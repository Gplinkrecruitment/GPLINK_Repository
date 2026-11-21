-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-14: a "nomination transfer" visa case (APP-29,
-- ADM-22) for a segment B doctor (already in Australia, visa tied to a
-- sponsoring employer) who is changing employer.
--
-- Additive only. Seven new nullable columns with no default on
-- public.visa_applications, one CHECK on a NEW column only, and one partial
-- UNIQUE index that only covers rows this package creates. Nothing is
-- dropped, renamed or narrowed, and no existing row is rewritten. Safe to run
-- twice.
--
-- What the LIVE table already has (read from
-- scripts/au-local/schema/prod-schema.sql, public."visa_applications"), and
-- what is reused instead of duplicated:
--
--   stage            text  CHECK: nomination, lodgement, processing, granted,
--                          refused. REUSED as it is for a transfer (being
--                          prepared, lodged, being assessed, approved, not
--                          approved). The CHECK is not touched.
--   visa_subclass    text  the subclass of the visa being APPLIED for. Kept
--                          for that. A transfer keeps the doctor's existing
--                          visa, so its subclass is `current_visa_subclass`.
--   sponsor_name,
--   sponsor_contact  text  the sponsoring employer of THIS case: for a
--                          transfer, the NEW employer. REUSED.
--   grant_date       timestamptz  REUSED: the day the new nomination was
--                          approved.
--   reference_number text  REUSED.
--   notes            jsonb REUSED.
--
-- The live table has no CHECK other than the one on `stage`, so nothing has
-- to be widened.
--
-- New columns:
--
--   case_type                'new_application' | 'nomination_transfer'.
--                            NULL = an existing case: today's fresh sponsored
--                            application. Only 'nomination_transfer' is ever
--                            written by this package.
--   current_sponsor_name     the employer the doctor's visa is tied to today.
--   current_visa_expiry      when the doctor's current visa expires.
--   current_visa_subclass    the subclass of the visa the doctor holds.
--   transfer_placement_key   which placement the transfer is for (the
--                            application id, as on the pre-start tasks).
--   transfer_decided_by      the staff member who confirmed a transfer is
--                            needed. A transfer case is never created without
--                            one.
--   transfer_decided_at      when.
--
-- Only read and written with the AU switch on, for a doctor on the
-- `au_restricted` pathway. Overseas visa cases are not affected: no existing
-- select names a new column.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.visa_applications
  add column if not exists case_type text,
  add column if not exists current_sponsor_name text,
  add column if not exists current_visa_expiry date,
  add column if not exists current_visa_subclass text,
  add column if not exists transfer_placement_key text,
  add column if not exists transfer_decided_by text,
  add column if not exists transfer_decided_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'visa_applications_case_type_check'
      and conrelid = 'public.visa_applications'::regclass
  ) then
    alter table public.visa_applications
      add constraint visa_applications_case_type_check
      check (case_type is null or case_type in ('new_application', 'nomination_transfer'))
      not valid;
  end if;
end $$;

alter table public.visa_applications validate constraint visa_applications_case_type_check;

-- One transfer case per doctor and placement. This is what makes "two staff
-- members confirm the same decision at the same moment" produce ONE case: the
-- second insert is refused (PostgREST 409, SQLSTATE 23505) and the code reads
-- the first one back. It covers only rows whose case_type is
-- 'nomination_transfer', which no row is before this package, so it cannot
-- fail on existing data.
create unique index if not exists uniq_visa_nomination_transfer
  on public.visa_applications (user_id, transfer_placement_key)
  where case_type = 'nomination_transfer';

-- The staff decision task, the transfer's four tasks and the supervision task
-- are made one-per-placement by the WP-13 index `uniq_au_lifecycle_task`
-- (migration 20261121110000): each carries metadata.lifecycle_kind,
-- placement_key and mark. That migration must be applied before, or with,
-- this one. No new index on public.registration_tasks is needed.

-- Rollback (by hand, only if no transfer case has been recorded):
--   drop index if exists public.uniq_visa_nomination_transfer;
--   alter table public.visa_applications
--     drop constraint if exists visa_applications_case_type_check,
--     drop column if exists case_type, drop column if exists current_sponsor_name,
--     drop column if exists current_visa_expiry, drop column if exists current_visa_subclass,
--     drop column if exists transfer_placement_key, drop column if exists transfer_decided_by,
--     drop column if exists transfer_decided_at;
