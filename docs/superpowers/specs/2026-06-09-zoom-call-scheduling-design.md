# Zoom Call Scheduling System — Design Spec

**Date:** 2026-06-09
**Status:** Approved, amended after implementation review
**Scope:** Admin-initiated Zoom assistance calls for GPs at MyIntealth, AMC, or AHPRA stages

---

## Overview

Admins can schedule Zoom assistance calls with GPs who need help at the MyIntealth, AMC, or AHPRA registration stages. The system uses Calendly for self-service booking (GP picks a time from shared admin availability) and Zoom AI Companion for automatic post-call summaries that are saved against the GP's admin case profile.

All call management surfaces in this spec are admin-only. GPs receive the Calendly booking link and normal meeting communications, but they do not see admin notes or admin call-history records unless a separate GP-facing feature is explicitly designed later.

## Implementation Corrections From Review

This spec has been amended to address implementation risks found in the current GP Link app:

- The app uses `registration_tasks` (plural), not `registration_task`.
- `scheduled_calls.status` is the canonical call lifecycle. `registration_tasks.status` must use existing work-queue-safe task statuses unless a migration explicitly widens task status constraints.
- A Supabase migration must add the `zoom_call` task type to the `registration_tasks_task_type_check` constraint.
- Calendly webhooks must match records with a durable call correlation token, not only by invitee email.
- Calendly and Zoom webhooks must be routed before same-origin enforcement and verify signatures from the raw request body.
- Zoom summary retrieval must use `meeting.summary_completed` and/or a durable retry job. Do not rely on `setTimeout()` after responding to a webhook on Vercel.
- Admin notes and internal summaries must never be sent to GP-facing endpoints, WhatsApp, or email.

## User Flow

```
Admin clicks "Schedule Zoom Call" on GP case
  → Modal: picks stage, writes internal notes (admin-only), confirms
  → System validates case_id/user_id belong together
  → System creates scheduled_calls record (status: invited) with a correlation_token
  → System creates registration_tasks record (task_type: zoom_call, status: waiting_on_gp)
  → GP receives Calendly link via WhatsApp (DoubleTick) + Email (Resend)
  → Calendly link includes the correlation token as tracking data
  → GP opens Calendly link, picks a time slot
  → Calendly webhook fires (invitee.created)
  → System verifies webhook signature, deduplicates event, matches by correlation token
  → System updates scheduled_calls: status → booked, scheduled_at + Zoom details
  → Linked task metadata + Scheduled Calls tab update automatically
  → Call happens on Zoom with AI Companion enabled
  → Zoom webhook fires (meeting.ended)
  → System verifies Zoom webhook and marks call status → completed, summary_status → pending
  → Zoom webhook fires (meeting.summary_completed) OR retry cron finds pending summary
  → System fetches AI Companion summary via Zoom API
  → summary_content + next_steps/action items saved to scheduled_calls
  → Summary appears on admin case under Call History
  → Admin AI profile summary can use call summaries as context
```

## Data Model

