import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

export const sql = neon(process.env.DATABASE_URL);

// Same limits the game checks in test mode. Keep these in step with RULES in index.html.
export const RULES = { maxPtsPerSec: 48 };
export const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export function handler(methods, fn) {
  return async (req, res) => {
    if (!methods.includes(req.method)) return send(res, 405, { error: 'method not allowed' });
    try { await fn(req, res, req.body || {}); }
    catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e); send(res, 500, { error: 'server error' });
    }
  };
}
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const validPhone = p => typeof p === 'string' && /^[6-9]\d{9}$/.test(p);
export const int = (v, max = 1e9) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
const CODECH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function couponCode() {
  const b = crypto.randomBytes(4); let s = 'GRILL-';
  for (let i = 0; i < 4; i++) s += CODECH[b[i] % CODECH.length];
  return s;
}
export const newToken = () => crypto.randomBytes(24).toString('base64url');

export function defaultCampaign() {
  const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return {
    tiers: [{ points: 10000, slots: 20, prize: 'Free shawarma' }, { points: 20000, slots: 10, prize: '₹200 off' }, { points: 30000, slots: 5, prize: '₹500 off' }],
    grand: { prize: '₹2,000 off', endsAt: end }, daily: { on: false, prize: '₹1,000 off' },
    sceneLen: 1000, safeZone: 500, validDays: 7
  };
}
// Same as cleanCampaign in index.html.
export function cleanCampaign(c) {
  const d = defaultCampaign(), n = (v, lo, hi, def) => { v = Math.floor(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
  const txt = (v, def) => { v = String(v == null ? '' : v).trim().slice(0, 40); return v || def; };
  const tiers = (Array.isArray(c.tiers) ? c.tiers : []).map(t => ({ points: n(t.points, 100, 1e7, 0), slots: n(t.slots, 0, 100000, 0), prize: txt(t.prize, '') }))
    .filter(t => t.points >= 100 && t.prize).sort((a, b) => a.points - b.points).slice(0, 6);
  const g = c.grand || {}, dl = c.daily || {};
  return {
    tiers: tiers.length ? tiers : d.tiers,
    grand: { prize: txt(g.prize, d.grand.prize), endsAt: /^\d{4}-\d{2}-\d{2}$/.test(g.endsAt || '') ? g.endsAt : d.grand.endsAt },
    daily: { on: !!dl.on, prize: txt(dl.prize, d.daily.prize) },
    sceneLen: n(c.sceneLen, 50, 100000, 1000), safeZone: n(c.safeZone, 0, 5000, 500), validDays: n(c.validDays, 1, 90, 7)
  };
}
export async function getConfig() {
  const rows = await sql`SELECT value FROM config WHERE key = 'campaign'`;
  let c = {}; try { c = rows[0] ? JSON.parse(rows[0].value) : {}; } catch (e) { c = {}; }
  return cleanCampaign(c);
}
export async function saveConfig(c) {
  const clean = cleanCampaign(c || {});
  await sql`INSERT INTO config (key, value) VALUES ('campaign', ${JSON.stringify(clean)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return clean;
}

// Checks the phone and its device token. Returns the player row.
export async function auth(phone, token) {
  if (!validPhone(phone) || !token) throw fail(401, 'sign in again');
  const rows = await sql`SELECT phone, name, token FROM players WHERE phone = ${phone}`;
  const p = rows[0];
  if (!p || !safeEqual(p.token, String(token))) throw fail(401, 'sign in again');
  return p;
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function adminOk(req) {
  const pin = req.headers['x-admin-pin'];
  return !!process.env.ADMIN_PIN && !!pin && safeEqual(pin, process.env.ADMIN_PIN);
}

// Returns a reason string when a run looks impossible, otherwise null.
export function judgeRun(s, serverSecs) {
  if (!(s.points >= 0) || !(s.secs >= 0)) return 'bad data';
  if (serverSecs != null && s.secs > serverSecs + 5) return 'run longer than the session';
  const secs = Math.max(1, serverSecs != null ? Math.min(serverSecs, s.secs + 5) : s.secs);
  if (s.points / secs > RULES.maxPtsPerSec) return 'points too fast';
  if (s.coins * 5 > s.points + 1) return 'more coins than points';
  return null;
}

export async function loadSession(sessionId, phone) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const rows = await sql`SELECT id, phone, finished_at, extract(epoch FROM now() - started_at) AS secs FROM sessions WHERE id = ${sessionId}`;
  const s = rows[0];
  return s && s.phone === phone ? s : null;
}

export async function stats() {
  const cfg = await getConfig();
  const [r] = await sql`
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    best AS (SELECT r.id, r.points, p.name FROM runs r JOIN players p USING (phone) WHERE NOT r.flagged ORDER BY r.points DESC, r.id LIMIT 1),
    rec AS (SELECT max(r.points) AS points FROM runs r, today WHERE NOT r.flagged AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date < today.d),
    top AS (
      SELECT r.id, r.points, p.name FROM runs r JOIN players p USING (phone), today
      WHERE NOT r.flagged AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date = today.d ORDER BY r.points DESC, r.id LIMIT 1)
    SELECT
      (SELECT id FROM best) AS best_id, (SELECT points FROM best) AS best_points, (SELECT name FROM best) AS best_name,
      (SELECT points FROM rec) AS record,
      (SELECT id FROM top) AS top_id, (SELECT points FROM top) AS top_points, (SELECT name FROM top) AS top_name,
      (SELECT coalesce(json_object_agg(tier, n), '{}') FROM (SELECT tier, count(*)::int AS n FROM coupons WHERE type = 'tier' GROUP BY tier) x) AS claimed,
      (SELECT count(*) > 0 FROM coupons WHERE type = 'grand') AS grand_awarded,
      (SELECT count(*)::int FROM runs, today WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = today.d) AS runs_today,
      (SELECT count(*)::int FROM players) AS players,
      (SELECT count(*)::int FROM coupons WHERE redeemed_at IS NOT NULL) AS redeemed,
      (SELECT count(*)::int FROM coupons) AS coupons,
      (SELECT count(*)::int FROM runs WHERE flagged) AS flagged`;
  const record = r.record || 0, claimed = r.claimed || {};
  return {
    tiers: cfg.tiers.map((t, i) => ({ ...t, claimed: claimed[i] || 0 })),
    grand: { ...cfg.grand, awarded: r.grand_awarded }, daily: cfg.daily, sceneLen: cfg.sceneLen, safeZone: cfg.safeZone,
    best: r.best_id != null ? { id: Number(r.best_id), points: r.best_points, name: r.best_name } : null,
    record,
    leader: cfg.daily.on && r.top_points != null && r.top_points > record ? { id: Number(r.top_id), points: r.top_points, name: r.top_name } : null,
    runsToday: r.runs_today, players: r.players, redeemed: r.redeemed, coupons: r.coupons, flagged: r.flagged
  };
}
export const couponOut = c => ({
  code: c.code, type: c.type, tier: c.tier, points: c.points, phone: c.phone, name: c.name, value: c.value,
  ts: new Date(c.issued_at).getTime(), expires: new Date(c.expires_at).getTime(), redeemed: !!c.redeemed_at
});
