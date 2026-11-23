-- Australian GP build, fix bundle FR-1 (final review, defect R-08).
-- Referee details and provider numbers are deleted with the account.
--
-- THE PROBLEM
--   public.au_gp_doctor_details (created by
--   20261121100000_au_gp_wp12_prestart_details.sql) holds what a doctor on an
--   Australian pathway records before starting: two referees (names, phones,
--   emails), notice given, the provider and prescriber numbers they already
--   hold. Its user_id had no link to the user's row, so when an account was
--   deleted (the 90-day purge, or staff removing an account) the row stayed.
--
-- THE FIX (additive)
--   A foreign key from au_gp_doctor_details.user_id to
--   public.user_profiles(user_id) ON DELETE CASCADE: the same link
--   public.gp_credentials has. user_profiles itself cascades from the sign-in
--   account (auth.users), so deleting the account removes this row too.
--
--   The table is new in this build and empty in production, so there is no
--   existing row the constraint could reject. It is still added NOT VALID
--   first (which protects every new row and every delete at once) and then
--   validated in a block that reports, rather than fails, if an orphan row is
--   ever found: nothing is deleted or rewritten by this file.
--
-- Nothing existing is dropped, renamed or narrowed. Idempotent.
-- Must run after 20261121100000_au_gp_wp12_prestart_details.sql.

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'au_gp_doctor_details_user_id_fkey'
      and conrelid = 'public.au_gp_doctor_details'::regclass
  ) then
    alter table public.au_gp_doctor_details
      add constraint au_gp_doctor_details_user_id_fkey
      foreign key (user_id) references public.user_profiles(user_id) on delete cascade
      not valid;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'au_gp_doctor_details_user_id_fkey'
      and conrelid = 'public.au_gp_doctor_details'::regclass
      and not convalidated
  ) then
    begin
      alter table public.au_gp_doctor_details validate constraint au_gp_doctor_details_user_id_fkey;
    exception when foreign_key_violation then
      raise notice 'au_gp_fr1: au_gp_doctor_details has row(s) whose user no longer exists. The constraint stays NOT VALID (new rows and deletes are still covered). Remove those rows by hand, then validate.';
    end;
  end if;
end $$;

comment on constraint au_gp_doctor_details_user_id_fkey on public.au_gp_doctor_details is
  'AU GP build (FR-1, R-08). Deleting the doctor (user_profiles, which cascades from auth.users) deletes what they recorded here.';

-- Rollback (by hand):
--   alter table public.au_gp_doctor_details drop constraint if exists au_gp_doctor_details_user_id_fkey;
