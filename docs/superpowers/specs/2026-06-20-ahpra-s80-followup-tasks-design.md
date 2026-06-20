# AHPRA Section 80(1)(b) Follow-Up Tasks — Design

**Date:** 2026-06-20
**Status:** Approved for implementation
**Test account:** Smith Miller (`smithmiller1234@gmail.com`)

## Plain-words summary

After a GP submits their AHPRA application, an AHPRA officer often replies with a
**"Notice to provide further information under section 80(1)(b)"** — an email
listing extra documents and clarifications they need before they can decide the
application. Today that email lands in our inbox and a human has to read it,
work out who does what, and chase the GP manually.

This feature turns that one email into a tidy, checkable set of tasks — some the
GP does themselves, some the team does behind the scenes — and keeps everyone
moving toward the single deadline AHPRA gave. The team always checks the
computer's reading of the email **before** anything reaches the GP, so nothing
wrong or half-understood ever gets shown to the doctor.

## Goals

1. Read an inbound AHPRA s80 notice and split it into clearly-owned items
   **without dropping any detail** the officer wrote.
2. Let the team review/edit/reassign those items in a holding tray, then
   **Release** them in one action.
3. Show the GP only their items, on their AHPRA page, with the right action for
   each (upload a file, or request a document from their institution and mark it
   done).
4. Handle the harder items as **team-owned** work: the supervised practice plan
   (SPPA-00) and the qualification/PSV check (which becomes a guided Zoom call).
5. When the GP finishes their institution-request items, generate **one combined
   reply** on the original AHPRA email thread for the team to send.
6. Drive urgency from **one shared deadline** for the whole notice.

## Non-goals (YAGNI)

- No automatic sending of email to AHPRA. Every outbound reply is a **draft** a
  human reviews and sends. (AHPRA correspondence is high-stakes; humans stay in
  the loop.)
- No automatic detection that AHPRA "received" an institution-direct document.
  AHPRA does not confirm receipt automatically, so we ask them to confirm via the
  combined reply.
- No new GP-facing payment/visa flows. This is purely the s80 follow-up loop.
- No change to how AHPRA emails are first detected as AHPRA (that already works).

## How an AHPRA notice maps to tasks (the worked example)

Using the real notice sent about Smith Miller (ref 1460970), the officer asked
for five things. Here is exactly how each becomes a task and who owns it:

| # | What AHPRA asked for | Owner | Action in the app |
|---|---|---|---|
| 1 | Certificate of Good Standing (from GMC) | **GP** | *Request-from-institution*: GP requests it from GMC, taps "Mark complete" |
| 2 | Qualification check / PSV (ECFMG·EPIC + AMC) | **Team** | Book a **guidance Zoom call** to walk the GP through MyIntealth / AMC and pin down the exact issue |
| 3 | English test confirmation (IELTS/OET) | **GP** | *Request-from-institution*: GP asks the test body to confirm, taps "Mark complete" |
| 4 | English language reference letters (OET > 2 yrs old) | **GP** | *Upload*: GP uploads employer reference letters → team reviews/approves |
| 5 | Supervised Practice Plan (SPPA-00) attachments | **Team** | Team completes via the existing practice pack; never shown to the GP |

### Item 5 detail — the anti-information-loss requirement

The notice did **not** just say "sign the practice plan." It named five specific
attachments. The extraction must capture every one of them as its own checkable
sub-item:

- A **signed & dated CV of the primary supervisor** (required at Q3 of SPPA-00)
- A **signed & dated CV of the alternate supervisor(s)** (required at Q4 of SPPA-00)
- If applicable, **details on how potential conflicts of interest** will be managed
- **Position description** for the proposed role(s) (required at Q10 of SPPA-00)
- **Section G attachment** — supervised practice goals and activities
- …all **certified where necessary**, returned by email or via the AHPRA portal

These map onto doc keys the practice pack already uses (`supervisor_cv`,
`position_description`, `section_g`), so item 5 plugs into existing machinery.

## Extraction fidelity (no dropped detail) — core principle

This is a hard rule, not a nice-to-have. The current AI extraction summarises
each item into one line and can drop sub-points (as it did with SPPA-00).

