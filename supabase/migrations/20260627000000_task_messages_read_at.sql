-- supabase/migrations/20260627000000_task_messages_read_at.sql
-- Unread tracking for the Registration Inbox. Null = unread (inbound only).
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_task_messages_unread
  ON task_messages (case_id)
  WHERE direction = 'inbound' AND read_at IS NULL;
