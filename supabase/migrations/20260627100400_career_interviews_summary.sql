-- ATS: career_interviews meeting summaries
-- Additive / non-breaking. Adds AI meeting-summary / action-item capture plus
-- Zoom summary fetch tracking to career interviews (mirrors the summary fields on
-- scheduled_calls). All columns use ADD COLUMN IF NOT EXISTS with safe defaults,
-- so existing interviews default to 'not_requested' and re-running is safe.

ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS meeting_summary TEXT;
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS meeting_action_items JSONB;
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS meeting_summary_raw JSONB;
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS summary_status TEXT NOT NULL DEFAULT 'not_requested'
  CHECK (summary_status IN ('not_requested','pending','saved','not_available','error'));
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS summary_fetch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS summary_error TEXT;
ALTER TABLE career_interviews ADD COLUMN IF NOT EXISTS zoom_meeting_uuid TEXT;
