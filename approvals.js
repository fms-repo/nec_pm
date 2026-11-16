/* =========================================================
   DOCUMENT APPROVALS — VOWD statements, change requests, completion certificates

   Lifecycle (documents.approval_status):
     None ──submit──▶ Pending ──every approver signs, in order──▶ Approved
                         │                                         (content stays locked)
                         ├─ an approver rejects (comment required) ─▶ Rejected ─edit─▶ submit again (new round)
                         └─ withdrawn by the submitter / administrator ─▶ None
   An administrator can reopen an Approved document (reason required, audit-logged).

   Rules enforced here, on the server, regardless of what the browser sends:
     · only the assigned approver, signed in with their own account, can sign their step — the
       shared administrator login can't sign on anyone's behalf;
     · steps are signed strictly in order;
     · content (and its CR analyses / decisions) can't be edited or deleted while Pending or Approved;
     · every submit / approve / reject / withdraw / reopen is written to the audit log.
   Every step is kept for good: who, when, comment, IP. A resubmission starts a new round.
   ========================================================= */
const express = require('express');

// roles = the signature blocks on that document's print preview, in signing order.
const DOC_TYPES = {
  vowd: {
    table: 'vowd_statements', label: 'VOWD Statement', numberCol: 'vowd_number', print: id => `/vowd-print.html?id=${id}`,
    titleSql: 'COALESCE(d.contractor_name, d.project_title)',
    roles: [
      { key: 'project_manager', label: 'Prepared By' },
      { key: 'supply_chain', label: 'Reviewed By' },
      { key: 'director', label: 'Approved By' }
    ]
  },
  change_request: {
    table: 'change_requests', label: 'Change Request', numberCol: 'cr_code', print: id => `/change-request-print.html?id=${id}`,
    titleSql: 'd.description',
    roles: [
      { key: 'submitter', label: 'Prepared By' },
      { key: 'reviewer', label: 'Reviewed By' },
      { key: 'ccb', label: 'Approved By' }
    ]
  },
  certificate: {
    table: 'completion_certificates', label: 'Completion Certificate', numberCol: 'certificate_number', print: id => `/certificate-print.html?id=${id}`,
    titleSql: "d.certificate_type || ' certificate'",
    roles: [
      { key: 'engineer', label: 'Prepared By' },
      { key: 'supply_chain', label: 'Reviewed By' },
      { key: 'client_rep', label: 'Approved By' }
    ]
  }
};

const LOCKED_STATUSES = ['Pending', 'Approved'];
const lockedMessage = status => (status === 'Pending'
  ? 'This document is awaiting approval and is locked. Withdraw it from approval first if it needs changing.'
  : 'This document has been approved and is locked. An administrator can reopen it for revision.');

