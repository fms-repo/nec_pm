const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs'); // only for the Sequence of Events template — it writes real
// Excel dropdown (data validation) cells, which the xlsx package's free edition cannot do.
const db = require('./db');
const { STARTER_RISKS, STARTER_ISSUES } = require('./db/demoData');

// Express 4 doesn't pass a rejected promise from an async route handler on to the error
// handler (Express 5 does), so a failed database call would leave the request hanging. Same
// as Express's own Layer#handle_request, plus forwarding the returned promise's rejection.
const Layer = require('express/lib/router/layer');
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // error-handling middleware, not a request handler
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

const app = express();
const PORT = process.env.PORT || 3000;

const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || 'nwa2026';

// gzip every response the browser accepts it for. The JSON this app returns is highly
// repetitive, so it shrinks ~20-25x — e.g. the dashboard's /api/bootstrap for a 2,000-project
// programme goes from ~60 MB to ~2.4 MB on the wire.
app.use(compression());
// A project is saved as one request, including every Sequence of Events row with its materials and crew:
// a few hundred rows is well past Express's 100 KB default.
app.use(express.json({ limit: '25mb' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(session({
  secret: process.env.SESSION_SECRET || 'water-rehab-dashboard-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 } // 8h
}));

// Logo/images must be reachable from the login screen before the user is authenticated.
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

/* =========================================================
   SIGN-IN — the shared administrator login (APP_USERNAME/APP_PASSWORD from the environment)
   plus personal accounts held in user_accounts (one per team member, created by an administrator).
   The session records who is signed in: userType 'admin' | 'user', and for personal accounts the
   team member id — which is what lets the approval workflow know whose turn it is to sign.
   ========================================================= */
const auth = require('./auth');
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const ACCOUNT_RECHECK_MS = 60 * 1000; // how often a signed-in personal account is re-checked as still active

// Failed sign-ins per IP address: past MAX_FAILED_PER_IP in 15 minutes, further attempts are refused
// outright. The per-account lock-out below stops guessing one person's password; this stops
// someone trying many different usernames (or the shared administrator login) from one place.
const MAX_FAILED_PER_IP = 30;
const failedByIp = new Map();
function ipThrottled(req) {
  const e = failedByIp.get(clientIp(req) || '?');
  return !!e && e.reset > Date.now() && e.n >= MAX_FAILED_PER_IP;
}
function noteFailedLogin(req) {
  const ip = clientIp(req) || '?', now = Date.now();
  if (failedByIp.size > 5000) for (const [k, v] of failedByIp) if (v.reset < now) failedByIp.delete(k);
  let e = failedByIp.get(ip);
  if (!e || e.reset < now) { e = { n: 0, reset: now + LOCKOUT_MINUTES * 60000 }; failedByIp.set(ip, e); }
  e.n++;
}

function sessionUser(req) {
  const s = req.session || {};
  if (!s.authenticated) return null;
  return {
    username: s.username, userType: s.userType || 'admin', isAdmin: (s.userType || 'admin') === 'admin',
    teamMemberId: s.teamMemberId || null, displayName: s.displayName || s.username,
    mustChangePassword: !!s.mustChangePassword,
    role: (s.userType || 'admin') === 'admin' ? 'administrator' : (s.role || 'approver'),
    projectIds: s.projectIds || [],
    menus: s.menus || [],
    permissions: s.permissions || {}
  };
}
const publicUser = u => ({ username: u.username, userType: u.userType, isAdmin: u.isAdmin, teamMemberId: u.teamMemberId,
  displayName: u.displayName, mustChangePassword: u.mustChangePassword, role: u.role, menus: u.menus, permissions: u.permissions });
const loadProjectIds = async teamMemberId =>
  (await db.prepare('SELECT project_id FROM user_project_access WHERE team_member_id = ?').all(teamMemberId)).map(r => r.project_id);

function requireAdmin(req, res, next) {
  const u = sessionUser(req);
  if (u && u.isAdmin) return next();
  return res.status(403).json({ error: 'Only the administrator can do this' });
}

function startSession(req, f) {
  return new Promise((resolve, reject) => req.session.regenerate(err => { // fresh session id on sign-in (session fixation)
    if (err) return reject(err);
    Object.assign(req.session, { authenticated: true, checkedAt: Date.now() }, f);
    resolve();
  }));
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 100 || password.length > 200) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (ipThrottled(req)) return res.status(429).json({ error: 'Too many failed sign-in attempts from this location. Try again in a few minutes.' });
  const fail = () => {
    noteFailedLogin(req);
    logAudit(req, { action: 'login_failed', username: username.slice(0, 100) });
    return res.status(401).json({ error: 'Invalid username or password' });
  };

  if (auth.safeEqual(username, APP_USERNAME) && auth.safeEqual(password, APP_PASSWORD)) {
    await startSession(req, { username, userType: 'admin', displayName: username });
    logAudit(req, { action: 'login', username });
    return res.json({ ok: true, username, userType: 'admin' });
  }

  const acct = await db.prepare(`
    SELECT ua.*, tm.name AS member_name FROM user_accounts ua JOIN team_members tm ON tm.id = ua.team_member_id
    WHERE LOWER(ua.username) = ?`).get(auth.normalizeUsername(username));
  if (!acct) { await auth.verifyDummy(password); return fail(); }
  if (acct.locked_until && acct.locked_until > new Date().toISOString()) {
    logAudit(req, { action: 'login_failed', username: acct.username, details: { note: 'Account temporarily locked' } });
    return res.status(423).json({ error: `Too many failed attempts. This account is locked for ${LOCKOUT_MINUTES} minutes.` });
  }
  const good = await auth.verifyPassword(password, acct.password_hash);
  if (!good || !acct.active) {
    if (!good) {
      const attempts = acct.failed_logins + 1;
      await db.prepare('UPDATE user_accounts SET failed_logins = ?, locked_until = ? WHERE team_member_id = ?').run(
        attempts >= MAX_FAILED_LOGINS ? 0 : attempts,
        attempts >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() : null,
        acct.team_member_id);
    }
    return fail();
  }
  await db.prepare('UPDATE user_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = utc_now_text() WHERE team_member_id = ?').run(acct.team_member_id);
  await startSession(req, {
    username: acct.username, userType: 'user', teamMemberId: acct.team_member_id,
    displayName: acct.member_name, mustChangePassword: !!acct.must_change_password,
    role: acct.role, projectIds: await loadProjectIds(acct.team_member_id),
    menus: require('./access').effectiveMenus(acct.role, acct.menus),
    permissions: require('./access').effectivePermissions(acct.role, acct.permissions)
  });
  logAudit(req, { action: 'login', username: acct.username });
  return res.json({ ok: true, username: acct.username, userType: 'user', mustChangePassword: !!acct.must_change_password });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.session && req.session.authenticated) logAudit(req, { action: 'logout' });
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  const u = sessionUser(req);
  if (u) return res.json(publicUser(u));
  return res.status(401).json({ error: 'Not authenticated' });
});

app.get('/login.html', async (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(async (req, res, next) => {
  if (!(req.session && req.session.authenticated)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login.html');
  }
  // A personal account switched off (or removed) by the administrator is signed out within a minute.
  if (req.session.userType === 'user' && Date.now() - (req.session.checkedAt || 0) > ACCOUNT_RECHECK_MS) {
    const acct = await db.prepare('SELECT active, role, menus, permissions FROM user_accounts WHERE team_member_id = ?').get(req.session.teamMemberId);
    if (!acct || !acct.active) {
      return req.session.destroy(() => (req.path.startsWith('/api/')
        ? res.status(401).json({ error: 'Not authenticated' }) : res.redirect('/login.html')));
    }
    req.session.role = acct.role;
    req.session.menus = require('./access').effectiveMenus(acct.role, acct.menus);
    req.session.permissions = require('./access').effectivePermissions(acct.role, acct.permissions);
    req.session.projectIds = await loadProjectIds(req.session.teamMemberId);
    req.session.checkedAt = Date.now();
  }
  // First sign-in with an administrator-issued temporary password: nothing else until it is changed.
  if (req.session.mustChangePassword && req.path.startsWith('/api/') && !req.path.startsWith('/api/auth/')) {
    return res.status(403).json({ error: 'You must change your temporary password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  return next();
});

app.post('/api/auth/change-password', async (req, res) => {
  const u = sessionUser(req);
  if (u.userType !== 'user') return res.status(400).json({ error: 'The administrator password is set on the server (APP_PASSWORD), not here' });
  const { currentPassword, newPassword } = req.body || {};
  const acct = await db.prepare('SELECT * FROM user_accounts WHERE team_member_id = ?').get(u.teamMemberId);
  if (!acct || typeof currentPassword !== 'string' || !(await auth.verifyPassword(currentPassword, acct.password_hash))) {
    return res.status(400).json({ error: 'Your current password is incorrect' });
  }
  const problem = auth.passwordProblem(newPassword, acct.username);
  if (problem) return badRequest(res, problem);
  if (newPassword === currentPassword) return badRequest(res, 'Choose a password different from the current one');
  await db.prepare('UPDATE user_accounts SET password_hash = ?, must_change_password = 0, password_changed_at = utc_now_text() WHERE team_member_id = ?')
    .run(await auth.hashPassword(newPassword), u.teamMemberId);
  req.session.mustChangePassword = false;
  logAudit(req, { action: 'password_change', entityType: 'User Account', entityId: u.teamMemberId, entityLabel: acct.username });
  res.json({ ok: true });
});

require('./access')(app, { db, sessionUser });

/* =========================================================
   AUDIT LOG — who changed what, when (see migration 005)
   One middleware covers every create/update/delete route listed in AUDITED, instead of
   touching each handler: it snapshots the record before the handler runs, and after a
   successful response records the action with a field-by-field before/after diff.
   ========================================================= */
// entity: label shown in the log · table: where the row lives · create: the POST that adds one ·
// item: URL segment for PUT/DELETE /api/<item>/:id
const AUDITED = [
  { entity: 'Project',                table: 'projects',                 create: /^\/api\/projects$/,                         item: 'projects' },
  { entity: 'Risk',                   table: 'risks',                    create: /^\/api\/risks$/,                            item: 'risks' },
  { entity: 'Issue',                  table: 'issues',                   create: /^\/api\/issues$/,                           item: 'issues' },
  { entity: 'Milestone',              table: 'milestones',               create: /^\/api\/milestones$/,                       item: 'milestones' },
  { entity: 'Invoice',                table: 'invoices',                 create: /^\/api\/projects\/\d+\/invoices$/,          item: 'invoices' },
  { entity: 'Document',               table: 'project_documents',        create: /^\/api\/projects\/\d+\/documents$/,         item: 'documents' },
  { entity: 'Completion Certificate', table: 'completion_certificates',  create: /^\/api\/projects\/\d+\/certificates$/,      item: 'certificates' },
  { entity: 'VOWD Statement',         table: 'vowd_statements',          create: /^\/api\/projects\/\d+\/vowd-statements$/,   item: 'vowd-statements' },
  { entity: 'Change Request',         table: 'change_requests',          create: /^\/api\/projects\/\d+\/change-requests$/,   item: 'change-requests' },
  { entity: 'CR Initial Analysis',    table: 'change_analyses',          create: /^\/api\/change-requests\/\d+\/analyses$/,   item: 'change-analyses' },
  { entity: 'CCB Decision',           table: 'change_decisions',         create: /^\/api\/change-requests\/\d+\/decisions$/,  item: 'change-decisions' },
  { entity: 'Project Member',         table: 'project_members',          create: /^\/api\/projects\/\d+\/members$/,           item: 'project-members' },
  { entity: 'External Party',         table: 'project_external_parties', create: /^\/api\/projects\/\d+\/external-parties$/,  item: 'external-parties' },
  { entity: 'Resource Group',         table: 'project_resource_groups',  create: /^\/api\/projects\/\d+\/resource-groups$/,   item: 'resource-groups' },
  { entity: 'Location',               table: 'governorates',             create: /^\/api\/governorates$/,                     item: 'governorates' },
  { entity: 'Project Type',           table: 'project_types',            create: /^\/api\/project-types$/,                    item: 'project-types' },
  { entity: 'Contractor',             table: 'contractors',              create: /^\/api\/contractors$/,                      item: 'contractors' },
  { entity: 'Business Unit',          table: 'business_units',           create: /^\/api\/business-units$/,                   item: 'business-units' },
  { entity: 'Team Member',            table: 'team_members',             create: /^\/api\/team-members$/,                     item: 'team-members' }
];

function matchAuditRoute(method, p) {
  let m;
  if (method === 'POST' && (m = /^\/api\/recycle-bin\/(\w+)\/(\d+)\/restore$/.exec(p)) && BIN_TYPES[m[1]]) {
    return { action: 'restore', entity: BIN_TYPES[m[1]].label, table: BIN_TYPES[m[1]].table, id: +m[2] };
  }
  if (method === 'DELETE' && (m = /^\/api\/recycle-bin\/(\w+)\/(\d+)$/.exec(p)) && BIN_TYPES[m[1]]) {
    return { action: 'purge', entity: BIN_TYPES[m[1]].label, table: BIN_TYPES[m[1]].table, id: +m[2] };
  }
  if ((m = /^\/api\/business-units\/(\d+)\/logo$/.exec(p)) && (method === 'POST' || method === 'DELETE')) {
    return { action: 'update', entity: 'Business Unit', table: 'business_units', id: +m[1] };
  }
  for (const a of AUDITED) {
    if (method === 'POST' && a.create.test(p)) return { action: 'create', entity: a.entity, table: a.table, id: null };
    if ((m = new RegExp(`^/api/${a.item}/(\\d+)$`).exec(p))) {
      if (method === 'PUT') return { action: 'update', entity: a.entity, table: a.table, id: +m[1] };
      if (method === 'DELETE') return { action: 'delete', entity: a.entity, table: a.table, id: +m[1] };
    }
  }
  return null;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket && req.socket.remoteAddress) || null;
}

const AUDIT_IGNORED_FIELDS = new Set(['id', 'created_at', 'updated_at']);
const clip = v => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v);
function compactRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== '' && !AUDIT_IGNORED_FIELDS.has(k)) out[k] = clip(v);
  return out;
}
function diffRows(before, after) {
  const changes = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (AUDIT_IGNORED_FIELDS.has(k)) continue;
    const a = before ? before[k] ?? null : null, b = after ? after[k] ?? null : null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = [clip(a), clip(b)];
  }
  return changes;
}
function auditLabel(table, row) {
  if (!row) return null;
  if (table === 'projects') return [row.code, row.name].filter(Boolean).join(' – ');
  if (table === 'change_analyses') return `${row.category || ''} analysis`.trim();
  if (table === 'change_decisions') return [row.decision, row.decision_date].filter(Boolean).join(' · ');
  const v = row.cr_code || row.invoice_number || row.certificate_number || row.vowd_number
    || row.title || row.name || row.milestone || row.original_filename;
  return v ? clip(String(v)) : null;
}
async function auditProjectId(table, row) {
  if (!row) return null;
  if (table === 'projects') return row.id;
  if (row.project_id) return row.project_id;
  if (row.change_request_id) {
    const cr = await db.prepare('SELECT project_id FROM change_requests WHERE id = ?').get(row.change_request_id);
    return cr ? cr.project_id : null;
  }
  return null;
}

// A project save deletes and re-inserts its Sequence of Events (new ids every time), so events
// are compared by their sequence number: which were added/removed, and which fields changed.
const EVENT_AUDIT_FIELDS = ['event_name', 'stage', 'status', 'progress_pct', 'planned_start', 'planned_end', 'actual_start', 'actual_end', 'assigned_to'];
function projectEventsSnapshot(projectId) {
  return db.prepare(`SELECT seq_no, ${EVENT_AUDIT_FIELDS.join(', ')} FROM project_events WHERE project_id = ? ORDER BY seq_no, id`).all(projectId);
}
function diffEvents(before, after) {
  const bySeq = rows => new Map(rows.map(r => [r.seq_no, r]));
  const b = bySeq(before || []), a = bySeq(after || []);
  const out = [];
  for (const [seq, row] of a) {
    const old = b.get(seq);
    if (!old) { out.push({ seq, event: row.event_name, added: true }); continue; }
    const changes = {};
    for (const f of EVENT_AUDIT_FIELDS) if (JSON.stringify(old[f] ?? null) !== JSON.stringify(row[f] ?? null)) changes[f] = [old[f] ?? null, row[f] ?? null];
    if (Object.keys(changes).length) out.push({ seq, event: row.event_name, changes });
  }
  for (const [seq, row] of b) if (!a.has(seq)) out.push({ seq, event: row.event_name, removed: true });
  return out.sort((x, y) => x.seq - y.seq);
}

// Never throws and never blocks the request: a failure to write the log is reported to the
// server console only. Runs outside any transaction (see db.outsideTransaction).
function logAudit(req, f) {
  return db.outsideTransaction(() => db.prepare(`INSERT INTO audit_log
      (username, ip_address, action, entity_type, entity_id, entity_label, project_id, method, path, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    f.username !== undefined ? f.username : (req.session && req.session.username) || null,
    clientIp(req), f.action, f.entityType || null, f.entityId || null, f.entityLabel || null,
    f.projectId || null, req.method, req.originalUrl, f.details ? JSON.stringify(f.details) : null
  )).catch(err => console.error(new Date().toISOString(), 'audit log write failed:', err.message));
}

async function recordAudit(req, match, before, beforeEvents, responseBody) {
  const id = match.id || (responseBody && responseBody.id) || null;
  const after = id ? (await db.prepare(`SELECT * FROM ${match.table} WHERE id = ?`).get(id)) || null : null;
  const row = after || before;
  let details;
  if (match.action === 'create') details = { values: compactRow(after) };
  else if (match.action === 'update' || match.action === 'restore') {
    details = { changes: diffRows(before, after) };
    if (beforeEvents) {
      const events = diffEvents(beforeEvents, await projectEventsSnapshot(id));
      if (events.length) details.events = events;
    }
  } else if (match.action === 'delete' && after) details = { note: 'Moved to the Recycle Bin' };
  else details = { snapshot: compactRow(before) }; // permanently removed: keep a copy of what it was
  await logAudit(req, {
    action: match.action, entityType: match.entity, entityId: id,
    entityLabel: auditLabel(match.table, row), projectId: await auditProjectId(match.table, row), details
  });
}

app.use(async (req, res, next) => {
  const match = req.method !== 'GET' && req.path.startsWith('/api/') ? matchAuditRoute(req.method, req.path) : null;
  if (!match) return next();
  let before = null, beforeEvents = null;
  try {
    if (match.id) before = (await db.prepare(`SELECT * FROM ${match.table} WHERE id = ?`).get(match.id)) || null;
    if (match.table === 'projects' && match.action === 'update') beforeEvents = await projectEventsSnapshot(match.id);
  } catch (err) { /* auditing must never block the request itself */ }
  let responseBody;
  const json = res.json.bind(res);
  res.json = body => { responseBody = body; return json(body); };
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    db.outsideTransaction(() => recordAudit(req, match, before, beforeEvents, responseBody))
      .catch(err => console.error(new Date().toISOString(), 'audit log failed:', err.message));
  });
  next();
});

require('./approvals')(app, { db, logAudit, sessionUser, requireAdmin, clientIp });

app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   HELPERS
   ========================================================= */
function computeProjectExtras(row, openIssues, criticalRisks, plannedPct, actualPct, actualCost) {
  const variance = +(actualPct - plannedPct).toFixed(1);
  const costUtilization = row.approved_budget > 0 ? +((actualCost / row.approved_budget) * 100).toFixed(1) : 0;
  const remaining = +(row.approved_budget - actualCost).toFixed(3);

  let score = 0;
  if (variance < -10) score += 2; else if (variance < -3) score += 1;
  if (costUtilization > 100) score += 2; else if (costUtilization > 90) score += 1;
  if (criticalRisks > 0) score += 2;
  if (openIssues > 3) score += 1;
  if (row.status === 'Delayed') score += 2;
  const health = row.status === 'Completed' ? 'On Track' : score >= 4 ? 'Critical' : score >= 2 ? 'At Risk' : 'On Track';

  return { variance, costUtilization, remaining, health };
}

// Expected Delay / Planned Progress / Actual Progress / Committed Cost / Actual Cost are all
// computed live here (like health and variance already were) rather than trusted from the
// stored columns, so they stay accurate on every read — not just immediately after the
// project was last saved. `opts.rawEvents`/`materials`/`crews`, when supplied by the caller
// (list endpoints prefetch everything in three queries to avoid N+1), are used as-is;
// otherwise each is fetched here for a single-project lookup.
const OPEN_ISSUE_SQL = `status IN ('Open','In Progress','Blocked')`;
const CRITICAL_RISK_SQL = `(probability * impact >= 16 OR is_critical = 1)`;
async function serializeProject(row, opts) {
  opts = opts || {};
  const openIssues = opts.openIssues !== undefined ? opts.openIssues
    : (await db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE project_id = ? AND ${OPEN_ISSUE_SQL}`).get(row.id)).n;
  const criticalRisks = opts.criticalRisks !== undefined ? opts.criticalRisks
    : (await db.prepare(`SELECT COUNT(*) AS n FROM risks WHERE project_id = ? AND ${CRITICAL_RISK_SQL}`).get(row.id)).n;
  const events = opts.rawEvents !== undefined ? opts.rawEvents
    : await db.prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY seq_no, id').all(row.id);
  const materials = opts.materials !== undefined ? opts.materials
    : (await db.prepare('SELECT * FROM project_materials WHERE project_id = ? ORDER BY id').all(row.id)).map(serializeMaterial);
  const crews = opts.crews !== undefined ? opts.crews
    : (await db.prepare(`SELECT pc.*, c.name AS contractor_name FROM project_crews pc LEFT JOIN contractors c ON c.id = pc.contractor_id WHERE pc.project_id = ? ORDER BY pc.id`).all(row.id)).map(serializeCrew);
  const plannedPct = computeProjectPlannedPct(row.start_date, row.end_date);
  const actualPct = computeProjectActualPct(events);
  const expectedDelayDays = computeProjectExpectedDelay(events, row.end_date);
  const { committedCost, actualCost } = computeProjectCosts(materials, crews);
  const extras = computeProjectExtras(row, openIssues, criticalRisks, plannedPct, actualPct, actualCost);
  // Revised Completion Date = the latest Planned End across the Sequence of Events (the
  // project's current planned finish). The contractual revised date approved through a change
  // request stays on that CR (see approvedCrRevisedCompletion, used by the CR print).
  const revisedCompletionDate = latestPlannedEnd(events);
  // Total approved CR cost impact across this project's change requests (see approvedCrCostImpact).
  const approvedChangeCost = opts.approvedChangeCost !== undefined ? opts.approvedChangeCost
    : await approvedCrCostImpact(row.id);
  const subcontractors = opts.subcontractors !== undefined ? opts.subcontractors
    : await db.prepare(`
        SELECT c.id, c.name FROM project_subcontractors ps
        JOIN contractors c ON c.id = ps.contractor_id
        WHERE ps.project_id = ? ORDER BY c.name
      `).all(row.id);
  // A project can span more than one location — governorate_id/governorate_name (the single
  // JOIN in PROJECT_SELECT) stay the "primary" location, used wherever only one location makes
  // sense (risks/issues/milestones attribution, single-select filters). `governorate` itself
  // becomes the full, comma-joined list so every existing display that just prints it (tables,
  // exports, drilldown subtitles) shows all of a project's locations with no further changes.
  const governorates = opts.governorates !== undefined ? opts.governorates
    : await db.prepare(`
        SELECT g.id, g.name FROM project_governorates pg
        JOIN governorates g ON g.id = pg.governorate_id
        WHERE pg.project_id = ? ORDER BY g.name
      `).all(row.id);
  const governorateNames = governorates.length ? governorates.map(g => g.name) : [row.governorate_name];
  const governorateIds = governorates.length ? governorates.map(g => g.id) : [row.governorate_id];
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    governorateId: row.governorate_id,
    governorate: governorateNames.join(', '),
    governorateIds,
    governorateNames,
    city: row.city,
    projectTypeId: row.project_type_id,
    type: row.project_type_name,
    contractorId: row.contractor_id,
    contractor: row.contractor_name,
    subcontractorIds: subcontractors.map(s => s.id),
    subcontractors,
    businessUnitId: row.business_unit_id,
    businessUnit: row.business_unit_name,
    businessUnitLogoUrl: row.business_unit_logo_path ? `/api/business-units/${row.business_unit_id}/logo` : null,
    projectManagerId: row.project_manager_id,
    projectManager: row.project_manager_name,
    status: row.status,
    plannedPct,
    actualPct,
    approvedBudget: row.approved_budget,
    contractValue: row.contract_value,
    approvedChangeCost,
    revisedContractValue: +((row.contract_value || 0) + approvedChangeCost).toFixed(3),
    actualCost,
    committedCost,
    expectedDelayDays,
    startDate: row.start_date,
    endDate: row.end_date,
    revisedCompletionDate,
    objective: row.objective,
    scope: row.scope,
    priority: row.priority,
    fundingSource: row.funding_source,
    contractReference: row.contract_reference,
    projectSponsor: row.project_sponsor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openIssues,
    criticalRisks,
    ...extras
  };
}

// Latest Planned End among a project's events (ISO 'YYYY-MM-DD' strings compare correctly as
// text); null when no event has a Planned End yet.
function latestPlannedEnd(events) {
  return events.reduce((max, e) => (e.planned_end && (!max || e.planned_end > max) ? e.planned_end : max), null);
}

function serializeMaterial(row) {
  return {
    id: row.id, projectId: row.project_id, eventId: row.event_id, stage: row.stage,
    materialName: row.material_name, specification: row.specification, unit: row.unit,
    plannedQty: row.planned_qty, consumedQty: row.consumed_qty, unitRate: row.unit_rate,
    supplier: row.supplier, deliveryDate: row.delivery_date, status: row.status, notes: row.notes,
    plannedAmount: +(row.planned_qty * row.unit_rate).toFixed(3),
    actualAmount: +(row.consumed_qty * row.unit_rate).toFixed(3)
  };
}

// Planned cost prices the Planned Qty; actual cost prices the Actual Qty (a crew's
// equivalent of a material's Consumed Qty). Lump Sum ignores Days.
function crewLineCost(qty, rateBasis, unitRate, allocatedDays) {
  const q = Number(qty) || 0, r = Number(unitRate) || 0, d = Number(allocatedDays) || 0;
  return rateBasis === 'Lump Sum' ? q * r : q * r * d;
}

function serializeCrew(row) {
  const cost = crewLineCost(row.quantity, row.rate_basis, row.unit_rate, row.allocated_days);
  const actualCost = crewLineCost(row.actual_qty, row.rate_basis, row.unit_rate, row.allocated_days);
  return {
    id: row.id, projectId: row.project_id, eventId: row.event_id, stage: row.stage,
    resourceType: row.resource_type, resourceName: row.resource_name,
    contractorId: row.contractor_id, contractor: row.contractor_name || null, poRef: row.po_ref || '',
    quantity: row.quantity, actualQty: row.actual_qty || 0,
    rateBasis: row.rate_basis, unitRate: row.unit_rate, allocatedDays: row.allocated_days,
    startDate: row.start_date, endDate: row.end_date, status: row.status, notes: row.notes,
    cost: +cost.toFixed(3),
    actualCost: +actualCost.toFixed(3)
  };
}

