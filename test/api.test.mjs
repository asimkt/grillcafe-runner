import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, admin, sql, lib, resetDb, signUp, startRun, playRun, setCampaign, defaultCfg, eventsOf, newPhone, newIp, PIN, CRON } from './helpers.mjs';

const lowBar = (slots = 1) => ({ ...defaultCfg(), tiers: [{ points: 100, slots, prize: 'Test prize' }], safeZone: 0 });
async function claim(p, sessionId, points = 100, tier = 0) {
  return call('tier-claim', { body: { phone: p.phone, token: p.token, sessionId, tier, points, coins: 1, secs: 4 }, ip: p.ip });
}

before(resetDb);
beforeEach(async () => {
  await resetDb();
  await setCampaign(defaultCfg());
  await sql`DELETE FROM security_events`;   // keep each test's admin-lockout counters clean
});

describe('public endpoints', () => {
  test('stats returns the campaign and works on an empty database', async () => {
    const r = await call('stats', { method: 'GET' });
    assert.equal(r.status, 200); assert.equal(r.json.tiers.length, 3); assert.equal(r.json.best, null); assert.equal(r.json.players, 0);
  });
  test('wrong HTTP method is 405, never 500', async () => {
    for (const n of ['register', 'run-start', 'run-finish', 'tier-claim', 'me-coupons']) assert.equal((await call(n, { method: 'GET' })).status, 405, n);
    for (const n of ['stats', 'leaderboard']) assert.equal((await call(n, { method: 'POST', body: {} })).status, 405, n);
  });
  test('junk request bodies are rejected cleanly (400/401), never a crash', async () => {
    for (const body of [undefined, null, 'x', 42, [], [1, 2], { phone: { $ne: 1 }, token: [] }, { phone: ['9876543210'], token: {} }]) {
      for (const n of ['register', 'run-start', 'run-finish', 'tier-claim', 'me-coupons']) {
        const r = await call(n, { body }); assert.ok([400, 401].includes(r.status), `${n} ${JSON.stringify(body)} -> ${r.status}`);
      }
    }
  });
});

