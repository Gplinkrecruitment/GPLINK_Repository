-- Meeting invite enhancements (2026-06-17)
-- 1) GP-visible reason for a scheduled call invite (shown in the invite email + admin Calls tab).
--    Distinct from admin_notes, which stays internal-only.
ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS meeting_reason TEXT;

-- 2) Per-RSO Calendly Managed Event link so the assigned RSO hosts the meeting
--    (their own Zoom, calendar, availability, notifications and reminders).
--    Blank falls back to the global CALENDLY_EVENT_URL, so existing behaviour is unchanged
--    until each RSO's link is filled in.
ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS calendly_event_url TEXT;
