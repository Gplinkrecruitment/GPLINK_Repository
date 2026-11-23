-- Australian GP build, fix bundle FR-1 (final review, defect B-01).
-- Only the server may write a doctor's pathway.
--
-- THE PROBLEM
--   The pathway columns this build added live on public.user_profiles, and the
--   live row policy "profiles_update_own" (with the table-level UPDATE grant to
--   "authenticated") lets a signed-in user update their OWN row directly
--   through the database API with their own token. So a doctor could set
--   candidate_pathway = 'au_vr' and pathway_confirmed_at themselves: a held
--   segment B or C doctor lifts their own hold and staff see "Confirmed by
--   staff". The same is true of one server-owned key the build keeps in
--   public.user_state.state ("state_update_own").
--
-- THE FIX (additive; nothing existing is dropped, replaced or narrowed)
--   Two BEFORE INSERT OR UPDATE row triggers. When the caller is NOT the
--   server, the trigger silently keeps the OLD value of every protected column
--   (on INSERT: forces it to NULL). Every other column in the same statement
--   is written exactly as before, so a client update of any other profile
--   field succeeds exactly as it does today, with the same status and the same
--   returned row. The existing policies and grants are not touched.
--
-- WHO COUNTS AS THE SERVER (trusted)
--   Trusted  = the database role in effect is not "anon" or "authenticated"
--              AND the request's JWT role claim is absent or "service_role".
--   So trusted: the app's service-role key through PostgREST (role
--   service_role, claim service_role); public.exec_sql() called with the
--   service-role key (SECURITY DEFINER, so the role is its owner; claim
--   service_role); a migration or the SQL editor (no claim at all); the
--   sign-up trigger public.handle_new_auth_user() (SECURITY DEFINER, fired by
--   the auth service's own connection, no claim).
--   Not trusted: any request made with the public key or a signed-in user's
--   token (role anon / authenticated), including one that reaches a SECURITY
--   DEFINER function (role is the owner, but the claim is still the user's).
--   A claim that cannot be read counts as not trusted.
--   The functions are SECURITY INVOKER on purpose: current_user must be the
--   caller's role, not the function owner's.
--
-- WHY IT CANNOT CHANGE WHAT THE LIVE APP OR AN OVERSEAS DOCTOR DOES TODAY
--   * The server (service role) returns from the trigger on its first line.
--   * Every protected column is new in this build (NULL on every existing
--     row), and no page or script writes to these tables directly: the browser
--     uses the database client for sign-in only.
--   * For a non-server caller the protected columns simply keep their value;
--     nothing is rejected, no other column is altered.
--
-- Protected on public.user_profiles: the 21 columns added by
--   20261120100000_au_gp_wp02_pathway_credentials.sql (6 pathway columns, 14
--   preference columns) and 20261120130000_au_gp_wp08_role_fields.sql
--   (preferred_locations). The server validates every one of them before
--   writing; a direct write would skip that validation.
-- Protected in public.user_state.state: the key "gp_au_placement_hold" (the
--   server's record that a placement's steps are held; the server acts on it).
--
-- Must run AFTER the two migrations named above (filename order does that).
-- Idempotent. Schema-qualified throughout (exec_sql has an empty search path).

-- 0. Refuse to install the guard if a column it names is missing: a trigger
--    that names a missing column would fail a non-server write at run time.
do $$
declare
  v_missing text;
begin
  select pg_catalog.string_agg(c.col, ', ') into v_missing
  from pg_catalog.unnest(array[
    'candidate_pathway','candidate_basis','pathway_set_by','pathway_set_at',
    'pathway_confirmed_at','pathway_confirmed_by',
    'current_suburb','current_state','current_postcode','current_latitude',
    'current_longitude','commute_radius_km','notice_period_weeks','available_from',
    'sessions_wanted','billing_preference','special_interests','open_to_locum',
    'open_to_relocate','timezone','preferred_locations'
  ]) as c(col)
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.user_profiles'::regclass
      and a.attname = c.col and a.attnum > 0 and not a.attisdropped
  );
  if v_missing is not null then
    raise exception 'au_gp_fr1: public.user_profiles is missing column(s): %. Apply the WP-02 and WP-08 migrations first.', v_missing;
  end if;
end $$;

-- 1. Is the caller the server?
create or replace function public.au_gp_caller_is_server()
returns boolean
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_user text := current_user;
  v_claim text;
begin
  if v_user in ('anon', 'authenticated') then
    return false;
  end if;
  begin
    v_claim := coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
      (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    );
  exception when others then
    return false;
  end;
  return v_claim is null or v_claim = 'service_role';
end;
$function$;

comment on function public.au_gp_caller_is_server() is
  'AU GP build (FR-1, B-01). True when the statement comes from the server: role in effect is not anon/authenticated and the JWT role claim is absent or service_role. SECURITY INVOKER on purpose.';

-- 2. user_profiles: a non-server write cannot change a server-owned column.
create or replace function public.au_gp_guard_user_profiles()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if public.au_gp_caller_is_server() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.candidate_pathway := null;
    new.candidate_basis := null;
    new.pathway_set_by := null;
    new.pathway_set_at := null;
    new.pathway_confirmed_at := null;
    new.pathway_confirmed_by := null;
    new.current_suburb := null;
    new.current_state := null;
    new.current_postcode := null;
    new.current_latitude := null;
    new.current_longitude := null;
    new.commute_radius_km := null;
    new.notice_period_weeks := null;
    new.available_from := null;
    new.sessions_wanted := null;
    new.billing_preference := null;
    new.special_interests := null;
    new.open_to_locum := null;
    new.open_to_relocate := null;
    new.timezone := null;
    new.preferred_locations := null;
  else
    new.candidate_pathway := old.candidate_pathway;
    new.candidate_basis := old.candidate_basis;
    new.pathway_set_by := old.pathway_set_by;
    new.pathway_set_at := old.pathway_set_at;
    new.pathway_confirmed_at := old.pathway_confirmed_at;
    new.pathway_confirmed_by := old.pathway_confirmed_by;
    new.current_suburb := old.current_suburb;
    new.current_state := old.current_state;
    new.current_postcode := old.current_postcode;
    new.current_latitude := old.current_latitude;
    new.current_longitude := old.current_longitude;
    new.commute_radius_km := old.commute_radius_km;
    new.notice_period_weeks := old.notice_period_weeks;
    new.available_from := old.available_from;
    new.sessions_wanted := old.sessions_wanted;
    new.billing_preference := old.billing_preference;
    new.special_interests := old.special_interests;
    new.open_to_locum := old.open_to_locum;
    new.open_to_relocate := old.open_to_relocate;
    new.timezone := old.timezone;
    new.preferred_locations := old.preferred_locations;
  end if;
  return new;
end;
$function$;

comment on function public.au_gp_guard_user_profiles() is
  'AU GP build (FR-1, B-01). BEFORE INSERT OR UPDATE on public.user_profiles: for a caller that is not the server, keeps the old value (INSERT: NULL) of the pathway and preference columns this build added. Every other column is untouched.';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_profiles'::regclass
      and t.tgname = 'trg_au_gp_guard_user_profiles' and not t.tgisinternal
  ) then
    create trigger trg_au_gp_guard_user_profiles
      before insert or update on public.user_profiles
      for each row execute function public.au_gp_guard_user_profiles();
  end if;
