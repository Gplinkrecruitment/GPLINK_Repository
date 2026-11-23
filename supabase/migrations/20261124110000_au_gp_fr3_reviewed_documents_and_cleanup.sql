-- Australian GP build, fix bundle FR-3 (final review round 3: S3-08, S3-04, S3-10).
--
-- Must run AFTER 20261124100000_au_gp_fr2_server_owned_records.sql (it
-- replaces one function that file created and uses
-- public.au_gp_caller_is_server()). Additive: no table, column, policy, grant
-- or constraint is dropped, replaced or narrowed. Idempotent. Schema-qualified
-- throughout (exec_sql has an empty search path). No begin/commit.
--
-- 1. AN APPROVED AUSTRALIAN DOCUMENT STAYS WHAT STAFF APPROVED (S3-08)
--    The FR-2 guard stopped a doctor GIVING an Australian document row
--    (country_code = 'au_reg') an approval, and dropped the approval when the
--    file name, file link, key or set changed. But the stored file itself
--    (storage_path), the expiry date and every other reviewed column could
--    still be changed through the database API with the approval kept: a
--    doctor could swap the file behind an approved indemnity certificate or
--    push its expiry out.
--    Now, for a caller that is NOT the server, ANY change to an approved
--    'au_reg' row other than its updated_at puts the row back to 'uploaded'
--    with the review cleared, so staff look at it again. That is the safe
--    direction: it can re-open a pre-start step, it can never close one or
--    keep one closed. (The alternative, silently refusing the change, would
--    leave an approved row whose doctor believes they replaced the file.)
--    Rows of every other document set, and every server write, are untouched.
--
-- 2. THE ONBOARDING RECORD GOES WITH THE ACCOUNT (S3-04)
--    FR-2 added one server-only record per finished profile in
--    public.runtime_kv ('au_onboarded:<user id>'). Nothing removed it when
--    the account was deleted. An AFTER DELETE trigger on public.user_profiles
--    now deletes that one key. It can never fail the delete (every error is
--    swallowed) and touches no other key.
--
-- 3. THE STATE GUARD'S KEY LIST CANNOT BE SHRUNK BY RE-RUNNING AN OLDER FILE (S3-10)
--    20261123110000_au_gp_fr1_server_owned_columns_guard.sql now defines the
--    same three-key list as the FR-2 file (it had one key, so re-running it
--    alone silently dropped two). This file defines it once more, so the
--    newest file always leaves the full list. Post-apply check e. below
--    detects a short list whatever was run.
--
-- AFTER APPLYING, in addition to checks a. to d. in the FR-2 file's header:
--   e. select p.prosrc like '%gp_au_placement_hold%'
--         and p.prosrc like '%gp_au_signup_audience%'
--         and p.prosrc like '%gp_au_branch_started_at%' as full_key_list
--      from pg_catalog.pg_proc p
--      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname = 'au_gp_guard_user_state';   -- must be t
--   f. select tgname from pg_catalog.pg_trigger
--        where tgname = 'trg_au_gp_onboarded_record_cleanup' and not tgisinternal;   -- one row

-- 0. Preconditions.
do $$
begin
  if pg_catalog.to_regprocedure('public.au_gp_caller_is_server()') is null then
    raise exception 'AU GP FR-3: public.au_gp_caller_is_server() is missing. Apply the FR-1 and FR-2 migrations first.';
  end if;
  if pg_catalog.to_regprocedure('public.au_gp_guard_user_documents()') is null then
    raise exception 'AU GP FR-3: public.au_gp_guard_user_documents() is missing. Apply 20261124100000_au_gp_fr2_server_owned_records.sql first.';
  end if;
end $$;

-- 1. The document guard (the FR-2 function, with the wider rule for an
--    approved row; the trigger that calls it already exists).
create or replace function public.au_gp_guard_user_documents()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_new jsonb;
  v_old jsonb;
begin
  if public.au_gp_caller_is_server() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.country_code = 'au_reg' then
      if new.status in ('approved', 'accepted') then
        new.status := 'uploaded';
      end if;
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;
    return new;
  end if;
  -- UPDATE
  if new.country_code = 'au_reg' or old.country_code = 'au_reg' then
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    if new.status in ('approved', 'accepted') then
      if old.status not in ('approved', 'accepted') or old.country_code is distinct from 'au_reg' then
        -- cannot be moved to approved, or carried in approved from another set
        new.status := case when old.country_code = 'au_reg' then old.status else 'uploaded' end;
      else
        -- An approved row. Compare everything except the bookkeeping column
        -- and the three columns this function has just put back.
        v_new := pg_catalog.to_jsonb(new) - 'updated_at' - 'status' - 'reviewed_by' - 'reviewed_at';
        v_old := pg_catalog.to_jsonb(old) - 'updated_at' - 'status' - 'reviewed_by' - 'reviewed_at';
        if v_new is distinct from v_old then
          -- anything reviewed has changed: staff look again
          new.status := 'uploaded';
          new.reviewed_by := null;
          new.reviewed_at := null;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

