# RSO Meeting Invite + Per-RSO Calendly Routing — Design

Date: 2026-06-17
Status: Approved (build)

## Plain-English summary

Admins can send a GP a meeting invite that includes a **reason the GP can read**, plus a
**private internal note** just for the team. The meeting is routed through the **assigned
RSO's own Calendly link** so the RSO becomes the real host (their Zoom, their calendar, their
reminders). Also fixes a bug where a "No Show" call could not be cancelled.

## Part 1 — Bug fix: cancel a No Show call

`PATCH /api/admin/calls/:id` with `{status:'cancelled'}` only allowed cancelling from
`invited`/`booked`, so a `no_show` call returned HTTP 409 and the Cancel button silently
failed. Fix: allow cancelling from `no_show` too. The reschedule path already supports
`no_show`; this just unblocks the existing Cancel button.

## Part 2 — Two note fields

- **Reason for the meeting (GP-visible)** → new `scheduled_calls.meeting_reason` column.
  Included in the invite email and shown on the admin Calls tab.
- **Internal note (admin-only)** → existing `admin_notes` (never sent to the GP). Unchanged.

## Part 3 — Per-RSO Calendly routing (Managed Events)

Each RSO has their own Calendly Managed Event copy (their own availability + their own Zoom).
The app stores each RSO's booking link and routes the GP to the **assigned RSO's** link.

- New `rso_team.calendly_event_url` column; surfaced by `loadRsoTeam()` / `mergeRsoRoster()`.
- `buildCalendlyBookingUrl(token, baseUrl)` gains an optional per-RSO base URL (falls back to
  the global `CALENDLY_EVENT_URL` when blank — so nothing breaks before links are filled in).
- **Webhook fix:** the booking webhook ignored any event type other than the single configured
  one. Each RSO's managed event has a different event-type URI, so RSO bookings would be
  silently dropped. Bookings are actually matched by our **correlation token**
  (`utm_content=call_<token>`), so we now also let through any booking carrying that token,
  regardless of event type.

## Part 4 — Invite email from the RSO

`sendEmail()` gains optional `from {email,name}` and `replyTo`. The schedule invite is sent:
- **From** the RSO when their address ends in `@mygplink.com.au` (verified Resend domain), with
  Reply-To the RSO.
- Otherwise **From** GP Link with **Reply-To** the RSO (e.g. an RSO on a Gmail address).

## What stays manual (Calendly/Zoom, per RSO — one-time ~2 min)

1. Accept Calendly seat invite. 2. Connect their own Zoom. 3. Connect their own calendar.
4. Receive the pushed Managed Event. 5. Set their availability. 6. Admin pastes their event
link into the app. After that everything is automatic.

## Data / migration

`supabase/migrations/<ts>_meeting_reason_and_rso_calendly.sql`:
- `ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS meeting_reason TEXT;`
- `ALTER TABLE rso_team ADD COLUMN IF NOT EXISTS calendly_event_url TEXT;`

## Tests

Mirror pure-function changes in `server-test-helpers.js`; add unit tests for `meeting_reason`
passthrough and the reason appearing in the invite email HTML. Existing `mergeRsoRoster` and
`scheduled-calls` tests must still pass.
