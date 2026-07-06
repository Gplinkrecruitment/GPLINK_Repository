-- AI Matching (Task 7): withdraw-reason on stage events
-- Additive / non-breaking. Adds a nullable `reason` column to
-- ats_stage_events so staff moving an application to `not_proceeding` from
-- `submitted` or later can optionally record why (e.g. 'gp_withdrew' for
-- "GP withdrew after submission") — this is the strike-source data Task 8's
-- career-lock work reads (a late withdrawal counts as a strike, spec §9).
--
-- Fully idempotent — safe to re-run.

ALTER TABLE ats_stage_events ADD COLUMN IF NOT EXISTS reason TEXT;
