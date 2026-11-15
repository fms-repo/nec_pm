-- Migration 2026-10-06-003: change request signatory names
-- Adds the reviewer and Change Control Board approver names so the CR print preview's
-- signature block can show who reviewed/approved it, matching the VOWD pattern. The submitter
-- name (first signatory) already existed as submitter_name.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT;
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS ccb_approved_by_name TEXT;