function serializeEvent(row) {
  return {
    id: row.id, projectId: row.project_id, seqNo: row.seq_no, stage: row.stage, eventName: row.event_name,
    plannedStart: row.planned_start, plannedEnd: row.planned_end, actualStart: row.actual_start, actualEnd: row.actual_end,
    status: row.status, assignedTo: row.assigned_to, progressPct: row.progress_pct,
    isCollapsed: !!row.is_collapsed, remarks: row.remarks
  };
}

// Committed Cost / Actual Cost are never entered directly — they are rolled up from the
// project's own Material Consumption and Crew/Contractor Allocation line items (the same
// itemized data behind the Cost Statement tab), in plain full OMR — the same unit as
// Approved Budget / Contract Value. Committed = every planned material amount + every crew
// allocation's cost at its Planned Qty, regardless of status (once a material is ordered or
// a crew is planned, it's committed spend). Actual = consumed material amount + crew cost at
// its Actual Qty.
function computeProjectCosts(materials, crews) {
  let committed = 0, actual = 0;
  materials.forEach(m => { committed += m.plannedAmount; actual += m.actualAmount; });
  crews.forEach(c => { committed += c.cost; actual += c.actualCost; });
  return { committedCost: +committed.toFixed(3), actualCost: +actual.toFixed(3) };
}
// Same rollup, but for the raw sanitized (snake_case, pre-serialize) rows available at
// POST/PUT time before the row has an id — used to keep the DB columns' snapshot in sync.
function computeProjectCostsFromSanitized(materials, crews) {
  let committed = 0, actual = 0;
  materials.forEach(m => {
    committed += (m.planned_qty || 0) * (m.unit_rate || 0);
    actual += (m.consumed_qty || 0) * (m.unit_rate || 0);
  });
  crews.forEach(c => {
    committed += crewLineCost(c.quantity, c.rate_basis, c.unit_rate, c.allocated_days);
    actual += crewLineCost(c.actual_qty, c.rate_basis, c.unit_rate, c.allocated_days);
  });
  return { committedCost: +committed.toFixed(3), actualCost: +actual.toFixed(3) };
}

function computeCostStatement(materials, crews) {
  const byStage = {};
  STAGES.forEach(s => { byStage[s] = { stage: s, materialPlanned: 0, materialActual: 0, crewCost: 0 }; });
  materials.forEach(m => {
    if (!byStage[m.stage]) byStage[m.stage] = { stage: m.stage, materialPlanned: 0, materialActual: 0, crewCost: 0 };
    byStage[m.stage].materialPlanned += m.plannedAmount;
    byStage[m.stage].materialActual += m.actualAmount;
  });
  crews.forEach(c => {
    if (!byStage[c.stage]) byStage[c.stage] = { stage: c.stage, materialPlanned: 0, materialActual: 0, crewCost: 0 };
    byStage[c.stage].crewCost += c.actualCost;
  });
  const stages = STAGES.map(s => {
    const d = byStage[s];
    const total = +(d.materialActual + d.crewCost).toFixed(3);
    return { stage: s, materialPlanned: +d.materialPlanned.toFixed(3), materialActual: +d.materialActual.toFixed(3), crewCost: +d.crewCost.toFixed(3), total };
  });
  const totals = stages.reduce((acc, s) => ({
    materialPlanned: acc.materialPlanned + s.materialPlanned,
    materialActual: acc.materialActual + s.materialActual,
    crewCost: acc.crewCost + s.crewCost,
    total: acc.total + s.total
  }), { materialPlanned: 0, materialActual: 0, crewCost: 0, total: 0 });
  Object.keys(totals).forEach(k => { totals[k] = +totals[k].toFixed(3); });
  return { stages, totals };
}

const PROJECT_SELECT = `
  SELECT p.*, g.name AS governorate_name, t.name AS project_type_name, c.name AS contractor_name,
         bu.name AS business_unit_name, bu.logo_path AS business_unit_logo_path, pmgr.name AS project_manager_name
  FROM projects p
  JOIN governorates g ON g.id = p.governorate_id
  JOIN project_types t ON t.id = p.project_type_id
  LEFT JOIN contractors c ON c.id = p.contractor_id
  LEFT JOIN business_units bu ON bu.id = p.business_unit_id
  LEFT JOIN team_members pmgr ON pmgr.id = p.project_manager_id
`;

// A change request counts as approved when its latest CCB decision is "Approved" (a later
// Rejected/Deferred decision supersedes an earlier approval). Only approved CRs move the
// project's Revised Completion Date / Revised Contract Value. `uptoCrId` limits the rollup to
// CRs raised up to and including that one — the position "as of" a given CR, for its print.
const CR_LATEST_DECISION_SQL = `(SELECT ld.decision FROM change_decisions ld WHERE ld.change_request_id = cr.id ORDER BY ld.decision_date DESC, ld.id DESC LIMIT 1)`;
const ALL_CRS = 2147483647; // largest INTEGER id — compared against an INTEGER column
async function approvedCrCostImpact(projectId, uptoCrId = ALL_CRS) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(a.cost_impact), 0) AS total FROM change_analyses a
    JOIN change_requests cr ON cr.id = a.change_request_id AND cr.deleted_at IS NULL
    WHERE cr.project_id = ? AND cr.id <= ? AND ${CR_LATEST_DECISION_SQL} = 'Approved'`).get(projectId, uptoCrId);
  return +(row.total || 0).toFixed(3);
}
async function approvedCrRevisedCompletion(projectId, uptoCrId = ALL_CRS) {
  const row = await db.prepare(`
    SELECT d.revised_completion_date AS d FROM change_decisions d
    JOIN change_requests cr ON cr.id = d.change_request_id AND cr.deleted_at IS NULL
    WHERE cr.project_id = ? AND cr.id <= ? AND d.decision = 'Approved' AND d.revised_completion_date IS NOT NULL
      AND ${CR_LATEST_DECISION_SQL} = 'Approved'
    ORDER BY d.decision_date DESC, d.id DESC LIMIT 1`).get(projectId, uptoCrId);
  return row ? row.d : null;
}

// Tables (besides projects) whose rows can themselves be soft-deleted into the Recycle Bin.
const SOFT_DELETE_TABLES = new Set(['change_requests', 'invoices', 'completion_certificates', 'vowd_statements', 'project_documents']);

// A row from a project-owned table — or undefined if it doesn't exist, it is soft-deleted itself,
// or its project is in the Recycle Bin — so views/edits/deletes of anything hidden 404 cleanly.
function activeChildRow(table, id) {
  const ownFilter = SOFT_DELETE_TABLES.has(table) ? ' AND t.deleted_at IS NULL' : '';
  return db.prepare(`SELECT t.* FROM ${table} t
    JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL WHERE t.id = ?${ownFilter}`).get(id);
}
// "Deleting" a project or one of the SOFT_DELETE_TABLES only moves it to the Recycle Bin.
function softDelete(table, id, req) {
  return db.prepare(`UPDATE ${table} SET deleted_at = utc_now_text(), deleted_by = ? WHERE id = ?`)
    .run((req.session && req.session.username) || null, id);
}
// Same, for a change request's Initial Analysis / CCB Decision rows (owned via their CR).
function activeCrChildRow(table, id) {
  return db.prepare(`SELECT t.* FROM ${table} t
    JOIN change_requests cr ON cr.id = t.change_request_id AND cr.deleted_at IS NULL
    JOIN projects p ON p.id = cr.project_id AND p.deleted_at IS NULL WHERE t.id = ?`).get(id);
}

// Per-project document sequence: each project's invoices/certificates/VOWD statements/
// change requests number from 1, independent of the row's global auto-increment id.
// Deliberately counts soft-deleted rows too, so a number is never handed out twice.
async function perProjectSeq(table, projectId, id) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND id <= ?`).get(projectId, id);
  return row.n;
}

async function nextProjectCode() {
  // Includes soft-deleted projects, so a code in the Recycle Bin is never reissued.
  const rows = await db.prepare('SELECT code FROM projects').all();
  let maxNum = 0;
  for (const r of rows) {
    const m = /^P-(\d+)$/.exec(r.code || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return 'P-' + String(maxNum + 1).padStart(4, '0');
}

// Runs a multer upload middleware and resolves with its error (or undefined), so upload
// routes can stay async/await end to end.
function runUpload(middleware, req, res) {
  return new Promise(resolve => middleware(req, res, err => resolve(err)));
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function isUniqueConstraintError(e) {
  return e && e.code === '23505'; // PostgreSQL unique_violation
}

/* =========================================================
   MASTER DATA: GOVERNORATES / PROJECT TYPES / CONTRACTORS
   ========================================================= */
function listMaster(table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
}
function masterDataRoutes(name, table, extraCols = [], ref = null) {
  const router = express.Router();
  const cols = ['name', ...extraCols.map(c => c.name)];

  router.get('/', async (req, res) => {
    res.json(await listMaster(table));
  });

  router.post('/', async (req, res) => {
    if (!req.body.name || !req.body.name.trim()) return badRequest(res, 'name is required');
    const values = cols.map(c => req.body[c] ?? (extraCols.find(e => e.name === c)?.default));
    try {
      const placeholders = cols.map(() => '?').join(', ');
      const info = await db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
      res.status(201).json(await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid));
    } catch (e) {
      if (isUniqueConstraintError(e)) return res.status(409).json({ error: `${name} name already exists` });
      throw e;
    }
  });

  router.put('/:id', async (req, res) => {
    const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: `${name} not found` });
    if (!req.body.name || !req.body.name.trim()) return badRequest(res, 'name is required');
    const values = cols.map(c => req.body[c] ?? existing[c]);
    try {
      const setClause = cols.map(c => `${c} = ?`).join(', ');
      await db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
      res.json(await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (e) {
      if (isUniqueConstraintError(e)) return res.status(409).json({ error: `${name} name already exists` });
      throw e;
    }
  });

  router.delete('/:id', async (req, res) => {
    const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: `${name} not found` });
    const { refTable, refColumn, refLabel } = ref || {
      refTable: 'projects',
      refColumn: table === 'governorates' ? 'governorate_id' : table === 'project_types' ? 'project_type_id' : 'contractor_id',
      refLabel: 'project(s)'
    };
    // A project in the Recycle Bin still references this record, so it still blocks deletion —
    // the message says so, otherwise it would point at projects nobody can see.
    const { n: inUse, binned } = await db.prepare(refTable === 'projects'
      ? `SELECT COUNT(*) AS n, COUNT(deleted_at) AS binned FROM projects WHERE ${refColumn} = ?`
      : `SELECT COUNT(*) AS n, 0 AS binned FROM ${refTable} WHERE ${refColumn} = ?`).get(req.params.id);
    if (inUse > 0) {
      const binNote = binned ? ` (${binned} of them in the Recycle Bin — permanently delete ${binned === 1 ? 'it' : 'them'} there first)` : '';
      return res.status(409).json({ error: `Cannot delete: ${inUse} ${refLabel} reference this ${name}${binNote}` });
    }
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  });

  return router;
}

app.use('/api/governorates', masterDataRoutes('location', 'governorates'));
app.use('/api/project-types', masterDataRoutes('project type', 'project_types'));
app.use('/api/contractors', masterDataRoutes('contractor', 'contractors', [{ name: 'base_performance', default: 75 }]));
app.use('/api/business-units', masterDataRoutes('business unit', 'business_units', [],
  { refTable: 'projects', refColumn: 'business_unit_id', refLabel: 'project(s)' }
));

// Business Unit letterhead logo, shown on print documents (certificate, invoice, VOWD, change
// request, data sheet) in place of a hardcoded organization name. Stored on disk outside
// public/ (same pattern as project documents) and served through an authenticated route
// rather than express.static.
const BU_LOGOS_DIR = path.join(__dirname, 'uploads', 'business-unit-logos');
fs.mkdirSync(BU_LOGOS_DIR, { recursive: true });
const BU_LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp']);
const buLogoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { cb(null, BU_LOGOS_DIR); },
    filename(req, file, cb) { cb(null, `${req.params.id}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`); }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!BU_LOGO_EXTENSIONS.has(ext)) return cb(new Error('Only PNG, JPG, SVG or WEBP images are allowed'));
    cb(null, true);
  }
});
app.post('/api/business-units/:id/logo', async (req, res) => {
  const bu = await db.prepare('SELECT * FROM business_units WHERE id = ?').get(req.params.id);
  if (!bu) return res.status(404).json({ error: 'Business unit not found' });
  const err = await runUpload(buLogoUpload.single('logo'), req, res);
  if (err) return badRequest(res, err.message || 'Upload failed');
  if (!req.file) return badRequest(res, 'A logo file is required');
  if (bu.logo_path) fs.unlink(path.join(BU_LOGOS_DIR, bu.logo_path), () => {});
  await db.prepare('UPDATE business_units SET logo_path = ? WHERE id = ?').run(req.file.filename, bu.id);
  res.json(await db.prepare('SELECT * FROM business_units WHERE id = ?').get(bu.id));
});
app.get('/api/business-units/:id/logo', async (req, res) => {
  const bu = await db.prepare('SELECT * FROM business_units WHERE id = ?').get(req.params.id);
  if (!bu || !bu.logo_path) return res.status(404).end();
  const filePath = path.join(BU_LOGOS_DIR, bu.logo_path);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});
