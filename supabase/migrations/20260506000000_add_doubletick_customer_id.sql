-- Add doubletick_customer_id to user_profiles so the VA admin can link
-- directly to a GP's DoubleTick conversation without an API round-trip.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS doubletick_customer_id text;
