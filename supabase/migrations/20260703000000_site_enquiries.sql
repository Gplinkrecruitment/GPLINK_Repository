-- Marketing-site lead-capture table: practice/GP/general enquiries submitted
-- via POST /api/public/enquiry (public, no-session endpoint). Consumed by the
-- admin "Website" tab (task 13). DDL verbatim from
-- docs/superpowers/specs/2026-07-03-marketing-website-design.md ("New table (DDL)").
create table if not exists public.site_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('practice','gp','general')),
  name text not null,
  email text not null,
  phone text,
  practice_name text,
  state text,
  message text,
  status text not null default 'new' check (status in ('new','contacted','closed')),
  metadata jsonb not null default '{}'::jsonb
);

-- ── RLS: service role only (matches convention in 20260624000000_security_advisor_fixes.sql
-- and 20260627100000_ats_practices.sql). The app writes/reads this table exclusively
-- through the service-role key (POST /api/public/enquiry + the admin Website tab both
-- go through supabaseDbRequest), which bypasses RLS — enabling it just closes the gap
-- where the public anon/publishable key could otherwise read every enquiry's PII
-- (name/email/phone) directly via PostgREST.
alter table public.site_enquiries enable row level security;

drop policy if exists site_enquiries_service_all on public.site_enquiries;
create policy site_enquiries_service_all on public.site_enquiries
  for all using (auth.role() = 'service_role');

create index if not exists idx_site_enquiries_created_at on public.site_enquiries (created_at desc);
create index if not exists idx_site_enquiries_status on public.site_enquiries (status);
