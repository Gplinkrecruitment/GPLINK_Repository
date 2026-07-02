-- In-app ATS offers (standalone-ATS Task B).
--
-- NOT applied automatically — apply later via rpc/exec_sql with the service key
-- (schema-qualify names). The code works WITHOUT this migration: lib/ats-offers.js
-- falls back to runtime_kv keys `ats_offer:{application_id}` (+ the
-- `ats_offers_index` list key) whenever the table is missing, so offers keep
-- flowing before the DDL lands. Applying this simply makes the records durable
-- first-class rows.
--
-- Additive / non-breaking. Same service-role RLS pattern as ats_stage_events
-- (20260627100500) — only the server's service key ever touches this table.

CREATE TABLE IF NOT EXISTS ats_offers (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         UUID,
  user_id                UUID,
  career_role_id         BIGINT,
  practice_id            UUID,
  job_title              TEXT,
  practice_name          TEXT,
  billing_split          TEXT,
  sessions_per_week      TEXT,
  compensation_range     TEXT,
  compensation_note      TEXT,
  start_date             DATE,
  contract_document_key  TEXT,
  notes                  TEXT,
  status                 TEXT        NOT NULL DEFAULT 'sent'
                           CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'withdrawn')),
  sent_by                TEXT,
  sent_at                TIMESTAMPTZ DEFAULT now(),
  responded_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ats_offers_application ON ats_offers(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ats_offers_user ON ats_offers(user_id, created_at DESC);

-- ── RLS: service role full access (ATS endpoints use the service key) ──
ALTER TABLE ats_offers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ats_offers' AND policyname = 'ats_offers_service_all'
  ) THEN
    CREATE POLICY ats_offers_service_all ON ats_offers
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
