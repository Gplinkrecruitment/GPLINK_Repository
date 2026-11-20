-- GP Link local test stack: the parts of a Supabase project that sit AROUND the
-- public schema. Loaded into the LOCAL database before the production-shaped
-- snapshot. Safe to re-run.

-- @@section roles
-- The API roles PostgREST switches between, with the same attributes as live.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;
alter role anon inherit;
alter role authenticated inherit;
alter role service_role inherit bypassrls;
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
alter role authenticator set lock_timeout = '8s';
grant anon, authenticated, service_role to authenticator;

-- @@section schemas
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists aulocal;
grant usage on schema public, extensions to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- @@section auth_helpers
-- The helpers row-level-security policies call (same behaviour as Supabase's).
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create or replace function auth.email() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;

-- @@section storage_tables
-- Minimal stand-ins for Supabase Storage's own tables. The local storage
-- emulator records each stored file here; the file bytes live on disk.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

-- @@section auth_emulator_tables
-- State the local auth emulator needs beyond auth.users.
create table if not exists aulocal.refresh_tokens (
  token text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  revoked boolean not null default false
);
create table if not exists aulocal.one_time_tokens (
  token_hash text primary key,
  user_id uuid not null,
  kind text not null,
  redirect_to text,
  new_email text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create table if not exists aulocal.applied_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
create table if not exists aulocal.stack_info (
  key text primary key,
  value text not null
);
insert into aulocal.stack_info (key, value) values ('marker', 'gplink-au-local-test-database')
on conflict (key) do nothing;
