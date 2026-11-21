/* =========================================================
   NOTIFICATIONS — in-app alerts shown under the bell in the page header.

   Two things raise an alert (checked every 15 minutes, and straight after a project is saved):
     · EVENT OVERDUE   — an event of the Sequence of Events is still open after its planned finish date.
                         "Open" means the same as on the Project Progress page: not Completed and under 100% progress.
     · PROJECT BEHIND  — a project's progress variance (actual % - planned %, the figure shown in the project register and
                         used for the health rating) falls below -10 points.
   Completed projects are not checked. Each alert is written once (notifications.dedup_key is unique):
     · an event is identified by project + stage + name + planned finish — event ids change on every save, so they cannot be used.
       Moving the planned finish date out re-arms it; so does renaming the event.
     · a project alert fires when the variance first drops below -10, and again only after it has recovered to -10 or better
       (project_alert_state remembers which side of the line each project is on).
   Who sees an alert: the administrator sees all; everyone else only for the projects they have been granted. Read state is per person.
   Set NOTIFICATION_SCAN=off to switch the regular check off.
   ========================================================= */
'use strict';
const THRESHOLD = -10; // points of progress variance
const SCAN_EVERY_MS = 15 * 60 * 1000;
const dmy = iso => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const num = v => (Math.round((Number(v) || 0) * 10) / 10);

