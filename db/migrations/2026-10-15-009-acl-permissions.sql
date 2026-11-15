-- Migration 2026-10-15-009: per-login permission matrix (ACL)
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
--
-- JSON object { resource: [actions] } — e.g. {"risks":["view","create"],"invoices":["view"]} — set by the
-- administrator. NULL = the role's template (approver: nothing; read_only: view everything;
-- project_manager: view/create/edit/delete on the project resources, view on master data and team).
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS permissions TEXT;
