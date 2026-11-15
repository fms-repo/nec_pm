-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- the earlier 2026-09-27* migration files). Not re-run-safe (SQLite has no
-- ADD COLUMN IF NOT EXISTS) -- if you're not certain whether it's already been applied,
-- run this first:
--   PRAGMA table_info(project_materials);
--   PRAGMA table_info(project_crews);
-- and skip straight to the backfill note below if event_id already appears on both.
--
-- Materials/Crew now attach to a specific Sequence of Events entry, not just a Stage, so
-- two events sharing a stage no longer share one Materials/Crew panel. This is best applied
-- via `npm run migrate` (db/runMigration.js), which also runs the one-time backfill in
-- db/migrate.js that assigns each existing row to whichever event currently "owns" its
-- stage -- that backfill logic is JS (project-grouped, ordered by seq_no), not expressible
-- as a single portable SQL statement, so it is NOT included below. Running the ALTERs here
-- without that backfill will leave every existing material/crew row unassigned (event_id
-- NULL) -- visible, but bucketed into "Other Materials & Crew" instead of under the event
-- it's shown under today. Prefer `npm run migrate` for this batch.

-- *** Run only if the columns are not already present (see PRAGMA check above) ***
ALTER TABLE project_materials ADD COLUMN event_id INTEGER REFERENCES project_events(id) ON DELETE SET NULL;
ALTER TABLE project_crews ADD COLUMN event_id INTEGER REFERENCES project_events(id) ON DELETE SET NULL;
