// Shared reference lists + generators for the project-brief child records
// (materials, crew/contractor allocation, sequence of events). Used by both
// db/seed.js (fresh install) and db/backfill.js (enriching an existing DB
// after migration so the new tabs aren't empty on already-seeded projects).

const STAGES = [
  'Mobilization', 'Design & Engineering', 'Procurement',
  'Execution / Construction', 'Testing & Commissioning',
  'Handover', 'Defects Liability', 'Closure'
];
const MATERIAL_STATUSES = ['Ordered', 'Delivered', 'Inspected', 'Rejected', 'Used'];
const RESOURCE_TYPES = ['Labour', 'Equipment', 'Subcontractor'];
const RATE_BASES = ['Per Day', 'Per Hour', 'Lump Sum'];
const CREW_STATUSES = ['Planned', 'Mobilized', 'Demobilized'];
const EVENT_STATUSES = ['Not Started', 'In Progress', 'Completed', 'Delayed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const FUNDING_SOURCES = ['Government Capex Budget', 'Nama Water Services Capex', 'World Bank Loan Facility', 'PPP Financing', 'Donor Grant Funding'];

// Risk register / issue log demo generators. Risk = a potential future event, scored
// Probability x Impact; Issue = something that has already happened, tracked to resolution.
// Both draw on the same category/owner pools so the two logs read as one coherent programme.
const RAID_CATEGORIES = ['Cost', 'Schedule', 'Technical', 'Contractual', 'HSE', 'Environmental', 'Quality', 'Resource', 'Stakeholder', 'Regulatory', 'Other'];
const RESPONSE_STRATEGIES = ['Avoid', 'Mitigate', 'Transfer', 'Accept'];
const RISK_STATUSES = ['Open', 'Watching', 'Mitigating', 'Closed'];
const ISSUE_STATUSES = ['Open', 'In Progress', 'Blocked', 'Resolved', 'Closed'];
const TEAM_OWNERS = ['Ahmed Al Balushi', 'Fatma Al Habsi', 'Khalid Al Harthy', 'Mariam Al Saadi', 'Salim Al Rawahi', 'Aisha Al Zadjali', 'Yousuf Al Maskari', 'Noura Al Kindi', 'Talal Al Amri', 'Suad Al Farsi'];
// Team directory backing Project Resources — same names as TEAM_OWNERS above so a person
// already showing up as a risk owner / issue assignee / event owner is also a real directory
// entry with a department and designation (and the "Tasks assigned" count on the Resources
// tab, which matches by name against project_events.assigned_to, lines up meaningfully).
const DEPARTMENTS = ['Planning', 'Design & Engineering', 'Procurement', 'Execution', 'Quality', 'HSE', 'Finance', 'Contracts'];
const ACCESS_LEVELS = ['Project Management', 'Finance', 'Read Only'];
const TEAM_DIRECTORY = [
  { name: 'Ahmed Al Balushi', department: 'Planning', designation: 'Project Manager', access_level: 'Project Management' },
  { name: 'Fatma Al Habsi', department: 'Design & Engineering', designation: 'Design Engineer', access_level: 'Project Management' },
  { name: 'Khalid Al Harthy', department: 'Execution', designation: 'Site Engineer', access_level: 'Project Management' },
  { name: 'Mariam Al Saadi', department: 'Quality', designation: 'QA/QC Engineer', access_level: 'Project Management' },
  { name: 'Salim Al Rawahi', department: 'Planning', designation: 'Project Manager', access_level: 'Project Management' },
  { name: 'Aisha Al Zadjali', department: 'HSE', designation: 'HSE Officer', access_level: 'Project Management' },
  { name: 'Yousuf Al Maskari', department: 'Procurement', designation: 'Procurement Officer', access_level: 'Project Management' },
  { name: 'Noura Al Kindi', department: 'Design & Engineering', designation: 'Design Engineer', access_level: 'Project Management' },
  { name: 'Talal Al Amri', department: 'Execution', designation: 'Site Supervisor', access_level: 'Project Management' },
  { name: 'Suad Al Farsi', department: 'Finance', designation: 'Cost Controller', access_level: 'Finance' }
].map(m => ({ ...m, email: m.name.toLowerCase().replace(/\s+/g, '.') + '@nwatarabot.om' }));
// Fixed reference "today" for demo data so identified/raised/target dates stay coherent with
// the rest of the seeded programme timeline regardless of when the seed script actually runs.
const DEMO_TODAY = new Date(2026, 8, 15);

const RISK_TITLES = [
  'Contractor mobilization delay risk', 'Budget variation approval risk', 'Utility clash risk at crossing points',
  'Material price escalation risk', 'Land access / way-leave dispute risk', 'Testing equipment calibration risk',
  'Subcontractor resourcing shortfall risk', 'Weather-related site suspension risk', 'Design change risk pending client review',
  'Permit approval delay risk with municipality', 'Traffic diversion approval risk', 'Long-lead item delivery slippage risk',
  'Groundwater / dewatering complexity risk', 'Key personnel turnover risk on contractor team', 'Third-party asset relocation delay risk'
];
const ISSUE_TITLES = [
  'Contractor mobilization delay', 'Budget variation approval pending', 'Road reinstatement delayed',
  'Material delivery delay', 'Utility clash discovered on site', 'Permit approval pending with municipality',
  'NCR reissued — pipe bedding compaction', 'Subcontractor resourcing shortfall', 'Design change request under review',
  'Traffic diversion approval delayed', 'Testing equipment calibration delay', 'Land access dispute with landowner',
  'Payment certificate delayed', 'Weather-related site suspension', 'Safety non-conformance under review'
];
const ISSUE_ROOT_CAUSES = ['Delayed third-party approval', 'Resource/material availability', 'Coordination gap with utility owner', 'Design ambiguity at issue', 'Weather / site access constraint'];

// Curated (non-random) starter checklists for the "Load template" quick-start action —
// a small set of common construction/water-infrastructure programme risks and issues so a
// new project isn't starting its register/log from a blank page.
const STARTER_RISKS = [
  { title: 'Contractor mobilization delay', category: 'Schedule', probability: 3, impact: 3, responseStrategy: 'Mitigate' },
  { title: 'Material price escalation', category: 'Cost', probability: 3, impact: 4, responseStrategy: 'Accept' },
  { title: 'Utility clash at crossing points', category: 'Technical', probability: 3, impact: 4, responseStrategy: 'Mitigate' },
  { title: 'Permit / approval delay with municipality', category: 'Regulatory', probability: 3, impact: 3, responseStrategy: 'Mitigate' },
  { title: 'Adverse weather / site access disruption', category: 'Environmental', probability: 2, impact: 3, responseStrategy: 'Accept' },
  { title: 'Key subcontractor resourcing shortfall', category: 'Resource', probability: 3, impact: 3, responseStrategy: 'Transfer' },
  { title: 'Land access / way-leave dispute', category: 'Stakeholder', probability: 2, impact: 4, responseStrategy: 'Mitigate' },
  { title: 'Health & safety incident on site', category: 'HSE', probability: 2, impact: 5, responseStrategy: 'Avoid' }
];
const STARTER_ISSUES = [
  { title: 'Contractor mobilization delay', category: 'Schedule', priority: 'High', severity: 'Medium' },
  { title: 'Material delivery delay', category: 'Cost', priority: 'Medium', severity: 'Medium' },
  { title: 'Utility clash discovered on site', category: 'Technical', priority: 'High', severity: 'High' },
  { title: 'Permit approval pending with municipality', category: 'Regulatory', priority: 'Medium', severity: 'Low' },
  { title: 'NCR — quality non-conformance', category: 'Quality', priority: 'High', severity: 'High' },
  { title: 'Payment certificate delayed', category: 'Cost', priority: 'Medium', severity: 'Low' },
  { title: 'Design change request under review', category: 'Technical', priority: 'Medium', severity: 'Medium' },
  { title: 'Weather-related site suspension', category: 'Environmental', priority: 'Low', severity: 'Low' }
];

function riskRow(project, pick, randInt) {
  const attention = project.status === 'Delayed' || project.status === 'At Risk';
  const probability = attention ? randInt(3, 5) : randInt(1, 4);
  const impact = attention ? randInt(3, 5) : randInt(2, 5);
  const status = pick(attention ? ['Open', 'Open', 'Watching', 'Mitigating'] : RISK_STATUSES);
  const identified = new Date(DEMO_TODAY.getTime() - randInt(10, 150) * 86400000);
  const hasTarget = status !== 'Closed' && pick([true, true, false]);
  const target = hasTarget ? new Date(identified.getTime() + randInt(14, 90) * 86400000) : null;
  const hasResidual = status === 'Mitigating' || status === 'Closed';
  return {
    title: pick(RISK_TITLES),
    description: 'Identified during routine project risk review; monitored by the project team for changes in likelihood or impact.',
    category: pick(RAID_CATEGORIES),
    owner: pick(TEAM_OWNERS),
    status,
    raised_date: identified,
    mitigation_target: target,
    probability, impact,
    response_strategy: pick(RESPONSE_STRATEGIES),
    mitigation_plan: 'Weekly monitoring with the contractor; escalate to programme management if likelihood or impact increases.',
    residual_probability: hasResidual ? Math.max(1, probability - randInt(1, 2)) : null,
    residual_impact: hasResidual ? Math.max(1, impact - randInt(0, 1)) : null,
    is_critical: (probability * impact >= 20) ? 1 : 0,
    triggers: 'Slippage against baseline programme; repeated non-conformance reports; contractor correspondence flagging the risk.',
    contingency_plan: 'Engage an alternate contractor/resource pool and adjust downstream sequencing if the risk materializes.',
    remarks: null
  };
}

function issueRow(project, pick, randInt, relatedRiskIds) {
  const attention = project.status === 'Delayed' || project.status === 'At Risk';
  const priority = attention ? pick(['High', 'High', 'Critical', 'Medium']) : pick(PRIORITIES);
  const severity = attention ? pick(['High', 'Critical', 'Medium']) : pick(PRIORITIES);
  const status = pick(attention ? ['Open', 'Open', 'In Progress', 'Blocked'] : ISSUE_STATUSES);
  const raised = new Date(DEMO_TODAY.getTime() - randInt(2, 150) * 86400000);
  const isResolved = status === 'Resolved' || status === 'Closed';
  const target = new Date(raised.getTime() + randInt(7, 45) * 86400000);
  const actualResolution = isResolved ? new Date(raised.getTime() + randInt(5, 40) * 86400000) : null;
  const linkToRisk = relatedRiskIds && relatedRiskIds.length && pick([true, false, false, false]);
  return {
    title: pick(ISSUE_TITLES),
    description: 'Reported by the site team; logged for tracking to resolution and closure sign-off.',
    category: pick(RAID_CATEGORIES),
    owner: pick(TEAM_OWNERS),
    raised_by: pick(TEAM_OWNERS),
    priority,
    severity,
    status,
    raised_date: raised,
    target_resolution_date: target,
    actual_resolution_date: actualResolution,
    impact_description: 'Affecting site progress and/or cost if not resolved by the target date.',
    root_cause: pick(ISSUE_ROOT_CAUSES),
    resolution_plan: 'Corrective action agreed with the contractor; progress tracked at the weekly site meeting.',
    verification_notes: isResolved ? 'Fix confirmed on site and closed out with the contractor.' : null,
    related_risk_id: linkToRisk ? pick(relatedRiskIds) : null,
    is_escalated: (status === 'Blocked' || priority === 'Critical') ? 1 : 0,
    remarks: null
  };
}

const MATERIAL_NAMES = ['DI Pipe 300mm', 'DI Pipe 200mm', 'HDPE Pipe 160mm', 'Gate Valve 300mm', 'Butterfly Valve 200mm', 'PRV Assembly', 'Electromagnetic Flow Meter', 'Precast Valve Chamber', 'Bedding Sand', 'Asphalt (Road Reinstatement)', 'Concrete Grade 30', 'Ductile Iron Fittings'];
const MATERIAL_UNITS = ['m', 'no', 'm3', 'ton', 'set'];
const SUPPLIERS = ['Oman Pipe Industries', 'Gulf Valves & Fittings LLC', 'Al Hassan Engineering Supplies', 'National Ready Mix', 'Barka Steel Trading'];
const RESOURCE_NAMES = {
  Labour: ['Pipe Laying Crew', 'Excavation Crew', 'Jointing & Welding Crew', 'Traffic Management Team', 'Survey Crew'],
  Equipment: ['Excavator 20T', 'Backhoe Loader', 'Compactor Roller', 'Dewatering Pump Set', 'Crane 25T'],
  Subcontractor: ['Road Reinstatement Subcontractor', 'Electrical Works Subcontractor', 'Disinfection & Testing Subcontractor']
};
const EVENT_TEMPLATES = [
  { stage: 'Mobilization', name: 'Site Mobilization & Setup' },
  { stage: 'Design & Engineering', name: 'Detailed Design Approval' },
  { stage: 'Procurement', name: 'Material Procurement & Delivery' },
  { stage: 'Execution / Construction', name: 'Pipeline Excavation' },
  { stage: 'Execution / Construction', name: 'Pipe Laying & Jointing' },
  { stage: 'Execution / Construction', name: 'Backfilling & Compaction' },
  { stage: 'Testing & Commissioning', name: 'Pressure Testing' },
  { stage: 'Testing & Commissioning', name: 'Flushing & Disinfection' },
  { stage: 'Handover', name: 'Handover to Operations' }
];

function briefFields(project, pick) {
  const cityOrGov = project.city || project.governorateName || 'the project area';
  const typeLabel = project.typeName ? project.typeName.toLowerCase() : 'water network';
  return {
    objective: `Rehabilitate and upgrade the water network to reduce leakage, improve pressure and supply reliability in ${cityOrGov}.`,
    scope: `Replacement/rehabilitation of ${typeLabel} infrastructure including associated civil works, network tie-ins and road reinstatement.`,
    priority: (project.status === 'Delayed' || project.status === 'At Risk') ? pick(['High', 'Critical']) : pick(PRIORITIES),
    funding_source: pick(FUNDING_SOURCES),
    contract_reference: `NWA/CTR/2026/${(project.code || 'P-0000').replace('P-', '')}`,
    project_sponsor: 'Programme Director – NWA/SUEZ'
  };
}

function materialRows(project, pick, randInt, rand, clamp) {
  const count = randInt(1, 4);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const planned = +rand(50, 600).toFixed(1);
    const ratio = project.status === 'Completed' ? 1 : project.status === 'Not Started' ? 0 : clamp(rand(0.2, 0.95), 0, 1);
    rows.push({
      stage: pick(STAGES.slice(2, 5)),
      material_name: pick(MATERIAL_NAMES),
      specification: 'As per approved technical specification',
      unit: pick(MATERIAL_UNITS),
      planned_qty: planned,
      consumed_qty: +(planned * ratio).toFixed(1),
      unit_rate: +rand(2, 180).toFixed(2),
      supplier: pick(SUPPLIERS),
      delivery_date: null,
      status: project.status === 'Completed' ? 'Used' : project.status === 'Not Started' ? 'Ordered' : pick(['Delivered', 'Inspected', 'Used']),
      notes: null
    });
  }
  return rows;
}

