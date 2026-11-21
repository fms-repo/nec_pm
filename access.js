/* =========================================================
   ACCESS CONTROL LIST — what each signed-in person may do

   Deny by default. The shared administrator login is unrestricted. Every personal login has:
     · a permission matrix: for each RESOURCE (Projects, Risks, Invoices, VOWD …) which ACTIONS
       (view / create / edit / delete) are allowed — the administrator ticks these per login;
       a login with no custom matrix gets its role's template (approver / read_only / project_manager);
     · for the project resources, the list of projects it may reach (user_project_access);
     · the sidebar menus it sees (user_accounts.menus; risks / issues / milestones menus also close
       their data).
   Approvals are separate: a person can always open — and sign — a document assigned to them, whatever
   their matrix says.

   Enforced here, once, in front of every route, not in the individual handlers: each request is mapped
   to (resource, action) and, where it belongs to a project, to that project. A route that is not
   recognised is refused to non-administrators, so a new route stays closed until it is listed below.
   List endpoints return only what the matrix and project grants allow.

   PER-PROJECT PERMISSIONS. user_project_access.permissions (JSON, usually NULL) lets the administrator set, for one login on one
   project, what it may do on each project TAB (Brief, Sequence of Events, Resources, Cost, Attachments, Change Requests,
   Certificate, VOWD, Invoice). A tab listed there uses those actions on that project instead of the login's own matrix; a tab not
   listed (or NULL) keeps the login's own matrix. Brief "view" always follows the login's own matrix (the grant itself is the way to
   hide a project). canOn() is the one place that works out "may this login do X to Y on project P".
   The Sequence of Events also has an "actuals" action: record Actual / Consumed quantities (and dated entries) and change nothing else.
   ========================================================= */
const ROLES = ['approver', 'read_only', 'project_manager'];
const ACTIONS = ['view', 'create', 'edit', 'delete'];
const ALL_ACTIONS = ['view', 'actuals', 'create', 'edit', 'delete']; // display order; 'actuals' exists on the Sequence of Events only

// The resources the matrix covers. `scoped` = belongs to a project, so the project grants also apply.
const RESOURCES = {
  projects:        { label: 'Projects (Project Brief)', scoped: true },
  events:          { label: 'Sequence of Events (incl. materials, crew / contractor)', scoped: true, actions: ['view', 'actuals', 'create', 'edit', 'delete'] },
  team:            { label: 'Resources tab (team members, external parties, resource groups)', scoped: true, actions: ['view', 'edit'] },
  cost:            { label: 'Cost Statement', scoped: true, actions: ['view'] },
  risks:           { label: 'Risks', scoped: true },
  issues:          { label: 'Issues', scoped: true },
  milestones:      { label: 'Milestones', scoped: true },
  invoices:        { label: 'Invoices', scoped: true },
  vowd:            { label: 'VOWD statements', scoped: true },
  change_requests: { label: 'Change requests (incl. analyses, decisions)', scoped: true },
  certificates:    { label: 'Completion certificates', scoped: true },
  documents:       { label: 'Project documents / attachments', scoped: true },
  locations:       { label: 'Locations (Master Data)', scoped: false },
  project_types:   { label: 'Project types (Master Data)', scoped: false },
  contractors:     { label: 'Contractors (Master Data)', scoped: false },
  business_units:  { label: 'Business units (Master Data)', scoped: false },
  team_members:    { label: 'Team members (Master Data)', scoped: false },
  reports:         { label: 'Report Library (generate reports, saved reports, schedules)', scoped: false }
};
const MASTER_KEYS = ['locations', 'project_types', 'contractors', 'business_units'];
const RESOURCE_KEYS = Object.keys(RESOURCES);
const SCOPED = RESOURCE_KEYS.filter(k => RESOURCES[k].scoped);
const actionsOf = k => (RESOURCES[k] && RESOURCES[k].actions) || ACTIONS;
// The tabs of the project form, in order, and the resource each one is controlled by (what a per-project override may set).
const PROJECT_TABS = [
  ['brief', 'Project Brief', 'projects'], ['resources', 'Resources', 'team'], ['events', 'Sequence of Events', 'events'], ['cost', 'Cost Statement', 'cost'],
  ['attachments', 'Attachments', 'documents'], ['changeRequests', 'Change Requests', 'change_requests'], ['certificate', 'Completion Certificate', 'certificates'],
  ['vowd', 'VOWD Statement', 'vowd'], ['invoice', 'Invoice', 'invoices']
];
const TAB_RESOURCES = PROJECT_TABS.map(t => t[2]);

