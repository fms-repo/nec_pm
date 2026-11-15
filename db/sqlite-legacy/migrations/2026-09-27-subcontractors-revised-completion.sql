-- Production upgrade script for this session's schema changes only (everything added
-- since 2026-09-24-business-units-vowd.sql). Safe to re-run: CREATE TABLE uses
-- IF NOT EXISTS. The ALTER TABLE statement is NOT re-run-safe (SQLite has no
-- ADD COLUMN IF NOT EXISTS) -- if you're not certain whether it's already been applied,
-- run this first:
--   PRAGMA table_info(change_decisions);
-- and skip the ALTER line if revised_completion_date already appears.

-- *** Run only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE change_decisions ADD COLUMN revised_completion_date TEXT;

-- Sub Contractors multi-select on the Project Brief tab, distinct from the single
-- primary Contractor (projects.contractor_id).
CREATE TABLE IF NOT EXISTS project_subcontractors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contractor_id   INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  UNIQUE(project_id, contractor_id)
);
