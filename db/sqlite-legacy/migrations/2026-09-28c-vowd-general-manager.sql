-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- earlier migration files). Not re-run-safe (SQLite has no ADD COLUMN IF NOT EXISTS) -- if
-- you're not certain whether it's already been applied, run this first:
--   PRAGMA table_info(vowd_statements);
-- and skip the ALTER line if general_manager already appears.
--
-- New third VOWD signatory line (General Manager), alongside Supply Chain Management.
-- The old "Contract Owner" free-text field is retired in the UI in favour of the project's
-- own Project Sponsor (Project Brief), read live -- contract_owner is left in the table
-- (unused, no data loss) rather than dropped.

-- *** Run only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE vowd_statements ADD COLUMN general_manager TEXT;
