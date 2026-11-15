-- Production upgrade script for this batch of changes only. `npm run migrate`
-- (db/runMigration.js -> db/migrate.js) applies this automatically and only once (it checks
-- whether each column already exists) -- prefer that over running this by hand.
--
-- Change Request "CR Type": who raised the change -- Client or Subcontractor. Separate from
-- the existing cr_type column (the change category: Scope / Schedule / Cost / ...).
-- Existing change requests default to Client. A Subcontractor CR must name the
-- subcontractor (subcontractor_id), which the API enforces.

ALTER TABLE change_requests ADD COLUMN cr_source TEXT NOT NULL DEFAULT 'Client';
ALTER TABLE change_requests ADD COLUMN subcontractor_id INTEGER REFERENCES contractors(id);
