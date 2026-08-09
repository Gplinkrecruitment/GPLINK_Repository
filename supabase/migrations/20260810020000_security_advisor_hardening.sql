-- Security Advisor hardening — clears every Supabase Security Advisor finding
-- (2 errors, 16 linter warnings, 20 info suggestions) at its root cause.
--
-- ROOT CAUSE 1 — tables (the 2 ERRORS)
-- Supabase ships this project with ALTER DEFAULT PRIVILEGES on schema `public`
-- granting arwdDxtm (i.e. ALL: select/insert/update/delete) on every NEW table
-- to `anon` and `authenticated`. That means row level security is the ONLY
-- thing standing between the public/publishable key (which ships inside the
-- front-end by design) and the table contents.
--   public.career_contracts and public.practice_groups were created without
--   `enable row level security`, so both were fully readable AND writable with
--   nothing but the public key. Verified live before this migration: an anon
--   request returned real contract rows and 18 practice_groups rows including
--   contact_email / contact_name / abn.
-- Every server-side read/write of these tables goes through supabaseDbRequest(),
-- which always uses SUPABASE_SERVICE_ROLE_KEY, and `service_role` has
-- rolbypassrls = true — so enabling RLS changes nothing for the app.
-- We also drop the anon/authenticated grants entirely, matching the tables that
-- were already tightened this way (career_roles, candidate_leads). Belt and
-- braces: if RLS is ever accidentally disabled again, the data stays shut.
--
-- ROOT CAUSE 2 — functions (10 of the WARNINGS)
-- PostgreSQL grants EXECUTE on every new function to PUBLIC implicitly, and
-- every role (including anon) inherits PUBLIC. Migration 20260730090000 already
-- tried to close this with `revoke all ... from anon, authenticated`, but that
-- leaves the PUBLIC grant in place, so has_function_privilege('anon', …) was
-- still true. The ACL showed `=X/postgres` — the PUBLIC entry. Revoking from
-- PUBLIC is the actual fix; we then grant EXECUTE back explicitly to the roles
-- that really invoke these functions.
--
-- ROOT CAUSE 3 — search_path (5 WARNINGS)
-- Five functions were created without a pinned search_path, so they resolve
-- object names using whatever search_path the caller happens to have. Pinned to
-- `public, pg_temp`, which is what they already effectively ran with — no
-- behaviour change, but it can no longer be redirected by a caller.
--
-- ROOT CAUSE 4 — storage listing (1 WARNING)
-- `career-hero-images` is a PUBLIC bucket, so its object URLs are served
-- without consulting storage.objects at all. The extra broad SELECT policy for
-- anon/authenticated therefore added no needed capability — it only let clients
-- LIST every file in the bucket. The other public bucket
-- (`practice-intro-videos`) has no such policy and works fine, which is the
-- proof that dropping it is safe.
--
-- ROOT CAUSE 5 — RLS enabled with no policy (the 20 INFO suggestions)
-- These are server-only tables: RLS is on, no policy exists, so PostgREST
-- returns nothing to anon/authenticated (correct) while the service key
-- bypasses RLS. The advisor still flags them because a table with no policy is
-- indistinguishable from one whose policies were forgotten. We add the same
-- explicit `<table>_service_all` service_role policy the other 32 tables in
-- this database already use, which documents the intent and clears the advisor
-- without granting anything new.

set local search_path to public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. ERRORS: rls_disabled_in_public
-- ---------------------------------------------------------------------------

alter table public.career_contracts enable row level security;
alter table public.practice_groups  enable row level security;

drop policy if exists career_contracts_service_all on public.career_contracts;
create policy career_contracts_service_all on public.career_contracts
  for all using ((select auth.role()) = 'service_role');

drop policy if exists practice_groups_service_all on public.practice_groups;
create policy practice_groups_service_all on public.practice_groups
  for all using ((select auth.role()) = 'service_role');

revoke all on table public.career_contracts from anon, authenticated;
revoke all on table public.practice_groups  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. INFO: rls_enabled_no_policy — explicit service_role policy per table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  tables text[] := array[
    'admin_audit_log', 'admin_mfa', 'client_errors', 'email_suppression',
    'email_templates', 'error_fix_proposals', 'gmail_watch_state',
    'incoming_email_todos', 'notification_preferences', 'password_setup_tokens',
    'pending_hires', 'processed_gmail_messages', 'processed_zoho_sign_events',
    'push_subscriptions', 'schema_migrations', 'system_bugs',
    'user_doc_scan_failures', 'user_session_epoch', 'webhook_events',
    'zoho_sign_envelopes'
  ];
