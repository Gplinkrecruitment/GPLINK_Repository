-- Add document pipeline columns to user_documents
ALTER TABLE public.user_documents
  ADD COLUMN IF NOT EXISTS google_drive_file_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rejection_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_classification_confidence integer,
  ADD COLUMN IF NOT EXISTS ai_classification_result text NOT NULL DEFAULT '';