comment on function public.au_gp_guard_user_documents() is
  'AU GP build (FR-2 S2-01, FR-3 S3-08). BEFORE INSERT OR UPDATE on public.user_documents: for a caller that is not the server, a row of the Australian document set (country_code au_reg) cannot be given an approval, and any change to an approved row puts it back to uploaded for review. Rows of every other set are untouched.';

-- 2. The onboarding record goes with the account.
create or replace function public.au_gp_forget_onboarded()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- SECURITY DEFINER on purpose: runtime_kv is closed to the public roles.
  -- Deletes the one key that belongs to the deleted profile, nothing else.
  begin
    delete from public.runtime_kv where key = 'au_onboarded:' || old.user_id::text;
  exception when others then
    null;  -- never fails the delete
  end;
  return null;
end;
$function$;

comment on function public.au_gp_forget_onboarded() is
  'AU GP build (FR-3, S3-04). AFTER DELETE on public.user_profiles: removes the server-only record runtime_kv au_onboarded:<user id>. Swallows every error.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass
      and t.tgname = 'trg_au_gp_onboarded_record_cleanup' and not t.tgisinternal
  ) then
    create trigger trg_au_gp_onboarded_record_cleanup
      after delete on public.user_profiles
      for each row execute function public.au_gp_forget_onboarded();
  end if;
end $$;

-- Records left by accounts already deleted (none are expected; harmless).
delete from public.runtime_kv k
where k.key like 'au_onboarded:%'
  and not exists (
    select 1 from public.user_profiles p
    where 'au_onboarded:' || p.user_id::text = k.key
  );

-- 3. The state guard, with the full key list (identical to the FR-2 file's).
create or replace function public.au_gp_guard_user_state()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_keys constant text[] := array['gp_au_placement_hold', 'gp_au_signup_audience', 'gp_au_branch_started_at'];
  v_key text;
  v_new jsonb;
  v_old jsonb;
begin
  if public.au_gp_caller_is_server() then
    return new;
  end if;
  v_new := new.state;
  if v_new is null or pg_catalog.jsonb_typeof(v_new) <> 'object' then
    if tg_op = 'UPDATE' and old.state is not null and pg_catalog.jsonb_typeof(old.state) = 'object'
       and old.state ?| v_keys then
      new.state := old.state;
    end if;
    return new;
  end if;
  v_old := case when tg_op = 'UPDATE' and old.state is not null and pg_catalog.jsonb_typeof(old.state) = 'object'
                then old.state else '{}'::jsonb end;
  foreach v_key in array v_keys loop
    if v_old ? v_key then
      v_new := pg_catalog.jsonb_set(v_new, array[v_key], v_old -> v_key, true);
    else
      v_new := v_new - v_key;
    end if;
  end loop;
  new.state := v_new;
  return new;
end;
$function$;

comment on function public.au_gp_guard_user_state() is
  'AU GP build (FR-1 B-01, FR-2 S2-01, FR-3 S3-10). BEFORE INSERT OR UPDATE on public.user_state: for a caller that is not the server, the server-owned keys gp_au_placement_hold, gp_au_signup_audience and gp_au_branch_started_at keep their old value (or stay absent). Every other key is untouched.';

-- 4. Grants (trigger functions are never called through the API).
revoke all on function public.au_gp_guard_user_documents() from public, anon, authenticated;
revoke all on function public.au_gp_forget_onboarded() from public, anon, authenticated;
revoke all on function public.au_gp_guard_user_state() from public, anon, authenticated;
grant execute on function public.au_gp_guard_user_documents() to service_role;
grant execute on function public.au_gp_forget_onboarded() to service_role;
grant execute on function public.au_gp_guard_user_state() to service_role;

-- Rollback (by hand; only with the switch off):
--   drop trigger if exists trg_au_gp_onboarded_record_cleanup on public.user_profiles;
--   drop function if exists public.au_gp_forget_onboarded();
--   (the document guard: re-run section 2 of the FR-2 file to restore its narrower rule)
