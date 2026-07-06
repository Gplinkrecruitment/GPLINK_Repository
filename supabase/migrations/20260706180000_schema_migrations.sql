-- Migration ledger — Phase 6 C4 (audit 2026-07-07 platform).
--
-- Migrations are applied manually via exec_sql, so nothing records WHICH files
-- in supabase/migrations/ have actually been run against prod. Missing tables
-- are then 404-skipped at runtime (weekly backup, placements path), silently
-- masking drift. This table is the ledger: one row per applied migration file.
--
-- GET /api/admin/migration-status (super-admin) diffs the repo's migration
-- files against these rows and surfaces the unapplied set on the admin
-- Technical tab. Historical applies are unknowable, so a one-time guarded
-- "mark all current as applied" admin action establishes the baseline.

create table if not exists public.schema_migrations (
  filename    text primary key,
  applied_at  timestamptz not null default now(),
  checksum    text
);

-- Server-only lockdown (same pattern as public.email_suppression / admin_mfa):
-- RLS enabled with NO policies blocks anon/authenticated PostgREST roles; the
-- app reads/writes with the service-role key, which bypasses RLS.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public;
revoke all on public.schema_migrations from anon;
revoke all on public.schema_migrations from authenticated;
