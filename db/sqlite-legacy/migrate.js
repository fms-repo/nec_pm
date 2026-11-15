// Idempotent incremental migrations, run on every startup after schema.sql.
// Safe to run against a brand-new database or an existing one — each ALTER
// TABLE only runs if the column isn't already present.
const demoData = require('../demoData');

module.exports = function migrate(db) {
  const projectCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
  const addProjectColumn = (name, def) => {
    if (!projectCols.includes(name)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
    }
  };

  addProjectColumn('objective', 'TEXT');
  addProjectColumn('scope', 'TEXT');
  addProjectColumn('priority', "TEXT NOT NULL DEFAULT 'Medium'");
  addProjectColumn('funding_source', 'TEXT');
  addProjectColumn('contract_reference', 'TEXT');
  addProjectColumn('project_sponsor', 'TEXT');

  // Business Unit (master list, seeded once) + Project Manager (picked from the team
  // directory) on the Project Brief. Both are nullable FKs added after the fact, so existing
  // projects are backfilled once — business unit defaults to "NEC", project manager is
  // inferred from whichever team member already carries the "Project Manager" designation on
  // that project's Resources tab (same convention the Reports "Manager" field relies on).
  const isFreshBusinessUnitMigration = !projectCols.includes('business_unit_id');
  const isFreshProjectManagerMigration = !projectCols.includes('project_manager_id');
  addProjectColumn('business_unit_id', 'INTEGER REFERENCES business_units(id)');
  addProjectColumn('project_manager_id', 'INTEGER REFERENCES team_members(id)');

  const businessUnitCount = db.prepare('SELECT COUNT(*) AS n FROM business_units').get().n;
  if (businessUnitCount === 0) {
    const insertBU = db.prepare('INSERT INTO business_units (name) VALUES (?)');
    ['NEC', 'AAMU', 'ECTRON'].forEach(name => insertBU.run(name));
  }

  if (isFreshBusinessUnitMigration) {
    const necId = db.prepare("SELECT id FROM business_units WHERE name = 'NEC'").get()?.id;
    if (necId) db.prepare('UPDATE projects SET business_unit_id = ? WHERE business_unit_id IS NULL').run(necId);
  }

  if (isFreshProjectManagerMigration) {
    db.prepare(`
      SELECT p.id AS project_id, tm.id AS team_member_id
      FROM projects p
      JOIN project_members pmem ON pmem.project_id = p.id
      JOIN team_members tm ON tm.id = pmem.team_member_id AND tm.designation = 'Project Manager'
      WHERE p.project_manager_id IS NULL
    `).all().forEach(r => {
      db.prepare('UPDATE projects SET project_manager_id = ? WHERE id = ?').run(r.team_member_id, r.project_id);
    });
  }

  // Risk register upgrade: probability x impact scoring, mitigation planning and residual
  // risk, replacing the old single "severity" field. Runs once — guarded on 'probability'
  // not existing yet — then backfills any pre-existing rows from their legacy severity/status.
  const riskCols = db.prepare("PRAGMA table_info(risks)").all().map(c => c.name);
  const addRiskColumn = (name, def) => {
    if (!riskCols.includes(name)) {
      db.exec(`ALTER TABLE risks ADD COLUMN ${name} ${def}`);
    }
  };
  const isFreshRiskMigration = !riskCols.includes('probability');

  addRiskColumn('description', 'TEXT');
  addRiskColumn('category', "TEXT NOT NULL DEFAULT 'Other'");
  addRiskColumn('owner', 'TEXT');
  addRiskColumn('mitigation_target', 'TEXT');
  addRiskColumn('probability', 'INTEGER NOT NULL DEFAULT 3');
  addRiskColumn('impact', 'INTEGER NOT NULL DEFAULT 3');
  addRiskColumn('response_strategy', 'TEXT');
  addRiskColumn('mitigation_plan', 'TEXT');
  addRiskColumn('residual_probability', 'INTEGER');
  addRiskColumn('residual_impact', 'INTEGER');
  addRiskColumn('is_critical', 'INTEGER NOT NULL DEFAULT 0');
  addRiskColumn('triggers', 'TEXT');
  addRiskColumn('contingency_plan', 'TEXT');
  addRiskColumn('remarks', 'TEXT');

  if (isFreshRiskMigration) {
    // Several plausible P x I combinations per legacy severity band (rather than one fixed
    // pair) so the migrated register/matrix isn't visually flat — picked deterministically
    // per row so re-running this migration is still idempotent in its output.
    const SEVERITY_TO_PI = {
      Critical: [[5, 5], [4, 5], [5, 4], [4, 4]],
      High: [[3, 4], [4, 3], [3, 5], [4, 4]],
      Medium: [[2, 3], [3, 2], [3, 3], [2, 4]]
    };
    const STATUS_MAP = { Open: 'Open', Overdue: 'Open', 'Pending Decision': 'Watching' };
    const backfillRow = db.prepare(`
      UPDATE risks SET probability = ?, impact = ?, status = ?, response_strategy = ?, owner = ?, category = ?
      WHERE id = ?`);
    db.prepare('SELECT id, severity, status FROM risks').all().forEach((r, idx) => {
      const options = SEVERITY_TO_PI[r.severity] || [[3, 3]];
      const [probability, impact] = options[idx % options.length];
      backfillRow.run(
        probability, impact, STATUS_MAP[r.status] || 'Open',
        demoData.RESPONSE_STRATEGIES[idx % demoData.RESPONSE_STRATEGIES.length],
        demoData.TEAM_OWNERS[idx % demoData.TEAM_OWNERS.length],
        demoData.RAID_CATEGORIES[idx % demoData.RAID_CATEGORIES.length],
        r.id
      );
    });
  }

  // Issue log upgrade: adds severity (distinct from priority — technical/functional impact
  // vs business urgency), who raised it, and closure verification notes. Also retires the
  // 'Escalated' status in favor of a 'Blocked' status (the issue itself is stuck) plus the
  // separate is_escalated flag now doubling as "blocking" (this issue blocks delivery).
  const issueCols = db.prepare("PRAGMA table_info(issues)").all().map(c => c.name);
  const addIssueColumn = (name, def) => {
    if (!issueCols.includes(name)) {
      db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${def}`);
    }
  };
  const isFreshIssueMigration = !issueCols.includes('severity');

  addIssueColumn('severity', "TEXT NOT NULL DEFAULT 'Medium'");
  addIssueColumn('raised_by', 'TEXT');
  addIssueColumn('verification_notes', 'TEXT');

  if (isFreshIssueMigration) {
    db.exec(`UPDATE issues SET severity = priority`);
    db.exec(`UPDATE issues SET status = 'Blocked', is_escalated = 1 WHERE status = 'Escalated'`);
    db.prepare('SELECT id FROM issues').all().forEach((r, idx) => {
      db.prepare('UPDATE issues SET raised_by = ? WHERE id = ?')
        .run(demoData.TEAM_OWNERS[idx % demoData.TEAM_OWNERS.length], r.id);
    });
  }

  // "Flag as key document" on the document repository, used by the Change Requests
  // attachment composer (also available to any document, not just change requests).
  const docCols = db.prepare("PRAGMA table_info(project_documents)").all().map(c => c.name);
  if (!docCols.includes('is_key')) {
    db.exec(`ALTER TABLE project_documents ADD COLUMN is_key INTEGER NOT NULL DEFAULT 0`);
  }

  // Gantt Timeline: the event sequence already carries stage + planned/actual dates, but
  // needs an owner and a completion percentage to be worth plotting as task bars. Runs once —
  // guarded on 'assigned_to' not existing yet — then backfills from status (Completed -> 100,
  // Not Started -> 0, else a deterministic partial value) so existing rows aren't blank.
  const eventCols = db.prepare("PRAGMA table_info(project_events)").all().map(c => c.name);
  const addEventColumn = (name, def) => {
    if (!eventCols.includes(name)) {
      db.exec(`ALTER TABLE project_events ADD COLUMN ${name} ${def}`);
    }
  };
  const isFreshEventMigration = !eventCols.includes('assigned_to');

  addEventColumn('assigned_to', 'TEXT');
  addEventColumn('progress_pct', 'REAL NOT NULL DEFAULT 0');
  // Whether this event's Materials/Crew panel was left collapsed or expanded, so the
  // Sequence of Events accordion reopens exactly how it was left at last Save Project
  // (e.g. after using "Collapse All") rather than always defaulting back to expanded.
  addEventColumn('is_collapsed', 'INTEGER NOT NULL DEFAULT 0');

  if (isFreshEventMigration) {
    const STATUS_TO_PROGRESS = { Completed: 100, 'Not Started': 0 };
    db.prepare('SELECT id, status FROM project_events').all().forEach((r, idx) => {
      const progress = STATUS_TO_PROGRESS[r.status] ?? (r.status === 'Delayed' ? 20 + (idx * 7) % 40 : 30 + (idx * 11) % 50);
      db.prepare('UPDATE project_events SET assigned_to = ?, progress_pct = ? WHERE id = ?')
        .run(demoData.TEAM_OWNERS[idx % demoData.TEAM_OWNERS.length], progress, r.id);
    });
  }

  // CCB decisions can now optionally carry a Revised Completion Date, surfaced read-only on
  // the Project Brief tab (the latest one recorded across a project's change requests).
  const decisionCols = db.prepare("PRAGMA table_info(change_decisions)").all().map(c => c.name);
  if (!decisionCols.includes('revised_completion_date')) {
    db.exec(`ALTER TABLE change_decisions ADD COLUMN revised_completion_date TEXT`);
  }

  // A VOWD statement can now reference which of the project's Sub Contractors performed
  // the work it covers (a dropdown on the VOWD tab, sourced from project_subcontractors).
  const vowdCols = db.prepare("PRAGMA table_info(vowd_statements)").all().map(c => c.name);
  if (!vowdCols.includes('subcontractor_id')) {
    db.exec(`ALTER TABLE vowd_statements ADD COLUMN subcontractor_id INTEGER REFERENCES contractors(id)`);
  }

  // Materials/Crew now attach to a specific Sequence of Events entry (event_id), not just a
  // Stage — so two events sharing a stage (e.g. two "Mobilization" tasks) each get their own
  // Materials/Crew panel instead of silently sharing one. Stage is kept in sync from the
  // linked event (still used for Cost Statement/VOWD stage rollups) but is no longer the
  // source of truth for "which event owns this line". Backfill assigns each existing row to
  // whichever event currently "owns" its stage — the first event (by seq_no) of that stage in
  // the same project — matching exactly what was visually shown before this migration, so
  // nothing appears to move or vanish. Anything left unmatched stays NULL (unassigned),
  // surfaced in the "Other Materials & Crew" section same as today.
  const materialColsBefore = db.prepare("PRAGMA table_info(project_materials)").all().map(c => c.name);
  const isFreshMaterialEventLink = !materialColsBefore.includes('event_id');
  if (isFreshMaterialEventLink) {
    db.exec(`ALTER TABLE project_materials ADD COLUMN event_id INTEGER REFERENCES project_events(id) ON DELETE SET NULL`);
  }
  const crewColsBefore = db.prepare("PRAGMA table_info(project_crews)").all().map(c => c.name);
  const isFreshCrewEventLink = !crewColsBefore.includes('event_id');
  if (isFreshCrewEventLink) {
    db.exec(`ALTER TABLE project_crews ADD COLUMN event_id INTEGER REFERENCES project_events(id) ON DELETE SET NULL`);
  }
  if (isFreshMaterialEventLink || isFreshCrewEventLink) {
    const firstEventForStage = {}; // `${project_id}::${stage}` -> event_id
    db.prepare('SELECT id, project_id, stage FROM project_events ORDER BY project_id, seq_no, id').all().forEach(e => {
      const key = e.project_id + '::' + e.stage;
      if (!(key in firstEventForStage)) firstEventForStage[key] = e.id;
    });
    if (isFreshMaterialEventLink) {
      const setMaterialEvent = db.prepare('UPDATE project_materials SET event_id = ? WHERE id = ?');
      db.prepare('SELECT id, project_id, stage FROM project_materials WHERE event_id IS NULL').all().forEach(m => {
        const key = m.project_id + '::' + m.stage;
        if (key in firstEventForStage) setMaterialEvent.run(firstEventForStage[key], m.id);
      });
    }
    if (isFreshCrewEventLink) {
      const setCrewEvent = db.prepare('UPDATE project_crews SET event_id = ? WHERE id = ?');
      db.prepare('SELECT id, project_id, stage FROM project_crews WHERE event_id IS NULL').all().forEach(c => {
        const key = c.project_id + '::' + c.stage;
        if (key in firstEventForStage) setCrewEvent.run(firstEventForStage[key], c.id);
      });
    }
  }

  // Projects can now span multiple locations (project_governorates), not just the single
  // governorate_id column. schema.sql already creates the table; here we just backfill each
  // existing project's current governorate_id in as its (only, primary) location, once.
  db.prepare(`
    INSERT INTO project_governorates (project_id, governorate_id)
    SELECT p.id, p.governorate_id FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM project_governorates pg WHERE pg.project_id = p.id)
  `).run();

  // Business Unit letterhead logo, shown on print documents in place of a hardcoded
  // organization name. No backfill needed — starts NULL (no logo) for every existing unit.
  const businessUnitCols = db.prepare("PRAGMA table_info(business_units)").all().map(c => c.name);
  if (!businessUnitCols.includes('logo_path')) {
    db.exec(`ALTER TABLE business_units ADD COLUMN logo_path TEXT`);
  }

  // VOWD statement signatory: "General Manager" is a new third signature line (alongside
  // Supply Chain Management). The old "Contract Owner" free-text field is retired in favour
  // of the project's own Project Sponsor (Project Brief), read live rather than duplicated
  // here — contract_owner itself is left in place (unused, no data loss) rather than dropped.
  const vowdColsForGM = db.prepare("PRAGMA table_info(vowd_statements)").all().map(c => c.name);
  if (!vowdColsForGM.includes('general_manager')) {
    db.exec(`ALTER TABLE vowd_statements ADD COLUMN general_manager TEXT`);
  }

  // Crew/labour lines now record an Actual Qty (like a material's Consumed Qty), and actual
  // labour cost is Actual Qty-based rather than "full planned cost once Mobilized/Demobilized".
  // Backfilled once so existing actual-cost totals are unchanged: crews already Mobilized or
  // Demobilized get Actual Qty = their Planned Qty, Planned crews stay at 0.
  const crewColsForActualQty = db.prepare("PRAGMA table_info(project_crews)").all().map(c => c.name);
  if (!crewColsForActualQty.includes('actual_qty')) {
    db.exec(`ALTER TABLE project_crews ADD COLUMN actual_qty REAL NOT NULL DEFAULT 0`);
    db.exec(`UPDATE project_crews SET actual_qty = quantity WHERE status IN ('Mobilized', 'Demobilized')`);
  }

  // Change request "CR Type" — who raised it (Client or Subcontractor), separate from the
  // existing cr_type change category. Existing CRs default to Client; a Subcontractor CR
  // must name the subcontractor (enforced in the API).
  const crColsForSource = db.prepare("PRAGMA table_info(change_requests)").all().map(c => c.name);
  if (!crColsForSource.includes('cr_source')) {
    db.exec(`ALTER TABLE change_requests ADD COLUMN cr_source TEXT NOT NULL DEFAULT 'Client'`);
  }
  if (!crColsForSource.includes('subcontractor_id')) {
    db.exec(`ALTER TABLE change_requests ADD COLUMN subcontractor_id INTEGER REFERENCES contractors(id)`);
  }

  // CR Initial Analysis: the single "Duration impact (days)" becomes two independently stored
  // fields, Months and Days. Existing values move into Days unchanged (no month conversion is
  // assumed). Hour impact is retired — hour_impact/duration_impact stay in place, unused.
  const analysisCols = db.prepare("PRAGMA table_info(change_analyses)").all().map(c => c.name);
  if (!analysisCols.includes('duration_months')) {
    db.exec(`ALTER TABLE change_analyses ADD COLUMN duration_months INTEGER NOT NULL DEFAULT 0`);
  }
  if (!analysisCols.includes('duration_days')) {
    db.exec(`ALTER TABLE change_analyses ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE change_analyses SET duration_days = CAST(ROUND(MAX(duration_impact, 0)) AS INTEGER)`);
  }
  // Schedule Impact is now just Yes/No: any graded impact (Minor/Moderate/Major) -> Yes,
  // None -> No. Only touches rows not already Yes/No, so it's safe to run on every start.
  db.exec(`UPDATE change_analyses
    SET schedule_impact = CASE WHEN schedule_impact IN ('Minor', 'Moderate', 'Major') THEN 'Yes' ELSE 'No' END
    WHERE schedule_impact NOT IN ('Yes', 'No')`);

  // Approved Budget / Contract Value / Actual Cost / Committed Cost on projects used to be
  // stored (and entered) in OMR Millions (e.g. 0.144582 for OMR 144,582) so every reader had
  // to remember to x1,000,000 before showing a real amount. Now stored as plain full OMR
  // throughout, matching every other monetary field in the app (materials, crew, invoices,
  // certificates, VOWD). One-time x1,000,000 conversion of existing rows, guarded by
  // PRAGMA user_version (no schema marker fits a pure data-scale change, so this is the one
  // migration in this file that isn't self-guarding via a column/table check).
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    db.exec(`
      UPDATE projects SET
        approved_budget = approved_budget * 1000000,
        contract_value = contract_value * 1000000,
        actual_cost = actual_cost * 1000000,
        committed_cost = committed_cost * 1000000
    `);
    db.exec('PRAGMA user_version = 1');
  }
};
