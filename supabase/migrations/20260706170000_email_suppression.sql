-- Email suppression list — Phase 6 C3 (audit M2).
--
-- One row per recipient address that must no longer receive MARKETING /
-- non-critical email (hard bounces + spam complaints reported by Resend's
-- webhook, plus any future manual entries). Transactional mail (OTP, security,
-- account notices) deliberately IGNORES this table — only sendEmail calls with
-- category:'marketing' consult it.
--
-- email is stored lowercased by the app (plain text PK — citext would need the
-- extension; normalisation happens in server.js before every read/write).
-- reason: 'hard_bounce' | 'complaint' | free text. source: 'resend_webhook' etc.

create table if not exists public.email_suppression (
  email       text primary key,
  reason      text,
  source      text,
  created_at  timestamptz not null default now()
);

-- Server-only lockdown (same pattern as public.admin_mfa / admin_audit_log):
-- RLS enabled with NO policies blocks anon/authenticated PostgREST roles; the
-- app reads/writes with the service-role key, which bypasses RLS.
alter table public.email_suppression enable row level security;
revoke all on public.email_suppression from public;
revoke all on public.email_suppression from anon;
revoke all on public.email_suppression from authenticated;