app.delete('/api/business-units/:id/logo', async (req, res) => {
  const bu = await db.prepare('SELECT * FROM business_units WHERE id = ?').get(req.params.id);
  if (!bu) return res.status(404).json({ error: 'Business unit not found' });
  if (bu.logo_path) fs.unlink(path.join(BU_LOGOS_DIR, bu.logo_path), () => {});
  await db.prepare('UPDATE business_units SET logo_path = NULL WHERE id = ?').run(bu.id);
  res.status(204).end();
});
// Overrides masterDataRoutes' generic GET '/' below (Express matches this exact GET first)
// to also include how many projects each team member is currently assigned to.
function listTeamMembers() {
  return db.prepare(`
    SELECT tm.*, (SELECT COUNT(*) FROM project_members pm JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
                  WHERE pm.team_member_id = tm.id) AS project_count
    FROM team_members tm ORDER BY tm.name, tm.id
  `).all();
}
app.get('/api/team-members', async (req, res) => {
  res.json(await listTeamMembers());
});
/* ---- Personal accounts (administrator only): give a team member a login ---- */
async function accountRow(teamMemberId) {
  return db.prepare('SELECT * FROM user_accounts WHERE team_member_id = ?').get(teamMemberId);
}
const ACCOUNT_ROLES = require('./access').ROLES;
const shapeAccount = (a, projectIds) => ({
  teamMemberId: a.team_member_id, username: a.username, role: a.role, projectIds,
  menus: a.menus ? JSON.parse(a.menus) : null, // null = the role's default
  permissions: a.permissions ? JSON.parse(a.permissions) : null, // null = the role's template
  effectivePermissions: require('./access').effectivePermissions(a.role, a.permissions),
  active: !!a.active, mustChangePassword: !!a.must_change_password,
  locked: !!(a.locked_until && a.locked_until > new Date().toISOString()), lastLoginAt: a.last_login_at, createdAt: a.created_at
});
// What the administrator's permission editor needs: the resources, actions and the role templates.
app.get('/api/user-accounts/acl-catalog', requireAdmin, (req, res) => {
  const acl = require('./access');
  res.json({ actions: acl.ACTIONS, resources: Object.entries(acl.RESOURCES).map(([key, r]) => ({ key, label: r.label, scoped: r.scoped })), templates: acl.TEMPLATES });
});
const accountShape = async a => shapeAccount(a, await loadProjectIds(a.team_member_id));
app.get('/api/user-accounts', requireAdmin, async (req, res) => {
  const grants = {};
  (await db.prepare('SELECT team_member_id, project_id FROM user_project_access').all()).forEach(g => { (grants[g.team_member_id] ||= []).push(g.project_id); });
  res.json((await db.prepare('SELECT * FROM user_accounts ORDER BY LOWER(username)').all()).map(a => shapeAccount(a, grants[a.team_member_id] || [])));
});
function accountAudit(req, tm, action, details) {
  return logAudit(req, { action, entityType: 'User Account', entityId: tm.id, entityLabel: `${tm.name}${details && details.username ? ' (' + details.username + ')' : ''}`, details });
}
// Create a login (returns a one-time temporary password) or change the username of an existing one.
app.post('/api/team-members/:id/account', requireAdmin, async (req, res) => {
  const tm = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!tm) return res.status(404).json({ error: 'Team member not found' });
  const username = auth.normalizeUsername(req.body && req.body.username);
  if (!auth.USERNAME_RE.test(username)) return badRequest(res, 'Username must be 3–40 characters: letters, numbers, dot, dash or underscore');
  if (auth.normalizeUsername(APP_USERNAME) === username) return res.status(409).json({ error: 'That username is reserved for the administrator' });
  const existing = await accountRow(tm.id);
  const role = req.body && req.body.role !== undefined ? req.body.role : 'approver';
  if (!ACCOUNT_ROLES.includes(role)) return badRequest(res, `role must be one of: ${ACCOUNT_ROLES.join(', ')}`);
  try {
    if (existing) {
      await db.prepare('UPDATE user_accounts SET username = ? WHERE team_member_id = ?').run(username, tm.id);
      await accountAudit(req, tm, 'account_update', { username, previousUsername: existing.username });
      return res.json({ account: await accountShape(await accountRow(tm.id)) });
    }
    const temporaryPassword = auth.generateTemporaryPassword();
    await db.prepare('INSERT INTO user_accounts (team_member_id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(tm.id, username, await auth.hashPassword(temporaryPassword), role);
    await accountAudit(req, tm, 'account_create', { username, role });
    res.status(201).json({ account: await accountShape(await accountRow(tm.id)), temporaryPassword });
  } catch (e) {
    if (isUniqueConstraintError(e)) return res.status(409).json({ error: 'That username is already taken' });
    throw e;
  }
});
app.post('/api/team-members/:id/account/reset-password', requireAdmin, async (req, res) => {
  const tm = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  const acct = tm && await accountRow(tm.id);
  if (!acct) return res.status(404).json({ error: 'This team member has no login yet' });
  const temporaryPassword = auth.generateTemporaryPassword();
  await db.prepare('UPDATE user_accounts SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE team_member_id = ?')
    .run(await auth.hashPassword(temporaryPassword), tm.id);
  await accountAudit(req, tm, 'account_reset_password', { username: acct.username });
  res.json({ account: await accountShape(await accountRow(tm.id)), temporaryPassword });
});
app.put('/api/team-members/:id/account', requireAdmin, async (req, res) => {
  const tm = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  const acct = tm && await accountRow(tm.id);
  if (!acct) return res.status(404).json({ error: 'This team member has no login yet' });
  const active = req.body && req.body.active ? 1 : 0;
  await db.prepare('UPDATE user_accounts SET active = ?, failed_logins = 0, locked_until = NULL WHERE team_member_id = ?').run(active, tm.id);
  const pending = active ? 0 : (await db.prepare(`SELECT COUNT(*) AS n FROM document_approval_steps WHERE team_member_id = ? AND status = 'Pending'`).get(tm.id)).n;
  await accountAudit(req, tm, active ? 'account_activate' : 'account_deactivate', { username: acct.username });
  res.json({ account: await accountShape(await accountRow(tm.id)), pendingApprovals: pending });
});
// What this login may do: its role, and (project roles only) which projects it can see.
app.put('/api/team-members/:id/account/access', requireAdmin, async (req, res) => {
  const tm = await db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  const acct = tm && await accountRow(tm.id);
  if (!acct) return res.status(404).json({ error: 'This team member has no login yet' });
  const b = req.body || {};
  const role = b.role === undefined ? acct.role : b.role;
  if (!ACCOUNT_ROLES.includes(role)) return badRequest(res, `role must be one of: ${ACCOUNT_ROLES.join(', ')}`);
  let menusJson;
  if (b.menus !== undefined) {
    if (b.menus === null) menusJson = null; // back to the role's default
    else if (!Array.isArray(b.menus) || !b.menus.every(k => require('./access').MENUS.includes(k))) return badRequest(res, 'menus must be a list of valid menu names, or null for the role default');
    else menusJson = JSON.stringify([...new Set(b.menus)]);
  }
  let permsJson;
  if (b.permissions !== undefined) {
    if (b.permissions === null) permsJson = null; // back to the role's template
    else {
      const clean = require('./access').cleanMatrix(b.permissions);
      if (!clean) return badRequest(res, 'permissions must be { resource: [view|create|edit|delete, …] } using known resources, or null for the role template');
      permsJson = JSON.stringify(clean);
    }
  }
  let projectIds = null;
  if (b.projectIds !== undefined) {
    if (!Array.isArray(b.projectIds) || !b.projectIds.every(id => Number.isInteger(id) && id > 0)) return badRequest(res, 'projectIds must be a list of project ids');
    projectIds = [...new Set(b.projectIds)];
    const found = projectIds.length ? await db.prepare('SELECT id FROM projects WHERE id = ANY(?::int[])').all(projectIds) : [];
    if (found.length !== projectIds.length) return badRequest(res, 'One or more projects do not exist');
  }
  const before = await loadProjectIds(tm.id);
  await db.transaction(async () => {
    await db.prepare('UPDATE user_accounts SET role = ? WHERE team_member_id = ?').run(role, tm.id);
    if (menusJson !== undefined) await db.prepare('UPDATE user_accounts SET menus = ? WHERE team_member_id = ?').run(menusJson, tm.id);
    if (permsJson !== undefined) await db.prepare('UPDATE user_accounts SET permissions = ? WHERE team_member_id = ?').run(permsJson, tm.id);
    if (projectIds) {
      await db.prepare('DELETE FROM user_project_access WHERE team_member_id = ?').run(tm.id);
      for (const pid of projectIds) await db.prepare('INSERT INTO user_project_access (team_member_id, project_id, granted_by) VALUES (?, ?, ?)').run(tm.id, pid, sessionUser(req).username);
    }
  })();
  const after = projectIds || before;
  await accountAudit(req, tm, 'account_access', {
    username: acct.username, role: acct.role === role ? role : `${acct.role} → ${role}`,
    projectsAdded: after.filter(x => !before.includes(x)).length, projectsRemoved: before.filter(x => !after.includes(x)).length, projectCount: after.length,
    ...(menusJson !== undefined ? { menus: menusJson === null ? 'role default' : `${JSON.parse(menusJson).length} menus` } : {}),
    ...(permsJson !== undefined ? { permissions: permsJson === null ? 'role template' : Object.entries(JSON.parse(permsJson)).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join('/')}`) } : {})
  });
  res.json({ account: await accountShape(await accountRow(tm.id)) });
});
// A team member who has signed (or been asked to sign) approvals is part of the signed record.
app.delete('/api/team-members/:id', async (req, res, next) => {
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM document_approval_steps WHERE team_member_id = ?').get(req.params.id)).n;
  if (n > 0) return res.status(409).json({ error: `Cannot delete: this person appears on ${n} approval record(s). Deactivate their login instead.` });
  next();
});

app.use('/api/team-members', masterDataRoutes('team member', 'team_members',
  [
    { name: 'department', default: 'Planning' },
    { name: 'designation', default: 'Engineer' },
    { name: 'email', default: null },
    { name: 'access_level', default: 'Project Management' }
  ],
  { refTable: 'project_members', refColumn: 'team_member_id', refLabel: 'project assignment(s)' }
));

/* =========================================================
   PROJECTS
   ========================================================= */
const PROJECT_REQUIRED = ['name', 'projectTypeId', 'status', 'startDate', 'endDate'];
const VALID_STATUSES = ['Not Started', 'Active', 'Completed', 'At Risk', 'Delayed'];
const STAGES = [
  'Mobilization', 'Design & Engineering', 'Procurement',
  'Execution / Construction', 'Testing & Commissioning',
  'Handover', 'Defects Liability', 'Closure'
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const MATERIAL_STATUSES = ['Ordered', 'Delivered', 'Inspected', 'Rejected', 'Used'];
const RESOURCE_TYPES = ['Labour', 'Equipment', 'Subcontractor'];
const RATE_BASES = ['Per Day', 'Per Hour', 'Lump Sum'];
const CREW_STATUSES = ['Planned', 'Mobilized', 'Demobilized'];
const EVENT_STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Delayed'];

function validateProjectBody(body, res) {
  for (const field of PROJECT_REQUIRED) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      badRequest(res, `${field} is required`);
      return false;
    }
  }
  if (!VALID_STATUSES.includes(body.status)) {
    badRequest(res, `status must be one of: ${VALID_STATUSES.join(', ')}`);
    return false;
  }
  if (!Array.isArray(body.governorateIds) || !body.governorateIds.length) {
    badRequest(res, 'At least one location (governorateIds) is required');
    return false;
  }
  if (body.startDate && body.endDate && body.endDate < body.startDate) {
    badRequest(res, 'Planned Completion Date must be on or after Planned Start Date.');
    return false;
  }
  for (const field of ['approvedBudget', 'contractValue']) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '') {
      const v = Number(body[field]);
      if (Number.isNaN(v) || v < 0) {
        badRequest(res, `${field} cannot be negative.`);
        return false;
      }
    }
  }
  return true;
}

const pickEnum = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

// Dated actual-quantity entries carried by a material / crew line: { id?, date: 'YYYY-MM-DD', quantity > 0, note? }.
const actorName = req => (req.session && (req.session.displayName || req.session.username)) || null;
function sanitizeEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(e => ({
      id: Number(e && e.id) || null,
      entry_date: e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) ? String(e.date) : null,
      quantity: Number(e && e.quantity),
      note: e && e.note ? String(e.note).trim().slice(0, 300) : null
    }))
    .filter(e => e.entry_date && Number.isFinite(e.quantity) && e.quantity > 0 && e.quantity < 1e9);
}
// An actual can only be logged for a day that has happened (a day of slack covers timezones).
function entryDateProblems(materials, crews) {
  const limit = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
  const out = [];
  [...(materials || []).map(m => [m, m.material_name]), ...(crews || []).map(c => [c, c.resource_name])].forEach(([line, name]) => {
    (line.entries || []).forEach(e => { if (e.entry_date > limit) out.push(`"${name}": the actual entry dated ${e.entry_date} is in the future`); });
  });
  return out;
}
function sanitizeMaterialRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r && r.materialName && String(r.materialName).trim())
    .map(r => ({
      stage: pickEnum(r.stage, STAGES, STAGES[3]),
      client_event_id: r.eventClientId != null ? String(r.eventClientId) : null,
      material_name: String(r.materialName).trim(),
      specification: r.specification ? String(r.specification).trim() : null,
      unit: r.unit ? String(r.unit).trim() : null,
      planned_qty: Number(r.plannedQty) || 0,
      consumed_qty: Number(r.consumedQty) || 0,
      unit_rate: omr3(r.unitRate),
      supplier: r.supplier ? String(r.supplier).trim() : null,
      delivery_date: r.deliveryDate || null,
      status: pickEnum(r.status, MATERIAL_STATUSES, MATERIAL_STATUSES[0]),
      notes: r.notes ? String(r.notes).trim() : null,
      entries: sanitizeEntries(r.entries)
    }));
}

// An actual value may not go above its planned value: material Consumed Qty <= Planned Qty, crew Actual Qty <= Planned Qty
// (so the actual amount is never above the planned amount), and the project's Actual Cost <= its Approved Budget.
// Returns a list of readable problems; empty means fine. The browser runs the same checks live in the form.
const ACTUAL_EPS = 1e-6, MONEY_EPS = 0.0005;
const fmtQty = n => String(+Number(n).toFixed(3));
function actualsProblems(materials, crews, events, actualCost, approvedBudget) {
  const eventName = {};
  (events || []).forEach(e => { if (e.client_id != null) eventName[e.client_id] = e.event_name; });
  const where = cid => (cid != null && eventName[cid] ? `Event "${eventName[cid]}" - ` : '');
  const out = [];
  (materials || []).forEach(m => {
    if (m.consumed_qty > m.planned_qty + ACTUAL_EPS) out.push(`${where(m.client_event_id)}Material "${m.material_name}": consumed ${fmtQty(m.consumed_qty)} exceeds planned ${fmtQty(m.planned_qty)}`);
  });
  (crews || []).forEach(c => {
    if (c.actual_qty > c.quantity + ACTUAL_EPS) out.push(`${where(c.client_event_id)}Crew / labour "${c.resource_name}": actual quantity ${fmtQty(c.actual_qty)} exceeds planned ${fmtQty(c.quantity)}`);
  });
  if (approvedBudget > 0 && actualCost > approvedBudget + MONEY_EPS) {
    out.push(`Actual Cost (OMR ${actualCost.toFixed(3)}) exceeds the Approved Budget (OMR ${Number(approvedBudget).toFixed(3)})`);
  }
  return out;
}
function rejectActuals(res, problems) {
  const shown = problems.slice(0, 8).join('; ') + (problems.length > 8 ? `; and ${problems.length - 8} more` : '');
  return res.status(400).json({ error: `Actual values cannot exceed the planned values: ${shown}.`, code: 'ACTUAL_EXCEEDS_PLANNED', problems });
}

function sanitizeCrewRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r && r.resourceName && String(r.resourceName).trim())
    .map(r => ({
      stage: pickEnum(r.stage, STAGES, STAGES[3]),
      client_event_id: r.eventClientId != null ? String(r.eventClientId) : null,
      resource_type: pickEnum(r.resourceType, RESOURCE_TYPES, RESOURCE_TYPES[0]),
      resource_name: String(r.resourceName).trim(),
      contractor_id: r.contractorId || null,
      po_ref: (typeof r.poRef === 'string' && r.poRef.trim().slice(0, 200)) || null,
      quantity: Number(r.quantity) || 0,
      actual_qty: Number(r.actualQty) || 0,
      rate_basis: pickEnum(r.rateBasis, RATE_BASES, RATE_BASES[0]),
      unit_rate: omr3(r.unitRate),
      allocated_days: Number(r.allocatedDays) || 0,
      start_date: r.startDate || null,
      end_date: r.endDate || null,
      status: pickEnum(r.status, CREW_STATUSES, CREW_STATUSES[0]),
      notes: r.notes ? String(r.notes).trim() : null,
      entries: sanitizeEntries(r.entries)
    }));
}

function sanitizeEventRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r && r.eventName && String(r.eventName).trim())
    .map((r, idx) => ({
      seq_no: Math.round(Number(r.seqNo)) || idx + 1,
      stage: pickEnum(r.stage, STAGES, STAGES[3]),
      client_id: r.clientId != null ? String(r.clientId) : null,
      event_name: String(r.eventName).trim(),
      planned_start: r.plannedStart || null,
      planned_end: r.plannedEnd || null,
      actual_start: r.actualStart || null,
      actual_end: r.actualEnd || null,
      status: pickEnum(r.status, EVENT_STATUSES, EVENT_STATUSES[0]),
      assigned_to: r.assignedTo ? String(r.assignedTo).trim() : null,
      progress_pct: Math.max(0, Math.min(100, Number(r.progressPct) || 0)),
      is_collapsed: r.isCollapsed ? 1 : 0,
      remarks: r.remarks ? String(r.remarks).trim() : null
    }));
}

// Expected Delay / Planned Progress / Actual Progress are never accepted from the client —
// they are derived here, at save time, from the project's own dates and its Sequence of
// Events rows (which is why these three must be computed AFTER sanitizeEventRows()).
// Local calendar day (the server's timezone) — toISOString() would give the UTC day, which in
// Oman (UTC+4) is still yesterday between midnight and 4am.
function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(dateStrA, dateStrB) {
  return Math.round((new Date(dateStrB + 'T00:00:00Z') - new Date(dateStrA + 'T00:00:00Z')) / 86400000);
}
function computeProjectPlannedPct(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const today = isoToday();
  if (today <= startDate) return 0;
  if (today >= endDate) return 100;
  const total = daysBetween(startDate, endDate);
  if (total <= 0) return 100;
  return +((daysBetween(startDate, today) / total) * 100).toFixed(1);
}
// Weighted rollup of each stage's own progress (weighted by its planned duration, so a
// multi-month Execution stage moves the overall % more than a two-day Mobilization stage).
function computeProjectActualPct(sanitizedEvents) {
  if (!sanitizedEvents.length) return 0;
  let weightedSum = 0, totalWeight = 0;
  sanitizedEvents.forEach(e => {
    let weight = 1;
    if (e.planned_start && e.planned_end) {
      const d = daysBetween(e.planned_start, e.planned_end) + 1;
      if (d > 0) weight = d;
    }
    const progress = e.status === 'Completed' ? 100 : Math.max(0, Math.min(100, Number(e.progress_pct) || 0));
    weightedSum += weight * progress;
    totalWeight += weight;
  });
  return totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(1) : 0;
}
// Expected Delay = Revised Completion Date (latest Planned End in the Sequence of Events, see
// latestPlannedEnd) − Planned Completion Date, in days. Never negative: a revised finish on or
// before the planned one is no delay. 0 when either date is missing.
function computeProjectExpectedDelay(events, endDate) {
  const revised = latestPlannedEnd(events);
  if (!revised || !endDate) return 0;
  return Math.max(0, daysBetween(endDate, revised));
}

const insertMaterialStmt = db.prepare(`INSERT INTO project_materials
  (project_id, event_id, stage, material_name, specification, unit, planned_qty, consumed_qty, unit_rate, supplier, delivery_date, status, notes)
  VALUES (@project_id, @event_id, @stage, @material_name, @specification, @unit, @planned_qty, @consumed_qty, @unit_rate, @supplier, @delivery_date, @status, @notes)`);
const insertCrewStmt = db.prepare(`INSERT INTO project_crews
  (project_id, event_id, stage, resource_type, resource_name, contractor_id, po_ref, quantity, actual_qty, rate_basis, unit_rate, allocated_days, start_date, end_date, status, notes)
  VALUES (@project_id, @event_id, @stage, @resource_type, @resource_name, @contractor_id, @po_ref, @quantity, @actual_qty, @rate_basis, @unit_rate, @allocated_days, @start_date, @end_date, @status, @notes)`);
const insertEventStmt = db.prepare(`INSERT INTO project_events
  (project_id, seq_no, stage, event_name, planned_start, planned_end, actual_start, actual_end, status, assigned_to, progress_pct, is_collapsed, remarks)
  VALUES (@project_id, @seq_no, @stage, @event_name, @planned_start, @planned_end, @actual_start, @actual_end, @status, @assigned_to, @progress_pct, @is_collapsed, @remarks)`);
const insertSubcontractorStmt = db.prepare(`INSERT INTO project_subcontractors (project_id, contractor_id) VALUES (@project_id, @contractor_id)`);
const insertProjectGovernorateStmt = db.prepare(`INSERT INTO project_governorates (project_id, governorate_id) VALUES (@project_id, @governorate_id)`);

// Distinct, valid-looking contractor ids only — mirrors the light-touch validation the other
// sanitizeXRows() helpers use (the contractor_id FK itself is the backstop against garbage).
// Generic numeric-id-array sanitizer, shared by any many-to-many project link (subcontractors,
// locations, ...): dedupes and drops anything that isn't a truthy number.
function sanitizeIdList(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  ids.forEach(id => { const n = Number(id); if (n) seen.add(n); });
  return [...seen];
}

// Events are inserted first so materials/crews can resolve a real event_id from the
// client-generated clientId each row carries (see eventBlockHTML/readEventRows on the
// client) — events have no stable id until this insert happens, since the whole event list
// is deleted and reinserted fresh on every save. A material/crew whose clientId doesn't
// resolve (event removed, or never assigned to one) gets event_id = NULL and keeps its own
// stage — it surfaces in the "Other Materials & Crew" section, same as an orphan today.
const insertEntryStmt = db.prepare(`INSERT INTO line_actual_entries (project_id, line_kind, line_id, entry_date, quantity, note, created_by, created_at)
  VALUES (@project_id, @line_kind, @line_id, @entry_date, @quantity, @note, @created_by, COALESCE(@created_at, utc_now_text()))`);
async function syncProjectChildren(projectId, sanitizedMaterials, sanitizedCrews, sanitizedEvents, sanitizedSubcontractorIds, sanitizedGovernorateIds, actor) {
  // Lines are rewritten on every save, so their dated actual entries are too. An entry that already existed keeps its
  // original author and time (matched by id, server-side — the browser cannot claim someone else's entry).
  const stamps = {};
  (await db.prepare('SELECT id, created_by, created_at FROM line_actual_entries WHERE project_id = ?').all(projectId))
    .forEach(r => { stamps[r.id] = r; });
  await db.prepare('DELETE FROM line_actual_entries WHERE project_id = ?').run(projectId);
  const saveEntries = async (kind, lineId, entries) => {
    for (const e of entries || []) {
      const old = e.id != null ? stamps[e.id] : null;
      await insertEntryStmt.run({ project_id: projectId, line_kind: kind, line_id: lineId, entry_date: e.entry_date, quantity: e.quantity, note: e.note,
        created_by: old ? old.created_by : (actor || null), created_at: old ? old.created_at : null });
    }
  };
  await db.prepare('DELETE FROM project_materials WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM project_crews WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM project_events WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM project_subcontractors WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM project_governorates WHERE project_id = ?').run(projectId);

  const eventByClientId = {};
  for (const e of sanitizedEvents) {
    const { client_id, ...eventFields } = e;
    const info = await insertEventStmt.run({ project_id: projectId, ...eventFields });
    if (client_id != null) eventByClientId[client_id] = { id: info.lastInsertRowid, stage: eventFields.stage };
  }

  for (const m of sanitizedMaterials) {
    const { client_event_id, entries, ...materialFields } = m;
    const linked = client_event_id != null ? eventByClientId[client_event_id] : null;
    const info = await insertMaterialStmt.run({
      project_id: projectId,
      event_id: linked ? linked.id : null,
      ...materialFields,
      stage: linked ? linked.stage : materialFields.stage
    });
    await saveEntries('material', info.lastInsertRowid, entries);
  }
  for (const c of sanitizedCrews) {
    const { client_event_id, entries, ...crewFields } = c;
    const linked = client_event_id != null ? eventByClientId[client_event_id] : null;
    const info = await insertCrewStmt.run({
      project_id: projectId,
      event_id: linked ? linked.id : null,
      ...crewFields,
      stage: linked ? linked.stage : crewFields.stage
    });
    await saveEntries('crew', info.lastInsertRowid, entries);
  }
  for (const id of sanitizedSubcontractorIds || []) await insertSubcontractorStmt.run({ project_id: projectId, contractor_id: id });
  for (const id of sanitizedGovernorateIds || []) await insertProjectGovernorateStmt.run({ project_id: projectId, governorate_id: id });
}

async function loadProjectDetail(id) {
  const row = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`).get(id);
  if (!row) return null;
  const governorates = await db.prepare(`
    SELECT g.id, g.name FROM project_governorates pg
    JOIN governorates g ON g.id = pg.governorate_id
    WHERE pg.project_id = ? ORDER BY g.name
  `).all(id);
  const materials = (await db.prepare('SELECT * FROM project_materials WHERE project_id = ? ORDER BY id').all(id)).map(serializeMaterial);
  const crews = (await db.prepare(`
    SELECT pc.*, c.name AS contractor_name FROM project_crews pc
    LEFT JOIN contractors c ON c.id = pc.contractor_id
    WHERE pc.project_id = ? ORDER BY pc.id`).all(id)).map(serializeCrew);
  const entryRows = await db.prepare('SELECT * FROM line_actual_entries WHERE project_id = ? ORDER BY entry_date, id').all(id);
  const entriesOf = (kind, lineId) => entryRows.filter(e => e.line_kind === kind && e.line_id === lineId)
    .map(e => ({ id: e.id, date: e.entry_date, quantity: e.quantity, note: e.note, createdBy: e.created_by, createdAt: e.created_at }));
  materials.forEach(m => { m.entries = entriesOf('material', m.id); });
  crews.forEach(c => { c.entries = entriesOf('crew', c.id); });
  const rawEvents = await db.prepare('SELECT * FROM project_events WHERE project_id = ? ORDER BY seq_no, id').all(id);
  const events = rawEvents.map(serializeEvent);
  return {
    ...(await serializeProject(row, { rawEvents, materials, crews, governorates })),
    materials, crews, events,
    costStatement: computeCostStatement(materials, crews)
  };
}

// Every per-project figure serializeProject() would otherwise look up one project at a time
// (open issues, critical risks, approved CR cost) is fetched here in one grouped query each, so
// listing N projects costs a fixed handful of queries instead of 3 per project — which, fired
// concurrently, used to swamp the connection pool on every dashboard load.
// Optional "only these projects" filter for the list functions below: `projectIds` null/undefined
// = every project (the full dashboard load); an array of ids = just those (the dashboard's
// refresh after a save, which re-reads only the project(s) the save touched instead of the
// whole programme). Returns an `AND <col> = ANY(...)` clause plus its parameter list.
function projectScope(col, projectIds) {
  return projectIds ? { sql: ` AND ${col} = ANY(?::int[])`, params: [projectIds] } : { sql: '', params: [] };
}
async function countsByProject(sql, params = []) {
  const map = {};
  (await db.prepare(sql).all(...params)).forEach(r => { map[r.project_id] = r.n; });
  return map;
}
async function listProjects(projectIds) {
  const s = col => projectScope(col, projectIds);
  const all = (sql, scope) => db.prepare(sql).all(...scope.params);
  const rows = await all(`${PROJECT_SELECT} WHERE p.deleted_at IS NULL${s('p.id').sql} ORDER BY p.id`, s('p.id'));
  const openIssuesByProject = await countsByProject(
    `SELECT project_id, COUNT(*) AS n FROM issues WHERE ${OPEN_ISSUE_SQL}${s('project_id').sql} GROUP BY project_id`,
    s('project_id').params);
  const criticalRisksByProject = await countsByProject(
    `SELECT project_id, COUNT(*) AS n FROM risks WHERE ${CRITICAL_RISK_SQL}${s('project_id').sql} GROUP BY project_id`,
    s('project_id').params);
  const approvedCostByProject = await countsByProject(`
    SELECT cr.project_id AS project_id, COALESCE(SUM(a.cost_impact), 0) AS n FROM change_analyses a
    JOIN change_requests cr ON cr.id = a.change_request_id AND cr.deleted_at IS NULL
    WHERE ${CR_LATEST_DECISION_SQL} = 'Approved'${s('cr.project_id').sql}
    GROUP BY cr.project_id`, s('cr.project_id').params);
  const eventsByProject = {};
  (await all(`SELECT * FROM project_events WHERE TRUE${s('project_id').sql} ORDER BY project_id, seq_no, id`, s('project_id'))).forEach(e => {
    (eventsByProject[e.project_id] ??= []).push(e);
  });
  const materialsByProject = {};
  (await all(`SELECT * FROM project_materials WHERE TRUE${s('project_id').sql} ORDER BY project_id, id`, s('project_id'))).forEach(m => {
    (materialsByProject[m.project_id] ??= []).push(serializeMaterial(m));
  });
  const crewsByProject = {};
  (await all(`SELECT pc.*, c.name AS contractor_name FROM project_crews pc
    LEFT JOIN contractors c ON c.id = pc.contractor_id WHERE TRUE${s('pc.project_id').sql} ORDER BY pc.project_id, pc.id`, s('pc.project_id'))).forEach(c => {
    (crewsByProject[c.project_id] ??= []).push(serializeCrew(c));
  });
  const subcontractorsByProject = {};
  (await all(`
    SELECT ps.project_id AS project_id, c.id AS id, c.name AS name
    FROM project_subcontractors ps JOIN contractors c ON c.id = ps.contractor_id
    WHERE TRUE${s('ps.project_id').sql}
    ORDER BY ps.project_id, c.name
  `, s('ps.project_id'))).forEach(r => { (subcontractorsByProject[r.project_id] ??= []).push({ id: r.id, name: r.name }); });
  const governoratesByProject = {};
  (await all(`
    SELECT pg.project_id AS project_id, g.id AS id, g.name AS name
    FROM project_governorates pg JOIN governorates g ON g.id = pg.governorate_id
    WHERE TRUE${s('pg.project_id').sql}
    ORDER BY pg.project_id, g.name
  `, s('pg.project_id'))).forEach(r => { (governoratesByProject[r.project_id] ??= []).push({ id: r.id, name: r.name }); });
  return Promise.all(rows.map(row => serializeProject(row, {
    rawEvents: eventsByProject[row.id] || [],
    materials: materialsByProject[row.id] || [],
    crews: crewsByProject[row.id] || [],
    subcontractors: subcontractorsByProject[row.id] || [],
    governorates: governoratesByProject[row.id] || [],
    openIssues: openIssuesByProject[row.id] || 0,
    criticalRisks: criticalRisksByProject[row.id] || 0,
    approvedChangeCost: +(approvedCostByProject[row.id] || 0).toFixed(3)
  })));
}

app.get('/api/projects', async (req, res) => {
  res.json(await listProjects());
});

app.get('/api/projects/:id', async (req, res) => {
  const detail = await loadProjectDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Project not found' });
  res.json(detail);
});

// All projects' Sequence-of-Events rows, flattened with project name/code — the source
// data for the Gantt Timeline view (grouped/nested client-side by project then stage).
async function listEvents(projectIds) {
  const scope = projectScope('e.project_id', projectIds);
  const rows = await db.prepare(`
    SELECT e.*, p.name AS project_name, p.code AS project_code
    FROM project_events e
    JOIN projects p ON p.id = e.project_id AND p.deleted_at IS NULL
    WHERE TRUE${scope.sql}
    ORDER BY e.project_id, e.seq_no, e.id
  `).all(...scope.params);
  return rows.map(row => ({ ...serializeEvent(row), projectName: row.project_name, projectCode: row.project_code }));
}
app.get('/api/events', async (req, res) => {
  res.json(await listEvents());
});

/* =========================================================
   SEQUENCE OF EVENTS — EXCEL TEMPLATE DOWNLOAD / BULK IMPORT
   Stateless: the template carries no project-specific data, and a parsed upload is
   handed back to the browser as JSON for the user to review inside the already-open
   Edit Project form (nothing is written to the database here) — it's merged in the
   same way a manually-added row would be, then only persists when Save Project runs.
   ========================================================= */
// A single combined sheet: every row is an Event, a Material line or a Crew/Labor line,
// selected by its own Row Type column (so the three used to be separate sheets, now one, as
// requested) — Material/Crew rows still link to an Event by matching Stage, same as the app's
// own mini-tables. Columns not used by a row's Row Type are simply left blank on that row.
// Column headers are chosen so every label used by parseCombinedEventsSheet() below is a
// case-insensitive prefix match against exactly one column — see the comment there.
const COMBINED_ROW_TYPES = ['Event', 'Material', 'Crew / Labor'];
const COMBINED_HEADERS = [
  ['Row Type', 14], ['Stage', 24], ['Name', 30], ['Status', 16],
  ['Seq No', 8], ['Planned Start (DD/MM/YYYY)', 20], ['Planned End (DD/MM/YYYY)', 20],
  ['Actual Start (DD/MM/YYYY)', 20], ['Actual End (DD/MM/YYYY)', 20], ['Assigned To', 18], ['Progress %', 11],
  ['Event Seq No', 13], ['Planned Qty', 12], ['Consumed / Actual Qty', 18], ['Unit Rate (OMR)', 14],
  ['Specification', 22], ['Material Unit', 12], ['Supplier', 20], ['Delivery Date (DD/MM/YYYY)', 20],
  ['Resource Type', 16], ['Rate Basis', 14], ['Days', 8], ['Subcontractor', 24], ['PO Reference No', 20],
  ['Notes', 30]
];
// Column groups for the banner row above the headers (1-indexed, inclusive) — purely visual,
// coloured with the app's own palette so each block of columns reads at a glance.
const COMBINED_GROUPS = [
  { from: 1, to: 4, label: 'ALL ROW TYPES', color: 'FF0F4C5C' },
  { from: 5, to: 11, label: 'EVENT ROWS ONLY', color: 'FF1B7A8C' },
  { from: 12, to: 15, label: 'MATERIAL & CREW/LABOR ROWS', color: 'FFC9A15A' },
  { from: 16, to: 19, label: 'MATERIAL ROWS ONLY', color: 'FFDCC08C' },
  { from: 20, to: 24, label: 'CREW / LABOR ROWS ONLY', color: 'FFC94C4C' },
  { from: 25, to: 25, label: 'ALL ROW TYPES', color: 'FF0F4C5C' }
];
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Accepts an Excel date serial (parsed into a JS Date by XLSX.read's cellDates:true),
// a DD/MM/YYYY string (what the template asks for and what Excel auto-formats typed
// dates as, matching this app's date display convention), or a plain ISO string as a
// fallback. Returns null (rather than throwing) for anything it can't confidently parse,
// so the caller can surface a per-row warning instead of failing the whole import.
function parseFlexibleDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return isNaN(value) ? null : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

// Builds the combined-sheet workbook (banner + headers + dropdowns + Reference sheet) shared by
// the blank template and the "export current data" download below — both just hand it a
// different set of data rows, in COMBINED_HEADERS column order, starting at row 3.
function buildCombinedEventsWorkbook(dataRows, contractorNames = []) {
  const COMBINED_STATUS_VALUES = [...new Set([...EVENT_STATUSES, ...MATERIAL_STATUSES, ...CREW_STATUSES])];
  const FIRST_DATA_ROW = 3, LAST_DATA_ROW = Math.max(300, dataRows.length + 10);
  const colOf = (header) => COMBINED_HEADERS.findIndex(([h]) => h === header) + 1;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Water Rehabilitation Dashboard';
  wb.created = new Date();
  const ws = wb.addWorksheet('Sequence of Events', { views: [{ state: 'frozen', ySplit: 2 }] });
  COMBINED_HEADERS.forEach(([, width], i) => { ws.getColumn(i + 1).width = width; });

  // Row 1: a merged banner over each block of columns, colour-coded by which Row Type uses them.
  COMBINED_GROUPS.forEach(g => {
    ws.mergeCells(1, g.from, 1, g.to);
    const cell = ws.getCell(1, g.from);
    cell.value = g.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.color } };
  });
  ws.getRow(1).height = 20;

  // Row 2: the real column headers.
  COMBINED_HEADERS.forEach(([header], i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2B3C' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  ws.getRow(2).height = 30;

  // Rows 3+: either the 3 illustrative example rows (blank template) or the project's actual
  // current Events/Materials/Crew (export), matching the column order in COMBINED_HEADERS exactly.
  dataRows.forEach(r => ws.addRow(r));

  // Dropdown (data validation) cells — the actual ask: Stage (and the other enum columns) are
  // a real pick-from-list in Excel, not just free text checked against the Reference sheet.
  const listValidation = (values) => ({ type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`] });
  const applyToColumn = (header, validation) => {
    const col = colOf(header);
    for (let r = FIRST_DATA_ROW; r <= LAST_DATA_ROW; r++) ws.getCell(r, col).dataValidation = validation;
  };
  applyToColumn('Row Type', listValidation(COMBINED_ROW_TYPES));
  applyToColumn('Stage', listValidation(STAGES));
  applyToColumn('Status', listValidation(COMBINED_STATUS_VALUES));
  applyToColumn('Resource Type', listValidation(RESOURCE_TYPES));
  applyToColumn('Rate Basis', listValidation(RATE_BASES));
  // Subcontractor: pick from the Contractors list (kept on the Reference sheet, so names with commas and long
  // lists work) — or simply type a new name: the dropdown only warns, and the app offers to add the new name on upload.
  const SUB_LIST_END = Math.max(contractorNames.length, 1) + 1;
  applyToColumn('Subcontractor', {
    type: 'list', allowBlank: true, formulae: [`Reference!$C$2:$C$${SUB_LIST_END}`],
    showErrorMessage: true, errorStyle: 'warning', errorTitle: 'New subcontractor?',
    error: 'This name is not in the Contractors list. Keep it and the app will offer to add it when you upload the file.'
  });
  ['Planned Start (DD/MM/YYYY)', 'Planned End (DD/MM/YYYY)', 'Actual Start (DD/MM/YYYY)', 'Actual End (DD/MM/YYYY)', 'Delivery Date (DD/MM/YYYY)'].forEach(h => {
    const col = colOf(h);
    for (let r = FIRST_DATA_ROW; r <= LAST_DATA_ROW; r++) ws.getCell(r, col).numFmt = 'dd/mm/yyyy';
  });

  const refWs = wb.addWorksheet('Reference');
  refWs.getColumn(1).width = 70;
  refWs.getColumn(3).width = 36;
  [
    ['How this template works'],
    ['Each row is one Event, one Material line, or one Crew / Labor line — pick which with the Row Type column (dropdown).'],
    ['A Material or Crew / Labor row links to one specific Event via its Event Seq No column — enter the Seq No shown on that Event\'s own row. Leave it blank and the line is only grouped by Stage (shows as "not assigned to a specific event" in the app), same as older downloads of this template.'],
    ['Leave a row completely blank to skip it.'],
    [''],
    ['Row Type values'], ...COMBINED_ROW_TYPES.map(s => [s]), [''],
    ['Valid Stage values'], ...STAGES.map(s => [s]), [''],
    ['Valid Status values — Event rows'], ...EVENT_STATUSES.map(s => [s]), [''],
    ['Valid Status values — Material rows'], ...MATERIAL_STATUSES.map(s => [s]), [''],
    ['Valid Status values — Crew / Labor rows'], ...CREW_STATUSES.map(s => [s]), [''],
    ['Valid Resource Type values — Crew / Labor rows only'], ...RESOURCE_TYPES.map(s => [s]), [''],
    ['Valid Rate Basis values — Crew / Labor rows only'], ...RATE_BASES.map(s => [s]), [''],
    ['Subcontractor — Crew / Labor rows only'],
    ['Pick the subcontractor doing this crew / labour line from the dropdown (list in column C of this sheet). To add a new one, just type its name: on upload the app asks whether to add it to the Contractors list. Every subcontractor used is also added to the project\'s Sub Contractors list.'], [''],
    ['PO Reference No — Crew / Labor rows only'],
    ['The subcontractor\'s purchase order reference for this line (free text, optional). The VOWD statement offers each distinct PO reference of the project as a dropdown, and carries Last Billed & Certified Value forward per PO.'], [''],
    ['Notes'],
    ['Dates must be entered as DD/MM/YYYY.'],
    ['Seq No controls the order of the Sequence of Events — leave blank to auto-number by row order.'],
    ['Event Seq No (Material & Crew / Labor rows only) — the Seq No of the Event this line belongs to.'],
    ['Planned Qty / Consumed / Actual Qty / Unit Rate (OMR) are shared: Material rows use them as Planned Qty / Consumed Qty / Unit Rate, Crew / Labor rows use them as Qty / Actual Qty / Unit Rate.'],
    ['Any value that doesn\'t match one of the lists above (case-insensitive) is defaulted and flagged on import.']
  ].forEach(l => refWs.addRow(l));
  refWs.getRow(1).font = { bold: true };
  // Written after the instruction lines above (addRow appends below whatever cells already exist).
  refWs.getCell('C1').value = 'Contractors list (Subcontractor column)';
  refWs.getCell('C1').font = { bold: true };
  contractorNames.forEach((n, i) => { refWs.getCell(i + 2, 3).value = n; });

  return wb;
}

async function contractorNameList() {
  return (await db.prepare('SELECT name FROM contractors ORDER BY name').all()).map(r => r.name);
}

app.get('/api/events/template', async (req, res) => {
  // One example of each Row Type, sharing a Stage and Event Seq No so the Material/Crew rows
  // visibly link to the example Event.
  const exampleRows = [
    ['Event', STAGES[0], 'Mobilize site & set up compound', EVENT_STATUSES[0], 1, '01/01/2026', '15/01/2026', '', '', '', 0, '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['Material', STAGES[0], 'DI Pipe 300mm', MATERIAL_STATUSES[0], '', '', '', '', '', '', '', 1, 500, 0, 45, 'Class K9', 'm', '', '', '', '', '', '', '', ''],
    ['Crew / Labor', STAGES[0], 'Pipe Laying Crew', CREW_STATUSES[0], '', '', '', '', '', '', '', 1, 1, 0, 80, '', '', '', '', RESOURCE_TYPES[0], RATE_BASES[0], 10, '', '', '']
  ];
  const wb = buildCombinedEventsWorkbook(exampleRows, await contractorNameList());
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sequence-of-events-template.xlsx"');
  res.send(Buffer.from(buf));
});

// DD/MM/YYYY for the export (matching the template's own date columns) from a stored
// 'YYYY-MM-DD' date, or '' when unset.
function dmyFromIso(iso) {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}
function eventExportRow(ev) {
  return ['Event', ev.stage, ev.eventName, ev.status, ev.seqNo,
    dmyFromIso(ev.plannedStart), dmyFromIso(ev.plannedEnd), dmyFromIso(ev.actualStart), dmyFromIso(ev.actualEnd),
    ev.assignedTo || '', ev.progressPct ?? 0,
    '', '', '', '', '', '', '', '', '', '', '', '', '', ev.remarks || ''];
}
function materialExportRow(m, eventSeqNo) {
  return ['Material', m.stage, m.materialName, m.status, '', '', '', '', '', '', '',
    eventSeqNo ?? '', m.plannedQty || 0, m.consumedQty || 0, m.unitRate || 0,
    m.specification || '', m.unit || '', m.supplier || '', dmyFromIso(m.deliveryDate),
    '', '', '', '', '', m.notes || ''];
}
function crewExportRow(c, eventSeqNo) {
  return ['Crew / Labor', c.stage, c.resourceName, c.status, '', '', '', '', '', '', '',
    eventSeqNo ?? '', c.quantity || 0, c.actualQty || 0, c.unitRate || 0,
    '', '', '', '', c.resourceType || '', c.rateBasis || '', c.allocatedDays || 0, c.contractor || '', c.poRef || '', c.notes || ''];
}
// One row per Event (in Sequence order), immediately followed by its own Materials then Crew /
// Labor lines — mirroring how they nest under that event in the app. Materials/Crew not tied to
// a specific event ("Other Materials & Crew" in the app) are listed last, Event Seq No blank.
function buildEventsExportRows(events, materials, crews) {
  const matByEvent = {}, crewByEvent = {};
  const orphanMats = [], orphanCrews = [];
  materials.forEach(m => { if (m.eventId != null) (matByEvent[m.eventId] ??= []).push(m); else orphanMats.push(m); });
  crews.forEach(c => { if (c.eventId != null) (crewByEvent[c.eventId] ??= []).push(c); else orphanCrews.push(c); });

  const rows = [];
  events.forEach(ev => {
    rows.push(eventExportRow(ev));
    (matByEvent[ev.id] || []).forEach(m => rows.push(materialExportRow(m, ev.seqNo)));
    (crewByEvent[ev.id] || []).forEach(c => rows.push(crewExportRow(c, ev.seqNo)));
  });
  orphanMats.forEach(m => rows.push(materialExportRow(m, null)));
  orphanCrews.forEach(c => rows.push(crewExportRow(c, null)));
  return rows;
}

// Same template, pre-filled with this project's current Sequence of Events / Materials / Crew —
// so a user can download, correct records in Excel, and upload the same file back via "Upload
// Filled Template" instead of re-keying everything from scratch.
app.get('/api/projects/:id/events/export', async (req, res) => {
  const detail = await loadProjectDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Project not found' });
  const dataRows = buildEventsExportRows(detail.events, detail.materials, detail.crews);
  const wb = buildCombinedEventsWorkbook(dataRows, await contractorNameList());
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="sequence-of-events-${detail.code}.xlsx"`);
  res.send(Buffer.from(buf));
});

// Older three-separate-sheets template (Sequence of Events / Materials / Crew - Labor), kept
// working for anyone who already downloaded it before the single combined-sheet template —
// unchanged from the original per-sheet parsing, just lifted into its own function.
function parseThreeSheetFormat(wb, eventsSheetName, materialsSheetName, crewSheetName) {
  const sheet = eventsSheetName && wb.Sheets[eventsSheetName];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const warnings = [];
  const events = [];
  rows.forEach((r, idx) => {
    const keys = Object.keys(r);
    const get = (label) => {
      const key = keys.find(k => k.toLowerCase().startsWith(label.toLowerCase()));
      return key ? r[key] : '';
    };
    const eventName = String(get('Event Name') || '').trim();
    if (!eventName) return;
    const rowNum = idx + 2;

    let stage = String(get('Stage') || '').trim();
    const stageMatch = STAGES.find(s => s.toLowerCase() === stage.toLowerCase());
    if (stage && !stageMatch) warnings.push(`Row ${rowNum}: Stage "${stage}" not recognized — defaulted to "${STAGES[3]}".`);
    stage = stageMatch || STAGES[3];

    let status = String(get('Status') || '').trim();
    const statusMatch = EVENT_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
    if (status && !statusMatch) warnings.push(`Row ${rowNum}: Status "${status}" not recognized — defaulted to "${EVENT_STATUSES[0]}".`);
    status = statusMatch || EVENT_STATUSES[0];

    const rawPStart = get('Planned Start'), rawPEnd = get('Planned End'), rawAStart = get('Actual Start'), rawAEnd = get('Actual End');
    const plannedStart = parseFlexibleDate(rawPStart), plannedEnd = parseFlexibleDate(rawPEnd);
    const actualStart = parseFlexibleDate(rawAStart), actualEnd = parseFlexibleDate(rawAEnd);
    if (rawPStart && !plannedStart) warnings.push(`Row ${rowNum}: Planned Start "${rawPStart}" could not be read — use DD/MM/YYYY.`);
    if (rawPEnd && !plannedEnd) warnings.push(`Row ${rowNum}: Planned End "${rawPEnd}" could not be read — use DD/MM/YYYY.`);
    if (rawAStart && !actualStart) warnings.push(`Row ${rowNum}: Actual Start "${rawAStart}" could not be read — use DD/MM/YYYY.`);
    if (rawAEnd && !actualEnd) warnings.push(`Row ${rowNum}: Actual End "${rawAEnd}" could not be read — use DD/MM/YYYY.`);

    // A Completed row with no Progress given defaults to 100, same as picking Completed in the app.
    const rawProgress = get('Progress');
    const progressPct = (status === 'Completed' && String(rawProgress).trim() === '') ? 100
      : Math.max(0, Math.min(100, Number(rawProgress) || 0));

    events.push({
      seqNo: Number(get('Seq No')) || (events.length + 1),
      stage, eventName, plannedStart, plannedEnd, actualStart, actualEnd, status,
      assignedTo: String(get('Assigned To') || '').trim() || null,
      progressPct,
      remarks: String(get('Remarks') || '').trim() || null
    });
  });
  const materials = [];
  if (materialsSheetName) {
    XLSX.utils.sheet_to_json(wb.Sheets[materialsSheetName], { defval: '' }).forEach((r, idx) => {
      const keys = Object.keys(r);
      const get = (label) => { const key = keys.find(k => k.toLowerCase().startsWith(label.toLowerCase())); return key ? r[key] : ''; };
      const materialName = String(get('Material') || '').trim();
      if (!materialName) return;
      const rowNum = idx + 2;

      let stage = String(get('Stage') || '').trim();
      const stageMatch = STAGES.find(s => s.toLowerCase() === stage.toLowerCase());
      if (stage && !stageMatch) warnings.push(`Materials row ${rowNum}: Stage "${stage}" not recognized — defaulted to "${STAGES[3]}".`);
      stage = stageMatch || STAGES[3];

      let status = String(get('Status') || '').trim();
      const statusMatch = MATERIAL_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (status && !statusMatch) warnings.push(`Materials row ${rowNum}: Status "${status}" not recognized — defaulted to "${MATERIAL_STATUSES[0]}".`);
      status = statusMatch || MATERIAL_STATUSES[0];

      const rawDelivery = get('Delivery Date');
      const deliveryDate = parseFlexibleDate(rawDelivery);
      if (rawDelivery && !deliveryDate) warnings.push(`Materials row ${rowNum}: Delivery Date "${rawDelivery}" could not be read — use DD/MM/YYYY.`);

      materials.push({
        stage, materialName,
        specification: String(get('Specification') || '').trim() || null,
        unit: String(get('Unit') || '').trim() || null,
        plannedQty: Number(get('Planned Qty')) || 0,
        consumedQty: Number(get('Consumed Qty')) || 0,
        unitRate: Number(get('Unit Rate')) || 0,
        supplier: String(get('Supplier') || '').trim() || null,
        deliveryDate,
        status,
        notes: String(get('Notes') || '').trim() || null
      });
    });
  }

  const crews = [];
  if (crewSheetName) {
    XLSX.utils.sheet_to_json(wb.Sheets[crewSheetName], { defval: '' }).forEach((r, idx) => {
      const keys = Object.keys(r);
      const get = (label) => { const key = keys.find(k => k.toLowerCase().startsWith(label.toLowerCase())); return key ? r[key] : ''; };
      const resourceName = String(get('Resource') || '').trim();
      if (!resourceName) return;
      const rowNum = idx + 2;

      let stage = String(get('Stage') || '').trim();
      const stageMatch = STAGES.find(s => s.toLowerCase() === stage.toLowerCase());
      if (stage && !stageMatch) warnings.push(`Crew/Labor row ${rowNum}: Stage "${stage}" not recognized — defaulted to "${STAGES[3]}".`);
      stage = stageMatch || STAGES[3];

      let resourceType = String(get('Type') || '').trim();
      const typeMatch = RESOURCE_TYPES.find(s => s.toLowerCase() === resourceType.toLowerCase());
      if (resourceType && !typeMatch) warnings.push(`Crew/Labor row ${rowNum}: Type "${resourceType}" not recognized — defaulted to "${RESOURCE_TYPES[0]}".`);
      resourceType = typeMatch || RESOURCE_TYPES[0];

      let rateBasis = String(get('Rate Basis') || '').trim();
      const rateBasisMatch = RATE_BASES.find(s => s.toLowerCase() === rateBasis.toLowerCase());
      if (rateBasis && !rateBasisMatch) warnings.push(`Crew/Labor row ${rowNum}: Rate Basis "${rateBasis}" not recognized — defaulted to "${RATE_BASES[0]}".`);
      rateBasis = rateBasisMatch || RATE_BASES[0];

      let status = String(get('Status') || '').trim();
      const statusMatch = CREW_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (status && !statusMatch) warnings.push(`Crew/Labor row ${rowNum}: Status "${status}" not recognized — defaulted to "${CREW_STATUSES[0]}".`);
      status = statusMatch || CREW_STATUSES[0];

      crews.push({
        stage, resourceType, resourceName,
        quantity: Number(get('Qty')) || 0,
        actualQty: Number(get('Actual Qty')) || 0,
        rateBasis,
        unitRate: Number(get('Unit Rate')) || 0,
        allocatedDays: Number(get('Days')) || 0,
        status,
        notes: String(get('Notes') || '').trim() || null
      });
    });
  }

  return { events, materials, crews, warnings };
}

// Matches a Row Type cell against the three Row Types by case-insensitive prefix, accepting
// "Crew", "Labor" or "Labour" too (not just the exact "Crew / Labor" wording) for leniency.
function matchRowType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('event')) return 'event';
  if (s.startsWith('material')) return 'material';
  if (s.startsWith('crew') || s.startsWith('labor') || s.startsWith('labour')) return 'crew';
  return null;
}

// Current single combined-sheet template: one row is an Event, Material or Crew/Labor line,
// selected by its Row Type column. Column labels below are each a case-insensitive prefix
// match against exactly one COMBINED_HEADERS column — see that constant's comment for why
// (e.g. "Consumed" / "Unit Rate" / "Material Unit" are deliberately distinct prefixes so they
// can never match each other's column, even though several headers start similarly).
// Returns null if no row has a recognizable Row Type at all, so the caller can fall back to
// treating the file as the older three-sheet format instead.
// Resolves a Material/Crew row's "Event Seq No" cell against the Seq No -> events-array-index
// map built below, so it can carry a precise eventIndex alongside its (still Stage-based, for
// back-compat) stage text. Blank Event Seq No is normal — unassigned lines just group by Stage,
// same as before this column existed.
function resolveEventIndex(get, seqNoToEventIndex, rowNum) {
  const raw = get('Event Seq No');
  const s = String(raw ?? '').trim();
  if (!s) return { eventIndex: null };
  const n = Number(s);
  if (!isNaN(n) && Object.prototype.hasOwnProperty.call(seqNoToEventIndex, n)) return { eventIndex: seqNoToEventIndex[n] };
  return { eventIndex: null, eventSeqWarning: `Row ${rowNum}: Event Seq No "${raw}" does not match any Event row — line left unassigned to a specific event (grouped by Stage only).` };
}

function parseCombinedEventsSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', range: 1 }); // row 1 is the banner; row 2 (index 1) is the real header row
  const warnings = [], events = [], materials = [], crews = [];
  let sawAnyRowType = false;

  // Lightweight pre-pass: map each Event row's eventual Seq No (explicit, or auto-numbered
  // exactly as the real pass below assigns it) to that event's index in `events` — so a
  // Material/Crew row can resolve "Event Seq No" regardless of which order rows appear in.
  const seqNoToEventIndex = {};
  let eventCount = 0;
  rows.forEach(r => {
    const keys = Object.keys(r);
    const get = (label) => { const key = keys.find(k => k.toLowerCase().startsWith(label.toLowerCase())); return key ? r[key] : ''; };
    if (matchRowType(get('Row Type')) !== 'event' || !String(get('Name') || '').trim()) return;
    eventCount++;
    seqNoToEventIndex[Number(get('Seq No')) || eventCount] = eventCount - 1;
  });

  rows.forEach((r, idx) => {
    const keys = Object.keys(r);
    const get = (label) => { const key = keys.find(k => k.toLowerCase().startsWith(label.toLowerCase())); return key ? r[key] : ''; };
    const rowNum = idx + 3; // header is row 2, data starts row 3
    const rawRowType = get('Row Type');
    const rowType = matchRowType(rawRowType);
    if (rowType) sawAnyRowType = true;
    const name = String(get('Name') || '').trim();
    if (!name && !String(rawRowType || '').trim()) return; // fully blank row — skip silently

    let stage = String(get('Stage') || '').trim();
    const stageMatch = STAGES.find(s => s.toLowerCase() === stage.toLowerCase());
    if (stage && !stageMatch) warnings.push(`Row ${rowNum}: Stage "${stage}" not recognized — defaulted to "${STAGES[3]}".`);
    stage = stageMatch || STAGES[3];

    if (!rowType) {
      if (name) warnings.push(`Row ${rowNum}: Row Type "${rawRowType}" not recognized (use Event / Material / Crew / Labor) — row skipped.`);
      return;
    }
    if (!name) return; // Row Type picked but nothing else filled in — skip silently

    if (rowType === 'event') {
      let status = String(get('Status') || '').trim();
      const statusMatch = EVENT_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (status && !statusMatch) warnings.push(`Row ${rowNum}: Status "${status}" not recognized for an Event row — defaulted to "${EVENT_STATUSES[0]}".`);
      status = statusMatch || EVENT_STATUSES[0];

      const rawPStart = get('Planned Start'), rawPEnd = get('Planned End'), rawAStart = get('Actual Start'), rawAEnd = get('Actual End');
      const plannedStart = parseFlexibleDate(rawPStart), plannedEnd = parseFlexibleDate(rawPEnd);
      const actualStart = parseFlexibleDate(rawAStart), actualEnd = parseFlexibleDate(rawAEnd);
      if (rawPStart && !plannedStart) warnings.push(`Row ${rowNum}: Planned Start "${rawPStart}" could not be read — use DD/MM/YYYY.`);
      if (rawPEnd && !plannedEnd) warnings.push(`Row ${rowNum}: Planned End "${rawPEnd}" could not be read — use DD/MM/YYYY.`);
      if (rawAStart && !actualStart) warnings.push(`Row ${rowNum}: Actual Start "${rawAStart}" could not be read — use DD/MM/YYYY.`);
      if (rawAEnd && !actualEnd) warnings.push(`Row ${rowNum}: Actual End "${rawAEnd}" could not be read — use DD/MM/YYYY.`);

      const rawProgress = get('Progress');
      const progressPct = (status === 'Completed' && String(rawProgress).trim() === '') ? 100
        : Math.max(0, Math.min(100, Number(rawProgress) || 0));

      events.push({
        seqNo: Number(get('Seq No')) || (events.length + 1),
        stage, eventName: name, plannedStart, plannedEnd, actualStart, actualEnd, status,
        assignedTo: String(get('Assigned To') || '').trim() || null,
        progressPct,
        remarks: String(get('Notes') || '').trim() || null
      });
    } else if (rowType === 'material') {
      let status = String(get('Status') || '').trim();
      const statusMatch = MATERIAL_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (status && !statusMatch) warnings.push(`Row ${rowNum}: Status "${status}" not recognized for a Material row — defaulted to "${MATERIAL_STATUSES[0]}".`);
      status = statusMatch || MATERIAL_STATUSES[0];

      const rawDelivery = get('Delivery Date');
      const deliveryDate = parseFlexibleDate(rawDelivery);
      if (rawDelivery && !deliveryDate) warnings.push(`Row ${rowNum}: Delivery Date "${rawDelivery}" could not be read — use DD/MM/YYYY.`);

      const { eventIndex, eventSeqWarning } = resolveEventIndex(get, seqNoToEventIndex, rowNum);
      if (eventSeqWarning) warnings.push(eventSeqWarning);

      materials.push({
        eventIndex, stage, materialName: name,
        specification: String(get('Specification') || '').trim() || null,
        unit: String(get('Material Unit') || '').trim() || null,
        plannedQty: Number(get('Planned Qty')) || 0,
        consumedQty: Number(get('Consumed') || get('Actual')) || 0,
        unitRate: Number(get('Unit Rate')) || 0,
        supplier: String(get('Supplier') || '').trim() || null,
        deliveryDate,
        status,
        notes: String(get('Notes') || '').trim() || null
      });
    } else { // crew
      let resourceType = String(get('Resource Type') || '').trim();
      const typeMatch = RESOURCE_TYPES.find(s => s.toLowerCase() === resourceType.toLowerCase());
      if (resourceType && !typeMatch) warnings.push(`Row ${rowNum}: Resource Type "${resourceType}" not recognized — defaulted to "${RESOURCE_TYPES[0]}".`);
      resourceType = typeMatch || RESOURCE_TYPES[0];

      let rateBasis = String(get('Rate Basis') || '').trim();
      const rateBasisMatch = RATE_BASES.find(s => s.toLowerCase() === rateBasis.toLowerCase());
      if (rateBasis && !rateBasisMatch) warnings.push(`Row ${rowNum}: Rate Basis "${rateBasis}" not recognized — defaulted to "${RATE_BASES[0]}".`);
      rateBasis = rateBasisMatch || RATE_BASES[0];

      let status = String(get('Status') || '').trim();
      const statusMatch = CREW_STATUSES.find(s => s.toLowerCase() === status.toLowerCase());
      if (status && !statusMatch) warnings.push(`Row ${rowNum}: Status "${status}" not recognized for a Crew / Labor row — defaulted to "${CREW_STATUSES[0]}".`);
      status = statusMatch || CREW_STATUSES[0];

      const { eventIndex, eventSeqWarning } = resolveEventIndex(get, seqNoToEventIndex, rowNum);
      if (eventSeqWarning) warnings.push(eventSeqWarning);

      crews.push({
        eventIndex, stage, resourceType, resourceName: name,
        quantity: Number(get('Planned Qty')) || 0,
        actualQty: Number(get('Consumed') || get('Actual')) || 0,
        rateBasis,
        unitRate: Number(get('Unit Rate')) || 0,
        allocatedDays: Number(get('Days')) || 0,
        contractorName: String(get('Subcontractor') || '').trim() || null,
        poRef: String(get('PO Ref') || '').trim().slice(0, 200),
        status,
        notes: String(get('Notes') || '').trim() || null
      });
    }
  });

  return sawAnyRowType ? { events, materials, crews, warnings } : null;
}

app.post('/api/events/import', async (req, res) => {
  importUpload.single('file')(req, res, async (err) => {
    if (err) return badRequest(res, err.message || 'Upload failed');
    if (!req.file) return badRequest(res, 'A file is required');
    let wb;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (e) {
      return badRequest(res, 'Could not read this file — please upload a valid .xlsx file.');
    }
    const eventsSheetName = wb.SheetNames.find(n => /sequence|event/i.test(n))
      || wb.SheetNames.find(n => !/reference|material|crew|labor|labour/i.test(n));
    const materialsSheetName = wb.SheetNames.find(n => /material/i.test(n));
    const crewSheetName = wb.SheetNames.find(n => /crew|labor|labour/i.test(n));

    let result = null;
    if (materialsSheetName || crewSheetName) {
      // An older template with Materials/Crew as their own separate sheets.
      result = parseThreeSheetFormat(wb, eventsSheetName, materialsSheetName, crewSheetName);
      if (!result) return badRequest(res, 'No Sequence of Events sheet found in the uploaded file.');
    } else {
      const sheet = eventsSheetName && wb.Sheets[eventsSheetName];
      if (!sheet) return badRequest(res, 'No data sheet found in the uploaded file.');
      result = parseCombinedEventsSheet(sheet);
      if (!result) return badRequest(res, 'No "Row Type" column found — please use the current Download Template.');
    }

    const { events, materials, crews, warnings } = result;
    if (!events.length && !materials.length && !crews.length) {
      return badRequest(res, 'No rows found in the uploaded file. Use the downloaded template and keep the header rows unchanged.');
    }
    // Subcontractor names -> the Contractors list (case-insensitive). A name that is not in the list is returned in
    // `newSubcontractors` so the browser can offer to add it — nothing is created here (the upload stays read-only).
    try {
      const masters = await db.prepare('SELECT id, name FROM contractors').all();
      const byName = new Map(masters.map(m => [m.name.trim().toLowerCase(), m]));
      const unknown = new Map();
      crews.forEach(c => {
        if (!c.contractorName) return;
        const key = c.contractorName.toLowerCase();
        const hit = byName.get(key);
        if (hit) { c.contractorId = hit.id; c.contractorName = hit.name; }
        else if (!unknown.has(key)) unknown.set(key, c.contractorName);
      });
      res.json({ events, materials, crews, warnings, newSubcontractors: [...unknown.values()] });
    } catch (e) {
      console.error('events import: subcontractor lookup failed', e);
      res.status(500).json({ error: 'Could not match the Subcontractor names against the Contractors list.' });
    }
  });
});

const omr3 = n => +(Number(n) || 0).toFixed(3); // amounts are kept to 3 decimals (1 OMR = 1000 baisa)
const projectWriteFields = (b) => ({
  name: b.name,
  governorate_id: b.governorateId,
  city: b.city || null,
  project_type_id: b.projectTypeId,
  contractor_id: b.contractorId || null,
  business_unit_id: b.businessUnitId || null,
  project_manager_id: b.projectManagerId || null,
  status: b.status,
  planned_pct: b.plannedPct ?? 0,
  actual_pct: b.actualPct ?? 0,
  approved_budget: omr3(b.approvedBudget),
  contract_value: omr3(b.contractValue),
  actual_cost: omr3(b.actualCost),
  committed_cost: omr3(b.committedCost),
  expected_delay_days: b.expectedDelayDays ?? 0,
  start_date: b.startDate,
  end_date: b.endDate,
  objective: b.objective ? String(b.objective).trim() : null,
  scope: b.scope ? String(b.scope).trim() : null,
  priority: pickEnum(b.priority, PRIORITIES, 'Medium'),
  funding_source: b.fundingSource ? String(b.fundingSource).trim() : null,
  contract_reference: b.contractReference ? String(b.contractReference).trim() : null,
  project_sponsor: b.projectSponsor ? String(b.projectSponsor).trim() : null
});

app.post('/api/projects', async (req, res) => {
  const b = req.body;
  if (!validateProjectBody(b, res)) return;
  const sanitizedEvents = sanitizeEventRows(b.events);
  const sanitizedMaterials = sanitizeMaterialRows(b.materials);
  const sanitizedCrews = sanitizeCrewRows(b.crews);
  const sanitizedSubcontractorIds = sanitizeIdList(b.subcontractorIds);
  const sanitizedGovernorateIds = sanitizeIdList(b.governorateIds);
  const autoFields = {
    plannedPct: computeProjectPlannedPct(b.startDate, b.endDate),
    actualPct: computeProjectActualPct(sanitizedEvents),
    expectedDelayDays: computeProjectExpectedDelay(sanitizedEvents, b.endDate),
    ...computeProjectCostsFromSanitized(sanitizedMaterials, sanitizedCrews),
    governorateId: sanitizedGovernorateIds[0]
  };
  const actualIssues = actualsProblems(sanitizedMaterials, sanitizedCrews, sanitizedEvents, autoFields.actualCost, omr3(b.approvedBudget));
  if (actualIssues.length) return rejectActuals(res, actualIssues);
  const dateIssues = entryDateProblems(sanitizedMaterials, sanitizedCrews);
  if (dateIssues.length) return res.status(400).json({ error: `Actual entries cannot be dated in the future: ${dateIssues.join('; ')}.`, code: 'ACTUAL_ENTRY_DATE' });
  const runInsert = db.transaction(async () => {
    await db.lock('project-code');
    const info = await db.prepare(`INSERT INTO projects
      (code, name, governorate_id, city, project_type_id, contractor_id, business_unit_id, project_manager_id, status, planned_pct, actual_pct,
       approved_budget, contract_value, actual_cost, committed_cost, expected_delay_days, start_date, end_date,
       objective, scope, priority, funding_source, contract_reference, project_sponsor)
      VALUES (@code, @name, @governorate_id, @city, @project_type_id, @contractor_id, @business_unit_id, @project_manager_id, @status, @planned_pct, @actual_pct,
       @approved_budget, @contract_value, @actual_cost, @committed_cost, @expected_delay_days, @start_date, @end_date,
       @objective, @scope, @priority, @funding_source, @contract_reference, @project_sponsor)`
    ).run({ code: await nextProjectCode(), ...projectWriteFields({ ...b, ...autoFields }) });
    await syncProjectChildren(info.lastInsertRowid, sanitizedMaterials, sanitizedCrews, sanitizedEvents, sanitizedSubcontractorIds, sanitizedGovernorateIds, actorName(req));
    return info.lastInsertRowid;
  });
  const newId = await runInsert();
  res.status(201).json(await loadProjectDetail(newId));
});

app.put('/api/projects/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  const b = req.body;
  if (!validateProjectBody(b, res)) return;
  const sanitizedEvents = sanitizeEventRows(b.events);
  const sanitizedMaterials = sanitizeMaterialRows(b.materials);
  const sanitizedCrews = sanitizeCrewRows(b.crews);
  const sanitizedSubcontractorIds = sanitizeIdList(b.subcontractorIds);
  const sanitizedGovernorateIds = sanitizeIdList(b.governorateIds);
  const autoFields = {
    plannedPct: computeProjectPlannedPct(b.startDate, b.endDate),
    actualPct: computeProjectActualPct(sanitizedEvents),
    expectedDelayDays: computeProjectExpectedDelay(sanitizedEvents, b.endDate),
    ...computeProjectCostsFromSanitized(sanitizedMaterials, sanitizedCrews),
    governorateId: sanitizedGovernorateIds[0]
  };
  const actualIssues = actualsProblems(sanitizedMaterials, sanitizedCrews, sanitizedEvents, autoFields.actualCost, omr3(b.approvedBudget));
  if (actualIssues.length) return rejectActuals(res, actualIssues);
  const dateIssues = entryDateProblems(sanitizedMaterials, sanitizedCrews);
  if (dateIssues.length) return res.status(400).json({ error: `Actual entries cannot be dated in the future: ${dateIssues.join('; ')}.`, code: 'ACTUAL_ENTRY_DATE' });
  const runUpdate = db.transaction(async () => {
    await db.prepare(`UPDATE projects SET
        name = @name, governorate_id = @governorate_id, city = @city, project_type_id = @project_type_id,
        contractor_id = @contractor_id, business_unit_id = @business_unit_id, project_manager_id = @project_manager_id,
        status = @status, planned_pct = @planned_pct, actual_pct = @actual_pct,
        approved_budget = @approved_budget, contract_value = @contract_value, actual_cost = @actual_cost,
        committed_cost = @committed_cost, expected_delay_days = @expected_delay_days,
        start_date = @start_date, end_date = @end_date,
        objective = @objective, scope = @scope, priority = @priority, funding_source = @funding_source,
        contract_reference = @contract_reference, project_sponsor = @project_sponsor,
        updated_at = utc_now_text()
      WHERE id = @id`
    ).run({ id: req.params.id, ...projectWriteFields({ ...b, ...autoFields }) });
    await syncProjectChildren(req.params.id, sanitizedMaterials, sanitizedCrews, sanitizedEvents, sanitizedSubcontractorIds, sanitizedGovernorateIds, actorName(req));
  });
  await runUpdate();
  res.json(await loadProjectDetail(req.params.id));
});

