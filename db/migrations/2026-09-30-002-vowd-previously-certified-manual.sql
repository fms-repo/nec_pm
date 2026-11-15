-- Migration 2026-09-30-002: VOWD "Less: Previously Certified" (Cumulative column) becomes
-- user-editable. It is still auto-filled with the statement's own Last Billed Net Due; this flag
-- records that the user has overridden that figure, so saving keeps their value instead of
-- recalculating it. Existing statements stay automatic (0).
ALTER TABLE vowd_statements ADD COLUMN IF NOT EXISTS cum_previously_certified_manual INTEGER NOT NULL DEFAULT 0;
