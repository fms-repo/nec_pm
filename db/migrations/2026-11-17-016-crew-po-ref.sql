-- Migration 2026-11-17-016: PO Reference Number on Sequence of Events crew / sub contractor lines
-- Runs once, inside a transaction.
--
-- A crew / labour line already names the sub contractor doing it (contractor_id). It now also carries the
-- sub contractor's PO reference number. The VOWD statement offers these as a dropdown and carries
-- "Last Billed & Certified Value" forward per PO.
-- Free text, optional. Existing lines keep it empty.

ALTER TABLE project_crews ADD COLUMN IF NOT EXISTS po_ref TEXT;
