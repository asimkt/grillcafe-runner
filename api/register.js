import { sql, handler, send, fail, validPhone, newToken, safeEqual, getIp, logEvent, alert, LIMITS } from './_lib.js';
// POST { name, phone, token? } -> { name, phone, token }.
// A number that already has runs or coupons can only be signed in again by the phone that holds its current token,
// or after the cafe team unlocks it in admin (otherwise anyone could take over a number and read its coupons).
// TODO before launch: verify the phone with an OTP (MSG91 / Firebase) before returning a token.
export default handler(['POST'], async (req, res, b) => {
  const ip = getIp(req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30), phone = String(b.phone || '');
  if (name.length < 2 || !validPhone(phone)) throw fail(400, 'name and 10-digit mobile required');

  const [t] = await sql`SELECT count(*)::int AS n FROM security_events WHERE kind = 'register' AND ip = ${ip} AND at > now() - interval '1 hour'`;
  if (t.n >= LIMITS.registerPerIpHour) {
    await logEvent('rate_limited', ip, phone, { what: 'register' }, 300);
    throw fail(429, 'Too many sign-ups from this network. Try again in a while.');
  }

  const [p] = await sql`SELECT token, banned_at, (reclaim_until IS NOT NULL AND reclaim_until > now()) AS unlocked,
      (EXISTS (SELECT 1 FROM runs WHERE phone = ${phone}) OR EXISTS (SELECT 1 FROM coupons WHERE phone = ${phone})) AS in_use
    FROM players WHERE phone = ${phone}`;
  if (p) {
    if (p.banned_at) { await logEvent('banned_access', ip, phone, { what: 'register' }, 300); throw fail(403, 'This number has been blocked by the cafe team.'); }
    const owner = typeof b.token === 'string' && b.token && safeEqual(p.token, b.token);
    if (p.in_use && !owner && !p.unlocked) {
      await logEvent('register_blocked', ip, phone, { why: 'number already in use on another phone' });
      await alert('Sign-in blocked: someone tried to take over ' + phone + ' from ' + ip);
      throw fail(409, 'This number is already playing on another phone. Ask the cafe team to unlock it.');
    }
  }
  const token = newToken();
  await sql`INSERT INTO players (phone, name, token, ip) VALUES (${phone}, ${name}, ${token}, ${ip})
            ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, token = EXCLUDED.token, ip = EXCLUDED.ip, reclaim_until = NULL`;
  await logEvent('register', ip, phone, {});
  send(res, 200, { name, phone, token });
});
