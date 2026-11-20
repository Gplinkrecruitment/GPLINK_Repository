-- Australian GP build, WP-02: pathway and credentials data model.
-- Spec: docs/au-gp/review-report.md ("Proposed data model"); conventions and the
-- full column inventory: docs/au-gp/CONVENTIONS.md.
--
-- WHAT THIS ADDS (additive only: nothing is dropped, renamed, narrowed or
-- rewritten, and no existing row is touched)
--   1. public.user_profiles      6 server-owned pathway columns
--   2. public.user_profiles      14 candidate preference columns
--   3. public.registration_cases 1 column, `pathway` (a mirror of the profile)
--   4. public.gp_credentials     new table, one row per doctor, service role only
--
-- WHY IT IS SAFE ON LIVE TABLES
--   * Every new column is nullable with NO default, so Postgres only updates the
--     catalogue: no table rewrite, no backfill, existing rows read NULL.
--   * NULL means "nothing recorded", which the application reads as an overseas
--     doctor on today's journey (lib/candidate-pathway.js normalisePathway).
--   * CHECK constraints are added NOT VALID and then validated in a separate
--     statement. Validation only takes a SHARE UPDATE EXCLUSIVE lock, and it is
--     trivially true because every existing row holds NULL in the new columns.
--   * Idempotent: safe to run twice (`if not exists`, guarded constraint adds,
--     `drop ... if exists` before each policy and trigger).
--
-- HOW IT IS RUN
--   * Locally by scripts/au-local/apply-migrations.sh.
--   * In production ONLY by the owner's go-ahead, through the
--     public.exec_sql(query text) function, which runs with an EMPTY
--     search_path. So every object below is schema-qualified, and there is no
--     BEGIN / COMMIT (exec_sql already runs inside one transaction and cannot
--     run transaction control).
--   * No agent applies this anywhere.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. user_profiles: pathway (server-owned; never written from the doctor's app)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists candidate_pathway text,
  add column if not exists candidate_basis text,
  add column if not exists pathway_set_by text,
  add column if not exists pathway_set_at timestamptz,
  add column if not exists pathway_confirmed_at timestamptz,
  add column if not exists pathway_confirmed_by text;

comment on column public.user_profiles.candidate_pathway is
  'AU GP build. overseas_esp | overseas_pep | au_vr | au_restricted | au_non_vr | au_registrar. NULL reads as overseas_esp. Server-owned: written only by setCandidatePathway (server.js).';
comment on column public.user_profiles.candidate_basis is
  'AU GP build. Where the doctor is based: overseas | australia. Drives the fee tier. NULL reads from the pathway.';
comment on column public.user_profiles.pathway_set_by is
  'AU GP build. Who last set the pathway: a staff email, or self for the doctor''s own onboarding answer.';
comment on column public.user_profiles.pathway_confirmed_at is
  'AU GP build. When staff confirmed the pathway. NULL with a pathway set = self-declared, pending staff confirmation.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'user_profiles_candidate_pathway_check'
      and conrelid = pg_catalog.to_regclass('public.user_profiles')
  ) then
    alter table public.user_profiles
      add constraint user_profiles_candidate_pathway_check
      check (candidate_pathway is null or candidate_pathway in (
        'overseas_esp', 'overseas_pep', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'user_profiles_candidate_basis_check'
      and conrelid = pg_catalog.to_regclass('public.user_profiles')
  ) then
    alter table public.user_profiles
      add constraint user_profiles_candidate_basis_check
      check (candidate_basis is null or candidate_basis in ('overseas', 'australia')) not valid;
  end if;
end $$;

alter table public.user_profiles validate constraint user_profiles_candidate_pathway_check;
alter table public.user_profiles validate constraint user_profiles_candidate_basis_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_profiles: candidate preferences (all optional)
--    Existing columns that already mean something close are REUSED, not
--    duplicated: preferred_city stays "where the doctor wants to work".
--    target_arrival_date / who_moving / children_count are overseas-move
--    answers and are left alone (available_from is a real date for doctors
--    already in Australia; target_arrival_date is free text).
--    Value lists for billing_preference and current_state are enforced in
--    lib/gp-credentials.js, not here, so they can grow without a migration.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists current_suburb text,
  add column if not exists current_state text,
  add column if not exists current_postcode text,
  add column if not exists current_latitude double precision,
  add column if not exists current_longitude double precision,
  add column if not exists commute_radius_km integer,
  add column if not exists notice_period_weeks integer,
  add column if not exists available_from date,
  add column if not exists sessions_wanted numeric(4,1),
  add column if not exists billing_preference text,
  add column if not exists special_interests text[],
  add column if not exists open_to_locum boolean,
  add column if not exists open_to_relocate boolean,
  add column if not exists timezone text;

comment on column public.user_profiles.timezone is
  'AU GP build. IANA time zone name (e.g. Australia/Perth) for interview windows. NULL = not known.';
comment on column public.user_profiles.billing_preference is
  'AU GP build. bulk | mixed | private | any (validated in lib/gp-credentials.js).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. registration_cases.pathway: a mirror of user_profiles.candidate_pathway so
--    case lists and scheduled jobs can filter without a join. NULL reads as
--    overseas. The profile is the source of truth; setCandidatePathway writes both.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.registration_cases
  add column if not exists pathway text;

comment on column public.registration_cases.pathway is
  'AU GP build. Mirror of user_profiles.candidate_pathway (same six values). NULL reads as overseas.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'registration_cases_pathway_check'
      and conrelid = pg_catalog.to_regclass('public.registration_cases')
  ) then
    alter table public.registration_cases
      add constraint registration_cases_pathway_check
      check (pathway is null or pathway in (
        'overseas_esp', 'overseas_pep', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'
      )) not valid;
  end if;
