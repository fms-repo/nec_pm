-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- the earlier 2026-09-27* migration files). Not re-run-safe (SQLite has no
-- ADD COLUMN IF NOT EXISTS) -- if you're not certain whether it's already been applied,
-- run this first:
--   PRAGMA table_info(project_events);
-- and skip the ALTER line if is_collapsed already appears.

-- *** Run only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE project_events ADD COLUMN is_collapsed INTEGER NOT NULL DEFAULT 0;
