# Support Ticket Grouping + Honest Names — Design

**Date:** 2026-07-09
**Status:** Approved ("yes code and deploy"), implemented on `worktree-support-ticket-grouping`.

## Problem

The CEO/RSO **Support** tab showed:
1. **Duplicate tickets** — every inbound WhatsApp message that looked like a help
   request created its own ticket (4 from one contact within ~90 seconds).
2. **"Unknown"** in the GP column for every WhatsApp/email item, even for known GPs.

Root causes (see investigation): WhatsApp/email "tickets" are `registration_tasks`
(`whatsapp_help` / `email_triage`) merged into the ticket list only at display time.
There was no "does this person already have an open ticket on this channel today?"
check — only per-message idempotency. And the merged endpoint forced `user_id = null`
on WhatsApp/email items, then resolved names by `user_id` only, so they never matched.

## Requirements (confirmed with owner)

- Group a person's messages **on the same channel** into ONE ticket within a
  **sliding 24h window** (each new message resets the timer). A **different channel**
  (e.g. WhatsApp vs email) is a **separate** ticket.
- GP column: known in-app GP → their real name; not-on-app sender → **"EXTERNAL (Not on App)"**.
  Never "Unknown". Titles keep the person's name.
- One-time **merge** of existing duplicates.

## Design

### 1. Grouping at ingestion (sliding 24h, per person + channel)

- **WhatsApp** (`server.js` DoubleTick webhook): before creating a `whatsapp_help`
  task, look for an OPEN one from the same contact — keyed by
  `doubletick_conversation_url` (per phone), with a `case_id` fallback for
  registered GPs — whose `updated_at` is within `SUPPORT_GROUP_WINDOW_MS` (24h). If
  found, append the message to `task_messages` and bump `updated_at` (slides the
  window); do not create a new task.
- **Email** (`server.js` Gmail triage): before `_createRegTask`, look for an OPEN
  `email_triage` task with the same sender address, scoped to the same case (or the
  caseless Support pool), within 24h. If found, reuse it (matched-case emails append
  via the existing hub-message insert; caseless append directly).
- **In-app**: left as discrete per-submission (each is a deliberate, categorised
  form submission — not a message flood). Noted for owner; easy to extend if wanted.

### 2. Honest names at display

`supportDisplayName(profile, opts)` → `{ name, isExternal }`. In the merged
`/api/admin/va/support` endpoint, WhatsApp/email items with no `user_id` are resolved:
- WhatsApp → match by phone (`findUserProfileByPhone`); fallback to a **unique**
  full-name match (`findUserProfileByFullName`) for a known GP who messaged from a
  number not on file.
- Email → match by sender address (`findUserProfileByEmail`).
- Matched → real name; unmatched → `EXTERNAL (Not on App)` (+ `is_external` flag).
The sibling `/api/admin/va/tickets` and CEO `/api/ceo/rso/:id/support` (both in-app
`support_tickets`, always a registered user) use the email fallback, never "Unknown".
Client fallbacks in `admin.html` / `ceo-dashboard.html` updated to match.

### 3. One-time cleanup

A logged script clusters existing OPEN caseless WhatsApp/email tickets by person +
channel with the same sliding-24h rule, keeps the earliest, and cancels the rest
(they drop off the Open list, remain under Closed; a `task_messages` + `task_timeline`
record preserves the audit trail).

## Testing

Pure helpers (`supportDisplayName`, `isWithinGroupingWindow`, `extractEmailAddress`,
`phoneFromSupportItem`, `contactNameFromSupportItem`) exported via `__testUtils` and
covered by `tests/support-grouping-and-names.test.js`. Full suite must stay green.

## Verified

Against live data: 4 same-contact WhatsApp tickets (within 90s) folded to 1; two
17-days-apart tickets correctly kept separate; Smith Miller (known GP, unregistered
WhatsApp number) resolves to "Smith Miller" via name fallback; Nohier Jackman (no
profile) → "EXTERNAL (Not on App)".
