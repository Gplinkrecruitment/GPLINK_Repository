-- ═════════════════════════════════════════════════════════════════════════════
-- Australian GP build, WP-06: staff tools (create candidate, Ahpra register
-- check, ownership).
--
-- Three additive changes. Nothing is dropped, renamed or narrowed, and no row
-- is rewritten.
--
--   1. registration_tasks.task_type   widened.
--        today (LIVE, read from pg_constraint, docs/au-gp/ENVIRONMENT.md
--        section 9), 30 values:
--          kickoff, verify, review, followup, blocker, escalation,
--          practice_pack, practice_pack_child, manual, system, visa_stage,
--          visa_doc, questionnaire, sponsor, migration_agent, sla_overdue,
--          chase, document_ops, whatsapp_help, email_triage,
--          ahpra_action_item, ahpra_correspondence, flagged_doc, doc_review,
--          zoom_call, alt_supervisor_cv_review, alt_supervisor_cv_request,
--          account_deleted_active_placement, model_update_available,
--          ahpra_conflict_letter
--        adds, used by WP-06:
--          ahpra_register_check   staff confirm a doctor on the public Ahpra
--                                 register (and the yearly re-check)
--          segment_review         a person decides the segment (A, B or C)
--                                 when the check finds conditions or lands
--                                 outside the launched segment
--        adds, for later packages (WP-11 / WP-13), so they need no further
--        change to this constraint in production. No behaviour is built for
--        them here:
--          dpa_19ab_check, reference_check, restraint_check,
--          start_date_tracking, provider_number_new_location,
--          credentialing_pack, invoice_due, indemnity_certificate,
--          guarantee_checkin
--
--   2. One OPEN ahpra_register_check task per case (partial unique index, the
--      same pattern as uniq_open_doc_check_task). The server de-duplicates with
--      a read first; this makes a racing duplicate impossible.
--
--   3. registration_cases.placing_consultant (text, nullable, no default):
--      the email of the consultant who owns an Australian case until
--      placement (owner decision 6). NULL = nobody recorded.
--
-- How the CHECK is widened: dropped and re-added with the superset inside ONE
-- `do $$ ... $$` block (a single statement: both steps happen or neither).
-- No existing row can fail a superset, so the `validate` cannot fail.
--
-- Re-runnable: the block does nothing when the constraint already allows
-- 'ahpra_register_check'; the index and the column use `if not exists`.
--
-- Written for production's public.exec_sql(query text): everything is
-- schema-qualified (it runs with an empty search_path) and there is no
-- transaction control.
--
-- NOT APPLIED ANYWHERE by an agent. Local test database only, through
-- scripts/au-local/apply-migrations.sh.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. registration_tasks.task_type
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'registration_tasks_task_type_check'
      and conrelid = pg_catalog.to_regclass('public.registration_tasks')
      and pg_catalog.pg_get_constraintdef(oid) like '%ahpra_register_check%'
  ) then
    alter table public.registration_tasks
      drop constraint if exists registration_tasks_task_type_check;
    alter table public.registration_tasks
      add constraint registration_tasks_task_type_check
      check (task_type in (
        'kickoff', 'verify', 'review', 'followup', 'blocker', 'escalation',
        'practice_pack', 'practice_pack_child', 'manual', 'system', 'visa_stage',
        'visa_doc', 'questionnaire', 'sponsor', 'migration_agent', 'sla_overdue',
        'chase', 'document_ops', 'whatsapp_help', 'email_triage',
        'ahpra_action_item', 'ahpra_correspondence', 'flagged_doc', 'doc_review',
        'zoom_call', 'alt_supervisor_cv_review', 'alt_supervisor_cv_request',
        'account_deleted_active_placement', 'model_update_available',
        'ahpra_conflict_letter',
        'ahpra_register_check', 'segment_review',
        'dpa_19ab_check', 'reference_check', 'restraint_check',
        'start_date_tracking', 'provider_number_new_location',
        'credentialing_pack', 'invoice_due', 'indemnity_certificate',
        'guarantee_checkin'
      )) not valid;
  end if;
end $$;

alter table public.registration_tasks validate constraint registration_tasks_task_type_check;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One open Ahpra register check per case
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists uniq_open_ahpra_register_check_task
  on public.registration_tasks (case_id)
  where task_type = 'ahpra_register_check'
    and status in ('open', 'in_progress', 'waiting');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Who owns an Australian case until placement
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.registration_cases
  add column if not exists placing_consultant text;

-- ═════════════════════════════════════════════════════════════════════════════
-- Rollback note (do not run without checking for rows first). Narrowing the
-- CHECK back only works while no task holds one of the new types:
--
--   select task_type, count(*) from public.registration_tasks
--     where task_type in ('ahpra_register_check', 'segment_review',
--       'dpa_19ab_check', 'reference_check', 'restraint_check',
--       'start_date_tracking', 'provider_number_new_location',
--       'credentialing_pack', 'invoice_due', 'indemnity_certificate',
--       'guarantee_checkin') group by 1;
--
--   drop index if exists public.uniq_open_ahpra_register_check_task;
--   alter table public.registration_cases drop column if exists placing_consultant;
--   alter table public.registration_tasks drop constraint if exists registration_tasks_task_type_check;
--   alter table public.registration_tasks add constraint registration_tasks_task_type_check
--     check (task_type in ( ...the 30 values listed at the top of this file... ));
-- ═════════════════════════════════════════════════════════════════════════════
