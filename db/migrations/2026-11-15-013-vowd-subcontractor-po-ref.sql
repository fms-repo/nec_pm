-- Migration 2026-11-15-013: VOWD statements get a free-text "Sub Contractor PO Ref".
-- Optional, typed by the user, shown on the VOWD statement and its print preview. Existing statements stay blank.
ALTER TABLE vowd_statements ADD COLUMN IF NOT EXISTS subcontractor_po_ref TEXT;
