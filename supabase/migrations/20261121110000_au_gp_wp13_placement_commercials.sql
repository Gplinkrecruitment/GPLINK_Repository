-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-13: commencement, invoice and guarantee tracking on
-- a placement (ADM-06, DAT-16).
--
-- Additive only. Fifteen new nullable columns with no default on
-- public.placements, three CHECK constraints on the new columns only, one
-- partial index on them, and one partial UNIQUE index on
-- public.registration_tasks that only covers tasks this package creates (see
-- the end of the file). Nothing is dropped, renamed or narrowed, and no
-- existing row is rewritten. Safe to run twice.
--
-- What the LIVE table already has, and what is reused instead of duplicated
-- (read from scripts/au-local/schema/prod-schema.sql, public."placements"):
--
--   start_date          date   the PLANNED start date staff entered when the
--                              placement was recorded. Kept as it is. It is
--                              not the same fact as the day the doctor
--                              actually started, so `commenced_at` is new.
--   sessions_per_week   text   free text ("8", "6-8", "full time"). Kept
--                              untouched (DAT-16). The fee tier needs a
--                              number, so `sessions_per_week_numeric` is new.
--   status              text   'active' | 'ended' | 'cancelled' (live CHECK).
--                              REUSED: an early exit sets status = 'ended'.
--                              No new status column.
--   placed_at, placed_by       when and by whom the placement was recorded.
--                              Reused as they are.
--
-- public.ats_offers is not changed: its sessions_per_week is the same free
-- text and is copied onto the placement when the placement is recorded.
--
-- New columns:
--
--   candidate_basis             'australia' | 'overseas': where the doctor was
--                               based when they commenced (feeBasisFor). Only
--                               'australia' is ever written by this package.
--   fee_tier                    'full_time' | 'part_time', from the agreement's
--                               own definition (8 or more sessions a week is
--                               full-time).
--   fee_amount_ex_gst           the placement fee from the agreement variant
--                               the practice signed, exclusive of GST. NULL
--                               when it could not be worked out: a fee is
--                               never guessed.
--   agreement_variant           the agreement variant the fee was read from
--                               (lib/agreement-variants.js key).
--   commenced_at                the day the doctor actually started work.
--   commencement_confirmed_by   the staff member who confirmed it.
--   invoice_due_at              the day the invoice falls due to be RAISED
--                               (the commencement day: the agreement invoices
--                               an Australian-based placement in full on
--                               commencement).
--   invoice_sent_at             the day staff sent the invoice (by hand).
--   invoice_paid_at             the day it was paid.
--   invoice_reference           the invoice number staff typed in.
--   guarantee_ends_at           commencement + 12 weeks.
--   ended_at                    the doctor's last working day, when they left.
--   end_reason                  why (a short code plus staff's note).
--   credit_pct                  the credit percentage from the agreement's
--                               schedule. NULL when a condition could not be
--                               checked from what is on file: never guessed.
--   sessions_per_week_numeric   sessions a week as a number.
--
-- Nothing in the app talks to Xero. The "invoice" columns record what a
-- person did by hand.
--
-- Only read and written with the AU switch on, for a doctor on an Australian
-- pathway. Overseas placements are not affected.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.placements
  add column if not exists candidate_basis text,
  add column if not exists fee_tier text,
  add column if not exists fee_amount_ex_gst numeric(10,2),
  add column if not exists agreement_variant text,
  add column if not exists commenced_at date,
  add column if not exists commencement_confirmed_by text,
  add column if not exists invoice_due_at date,
  add column if not exists invoice_sent_at date,
  add column if not exists invoice_paid_at date,
  add column if not exists invoice_reference text,
  add column if not exists guarantee_ends_at date,
  add column if not exists ended_at date,
  add column if not exists end_reason text,
  add column if not exists credit_pct numeric(5,2),
  add column if not exists sessions_per_week_numeric numeric(4,1);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'placements_fee_tier_check'
      and conrelid = pg_catalog.to_regclass('public.placements')
  ) then
    alter table public.placements
      add constraint placements_fee_tier_check
      check (fee_tier is null or fee_tier in ('full_time', 'part_time')) not valid;
  end if;
end $$;

alter table public.placements validate constraint placements_fee_tier_check;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'placements_candidate_basis_check'
      and conrelid = pg_catalog.to_regclass('public.placements')
  ) then
    alter table public.placements
      add constraint placements_candidate_basis_check
      check (candidate_basis is null or candidate_basis in ('overseas', 'australia')) not valid;
  end if;
end $$;

alter table public.placements validate constraint placements_candidate_basis_check;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'placements_credit_pct_check'
      and conrelid = pg_catalog.to_regclass('public.placements')
  ) then
    alter table public.placements
      add constraint placements_credit_pct_check
      check (credit_pct is null or (credit_pct >= 0 and credit_pct <= 100)) not valid;
  end if;
end $$;

alter table public.placements validate constraint placements_credit_pct_check;

-- The daily lifecycle job reads the placements that have commenced.
create index if not exists idx_placements_commenced_at
  on public.placements (commenced_at)
  where commenced_at is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- One WP-13 task per case, placement, kind and mark.
--
-- Everything a commencement derives is a task whose metadata carries
--   lifecycle_kind   invoice_due | guarantee_checkin | week1_checkin |
--                    start_date_reached | prestart_at_risk | notice_not_recorded |
--                    indemnity_expiring | guarantee_ending | part_time_uplift |
--                    invoice_overdue | replacement_or_credit
--   placement_key    the placement it belongs to (the application id)
--   mark             which one, where there are several (w4, w8, w12, m6, a date)
-- Two requests at the same moment (two people pressing "Confirm commenced",
-- the daily job overlapping a person, two overlapping runs of the job) must
-- never produce two of the same task. A read followed by an insert cannot
-- promise that; this index does. The app treats the refused insert (PostgREST
-- 409, SQLSTATE 23505) as "already there".
--
-- A task marked `undone` (a commencement recorded in error) is left out, so a
-- later, correct commencement can create a fresh set.
--
-- Cannot fail on existing rows: `lifecycle_kind` is a metadata key that no
-- task has before this package (the index is empty when it is built). It is in
-- THIS file, with the columns, on purpose: the two are never applied apart.
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists uniq_au_lifecycle_task
  on public.registration_tasks (
    case_id,
    (metadata ->> 'placement_key'),
    (metadata ->> 'lifecycle_kind'),
    (coalesce(metadata ->> 'mark', ''))
  )
  where (metadata ->> 'lifecycle_kind') is not null
    and coalesce(metadata ->> 'undone', 'false') <> 'true';

-- Rollback (by hand, only if nothing has been recorded in these columns):
--   drop index if exists public.uniq_au_lifecycle_task;
--   drop index if exists public.idx_placements_commenced_at;
--   alter table public.placements
--     drop constraint if exists placements_fee_tier_check,
--     drop constraint if exists placements_candidate_basis_check,
--     drop constraint if exists placements_credit_pct_check,
--     drop column if exists candidate_basis, drop column if exists fee_tier,
--     drop column if exists fee_amount_ex_gst, drop column if exists agreement_variant,
--     drop column if exists commenced_at, drop column if exists commencement_confirmed_by,
--     drop column if exists invoice_due_at, drop column if exists invoice_sent_at,
--     drop column if exists invoice_paid_at, drop column if exists invoice_reference,
--     drop column if exists guarantee_ends_at, drop column if exists ended_at,
--     drop column if exists end_reason, drop column if exists credit_pct,
--     drop column if exists sessions_per_week_numeric;
