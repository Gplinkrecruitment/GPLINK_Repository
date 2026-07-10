-- 20260711220000_match_nudges.sql
-- Two nudge stamps for the match-expiry automation (spec 2026-07-11 Part B).
-- NOTE prod drift: verify live gp_applications columns before applying; these
-- ADD COLUMN IF NOT EXISTS statements are idempotent.
ALTER TABLE public.gp_applications
  ADD COLUMN IF NOT EXISTS match_final_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS match_more_time_requested_at TIMESTAMPTZ;
NOTIFY pgrst, 'reload schema';
