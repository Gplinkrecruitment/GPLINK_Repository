-- Admin two-factor authentication (TOTP) enrolment — Phase 6 C1 (audit S1).
--
-- One row per enrolled admin email. Enrolment is OPT-IN: an email with no row
-- (or disabled = true) logs in with password only — this is the lockout-safe
-- design; the server NEVER blocks an un-enrolled admin.
--
-- totp_secret is stored at rest in plaintext: acceptable because this table is
-- service-role-only (RLS on, zero policies, all PostgREST grants revoked) and
-- it is deliberately EXCLUDED from the weekly Drive backup (BACKUP_TABLES in
-- server.js must NOT list admin_mfa — 2FA secrets stay out of backup exports).
--
-- backup_codes: jsonb array of HMAC-SHA256 hashes of one-time recovery codes.
-- A code is removed from the array when used (single-use). A lost-device admin
-- uses one to complete login or to disable 2FA entirely.

create table if not exists public.admin_mfa (
  admin_email   text primary key,
  totp_secret   text not null,
  enrolled_at   timestamptz not null default now(),
  backup_codes  jsonb not null default '[]'::jsonb,
  last_used_at  timestamptz,
  disabled      boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- Server-only lockdown (same pattern as admin_audit_log): RLS enabled with NO
-- policies blocks the anon/authenticated PostgREST roles entirely; the app
-- reads/writes with the service-role key, which bypasses RLS. Belt-and-braces:
-- revoke every table privilege from the client-facing roles too.
alter table public.admin_mfa enable row level security;
revoke all on public.admin_mfa from public;
revoke all on public.admin_mfa from anon;
revoke all on public.admin_mfa from authenticated;