describe('sign-up and account safety', () => {
  test('registers a player and returns a token', async () => {
    const p = await signUp('Asha'); assert.ok(p.token.length >= 30);
    const [row] = await sql`SELECT name, ip FROM players WHERE phone = ${p.phone}`; assert.equal(row.name, 'Asha'); assert.equal(row.ip, p.ip);
  });
  test('validates name and mobile number', async () => {
    for (const body of [{ name: 'A', phone: '9876543210' }, { name: 'Asha', phone: '12345' }, { name: 'Asha', phone: '5876543210' }, { name: '', phone: '' }, { name: 'Asha', phone: "9876543210'; DROP TABLE players;--" }])
      assert.equal((await call('register', { body })).status, 400, JSON.stringify(body));
  });
  test('hostile names are stored as plain text and the tables survive (SQL injection / XSS)', async () => {
    const evil = [`Robert'); DROP TABLE players;--`, '<img src=x onerror=alert(1)>', '<script>alert(1)</script>'];
    for (const n of evil) { const p = await signUp(n); await playRun(p, 500); }
    const board = await call('leaderboard', { method: 'GET' });
    assert.ok(board.json.overall.length === 3);
    assert.ok(board.json.overall.some(r => r.name.includes('<script>')));          // returned as data; the game escapes it on screen
    assert.equal(board.headers['content-type'], 'application/json');
    assert.equal((await sql`SELECT count(*)::int AS n FROM players`)[0].n, 3);
  });
  test('a number that already has runs cannot be taken over by someone else', async () => {
    const owner = await signUp('Owner'); await playRun(owner, 800);
    const thief = await call('register', { body: { name: 'Thief', phone: owner.phone }, ip: '66.66.66.66' });
    assert.equal(thief.status, 409);
    const blocked = await eventsOf('register_blocked'); assert.equal(blocked.length, 1); assert.equal(blocked[0].ip, '66.66.66.66'); assert.equal(blocked[0].phone, owner.phone);
    // the owner's token still works
    assert.equal((await call('me-coupons', { body: { phone: owner.phone, token: owner.token } })).status, 200);
  });
  test('the real owner can sign in again from their own phone (token supplied), and the old token stops working', async () => {
    const owner = await signUp('Owner'); await playRun(owner, 800);
    const again = await call('register', { body: { name: 'Owner', phone: owner.phone, token: owner.token } });
    assert.equal(again.status, 200); assert.notEqual(again.json.token, owner.token);
    assert.equal((await call('me-coupons', { body: { phone: owner.phone, token: owner.token } })).status, 401);
  });
  test('wrong old token does not help a thief', async () => {
    const owner = await signUp('Owner'); await playRun(owner, 800);
    assert.equal((await call('register', { body: { name: 'Thief', phone: owner.phone, token: 'guess' } })).status, 409 );
  });
  test('admin can unlock a lost-phone number for one sign-in', async () => {
    const owner = await signUp('Owner'); await playRun(owner, 800);
    assert.equal((await admin({ action: 'reset_player', phone: owner.phone })).status, 200);
    const back = await call('register', { body: { name: 'Owner', phone: owner.phone } });
    assert.equal(back.status, 200);
    assert.equal((await call('register', { body: { name: 'Thief', phone: owner.phone } })).status, 409, 'unlock is single use');
  });
  test('an expired unlock no longer works', async () => {
    const owner = await signUp('Owner'); await playRun(owner, 800);
    await admin({ action: 'reset_player', phone: owner.phone });
    await sql`UPDATE players SET reclaim_until = now() - interval '1 minute' WHERE phone = ${owner.phone}`;
    assert.equal((await call('register', { body: { name: 'Thief', phone: owner.phone } })).status, 409);
  });
  test('a squatter who registered a number but never played cannot lock the real owner out', async () => {
    const phone = newPhone();
    await call('register', { body: { name: 'Squatter', phone } });
    assert.equal((await call('register', { body: { name: 'RealOwner', phone } })).status, 200);
  });
  test('sign-ups are rate limited per network address', async () => {
    for (let i = 0; i < 40; i++) await sql`INSERT INTO security_events (kind, ip, phone) VALUES ('register', '77.77.77.77', ${newPhone()})`;
    assert.equal((await call('register', { body: { name: 'Bot', phone: newPhone() }, ip: '77.77.77.77' })).status, 429);
    assert.equal((await call('register', { body: { name: 'Human', phone: newPhone() }, ip: '78.78.78.78' })).status, 200);
    assert.ok((await eventsOf('rate_limited')).length >= 1);
  });
  test('wrong, missing and other-number tokens are rejected and logged', async () => {
    const a = await signUp('Alice'), b = await signUp('Bobby');
    for (const body of [{ phone: a.phone, token: 'nope' }, { phone: a.phone, token: b.token }, { phone: a.phone }, { phone: a.phone, token: 12345 }, { phone: newPhone(), token: a.token }])
      assert.equal((await call('me-coupons', { body, ip: '55.55.55.55' })).status, 401, JSON.stringify(body));
    assert.ok((await eventsOf('bad_token')).some(e => e.ip === '55.55.55.55'));
  });
  test('coupons are private to their owner', async () => {
    await setCampaign(lowBar(5));
    const a = await signUp('Alice'), b = await signUp('Bobby');
    const ses = await startRun(a, 10); assert.equal((await claim(a, ses)).json.won, true);
    assert.equal((await call('me-coupons', { body: { phone: a.phone, token: a.token } })).json.length, 1);
    assert.equal((await call('me-coupons', { body: { phone: b.phone, token: b.token } })).json.length, 0);
    assert.equal((await call('me-coupons', { body: { phone: a.phone, token: b.token } })).status, 401);
  });
});