module.exports = function registerApprovals(app, { db, logAudit, sessionUser, requireAdmin, clientIp }) {
  const bad = (res, msg) => res.status(400).json({ error: msg });
  const clip = (v, n = 1000) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

  async function loadDoc(type, id, { forUpdate = false } = {}) {
    const t = DOC_TYPES[type];
    if (!t || !/^\d+$/.test(String(id))) return null;
    return (await db.prepare(`
      SELECT d.*, d.${t.numberCol} AS number, p.code AS project_code, p.name AS project_name
      FROM ${t.table} d JOIN projects p ON p.id = d.project_id AND p.deleted_at IS NULL
      WHERE d.id = ? AND d.deleted_at IS NULL${forUpdate ? ' FOR UPDATE OF d' : ''}`).get(id)) || null;
  }

  const serializeStep = s => ({
    id: s.id, round: s.round, stepNo: s.step_no, roleKey: s.role_key, roleLabel: s.role_label,
    teamMemberId: s.team_member_id, name: s.approver_name, designation: s.approver_designation, status: s.status,
    submittedAt: s.submitted_at, submittedBy: s.submitted_by, actedAt: s.acted_at, actedBy: s.acted_by, comment: s.comment
  });

  async function loadState(type, doc, user) {
    const t = DOC_TYPES[type];
    const steps = (await db.prepare('SELECT * FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? ORDER BY round, step_no, id').all(type, doc.id)).map(serializeStep);
    const status = doc.approval_status, round = doc.approval_round;
    const current = round > 0 ? steps.filter(s => s.round === round) : [];
    const active = status === 'Pending' ? current.find(s => s.status === 'Pending') || null : null;
    const rounds = {};
    steps.filter(s => s.round > 0 && s.round !== (status === 'Pending' || status === 'Approved' ? round : -1)).forEach(s => { (rounds[s.round] ||= []).push(s); });
    return {
      docType: type, docId: doc.id, docLabel: t.label, number: doc.number, projectId: doc.project_id,
      projectCode: doc.project_code, projectName: doc.project_name, printUrl: t.print(doc.id),
      status, round, locked: LOCKED_STATUSES.includes(status), roles: t.roles,
      // assignments being prepared (not yet submitted), or — after a rejection / withdrawal — carried over for resubmission
      draft: steps.filter(s => s.round === 0),
      // the round currently in force (Pending or Approved)
      current: status === 'Pending' || status === 'Approved' ? current : [],
      // the round that was rejected, shown while the document is back with its author
      lastRejected: status === 'Rejected' ? steps.filter(s => s.round === round) : [],
      history: Object.keys(rounds).sort((a, b) => a - b).map(r => ({ round: +r, steps: rounds[r] })),
      activeStepId: active ? active.id : null,
      canAct: !!(active && user.userType === 'user' && user.teamMemberId === active.teamMemberId),
      waitingOn: active ? { name: active.name, roleLabel: active.roleLabel } : null
    };
  }

  const stepAudit = (req, type, doc, action, details) => logAudit(req, {
    action, entityType: DOC_TYPES[type].label, entityId: doc.id, entityLabel: doc.number, projectId: doc.project_id, details
  });

  // Copies a finished/abandoned round's assignments back as an editable draft (round 0), so a
  // rejected / withdrawn / reopened document can be corrected and resubmitted to the same people.
  async function carryOverAssignments(type, doc, fromRound) {
    await db.prepare('DELETE FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = 0').run(type, doc.id);
    await db.prepare(`
      INSERT INTO document_approval_steps (project_id, doc_type, doc_id, round, step_no, role_key, role_label, team_member_id, approver_name, approver_designation, status)
      SELECT project_id, doc_type, doc_id, 0, step_no, role_key, role_label, team_member_id, approver_name, approver_designation, 'Draft'
      FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = ?`).run(type, doc.id, fromRound);
  }

  /* ---- lock: no edits / deletes while a document is Pending or Approved ---- */
  const LOCK_ROUTES = [
    { re: /^\/api\/vowd-statements\/(\d+)$/, methods: ['PUT', 'DELETE'], type: 'vowd' },
    { re: /^\/api\/certificates\/(\d+)$/, methods: ['PUT', 'DELETE'], type: 'certificate' },
    { re: /^\/api\/change-requests\/(\d+)$/, methods: ['PUT', 'DELETE'], type: 'change_request' },
    { re: /^\/api\/change-requests\/(\d+)\/(analyses|decisions)$/, methods: ['POST'], type: 'change_request' },
    { re: /^\/api\/change-(analyses|decisions)\/(\d+)$/, methods: ['PUT', 'DELETE'], type: 'change_request', child: true }
  ];
  app.use(async (req, res, next) => {
    if (req.method === 'GET' || !req.path.startsWith('/api/')) return next();
    for (const r of LOCK_ROUTES) {
      const m = r.re.exec(req.path);
      if (!m || !r.methods.includes(req.method)) continue;
      let status;
      if (r.child) {
        const table = m[1] === 'analyses' ? 'change_analyses' : 'change_decisions';
        const row = await db.prepare(`SELECT cr.approval_status FROM ${table} c JOIN change_requests cr ON cr.id = c.change_request_id WHERE c.id = ?`).get(m[2]);
        status = row && row.approval_status;
      } else {
        const row = await db.prepare(`SELECT approval_status FROM ${DOC_TYPES[r.type].table} WHERE id = ?`).get(m[1]);
        status = row && row.approval_status;
      }
      if (LOCKED_STATUSES.includes(status)) return res.status(423).json({ error: lockedMessage(status), code: 'DOCUMENT_LOCKED' });
      break;
    }
    next();
  });

  /* ---- people who can be chosen as approvers: team members with an active personal account ---- */
  app.get('/api/approvals/approvers', async (req, res) => {
    res.json((await db.prepare(`
      SELECT tm.id, tm.name, tm.designation, tm.department
      FROM user_accounts ua JOIN team_members tm ON tm.id = ua.team_member_id
      WHERE ua.active = 1 ORDER BY tm.name, tm.id`).all()).map(r => ({
      teamMemberId: r.id, name: r.name, designation: r.designation, department: r.department
    })));
  });

  /* ---- the signed-in person's worklist ---- */
  const myApprovalsSql = (type, extra) => {
    const t = DOC_TYPES[type];
    return `SELECT s.id AS step_id, s.step_no, s.role_label, s.round, s.submitted_at, s.submitted_by, s.status AS step_status, s.acted_at, s.comment,
        d.id AS doc_id, d.${t.numberCol} AS number, ${t.titleSql} AS title, d.approval_status,
        p.id AS project_id, p.code AS project_code, p.name AS project_name,
        (SELECT s2.approver_name FROM document_approval_steps s2 WHERE s2.doc_type = s.doc_type AND s2.doc_id = s.doc_id AND s2.round = s.round
           AND s2.status = 'Pending' ORDER BY s2.step_no LIMIT 1) AS active_name,
        NOT EXISTS (SELECT 1 FROM document_approval_steps s3 WHERE s3.doc_type = s.doc_type AND s3.doc_id = s.doc_id AND s3.round = s.round
           AND s3.status = 'Pending' AND s3.step_no < s.step_no) AS my_turn
      FROM document_approval_steps s
      JOIN ${t.table} d ON d.id = s.doc_id AND d.deleted_at IS NULL
      JOIN projects p ON p.id = d.project_id AND p.deleted_at IS NULL
      WHERE s.doc_type = '${type}' ${extra}`;
  };
  const shapeItem = (type, r) => ({
    docType: type, docLabel: DOC_TYPES[type].label, docId: r.doc_id, stepId: r.step_id, number: r.number,
    title: r.title ? String(r.title).slice(0, 140) : null, projectId: r.project_id, projectCode: r.project_code, projectName: r.project_name,
    roleLabel: r.role_label, round: r.round, submittedAt: r.submitted_at, submittedBy: r.submitted_by,
    myTurn: !!r.my_turn, stepStatus: r.step_status, actedAt: r.acted_at, comment: r.comment, waitingOn: r.active_name, printUrl: DOC_TYPES[type].print(r.doc_id)
  });
  async function awaitingFor(teamMemberId) {
    const out = [];
    for (const type of Object.keys(DOC_TYPES)) {
      const rows = await db.prepare(myApprovalsSql(type, `AND s.team_member_id = ? AND s.status = 'Pending' AND d.approval_status = 'Pending' AND d.approval_round = s.round`)).all(teamMemberId);
      rows.forEach(r => out.push(shapeItem(type, r)));
    }
    return out;
  }
  app.get('/api/my-approvals', async (req, res) => {
    const user = sessionUser(req);
    if (user.userType !== 'user') {
      // The shared administrator login has no approvals of its own: show what is in flight, read-only.
      const overview = [];
      for (const type of Object.keys(DOC_TYPES)) {
        (await db.prepare(myApprovalsSql(type, `AND s.status = 'Pending' AND d.approval_status = 'Pending' AND d.approval_round = s.round
          AND s.step_no = (SELECT MIN(s3.step_no) FROM document_approval_steps s3 WHERE s3.doc_type = s.doc_type AND s3.doc_id = s.doc_id AND s3.round = s.round AND s3.status = 'Pending')`)).all())
          .forEach(r => overview.push(shapeItem(type, r)));
      }
      return res.json({ isAdmin: true, awaiting: [], upcoming: [], decided: [], overview });
    }
    const all = await awaitingFor(user.teamMemberId);
    const awaiting = all.filter(it => it.myTurn), upcoming = all.filter(it => !it.myTurn); // upcoming: someone earlier still has to sign
    const byDate = (a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt));
    const decided = [];
    for (const type of Object.keys(DOC_TYPES)) {
      (await db.prepare(`${myApprovalsSql(type, `AND s.team_member_id = ? AND s.status IN ('Approved','Rejected')`)} ORDER BY s.acted_at DESC LIMIT 30`).all(user.teamMemberId))
        .forEach(r => decided.push(shapeItem(type, r)));
    }
    decided.sort((a, b) => String(b.actedAt).localeCompare(String(a.actedAt)));
    res.json({ isAdmin: false, awaiting: awaiting.sort(byDate), upcoming: upcoming.sort(byDate), decided: decided.slice(0, 30), overview: [] });
  });

  /* ---- one document's approval state ---- */
  app.get('/api/approvals/:type/:id', async (req, res) => {
    const doc = await loadDoc(req.params.type, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(await loadState(req.params.type, doc, sessionUser(req)));
  });

  /* ---- choose / change the approvers (only while not submitted) ---- */
  app.put('/api/approvals/:type/:id/approvers', async (req, res) => {
    const { type } = req.params, t = DOC_TYPES[type];
    const approvers = Array.isArray(req.body && req.body.approvers) ? req.body.approvers : null;
    if (!t || !approvers) return bad(res, 'approvers (a list of {roleKey, teamMemberId}) is required');
    const result = await db.transaction(async () => {
      const doc = await loadDoc(type, req.params.id, { forUpdate: true });
      if (!doc) return { status: 404, body: { error: 'Document not found' } };
      if (LOCKED_STATUSES.includes(doc.approval_status)) return { status: 423, body: { error: lockedMessage(doc.approval_status), code: 'DOCUMENT_LOCKED' } };
      const seen = new Set(), rows = [];
      for (const a of approvers) {
        const idx = t.roles.findIndex(r => r.key === a.roleKey);
        if (idx < 0) return { status: 400, body: { error: `Unknown signature role "${a.roleKey}"` } };
        if (seen.has(a.roleKey)) return { status: 400, body: { error: 'Each signature role can only be assigned once' } };
        seen.add(a.roleKey);
        const m = await db.prepare(`SELECT tm.id, tm.name, tm.designation FROM team_members tm JOIN user_accounts ua ON ua.team_member_id = tm.id AND ua.active = 1 WHERE tm.id = ?`).get(Number(a.teamMemberId));
        if (!m) return { status: 400, body: { error: `${t.roles[idx].label}: the chosen person has no active login, so they cannot approve` } };
        rows.push({ idx, role: t.roles[idx], m });
      }
      rows.sort((a, b) => a.idx - b.idx);
      await db.prepare('DELETE FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = 0').run(type, doc.id);
      for (const [i, r] of rows.entries()) {
        await db.prepare(`INSERT INTO document_approval_steps (project_id, doc_type, doc_id, round, step_no, role_key, role_label, team_member_id, approver_name, approver_designation, status)
          VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'Draft')`).run(doc.project_id, type, doc.id, i + 1, r.role.key, r.role.label, r.m.id, r.m.name, r.m.designation);
      }
      return { status: 200, body: await loadState(type, doc, sessionUser(req)), doc, count: rows.length };
    })();
    if (result.status === 200) {
      stepAudit(req, type, result.doc, 'approvers_assigned', { approvers: result.body.draft.map(s => `${s.roleLabel}: ${s.name}`) });
    }
    res.status(result.status).json(result.body);
  });

  /* ---- submit for approval ---- */
  app.post('/api/approvals/:type/:id/submit', async (req, res) => {
    const { type } = req.params, user = sessionUser(req);
    if (!DOC_TYPES[type]) return res.status(404).json({ error: 'Unknown document type' });
    const result = await db.transaction(async () => {
      const doc = await loadDoc(type, req.params.id, { forUpdate: true });
      if (!doc) return { status: 404, body: { error: 'Document not found' } };
      if (LOCKED_STATUSES.includes(doc.approval_status)) return { status: 409, body: { error: doc.approval_status === 'Pending' ? 'This document has already been submitted for approval' : 'This document is already approved' } };
      const draft = await db.prepare(`SELECT s.*, ua.active FROM document_approval_steps s LEFT JOIN user_accounts ua ON ua.team_member_id = s.team_member_id
        WHERE s.doc_type = ? AND s.doc_id = ? AND s.round = 0 ORDER BY s.step_no`).all(type, doc.id);
      if (!draft.length) return { status: 400, body: { error: 'Choose at least one approver before submitting' } };
      if (type === 'change_request') {
        const att = await db.prepare('SELECT COUNT(*) AS n FROM project_documents WHERE change_request_id = ? AND deleted_at IS NULL').get(doc.id);
        if (!Number(att.n)) return { status: 400, body: { error: 'Attach at least one supporting document to this change request before submitting it for approval', code: 'ATTACHMENT_REQUIRED' } };
      }
      const inactive = draft.filter(s => !s.active).map(s => s.approver_name);
      if (inactive.length) return { status: 400, body: { error: `These approvers no longer have an active login: ${inactive.join(', ')}. Choose someone else.` } };
      const round = doc.approval_round + 1;
      await db.prepare(`UPDATE document_approval_steps SET round = ?, status = 'Pending', submitted_at = utc_now_text(), submitted_by = ? WHERE doc_type = ? AND doc_id = ? AND round = 0`)
        .run(round, user.username, type, doc.id);
      await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET approval_status = 'Pending', approval_round = ? WHERE id = ?`).run(round, doc.id);
      doc.approval_status = 'Pending'; doc.approval_round = round;
      return { status: 200, body: await loadState(type, doc, user), doc, draft };
    })();
    if (result.status === 200) stepAudit(req, type, result.doc, 'submit_for_approval', { round: result.doc.approval_round, approvers: result.draft.map(s => `${s.role_label}: ${s.approver_name}`) });
    res.status(result.status).json(result.body);
  });

  /* ---- approve / reject a step ---- */
  async function decide(req, res, outcome) {
    const { type } = req.params, user = sessionUser(req);
    if (!DOC_TYPES[type]) return res.status(404).json({ error: 'Unknown document type' });
    if (user.userType !== 'user') return res.status(403).json({ error: 'Approvals are signed by the assigned person, signed in with their own account' });
    const comment = clip(req.body && req.body.comment);
    if (outcome === 'Rejected' && comment.length < 3) return bad(res, 'A reason is required when rejecting');
    const result = await db.transaction(async () => {
      const doc = await loadDoc(type, req.params.id, { forUpdate: true });
      if (!doc) return { status: 404, body: { error: 'Document not found' } };
      if (doc.approval_status !== 'Pending') return { status: 409, body: { error: 'This document is not awaiting approval' } };
      const step = await db.prepare(`SELECT * FROM document_approval_steps WHERE id = ? AND doc_type = ? AND doc_id = ? AND round = ?`).get(Number(req.params.stepId), type, doc.id, doc.approval_round);
      if (!step || step.status !== 'Pending') return { status: 409, body: { error: 'This step has already been completed' } };
      if (step.team_member_id !== user.teamMemberId) return { status: 403, body: { error: 'This step is assigned to someone else' } };
      const earlier = await db.prepare(`SELECT approver_name FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = ? AND status = 'Pending' AND step_no < ? ORDER BY step_no LIMIT 1`).get(type, doc.id, doc.approval_round, step.step_no);
      if (earlier) return { status: 409, body: { error: `Not your turn yet — waiting for ${earlier.approver_name} to sign first` } };

      await db.prepare(`UPDATE document_approval_steps SET status = ?, acted_at = utc_now_text(), acted_by = ?, comment = ?, ip_address = ? WHERE id = ?`)
        .run(outcome, user.username, comment || null, clientIp(req), step.id);
      let finalState = 'Pending';
      if (outcome === 'Rejected') {
        await db.prepare(`UPDATE document_approval_steps SET status = 'Voided' WHERE doc_type = ? AND doc_id = ? AND round = ? AND status = 'Pending'`).run(type, doc.id, doc.approval_round);
        await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET approval_status = 'Rejected' WHERE id = ?`).run(doc.id);
        await carryOverAssignments(type, doc, doc.approval_round);
        finalState = 'Rejected';
      } else {
        const left = await db.prepare(`SELECT COUNT(*) AS n FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = ? AND status = 'Pending'`).get(type, doc.id, doc.approval_round);
        if (left.n === 0) {
          finalState = 'Approved';
          await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET approval_status = 'Approved' WHERE id = ?`).run(doc.id);
          if (type === 'vowd' || type === 'certificate') {
            await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET status = 'Issued', issued_at = COALESCE(issued_at, utc_now_text()) WHERE id = ?`).run(doc.id);
          } else {
            // A fully approved change request is the Change Control Board's "Approved" decision: record it so the
            // contract value / completion-date impact flows through exactly as a manually entered decision would.
            await db.prepare(`INSERT INTO change_decisions (change_request_id, decision, decision_explanation, created_by_approval) VALUES (?, 'Approved', ?, 1)`)
              .run(doc.id, `Approved through the approval workflow (round ${doc.approval_round}).`);
          }
        }
      }
      doc.approval_status = finalState;
      return { status: 200, body: await loadState(type, doc, user), doc, step, finalState };
    })();
    if (result.status === 200) {
      stepAudit(req, type, result.doc, outcome === 'Approved' ? 'approve' : 'reject', {
        step: `${result.step.role_label}`, round: result.step.round, comment: comment || undefined,
        outcome: result.finalState === 'Approved' ? 'Fully approved' : result.finalState === 'Rejected' ? 'Returned to author' : 'Passed to next approver'
      });
    }
    res.status(result.status).json(result.body);
  }
  app.post('/api/approvals/:type/:id/steps/:stepId/approve', (req, res) => decide(req, res, 'Approved'));
  app.post('/api/approvals/:type/:id/steps/:stepId/reject', (req, res) => decide(req, res, 'Rejected'));

  /* ---- withdraw (submitter or administrator) ---- */
  app.post('/api/approvals/:type/:id/withdraw', async (req, res) => {
    const { type } = req.params, user = sessionUser(req);
    if (!DOC_TYPES[type]) return res.status(404).json({ error: 'Unknown document type' });
    const result = await db.transaction(async () => {
      const doc = await loadDoc(type, req.params.id, { forUpdate: true });
      if (!doc) return { status: 404, body: { error: 'Document not found' } };
      if (doc.approval_status !== 'Pending') return { status: 409, body: { error: 'This document is not awaiting approval' } };
      const first = await db.prepare(`SELECT submitted_by FROM document_approval_steps WHERE doc_type = ? AND doc_id = ? AND round = ? ORDER BY step_no LIMIT 1`).get(type, doc.id, doc.approval_round);
      if (!user.isAdmin && (!first || first.submitted_by !== user.username)) return { status: 403, body: { error: 'Only the person who submitted this, or the administrator, can withdraw it' } };
      await db.prepare(`UPDATE document_approval_steps SET status = 'Voided' WHERE doc_type = ? AND doc_id = ? AND round = ? AND status = 'Pending'`).run(type, doc.id, doc.approval_round);
      await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET approval_status = 'None' WHERE id = ?`).run(doc.id);
      await carryOverAssignments(type, doc, doc.approval_round);
      doc.approval_status = 'None';
      return { status: 200, body: await loadState(type, doc, user), doc };
    })();
    if (result.status === 200) stepAudit(req, type, result.doc, 'withdraw', { round: result.doc.approval_round });
    res.status(result.status).json(result.body);
  });

  /* ---- reopen an approved document for revision (administrator, reason required) ---- */
  app.post('/api/approvals/:type/:id/reopen', requireAdmin, async (req, res) => {
    const { type } = req.params;
    if (!DOC_TYPES[type]) return res.status(404).json({ error: 'Unknown document type' });
    const reason = clip(req.body && req.body.reason);
    if (reason.length < 5) return bad(res, 'Give a reason for reopening (at least a few words)');
    const result = await db.transaction(async () => {
      const doc = await loadDoc(type, req.params.id, { forUpdate: true });
      if (!doc) return { status: 404, body: { error: 'Document not found' } };
      if (doc.approval_status !== 'Approved') return { status: 409, body: { error: 'Only an approved document can be reopened' } };
      await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET approval_status = 'None' WHERE id = ?`).run(doc.id);
      if (type === 'change_request') await db.prepare('DELETE FROM change_decisions WHERE change_request_id = ? AND created_by_approval = 1').run(doc.id);
      else await db.prepare(`UPDATE ${DOC_TYPES[type].table} SET status = 'Draft', issued_at = NULL WHERE id = ?`).run(doc.id);
      await carryOverAssignments(type, doc, doc.approval_round);
      doc.approval_status = 'None';
      return { status: 200, body: await loadState(type, doc, sessionUser(req)), doc };
    })();
    if (result.status === 200) stepAudit(req, type, result.doc, 'reopen', { reason });
    res.status(result.status).json(result.body);
  });
};

module.exports.DOC_TYPES = DOC_TYPES;
