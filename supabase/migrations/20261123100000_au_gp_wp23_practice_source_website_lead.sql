-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-23: let the website's practice lead form save.
--
-- Widens ONE CHECK constraint. Nothing else changes: no column, no row, no
-- default. Additive only: every value that is allowed today stays allowed.
--
--   practices.source   today (LIVE, read from pg_constraint through
--                      scripts/au-local/snapshot-schema.js --check on
--                      2026-11-23, and the same list as the committed snapshot
--                      scripts/au-local/schema/prod-schema.sql):
--                        zoho_sync, internal_ats, manual, backfill,
--                        facebook_lead, website_enquiry
--                      adds: website_lead
--
-- WHY. The practice lead form on /employers (POST /api/public/practice-lead,
-- lib/practice-pipeline.js buildPracticeProspectRow) has always written
-- source = 'website_lead'. That value is not in the list above, so the insert
-- is refused (23514) and the visitor is told "Something went wrong saving
-- that". No migration ever added the value. This is NOT caused by the
-- Australian build and does not depend on its switch: it was found when WP-23
-- walked "a metro practice outside a DPA fills in the lead form" on the local
-- copy of the production structure. A practice that came through the Meta
-- lead form ('facebook_lead') is not affected.
--
-- Until this is applied, a new practice can still be brought in through the
-- CEO dashboard or the Meta lead form and sent the intake link; only the
-- website form's own first step fails.
--
-- How a CHECK is widened: it cannot be altered in place, so it is dropped and
-- re-added with the superset list, inside ONE `do $$ ... $$` block (a single
-- statement: both steps happen or neither does). No existing row can fail a
-- superset, so the `validate` that follows cannot fail.
--
-- Re-runnable: the block does nothing when the constraint already allows
-- 'website_lead'.
--
-- Written for production's public.exec_sql(query text): everything is
-- schema-qualified and there is no transaction control.
--
-- NOT APPLIED ANYWHERE by an agent. Local test database only, through
-- scripts/au-local/apply-migrations.sh.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'practices_source_check'
      and conrelid = pg_catalog.to_regclass('public.practices')
      and pg_catalog.pg_get_constraintdef(oid) like '%website_lead%'
  ) then
    alter table public.practices
      drop constraint if exists practices_source_check;
    alter table public.practices
      add constraint practices_source_check
      check (source in (
        'zoho_sync', 'internal_ats', 'manual', 'backfill', 'facebook_lead', 'website_enquiry',
        'website_lead'
      )) not valid;
  end if;
end
$$;

alter table public.practices validate constraint practices_source_check;
