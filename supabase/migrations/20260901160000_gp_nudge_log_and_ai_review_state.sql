-- Drop-off nudge ledger + AI document-review state (owner rules, 2026-09-01).
-- NOT applied automatically — this was applied to prod via rpc/exec_sql with the
-- service key on 2026-09-01 (schema-qualify names when re-applying).

-- One row per (GP, drop-off point, channel) — the dedup ledger that guarantees
-- a doctor is nudged about any given drop-off point at most once per channel,
-- across manual sends and both nudge crons.
create table if not exists public.gp_nudge_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  nudge_key text not null,
  channel text not null,
  sent_at timestamptz not null default now()
);
create unique index if not exists gp_nudge_log_unique on public.gp_nudge_log (user_id, nudge_key, channel);

-- Service-role only (Supabase default privileges would otherwise hand anon
-- full access — see the 2026-08 security-scanner sweep).
alter table public.gp_nudge_log enable row level security;
revoke all on table public.gp_nudge_log from public;
revoke all on table public.gp_nudge_log from anon;
revoke all on table public.gp_nudge_log from authenticated;

-- Outcome marker for the automatic AI document review sweep
-- (/api/cron/doc-ai-review): auto_approved | auto_rejected | manual_required |
-- error_download | no_file | skipped_staff. NULL = not yet attempted; the cron
-- makes exactly one automatic attempt per document.
alter table public.user_documents add column if not exists ai_review_state text;
