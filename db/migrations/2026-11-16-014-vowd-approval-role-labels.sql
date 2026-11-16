-- Migration 2026-11-16-014: VOWD approval signatory labels
-- Runs once, inside a transaction.
--
-- The three VOWD approval steps are now labelled Prepared By / Reviewed By / Approved By
-- (was Project Manager / Business Unit Head, Supply Chain Manager, Project Director / Executive Director).
-- Label only: role_key, approvers, order and status are untouched. Steps already saved (drafts, pending,
-- approved history) keep their old label in document_approval_steps.role_label, so rename them here too.

UPDATE document_approval_steps SET role_label = 'Prepared By' WHERE doc_type = 'vowd' AND role_key = 'project_manager';
UPDATE document_approval_steps SET role_label = 'Reviewed By' WHERE doc_type = 'vowd' AND role_key = 'supply_chain';
UPDATE document_approval_steps SET role_label = 'Approved By' WHERE doc_type = 'vowd' AND role_key = 'director';
