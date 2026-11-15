-- Migration 2026-10-19-010: attachments belong to a specific change request
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
--
-- A change request needs its own supporting file(s) before it can be submitted for approval.
-- NULL = a project-level "Change Request" file uploaded before this migration (left as it was).
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS change_request_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_project_documents_cr ON project_documents(change_request_id);
