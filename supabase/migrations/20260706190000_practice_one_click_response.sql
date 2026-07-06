-- Phase 6 D1b — practice one-click response (accept / decline / request interview).
--
-- Widens gp_applications.practice_submission_status with the two new
-- practice-recorded decision values:
--   * client_accepted            (practice clicked "Accept this candidate";
--                                 a HUMAN still does the formal reveal + offer,
--                                 which moves it on to 'client_approved')
--   * client_interview_requested (practice clicked "Request an interview")
-- and adds two audit columns recording when/what the practice clicked.
--
-- The LIVE constraint was read via pg_get_constraintdef on 2026-07-06 and
-- matched the original six-value list from migration 20260422010000 exactly
-- (no drift), so the DROP + ADD below is the verified full superset.

ALTER TABLE public.gp_applications
  ADD COLUMN IF NOT EXISTS practice_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS practice_response_action TEXT;

ALTER TABLE public.gp_applications
  DROP CONSTRAINT IF EXISTS gp_applications_practice_submission_status_check;

ALTER TABLE public.gp_applications
  ADD CONSTRAINT gp_applications_practice_submission_status_check
  CHECK (practice_submission_status IN (
    'pending_va_submission',
    'submitted_to_practice',
    'client_reviewed',
    'client_approved',
    'client_accepted',
    'client_rejected',
    'client_interview_requested',
    'interview_ready'
  ));
