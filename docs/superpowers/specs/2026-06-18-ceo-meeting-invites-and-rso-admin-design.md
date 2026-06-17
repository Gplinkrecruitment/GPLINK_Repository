# Spec: CEO-dashboard meeting invites (parity) + RSO management screen

Date: 2026-06-18
Status: Ready to implement (hand to an ultra-effort session)
Audience: the implementing session — this is self-contained.

## Plain-English goal
1. Make the **CEO dashboard** "Schedule Call" able to do everything the admin dashboard now does:
   a GP-visible **reason**, a private **internal note**, and an **assigned RSO** picker that routes the
   GP to that RSO's own Calendly link.
2. Add a **self-service "RSO" screen** so an admin can add an RSO and **paste their Calendly link**
   (and toggle active) without a developer editing the database.

## Already shipped — DO NOT redo (context)
On `main` (commit `68c115d`, 2026-06-17/18). Both DB columns are **live in production**:
- `scheduled_calls.meeting_reason TEXT`, `rso_team.calendly_event_url TEXT`.

server.js already does:
- `buildScheduledCallInsertPayload` stores `meeting_reason` (mirror exists in `server-test-helpers.js`).
- `buildCalendlyBookingUrl(token, baseUrl)` — routes to a per-RSO Calendly link, falls back to global `CALENDLY_EVENT_URL` when blank.
- `POST /api/admin/calls/schedule` reads `body.meeting_reason`, uses `assignedRso.calendly_event_url`,
  includes the reason in the invite email, and sends the email **From** the RSO when their address is
  `@mygplink.com.au` (else From GP Link + **Reply-To** the RSO).
- `buildZoomCallInviteEmailHtml(first, stage, url, reason)` renders a "Why we'd like to meet" block.
- `sendEmail({..., from:{email,name}, replyTo})` supports per-sender From/Reply-To.
- `loadRsoTeam()` / `mergeRsoRoster()` expose `calendly_event_url` per RSO.
- Cancel allowed from `no_show`; the Calendly webhook now lets through any booking carrying our
  correlation token (so per-RSO Managed Event types aren't dropped).

admin.html already has: "Send meeting invite" button on the Calls tab, the reason + internal-note
fields, an RSO picker, and the reason shown on call cards.

`GET /api/admin/rsos` returns the roster (from `rso_team`, falling back to the `RSO_TEAM` seed).
There is **no** write endpoint for RSOs yet.

## Part 1 — CEO dashboard meeting-invite parity
File: `pages/ceo-dashboard.html`. The endpoint is unchanged — only the UI needs the extra fields.
- `openCeoZoomModal(caseId, userId, currentStage)` (~line 3834): add to the modal
  - a **"Reason for the meeting (the GP will see this)"** textarea (e.g. `id="mZoomReason"`),
  - keep the existing internal **Notes** textarea (`mZoomNotes` → `admin_notes`),
  - an **"Assigned RSO"** `<select>` populated from `GET /api/admin/rsos` (option value = email; show
    name). Pre-select the GP's current assigned RSO if available.
- `submitCeoZoom(caseId, userId)` (~3848): add to the POST body
  `meeting_reason: <reason>` and `assigned_rso_email: <selected email>`.
- Per-GP calls render (`loadGpCalls` / renderer ~line 4626): show `call.meeting_reason`
  (GP-visible, distinct styling) separate from `call.admin_notes` (internal).
- Call actions (~4657): cancel/no-show/reschedule already call the right endpoints; the no-show
  cancel fix is server-side, so just verify the Cancel action now works on a `no_show` row.

## Part 2 — RSO management screen ("the RSO screen")
Purpose: add/edit RSOs incl. their `calendly_event_url`, no developer needed. This is what makes
future RSO onboarding self-service (see `docs/rso-calendly-zoom-setup.md` for the Calendly/Zoom side).
- Server (`server.js`), admin-session gated, service-key writes to `public.rso_team`:
  - `POST /api/admin/rsos` — create `{ name, email, phone, user_id, active, calendly_event_url }`.
  - `PATCH /api/admin/rsos/:id` — update any of the above (esp. `calendly_event_url`, `active`).
  - Prefer **deactivate** (`active=false`) over hard delete.
  - Validate: email format; `calendly_event_url` blank OR starts with `https://calendly.com/`.
  - **Verify the `rso_team` primary-key column first** (id vs user_id) before writing the `:id` route.
- UI: extend the existing RSO oversight area in the CEO dashboard (`renderRsoOversight` ~line 2436):
  an **"Add RSO"** button + per-card **Edit** with a field to paste the Calendly link and an
  active toggle. Reuse `.rso-card` styles. Refresh the roster after save.

## Part 3 — Tests
- Add a pure builder/validator for the RSO write payload and unit-test it (mirror in
  `server-test-helpers.js` if used by tests), following the `buildScheduledCallInsertPayload` pattern.
- `npm test` (vitest) must stay green (currently 501 passing).

## Part 4 — How to test the live chain NOW, before any RSO is ready
The host of a Calendly booking is whoever owns the booked event. Until an RSO's `calendly_event_url`
is set, the schedule flow falls back to the **global** event, which is hosted by **GP Link
(hello@mygplink.com.au)** — and that account already has Zoom connected. So:
- Send an invite with **no RSO assigned** (or an RSO whose `calendly_event_url` is blank) to a test
  GP whose inbox you control → book a time → confirm a **Zoom** meeting is created on hello@'s Zoom,
  the booking appears in the calls list, and (after the call) the AI summary lands. This proves
  invite → booking → webhook → calls list → summary end-to-end without needing Hazel's login.

## Open questions for the implementer
- `rso_team` primary-key column name (verify before the PATCH route).
- Put the RSO screen in the CEO dashboard (recommended — RSO oversight already lives there), the
  admin dashboard, or both?
- Do you also want to mark one RSO as the "default" assignee from this screen?

## Manual ops context (already documented)
`docs/rso-calendly-zoom-setup.md` — Calendly Managed Events + org-wide Zoom; one **licensed** Zoom
seat per active RSO; each RSO does a one-time ~3-min connect (accept Zoom + Calendly invites, connect
calendar, set hours).
