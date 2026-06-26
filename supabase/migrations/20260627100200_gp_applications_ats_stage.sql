-- ATS: gp_applications pipeline stage
-- Additive / non-breaking. Adds an ATS hiring-pipeline stage + free-text notes to
-- GP job applications so candidates can move through the in-app hiring funnel.
-- All columns use ADD COLUMN IF NOT EXISTS with safe defaults; existing
-- applications default to the 'applied' stage. Safe to re-run.

ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS ats_stage TEXT NOT NULL DEFAULT 'applied'
  CHECK (ats_stage IN ('applied','submitted','reviewing','interview','offer','hired','not_proceeding'));
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS ats_stage_updated_at TIMESTAMPTZ;
ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS ats_notes TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_gp_applications_ats_stage ON gp_applications(ats_stage);
