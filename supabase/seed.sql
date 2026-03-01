-- Seed existing GP Link profile into Supabase tables.
-- NOTE: This only inserts if the auth user already exists in auth.users.
-- Create/sign-in user once in your app first, then run this seed.

insert into public.user_profiles (
  user_id,
  email,
  first_name,
  last_name,
  country_dial,
  phone_number,
  registration_country,
  phone,
  registration_number,
  gmc_number,
  profile_photo_name,
  profile_photo_data_url,
  id_copy_name,
  id_copy_data_url,
  cv_file_name,
  updated_at
)
select
  au.id,
  'khaleedmahmoud1211@gmail.com',
  'Khaleed',
  'Mahmoud',
  '+61',
  '406281243',
  'UK',
  '+61 406281243',
  '12345',
  '',
  '',
  '',
  '',
  '',
  '',
  '2026-02-24T13:17:44.502Z'::timestamptz
from auth.users au
where lower(au.email) = 'khaleedmahmoud1211@gmail.com'
on conflict (user_id) do update
set
  email = excluded.email,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  country_dial = excluded.country_dial,
  phone_number = excluded.phone_number,
  registration_country = excluded.registration_country,
  phone = excluded.phone,
  registration_number = excluded.registration_number,
  gmc_number = excluded.gmc_number,
  profile_photo_name = excluded.profile_photo_name,
  profile_photo_data_url = excluded.profile_photo_data_url,
  id_copy_name = excluded.id_copy_name,
  id_copy_data_url = excluded.id_copy_data_url,
  cv_file_name = excluded.cv_file_name,
  updated_at = excluded.updated_at;

insert into public.user_state (user_id, state, updated_at)
select
  au.id,
  '{}'::jsonb,
  now()
from auth.users au
where lower(au.email) = 'khaleedmahmoud1211@gmail.com'
on conflict (user_id) do update
set state = coalesce(public.user_state.state, '{}'::jsonb),
    updated_at = now();
