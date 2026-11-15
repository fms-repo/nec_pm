-- Production upgrade script for this batch of changes only. `npm run migrate`
-- (db/runMigration.js -> db/migrate.js) applies this automatically and only once (it checks
-- whether each column already exists) -- prefer that over running this by hand.
--
-- CR Initial Analysis:
--  * "Duration impact (days)" is replaced by two independently stored whole-number fields,
--    duration_months and duration_days. Existing values move into duration_days unchanged
--    (no days-to-months conversion is assumed).
--  * "Hour impact" is retired from the UI. hour_impact and duration_impact are left in
--    place, unused, so no history is lost.
--  * Schedule Impact becomes Yes/No: Minor/Moderate/Major -> Yes, None -> No.

ALTER TABLE change_analyses ADD COLUMN duration_months INTEGER NOT NULL DEFAULT 0;
ALTER TABLE change_analyses ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 0;

UPDATE change_analyses SET duration_days = CAST(ROUND(MAX(duration_impact, 0)) AS INTEGER);

UPDATE change_analyses
  SET schedule_impact = CASE WHEN schedule_impact IN ('Minor', 'Moderate', 'Major') THEN 'Yes' ELSE 'No' END
  WHERE schedule_impact NOT IN ('Yes', 'No');