app.delete('/api/projects/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });
  await softDelete('projects', req.params.id, req); // everything under it is hidden with it, untouched
  res.status(204).end();
});

/* =========================================================
   RISK REGISTER
   A risk is a potential future event, scored Probability x Impact (1-5 each, so 1-25
   overall) with an optional residual score captured once mitigation is under way.
   ========================================================= */
const VALID_RISK_STATUSES = ['Open', 'Watching', 'Mitigating', 'Closed'];
const VALID_RISK_CATEGORIES = ['Cost', 'Schedule', 'Technical', 'Contractual', 'HSE', 'Environmental', 'Quality', 'Resource', 'Stakeholder', 'Regulatory', 'Other'];
const VALID_RESPONSE_STRATEGIES = ['Avoid', 'Mitigate', 'Transfer', 'Accept'];

function scoreBand(score) {
  if (score >= 16) return 'Critical';
  if (score >= 10) return 'High';
  if (score >= 5) return 'Medium';
  return 'Low';
}

const RISK_SELECT = `
  SELECT r.*, p.name AS project_name, g.name AS governorate_name
  FROM risks r
  JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
  JOIN governorates g ON g.id = p.governorate_id
`;
function serializeRisk(row) {
  const inherentScore = row.probability * row.impact;
  const hasResidual = row.residual_probability != null && row.residual_impact != null;
  const severityBand = scoreBand(inherentScore);
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    governorate: row.governorate_name,
    title: row.title,
    description: row.description,
    category: row.category,
    owner: row.owner,
    status: row.status,
    identifiedDate: row.raised_date,
    mitigationTarget: row.mitigation_target,
    probability: row.probability,
    impact: row.impact,
    inherentScore,
    severityBand,
    responseStrategy: row.response_strategy,
    mitigationPlan: row.mitigation_plan,
    residualProbability: row.residual_probability,
    residualImpact: row.residual_impact,
    residualScore: hasResidual ? row.residual_probability * row.residual_impact : null,
    isCritical: !!row.is_critical, // manual override flag — combine with severityBand==='Critical' for display
    triggers: row.triggers,
    contingencyPlan: row.contingency_plan,
    remarks: row.remarks,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const riskWriteFields = (b, existing) => {
  const probability = Number(b.probability);
  const impact = Number(b.impact);
  const residualProbability = b.residualProbability !== '' && b.residualProbability != null ? Number(b.residualProbability) : null;
  const residualImpact = b.residualImpact !== '' && b.residualImpact != null ? Number(b.residualImpact) : null;
  return {
    title: b.title.trim(),
    status: b.status,
    raised_date: b.identifiedDate || (existing ? existing.raised_date : isoToday()),
    description: b.description || null,
    category: b.category || 'Other',
    owner: b.owner || null,
    mitigation_target: b.mitigationTarget || null,
    probability, impact,
    response_strategy: b.responseStrategy || null,
    mitigation_plan: b.mitigationPlan || null,
    residual_probability: residualProbability,
    residual_impact: residualImpact,
    is_critical: b.isCritical ? 1 : 0,
    triggers: b.triggers || null,
    contingency_plan: b.contingencyPlan || null,
    remarks: b.remarks || null
  };
};

function validateRiskBody(b, res) {
  if (!b.projectId || !b.title || !b.title.trim()) { badRequest(res, 'projectId and title are required'); return false; }
  if (!VALID_RISK_STATUSES.includes(b.status)) { badRequest(res, `status must be one of: ${VALID_RISK_STATUSES.join(', ')}`); return false; }
  const probability = Number(b.probability);
  const impact = Number(b.impact);
  if (!Number.isInteger(probability) || probability < 1 || probability > 5) { badRequest(res, 'probability must be an integer from 1 to 5'); return false; }
  if (!Number.isInteger(impact) || impact < 1 || impact > 5) { badRequest(res, 'impact must be an integer from 1 to 5'); return false; }
  if (b.category && !VALID_RISK_CATEGORIES.includes(b.category)) { badRequest(res, `category must be one of: ${VALID_RISK_CATEGORIES.join(', ')}`); return false; }
  if (b.responseStrategy && !VALID_RESPONSE_STRATEGIES.includes(b.responseStrategy)) { badRequest(res, `responseStrategy must be one of: ${VALID_RESPONSE_STRATEGIES.join(', ')}`); return false; }
  return true;
}

async function listRisks(projectId, projectIds) {
  const scope = projectScope('r.project_id', projectIds);
  const rows = projectId
    ? await db.prepare(`${RISK_SELECT} WHERE r.project_id = ? ORDER BY r.raised_date DESC, r.id`).all(projectId)
    : await db.prepare(`${RISK_SELECT} WHERE TRUE${scope.sql} ORDER BY r.raised_date DESC, r.id`).all(...scope.params);
  return rows.map(serializeRisk);
}
app.get('/api/risks', async (req, res) => {
  res.json(await listRisks(req.query.projectId));
});

app.post('/api/risks', async (req, res) => {
  const b = req.body;
  if (!validateRiskBody(b, res)) return;
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(b.projectId);
  if (!project) return badRequest(res, 'projectId does not exist');
  const info = await db.prepare(`INSERT INTO risks
      (project_id, title, status, raised_date, description, category, owner, mitigation_target,
       probability, impact, response_strategy, mitigation_plan, residual_probability, residual_impact,
       is_critical, triggers, contingency_plan, remarks)
    VALUES (@project_id, @title, @status, @raised_date, @description, @category, @owner, @mitigation_target,
       @probability, @impact, @response_strategy, @mitigation_plan, @residual_probability, @residual_impact,
       @is_critical, @triggers, @contingency_plan, @remarks)`)
    .run({ project_id: b.projectId, ...riskWriteFields(b) });
  res.status(201).json(serializeRisk(await db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(info.lastInsertRowid)));
});

app.put('/api/risks/:id', async (req, res) => {
  const existing = await activeChildRow('risks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Risk not found' });
  const b = req.body;
  if (!VALID_RISK_STATUSES.includes(b.status)) return badRequest(res, `status must be one of: ${VALID_RISK_STATUSES.join(', ')}`);
  b.projectId = b.projectId || existing.project_id;
  if (!validateRiskBody(b, res)) return;
  await db.prepare(`UPDATE risks SET
      title = @title, status = @status, raised_date = @raised_date, description = @description,
      category = @category, owner = @owner, mitigation_target = @mitigation_target,
      probability = @probability, impact = @impact, response_strategy = @response_strategy,
      mitigation_plan = @mitigation_plan, residual_probability = @residual_probability,
      residual_impact = @residual_impact, is_critical = @is_critical, triggers = @triggers,
      contingency_plan = @contingency_plan, remarks = @remarks, updated_at = utc_now_text()
    WHERE id = @id`)
    .run({ id: req.params.id, ...riskWriteFields(b, existing) });
  res.json(serializeRisk(await db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(req.params.id)));
});

