-- ══════════════════════════════════════════════
-- Nudge Chat Messages + Status Extension
-- ══════════════════════════════════════════════

-- 1. Extend user_nudges status to support chat states
ALTER TABLE user_nudges DROP CONSTRAINT IF EXISTS user_nudges_status_check;
ALTER TABLE user_nudges ADD CONSTRAINT user_nudges_status_check
  CHECK (status IN ('pending','delivered','read','dismissed','active','closed'));

-- 2. Nudge chat messages — threaded replies for each nudge
CREATE TABLE IF NOT EXISTS nudge_chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nudge_id UUID NOT NULL REFERENCES user_nudges(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('admin','user')),
  sender_email TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nudge_chat_messages_nudge ON nudge_chat_messages(nudge_id, created_at ASC);

ALTER TABLE nudge_chat_messages ENABLE ROW LEVEL SECURITY;

-- Users can read messages on their own nudges
CREATE POLICY nudge_chat_messages_select_own ON nudge_chat_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_nudges WHERE user_nudges.id = nudge_chat_messages.nudge_id AND user_nudges.user_id = auth.uid())
  );

-- Users can insert messages on their own nudges (sender_type='user' only)
CREATE POLICY nudge_chat_messages_insert_own ON nudge_chat_messages
  FOR INSERT WITH CHECK (
    sender_type = 'user' AND
    EXISTS (SELECT 1 FROM user_nudges WHERE user_nudges.id = nudge_chat_messages.nudge_id AND user_nudges.user_id = auth.uid())
  );

-- Service role full access
CREATE POLICY nudge_chat_messages_service_all ON nudge_chat_messages
  FOR ALL USING (auth.role() = 'service_role');
