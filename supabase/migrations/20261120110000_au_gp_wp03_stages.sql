-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-03: the Australian stage ladder.
--
-- Widens two CHECK constraints so a registration case (and an assistance call)
-- can hold the Australian stages. Nothing else changes: no column, no row, no
-- default. Additive only: every value that is allowed today stays allowed.
--
--   registration_cases.stage   today (LIVE, read from pg_constraint, see
--                              docs/au-gp/ENVIRONMENT.md section 9):
--                                myintealth, amc, career, ahpra, visa, pbs,
--                                commencement, complete
--                              adds: placement, prestart, commenced, guarantee
--
--   scheduled_calls.stage      today (LIVE): NULL, myintealth, amc, ahpra
--                              adds: placement, prestart, commenced, guarantee
--                              The server only accepts 'prestart' for an
--                              Australian doctor today (lib/journey-ladders.js
--                              AU_CALL_STAGES). The other three are allowed here
--                              so the commencement and guarantee check-in calls
--                              (WP-13) do not need a second production migration.
--
-- How a CHECK is widened: it cannot be altered in place, so it is dropped and
-- re-added with the superset list. Both steps sit inside ONE `do $$ ... $$`
-- block, which Postgres runs as a single statement: either both happen or
-- neither does, and there is no moment where the table has no constraint that
-- another session could see. No existing row can fail a superset, so the
-- `validate` that follows cannot fail.
--
-- Re-runnable: each block does nothing when the constraint already allows
-- 'guarantee'.
--
-- Written for production's public.exec_sql(query text): everything is
-- schema-qualified (it runs with an empty search_path) and there is no
-- transaction control.
--
-- NOT APPLIED ANYWHERE by an agent. Local test database only, through
-- scripts/au-local/apply-migrations.sh.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. registration_cases.stage
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'registration_cases_stage_check'
      and conrelid = pg_catalog.to_regclass('public.registration_cases')
      and pg_catalog.pg_get_constraintdef(oid) like '%guarantee%'
  ) then
    alter table public.registration_cases
      drop constraint if exists registration_cases_stage_check;
    alter table public.registration_cases
      add constraint registration_cases_stage_check
      check (stage in (
        'myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement', 'complete',
        'placement', 'prestart', 'commenced', 'guarantee'
      )) not valid;
  end if;
end $$;

alter table public.registration_cases validate constraint registration_cases_stage_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. scheduled_calls.stage
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'scheduled_calls_stage_check'
      and conrelid = pg_catalog.to_regclass('public.scheduled_calls')
      and pg_catalog.pg_get_constraintdef(oid) like '%guarantee%'
  ) then
    alter table public.scheduled_calls
      drop constraint if exists scheduled_calls_stage_check;
    alter table public.scheduled_calls
      add constraint scheduled_calls_stage_check
      check (stage is null or stage in (
        'myintealth', 'amc', 'ahpra',
        'placement', 'prestart', 'commenced', 'guarantee'
      )) not valid;
  end if;
end $$;

alter table public.scheduled_calls validate constraint scheduled_calls_stage_check;

-- ═════════════════════════════════════════════════════════════════════════════
-- Rollback note (do not run without checking for rows first). Narrowing back
-- only works while no row holds an Australian stage:
--
--   select stage, count(*) from public.registration_cases
--     where stage in ('placement', 'prestart', 'commenced', 'guarantee') group by 1;
--   select stage, count(*) from public.scheduled_calls
--     where stage in ('placement', 'prestart', 'commenced', 'guarantee') group by 1;
--
--   alter table public.registration_cases drop constraint if exists registration_cases_stage_check;
--   alter table public.registration_cases add constraint registration_cases_stage_check
--     check (stage in ('myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement', 'complete'));
--   alter table public.scheduled_calls drop constraint if exists scheduled_calls_stage_check;
--   alter table public.scheduled_calls add constraint scheduled_calls_stage_check
--     check (stage is null or stage in ('myintealth', 'amc', 'ahpra'));
-- ═════════════════════════════════════════════════════════════════════════════
