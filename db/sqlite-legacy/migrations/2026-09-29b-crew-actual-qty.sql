-- Production upgrade script for this batch of changes only. `npm run migrate`
-- (db/runMigration.js -> db/migrate.js) applies this automatically and only once (it checks
-- whether the column already exists) -- prefer that over running this by hand.
--
-- Crew / labour lines gain an Actual Qty (mirrors a material's Consumed Qty). Actual labour
-- cost is now Actual Qty x Unit Rate (x Days unless Lump Sum) instead of the full planned cost
-- once a crew is Mobilized/Demobilized. The backfill keeps every existing actual-cost total
-- unchanged: Mobilized/Demobilized crews get Actual Qty = their Planned Qty, Planned stay 0.

ALTER TABLE project_crews ADD COLUMN actual_qty REAL NOT NULL DEFAULT 0;

UPDATE project_crews SET actual_qty = quantity WHERE status IN ('Mobilized', 'Demobilized');
