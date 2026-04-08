-- Migration: DoubleTick WhatsApp integration columns for registration_tasks
-- Created: 2026-04-06

ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS doubletick_conversation_url TEXT,
  ADD COLUMN IF NOT EXISTS doubletick_message_id       TEXT;

-- Add whatsapp_help task type to CHECK constraint
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops','whatsapp_help'
  ));

-- Partial unique index — prevents duplicate task creation from replayed webhook
-- deliveries. Only enforced when doubletick_message_id is populated.
CREATE UNIQUE INDEX IF NOT EXISTS registration_tasks_doubletick_message_id_unique
  ON registration_tasks (doubletick_message_id)
  WHERE doubletick_message_id IS NOT NULL;

-- Index for VA dashboard join on conversation URL
CREATE INDEX IF NOT EXISTS registration_tasks_doubletick_conversation_url_idx
  ON registration_tasks (doubletick_conversation_url)
  WHERE doubletick_conversation_url IS NOT NULL;

COMMENT ON COLUMN registration_tasks.doubletick_conversation_url IS
  'DoubleTick conversation URL stored after allow-list validation (must start with https://app.doubletick.io/)';

COMMENT ON COLUMN registration_tasks.doubletick_message_id IS
  'DoubleTick message ID used as idempotency key; partial unique index prevents duplicate tasks from replayed webhooks';
