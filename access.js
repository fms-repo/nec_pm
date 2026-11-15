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
   ========================================================= */
const ROLES = ['approver', 'read_only', 'project_manager'];
const ACTIONS = ['view', 'create', 'edit', 'delete'];

// The resources the matrix covers. `scoped` = belongs to a project, so the project grants also apply.
const RESOURCES = {
  projects:        { label: 'Projects (incl. events, team, external parties)', scoped: true },
  risks:           { label: 'Risks', scoped: true },
  issues:          { label: 'Issues', scoped: true },
  milestones:      { label: 'Milestones', scoped: true },
  invoices:        { label: 'Invoices', scoped: true },
  vowd:            { label: 'VOWD statements', scoped: true },
  change_requests: { label: 'Change requests (incl. analyses, decisions)', scoped: true },
  certificates:    { label: 'Completion certificates', scoped: true },
  documents:       { label: 'Project documents / attachments', scoped: true },
  master_data:     { label: 'Master data (locations, types, contractors, business units)', scoped: false },
  team_members:    { label: 'Team members', scoped: false }
};
const RESOURCE_KEYS = Object.keys(RESOURCES);
const SCOPED = RESOURCE_KEYS.filter(k => RESOURCES[k].scoped);

// Starting points for the matrix (also what a login gets until the administrator customises it).
const TEMPLATES = {
  approver: {},
  read_only: Object.fromEntries(RESOURCE_KEYS.map(k => [k, ['view']])),
  project_manager: { ...Object.fromEntries(SCOPED.map(k => [k, ACTIONS.slice()])), master_data: ['view'], team_members: ['view'] }
};
// stored JSON (or null) -> { resource: [actions] }. Unknown resources/actions are ignored.
function effectivePermissions(role, stored) {
  if (role === 'approver') return {};
  let obj = null;
  try { obj = stored ? JSON.parse(stored) : null; } catch (e) { /* default */ }
  if (!obj || typeof obj !== 'object') return JSON.parse(JSON.stringify(TEMPLATES[role] || {}));
  const out = {};
  for (const k of RESOURCE_KEYS) out[k] = Array.isArray(obj[k]) ? ACTIONS.filter(a => obj[k].includes(a)) : [];
  return out;
}
// Validates a matrix coming from the administrator; returns the cleaned object or null if invalid.
function cleanMatrix(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!RESOURCES[k] || !Array.isArray(v) || !v.every(a => ACTIONS.includes(a))) return null;
    out[k] = ACTIONS.filter(a => v.includes(a));
  }
  return out;
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
  'project-members': 'projects', 'external-parties': 'projects', 'resource-groups': 'projects'
};
// Sub-records are changed by editing their parent (an analysis is part of a change request, a member part of a project).
const CHILD_SEGMENTS = new Set(['change-analyses', 'change-decisions', 'project-members', 'external-parties', 'resource-groups']);
const DOC_TABLES = { vowd: 'vowd_statements', change_request: 'change_requests', certificate: 'completion_certificates' };
const APPROVAL_RESOURCE = { vowd: 'vowd', change_request: 'change_requests', certificate: 'certificates' };
const DOC_VIEW_TYPE = { 'vowd-statements': 'vowd', 'change-requests': 'change_request', certificates: 'certificate' };
// /api/projects/:id/<rest>  ->  resource
const PROJECT_SUB = [
  [/^$/, 'projects'], [/^events\/export$/, 'projects'], [/^(members|external-parties|resource-groups)$/, 'projects', true],
  [/^invoices$/, 'invoices'], [/^documents$/, 'documents'], [/^certificates$/, 'certificates'], [/^vowd-statements$/, 'vowd'],
  [/^(change-requests|change-analyses|change-decisions)$/, 'change_requests']
];

