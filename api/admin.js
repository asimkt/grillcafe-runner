import { sql, handler, send, adminGate, stats, getConfig, saveConfig, cutoffIso, couponOut, couponCode, int, validPhone, logEvent, alert } from './_lib.js';
// GET  (header x-admin-pin) -> overview for the admin page, including the security report
// POST (header x-admin-pin) { action: 'redeem' | 'config' | 'unflag' | 'grand' | 'ban' | 'reset_player', ... }
// Every request goes through adminGate: wrong-PIN lockout and audit trail. Every action is written to security_events.
export async function awardGrand(cfg) {
  const top = await sql`SELECT id, phone, points FROM runs WHERE NOT flagged AND created_at < ${cutoffIso(cfg)}::timestamptz ORDER BY points DESC, id LIMIT 1`;
  if (!top.length) return { ok: false, error: 'no runs yet' };
  const code = couponCode();
  const rows = await sql`INSERT INTO coupons (code, type, phone, value, points, expires_at)
    VALUES (${code}, 'grand', ${top[0].phone}, ${cfg.grand.prize}, ${top[0].points}, now() + make_interval(days => ${cfg.validDays}::int))
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
export default handler(['GET', 'POST'], async (req, res, b) => {
  const ip = await adminGate(req);
  if (req.method === 'POST') {
    const audit = (what, extra) => logEvent('admin_action', ip, null, { action: what, ...extra });
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
    } else if (b.action === 'reset_player') {
      // The real owner lost their phone: let them sign in again once, within 24 hours.
      if (!validPhone(b.phone)) return send(res, 400, { error: 'bad phone' });
      await sql`UPDATE players SET reclaim_until = now() + interval '24 hours' WHERE phone = ${b.phone} AND banned_at IS NULL`;
      await audit('reset_player', { phone: b.phone });
    } else return send(res, 400, { error: 'unknown action' });
    return send(res, 200, { ok: true });
  }
  const [st, config, leaderboard, coupons, runs, security] = await Promise.all([
    stats(), getConfig(),
    sql`SELECT r.phone, p.name, max(r.points)::int AS points, (array_agg(r.coins ORDER BY r.points DESC))[1] AS coins,
               count(*)::int AS runs, (extract(epoch FROM max(r.created_at)) * 1000)::bigint AS last
        FROM runs r JOIN players p USING (phone) WHERE NOT r.flagged
        GROUP BY r.phone, p.name ORDER BY points DESC LIMIT 100`,
    sql`SELECT c.*, p.name, (p.banned_at IS NOT NULL) AS banned FROM coupons c JOIN players p USING (phone) ORDER BY c.issued_at DESC LIMIT 300`,
    sql`SELECT r.id, r.phone, p.name, r.points, r.coins, r.secs, r.flagged, r.reason, (extract(epoch FROM r.created_at) * 1000)::bigint AS ts
        FROM runs r JOIN players p USING (phone) ORDER BY r.created_at DESC LIMIT 50`,
    securityReport()
  ]);
  send(res, 200, {
    stats: st, config, security,
    leaderboard: leaderboard.map(r => ({ ...r, last: Number(r.last) })),
    coupons: coupons.map(c => ({ ...couponOut(c), banned: c.banned })),
    runs: runs.map(r => ({ ...r, id: Number(r.id), ts: Number(r.ts) }))
  });
});
