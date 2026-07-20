-- "Waiting on practice" tracker + reminder engine.
-- Columns that track the practice's accept/decline SLA on a submitted candidate:
--  practice_reminder_count   how many auto/manual reminders we've emailed the practice
--  last_practice_reminder_at when the last reminder went out (day-3/day-5 gating)
--  practice_chase_flagged_at set at day 7 with no reply → "chase personally" flag
--  practice_opened_at        when the practice first opened the decision link → "Reviewing"
-- All additive + nullable/defaulted → safe, backward-compatible.
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS practice_reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS last_practice_reminder_at TIMESTAMPTZ;
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS practice_chase_flagged_at TIMESTAMPTZ;
ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS practice_opened_at TIMESTAMPTZ;
