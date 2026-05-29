-- Add metadata JSONB column to registration_tasks for SPPA-00 conflict scan results and state tracking
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
