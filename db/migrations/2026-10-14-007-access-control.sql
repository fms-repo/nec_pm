-- Migration 2026-10-14-007: role-based access control
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
--
-- Every personal login gets a role, chosen by the administrator:
--   approver         can open only the documents assigned to them for approval (default — least access)
--   read_only        can view the projects the administrator has granted them, change nothing
--   project_manager  can view and edit the projects the administrator has granted them
-- The shared administrator login (APP_USERNAME/APP_PASSWORD) is unrestricted and manages all of this.
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'approver';

-- Which projects a read_only / project_manager login may see. Removed automatically with the person
-- or the project.
CREATE TABLE IF NOT EXISTS user_project_access (
  team_member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  granted_at     TEXT NOT NULL DEFAULT utc_now_text(),
  granted_by     TEXT,
  PRIMARY KEY (team_member_id, project_id)
);
CREATE INDEX IF NOT EXISTS user_project_access_project_idx ON user_project_access (project_id);