begin
  foreach t in array tables loop
    if pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(t)) is not null then
      execute pg_catalog.format('drop policy if exists %I on public.%I', t || '_service_all', t);
      execute pg_catalog.format(
        'create policy %I on public.%I for all using ((select auth.role()) = ''service_role'')',
        t || '_service_all', t
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. WARNINGS: function_search_path_mutable
-- ---------------------------------------------------------------------------

alter function public.set_updated_at()                                set search_path = public, pg_temp;
alter function public.is_admin(uuid)                                  set search_path = public, pg_temp;
alter function public.is_super_admin(uuid)                            set search_path = public, pg_temp;
alter function public.get_ahpra_readiness(uuid)                       set search_path = public, pg_temp;
alter function public.rate_limit_hit(text, integer, bigint)           set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. WARNINGS: anon_/authenticated_security_definer_function_executable
--    Revoke the implicit PUBLIC grant, then re-grant only to real callers.
--
--    handle_new_auth_user / handle_ahpra_case_change / handle_ahpra_doc_change
--    return `trigger`, so PostgREST does not expose them at all (verified: an
--    anon POST to /rest/v1/rpc/<name> returns PGRST202 "not found in the schema
--    cache"). PostgreSQL checks EXECUTE on a trigger function when the TRIGGER
--    is created, not on every fire — but we still grant EXECUTE explicitly to
--    every role that performs a triggering write, so the triggers cannot break
--    even if that check were to change.
--
--    log_ahpra_event / mark_ahpra_download_attempt WERE genuinely reachable:
--    they are ordinary callable functions and anon held EXECUTE. They are only
--    ever invoked from inside other SECURITY DEFINER functions/triggers — the
--    single rpc/ call anywhere in the server code is rpc/rate_limit_hit.
-- ---------------------------------------------------------------------------

revoke all on function public.handle_new_auth_user()         from public, anon, authenticated;
revoke all on function public.handle_ahpra_case_change()     from public, anon, authenticated;
revoke all on function public.handle_ahpra_doc_change()      from public, anon, authenticated;
revoke all on function public.log_ahpra_event(uuid, text, text, text, jsonb, text)
                                                             from public, anon, authenticated;
revoke all on function public.mark_ahpra_download_attempt(uuid, jsonb)
                                                             from public, anon, authenticated;

-- Completes the partial revoke in 20260730090000 (it missed PUBLIC).
revoke all on function public.rate_limit_hit(text, integer, bigint) from public;

grant execute on function public.handle_new_auth_user()      to postgres, service_role;
grant execute on function public.handle_ahpra_case_change()  to postgres, service_role;
grant execute on function public.handle_ahpra_doc_change()   to postgres, service_role;
grant execute on function public.log_ahpra_event(uuid, text, text, text, jsonb, text)
                                                             to postgres, service_role;
grant execute on function public.mark_ahpra_download_attempt(uuid, jsonb)
                                                             to postgres, service_role;
grant execute on function public.rate_limit_hit(text, integer, bigint) to postgres, service_role;

-- Roles that only exist on hosted Supabase: auth writes into auth.users as
-- supabase_auth_admin, and an owner editing a row in the Supabase table editor
-- writes as dashboard_user. Granting to them keeps signup and manual edits
-- working; neither role is anon/authenticated, so the advisor stays clear.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.handle_new_auth_user() to supabase_auth_admin';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'dashboard_user') then
    execute 'grant execute on function public.handle_new_auth_user() to dashboard_user';
    execute 'grant execute on function public.handle_ahpra_case_change() to dashboard_user';
    execute 'grant execute on function public.handle_ahpra_doc_change() to dashboard_user';
    execute 'grant execute on function public.log_ahpra_event(uuid, text, text, text, jsonb, text) to dashboard_user';
    execute 'grant execute on function public.mark_ahpra_download_attempt(uuid, jsonb) to dashboard_user';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. WARNING: public_bucket_allows_listing
-- ---------------------------------------------------------------------------

-- storage.objects is owned by supabase_storage_admin and `postgres` is not a
-- member of that role, so this DROP only succeeds when the migration is run by
-- a storage-privileged role. Applied by hand via Dashboard -> Storage ->
-- Policies otherwise. Guarded so the rest of the migration still applies.
do $$
begin
  execute 'drop policy if exists career_hero_images_public_select on storage.objects';
exception
  when insufficient_privilege then
    raise warning 'SKIPPED: drop policy career_hero_images_public_select on storage.objects — needs supabase_storage_admin (do it in Dashboard -> Storage -> Policies)';
end $$;

-- Make the new tables/functions visible to PostgREST straight away.
notify pgrst, 'reload schema';
