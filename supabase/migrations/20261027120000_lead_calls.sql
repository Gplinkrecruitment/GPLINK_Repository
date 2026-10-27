-- Outbound AI phone calls to GP leads ("Hazel" on Retell AI): one row per call.
-- Written by POST /api/webhooks/retell (call_started / call_ended /
-- call_analyzed, keyed on Retell's call_id) and read by the admin leads view.
-- The lead's own site_enquiries.metadata.consult.ai_call holds the COMPACT
-- summary (status, outcome, attempt, timestamps, one-line summary) that the
-- cron uses to decide whether to ring again; consult.ai_calls is the per-attempt
-- history. This table holds the FULL record — transcript, recording URL,
-- post-call analysis, cost — so the lead row stays small. Feature overview:
-- docs/lead-calls/README.md.
create table if not exists public.lead_calls (
  id uuid primary key default gen_random_uuid(),
  call_id text not null unique,
  enquiry_id uuid null references public.site_enquiries(id) on delete set null,
  direction text,
  from_number text,
  to_number text,
  agent_id text,
  status text,
  outcome text,
  disconnection_reason text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_s integer,
  summary text,
  sentiment text,
  transcript text,
  recording_url text,
  analysis jsonb,
  cost_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── RLS: service role only (same convention as 20260703000000_site_enquiries.sql).
-- The app reads/writes this table exclusively through the service-role key
-- (supabaseDbRequest), which bypasses RLS — enabling it just stops the public
-- anon/publishable key from reading transcripts and phone numbers via PostgREST.
alter table public.lead_calls enable row level security;

drop policy if exists lead_calls_service_all on public.lead_calls;
create policy lead_calls_service_all on public.lead_calls
  for all using (auth.role() = 'service_role');

create index if not exists idx_lead_calls_enquiry_id on public.lead_calls (enquiry_id);
create index if not exists idx_lead_calls_started_at on public.lead_calls (started_at desc);

-- updated_at bump on every write (public.set_updated_at() is defined in
-- 20260225014500_init_gp_link.sql).
drop trigger if exists trg_lead_calls_updated_at on public.lead_calls;
create trigger trg_lead_calls_updated_at
before update on public.lead_calls
for each row
execute function public.set_updated_at();
