-- Daily mirror of the NHS England Performers List (owner decision 2026-09-01:
-- keep the list and replace it daily, so a registration check is a local
-- indexed lookup instead of a fresh 17MB download). Medical rows only; the
-- live NHS download remains the fallback when this mirror is stale.
create table if not exists public.nhs_performers_mirror (
  id bigint generated always as identity primary key,
  number text not null,
  alignment text,
  role text,
  fore_names text,
  surname text,
  status text,
  registered_date text,
  first_on_list_date text,
  gp_register_date text,
  region text,
  probationary text,
  sync_batch text not null,
  synced_at timestamptz not null default now()
);
create index if not exists idx_nhs_performers_mirror_number on public.nhs_performers_mirror (number);
create index if not exists idx_nhs_performers_mirror_batch on public.nhs_performers_mirror (sync_batch);
-- Service-role only (Supabase default privileges would otherwise hand anon
-- full access — see the 2026-08 security-scanner sweep).
alter table public.nhs_performers_mirror enable row level security;
revoke all on table public.nhs_performers_mirror from public;
revoke all on table public.nhs_performers_mirror from anon;
revoke all on table public.nhs_performers_mirror from authenticated;
