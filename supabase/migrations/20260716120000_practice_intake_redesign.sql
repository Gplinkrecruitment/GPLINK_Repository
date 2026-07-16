-- Practice intake redesign: corporate groups + the columns the form now derives.
--
-- HOW TO APPLY (this repo has no psql, no Supabase CLI, no direct DB connection):
--   POST {SUPABASE_URL}/rest/v1/rpc/exec_sql
--     headers: apikey + Authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}   (from .env)
--     body:    {"query": "<the RAW text of this file>"}
--   HTTP 204 = success. Send the file RAW -- do not strip comments or collapse
--   whitespace, that mangles the dollar-quoted DO block into a 42601 syntax error.
--   Multi-statement strings execute fine in one call.
--
-- WHY EVERY NAME IS SCHEMA-QUALIFIED: public.exec_sql is declared
--   `security definer set search_path = ''`, so it runs with NOTHING on the
--   search path. An unqualified `practices` raises 42P01 "relation does not
--   exist" even though the table is right there. This applies to ALTER and
--   CREATE INDEX too, not just CREATE TABLE.
--
-- AFTER APPLYING: run `notify pgrst, 'reload schema';` and wait ~3s, or PostgREST
--   keeps returning PGRST205/42703 for the new table and columns.
--   Then verify for real -- never assume success:
--     GET /rest/v1/practice_groups?select=id&limit=1
--     GET /rest/v1/practices?select=group_id,urgency,dpa_suggested&limit=1
--
-- Safe to re-run: every statement is IF NOT EXISTS or otherwise guarded.

-- One group per contracting arrangement. A solo practice gets a group of one,
-- so there is exactly one code path -- no "is this a group?" branching downstream.
CREATE TABLE IF NOT EXISTS public.practice_groups (
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
  ON public.practice_groups (intake_token) WHERE intake_token IS NOT NULL;

ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.practice_groups(id);
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS entity_name text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS abn text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS urgency text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS dpa_suggested boolean;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS dpa_mismatch boolean DEFAULT false;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS gps_needed text;
ALTER TABLE public.practices ADD COLUMN IF NOT EXISTS supervision_available boolean;

-- urgency and employment_type are small closed sets. Added only if absent, so a
-- re-run does not error on an already-present constraint.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'practices_urgency_check') THEN
    ALTER TABLE public.practices ADD CONSTRAINT practices_urgency_check
      CHECK (urgency IS NULL OR urgency IN ('asap','3_6m','12m'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'practices_employment_type_check') THEN
    ALTER TABLE public.practices ADD CONSTRAINT practices_employment_type_check
      CHECK (employment_type IS NULL OR employment_type IN ('full_time','part_time','either'));
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS practices_group_id_idx ON public.practices (group_id);

-- Backfill: every existing practice becomes a group of one, carrying its current
-- token and agreement state up. In-flight intake links keep working because the
-- server reads the token from the group and falls back to practices.intake_token.
--
-- Re-run safety: the INSERT and the UPDATE below are separate statements, so a
-- run interrupted between them would leave practices with group_id still NULL.
-- Without a guard, a second attempt would then insert a DUPLICATE group for those
-- practices. The NOT EXISTS clause closes that gap by keying off the same
-- backfilled_from_practice tag the UPDATE matches on.
INSERT INTO public.practice_groups (entity_name, contact_name, contact_email, contact_phone,
                                    intake_token, agreement_status, agreement_signed_at,
                                    agreement_signed_by, agreement_signed_pdf_key, source, metadata)
SELECT p.name, p.contact_name, p.contact_email, p.contact_phone,
       p.intake_token, COALESCE(p.agreement_status, 'unsigned'), p.agreement_signed_at,
       p.agreement_signed_by, p.agreement_signed_pdf_key, p.source,
       jsonb_build_object('backfilled_from_practice', p.id)
FROM public.practices p
WHERE p.group_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.practice_groups g
    WHERE g.metadata->>'backfilled_from_practice' = p.id::text
  );

UPDATE public.practices p
SET group_id = g.id
FROM public.practice_groups g
WHERE p.group_id IS NULL
  AND g.metadata->>'backfilled_from_practice' = p.id::text;
