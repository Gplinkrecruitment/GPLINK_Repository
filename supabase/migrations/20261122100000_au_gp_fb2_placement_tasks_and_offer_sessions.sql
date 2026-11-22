-- Australian GP build, fix bundle FB-2a (walk-findings R11 and W3-D18).
-- Additive and idempotent. NOT applied to any Supabase project by an agent:
-- applied to the local test database only (scripts/au-local/apply-migrations.sh).
-- The lead asks the owner once, at the end, before anything reaches production.
--
-- 1. R11: one of each placement task per placement, guaranteed by the database.
--
--    The tasks a recorded placement sets off for a doctor on an Australian
--    pathway (start date, indemnity certificate, provider number, credentialing
--    pack, the contract task, the placement decision task, the segment B
--    tasks) are created by server.js _auEnsurePlacementTask: read, then insert.
--    Until now "once" was a claim in the nudge ledger with a 250 ms takeover,
--    so two overlapping passes with a slow first insert could each insert the
--    task. From this migration each such task carries
--    metadata.placement_task_kind, and this index refuses a second row for the
--    same case, placement and kind. The insert that loses is answered 409
--    (SQLSTATE 23505) and the code treats that as "already there".
--
--    `placement_key` is the placement's own key (the application id). A doctor
--    placed a second time (walk-findings W3-D3: a new placement cycle on the
--    same case) has a different placement key, so the second placement gets
--    its own full set and nothing of the first blocks it.
--
--    The index covers only rows that carry `placement_task_kind`. No row
--    written before this migration has that key, so creating the index cannot
--    fail on existing rows and changes nothing for any existing task.

create unique index if not exists uniq_au_placement_task
  on public.registration_tasks (
    case_id,
    (metadata ->> 'placement_key'),
    (metadata ->> 'placement_task_kind')
  )
  where (metadata ->> 'placement_task_kind') is not null
    and (metadata ->> 'placement_key') is not null;

-- 2. W3-D18: sessions a week as a NUMBER on the offer.
--
--    `ats_offers.sessions_per_week` is free text ("8", "8 to 9", "full time")
--    and is never interpreted. The Australian placement fee depends on whether
--    the doctor works 8 or more sessions a week, and WP-13 holds that number on
--    the placement (placements.sessions_per_week_numeric). It was only ever
--    asked for at "Confirm commenced". This column lets staff record it when
--    the offer or the contract is sent, for a candidate on an Australian
--    pathway, and the placement then carries it. Nullable, no default: existing
--    rows and every overseas offer are untouched (the column is only ever
--    written for an Australian candidate, with the switch on, in its own write).

alter table public.ats_offers
  add column if not exists sessions_per_week_numeric numeric(4,1);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ats_offers_sessions_per_week_numeric_check'
      and conrelid = 'public.ats_offers'::regclass
  ) then
    alter table public.ats_offers
      add constraint ats_offers_sessions_per_week_numeric_check
      check (sessions_per_week_numeric is null or (sessions_per_week_numeric > 0 and sessions_per_week_numeric <= 14))
      not valid;
  end if;
end $$;

alter table public.ats_offers validate constraint ats_offers_sessions_per_week_numeric_check;

-- Rollback (by hand, only if nothing has been recorded in the column):
--   drop index if exists public.uniq_au_placement_task;
--   alter table public.ats_offers
--     drop constraint if exists ats_offers_sessions_per_week_numeric_check,
--     drop column if exists sessions_per_week_numeric;