// Starting points for the matrix (also what a login gets until the administrator customises it).
const TEMPLATES = {
  approver: {},
  read_only: Object.fromEntries(RESOURCE_KEYS.map(k => [k, ['view']])),
  project_manager: { ...Object.fromEntries(SCOPED.map(k => [k, actionsOf(k).slice()])), ...Object.fromEntries(MASTER_KEYS.map(k => [k, ['view']])), team_members: ['view'], reports: ACTIONS.slice() }
};
// Matrices saved before a row existed have no entry for it. They keep exactly the access they had:
//   · Sequence of Events / Resources / Cost followed "Projects" (viewing the project showed them; editing the project saved them);
//   · Locations / Project types / Contractors / Business units were one row, "Master data" — each takes over that row's actions;
//   · the Report Library was open to anyone who could view projects (and had the menu) — they keep all of it.
// (o = the matrix being built so far, raw = the stored one)
const DERIVED = {
  events: o => { const p = o.projects || []; return p.includes('view') ? ['view', ...(p.includes('edit') ? ['actuals', 'create', 'edit', 'delete'] : [])] : []; },
  team: o => { const p = o.projects || []; return p.includes('view') ? ['view', ...(p.includes('edit') ? ['edit'] : [])] : []; },
  cost: o => ((o.projects || []).includes('view') ? ['view'] : []),
  reports: o => ((o.projects || []).includes('view') ? ACTIONS.slice() : []),
  ...Object.fromEntries(MASTER_KEYS.map(k => [k, (o, raw) => (Array.isArray(raw.master_data) ? ACTIONS.filter(a => raw.master_data.includes(a)) : [])]))
};
// stored JSON (or null) -> { resource: [actions] }. Unknown resources/actions are ignored.
function effectivePermissions(role, stored) {
  if (role === 'approver') return {};
  let obj = null;
  try { obj = stored ? JSON.parse(stored) : null; } catch (e) { /* default */ }
  if (!obj || typeof obj !== 'object') return JSON.parse(JSON.stringify(TEMPLATES[role] || {}));
  const out = {};
  for (const k of RESOURCE_KEYS) out[k] = Array.isArray(obj[k]) ? actionsOf(k).filter(a => obj[k].includes(a)) : (DERIVED[k] ? DERIVED[k](out, obj) : []);
  return out;
}
// Validates a matrix coming from the administrator; returns the cleaned object or null if invalid.
function cleanMatrix(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!RESOURCES[k] || !Array.isArray(v) || !v.every(a => actionsOf(k).includes(a))) return null;
    out[k] = actionsOf(k).filter(a => v.includes(a));
  }
  return out;
}
// A per-project override: only the project tabs' resources. Returns the cleaned object, or null if invalid.
function cleanProjectMatrix(obj) {
  const m = cleanMatrix(obj);
  return m && Object.keys(m).every(k => TAB_RESOURCES.includes(k)) ? m : null;
}
function parseOverride(stored) {
  try { return stored ? cleanProjectMatrix(JSON.parse(stored)) : null; } catch (e) { return null; }
}

/* ---------- may this login do this to this project? ---------- */
// The matrix in force on one project: the login's own, with the tabs listed in the project override replaced.
function permsOn(user, projectId) {
  const own = user.permissions || {}, o = user.projectPerms && user.projectPerms[projectId];
  if (!o) return own;
  const out = { ...own, ...o };
  if (o.projects) out.projects = (own.projects || []).includes('view') ? [...new Set(['view', ...o.projects])] : o.projects.filter(a => a !== 'view'); // "view" is never changed per project
  return out;
}
function canOn(user, resource, action, projectId) {
  if (user.isAdmin) return true;
  const acts = permsOn(user, projectId)[resource] || [];
  if (acts.includes(action)) return true;
  if (resource === 'events') { // recording actuals is part of editing; anyone who may change events may see them
    if (action === 'actuals') return acts.includes('edit');
    if (action === 'view') return acts.length > 0;
  }
  return false;
}

