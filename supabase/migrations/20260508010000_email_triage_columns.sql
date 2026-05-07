-- Add email metadata columns for email_triage tasks
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS email_body_snippet text,
  ADD COLUMN IF NOT EXISTS email_sender text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id text;
