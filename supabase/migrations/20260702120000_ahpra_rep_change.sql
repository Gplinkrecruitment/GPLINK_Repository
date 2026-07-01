-- AHPRA change-of-representative (ANOM-00) feature — data model.
--
-- Adds: RSO onboarding/profile fields on rso_team, the per-case pinned AHPRA
-- representative mailbox on registration_cases, and the `ahpra_rep_change`
-- registration_tasks.task_type.
--
-- NOTE: this file is committed as the record of the change. Prod DDL apply is
-- deferred to ship time. All ADD COLUMN statements are idempotent; the
-- constraint rebuild below UNIONs the new type onto the current list.

-- ── rso_team: representative onboarding profile ─────────────────────────────
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS company_email text;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS ahpra_account_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS ahpra_account_confirmed_at timestamptz;
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- ── registration_cases: pinned AHPRA representative mailbox ──────────────────
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_email text;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_user_id uuid;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_auth_rep_confirmed_at timestamptz;

-- Backfill company_email from the existing contact email where it is already
-- an @mygplink.com.au mailbox (the only kind valid as an AHPRA rep sender).
UPDATE rso_team SET company_email = email
  WHERE company_email IS NULL AND email ILIKE '%@mygplink.com.au';

-- ── registration_tasks: add the ahpra_rep_change task type ──────────────────
-- The IN-list below is the current live set (as of migration
-- 20260701000000_add_ahpra_conflict_letter_task_type.sql) UNION 'ahpra_rep_change'.
-- NOTE: re-derive this IN-list from the LIVE constraint (pg_get_constraintdef)
-- at apply time — it has drifted from the migration files before, and dropping
-- any pre-existing type here would silently reject inserts for it in prod.
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
    'ahpra_conflict_letter',
    'ahpra_rep_change'
  ));