module.exports = function registerNotifications(app, d) {
  const { db, sessionUser, listProjects, listEvents, omanToday } = d;

  /* ---------- detection ---------- */
  async function add(n) {
    const r = await db.prepare(`INSERT INTO notifications (kind, dedup_key, project_id, severity, title, message, details) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dedup_key) DO NOTHING`).run(n.kind, n.key, n.projectId, n.severity, n.title, n.message, JSON.stringify(n.details || {}));
    return r.changes || 0;
  }

  // projectIds: array to check just those projects (after a save), or null for all. Returns how many alerts were created.
  async function scan(projectIds) {
    const today = omanToday();
    const projects = (await listProjects(projectIds || null)).filter(p => p.status !== 'Completed');
    if (!projects.length) return 0;
    const byId = new Map(projects.map(p => [p.id, p]));
    let created = 0;

    for (const e of await listEvents(projects.map(p => p.id))) {
      const p = byId.get(e.projectId);
      const done = e.status === 'Completed' || (Number(e.progressPct) || 0) >= 100;
      if (!p || done || !e.plannedEnd || e.plannedEnd >= today) continue;
      created += await add({
        kind: 'event-overdue', key: ['event-overdue', p.id, e.stage, e.eventName, e.plannedEnd].join('|'), projectId: p.id, severity: 'warn',
        title: `Event past its planned date: ${e.eventName}`,
        message: `${p.name} — "${e.eventName}" (${e.stage}) was due to finish on ${dmy(e.plannedEnd)} and is still ${e.status} at ${num(e.progressPct)}%.`,
        details: { eventName: e.eventName, stage: e.stage, plannedEnd: e.plannedEnd, status: e.status, progress: num(e.progressPct) }
      });
    }

    for (const p of projects) {
      if (p.variance < THRESHOLD) {
        // flips "below" from false to true in one statement, so only one of two overlapping checks raises the alert
        const flipped = (await db.prepare(`INSERT INTO project_alert_state (project_id, progress_below) VALUES (?, TRUE)
          ON CONFLICT (project_id) DO UPDATE SET progress_below = TRUE WHERE project_alert_state.progress_below = FALSE`).run(p.id)).changes;
        if (!flipped) continue;
        try {
          created += await add({
            kind: 'progress-behind', key: `progress-behind|${p.id}|${Date.now()}`, projectId: p.id, severity: 'bad',
            title: `Project behind plan: ${p.name}`,
            message: `${p.name} is ${Math.abs(num(p.variance))} points behind plan — actual progress ${num(p.actualPct)}% against ${num(p.plannedPct)}% planned.`,
            details: { actualPct: num(p.actualPct), plannedPct: num(p.plannedPct), variance: num(p.variance) }
          });
        } catch (e) { await db.prepare('UPDATE project_alert_state SET progress_below = FALSE WHERE project_id = ?').run(p.id); throw e; } // try again on the next check
      } else {
        await db.prepare('UPDATE project_alert_state SET progress_below = FALSE WHERE project_id = ? AND progress_below').run(p.id);
      }
    }
    return created;
  }

  let busy = false;
  const safeScan = async ids => {
    if (busy && !ids) return 0; // a full check is already running
    if (!ids) busy = true;
    try { const n = await db.outsideTransaction(() => scan(ids)); if (n && !ids) console.log(new Date().toISOString(), `notifications: ${n} new alert${n === 1 ? '' : 's'}`); return n; }
    catch (e) { console.error(new Date().toISOString(), 'notification check failed:', e.message); return 0; }
    finally { if (!ids) busy = false; }
  };
  if (process.env.NOTIFICATION_SCAN !== 'off') {
    setTimeout(() => safeScan(null), 15000).unref();
    setInterval(() => safeScan(null), SCAN_EVERY_MS).unref();
  }

  /* ---------- who can see what ---------- */
  const acl = require('./access');
  // everyone sees alerts for the projects they are granted; event alerts name an event, so those also need view on the Sequence of Events there
  const visible = u => (u.isAdmin ? { sql: '', params: [] }
    : { sql: " AND n.project_id = ANY(?::int[]) AND (n.kind <> 'event-overdue' OR n.project_id = ANY(?::int[]))",
        params: [u.projectIds || [], (u.projectIds || []).filter(pid => acl.canOn(u, 'events', 'view', pid))] });
  const FROM = `FROM notifications n JOIN projects p ON p.id = n.project_id AND p.deleted_at IS NULL
    LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.username = ?`;
  const parse = s => { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } };

  app.get('/api/notifications', async (req, res) => {
    const u = sessionUser(req), v = visible(u);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100), offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const unreadOnly = req.query.unread === '1' ? ' AND r.username IS NULL' : '';
    const [{ n: unread }, { n: total }] = await Promise.all([
      db.prepare(`SELECT COUNT(*)::int AS n ${FROM} WHERE r.username IS NULL${v.sql}`).get(u.username, ...v.params),
      db.prepare(`SELECT COUNT(*)::int AS n ${FROM} WHERE TRUE${v.sql}${unreadOnly}`).get(u.username, ...v.params)
    ]);
    const rows = await db.prepare(`SELECT n.id, n.kind, n.severity, n.title, n.message, n.details, n.project_id, n.created_at, p.name AS project_name, p.code AS project_code,
        (r.username IS NOT NULL) AS is_read ${FROM} WHERE TRUE${v.sql}${unreadOnly} ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(u.username, ...v.params, limit, offset);
    res.json({ unread, total, items: rows.map(r => ({ id: r.id, kind: r.kind, severity: r.severity, title: r.title, message: r.message, details: parse(r.details),
      projectId: r.project_id, projectName: r.project_name, projectCode: r.project_code, createdAt: r.created_at, read: !!r.is_read })) });
  });

  // body: { ids: [1, 2] } or { all: true }
  app.post('/api/notifications/read', async (req, res) => {
    const u = sessionUser(req), v = visible(u), b = req.body || {};
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 2147483647))].slice(0, 1000);
    if (!b.all && !ids.length) return res.status(400).json({ error: 'Nothing to mark as read' });
    const pick = b.all ? '' : ' AND n.id = ANY(?::int[])';
    await db.prepare(`INSERT INTO notification_reads (notification_id, username)
      SELECT n.id, ? FROM notifications n JOIN projects p ON p.id = n.project_id AND p.deleted_at IS NULL WHERE TRUE${v.sql}${pick} ON CONFLICT DO NOTHING`)
      .run(u.username, ...v.params, ...(b.all ? [] : [ids]));
    res.json({ ok: true });
  });

  return { scan: safeScan };
};
