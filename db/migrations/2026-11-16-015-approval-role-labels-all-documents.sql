-- Migration 2026-11-16-015: Prepared By / Reviewed By / Approved By on every approval
-- Runs once, inside a transaction.
--
-- Migration 014 relabelled the VOWD steps. Change requests and completion certificates now use the same
-- three labels. Label only: role_key, approvers, order and status are untouched. Steps already saved keep
-- their old label in document_approval_steps.role_label, so rename them here.

UPDATE document_approval_steps SET role_label = 'Prepared By' WHERE (doc_type, role_key) IN (('change_request', 'submitter'), ('certificate', 'engineer'));
UPDATE document_approval_steps SET role_label = 'Reviewed By' WHERE (doc_type, role_key) IN (('change_request', 'reviewer'), ('certificate', 'supply_chain'));
UPDATE document_approval_steps SET role_label = 'Approved By' WHERE (doc_type, role_key) IN (('change_request', 'ccb'), ('certificate', 'client_rep'));
