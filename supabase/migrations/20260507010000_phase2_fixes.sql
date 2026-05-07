-- Phase 2 fixes: backfill related_stage, doubletick_messages table, follow-up linkage

-- =====================================================
-- 1. Backfill related_stage on tasks that are missing it
-- =====================================================

-- doc_review tasks: infer stage from related_document_key
UPDATE registration_tasks
SET related_stage = CASE
  WHEN related_document_key IN ('sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv') THEN 'ahpra'
  ELSE 'career'
END
WHERE related_stage IS NULL
  AND task_type = 'doc_review';

-- manual tasks: infer from case stage
UPDATE registration_tasks t
SET related_stage = c.stage
FROM registration_cases c
WHERE t.case_id = c.id
  AND t.related_stage IS NULL
  AND t.task_type = 'manual';

-- catch-all: any remaining NULL gets case stage
UPDATE registration_tasks t
SET related_stage = c.stage
FROM registration_cases c
WHERE t.case_id = c.id
  AND t.related_stage IS NULL;

-- =====================================================
-- 2. DoubleTick messages table for reconciliation
-- =====================================================

CREATE TABLE IF NOT EXISTS doubletick_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  case_id UUID REFERENCES registration_cases(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  from_phone TEXT NOT NULL,
  contact_name TEXT,
  message_body TEXT,
  message_type TEXT DEFAULT 'TEXT',
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  doubletick_message_id TEXT,
  conversation_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dt_messages_case ON doubletick_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_dt_messages_user ON doubletick_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_dt_messages_phone ON doubletick_messages(from_phone);
CREATE INDEX IF NOT EXISTS idx_dt_messages_created ON doubletick_messages(created_at DESC);

ALTER TABLE doubletick_messages ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'doubletick_messages' AND policyname = 'Service role full access on doubletick_messages') THEN
    CREATE POLICY "Service role full access on doubletick_messages"
      ON doubletick_messages FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

-- =====================================================
-- 3. Follow-up linkage: source timeline ID on tasks
-- =====================================================

ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS follow_up_source_timeline_id UUID REFERENCES task_timeline(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reg_tasks_followup_source ON registration_tasks(follow_up_source_timeline_id)
  WHERE follow_up_source_timeline_id IS NOT NULL;
