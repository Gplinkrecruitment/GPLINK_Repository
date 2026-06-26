-- ATS: registration_cases candidate-intent scoring
-- Additive / non-breaking. Adds candidate-intent scoring + comms engagement
-- snapshots used by the Candidates tab intent calculator. All columns are
-- nullable (or JSONB) with no backfill required and use ADD COLUMN IF NOT EXISTS,
-- so the migration is safe to re-run and touches no existing data.

ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS intent_score INTEGER;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS intent_band TEXT
  CHECK (intent_band IN ('hot','warm','cold'));
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS intent_signals JSONB;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS intent_computed_at TIMESTAMPTZ;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS comms_engagement JSONB;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS comms_engagement_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_registration_cases_intent ON registration_cases(intent_score DESC NULLS LAST);
