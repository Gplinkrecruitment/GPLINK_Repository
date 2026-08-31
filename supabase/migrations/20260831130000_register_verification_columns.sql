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