end $$;

alter table public.registration_cases validate constraint registration_cases_pathway_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. gp_credentials: what a doctor who ALREADY holds Ahpra registration brings.
--    One row per doctor. THE source of truth for Ahpra registration data on
--    every Australian pathway (finding DAT-09; rule in lib/gp-credentials.js
--    readAhpraRegistration). The overseas journey keeps using
--    registration_cases.ahpra_registration_*; nothing is moved.
--    Keyed to user_profiles.user_id (uuid, itself the auth.users id), so a
--    purged account takes its credentials with it.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gp_credentials (
  user_id uuid primary key references public.user_profiles(user_id) on delete cascade,

  -- Ahpra registration
  ahpra_number text,
  ahpra_registration_type text,          -- general | specialist | general_and_specialist | provisional | limited | non_practising
  specialist_gp boolean,                 -- on the specialist register as a GP
  has_conditions boolean,
  conditions_text text,
  has_undertakings boolean,
  undertakings_text text,
  has_notations boolean,
  notations_text text,
  registration_expiry date,
  ahpra_last_checked_at timestamptz,     -- staff looked at the public register
  ahpra_last_checked_by text,

  -- Fellowship and vocational registration
  fellowship_type text,                  -- fracgp | facrrm | both | other | none
  fellowship_detail text,                -- free text when 'other'
  fellowship_year integer,
  vr_status text,                        -- vr | non_vr | unsure

  -- Section 19AB moratorium. The doctor's own answer, and the staff-confirmed
  -- answer kept separately. Only a staff-confirmed 'no' lifts the DPA
  -- restriction (lib/candidate-pathway.js computeDpaRestricted).
  moratorium_19ab_status text,           -- yes | no | unsure (doctor's answer)
  moratorium_19ab_end_date date,
  moratorium_19ab_confirmed_status text, -- yes | no (staff)
  moratorium_19ab_confirmed_by text,
  moratorium_19ab_confirmed_at timestamptz,

  -- Work rights
  work_rights text,                      -- citizen | pr | visa
  visa_subclass text,
  visa_expiry date,
  visa_sponsor_tied boolean,             -- visa is tied to a sponsoring employer
  visa_sponsor_name text,

  -- Supervision and indemnity
  supervision_level text,                -- none | level_1 .. level_4
  indemnity_provider text,
  indemnity_expiry date,

  -- Provenance: the doctor said so vs staff checked it
  self_declared_at timestamptz,
  staff_verified_at timestamptz,
  staff_verified_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gp_credentials_fellowship_type_check
    check (fellowship_type is null or fellowship_type in ('fracgp', 'facrrm', 'both', 'other', 'none')),
  constraint gp_credentials_vr_status_check
    check (vr_status is null or vr_status in ('vr', 'non_vr', 'unsure')),
  constraint gp_credentials_19ab_status_check
    check (moratorium_19ab_status is null or moratorium_19ab_status in ('yes', 'no', 'unsure')),
  constraint gp_credentials_19ab_confirmed_status_check
    check (moratorium_19ab_confirmed_status is null or moratorium_19ab_confirmed_status in ('yes', 'no')),
  constraint gp_credentials_work_rights_check
    check (work_rights is null or work_rights in ('citizen', 'pr', 'visa'))
);

comment on table public.gp_credentials is
  'AU GP build. One row per doctor who already holds Ahpra registration: registration, fellowship, 19AB, work rights, supervision, indemnity. Service role only. Source of truth for Ahpra data on Australian pathways.';

-- RLS: service role only, the same convention as public.lead_calls and
-- 20260810020000_security_advisor_hardening.sql. The app reads and writes this
-- table only through the service-role key (supabaseDbRequest), which bypasses
-- RLS. There is deliberately NO anon or authenticated policy, and their table
-- grants are revoked as well, so the public key can never read a doctor's
-- registration or visa details even if RLS were switched off by mistake.
alter table public.gp_credentials enable row level security;

drop policy if exists gp_credentials_service_all on public.gp_credentials;
create policy gp_credentials_service_all on public.gp_credentials
  for all using ((select auth.role()) = 'service_role');

revoke all on table public.gp_credentials from anon, authenticated;

-- Staff "annual re-check" and expiry sweeps read by expiry date (WP-06).
create index if not exists idx_gp_credentials_registration_expiry
  on public.gp_credentials (registration_expiry)
  where registration_expiry is not null;

-- updated_at bump on every write (public.set_updated_at() is defined in
-- 20260225014500_init_gp_link.sql).
drop trigger if exists trg_gp_credentials_updated_at on public.gp_credentials;
create trigger trg_gp_credentials_updated_at
before update on public.gp_credentials
for each row
execute function public.set_updated_at();

-- Case lists filter Australian cases by this column (WP-03, WP-04). Partial, so
-- it stays empty until a pathway is recorded.
create index if not exists idx_registration_cases_pathway
  on public.registration_cases (pathway)
  where pathway is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK NOTE. DO NOT RUN. Reference only.
-- Everything above is additive, so undoing it is dropping exactly what was
-- added. Dropping DELETES whatever staff and doctors have recorded in these
-- columns and this table, so take a copy first, and turn AU_PATHWAY_ENABLED off
-- before dropping (with the switch off no query names any of these objects).
--
--   drop index if exists public.idx_registration_cases_pathway;
--   drop trigger if exists trg_gp_credentials_updated_at on public.gp_credentials;
--   drop table if exists public.gp_credentials;
--
--   alter table public.registration_cases
--     drop constraint if exists registration_cases_pathway_check,
--     drop column if exists pathway;
--
--   alter table public.user_profiles
--     drop constraint if exists user_profiles_candidate_pathway_check,
--     drop constraint if exists user_profiles_candidate_basis_check,
--     drop column if exists candidate_pathway,
--     drop column if exists candidate_basis,
--     drop column if exists pathway_set_by,
--     drop column if exists pathway_set_at,
--     drop column if exists pathway_confirmed_at,
--     drop column if exists pathway_confirmed_by,
--     drop column if exists current_suburb,
--     drop column if exists current_state,
--     drop column if exists current_postcode,
--     drop column if exists current_latitude,
--     drop column if exists current_longitude,
--     drop column if exists commute_radius_km,
--     drop column if exists notice_period_weeks,
--     drop column if exists available_from,
--     drop column if exists sessions_wanted,
--     drop column if exists billing_preference,
--     drop column if exists special_interests,
--     drop column if exists open_to_locum,
--     drop column if exists open_to_relocate,
--     drop column if exists timezone;
-- ═════════════════════════════════════════════════════════════════════════════
