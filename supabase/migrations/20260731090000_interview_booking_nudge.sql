-- Interview booking nudge (owner call 2026-07-31).
--
-- booking_invite_sent_at (20260723090000) is a ONE-SHOT stamp: the
-- congratulations-and-book email fires exactly once when the practice's times
-- land. Nothing chased a doctor who ignored it — the interview-reminders cron
-- only fires for interviews that are ALREADY booked — so an application could
-- sit at Interview indefinitely with times on the table and no follow-up.
--
-- These two columns own the follow-up cadence and are deliberately SEPARATE
-- from the one-shot stamp, so the chase can never re-arm or overwrite the
-- invite (and the invite can never look like a nudge).
alter table public.gp_applications
  add column if not exists booking_nudge_count integer not null default 0;

alter table public.gp_applications
  add column if not exists booking_nudge_last_at timestamptz;

-- The cron scans for applications that were invited but never booked. Partial
-- index: the chase caps at 3, so rows past the cap drop out of the index
-- entirely rather than being scanned and discarded every run.
create index if not exists idx_gp_applications_booking_nudge
  on public.gp_applications (booking_invite_sent_at, booking_nudge_last_at)
  where booking_invite_sent_at is not null and booking_nudge_count < 3;