Requirements:

1. **Full detail per item.** The model must return, for every requested item, the
   complete requirement text — all sub-bullets, every form reference (e.g. "Q3 of
   SPPA-00"), certification notes, and submission method ("return email or AHPRA
   portal"). Stored verbatim on the task as `detail` (long text), separate from a
   short `title`.
2. **Sub-items for multi-part requests.** When an item lists several attachments
   (like SPPA-00), each named attachment becomes its own checkable line so nothing
   hides inside a summary.
3. **Original letter always attached.** The full original email body is stored on
   the bundle and shown to the team during review, side-by-side with the extracted
   items, so a human can catch anything the model missed and add it before release.
4. **Budget headroom.** The model call must have enough output budget to return
   full detail (raise `max_tokens`; current 1000 is too small for a long notice)
   and must **fail loud, not silent** — if extraction returns nothing, the bundle
   is still created from the raw email and flagged "needs manual split," never
   silently dropped.

## The flow, end-to-end

```
AHPRA s80 email arrives in monitored inbox
        │
        ▼
[1] Detected as AHPRA (existing) → identify the GP's case (Smith Miller)
        │
        ▼
[2] AI extraction (improved): one bundle =
      { reference, deadline, original_email_body,
        items:[ { title, detail, owner, mode, sub_items[] } ... ] }
        │
        ▼
[3] Holding tray (NOT visible to GP yet) — "AHPRA requested more info — ref 1460970"
      Team reviews each item next to the original letter:
        • edit title/detail
        • change owner (gp / team)
        • change mode (upload / request-from-institution / team)
        • add a missed sub-item
        • set/confirm the shared deadline
        │
        ▼  team clicks  ── Release ──►
        │
        ├──► GP items become visible on the GP's AHPRA page
        └──► Team items activate as team tasks (PSV Zoom call, SPPA-00 pack)
        │
        ▼
[4] GP works their items:
      • Upload items   → file → team review → approve/reject (existing pipeline)
      • Request items  → GP requests from institution → taps "Mark complete"
        │
        ▼
[5] When ALL the GP's request-from-institution items are marked complete →
      one team task appears: "Reply to AHPRA to confirm receipt"
      with a ready draft on the ORIGINAL email thread:
        - confirms the institution-direct items (GMC cert, English confirmation)
        - team can attach the approved uploads + signed SPPA-00 docs
        - asks the officer to confirm receipt of the institution-direct items
      Team reviews the draft and sends it. (No auto-send.)
        │
        ▼
[6] One shared deadline drives reminders/urgency for the whole bundle until done.
```

## Data model (as built)

No database migration is needed. Each item is a `registration_tasks` row with
`task_type = 'ahpra_action_item'` (an already-allowed type) and **all new state
held in the existing `metadata` jsonb column**, so existing tasks and the table
schema are completely unaffected. The `metadata` shape:

- `s80: true` — marks this as a section-80 follow-up item.
- `bundle_id` — groups all items from one notice. **Unique per officer message**
  (keyed on the Gmail message id, not the AHPRA reference, so follow-up notices
  for the same application don't collide). `reference` is kept for display only.
- `review_status` — `'pending_review'` in the holding tray, `'active'` after Release.
- `owner` — `'gp'` or `'team'`.
- `mode` — `'upload'`, `'request_institution'`, `'team'`, or `'reply'`.
- `detail` — the full verbatim requirement (fidelity rule).
- `sub_items` — array of `{ label, done }` for multi-part items (e.g. SPPA-00).
- `institution` — e.g. `GMC`, for request items and the draft.
- `gp_marked_complete_at` — set when the GP marks a request item complete.
- `upload` — `{ file_name, storage_path, status, reject_reason, … }` for upload items.
- `draft` — `{ subject, body }` for the combined-reply task.
- `original_email` — `{ subject, sender, body }`, the full letter (fidelity safety net).

The shared deadline is written to the existing `ahpra_deadline` (and `due_date`)
columns on every item; when extraction misses the date a 14-day target is used and
stored there so both UIs (which read `ahpra_deadline`) still show it. The original
officer email is also linked via a `task_messages` row per item for reply threading.

Tasks are Supabase-only (consistent with the rest of the tasks system; there is no
local-JSON task fallback).

## Components

1. **Extraction (`extractAhpraActionItems`, server.js)** — rewritten prompt +
   larger token budget + new return shape (full `detail`, `owner`, `mode`,
   `sub_items`), stores `original_email_body`, fails loud.
2. **Bundle creation (AHPRA task loop, server.js)** — creates tasks as
   `review_status='pending_review'` under one `bundle_id` instead of going live
   immediately; attaches `case_id`; copies the shared `deadline` onto each.
3. **Holding tray + Release (admin.html + server.js)** — a "needs review" group
   showing the bundle next to the original letter; edit/owner/mode/add-sub-item
   controls; a **Release** endpoint that flips the bundle to `active`, makes GP
   items visible, and activates team items.
4. **GP AHPRA inbox (ahpra.html + server.js)** — lists the GP's released items
   with the correct action per `mode`; upload reuses the existing document
   pipeline; request-items show a "Mark complete" button.
5. **Combined reply generator (server.js)** — when all request-items in a bundle
   are `gp_marked_complete`, create the "Reply to AHPRA to confirm receipt" team
   task with a generated draft on the original thread.
6. **PSV Zoom task (server.js + admin.html)** — the PSV item is a team task whose
   action links to the existing meeting/Calendly/Zoom booking so the team books a
   guidance call with the GP.
7. **SPPA-00 team item (server.js)** — a team task carrying the five named
   sub-items, tied to the existing practice-pack doc keys.
8. **Shared deadline + nudge (server.js + ahpra.html)** — one deadline on the
   bundle; on Release, the GP gets an in-app notification (existing updates-sync)
   plus the existing nudge channel.
9. **Manual ingest (server.js + admin.html)** — a "Log AHPRA letter" button +
   modal lets the team paste a letter that arrived outside the monitored inbox
   (or forward a GP-received notice). It runs the exact same extraction + bundle
   path, so the team always gets the same reviewed tray. This is also the test
   entry point for Smith Miller.

## Error handling

- **Extraction returns empty / errors:** still create the bundle from the raw
  email, mark it "needs manual split," surface in the holding tray. Never silently
  drop a notice. Log loudly.
- **No case_id for the GP:** create/repair the AHPRA-stage case first
  (`_ensureRegCase`); if the user is staff/admin, do not create a GP case (per
  existing `_ensureRegCase` guard).
- **Duplicate notice (same reference re-sent):** dedup by `bundle_id` /
  `reference` so a re-sent email doesn't create a second bundle; new items append.
- **Release with unowned/unmoded items:** block Release until every item has an
  owner and mode (team must resolve in the tray).
- **GP marks complete then re-opens:** allow un-marking before the combined reply
  is sent; once the reply task exists, lock to avoid confusion.

## Testing

- Unit: extraction returns full `detail` + `sub_items` for the SPPA-00 example
  (assert the five named attachments survive); empty-extraction fail-loud path.
- Unit: Release flips review_status and visibility; combined-reply task only
  appears when ALL request-items are complete.
- Integration (Smith Miller): seed a real AHPRA-stage case, feed the real s80
  email, confirm a holding-tray bundle with five correctly-owned items and full
  SPPA-00 detail; Release; confirm GP page shows three GP items; mark the two
  request-items complete; confirm the single combined-reply draft task appears.
- Manual browser pass on the GP AHPRA page and the admin holding tray (noted
  explicitly as manual; not claimed as automatic).

## Test-account setup (Smith Miller)

1. Fix the expired bypass for `smithmiller1234@gmail.com` (three places:
   server.js, `js/bypass-config.js`, `pages/ahpra.html`) — extend the timestamp.
2. Seed a real AHPRA-stage `registration_case` so created tasks have a `case_id`.
3. Use the real notice email body (ref 1460970) as the extraction input.

## Rollout

Ship behind the normal deploy (push to `main` → Vercel builds prod). The feature
only activates on inbound AHPRA s80 emails and the new GP/admin UI; existing tasks
are untouched because new columns are nullable/defaulted. Adversarial code review
runs before deploy.