// The sidebar menus the administrator can switch on/off per login (data-tab values in index.html;
// My Approvals is always available, and the Administration pages are administrator-only).
// Keep in step with the sidebar — a test checks they match.
const MENUS = ['overview', 'master-projects', 'portfolio', 'progress', 'financial', 'health', 'contractors',
  'risks-crud', 'issues-crud', 'risks', 'milestones-crud', 'milestones', 'gantt', 'reports',
  'master-governorates', 'master-types', 'master-contractors', 'master-business-units', 'master-team-members'];
// Menus that own a distinct body of data, so switching them off also closes the matching API routes.
const DATA_MENUS = { risks: ['risks-crud', 'risks'], issues: ['issues-crud'], milestones: ['milestones-crud', 'milestones'] };
function effectiveMenus(role, stored) {
  if (role === 'approver') return [];
  let list = null;
  try { list = stored ? JSON.parse(stored) : null; } catch (e) { /* treat as default */ }
  return Array.isArray(list) ? list.filter(k => MENUS.includes(k)) : MENUS.slice();
}

const ITEM_TABLES = {
  risks: 'risks', issues: 'issues', milestones: 'milestones', invoices: 'invoices', documents: 'project_documents',
  certificates: 'completion_certificates', 'vowd-statements': 'vowd_statements', 'change-requests': 'change_requests',
  'project-members': 'project_members', 'external-parties': 'project_external_parties', 'resource-groups': 'project_resource_groups'
};
// /api/<segment>/:id  ->  which resource it is
const ITEM_RESOURCE = {
  risks: 'risks', issues: 'issues', milestones: 'milestones', invoices: 'invoices', documents: 'documents', certificates: 'certificates',
  'vowd-statements': 'vowd', 'change-requests': 'change_requests', 'change-analyses': 'change_requests', 'change-decisions': 'change_requests',
  'project-members': 'team', 'external-parties': 'team', 'resource-groups': 'team'
};
// Sub-records are changed by editing their parent (an analysis is part of a change request, a member part of a project).
const CHILD_SEGMENTS = new Set(['change-analyses', 'change-decisions', 'project-members', 'external-parties', 'resource-groups']);
const DOC_TABLES = { vowd: 'vowd_statements', change_request: 'change_requests', certificate: 'completion_certificates' };
const APPROVAL_RESOURCE = { vowd: 'vowd', change_request: 'change_requests', certificate: 'certificates' };
const DOC_VIEW_TYPE = { 'vowd-statements': 'vowd', 'change-requests': 'change_request', certificates: 'certificate' };
// /api/projects/:id/<rest>  ->  resource
const PROJECT_SUB = [
  [/^$/, 'projects'], [/^events\/export$/, 'events'], [/^(members|external-parties|resource-groups)$/, 'team', true],
  [/^invoices$/, 'invoices'], [/^documents$/, 'documents'], [/^certificates$/, 'certificates'], [/^vowd-statements$/, 'vowd'],
  [/^(change-requests|change-analyses|change-decisions)$/, 'change_requests']
];

const ADMIN_ONLY = [/^\/api\/audit-log(\/|$)/, /^\/api\/reports\/access-log(\/|$)/, /^\/api\/recycle-bin(\/|$)/, /^\/api\/user-accounts(\/|$)/, /^\/api\/team-members\/\d+\/account(\/|$)/];
const MASTER = /^\/api\/(governorates|project-types|contractors|business-units|team-members)(\/|$)/;
const MASTER_RESOURCE = { governorates: 'locations', 'project-types': 'project_types', contractors: 'contractors', 'business-units': 'business_units', 'team-members': 'team_members' };
const GLOBAL_GET = /^\/api\/(governorates|project-types|contractors|business-units|team-members|trend|events\/template|approvals\/approvers)(\/\d+\/logo)?$/;
const LIST_RESOURCE = { '/api/projects': 'projects', '/api/events': 'events', '/api/risks': 'risks', '/api/issues': 'issues', '/api/milestones': 'milestones', '/api/change-requests': 'change_requests' };
const CREATE_IN_BODY = { '/api/risks': 'risks', '/api/risks/template': 'risks', '/api/issues': 'issues', '/api/issues/template': 'issues', '/api/milestones': 'milestones' };
const ACTION_OF = { GET: 'view', POST: 'create', PUT: 'edit', DELETE: 'delete' };

