/* =========================================================
   REPORT LIBRARY — server side: build a report, keep it, schedule it.

   Everything goes through one path: generateReport() works out the finished report on the server (see reports-blocks.js),
   freezes it as JSON in report_runs, and returns the run. The viewer / print page (public/report-print.html), the Excel
   download and the archive all read that stored snapshot — so a report opened next month shows the numbers as they were
   on the day it was generated, and a scheduled report (no browser involved) is exactly the same thing as a manual one.

   Who sees what (nothing new to set up — it follows the logins' existing menus, permission matrix and project grants):
     · a report can be generated if the login can open one of its pages (reports-blocks.js `menus`) and may view the data of
       each block it contains; blocks the login may not see are left out and the report says so;
     · a stored run is shown only to a login that may see ALL of its projects and every block it contains;
     · schedule recipients must pass the same test, checked when the schedule is saved and again whenever a run is opened.
   Who generated / opened / downloaded / printed what is written to the audit log (entity "Report").
   ========================================================= */
'use strict';
const { BLOCKS, REPORTS, LAYOUTS, PERIODS, userCan, resolvePeriod, diff, day } = require('./reports-blocks');
const { buildWorkbook } = require('./reports-excel');
const acl = require('./access');
const PC = require('./public/progress-calc.js');

const OMAN_MS = 4 * 3600 * 1000;
const clean = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const ids = a => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 2147483647))].slice(0, 5000);
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const refOf = r => `RPT-${String(r.generated_at || '').slice(0, 4) || new Date().getFullYear()}-${String(r.id).padStart(4, '0')}`;

