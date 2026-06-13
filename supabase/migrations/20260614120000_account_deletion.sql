-- Account deletion / reinstatement: soft-delete (archive) columns on user_profiles.
-- active -> archived (hidden everywhere, 90-day grace, reversible) -> purged (cron).

begin;

alter table public.user_profiles
  add column if not exists account_status text not null default 'active';

alter table public.user_profiles
  add column if not exists archived_at timestamptz;

alter table public.user_profiles
  add column if not exists purge_after timestamptz;

alter table public.user_profiles
  add column if not exists archived_reason text;

-- Index for the admin archived-accounts list and the purge cron.
create index if not exists idx_user_profiles_account_status
  on public.user_profiles (account_status);

create index if not exists idx_user_profiles_purge_after
  on public.user_profiles (purge_after)
  where account_status = 'archived';

commit;
