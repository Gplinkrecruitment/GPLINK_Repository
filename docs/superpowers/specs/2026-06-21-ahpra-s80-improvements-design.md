# AHPRA s80 "Request for More Information" — Efficiency, Accuracy & Clarity Upgrade

**Date:** 2026-06-21
**Status:** Approved design — ready for implementation planning
**Branch:** `worktree-ahpra-s80-improvements` (based on prod `main`, which already contains the live s80 feature)

---

## Plain-English summary

When AHPRA emails a doctor asking for more information, our team logs the letter, the
system splits it into items, an admin decides for each item **who** does it and **how**,
releases it, the doctor acts, and the team replies to AHPRA. This upgrade makes that whole
loop **faster for admins, more accurate, clearer for the doctor, and harder to let things
slip** — by:

1. Using the **newest AI model** with a **confidence score + reason** on every item.
2. **Auto-handling** the items the AI is very confident about (releasing, approving uploads,
   and sending the AHPRA reply), while anything uncertain still goes to a human.
3. **Closing the biggest gap** — today a doctor just *ticks* "I requested it" and nobody
   confirms the institution actually sent it to AHPRA. We add proof, AI thread-watching, and
   automatic chasing so nothing silently slips past the deadline.
4. Making the doctor's page **clear**: progress, deadline countdown, plain statuses, and a
   loud reminder to CC the team on AHPRA emails.

Everything automatic is **logged to the case timeline and notifies the assigned RSO**, and
anything below the confidence line falls back to today's human-in-the-loop flow.

---

## Current system (what exists today, for reference)

Authoritative source files (all already in prod `main`):

- `lib/ahpra-s80.js` — pure logic: extraction prompt, item normalisation, ownership rules,
  combined-reply draft. Owners `['gp','team']`; modes `['upload','request_institution','team']`.
  `mode==='team'` ⇒ `owner='team'` and vice-versa (the two are kept consistent).
- `server.js`:
  - `_createAhpraS80Bundle(...)` — shared by the live Gmail pipeline and the manual-ingest
    endpoint; creates tasks with `task_type='ahpra_action_item'`, `metadata.s80=true`,
    `metadata.review_status='pending_review'`, status `'waiting'`.
  - `POST /api/admin/ahpra/ingest-manual` — paste-a-letter entry point.
  - `POST /api/admin/ahpra/release` — sets `review_status='active'`; GP items →
    `status='waiting_on_gp'`, team items → `status='open'`; notifies GP only if ≥1 GP item.
  - `POST /api/admin/ahpra/item/review` — admin approve/reject of a GP upload.
  - `GET /api/admin/ahpra/item/file` — signed URL to view a GP-uploaded file.
  - `GET /api/ahpra/more-info` — GP-facing list (returns only `owner==='gp'` +
    `review_status==='active'` items; always uses `gp_instructions`, never the officer's raw
    words).
  - `POST /api/ahpra/more-info/mark-complete` — GP marks a request-institution item done;
    when all are done, auto-creates the combined-reply team task (`mode='reply'`).
  - `PUT /api/ahpra/more-info/upload` — GP uploads a file for an upload item.
  - Daily reconciliation cron — AI-checks whether follow-up tasks were fulfilled (Gmail /
    DoubleTick / app state).
- `pages/admin.html` — `renderS80Tray` (holding tray + Who/How dropdowns + Release),
  `renderS80Active` (in-progress view), the change handler (`data-s80-owner` / `data-s80-mode`,
  auto-syncs team), action handlers (release/review/complete/book-call/copy).
- `pages/ahpra.html` — `renderAhpraMoreInfoCard` / `ahpraMoreInfoItemHtml` (GP card),
  `wireAhpraMoreInfo`, `handleAhpraMark`, `handleAhpraUpload`.

**Known gaps this upgrade targets:** capture is half-manual; every item is re-decided by
hand; upload review is all-manual with no AI assist; the reply is copy-pasted into Gmail;
"request from institution" is self-certified with no confirmation (silent-failure risk); the
GP sees a flat list with no progress, countdown, or visibility of team-handled work.