module.exports = function registerReports(app, d) {
  const { db, sessionUser, logAudit, projectScope, listProjects, listEvents, listRisks, listIssues, listMilestones, loadSubcontractorFacts, loadEventSubs, STAGES, crewLineCost, SubPerf, omanToday } = d;

  /* ---------- people ---------- */
  const me = req => sessionUser(req);
  async function accountUser(username) {
    const a = await db.prepare(`SELECT ua.*, tm.name AS member_name FROM user_accounts ua JOIN team_members tm ON tm.id = ua.team_member_id
      WHERE LOWER(ua.username) = ? AND ua.active = 1`).get(String(username || '').toLowerCase());
    if (!a) return null;
    const access = await db.prepare('SELECT project_id, permissions FROM user_project_access WHERE team_member_id = ?').all(a.team_member_id);
    const projectIds = access.map(r => r.project_id), projectPerms = {};
    access.forEach(r => { const o = acl.parseOverride(r.permissions); if (o) projectPerms[r.project_id] = o; });
    return { username: a.username, isAdmin: false, displayName: a.member_name, teamMemberId: a.team_member_id, projectIds, projectPerms,
      menus: acl.effectiveMenus(a.role, a.menus), permissions: acl.effectivePermissions(a.role, a.permissions) };
  }
  const allowOf = u => ({
    risks: userCan(u, { data: 'risks' }), issues: userCan(u, { data: 'issues' }), milestones: userCan(u, { data: 'milestones' }),
    invoices: userCan(u, { views: ['invoices'] }), vowd: userCan(u, { views: ['vowd'] }), changes: userCan(u, { views: ['change_requests'] }),
    certificates: userCan(u, { views: ['certificates'] })
  });

  /* ---------- scope & period ---------- */
  async function visibleProjects(user) {
    const rows = await db.prepare(`SELECT p.id, p.code, p.name, p.status, p.business_unit_id, bu.name AS bu_name
      FROM projects p LEFT JOIN business_units bu ON bu.id = p.business_unit_id WHERE p.deleted_at IS NULL ORDER BY p.name`).all();
    const mine = user.isAdmin ? rows : rows.filter(r => (user.projectIds || []).includes(r.id));
    return mine.map(r => ({ id: r.id, code: r.code, name: r.name, status: r.status, businessUnitId: r.business_unit_id, businessUnit: r.bu_name || null }));
  }
  function cleanInput(raw) {
    raw = raw || {};
    const per = raw.period || {};
    return {
      reportKey: clean(raw.reportKey, 40) || 'custom', definitionId: Number(raw.definitionId) || null, title: clean(raw.title, 120),
      blocks: Array.isArray(raw.blocks) ? raw.blocks.map(b => clean(Array.isArray(b) ? b[0] : b, 40)).filter(Boolean).slice(0, 40) : [],
      options: Array.isArray(raw.options) ? raw.options.map(o => clean(o, 40)).slice(0, 10) : [],
      layout: LAYOUTS.some(l => l.key === raw.layout) ? raw.layout : '',
      // optional narrowing to some subcontractors (0 = events with no subcontractor) and / or event names — used by the progress reports
      subcontractorIds: [...new Set((Array.isArray(raw.subcontractorIds) ? raw.subcontractorIds : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 2147483647))].slice(0, 200),
      eventNames: [...new Set((Array.isArray(raw.eventNames) ? raw.eventNames : []).map(s => clean(s, 200)).filter(Boolean))].slice(0, 50),
      businessUnitIds: ids(raw.businessUnitIds), projectIds: ids(raw.projectIds), statuses: (Array.isArray(raw.statuses) ? raw.statuses : []).map(s => clean(s, 40)).filter(Boolean).slice(0, 12),
      period: { preset: PERIODS.some(p => p.key === per.preset) ? per.preset : '', from: clean(per.from, 10), to: clean(per.to, 10) }
    };
  }
  async function resolveScope(user, input, visible) {
    visible = visible || await visibleProjects(user);
    let list = visible;
    if (input.businessUnitIds.length) list = list.filter(p => input.businessUnitIds.includes(p.businessUnitId));
    if (input.projectIds.length) list = list.filter(p => input.projectIds.includes(p.id));
    if (input.statuses.length) list = list.filter(p => input.statuses.includes(p.status));
    return { visible, projects: list };
  }
  function scopeLabel(projects, visible, input) {
    if (projects.length === 1) return projects[0].name;
    const bus = [...new Set(projects.map(p => p.businessUnit || 'Unassigned'))];
    if (!input.projectIds.length && !input.statuses.length && input.businessUnitIds.length && bus.length === 1) return `${bus[0]} — ${projects.length} projects`;
    if (projects.length === visible.length) return `All projects (${projects.length})`;
    if (!input.projectIds.length && !input.statuses.length && input.businessUnitIds.length) return `${bus.length} business units — ${projects.length} projects`;
    return `${projects.length} selected projects`;
  }

  /* ---------- the data a report reads (loaded on demand, once per run) ---------- */
  function makeContext(user, scopeProjects, period, today, filter) {
    const idList = scopeProjects.map(p => p.id);
    const memo = fn => { let p; return () => (p ||= fn()); };
    const q = (sql, ...extra) => db.prepare(sql).all(idList, ...extra);
    const baseAllow = allowOf(user), allowUsed = new Set();
    // Remember which kinds of data (risks, issues, VOWD …) the report actually read, so the stored run can later be shown
    // only to logins that may see all of them — a report built by an administrator can quote risk counts in a summary strip.
    const allow = new Proxy(baseAllow, { get: (t, k) => { if (t[k]) allowUsed.add(k); return t[k]; } });
    const c = {
      user, today, period, ids: idList, allow, allowUsed, STAGES, SubPerf, crewLineCost, opts: {}, filter: filter || null,
      projects: memo(() => listProjects(idList)),
      events: memo(async () => (filter ? PC.filterEvents(await listEvents(idList), filter.subs, filter) : listEvents(idList)).then(list => list.filter(e => acl.canOn(user, 'events', 'view', e.projectId)))),
      risks: memo(() => listRisks(null, idList)),
      issues: memo(() => listIssues(null, idList)),
      milestones: memo(() => listMilestones(null, idList)),
      // which subcontractor(s) carry each Sequence-of-Events line: a crew / labour line names its event and its sub contractor
      eventCrews: memo(async () => (await q(`SELECT pc.event_id, pc.project_id, pc.contractor_id, ct.name AS contractor FROM project_crews pc JOIN contractors ct ON ct.id = pc.contractor_id
        WHERE pc.event_id IS NOT NULL AND pc.project_id = ANY(?::int[]) ORDER BY ct.name`)).filter(r => acl.canOn(user, 'events', 'view', r.project_id))),
      costLines: memo(async () => ({
        materials: await q('SELECT project_id, stage, material_name, supplier, status, planned_qty, consumed_qty, unit_rate, delivery_date FROM project_materials WHERE project_id = ANY(?::int[])'),
        crews: await q('SELECT project_id, stage, quantity, actual_qty, rate_basis, unit_rate, allocated_days FROM project_crews WHERE project_id = ANY(?::int[])')
      })),
      crs: memo(async () => (await q(`SELECT cr.id, cr.project_id, cr.cr_code, cr.cr_type, cr.cr_source, cr.date_submitted,
          (SELECT COUNT(*) FROM change_analyses a WHERE a.change_request_id = cr.id) AS analysis_count,
          (SELECT COALESCE(SUM(a.cost_impact), 0) FROM change_analyses a WHERE a.change_request_id = cr.id) AS cost_impact,
          (SELECT x.decision FROM change_decisions x WHERE x.change_request_id = cr.id ORDER BY x.decision_date DESC, x.id DESC LIMIT 1) AS decision
        FROM change_requests cr WHERE cr.deleted_at IS NULL AND cr.project_id = ANY(?::int[]) ORDER BY cr.date_submitted DESC, cr.id DESC`)).map(r => ({
        id: r.id, projectId: r.project_id, crCode: r.cr_code, crType: r.cr_type, crSource: r.cr_source || 'Client', dateSubmitted: r.date_submitted,
        analysisCount: r.analysis_count, costImpact: Number(r.cost_impact) || 0, decision: r.decision || null }))),
      certs: memo(async () => (await q('SELECT * FROM completion_certificates WHERE deleted_at IS NULL AND project_id = ANY(?::int[]) ORDER BY id')).map(r => ({
        id: r.id, projectId: r.project_id, certificateNumber: r.certificate_number, certificateType: r.certificate_type, status: r.status, completionDate: r.completion_date,
        defectsLiabilityEnd: r.defects_liability_end, contractValue: r.contract_value, finalCost: r.final_cost, outstandingItems: r.outstanding_items }))),
      invoices: memo(() => q('SELECT project_id, status, grand_total FROM invoices WHERE deleted_at IS NULL AND project_id = ANY(?::int[])')),
      vowds: memo(() => q('SELECT project_id, status, approval_status FROM vowd_statements WHERE deleted_at IS NULL AND project_id = ANY(?::int[])')),
      subcontractorFacts: memo(() => loadSubcontractorFacts({ projectIds: idList, vowd: c.allow.vowd, changes: c.allow.changes })),
      approvals: memo(async () => {
        const out = [];
        const kinds = [['vowd', 'vowd_statements', 'vowd_number', c.allow.vowd], ['change_request', 'change_requests', 'cr_code', c.allow.changes], ['certificate', 'completion_certificates', 'certificate_number', c.allow.certificates]];
        for (const [type, table, num, ok] of kinds) {
          if (!ok) continue;
          const cur = f => `(SELECT s.${f} FROM document_approval_steps s WHERE s.doc_type = '${type}' AND s.doc_id = x.id AND s.round = x.approval_round AND s.status = 'Pending' ORDER BY s.step_no LIMIT 1)`;
          const rows = await q(`SELECT x.id, x.project_id, x.${num} AS ref, ${cur('approver_name')} AS approver, ${cur('role_label')} AS role,
            (SELECT MIN(s.submitted_at) FROM document_approval_steps s WHERE s.doc_type = '${type}' AND s.doc_id = x.id AND s.round = x.approval_round) AS submitted_at
            FROM ${table} x WHERE x.deleted_at IS NULL AND x.approval_status = 'Pending' AND x.project_id = ANY(?::int[])`);
          rows.forEach(r => { const sd = r.submitted_at ? String(r.submitted_at).slice(0, 10) : null; out.push({ type, ref: r.ref, projectId: r.project_id, approver: r.approver, role: r.role, submittedDay: sd, ageDays: sd ? diff(sd, today) : null }); });
        }
        return out.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
      }),
      approvalCounts: memo(async () => {
        const out = [];
        for (const [type, table, ok] of [['vowd', 'vowd_statements', c.allow.vowd], ['change_request', 'change_requests', c.allow.changes], ['certificate', 'completion_certificates', c.allow.certificates]]) {
          if (!ok) continue;
          const row = { type };
          (await q(`SELECT approval_status AS s, COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL AND project_id = ANY(?::int[]) GROUP BY 1`)).forEach(r => { row[r.s || 'None'] = r.n; });
          out.push(row);
        }
        return out;
      }),
      auditSummary: memo(() => db.prepare(`SELECT entity_type AS entity, action, COUNT(*) AS n FROM audit_log WHERE LEFT(occurred_at, 10) BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY 3 DESC`).all(period.from, period.to))
    };
    return c;
  }

  /* ---------- generate ---------- */
  const normSpec = b => (Array.isArray(b) ? { key: b[0], opts: b[1] || {} } : { key: b, opts: {} });
  function specsFor(input) {
    const def = input.reportKey !== 'custom' ? REPORTS.find(r => r.key === input.reportKey) : null;
    if (input.reportKey !== 'custom' && !def) throw httpError(400, 'Unknown report');
    let specs;
    if (def) {
      specs = def.blocks.map(normSpec);
      (def.optional || []).forEach(o => { if (input.options.includes(o.key)) specs.push({ key: o.key, opts: {} }); });
    } else {
      const seen = new Set();
      specs = input.blocks.filter(k => BLOCKS[k] && !seen.has(k) && seen.add(k)).map(k => ({ key: k, opts: {} }));
      if (!specs.length) throw httpError(400, 'Choose at least one section for the report');
    }
    return { def, specs };
  }
  function canRun(user, def, specs) {
    const okBlocks = specs.filter(s => userCan(user, BLOCKS[s.key].needs));
    const menuOk = !def || userCan(user, { menus: def.menus });
    return { okBlocks, menuOk, omitted: specs.filter(s => !okBlocks.includes(s)).map(s => ({ title: BLOCKS[s.key].title, reason: 'not available to your login' })) };
  }

  async function generateReport(user, rawInput, meta = {}) {
    const input = cleanInput(rawInput);
    const { def, specs } = specsFor(input);
    const { okBlocks, menuOk, omitted } = canRun(user, def, specs);
    if (!menuOk || !okBlocks.length) throw httpError(403, 'Your login does not have access to the data in this report');
    const today = omanToday();
    const period = resolvePeriod(input.period.preset || (def && def.period) || 'last-month', input.period.from, input.period.to, today);
    if (!period) throw httpError(400, 'Choose a valid period (for custom dates, the end must not be before the start)');
    const resolved = await resolveScope(user, input), visible = resolved.visible;
    let projects = resolved.projects;
    if (!projects.length) throw httpError(400, 'No projects match the selected business units, projects and status');
    if (projects.length > 300) throw httpError(400, 'Too many projects for one report — narrow the selection to 300 or fewer');

    // Subcontractor / event filter: keep only the matching events, and only the projects that have one
    let filter = null, filterLabel = '';
    if (input.subcontractorIds.length || input.eventNames.length) {
      const subs = input.subcontractorIds.length ? await loadEventSubs(projects.map(p => p.id)) : {};
      const kept = PC.filterEvents(await listEvents(projects.map(p => p.id)), subs, input);
      projects = projects.filter(p => kept.some(e => e.projectId === p.id));
      if (!projects.length) throw httpError(400, 'No events match the selected subcontractor / event filter in these projects');
      filter = { subs, subcontractorIds: input.subcontractorIds, eventNames: input.eventNames };
      const nameOf = new Map(Object.values(subs).flat().map(x => [x[0], x[1]]));
      const subText = input.subcontractorIds.map(i => (i === 0 ? 'no subcontractor' : nameOf.get(i) || `#${i}`)).join(', ');
      filterLabel = [subText && `subcontractor: ${subText}`, input.eventNames.length && `event: ${input.eventNames.join(', ')}`].filter(Boolean).join(' · ');
    }
    const c = makeContext(user, projects, period, today, filter);
    const sections = [];
    for (const s of okBlocks) {
      try { sections.push(...await BLOCKS[s.key].build({ ...c, opts: s.opts })); }
      catch (err) {
        console.error(new Date().toISOString(), 'report block failed:', s.key, err);
        sections.push({ kind: 'text', title: BLOCKS[s.key].title, text: 'This section could not be generated because of an internal error. The administrator can find the details in the server log.', tone: 'bad' });
      }
    }

    const bus = await db.prepare('SELECT id, name, logo_path FROM business_units ORDER BY id').all();
    const scopeBus = [...new Set(projects.map(p => p.businessUnitId).filter(Boolean))];
    const brandBu = scopeBus.length === 1 ? bus.find(b => b.id === scopeBus[0]) : bus.find(b => /^nec$/i.test(b.name)) || null;
    const layout = input.layout || (def && def.layout) || 'standard';
    const title = input.title || (def ? def.title : 'Custom report');
    const label = scopeLabel(projects, visible, input) + (filterLabel ? ` — ${filterLabel}` : '');
    const doc = {
      v: 1, key: def ? def.key : 'custom', title, category: def ? def.category : 'Custom', layout, today, generatedAt: new Date().toISOString(),
      generatedBy: user.displayName || user.username, period, scope: { label, projectCount: projects.length, projects: projects.slice(0, 60).map(p => ({ id: p.id, code: p.code, name: p.name, businessUnit: p.businessUnit, status: p.status })),
        businessUnits: [...new Set(projects.map(p => p.businessUnit || 'Unassigned'))], statuses: input.statuses },
      brand: { name: brandBu ? brandBu.name : 'NEC', logoUrl: brandBu && brandBu.logo_path ? `/api/business-units/${brandBu.id}/logo` : null },
      omitted, sections
    };
    const snapshot = JSON.stringify(doc);
    const idList = projects.map(p => p.id).sort((a, b) => a - b);
    const sig = `${doc.key}|${idList.join(',')}|${def ? '' : okBlocks.map(s => s.key).join(',')}${filterLabel ? '|' + filterLabel : ''}`;
    const version = ((await db.prepare('SELECT COUNT(*) AS n FROM report_runs WHERE scope_sig = ?').get(sig)).n || 0) + 1;
    const params = { ...input, blocks: okBlocks.map(s => s.key), omitted: omitted.map(o => o.title), periodResolved: { from: period.from, to: period.to }, allowUsed: [...c.allowUsed] };
    const info = await db.prepare(`INSERT INTO report_runs (report_key, title, category, version, scope_sig, source, schedule_id, definition_id, layout, params, scope_label, project_count,
        period_from, period_to, as_of, generated_by, generated_by_name, snapshot, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(doc.key, title, doc.category, version, sig, meta.source || 'adhoc', meta.scheduleId || null, meta.definitionId || input.definitionId || null,
      layout, JSON.stringify(params), label, projects.length, period.from, period.to, today, user.username, user.displayName || user.username, snapshot, Buffer.byteLength(snapshot));
    const runId = info.lastInsertRowid;
    for (const pid of idList) await db.prepare('INSERT INTO report_run_projects (run_id, project_id) VALUES (?, ?)').run(runId, pid);
    const row = await db.prepare('SELECT id, generated_at FROM report_runs WHERE id = ?').get(runId);
    return { id: runId, ref: refOf(row), title, version, scopeLabel: label, projectCount: projects.length, key: doc.key, source: meta.source || 'adhoc' };
  }

  /* ---------- who may open a stored run ---------- */
  async function canSeeRun(user, row) {
    if (user.isAdmin) return true;
    const outside = await db.prepare('SELECT 1 AS x FROM report_run_projects WHERE run_id = ? AND project_id <> ALL(?::int[]) LIMIT 1').get(row.id, user.projectIds || []);
    if (outside) return false;
    const p = parseJson(row.params, {});
    const def = REPORTS.find(r => r.key === row.report_key);
    if (def && !userCan(user, { menus: def.menus })) return false;
    const mine = allowOf(user);
    if ((p.allowUsed || []).some(k => !mine[k])) return false;
    return (p.blocks || []).every(k => BLOCKS[k] && userCan(user, BLOCKS[k].needs));
  }
  const runMeta = r => ({ id: r.id, ref: refOf(r), key: r.report_key, title: r.title, category: r.category, version: r.version, source: r.source, scheduleId: r.schedule_id, layout: r.layout, scopeLabel: r.scope_label,
    projectCount: r.project_count, periodFrom: r.period_from, periodTo: r.period_to, asOf: r.as_of, generatedBy: r.generated_by_name || r.generated_by, generatedByUser: r.generated_by, generatedAt: r.generated_at,
    sizeKb: Math.max(1, Math.round((r.size_bytes || 0) / 1024)), blocks: parseJson(r.params, {}).blocks || [],
    input: (p => ({ reportKey: r.report_key, definitionId: p.definitionId || null, title: p.title || '', blocks: p.blocks || [], options: p.options || [], layout: r.layout, businessUnitIds: p.businessUnitIds || [],
      projectIds: p.projectIds || [], statuses: p.statuses || [], subcontractorIds: p.subcontractorIds || [], eventNames: p.eventNames || [], period: { preset: 'custom', from: r.period_from, to: r.period_to } }))(parseJson(r.params, {})) });

  function audit(req, action, run, details) {
    return logAudit(req, { action, entityType: 'Report', entityId: run.id, entityLabel: `${run.ref || refOf(run)} · ${run.title}`, details });
  }
  const guard = fn => async (req, res, next) => { try { await fn(req, res); } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); } };

  /* =========================================================
     ROUTES
     ========================================================= */
  app.get('/api/reports/catalogue', guard(async (req, res) => {
    const user = me(req), visible = await visibleProjects(user), unread = await db.prepare('SELECT COUNT(*) AS n FROM report_deliveries WHERE username = ? AND read_at IS NULL').get(user.username);
    const reports = REPORTS.map(r => {
      const specs = r.blocks.map(normSpec), { okBlocks, menuOk } = canRun(user, r, specs);
      const fine = menuOk && okBlocks.length > 0;
      return { key: r.key, category: r.category, icon: r.icon, title: r.title, tag: r.tag, description: r.description, audience: r.audience, layout: r.layout, period: r.period, optional: (r.optional || []).filter(o => userCan(user, BLOCKS[o.key].needs)),
        sections: specs.map(s => BLOCKS[s.key].title), available: fine, reason: fine ? '' : 'Needs access to ' + (menuOk ? 'the data in this report' : 'the matching page in the sidebar') };
    });
    const blocks = Object.values(BLOCKS).map(b => ({ key: b.key, group: b.group, title: b.title, description: b.description, available: userCan(user, b.needs) }));
    const buCount = {}; visible.forEach(p => { const k = p.businessUnitId || 0; buCount[k] = (buCount[k] || 0) + 1; });
    const buRows = await db.prepare('SELECT id, name, logo_path IS NOT NULL AS logo FROM business_units ORDER BY name').all();
    const businessUnits = buRows.filter(b => buCount[b.id]).map(b => ({ id: b.id, name: b.name, projectCount: buCount[b.id], logo: !!b.logo }));
    if (buCount[0]) businessUnits.push({ id: 0, name: 'Unassigned', projectCount: buCount[0] });
    res.json({ reports, blocks, layouts: LAYOUTS, periods: PERIODS, projects: visible, businessUnits, statuses: [...new Set(visible.map(p => p.status))].sort(), unread: unread.n,
      isAdmin: user.isAdmin, today: omanToday() });
  }));

  app.post('/api/reports/runs', guard(async (req, res) => {
    const user = me(req), run = await generateReport(user, req.body);
    await audit(req, 'report-generated', run, { report: run.key, scope: run.scopeLabel, projects: run.projectCount, version: run.version });
    res.status(201).json(run);
  }));

  app.get('/api/reports/runs', guard(async (req, res) => {
    const user = me(req), qy = req.query, where = ['TRUE'], params = [user.username];
    if (!user.isAdmin) { where.push('NOT EXISTS (SELECT 1 FROM report_run_projects rp WHERE rp.run_id = r.id AND rp.project_id <> ALL(?::int[]))'); params.push(user.projectIds || []); }
    if (qy.q) { where.push('(r.title ILIKE ? OR r.scope_label ILIKE ? OR r.generated_by_name ILIKE ?)'); const t = `%${clean(qy.q, 60).replace(/[%_]/g, '')}%`; params.push(t, t, t); }
    if (qy.reportKey) { where.push('r.report_key = ?'); params.push(clean(qy.reportKey, 40)); }
    if (qy.source === 'adhoc' || qy.source === 'scheduled') { where.push('r.source = ?'); params.push(qy.source); }
    if (qy.projectId && Number(qy.projectId)) { where.push('EXISTS (SELECT 1 FROM report_run_projects rp2 WHERE rp2.run_id = r.id AND rp2.project_id = ?)'); params.push(Number(qy.projectId)); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(qy.from || '')) { where.push('LEFT(r.generated_at, 10) >= ?'); params.push(qy.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(qy.to || '')) { where.push('LEFT(r.generated_at, 10) <= ?'); params.push(qy.to); }
    if (qy.mine === '1') { where.push('r.generated_by = ?'); params.push(user.username); }
    if (qy.inbox === '1') where.push('d.run_id IS NOT NULL');
    const rows = await db.prepare(`SELECT r.id, r.report_key, r.title, r.category, r.version, r.source, r.schedule_id, r.layout, r.params, r.scope_label, r.project_count, r.period_from, r.period_to, r.as_of,
        r.generated_by, r.generated_by_name, r.generated_at, r.size_bytes, d.run_id IS NOT NULL AS delivered, d.read_at AS read_at
      FROM report_runs r LEFT JOIN report_deliveries d ON d.run_id = r.id AND d.username = ?
      WHERE ${where.join(' AND ')} ORDER BY r.generated_at DESC, r.id DESC LIMIT 600`).all(...params);
    const seen = [];
    for (const r of rows) if (await canSeeRun(user, r)) seen.push({ ...runMeta(r), delivered: !!r.delivered, unread: !!r.delivered && !r.read_at });
    const limit = Math.min(200, Number(qy.limit) || 50), offset = Math.max(0, Number(qy.offset) || 0);
    res.json({ total: seen.length, runs: seen.slice(offset, offset + limit) });
  }));

  async function loadRun(req, withSnapshot) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw httpError(404, 'Report not found');
    const row = await db.prepare(`SELECT * FROM report_runs WHERE id = ?`).get(id);
    if (!row || !(await canSeeRun(me(req), row))) throw httpError(404, 'Report not found'); // not "forbidden": do not reveal that it exists
    return row;
  }
  app.get('/api/reports/runs/:id', guard(async (req, res) => {
    const user = me(req), row = await loadRun(req);
    await db.prepare('UPDATE report_deliveries SET read_at = utc_now_text() WHERE run_id = ? AND username = ? AND read_at IS NULL').run(row.id, user.username);
    await audit(req, 'report-viewed', row, { report: row.report_key, version: row.version });
    res.json({ meta: runMeta(row), doc: parseJson(row.snapshot, null) });
  }));
  app.post('/api/reports/runs/:id/log', guard(async (req, res) => {
    const row = await loadRun(req), action = { print: 'report-printed', pdf: 'report-printed' }[clean(req.body && req.body.action, 12)];
    if (!action) throw httpError(400, 'Unknown action');
    await audit(req, action, row, { report: row.report_key, version: row.version });
    res.json({ ok: true });
  }));
  app.get('/api/reports/runs/:id/excel', guard(async (req, res) => {
    const row = await loadRun(req), doc = parseJson(row.snapshot, null);
    if (!doc) throw httpError(500, 'This report could not be read');
    const wb = await buildWorkbook(doc, { ref: refOf(row), version: row.version });
    await audit(req, 'report-downloaded', row, { report: row.report_key, version: row.version, format: 'Excel' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${refOf(row)}-${doc.key}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }));

  /* ---------- saved custom reports ---------- */
  const defRow = r => ({ id: r.id, name: r.name, description: r.description, blocks: parseJson(r.blocks, []), params: parseJson(r.params, {}), shared: !!r.is_shared, owner: r.owner, ownerName: r.owner_name, updatedAt: r.updated_at });
  function defBody(b) {
    const input = cleanInput({ ...b.params, blocks: b.blocks, reportKey: 'custom' });
    const blocks = input.blocks.filter(k => BLOCKS[k]);
    if (!clean(b.name, 80)) throw httpError(400, 'Give the report a name');
    if (!blocks.length) throw httpError(400, 'Choose at least one section');
    return { name: clean(b.name, 80), description: clean(b.description, 300), blocks,
      params: { layout: input.layout, businessUnitIds: input.businessUnitIds, projectIds: input.projectIds, statuses: input.statuses, period: input.period, title: input.title }, shared: b.shared ? 1 : 0 };
  }
  app.get('/api/reports/definitions', guard(async (req, res) => {
    const user = me(req);
    res.json((await db.prepare('SELECT * FROM report_definitions WHERE is_shared = 1 OR owner = ? ORDER BY name').all(user.username)).map(defRow));
  }));
  app.post('/api/reports/definitions', guard(async (req, res) => {
    const user = me(req), b = defBody(req.body || {});
    const info = await db.prepare('INSERT INTO report_definitions (name, description, blocks, params, is_shared, owner, owner_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.name, b.description, JSON.stringify(b.blocks), JSON.stringify(b.params), b.shared, user.username, user.displayName || user.username);
    res.status(201).json(defRow(await db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(info.lastInsertRowid)));
  }));
  async function ownDef(req) {
    const user = me(req), row = await db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(Number(req.params.id));
    if (!row || (!user.isAdmin && row.owner !== user.username && !row.is_shared)) throw httpError(404, 'Saved report not found');
    return { user, row, mine: user.isAdmin || row.owner === user.username };
  }
  app.put('/api/reports/definitions/:id', guard(async (req, res) => {
    const { row, mine } = await ownDef(req); if (!mine) throw httpError(403, 'Only the person who saved this report (or the administrator) can change it');
    const b = defBody(req.body || {});
    await db.prepare('UPDATE report_definitions SET name = ?, description = ?, blocks = ?, params = ?, is_shared = ?, updated_at = utc_now_text() WHERE id = ?')
      .run(b.name, b.description, JSON.stringify(b.blocks), JSON.stringify(b.params), b.shared, row.id);
    res.json(defRow(await db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(row.id)));
  }));
  app.delete('/api/reports/definitions/:id', guard(async (req, res) => {
    const { row, mine } = await ownDef(req); if (!mine) throw httpError(403, 'Only the person who saved this report (or the administrator) can delete it');
    const used = await db.prepare('SELECT COUNT(*) AS n FROM report_schedules WHERE definition_id = ?').get(row.id);
    if (used.n) throw httpError(409, `This saved report is used by ${used.n} schedule${used.n > 1 ? 's' : ''} — delete or change those first`);
    await db.prepare('DELETE FROM report_definitions WHERE id = ?').run(row.id);
    res.json({ ok: true });
  }));

  /* ---------- schedules ---------- */
  function nextRunAt(s, afterMs) {
    const [hh, mm] = String(s.run_time || '07:00').split(':').map(Number);
    const local = new Date(afterMs + OMAN_MS); // read as UTC fields = the clock in Oman
    for (let i = 0; i <= 62; i++) {
      const dt = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i, hh, mm, 0));
      let ok = s.frequency === 'daily';
      if (s.frequency === 'weekly') ok = (dt.getUTCDay() + 6) % 7 === s.weekday;
      if (s.frequency === 'monthly') { const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(); ok = dt.getUTCDate() === (s.month_day === 0 ? last : Math.min(s.month_day, last)); }
      const utc = dt.getTime() - OMAN_MS;
      if (ok && utc > afterMs) return new Date(utc).toISOString();
    }
    return null;
  }
  const FREQ = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  function whenText(s) {
    const t = s.run_time;
    if (s.frequency === 'weekly') return `Every ${DAYS[s.weekday]} at ${t}`;
    if (s.frequency === 'monthly') return s.month_day === 0 ? `Last day of every month at ${t}` : `Day ${s.month_day} of every month at ${t}`;
    return `Every day at ${t}`;
  }
  async function scheduleInput(s) { // what generateReport() needs, from a schedule row
    const p = parseJson(s.params, {}), input = { ...p, reportKey: s.report_key };
    if (s.report_key === 'custom') {
      const def = s.definition_id ? await db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(s.definition_id) : null;
      if (!def) throw httpError(409, 'The saved report this schedule uses has been deleted');
      const dp = parseJson(def.params, {});
      Object.assign(input, { blocks: parseJson(def.blocks, []), layout: p.layout || dp.layout, title: p.title || dp.title || def.name });
      ['businessUnitIds', 'projectIds', 'statuses'].forEach(k => { if (!(p[k] || []).length) input[k] = dp[k] || []; });
      if (!p.period || !p.period.preset) input.period = dp.period;
    }
    return input;
  }
  async function schedRow(s, user) {
    const names = {};
    (await db.prepare(`SELECT ua.username, tm.name FROM user_accounts ua JOIN team_members tm ON tm.id = ua.team_member_id`).all()).forEach(a => { names[a.username.toLowerCase()] = a.name; });
    const rec = parseJson(s.recipients, []);
    const p = parseJson(s.params, {});
    const def = REPORTS.find(r => r.key === s.report_key);
    return { id: s.id, name: s.name, reportKey: s.report_key, definitionId: s.definition_id, reportTitle: def ? def.title : 'Custom report', frequency: s.frequency, weekday: s.weekday, monthDay: s.month_day, runTime: s.run_time,
      when: whenText(s), recipients: rec.map(u => ({ username: u, name: names[String(u).toLowerCase()] || u })), active: !!s.active, nextRunAt: s.active ? s.next_run_at : null, lastRunAt: s.last_run_at, lastRunId: s.last_run_id, lastError: s.last_error,
      createdBy: s.created_by_name || s.created_by, mine: user.isAdmin || s.created_by === user.username, params: p };
  }
  async function checkRecipients(creator, input, recipients) { // every recipient must be able to see everything the schedule will contain
    const { projects } = await resolveScope(creator, input);
    if (!projects.length) throw httpError(400, 'No projects match this scope');
    const { def, specs } = specsFor(input), { okBlocks } = canRun(creator, def, specs), problems = [];
    for (const u of recipients) {
      const acct = await accountUser(u);
      if (!acct) { problems.push(`${u} has no active login`); continue; }
      const noAccess = projects.filter(p => !(acct.projectIds || []).includes(p.id));
      if (noAccess.length) { problems.push(`${acct.displayName} cannot see ${noAccess.length === 1 ? noAccess[0].name : noAccess.length + ' of these projects'}`); continue; }
      const missing = okBlocks.filter(s => !userCan(acct, BLOCKS[s.key].needs)), mine = allowOf(acct), theirs = allowOf(creator);
      const lacks = Object.keys(theirs).filter(k => theirs[k] && !mine[k]);
      if (missing.length || lacks.length || (def && !userCan(acct, { menus: def.menus }))) problems.push(`${acct.displayName} does not have access to ${missing.length ? missing.map(s => BLOCKS[s.key].title).join(', ') : lacks.length ? 'all the data in this report (' + lacks.join(', ') + ')' : 'this report'}`);
    }
    return problems;
  }
  async function scheduleBody(req, existing) {
    const user = me(req), b = req.body || {};
    const name = clean(b.name, 100); if (!name) throw httpError(400, 'Give the schedule a name');
    const reportKey = clean(b.reportKey, 40) || 'custom';
    let definitionId = null;
    if (reportKey === 'custom') {
      definitionId = Number(b.definitionId) || null;
      const def = definitionId ? await db.prepare('SELECT id FROM report_definitions WHERE id = ? AND (is_shared = 1 OR owner = ? OR ?)').get(definitionId, user.username, !!user.isAdmin) : null;
      if (!def) throw httpError(400, 'Choose a saved custom report to schedule');
    } else if (!REPORTS.some(r => r.key === reportKey)) throw httpError(400, 'Unknown report');
    const frequency = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : null; if (!frequency) throw httpError(400, 'Choose how often the report runs');
    const runTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.runTime || '') ? b.runTime : '07:00';
    const weekday = frequency === 'weekly' ? Math.min(6, Math.max(0, Number(b.weekday) || 0)) : null;
    const monthDay = frequency === 'monthly' ? (Number(b.monthDay) === 0 ? 0 : Math.min(28, Math.max(1, Number(b.monthDay) || 1))) : null;
    const input = cleanInput({ ...b.params, reportKey, blocks: [], definitionId });
    if (input.period.preset === 'custom') input.period.preset = 'last-month'; // a schedule needs a moving period
    const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : []).map(u => clean(u, 80).toLowerCase()).filter(Boolean))].slice(0, 50);
    const full = reportKey === 'custom' ? await scheduleInput({ report_key: reportKey, definition_id: definitionId, params: JSON.stringify(input) }) : input;
    const { def, specs } = specsFor(full);
    const can = canRun(user, def, specs); if (!can.menuOk || !can.okBlocks.length) throw httpError(403, 'Your login does not have access to the data in this report');
    const problems = await checkRecipients(user, full, recipients);
    if (problems.length) throw httpError(400, 'Some recipients cannot receive this report: ' + problems.join('; ') + '.');
    return { name, reportKey, definitionId, frequency, runTime, weekday, monthDay, recipients,
      params: { businessUnitIds: input.businessUnitIds, projectIds: input.projectIds, statuses: input.statuses, layout: input.layout, options: input.options, period: { preset: input.period.preset || (def && def.period) || 'last-month' }, title: input.title } };
  }
  app.get('/api/reports/schedules', guard(async (req, res) => {
    const user = me(req), rows = await db.prepare('SELECT * FROM report_schedules ORDER BY name').all();
    const mine = rows.filter(s => user.isAdmin || s.created_by === user.username || parseJson(s.recipients, []).some(u => String(u).toLowerCase() === user.username.toLowerCase()));
    res.json(await Promise.all(mine.map(s => schedRow(s, user))));
  }));
  app.post('/api/reports/schedules/recipients', guard(async (req, res) => {
    const user = me(req), b = req.body || {}, reportKey = clean(b.reportKey, 40) || 'custom';
    const input = cleanInput({ ...b.params, reportKey, blocks: [], definitionId: b.definitionId });
    const full = reportKey === 'custom' ? await scheduleInput({ report_key: reportKey, definition_id: Number(b.definitionId) || null, params: JSON.stringify(input) }) : input;
    const { projects } = await resolveScope(user, full), { def, specs } = specsFor(full), { okBlocks } = canRun(user, def, specs);
    const accounts = await db.prepare(`SELECT ua.username, tm.name FROM user_accounts ua JOIN team_members tm ON tm.id = ua.team_member_id WHERE ua.active = 1 ORDER BY tm.name`).all();
    const out = [];
    for (const a of accounts) {
      const acct = await accountUser(a.username); let reason = '';
      if (acct) {
        const no = projects.filter(p => !(acct.projectIds || []).includes(p.id));
        if (no.length) reason = `No access to ${no.length === 1 ? no[0].name : no.length + ' of the projects'}`;
        else if ((def && !userCan(acct, { menus: def.menus })) || okBlocks.some(s => !userCan(acct, BLOCKS[s.key].needs)) || Object.entries(allowOf(user)).some(([k, v]) => v && !allowOf(acct)[k])) reason = 'No access to the data in this report';
      }
      out.push({ username: a.username, name: a.name, eligible: !!acct && !reason, reason });
    }
    res.json(out);
  }));
  app.post('/api/reports/schedules', guard(async (req, res) => {
    const user = me(req), s = await scheduleBody(req);
    const row0 = { run_time: s.runTime, frequency: s.frequency, weekday: s.weekday, month_day: s.monthDay };
    const info = await db.prepare(`INSERT INTO report_schedules (name, report_key, definition_id, params, frequency, weekday, month_day, run_time, recipients, active, next_run_at, created_by, created_by_name, created_by_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(s.name, s.reportKey, s.definitionId, JSON.stringify(s.params), s.frequency, s.weekday, s.monthDay, s.runTime, JSON.stringify(s.recipients),
      nextRunAt(row0, Date.now()), user.username, user.displayName || user.username, user.isAdmin ? 1 : 0);
    await logAudit(req, { action: 'report-schedule-created', entityType: 'Report', entityId: info.lastInsertRowid, entityLabel: `Schedule · ${s.name}`, details: { report: s.reportKey, when: whenText({ ...row0, run_time: s.runTime }), recipients: s.recipients } });
    res.status(201).json(await schedRow(await db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(info.lastInsertRowid), user));
  }));
  async function ownSchedule(req) {
    const user = me(req), row = await db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(Number(req.params.id));
    if (!row) throw httpError(404, 'Schedule not found');
    if (!user.isAdmin && row.created_by !== user.username) throw httpError(403, 'Only the person who created this schedule (or the administrator) can change it');
    return { user, row };
  }
  app.put('/api/reports/schedules/:id', guard(async (req, res) => {
    const { user, row } = await ownSchedule(req), s = await scheduleBody(req, row);
    const active = req.body.active === false ? 0 : 1, row0 = { run_time: s.runTime, frequency: s.frequency, weekday: s.weekday, month_day: s.monthDay };
    await db.prepare(`UPDATE report_schedules SET name = ?, report_key = ?, definition_id = ?, params = ?, frequency = ?, weekday = ?, month_day = ?, run_time = ?, recipients = ?, active = ?, next_run_at = ?, last_error = NULL, updated_at = utc_now_text() WHERE id = ?`)
      .run(s.name, s.reportKey, s.definitionId, JSON.stringify(s.params), s.frequency, s.weekday, s.monthDay, s.runTime, JSON.stringify(s.recipients), active, active ? nextRunAt(row0, Date.now()) : null, row.id);
    await logAudit(req, { action: 'report-schedule-changed', entityType: 'Report', entityId: row.id, entityLabel: `Schedule · ${s.name}`, details: { active: !!active, when: whenText({ ...row0, run_time: s.runTime }), recipients: s.recipients } });
    res.json(await schedRow(await db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(row.id), user));
  }));
  app.post('/api/reports/schedules/:id/pause', guard(async (req, res) => {
    const { user, row } = await ownSchedule(req), on = req.body && req.body.active === true;
    await db.prepare('UPDATE report_schedules SET active = ?, next_run_at = ?, updated_at = utc_now_text() WHERE id = ?').run(on ? 1 : 0, on ? nextRunAt(row, Date.now()) : null, row.id);
    await logAudit(req, { action: on ? 'report-schedule-resumed' : 'report-schedule-paused', entityType: 'Report', entityId: row.id, entityLabel: `Schedule · ${row.name}` });
    res.json(await schedRow(await db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(row.id), user));
  }));
  app.delete('/api/reports/schedules/:id', guard(async (req, res) => {
    const { row } = await ownSchedule(req);
    await db.prepare('DELETE FROM report_schedules WHERE id = ?').run(row.id);
    await logAudit(req, { action: 'report-schedule-deleted', entityType: 'Report', entityId: row.id, entityLabel: `Schedule · ${row.name}` });
    res.json({ ok: true });
  }));
  app.post('/api/reports/schedules/:id/run', guard(async (req, res) => { // "run now": same as a scheduled run, without moving the next date
    const { user, row } = await ownSchedule(req), run = await runSchedule(row, { manual: true, req });
    res.status(201).json({ ...run, schedule: await schedRow(await db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(row.id), user) });
  }));

  async function runSchedule(s, o = {}) {
    const creator = s.created_by_admin ? { username: s.created_by, isAdmin: true, displayName: s.created_by_name || s.created_by, projectIds: [], menus: [], permissions: {} } : await accountUser(s.created_by);
    try {
      if (!creator) throw httpError(409, `The login that created this schedule (${s.created_by}) is switched off or removed`);
      const input = await scheduleInput(s);
      const run = await generateReport(creator, input, { source: 'scheduled', scheduleId: s.id, definitionId: s.definition_id });
      for (const u of parseJson(s.recipients, [])) await db.prepare('INSERT INTO report_deliveries (run_id, username, schedule_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(run.id, u, s.id);
      await db.prepare('UPDATE report_schedules SET last_run_at = utc_now_text(), last_run_id = ?, last_error = NULL WHERE id = ?').run(run.id, s.id);
      const stub = o.req || { session: { username: s.created_by }, headers: {}, socket: {}, method: 'SCHEDULE', originalUrl: 'scheduler' };
      await logAudit(stub, { action: 'report-generated', username: creator.username, entityType: 'Report', entityId: run.id, entityLabel: `${run.ref} · ${run.title}`,
        details: { report: run.key, scope: run.scopeLabel, projects: run.projectCount, scheduled: s.name, recipients: parseJson(s.recipients, []) } });
      return run;
    } catch (err) {
      await db.prepare('UPDATE report_schedules SET last_error = ?, last_run_at = utc_now_text() WHERE id = ?').run(String(err.message || err).slice(0, 300), s.id);
      if (o.manual) throw err;
      console.error(new Date().toISOString(), `scheduled report "${s.name}" failed:`, err.message);
      return null;
    }
  }
  async function schedulerTick() {
    const due = await db.prepare(`SELECT * FROM report_schedules WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 20`).all(new Date().toISOString());
    for (const s of due) {
      // Move the next date forward first (and only proceed if this process won the update), so a restart or a second server
      // never runs the same slot twice, and a missed slot runs once — not once per missed day.
      const claim = await db.prepare('UPDATE report_schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?').run(nextRunAt(s, Date.now()), s.id, s.next_run_at);
      if (claim.changes) await runSchedule(s);
    }
  }
  if (process.env.REPORT_SCHEDULER !== 'off') {
    let busy = false;
    const loop = () => { if (busy) return; busy = true; schedulerTick().catch(e => console.error(new Date().toISOString(), 'report scheduler:', e.message)).finally(() => { busy = false; }); };
    setTimeout(loop, 15000).unref();
    setInterval(loop, 60000).unref();
  }

  /* ---------- inbox & access log ---------- */
  app.get('/api/reports/inbox', guard(async (req, res) => {
    const user = me(req);
    const rows = await db.prepare(`SELECT r.id, r.report_key, r.title, r.category, r.version, r.source, r.schedule_id, r.layout, r.params, r.scope_label, r.project_count, r.period_from, r.period_to, r.as_of,
        r.generated_by, r.generated_by_name, r.generated_at, r.size_bytes, d.read_at FROM report_deliveries d JOIN report_runs r ON r.id = d.run_id
      WHERE d.username = ? AND d.read_at IS NULL ORDER BY r.generated_at DESC LIMIT 30`).all(user.username);
    const out = []; for (const r of rows) if (await canSeeRun(user, r)) out.push(runMeta(r));
    res.json({ unread: out.length, runs: out });
  }));
  app.get('/api/reports/access-log', guard(async (req, res) => {
    const user = me(req); if (!user.isAdmin) throw httpError(403, 'Only the administrator can see the report access log');
    const qy = req.query, where = [`a.entity_type = 'Report'`], params = [];
    if (qy.q) { where.push('(a.entity_label ILIKE ? OR a.username ILIKE ?)'); const t = `%${clean(qy.q, 60).replace(/[%_]/g, '')}%`; params.push(t, t); }
    if (qy.user) { where.push('a.username = ?'); params.push(clean(qy.user, 80)); }
    if (qy.action) { where.push('a.action = ?'); params.push(clean(qy.action, 40)); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(qy.from || '')) { where.push('LEFT(a.occurred_at, 10) >= ?'); params.push(qy.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(qy.to || '')) { where.push('LEFT(a.occurred_at, 10) <= ?'); params.push(qy.to); }
    const limit = Math.min(200, Number(qy.limit) || 50), offset = Math.max(0, Number(qy.offset) || 0);
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${where.join(' AND ')}`).get(...params)).n;
    const rows = await db.prepare(`SELECT a.id, a.occurred_at, a.username, a.ip_address, a.action, a.entity_id, a.entity_label, a.details FROM audit_log a WHERE ${where.join(' AND ')} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const users = (await db.prepare(`SELECT DISTINCT username FROM audit_log WHERE entity_type = 'Report' AND username IS NOT NULL ORDER BY username`).all()).map(r => r.username);
    res.json({ total, users, rows: rows.map(r => ({ id: r.id, at: r.occurred_at, user: r.username, ip: r.ip_address, action: r.action, runId: r.entity_id, label: r.entity_label, details: parseJson(r.details, null) })) });
  }));

  return { generateReport, nextRunAt };
};
