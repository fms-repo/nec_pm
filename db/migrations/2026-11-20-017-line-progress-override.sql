-- Migration 2026-11-20-017: Progress % on Sequence of Events material and crew / contractor lines
-- Runs once, inside a transaction.
--
-- A line's Progress % is Actual Qty / Planned Qty, worked out automatically. progress_override holds a manually typed
-- value instead: NULL = automatic (the normal case), a number 0-100 = the person overrode it. An event's own Progress %
-- is then the average of its lines' Progress % (worked out when the project is saved).
-- Existing lines stay automatic. Nothing is rewritten here.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS progress_override DOUBLE PRECISION;
ALTER TABLE project_crews     ADD COLUMN IF NOT EXISTS progress_override DOUBLE PRECISION;