module.exports = function registerAccess(app, { db, sessionUser }) {
  const deny = (res, msg) => res.status(403).json({ error: msg, code: 'ACCESS_DENIED' });
  const NO_PROJECT = 'You do not have access to this project';

  const assigned = async (type, id, teamMemberId) => !!(await db.prepare(
    `SELECT 1 AS ok FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND team_member_id = ? AND round > 0 LIMIT 1`).get(type, id, teamMemberId));

  async function projectOfItem(segment, id) {
    if (segment === 'change-analyses' || segment === 'change-decisions') {
      const table = segment === 'change-analyses' ? 'change_analyses' : 'change_decisions';
      const r = await db.prepare(`SELECT cr.project_id FROM ${table} c JOIN change_requests cr ON cr.id = c.change_request_id WHERE c.id = ?`).get(id);
      return r ? r.project_id : null;
    }
    const table = ITEM_TABLES[segment];
    if (!table) return undefined; // not a known item route
    const r = await db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id);
    return r ? r.project_id : null;
  }

  // Keeps the rows of a list that belong to projects this login may reach AND may view that kind of record on (per-project permissions).
  function filterBody(path, body, allowed, user) {
    const keep = (arr, key, resource) => (Array.isArray(arr) ? arr.filter(r => allowed.has(r[key]) && (!resource || canOn(user, resource, 'view', r[key]))) : arr);
    if (path === '/api/projects') return keep(body, 'id');
    if (path === '/api/bootstrap' && body && typeof body === 'object') {
      return { ...body, projects: keep(body.projects, 'id'), risks: keep(body.risks, 'projectId', 'risks'), issues: keep(body.issues, 'projectId', 'issues'),
        milestones: keep(body.milestones, 'projectId', 'milestones'), events: keep(body.events, 'projectId', 'events') };
    }
    return keep(body, 'projectId', LIST_RESOURCE[path]);
  }

  app.use(async (req, res, next) => {
    const p = req.path, m = req.method;
    if (!p.startsWith('/api/')) return next();
    const user = sessionUser(req);
    if (!user || user.isAdmin) return next();
    if (p.startsWith('/api/auth/')) return next();
    if (m === 'GET' && p === '/api/my-approvals') return next();
    // Signing a step: open to every login — the approval engine checks it is really that person's step.
    if (m === 'POST' && /^\/api\/approvals\/\w+\/\d+\/steps\/\d+\/(approve|reject)$/.test(p)) return next();
    if (ADMIN_ONLY.some(re => re.test(p))) return deny(res, 'Only the administrator can do this');
    let a;

    // A document assigned to you for approval can always be opened, whatever your matrix says.
    if (m === 'GET') {
      if ((a = /^\/api\/approvals\/(\w+)\/(\d+)$/.exec(p)) && DOC_TABLES[a[1]] && await assigned(a[1], a[2], user.teamMemberId)) return next();
      if ((a = /^\/api\/(vowd-statements|change-requests|certificates)\/(\d+)$/.exec(p)) && await assigned(DOC_VIEW_TYPE[a[1]], a[2], user.teamMemberId)) return next();
      if (/^\/api\/business-units\/\d+\/logo$/.test(p)) return next(); // letterhead on the print preview
    }

    const perms = user.permissions || {};
    const can = (r, act) => (perms[r] || []).includes(act);
    if (!Object.values(perms).some(list => list.length)) return deny(res, 'Your account can only review the documents assigned to you for approval');
    const ACT_TEXT = { view: 'view', actuals: 'record actual quantities in', create: 'create', edit: 'edit', delete: 'delete' };
    const deniedMsg = (r, act) => deny(res, `You do not have permission to ${ACT_TEXT[act] || act} ${RESOURCES[r].label.replace(/ \(.*\)$/, '').toLowerCase()}`);
    const need = (r, act) => (can(r, act) ? null : deniedMsg(r, act));
    // the same check on one project (its per-project permissions apply)
    const needOn = (r, act, pid) => (canOn(user, r, act, pid) ? null : deniedMsg(r, act));
    // "somewhere": the login's own matrix allows it, or some project's override does (used for list endpoints, which are then filtered per project)
    const anyView = r => can(r, 'view') || Object.values(user.projectPerms || {}).some(o => (o[r] || []).includes('view'));
    // Notifications (the bell): any login that can view projects; the routes themselves only return alerts for the projects granted.
    if ((m === 'GET' && p === '/api/notifications') || (m === 'POST' && p === '/api/notifications/read')) return need('projects', 'view') || next();

    const allowed = new Set(user.projectIds);
    const allow = pid => allowed.has(Number(pid));
    const menus = new Set(user.menus);
    const hasData = domain => DATA_MENUS[domain].some(k => menus.has(k));
    const NO_MENU = 'You do not have access to this menu';
    if ((a = /^\/api\/(risks|issues|milestones)(\/|$)/.exec(p)) && !hasData(a[1])) return deny(res, NO_MENU);

    /* ---- Subcontractor Performance: read-only; the route itself narrows the facts to the projects (and the VOWD / change-request
            values) this login may see, so here it only needs the menu and view on projects ---- */
    if (m === 'GET' && /^\/api\/subcontractor-performance(\/export)?$/.test(p)) {
      if (!menus.has('contractors')) return deny(res, NO_MENU);
      return need('projects', 'view') || next();
    }

    /* ---- Project Progress sheet (Excel): needs the Project Progress menu and view on projects; the route narrows it to the granted projects ---- */
    if (m === 'GET' && (p === '/api/progress/export' || p === '/api/progress/event-subcontractors')) {
      if (!menus.has('progress')) return deny(res, NO_MENU);
      return need('projects', 'view') || next();
    }

    /* ---- Report Library: needs the Report Library menu and view on projects. The routes themselves decide which reports, projects and
            stored runs this login may use (reports.js) — the same menus, permission matrix and project grants as everywhere else. ---- */
    if (/^\/api\/reports(\/|$)/.test(p)) {
      if (!menus.has('reports')) return deny(res, NO_MENU);
      // view: look at / print / download what exists (and the logging of that, and the recipient look-up); create: generate a report, save a
      // custom report, create a schedule; edit: change / pause / run-now a schedule or saved report; delete: remove one.
      const sub = p.replace(/^\/api\/reports/, '');
      let act = 'view';
      if (m === 'DELETE') act = 'delete';
      else if (m === 'PUT') act = 'edit';
      else if (m === 'POST') act = /^\/runs\/\d+\/log$/.test(sub) || sub === '/schedules/recipients' ? 'view' : /^\/schedules\/\d+\/(pause|run)$/.test(sub) ? 'edit' : 'create';
      return need('projects', 'view') || need('reports', act) || next();
    }

    /* ---- reference data & team members ---- */
    if (m === 'GET' && GLOBAL_GET.test(p)) return next();
    if ((a = MASTER.exec(p))) { // GET handled above; anything else is a change
      const resource = MASTER_RESOURCE[a[1]];
      const act = /\/logo$/.test(p) ? 'edit' : ACTION_OF[m];
      return need(resource, act) || next();
    }

    /* ---- lists: only what the matrix and the project grants allow ---- */
    if (m === 'GET' && p === '/api/bootstrap') {
      const json = res.json.bind(res);
      res.json = body => {
        let out = filterBody(p, body, allowed, user);
        if (out && typeof out === 'object') {
          const blank = {};
          if (!can('projects', 'view')) { blank.projects = []; blank.events = []; }
          for (const key of ['risks', 'issues', 'milestones']) {
            if (!hasData(key)) blank[key] = [];
          }
          out = { ...out, ...Object.fromEntries(Object.entries(blank).filter(([k]) => Array.isArray(out[k]))) };
        }
        return json(out);
      };
      return next();
    }
    if (m === 'GET' && LIST_RESOURCE[p]) {
      if (!anyView(LIST_RESOURCE[p]) && LIST_RESOURCE[p] !== 'events') return deniedMsg(LIST_RESOURCE[p], 'view');
      if (req.query.projectId && !allow(req.query.projectId)) return deny(res, NO_PROJECT);
      const json = res.json.bind(res);
      res.json = body => json(filterBody(p, body, allowed, user));
      return next();
    }
    if (m === 'POST' && p === '/api/events/import') return (can('projects', 'edit') || can('events', 'edit') || can('events', 'create')) ? next() : deniedMsg('events', 'create');

    if (m === 'POST' && p === '/api/projects') {
      const denied = need('projects', 'create'); if (denied) return denied;
      // A creator is granted the project straight away so it doesn't vanish from their own view.
      const json = res.json.bind(res);
      res.json = body => {
        if (res.statusCode === 201 && body && body.id) {
          db.outsideTransaction(() => db.prepare(`INSERT INTO user_project_access (team_member_id, project_id, granted_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
            .run(user.teamMemberId, body.id, user.username)).then(() => {
            req.session.projectIds = [...new Set([...(req.session.projectIds || []), body.id])];
            json(body);
          }).catch(err => next(err));
          return res;
        }
        return json(body);
      };
      return next();
    }
    if (m === 'POST' && CREATE_IN_BODY[p]) {
      const denied = needOn(CREATE_IN_BODY[p], 'create', req.body && req.body.projectId); if (denied) return denied;
      return allow(req.body && req.body.projectId) ? next() : deny(res, NO_PROJECT);
    }

    /* ---- /api/projects/:id and what hangs off it ---- */
    if ((a = /^\/api\/projects\/(\d+)(?:\/(.*))?$/.exec(p))) {
      const rest = a[2] || '', pid = Number(a[1]);
      const hit = PROJECT_SUB.find(([re]) => re.test(rest));
      if (!hit) return deny(res, 'This action is not available to your account');
      const [, resource, isTeamSub] = hit;
      if (!allow(pid)) return deny(res, NO_PROJECT);
      // The project save carries the Brief AND the Sequence of Events. It is open to anyone who may edit the Brief or do anything on the
      // events; the save itself (server.js) then applies only the parts this login may change.
      if (m === 'PUT' && rest === '') {
        if (!canOn(user, 'projects', 'edit', pid) && !['actuals', 'create', 'edit', 'delete'].some(x => canOn(user, 'events', x, pid))) return deniedMsg('projects', 'edit');
        return next();
      }
      // adding to a project's team / parties / groups is an edit of the team tab; everything else maps from the method
      const denied = needOn(resource, isTeamSub && m !== 'GET' ? 'edit' : ACTION_OF[m], pid); if (denied) return denied;
      return next();
    }

    /* ---- approvals: assigning / submitting needs edit on that kind of document ---- */
    if ((a = /^\/api\/approvals\/(\w+)\/(\d+)(\/|$)/.exec(p))) {
      const table = DOC_TABLES[a[1]];
      if (!table) return next(); // unknown type: the route answers 404
      const doc = await db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(a[2]);
      if (!doc) return next();
      const denied = needOn(APPROVAL_RESOURCE[a[1]], m === 'GET' ? 'view' : 'edit', doc.project_id); if (denied) return denied;
      return allow(doc.project_id) ? next() : deny(res, NO_PROJECT);
    }

    /* ---- /api/<record>/:id ---- */
    if ((a = /^\/api\/([a-z-]+)\/(\d+)(\/|$)/.exec(p))) {
      const resource = ITEM_RESOURCE[a[1]];
      if (!resource) return deny(res, 'This action is not available to your account');
      const act = CHILD_SEGMENTS.has(a[1]) && m !== 'GET' ? 'edit' : (m === 'POST' ? 'edit' : ACTION_OF[m]); // POST here = add a child (analysis / decision)
      const pid = await projectOfItem(a[1], a[2]);
      if (pid === null) return need(resource, act) || next(); // no such record: the route answers 404
      const denied = needOn(resource, act, pid); if (denied) return denied;
      return allow(pid) ? next() : deny(res, NO_PROJECT);
    }
    return deny(res, 'This action is not available to your account');
  });
};

Object.assign(module.exports, { MASTER_RESOURCE, ROLES, ACTIONS, ALL_ACTIONS, RESOURCES, TEMPLATES, MENUS, PROJECT_TABS, TAB_RESOURCES, actionsOf, effectiveMenus, effectivePermissions,
  cleanMatrix, cleanProjectMatrix, parseOverride, permsOn, canOn });
