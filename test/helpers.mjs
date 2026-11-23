// Test harness: calls the real API handlers in-process, against a throwaway Neon branch.
// Safety: tests TRUNCATE every table, so they refuse to run unless you name the exact database host you mean to wipe:
//   TEST_DATABASE_URL=postgresql://...  CONFIRM_TEST_DB_HOST=ep-xxxx-pooler.region.aws.neon.tech  npm test
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a throwaway database (a Neon branch). Tests wipe it.');
const host = new URL(url).host;
if (process.env.CONFIRM_TEST_DB_HOST !== host) throw new Error(`Refusing to run: set CONFIRM_TEST_DB_HOST=${host} to confirm this database may be wiped.`);
process.env.DATABASE_URL = url;
process.env.ADMIN_PIN = 'test-pin-12345678';
process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.ALERT_WEBHOOK_URL;

export const PIN = process.env.ADMIN_PIN, CRON = process.env.CRON_SECRET;
const lib = await import('../api/_lib.js');
export const { sql } = lib;
export { lib };
const mods = {};
for (const n of ['register', 'run-start', 'run-finish', 'tier-claim', 'me-coupons', 'stats', 'leaderboard', 'admin', 'cron-settle'])
  mods[n] = (await import(`../api/${n}.js`)).default;

// Calls a handler like Vercel would. Returns { status, json, headers }.
export async function call(name, { method = 'POST', body, headers = {}, ip = '10.0.0.1' } = {}) {
  const req = { method, body, headers: { 'x-real-ip': ip, ...headers }, query: {} };
  const out = { status: 200, headers: {}, text: '' };
  const res = { statusCode: 200, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(t) { out.text = t || ''; } };
  await mods[name](req, res);
  out.status = res.statusCode;
  try { out.json = JSON.parse(out.text); } catch (e) { out.json = null; }
  return out;
}
export const admin = (body, o = {}) => call('admin', { method: body ? 'POST' : 'GET', body, headers: { 'x-admin-pin': PIN, ...(o.headers || {}) }, ip: o.ip || '10.9.9.9' });

export async function resetDb() {
  assert.equal(new URL(process.env.DATABASE_URL).host, host);
  await sql`TRUNCATE security_events, runs, sessions, coupons, daily_awards, players CASCADE`;
  await sql`DELETE FROM config`;
}
let phoneN = 0;
export const newPhone = () => '9' + String(800000000 + (++phoneN * 7919) % 99999999).padStart(9, '0');
let ipN = 0;
export const newIp = () => { ipN++; return `10.${(ipN >> 8) & 255}.${ipN & 255}.7`; };
export async function signUp(name = 'Tester', ip = newIp(), phone = newPhone()) {
  const r = await call('register', { body: { name, phone }, ip });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { phone, token: r.json.token, name, ip };
}
export async function startRun(p, backdateSecs = 0) {
  const r = await call('run-start', { body: { phone: p.phone, token: p.token }, ip: p.ip });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (backdateSecs) await sql`UPDATE sessions SET started_at = now() - make_interval(secs => ${backdateSecs}::int) WHERE id = ${r.json.sessionId}`;
  return r.json.sessionId;
}
// A finished, legitimate-looking run (session backdated so the pace is believable).
export async function playRun(p, points, secs = Math.ceil(points / 15) + 5) {
  const sessionId = await startRun(p, secs);
  const coins = Math.floor(points / 40);
  const r = await call('run-finish', { body: { phone: p.phone, token: p.token, sessionId, points, coins, metres: points * 2 - coins * 10, secs }, ip: p.ip });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
export const setCampaign = c => admin({ action: 'config', config: c });
export const defaultCfg = () => ({ tiers: [{ points: 10000, slots: 20, prize: 'Free shawarma' }, { points: 20000, slots: 10, prize: '₹200 off' }, { points: 30000, slots: 5, prize: '₹500 off' }], grand: { prize: '₹2,000 off', endsAt: '2099-12-31', endsHour: 21 }, daily: { on: false, prize: '₹1,000 off' }, sceneLen: 1000, safeZone: 500, validDays: 7 });
export const eventsOf = async kind => sql`SELECT * FROM security_events WHERE kind = ${kind} ORDER BY id`;