describe('runs and fair play', () => {
  test('a believable run is saved and not flagged', async () => {
    const p = await signUp(); const r = await playRun(p, 3000); assert.equal(r.flagged, false); assert.equal(r.run.points, 3000);
  });
  test('an impossible run is flagged, logged, and kept off the leaderboard', async () => {
    const p = await signUp('Cheater'); const ses = await startRun(p);
    const r = await call('run-finish', { body: { phone: p.phone, token: p.token, sessionId: ses, points: 900000, coins: 10, metres: 1, secs: 2 }, ip: p.ip });
    assert.equal(r.json.flagged, true);
    const ev = await eventsOf('cheat_flag'); assert.equal(ev.length, 1); assert.equal(ev[0].phone, p.phone); assert.equal(ev[0].ip, p.ip);
    assert.equal((await call('leaderboard', { method: 'GET' })).json.overall.length, 0);
  });
  test('a session cannot be replayed to submit a second run', async () => {
    const p = await signUp(); const ses = await startRun(p, 200);
    const body = { phone: p.phone, token: p.token, sessionId: ses, points: 2000, coins: 5, metres: 3000, secs: 200 };
    assert.equal((await call('run-finish', { body })).json.flagged, false);
    const again = await call('run-finish', { body }); assert.equal(again.json.flagged, true);
  });
  test('cannot finish another player\'s session', async () => {
    const a = await signUp('Alice'), b = await signUp('Bobby'); const ses = await startRun(a, 200);
    const r = await call('run-finish', { body: { phone: b.phone, token: b.token, sessionId: ses, points: 2000, coins: 5, metres: 1, secs: 200 } });
    assert.equal(r.json.flagged, true);
  });
  test('a run with no session at all is flagged', async () => {
    const p = await signUp(); const r = await call('run-finish', { body: { phone: p.phone, token: p.token, points: 5000, coins: 1, metres: 1, secs: 100 } });
    assert.equal(r.json.flagged, true);
  });
  test('absurd numbers and oversized event traces do not crash anything', async () => {
    const p = await signUp(); const ses = await startRun(p, 5);
    const r = await call('run-finish', { body: { phone: p.phone, token: p.token, sessionId: ses, points: 1e30, coins: -5, metres: 'x', secs: Infinity, events: Array.from({ length: 5000 }, () => ({ a: 'x'.repeat(200) })) } });
    assert.equal(r.status, 200); assert.equal(r.json.flagged, true);
  });
  test('more than 6 runs started in a minute is refused', async () => {
    const p = await signUp(); for (let i = 0; i < 6; i++) await startRun(p);
    assert.equal((await call('run-start', { body: { phone: p.phone, token: p.token } })).status, 429);
  });
  test('repeated cheating shows up in the admin "players to check" list', async () => {
    const p = await signUp('Sneaky');
    for (let i = 0; i < 3; i++) { const ses = await startRun(p); await call('run-finish', { body: { phone: p.phone, token: p.token, sessionId: ses, points: 99999, coins: 1, metres: 1, secs: 3 }, ip: p.ip }); await sql`DELETE FROM sessions WHERE false`; }
    const o = (await admin()).json; assert.ok(o.security.suspects.some(s => s.phone === p.phone && s.flagged >= 2));
  });
});

