-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-12: the doctor's pre-start page and the Medicare
-- provider number for a new practice location (ADM-21, APP-12, APP-13).
--
-- Additive only. Five new nullable columns with no default on
-- pbs_applications, and one new service-only table. Nothing is dropped,
-- renamed or narrowed, and no row is rewritten. Safe to run twice.
--
-- 1. pbs_applications: where the new location's provider number is held
--
--    The table is one row per doctor per type: the live constraint is
--      pbs_applications_user_id_application_type_key UNIQUE (user_id, application_type)
--    A second row for a second location is therefore impossible without
--    dropping or narrowing that constraint, which this build never does. So
--    the location is recorded ON the doctor's existing `medicare_provider`
--    row: that row's provider_number is the number for the location named in
--    the columns below.
--
--    KNOWN LIMIT (documented in docs/au-gp/CONVENTIONS.md section 24): one
--    new-location number per doctor at a time. A doctor placed a second time
--    overwrites the first location on this row (the earlier number stays on
--    the earlier placement's task, in registration_tasks.metadata). Holding
--    several at once needs a child table or a wider unique key: an owner
--    decision, because it changes a live constraint.
--
--      au_location_practice_id     the practice (practices.id) when known
--      au_location_name            the practice / location name as recorded
--      au_location_placement_key   the placement the number belongs to (the
--                                  application id; matches
--                                  registration_tasks.metadata.placement_key)
--      au_location_recorded_by     staff email, or 'doctor'
--      au_location_recorded_at     when it was recorded
--
-- 2. au_gp_doctor_details: what an Australian GP tells us on the pre-start
--    page and in Account that has no other home. One row per doctor.
--
--      referees                    jsonb array of exactly two objects:
--                                  { name, role, relationship, phone, email,
--                                    agreed_to_contact, at_current_practice }
--      referees_submitted_at
--      notice_given                the doctor recorded "I have given notice"
--      notice_given_date           the date they gave it
--      notice_placement_key        the placement it was recorded for
--      notice_recorded_at
--      existing_provider_numbers   jsonb array of { number, location }: the
--                                  provider numbers the doctor already holds
--      prescriber_number           the doctor's existing prescriber number
--
-- Only read and written with the AU switch on, for a doctor on an Australian
-- pathway. Overseas doctors are not affected: nothing looks at any of this
-- for them.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.pbs_applications
  add column if not exists au_location_practice_id uuid,
  add column if not exists au_location_name text,
  add column if not exists au_location_placement_key text,
  add column if not exists au_location_recorded_by text,
  add column if not exists au_location_recorded_at timestamptz;

comment on column public.pbs_applications.au_location_practice_id is
  'AU GP build (WP-12, ADM-21). The practice this row''s provider_number is for, when known.';
comment on column public.pbs_applications.au_location_name is
  'AU GP build (WP-12, ADM-21). The practice / location name this row''s provider_number is for.';
comment on column public.pbs_applications.au_location_placement_key is
  'AU GP build (WP-12, ADM-21). The placement (application id) the number was recorded for.';
comment on column public.pbs_applications.au_location_recorded_by is
  'AU GP build (WP-12). Who recorded the number: a staff email, or doctor.';
comment on column public.pbs_applications.au_location_recorded_at is
  'AU GP build (WP-12). When the number was recorded.';

create table if not exists public.au_gp_doctor_details (
  user_id uuid primary key,
  referees jsonb,
  referees_submitted_at timestamptz,
  notice_given boolean,
  notice_given_date date,
  notice_placement_key text,
  notice_recorded_at timestamptz,
  existing_provider_numbers jsonb,
  prescriber_number text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

comment on table public.au_gp_doctor_details is
  'AU GP build (WP-12). What a doctor on an Australian pathway records on the pre-start page and in Account: two referees, notice given, the provider and prescriber numbers they already hold. One row per doctor. Service role only.';

alter table public.au_gp_doctor_details enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'au_gp_doctor_details'
      and policyname = 'au_gp_doctor_details_service_all'
  ) then
    create policy au_gp_doctor_details_service_all on public.au_gp_doctor_details
      for all using ((select auth.role()) = 'service_role')
      with check ((select auth.role()) = 'service_role');
  end if;
end $$;

revoke all on public.au_gp_doctor_details from anon, authenticated;

-- Rollback (manual, only if nothing has been stored):
--   drop table if exists public.au_gp_doctor_details;
--   alter table public.pbs_applications
--     drop column if exists au_location_practice_id,
--     drop column if exists au_location_name,
--     drop column if exists au_location_placement_key,
--     drop column if exists au_location_recorded_by,
--     drop column if exists au_location_recorded_at;
