-- Outbound email template library — Phase 6 I1 (audit M2).
--
-- Curated default templates live IN CODE (lib/email-templates.js) so the library
-- works even when this table is empty or the migration has not been applied yet.
-- This table holds CEO-managed additions and overrides:
--   * a row with template_key matching a default's key overrides that default
--     (active=false hides the default entirely);
--   * rows with a NULL/novel template_key are extra custom templates.
-- Managed via /api/admin/email-templates (read: any admin; write: super admin).

create table if not exists public.email_templates (
  id            uuid primary key default gen_random_uuid(),
  template_key  text unique,          -- null for pure custom templates
  name          text not null,
  category      text,                 -- triage category / free label
  stage         text,                 -- registration stage the template relates to
  subject       text not null default '',
  body          text not null default '',
  active        boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Server-only lockdown (same pattern as public.email_suppression): RLS enabled
-- with NO policies blocks anon/authenticated PostgREST roles; the app reads and
-- writes with the service-role key, which bypasses RLS.
alter table public.email_templates enable row level security;
revoke all on public.email_templates from public;
revoke all on public.email_templates from anon;
revoke all on public.email_templates from authenticated;
