-- Track VA-led submit-to-practice workflow for career applications

ALTER TABLE gp_applications
  ADD COLUMN IF NOT EXISTS practice_submission_status TEXT,
  ADD COLUMN IF NOT EXISTS zoho_submission_id TEXT,
  ADD COLUMN IF NOT EXISTS zoho_client_id TEXT,
  ADD COLUMN IF NOT EXISTS zoho_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS practice_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS practice_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS submitted_to_practice_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_to_practice_by TEXT,
  ADD COLUMN IF NOT EXISTS submission_task_id UUID REFERENCES registration_tasks(id) ON DELETE SET NULL;

UPDATE gp_applications
SET practice_submission_status = 'pending_va_submission'
WHERE practice_submission_status IS NULL OR btrim(practice_submission_status) = '';

ALTER TABLE gp_applications
  ALTER COLUMN practice_submission_status SET DEFAULT 'pending_va_submission';

ALTER TABLE gp_applications
  ALTER COLUMN practice_submission_status SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gp_applications_practice_submission_status_check'
  ) THEN
    ALTER TABLE gp_applications
      ADD CONSTRAINT gp_applications_practice_submission_status_check
      CHECK (practice_submission_status IN (
        'pending_va_submission',
        'submitted_to_practice',
        'client_reviewed',
        'client_approved',
        'client_rejected',
        'interview_ready'
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gp_applications_zoho_submission_id
  ON gp_applications(zoho_submission_id)
  WHERE zoho_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gp_applications_submission_status
  ON gp_applications(practice_submission_status);

CREATE INDEX IF NOT EXISTS idx_gp_applications_submission_task_id
  ON gp_applications(submission_task_id)
  WHERE submission_task_id IS NOT NULL;
