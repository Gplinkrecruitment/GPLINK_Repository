-- Migration: 20260707140000_scheduled_calls_disposition.sql
-- Phase 6 G2b: structured call-outcome logging.
-- Adds a disposition (fixed list) + outcome note to scheduled_calls so completing
-- a call records WHAT happened, not just a status enum + free-text admin_notes.

ALTER TABLE public.scheduled_calls
  ADD COLUMN IF NOT EXISTS call_disposition TEXT;

ALTER TABLE public.scheduled_calls
  ADD COLUMN IF NOT EXISTS outcome_note TEXT;

ALTER TABLE public.scheduled_calls
  DROP CONSTRAINT IF EXISTS scheduled_calls_call_disposition_check;

ALTER TABLE public.scheduled_calls
  ADD CONSTRAINT scheduled_calls_call_disposition_check
    CHECK (call_disposition IS NULL OR call_disposition IN (
      'resolved', 'needs_followup', 'escalate', 'no_answer', 'rescheduled'
    ));

COMMENT ON COLUMN public.scheduled_calls.call_disposition IS 'Structured outcome logged when an RSO completes the call: resolved | needs_followup | escalate | no_answer | rescheduled';
COMMENT ON COLUMN public.scheduled_calls.outcome_note IS 'Required free-text outcome note captured alongside call_disposition';
