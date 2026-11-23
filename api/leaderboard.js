import { sql, handler, getConfig, cutoffIso } from './_lib.js';
// GET /api/leaderboard -> { daily: [{rank, name, points}], overall: [...], day, updatedAt }
// Best run per player. Today = India date. Flagged and banned runs never appear. Mobile numbers are never returned.
// Cached at the edge for 30 minutes, so visitors almost never reach the database and Neon can stay asleep (it bills compute time).
// ?live=1 (used by the game when a player opens the board) is cached for just 60 seconds: that player is already waking the database.
const TOP = 25;
export default handler(['GET'], async (req, res) => {
  const cutoff = cutoffIso(await getConfig());
  const [daily, overall, [d]] = await Promise.all([
    sql`SELECT p.name, max(r.points)::int AS points, min(r.id) AS first_id
        FROM runs r JOIN players p USING (phone)
        WHERE NOT r.flagged AND p.banned_at IS NULL AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        GROUP BY r.phone, p.name ORDER BY points DESC, first_id LIMIT ${TOP}`,
    sql`SELECT p.name, max(r.points)::int AS points, min(r.id) AS first_id
        FROM runs r JOIN players p USING (phone)
        WHERE NOT r.flagged AND p.banned_at IS NULL AND r.created_at < ${cutoff}::timestamptz
        GROUP BY r.phone, p.name ORDER BY points DESC, first_id LIMIT ${TOP}`,
    sql`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS day`
  ]);
  const rows = list => list.map((r, i) => ({ rank: i + 1, name: String(r.name).slice(0, 30), points: r.points }));
  const live = String((req.query && req.query.live) || '') === '1';
  res.setHeader('Cache-Control', live ? 'public, s-maxage=60' : 'public, s-maxage=1800, stale-while-revalidate=600');
  res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ closesAt: cutoff, day: d.day, daily: rows(daily), overall: rows(overall), updatedAt: Date.now() }));
});
