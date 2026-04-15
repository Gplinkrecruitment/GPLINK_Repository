-- Gmail watch state: tracks historyId per monitored inbox
CREATE TABLE IF NOT EXISTS gmail_watch_state (
  email_address text PRIMARY KEY,
  history_id text NOT NULL,
  watch_expiry timestamptz,
  updated_at timestamptz DEFAULT now()
);

-- Processed Gmail messages: dedup + unmatched document store
CREATE TABLE IF NOT EXISTS processed_gmail_messages (
  gmail_message_id text PRIMARY KEY,
  email_address text NOT NULL,
  sender text,
  subject text,
  processed_at timestamptz DEFAULT now(),
  result text,  -- 'matched', 'unmatched', 'filtered', 'error'
  matched_task_id text,
  attachment_data jsonb,  -- For unmatched: [{filename, base64, mime_type, size}]
  ai_summary text
);

-- New columns on registration_tasks for Gmail-sourced documents
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_message_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_attachment_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_confidence real;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_reasoning text;