describe('prizes', () => {
  test('first to reach the level wins; the same phone gets the same coupon back; others see sold out', async () => {
    await setCampaign(lowBar(1));
    const a = await signUp('Alice'), b = await signUp('Bobby'); const sa = await startRun(a, 10), sb = await startRun(b, 10);
    const w = await claim(a, sa); assert.equal(w.json.won, true); assert.match(w.json.coupon.code, /^GRILL-/);
    const again = await claim(a, sa); assert.equal(again.json.already, true); assert.equal(again.json.coupon.code, w.json.coupon.code);
    assert.equal((await claim(b, sb)).json.soldOut, true);
    assert.equal((await eventsOf('prize_won')).length, 1);
  });
  test('cannot claim without the points, with a fake session, or with someone else\'s session', async () => {
    await setCampaign({ ...lowBar(5), tiers: [{ points: 1000, slots: 5, prize: 'P' }] });
    const a = await signUp('Alice'), b = await signUp('Bobby'); const sa = await startRun(a, 100);
    assert.equal((await claim(a, sa, 100)).json.reason, 'not enough points');
    assert.equal((await claim(a, '00000000-0000-0000-0000-000000000000', 1000)).json.reason, 'unknown session');
    assert.equal((await claim(a, 'not-a-uuid', 1000)).json.reason, 'unknown session');
    assert.equal((await claim(b, sa, 1000)).json.reason, 'unknown session');
    assert.equal((await claim(a, sa, 1000, 7)).json.reason, 'no such prize');
  });
  test('claiming faster than the server clock allows is rejected and logged', async () => {
    await setCampaign(lowBar(5)); const a = await signUp('Alice'); const ses = await startRun(a);   // not backdated: 0 seconds elapsed
    const r = await claim(a, ses, 100); assert.equal(r.json.rejected, true);
    assert.equal((await eventsOf('cheat_flag')).length, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM coupons`)[0].n, 0);
  });
  test('a flood of simultaneous claims never gives out more prizes than there are winners', async () => {
    await setCampaign(lowBar(3));
    const players = await Promise.all(Array.from({ length: 10 }, (_, i) => signUp('Racer' + i)));
    const sessions = await Promise.all(players.map(p => startRun(p, 10)));
    const results = await Promise.all(players.map((p, i) => claim(p, sessions[i])));
    assert.equal(results.filter(r => r.json.won).length, 3);
    assert.equal(results.filter(r => r.json.soldOut).length, 7);
    assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'tier'`)[0].n, 3);
  });
  test('the same player claiming twice at once still gets exactly one coupon', async () => {
    await setCampaign(lowBar(5)); const a = await signUp('Alice'); const ses = await startRun(a, 10);
    await Promise.all([claim(a, ses), claim(a, ses), claim(a, ses)]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE phone = ${a.phone}`)[0].n, 1);
  });
});

describe('admin: access control', () => {
  test('no PIN, wrong PIN and odd headers are all refused', async () => {
    assert.equal((await call('admin', { method: 'GET', ip: '1.1.1.1' })).status, 401);
    assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': 'wrong' }, ip: '1.1.1.2' })).status, 401);
    assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': ['a', 'b'] }, ip: '1.1.1.3' })).status, 401);
    assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': PIN + ' ' }, ip: '1.1.1.4' })).status, 401);
    assert.equal((await call('admin', { method: 'POST', body: { action: 'config', config: {} }, ip: '1.1.1.5' })).status, 401);
  });
  test('the correct PIN works', async () => { const r = await admin(); assert.equal(r.status, 200); assert.ok(r.json.security); assert.ok(r.json.stats); });
  test('player tokens are not admin credentials', async () => {
    const p = await signUp(); assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': p.token }, ip: '1.2.3.4' })).status, 401);
  });
  test('brute force: 5 wrong PINs lock that address out, even for the right PIN', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': 'guess' + i }, ip: '2.2.2.2' })).status, 401);
    assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': PIN }, ip: '2.2.2.2' })).status, 429);
    assert.equal((await call('admin', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { action: 'config', config: {} }, ip: '2.2.2.2' })).status, 429);
    assert.equal((await admin(undefined, { ip: '3.3.3.3' })).status, 200, 'other addresses are unaffected');
    assert.equal((await eventsOf('admin_login_fail')).length, 5); assert.ok((await eventsOf('admin_locked')).length >= 1);
  });
  test('the lockout lifts after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) await call('admin', { method: 'GET', headers: { 'x-admin-pin': 'g' + i }, ip: '4.4.4.4' });
    await sql`UPDATE security_events SET at = now() - interval '16 minutes' WHERE ip = '4.4.4.4'`;
    assert.equal((await admin(undefined, { ip: '4.4.4.4' })).status, 200);
  });
  test('a distributed attack (50 wrong PINs from many addresses) locks admin for everyone', async () => {
    for (let i = 0; i < 50; i++) await sql`INSERT INTO security_events (kind, ip) VALUES ('admin_login_fail', ${'8.8.' + i + '.1'})`;
    assert.equal((await admin(undefined, { ip: '9.9.9.200' })).status, 429);
  });
  test('admin refuses to run with a weak or missing PIN configured', async () => {
    const was = process.env.ADMIN_PIN;
    try {
      for (const weak of ['', '1234', '1234567']) { process.env.ADMIN_PIN = weak; assert.equal((await call('admin', { method: 'GET', headers: { 'x-admin-pin': weak }, ip: '5.5.5.5' })).status, 503, `"${weak}"`); }
      delete process.env.ADMIN_PIN; assert.equal((await call('admin', { method: 'GET', headers: {}, ip: '5.5.5.5' })).status, 503);
    } finally { process.env.ADMIN_PIN = was; }
  });
});

describe('admin: working properly', () => {
  test('overview lists players, coupons, runs, leaderboard and security', async () => {
    await setCampaign(lowBar(5)); const a = await signUp('Alice'); await playRun(a, 3000); await claim(a, await startRun(a, 10));
    const o = (await admin()).json;
    assert.equal(o.stats.players, 1); assert.equal(o.coupons.length, 1); assert.equal(o.runs.length, 1); assert.equal(o.leaderboard[0].points, 3000);
    for (const k of ['events', 'suspects', 'clusters', 'banned']) assert.ok(Array.isArray(o.security[k]), k);
  });
  test('settings are saved, sanitised and reflected publicly', async () => {
    const r = await admin({ action: 'config', config: { tiers: [{ points: 5000, slots: 3, prize: 'Y'.repeat(200) }], grand: { prize: 'Big', endsAt: '2026-12-31', endsHour: 21 }, daily: { on: true, prize: 'D' }, sceneLen: 500, safeZone: 100, validDays: 3 } });
    assert.equal(r.status, 200);
    const s = (await call('stats', { method: 'GET' })).json;
    assert.equal(s.tiers[0].points, 5000); assert.equal(s.tiers[0].prize.length, 40); assert.equal(s.grand.prize, 'Big'); assert.equal(s.daily.on, true); assert.equal(s.sceneLen, 500);
  });
  test('garbage settings fall back to safe defaults instead of breaking the game', async () => {
    assert.equal((await admin({ action: 'config', config: { tiers: 'lol', grand: 5, daily: null } })).status, 200);
    const s = (await call('stats', { method: 'GET' })).json; assert.equal(s.tiers.length, 3);
  });
  test('coupon can be marked redeemed and un-redeemed; a code with SQL in it does nothing', async () => {
    await setCampaign(lowBar(5)); const a = await signUp('Alice'); const w = await claim(a, await startRun(a, 10)); const code = w.json.coupon.code;
    await admin({ action: 'redeem', code, value: true });
    assert.equal((await admin()).json.coupons.find(c => c.code === code).redeemed, true);
    await admin({ action: 'redeem', code, value: false });
    assert.equal((await admin()).json.coupons.find(c => c.code === code).redeemed, false);
    await admin({ action: 'redeem', code: "x' OR '1'='1", value: true });
    assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE redeemed_at IS NOT NULL`)[0].n, 0);
  });
  test('a flagged run can be approved and then counts', async () => {
    const p = await signUp('Alice'); const ses = await startRun(p);
    const r = await call('run-finish', { body: { phone: p.phone, token: p.token, sessionId: ses, points: 4000, coins: 1, metres: 1, secs: 3 } });
    assert.equal(r.json.flagged, true);
    await admin({ action: 'unflag', id: Number(r.json.run.id) });
    assert.equal((await call('leaderboard', { method: 'GET' })).json.overall[0].points, 4000);
  });
  test('ban: hides runs, blocks play and sign-in, marks coupons; unban restores', async () => {
    await setCampaign(lowBar(5)); const a = await signUp('Alice'); await playRun(a, 9000); await claim(a, await startRun(a, 10));
    assert.equal((await admin({ action: 'ban', phone: a.phone })).status, 200);
    assert.equal((await call('leaderboard', { method: 'GET' })).json.overall.length, 0);
    assert.equal((await call('run-start', { body: { phone: a.phone, token: a.token } })).status, 403);
    assert.equal((await call('me-coupons', { body: { phone: a.phone, token: a.token } })).status, 403);
    assert.equal((await call('register', { body: { name: 'Alice', phone: a.phone, token: a.token } })).status, 403);
    const o = (await admin()).json; assert.equal(o.coupons[0].banned, true); assert.equal(o.security.banned.length, 1);
    assert.equal((await call('stats', { method: 'GET' })).json.best, null, 'banned scores cannot be the top score');
    await admin({ action: 'ban', phone: a.phone, value: false });
    assert.equal((await call('leaderboard', { method: 'GET' })).json.overall[0].points, 9000);
    assert.equal((await call('run-start', { body: { phone: a.phone, token: a.token } })).status, 200);
  });
  test('bad admin input is rejected, not executed', async () => {
    assert.equal((await admin({ action: 'ban', phone: "1'; DROP TABLE players;--" })).status, 400);
    assert.equal((await admin({ action: 'reset_player', phone: 'abc' })).status, 400);
    assert.equal((await admin({ action: 'format_disk' })).status, 400);
    assert.equal((await admin({})).status, 400);
  });
  test('every admin change is written to the audit log with the address', async () => {
    const a = await signUp('Alice');
    await admin({ action: 'ban', phone: a.phone }, { ip: '12.12.12.12' }); await admin({ action: 'config', config: {} }, { ip: '12.12.12.12' });
    const log = await eventsOf('admin_action'); assert.deepEqual(log.map(e => e.detail.action), ['ban', 'config']); assert.ok(log.every(e => e.ip === '12.12.12.12'));
  });
  test('many numbers from one network are surfaced as a cluster', async () => {
    for (let i = 0; i < 6; i++) await signUp('Fan' + i, '99.99.99.99');
    assert.ok((await admin()).json.security.clusters.some(c => c.ip === '99.99.99.99' && c.numbers === 6));
  });
  test('the security log shows attacks but hides routine sign-ups', async () => {
    await call('admin', { method: 'GET', headers: { 'x-admin-pin': 'bad' }, ip: '13.13.13.13' }); await signUp('Alice');
    const kinds = (await admin()).json.security.events.map(e => e.kind);
    assert.ok(kinds.includes('admin_login_fail')); assert.ok(!kinds.includes('register'));
  });
});

