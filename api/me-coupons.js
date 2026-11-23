import { sql, handler, send, auth, couponOut } from './_lib.js';
// POST { phone, token } -> the player's coupons. Needs the device token, so nobody can read another number's codes.
export default handler(['POST'], async (req, res, b) => {
  const p = await auth(b.phone, b.token, req);
  const rows = await sql`SELECT * FROM coupons WHERE phone = ${p.phone} ORDER BY issued_at DESC`;
  send(res, 200, rows.map(couponOut));
});
