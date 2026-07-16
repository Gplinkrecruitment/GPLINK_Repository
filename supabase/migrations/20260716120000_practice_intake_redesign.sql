-- Practice intake redesign: corporate groups + the columns the form now derives.
-- Apply via Supabase rpc/exec_sql with the service role key (param name: query).
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.

-- One group per contracting arrangement. A solo practice gets a group of one,
-- so there is exactly one code path -- no "is this a group?" branching downstream.
CREATE TABLE IF NOT EXISTS practice_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name text,
  abn text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_role text,
  intake_token text,
  agreement_status text DEFAULT 'unsigned' CHECK (agreement_status IN ('unsigned','sent','signed')),
  agreement_signed_at timestamptz,
  agreement_signed_by text,
  agreement_signed_pdf_key text,
  source text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS practice_groups_intake_token_idx
  ON practice_groups (intake_token) WHERE intake_token IS NOT NULL;

ALTER TABLE practices ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES practice_groups(id);
ALTER TABLE practices ADD COLUMN IF NOT EXISTS entity_name text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS abn text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS urgency text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS dpa_suggested boolean;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS dpa_mismatch boolean DEFAULT false;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS gps_needed text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS supervision_available boolean;

-- urgency is a small closed set; add the constraint only if it is not already there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_urgency_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_urgency_check
      CHECK (urgency IS NULL OR urgency IN ('asap','3_6m','12m'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_employment_type_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_employment_type_check
      CHECK (employment_type IS NULL OR employment_type IN ('full_time','part_time','either'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS practices_group_id_idx ON practices (group_id);

-- Backfill: every existing practice becomes a group of one, carrying its current
-- token and agreement state up. In-flight intake links keep working because the
-- server reads the token from the group and falls back to practices.intake_token.
--
-- Re-run safety note: exec_sql in this repo applies one statement per call (see
-- migration house-style docs), so a run can be interrupted between this INSERT
-- and the UPDATE below. Without a guard, that would let a second attempt insert
-- a duplicate group for a practice whose group_id was never actually set. The
-- "AND NOT EXISTS" clause below closes that gap: it keys off the same
-- backfilled_from_practice tag the UPDATE matches on, so re-running after a
-- partial apply (or a full second run) can never create a second group for the
-- same practice.
INSERT INTO practice_groups (entity_name, contact_name, contact_email, contact_phone,
                             intake_token, agreement_status, agreement_signed_at,
                             agreement_signed_by, agreement_signed_pdf_key, source, metadata)
SELECT p.name, p.contact_name, p.contact_email, p.contact_phone,
       p.intake_token, COALESCE(p.agreement_status, 'unsigned'), p.agreement_signed_at,
       p.agreement_signed_by, p.agreement_signed_pdf_key, p.source,
       jsonb_build_object('backfilled_from_practice', p.id)
FROM practices p
WHERE p.group_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM practice_groups g
    WHERE g.metadata->>'backfilled_from_practice' = p.id::text
  );

UPDATE practices p
SET group_id = g.id
FROM practice_groups g
WHERE p.group_id IS NULL
  AND g.metadata->>'backfilled_from_practice' = p.id::text;
