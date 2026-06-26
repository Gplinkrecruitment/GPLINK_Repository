-- ATS: career_roles columns
-- Additive / non-breaking. Links job roles to an ATS practice and tracks job
-- lifecycle status / authorship for jobs posted through the in-app ATS.
-- All columns use ADD COLUMN IF NOT EXISTS with defaults, so existing rows are
-- backfilled with safe defaults and the migration is safe to re-run.

ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS practice_id UUID REFERENCES practices(id) ON DELETE SET NULL;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS job_status TEXT NOT NULL DEFAULT 'open'
  CHECK (job_status IN ('open','filled','closed'));
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS posted_by TEXT NOT NULL DEFAULT '';
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS ats_created BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_career_roles_practice ON career_roles(practice_id);