describe('leaderboard', () => {
  test('shows each player once with their best score, highest first, names only', async () => {
    const a = await signUp('Alice'), b = await signUp('Bobby'), c = await signUp('Chitra');
    await playRun(a, 1000); await playRun(a, 5000); await playRun(a, 2000); await playRun(b, 4000); await playRun(c, 6000);
    const j = (await call('leaderboard', { method: 'GET' })).json;
    assert.deepEqual(j.overall.map(r => [r.rank, r.name, r.points]), [[1, 'Chitra', 6000], [2, 'Alice', 5000], [3, 'Bobby', 4000]]);
    assert.deepEqual(j.daily.map(r => r.name), ['Chitra', 'Alice', 'Bobby']);
    for (const r of [...j.overall, ...j.daily]) assert.deepEqual(Object.keys(r).sort(), ['name', 'points', 'rank']);
    assert.ok(!/\b[6-9]\d{9}\b/.test(JSON.stringify(j)), 'no phone numbers anywhere in the response');
    assert.ok(!JSON.stringify(j).includes(a.token));
  });
  test('today only counts runs from today (India time); overall counts everything', async () => {
    const a = await signUp('Alice'), b = await signUp('Bobby'); await playRun(a, 9000); await playRun(b, 2000);
    await sql`UPDATE runs SET created_at = now() - interval '2 days' WHERE phone = ${a.phone}`;
    const j = (await call('leaderboard', { method: 'GET' })).json;
    assert.deepEqual(j.daily.map(r => r.name), ['Bobby']); assert.deepEqual(j.overall.map(r => r.name), ['Alice', 'Bobby']);
  });
  test('the overall board freezes at the closing time', async () => {
    await setCampaign({ ...defaultCfg(), grand: { prize: 'G', endsAt: '2026-01-01', endsHour: 21 } });
    const a = await signUp('Early'), b = await signUp('Late'); await playRun(a, 3000); await playRun(b, 8000);
    await sql`UPDATE runs SET created_at = '2026-01-01T15:00:00Z' WHERE phone = ${a.phone}`;   // 8:30 PM India, before the cutoff
    await sql`UPDATE runs SET created_at = '2026-01-01T16:00:00Z' WHERE phone = ${b.phone}`;   // 9:30 PM India, after the cutoff
    const j = (await call('leaderboard', { method: 'GET' })).json; assert.deepEqual(j.overall.map(r => r.name), ['Early']);
    assert.equal(j.closesAt, '2026-01-01T15:30:00.000Z');
  });
  test('is cached for 30 minutes at the edge (so visitors do not wake the database), 60 seconds when the game asks for fresh data', async () => {
    const r = await call('leaderboard', { method: 'GET' }); assert.match(r.headers['cache-control'], /s-maxage=1800/);
    const live = await (async () => { const req = { method: 'GET', headers: { 'x-real-ip': '1.1.1.1' }, query: { live: '1' } }; const out = { h: {} }; const res = { statusCode: 200, setHeader(k, v) { out.h[k.toLowerCase()] = v; }, end() {} };
      const mod = (await import('../api/leaderboard.js')).default; await mod(req, res); return out.h['cache-control']; })();
    assert.match(live, /s-maxage=60$/);
  });
  test('stats are never cached for the game, but the marketing page can use a 30-minute cached copy', async () => {
    assert.equal((await call('stats', { method: 'GET' })).headers['cache-control'], 'no-store');
    const req = { method: 'GET', headers: {}, query: { public: '1' } }; const out = { h: {} };
    await (await import('../api/stats.js')).default(req, { statusCode: 200, setHeader(k, v) { out.h[k.toLowerCase()] = v; }, end() {} });
    assert.match(out.h['cache-control'], /s-maxage=1800/);
  });
  test('returns at most 25 rows', async () => {
    for (let i = 0; i < 27; i++) { const p = await signUp('P' + String(i).padStart(2, '0')); await sql`INSERT INTO runs (phone, points, coins, metres, secs) VALUES (${p.phone}, ${1000 + i}, 0, 0, 100)`; }
    const r = await call('leaderboard', { method: 'GET' });
    assert.equal(r.json.overall.length, 25); assert.equal(r.json.overall[0].points, 1026);
  });
  test('empty board is fine', async () => { const j = (await call('leaderboard', { method: 'GET' })).json; assert.deepEqual([j.daily, j.overall], [[], []]); });
});

