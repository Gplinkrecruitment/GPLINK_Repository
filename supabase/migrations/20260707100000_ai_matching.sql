-- AI Matching: shortlist stage + match columns + match_cache
-- Foundation migration for the AI Matching program (Task 1 of the
-- 2026-07-06 implementation plan). Additive / non-breaking:
--   1) gp_applications gets new `match_*` / `decline_reason` /
--      `redirect_alternatives` columns (all guarded ADD COLUMN IF NOT EXISTS).
--   2) The `ats_stage` CHECK constraint is dropped + re-added to allow the new
--      'shortlisted' stage (a candidate can be matched to a job by the
--      team/AI before they ever submit an application).
--   3) A new `match_cache` table stores AI ranking results so repeat lookups
--      within a TTL window don't re-call the model.
--
-- *** IMPORTANT — constraint-drift precedent ***
-- A prior migration's CHECK constraint on a different table was found to have
-- drifted from what's actually live in prod (see task_type CHECK constraint
-- drift, SPPA alt-supervisor CV request). VERIFY THE LIVE constraint name and
-- value list in prod BEFORE applying this migration — do not assume the
-- migration history file is the source of truth. Read it with:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'gp_applications_ats_stage_check';
-- ...and confirm both the constraint name and the value list below still
-- match what's actually deployed.
--
-- Fully idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) gp_applications: new match_* columns
-- ---------------------------------------------------------------------------
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_reasons JSONB;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_score INT;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS matched_by TEXT;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_expires_at TIMESTAMPTZ;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_seen_at TIMESTAMPTZ;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_outcome TEXT;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS redirect_alternatives JSONB;

-- ---------------------------------------------------------------------------
-- 2) ats_stage CHECK constraint: add 'shortlisted' to the allowed set.
--    Guarded drop-then-recreate so this is safe to re-run and safe even if
--    the constraint was already dropped/renamed by a prior partial apply.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gp_applications_ats_stage_check'
  ) THEN
    ALTER TABLE gp_applications DROP CONSTRAINT gp_applications_ats_stage_check;
  END IF;
  ALTER TABLE gp_applications ADD CONSTRAINT gp_applications_ats_stage_check
    CHECK (ats_stage IN ('shortlisted','applied','submitted','reviewing','interview','offer','hired','not_proceeding'));
END $$;

-- ---------------------------------------------------------------------------
-- 2b) origin CHECK constraint: add 'ai_matched' to the allowed set.
--     The AI Matching shortlist endpoint inserts gp_applications rows with
--     origin='ai_matched' (a team/AI-initiated match, distinct from
--     'gp_applied' and 'admin_applied'). The live constraint from migration
--     20260705100000 only allows the original two values, so every shortlist
--     insert would violate it without this. Same guarded drop-then-recreate
--     style as the ats_stage block above.
--
--     *** Same constraint-drift warning as the file header: read the LIVE
--     constraint def in prod BEFORE applying —
--       SELECT pg_get_constraintdef(oid) FROM pg_constraint
--       WHERE conname = 'gp_applications_origin_check';
--     — and confirm the value list below is a superset of what's deployed.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gp_applications_origin_check'
  ) THEN
    ALTER TABLE gp_applications DROP CONSTRAINT gp_applications_origin_check;
  END IF;
  ALTER TABLE gp_applications ADD CONSTRAINT gp_applications_origin_check
    CHECK (origin IN ('gp_applied','admin_applied','ai_matched'));
END $$;

-- ---------------------------------------------------------------------------
-- 3) match_cache: AI ranking results, keyed by subject (a job or a GP), so
--    repeat lookups within a TTL window reuse the cached ranking instead of
--    re-calling the model. One row per (subject_type, subject_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_cache (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  TEXT        NOT NULL,
  subject_id    TEXT        NOT NULL,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_match_cache_subject ON match_cache(subject_type, subject_id);

-- ── RLS: service role full access (admin / ATS endpoints use the service key) ──
ALTER TABLE match_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'match_cache' AND policyname = 'match_cache_service_all'
  ) THEN
    CREATE POLICY match_cache_service_all ON match_cache
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
