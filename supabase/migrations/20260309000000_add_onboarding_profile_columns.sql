begin;

-- Add onboarding-related columns to user_profiles.
-- These are written by the /api/onboarding/complete endpoint.
alter table public.user_profiles
  add column if not exists qualification_country text not null default '',
  add column if not exists preferred_city text not null default '',
  add column if not exists target_arrival_date text not null default '',
  add column if not exists who_moving text not null default '',
  add column if not exists children_count text not null default '',
  add column if not exists onboarding_completed_at timestamptz;

commit;
