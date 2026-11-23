import { handler, stats } from './_lib.js';
// GET /api/stats          -> live numbers for the game (never cached)
// GET /api/stats?public=1 -> same data for the marketing page, cached at the edge for 30 minutes so visitors don't wake the database
export default handler(['GET'], async (req, res) => {
  const out = await stats();
  const pub = String((req.query && req.query.public) || '') === '1';
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', pub ? 'public, s-maxage=1800, stale-while-revalidate=600' : 'no-store');
  res.end(JSON.stringify(out));
});