### New table: `scheduled_calls`

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Primary key |
| `case_id` | UUID (FK → registration_cases) | Links to GP's registration case |
| `user_id` | UUID (FK → auth.users) | The GP's auth user id |
| `registration_task_id` | UUID (FK → registration_tasks) | Linked admin task card |
| `stage` | TEXT | `myintealth` / `amc` / `ahpra` |
| `status` | TEXT | `invited` → `booked` → `completed` / `cancelled` / `no_show` |
| `admin_notes` | TEXT | Internal-only pre-call context; never GP-facing |
| `correlation_token` | TEXT UNIQUE | Random token included in Calendly tracking data for webhook matching |
| `calendly_booking_url` | TEXT | Exact booking link sent to GP, including tracking token |
| `calendly_event_type_uri` | TEXT | Calendly event type URI, used to filter relevant bookings |
| `calendly_event_uri` | TEXT | Calendly scheduled event URI from webhook |
| `calendly_invitee_uri` | TEXT UNIQUE | Calendly invitee URI |
| `calendly_old_invitee_uri` | TEXT | Previous invitee URI when rescheduled |
| `calendly_webhook_event_id` | TEXT | Last processed Calendly webhook id or payload hash |
| `invitee_email` | TEXT | Email used by GP in Calendly |
| `scheduled_at` | TIMESTAMPTZ | Confirmed booking date/time |
| `booked_at` | TIMESTAMPTZ | When Calendly booking was confirmed |
| `timezone` | TEXT | GP's timezone from Calendly |
| `duration_minutes` | INT | Fixed at 30 |
| `zoom_meeting_id` | TEXT | Zoom meeting number/id |
| `zoom_meeting_uuid` | TEXT | Zoom meeting UUID for exact past meeting instance |
| `zoom_join_url` | TEXT | Join URL for admin quick-join |
| `zoom_passcode` | TEXT | Meeting passcode, if Calendly/Zoom provides it |
| `meeting_summary` | TEXT | Zoom `summary_content` markdown from AI Companion |
| `meeting_action_items` | JSONB | Zoom `next_steps` plus parsed action items where available |
| `meeting_summary_raw` | JSONB | Raw Zoom summary payload for future parsing changes |
| `summary_status` | TEXT | `not_requested` / `pending` / `saved` / `not_available` / `error` |
| `summary_fetch_attempts` | INT | Retry counter for summary fetch |
| `summary_error` | TEXT | Last summary fetch error, admin-only |
| `summary_saved_at` | TIMESTAMPTZ | When summary was fetched |
| `invite_sent_at` | TIMESTAMPTZ | When first invite notification was sent |
| `resend_count` | INT | Number of invite resends |
| `notification_channels` | JSONB | Delivery attempts/results for WhatsApp/email |
| `whatsapp_message_id` | TEXT | DoubleTick message id if sent |
| `email_message_id` | TEXT | Resend message id if returned |
| `completed_at` | TIMESTAMPTZ | When Zoom indicated meeting ended |
| `cancelled_at` | TIMESTAMPTZ | When Calendly/admin cancelled |
| `no_show_at` | TIMESTAMPTZ | When admin marked no-show |
| `created_by` | TEXT | Admin email/session actor |
| `created_at` | TIMESTAMPTZ | When invite was created |
| `updated_at` | TIMESTAMPTZ | Last modified |

### Constraints and indexes

- `stage CHECK (stage IN ('myintealth','amc','ahpra'))`
- `status CHECK (status IN ('invited','booked','completed','cancelled','no_show'))`
- `summary_status CHECK (summary_status IN ('not_requested','pending','saved','not_available','error'))`
- Index `(case_id, created_at DESC)` for case call history
- Index `(status, scheduled_at)` for Scheduled Calls tab
- Partial unique index on `calendly_invitee_uri` where not null
- Partial unique index on `zoom_meeting_id` where not null
- Unique index on `correlation_token`

### Optional table: `webhook_events`

Add a small idempotency table if webhook payloads do not provide stable event ids in all cases:

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID (PK) | Primary key |
| `provider` | TEXT | `calendly` / `zoom` |
| `event_id` | TEXT | Provider event id or SHA-256 hash of timestamp + raw body |
| `event_type` | TEXT | Provider event name |
| `processed_at` | TIMESTAMPTZ | When accepted |
| `payload` | JSONB | Redacted payload for debugging |

Unique index: `(provider, event_id)`.

### Registration task creation

When a call is scheduled, a `registration_tasks` row is created on the case:

- `task_type`: `zoom_call`
- `related_stage`: selected stage
- `title`: `Zoom Assistance Call — {Stage}`
- `description`: short admin-safe status text, not GP-facing
- `status`: work queue status, not the canonical call status
- `metadata`: includes `scheduled_call_id`, `call_status`, `calendly_invitee_uri`, `zoom_meeting_id`, and summary state

