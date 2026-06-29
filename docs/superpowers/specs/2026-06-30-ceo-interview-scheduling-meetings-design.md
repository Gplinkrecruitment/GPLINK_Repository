# CEO Interview Scheduling + Meetings Tab — Design Spec

**Date:** 2026-06-30
**Status:** Draft for owner review
**Branch:** `worktree-ats-prototype` (preview → production after review)
**Companion docs:** [[2026-06-27-ats-ceo-restructure-design.md]] (the 4-tab CEO/ATS restructure this builds on), [[2026-06-09-zoom-call-scheduling-design.md]] (the consultation scheduling pipeline this reuses)

---

## 1. Plain-English summary (for a non-technical reader)

Today the CEO's standard consultations (the first calls with GPs who come in through ads) work end to end: the GP books a slot on Calendly, a Zoom call is created automatically, and when the call ends the AI writes a summary that gets saved. Interviews were only half-built and the booking button was removed because it didn't work.

This project makes the **"Book interview"** button work, and it adds two things:

1. A **Meetings tab** for the CEO — one tidy list of every Zoom meeting the CEO has, with a filter to switch between **Standard consultations** and **Interviews**, grouped into Upcoming / Past / Summaries. It looks and behaves like the Calls page the RSOs already use.
2. An **Applications section** on each candidate — a list of every job that GP has applied for, and for each one: where they are in the hiring pipeline, the interview summary once the interview happens, and an offer/contract placeholder for later.

The hard part of an interview is that **three people in two countries have to be free at once**: the GP (UK), the medical practice (Australia), and the CEO (Sydney). The system automates this: it asks the practice for their availability by email, an AI reads the reply, and the software works out the exact slots where all three are free — correct across timezones and daylight saving — then lets the GP pick one. We then create the Zoom interview automatically and save its AI summary, the same way consultations work.

**Your Google Calendar becomes the single source of truth for your time.** We connect it so that: (a) when we work out interview slots we read it and never offer a time that clashes with a standard consultation, and (b) when an interview is booked we write it onto that calendar, so Calendly sees the slot as busy and won't let a consultation be booked over it. Clashes are prevented in both directions.