end $$;

-- 3. user_state: a non-server write cannot add, change or remove a
--    server-owned key inside the state document.
create or replace function public.au_gp_guard_user_state()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  -- FR-3 (S3-10): the SAME full list as the FR-2 and FR-3 files, so
  -- re-running this file on its own can no longer shrink the list to one key.
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
    -- Not a document with keys: nothing of ours can be in it. On UPDATE the
    -- server-owned keys of the old row would be lost, so keep the old document
    -- when it carried one.
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

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.user_state'::regclass
      and t.tgname = 'trg_au_gp_guard_user_state' and not t.tgisinternal
  ) then
    create trigger trg_au_gp_guard_user_state
      before insert or update on public.user_state
      for each row execute function public.au_gp_guard_user_state();
  end if;
end $$;

-- 4. Grants. The two trigger functions are never called through the API (a
--    trigger fires without the caller needing EXECUTE). The helper IS called
--    from inside the triggers with the caller's own role (SECURITY INVOKER),
--    so every role must be able to run it; it only answers "am I the server?".
revoke all on function public.au_gp_guard_user_profiles() from public, anon, authenticated;
revoke all on function public.au_gp_guard_user_state() from public, anon, authenticated;
grant execute on function public.au_gp_caller_is_server() to public, anon, authenticated, service_role;
grant execute on function public.au_gp_guard_user_profiles() to service_role;
grant execute on function public.au_gp_guard_user_state() to service_role;

-- Rollback (by hand; removes the protection, so only with the switch off):
--   drop trigger if exists trg_au_gp_guard_user_profiles on public.user_profiles;
--   drop trigger if exists trg_au_gp_guard_user_state on public.user_state;
--   drop function if exists public.au_gp_guard_user_profiles();
--   drop function if exists public.au_gp_guard_user_state();
--   drop function if exists public.au_gp_caller_is_server();
