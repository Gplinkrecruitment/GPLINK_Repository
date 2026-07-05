begin;

alter table public.practices
  add column if not exists org_type text not null default 'practice';
do $$ begin
  alter table public.practices
    add constraint practices_org_type_check check (org_type in ('practice','corporation'));
exception when duplicate_object then null; end $$;

alter table public.career_roles
  add column if not exists address text not null default '',
  add column if not exists details jsonb not null default '{}'::jsonb;

commit;
