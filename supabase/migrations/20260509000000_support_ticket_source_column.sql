-- Add source column to support_tickets to track ticket origin
-- (e.g. 'nudge_reply' when a GP responds to a VA nudge)

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