describe('daily job (cron) and the top-score prize', () => {
  const cron = (secret, ip) => call('cron-settle', { method: 'GET', headers: secret === undefined ? {} : { authorization: secret }, ip });
  test('only runs with the secret', async () => {
    assert.equal((await cron(undefined)).status, 401); assert.equal((await cron('Bearer wrong')).status, 401); assert.equal((await cron(CRON)).status, 401); assert.equal((await cron('Bearer ')).status, 401);
    assert.equal((await cron('Bearer ' + CRON)).status, 200);
  });
  test('before the closing time nobody wins the top-score prize', async () => {
    const a = await signUp('Alice'); await playRun(a, 5000); const r = await cron('Bearer ' + CRON);
    assert.equal(r.json.grand, null); assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'grand'`)[0].n, 0);
  });
  test('after 9 PM on the last day the best score before 9 PM wins, exactly once', async () => {
    await setCampaign({ ...defaultCfg(), grand: { prize: 'Top prize', endsAt: '2026-01-01', endsHour: 21 } });
    const a = await signUp('Before'), b = await signUp('After'), c = await signUp('Cheater'); await playRun(a, 7000); await playRun(b, 9000); await playRun(c, 8000);
    await sql`UPDATE runs SET created_at = '2026-01-01T14:00:00Z' WHERE phone = ${a.phone}`;
    await sql`UPDATE runs SET created_at = '2026-01-01T16:00:00Z' WHERE phone = ${b.phone}`;       // after 9 PM India: too late
    await sql`UPDATE runs SET created_at = '2026-01-01T13:00:00Z', flagged = true, reason = 'points too fast' WHERE phone = ${c.phone}`;
    const r = await cron('Bearer ' + CRON); assert.equal(r.json.grand.ok, true);
    const [g] = await sql`SELECT phone, value FROM coupons WHERE type = 'grand'`; assert.equal(g.phone, a.phone); assert.equal(g.value, 'Top prize');
    assert.equal((await cron('Bearer ' + CRON)).json.grand.error, 'already awarded');
    assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'grand'`)[0].n, 1);
  });
  test('a banned player cannot win the top-score prize', async () => {
    await setCampaign({ ...defaultCfg(), grand: { prize: 'G', endsAt: '2026-01-01', endsHour: 21 } });
    const a = await signUp('Honest'), b = await signUp('Banned'); await playRun(a, 3000); await playRun(b, 9000);
    await sql`UPDATE runs SET created_at = '2026-01-01T10:00:00Z'`; await admin({ action: 'ban', phone: b.phone });
    await cron('Bearer ' + CRON); assert.equal((await sql`SELECT phone FROM coupons WHERE type = 'grand'`)[0].phone, a.phone);
  });
  test('daily record prize (when switched on) goes to a finished day\'s best run once', async () => {
    await setCampaign({ ...defaultCfg(), daily: { on: true, prize: 'Daily' } });
    const a = await signUp('Alice'), b = await signUp('Bobby'); await playRun(a, 2000); await playRun(b, 4000);
    await sql`UPDATE runs SET created_at = now() - interval '1 day'`;
    const r = await cron('Bearer ' + CRON); assert.equal(r.json.daily.length, 1);
    const [d] = await sql`SELECT phone, value FROM coupons WHERE type = 'record'`; assert.equal(d.phone, b.phone);
    await cron('Bearer ' + CRON); assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'record'`)[0].n, 1);
  });
  test('daily prize stays off when the switch is off', async () => {
    const a = await signUp('Alice'); await playRun(a, 2000); await sql`UPDATE runs SET created_at = now() - interval '1 day'`;
    await cron('Bearer ' + CRON); assert.equal((await sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'record'`)[0].n, 0);
  });
});
