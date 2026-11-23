import { sql, handler, send, fail, validPhone, newToken } from './_lib.js';
// POST { name, phone } -> { name, phone, token }. Issues a fresh device token each time.
// TODO before launch: verify the phone with an OTP (MSG91 / Firebase) before returning a token.
export default handler(['POST'], async (req, res, b) => {
  const name = String(b.name || '').trim().slice(0, 30), phone = String(b.phone || '');
  if (name.length < 2 || !validPhone(phone)) throw fail(400, 'name and 10-digit mobile required');
  const token = newToken();
  await sql`INSERT INTO players (phone, name, token) VALUES (${phone}, ${name}, ${token})
            ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, token = EXCLUDED.token`;
  send(res, 200, { name, phone, token });
});
