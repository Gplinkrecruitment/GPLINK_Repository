-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-08: role fields, the server-owned preferred
-- locations list, and the "a person reviewed this doctor's flags" stamp.
--
-- Additive only. New nullable columns with no default, four CHECKs on the new
-- columns. Nothing is dropped, renamed or narrowed, and no row is rewritten.
-- Safe to run twice.
--
--   1. career_roles: who a role is open to (DAT-12, DAT-13, WEB-10 data)
--        vr_requirement      vr_required | vr_preferred | non_vr_accepted
--                            NULL is read as vr_required for an Australian
--                            doctor (owner decision 5: non-VR is gated off
--                            unless a role explicitly accepts it).
--        accepts_registrars  NULL is read as no.
--        accepts_supervised  NULL is read as no.
--        engagement_type     permanent | contract (locum is out of scope:
--                            owner decision 10).
--        sessions_min / sessions_max   sessions a week the role offers.
--        special_interests   text[] (house style: career_roles.tags is text[]).
--        dpa_status          yes | no | unknown. A STATUS beside the existing
--                            boolean, not a replacement for it.
--
--      The existing `dpa boolean not null default false` is NOT changed and
--      stays the only thing the overseas rules read. It stores "unknown" as
--      false (DAT-13); dpa_status is where "unknown" can now be said. NULL
--      dpa_status = not recorded: an Australian doctor's rules then fall back
--      to the boolean (true = in a DPA; anything else = not known to be).
--
--      NOT added, because the table already carries them:
--        billing model  -> career_roles.billing_model (text: 'mixed', 'bulk',
--                          'private', or a legacy label such as 'Mixed
--                          Billing'), with mixed_billing / private_billing.
--                          Read through roleEligibility.normaliseBillingModel.
--        MMM            -> career_roles.mmm (text). Metro / regional is derived
--                          from it (MM1 = metro), falling back to the existing
--                          metro / regional booleans.
--
--   2. user_profiles.preferred_locations (text[])
--        The full list an Australian doctor picked at onboarding. Until now it
--        lived only in user_state.gp_onboarding, which the doctor's browser can
--        rewrite. Written by the server from validated answers.
--
--   3. gp_credentials.flags_reviewed_at / flags_reviewed_by
--        "A person has looked at this doctor's condition, undertaking or
--        notation." Staff only. Cleared by the application whenever the flags
--        on file change.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. career_roles
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.career_roles
  add column if not exists vr_requirement text,
  add column if not exists accepts_registrars boolean,
  add column if not exists accepts_supervised boolean,
  add column if not exists engagement_type text,
  add column if not exists sessions_min numeric(4,1),
  add column if not exists sessions_max numeric(4,1),
  add column if not exists special_interests text[],
  add column if not exists dpa_status text;

comment on column public.career_roles.vr_requirement is
  'AU GP build. vr_required | vr_preferred | non_vr_accepted. NULL is read as vr_required for an Australian doctor.';
comment on column public.career_roles.accepts_registrars is
  'AU GP build. The role accepts GP registrars. NULL is read as no.';
comment on column public.career_roles.accepts_supervised is
  'AU GP build. The role accepts doctors who need supervision (limited / provisional registration). NULL is read as no.';
comment on column public.career_roles.engagement_type is
  'AU GP build. permanent | contract. Locum work is out of scope.';
comment on column public.career_roles.sessions_min is
  'AU GP build. Fewest sessions a week the role offers.';
comment on column public.career_roles.sessions_max is
  'AU GP build. Most sessions a week the role offers.';
comment on column public.career_roles.special_interests is
  'AU GP build. Clinical special interests the practice wants or supports.';
comment on column public.career_roles.dpa_status is
  'AU GP build. yes | no | unknown. A status beside the dpa boolean (which is unchanged and is all the overseas rules read). NULL = not recorded.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'career_roles_vr_requirement_check'
      and conrelid = pg_catalog.to_regclass('public.career_roles')
  ) then
    alter table public.career_roles
      add constraint career_roles_vr_requirement_check
      check (vr_requirement is null or vr_requirement in ('vr_required', 'vr_preferred', 'non_vr_accepted')) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'career_roles_engagement_type_check'
      and conrelid = pg_catalog.to_regclass('public.career_roles')
  ) then
    alter table public.career_roles
      add constraint career_roles_engagement_type_check
      check (engagement_type is null or engagement_type in ('permanent', 'contract')) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'career_roles_dpa_status_check'
      and conrelid = pg_catalog.to_regclass('public.career_roles')
  ) then
    alter table public.career_roles
      add constraint career_roles_dpa_status_check
      check (dpa_status is null or dpa_status in ('yes', 'no', 'unknown')) not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'career_roles_sessions_range_check'
      and conrelid = pg_catalog.to_regclass('public.career_roles')
  ) then
    alter table public.career_roles
      add constraint career_roles_sessions_range_check
      check (
        (sessions_min is null or (sessions_min >= 0 and sessions_min <= 14))
        and (sessions_max is null or (sessions_max >= 0 and sessions_max <= 14))
        and (sessions_min is null or sessions_max is null or sessions_min <= sessions_max)
      ) not valid;
  end if;
end $$;

alter table public.career_roles validate constraint career_roles_vr_requirement_check;
alter table public.career_roles validate constraint career_roles_engagement_type_check;
alter table public.career_roles validate constraint career_roles_dpa_status_check;
alter table public.career_roles validate constraint career_roles_sessions_range_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_profiles: the full preferred-locations list, server-owned
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists preferred_locations text[];

comment on column public.user_profiles.preferred_locations is
  'AU GP build. Every location an Australian doctor chose at onboarding (validated values). Server-written; preferred_city still holds the first city.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. gp_credentials: the reviewed stamp
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.gp_credentials
  add column if not exists flags_reviewed_at timestamptz,
  add column if not exists flags_reviewed_by text;

comment on column public.gp_credentials.flags_reviewed_at is
  'AU GP build. Staff only. When a person last reviewed this doctor''s condition / undertaking / notation flags. Cleared when the flags change.';
comment on column public.gp_credentials.flags_reviewed_by is
  'AU GP build. Staff only. Who reviewed them.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Rollback (not run automatically; only if this must be undone):
--
--   alter table public.career_roles
--     drop constraint if exists career_roles_vr_requirement_check,
--     drop constraint if exists career_roles_engagement_type_check,
--     drop constraint if exists career_roles_dpa_status_check,
--     drop constraint if exists career_roles_sessions_range_check,
--     drop column if exists vr_requirement,
--     drop column if exists accepts_registrars,
--     drop column if exists accepts_supervised,
--     drop column if exists engagement_type,
--     drop column if exists sessions_min,
--     drop column if exists sessions_max,
--     drop column if exists special_interests,
--     drop column if exists dpa_status;
--   alter table public.user_profiles drop column if exists preferred_locations;
--   alter table public.gp_credentials
--     drop column if exists flags_reviewed_at,
--     drop column if exists flags_reviewed_by;
-- ═════════════════════════════════════════════════════════════════════════════
