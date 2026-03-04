begin;

create table if not exists public.runtime_kv (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_runtime_kv_expires_at on public.runtime_kv(expires_at);

drop trigger if exists trg_runtime_kv_updated_at on public.runtime_kv;
create trigger trg_runtime_kv_updated_at
before update on public.runtime_kv
for each row
execute function public.set_updated_at();

alter table public.runtime_kv disable row level security;
revoke all on table public.runtime_kv from anon, authenticated;

commit;
