-- Production upgrade script for this batch of changes only (adds to, does not replace,
-- earlier migration files). Not re-run-safe (SQLite has no ADD COLUMN IF NOT EXISTS) -- if
-- you're not certain whether it's already been applied, run this first:
--   PRAGMA table_info(business_units);
-- and skip the ALTER line if logo_path already appears.
--
-- Business Unit letterhead logo (filename under uploads/business-unit-logos/, served via
-- /api/business-units/:id/logo), shown on print documents in place of a hardcoded
-- organization name. No backfill -- starts NULL for every existing unit.

-- *** Run only if the column is not already present (see PRAGMA check above) ***
ALTER TABLE business_units ADD COLUMN logo_path TEXT;
