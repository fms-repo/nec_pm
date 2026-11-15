// Demo seed: populates master data + a coherent demo dataset (same shape as the original
// in-browser demo generator) for a development/training database. Never runs automatically —
// only via `npm run seed`, and only into an empty database (it refuses if any project exists).

const GOVERNORATES = [
  { name: 'Muscat', cities: ['Muscat', 'Seeb', 'Bausher', 'Al Amerat'] },
  { name: 'Dhofar', cities: ['Salalah', 'Taqah', 'Mirbat'] },
  { name: 'North Al Batinah', cities: ['Sohar', 'Shinas', 'Saham'] },
  { name: 'South Al Batinah', cities: ['Barka', 'Rustaq', 'Nakhal'] },
  { name: 'Al Dakhiliyah', cities: ['Nizwa', 'Bahla', 'Adam'] },
  { name: 'Al Dhahirah', cities: ['Ibri', 'Yanqul'] },
  { name: 'Al Buraimi', cities: ['Al Buraimi', 'Mahdah'] },
  { name: 'Musandam', cities: ['Khasab', 'Bukha'] },
  { name: 'Al Wusta', cities: ['Duqm', 'Haima'] },
  { name: 'South Ash Sharqiyah', cities: ['Sur', 'Al Kamil'] },
  { name: 'North Ash Sharqiyah', cities: ['Ibra', 'Al Mudhaibi'] }
];
const PROJECT_TYPES = ['Network Rehabilitation', 'Pump Station Upgrade', 'Reservoir Rehabilitation', 'Leak Detection & Repair', 'Transmission Main Replacement', 'Distribution Network Expansion'];
const CONTRACTORS = [
  { name: 'Al Rawahi Infrastructure LLC', base: 88 },
  { name: 'Batinah Hydro Engineering', base: 92 },
  { name: 'Gulf Pipeline Contractors', base: 76 },
  { name: 'Nizwa Techno Build', base: 81 },
  { name: 'Sharqiyah Civil Contractors', base: 69 },
  { name: 'Salalah Water Works Co.', base: 85 },
  { name: 'Al Amerat Construction Co.', base: 73 },
  { name: 'Wadi Engineering & Trading', base: 90 }
];
const STATUSES = ['Not Started', 'Active', 'Completed', 'At Risk', 'Delayed'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];
const MILESTONE_TYPES = ['Design Completed', 'Contract Awarded', 'Mobilization', 'Construction Started', '50% Completion', 'Pipeline Installation Completed', 'Testing Completed', 'Commissioning', 'Handover'];

