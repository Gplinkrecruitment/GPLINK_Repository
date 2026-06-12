-- Track how many times a scheduled call has been missed (no-show) or cancelled
-- by the GP. Used to auto-close the linked task after a second GP-driven
-- failure (one rebooking grace). Persists across reschedules.
ALTER TABLE public.scheduled_calls
  ADD COLUMN IF NOT EXISTS failed_attempt_count INTEGER NOT NULL DEFAULT 0;
