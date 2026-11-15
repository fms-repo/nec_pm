-- Migration 2026-10-14-004: soft delete
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
--
-- Deleting one of these now only stamps deleted_at/deleted_by; the row stays (hidden everywhere)
-- until it is restored or permanently removed from the Recycle Bin. A soft-deleted project also
-- hides everything under it (risks, issues, events, invoices, ...) without touching those rows.
-- Kept rows still count towards per-project document numbering, so INV/CR/VOWD/certificate
-- numbers are never handed out twice.
ALTER TABLE projects                ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE projects                ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE change_requests         ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE change_requests         ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE invoices                ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE invoices                ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE completion_certificates ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE completion_certificates ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE vowd_statements         ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE vowd_statements         ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE project_documents       ADD COLUMN IF NOT EXISTS deleted_at TEXT;
ALTER TABLE project_documents       ADD COLUMN IF NOT EXISTS deleted_by TEXT;