Task status mapping:

| `scheduled_calls.status` | `registration_tasks.status` | Notes |
|---|---|---|
| `invited` | `waiting_on_gp` | GP needs to book a time |
| `booked` | `waiting` | Call is scheduled; no GP task action required |
| `completed` | `completed` | Call ended, summary saved or pending |
| `cancelled` | `cancelled` | Call cancelled |
| `no_show` | `waiting_on_gp` | Display no-show from `scheduled_calls.status` / task metadata |

Migration requirement: add `zoom_call` to `registration_tasks_task_type_check`. Do not mirror `invited`, `booked`, or `no_show` directly into `registration_tasks.status` unless a deliberate migration widens the task status constraint and all existing queue filters are updated.

## API Endpoints

### Admin endpoints (authenticated, admin-only)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/calls/schedule` | Create invite, task, tracked Calendly link, and notifications |
| `GET` | `/api/admin/calls` | List calls, filterable by stage/status/date/case |
| `GET` | `/api/admin/calls/:id` | Single call detail with summary |
| `PATCH` | `/api/admin/calls/:id` | Update admin notes, mark no-show, cancel |
| `POST` | `/api/admin/calls/:id/resend` | Resend Calendly link |
| `POST` | `/api/admin/calls/:id/fetch-summary` | Admin-triggered summary retry |

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

Validation rules:

- Require admin session.
- Require Supabase DB.
- Verify `case_id` exists and belongs to `user_id`.
- Verify `stage` is one of `myintealth`, `amc`, `ahpra`.
- Limit `admin_notes` length.
- Validate notification flags; at least one channel should be selected unless admin confirms "record only".
- Rate limit schedule/resend actions per admin and per GP.

### GET /api/admin/calls — Query params

- `stage` — filter by myintealth/amc/ahpra
- `status` — filter by invited/booked/completed/cancelled/no_show
- `from` / `to` — date range, based on `scheduled_at` for booked calls and `created_at` for invited calls
- `case_id` — filter to a specific GP case
- `summary_status` — filter summary fetch state

### Webhook and cron endpoints (external/internal services)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/webhooks/calendly` | Receives `invitee.created` and `invitee.canceled` events |
| `POST` | `/api/webhooks/zoom` | Receives `endpoint.url_validation`, `meeting.ended`, and `meeting.summary_completed` |
| `POST` | `/api/cron/call-summary-retry` | Cron-protected retry for pending/error Zoom summaries |

Webhook routes must be registered in `server.js` before mutation same-origin enforcement, like the existing DoubleTick/Gmail/Zoho webhook routes.

## Calendly Integration

### Scheduling link and correlation

The booking link sent to the GP must include a durable correlation token tied to `scheduled_calls.id`.

Preferred approach:

```
{CALENDLY_EVENT_URL}?utm_source=gplink&utm_medium=registration_call&utm_content=call_{correlation_token}
```

During implementation, verify the actual Calendly webhook payload includes the selected tracking field. If it does not, use a required prefilled custom question or fetch invitee details from Calendly's API to recover the correlation data. Email-only matching is fallback only.

### Calendly webhook handler (`invitee.created`)

1. Read raw body.
2. Verify `Calendly-Webhook-Signature` with `CALENDLY_WEBHOOK_SECRET` and reject stale timestamps.
3. Deduplicate with provider event id or raw-body hash.
4. Parse payload and ignore non-GP Registration Assistance event types.
5. Extract `correlation_token` from tracking/custom answer data.
6. Match to `scheduled_calls` by correlation token. Fallback: `calendly_invitee_uri`, then email + latest `invited` record only if unambiguous.
7. Fetch scheduled event/invitee details from Calendly API when required to get full event, timezone, location, and Zoom details.
8. Update record: `status` → `booked`, populate `scheduled_at`, `booked_at`, `timezone`, `calendly_event_uri`, `calendly_invitee_uri`, `invitee_email`.
9. Extract Zoom meeting details from Calendly location data if present (`zoom_meeting_id`, join URL, passcode).
10. Update linked `registration_tasks` status to `waiting` and merge call metadata.

