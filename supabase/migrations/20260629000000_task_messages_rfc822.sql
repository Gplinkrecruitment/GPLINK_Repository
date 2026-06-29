-- Persist the RFC822 Message-ID / References headers on inbound (and outbound) email
-- messages so conversations can thread across mailboxes (set In-Reply-To on replies),
-- re-anchor a reply that lands in a different Gmail thread to its original conversation,
-- and de-duplicate the same email delivered to two watched mailboxes.
-- (body_html already exists from 20260520000000_admin_task_redesign.sql.)
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS rfc822_message_id TEXT;
ALTER TABLE task_messages ADD COLUMN IF NOT EXISTS rfc822_references TEXT;
CREATE INDEX IF NOT EXISTS idx_task_messages_rfc822 ON task_messages (rfc822_message_id) WHERE rfc822_message_id IS NOT NULL;
