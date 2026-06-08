# Zoom Call Scheduling System — Design Spec

**Date:** 2026-06-09
**Status:** Approved
**Scope:** Admin-initiated Zoom assistance calls for GPs at MyIntealth, AMC, or AHPRA stages

---

## Overview

Admins can schedule Zoom assistance calls with GPs who need help at the MyIntealth, AMC, or AHPRA registration stages. The system uses Calendly for self-service booking (GP picks a time from shared admin availability) and Zoom AI Companion for automatic post-call summaries that get saved to the GP's profile.

## User Flow

```
Admin clicks "Schedule Zoom Call" on GP case
  → Modal: picks stage, writes internal notes (admin-only), confirms
  → System creates scheduled_calls record (status: invited)
  → GP receives Calendly link via WhatsApp (DoubleTick) + Email (Resend)
  → GP opens Calendly link, picks a time slot
  → Calendly webhook fires (invitee.created)
  → System updates record: status → booked, populates scheduled_at + Zoom link
  → Task on case + Scheduled Calls tab both update automatically
  → Call happens on Zoom with AI Companion enabled
  → Zoom webhook fires (meeting.ended)
  → System waits ~2 min, then fetches AI Companion summary via Zoom API
  → Summary + action items saved to scheduled_calls record
  → Summary appears on GP's case under "Call History"
  → AI profile summary system can access call summaries as context
```

## Data Model

### New table: `scheduled_calls`

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Primary key |
| `case_id` | UUID (FK → registration_cases) | Links to GP's registration case |
| `user_id` | UUID (FK → user_profiles) | The GP |
| `stage` | TEXT | `myintealth` / `amc` / `ahpra` |
| `status` | TEXT | `invited` → `booked` → `completed` / `cancelled` / `no_show` |
| `admin_notes` | TEXT | Internal-only pre-call context (GP never sees this) |
| `calendly_event_uri` | TEXT | Calendly event URI (from webhook) |
| `calendly_invitee_uri` | TEXT | Calendly invitee URI |
| `scheduled_at` | TIMESTAMPTZ | Confirmed booking date/time |
| `timezone` | TEXT | GP's timezone (detected by Calendly) |
| `duration_minutes` | INT | Fixed at 30 |
| `zoom_meeting_id` | TEXT | From Calendly/Zoom |
| `zoom_join_url` | TEXT | For admin quick-join |
| `zoom_passcode` | TEXT | Meeting passcode |
| `meeting_summary` | TEXT | Zoom AI Companion summary (post-call) |
| `meeting_action_items` | JSONB | Structured action items from Zoom AI |
| `summary_saved_at` | TIMESTAMPTZ | When summary was fetched |
| `created_at` | TIMESTAMPTZ | When invite was sent |
| `updated_at` | TIMESTAMPTZ | Last modified |

### Registration task creation

When a call is scheduled, a `registration_task` is also created on the case:
- `task_type`: `zoom_call`
- `related_stage`: the selected stage
- `title`: "Zoom Assistance Call — {Stage}"
- `status`: tracks alongside the `scheduled_calls` record status

## API Endpoints

### Admin endpoints (authenticated, admin-only)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/calls/schedule` | Create invite, send Calendly link to GP via WhatsApp + email |
| `GET` | `/api/admin/calls` | List all calls (filterable by stage, status, date range) |
| `GET` | `/api/admin/calls/:id` | Single call detail with summary |
| `PATCH` | `/api/admin/calls/:id` | Update admin notes, mark no-show, cancel |
| `POST` | `/api/admin/calls/:id/resend` | Resend Calendly link to GP |

### POST /api/admin/calls/schedule — Request body

```json
{
  "case_id": "uuid",
  "user_id": "uuid",
  "stage": "ahpra",
  "admin_notes": "GP confused about Standard vs Specialist pathway...",
  "notify_whatsapp": true,
  "notify_email": true
}
```

### GET /api/admin/calls — Query params

- `stage` — filter by myintealth/amc/ahpra
- `status` — filter by invited/booked/completed/cancelled/no_show
- `from` / `to` — date range
- `case_id` — filter to a specific GP

### Webhook endpoints (external services)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/webhooks/calendly` | Receives `invitee.created` and `invitee.canceled` events |
| `POST` | `/api/webhooks/zoom` | Receives `meeting.ended` event, triggers summary fetch |

### Calendly webhook handler (`invitee.created`)

1. Extract invitee email from payload
2. Match to a `scheduled_calls` record by email + status `invited`
3. Update record: `status` → `booked`, populate `scheduled_at`, `timezone`, `calendly_event_uri`, `calendly_invitee_uri`
4. Extract Zoom meeting details from Calendly event (join URL, meeting ID, passcode)
5. Update the linked registration task

### Calendly webhook handler (`invitee.canceled`)

1. Match record by `calendly_invitee_uri`
2. Update record: `status` → `cancelled`
3. Update the linked registration task
4. Optionally notify admin

### Zoom webhook handler (`meeting.ended`)

1. Verify webhook signature using `ZOOM_WEBHOOK_SECRET`
2. Match `zoom_meeting_id` to a `scheduled_calls` record
3. Update record: `status` → `completed`
4. Schedule a delayed fetch (~2 minutes) for the AI Companion summary
5. Fetch `GET /meetings/{meetingId}/meeting_summary` from Zoom API
6. Save `meeting_summary` (text) and `meeting_action_items` (JSONB) to the record
7. Update `summary_saved_at` timestamp
8. Update the linked registration task to completed

