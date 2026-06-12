# Unified Call Task on the GP Profile — Design

**Date:** 2026-06-12
**Status:** Approved (design), pending implementation plan

## Problem

The admin GP profile **Tasks** tab currently shows two overlapping things for Zoom assistance calls:

1. A plain `zoom_call` task card (`Zoom Assistance Call — AHPRA`) with a generic **Complete** button and `…` menu.
2. A separate **"SCHEDULED CALLS"** section injected at the bottom of the pane, rendering a rich card per scheduled call (Time, RSO, Calendly link, ADMIN NOTES, GP'S BOOKING NOTES, status badge, Cancel/Reschedule/etc.).

This duplicates information, and the rich "SCHEDULED CALLS" block belongs to the dedicated **Calls** tab that already exists on the profile. The plain task card carries none of the useful call context or actions.

## Goal

The call task **is** the scheduled call. One card on the Tasks tab that reflects the **most recently scheduled call** for that stage, carrying the same details and actions the current scheduled-call card has. The standalone "SCHEDULED CALLS" block is removed. The call's lifecycle (booked → completed/cancelled) drives whether the task appears.

## Current code (reference)

| Component | File | Lines |
|-----------|------|-------|
| Task pane render (filters out completed/cancelled) | `pages/admin.html` | 2604–2768 (filter at 2605) |
| `injectZoomCallsIntoTasksPane()` + "SCHEDULED CALLS" block | `pages/admin.html` | 2765–2766, 8881–8895 |
| `renderZoomTaskCard()` (rich call card) | `pages/admin.html` | 8775–8829 |
| Calls tab pane (`renderGpCallHistoryPane` / `loadCallHistoryPane`) | `pages/admin.html` | 8974–9053 |
| `POST /api/admin/calls/schedule` (creates task + call) | `server.js` | 24948–25091 (task create at 25034) |
| `PATCH /api/admin/calls/:id` (status sync) | `server.js` | 25139–25248 |
| Zoom `meeting.ended` → task completed + summary | `server.js` | 12996–13037 |
| Calendly cancel/reschedule handler | `server.js` | 12828–12890 |
| `CALL_STATUS_TO_TASK_STATUS` map | `server.js` | 402–412 |

## Design

### 1. Remove the standalone "SCHEDULED CALLS" block from the Tasks pane

- Remove the `injectZoomCallsIntoTasksPane(c.id)` call and its container (`pages/admin.html:2765–2766`).
- `injectZoomCallsIntoTasksPane()` and `renderZoomTaskCard()` are no longer used by the Tasks pane. The equivalent rich rendering moves into the task card itself (§3). Keep `renderZoomTaskCard` only if reused by the Calls tab; otherwise remove to avoid dead code. (The Calls tab uses its own `loadCallHistoryPane` renderer, so `renderZoomTaskCard` is expected to become dead and should be removed.)
- The dedicated **Calls** tab is unchanged and remains the full call history + summary view.

### 2. One persistent call task per stage (backend)

In `POST /api/admin/calls/schedule` (`server.js:25034`), before creating a registration task:

- Look up an existing **open** `zoom_call` task for the same `(case_id, related_stage)` — "open" = status not in `completed`/`complete`/`cancelled`.
- **If found:** reuse it. Relink it to the new `scheduled_calls` row (set `scheduled_calls.registration_task_id` to the existing task id) and reset its status to `waiting_on_gp`, title to `Zoom Assistance Call — {StageDisplay}`. Do **not** create a second task.
- **If not found:** create the task as today.

Result: there is at most one `zoom_call` task per stage. The card reflects the **most recent** `scheduled_calls` row whose `registration_task_id` points at that task (order by `created_at desc`).

### 3. The unified call task card (Tasks tab)

`renderGpTasksPane` branches on `t.task_type === 'zoom_call'` and renders the rich card (same visual as today's scheduled-call card) instead of the generic `st-title` + Complete layout. Card data comes from the most-recent linked `scheduled_calls` row.

Card contents:
- **Avatar + title:** `Zoom Assistance Call — {StageDisplay}` (stage cased to display name, e.g. `AHPRA`, not `ahpra`).
- **Status badge** (top-right): Invited / Booked / Completed / Cancelled / No Show.
- **Time** (or "Not yet booked"), **RSO**, Calendly **View event** link, **Join Zoom** link (when booked).
- **ADMIN NOTES** block, **GP'S BOOKING NOTES** block.
- **Status-driven actions** (same set the card has today):
  - `invited`: Resend Invite, Cancel
  - `booked`: Cancel, Reschedule, Mark No Show, Join Zoom
  - `no_show`: Schedule new call (reschedule)
  - `cancelled`: Schedule new call (see §4)
- The generic **Complete** button and `…` menu are replaced by the call actions. A manual **"Mark complete"** is kept in an overflow menu as an escape hatch for edge cases.

Data plumbing: the Tasks pane needs the scheduled-call data for its `zoom_call` tasks. Fetch calls for the case alongside tasks (the Tasks pane already has `c.id`; reuse the existing `GET /api/admin/calls?case_id=` shape) and match by `registration_task_id`. Prefer loading once when the pane renders rather than per-card.

### 4. Lifecycle

| Event | Backend today | Card behaviour |
|-------|---------------|----------------|
| Booked → Completed (Zoom `meeting.ended`) | task → `completed`, AI summary saved (`server.js:12996`) | Card **disappears** from Tasks (filter `admin.html:2605`). Completed call + summary visible in **Calls** tab. ✔ |
| Calendly true cancel (`rescheduled=false`) | call → `cancelled`, task → `cancelled` (`server.js:12887`) | **Change:** keep task **open** so it stays on Tasks as "Cancelled — needs rebooking" with a **Schedule new call** action. `scheduled_calls` row stays `cancelled`. |
| Calendly reschedule (`rescheduled=true`) | call reset to `invited`, fresh booking URL | Card shows "Not yet booked / waiting on GP." ✔ no change. |
| Mark No Show | call → `no_show`, task → `waiting_on_gp` | Card shows "No Show — reschedule." ✔ no change. |

**Cancellation change detail:** the only behavioural backend change is that a true cancel must **not** close the task. Today cancel maps the task to `cancelled` (via `CALL_STATUS_TO_TASK_STATUS` and/or the Calendly handler). After this change, on a true cancel the `scheduled_calls` row is set to `cancelled` but the linked task is set/left to an **open** status (`waiting_on_gp`) so it remains visible as "needs rebooking." This applies to both the Calendly webhook cancel (`server.js:12887`) and the admin UI Cancel action (`PATCH /api/admin/calls/:id`, `server.js:25181`). The card detects the `cancelled` call status and renders the "needs rebooking" state.

### 5. Summary attachment

No new storage. The Zoom AI summary already lives on `scheduled_calls.meeting_summary` and is rendered in the Calls tab (`admin.html:9035`). Since the completed task disappears from Tasks, the summary is consumed from the Calls tab. "Summary attached to the task" is satisfied by the linked `scheduled_calls` row.

## Out of scope

- No change to the Calls tab rendering or the scheduled-call panel at the top level.
- No change to Zoom/Calendly webhook plumbing beyond the cancel-keeps-task-open behaviour.
- No new database columns.

## Acceptance criteria

1. The "SCHEDULED CALLS" section no longer appears at the bottom of the Tasks tab.
2. A `zoom_call` task renders as the rich card (Time, RSO, Calendly, notes, status badge, status-driven actions) matching the current scheduled-call card design.
3. Scheduling a second call for the same stage updates the single existing call task rather than creating a second one.
4. Completing a call via Zoom removes the task from Tasks; the summary is viewable in the Calls tab.
5. Cancelling a call leaves the task on the Tasks tab in a "Cancelled — needs rebooking" state with a Schedule-new-call action.
6. Rescheduling and No Show keep the task open with the correct state, as today.
