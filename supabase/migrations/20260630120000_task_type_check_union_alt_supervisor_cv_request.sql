-- Rebuild registration_tasks_task_type_check to allow EVERY task_type the application code creates.
--
-- The constraint had drifted: earlier migrations were non-additive and conflicted —
-- 20260601 added 'ahpra_correspondence'/'alt_supervisor_cv_review' but 20260609 (later) re-created
-- the constraint WITHOUT them (adding 'zoom_call' etc.). So the LIVE constraint was missing several
-- task types the code inserts, silently rejecting those inserts in production:
--   alt_supervisor_cv_review, ahpra_correspondence, account_deleted_active_placement,
--   model_update_available — and now the new alt_supervisor_cv_request.
--
-- This list is the UNION of the live constraint (20260609) and every `task_type` literal created in
-- server.js / lib / scripts, so it is purely additive and fixes the latent breakage.
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops','whatsapp_help','email_triage',
    'ahpra_action_item','ahpra_correspondence','flagged_doc','doc_review','zoom_call',
    'alt_supervisor_cv_review','alt_supervisor_cv_request',
    'account_deleted_active_placement','model_update_available'
  ));
