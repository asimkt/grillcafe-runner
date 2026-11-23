// Pure-function tests. No database needed beyond the harness import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { judgeRun, cleanCampaign, couponCode, safeEqual, getIp, validPhone, cutoffIso, defaultCampaign } from '../api/_lib.js';

test('judgeRun accepts a normal run', () => assert.equal(judgeRun({ points: 3000, coins: 40, secs: 200 }, 205), null));
test('judgeRun flags impossible speed', () => assert.equal(judgeRun({ points: 5000, coins: 10, secs: 10 }, 12), 'points too fast'));
test('judgeRun flags a run longer than the server session', () => assert.equal(judgeRun({ points: 100, coins: 1, secs: 600 }, 30), 'run longer than the session'));
test('judgeRun flags more coin value than points', () => assert.equal(judgeRun({ points: 100, coins: 500, secs: 100 }, 100), 'more coins than points'));
test('judgeRun flags garbage', () => { assert.equal(judgeRun({ points: -5, coins: 0, secs: 5 }, 5), 'bad data'); assert.equal(judgeRun({ points: NaN, coins: 0, secs: 5 }, 5), 'bad data'); });
test('judgeRun cannot be fooled by claiming a long run in a short session', () => assert.ok(judgeRun({ points: 20000, coins: 0, secs: 5000 }, 20)));

test('validPhone', () => {
  for (const p of ['9876543210', '6000000000']) assert.ok(validPhone(p));
  for (const p of ['5876543210', '987654321', '98765432100', '98765 43210', '', null, undefined, 9876543210, "9876543210'; DROP TABLE players;--"]) assert.ok(!validPhone(p), String(p));
});
test('couponCode format and uniqueness', () => {
  const seen = new Set(); for (let i = 0; i < 500; i++) { const c = couponCode(); assert.match(c, /^GRILL-[A-HJKMNP-Z2-9]{4}$/); seen.add(c); }
  assert.ok(seen.size > 450);
});
test('safeEqual', () => { assert.ok(safeEqual('abc', 'abc')); assert.ok(!safeEqual('abc', 'abd')); assert.ok(!safeEqual('abc', 'abcd')); assert.ok(!safeEqual('', 'x')); });
test('getIp prefers the platform header and never throws', () => {
  assert.equal(getIp({ headers: { 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }), '1.2.3.4');
  assert.equal(getIp({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } }), '5.6.7.8');
  assert.equal(getIp({ headers: {} }), 'unknown'); assert.equal(getIp(undefined), 'unknown');
});
test('cleanCampaign: sane defaults and clamping', () => {
  const c = cleanCampaign({ tiers: [{ points: 5, slots: -3, prize: '' }], grand: { endsAt: 'tomorrow', endsHour: 99 }, sceneLen: 1, safeZone: 1e9, validDays: 0 });
  assert.equal(c.tiers.length, 3); assert.equal(c.grand.endsHour, 23); assert.match(c.grand.endsAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(c.sceneLen, 50); assert.equal(c.safeZone, 5000); assert.equal(c.validDays, 1);
});
test('cleanCampaign: tiers sorted, capped at 6, text trimmed to 40, no object injection', () => {
  const tiers = Array.from({ length: 10 }, (_, i) => ({ points: (10 - i) * 1000, slots: 5, prize: 'x'.repeat(100) }));
  const c = cleanCampaign({ tiers, evil: { __proto__: { polluted: 1 } } });
  assert.equal(c.tiers.length, 6); assert.deepEqual(c.tiers.map(t => t.points), [...c.tiers.map(t => t.points)].sort((a, b) => a - b)); assert.equal(c.tiers[0].prize.length, 40);
  assert.equal(({}).polluted, undefined); assert.equal(c.evil, undefined);
});
test('cleanCampaign is stable (cleaning twice changes nothing)', () => { const a = cleanCampaign(defaultCampaign()); assert.deepEqual(cleanCampaign(a), a); });
test('cutoff is 9 PM India time on the end date by default', () => {
  assert.equal(cutoffIso({ grand: { endsAt: '2026-12-31', endsHour: 21 } }), '2026-12-31T15:30:00.000Z');
  assert.equal(cutoffIso(cleanCampaign({ grand: { endsAt: '2026-12-31' } })), '2026-12-31T15:30:00.000Z');
});