**Important honesty note:** interviews do **not** go through Calendly, and they can't — Calendly has no way for software to create a booking inside it, and it can't see the practice's or GP's availability. So the app does the three-way matching itself, creates the Zoom meeting, and records the interview on your Google Calendar (which is exactly where Calendly looks to decide if you're free). Standard consultations are unchanged and keep using Calendly; they already land on the same Google Calendar, so everything reconciles in one place.

---

## 2. Goals / Non-goals

### Goals
- Make **"Book interview"** functional from a candidate's application in the ATS.
- Automate three-way (GP + practice + CEO) availability matching across UK ↔ AU timezones, with daylight-saving handled correctly.
- Collect the practice's availability by email and extract it with AI (the practice replies in plain English — "Option A").
- Create the Zoom interview automatically and reuse the existing Zoom AI Companion summary pipeline so interview summaries save themselves.
- **Connect the CEO's Google Calendar** as the single source of truth for their time.
- **Two-way clash prevention:** never offer an interview slot that clashes with a consultation (read the calendar), and block consultations from being booked over an interview (write the interview to the calendar Calendly checks).
- Add a **Meetings** master tab to the CEO dashboard: the CEO's own meetings, filter Consultation/Interview, grouped Upcoming/Past/Summaries.
- Add an **Applications** section to each candidate's detail view: per-application pipeline stage, interview summary, and an offer/contract placeholder.
- Every code path works end to end (UI → API → DB → read-back) and is covered by tests, including timezone/DST edge cases.

### Non-goals (explicitly out of scope for this build)
- A real offer/contract management flow (upload, e-sign, accept/decline) — placeholder only this round.
- An org-wide meetings view spanning every RSO — the Meetings tab is the CEO's own meetings only.
- A practice-facing self-serve scheduling portal — the practice just replies to an email.
- Auto-rescheduling / no-show re-invite automation for interviews (consultations already have this; interviews can reuse it later).
- Changing how standard consultations work in any way.

---

## 3. Background — what exists today (verified by code exploration)

- **Consultations** live in the `scheduled_calls` table (migration `20260609000000_scheduled_calls.sql`). They are booked via Calendly (`handleCalendlyInviteeCreated`, server.js ~15071–15194), the Zoom join URL comes from the Calendly event location, and `meeting.ended` → `meeting.summary_completed` Zoom webhooks call `fetchAndSaveZoomSummary` (server.js ~15577–15657) which saves `meeting_summary` / `meeting_action_items` onto the `scheduled_calls` row, matched by `zoom_meeting_uuid` / `zoom_meeting_id`.
- `GET /api/admin/calls` (server.js ~29320–29344) lists calls, accepts `case_id`, `status`, `stage`, `summary_status`, `from`, `to`. `normalizeScheduledCallForApi` (~882–890) shapes the API row.
- The CEO dashboard already contains per-GP call classification (`classifyGpCalls`, `renderGpCallCard`, ceo-dashboard.html ~5450–5608) — Upcoming / Past / Summary logic and abandoned-draft filtering — which the Meetings tab will mirror.
- **Interviews** were half-built on a *separate* path: a `career_interviews` table (migrations `20260407000000_career_interviews.sql` + `20260627100400_career_interviews_summary.sql`, **never applied** to the shared DB) and a manual datetime-picker modal in `js/ceo-ats-jobs.js` (`interviewModalHtml` / `openInterviewModal` / `submitInterview` → `POST /api/admin/career/interview/schedule`). The trigger button (`atsJobSchedBtn`) was removed earlier because the table is absent and the flow was manual, not Calendly-based.
- **ATS applications** live in `gp_applications` with `ats_stage` (`applied → submitted → reviewing → interview → offer → hired` + `not_proceeding`); `ats_stage_events` is the audit trail. `POST`/`PATCH /api/ats/application` (server.js ~43723–43770) create/move applications.
- The **candidate detail** endpoint `GET /api/ceo/candidate` returns an `apps` array built by joining `gp_applications` + `career_roles` (server.js ~23217–23228) with fields `{ id, job_id, job_title, practice_name, ats_stage }`. Rendered in `pipelineCardInner` (`js/ceo-ats-candidates.js` ~369–405).
- A **practice email hub** already exists (registration@ hub) that emails practices and AI-parses their replies — we reuse this channel for the availability request.

---

## 4. Key architectural decision: interviews unify into `scheduled_calls`, created directly (not via Calendly)

**Decision:** Store interviews as rows in the existing `scheduled_calls` table, tagged with a new `meeting_kind = 'interview'` and linked to the job application. Retire the half-built `career_interviews` path (its migrations are not applied; its modal is replaced).

**Why:**
- **One table = one clean Meetings list.** "All the CEO's Zoom meetings" becomes a single query over `scheduled_calls` filtered by `meeting_kind`.
- **The Zoom summary pipeline is reused with zero new wiring.** `fetchAndSaveZoomSummary` already matches `scheduled_calls` rows by `zoom_meeting_id` / `zoom_meeting_uuid`. As long as we store the `zoom_meeting_id` when we create the interview's Zoom meeting, summaries save automatically — same as consultations.
- **Avoids merging two tables** with two different summary mechanisms in the Meetings tab.

**Why not Calendly for interviews (the honest constraint):** Calendly cannot enforce the practice's windows or the GP's sleep window, and it has **no API to create a booking** on the user's behalf. Routing interviews through Calendly would discard the three-way filtering that is the entire purpose. Therefore the app computes the overlap itself and creates the Zoom meeting via the Zoom API. **Consultations keep using Calendly unchanged.**

**Second decision — the CEO's Google Calendar is the single source of truth for their time, giving two-way clash prevention.** We add a Google Calendar integration (new — none exists today) for the CEO's account:
- **Read (prevents proposing a clash):** the scheduling engine reads the CEO's calendar free/busy when generating slots. Because Calendly writes booked consultations onto this same calendar, free/busy already reflects consultations — so we never offer an interview slot that overlaps one.
- **Write (prevents a future clash):** on booking we create a calendar event for the interview on the CEO's Google Calendar. Calendly checks that calendar for conflicts, so it will not offer or accept a consultation over an interview.

This reconciles consultations (written by Calendly) and interviews (written by us) in one calendar that everything reads. It requires the owner to connect Google Calendar both to our app (so we can read/write) and to Calendly's conflict-checking (so Calendly respects interviews). See §12.

**Consequence for the owner:** No "Interview" Calendly event type is required. Setup is: connect Google Calendar (to our app + to Calendly's conflict-check) and confirm the Zoom credential can create meetings with AI Companion summaries on. See §12.

---

## 5. The three-way scheduling engine

This is the heart of the build. It is a **pure module** (`lib/interview-scheduler.js`) with no DB or network calls, so it is fully unit-testable. It takes availability inputs + a reference "now" and returns concrete bookable slots.

### 5.1 Availability rules (the agreed defaults)

| Party | Timezone source | Weekdays (Mon–Fri) | Weekends (Sat–Sun) |
|---|---|---|---|
| **Host (CEO)** | Fixed: `Australia/Sydney` | 11:00 – 02:00 (next day) | 11:00 – 02:00 (next day) |
| **Practice** | Derived from practice's AU location (default `Australia/Sydney`) | 18:00 – 22:00 | 00:00 – 24:00 (all day) |
| **GP** | Derived from registration country (`uk→Europe/London`, `ie→Europe/Dublin`, `nz→Pacific/Auckland`) | 06:00 – 23:00 (asleep 23:00–06:00) | 06:00 – 23:00 (same sleep rule) |

Notes:
- These are **defaults**. The practice's emailed reply (§5.4) **narrows or overrides** the practice's default windows for specific dates ("Only Thursday after 7pm").
- The host window is additionally constrained by the CEO's **real Google Calendar free/busy** — any time the CEO is already booked (including Calendly-booked consultations, which Calendly writes onto this calendar) is subtracted. This is the read half of the two-way clash prevention (§4).
- Each party window is configurable via constants at the top of the module so the owner's hours can change without code spelunking.

### 5.2 Timezone + daylight-saving handling

- All windows are expressed in each party's **IANA timezone** and converted to **absolute UTC instants** for overlap math, using the runtime's `Intl.DateTimeFormat` timezone support (no fixed offsets). This makes British Summer Time and Australian daylight saving automatic and correct, including the weeks where only one country has shifted.
- Every slot returned carries its UTC instant plus a **rendering in each party's local time**, so the GP sees their time, and confirmations show all three local times.
- The module never uses "now" implicitly: callers pass a `now` instant so tests are deterministic across DST boundaries.

### 5.3 The overlap algorithm

Given: reference `now`, a horizon (default **next 14 days**), interview duration (default **45 minutes**), minimum lead time (default **48 hours** so the practice has notice), and the three sets of daily windows:

1. Build, for each day in the horizon, each party's availability as UTC intervals (host, practice, GP), applying weekday/weekend rules and the practice's emailed overrides.
2. Subtract the host's busy intervals — read from the CEO's Google Calendar free/busy (which includes Calendly-booked consultations) plus any existing interviews — from the host set.
3. Intersect the three sets day by day → **three-way-free intervals** (UTC).
4. Drop any interval shorter than the interview duration and anything inside the lead-time buffer.
5. Slice the surviving intervals into discrete start times on a **30-minute grid** → the candidate slot list.
6. Cap and spread the offered slots (e.g., up to ~12 slots, spread across distinct days/times so the GP gets real choice rather than 12 consecutive ones).

Output: an ordered list of `{ startUtc, endUtc, localByParty: { host, practice, gp } }`.

### 5.4 Practice availability via email (Option A)

- When the CEO clicks **Book interview**, the system sends the practice an email through the existing hub.
- **Email body (owner-approved wording):** *"Which evenings/weekends over the next 2 weeks suit to interview Dr X?"* (with the GP's real name substituted, plus a short polite frame and a reply-to that lands back in the hub).
- The practice's free-text reply is parsed by an AI step (reusing the project's existing practice-reply AI parsing) into structured windows **in the practice's Australian timezone**, e.g. `[{ date, from, to }]`. The AI is instructed to interpret vague phrases ("Tuesday evening", "any time Saturday") into concrete windows and to flag if no availability was given.
- If the practice does not reply within the horizon, the engine falls back to the **default** practice windows (weekday 18:00–22:00 / weekends all day) so booking is never fully blocked — and the CEO is notified that defaults were used.

### 5.5 Defaults summary (all configurable)
- Horizon: 14 days · Duration: 45 min · Lead time: 48 h · Grid: 30 min · Max offered slots: ~12.

---

## 6. Data model changes

Additive migration on `scheduled_calls` (keeps consultations working):

- `meeting_kind TEXT NOT NULL DEFAULT 'consultation'` — `CHECK (meeting_kind IN ('consultation','interview'))`.
- `application_id UUID NULL` — FK to `gp_applications(id)`, set for interviews so they appear under the right application.
- `career_role_id BIGINT NULL` and `practice_name TEXT NULL` — denormalized job/practice labels for the Meetings list and the application view.
- Relax `stage`: it is currently `NOT NULL CHECK (stage IN ('myintealth','amc','ahpra'))`. Make it **nullable** and widen/relax the check so interview rows (which have no registration stage) are valid. Consultation rows are unaffected.
- Practice-availability tracking fields for the interview flow:
  - `practice_availability_status TEXT DEFAULT 'not_requested'` — `not_requested | requested | received | defaulted`.
  - `practice_availability_windows JSONB` — the AI-extracted windows.
  - `practice_availability_requested_at` / `_received_at TIMESTAMPTZ`.
- Host identity: add `host_kind TEXT DEFAULT 'rso'` (`rso | ceo`) so the Meetings tab can select the CEO's own meetings cleanly. (Consultations the CEO personally runs are `ceo`; RSO consultations stay `rso`.)
- `gcal_event_id TEXT NULL` — the Google Calendar event id created for a booked interview (so we can update/cancel it and confirm it was written to the calendar Calendly checks).

Local-JSON parity: the same fields are mirrored in `dbState.scheduledCalls` (or the existing local collection) so the gated page runs the real code offline, consistent with the existing ATS local-mode pattern.

New/changed server helpers:
- `createZoomMeeting({ topic, startUtc, durationMin, hostEmail })` — new helper using the existing Zoom API credentials (same auth path as `fetchAndSaveZoomSummary`) to create the interview's Zoom meeting; returns `{ id, uuid, join_url, passcode, host_url }`. Requires the Zoom credential to have meeting-create scope (§12).
- `lib/google-calendar.js` (new) — a small client with `googleCalendarFreeBusy({ calendarId, fromUtc, toUtc })` (read) and `createCalendarEvent({ calendarId, summary, startUtc, endUtc, attendees, zoomJoinUrl })` (write), using the CEO account's Google credentials with a new Calendar scope (§12). **Dual-mode:** in local/dev/test it reads/writes a fake calendar held in `dbState` so the engine and endpoints are fully testable without Google; in prod it calls the Google Calendar API. Same prod-only-credential pattern as Drive — see [[drive-folders-and-docs-mechanics]] — so the real calendar path is verified in production and mocked locally.
- Reuse `fetchAndSaveZoomSummary` unchanged for interview summaries (matches by `zoom_meeting_id`).
- The career_interviews migrations remain unapplied and the `/api/admin/career/interview/*` endpoints + the old modal are retired/removed to avoid a second, dead interview path. (Note: `lib/ceo-metrics.js` references `career_interviews`; since that table is absent in the DB those reads are already no-ops — they'll be repointed at the unified `scheduled_calls` interview rows or left inert, decided during implementation.)

---

## 7. Book-interview flow (state machine)

An interview `scheduled_calls` row moves through:

1. **`requested`** — CEO clicked Book interview; practice availability email sent; `practice_availability_status = requested`. (We reuse `status` semantics; interview-specific sub-state lives in `practice_availability_status` + whether `scheduled_at` is set.)
2. **practice replied / defaulted** — AI windows stored (`received`) or defaults applied (`defaulted`); the engine computes slots; the GP is notified (WhatsApp + email via existing channels) that slots are ready to pick.
3. **`invited` → awaiting GP pick** — GP opens the app and sees the pre-cleared slots.
4. **GP picks** → we re-check the slot is still free against the CEO's Google Calendar, `createZoomMeeting`, then `createCalendarEvent` on the CEO's Google Calendar (storing `gcal_event_id` — this is what blocks Calendly from booking a consultation over it), store Zoom fields + `scheduled_at`, set `status = 'booked'`, send calendar invites to all three (each in their local time), and move the application's `ats_stage` to `interview` (writing an `ats_stage_events` row).
5. **`completed`** — Zoom `meeting.ended` → `summary_status = 'pending'` (existing handler).
6. **summarized** — Zoom `meeting.summary_completed` → `fetchAndSaveZoomSummary` saves the summary (existing handler).

Cancel / no-show / reschedule reuse the existing consultation handlers where possible; full interview-specific reschedule automation is out of scope (§2).

---

## 8. UI: the "Book interview" control + GP slot picker

- **Re-add the Book interview button** to the ATS job pipeline drawer in `js/ceo-ats-jobs.js`, where the removed `atsJobSchedBtn` used to be (the click listener still exists). It opens a small confirm ("Send Dr X's practice an availability request and start interview scheduling?") rather than the old manual datetime modal, which is removed.
- **GP slot picker (candidate-facing, in the app):** when slots are ready, the GP sees a short list of slot buttons, each labeled in **their** local time (with a small "(your local time)" note), and picks one. This is a new lightweight in-app view; on pick it calls the booking endpoint (§11). No Calendly embed.
- Status visibility for the CEO: the application row + the Meetings tab show where the interview is ("Awaiting practice availability", "Awaiting GP to pick a time", "Booked for …", "Completed — summary saved").

---

## 9. UI: Meetings master tab (CEO dashboard)

- New top-level tab alongside Registration | Candidates | Jobs | Practices → **Meetings**, with its own module `js/ceo-ats-meetings.js` and hash route `#meetings`.
- Content: the CEO's own meetings (`host_kind = 'ceo'`), with:
  - A filter: **All | Standard consultation | Interview** (by `meeting_kind`).
  - Grouping mirroring the RSO calls page: **Upcoming**, **Past**, **Summaries** (completed meetings with a saved summary), reusing the existing `classifyGpCalls`-style logic + abandoned-draft filtering.
  - Each row: person/GP name, type pill (Consultation/Interview), date/time in Sydney + the GP's local time, status, Join link (when booked + has Zoom URL), and for interviews the job/practice it's for. Clicking a completed meeting shows its saved AI summary + action items.
- Backed by `GET /api/ceo/meetings` (§11), which is `GET /api/admin/calls` semantics scoped to the CEO's host meetings with the `meeting_kind` filter.

## 10. UI: Applications section on candidate detail

- In `js/ceo-ats-candidates.js`, promote the current inline apps list into a clearly-headed **Applications** section in the candidate detail view (its own card after the pipeline card).
- Per application show:
  - Job title + practice + current **pipeline stage** (existing stage pill + the stage dropdown already built).
  - **Interview**: status / scheduled time / **saved summary** once complete (pulled from the linked interview `scheduled_calls` row).
  - **Offer / contract**: a placeholder block (label + status text, e.g. "—" / "Not started"), no upload yet.
- Backend: extend `GET /api/ceo/candidate`'s `apps` builder (server.js ~23217–23228) to include, per application, the linked interview summary fields and an offer/contract placeholder object. Both prod (Supabase join on `scheduled_calls` where `application_id = app.id AND meeting_kind='interview'`) and local-JSON modes.

---

## 11. API surface (new / changed)

- `POST /api/ats/interview/request` — body `{ application_id }`. Creates the interview `scheduled_calls` row (`meeting_kind='interview'`, `host_kind='ceo'`), sends the practice availability email, sets `practice_availability_status='requested'`. CEO/super-admin guarded.
- (internal) practice-reply ingestion — when the hub receives the practice's reply, AI-parse → store `practice_availability_windows`, compute slots, notify the GP. Hooks into the existing hub reply path.
- `GET /api/ats/interview/slots?application_id=…` — returns the computed pre-cleared slots for the GP picker (each with per-party local times).
- `POST /api/ats/interview/book` — body `{ application_id, slot_start_utc }`. Re-validates the slot is still three-way-free **including a fresh Google Calendar free/busy check**, `createZoomMeeting`, `createCalendarEvent` on the CEO's Google Calendar (stores `gcal_event_id`), stores Zoom fields + `scheduled_at`, sets `status='booked'`, moves `ats_stage` to `interview`, sends invites. Idempotent on the interview row.
- `GET /api/ceo/meetings?kind=all|consultation|interview` — the CEO's host meetings for the Meetings tab.
- `GET /api/ceo/candidate` — extended `apps[]` with interview summary + offer/contract placeholder (no new route).

All endpoints dual-mode (Supabase + local-JSON), following the existing ATS endpoint conventions.

---

## 12. External setup the owner must do once (and what I'll provide)

- **Google Calendar (new — this is the main setup):**
  1. Connect the CEO's Google Calendar to **Calendly's conflict-checking** (Calendly → Calendar connection → "check this calendar for conflicts"), so Calendly treats interviews on that calendar as busy.
  2. Grant **our app** access to the CEO's Google Calendar (Calendar API scope, added to the existing Google integration — the CEO consents once, or we use Google Workspace domain-wide delegation for hello@). This lets us read free/busy and write interview events.
  3. Confirm Calendly is set to **add booked consultations to this same Google Calendar**, so consultations appear in free/busy.
- **Zoom:** ensure the Zoom credential can **create meetings** (meeting-create scope on the Server-to-Server OAuth app) and that **AI Companion meeting summaries** are enabled for the host account. I'll write click-by-click steps.
- **No "Interview" Calendly event type needed** (interviews don't use Calendly).
- The practice availability email uses the existing hub — no new setup.

I'll build and test everything in local mode so it's ready the moment the Zoom scope is confirmed, then ship to the preview branch and (on the owner's say-so) production, applying the additive migration to the shared Supabase.

---

## 13. Testing strategy

- **Unit tests for `lib/interview-scheduler.js`** (the pure engine): overlaps across UK/AU with **DST boundary cases** (UK in BST while AU in standard time, and vice-versa), weekday vs weekend rules, GP sleep-window exclusion, practice override narrowing, lead-time and duration filtering, empty-overlap days. Deterministic via injected `now`.
- **Endpoint tests** (vitest, local-JSON mode, minted `gp_admin_session`): request → slots → book happy path; idempotency; auth guard; application stage moves to `interview` and an `ats_stage_events` row is written; Meetings list filtering by `meeting_kind`; candidate `apps[]` includes interview summary + placeholder.
- **Google Calendar read/write is mocked** in dev/test (the fake calendar in `dbState`): tests assert booking writes a calendar event and stores `gcal_event_id`, and that a busy calendar interval is excluded from the offered slots (the two-way clash prevention). The real Google Calendar API path is prod-only (mocked locally, like Drive).
- **Regression:** the full existing suite (753+) stays green; consultations behave identically.
- **Visual:** screenshot the Meetings tab (both filters), the candidate Applications section, and the GP slot picker on the real gated page via the existing screenshot harness.

---

## 14. Open items to verify during implementation (not blockers)
- **Practice timezone data:** confirm what location/state we store per derived practice (from `career_roles` / `source_payload.zoho`) so practice TZ is correct, not just defaulted to Sydney. If too thin, default to Sydney and surface the assumption on the booking screen.
- **GP timezone source:** confirm `registration_country` reliably yields a timezone for every GP; otherwise default by country with an override.
- **Google auth for Calendar:** confirm the existing Google integration's auth mechanism (service account with domain-wide delegation vs OAuth) and add the Calendar scope for the CEO account (hello@). The real calendar read/write can only be verified in production (no Google creds locally — see [[machine-environment-quirks]]), so it ships behind the same prod-only pattern as Drive, mocked locally.
- **Zoom create-meeting scope:** confirm the existing Zoom app credential can create meetings; if a scope change is needed, that's the one owner setup step.

---

## 15. Sequencing (for the implementation plan)
1. Migration + `scheduled_calls` model changes (+ local-mode parity).
2. `lib/interview-scheduler.js` pure engine + its unit tests.
3. `createZoomMeeting` helper + `lib/google-calendar.js` (free/busy read + event write, dual-mode) + reuse of the summary pipeline.
4. Practice availability email + AI-parse ingestion.
5. Interview API endpoints (request / slots / book) + stage move.
6. UI: Book interview button + GP slot picker.
7. UI: Meetings master tab.
8. UI: Applications section on candidate detail.
9. Endpoint + regression tests; screenshots; owner setup doc.