const demoData = require('./demoData');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seed(db) {
  const rng = mulberry32(20260816);
  const rand = (min, max) => min + rng() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (arr) => arr[randInt(0, arr.length - 1)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const toISO = (d) => d.toISOString().slice(0, 10);

  const run = db.transaction(async () => {
    const insertGov = db.prepare('INSERT INTO governorates (name) VALUES (?)');
    const govIds = {};
    for (const g of GOVERNORATES) govIds[g.name] = (await insertGov.run(g.name)).lastInsertRowid;

    const insertType = db.prepare('INSERT INTO project_types (name) VALUES (?)');
    const typeIds = {};
    for (const t of PROJECT_TYPES) typeIds[t] = (await insertType.run(t)).lastInsertRowid;

    const insertContractor = db.prepare('INSERT INTO contractors (name, base_performance) VALUES (?, ?)');
    const contractorIds = {};
    for (const c of CONTRACTORS) contractorIds[c.name] = (await insertContractor.run(c.name, c.base)).lastInsertRowid;

    const insertProject = db.prepare(`INSERT INTO projects
      (code, name, governorate_id, city, project_type_id, contractor_id, status, planned_pct, actual_pct,
       approved_budget, contract_value, actual_cost, committed_cost, expected_delay_days, start_date, end_date,
       objective, scope, priority, funding_source, contract_reference, project_sponsor)
      VALUES (@code, @name, @governorate_id, @city, @project_type_id, @contractor_id, @status, @planned_pct, @actual_pct,
       @approved_budget, @contract_value, @actual_cost, @committed_cost, @expected_delay_days, @start_date, @end_date,
       @objective, @scope, @priority, @funding_source, @contract_reference, @project_sponsor)`);

    const insertMaterial = db.prepare(`INSERT INTO project_materials
      (project_id, stage, material_name, specification, unit, planned_qty, consumed_qty, unit_rate, supplier, delivery_date, status, notes)
      VALUES (@project_id, @stage, @material_name, @specification, @unit, @planned_qty, @consumed_qty, @unit_rate, @supplier, @delivery_date, @status, @notes)`);
    const insertCrew = db.prepare(`INSERT INTO project_crews
      (project_id, stage, resource_type, resource_name, contractor_id, quantity, actual_qty, rate_basis, unit_rate, allocated_days, start_date, end_date, status, notes)
      VALUES (@project_id, @stage, @resource_type, @resource_name, @contractor_id, @quantity, @actual_qty, @rate_basis, @unit_rate, @allocated_days, @start_date, @end_date, @status, @notes)`);
    const insertEvent = db.prepare(`INSERT INTO project_events
      (project_id, seq_no, stage, event_name, planned_start, planned_end, actual_start, actual_end, status, assigned_to, progress_pct, remarks)
      VALUES (@project_id, @seq_no, @stage, @event_name, @planned_start, @planned_end, @actual_start, @actual_end, @status, @assigned_to, @progress_pct, @remarks)`);

    let pid = 1;
    const projectRows = [];
    for (const gov of GOVERNORATES) {
      const numProjects = randInt(2, 4);
      for (let i = 0; i < numProjects; i++) {
        const city = pick(gov.cities);
        const type = pick(PROJECT_TYPES);
        const contractor = pick(CONTRACTORS);
        const status = pick(STATUSES.concat(['Active', 'Active', 'At Risk']));
        let plannedPct = randInt(20, 95);
        let actualPct;
        if (status === 'Completed') { plannedPct = 100; actualPct = 100; }
        else if (status === 'Not Started') { plannedPct = randInt(0, 5); actualPct = 0; }
        else if (status === 'Delayed') { actualPct = clamp(plannedPct - randInt(6, 22), 0, 95); }
        else if (status === 'At Risk') { actualPct = clamp(plannedPct - randInt(2, 10), 0, 95); }
        else { actualPct = clamp(plannedPct + randInt(-4, 8), 0, 99); }

        const approvedBudget = +rand(350000, 4200000).toFixed(2); // full OMR, like every other amount
        const contractValue = +(approvedBudget * rand(0.88, 1.04)).toFixed(2);
        const costRatio = clamp((actualPct / 100) * rand(0.92, 1.22), 0, 1.35);
        const actualCost = +(contractValue * costRatio).toFixed(2);
        const committedCost = +(actualCost + contractValue * rand(0.03, 0.12)).toFixed(2);
        const startMonth = randInt(0, 3);
        const startDate = new Date(2025, 9 + startMonth, randInt(1, 28));
        const endDate = new Date(2026, 10 + randInt(0, 6), randInt(1, 28));
        const expectedDelayDays = status === 'Delayed' ? randInt(10, 45) : status === 'At Risk' ? randInt(0, 14) : 0;

        const code = 'P-' + String(pid).padStart(4, '0');
        const name = `${city} Rehabilitation – ${String(pid).padStart(2, '0')}`;
        const brief = demoData.briefFields({ code, city, governorateName: gov.name, typeName: type, status }, pick);
        const info = await insertProject.run({
          code, name,
          governorate_id: govIds[gov.name],
          city,
          project_type_id: typeIds[type],
          contractor_id: contractorIds[contractor.name],
          status, planned_pct: plannedPct, actual_pct: actualPct,
          approved_budget: approvedBudget, contract_value: contractValue,
          actual_cost: actualCost, committed_cost: committedCost,
          expected_delay_days: expectedDelayDays,
          start_date: toISO(startDate), end_date: toISO(endDate),
          objective: brief.objective, scope: brief.scope, priority: brief.priority,
          funding_source: brief.funding_source, contract_reference: brief.contract_reference,
          project_sponsor: brief.project_sponsor
        });
        const projectId = info.lastInsertRowid;

        for (const m of demoData.materialRows({ status }, pick, randInt, rand, clamp)) {
          await insertMaterial.run({ project_id: projectId, ...m });
        }
        for (const c of demoData.crewRows({ status }, pick, randInt, rand, contractorIds[contractor.name])) {
          await insertCrew.run({ project_id: projectId, ...c });
        }
        for (const e of demoData.eventRows({ status, actualPct, startDate, endDate }, pick, toISO)) {
          await insertEvent.run({ project_id: projectId, ...e });
        }

        projectRows.push({ id: projectId, status, plannedPct, actualPct });
        pid++;
      }
    }

    // Bias which projects receive demo risks/issues the same way the original
    // generator favoured Delayed / At Risk projects — seeding only, not a stored rule.
    const attentionHint = (p) => p.status === 'Delayed' || p.status === 'At Risk' || (p.actualPct - p.plannedPct) < -8;

    const insertRisk = db.prepare(`INSERT INTO risks
      (project_id, title, status, raised_date, description, category, owner, mitigation_target,
       probability, impact, response_strategy, mitigation_plan, residual_probability, residual_impact,
       is_critical, triggers, contingency_plan, remarks)
      VALUES (@project_id, @title, @status, @raised_date, @description, @category, @owner, @mitigation_target,
       @probability, @impact, @response_strategy, @mitigation_plan, @residual_probability, @residual_impact,
       @is_critical, @triggers, @contingency_plan, @remarks)`);
    const insertIssue = db.prepare(`INSERT INTO issues
      (project_id, title, status, raised_date, description, category, owner, raised_by, priority, severity, target_resolution_date,
       actual_resolution_date, impact_description, root_cause, resolution_plan, verification_notes, related_risk_id, is_escalated, remarks)
      VALUES (@project_id, @title, @status, @raised_date, @description, @category, @owner, @raised_by, @priority, @severity, @target_resolution_date,
       @actual_resolution_date, @impact_description, @root_cause, @resolution_plan, @verification_notes, @related_risk_id, @is_escalated, @remarks)`);

    const attentionPool = projectRows.filter(attentionHint);
    const riskPool = attentionPool.length ? attentionPool : projectRows;
    const riskCount = randInt(18, 22);
    const riskIdsByProject = {};
    for (let i = 0; i < riskCount; i++) {
      const proj = pick(riskPool);
      const row = demoData.riskRow(proj, pick, randInt);
      const info = await insertRisk.run({
        project_id: proj.id, title: row.title, status: row.status,
        raised_date: toISO(row.raised_date), description: row.description, category: row.category, owner: row.owner,
        mitigation_target: row.mitigation_target ? toISO(row.mitigation_target) : null,
        probability: row.probability, impact: row.impact, response_strategy: row.response_strategy,
        mitigation_plan: row.mitigation_plan, residual_probability: row.residual_probability, residual_impact: row.residual_impact,
        is_critical: row.is_critical, triggers: row.triggers, contingency_plan: row.contingency_plan, remarks: row.remarks
      });
      (riskIdsByProject[proj.id] = riskIdsByProject[proj.id] || []).push(info.lastInsertRowid);
    }

    const issuePool = attentionPool.length ? attentionPool : projectRows;
    const issueCount = randInt(16, 20);
    for (let i = 0; i < issueCount; i++) {
      const proj = pick(issuePool);
      const row = demoData.issueRow(proj, pick, randInt, riskIdsByProject[proj.id]);
      await insertIssue.run({
        project_id: proj.id, title: row.title, status: row.status,
        raised_date: toISO(row.raised_date), description: row.description, category: row.category, owner: row.owner,
        raised_by: row.raised_by, priority: row.priority, severity: row.severity,
        target_resolution_date: toISO(row.target_resolution_date),
        actual_resolution_date: row.actual_resolution_date ? toISO(row.actual_resolution_date) : null,
        impact_description: row.impact_description, root_cause: row.root_cause, resolution_plan: row.resolution_plan,
        verification_notes: row.verification_notes,
        related_risk_id: row.related_risk_id || null, is_escalated: row.is_escalated, remarks: row.remarks
      });
    }

    const insertMilestone = db.prepare('INSERT INTO milestones (project_id, milestone, due_date, status) VALUES (?, ?, ?, ?)');
    for (const p of projectRows) {
      if (rng() < 0.72) {
        const mStatus = p.status === 'Delayed' ? 'Delayed' : p.status === 'At Risk' ? pick(['At Risk', 'On Track']) : 'On Track';
        const milestone = p.status === 'Completed' ? 'Handover' : pick(MILESTONE_TYPES);
        const due = new Date(2026, 7 + randInt(0, 2), randInt(1, 28));
        await insertMilestone.run(p.id, milestone, toISO(due), mStatus);
      }
    }

    const insertTrend = db.prepare('INSERT INTO programme_trend (month, seq, planned, actual, spend) VALUES (?, ?, ?, ?, ?)');
    let planCum = 8, actCum = 6, spendCum = 1.2;
    for (const [idx, mo] of MONTHS.entries()) {
      planCum += rand(6, 10); actCum += rand(4, 9.5); spendCum += rand(1.1, 2.4);
      await insertTrend.run(mo, idx, Math.min(100, +planCum.toFixed(1)), Math.min(100, +actCum.toFixed(1)), +spendCum.toFixed(2));
    }

    // Team directory (shared across all projects) + a starting set of project members so
    // the Resources tab isn't empty on first run. External parties / groups are left for
    // the user to add per project, same as Change Requests starts empty.
    const insertTeamMember = db.prepare(`INSERT INTO team_members (name, department, designation, email, access_level)
      VALUES (@name, @department, @designation, @email, @access_level)`);
    const teamMemberIds = [];
    for (const m of demoData.TEAM_DIRECTORY) teamMemberIds.push((await insertTeamMember.run(m)).lastInsertRowid);

    const insertProjectMember = db.prepare('INSERT INTO project_members (project_id, team_member_id) VALUES (?, ?)');
    for (const p of projectRows) {
      const count = randInt(2, 4);
      const chosen = new Set();
      while (chosen.size < count) chosen.add(pick(teamMemberIds));
      for (const tmId of chosen) await insertProjectMember.run(p.id, tmId);
    }

    console.log(`Seeded ${projectRows.length} projects, ${riskCount} risks, ${issueCount} issues, ${teamMemberIds.length} team members, ${MONTHS.length} months of programme trend.`);
  });

  await run();
}

module.exports = seed;

if (require.main === module) {
  const db = require('./index');
  (async () => {
    await db.init();
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM projects').get();
    if (n > 0) throw new Error(`the database already has ${n} project(s) — demo data is only seeded into an empty database.`);
    await seed(db);
  })()
    .catch(e => { console.error('Seed aborted:', e.message); process.exitCode = 1; })
    .finally(() => db.close());
}
