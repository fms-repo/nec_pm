-- Migration 2026-10-14-008: per-login menu access
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
--
-- JSON list of the sidebar menus a login may use, chosen by the administrator. NULL = the role's
-- default (approver: none beyond My Approvals; read_only / project_manager: every menu).
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS menus TEXT;
