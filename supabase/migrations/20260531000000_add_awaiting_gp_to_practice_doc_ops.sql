-- Add 'awaiting_gp' to the ops_status check constraint for SPPA-00 lifecycle
ALTER TABLE practice_doc_ops DROP CONSTRAINT IF EXISTS practice_doc_ops_ops_status_check;
ALTER TABLE practice_doc_ops ADD CONSTRAINT practice_doc_ops_ops_status_check
  CHECK (ops_status IN ('not_requested','requested','awaiting_practice','awaiting_gp','received','under_review','needs_correction','ready_for_gp','completed'));