function crewRows(project, pick, randInt, rand, contractorId) {
  const count = randInt(1, 3);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const type = pick(RESOURCE_TYPES);
    const rateBasis = type === 'Subcontractor' ? pick(['Lump Sum', 'Per Day']) : pick(RATE_BASES);
    const quantity = type === 'Labour' ? randInt(2, 8) : randInt(1, 2);
    const status = project.status === 'Completed' ? 'Demobilized' : project.status === 'Not Started' ? 'Planned' : pick(['Mobilized', 'Planned']);
    rows.push({
      stage: pick(STAGES.slice(0, 5)),
      resource_type: type,
      resource_name: pick(RESOURCE_NAMES[type]),
      contractor_id: type === 'Subcontractor' ? contractorId : null,
      quantity,
      actual_qty: status === 'Planned' ? 0 : quantity,
      rate_basis: rateBasis,
      unit_rate: rateBasis === 'Lump Sum' ? +rand(1500, 12000).toFixed(2) : +rand(35, 320).toFixed(2),
      allocated_days: rateBasis === 'Lump Sum' ? 0 : randInt(5, 60),
      start_date: null,
      end_date: null,
      status,
      notes: null
    });
  }
  return rows;
}

function eventRows(project, pick, toISO) {
  const start = project.startDate instanceof Date ? project.startDate : new Date(project.startDate);
  const end = project.endDate instanceof Date ? project.endDate : new Date(project.endDate);
  const spanMs = Math.max(end.getTime() - start.getTime(), 1);
  const n = EVENT_TEMPLATES.length;
  const progressCutoff = project.status === 'Completed' ? 1 : project.status === 'Not Started' ? 0 : (project.actualPct || 0) / 100;

  return EVENT_TEMPLATES.map((tpl, idx) => {
    const fracStart = idx / n;
    const fracEnd = (idx + 1) / n;
    const plannedStart = new Date(start.getTime() + spanMs * fracStart);
    const plannedEnd = new Date(start.getTime() + spanMs * fracEnd);
    const isDone = fracEnd <= progressCutoff;
    const inProgress = !isDone && fracStart < progressCutoff;
    const status = isDone ? 'Completed' : inProgress ? 'In Progress' : (project.status === 'Delayed' && fracStart < progressCutoff + 0.15) ? 'Delayed' : 'Not Started';
    const progressPct = isDone ? 100 : inProgress ? Math.round(((progressCutoff - fracStart) / (fracEnd - fracStart)) * 100) : 0;
    return {
      seq_no: idx + 1,
      stage: tpl.stage,
      event_name: tpl.name,
      planned_start: toISO(plannedStart),
      planned_end: toISO(plannedEnd),
      actual_start: (isDone || inProgress) ? toISO(plannedStart) : null,
      actual_end: isDone ? toISO(plannedEnd) : null,
      status,
      assigned_to: TEAM_OWNERS[idx % TEAM_OWNERS.length],
      progress_pct: progressPct,
      remarks: null
    };
  });
}

module.exports = {
  STAGES, MATERIAL_STATUSES, RESOURCE_TYPES, RATE_BASES, CREW_STATUSES, EVENT_STATUSES, PRIORITIES, FUNDING_SOURCES,
  RAID_CATEGORIES, RESPONSE_STRATEGIES, RISK_STATUSES, ISSUE_STATUSES, TEAM_OWNERS, STARTER_RISKS, STARTER_ISSUES,
  DEPARTMENTS, ACCESS_LEVELS, TEAM_DIRECTORY,
  briefFields, materialRows, crewRows, eventRows, riskRow, issueRow
};
