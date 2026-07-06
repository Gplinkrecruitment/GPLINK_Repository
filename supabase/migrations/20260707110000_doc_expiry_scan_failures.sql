-- Phase 6 F3 — document reliability
-- 1. Expiry tracking on user_documents (validity-windowed docs: police checks,
--    certificates of good standing, ...) + a dedup flag for the renewal nudge.
-- 2. Server-authoritative AI-scan failure counting (replaces the localStorage
--    CERT_SUPPORT_THRESHOLD counter) + the persisted last failure reason so a
--    GP who dismissed the scan popup can still see why the scan failed.

alter table public.user_documents add column if not exists expires_at timestamptz;
alter table public.user_documents add column if not exists expiry_nudged_at timestamptz;

create index if not exists idx_user_documents_expires_at
  on public.user_documents (expires_at)
  where expires_at is not null;

create table if not exists public.user_doc_scan_failures (
  id bigserial primary key,
  user_id uuid not null,
  document_key text not null,
  country_code text not null default '',
  fail_count integer not null default 0,
  last_reason text not null default '',
  last_failed_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, document_key)
);

-- Server-only table (service role bypasses RLS); no client policies on purpose.
alter table public.user_doc_scan_failures enable row level security;

create index if not exists idx_user_doc_scan_failures_user
  on public.user_doc_scan_failures (user_id);
