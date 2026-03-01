begin;

-- Core profile table keyed to Supabase Auth users.
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  first_name text not null default '',
  last_name text not null default '',
  country_dial text not null default '',
  phone_number text not null default '',
  registration_country text not null default '',
  phone text not null default '',
  registration_number text not null default '',
  gmc_number text not null default '',
  profile_photo_name text not null default '',
  profile_photo_data_url text not null default '',
  id_copy_name text not null default '',
  id_copy_data_url text not null default '',
  cv_file_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- App state blob table (keeps your existing localStorage/state-sync model compatible).
create table if not exists public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_user_state_updated_at on public.user_state;
create trigger trg_user_state_updated_at
before update on public.user_state
for each row
execute function public.set_updated_at();

-- Auto-create app rows when a new auth user signs up.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  md jsonb;
  v_email text;
  v_first text;
  v_last text;
  v_dial text;
  v_phone text;
  v_country text;
begin
  md := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_email := lower(coalesce(new.email, ''));
  v_first := coalesce(md->>'firstName', '');
  v_last := coalesce(md->>'lastName', '');
  v_dial := coalesce(md->>'countryDial', '');
  v_phone := coalesce(md->>'phoneNumber', '');
  v_country := coalesce(md->>'registrationCountry', '');

  insert into public.user_profiles (
    user_id, email, first_name, last_name, country_dial, phone_number, registration_country, phone
  )
  values (
    new.id,
    v_email,
    v_first,
    v_last,
    v_dial,
    v_phone,
    v_country,
    trim(both from concat_ws(' ', v_dial, v_phone))
  )
  on conflict (user_id) do update
  set
    email = excluded.email,
    first_name = coalesce(nullif(excluded.first_name, ''), public.user_profiles.first_name),
    last_name = coalesce(nullif(excluded.last_name, ''), public.user_profiles.last_name),
    country_dial = coalesce(nullif(excluded.country_dial, ''), public.user_profiles.country_dial),
    phone_number = coalesce(nullif(excluded.phone_number, ''), public.user_profiles.phone_number),
    registration_country = coalesce(nullif(excluded.registration_country, ''), public.user_profiles.registration_country),
    phone = coalesce(nullif(excluded.phone, ''), public.user_profiles.phone);

  insert into public.user_state (user_id, state)
  values (new.id, '{}'::jsonb)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_gp_link on auth.users;
create trigger on_auth_user_created_gp_link
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

-- RLS: users can only access their own data.
alter table public.user_profiles enable row level security;
alter table public.user_state enable row level security;

drop policy if exists "profiles_select_own" on public.user_profiles;
create policy "profiles_select_own"
on public.user_profiles
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.user_profiles;
create policy "profiles_insert_own"
on public.user_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.user_profiles;
create policy "profiles_update_own"
on public.user_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "state_select_own" on public.user_state;
create policy "state_select_own"
on public.user_state
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "state_insert_own" on public.user_state;
create policy "state_insert_own"
on public.user_state
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "state_update_own" on public.user_state;
create policy "state_update_own"
on public.user_state
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

commit;
