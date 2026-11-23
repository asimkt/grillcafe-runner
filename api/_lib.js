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
    try {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      await fn(req, res, b);
    }
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
    grand: { prize: '₹2,000 off', endsAt: end, endsHour: 21 }, daily: { on: false, prize: '₹1,000 off' },
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
    grand: { prize: txt(g.prize, d.grand.prize), endsAt: /^\d{4}-\d{2}-\d{2}$/.test(g.endsAt || '') ? g.endsAt : d.grand.endsAt, endsHour: n(g.endsHour, 0, 23, 21) },
    daily: { on: !!dl.on, prize: txt(dl.prize, d.daily.prize) },
    sceneLen: n(c.sceneLen, 50, 100000, 1000), safeZone: n(c.safeZone, 0, 5000, 500), validDays: n(c.validDays, 1, 90, 7)
  };
}
// The moment the top-score race closes: the end date at endsHour o'clock India time (default 9 PM). Runs after it don't count for the top-score prize.
export const cutoffIso = cfg => new Date(`${cfg.grand.endsAt}T${String(cfg.grand.endsHour).padStart(2, '0')}:00:00+05:30`).toISOString();
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

// ---- Security: who is calling, audit trail, alerts, admin lockout ----
export const LIMITS = { adminPerIp: 5, adminGlobal: 50, adminWindow: '15 minutes', registerPerIpHour: 40, flagsBeforeAlert: 3 };
export function getIp(req) {
  const h = (req && req.headers) || {};
  const v = h['x-vercel-forwarded-for'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || (req && req.socket && req.socket.remoteAddress) || '';
  return String(v).trim().slice(0, 64) || 'unknown';
}
// Writes one row to the audit trail. Never throws: logging must not break a request.
// dedupeSecs: skip if the same kind from the same ip was already logged that recently (stops floods).
export async function logEvent(kind, ip, phone, detail, dedupeSecs = 0) {
  try {
    const d = JSON.stringify(detail || {}).slice(0, 2000);
    if (dedupeSecs > 0) {
      await sql`INSERT INTO security_events (kind, ip, phone, detail)
        SELECT ${kind}, ${ip}, ${phone || null}, ${d}::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM security_events WHERE kind = ${kind} AND ip IS NOT DISTINCT FROM ${ip}
                          AND at > now() - make_interval(secs => ${dedupeSecs}::int))`;
    } else {
      await sql`INSERT INTO security_events (kind, ip, phone, detail) VALUES (${kind}, ${ip}, ${phone || null}, ${d}::jsonb)`;
    }
  } catch (e) { console.error('logEvent failed', e); }
}
// Optional: set ALERT_WEBHOOK_URL (a Slack incoming webhook works) to be told about attacks as they happen.
export async function alert(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '[Grill Cafe game] ' + text }), signal: AbortSignal.timeout(2500) }); }
  catch (e) { console.error('alert failed', e.message); }
}

// Checks the phone and its device token. Returns the player row.
export async function auth(phone, token, req) {
  const ip = getIp(req);
  if (!validPhone(phone) || typeof token !== 'string' || !token) throw fail(401, 'sign in again');
  const rows = await sql`SELECT phone, name, token, banned_at FROM players WHERE phone = ${phone}`;
  const p = rows[0];
  if (!p || !safeEqual(p.token, token)) {
    await logEvent('bad_token', ip, phone, {}, 30);
    throw fail(401, 'sign in again');
  }
  if (p.banned_at) { await logEvent('banned_access', ip, phone, {}, 300); throw fail(403, 'This number has been blocked by the cafe team.'); }
  return p;
}
export function safeEqual(a, b) {
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
export function adminOk(req) {
  const pin = req.headers['x-admin-pin'], want = process.env.ADMIN_PIN;
  return typeof pin === 'string' && !!want && safeEqual(pin, want);
}
// Every admin request goes through here: PIN check, brute-force lockout, audit log.
// 5 wrong PINs from one address, or 50 from anywhere, in 15 minutes locks admin (even for the right PIN) until the window passes.
export async function adminGate(req) {
  const ip = getIp(req);
  if ((process.env.ADMIN_PIN || '').length < 8) throw fail(503, 'admin is off: set ADMIN_PIN to at least 8 characters');
  const [c] = await sql`SELECT count(*) FILTER (WHERE ip = ${ip})::int AS mine, count(*)::int AS total FROM security_events
                        WHERE kind = 'admin_login_fail' AND at > now() - interval '15 minutes'`;
  if (c.mine >= LIMITS.adminPerIp || c.total >= LIMITS.adminGlobal) {
    await logEvent('admin_locked', ip, null, { mine: c.mine, total: c.total }, 60);
    throw fail(429, 'Too many wrong PINs. Admin is locked for 15 minutes.');
  }
  if (!adminOk(req)) {
    await logEvent('admin_login_fail', ip, null, { ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    if (c.mine + 1 === LIMITS.adminPerIp) await alert('Admin locked: ' + LIMITS.adminPerIp + ' wrong PINs from ' + ip);
    throw fail(401, 'wrong PIN');
  }
  await logEvent('admin_login_ok', ip, null, {}, 1800);
  return ip;
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
  const cfg = await getConfig(), cutoff = cutoffIso(cfg);
  const [r] = await sql`
    WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    best AS (SELECT r.id, r.points, p.name FROM runs r JOIN players p USING (phone) WHERE NOT r.flagged AND r.created_at < ${cutoff}::timestamptz ORDER BY r.points DESC, r.id LIMIT 1),
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
