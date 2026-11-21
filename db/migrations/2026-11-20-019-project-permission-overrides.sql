-- Migration 2026-11-20-019: per-project permissions for a login
-- Runs once, inside a transaction.
--
-- user_project_access already says WHICH projects a login can reach. permissions now lets the administrator also say what the
-- login may do on THAT project, tab by tab (view / create / edit / delete, and "actual quantities only" on the Sequence of Events).
--   NULL (every existing row) = use the login's own permission matrix, exactly as before.
--   a JSON matrix             = for the tabs listed in it, use these actions on this project instead of the login's own.
-- Nothing is changed for existing logins.

ALTER TABLE user_project_access ADD COLUMN IF NOT EXISTS permissions TEXT;
