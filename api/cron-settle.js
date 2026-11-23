import { sql, handler, send, couponCode, getConfig } from './_lib.js';
import { awardGrand } from './admin.js';
// Runs daily at 00:05 India time (vercel.json).
// 1. If the daily record prize is on: each finished India day's top run wins it, if it beat every earlier run.
// 2. Once the campaign end date has passed: the top score overall wins the grand prize (once).
export default handler(['GET'], async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { error: 'unauthorized' });
  const cfg = await getConfig(), out = { daily: [], grand: null };
  const days = await sql`
    SELECT DISTINCT ((created_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS d FROM runs
    WHERE NOT flagged AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND (created_at AT TIME ZONE 'Asia/Kolkata')::date NOT IN (SELECT day FROM daily_awards)
    ORDER BY d`;
  for (const { d } of days) {
    let code = null, top = null;
    if (cfg.daily.on) {
      const [b] = await sql`SELECT coalesce(max(points), 0)::int AS best FROM runs WHERE NOT flagged AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < ${d}::date`;
      [top] = await sql`SELECT id, phone, points FROM runs WHERE NOT flagged AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${d}::date ORDER BY points DESC, id LIMIT 1`;
      if (top && top.points > b.best) {
        code = couponCode();
        await sql`INSERT INTO coupons (code, type, phone, value, points, expires_at)
                  VALUES (${code}, 'record', ${top.phone}, ${cfg.daily.prize}, ${top.points}, now() + make_interval(days => ${cfg.validDays}::int))`;
      } else top = null;
    }
    await sql`INSERT INTO daily_awards (day, phone, run_id, points, coupon_code)
              VALUES (${d}::date, ${top ? top.phone : null}, ${top ? top.id : null}, ${top ? top.points : null}, ${code}) ON CONFLICT (day) DO NOTHING`;
    out.daily.push({ day: d, code });
  }
  const [ended] = await sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date > ${cfg.grand.endsAt}::date AS over`;
  if (ended.over) out.grand = await awardGrand(cfg);
  send(res, 200, out);
});
