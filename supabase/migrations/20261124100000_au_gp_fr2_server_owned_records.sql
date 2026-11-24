-- Australian GP build, fix bundle FR-2 (final review round 2: R2-02 b, S2-01).
-- Three more things only the server may decide.
--
-- Must run AFTER 20261123110000_au_gp_fr1_server_owned_columns_guard.sql
-- (it uses public.au_gp_caller_is_server() and replaces one function that
-- file created). Additive: no existing table, column, policy, grant or
-- constraint is dropped, replaced or narrowed. Idempotent. Schema-qualified
-- throughout (exec_sql has an empty search path). No begin/commit.
--
-- 1. THE SERVER'S OWN RECORD THAT A DOCTOR FINISHED ONBOARDING (R2-02 b)
--    public.user_profiles.onboarding_completed_at can be changed by the
--    doctor through the database API with their own token (row policy
--    "profiles_update_own"); the owner decided not to guard that column
--    (P-02). So an onboarded overseas doctor could set it to NULL and then
--    post the Australian onboarding as if for the first time. The server now
--    also asks a record the doctor cannot reach: public.runtime_kv (row
--    security off, every grant revoked from anon and authenticated), key
--    'au_onboarded:<user id>'.
--      * An AFTER trigger writes that record the moment the column first
--        becomes non-null, whoever wrote it. It only ever INSERTS (on
--        conflict: nothing), never updates or deletes, and it can never fail
--        or change the profile write (every error is swallowed).
--      * One record is written now for every profile already finished.
--    The app makes no extra request for an overseas doctor, so the overseas
--    completion is request-for-request what it is today.
--    A doctor setting the column themselves only creates a record that says
--    "finished": it can never make them look NOT finished.
--
-- 2. APPROVAL OF AN AUSTRALIAN DOCUMENT (S2-01 i)
--    Row policies "user_documents_insert_own" / "user_documents_update_own"
--    let a signed-in user write their own rows, including status. A doctor
--    could insert an Australian document row already marked 'approved', and
--    the server's pre-start checks read that status. For rows of the
--    Australian document set ONLY (country_code = 'au_reg', which no overseas
--    doctor has) a non-server write can no longer set, keep-by-swap or forge
--    an approval:
--      INSERT  status 'approved'/'accepted' becomes 'uploaded'; reviewed_by,
--              reviewed_at are cleared.
--      UPDATE  status cannot be moved TO 'approved'/'accepted'; reviewed_by
--              and reviewed_at keep their old values; and an approved row
--              whose file, key or document set is changed goes back to
--              'uploaded' (a new file is a new thing to review).
--    Every other column, and every row of every other document set, is
--    written exactly as before. Nothing is rejected.
--
-- 3. TWO MORE SERVER-OWNED KEYS IN public.user_state.state (S2-01 ii)
--    'gp_au_signup_audience' and 'gp_au_branch_started_at' are written only
--    by the server. They are added to the keys the FR-1 state guard protects
--    (same function, same trigger, same behaviour; one constant changes).
--    Neither key unlocks anything; this stops them being forged or removed.
--
-- AFTER APPLYING (to any database), CHECK THE GUARDS REALLY RECOGNISE THE
-- SERVER. The trust test reads the request's role; if a project's API sent a
-- different claim, the SERVER's own writes would be silently discarded:
--   a. With the SERVICE-ROLE key, through the API, set a test profile's
--      candidate_pathway to 'au_vr' and read it back: it must read 'au_vr'.
--      Set it back to null and read it back: it must read null.
--   b. select convalidated from pg_catalog.pg_constraint
--        where conname = 'au_gp_doctor_details_user_id_fkey';      -- must be t
--   c. select tgname from pg_catalog.pg_trigger
--        where tgname in ('trg_au_gp_guard_user_profiles','trg_au_gp_guard_user_state',
--                         'trg_au_gp_guard_user_documents','trg_au_gp_onboarded_record')
--          and not tgisinternal;                                    -- four rows
--   d. select count(*) from public.runtime_kv where key like 'au_onboarded:%';
--      -- is AT LEAST: select count(*) from public.user_profiles where onboarding_completed_at is not null;
--      -- (FR-4, M4-04) It can be higher, and that is correct: the record is
--      -- kept on purpose when a profile's onboarding_completed_at is later set
--      -- back to NULL (that is exactly the forging the record exists to
--      -- catch). On the shared local database the two extra records are test
--      -- accounts whose column was nulled by hand during the reviews. The
--      -- records that should NOT exist are ones with no profile at all:
--      --   select count(*) from public.runtime_kv k where k.key like 'au_onboarded:%'
--      --     and not exists (select 1 from public.user_profiles p where 'au_onboarded:' || p.user_id::text = k.key);   -- 0

