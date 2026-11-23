// Manage admin accounts from your terminal. The PIN is printed once and only its hash is stored.
//   DATABASE_URL=postgresql://... node scripts/admin-user.mjs add <username> <owner|manager> "<Display name>"
//   DATABASE_URL=postgresql://... node scripts/admin-user.mjs reset <username>
//   DATABASE_URL=postgresql://... node scripts/admin-user.mjs disable|enable <username>
//   DATABASE_URL=postgresql://... node scripts/admin-user.mjs list
import { neon } from '@neondatabase/serverless';
import { hashPin, randomPin } from '../api/_lib.js';
const [cmd, user, role, ...name] = process.argv.slice(2);
const sql = neon(process.env.DATABASE_URL);
const u = String(user || '').toLowerCase();
if (cmd === 'add') {
  if (!/^[a-z0-9._-]{2,30}$/.test(u) || !['owner', 'manager'].includes(role)) { console.error('usage: add <username> <owner|manager> "<Display name>"'); process.exit(1); }
  const pin = randomPin();
  await sql`INSERT INTO admin_users (username, display_name, role, pin_hash) VALUES (${u}, ${name.join(' ') || u}, ${role}, ${hashPin(pin)})`;
  console.log(`${u} (${role}) created. PIN: ${pin}   <- shown once`);
} else if (cmd === 'reset') {
  const pin = randomPin();
  const r = await sql`UPDATE admin_users SET pin_hash = ${hashPin(pin)}, pin_changed_at = now(), disabled_at = NULL WHERE username = ${u} RETURNING username`;
  console.log(r.length ? `${u}: new PIN ${pin}   <- shown once` : 'no such user');
} else if (cmd === 'disable' || cmd === 'enable') {
  const r = cmd === 'disable' ? await sql`UPDATE admin_users SET disabled_at = now() WHERE username = ${u} RETURNING username` : await sql`UPDATE admin_users SET disabled_at = NULL WHERE username = ${u} RETURNING username`;
  console.log(r.length ? `${u}: ${cmd}d` : 'no such user');
} else if (cmd === 'list') {
  console.table(await sql`SELECT username, display_name, role, last_login_at, disabled_at FROM admin_users ORDER BY created_at`);
} else { console.error('commands: add | reset | disable | enable | list'); process.exit(1); }