### Calendly webhook handler (`invitee.canceled`)

1. Verify signature and deduplicate.
2. Match by `calendly_invitee_uri`.
3. If payload indicates `rescheduled: true`, store `calendly_old_invitee_uri` and wait for the paired `invitee.created`; do not mark the call finally cancelled.
4. If not rescheduled, update `scheduled_calls.status` → `cancelled`, set `cancelled_at`.
5. Update linked `registration_tasks.status` → `cancelled`.
6. Optionally notify admin in-app.

## Zoom Integration

### Webhook handler (`endpoint.url_validation`)

Zoom requires challenge-response validation when configuring the webhook endpoint and periodically after that.

1. Read raw body and parse JSON.
2. If `event === "endpoint.url_validation"`, HMAC-SHA256 the `payload.plainToken` with `ZOOM_WEBHOOK_SECRET`.
3. Return `{ plainToken, encryptedToken }` within 3 seconds.

### Webhook signature verification

For non-validation events:

1. Read raw body.
2. Use `x-zm-request-timestamp` and raw body to compute `v0:{timestamp}:{rawBody}`.
3. HMAC-SHA256 with `ZOOM_WEBHOOK_SECRET`.
4. Compare timing-safely with `x-zm-signature`.
5. Reject stale timestamps and duplicate webhook events.

### Zoom webhook handler (`meeting.ended`)

1. Verify webhook signature.
2. Match by `zoom_meeting_id` or `zoom_meeting_uuid`.
3. Update `scheduled_calls.status` → `completed`, set `completed_at`, set `summary_status` → `pending`.
4. Update linked task to `completed` only after the call is ended; task metadata can show `summary_status: pending`.
5. Do not rely on an in-memory `setTimeout()` after responding to Zoom. Store state and let `meeting.summary_completed` or retry cron fetch the summary.

### Zoom webhook handler (`meeting.summary_completed`)

1. Verify webhook signature.
2. Match by meeting id/UUID.
3. Fetch `GET /v2/meetings/{meetingId}/meeting_summary` using Server-to-Server OAuth.
4. If the meeting UUID begins with `/` or contains `//`, double-encode the UUID for API calls.
5. Save `summary_content` to `meeting_summary`.
6. Save `next_steps` and any parsed action items to `meeting_action_items`.
7. Save full payload to `meeting_summary_raw`.
8. Set `summary_status` → `saved`, `summary_saved_at` → now.
9. If the API returns 403/404/429 or a summary is not ready, set `summary_status` to `pending` or `error` with retry metadata.

### Summary retry cron

`/api/cron/call-summary-retry` should:

- Require `CRON_SECRET` or equivalent authorization.
- Find calls with `status = completed` and `summary_status IN ('pending','error')`.
- Retry with capped exponential backoff.
- Stop after a defined attempt limit and mark `summary_status = not_available` when Zoom never produces a summary.

## UI Components

### 4a. "Schedule Zoom Call" Button

Location: GP case header, in the `d-actions` row alongside existing case action buttons.

