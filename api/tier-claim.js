import { sql, handler, send, auth, getConfig, loadSession, judgeRun, couponCode, int, couponOut } from './_lib.js';
// POST { phone, token, sessionId, tier, points, coins, secs } when the run enters the super zone before a prize.
// One coupon per phone per prize level, never more than that level's winners, even under concurrent claims.
export default handler(['POST'], async (req, res, b) => {
  const p = await auth(b.phone, b.token);
  const ses = await loadSession(b.sessionId, p.phone);
  if (!ses || ses.finished_at) return send(res, 200, { rejected: true, reason: 'unknown session' });
  const cfg = await getConfig(), ti = int(b.tier, 100), tier = cfg.tiers[ti];
  if (!tier) return send(res, 200, { rejected: true, reason: 'no such prize' });
  const s = { points: int(b.points), coins: int(b.coins), secs: int(b.secs, 86400) };
  const why = judgeRun(s, Number(ses.secs));
  if (why) return send(res, 200, { rejected: true, reason: why });
  if (s.points < tier.points - cfg.safeZone) return send(res, 200, { rejected: true, reason: 'not enough points' });
  const code = couponCode();
  const [, inserted, count] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(424242, ${ti}::int)`,
    sql`INSERT INTO coupons (code, type, tier, phone, value, session_id, points, expires_at)
        SELECT ${code}, 'tier', ${ti}::int, ${p.phone}, ${tier.prize}, ${ses.id}, ${tier.points}, now() + make_interval(days => ${cfg.validDays}::int)
        WHERE NOT EXISTS (SELECT 1 FROM coupons WHERE type = 'tier' AND tier = ${ti}::int AND phone = ${p.phone})
          AND (SELECT count(*) FROM coupons WHERE type = 'tier' AND tier = ${ti}::int) < ${tier.slots}::int
        RETURNING *`,
    sql`SELECT count(*)::int AS n FROM coupons WHERE type = 'tier' AND tier = ${ti}::int`
  ]);
  if (inserted.length) return send(res, 200, { won: true, rank: count[0].n, coupon: couponOut(inserted[0]) });
  const mine = await sql`SELECT * FROM coupons WHERE type = 'tier' AND tier = ${ti}::int AND phone = ${p.phone}`;
  if (mine.length) return send(res, 200, { already: true, coupon: couponOut(mine[0]) });
  send(res, 200, { soldOut: true });
});
