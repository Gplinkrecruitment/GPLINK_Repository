-- PEP waitlist — GPs whose certificate missed their country cutoff date.
--
-- NOT applied automatically — apply later via rpc/exec_sql with the service key
-- (schema-qualify names). Rows are captured when a certificate's date is read
-- as earlier than the country cutoff the GP needed to clear; the app upserts by
-- user_id (one waitlist row per user) and can flip `notify_requested` /
-- `released` when the GP asks to be told at launch or is later let through.
--
-- Additive / non-breaking. user_id is intentionally loose (nullable, NO foreign
-- key) so rows can be created before a Supabase user id is resolved, matching
-- the surrounding tables. Same service-role RLS pattern as placements
-- (20260703092000) / ats_offers (20260703091000) — only the server's service
-- key ever touches this table.

CREATE TABLE IF NOT EXISTS pep_waitlist (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID,
  email                  TEXT,
  name                   TEXT,
  phone                  TEXT,
  country                TEXT,        -- 'GB' | 'IE' | 'NZ'
  cert_type              TEXT,        -- e.g. 'MRCGP Certificate'
  date_found             TEXT,        -- date read off the certificate (stored as text, as read)
  cutoff_date            TEXT,        -- the country cutoff the cert missed, e.g. '2007-08-01'
  notify_requested       BOOLEAN     NOT NULL DEFAULT false,
  notify_requested_at    TIMESTAMPTZ,
  launch_notified_at     TIMESTAMPTZ,
  released               BOOLEAN     NOT NULL DEFAULT false,
  released_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pep_waitlist_user ON pep_waitlist(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pep_waitlist_email ON pep_waitlist(email);

-- ── RLS: service role full access (server endpoints use the service key) ──
ALTER TABLE pep_waitlist ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'pep_waitlist' AND policyname = 'pep_waitlist_service_all'
  ) THEN
    CREATE POLICY pep_waitlist_service_all ON pep_waitlist
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
