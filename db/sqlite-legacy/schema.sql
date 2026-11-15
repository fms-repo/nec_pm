CREATE TABLE IF NOT EXISTS governorates (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS project_types (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS contractors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  base_performance  INTEGER NOT NULL DEFAULT 75
);

-- Business Units: which internal entity (NEC, AAMU, ECTRON, ...) owns a project. A simple
-- name-only master like governorates/project_types, editable by the user so new units can be
-- added later without a code change. logo_path (filename under uploads/business-unit-logos/,
-- served via /api/business-units/:id/logo) is the letterhead shown on print documents.
CREATE TABLE IF NOT EXISTS business_units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  logo_path  TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  governorate_id      INTEGER NOT NULL REFERENCES governorates(id),
  city                TEXT,
  project_type_id     INTEGER NOT NULL REFERENCES project_types(id),
  contractor_id       INTEGER REFERENCES contractors(id),
  status              TEXT NOT NULL DEFAULT 'Not Started',
  planned_pct         REAL NOT NULL DEFAULT 0,
  actual_pct          REAL NOT NULL DEFAULT 0,
  approved_budget     REAL NOT NULL DEFAULT 0,
  contract_value      REAL NOT NULL DEFAULT 0,
  actual_cost         REAL NOT NULL DEFAULT 0,
  committed_cost      REAL NOT NULL DEFAULT 0,
  expected_delay_days INTEGER NOT NULL DEFAULT 0,
  start_date          TEXT,
  end_date            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Risk register: potential future events, scored Probability x Impact (1-5 each) with an
-- optional post-mitigation residual score. `severity` is legacy (pre-register model) and is
-- superseded by the probability/impact score bands; kept only so old rows still have a value.
-- Extra columns (description, category, owner, probability, impact, ...) are added by
-- db/migrate.js rather than here, so the same migration path covers fresh and existing databases.
CREATE TABLE IF NOT EXISTS risks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'Medium',
  status       TEXT NOT NULL DEFAULT 'Open',
  raised_date  TEXT NOT NULL DEFAULT (date('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Issue log: problems that have already occurred (RAID-log "Issues"), tracked to resolution
-- rather than scored by probability. May optionally trace back to the risk that materialized.
CREATE TABLE IF NOT EXISTS issues (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id              INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  description             TEXT,
  category                TEXT NOT NULL DEFAULT 'Other',
  owner                   TEXT,
  priority                TEXT NOT NULL DEFAULT 'Medium',
  status                  TEXT NOT NULL DEFAULT 'Open',
  raised_date             TEXT NOT NULL DEFAULT (date('now')),
  target_resolution_date  TEXT,
  actual_resolution_date  TEXT,
  impact_description      TEXT,
  root_cause              TEXT,
  resolution_plan         TEXT,
  related_risk_id         INTEGER REFERENCES risks(id) ON DELETE SET NULL,
  is_escalated            INTEGER NOT NULL DEFAULT 0,
  remarks                 TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone    TEXT NOT NULL,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'On Track',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programme_trend (
  month    TEXT PRIMARY KEY,
  seq      INTEGER NOT NULL,
  planned  REAL NOT NULL,
  actual   REAL NOT NULL,
  spend    REAL NOT NULL
);

-- Project Brief line items: material consumption, crew/contractor allocation and
-- the sequence of events. Extra `projects` brief columns (objective, scope, priority,
-- funding_source, contract_reference, project_sponsor) are added by db/migrate.js
-- rather than here, so the same migration path covers both fresh and existing databases.

CREATE TABLE IF NOT EXISTS project_materials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL DEFAULT 'Execution / Construction',
  material_name   TEXT NOT NULL,
  specification   TEXT,
  unit            TEXT,
  planned_qty     REAL NOT NULL DEFAULT 0,
  consumed_qty    REAL NOT NULL DEFAULT 0,
  unit_rate       REAL NOT NULL DEFAULT 0,
  supplier        TEXT,
  delivery_date   TEXT,
  status          TEXT NOT NULL DEFAULT 'Ordered',
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS project_crews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL DEFAULT 'Execution / Construction',
  resource_type   TEXT NOT NULL DEFAULT 'Labour',
  resource_name   TEXT NOT NULL,
  contractor_id   INTEGER REFERENCES contractors(id),
  quantity        REAL NOT NULL DEFAULT 1,
  actual_qty      REAL NOT NULL DEFAULT 0,
  rate_basis      TEXT NOT NULL DEFAULT 'Per Day',
  unit_rate       REAL NOT NULL DEFAULT 0,
  allocated_days  REAL NOT NULL DEFAULT 0,
  start_date      TEXT,
  end_date        TEXT,
  status          TEXT NOT NULL DEFAULT 'Planned',
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS project_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq_no          INTEGER NOT NULL DEFAULT 1,
  stage           TEXT NOT NULL DEFAULT 'Execution / Construction',
  event_name      TEXT NOT NULL,
  planned_start   TEXT,
  planned_end     TEXT,
  actual_start    TEXT,
  actual_end      TEXT,
  status          TEXT NOT NULL DEFAULT 'Not Started',
  remarks         TEXT
);

-- Invoices are generated from a selection of a project's material/crew cost
-- line items. invoice_items snapshot their description/qty/rate at creation
-- time (not a live join) so an invoice never silently changes if the source
-- material/crew row is edited or deleted afterwards.
CREATE TABLE IF NOT EXISTS invoices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invoice_number       TEXT NOT NULL UNIQUE,
  invoice_date         TEXT NOT NULL DEFAULT (date('now')),
  due_date             TEXT,
  status               TEXT NOT NULL DEFAULT 'Draft',
  bill_from_name       TEXT,
  bill_from_address    TEXT,
  bill_from_contact    TEXT,
  bill_to_name         TEXT,
  bill_to_address      TEXT,
  bill_to_contact      TEXT,
  margin_mode          TEXT NOT NULL DEFAULT 'line',
  global_margin_type   TEXT NOT NULL DEFAULT 'percent',
  global_margin_value  REAL NOT NULL DEFAULT 0,
  vat_rate             REAL NOT NULL DEFAULT 5,
  payment_terms        TEXT,
  bank_details         TEXT,
  notes                TEXT,
  subtotal             REAL NOT NULL DEFAULT 0,
  margin_total         REAL NOT NULL DEFAULT 0,
  vat_amount           REAL NOT NULL DEFAULT 0,
  grand_total          REAL NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL DEFAULT 'material',
  source_id       INTEGER,
  stage           TEXT,
  description     TEXT NOT NULL,
  quantity        REAL NOT NULL DEFAULT 1,
  unit            TEXT,
  unit_rate       REAL NOT NULL DEFAULT 0,
  base_amount     REAL NOT NULL DEFAULT 0,
  margin_type     TEXT NOT NULL DEFAULT 'percent',
  margin_value    REAL NOT NULL DEFAULT 0,
  margin_amount   REAL NOT NULL DEFAULT 0,
  line_total      REAL NOT NULL DEFAULT 0,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoices_project ON invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- Document repository: files are stored on disk outside the public/ web root
-- (uploads/<project_id>/<stored_filename>) and served through an authenticated
-- download route, not express.static, so the upload folder is never directly
-- browsable and every download goes through a session check.
CREATE TABLE IF NOT EXISTS project_documents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category           TEXT NOT NULL DEFAULT 'Other',
  title              TEXT NOT NULL,
  notes              TEXT,
  original_filename  TEXT NOT NULL,
  stored_filename    TEXT NOT NULL,
  mime_type          TEXT,
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  uploaded_by        TEXT,
  uploaded_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Completion certificates: Provisional (issued at practical completion, before
-- the defects liability period) or Final (issued once the DLP has elapsed and
-- outstanding defects are cleared). A project can have more than one over its
-- lifecycle (e.g. one Provisional, then one Final), so this mirrors invoices:
-- a per-project list rather than a single record on the project itself.
CREATE TABLE IF NOT EXISTS completion_certificates (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id               INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  certificate_number       TEXT NOT NULL UNIQUE,
  certificate_type         TEXT NOT NULL DEFAULT 'Provisional',
  status                   TEXT NOT NULL DEFAULT 'Draft',
  completion_date          TEXT,
  inspection_date          TEXT,
  defects_liability_start  TEXT,
  defects_liability_end    TEXT,
  contract_value           REAL NOT NULL DEFAULT 0,
  final_cost               REAL NOT NULL DEFAULT 0,
  engineer_name            TEXT,
  engineer_title           TEXT,
  contractor_rep_name      TEXT,
  contractor_rep_title     TEXT,
  client_rep_name          TEXT,
  client_rep_title         TEXT,
  outstanding_items        TEXT,
  remarks                  TEXT,
  issued_at                TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VOWD (Value of Work Done) Statements: an accrual / account-closure snapshot comparing what
-- was last billed & certified against the cumulative work done as of a given date — distinct
-- from a completion certificate (which certifies the works themselves at handover). A project
-- is typically re-stated every billing cycle, so this mirrors invoices/certificates: a
-- per-project list rather than a single record on the project. Every "lb_" (Last Billed &
-- Certified) / "cum_" (Cumulative as of statement date) pair is a raw user-entered amount;
-- VOWD subtotals, VAT and Net Due are derived at read time (server.js#serializeVowd) rather
-- than stored, the same way Cost Statement and crew line totals are derived elsewhere.
CREATE TABLE IF NOT EXISTS vowd_statements (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id                INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vowd_number                TEXT NOT NULL UNIQUE,
  status                     TEXT NOT NULL DEFAULT 'Draft',
  statement_date             TEXT,
  financial_year             TEXT,
  as_of_date                 TEXT,
  last_billed_ref            TEXT,
  contract_no                TEXT,
  contractor_name            TEXT,
  subcontractor_id           INTEGER REFERENCES contractors(id),
  project_title              TEXT,
  contract_owner             TEXT,
  general_manager            TEXT,
  supply_chain_management    TEXT,
  awarded_contract_value     REAL NOT NULL DEFAULT 0,
  variation_order_value      REAL NOT NULL DEFAULT 0,
  approved_vo_ref            TEXT,
  vat_pct                    REAL NOT NULL DEFAULT 5,
  lb_work_done                REAL NOT NULL DEFAULT 0,
  lb_variations                REAL NOT NULL DEFAULT 0,
  lb_materials_at_site         REAL NOT NULL DEFAULT 0,
  lb_advance_paid              REAL NOT NULL DEFAULT 0,
  lb_advance_recovered         REAL NOT NULL DEFAULT 0,
  lb_retention_deduction       REAL NOT NULL DEFAULT 0,
  lb_previously_certified      REAL NOT NULL DEFAULT 0,
  lb_other_deductions          REAL NOT NULL DEFAULT 0,
  cum_work_done                REAL NOT NULL DEFAULT 0,
  cum_variations                REAL NOT NULL DEFAULT 0,
  cum_materials_at_site         REAL NOT NULL DEFAULT 0,
  cum_advance_paid              REAL NOT NULL DEFAULT 0,
  cum_advance_recovered         REAL NOT NULL DEFAULT 0,
  cum_retention_deduction       REAL NOT NULL DEFAULT 0,
  cum_previously_certified      REAL NOT NULL DEFAULT 0,
  cum_other_deductions          REAL NOT NULL DEFAULT 0,
  item_notes                 TEXT,
  retention_remarks          TEXT,
  issued_at                  TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vowd_project ON vowd_statements(project_id);

-- Change management (PMBOK-style integrated change control): a Change Request moves
-- through Initial Analysis (impact assessment) to a Change Control Board decision.
-- CR status is derived, not stored — Submitted (no analysis yet) -> Under Analysis (has
-- an analysis, no decision) -> the latest decision's outcome (Approved/Rejected/Deferred).
CREATE TABLE IF NOT EXISTS change_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cr_code             TEXT NOT NULL UNIQUE,
  cr_type             TEXT NOT NULL DEFAULT 'Scope',
  cr_source           TEXT NOT NULL DEFAULT 'Client',
  subcontractor_id    INTEGER REFERENCES contractors(id),
  submitter_name      TEXT,
  description         TEXT NOT NULL,
  date_submitted      TEXT NOT NULL DEFAULT (date('now')),
  date_required       TEXT,
  priority             TEXT NOT NULL DEFAULT 'Medium',
  reason_for_change    TEXT,
  assumptions_notes    TEXT,
  comments             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_analyses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  change_request_id  INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  category            TEXT NOT NULL DEFAULT 'Other',
  sub_category        TEXT,
  hour_impact         REAL NOT NULL DEFAULT 0,  -- retired (no longer shown/edited), kept for history
  duration_impact     REAL NOT NULL DEFAULT 0,  -- retired: superseded by duration_months + duration_days
  duration_months     INTEGER NOT NULL DEFAULT 0,
  duration_days       INTEGER NOT NULL DEFAULT 0,
  schedule_impact     TEXT NOT NULL DEFAULT 'No',  -- 'Yes' | 'No'
  cost_impact         REAL NOT NULL DEFAULT 0,
  comments             TEXT,
  recommendations     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_decisions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  change_request_id       INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  decision                  TEXT NOT NULL DEFAULT 'Approved',
  decision_date             TEXT NOT NULL DEFAULT (date('now')),
  decision_explanation     TEXT,
  revised_completion_date TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team directory (company users), shared across all projects. project_members below assigns
-- individuals from this directory onto a specific project; access_level gates who shows up
-- in a project's "add member" picker (only those with Project Management access can be
-- assigned to run/own project work — Finance/Read Only stay directory-only).
CREATE TABLE IF NOT EXISTS team_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'Planning',
  designation   TEXT NOT NULL DEFAULT 'Engineer',
  email         TEXT,
  access_level  TEXT NOT NULL DEFAULT 'Project Management',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project Resources: internal members (assigned from team_members), external parties (not
-- company staff — client reps, consultants, regulators…), and groups that organize both for
-- visibility/reporting. member_type + member_id on group entries is a polymorphic reference
-- (same pattern as invoice_items.source_type/source_id) rather than two nullable FK columns.
CREATE TABLE IF NOT EXISTS project_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_member_id  INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, team_member_id)
);

-- Sub Contractors: a project's secondary/supporting contractors, distinct from the single
-- primary Contractor on the Project Brief (projects.contractor_id). Multi-select, edited
-- inline on the Brief tab and synced by full delete+reinsert on Save Project — the same
-- pattern used for project_materials/project_crews/project_events, rather than the
-- incremental add/remove endpoints project_members uses.
-- A project can span more than one governorate/location. projects.governorate_id stays the
-- "primary" location (first one picked, still used to attribute risks/issues/milestones and
-- for single-select filters), while this table holds the full set shown on the Project Brief
-- tab and in location-based charts/filters (a project counts toward each of its locations).
CREATE TABLE IF NOT EXISTS project_governorates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  governorate_id  INTEGER NOT NULL REFERENCES governorates(id) ON DELETE CASCADE,
  UNIQUE(project_id, governorate_id)
);

CREATE TABLE IF NOT EXISTS project_subcontractors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id   INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  UNIQUE(project_id, contractor_id)
);

CREATE TABLE IF NOT EXISTS project_external_parties (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  organization  TEXT,
  role          TEXT NOT NULL DEFAULT 'Consultant',
  email         TEXT,
  phone         TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_resource_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_resource_group_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     INTEGER NOT NULL REFERENCES project_resource_groups(id) ON DELETE CASCADE,
  member_type  TEXT NOT NULL DEFAULT 'member',
  member_id    INTEGER NOT NULL,
  UNIQUE(group_id, member_type, member_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_team_member ON project_members(team_member_id);
CREATE INDEX IF NOT EXISTS idx_external_parties_project ON project_external_parties(project_id);
CREATE INDEX IF NOT EXISTS idx_resource_groups_project ON project_resource_groups(project_id);
CREATE INDEX IF NOT EXISTS idx_resource_group_entries_group ON project_resource_group_entries(group_id);

CREATE INDEX IF NOT EXISTS idx_documents_project ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_certificates_project ON completion_certificates(project_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_project ON change_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_change_analyses_cr ON change_analyses(change_request_id);
CREATE INDEX IF NOT EXISTS idx_change_decisions_cr ON change_decisions(change_request_id);

CREATE INDEX IF NOT EXISTS idx_projects_gov ON projects(governorate_id);
CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(project_type_id);
CREATE INDEX IF NOT EXISTS idx_projects_contractor ON projects(contractor_id);
CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_related_risk ON issues(related_risk_id);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_materials_project ON project_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_crews_project ON project_crews(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON project_events(project_id);