const ADMIN_ONLY = [/^\/api\/audit-log(\/|$)/, /^\/api\/reports\/access-log(\/|$)/, /^\/api\/recycle-bin(\/|$)/, /^\/api\/user-accounts(\/|$)/, /^\/api\/team-members\/\d+\/account(\/|$)/];
const MASTER = /^\/api\/(governorates|project-types|contractors|business-units|team-members)(\/|$)/;
const GLOBAL_GET = /^\/api\/(governorates|project-types|contractors|business-units|team-members|trend|events\/template|approvals\/approvers)(\/\d+\/logo)?$/;
const LIST_RESOURCE = { '/api/projects': 'projects', '/api/events': 'projects', '/api/risks': 'risks', '/api/issues': 'issues', '/api/milestones': 'milestones', '/api/change-requests': 'change_requests' };
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

  function filterBody(path, body, allowed) {
    const keep = (arr, key) => (Array.isArray(arr) ? arr.filter(r => allowed.has(r[key])) : arr);
    if (path === '/api/projects') return keep(body, 'id');
    if (path === '/api/bootstrap' && body && typeof body === 'object') {
      return { ...body, projects: keep(body.projects, 'id'), risks: keep(body.risks, 'projectId'), issues: keep(body.issues, 'projectId'),
        milestones: keep(body.milestones, 'projectId'), events: keep(body.events, 'projectId') };
    }
    return keep(body, 'projectId');
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
    const need = (r, act) => (can(r, act) ? null : deny(res, `You do not have permission to ${act} ${RESOURCES[r].label.replace(/ \(.*\)$/, '').toLowerCase()}`));

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
    if (m === 'GET' && p === '/api/progress/export') {
      if (!menus.has('progress')) return deny(res, NO_MENU);
      return need('projects', 'view') || next();
    }

    /* ---- Report Library: needs the Report Library menu and view on projects. The routes themselves decide which reports, projects and
            stored runs this login may use (reports.js) — the same menus, permission matrix and project grants as everywhere else. ---- */
    if (/^\/api\/reports(\/|$)/.test(p)) {
      if (!menus.has('reports')) return deny(res, NO_MENU);
      return need('projects', 'view') || next();
    }

    /* ---- reference data & team members ---- */
    if (m === 'GET' && GLOBAL_GET.test(p)) return next();
    if ((a = MASTER.exec(p))) { // GET handled above; anything else is a change
      const resource = a[1] === 'team-members' ? 'team_members' : 'master_data';
      const act = /\/logo$/.test(p) ? 'edit' : ACTION_OF[m];
      return need(resource, act) || next();
    }

    /* ---- lists: only what the matrix and the project grants allow ---- */
    if (m === 'GET' && p === '/api/bootstrap') {
      const json = res.json.bind(res);
      res.json = body => {
        let out = filterBody(p, body, allowed);
        if (out && typeof out === 'object') {
          const blank = {};
          if (!can('projects', 'view')) { blank.projects = []; blank.events = []; }
          for (const [key, r] of [['risks', 'risks'], ['issues', 'issues'], ['milestones', 'milestones']]) {
            if (!can(r, 'view') || !hasData(key)) blank[key] = [];
          }
          out = { ...out, ...Object.fromEntries(Object.entries(blank).filter(([k]) => Array.isArray(out[k]))) };
        }
        return json(out);
      };
      return next();
    }
    if (m === 'GET' && LIST_RESOURCE[p]) {
      const denied = need(LIST_RESOURCE[p], 'view'); if (denied) return denied;
      if (req.query.projectId && !allow(req.query.projectId)) return deny(res, NO_PROJECT);
      const json = res.json.bind(res);
      res.json = body => json(filterBody(p, body, allowed));
      return next();
    }
    if (m === 'POST' && p === '/api/events/import') return need('projects', 'edit') || next();

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
      const denied = need(CREATE_IN_BODY[p], 'create'); if (denied) return denied;
      return allow(req.body && req.body.projectId) ? next() : deny(res, NO_PROJECT);
    }

    /* ---- /api/projects/:id and what hangs off it ---- */
    if ((a = /^\/api\/projects\/(\d+)(?:\/(.*))?$/.exec(p))) {
      const rest = a[2] || '';
      const hit = PROJECT_SUB.find(([re]) => re.test(rest));
      if (!hit) return deny(res, 'This action is not available to your account');
      const [, resource, isTeamSub] = hit;
      // adding to a project's team / parties / groups is an edit of the project; everything else maps from the method
      const denied = need(resource, isTeamSub && m !== 'GET' ? 'edit' : ACTION_OF[m]); if (denied) return denied;
      return allow(a[1]) ? next() : deny(res, NO_PROJECT);
    }

    /* ---- approvals: assigning / submitting needs edit on that kind of document ---- */
    if ((a = /^\/api\/approvals\/(\w+)\/(\d+)(\/|$)/.exec(p))) {
      const table = DOC_TABLES[a[1]];
      if (!table) return next(); // unknown type: the route answers 404
      const doc = await db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(a[2]);
      if (!doc) return next();
      const denied = need(APPROVAL_RESOURCE[a[1]], m === 'GET' ? 'view' : 'edit'); if (denied) return denied;
      return allow(doc.project_id) ? next() : deny(res, NO_PROJECT);
    }

    /* ---- /api/<record>/:id ---- */
    if ((a = /^\/api\/([a-z-]+)\/(\d+)(\/|$)/.exec(p))) {
      const resource = ITEM_RESOURCE[a[1]];
      if (!resource) return deny(res, 'This action is not available to your account');
      const act = CHILD_SEGMENTS.has(a[1]) && m !== 'GET' ? 'edit' : (m === 'POST' ? 'edit' : ACTION_OF[m]); // POST here = add a child (analysis / decision)
      const denied = need(resource, act); if (denied) return denied;
      const pid = await projectOfItem(a[1], a[2]);
      if (pid === null) return next(); // no such record: the route answers 404
      return allow(pid) ? next() : deny(res, NO_PROJECT);
    }
    return deny(res, 'This action is not available to your account');
  });
};

Object.assign(module.exports, { ROLES, ACTIONS, RESOURCES, TEMPLATES, MENUS, effectiveMenus, effectivePermissions, cleanMatrix });
