-- GP self-withdrawal: record WHEN the doctor walked away
-- Additive / non-breaking. Adds a nullable `withdrawn_at` timestamp to
-- gp_applications.
--
-- Why: POST /api/career/application/withdraw only ever set
-- status='withdrawn' + updated_at. updated_at moves for ANY write (a stage
-- reconciliation, an interview cancellation, a nightly sweep), so it could
-- never answer "when did this doctor actually withdraw?". The CEO drawer
-- needs that date to explain a withdrawn card, and the intent score's
-- withdrawal penalty needs an auditable trail behind the count.
--
-- Deliberately additive only: no CHECK constraint is touched and nothing is
-- dropped. gp_applications.status is free-text with a 'withdrawn' value
-- already in live use, so no constraint change is required.
--
-- Fully idempotent — safe to re-run.

ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;

COMMENT ON COLUMN public.gp_applications.withdrawn_at IS
  'Set when the GP withdraws this application themselves (POST /api/career/application/withdraw). NULL for every other terminal outcome.';

-- Unrelated pre-existing breakage found by the same schema sweep that caught
-- gp_applications.created_at: the interview-reminder cron selects
-- career_interviews.reminder_sent, which has never existed. PostgREST 400s the
-- whole query, so that reminder has never fired once. career_interviews is the
-- LEGACY interview table (live interviews are rows in scheduled_calls) and is
-- currently empty, so this is dormant rather than urgent — but one additive
-- column costs nothing and stops a permanently-400ing query.
ALTER TABLE public.career_interviews ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.career_interviews.reminder_sent IS
  'Dedupe flag for the day-before interview reminder cron. Legacy table — live interviews are scheduled_calls rows with meeting_kind=interview.';

NOTIFY pgrst, 'reload schema';
