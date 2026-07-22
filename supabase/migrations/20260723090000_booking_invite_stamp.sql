-- One-shot stamp: the GP's congrats+book email fires exactly once per
-- application, at the first moment approval AND practice availability both exist.
alter table public.gp_applications add column if not exists booking_invite_sent_at timestamptz;
