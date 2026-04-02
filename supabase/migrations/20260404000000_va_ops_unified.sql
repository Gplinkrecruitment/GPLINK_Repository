-- VA Unified Operations System
-- Extends registration case/task engine to cover visa, questionnaire, sponsor, and practice-doc ops
-- All changes are additive — no destructive operations

-- ══════════════════════════════════════════════
-- 1. Extend registration_cases with visa/sponsor linkage
-- ══════════════════════════════════════════════

ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS visa_case_id UUID REFERENCES visa_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sponsor_name TEXT,
  ADD COLUMN IF NOT EXISTS sponsor_contact TEXT,
  ADD COLUMN IF NOT EXISTS migration_agent TEXT,
  ADD COLUMN IF NOT EXISTS migration_agent_contact TEXT,
  ADD COLUMN IF NOT EXISTS risk_notes TEXT,
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'
    CHECK (priority IS NULL OR priority IN ('urgent','high','normal','low'));

CREATE INDEX IF NOT EXISTS idx_reg_cases_visa ON registration_cases(visa_case_id);

-- ══════════════════════════════════════════════
-- 2. Extend registration_tasks with domain + visa linkage + richer statuses
-- ══════════════════════════════════════════════

-- Add domain column
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT 'registration',
  ADD COLUMN IF NOT EXISTS visa_case_id UUID REFERENCES visa_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS follow_up_date DATE,
  ADD COLUMN IF NOT EXISTS sla_due_date DATE,
  ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Widen task_type CHECK
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops'
  ));

-- Widen status CHECK
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked'
  ));

-- Add domain CHECK
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_domain_check
  CHECK (domain IN ('registration','visa','questionnaire','sponsor','document','system'));

CREATE INDEX IF NOT EXISTS idx_reg_tasks_domain ON registration_tasks(domain);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_visa ON registration_tasks(visa_case_id);
CREATE INDEX IF NOT EXISTS idx_reg_tasks_followup ON registration_tasks(follow_up_date)
  WHERE status NOT IN ('completed','cancelled');
CREATE INDEX IF NOT EXISTS idx_reg_tasks_sla ON registration_tasks(sla_due_date)
  WHERE status NOT IN ('completed','cancelled');

-- ══════════════════════════════════════════════
-- 3. Extend task_timeline with domain + wider event types
-- ══════════════════════════════════════════════

ALTER TABLE task_timeline
  ADD COLUMN IF NOT EXISTS domain TEXT DEFAULT 'registration',
  ADD COLUMN IF NOT EXISTS visa_case_id UUID REFERENCES visa_applications(id) ON DELETE SET NULL;

-- Widen event_type CHECK
ALTER TABLE task_timeline DROP CONSTRAINT IF EXISTS task_timeline_event_type_check;
ALTER TABLE task_timeline ADD CONSTRAINT task_timeline_event_type_check
  CHECK (event_type IN (
    'created','status_change','assigned','note','blocker_set','blocker_cleared',
    'priority_change','stage_change','completed','cancelled','system','reopened',
    'questionnaire_submitted','questionnaire_returned','questionnaire_reviewed',
    'pdf_generated','questionnaire_sent','sponsor_request','doc_approved',
    'doc_rejected','owner_changed','escalation','sla_breached',
    'visa_stage_change','visa_doc_uploaded','visa_doc_reviewed'
  ));

-- ══════════════════════════════════════════════
-- 4. Visa Questionnaires table
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS visa_questionnaires (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visa_case_id UUID NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','returned_for_changes','va_reviewed','ready_to_send','sent')),
  recipient_route TEXT
    CHECK (recipient_route IS NULL OR recipient_route IN ('gplink_migration_agent','practice_agent','practice_direct')),
  version INTEGER NOT NULL DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  return_note TEXT,
  review_note TEXT,
  send_note TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  sent_by TEXT,
  sent_at TIMESTAMPTZ,
  pdf_generated_at TIMESTAMPTZ,
  pdf_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(visa_case_id)
);

CREATE INDEX IF NOT EXISTS idx_visa_questionnaires_user ON visa_questionnaires(user_id);
CREATE INDEX IF NOT EXISTS idx_visa_questionnaires_case ON visa_questionnaires(visa_case_id);
CREATE INDEX IF NOT EXISTS idx_visa_questionnaires_status ON visa_questionnaires(status);

ALTER TABLE visa_questionnaires ENABLE ROW LEVEL SECURITY;

-- GP can read own questionnaire
CREATE POLICY visa_questionnaires_select_own ON visa_questionnaires
  FOR SELECT USING (auth.uid() = user_id);

-- GP can insert own questionnaire
CREATE POLICY visa_questionnaires_insert_own ON visa_questionnaires
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- GP can update own questionnaire (only draft/returned)
CREATE POLICY visa_questionnaires_update_own ON visa_questionnaires
  FOR UPDATE USING (auth.uid() = user_id AND status IN ('draft','returned_for_changes'));

-- Service role full access
CREATE POLICY visa_questionnaires_service_all ON visa_questionnaires
  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════
-- 5. Practice Document Operations table
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS practice_doc_ops (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES registration_cases(id) ON DELETE CASCADE,
  document_key TEXT NOT NULL
    CHECK (document_key IN ('sppa_00','section_g','position_description','offer_contract','supervisor_cv')),
  ops_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (ops_status IN ('not_requested','requested','awaiting_practice','received','under_review','needs_correction','ready_for_gp','completed')),
  requested_from TEXT,
  practice_contact TEXT,
  request_date DATE,
  due_date DATE,
  last_chased_date DATE,
  file_version INTEGER DEFAULT 0,
  review_outcome TEXT,
  correction_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(case_id, document_key)
);

CREATE INDEX IF NOT EXISTS idx_practice_doc_ops_case ON practice_doc_ops(case_id);
CREATE INDEX IF NOT EXISTS idx_practice_doc_ops_status ON practice_doc_ops(ops_status);

ALTER TABLE practice_doc_ops ENABLE ROW LEVEL SECURITY;

CREATE POLICY practice_doc_ops_service_all ON practice_doc_ops
  FOR ALL USING (auth.role() = 'service_role');

-- ══════════════════════════════════════════════
-- 6. Updated-at triggers for new tables
-- ══════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_visa_questionnaires') THEN
    CREATE TRIGGER set_updated_at_visa_questionnaires
      BEFORE UPDATE ON visa_questionnaires
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_practice_doc_ops') THEN
    CREATE TRIGGER set_updated_at_practice_doc_ops
      BEFORE UPDATE ON practice_doc_ops
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
