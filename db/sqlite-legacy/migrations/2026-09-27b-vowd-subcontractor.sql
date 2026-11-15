-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- 2026-09-27-subcontractors-revised-completion.sql). Not re-run-safe (SQLite has no
-- ADD COLUMN IF NOT EXISTS) -- if you're not certain whether it's already been applied,
-- run this first:
--   PRAGMA table_info(vowd_statements);
-- and skip the ALTER line if subcontractor_id already appears.

-- *** Run only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE vowd_statements ADD COLUMN subcontractor_id INTEGER REFERENCES contractors(id);
