import { sql, handler, send, adminOk, stats, getConfig, saveConfig, couponOut, couponCode, int } from './_lib.js';
// GET  (header x-admin-pin) -> overview for the admin page
// POST (header x-admin-pin) { action: 'redeem' | 'config' | 'unflag' | 'grand', ... }
export async function awardGrand(cfg) {
  const top = await sql`SELECT id, phone, points FROM runs WHERE NOT flagged ORDER BY points DESC, id LIMIT 1`;
  if (!top.length) return { ok: false, error: 'no runs yet' };
  const code = couponCode();
  const rows = await sql`INSERT INTO coupons (code, type, phone, value, points, expires_at)
    VALUES (${code}, 'grand', ${top[0].phone}, ${cfg.grand.prize}, ${top[0].points}, now() + make_interval(days => ${cfg.validDays}::int))
    ON CONFLICT DO NOTHING RETURNING code`;
  return rows.length ? { ok: true, code } : { ok: false, error: 'already awarded' };
}
export default handler(['GET', 'POST'], async (req, res, b) => {
  if (!adminOk(req)) return send(res, 401, { error: 'wrong PIN' });
  if (req.method === 'POST') {
    if (b.action === 'redeem') {
      await sql`UPDATE coupons SET redeemed_at = ${b.value ? new Date().toISOString() : null} WHERE code = ${String(b.code)}`;
    } else if (b.action === 'config') {
      await saveConfig(b.config);
    } else if (b.action === 'unflag') {
      await sql`UPDATE runs SET flagged = false, reason = 'approved by admin' WHERE id = ${int(b.id)}`;
    } else if (b.action === 'grand') {
      return send(res, 200, await awardGrand(await getConfig()));
    } else return send(res, 400, { error: 'unknown action' });
    return send(res, 200, { ok: true });
  }
  const [st, config, leaderboard, coupons, runs] = await Promise.all([
    stats(), getConfig(),
    sql`SELECT r.phone, p.name, max(r.points)::int AS points, (array_agg(r.coins ORDER BY r.points DESC))[1] AS coins,
               count(*)::int AS runs, (extract(epoch FROM max(r.created_at)) * 1000)::bigint AS last
        FROM runs r JOIN players p USING (phone) WHERE NOT r.flagged
        GROUP BY r.phone, p.name ORDER BY points DESC LIMIT 100`,
    sql`SELECT c.*, p.name FROM coupons c JOIN players p USING (phone) ORDER BY c.issued_at DESC LIMIT 300`,
    sql`SELECT r.id, r.phone, p.name, r.points, r.coins, r.secs, r.flagged, r.reason, (extract(epoch FROM r.created_at) * 1000)::bigint AS ts
        FROM runs r JOIN players p USING (phone) ORDER BY r.created_at DESC LIMIT 50`
  ]);
  send(res, 200, {
    stats: st, config,
    leaderboard: leaderboard.map(r => ({ ...r, last: Number(r.last) })),
    coupons: coupons.map(couponOut),
    runs: runs.map(r => ({ ...r, id: Number(r.id), ts: Number(r.ts) }))
  });
});
