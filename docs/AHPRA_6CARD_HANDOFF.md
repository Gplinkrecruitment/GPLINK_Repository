# AHPRA 6-Card Source-of-Truth — Session Handover & Testing Guide

**Date:** 2026-07-01
**Status:** ✅ SHIPPED to main/prod — merge commit `e868d1b`, Vercel production deployment **READY**.
**Tests:** 894 passing (includes 13 new in `tests/ahpra-6card.test.js`).
**Branch:** `worktree-ahpra-6card-source-of-truth` (already fast-forwarded into `main`).

> Purpose of this doc: give a fresh session everything needed to **test** the AHPRA officer-email → 6-card → doctor flow that shipped this session. The one thing that could NOT be verified from this machine: a real inbound `@ahpra.gov.au` email (can't fabricate one). Everything up to that is verified.

---

## 1. What this feature is (plain)

When the Australian medical-registration office (**AHPRA**) emails about a doctor, the app:
1. AI-classifies the email into one of **6 response types** and shows the RSO/admin a **card** with the right action:
   `direct_reply` · `request_from_gp` · `request_from_practice` · `amend_document` · `status_update` · `escalation`.
2. When the RSO clicks **"Send to GP"** on a `request_from_gp` / `amend(owner=gp)` card, the **doctor now sees an in-app AHPRA to-do** (upload box + deadline + instruction on their AHPRA page) **and gets a notification** — not just an email.

## 2. The bug that was fixed (why this session happened)

The 6-mode classifier was **already merged** but **silently dead in production**: `_processAhpraEmail` wrote the matched-GP task body to a **non-existent `detail` column** → PostgREST error `42703` rejected **every matched-GP insert**. The code never checked the insert result (it logged "Created task" on failure). **Proof:** the only `ahpra_correspondence` row in prod was the *unmatched* one (which used a different insert without the typo). So the thing actually handling AHPRA mail in prod was the **older s80 pipeline** (`ahpra_action_item`), which is ALSO the doctor-facing AHPRA-page to-do system.

Two pipelines fired on every AHPRA email (duplicate). Owner chose **"Fix + connect to doctor"**: make the 6-card the single front door, keep + reuse the s80 doctor-facing machinery, wire them together.

## 3. What changed — key symbols & anchors

All in `server.js` + `pages/admin.html` (grep the symbol; line numbers drift).

### server.js
- `async function _processAhpraEmail(emailMeta, sourceMsgId, preMatchedCase)` — the classifier/front door. Now:
  - writes `description:` (was the broken `detail:`); **bails + logs loudly** if the insert is rejected.
  - **idempotency**: skips if `source_gmail_message_id` already has a card, or if the `gmail_thread_id` already has a card (a reply → attaches via response-matching instead of a 2nd card).
  - **confidence gate**: binds to a case only via `preMatchedCase` (strong inline match) OR `ahpraConfidentMatch(triage)` (≥0.7 & !needs_triage); else an unmatched Support task.
  - stores `source_gmail_message_id` / `gmail_thread_id` / `email_sender` / `email_body_snippet` + an inbound `task_messages` row (with rfc822 headers) so the card shows the request and replies can thread.
  - on-file qual docs attach `user_documents.file_url` (were attaching with no URL).
- `function ahpraConfidentMatch(triage)` — pure, exported in `__testUtils`, unit-tested.
- `function buildAhpraGpDeliveryItem(card, cardMeta, nowIso)` — pure, exported, unit-tested; maps a card → the GP-facing s80 item payload (`s80:true, review_status:'active', owner:'gp', mode:'upload'`).
- **Dispatch** (inside the Gmail message loop, after the inline GP-match block): `await _processAhpraEmail(emailMeta, currentMsgId, gpCase);` — **AWAITED** (was fire-and-forget; the review caught that a frozen serverless instance could lose the email). The legacy s80 auto-bundle **no longer fires on inbound mail**; inline `email_triage` is skipped for AHPRA (`&& !isAhpra`).
- **Endpoint** `POST /api/admin/va/task/:id/ahpra-deliver-to-gp` — creates the doctor-facing s80 item + `pushDocumentNotificationToUser`, flips the card to `waiting_on_gp`. Gated to `task_type === 'ahpra_correspondence'`; idempotent on `metadata.source_card_task_id`.
- **Cron backstop** in `GET /api/cron/process-gmail` — search for `ahpraReconcile`: re-pulls open `ahpra_correspondence` threads so an archived / behind-cursor officer reply isn't silently lost (mirrors the SPPA/alt-CV sweeps).
- **Conflict-letter reconciliation** (a parallel feature that landed on main during this work — commit `4e5f64e`, see `ahpra_conflict_letter`): the merge kept the front-door call and relies on the conflict letter's OTHER triggers — Trigger A (officer assigned), Trigger B (conflict scan), and **path-C** inside `_processAhpraEmail` (`isConflictFollowup` → `_ensureAhpraConflictLetter` → `suppressedByConflictLetter` wraps the card insert `if (!suppressedByConflictLetter)`). Path-C passes `sourceMsgId` for auto-close threading.

### pages/admin.html
- `function renderOpsAhpraActionItem(task,msgs,docs)` — the 6-mode card renderer (badge + officer email + per-type composer/buttons).
- The two GP "Send to GP" buttons carry `data-ops-ahpra-gp-deliver="1"`; the `sendGpEmailBtn` handler calls `/ahpra-deliver-to-gp` after the email (search `ahpraDeliver3`).

### pages/ahpra.html (doctor view)
- `renderAhpraMoreInfoCard(data)` / `ahpraMoreInfoItemHtml(item)` render the doctor's AHPRA to-do; fed by `GET /api/ahpra/more-info` (filter: `metadata.s80 && review_status==='active' && owner==='gp'`). `mode:'upload'` → the "Upload document" box.

### lib/email-triage.js
- `AHPRA_RESPONSE_TYPES`, `AHPRA_TRIAGE_SYSTEM_PROMPT`, `triageAhpraEmail`, `parseAhpraTriageResponse` — the AI classifier (returns response_type, confidence, matched_gp_user_id, officer info, amend_target, on_file_documents, draft_response, needs_triage).

### tests
- `tests/ahpra-6card.test.js` — 13 tests for `ahpraConfidentMatch` (0.7 boundary, needs_triage, no-match, null-safe) + `buildAhpraGpDeliveryItem` (s80/active/owner=gp/mode=upload, title-suffix strip, instruction/deadline fallbacks).

## 4. HOW TO TEST

### 4a. Automated tests (fast, no creds)
```
NODE=/tmp/node-v20.18.1-darwin-arm64/bin/node   # no system node on this Mac
$NODE node_modules/vitest/vitest.mjs run                       # full suite (expect 894 pass)
$NODE node_modules/vitest/vitest.mjs run tests/ahpra-6card.test.js   # just this feature's unit tests
$NODE --check server.js                                        # syntax
```

### 4b. Live end-to-end (needs a real/allow-listed inbound email — the un-verifiable part)
Preconditions: a GP whose `registration_cases` row is `status in (active,in_progress)` and `stage in (ahpra,career,pbs,commencement)`; sender is `@ahpra.gov.au` OR in `TEST_WATCH_FROM_SENDERS`; lands in a watched mailbox.
1. Send an AHPRA-style email naming the GP (or CC the GP / include their AHPRA application number for the strong match).
2. **Expect:** exactly ONE `ahpra_correspondence` card on the RSO Ops Queue with a sensible response_type; the officer email visible ("Open full email"); NO duplicate `email_triage` / s80 card.
3. Click **"Send to GP"** on a `request_from_gp` card → **expect:** the doctor's AHPRA page shows a new "Upload document" item + they get a notification; an `ahpra_action_item` (metadata `s80/active/owner=gp/mode=upload`, `source_card_task_id` = the card) is created; the card flips to `waiting_on_gp`.
4. Reply from the officer on the same thread → **expect:** it attaches to the existing card (no 2nd card). If it's archived/mistimed, the hourly `/api/cron/process-gmail` sweep recovers it.

### 4c. DB verification (service key, read-only)
`exec_sql(query)` returns **void** (can't read results) — verify via PostgREST REST instead. Read `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env` (don't print the key).
```bash
SUPABASE_URL=$(grep -m1 -oE '^SUPABASE_URL=.+' .env | cut -d= -f2-)
SVC=$(grep -m1 -oE '^SUPABASE_SERVICE_ROLE_KEY=.+' .env | cut -d= -f2-)
# matched cards should now exist (case_id NOT null) — pre-fix there were ZERO:
curl -s "$SUPABASE_URL/rest/v1/registration_tasks?select=id,title,case_id,status&task_type=eq.ahpra_correspondence&order=created_at.desc&limit=10" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
# GP-facing items created by the deliver endpoint:
curl -s "$SUPABASE_URL/rest/v1/registration_tasks?select=id,status,metadata&task_type=eq.ahpra_action_item&metadata->>ingest_source=eq.ahpra_card_delivery&limit=10" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
# the 'detail' column genuinely does not exist (this SHOULD error 42703 — that was the bug):
curl -s "$SUPABASE_URL/rest/v1/registration_tasks?select=detail&limit=1" -H "apikey: $SVC" -H "Authorization: Bearer $SVC"
```

### 4d. Regenerate the visual previews (faithful, from the REAL renderers)
Builder scripts were in the job tmp (won't survive into a new session/job). To rebuild: slice `renderOpsAhpraActionItem` + helpers from `pages/admin.html` (RSO cards) and `renderAhpraMoreInfoCard`/`ahpraMoreInfoItemHtml` from `pages/ahpra.html` (doctor view) into a standalone HTML with mock data, then screenshot with headless Chrome:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=W,H --screenshot=out.png "file://.../preview.html"`.

## 5. Deferred (documented, low risk — safe to leave)
- A **unique index** on `registration_tasks(task_type, source_gmail_message_id)` to fully close the rare cross-invocation duplicate-card race (currently narrowed by the await + check-then-insert dedup).
- **Resurface** a `waiting_on_gp` card when an officer sends a follow-up (pre-existing response-matching design: a same-thread non-doc reply attaches but doesn't flip the ball).

## 6. Environment / gotchas for a new session
- **No system node/npm/gh/vercel CLI** on this Mac. Temp node: `/tmp/node-v20.18.1-darwin-arm64/bin/node`. Headless Chrome present at `/Applications/Google Chrome.app/...`.
- **Local checkout drifts** — origin/main moved twice mid-session. Always `git fetch` and verify against `origin/main` (`git show origin/main:server.js`), not the local tree.
- **Supabase**: only REST creds in `.env`; `exec_sql(query)` = void; verify via REST. Live `registration_tasks_task_type_check` accepts `ahpra_correspondence` + `ahpra_action_item` + `ahpra_conflict_letter` (all already applied to prod).
- **Push**: background sessions push via `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push`. Prod = push `origin/main` → Vercel auto-build (project `prj_LeHg7obiXjySqpjR23S46QmwSLXJ`, team `team_CZsGx8ESlTxQ3Uc9sHG23vCY`).
- **Related memory**: `ahpra-6card-source-of-truth.md`, `ahpra-conflict-officer-letter.md`, `ahpra-s80-followup-tasks.md`, `sppa-alt-supervisor-cv-request.md`.

## 7. The full audit that started this (for context)
A 9-segment multi-agent audit of the AHPRA flow found 48 verified issues (0 critical by the ranker, but the `detail` bug is effectively critical — the feature never worked for a matched GP). Themes fixed this session: broken save, wrong-GP binding, duplicate pipelines, doctor-facing disconnect, missing officer-reply backstop, on-file doc URL, escalation routing note. The rest (CEO-dashboard mis-target, some UI-state polish) are separate follow-ups not in scope of "fix + connect to doctor."