app.delete('/api/risks/:id', async (req, res) => {
  const existing = await activeChildRow('risks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Risk not found' });
  await db.prepare('DELETE FROM risks WHERE id = ?').run(req.params.id); // issues.related_risk_id is cleared via ON DELETE SET NULL
  res.status(204).end();
});

/* =========================================================
   ISSUE LOG
   An issue is something that has already happened (RAID-log "Issue"), tracked by
   priority/status to resolution rather than scored by likelihood. May optionally
   trace back to the risk that materialized into it. Priority (business urgency) and
   severity (technical/functional impact) are tracked separately, as is who raised it
   (raisedBy) vs who is fixing it (assignedTo — the legacy `owner` column, relabeled).
   ========================================================= */
const VALID_ISSUE_STATUSES = ['Open', 'In Progress', 'Blocked', 'Resolved', 'Closed'];
const VALID_ISSUE_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const VALID_ISSUE_SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

const ISSUE_SELECT = `
  SELECT i.*, p.name AS project_name, g.name AS governorate_name, r.title AS related_risk_title
  FROM issues i
  JOIN projects p ON p.id = i.project_id AND p.deleted_at IS NULL
  JOIN governorates g ON g.id = p.governorate_id
  LEFT JOIN risks r ON r.id = i.related_risk_id
`;
function serializeIssue(row) {
  const today = isoToday();
  const isOpenState = row.status !== 'Resolved' && row.status !== 'Closed';
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    governorate: row.governorate_name,
    title: row.title,
    description: row.description,
    category: row.category,
    assignedTo: row.owner,
    raisedBy: row.raised_by,
    priority: row.priority,
    severity: row.severity,
    status: row.status,
    raisedDate: row.raised_date,
    targetResolutionDate: row.target_resolution_date,
    actualResolutionDate: row.actual_resolution_date,
    impactDescription: row.impact_description,
    rootCause: row.root_cause,
    resolutionPlan: row.resolution_plan,
    verificationNotes: row.verification_notes,
    relatedRiskId: row.related_risk_id,
    relatedRiskTitle: row.related_risk_title,
    isBlocking: !!row.is_escalated,
    isOverdue: isOpenState && !!row.target_resolution_date && row.target_resolution_date < today,
    remarks: row.remarks,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const issueWriteFields = (b, existing, req) => ({
  title: b.title.trim(),
  status: b.status,
  raised_date: b.raisedDate || (existing ? existing.raised_date : isoToday()),
  description: b.description || null,
  category: b.category || 'Other',
  owner: b.assignedTo || null,
  raised_by: b.raisedBy || (existing ? existing.raised_by : null) || (req.session && req.session.username) || null,
  priority: b.priority,
  severity: b.severity || b.priority,
  target_resolution_date: b.targetResolutionDate || null,
  actual_resolution_date: b.actualResolutionDate || null,
  impact_description: b.impactDescription || null,
  root_cause: b.rootCause || null,
  resolution_plan: b.resolutionPlan || null,
  verification_notes: b.verificationNotes || null,
  related_risk_id: b.relatedRiskId || null,
  is_escalated: b.isBlocking ? 1 : 0,
  remarks: b.remarks || null
});

async function validateIssueBody(b, res) {
  if (!b.projectId || !b.title || !b.title.trim()) { badRequest(res, 'projectId and title are required'); return false; }
  if (!VALID_ISSUE_STATUSES.includes(b.status)) { badRequest(res, `status must be one of: ${VALID_ISSUE_STATUSES.join(', ')}`); return false; }
  if (!VALID_ISSUE_PRIORITIES.includes(b.priority)) { badRequest(res, `priority must be one of: ${VALID_ISSUE_PRIORITIES.join(', ')}`); return false; }
  if (b.severity && !VALID_ISSUE_SEVERITIES.includes(b.severity)) { badRequest(res, `severity must be one of: ${VALID_ISSUE_SEVERITIES.join(', ')}`); return false; }
  if (b.category && !VALID_RISK_CATEGORIES.includes(b.category)) { badRequest(res, `category must be one of: ${VALID_RISK_CATEGORIES.join(', ')}`); return false; }
  if (b.relatedRiskId && !(await activeChildRow('risks', b.relatedRiskId))) { badRequest(res, 'relatedRiskId does not exist'); return false; }
  return true;
}

async function listIssues(projectId, projectIds) {
  const scope = projectScope('i.project_id', projectIds);
  const rows = projectId
    ? await db.prepare(`${ISSUE_SELECT} WHERE i.project_id = ? ORDER BY i.raised_date DESC, i.id`).all(projectId)
    : await db.prepare(`${ISSUE_SELECT} WHERE TRUE${scope.sql} ORDER BY i.raised_date DESC, i.id`).all(...scope.params);
  return rows.map(serializeIssue);
}
app.get('/api/issues', async (req, res) => {
  res.json(await listIssues(req.query.projectId));
});

app.post('/api/issues', async (req, res) => {
  const b = req.body;
  if (!(await validateIssueBody(b, res))) return;
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(b.projectId);
  if (!project) return badRequest(res, 'projectId does not exist');
  const info = await db.prepare(`INSERT INTO issues
      (project_id, title, status, raised_date, description, category, owner, raised_by, priority, severity,
       target_resolution_date, actual_resolution_date, impact_description, root_cause, resolution_plan,
       verification_notes, related_risk_id, is_escalated, remarks)
    VALUES (@project_id, @title, @status, @raised_date, @description, @category, @owner, @raised_by, @priority, @severity,
       @target_resolution_date, @actual_resolution_date, @impact_description, @root_cause, @resolution_plan,
       @verification_notes, @related_risk_id, @is_escalated, @remarks)`)
    .run({ project_id: b.projectId, ...issueWriteFields(b, null, req) });
  res.status(201).json(serializeIssue(await db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(info.lastInsertRowid)));
});

app.put('/api/issues/:id', async (req, res) => {
  const existing = await activeChildRow('issues', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Issue not found' });
  const b = req.body;
  b.projectId = b.projectId || existing.project_id;
  if (!(await validateIssueBody(b, res))) return;
  await db.prepare(`UPDATE issues SET
      title = @title, status = @status, raised_date = @raised_date, description = @description,
      category = @category, owner = @owner, raised_by = @raised_by, priority = @priority, severity = @severity,
      target_resolution_date = @target_resolution_date, actual_resolution_date = @actual_resolution_date,
      impact_description = @impact_description, root_cause = @root_cause, resolution_plan = @resolution_plan,
      verification_notes = @verification_notes, related_risk_id = @related_risk_id,
      is_escalated = @is_escalated, remarks = @remarks, updated_at = utc_now_text()
    WHERE id = @id`)
    .run({ id: req.params.id, ...issueWriteFields(b, existing, req) });
  res.json(serializeIssue(await db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(req.params.id)));
});

app.delete('/api/issues/:id', async (req, res) => {
  const existing = await activeChildRow('issues', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Issue not found' });
  await db.prepare('DELETE FROM issues WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* =========================================================
   "Load template" quick-start: bulk-adds a curated starter checklist of common
   risks/issues to a project so its register/log isn't starting from a blank page.
   ========================================================= */
app.post('/api/risks/template', async (req, res) => {
  const projectId = req.body.projectId;
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!project) return badRequest(res, 'projectId does not exist');
  const today = isoToday();
  const insert = db.prepare(`INSERT INTO risks
      (project_id, title, status, raised_date, category, probability, impact, response_strategy)
    VALUES (@project_id, @title, 'Open', @raised_date, @category, @probability, @impact, @response_strategy)`);
  const ids = await db.transaction(async () => {
    const out = [];
    for (const t of STARTER_RISKS) {
      out.push((await insert.run({
        project_id: projectId, raised_date: today, title: t.title, category: t.category,
        probability: t.probability, impact: t.impact, response_strategy: t.responseStrategy
      })).lastInsertRowid);
    }
    return out;
  })();
  const created = [];
  for (const id of ids) created.push(serializeRisk(await db.prepare(`${RISK_SELECT} WHERE r.id = ?`).get(id)));
  res.status(201).json(created);
});

app.post('/api/issues/template', async (req, res) => {
  const projectId = req.body.projectId;
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId);
  if (!project) return badRequest(res, 'projectId does not exist');
  const today = isoToday();
  const insert = db.prepare(`INSERT INTO issues
      (project_id, title, status, raised_date, category, priority, severity)
    VALUES (@project_id, @title, 'Open', @raised_date, @category, @priority, @severity)`);
  const ids = await db.transaction(async () => {
    const out = [];
    for (const t of STARTER_ISSUES) out.push((await insert.run({ project_id: projectId, raised_date: today, ...t })).lastInsertRowid);
    return out;
  })();
  const created = [];
  for (const id of ids) created.push(serializeIssue(await db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(id)));
  res.status(201).json(created);
});

/* =========================================================
   MILESTONES
   ========================================================= */
const VALID_MILESTONE_STATUSES = ['On Track', 'At Risk', 'Delayed'];
const MILESTONE_SELECT = `
  SELECT m.*, p.name AS project_name, g.name AS governorate_name
  FROM milestones m
  JOIN projects p ON p.id = m.project_id AND p.deleted_at IS NULL
  JOIN governorates g ON g.id = p.governorate_id
`;
function serializeMilestone(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    governorate: row.governorate_name,
    milestone: row.milestone,
    dueDate: row.due_date,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listMilestones(projectId, projectIds) {
  const scope = projectScope('m.project_id', projectIds);
  const rows = projectId
    ? await db.prepare(`${MILESTONE_SELECT} WHERE m.project_id = ? ORDER BY m.due_date NULLS FIRST, m.id`).all(projectId)
    : await db.prepare(`${MILESTONE_SELECT} WHERE TRUE${scope.sql} ORDER BY m.due_date NULLS FIRST, m.id`).all(...scope.params);
  return rows.map(serializeMilestone);
}
app.get('/api/milestones', async (req, res) => {
  res.json(await listMilestones(req.query.projectId));
});

app.post('/api/milestones', async (req, res) => {
  const b = req.body;
  if (!b.projectId || !b.milestone || !b.milestone.trim()) return badRequest(res, 'projectId and milestone are required');
  if (!VALID_MILESTONE_STATUSES.includes(b.status)) return badRequest(res, `status must be one of: ${VALID_MILESTONE_STATUSES.join(', ')}`);
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(b.projectId);
  if (!project) return badRequest(res, 'projectId does not exist');
  const info = await db.prepare('INSERT INTO milestones (project_id, milestone, due_date, status) VALUES (?, ?, ?, ?)')
    .run(b.projectId, b.milestone.trim(), b.dueDate || null, b.status);
  res.status(201).json(serializeMilestone(await db.prepare(`${MILESTONE_SELECT} WHERE m.id = ?`).get(info.lastInsertRowid)));
});

app.put('/api/milestones/:id', async (req, res) => {
  const existing = await activeChildRow('milestones', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Milestone not found' });
  const b = req.body;
  if (!b.milestone || !b.milestone.trim()) return badRequest(res, 'milestone is required');
  if (!VALID_MILESTONE_STATUSES.includes(b.status)) return badRequest(res, `status must be one of: ${VALID_MILESTONE_STATUSES.join(', ')}`);
  await db.prepare(`UPDATE milestones SET milestone = ?, due_date = ?, status = ?, updated_at = utc_now_text() WHERE id = ?`)
    .run(b.milestone.trim(), b.dueDate || existing.due_date, b.status, req.params.id);
  res.json(serializeMilestone(await db.prepare(`${MILESTONE_SELECT} WHERE m.id = ?`).get(req.params.id)));
});

app.delete('/api/milestones/:id', async (req, res) => {
  const existing = await activeChildRow('milestones', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Milestone not found' });
  await db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* =========================================================
   INVOICES (generated from a selection of a project's material/crew
   cost line items, with per-line or whole-invoice margin and VAT)
   ========================================================= */
const VALID_INVOICE_STATUSES = ['Draft', 'Issued', 'Paid', 'Cancelled'];
const MARGIN_TYPES = ['percent', 'value'];
const MARGIN_MODES = ['line', 'global'];

function round2(n) { return +(Number(n) || 0).toFixed(3); }

function sanitizeInvoiceItems(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r && r.description && String(r.description).trim())
    .map((r, idx) => ({
      source_type: r.sourceType === 'crew' ? 'crew' : 'material',
      source_id: r.sourceId || null,
      stage: r.stage ? String(r.stage).trim() : null,
      description: String(r.description).trim(),
      quantity: Number(r.quantity) || 0,
      unit: r.unit ? String(r.unit).trim() : null,
      unit_rate: Number(r.unitRate) || 0,
      base_amount: round2(r.baseAmount !== undefined ? r.baseAmount : (Number(r.quantity) || 0) * (Number(r.unitRate) || 0)),
      margin_type: MARGIN_TYPES.includes(r.marginType) ? r.marginType : 'percent',
      margin_value: Number(r.marginValue) || 0,
      sort_order: idx
    }));
}

// Line mode: each item carries its own margin. Global mode: a single margin
// (percent or flat value) is applied once to the invoice subtotal instead.
function computeInvoiceTotals(items, marginMode, globalMarginType, globalMarginValue, vatRate) {
  const subtotal = round2(items.reduce((s, i) => s + i.base_amount, 0));
  let computedItems, marginTotal;
  if (marginMode === 'global') {
    marginTotal = round2(globalMarginType === 'percent' ? subtotal * (globalMarginValue / 100) : globalMarginValue);
    computedItems = items.map(i => ({ ...i, margin_type: globalMarginType, margin_value: 0, margin_amount: 0, line_total: round2(i.base_amount) }));
  } else {
    computedItems = items.map(i => {
      const marginAmount = round2(i.margin_type === 'percent' ? i.base_amount * (i.margin_value / 100) : i.margin_value);
      return { ...i, margin_amount: marginAmount, line_total: round2(i.base_amount + marginAmount) };
    });
    marginTotal = round2(computedItems.reduce((s, i) => s + i.margin_amount, 0));
  }
  const vatAmount = round2((subtotal + marginTotal) * (vatRate / 100));
  const grandTotal = round2(subtotal + marginTotal + vatAmount);
  return { items: computedItems, subtotal, marginTotal, vatAmount, grandTotal };
}

function serializeInvoiceItem(row) {
  return {
    id: row.id, invoiceId: row.invoice_id, sourceType: row.source_type, sourceId: row.source_id,
    stage: row.stage, description: row.description, quantity: row.quantity, unit: row.unit,
    unitRate: row.unit_rate, baseAmount: row.base_amount, marginType: row.margin_type,
    marginValue: row.margin_value, marginAmount: row.margin_amount, lineTotal: row.line_total,
    sortOrder: row.sort_order
  };
}

function serializeInvoice(row) {
  return {
    id: row.id, projectId: row.project_id, invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date, dueDate: row.due_date, status: row.status,
    billFromName: row.bill_from_name, billFromAddress: row.bill_from_address, billFromContact: row.bill_from_contact,
    billToName: row.bill_to_name, billToAddress: row.bill_to_address, billToContact: row.bill_to_contact,
    marginMode: row.margin_mode, globalMarginType: row.global_margin_type, globalMarginValue: row.global_margin_value,
    vatRate: row.vat_rate, paymentTerms: row.payment_terms, bankDetails: row.bank_details, notes: row.notes,
    subtotal: row.subtotal, marginTotal: row.margin_total, vatAmount: row.vat_amount, grandTotal: row.grand_total,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

const invoiceInsertStmt = db.prepare(`INSERT INTO invoices
  (project_id, invoice_number, invoice_date, due_date, status, bill_from_name, bill_from_address, bill_from_contact,
   bill_to_name, bill_to_address, bill_to_contact, margin_mode, global_margin_type, global_margin_value, vat_rate,
   payment_terms, bank_details, notes, subtotal, margin_total, vat_amount, grand_total)
  VALUES (@project_id, @invoice_number, @invoice_date, @due_date, @status, @bill_from_name, @bill_from_address, @bill_from_contact,
   @bill_to_name, @bill_to_address, @bill_to_contact, @margin_mode, @global_margin_type, @global_margin_value, @vat_rate,
   @payment_terms, @bank_details, @notes, @subtotal, @margin_total, @vat_amount, @grand_total)`);
const invoiceItemInsertStmt = db.prepare(`INSERT INTO invoice_items
  (invoice_id, source_type, source_id, stage, description, quantity, unit, unit_rate, base_amount, margin_type, margin_value, margin_amount, line_total, sort_order)
  VALUES (@invoice_id, @source_type, @source_id, @stage, @description, @quantity, @unit, @unit_rate, @base_amount, @margin_type, @margin_value, @margin_amount, @line_total, @sort_order)`);

function invoiceWriteFields(b, existing) {
  return {
    invoice_date: b.invoiceDate || existing?.invoice_date || isoToday(),
    due_date: b.dueDate || null,
    status: VALID_INVOICE_STATUSES.includes(b.status) ? b.status : (existing?.status || 'Draft'),
    bill_from_name: b.billFromName || null, bill_from_address: b.billFromAddress || null, bill_from_contact: b.billFromContact || null,
    bill_to_name: b.billToName || null, bill_to_address: b.billToAddress || null, bill_to_contact: b.billToContact || null,
    payment_terms: b.paymentTerms || null, bank_details: b.bankDetails || null, notes: b.notes || null
  };
}

async function loadInvoiceDetail(id) {
  const row = await activeChildRow('invoices', id);
  if (!row) return null;
  const items = (await db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id)).map(serializeInvoiceItem);
  const projectRow = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(row.project_id);
  return { ...serializeInvoice(row), items, project: projectRow ? await serializeProject(projectRow) : null };
}

app.get('/api/projects/:id/invoices', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM invoices WHERE project_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(req.params.id);
  res.json(rows.map(serializeInvoice));
});

app.post('/api/projects/:id/invoices', async (req, res) => {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const b = req.body;
  const items = sanitizeInvoiceItems(b.items);
  if (!items.length) return badRequest(res, 'At least one line item is required');
  if (!MARGIN_MODES.includes(b.marginMode)) return badRequest(res, `marginMode must be one of: ${MARGIN_MODES.join(', ')}`);
  const globalMarginType = MARGIN_TYPES.includes(b.globalMarginType) ? b.globalMarginType : 'percent';
  const vatRate = Number(b.vatRate) || 0;
  const { items: computedItems, subtotal, marginTotal, vatAmount, grandTotal } =
    computeInvoiceTotals(items, b.marginMode, globalMarginType, Number(b.globalMarginValue) || 0, vatRate);

  const newId = await db.transaction(async () => {
    await db.lock('invoice-number');
    const info = await invoiceInsertStmt.run({
      project_id: project.id, invoice_number: 'PENDING',
      margin_mode: b.marginMode, global_margin_type: globalMarginType, global_margin_value: Number(b.globalMarginValue) || 0,
      vat_rate: vatRate, subtotal, margin_total: marginTotal, vat_amount: vatAmount, grand_total: grandTotal,
      ...invoiceWriteFields(b)
    });
    const invoiceId = info.lastInsertRowid;
    await db.prepare('UPDATE invoices SET invoice_number = ? WHERE id = ?')
      .run(`INV-${project.code}-${String(await perProjectSeq('invoices', project.id, invoiceId)).padStart(4, '0')}`, invoiceId);
    for (const i of computedItems) await invoiceItemInsertStmt.run({ invoice_id: invoiceId, ...i });
    return invoiceId;
  })();
  res.status(201).json(await loadInvoiceDetail(newId));
});

app.get('/api/invoices/:id', async (req, res) => {
  const detail = await loadInvoiceDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Invoice not found' });
  res.json(detail);
});

app.put('/api/invoices/:id', async (req, res) => {
  const existing = await activeChildRow('invoices', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  const b = req.body;
  const items = sanitizeInvoiceItems(b.items);
  if (!items.length) return badRequest(res, 'At least one line item is required');
  if (!MARGIN_MODES.includes(b.marginMode)) return badRequest(res, `marginMode must be one of: ${MARGIN_MODES.join(', ')}`);
  const globalMarginType = MARGIN_TYPES.includes(b.globalMarginType) ? b.globalMarginType : 'percent';
  const vatRate = Number(b.vatRate) || 0;
  const { items: computedItems, subtotal, marginTotal, vatAmount, grandTotal } =
    computeInvoiceTotals(items, b.marginMode, globalMarginType, Number(b.globalMarginValue) || 0, vatRate);

  await db.transaction(async () => {
    await db.prepare(`UPDATE invoices SET
        invoice_date = @invoice_date, due_date = @due_date, status = @status,
        bill_from_name = @bill_from_name, bill_from_address = @bill_from_address, bill_from_contact = @bill_from_contact,
        bill_to_name = @bill_to_name, bill_to_address = @bill_to_address, bill_to_contact = @bill_to_contact,
        margin_mode = @margin_mode, global_margin_type = @global_margin_type, global_margin_value = @global_margin_value,
        vat_rate = @vat_rate, payment_terms = @payment_terms, bank_details = @bank_details, notes = @notes,
        subtotal = @subtotal, margin_total = @margin_total, vat_amount = @vat_amount, grand_total = @grand_total,
        updated_at = utc_now_text()
      WHERE id = @id`
    ).run({
      id: req.params.id,
      margin_mode: b.marginMode, global_margin_type: globalMarginType, global_margin_value: Number(b.globalMarginValue) || 0,
      vat_rate: vatRate, subtotal, margin_total: marginTotal, vat_amount: vatAmount, grand_total: grandTotal,
      ...invoiceWriteFields(b, existing)
    });
    await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
    for (const i of computedItems) await invoiceItemInsertStmt.run({ invoice_id: req.params.id, ...i });
  })();
  res.json(await loadInvoiceDetail(req.params.id));
});

app.delete('/api/invoices/:id', async (req, res) => {
  const existing = await activeChildRow('invoices', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  await softDelete('invoices', req.params.id, req);
  res.status(204).end();
});

/* =========================================================
   DOCUMENT REPOSITORY (per-project file attachments)
   Files are stored on disk outside public/ (uploads/<projectId>/<uuid>.<ext>)
   and served only through the authenticated /api/documents/:id/download
   route below, never via express.static, so the upload folder is never
   directly browsable and every download still goes through the session gate.
   ========================================================= */
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const VALID_DOC_CATEGORIES = [
  'Contract Document', 'Drawings & Design', 'Permits & Approvals', 'Inspection Report',
  'Test Certificate', 'Photos (Progress / Site)', 'Correspondence', 'Method Statement',
  'Handover Document', 'Completion Certificate', 'Change Request', 'Other'
];
// Executable/script types are blocked; anything else (docs, drawings, images,
// spreadsheets, archives, PDFs) is accepted — this is a document repository,
// not a narrowly-typed form upload.
const BLOCKED_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.sh', '.msi', '.com', '.dll', '.ps1', '.vbs', '.js', '.jar', '.app']);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const crLockedMessage = status => status === 'Pending'
  ? 'This change request is awaiting approval and is locked. Withdraw it from approval first if its attachments need changing.'
  : status === 'Approved' ? 'This change request has been approved and is locked. An administrator can reopen it for revision.' : null;

const uploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) return cb(new Error(`File type ${ext} is not allowed`));
    cb(null, true);
  }
});

function serializeDocument(row) {
  return {
    id: row.id, projectId: row.project_id, category: row.category, title: row.title, notes: row.notes,
    originalFilename: row.original_filename, mimeType: row.mime_type, sizeBytes: row.size_bytes,
    isKey: !!row.is_key, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at,
    changeRequestId: row.change_request_id || null
  };
}

app.get('/api/projects/:id/documents', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM project_documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC').all(req.params.id);
  res.json(rows.map(serializeDocument));
});

app.post('/api/projects/:id/documents', async (req, res) => {
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const err = await runUpload(upload.single('file'), req, res);
  if (err) return badRequest(res, err.message || 'Upload failed');
  if (!req.file) return badRequest(res, 'A file is required');
  // An attachment can belong to one change request; it must be that project's, and not locked for approval.
  let crId = null;
  if (req.body.changeRequestId) {
    const cr = await db.prepare('SELECT id, approval_status FROM change_requests WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(req.body.changeRequestId, project.id);
    const problem = !cr ? 'That change request was not found on this project' : crLockedMessage(cr.approval_status);
    if (problem) { fs.unlink(req.file.path, () => {}); return res.status(cr ? 423 : 400).json({ error: problem, ...(cr ? { code: 'DOCUMENT_LOCKED' } : {}) }); }
    crId = cr.id;
  }
  const category = crId ? 'Change Request' : (VALID_DOC_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other');
  const title = (req.body.title && req.body.title.trim()) || req.file.originalname;
  const info = await db.prepare(`INSERT INTO project_documents
      (project_id, category, title, notes, original_filename, stored_filename, mime_type, size_bytes, is_key, uploaded_by, change_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(project.id, category, title, req.body.notes || null, req.file.originalname, req.file.filename,
         req.file.mimetype, req.file.size, req.body.isKey === 'true' ? 1 : 0, (req.session && req.session.username) || null, crId);
  const row = await activeChildRow('project_documents', info.lastInsertRowid);
  res.status(201).json(serializeDocument(row));
});

app.get('/api/documents/:id/download', async (req, res) => {
  const row = await activeChildRow('project_documents', req.params.id);
  if (!row) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(UPLOADS_DIR, String(row.project_id), row.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/documents/:id', async (req, res) => {
  const row = await activeChildRow('project_documents', req.params.id);
  if (!row) return res.status(404).json({ error: 'Document not found' });
  if (row.change_request_id) { // a change request's attachment is part of what the approvers signed
    const cr = await db.prepare('SELECT approval_status FROM change_requests WHERE id = ?').get(row.change_request_id);
    const problem = cr && crLockedMessage(cr.approval_status);
    if (problem) return res.status(423).json({ error: problem, code: 'DOCUMENT_LOCKED' });
  }
  await softDelete('project_documents', req.params.id, req); // the file stays on disk until permanently deleted
  res.status(204).end();
});

/* =========================================================
   COMPLETION CERTIFICATES (Provisional / Final)
   ========================================================= */
const VALID_CERT_TYPES = ['Provisional', 'Final'];
const VALID_CERT_STATUSES = ['Draft', 'Issued'];

function serializeCertificate(row) {
  return {
    id: row.id, projectId: row.project_id, certificateNumber: row.certificate_number,
    certificateType: row.certificate_type, status: row.status,
    completionDate: row.completion_date, inspectionDate: row.inspection_date,
    defectsLiabilityStart: row.defects_liability_start, defectsLiabilityEnd: row.defects_liability_end,
    contractValue: row.contract_value, finalCost: row.final_cost,
    engineerName: row.engineer_name, engineerTitle: row.engineer_title,
    contractorRepName: row.contractor_rep_name, contractorRepTitle: row.contractor_rep_title,
    clientRepName: row.client_rep_name, clientRepTitle: row.client_rep_title,
    outstandingItems: row.outstanding_items, remarks: row.remarks,
    issuedAt: row.issued_at, approvalStatus: row.approval_status, approvalRound: row.approval_round,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function certificateWriteFields(b, existing) {
  const type = VALID_CERT_TYPES.includes(b.certificateType) ? b.certificateType : (existing?.certificate_type || 'Provisional');
  const status = VALID_CERT_STATUSES.includes(b.status) ? b.status : (existing?.status || 'Draft');
  return {
    certificate_type: type, status,
    completion_date: b.completionDate || null, inspection_date: b.inspectionDate || null,
    defects_liability_start: b.defectsLiabilityStart || null, defects_liability_end: b.defectsLiabilityEnd || null,
    contract_value: omr3(b.contractValue), final_cost: omr3(b.finalCost),
    engineer_name: b.engineerName || null, engineer_title: b.engineerTitle || null,
    contractor_rep_name: b.contractorRepName || null, contractor_rep_title: b.contractorRepTitle || null,
    client_rep_name: b.clientRepName || null, client_rep_title: b.clientRepTitle || null,
    outstanding_items: b.outstandingItems || null, remarks: b.remarks || null,
    issued_at: status === 'Issued' ? (existing?.issued_at || new Date().toISOString()) : (status === 'Draft' ? null : existing?.issued_at || null)
  };
}

async function loadCertificateDetail(id) {
  const row = await activeChildRow('completion_certificates', id);
  if (!row) return null;
  const projectRow = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(row.project_id);
  return { ...serializeCertificate(row), project: projectRow ? await serializeProject(projectRow) : null };
}

app.get('/api/projects/:id/certificates', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM completion_certificates WHERE project_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(req.params.id);
  res.json(rows.map(serializeCertificate));
});

app.post('/api/projects/:id/certificates', async (req, res) => {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const b = req.body;
  if (!VALID_CERT_TYPES.includes(b.certificateType)) return badRequest(res, `certificateType must be one of: ${VALID_CERT_TYPES.join(', ')}`);
  const fields = certificateWriteFields(b, null);
  const newId = await db.transaction(async () => {
    await db.lock('certificate-number');
    const info = await db.prepare(`INSERT INTO completion_certificates
        (project_id, certificate_number, certificate_type, status, completion_date, inspection_date,
         defects_liability_start, defects_liability_end, contract_value, final_cost,
         engineer_name, engineer_title, contractor_rep_name, contractor_rep_title,
         client_rep_name, client_rep_title, outstanding_items, remarks, issued_at)
        VALUES (@project_id, 'PENDING', @certificate_type, @status, @completion_date, @inspection_date,
         @defects_liability_start, @defects_liability_end, @contract_value, @final_cost,
         @engineer_name, @engineer_title, @contractor_rep_name, @contractor_rep_title,
         @client_rep_name, @client_rep_title, @outstanding_items, @remarks, @issued_at)`)
      .run({ project_id: project.id, ...fields });
    const certId = info.lastInsertRowid;
    const prefix = fields.certificate_type === 'Final' ? 'FCC' : 'PCC';
    await db.prepare('UPDATE completion_certificates SET certificate_number = ? WHERE id = ?')
      .run(`${prefix}-${project.code}-${String(await perProjectSeq('completion_certificates', project.id, certId)).padStart(4, '0')}`, certId);
    return certId;
  })();
  res.status(201).json(await loadCertificateDetail(newId));
});

app.get('/api/certificates/:id', async (req, res) => {
  const detail = await loadCertificateDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Certificate not found' });
  res.json(detail);
});

app.put('/api/certificates/:id', async (req, res) => {
  const existing = await activeChildRow('completion_certificates', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });
  const b = req.body;
  if (!VALID_CERT_TYPES.includes(b.certificateType)) return badRequest(res, `certificateType must be one of: ${VALID_CERT_TYPES.join(', ')}`);
  const fields = certificateWriteFields(b, existing);
  await db.prepare(`UPDATE completion_certificates SET
      certificate_type = @certificate_type, status = @status, completion_date = @completion_date, inspection_date = @inspection_date,
      defects_liability_start = @defects_liability_start, defects_liability_end = @defects_liability_end,
      contract_value = @contract_value, final_cost = @final_cost,
      engineer_name = @engineer_name, engineer_title = @engineer_title,
      contractor_rep_name = @contractor_rep_name, contractor_rep_title = @contractor_rep_title,
      client_rep_name = @client_rep_name, client_rep_title = @client_rep_title,
      outstanding_items = @outstanding_items, remarks = @remarks, issued_at = @issued_at,
      updated_at = utc_now_text()
    WHERE id = @id`
  ).run({ id: req.params.id, ...fields });
  res.json(await loadCertificateDetail(req.params.id));
});

app.delete('/api/certificates/:id', async (req, res) => {
  const existing = await activeChildRow('completion_certificates', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });
  await softDelete('completion_certificates', req.params.id, req);
  res.status(204).end();
});

/* =========================================================
   VOWD (VALUE OF WORK DONE) STATEMENTS — accrual / account-closure snapshots,
   distinct from completion certificates. Every lb_/cum_ pair is a raw amount;
   VOWD subtotals, VAT and Net Due are derived here rather than stored.
   ========================================================= */
const VALID_VOWD_STATUSES = ['Draft', 'Issued'];

function vowdTotals(row, prefix) {
  const workDone = row[`${prefix}_work_done`] || 0;
  const variations = row[`${prefix}_variations`] || 0;
  const materials = row[`${prefix}_materials_at_site`] || 0;
  const vowdTotal = workDone + variations + materials;
  const vat = +(vowdTotal * (row.vat_pct || 0) / 100).toFixed(3);
  const advancePaid = row[`${prefix}_advance_paid`] || 0;
  const subtotalA = +(vowdTotal + vat + advancePaid).toFixed(3);
  const advanceRecovered = row[`${prefix}_advance_recovered`] || 0;
  const retentionDeduction = row[`${prefix}_retention_deduction`] || 0;
  const previouslyCertified = row[`${prefix}_previously_certified`] || 0;
  const otherDeductions = row[`${prefix}_other_deductions`] || 0;
  const subtotalB = +(advanceRecovered + retentionDeduction + previouslyCertified + otherDeductions).toFixed(3);
  const netDue = +(subtotalA - subtotalB).toFixed(3);
  return {
    workDone, variations, materials, vowdTotal: +vowdTotal.toFixed(3), vat, advancePaid, subtotalA,
    advanceRecovered, retentionDeduction, previouslyCertified, otherDeductions, subtotalB, netDue
  };
}

async function vowdPcNumber(projectId, id) {
  return 'PC-' + String(await perProjectSeq('vowd_statements', projectId, id)).padStart(2, '0');
}

async function serializeVowd(row) {
  return {
    id: row.id, projectId: row.project_id, vowdNumber: row.vowd_number, pcNumber: await vowdPcNumber(row.project_id, row.id), status: row.status,
    statementDate: row.statement_date, financialYear: row.financial_year, asOfDate: row.as_of_date,
    lastBilledRef: row.last_billed_ref,
    contractNo: row.contract_no, contractorName: row.contractor_name,
    subcontractorId: row.subcontractor_id, subcontractorName: row.subcontractor_name || null,
    subcontractorPoRef: row.subcontractor_po_ref || '',
    projectTitle: row.project_title,
    contractOwner: row.contract_owner, generalManager: row.general_manager, supplyChainManagement: row.supply_chain_management,
    awardedContractValue: row.awarded_contract_value, variationOrderValue: row.variation_order_value,
    revisedContractValue: +(row.awarded_contract_value + row.variation_order_value).toFixed(3),
    approvedVoRef: row.approved_vo_ref, vatPct: row.vat_pct,
    lastBilled: vowdTotals(row, 'lb'),
    cumulative: vowdTotals(row, 'cum'),
    // true when the user overrode the auto "Less: Previously Certified" (Cumulative) figure
    cumPreviouslyCertifiedManual: !!row.cum_previously_certified_manual,
    itemNotes: row.item_notes, retentionRemarks: row.retention_remarks,
    issuedAt: row.issued_at, approvalStatus: row.approval_status, approvalRound: row.approval_round,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

// The "Last Billed & Certified Value" column is never user-entered: it's 0 for a
// project's first VOWD statement, otherwise it's carried forward from the immediately
// preceding statement's Cumulative column — so it's derived here from the DB, not
// trusted from the request body, regardless of what the client sent.
// "Previous" means the previous statement in the SAME chain on this project. The chain is the sub contractor's PO
// reference when the statement has one (matched ignoring case and surrounding spaces — whichever sub contractor it
// names), so every PO has its own running Last Billed & Certified value. A statement with no PO keeps the older
// rule: it chains with the other no-PO statements of the same sub contractor (no sub contractor chain together).
async function vowdPreviousStatement(projectId, beforeId, subcontractorId, poRef) {
  const po = typeof poRef === 'string' ? poRef.trim().toLowerCase() : '';
  const sub = Number(subcontractorId) || null;
  const chain = po
    ? { sql: "AND LOWER(TRIM(COALESCE(subcontractor_po_ref, ''))) = ?", param: po }
    : { sql: "AND TRIM(COALESCE(subcontractor_po_ref, '')) = '' AND subcontractor_id IS NOT DISTINCT FROM ?", param: sub };
  return beforeId
    ? await db.prepare(`SELECT * FROM vowd_statements WHERE project_id = ? AND id < ? AND deleted_at IS NULL ${chain.sql} ORDER BY id DESC LIMIT 1`).get(projectId, beforeId, chain.param)
    : await db.prepare(`SELECT * FROM vowd_statements WHERE project_id = ? AND deleted_at IS NULL ${chain.sql} ORDER BY id DESC LIMIT 1`).get(projectId, chain.param);
}
function vowdLbCarryForward(previous) {
  if (!previous) {
    return { lbWorkDone: 0, lbVariations: 0, lbMaterialsAtSite: 0, lbAdvancePaid: 0, lbAdvanceRecovered: 0, lbRetentionDeduction: 0, lbPreviouslyCertified: 0, lbOtherDeductions: 0 };
  }
  return {
    lbWorkDone: previous.cum_work_done, lbVariations: previous.cum_variations, lbMaterialsAtSite: previous.cum_materials_at_site,
    lbAdvancePaid: previous.cum_advance_paid, lbAdvanceRecovered: previous.cum_advance_recovered,
    lbRetentionDeduction: previous.cum_retention_deduction, lbPreviouslyCertified: previous.cum_previously_certified,
    lbOtherDeductions: previous.cum_other_deductions
  };
}
// "Less: Previously Certified" (Cumulative column) is auto-filled with this same statement's
// own Last Billed column Net Due, so that the Cumulative Net Due works out to only the
// incremental amount due this period. The user may override it (cumPreviouslyCertifiedManual);
// an overridden figure is kept as entered, otherwise it is recalculated on every save.
// Rounded step by step exactly like vowdTotals (VAT to 3 decimals first), so the auto figure
// always equals the Last Billed Net Due shown on screen and in the print.
function vowdLbNetDue(b) {
  const num = (v) => Number(v) || 0;
  const vowdTotal = num(b.lbWorkDone) + num(b.lbVariations) + num(b.lbMaterialsAtSite);
  const vat = +(vowdTotal * (num(b.vatPct) || 0) / 100).toFixed(3);
  const subtotalA = +(vowdTotal + vat + num(b.lbAdvancePaid)).toFixed(3);
  const subtotalB = +(num(b.lbAdvanceRecovered) + num(b.lbRetentionDeduction) + num(b.lbPreviouslyCertified) + num(b.lbOtherDeductions)).toFixed(3);
  return +(subtotalA - subtotalB).toFixed(3);
}

// Cumulative Value of Work Done + Variations may not go above the Revised Contract Value (awarded + variation order).
function vowdActualsProblem(b) {
  const num = v => Number(v) || 0;
  const revised = num(b.awardedContractValue) + num(b.variationOrderValue), cum = num(b.cumWorkDone) + num(b.cumVariations);
  if (revised > 0 && cum > revised + MONEY_EPS) {
    return `Cumulative Value of Work Done + Variations (OMR ${cum.toFixed(3)}) cannot exceed the Revised Contract Value (OMR ${revised.toFixed(3)})`;
  }
  return null;
}
function vowdWriteFields(b, existing, previous) {
  const status = VALID_VOWD_STATUSES.includes(b.status) ? b.status : (existing?.status || 'Draft');
  const num = (v) => Number(v) || 0;
  const lb = vowdLbCarryForward(previous);
  // A body that doesn't mention the override keeps the statement's current setting and value.
  const previouslyCertifiedManual = b.cumPreviouslyCertifiedManual !== undefined
    ? !!b.cumPreviouslyCertifiedManual : !!existing?.cum_previously_certified_manual;
  const cumPreviouslyCertified = !previouslyCertifiedManual
    ? vowdLbNetDue({ ...lb, vatPct: num(b.vatPct) || 5 })
    : (b.cumPreviouslyCertified !== undefined ? num(b.cumPreviouslyCertified) : num(existing?.cum_previously_certified));
  return {
    status,
    statement_date: b.statementDate || null, financial_year: b.financialYear || null, as_of_date: b.asOfDate || null,
    last_billed_ref: previous ? previous.vowd_number : null, // derived with the carried-forward figures, not trusted from the request
    contract_no: b.contractNo || null, contractor_name: b.contractorName || null,
    subcontractor_id: b.subcontractorId || null,
    subcontractor_po_ref: (typeof b.subcontractorPoRef === 'string' && b.subcontractorPoRef.trim().slice(0, 200)) || null,
    project_title: b.projectTitle || null,
    contract_owner: b.contractOwner || null, general_manager: b.generalManager || null, supply_chain_management: b.supplyChainManagement || null,
    awarded_contract_value: num(b.awardedContractValue), variation_order_value: num(b.variationOrderValue),
    approved_vo_ref: b.approvedVoRef || null, vat_pct: num(b.vatPct) || 5,
    lb_work_done: lb.lbWorkDone, lb_variations: lb.lbVariations, lb_materials_at_site: lb.lbMaterialsAtSite,
    lb_advance_paid: lb.lbAdvancePaid, lb_advance_recovered: lb.lbAdvanceRecovered,
    lb_retention_deduction: lb.lbRetentionDeduction, lb_previously_certified: lb.lbPreviouslyCertified,
    lb_other_deductions: lb.lbOtherDeductions,
    cum_work_done: num(b.cumWorkDone), cum_variations: num(b.cumVariations), cum_materials_at_site: num(b.cumMaterialsAtSite),
    cum_advance_paid: num(b.cumAdvancePaid), cum_advance_recovered: num(b.cumAdvanceRecovered),
    cum_retention_deduction: num(b.cumRetentionDeduction),
    cum_previously_certified: cumPreviouslyCertified,
    cum_previously_certified_manual: previouslyCertifiedManual ? 1 : 0,
    cum_other_deductions: num(b.cumOtherDeductions),
    item_notes: b.itemNotes || null, retention_remarks: b.retentionRemarks || null,
    issued_at: status === 'Issued' ? (existing?.issued_at || new Date().toISOString()) : (status === 'Draft' ? null : existing?.issued_at || null)
  };
}

async function loadVowdDetail(id) {
  const row = await db.prepare(`
    SELECT v.*, c.name AS subcontractor_name FROM vowd_statements v
    JOIN projects p ON p.id = v.project_id AND p.deleted_at IS NULL
    LEFT JOIN contractors c ON c.id = v.subcontractor_id
    WHERE v.id = ? AND v.deleted_at IS NULL`).get(id);
  if (!row) return null;
  const projectRow = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(row.project_id);
  return { ...(await serializeVowd(row)), project: projectRow ? await serializeProject(projectRow) : null };
}

app.get('/api/projects/:id/vowd-statements', async (req, res) => {
  const rows = await db.prepare(`
    SELECT v.*, c.name AS subcontractor_name FROM vowd_statements v
    LEFT JOIN contractors c ON c.id = v.subcontractor_id
    WHERE v.project_id = ? AND v.deleted_at IS NULL ORDER BY v.id DESC`).all(req.params.id);
  res.json(await Promise.all(rows.map(serializeVowd)));
});

app.post('/api/projects/:id/vowd-statements', async (req, res) => {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const vowdIssue = vowdActualsProblem(req.body);
  if (vowdIssue) return res.status(400).json({ error: vowdIssue + '.', code: 'ACTUAL_EXCEEDS_PLANNED' });
  const newId = await db.transaction(async () => {
    await db.lock('vowd-number');
    // Read the previous statement inside the lock, so its Cumulative column is carried forward
    // even when two statements for the same project are created at the same moment.
    const previous = await vowdPreviousStatement(project.id, null, req.body.subcontractorId, req.body.subcontractorPoRef);
    const fields = vowdWriteFields(req.body, null, previous);
    const cols = Object.keys(fields);
    const info = await db.prepare(`INSERT INTO vowd_statements
        (project_id, vowd_number, ${cols.join(', ')})
        VALUES (@project_id, 'PENDING', ${cols.map(c => `@${c}`).join(', ')})`)
      .run({ project_id: project.id, ...fields });
    const vowdId = info.lastInsertRowid;
    await db.prepare('UPDATE vowd_statements SET vowd_number = ? WHERE id = ?')
      .run(`VOWD-${project.code}-${String(await perProjectSeq('vowd_statements', project.id, vowdId)).padStart(4, '0')}`, vowdId);
    return vowdId;
  })();
  res.status(201).json(await loadVowdDetail(newId));
});

app.get('/api/vowd-statements/:id', async (req, res) => {
  const detail = await loadVowdDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'VOWD statement not found' });
  res.json(detail);
});

app.put('/api/vowd-statements/:id', async (req, res) => {
  const existing = await activeChildRow('vowd_statements', req.params.id);
  if (!existing) return res.status(404).json({ error: 'VOWD statement not found' });
  const vowdIssue = vowdActualsProblem(req.body);
  if (vowdIssue) return res.status(400).json({ error: vowdIssue + '.', code: 'ACTUAL_EXCEEDS_PLANNED' });
  const previous = await vowdPreviousStatement(existing.project_id, existing.id, req.body.subcontractorId, req.body.subcontractorPoRef);
  const fields = vowdWriteFields(req.body, existing, previous);
  const setClause = Object.keys(fields).map(c => `${c} = @${c}`).join(', ');
  await db.prepare(`UPDATE vowd_statements SET ${setClause}, updated_at = utc_now_text() WHERE id = @id`)
    .run({ id: req.params.id, ...fields });
  res.json(await loadVowdDetail(req.params.id));
});

app.delete('/api/vowd-statements/:id', async (req, res) => {
  const existing = await activeChildRow('vowd_statements', req.params.id);
  if (!existing) return res.status(404).json({ error: 'VOWD statement not found' });
  await softDelete('vowd_statements', req.params.id, req);
  res.status(204).end();
});

/* =========================================================
   CHANGE REQUESTS (per-project change control: Request -> Initial Analysis -> CCB)
   A CR's status is derived from its latest analysis/decision rather than stored, so
   it can never drift out of sync with the actual workflow state.
   ========================================================= */
const VALID_CR_TYPES = ['Scope', 'Schedule', 'Cost', 'Technical / Design', 'Contractual', 'Quality', 'Other'];
const VALID_CR_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const VALID_SCHEDULE_IMPACTS = ['Yes', 'No'];
const VALID_CCB_DECISIONS = ['Approved', 'Rejected', 'Deferred'];
const VALID_CR_SOURCES = ['Client', 'Subcontractor'];

// Returns { crSource, subcontractorId } or an error string. A Subcontractor CR must name
// an existing contractor; a Client CR never carries one.
// On update, a body that omits crSource keeps the existing values rather than resetting them.
async function crSourceFields(b, existing) {
  if (b.crSource === undefined && existing) {
    return { crSource: existing.cr_source || 'Client', subcontractorId: existing.subcontractor_id || null };
  }
  const crSource = b.crSource === undefined ? 'Client' : b.crSource;
  if (!VALID_CR_SOURCES.includes(crSource)) return `crSource must be one of: ${VALID_CR_SOURCES.join(', ')}`;
  if (crSource === 'Client') return { crSource, subcontractorId: null };
  const subcontractorId = Number(b.subcontractorId) || null;
  if (!subcontractorId) return 'Subcontractor is required when CR Type is Subcontractor';
  if (!(await db.prepare('SELECT id FROM contractors WHERE id = ?').get(subcontractorId))) return 'Selected subcontractor was not found';
  return { crSource, subcontractorId };
}

function crStatus(row) {
  if (row.latest_decision) return row.latest_decision;
  if (row.analysis_count > 0) return 'Under Analysis';
  return 'Submitted';
}

function serializeChangeRequest(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    crCode: row.cr_code,
    crType: row.cr_type,
    crSource: row.cr_source || 'Client',
    subcontractorId: row.subcontractor_id || null,
    subcontractorName: row.subcontractor_name || null,
    submitterName: row.submitter_name,
    reviewedByName: row.reviewed_by_name,
    ccbApprovedByName: row.ccb_approved_by_name,
    description: row.description,
    dateSubmitted: row.date_submitted,
    dateRequired: row.date_required,
    priority: row.priority,
    reasonForChange: row.reason_for_change,
    assumptionsNotes: row.assumptions_notes,
    comments: row.comments,
    status: crStatus(row),
    analysisCount: row.analysis_count,
    approvalStatus: row.approval_status,
    approvalRound: row.approval_round,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const CR_SELECT = `
  SELECT cr.*, sc.name AS subcontractor_name,
    (SELECT COUNT(*) FROM change_analyses a WHERE a.change_request_id = cr.id) AS analysis_count,
    (SELECT d.decision FROM change_decisions d WHERE d.change_request_id = cr.id ORDER BY d.decision_date DESC, d.id DESC LIMIT 1) AS latest_decision
  FROM change_requests cr
  LEFT JOIN contractors sc ON sc.id = cr.subcontractor_id
`;

// All projects' change requests, flattened with project name/code — the source data for the
// portfolio-wide Intake / Change Log export (mirrors the /api/events / /api/milestones pattern).
app.get('/api/change-requests', async (req, res) => {
  const rows = await db.prepare(`
    SELECT cr.*, p.name AS project_name, p.code AS project_code, sc.name AS subcontractor_name,
      (SELECT COUNT(*) FROM change_analyses a WHERE a.change_request_id = cr.id) AS analysis_count,
      (SELECT d.decision FROM change_decisions d WHERE d.change_request_id = cr.id ORDER BY d.decision_date DESC, d.id DESC LIMIT 1) AS latest_decision
    FROM change_requests cr
    JOIN projects p ON p.id = cr.project_id AND p.deleted_at IS NULL
    LEFT JOIN contractors sc ON sc.id = cr.subcontractor_id
    WHERE cr.deleted_at IS NULL
    ORDER BY cr.project_id, cr.id DESC
  `).all();
  res.json(rows.map(row => ({ ...serializeChangeRequest(row), projectName: row.project_name, projectCode: row.project_code })));
});

app.get('/api/projects/:id/change-requests', async (req, res) => {
  const rows = await db.prepare(`${CR_SELECT} WHERE cr.project_id = ? AND cr.deleted_at IS NULL ORDER BY cr.id DESC`).all(req.params.id);
  res.json(rows.map(serializeChangeRequest));
});

// Full detail for a single change request (its own analyses + CCB decisions nested in), used
// by the print/PDF view so it can render a complete change-control record in one request.
app.get('/api/change-requests/:id', async (req, res) => {
  const row = await db.prepare(`${CR_SELECT} WHERE cr.id = ? AND cr.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = cr.project_id AND p.deleted_at IS NULL)`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Change request not found' });
  const project = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(row.project_id);
  const analyses = (await db.prepare(`${ANALYSIS_SELECT} WHERE a.change_request_id = ? ORDER BY a.id`).all(row.id)).map(serializeAnalysis);
  const decisions = (await db.prepare(`${DECISION_SELECT} WHERE d.change_request_id = ? ORDER BY d.id`).all(row.id)).map(serializeDecision);
  const projectFull = project ? await serializeProject(project) : null;
  // Contract position "as of" this CR: original Project Brief figures plus every approved CR
  // up to and including this one. With no approved revision, Revised = Original.
  const originalContractValue = project ? (project.contract_value || 0) : 0;
  const originalCompletionDate = project ? project.end_date : null;
  const crCostImpact = +analyses.reduce((s, a) => s + (Number(a.costImpact) || 0), 0).toFixed(3);
  res.json({
    ...serializeChangeRequest(row),
    projectName: project ? project.name : null,
    projectCode: project ? project.code : null,
    businessUnit: projectFull ? projectFull.businessUnit : null,
    businessUnitLogoUrl: projectFull ? projectFull.businessUnitLogoUrl : null,
    contractReference: project ? project.contract_reference : null,
    originalCompletionDate,
    revisedCompletionDate: project ? ((await approvedCrRevisedCompletion(project.id, row.id)) || originalCompletionDate) : null,
    originalContractValue,
    crCostImpact,
    revisedContractValue: project ? +(originalContractValue + await approvedCrCostImpact(project.id, row.id)).toFixed(3) : 0,
    analyses, decisions
  });
});

app.post('/api/projects/:id/change-requests', async (req, res) => {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const b = req.body;
  if (!b.description || !b.description.trim()) return badRequest(res, 'description is required');
  if (!VALID_CR_TYPES.includes(b.crType)) return badRequest(res, `crType must be one of: ${VALID_CR_TYPES.join(', ')}`);
  if (!VALID_CR_PRIORITIES.includes(b.priority)) return badRequest(res, `priority must be one of: ${VALID_CR_PRIORITIES.join(', ')}`);
  const source = await crSourceFields(b);
  if (typeof source === 'string') return badRequest(res, source);
  const newId = await db.transaction(async () => {
    await db.lock('change-request-number');
    const info = await db.prepare(`INSERT INTO change_requests
        (project_id, cr_code, cr_type, cr_source, subcontractor_id, submitter_name, reviewed_by_name, ccb_approved_by_name,
         description, date_submitted, date_required, priority, reason_for_change, assumptions_notes, comments)
        VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(project.id, b.crType, source.crSource, source.subcontractorId, b.submitterName || null, b.reviewedByName || null,
           b.ccbApprovedByName || null, b.description.trim(),
           b.dateSubmitted || isoToday(), b.dateRequired || null,
           b.priority, b.reasonForChange || null, b.assumptionsNotes || null, b.comments || null);
    const crId = info.lastInsertRowid;
    await db.prepare('UPDATE change_requests SET cr_code = ? WHERE id = ?')
      .run(`CR-${project.code}-${String(await perProjectSeq('change_requests', project.id, crId)).padStart(3, '0')}`, crId);
    return crId;
  })();
  res.status(201).json(serializeChangeRequest(await db.prepare(`${CR_SELECT} WHERE cr.id = ?`).get(newId)));
});

app.put('/api/change-requests/:id', async (req, res) => {
  const existing = await activeChildRow('change_requests', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Change request not found' });
  const b = req.body;
  if (!b.description || !b.description.trim()) return badRequest(res, 'description is required');
  if (!VALID_CR_TYPES.includes(b.crType)) return badRequest(res, `crType must be one of: ${VALID_CR_TYPES.join(', ')}`);
  if (!VALID_CR_PRIORITIES.includes(b.priority)) return badRequest(res, `priority must be one of: ${VALID_CR_PRIORITIES.join(', ')}`);
  const source = await crSourceFields(b, existing);
  if (typeof source === 'string') return badRequest(res, source);
  await db.prepare(`UPDATE change_requests SET
      cr_type = ?, cr_source = ?, subcontractor_id = ?, submitter_name = ?, reviewed_by_name = ?, ccb_approved_by_name = ?,
      description = ?, date_submitted = ?, date_required = ?,
      priority = ?, reason_for_change = ?, assumptions_notes = ?, comments = ?, updated_at = utc_now_text()
    WHERE id = ?`)
    .run(b.crType, source.crSource, source.subcontractorId, b.submitterName || null, b.reviewedByName || null, b.ccbApprovedByName || null,
         b.description.trim(), b.dateSubmitted || existing.date_submitted,
         b.dateRequired || null, b.priority, b.reasonForChange || null, b.assumptionsNotes || null,
         b.comments || null, req.params.id);
  res.json(serializeChangeRequest(await db.prepare(`${CR_SELECT} WHERE cr.id = ?`).get(req.params.id)));
});

app.delete('/api/change-requests/:id', async (req, res) => {
  const existing = await activeChildRow('change_requests', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Change request not found' });
  await softDelete('change_requests', req.params.id, req); // its analyses/decisions are hidden with it
  res.status(204).end();
});

/* ---- Initial Analysis (impact assessment against a change request) ---- */
const VALID_ANALYSIS_CATEGORIES = ['Cost', 'Schedule', 'Technical', 'Contractual', 'HSE', 'Environmental', 'Quality', 'Resource', 'Stakeholder', 'Regulatory', 'Other'];

function serializeAnalysis(row) {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    crCode: row.cr_code,
    category: row.category,
    subCategory: row.sub_category,
    durationMonths: row.duration_months || 0,
    durationDays: row.duration_days || 0,
    scheduleImpact: row.schedule_impact,
    costImpact: row.cost_impact,
    comments: row.comments,
    recommendations: row.recommendations,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Months and Days are independent whole numbers (blank = 0). Returns an error string or the pair.
function analysisDurationFields(b) {
  const parse = (v, label) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return `${label} must be a whole number of 0 or more`;
    return n;
  };
  const months = parse(b.durationMonths, 'Number of Months');
  if (typeof months === 'string') return months;
  const days = parse(b.durationDays, 'Number of Days');
  if (typeof days === 'string') return days;
  return { months, days };
}

const ANALYSIS_SELECT = `
  SELECT a.*, cr.cr_code, cr.project_id
  FROM change_analyses a
  JOIN change_requests cr ON cr.id = a.change_request_id AND cr.deleted_at IS NULL
`;

app.get('/api/projects/:id/change-analyses', async (req, res) => {
  const rows = await db.prepare(`${ANALYSIS_SELECT} WHERE cr.project_id = ? ORDER BY a.id DESC`).all(req.params.id);
  res.json(rows.map(serializeAnalysis));
});

app.post('/api/change-requests/:id/analyses', async (req, res) => {
  const cr = await activeChildRow('change_requests', req.params.id);
  if (!cr) return res.status(404).json({ error: 'Change request not found' });
  const b = req.body;
  if (!VALID_ANALYSIS_CATEGORIES.includes(b.category)) return badRequest(res, `category must be one of: ${VALID_ANALYSIS_CATEGORIES.join(', ')}`);
  if (!VALID_SCHEDULE_IMPACTS.includes(b.scheduleImpact)) return badRequest(res, `scheduleImpact must be one of: ${VALID_SCHEDULE_IMPACTS.join(', ')}`);
  const duration = analysisDurationFields(b);
  if (typeof duration === 'string') return badRequest(res, duration);
  const info = await db.prepare(`INSERT INTO change_analyses
      (change_request_id, category, sub_category, duration_months, duration_days, schedule_impact, cost_impact, comments, recommendations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(cr.id, b.category, b.subCategory || null, duration.months, duration.days,
         b.scheduleImpact, omr3(b.costImpact), b.comments || null, b.recommendations || null);
  res.status(201).json(serializeAnalysis(await db.prepare(`${ANALYSIS_SELECT} WHERE a.id = ?`).get(info.lastInsertRowid)));
});

app.put('/api/change-analyses/:id', async (req, res) => {
  const existing = await activeCrChildRow('change_analyses', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Analysis not found' });
  const b = req.body;
  if (!VALID_ANALYSIS_CATEGORIES.includes(b.category)) return badRequest(res, `category must be one of: ${VALID_ANALYSIS_CATEGORIES.join(', ')}`);
  if (!VALID_SCHEDULE_IMPACTS.includes(b.scheduleImpact)) return badRequest(res, `scheduleImpact must be one of: ${VALID_SCHEDULE_IMPACTS.join(', ')}`);
  const duration = analysisDurationFields(b);
  if (typeof duration === 'string') return badRequest(res, duration);
  await db.prepare(`UPDATE change_analyses SET
      category = ?, sub_category = ?, duration_months = ?, duration_days = ?, schedule_impact = ?,
      cost_impact = ?, comments = ?, recommendations = ?, updated_at = utc_now_text()
    WHERE id = ?`)
    .run(b.category, b.subCategory || null, duration.months, duration.days,
         b.scheduleImpact, omr3(b.costImpact), b.comments || null, b.recommendations || null, req.params.id);
  res.json(serializeAnalysis(await db.prepare(`${ANALYSIS_SELECT} WHERE a.id = ?`).get(req.params.id)));
});

app.delete('/api/change-analyses/:id', async (req, res) => {
  const existing = await activeCrChildRow('change_analyses', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Analysis not found' });
  await db.prepare('DELETE FROM change_analyses WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* ---- Change Control Board decisions ---- */
function serializeDecision(row) {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    crCode: row.cr_code,
    decision: row.decision,
    decisionDate: row.decision_date,
    decisionExplanation: row.decision_explanation,
    revisedCompletionDate: row.revised_completion_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const DECISION_SELECT = `
  SELECT d.*, cr.cr_code, cr.project_id
  FROM change_decisions d
  JOIN change_requests cr ON cr.id = d.change_request_id AND cr.deleted_at IS NULL
`;

app.get('/api/projects/:id/change-decisions', async (req, res) => {
  const rows = await db.prepare(`${DECISION_SELECT} WHERE cr.project_id = ? ORDER BY d.id DESC`).all(req.params.id);
  res.json(rows.map(serializeDecision));
});

app.post('/api/change-requests/:id/decisions', async (req, res) => {
  const cr = await activeChildRow('change_requests', req.params.id);
  if (!cr) return res.status(404).json({ error: 'Change request not found' });
  const b = req.body;
  if (!VALID_CCB_DECISIONS.includes(b.decision)) return badRequest(res, `decision must be one of: ${VALID_CCB_DECISIONS.join(', ')}`);
  const info = await db.prepare(`INSERT INTO change_decisions
      (change_request_id, decision, decision_date, decision_explanation, revised_completion_date)
      VALUES (?, ?, ?, ?, ?)`)
    .run(cr.id, b.decision, b.decisionDate || isoToday(), b.decisionExplanation || null, b.revisedCompletionDate || null);
  res.status(201).json(serializeDecision(await db.prepare(`${DECISION_SELECT} WHERE d.id = ?`).get(info.lastInsertRowid)));
});

app.put('/api/change-decisions/:id', async (req, res) => {
  const existing = await activeCrChildRow('change_decisions', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Decision not found' });
  const b = req.body;
  if (!VALID_CCB_DECISIONS.includes(b.decision)) return badRequest(res, `decision must be one of: ${VALID_CCB_DECISIONS.join(', ')}`);
  await db.prepare(`UPDATE change_decisions SET decision = ?, decision_date = ?, decision_explanation = ?, revised_completion_date = ?, updated_at = utc_now_text() WHERE id = ?`)
    .run(b.decision, b.decisionDate || existing.decision_date, b.decisionExplanation || null, b.revisedCompletionDate || null, req.params.id);
  res.json(serializeDecision(await db.prepare(`${DECISION_SELECT} WHERE d.id = ?`).get(req.params.id)));
});

app.delete('/api/change-decisions/:id', async (req, res) => {
  const existing = await activeCrChildRow('change_decisions', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Decision not found' });
  await db.prepare('DELETE FROM change_decisions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

/* =========================================================
   PROJECT RESOURCES: Members (assigned from the team directory), External Parties
   (non-company stakeholders), and Groups that organize both for visibility/reporting.
   ========================================================= */
const VALID_EXTERNAL_ROLES = ['Client Representative', 'Consultant', 'Regulator', 'Auditor', 'Supplier Contact', 'Other'];

function serializeProjectMember(row) {
  return {
    id: row.id, projectId: row.project_id, teamMemberId: row.team_member_id,
    name: row.name, department: row.department, designation: row.designation,
    email: row.email, accessLevel: row.access_level,
    tasksAssigned: row.tasks_assigned, addedAt: row.added_at
  };
}
const PROJECT_MEMBER_SELECT = `
  SELECT pm.*, tm.name, tm.department, tm.designation, tm.email, tm.access_level,
    (SELECT COUNT(*) FROM project_events e WHERE e.project_id = pm.project_id AND e.assigned_to = tm.name) AS tasks_assigned
  FROM project_members pm
  JOIN team_members tm ON tm.id = pm.team_member_id
`;

app.get('/api/projects/:id/members', async (req, res) => {
  const rows = await db.prepare(`${PROJECT_MEMBER_SELECT} WHERE pm.project_id = ? ORDER BY tm.name, pm.id`).all(req.params.id);
  res.json(rows.map(serializeProjectMember));
});

app.post('/api/projects/:id/members', async (req, res) => {
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const teamMemberId = req.body.teamMemberId;
  if (!teamMemberId) return badRequest(res, 'teamMemberId is required');
  const tm = await db.prepare('SELECT id FROM team_members WHERE id = ?').get(teamMemberId);
  if (!tm) return badRequest(res, 'Unknown team member');
  try {
    const info = await db.prepare('INSERT INTO project_members (project_id, team_member_id) VALUES (?, ?)').run(req.params.id, teamMemberId);
    res.status(201).json(serializeProjectMember(await db.prepare(`${PROJECT_MEMBER_SELECT} WHERE pm.id = ?`).get(info.lastInsertRowid)));
  } catch (e) {
    if (isUniqueConstraintError(e)) return res.status(409).json({ error: 'This person is already a member of the project' });
    throw e;
  }
});

app.delete('/api/project-members/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM project_members WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project member not found' });
  await db.prepare('DELETE FROM project_members WHERE id = ?').run(req.params.id);
  // member_id on group entries is a polymorphic reference (see schema.sql), not a real FK,
  // so it isn't cleaned up by ON DELETE CASCADE — drop any group memberships by hand.
  await db.prepare(`DELETE FROM project_resource_group_entries WHERE member_type = 'member' AND member_id = ?`).run(req.params.id);
  res.status(204).end();
});

function serializeExternalParty(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, organization: row.organization,
    role: row.role, email: row.email, phone: row.phone, notes: row.notes, createdAt: row.created_at
  };
}
const externalPartyWriteFields = (b) => ({
  name: String(b.name).trim(),
  organization: b.organization ? String(b.organization).trim() : null,
  role: pickEnum(b.role, VALID_EXTERNAL_ROLES, VALID_EXTERNAL_ROLES[0]),
  email: b.email ? String(b.email).trim() : null,
  phone: b.phone ? String(b.phone).trim() : null,
  notes: b.notes ? String(b.notes).trim() : null
});

app.get('/api/projects/:id/external-parties', async (req, res) => {
  res.json((await db.prepare('SELECT * FROM project_external_parties WHERE project_id = ? ORDER BY id').all(req.params.id)).map(serializeExternalParty));
});

app.post('/api/projects/:id/external-parties', async (req, res) => {
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.body.name || !String(req.body.name).trim()) return badRequest(res, 'name is required');
  const info = await db.prepare(`INSERT INTO project_external_parties (project_id, name, organization, role, email, phone, notes)
    VALUES (@project_id, @name, @organization, @role, @email, @phone, @notes)`)
    .run({ project_id: req.params.id, ...externalPartyWriteFields(req.body) });
  res.status(201).json(serializeExternalParty(await db.prepare('SELECT * FROM project_external_parties WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/external-parties/:id', async (req, res) => {
  const existing = await db.prepare('SELECT * FROM project_external_parties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'External party not found' });
  if (!req.body.name || !String(req.body.name).trim()) return badRequest(res, 'name is required');
  await db.prepare(`UPDATE project_external_parties SET name=@name, organization=@organization, role=@role, email=@email, phone=@phone, notes=@notes WHERE id=@id`)
    .run({ id: req.params.id, ...externalPartyWriteFields(req.body) });
  res.json(serializeExternalParty(await db.prepare('SELECT * FROM project_external_parties WHERE id = ?').get(req.params.id)));
});

app.delete('/api/external-parties/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM project_external_parties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'External party not found' });
  await db.prepare('DELETE FROM project_external_parties WHERE id = ?').run(req.params.id);
  await db.prepare(`DELETE FROM project_resource_group_entries WHERE member_type = 'external' AND member_id = ?`).run(req.params.id);
  res.status(204).end();
});

function serializeGroup(row, entries) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, description: row.description,
    entries: entries.map(e => ({ id: e.id, type: e.member_type, refId: e.member_id, name: e.display_name }))
  };
}
const RESOURCE_GROUP_ENTRY_SELECT = `
  SELECT e.id, e.member_type,
    CASE WHEN e.member_type = 'member' THEN pm.id ELSE ep.id END AS member_id,
    CASE WHEN e.member_type = 'member' THEN tm.name ELSE ep.name END AS display_name
  FROM project_resource_group_entries e
  LEFT JOIN project_members pm ON e.member_type = 'member' AND pm.id = e.member_id
  LEFT JOIN team_members tm ON tm.id = pm.team_member_id
  LEFT JOIN project_external_parties ep ON e.member_type = 'external' AND ep.id = e.member_id
  WHERE e.group_id = ?
  ORDER BY display_name, e.id
`;
async function loadResourceGroup(groupId) {
  const row = await db.prepare('SELECT * FROM project_resource_groups WHERE id = ?').get(groupId);
  if (!row) return null;
  return serializeGroup(row, await db.prepare(RESOURCE_GROUP_ENTRY_SELECT).all(groupId));
}
async function writeGroupEntries(groupId, entries) {
  await db.prepare('DELETE FROM project_resource_group_entries WHERE group_id = ?').run(groupId);
  const insertEntry = db.prepare('INSERT INTO project_resource_group_entries (group_id, member_type, member_id) VALUES (?, ?, ?)');
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && (e.type === 'member' || e.type === 'external') && e.refId) await insertEntry.run(groupId, e.type, e.refId);
  }
}

app.get('/api/projects/:id/resource-groups', async (req, res) => {
  const groups = await db.prepare('SELECT * FROM project_resource_groups WHERE project_id = ? ORDER BY id').all(req.params.id);
  res.json(await Promise.all(groups.map(async g => serializeGroup(g, await db.prepare(RESOURCE_GROUP_ENTRY_SELECT).all(g.id)))));
});

app.post('/api/projects/:id/resource-groups', async (req, res) => {
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.body.name || !String(req.body.name).trim()) return badRequest(res, 'name is required');
  const runInsert = db.transaction(async () => {
    const info = await db.prepare('INSERT INTO project_resource_groups (project_id, name, description) VALUES (?, ?, ?)')
      .run(req.params.id, String(req.body.name).trim(), req.body.description ? String(req.body.description).trim() : null);
    await writeGroupEntries(info.lastInsertRowid, req.body.entries);
    return info.lastInsertRowid;
  });
  res.status(201).json(await loadResourceGroup(await runInsert()));
});

app.put('/api/resource-groups/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM project_resource_groups WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Group not found' });
  if (!req.body.name || !String(req.body.name).trim()) return badRequest(res, 'name is required');
  const runUpdate = db.transaction(async () => {
    await db.prepare('UPDATE project_resource_groups SET name = ?, description = ? WHERE id = ?')
      .run(String(req.body.name).trim(), req.body.description ? String(req.body.description).trim() : null, req.params.id);
    await writeGroupEntries(req.params.id, req.body.entries);
  });
  await runUpdate();
  res.json(await loadResourceGroup(req.params.id));
});

app.delete('/api/resource-groups/:id', async (req, res) => {
  const existing = await db.prepare('SELECT id FROM project_resource_groups WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Group not found' });
  await db.prepare('DELETE FROM project_resource_groups WHERE id = ?').run(req.params.id); // entries cascade via FK
  res.status(204).end();
});

/* =========================================================
   PROGRAMME TREND (read-only, seeded once for the trend charts)
   ========================================================= */
function listTrend() {
  return db.prepare('SELECT month, planned, actual, spend FROM programme_trend ORDER BY seq').all();
}
app.get('/api/trend', async (req, res) => {
  res.json(await listTrend());
});

/* =========================================================
   RECYCLE BIN — soft-deleted projects and project documents
   Everything can be restored. Only Projects and Documents can be permanently deleted:
   invoices, certificates, VOWDs and CRs are numbered per project from a row count, so purging
   one on its own would let its number be issued again (and they are financial/contractual
   records worth keeping). Permanently deleting their project removes them with it.
   ========================================================= */
const BIN_TYPES = {
  project:       { table: 'projects',                label: 'Project',                purgeable: true },
  changeRequest: { table: 'change_requests',         label: 'Change Request' },
  invoice:       { table: 'invoices',                label: 'Invoice' },
  certificate:   { table: 'completion_certificates', label: 'Completion Certificate' },
  vowd:          { table: 'vowd_statements',         label: 'VOWD Statement' },
  document:      { table: 'project_documents',       label: 'Document',               purgeable: true }
};

// Items inside a deleted project aren't listed separately — they come back with the project.
app.get('/api/recycle-bin', async (req, res) => {
  const child = (type, table, ref, title) => `
    SELECT '${type}' AS type, t.id, ${ref} AS ref, ${title} AS title, p.id AS project_id, p.code AS project_code,
           p.name AS project_name, t.deleted_at, t.deleted_by
    FROM ${table} t JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    WHERE t.deleted_at IS NOT NULL`;
  const rows = await db.prepare(`
    SELECT 'project' AS type, p.id, p.code AS ref, p.name AS title, p.id AS project_id, p.code AS project_code,
           p.name AS project_name, p.deleted_at, p.deleted_by
    FROM projects p WHERE p.deleted_at IS NOT NULL
    UNION ALL ${child('changeRequest', 'change_requests', 't.cr_code', 't.description')}
    UNION ALL ${child('invoice', 'invoices', 't.invoice_number', 't.bill_to_name')}
    UNION ALL ${child('certificate', 'completion_certificates', 't.certificate_number', "t.certificate_type || ' completion certificate'")}
    UNION ALL ${child('vowd', 'vowd_statements', 't.vowd_number', 't.project_title')}
    UNION ALL ${child('document', 'project_documents', 't.title', 't.original_filename')}
    ORDER BY deleted_at DESC, id DESC`).all();
  res.json(rows.map(r => ({
    type: r.type, typeLabel: BIN_TYPES[r.type].label, id: r.id, ref: r.ref, title: r.title,
    projectId: r.project_id, projectCode: r.project_code, projectName: r.project_name,
    deletedAt: r.deleted_at, deletedBy: r.deleted_by, canPurge: !!BIN_TYPES[r.type].purgeable
  })));
});

async function binnedRow(req, res) {
  const def = BIN_TYPES[req.params.type];
  if (!def) { res.status(404).json({ error: 'Unknown item type' }); return null; }
  const row = await db.prepare(`SELECT * FROM ${def.table} WHERE id = ? AND deleted_at IS NOT NULL`).get(req.params.id);
  if (!row) { res.status(404).json({ error: `${def.label} not found in the Recycle Bin` }); return null; }
  return { def, row };
}

app.post('/api/recycle-bin/:type/:id/restore', async (req, res) => {
  const found = await binnedRow(req, res);
  if (!found) return;
  const { def, row } = found;
  if (def.table !== 'projects') {
    const project = await db.prepare('SELECT deleted_at FROM projects WHERE id = ?').get(row.project_id);
    if (project && project.deleted_at) return res.status(409).json({ error: 'Its project is in the Recycle Bin — restore the project instead' });
  }
  await db.prepare(`UPDATE ${def.table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

app.delete('/api/recycle-bin/:type/:id', async (req, res) => {
  const def = BIN_TYPES[req.params.type];
  if (def && !def.purgeable) {
    return res.status(400).json({ error: `${def.label}s are numbered records kept for audit — restore it, or permanently delete its project to remove it` });
  }
  const found = await binnedRow(req, res);
  if (!found) return;
  const { row } = found;
  if (def.table === 'projects') {
    await db.prepare('DELETE FROM document_approval_steps WHERE project_id = ?').run(row.id); // no FK: polymorphic
    await db.prepare('DELETE FROM projects WHERE id = ?').run(row.id); // cascades to everything under it
    fs.rmSync(path.join(UPLOADS_DIR, String(row.id)), { recursive: true, force: true });
  } else {
    await db.prepare('DELETE FROM project_documents WHERE id = ?').run(row.id);
    fs.unlink(path.join(UPLOADS_DIR, String(row.project_id), row.stored_filename), () => {});
  }
  res.status(204).end();
});

/* ---- Audit log viewer (read-only — nothing in the app can edit or delete entries) ---- */
const AUDIT_TS = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/; // UTC, same text format as occurred_at
app.get('/api/audit-log', async (req, res) => {
  const where = [], params = [];
  const add = (sql, ...vals) => { where.push(sql); params.push(...vals); };
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    add('(a.username ILIKE ? OR a.entity_label ILIKE ? OR a.entity_type ILIKE ? OR p.code ILIKE ? OR p.name ILIKE ? OR a.ip_address ILIKE ?)',
      like, like, like, like, like, like);
  }
  if (req.query.action) add('a.action = ?', String(req.query.action));
  if (req.query.user) add('a.username = ?', String(req.query.user));
  if (req.query.entity) add('a.entity_type = ?', String(req.query.entity));
  if (req.query.projectId) add('a.project_id = ?', Number(req.query.projectId) || 0);
  if (AUDIT_TS.test(req.query.from || '')) add('a.occurred_at >= ?', req.query.from);
  if (AUDIT_TS.test(req.query.to || '')) add('a.occurred_at < ?', req.query.to);
  if (req.query.beforeId) add('a.id < ?', Number(req.query.beforeId) || 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = await db.prepare(`
    SELECT a.*, p.code AS project_code, p.name AS project_name
    FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT ${limit + 1}`).all(...params);
  res.json({
    hasMore: rows.length > limit,
    entries: rows.slice(0, limit).map(r => ({
      id: r.id, occurredAt: r.occurred_at, username: r.username, ipAddress: r.ip_address, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, entityLabel: r.entity_label,
      projectId: r.project_id, projectCode: r.project_code, projectName: r.project_name,
      method: r.method, path: r.path, details: r.details ? JSON.parse(r.details) : null
    }))
  });
});
app.get('/api/audit-log/facets', async (req, res) => {
  res.json({
    users: (await db.prepare('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY username').all()).map(r => r.username),
    entities: (await db.prepare('SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type').all()).map(r => r.entity_type)
  });
});

// Everything the dashboard needs on startup, in ONE request read over ONE pooled connection
// (and one consistent snapshot), instead of 11 parallel requests each grabbing its own
// connection — that burst is what intermittently failed right after login, and a single one
// of the 11 failing used to leave the whole dashboard empty. Read-only, so it is safe to retry
// as a whole if the connection drops part-way.
const loadBootstrap = db.transaction(async () => ({
  governorates: await listMaster('governorates'),
  projectTypes: await listMaster('project_types'),
  contractors: await listMaster('contractors'),
  teamMembers: await listTeamMembers(),
  businessUnits: await listMaster('business_units'),
  projects: await listProjects(),
  risks: await listRisks(),
  issues: await listIssues(),
  milestones: await listMilestones(),
  trend: await listTrend(),
  events: await listEvents()
}));
// ?projectIds=1,2 — just those projects' rows (projects, risks, issues, milestones, events), for
// the dashboard's refresh after a save: the client swaps them into what it already holds instead
// of re-downloading the whole programme. A project that no longer exists (deleted) simply comes
// back with no rows, which removes it on the client.
const MAX_SCOPED_PROJECTS = 200;
const loadProjectScoped = db.transaction(async projectIds => ({
  projectIds,
  projects: await listProjects(projectIds),
  risks: await listRisks(null, projectIds),
  issues: await listIssues(null, projectIds),
  milestones: await listMilestones(null, projectIds),
  events: await listEvents(projectIds)
}));
app.get('/api/bootstrap', async (req, res) => {
  let projectIds = null;
  if (req.query.projectIds !== undefined) {
    projectIds = [...new Set(String(req.query.projectIds).split(',').filter(Boolean).map(Number))];
    if (!projectIds.length || projectIds.length > MAX_SCOPED_PROJECTS || !projectIds.every(id => Number.isInteger(id) && id > 0 && id <= 2147483647)) {
      return badRequest(res, `projectIds must be 1–${MAX_SCOPED_PROJECTS} comma-separated project ids`);
    }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return res.json(projectIds ? await loadProjectScoped(projectIds) : await loadBootstrap());
    } catch (err) {
      if (attempt >= 3 || !db.isTransientError(err)) throw err;
      console.warn(new Date().toISOString(), `bootstrap: transient DB error (${err.code || err.message}), retry ${attempt}/2`);
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
});

/* =========================================================
   SUBCONTRACTOR PERFORMANCE
   The server only gathers the facts (what the data says happened); every score is worked out by public/subcontractor-perf.js,
   the same file the dashboard page and the printable scorecard use, so the three can never disagree.
   A subcontractor is linked to an event through the Crew / Labour lines of that event (their Contractor column), to a
   contract through the project's Sub Contractors list, its Crew lines, its VOWD statements and its Subcontractor change requests.
   ========================================================= */
const SubPerf = require('./public/subcontractor-perf.js');
const omanToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10); // the programme runs on Oman time (UTC+4)

// Which projects this request may read: the administrator reads all (or the `projects` the page asks for); anyone else
// only the projects granted to them, further narrowed by the `projects` the page asks for. Also reports whether the
// person may see VOWD values and change requests, since the facts quote both.
function subPerfScope(req) {
  let asked = null;
  if (req.query.projects !== undefined && String(req.query.projects) !== '') {
    asked = [...new Set(String(req.query.projects).split(',').filter(Boolean).map(Number))].filter(id => Number.isInteger(id) && id > 0 && id <= 2147483647);
    if (asked.length > 5000) asked = asked.slice(0, 5000);
  }
  const u = sessionUser(req);
  if (u && !u.isAdmin) {
    const granted = new Set(u.projectIds || []);
    const ids = (asked || [...granted]).filter(id => granted.has(id));
    const can = r => ((u.permissions || {})[r] || []).includes('view');
    return { projectIds: ids, vowd: can('vowd'), changes: can('change_requests') };
  }
  return { projectIds: asked, vowd: true, changes: true };
}

async function loadSubcontractorFacts(scope) {
  const sc = col => projectScope(col, scope.projectIds);
  const q = (sql, s) => db.prepare(sql).all(...s.params);
  const projects = await q(`SELECT p.id, p.code, p.name, p.status FROM projects p WHERE p.deleted_at IS NULL${sc('p.id').sql} ORDER BY p.id`, sc('p.id'));
  const live = new Set(projects.map(p => p.id));
  const [crews, eventRows, listed, vowds, crs, masters] = await Promise.all([
    q(`SELECT pc.project_id, pc.event_id, pc.contractor_id, pc.quantity, pc.actual_qty, pc.rate_basis, pc.unit_rate, pc.allocated_days
       FROM project_crews pc WHERE pc.contractor_id IS NOT NULL${sc('pc.project_id').sql}`, sc('pc.project_id')),
    q(`SELECT e.id, e.project_id, e.seq_no, e.stage, e.event_name, e.planned_start, e.planned_end, e.actual_start, e.actual_end, e.status, e.progress_pct
       FROM project_events e WHERE TRUE${sc('e.project_id').sql}`, sc('e.project_id')),
    q(`SELECT ps.project_id, ps.contractor_id FROM project_subcontractors ps WHERE TRUE${sc('ps.project_id').sql}`, sc('ps.project_id')),
    scope.vowd ? q(`SELECT DISTINCT ON (v.project_id, v.subcontractor_id) v.project_id, v.subcontractor_id AS contractor_id, v.awarded_contract_value, v.vowd_number
       FROM vowd_statements v WHERE v.deleted_at IS NULL AND v.subcontractor_id IS NOT NULL${sc('v.project_id').sql}
       ORDER BY v.project_id, v.subcontractor_id, v.id DESC`, sc('v.project_id')) : [],
    scope.changes ? q(`SELECT cr.id, cr.project_id, cr.subcontractor_id AS contractor_id, cr.cr_code, cr.cr_type, cr.description, cr.date_submitted,
         (SELECT COUNT(*) FROM change_analyses a WHERE a.change_request_id = cr.id) AS analysis_count,
         (SELECT d.decision FROM change_decisions d WHERE d.change_request_id = cr.id ORDER BY d.decision_date DESC, d.id DESC LIMIT 1) AS decision,
         (SELECT d.decision_date FROM change_decisions d WHERE d.change_request_id = cr.id ORDER BY d.decision_date DESC, d.id DESC LIMIT 1) AS decision_date,
         (SELECT COALESCE(SUM(a.cost_impact), 0) FROM change_analyses a WHERE a.change_request_id = cr.id) AS cost_impact
       FROM change_requests cr WHERE cr.deleted_at IS NULL AND cr.cr_source = 'Subcontractor' AND cr.subcontractor_id IS NOT NULL${sc('cr.project_id').sql}
       ORDER BY cr.project_id, cr.id`, sc('cr.project_id')) : [],
    db.prepare('SELECT id, name FROM contractors ORDER BY name').all()
  ]);

  const eventById = new Map(eventRows.filter(e => live.has(e.project_id)).map(e => [e.id, e]));
  const contracts = new Map();
  const contractOf = (projectId, contractorId) => {
    const k = projectId + ':' + contractorId;
    if (!contracts.has(k)) contracts.set(k, { projectId, contractorId, plannedValue: 0, actualValue: 0, awarded: null, vowdNumber: null, listed: false });
    return contracts.get(k);
  };
  const events = new Map();
  crews.forEach(c => {
    if (!live.has(c.project_id)) return;
    const k = contractOf(c.project_id, c.contractor_id);
    const planned = crewLineCost(c.quantity, c.rate_basis, c.unit_rate, c.allocated_days);
    k.plannedValue += planned;
    k.actualValue += crewLineCost(c.actual_qty, c.rate_basis, c.unit_rate, c.allocated_days);
    const e = c.event_id != null ? eventById.get(c.event_id) : null;
    if (!e) return;
    const ek = e.id + ':' + c.contractor_id;
    if (!events.has(ek)) {
      events.set(ek, { projectId: e.project_id, eventId: e.id, seqNo: e.seq_no, contractorId: c.contractor_id, name: e.event_name, stage: e.stage,
        plannedStart: e.planned_start, plannedEnd: e.planned_end, actualStart: e.actual_start, actualEnd: e.actual_end,
        status: e.status, progress: e.progress_pct, plannedValue: 0 });
    }
    events.get(ek).plannedValue += planned;
  });
  listed.forEach(l => { if (live.has(l.project_id)) contractOf(l.project_id, l.contractor_id).listed = true; });
  vowds.forEach(v => {
    if (!live.has(v.project_id)) return;
    const k = contractOf(v.project_id, v.contractor_id);
    k.awarded = v.awarded_contract_value > 0 ? v.awarded_contract_value : null;
    k.vowdNumber = v.vowd_number;
  });
  const changes = crs.filter(c => live.has(c.project_id)).map(c => {
    contractOf(c.project_id, c.contractor_id);
    return { id: c.id, projectId: c.project_id, contractorId: c.contractor_id, crCode: c.cr_code, crType: c.cr_type, description: c.description,
      dateSubmitted: c.date_submitted, analysed: c.analysis_count > 0, decision: c.decision || null, decisionDate: c.decision_date || null,
      costImpact: Number(c.cost_impact) || 0 };
  });
  const round3 = v => +(v || 0).toFixed(3);
  const contractList = [...contracts.values()].map(k => ({ ...k, plannedValue: round3(k.plannedValue), actualValue: round3(k.actualValue) }));
  const used = new Set(contractList.map(k => k.contractorId));
  return {
    asOf: omanToday(),
    projects,
    contractors: masters.filter(m => used.has(m.id)),
    contracts: contractList,
    events: [...events.values()].map(e => ({ ...e, plannedValue: round3(e.plannedValue) })),
    changes,
    withheld: { vowd: !scope.vowd, changes: !scope.changes }
  };
}

app.get('/api/subcontractor-performance', async (req, res) => {
  res.json(await loadSubcontractorFacts(subPerfScope(req)));
});

// Excel benchmarking export — scorecard, deliverable compliance, variations and contracts, plus how the score is worked out.
app.get('/api/subcontractor-performance/export', async (req, res) => {
  const scope = subPerfScope(req);
  const facts = await loadSubcontractorFacts(scope);
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOf || '')) ? String(req.query.asOf) : facts.asOf;
  const period = SubPerf.PERIODS.some(p => p.key === req.query.period) ? req.query.period : 'all';
  const from = SubPerf.periodFrom(period, asOf);
  const results = SubPerf.compute(facts, { asOf, from, projectIds: scope.projectIds ? new Set(scope.projectIds) : null });
  const port = SubPerf.portfolio(results);
  const periodLabel = SubPerf.PERIODS.find(p => p.key === period).label;
  const dmy = iso => (iso ? iso.split('-').reverse().join('/') : '');
  const NAVY = 'FF1E355E', RAG_FILL = { green: 'FFE7F4EC', amber: 'FFFBF2DF', red: 'FFFBEAEA', none: 'FFEEF1F2' }, RAG_FONT = { green: 'FF2E8B57', amber: 'FFB77A0B', red: 'FFC94C4C', none: 'FF5B6E77' };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Water Rehabilitation Dashboard';
  wb.created = new Date();

  const sheet = (name, title, headers, widths, rows, opts = {}) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.getCell('A1').value = title;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
    ws.getCell('A2').value = `As of ${dmy(asOf)} · period: ${periodLabel}${from ? ' (from ' + dmy(from) + ')' : ''} · all amounts in OMR`;
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5B6E77' } };
    headers.forEach((h, i) => {
      const c = ws.getCell(4, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      ws.getColumn(i + 1).width = widths[i];
    });
    ws.getRow(4).height = 30;
    rows.forEach(r => ws.addRow(r));
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
    (opts.money || []).forEach(ci => ws.getColumn(ci).numFmt = '#,##0.000');
    (opts.pct || []).forEach(ci => ws.getColumn(ci).numFmt = '0.0');
    return ws;
  };

  const NA = 'not measured';
  const ws1 = sheet('Scorecard', 'Subcontractor performance scorecard',
    ['Rank', 'Subcontractor', 'Projects', 'Active contracts', 'Contract value', 'Events due', 'On time', 'Late', 'Overdue', 'On-time delivery %',
     'Variation requests', 'Variation growth %', 'Cost adherence', 'Quality', 'HSE', 'Responsiveness', 'Overall score', 'Rating', 'KPIs in score'],
    [7, 34, 10, 11, 16, 10, 9, 8, 9, 13, 11, 12, 13, 13, 13, 15, 12, 15, 18],
    results.map(r => [r.rank || '', r.name, r.projectCount, r.activeContracts, +r.contractValue.toFixed(3), r.delivery.due, r.delivery.ontime, r.delivery.late, r.delivery.overdue,
      r.delivery.score ?? NA, r.cost ? r.cost.requests : '', r.cost ? r.cost.growthPct : '', r.cost ? r.cost.score : NA, NA, NA, NA,
      r.overall ?? NA, r.partial ? 'Not enough data' : SubPerf.RAG_LABEL[r.rag], r.kpisUsed.map(k => SubPerf.KPIS.find(x => x.key === k).short).join(' + ') || '—']),
    { money: [5], pct: [10, 12, 13, 17] });
  ws1.eachRow((row, n) => {
    if (n < 5) return;
    const r = results[n - 5];
    if (!r) return;
    [17, 18].forEach(ci => { const c = row.getCell(ci); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RAG_FILL[r.rag] } }; c.font = { bold: true, color: { argb: RAG_FONT[r.rag] } }; });
    [14, 15, 16].forEach(ci => { row.getCell(ci).font = { italic: true, color: { argb: 'FF8A97A0' } }; });
  });
  const pr = ws1.rowCount + 2;
  ws1.getCell(pr, 2).value = 'Programme (all subcontractors above)';
  ws1.getCell(pr, 2).font = { bold: true };
  ws1.getCell(pr, 10).value = port.delivery ?? NA;
  ws1.getCell(pr, 13).value = port.cost ?? NA;
  ws1.getCell(pr, 17).value = port.overall ?? NA;
  [10, 13, 17].forEach(ci => { ws1.getCell(pr, ci).font = { bold: true }; ws1.getCell(pr, ci).numFmt = '0.0'; });

  const STATE = { ontime: 'On time', late: 'Completed late', overdue: 'Overdue (not finished)', pending: 'Not yet due', nodate: 'No planned end date', nofinish: 'Completed, no actual end date' };
  const evRows = [];
  results.forEach(r => r.events.forEach(e => evRows.push([r.name, e.project ? e.project.code : '', e.project ? e.project.name : '', e.seqNo, e.name, e.stage,
    dmy(e.plannedStart), dmy(e.plannedEnd), dmy(e.actualStart), dmy(e.actualEnd), e.status, STATE[e.state], e.daysLate || 0, e.plannedValue])));
  sheet('Deliverables', 'Deliverable / milestone compliance',
    ['Subcontractor', 'Project code', 'Project', 'Seq', 'Event', 'Stage', 'Planned start', 'Planned end', 'Actual start', 'Actual end', 'Event status', 'Result', 'Days late', 'Subcontractor planned value'],
    [30, 13, 30, 6, 44, 22, 13, 13, 13, 13, 13, 28, 10, 18], evRows, { money: [14] });

  const crRows = [];
  results.forEach(r => r.changes.forEach(c => crRows.push([r.name, c.project ? c.project.code : '', c.crCode, c.crType, c.description, dmy(c.dateSubmitted), c.status, dmy(c.decisionDate), c.costImpact])));
  sheet('Variations', 'Subcontractor variation requests (change requests)',
    ['Subcontractor', 'Project code', 'CR code', 'Category', 'Description', 'Submitted', 'Status', 'Decision date', 'Cost impact'],
    [30, 13, 16, 14, 60, 13, 16, 13, 16], crRows, { money: [9] });

  const kRows = [];
  results.forEach(r => r.contracts.forEach(k => kRows.push([r.name, k.project.code || '', k.project.name || '', k.project.status || '', k.base, k.baseSource, k.variationValue, k.contractValue,
    k.plannedValue, k.actualValue, k.vowdNumber || '', k.requests, k.listed ? 'Yes' : 'No'])));
  sheet('Contracts', 'Contracts per subcontractor',
    ['Subcontractor', 'Project code', 'Project', 'Project status', 'Base value', 'Base taken from', 'Approved variations', 'Contract value', 'Planned crew / labour value', 'Actual crew / labour value',
     'Latest VOWD', 'Variation requests', 'Listed as sub-contractor'],
    [30, 13, 30, 13, 16, 26, 16, 16, 18, 18, 18, 12, 14], kRows, { money: [5, 7, 8, 9, 10] });

  const how = wb.addWorksheet('How it is scored');
  how.getColumn(1).width = 30; how.getColumn(2).width = 110;
  [['How the score is worked out', ''],
   ['On-time delivery', 'Events linked to the subcontractor through the Crew / Labour lines. An event counts when its planned end date has passed or it has been finished. Score = events finished on or before the planned end ÷ events due × 100. Events with no planned end date, or marked Completed without an actual end date, are left out.'],
   ['Cost adherence', `Contract base = latest VOWD awarded value, otherwise the planned crew / labour value. Variation growth = approved subcontractor change-request cost ÷ base. ${SubPerf.CONFIG.growthCapPct}% growth or more scores 0. Variation frequency = requests per contract; ${SubPerf.CONFIG.freqCap} or more per contract scores 0. Cost adherence = ${SubPerf.CONFIG.costGrowthShare * 100}% growth score + ${100 - SubPerf.CONFIG.costGrowthShare * 100}% frequency score.`],
   ['Quality, HSE, Responsiveness', 'Not measured yet — the system holds no NCR, snag, incident, observation, RFI or submittal records. They are left out of the score rather than counted as zero.'],
   ['Overall score', 'Weighted average of the KPIs that have data. Full weighting: ' + SubPerf.KPIS.map(k => `${k.label} ${k.weight}`).join(', ') + '. The weight of a KPI with no data is shared out over the others, so the score reflects what is measured. An overall score needs at least ' + SubPerf.CONFIG.minKpis + ' KPIs with data; with fewer, the KPI is shown but no overall score or rating is given.'],
   ['Rating', `Score ≥ ${SubPerf.CONFIG.ragGreen} On target · ${SubPerf.CONFIG.ragAmber}–${SubPerf.CONFIG.ragGreen - 1} Watch · below ${SubPerf.CONFIG.ragAmber} Action needed.`]
  ].forEach((r, i) => { const row = how.addRow(r); row.alignment = { wrapText: true, vertical: 'top' }; if (i === 0) row.font = { bold: true, size: 14, color: { argb: NAVY } }; else row.getCell(1).font = { bold: true }; });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Subcontractor-Performance-${asOf}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/* =========================================================
   PROJECT PROGRESS — Excel measurement sheet (planned vs actual by activity). The numbers come from public/progress-calc.js,
   the same file the Project Progress page and the Report Library use.
   ========================================================= */
app.get('/api/progress/export', async (req, res) => {
  const u = sessionUser(req);
  const asked = [...new Set(String(req.query.projects || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 2147483647))].slice(0, 5000);
  const ids = u.isAdmin ? (asked.length ? asked : null) : (asked.length ? asked.filter(i => (u.projectIds || []).includes(i)) : (u.projectIds || []));
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
  const [plist, evs] = await Promise.all([listProjects(ids), listEvents(ids)]);
  const an = require('./public/progress-calc.js').analyse(plist, evs, { today: omanToday(), from: iso(req.query.from), to: iso(req.query.to) });
  const wb = require('./progress-export').buildProgressWorkbook(an, { stages: STAGES });
  await logAudit(req, { action: 'download', entityType: 'Progress sheet', entityLabel: `Progress measurement sheet · ${plist.length} project${plist.length === 1 ? '' : 's'}`, details: { projects: plist.map(p => p.code) } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="progress-measurement-${omanToday()}.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

/* =========================================================
   REPORT LIBRARY — catalogue, generate, archive, schedules, access log (see reports.js)
   ========================================================= */
require('./reports')(app, { db, sessionUser, logAudit, projectScope, listProjects, listEvents, listRisks, listIssues, listMilestones,
  loadSubcontractorFacts, STAGES, crewLineCost, SubPerf, omanToday });

/* =========================================================
   ERROR HANDLER
   ========================================================= */
// PostgreSQL rejects values SQLite used to store as-is (text in a number column, a missing
// parent row), so those come back as a 400 with the reason instead of a bare 500.
const PG_BAD_INPUT = {
  '22P02': 'Invalid value',               // invalid_text_representation (e.g. "abc" for a number)
  '22003': 'Value out of range',          // numeric_value_out_of_range
  '22007': 'Invalid date/time value',     // invalid_datetime_format
  '23502': 'A required value is missing', // not_null_violation
  '23503': 'A referenced record does not exist' // foreign_key_violation
};
app.use((err, req, res, next) => {
  if (err && err.code === '23503' && req.method === 'DELETE') {
    return res.status(409).json({ error: "Cannot delete: this record is still in use elsewhere (e.g. set as a project's Project Manager or Contractor)." });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'This save is too large for the server to accept. Split the data into smaller parts and try again.' });
  }
  if (err && PG_BAD_INPUT[err.code]) {
    return res.status(400).json({ error: PG_BAD_INPUT[err.code] });
  }
  console.error(new Date().toISOString(), req.method, req.originalUrl, err && err.code ? `[${err.code}]` : '', err);
  if (db.isTransientError(err)) {
    return res.status(503).json({ error: 'Database temporarily unavailable — please try again' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Water Rehabilitation Dashboard running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Could not start — PostgreSQL connection or migration failed:', err.message);
    process.exit(1);
  });
