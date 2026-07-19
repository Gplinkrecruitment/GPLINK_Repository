-- AI bug-fix approval pipeline — proposal store.
--
-- Once a day the error-fix-analysis cron takes open, non-noise error groups
-- (grouped by client_errors.error_hash via buildClientErrorGroups), asks Claude
-- Opus 4.8 what is broken and how to fix it, and writes ONE row per error group
-- here. The owner then approves or rejects — from the daily email (one-click,
-- token-authed) or from the CEO dashboard's Technical tab.
--
-- Approval only sets status='approved'. A separate executor picks approved rows
-- up and fills in branch_name / pr_url / execution_*.
--
-- NOTE on client_errors: it has NO created_at column (first_seen_at /
-- last_seen_at only). This table defines its own created_at; do not assume the
-- same shape on client_errors.

CREATE TABLE IF NOT EXISTS public.error_fix_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link back to the error group. error_hash is the signature both the client
  -- and server error writers already dedupe on, so it is the stable join key.
  -- Deliberately NOT a foreign key: client_errors rows can be resolved or
  -- pruned without destroying the record of what was proposed and approved.
  error_hash TEXT NOT NULL,

  -- Snapshot of the error at analysis time, so the email and the dashboard can
  -- render a proposal even after the underlying rows change or are resolved.
  error_message TEXT,
  page_url TEXT,
  error_source TEXT,                       -- 'client' | 'server'
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  affected_users INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,

  -- The AI's answer.
  plain_explanation TEXT,                  -- non-technical: what is broken, who it affects
  technical_diagnosis TEXT,                -- for an engineer
  proposed_fix TEXT,                       -- the change to make
  suspect_files JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{file,startLine,endLine}] shown to the model
  ai_model TEXT,                           -- e.g. 'claude-opus-4-8'
  model_risk TEXT,                         -- what the MODEL claimed, before our guardrail

  -- Our own, server-side risk decision. The model's claim is only an input:
  -- classifyProposalRisk() can downgrade safe_auto -> needs_review, never up.
  risk_class TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (risk_class IN ('safe_auto', 'needs_review')),
  risk_reason TEXT,
  risk_downgraded BOOLEAN NOT NULL DEFAULT FALSE,

  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'in_progress', 'shipped', 'failed')),

  -- Decision audit.
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  decision_source TEXT,                    -- 'email' | 'dashboard'

  -- Filled in by the fix executor (a later agent). Nothing in this build writes
  -- them; they exist so the executor does not need its own migration.
  branch_name TEXT,
  pr_url TEXT,
  execution_started_at TIMESTAMPTZ,
  execution_finished_at TIMESTAMPTZ,
  execution_error TEXT,

  -- One-click email approval. Only the SHA-256 HASH of the token is stored, so
  -- read access to this table does not confer the ability to approve anything.
  -- Single-use: approval_token_used_at is stamped on first consumption.
  approval_token_hash TEXT,
  approval_token_expires_at TIMESTAMPTZ,
  approval_token_used_at TIMESTAMPTZ,

  emailed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: at most ONE in-flight proposal per error group. A re-run of the
-- cron therefore cannot create a duplicate for the same error_hash. Closed
-- outcomes (rejected / shipped / failed) are excluded, so if the same error
-- comes back later it can be proposed again.
CREATE UNIQUE INDEX IF NOT EXISTS error_fix_proposals_one_open_per_hash
  ON public.error_fix_proposals (error_hash)
  WHERE status IN ('proposed', 'approved', 'in_progress');

CREATE INDEX IF NOT EXISTS error_fix_proposals_status_created_idx
  ON public.error_fix_proposals (status, created_at DESC);

-- Token lookup for the email one-click flow.
CREATE INDEX IF NOT EXISTS error_fix_proposals_token_hash_idx
  ON public.error_fix_proposals (approval_token_hash)
  WHERE approval_token_hash IS NOT NULL;

-- Service-role only. Nothing here is ever read by a signed-in GP: the CEO
-- dashboard reads it through the server (requireCeoSession), and the email
-- one-click flow reads it through the server by token.
ALTER TABLE public.error_fix_proposals ENABLE ROW LEVEL SECURITY;
