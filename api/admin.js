import { sql, handler, send, adminGate, stats, getConfig, saveConfig, cutoffIso, expiryIso, couponOut, couponCode, int, validPhone, logEvent, alert, hashPin, randomPin, MIN_PIN } from './_lib.js';
// GET  (header x-admin-pin) -> overview for the admin page, including the security report
// POST { action: 'redeem' | 'unflag' | 'ban' | 'reset_player' | 'set_pin' | 'config' | 'grand' | 'disable_user', ... }
// Headers: x-admin-user and x-admin-pin. Every request goes through adminGate: named login, lockout and audit trail.
// Roles: owner can do everything. manager can't change prize settings, award the top-score prize, or manage other accounts.
// Every action is written to security_events with the person's username.
export async function awardGrand(cfg) {
  const top = await sql`SELECT id, phone, points FROM runs WHERE NOT flagged AND created_at < ${cutoffIso(cfg)}::timestamptz ORDER BY points DESC, id LIMIT 1`;
  if (!top.length) return { ok: false, error: 'no runs yet' };
  const code = couponCode();
  const rows = await sql`INSERT INTO coupons (code, type, phone, value, points, expires_at)
    VALUES (${code}, 'grand', ${top[0].phone}, ${cfg.grand.prize}, ${top[0].points}, ${expiryIso(cfg)}::timestamptz)
    ON CONFLICT DO NOTHING RETURNING code`;
  return rows.length ? { ok: true, code } : { ok: false, error: 'already awarded' };
}
async function securityReport() {
  const [events, suspects, clusters, banned] = await Promise.all([
    sql`SELECT id, (extract(epoch FROM at) * 1000)::bigint AS ts, kind, ip, phone, detail FROM security_events
        WHERE kind NOT IN ('register', 'admin_login_ok') ORDER BY id DESC LIMIT 100`,
    sql`SELECT r.phone, p.name, p.ip, (p.banned_at IS NOT NULL) AS banned, count(*)::int AS runs,
               count(*) FILTER (WHERE r.flagged AND r.reason IS DISTINCT FROM 'banned')::int AS flagged,
               max(CASE WHEN r.secs >= 60 THEN r.points::float / r.secs END)::numeric(6,1) AS fastest,
               array_agg(DISTINCT r.reason) FILTER (WHERE r.flagged AND r.reason IS DISTINCT FROM 'banned') AS reasons
        FROM runs r JOIN players p USING (phone) WHERE r.created_at > now() - interval '7 days'
        GROUP BY r.phone, p.name, p.ip, p.banned_at
        HAVING count(*) FILTER (WHERE r.flagged AND r.reason IS DISTINCT FROM 'banned') >= 2
            OR max(CASE WHEN r.secs >= 60 THEN r.points::float / r.secs END) > 30
        ORDER BY flagged DESC, fastest DESC NULLS LAST LIMIT 30`,
    sql`SELECT ip, count(DISTINCT phone)::int AS numbers FROM security_events
        WHERE kind = 'register' AND at > now() - interval '24 hours' AND ip IS NOT NULL
        GROUP BY ip HAVING count(DISTINCT phone) >= 5 ORDER BY numbers DESC LIMIT 20`,
    sql`SELECT phone, name, (extract(epoch FROM banned_at) * 1000)::bigint AS ts FROM players WHERE banned_at IS NOT NULL ORDER BY banned_at DESC`
  ]);
  return {
    events: events.map(e => ({ ...e, id: Number(e.id), ts: Number(e.ts) })),
    suspects: suspects.map(s => ({ ...s, fastest: s.fastest == null ? null : Number(s.fastest), reasons: s.reasons || [] })),
    clusters, banned: banned.map(b => ({ ...b, ts: Number(b.ts) }))
  };
}
const OWNER_ONLY = new Set(['config', 'grand', 'disable_user']);
export default handler(['GET', 'POST'], async (req, res, b) => {
  const { ip, user } = await adminGate(req);
  if (req.method === 'POST') {
    const audit = (what, extra) => logEvent('admin_action', ip, null, { by: user.username, action: what, ...extra });
    if (OWNER_ONLY.has(b.action) && user.role !== 'owner') {
      await logEvent('admin_denied', ip, null, { by: user.username, action: String(b.action) });
      return send(res, 403, { error: 'Only the owner can do that.' });
    }
    if (b.action === 'redeem') {
      await sql`UPDATE coupons SET redeemed_at = ${b.value ? new Date().toISOString() : null} WHERE code = ${String(b.code)}`;
      await audit('redeem', { code: String(b.code).slice(0, 20), value: !!b.value });
    } else if (b.action === 'config') {
      const c = await saveConfig(b.config);
      await audit('config', { tiers: c.tiers.length, grand: c.grand, daily: c.daily.on });
    } else if (b.action === 'unflag') {
      await sql`UPDATE runs SET flagged = false, reason = 'approved by admin' WHERE id = ${int(b.id)}`;
      await audit('unflag', { run: int(b.id) });
    } else if (b.action === 'grand') {
      const r = await awardGrand(await getConfig());
      await audit('grand', { result: r.ok ? 'awarded' : r.error });
      return send(res, 200, r);
    } else if (b.action === 'ban') {
      if (!validPhone(b.phone)) return send(res, 400, { error: 'bad phone' });
      if (b.value === false) {
        await sql`UPDATE players SET banned_at = NULL WHERE phone = ${b.phone}`;
        await sql`UPDATE runs SET flagged = false, reason = NULL WHERE phone = ${b.phone} AND reason = 'banned'`;
        await audit('unban', { phone: b.phone });
      } else {
        await sql`UPDATE players SET banned_at = now() WHERE phone = ${b.phone}`;
        await sql`UPDATE runs SET flagged = true, reason = 'banned' WHERE phone = ${b.phone} AND NOT flagged`;
        await audit('ban', { phone: b.phone });
        await alert('Admin banned ' + b.phone);
      }
    } else if (b.action === 'set_pin') {
      // Change your own PIN, or (owner only) reset someone else's: a new random PIN is returned once.
      const target = b.username == null ? user.username : String(b.username).trim().toLowerCase();
      if (target !== user.username && user.role !== 'owner') {
        await logEvent('admin_denied', ip, null, { by: user.username, action: 'set_pin', target });
        return send(res, 403, { error: 'Only the owner can reset someone else\'s PIN.' });
      }
      let pin = typeof b.pin === 'string' ? b.pin : '', generated = false;
      if (!pin && target !== user.username) { pin = randomPin(); generated = true; }
      if (pin.length < MIN_PIN || pin.length > 64) return send(res, 400, { error: 'PIN must be at least ' + MIN_PIN + ' characters.' });
      const done = await sql`UPDATE admin_users SET pin_hash = ${hashPin(pin)}, pin_changed_at = now() WHERE username = ${target} RETURNING username`;
      if (!done.length) return send(res, 404, { error: 'no such user' });
      await audit('set_pin', { target, generated });
      return send(res, 200, generated ? { ok: true, username: target, pin } : { ok: true });
    } else if (b.action === 'disable_user') {
      const target = String(b.username || '').trim().toLowerCase();
      if (target === user.username) return send(res, 400, { error: 'You cannot disable your own account.' });
      const done = b.value === false ? await sql`UPDATE admin_users SET disabled_at = NULL WHERE username = ${target} RETURNING username`
                                     : await sql`UPDATE admin_users SET disabled_at = now() WHERE username = ${target} RETURNING username`;
      if (!done.length) return send(res, 404, { error: 'no such user' });
      await audit(b.value === false ? 'enable_user' : 'disable_user', { target });
    } else if (b.action === 'reset_player') {
      // The real owner lost their phone: let them sign in again once, within 24 hours.
      if (!validPhone(b.phone)) return send(res, 400, { error: 'bad phone' });
      await sql`UPDATE players SET reclaim_until = now() + interval '24 hours' WHERE phone = ${b.phone} AND banned_at IS NULL`;
      await audit('reset_player', { phone: b.phone });
    } else return send(res, 400, { error: 'unknown action' });
    return send(res, 200, { ok: true });
  }
  const [st, config, leaderboard, coupons, runs, security, sources, users] = await Promise.all([
    stats(), getConfig(),
    sql`SELECT r.phone, p.name, max(r.points)::int AS points, (array_agg(r.coins ORDER BY r.points DESC))[1] AS coins,
               count(*)::int AS runs, (extract(epoch FROM max(r.created_at)) * 1000)::bigint AS last
        FROM runs r JOIN players p USING (phone) WHERE NOT r.flagged
        GROUP BY r.phone, p.name ORDER BY points DESC LIMIT 100`,
    sql`SELECT c.*, p.name, (p.banned_at IS NOT NULL) AS banned FROM coupons c JOIN players p USING (phone) ORDER BY c.issued_at DESC LIMIT 300`,
    sql`SELECT r.id, r.phone, p.name, r.points, r.coins, r.secs, r.flagged, r.reason, (extract(epoch FROM r.created_at) * 1000)::bigint AS ts
        FROM runs r JOIN players p USING (phone) ORDER BY r.created_at DESC LIMIT 50`,
    securityReport(),
    sql`WITH pr AS (SELECT phone, count(*) FILTER (WHERE NOT flagged)::int AS n FROM runs GROUP BY phone),
             pc AS (SELECT phone, count(*)::int AS n FROM coupons GROUP BY phone)
        SELECT coalesce(p.ref, 'direct') AS source, count(*)::int AS players, coalesce(sum(pr.n), 0)::int AS runs, coalesce(sum(pc.n), 0)::int AS prizes
        FROM players p LEFT JOIN pr ON pr.phone = p.phone LEFT JOIN pc ON pc.phone = p.phone
        GROUP BY 1 ORDER BY players DESC LIMIT 60`,
    user.role === 'owner' ? sql`SELECT username, display_name, role, (extract(epoch FROM last_login_at) * 1000)::bigint AS last_login, (disabled_at IS NOT NULL) AS disabled FROM admin_users ORDER BY created_at` : []
  ]);
  send(res, 200, {
    me: user, sources, users: users.map(u => ({ ...u, last_login: u.last_login == null ? null : Number(u.last_login) })), stats: st, config, security,
    leaderboard: leaderboard.map(r => ({ ...r, last: Number(r.last) })),
    coupons: coupons.map(c => ({ ...couponOut(c), banned: c.banned })),
    runs: runs.map(r => ({ ...r, id: Number(r.id), ts: Number(r.ts) }))
  });
});
