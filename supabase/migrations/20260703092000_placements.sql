-- In-app placements (standalone-ATS Task C).
--
-- NOT applied automatically — apply later via rpc/exec_sql with the service key
-- (schema-qualify names). The code works WITHOUT this migration: accepting an
-- in-app offer tolerantly SKIPS the placements row when this table is missing
-- (logged once per process) because the durable placement of record is
-- user_state.gp_career_state — the same shape the Zoho reverse-sync writes.
-- Applying this simply adds a first-class, queryable placement row per
-- acceptance for reporting and future ops tooling.
--
-- Additive / non-breaking. Same service-role RLS pattern as ats_offers
-- (20260703091000) / ats_stage_events (20260627100500) — only the server's
-- service key ever touches this table.

CREATE TABLE IF NOT EXISTS placements (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID,
  application_id         UUID,
  career_role_id         BIGINT,
  practice_id            UUID,
  practice_name          TEXT,
  job_title              TEXT,
  location               TEXT,
  billing_split          TEXT,
  sessions_per_week      TEXT,
  compensation_range     TEXT,
  start_date             DATE,
  contract_document_key  TEXT,
  offer_id               UUID,
  placed_by              TEXT,
  placed_at              TIMESTAMPTZ DEFAULT now(),
  status                 TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'ended', 'cancelled')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_placements_user ON placements(user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_placements_application ON placements(application_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_placements_practice ON placements(practice_id, placed_at DESC);

-- ── RLS: service role full access (server endpoints use the service key) ──
ALTER TABLE placements ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'placements' AND policyname = 'placements_service_all'
  ) THEN
    CREATE POLICY placements_service_all ON placements
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
