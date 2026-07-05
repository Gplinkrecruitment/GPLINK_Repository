begin;

create table if not exists public.zoho_archive (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  zoho_id text not null,
  payload jsonb not null,
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (entity_type, zoho_id)
);
create index if not exists zoho_archive_entity_idx on public.zoho_archive (entity_type);
alter table public.zoho_archive disable row level security;
revoke all on public.zoho_archive from anon, authenticated;

create table if not exists public.candidate_leads (
  id uuid primary key default gen_random_uuid(),
  zoho_candidate_id text unique,
  name text,
  email text not null,
  phone text,
  source text not null default 'zoho_recruit',
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists candidate_leads_email_idx on public.candidate_leads (lower(email));
alter table public.candidate_leads disable row level security;
revoke all on public.candidate_leads from anon, authenticated;

commit;
