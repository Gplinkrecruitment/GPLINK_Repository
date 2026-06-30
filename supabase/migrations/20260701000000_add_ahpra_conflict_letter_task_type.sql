-- Allow the new `ahpra_conflict_letter` task_type.
--
-- The live `registration_tasks_task_type_check` constraint had drifted from the
-- migration history (earlier non-additive migrations were applied directly via
-- exec_sql), so this rebuilds it from the VERIFIED LIVE list read from production
-- on 2026-07-01 plus the new `ahpra_conflict_letter` type. This same DDL was
-- applied to production via rpc/exec_sql before the feature deployed, so the
-- constraint and this file are in sync. Do not assume the prior migration files
-- reflect the live constraint — read it from the DB before editing.
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff', 'verify', 'review', 'followup', 'blocker', 'escalation',
    'practice_pack', 'practice_pack_child', 'manual', 'system', 'visa_stage',
    'visa_doc', 'questionnaire', 'sponsor', 'migration_agent', 'sla_overdue',
    'chase', 'document_ops', 'whatsapp_help', 'email_triage', 'ahpra_action_item',
    'ahpra_correspondence', 'flagged_doc', 'doc_review', 'zoom_call',
    'alt_supervisor_cv_review', 'alt_supervisor_cv_request',
    'account_deleted_active_placement', 'model_update_available',
    'ahpra_conflict_letter'
  ));
