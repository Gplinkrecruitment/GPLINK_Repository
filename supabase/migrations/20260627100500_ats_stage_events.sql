-- ATS: pipeline stage-change audit log
-- Additive / non-breaking. Records every time a candidate's job application is
-- moved between ATS board stages (drag-and-drop or drawer), for an auditable
-- history. Fully idempotent and safe to re-run.

CREATE TABLE IF NOT EXISTS ats_stage_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID,
  from_stage      TEXT        NOT NULL DEFAULT '',
  to_stage        TEXT        NOT NULL DEFAULT '',
  actor           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ats_stage_events_app ON ats_stage_events(application_id, created_at DESC);

-- ── RLS: service role full access (ATS endpoints use the service key) ──
ALTER TABLE ats_stage_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ats_stage_events' AND policyname = 'ats_stage_events_service_all'
  ) THEN
    CREATE POLICY ats_stage_events_service_all ON ats_stage_events
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