## UI Components

### 4a. "Schedule Zoom Call" Button

Location: GP case header, in the `d-actions` row alongside existing buttons.

Styled as a Zoom-branded button (blue #2D8CFF background, white text, camera icon).

### 4b. Schedule Modal

Triggered when admin clicks the button. Contents:

- **GP info block** (read-only): avatar, name, email, phone
- **Stage dropdown**: MyIntealth / AMC / AHPRA — defaults to GP's current stage
- **Internal notes textarea**: clearly labelled "Admin only — GP won't see this"
- **Notification checkboxes**: WhatsApp + Email (both checked by default)
- **Submit button**: "Send Calendly Invite"

### 4c. Task on Case (Tasks tab)

A Zoom-specific task card that renders differently based on status:

- **Invited**: "Waiting for GP to book a time" — shows resend link button, time since invite sent
- **Booked**: Blue Zoom card with date/time, stage, admin notes, "Join Zoom" button, reschedule/cancel actions
- **Completed**: Green card with "View Summary" expandable section showing AI Companion notes + action items
- **Cancelled**: Greyed out with "Reschedule" option
- **No-show**: Red-flagged with "Reschedule" option

### 4d. Scheduled Calls Tab (top-level admin view)

New tab in the admin top-level navigation alongside Cases / Work Queue / Guide.

Layout:
- **Header**: "Upcoming Calls" title + filter pills (All / MyIntealth / AMC / AHPRA) + time filters (Today / This Week)
- **Call rows grouped by date**: Today → This Week → Later
- Each row shows: date/time block, GP name, stage pill, admin notes preview (truncated), status badge, Join/View button
- Clicking a row navigates to that GP's case detail (auto-opens Tasks tab)
- Top bar chip shows count of calls this week

### 4e. Call History Section (GP case detail)

New section on the GP's case detail view, below the Tasks section.

- Shows all completed calls for this GP in reverse chronological order
- Each entry: date, stage, admin's pre-call notes, full Zoom AI Companion summary, action items
- Expandable/collapsible per call
- Multiple calls stack (a GP may need more than one assistance call)

### 4f. AI Profile Summary Integration

The existing AI summary system that generates GP profile overviews will include call history as context:
- Number of assistance calls
- Topics discussed (from admin notes + AI summary)
- Outstanding action items
- This gives the AI summary a richer picture of where the GP needs help

## External Service Requirements

### Calendly (Pro plan required)

- **Event type**: "GP Registration Assistance" — 30 min, Zoom video integration enabled
- **Availability**: Admin sets recurring weekly availability in Calendly directly
- **Webhook**: Subscribe to `invitee.created` and `invitee.canceled` events, pointing to `/api/webhooks/calendly`
- **Auth**: Personal Access Token

### Zoom (Workplace Pro required for AI Companion)

- **AI Companion**: Must be enabled in Zoom account settings → "Meeting summary with AI Companion"
- **Server-to-Server OAuth app**: Same app used for career interviews (already exists)
- **Webhook**: Subscribe to `meeting.ended` event, pointing to `/api/webhooks/zoom`
- **API**: `GET /meetings/{meetingId}/meeting_summary` to fetch AI Companion output

### DoubleTick (WhatsApp)

- New approved template: `zoom_call_invite` — includes GP first name, stage name, Calendly booking link
- Uses existing `sendDoubleTickTemplate()` function pattern

### Resend (Email)

- New email template with Calendly booking link, stage context, and call purpose
- Uses existing `sendEmail()` function

## Environment Variables

### New

| Var | Purpose |
|---|---|
| `CALENDLY_API_TOKEN` | Personal Access Token for Calendly API |
| `CALENDLY_EVENT_URL` | Scheduling link for the "GP Registration Assistance" event type |
| `CALENDLY_WEBHOOK_SECRET` | Signing key to verify incoming Calendly webhooks |
| `ZOOM_WEBHOOK_SECRET` | Signing key to verify incoming Zoom webhooks |

### Existing (already configured for career interviews)

| Var | Purpose |
|---|---|
| `ZOOM_CLIENT_ID` | Zoom Server-to-Server OAuth |
| `ZOOM_CLIENT_SECRET` | Zoom Server-to-Server OAuth |
| `ZOOM_ACCOUNT_ID` | Zoom Server-to-Server OAuth |
| `DOUBLETICK_API_KEY` | WhatsApp messaging |
| `RESEND_API_KEY` | Email sending |

## Setup Instructions (for admin)

Detailed step-by-step setup guides will be provided during implementation for:

1. **Calendly Pro setup** — Creating the event type, enabling Zoom integration, generating API token, configuring webhook
2. **Zoom AI Companion setup** — Enabling meeting summaries, configuring the webhook subscription, verifying Server-to-Server OAuth app permissions
3. **DoubleTick template** — Submitting the `zoom_call_invite` template for WhatsApp approval
4. **Vercel env vars** — Setting all new environment variables

## Out of Scope

- GP-initiated call requests (GP cannot request a call themselves — admin-only)
- Multiple admins / admin-specific Calendly accounts (single shared Calendly account)
- Call recording storage (Zoom handles recording; we only store the AI summary)
- SMS notifications (WhatsApp + Email only)
- Custom call durations (fixed 30 min)
