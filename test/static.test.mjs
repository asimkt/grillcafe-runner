// Checks on the files themselves: headers, public files, secrets. No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name === '.git' || e.name === '.vercel' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('security headers are set for every page', () => {
  const h = Object.fromEntries(JSON.parse(read('vercel.json')).headers[0].headers.map(x => [x.key, x.value]));
  assert.equal(h['X-Content-Type-Options'], 'nosniff'); assert.equal(h['X-Frame-Options'], 'DENY'); assert.match(h['Strict-Transport-Security'], /max-age=\d{7,}/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/); assert.match(h['Content-Security-Policy'], /connect-src 'self'/); assert.match(h['Content-Security-Policy'], /object-src 'none'/);
  assert.ok(!/script-src[^;]*https?:/.test(h['Content-Security-Policy']), 'no third-party scripts allowed');
});
test('internal files are not published', () => {
  const ign = read('.vercelignore'); for (const f of ['HANDOFF.md', 'schema.sql', 'README.md', 'game-test-mode.html', 'test', 'scripts']) assert.ok(ign.split('\n').includes(f), f);
});
test('no secrets or connection strings are committed', () => {
  const bad = [];
  for (const f of walk(root)) { if (/\.(png|jpg|ico|woff2?)$/.test(f)) continue; const t = fs.readFileSync(f, 'utf8'); if (/npg_[A-Za-z0-9]{8,}|postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/.test(t)) bad.push(path.relative(root, f)); }
  assert.deepEqual(bad, []);
  assert.ok(read('.gitignore').includes('.env'));
});
test('every API endpoint checks the HTTP method, and none use string-built SQL', () => {
  for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => !f.startsWith('_'))) {
    const t = read('api/' + f); assert.match(t, /handler\(\[/, f);
    assert.ok(!/sql\(\s*[`'"]/.test(t) && !/sql\.unsafe/.test(t), f + ' builds SQL from strings');
  }
});
test('nothing polls the server in the background more often than every 30 minutes', () => {
  for (const f of ['index.html', 'play.html']) for (const m of read(f).matchAll(/setInterval\([^;]*?,\s*([^)]+)\)\s*;/gs)) {
    const ms = Function('return (' + m[1].replace(/\*/g, '*') + ')')(); if (ms >= 1000 && ms < 1800000 && !/tick/.test(m[0])) assert.fail(f + ' polls every ' + ms + 'ms: ' + m[0].slice(0, 80));
  }
});
test('public pages never describe how cheating is detected', () => {
  for (const f of ['index.html', 'play.html']) { const t = read(f).replace(/<script[\s\S]*?<\/script>/g, m => m.includes('GRILL_CONFIG') ? '' : m);
    for (const m of t.matchAll(/(timed by our server|look impossible|held back|checked by the cafe team|flagged for review|will be checked)/gi)) { const ctx = t.slice(Math.max(0, m.index - 60), m.index + 60); if (!/\/\/|admin|Admin|data-unflag|runs flagged/.test(ctx)) assert.fail(f + ' reveals: ' + ctx); } }
});
test('the landing page frames the player as the poocha, not the chaser', () => {
  const t = read('index.html'); assert.ok(!/catch the poocha|chase the poocha|run it down/i.test(t)); assert.match(t, /you’re the <b>poocha<\/b>/i);
});
test('table QR links (/t/12) are routed to the landing page', () => assert.ok(JSON.parse(read('vercel.json')).rewrites.some(r => r.source === '/t/:n')));
test('admin endpoints always go through the login gate, and there is no shared PIN left', () => {
  assert.match(read('api/admin.js'), /await adminGate\(req\)/);
  for (const f of fs.readdirSync(path.join(root, 'api'))) assert.ok(!/ADMIN_PIN/.test(read('api/' + f)), f + ' still reads ADMIN_PIN');
});
test('the game never writes player-supplied text without escaping it', () => {
  const t = read('play.html');
  for (const m of t.matchAll(/\.name\b[^;\n]{0,40}/g)) if (/innerHTML|\+\s*r\.name|\+\s*x\.name|\+\s*b\.name|\+\s*c\.name/.test(m[0]) && !/esc\(/.test(m[0])) assert.fail('unescaped name: ' + m[0]);
});
test('the public pages load nothing from third parties except Google Fonts', () => {
  for (const f of ['index.html', 'play.html']) { if (!fs.existsSync(path.join(root, f))) continue; const hosts = new Set([...read(f).matchAll(/(?:src|href)=["']https?:\/\/([^/"']+)/g)].map(m => m[1])); for (const h of hosts) assert.ok(['fonts.googleapis.com', 'fonts.gstatic.com'].includes(h), f + ' loads ' + h); }
});
