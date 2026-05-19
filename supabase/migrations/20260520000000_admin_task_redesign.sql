-- Admin Task System Redesign
-- Adds AHPRA tracking columns, task messages/documents tables,
-- wider task_type and status constraints, and supporting indexes.

-- ══════════════════════════════════════════════
-- 1. New columns on registration_cases (AHPRA tracking)
-- ══════════════════════════════════════════════

ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS ahpra_application_number TEXT,
  ADD COLUMN IF NOT EXISTS ahpra_officer_name TEXT,
  ADD COLUMN IF NOT EXISTS ahpra_officer_email TEXT;

CREATE INDEX IF NOT EXISTS idx_reg_cases_ahpra_appnum
  ON registration_cases (ahpra_application_number)
  WHERE ahpra_application_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_ahpra_officer_email
  ON registration_cases (ahpra_officer_email)
  WHERE ahpra_officer_email IS NOT NULL;

-- ══════════════════════════════════════════════
-- 2. New columns on registration_tasks
-- ══════════════════════════════════════════════

ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS source_gmail_message_id TEXT,
  ADD COLUMN IF NOT EXISTS ahpra_deadline DATE;

-- ══════════════════════════════════════════════
-- 3. Widen task_type constraint
-- ══════════════════════════════════════════════

ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops','whatsapp_help','email_triage',
    'ahpra_action_item','flagged_doc','doc_review'
  ));

-- ══════════════════════════════════════════════
-- 4. Widen status constraint (add 'deferred')
-- ══════════════════════════════════════════════

ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external',
    'blocked','escalated','deferred'
  ));

-- ══════════════════════════════════════════════
-- 5. task_messages — conversation thread on a task
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  doubletick_message_id TEXT,
  is_document_delivery BOOLEAN DEFAULT FALSE,
  ai_match_confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_task_messages_gmail_thread ON task_messages(gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_messages_case ON task_messages(case_id)
  WHERE case_id IS NOT NULL;

-- ══════════════════════════════════════════════
-- 6. task_documents — document versions attached to a task
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS task_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE CASCADE,
  message_id UUID REFERENCES task_messages(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  google_drive_file_id TEXT,
  google_drive_url TEXT,
  attachment_url TEXT,
  version INTEGER DEFAULT 1,
  is_current BOOLEAN DEFAULT TRUE,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_documents_task ON task_documents(task_id);
CREATE INDEX IF NOT EXISTS idx_task_documents_case ON task_documents(case_id)
  WHERE case_id IS NOT NULL;

-- ══════════════════════════════════════════════
-- 7. RLS on new tables
-- ══════════════════════════════════════════════

ALTER TABLE task_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_documents ENABLE ROW LEVEL SECURITY;

-- Service role full access (admin endpoints use service key)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'task_messages' AND policyname = 'task_messages_service_all'
  ) THEN
    CREATE POLICY task_messages_service_all ON task_messages
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'task_documents' AND policyname = 'task_documents_service_all'
  ) THEN
    CREATE POLICY task_documents_service_all ON task_documents
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
