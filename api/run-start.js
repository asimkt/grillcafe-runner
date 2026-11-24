import { sql, handler, send, auth } from './_lib.js';
// POST { phone, token } -> { sessionId, startedAt }. The server clock times every run.
export default handler(['POST'], async (req, res, b) => {
  const p = await auth(b.phone, b.token, req);
  const recent = await sql`SELECT count(*)::int AS n FROM sessions WHERE phone = ${p.phone} AND started_at > now() - interval '1 minute'`;
  if (recent[0].n >= 6) return send(res, 429, { error: 'too many runs, slow down' });
  const [s] = await sql`INSERT INTO sessions (phone) VALUES (${p.phone}) RETURNING id, started_at`;
  // prize levels this player already holds, so the game can skip the super zone for them
  const won = await sql`SELECT tier FROM coupons WHERE phone = ${p.phone} AND type = 'tier' ORDER BY tier`;
  send(res, 200, { sessionId: s.id, startedAt: new Date(s.started_at).getTime(), won: won.map(r => r.tier) });
});
