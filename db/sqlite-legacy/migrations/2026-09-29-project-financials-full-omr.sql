-- Production upgrade script for this batch of changes only. NOT idempotent -- this is a
-- one-time data-scale conversion with no schema marker to check, so `npm run migrate`
-- (db/runMigration.js -> db/migrate.js) guards it internally via PRAGMA user_version instead.
-- Do NOT run the UPDATE below by hand unless PRAGMA user_version is currently 0 -- running it
-- twice will multiply these figures by 1,000,000 a second time and corrupt them. Prefer
-- `npm run migrate`, which checks this for you.
--
--   PRAGMA user_version;   -- must print 0 before running the UPDATE below
--
-- Approved Budget / Contract Value / Actual Cost / Committed Cost used to be stored (and
-- entered) in OMR Millions (e.g. 0.144582 for OMR 144,582). Now stored as plain full OMR,
-- matching every other monetary field in the app.

UPDATE projects SET
  approved_budget = approved_budget * 1000000,
  contract_value = contract_value * 1000000,
  actual_cost = actual_cost * 1000000,
  committed_cost = committed_cost * 1000000;

PRAGMA user_version = 1;