---

## Cross-cutting foundation

### AI model
- All s80 AI calls use **`claude-opus-4-8`** (newest).
- **Remove the `temperature` parameter** from these calls — Opus 4.7/4.8 reject it (HTTP 400).
  (Confirmed by both the claude-api reference and project memory "temperature usage blocks
  Opus 4.7/4.8".) This is the change that unblocks using the newest model.
- Prefer **structured outputs** (`output_config.format` with a JSON schema) for the extraction
  and the new AI checks, so the JSON is guaranteed valid instead of regex-scraped. (Opus 4.8
  supports structured outputs; assistant-prefill is unavailable on this model family anyway.)

### Confidence + reason
- `buildExtractionPrompt` (in `lib/ahpra-s80.js`) gains two per-item fields in its JSON
  contract: `confidence` (0.0–1.0 — how sure the AI is of this item's `owner`/`mode`/`kind`)
  and `reason` (one short sentence). `normalizeItem` stores them in metadata as
  `metadata.ai_confidence` and `metadata.ai_reason`.
- A single tunable constant governs all automatic actions:
  `S80_AUTO_CONFIDENCE = 0.92` (server-side; one place to change).

### Audit + notify (applies to every automatic action)
- Every auto-action writes a case-timeline event via the existing `_logCaseEvent(...)` and
  pushes a notification to the assigned RSO. Nothing automatic is silent.

---

## Part A — Smarter capture & classification

**Goal:** stop re-deciding every item; auto-release the obvious notices.

1. **Reliable auto-ingest.** The live Gmail pipeline already feeds `_createAhpraS80Bundle`.
   Verify AHPRA "more information" emails route into it (triage classification), and that
   manual paste remains as the fallback. No new endpoint.
2. **Confidence + reason in the tray.** `renderS80Tray` shows, per item, a confidence badge
   and the one-line reason beside the Who/How dropdowns, so admins skim-and-trust.
3. **Auto-release.** In `_createAhpraS80Bundle` (after normalisation), if **every** item in
   the bundle has `ai_confidence >= S80_AUTO_CONFIDENCE` **and** none is a `needs_split` /
   unparsed / unknown-kind item, call the same release logic immediately instead of leaving
   the bundle in `pending_review`. Otherwise the bundle stays in the tray (today's behaviour).
   - Reuse the existing release transition (extract `_releaseS80Bundle(caseId, bundleId)` as a
     shared helper so both `POST /api/admin/ahpra/release` and auto-release call it).
   - Log "Auto-released (AI confidence ≥92%)" to the timeline + notify the assigned RSO.
   - Team-only items still just become team tasks; they were never GP-facing.

**Data:** no schema change — `ai_confidence` / `ai_reason` live in the JSON `metadata` blob,
consistent with the existing metadata-only s80 design.

---

## Part B — Faster admin review & one-click reply

**Goal:** make approving an upload a glance, and remove the copy-paste reply.

1. **AI upload pre-check.** When a GP uploads a file (`PUT /api/ahpra/more-info/upload`),
   run an Opus 4.8 check: *does this file match the requested item (title + detail)?* Returns
   `{matches:bool, confidence:0–1, reason:string}`, stored in `metadata.upload.ai_match`.
   - Reuse the existing document-AI plumbing where possible (`ensureDocReviewOnUpload`,
     `/api/admin/va/doc-review/ai-scan`, certified-copy detection) rather than a parallel path.
   - `renderS80Active` shows the verdict in the review row
     ("✓ Looks like the requested reference letter, 95%" / "⚠ Looks like a CV, not a
     Certificate of Good Standing").
   - **Auto-approve** when `ai_match.matches && ai_match.confidence >= S80_AUTO_CONFIDENCE`
     and (for documents that require it) certified-copy detection passes; else a human
     approves as today. Auto-approve logs + notifies RSO.
2. **Send the AHPRA reply from the app.** When the combined-reply task is ready, a
   **"Send to AHPRA"** action posts `buildCombinedReplyDraft` output on the original Gmail
   thread (`gmail_thread_id`) with the GP's **approved upload files attached**, then marks the
   reply task complete.
   - New backend: `POST /api/admin/ahpra/reply/send` (admin) and the underlying Gmail send.
   - **Prerequisite:** the app's Google integration must have **send** scope
     (`gmail.send`) for the team account. This is currently read/watch only — flag as an
     explicit setup step; the feature degrades to "copy draft / open Gmail" if send is
     unavailable.
   - Under the automation rule (Part E), this send can be automatic when confident; otherwise
     it's the one-click button.

---

## Part C — Closing the institution loop

**Goal:** never trust a bare "I requested it" tick again.

1. **Unmissable CC instruction (GP page).** A prominent banner on `pages/ahpra.html`'s
   more-info card: *"Whenever you email AHPRA — or ask an institution to email AHPRA — you
   MUST CC `<assigned-RSO address>`."* Show the exact address. This is required for the
   thread-watch to work; make it impossible to miss (top of the card + repeated on each
   request-institution item).
   - The CC address is the assigned RSO's monitored Gmail (from the case's assigned VA /
     `rso_team`); fall back to the team archive address if none.
2. **Proof upload.** For request-institution items, in addition to "Mark as requested," the GP
   can forward/upload the institution's "sent to AHPRA" confirmation. Stored on the item
   (`metadata.proof`), surfaced to the admin.
3. **AI thread-watch (extend the daily reconciliation cron).** For each active
   request-institution item, have the cron read the AHPRA email thread (now visible via the
   CC) with Opus 4.8 and detect: (a) AHPRA acknowledging receipt of the document → set
   `metadata.received_confirmed_at`, mark item satisfied; (b) AHPRA still listing it
   outstanding → flag for the RSO. Only act on high confidence; log evidence.
4. **Auto-chase.** Track `gp_marked_complete_at` vs `received_confirmed_at`. If an item is
   "requested" but not confirmed within **`S80_CHASE_DAYS = 7`**, auto-nudge the GP and alert
   the assigned RSO; escalate as the deadline approaches. Reuse the existing nudge mechanism.

**Data:** all new fields (`proof`, `received_confirmed_at`, chase timestamps) live in the
item's JSON `metadata` — no migration.

---

## Part D — Clearer GP experience

**Goal:** the doctor always knows what's done, what's left, and by when.

On `pages/ahpra.html`'s more-info card (`renderAhpraMoreInfoCard` / `ahpraMoreInfoItemHtml`):

1. **Progress tracker** — "2 of 4 done" + a progress bar (counts GP-actionable items).
2. **Deadline countdown** — "6 days left — due 29 Aug," colour-escalating as it nears.
3. **Plain per-item status** —
   - Upload: To do → Uploaded (under review) → Accepted / Not accepted (re-upload).
   - Request: To do → Requested (awaiting AHPRA) → Confirmed received.
4. **Team items visible (read-only).** Extend `GET /api/ahpra/more-info` to also return
   team-owned items as **read-only summaries** ("Supervised practice plan — handled by our
   team ✓") — title only, never the officer's raw words — so the GP sees the full picture.
   Render them greyed/non-actionable, separate from their own to-do items.
5. **CC reminder banner** (from Part C) and **automatic deadline reminders** (from the
   chase mechanism).

---

## Part E — Automation policy (option 2, made safe)

A single confidence line (`S80_AUTO_CONFIDENCE = 0.92`) gates **three** automatic actions:

| Action | Auto when… | Fallback |
|---|---|---|
| Release a notice to the GP (Part A) | every item ≥ threshold & none unusual | tray review |
| Approve a GP upload (Part B) | AI match ≥ threshold & certified-copy OK | human approve |
| Send the AHPRA reply (Part B) | all items done & confident | one-click "Send to AHPRA" |

Safeguards:
- Every auto-action → `_logCaseEvent` + RSO notification.
- Anything below the line → existing human-in-the-loop path.
- **Auto-send the regulator-facing reply has a 10-minute cancel window**
  (`S80_REPLY_HOLD_MINUTES = 10`): the reply task is queued and an admin can cancel before it
  goes; if not cancelled, it sends and marks complete. (Set the window to 0 for instant send.)

Tunable constants (one place each): `S80_AUTO_CONFIDENCE=0.92`, `S80_CHASE_DAYS=7`,
`S80_REPLY_HOLD_MINUTES=10`.

---

## Architecture & data flow (end-to-end)

```
AHPRA email ──▶ Gmail pipeline / manual paste
        │
        ▼
_createAhpraS80Bundle  (Opus 4.8 extraction → items w/ ai_confidence + ai_reason)
        │
   all items ≥0.92 & clean? ──yes──▶ _releaseS80Bundle (auto)  ──┐
        │ no                                                     │
        ▼                                                        ▼
  Holding tray (admin sets Who/How, sees confidence/reason) ──▶ Released
        │                                                        │
        ▼                                                        ▼
   GP page: progress + countdown + clear statuses + team items (read-only) + CC banner
        │                         │
   upload item                request-institution item
        │                         │
 AI pre-check ──auto/human──▶ approve     mark requested + (optional) proof
        │                         │
        │                  daily cron: AI reads AHPRA thread (via CC) →
        │                  received_confirmed_at, or chase after 7 days
        ▼                         ▼
   all GP items done ──▶ combined reply task ──▶ Send to AHPRA from app
                                              (auto w/ 10-min cancel window, or one-click)
```

**No database migration.** Every new field rides in the existing `registration_tasks.metadata`
JSON blob, consistent with the current metadata-only s80 implementation.

---

## Error handling

- **AI call failure / low confidence** at extraction → bundle stays in `pending_review`
  (never auto-release on uncertainty). Surface a clear tray note.
- **AI upload pre-check failure** → fall back to manual approve; never block the GP's upload.
- **Gmail send failure** → reply task stays open, admin sees the error and the copy-draft
  fallback; never mark "sent" unless the send actually succeeded (per CLAUDE.md rule 2/5).
- **Thread-watch ambiguity** → do nothing automatic; only flag for human on clear signals.
- **Missing CC** → thread-watch simply can't confirm; the chase timer still protects the
  deadline, and the banner reduces this case.
- All automatic actions are idempotent (guard on the timestamps/status they set) to survive
  cron re-runs and double-fires (mirrors the existing combined-reply double-fire guard).

## Testing

- **Unit (`lib/ahpra-s80.js`)** — extend existing tests: confidence/reason parsing,
  auto-release gate (all-high vs one-low), `S80_AUTO_CONFIDENCE` boundary, structured-output
  schema shape, combined-reply unchanged.
- **Backend** — release helper extraction (manual + auto paths identical), upload pre-check
  storage, reply-send guards (no "sent" without success), chase/idempotency.
- **Manual smoke** (preview, transparently reported): paste a sample notice end-to-end —
  auto-release path, low-confidence tray path, GP upload auto-approve vs human, request +
  proof + confirmed-received, combined reply send with cancel window.

## Rollout (phased, each shippable)

1. **Foundations** — Opus 4.8 + remove temperature + confidence/reason + show in tray.
2. **GP clarity** — progress, countdown, statuses, team-item visibility, CC banner.
3. **Close the loop** — proof upload + thread-watch in cron + auto-chase.
4. **Admin speed** — AI upload pre-check + send-reply-from-app (needs `gmail.send` scope).
5. **Turn on automation** — auto-release / auto-approve / auto-send gated on confidence,
   with audit + RSO notify + 10-min reply cancel window.

## Open prerequisites / decisions captured

- **Gmail `send` scope** must be enabled for the team account before Phase 4's auto/one-click
  reply can send (degrades gracefully to copy-draft until then).
- Defaults chosen, all tunable: confidence **92%**, chase **7 days**, reply cancel window
  **10 min**.
- Dashboard parity: the s80 in-progress view is duplicated logic between `pages/admin.html`
  and `pages/ceo-dashboard.html` per existing convention — any admin-side render change must
  be mirrored in both.
