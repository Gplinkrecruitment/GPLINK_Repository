-- ATS: Practices directory
-- Additive / non-breaking. Adds a `practices` table for the in-app ATS so jobs
-- and candidates can be linked to a medical practice independently of Zoho.
-- Fully idempotent (create table / index / policy / trigger are all guarded),
-- so it is safe to re-run and does not alter or remove any existing data.

CREATE TABLE IF NOT EXISTS practices (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  location_city    TEXT        NOT NULL DEFAULT '',
  location_state   TEXT        NOT NULL DEFAULT '',
  location_country TEXT        NOT NULL DEFAULT 'Australia',
  practice_type    TEXT        NOT NULL DEFAULT '',
  contact_name     TEXT        NOT NULL DEFAULT '',
  contact_email    TEXT        NOT NULL DEFAULT '',
  contact_phone    TEXT        NOT NULL DEFAULT '',
  ahpra_number     TEXT        NOT NULL DEFAULT '',
  zoho_client_id   TEXT,
  source           TEXT        NOT NULL DEFAULT 'internal_ats'
                                 CHECK (source IN ('zoho_sync','internal_ats','manual','backfill')),
  notes            TEXT        NOT NULL DEFAULT '',
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_by       TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique practice name + active-practices lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_practices_name_lower ON practices(lower(name));
CREATE INDEX IF NOT EXISTS idx_practices_active ON practices(is_active, name);

-- ── RLS: service role full access (admin / ATS endpoints use the service key) ──
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'practices' AND policyname = 'practices_service_all'
  ) THEN
    CREATE POLICY practices_service_all ON practices
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Reuse the existing set_updated_at() trigger function (defined in earlier migrations)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_practices') THEN
    CREATE TRIGGER set_updated_at_practices
      BEFORE UPDATE ON practices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
