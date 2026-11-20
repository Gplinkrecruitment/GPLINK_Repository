-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-09: a doctor's consent to have their profile sent to
-- one practice for one role (WEB-19; consent draft section C).
--
-- Additive only. Five new nullable columns with no default on
-- gp_applications, and one CHECK on one of the new columns. Nothing is
-- dropped, renamed or narrowed, and no row is rewritten. Safe to run twice.
--
--   profile_share_consent_at       when the consent was given / recorded
--   profile_share_consent_version  which wording was shown
--                                  (lib/profile-share-consent.js CONSENT_VERSION)
--   profile_share_consent_source   doctor        the doctor ticked the box when
--                                                they applied
--                                  staff_verbal  staff recorded a consent the
--                                                doctor gave by phone or message
--   profile_share_consent_by       'self', or the staff member's email
--   profile_share_consent_role_id  the role the consent covers (the row's own
--                                  career_role_id, as text). Kept so a row that
--                                  is ever re-pointed cannot carry an old
--                                  consent to a different practice.
--
-- One gp_applications row is one doctor and one role, so the consent lives on
-- the row it covers. gp_applications has no JSON / metadata column to reuse
-- (match_reasons and redirect_alternatives are owned by AI matching).
--
-- Only read and written for a doctor on an Australian pathway with the AU
-- switch on. Existing rows are NULL, which reads as "no consent on file": an
-- Australian doctor's application then cannot be submitted to a practice until
-- the doctor applies again with the tick, or staff record a verbal consent.
-- Overseas doctors are not affected: nothing looks at these columns for them.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.gp_applications
  add column if not exists profile_share_consent_at timestamptz,
  add column if not exists profile_share_consent_version text,
  add column if not exists profile_share_consent_source text,
  add column if not exists profile_share_consent_by text,
  add column if not exists profile_share_consent_role_id text;

comment on column public.gp_applications.profile_share_consent_at is
  'AU GP build (WP-09). When the doctor agreed to this profile being sent to this practice for this role. NULL = no consent on file.';
comment on column public.gp_applications.profile_share_consent_version is
  'AU GP build (WP-09). Version of the consent wording shown (lib/profile-share-consent.js).';
comment on column public.gp_applications.profile_share_consent_source is
  'AU GP build (WP-09). doctor | staff_verbal.';
comment on column public.gp_applications.profile_share_consent_by is
  'AU GP build (WP-09). self, or the email of the staff member who recorded a verbal consent.';
comment on column public.gp_applications.profile_share_consent_role_id is
  'AU GP build (WP-09). The role the consent covers (career_role_id as text).';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'gp_applications_profile_share_consent_source_check'
      and conrelid = pg_catalog.to_regclass('public.gp_applications')
  ) then
    alter table public.gp_applications
      add constraint gp_applications_profile_share_consent_source_check
      check (profile_share_consent_source is null or profile_share_consent_source in ('doctor', 'staff_verbal'))
      not valid;
  end if;
end $$;

alter table public.gp_applications validate constraint gp_applications_profile_share_consent_source_check;

-- Rollback (not run automatically; only if this must be undone before use):
--   alter table public.gp_applications drop constraint if exists gp_applications_profile_share_consent_source_check;
--   alter table public.gp_applications
--     drop column if exists profile_share_consent_at,
--     drop column if exists profile_share_consent_version,
--     drop column if exists profile_share_consent_source,
--     drop column if exists profile_share_consent_by,
--     drop column if exists profile_share_consent_role_id;