-- 0. Preconditions.
do $$
begin
  if pg_catalog.to_regprocedure('public.au_gp_caller_is_server()') is null then
    raise exception 'AU GP FR-2: public.au_gp_caller_is_server() is missing. Apply 20261123110000_au_gp_fr1_server_owned_columns_guard.sql first.';
  end if;
  if pg_catalog.to_regclass('public.runtime_kv') is null then
    raise exception 'AU GP FR-2: public.runtime_kv is missing.';
  end if;
end $$;

-- 1. The onboarding record.
create or replace function public.au_gp_record_onboarded()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- SECURITY DEFINER on purpose: the profile write may come from a signed-in
  -- user, who has no access to public.runtime_kv. The function writes one
  -- fixed-shape row keyed by the row's own user id and nothing else.
  begin
    if new.onboarding_completed_at is not null
       and (tg_op = 'INSERT' or old.onboarding_completed_at is null) then
      insert into public.runtime_kv (key, value)
      values ('au_onboarded:' || new.user_id::text,
              pg_catalog.jsonb_build_object('v', 1, 'at', new.onboarding_completed_at, 'by', 'trigger'))
      on conflict (key) do nothing;
    end if;
  exception when others then
    null;  -- never fails or changes the profile write
  end;
  return null;
end;
$function$;

comment on function public.au_gp_record_onboarded() is
  'AU GP build (FR-2, R2-02). AFTER INSERT OR UPDATE OF onboarding_completed_at on public.user_profiles: writes the server-only record runtime_kv au_onboarded:<user id> once, when the column first becomes non-null. Insert only; swallows every error.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass
      and t.tgname = 'trg_au_gp_onboarded_record' and not t.tgisinternal
  ) then
    create trigger trg_au_gp_onboarded_record
      after insert or update of onboarding_completed_at on public.user_profiles
      for each row execute function public.au_gp_record_onboarded();
  end if;
end $$;

insert into public.runtime_kv (key, value)
select 'au_onboarded:' || p.user_id::text,
       pg_catalog.jsonb_build_object('v', 1, 'at', p.onboarding_completed_at, 'by', 'migration')
from public.user_profiles p
where p.onboarding_completed_at is not null
on conflict (key) do nothing;

-- 2. Approval of an Australian document.
create or replace function public.au_gp_guard_user_documents()
returns trigger
language plpgsql
set search_path to ''
as $function$
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
      elsif new.document_key is distinct from old.document_key
         or new.file_url is distinct from old.file_url
         or new.file_name is distinct from old.file_name
         or new.country_code is distinct from old.country_code then
        -- an approved row whose file or label changes is a new thing to review
        new.status := 'uploaded';
        new.reviewed_by := null;
        new.reviewed_at := null;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

comment on function public.au_gp_guard_user_documents() is
  'AU GP build (FR-2, S2-01). BEFORE INSERT OR UPDATE on public.user_documents: for a caller that is not the server, a row of the Australian document set (country_code au_reg) cannot be given an approval. Rows of every other set are untouched.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_documents'::regclass
      and t.tgname = 'trg_au_gp_guard_user_documents' and not t.tgisinternal
  ) then
    create trigger trg_au_gp_guard_user_documents
      before insert or update on public.user_documents
      for each row execute function public.au_gp_guard_user_documents();
  end if;
end $$;

-- 3. Two more server-owned keys in user_state.state. The function is the
--    FR-1 one with a longer key list; nothing else in it changes.
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
  'AU GP build (FR-1 B-01, FR-2 S2-01). BEFORE INSERT OR UPDATE on public.user_state: for a caller that is not the server, the server-owned keys gp_au_placement_hold, gp_au_signup_audience and gp_au_branch_started_at keep their old value (or stay absent). Every other key is untouched.';

-- 4. Grants (as in FR-1: trigger functions are never called through the API).
revoke all on function public.au_gp_record_onboarded() from public, anon, authenticated;
revoke all on function public.au_gp_guard_user_documents() from public, anon, authenticated;
revoke all on function public.au_gp_guard_user_state() from public, anon, authenticated;
grant execute on function public.au_gp_record_onboarded() to service_role;
grant execute on function public.au_gp_guard_user_documents() to service_role;
grant execute on function public.au_gp_guard_user_state() to service_role;

-- Rollback (by hand; removes the protection, so only with the switch off):
--   drop trigger if exists trg_au_gp_onboarded_record on public.user_profiles;
--   drop trigger if exists trg_au_gp_guard_user_documents on public.user_documents;
--   drop function if exists public.au_gp_record_onboarded();
--   drop function if exists public.au_gp_guard_user_documents();
--   delete from public.runtime_kv where key like 'au_onboarded:%';
--   (the state guard: re-run section 3 of the FR-1 file to restore its one-key list)
