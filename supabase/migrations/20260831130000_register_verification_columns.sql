-- Register-verification onboarding (owner decision 2026-08-31): a doctor's
-- public medical-register details replace the qualification-document uploads
-- at onboarding. Staff verify against the live public register; documents
-- are collected later at the start of MyIntealth.
alter table public.user_profiles
  add column if not exists register_body text,
  add column if not exists register_number text,
  add column if not exists register_name text,
  add column if not exists register_status text,
  add column if not exists register_verified_at timestamptz,
  add column if not exists register_verified_by text;

-- 2026-09-01: automated verification retry marker (hourly cron stamps every
-- attempt so a doctor the sources cannot settle is retried weekly, not hourly).
alter table public.user_profiles
  add column if not exists register_auto_checked_at timestamptz;
