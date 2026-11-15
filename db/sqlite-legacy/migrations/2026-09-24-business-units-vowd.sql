-- Production upgrade script for this session's schema changes only.
-- Safe to re-run: CREATE TABLE/INDEX use IF NOT EXISTS. The two ALTER TABLE
-- statements are NOT re-run-safe (SQLite has no ADD COLUMN IF NOT EXISTS) --
-- if you're not certain whether they've already been applied, run this first:
--   PRAGMA table_info(projects);
-- and skip the ALTER lines if business_unit_id / project_manager_id already appear.

CREATE TABLE IF NOT EXISTS business_units (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

INSERT INTO business_units (name)
  SELECT 'NEC' WHERE NOT EXISTS (SELECT 1 FROM business_units);
INSERT INTO business_units (name)
  SELECT 'AAMU' WHERE NOT EXISTS (SELECT 1 FROM business_units WHERE name = 'AAMU');
INSERT INTO business_units (name)
  SELECT 'ECTRON' WHERE NOT EXISTS (SELECT 1 FROM business_units WHERE name = 'ECTRON');

-- *** Run each ALTER only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE projects ADD COLUMN business_unit_id INTEGER REFERENCES business_units(id);
ALTER TABLE projects ADD COLUMN project_manager_id INTEGER REFERENCES team_members(id);

-- One-time backfill: existing projects default to the "NEC" business unit.
UPDATE projects
SET business_unit_id = (SELECT id FROM business_units WHERE name = 'NEC')
WHERE business_unit_id IS NULL;

-- One-time backfill: infer project_manager_id from whichever team member already
-- carries the "Project Manager" designation on that project's Resources tab.
UPDATE projects
SET project_manager_id = (
  SELECT tm.id FROM project_members pmem
  JOIN team_members tm ON tm.id = pmem.team_member_id AND tm.designation = 'Project Manager'
  WHERE pmem.project_id = projects.id
  LIMIT 1
)
WHERE project_manager_id IS NULL
  AND EXISTS (
    SELECT 1 FROM project_members pmem
    JOIN team_members tm ON tm.id = pmem.team_member_id AND tm.designation = 'Project Manager'
    WHERE pmem.project_id = projects.id
  );

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
  project_title              TEXT,
  contract_owner             TEXT,
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