Styled as a Zoom-branded button (blue #2D8CFF background, white text, camera icon).

### 4b. Schedule Modal

Triggered when admin clicks the button. Contents:

- **GP info block** (read-only): avatar, name, email, phone
- **Stage dropdown**: MyIntealth / AMC / AHPRA — defaults to GP's current stage
- **Internal notes textarea**: clearly labelled "Admin only — GP won't see this"
- **Notification checkboxes**: WhatsApp + Email (both checked by default)
- **Submit button**: "Send Calendly Invite"

### 4c. Task on Case (Tasks tab)

A Zoom-specific task card renders from `scheduled_calls.status`, not only `registration_tasks.status`:

- **Invited**: "Waiting for GP to book a time" — shows resend link button, time since invite sent
- **Booked**: Blue Zoom card with date/time, stage, admin notes, "Join Zoom" button, reschedule/cancel actions
- **Completed, summary pending**: Completed call with "Summary processing" state
- **Completed, summary saved**: Green card with "View Summary" expandable admin-only section
- **Completed, summary unavailable/error**: Show retry button and last error to admin
- **Cancelled**: Greyed out with "Reschedule" option
- **No-show**: Red-flagged with "Reschedule" option

### 4d. Scheduled Calls Tab (top-level admin view)

New tab in the admin top-level navigation alongside Ops Queue / GPs / Support / Guide.

Layout:

- **Header**: "Scheduled Calls" title + count of this week's booked calls
- **Filter pills**: All / MyIntealth / AMC / AHPRA
- **Time filters**: Today / This Week / Later / Needs Summary
- **Call rows grouped by date**: Today → This Week → Later → Unbooked Invites
- Each row shows: date/time block, GP name, stage pill, admin notes preview (truncated), status badge, summary badge, Join/View button
- Clicking a row navigates to that GP's case detail and auto-opens Tasks tab

### 4e. Call History Section (Admin GP case detail)

New admin-only section on the GP's case detail view, below Tasks.

- Shows completed calls for this GP in reverse chronological order
- Each entry: date, stage, admin pre-call notes, Zoom AI Companion summary, action items
- Expandable/collapsible per call
- Multiple calls stack
- Never rendered in GP-facing pages or APIs in this scope

### 4f. AI Profile Summary Integration

The existing admin AI summary system that generates GP profile overviews can include call history as context:

- Number of assistance calls
- Topics discussed from admin notes and Zoom summary
- Outstanding action items
- Summary status for recent calls

The prompt must label this context as internal admin call history and must not include unsupported conclusions. If a future GP-facing AI summary is built, admin notes must be excluded or redacted first.

## External Service Requirements

### Calendly (paid plan required)

- **Event type**: "GP Registration Assistance" — 30 min, Zoom video integration enabled
- **Availability**: Admin sets recurring weekly availability in Calendly directly
- **Webhook**: Subscribe to `invitee.created` and `invitee.canceled`, pointing to `/api/webhooks/calendly`
- **Scope**: single shared Calendly account for this phase
- **Auth**: Personal Access Token with required read/webhook scopes
- **Setup validation**: test that webhook payload includes event type, invitee URI, tracking/correlation data, timezone, and Zoom location data

### Zoom (Workplace Pro or higher for AI Companion)

- **AI Companion**: Enable "Meeting summary with AI Companion"
- **Webhook events**: Subscribe to `meeting.ended` and `meeting.summary_completed`
- **Webhook validation**: Endpoint must support `endpoint.url_validation`
- **Server-to-Server OAuth app**: Same app can be used as career interviews only if scopes are expanded
- **Required summary scopes**: `meeting_summary:read:admin` or the current granular equivalent (`meeting:read:summary:admin`)
- **Settings caveats**:
  - End-to-end encrypted meetings do not support summaries.
  - Disable settings that restrict summary access to email only if API retrieval is needed.
  - Confirm any Zoom IP access-control setting does not block Vercel.
- **API**: `GET /v2/meetings/{meetingId}/meeting_summary`

### DoubleTick (WhatsApp)

- New approved template: `zoom_call_invite`
- Template placeholders: GP first name, stage display name, Calendly booking link
- Existing `sendDoubleTickTemplate()` only handles stage/name templates; implementation should add a dedicated `sendDoubleTickZoomCallInvite()` helper rather than forcing this through the old function signature.
- Store returned DoubleTick message id where available.

### Resend (Email)

- New email template with Calendly booking link, stage context, and call purpose
- Uses existing `sendEmail()` function
- Store returned message id if Resend response exposes it
- Email must not include `admin_notes`

## Environment Variables

### New

| Var | Purpose |
|---|---|
| `CALENDLY_API_TOKEN` | Personal Access Token for Calendly API |
| `CALENDLY_EVENT_URL` | Public scheduling link for "GP Registration Assistance" |
| `CALENDLY_EVENT_TYPE_URI` | Event type URI used to filter webhook payloads |
| `CALENDLY_WEBHOOK_SECRET` | Signing key for Calendly webhook verification |
| `ZOOM_WEBHOOK_SECRET` | Zoom webhook secret token for validation and signatures |
| `CRON_SECRET` | Protects summary retry cron endpoint if not already configured |

### Existing (already configured for career interviews)

| Var | Purpose |
|---|---|
| `ZOOM_CLIENT_ID` | Zoom Server-to-Server OAuth |
| `ZOOM_CLIENT_SECRET` | Zoom Server-to-Server OAuth |
| `ZOOM_ACCOUNT_ID` | Zoom Server-to-Server OAuth |
| `DOUBLETICK_API_KEY` | WhatsApp messaging |
| `RESEND_API_KEY` | Email sending |

Also update `.env.example` with every new variable and note required Zoom summary scopes.

## Security and Privacy Requirements

- Admin endpoints require `requireAdminSession`.
- Webhook endpoints must not require same-origin headers, but must verify provider signatures.
- Use raw request bodies for webhook signature verification; do not parse JSON first.
- Deduplicate webhook deliveries.
- Limit and sanitize all stored free text (`admin_notes`, summary errors, notification results).
- Validate outbound URLs before rendering or sending:
  - Calendly booking URL must be HTTPS and on an expected Calendly domain.
  - Zoom join URL must be HTTPS or an approved Zoom deep-link scheme where needed.
- Do not log secrets, full webhook signatures, passcodes, or full join URLs.
- `admin_notes`, `summary_error`, and internal notification results are admin-only.
- RLS: `scheduled_calls` should be service-role/admin-only for this phase; no GP read policy until a separate GP-facing design exists.

## Setup Instructions (for admin)

Detailed step-by-step setup guides will be provided during implementation for:

1. **Supabase migration** — Create `scheduled_calls`, optional `webhook_events`, indexes, RLS, and add `zoom_call` to `registration_tasks_task_type_check`
2. **Calendly paid setup** — Create event type, enable Zoom integration, generate API token, configure webhook, confirm correlation token appears in payload
3. **Zoom AI Companion setup** — Enable meeting summaries, add webhook endpoint, handle validation, subscribe to `meeting.ended` and `meeting.summary_completed`, verify summary scopes
4. **DoubleTick template** — Submit `zoom_call_invite` with exact placeholder order
5. **Vercel env vars** — Set all new variables and redeploy
6. **Smoke test** — Schedule a test invite, book it, reschedule it, cancel it, complete a short call, and confirm summary retry behavior

## Test Plan

- Unit-test status mapping from `scheduled_calls.status` to `registration_tasks.status`.
- Unit-test Calendly signature validation with raw body.
- Unit-test Zoom signature validation and `endpoint.url_validation` response.
- Webhook idempotency test: duplicate Calendly/Zoom payloads do not duplicate calls or tasks.
- Calendly reschedule test: `invitee.canceled` with `rescheduled=true` does not mark the call finally cancelled.
- Summary retry test: pending summary is retried and eventually becomes `saved` or `not_available`.
- Privacy test: GP-facing payloads never include `admin_notes`, `summary_error`, or internal notification metadata.
- Admin UI smoke test: invite, booked, completed/pending summary, completed/saved summary, cancelled, and no-show cards all render.

## Out of Scope

- GP-initiated call requests (GP cannot request a call themselves — admin-only)
- Multiple admins / admin-specific Calendly accounts (single shared Calendly account)
- GP-facing call history or GP-visible call summaries
- Call recording storage (Zoom handles recording; we only store the AI summary)
- SMS notifications (WhatsApp + Email only)
- Custom call durations (fixed 30 min)
