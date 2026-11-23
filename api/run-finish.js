import { sql, handler, send, auth, loadSession, judgeRun, int, stats, getIp, logEvent, alert, LIMITS } from './_lib.js';
// POST { phone, token, sessionId, points, coins, metres, secs, livesUsed, powerups, events }
export default handler(['POST'], async (req, res, b) => {
  const p = await auth(b.phone, b.token, req), ip = getIp(req);
  const ses = await loadSession(b.sessionId, p.phone);
  const s = { points: int(b.points), coins: int(b.coins), metres: int(b.metres), secs: int(b.secs, 86400) };
  let why = ses ? judgeRun(s, Number(ses.secs)) : 'no session';
  if (ses && ses.finished_at) why = 'session already used';
  const before = await stats();
  let events = Array.isArray(b.events) ? JSON.stringify(b.events.slice(-1500)) : null;
  if (events && events.length > 100000) events = null; // junk or oversized: keep the run, drop the trace
  const rows = await sql`
    INSERT INTO runs (session_id, phone, points, coins, metres, secs, lives_used, powerups, events, flagged, reason, ip)
    VALUES (${ses && !ses.finished_at ? ses.id : null}, ${p.phone}, ${s.points}, ${s.coins}, ${s.metres}, ${s.secs},
            ${int(b.livesUsed, 100)}, ${int(b.powerups, 1000)}, ${events}::jsonb, ${!!why}, ${why}, ${ip})
    ON CONFLICT (session_id) DO NOTHING
    RETURNING id, points, coins, metres, secs, flagged, created_at`;
  if (ses && !ses.finished_at) await sql`UPDATE sessions SET finished_at = now() WHERE id = ${ses.id}`;
  const run = rows[0] || null;
  if (why) {
    await logEvent('cheat_flag', ip, p.phone, { reason: why, points: s.points, coins: s.coins, secs: s.secs, serverSecs: ses ? Math.round(Number(ses.secs)) : null });
    const [f] = await sql`SELECT count(*)::int AS n FROM runs WHERE phone = ${p.phone} AND flagged AND created_at > now() - interval '24 hours'`;
    if (f.n === LIMITS.flagsBeforeAlert) await alert(p.phone + ' (' + p.name + ') has ' + f.n + ' flagged runs in 24h, latest: ' + why + '. IP ' + ip);
  }
  const after = await stats();
  send(res, 200, {
    run, best: before.best ? before.best.points : 0, flagged: !!why,
    top: !!(run && after.best && after.best.id === Number(run.id)),
    leading: !!(run && after.leader && after.leader.id === Number(run.id))
  });
});
