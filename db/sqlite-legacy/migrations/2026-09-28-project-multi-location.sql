-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- earlier migration files). Best applied via `npm run migrate` (db/runMigration.js), which
-- re-runs schema.sql (creates the table below via CREATE TABLE IF NOT EXISTS) and then
-- db/migrate.js, which backfills every existing project's current governorate_id in as its
-- first location row -- that backfill is one INSERT...SELECT (see db/migrate.js) and is safe
-- to include here too, so this script is fully self-contained if run manually.

CREATE TABLE IF NOT EXISTS project_governorates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  governorate_id  INTEGER NOT NULL REFERENCES governorates(id) ON DELETE CASCADE,
  UNIQUE(project_id, governorate_id)
);

INSERT INTO project_governorates (project_id, governorate_id)
SELECT p.id, p.governorate_id FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM project_governorates pg WHERE pg.project_id = p.id);
