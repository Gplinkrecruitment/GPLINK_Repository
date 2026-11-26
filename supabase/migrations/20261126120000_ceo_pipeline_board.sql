-- CEO Overview "Pipeline & money" board (owner picked mockup A, 26 Nov 2026).
--
-- pipeline_people   every live candidate / deal the app can't infer on its own:
--                   doctors who only talk to the owner on his personal WhatsApp,
--                   deals signed by email outside the app, and manual adds.
--                   Doctors who ARE in the app are read live from the app tables
--                   (gp_applications, placements, registration_cases …); a row here
--                   may link to them via user_id to carry the owner's notes/next step.
-- pipeline_events   history of Done / notes / stage moves on a person.
-- xero_connection   one row: the read-only Xero OAuth connection (tokens rotate).
-- xero_invoices     sales invoices mirrored from Xero every hour (ACCREC only).
-- email_contract_finds  signed contracts the hourly email scan found; each one
--                   proposes a pipeline_people row the owner confirms with one click.
-- pipeline_sync_state   freshness per source (xero / whatsapp_export / email_scan /
--                   doubletick) so the board can say "Xero checked 12 min ago".
--
-- All service-role only (the app talks to them through the service key).

create table if not exists public.pipeline_people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  user_id uuid null,
  enquiry_id uuid null,
  stage text not null default 'warm'
    check (stage in ('warm','consult','matched','signed','visa','started','later','closed')),
  practice_name text,
  status_note text,
  next_step text,
  next_step_due date,
  waiting_on_owner boolean not null default false,
  wait_note text,
  heat_override smallint null check (heat_override between 0 and 3),
  later_until date,
  later_reason text,
  start_date_text text,
  source text not null default 'manual'
    check (source in ('whatsapp_personal','whatsapp_business','email_contract','manual','app')),
  source_ref text,
  last_message_at timestamptz,
  last_message_from text check (last_message_from in ('them','me')),
  last_message_snippet text,
  needs_confirm boolean not null default false,
  confirmed_at timestamptz,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_pipeline_people_source_ref
  on public.pipeline_people (source, source_ref) where source_ref is not null;
create index if not exists idx_pipeline_people_user_id on public.pipeline_people (user_id);
create index if not exists idx_pipeline_people_stage on public.pipeline_people (stage) where archived_at is null;

create table if not exists public.pipeline_events (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.pipeline_people(id) on delete cascade,
  kind text not null check (kind in ('done','note','stage','import','confirm','dismiss')),
  text text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pipeline_events_person on public.pipeline_events (person_id, created_at desc);

create table if not exists public.xero_connection (
  id text primary key default 'default',
  tenant_id text,
  tenant_name text,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scopes text,
  connected_at timestamptz,
  connected_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.xero_invoices (
  invoice_id text primary key,
  invoice_number text,
  type text,
  status text,
  contact_id text,
  contact_name text,
  reference text,
  line_text text,
  invoice_date date,
  due_date date,
  total numeric,
  amount_due numeric,
  amount_paid numeric,
  amount_credited numeric,
  currency text,
  fully_paid_on date,
  doctor_name text,
  pipeline_person_id uuid null references public.pipeline_people(id) on delete set null,
  user_id uuid null,
  xero_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  raw jsonb
);
create index if not exists idx_xero_invoices_status on public.xero_invoices (status);

create table if not exists public.email_contract_finds (
  gmail_message_id text primary key,
  thread_id text,
  mailbox text,
  subject text,
  from_email text,
  message_date timestamptz,
  doctor_name text,
  practice_name text,
  signed_date date,
  confidence numeric,
  ai_summary text,
  status text not null default 'proposed' check (status in ('proposed','confirmed','dismissed','ignored')),
  pipeline_person_id uuid null references public.pipeline_people(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pipeline_sync_state (
  source text primary key,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['pipeline_people','pipeline_events','xero_connection','xero_invoices','email_contract_finds','pipeline_sync_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_service_all', t);
    execute format('create policy %I on public.%I for all using (auth.role() = ''service_role'')', t || '_service_all', t);
  end loop;
end $$;

drop trigger if exists trg_pipeline_people_updated_at on public.pipeline_people;
create trigger trg_pipeline_people_updated_at before update on public.pipeline_people
for each row execute function public.set_updated_at();
drop trigger if exists trg_xero_connection_updated_at on public.xero_connection;
create trigger trg_xero_connection_updated_at before update on public.xero_connection
for each row execute function public.set_updated_at();
drop trigger if exists trg_email_contract_finds_updated_at on public.email_contract_finds;
create trigger trg_email_contract_finds_updated_at before update on public.email_contract_finds
for each row execute function public.set_updated_at();
drop trigger if exists trg_pipeline_sync_state_updated_at on public.pipeline_sync_state;
create trigger trg_pipeline_sync_state_updated_at before update on public.pipeline_sync_state
for each row execute function public.set_updated_at();
