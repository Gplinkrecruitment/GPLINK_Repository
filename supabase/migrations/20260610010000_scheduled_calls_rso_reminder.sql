-- Add RSO assignment and call reminder tracking to scheduled_calls
ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS assigned_rso_email TEXT;
ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS assigned_rso_name TEXT;
ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
