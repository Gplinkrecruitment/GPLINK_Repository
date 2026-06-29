-- Interview meetings on scheduled_calls (additive; consultations unaffected).
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS meeting_kind TEXT NOT NULL DEFAULT 'consultation',
  ADD COLUMN IF NOT EXISTS host_kind TEXT NOT NULL DEFAULT 'rso',
  ADD COLUMN IF NOT EXISTS application_id UUID NULL REFERENCES gp_applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS career_role_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS practice_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS gcal_event_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_status TEXT NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS practice_availability_windows JSONB NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS practice_availability_received_at TIMESTAMPTZ NULL;

-- meeting_kind constraint
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_meeting_kind_chk;
ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_meeting_kind_chk
  CHECK (meeting_kind IN ('consultation','interview'));

-- case_id / user_id were NOT NULL (consultations always have a registration case + user).
-- An ATS-only candidate may have an application but no registration case yet, so an interview
-- row legitimately has a null case_id/user_id. Relax (additive; consultations still set both).
ALTER TABLE scheduled_calls ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE scheduled_calls ALTER COLUMN user_id DROP NOT NULL;

-- stage was NOT NULL CHECK (myintealth/amc/ahpra). Interviews have no stage → relax.
ALTER TABLE scheduled_calls ALTER COLUMN stage DROP NOT NULL;
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_stage_check;
ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_stage_check
  CHECK (stage IS NULL OR stage IN ('myintealth','amc','ahpra'));

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_kind_host ON scheduled_calls(meeting_kind, host_kind);
CREATE INDEX IF NOT EXISTS idx_scheduled_calls_application ON scheduled_calls(application_id);
