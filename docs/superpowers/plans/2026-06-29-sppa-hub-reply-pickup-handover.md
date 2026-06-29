# Handoff — SPPA-00 practice reply not auto-picked-up under the registration@ hub

**Date:** 2026-06-29
**Status:** ⚠️ Smith's test case RECOVERED MANUALLY (unblocked). The underlying **auto-pickup bug is NOT fixed** — a practice reply is *found* by the recovery scan but silently dropped during processing, with **zero trace** (no log, no error, no DB row). This doc is for a fresh session to nail and fix it properly.
**Prior session:** this one (background job c0177b41). Lots of related hardening shipped; the core drop remains.

---

## 1. The bug in one paragraph
After enabling the registration@ email hub, when the **practice** (khaleedmahmoud1211@gmail.com) replies to registration@ with the completed SPPA-00, the SPPA task does **not** advance `sent_to_practice → practice_returned`. The reply genuinely lands in registration@'s INBOX (in the conversation thread, with the PDF). The recovery scan (recheck button / hourly reconcile / `processGmailNotification` recovery mode) **surfaces** the message, but the per-message processing loop **never processes it** — it produced no "[Gmail] Early response match…" log, no "[Gmail] Error processing message…" log, no `task_messages` row, and no `processed_gmail_messages` row. The same path works for the **candidate** (Smith). The candidate's reply also (correctly) gets held by the sender-identity guard ("candidate replied while awaiting practice"). It is specifically the **practice reply** that vanishes.

## 2. Test case identifiers (prod Supabase)
- GP/candidate: **Smith Miller**, user_id `a505f0b8-fb62-490d-9d63-2c09f800366f`, case `10a3c2d8-aefc-43c7-af3c-7ae5c014ea97` (status **active**).
- SPPA task: `30ee082d-1032-4227-866c-e4cfdd2bbaa4` (related_document_key `sppa_00`, task_type `practice_pack_child`), `gmail_thread_id = 19f0df1232476fc3`.
- Practice contact = **khaleedmahmoud1211@gmail.com** = `metadata.sent_to_practice_email`, AND `gp_applications.practice_contact_email` on Smith's **hired** application. ⚠️ This is ALSO the owner's own account: user_id `2f94f870-7ab2-4f71-98ad-bf3756ed88db`, present in `user_profiles` (empty name) and `rso_team` (active RSO "Khaleed Mahmoud"), but has **NO `registration_cases` row**.
- The dropped message: gmail id `19f0e79c7bcd2cc1`, thread `19f0df1232476fc3`, subject "Re: SPPA-00 Supervised Practice Plan for Dr Smith Miller — Please Complete and Sign", attachment `SPPA-00 (2) (3) (1).pdf` (~692 KB). **Recovered manually 2026-06-28** → task is now `practice_returned` (metadata.practice_returned_via = `manual_recovery`).

## 3. What is VERIFIED (don't re-derive)
Confirmed by direct prod DB reads + direct Gmail API reads (service account impersonating registration@) + Vercel runtime logs:
1. The reply is in registration@ **INBOX** (label INBOX present) — NOT archived. (Earlier "archived-on-arrival" hypothesis was WRONG.)
2. `threads.get(registration@, 19f0df1232476fc3)` returns **4 messages** incl. khaleed's reply. The recovery logged `surfaced 4 message id(s)` + `Found 4 new messages for registration@`.
3. `messages.list(registration@, q:"from:khaleedmahmoud1211@gmail.com newer_than:30d")` returns the reply. So the search works too.
4. The recheck ran correctly: timeline event `Manual re-check for practice reply triggered` with `{scanned:[registration@ ok, hello@ ok], thread:19f0df1232476fc3, fromSender:khaleedmahmoud1211@gmail.com}`.
5. In the registration@ recovery, the loop processed only **3 of the 4**: `19f0df…` → Pre-filter rejected internal_sender; `19f0e741…` (Smith reply) → "Skipping re-ingest — already attached"; `19f0e775…` → Pre-filter rejected internal_sender; then immediately "Updated historyId". **`19f0e79c…` (khaleed) has NO processing line at all.** Searching prod logs by the message id and by the task id returns nothing for it.
6. Role resolution SHOULD succeed: candidate-match fails (khaleed has no active case), practice-match succeeds (`gp_applications` where `practice_contact_email=khaleed AND status=hired` → 1 row = Smith; `registration_cases` for Smith `status=active` exists) → `earlyGpCase`=Smith, `earlySenderRole`='practice'.
7. `preFilterEmail` only rejects senders ending `@mygplink.com.au` as `internal_sender` — khaleed is gmail.com, so it passes (not the cause).
8. Not an idempotency skip: `19f0e79c` was NOT in `task_messages`/`processed_gmail_messages` before recovery.
9. **This is NOT just a test-data quirk** — a real external practice resolves to the SAME `earlyGpCase=Smith, role=practice` path, so it would be dropped the same way. Treat as a production bug.

## 4. Ruled out
- Wrong mailbox scan (fixed: recheck now scans `resolveCaseSenderInfo(case).from` = registration@ — commit `e1294b9`).
- Archived/INBOX-label issue (it IS in INBOX; recovery is label-agnostic anyway).
- Forward-only history cursor (recovery uses threads.get, cursor-independent).
- From-header mojibake (separate, fixed `c0961f6`).
- internal_sender pre-filter (only @mygplink.com.au).
- hello@ double-watch noise (separate; being shut off by `0514b87` setting TEST_WATCH defaults to ''; TEST_WATCH_INBOXES/TEST_WATCH_FROM_SENDERS are NOT set as Vercel env vars).

## 5. Leading hypotheses for the next session (UNCONFIRMED)
The reply is surfaced but the loop body produces zero output for it. Two candidates:
- **(A) `matchResponseToTask(Smith, 19f0e79c)` returns null / ≤0.5**, so the early-match block's `if (earlyMatch && earlyMatch.confidence > 0.5)` is false and the code falls through **without recording** (no `processed_gmail_messages` insert on this path → explains zero trace). Signal-1 (thread match) SHOULD match: `registration_tasks where case_id=Smith AND gmail_thread_id=19f0df… AND status IN (open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external)` — the SPPA task was `status=open` at recheck time, which is in the list. So why would it miss? Possibly the message's `emailMeta.threadId` wasn't populated in the recovery-fetched message, or a stale `gmail_thread_id` on the task at that instant. **Confirm by logging `earlyGpCase`, `earlySenderRole`, and `earlyMatch` for this message.**
- **(B) The loop silently iterated only 3** (e.g., `threads.get` returned 3 at that instant, or a dedupe/ordering quirk dropped the 4th). Less likely given "Found 4", but confirm by logging each surfaced id and each loop iteration's `currentMsgId`.

Either way: **the fix is to add diagnostic logging to `processGmailNotification` (recovery branch + per-message loop) and re-run the recheck on Smith's task**, then read the logs via the Vercel MCP. That will pinpoint it in one pass.

## 6. Recommended robust fix (do this regardless of the exact cause)
Codify the **deterministic recovery that already worked by hand** so a practice/candidate return can never be silently dropped. In the recheck-thread endpoint AND the process-gmail reconcile sweep, for an SPPA task awaiting a reply:
1. `threads.get` the task's `gmail_thread_id` on `resolveCaseSenderInfo(case).from`.
2. Find the newest thread message whose parsed sender == `metadata.sent_to_practice_email` (practice) — or `metadata.sent_to_candidate_email` (candidate) for the gp_returned direction — that is NOT already in `task_messages` for the task and has an attachment.
3. If found and the task is in the matching awaiting state, **directly**: insert `task_message`, set prior `task_documents.is_current=false`, insert the attachment as a `task_document` (data URL), flip `sppa_state` (`practice_returned` / `gp_returned`) + timestamps, set `practice_doc_ops` ops_status, insert a `processed_gmail_messages` dedup row, and (practice path) clear stale `completeness_check`/`completeness_override` + fire `_runSppaCompletenessCheck`.
This bypasses the fragile `earlyGpCase` heuristics + `matchResponseToTask` entirely for the known-task recovery path. The exact field shapes are in the working manual-recovery script — reproduced in §9.

## 7. What was shipped this session (all on origin/main, prod)
- `a5b102e` recheck-thread: recovery mode in `processGmailNotification(opts.recoverThreadId/recoverFromSender)` via threads.get + from:sender search (label/cursor-independent).
- `bd4063f` merge of `worktree-rso-email-hub-prototype` into main (registration@ hub) + `dbfe759` Hazel-signoff fix; hub ENABLED (`REGISTRATION_HUB_EMAIL=registration@mygplink.com.au`, Production).
- `c0961f6` From-header RFC 2047 encoding (fixes "GP Link Admin Ã¢Â€Â" GP Link" mojibake in `lib/registration-hub.js` buildFromHeader).
- `e1294b9` recheck scans the HUB mailbox (`resolveCaseSenderInfo(case).from`), not just the assigned RSO + TEST_WATCH.
- `22a195a` **P1**: process-gmail cron → hourly (vercel.json) + SPPA reconcile sweep (cursor-independent thread recovery for open awaiting-reply SPPA tasks); **P4** isDocDelivery attachment extractor now uses `emailAddress` not `MONITORED_VA_EMAILS[0]`.
- `ec8a509` **P5/P6** hub-mailbox scoping: request-revision (thread lookup + From + drafts.create), admin email-send pre-thread lookup, suggest-reply AI thread context now use `resolveCaseSenderInfo(case).from`.
- NOT done (deferred): **P2** fix the forward-only cursor advance itself; **P3** widen the watch labelIds (currently `['INBOX','SENT']`); **P6b** check-reply guard; **P7** diagnostics/reprocess tool. See memory `sppa-gmail-pipeline-hardening`.
- Other authors moved main ahead too: `0514b87` (TEST_WATCH off), `5783360` (per-thread inbox labels), `017883a` (suggest reply). **Local checkout was BEHIND origin/main — always work from origin/main / a fresh worktree.**

## 8. Key code locations (server.js unless noted; line numbers approximate, grep to confirm)
- `processGmailNotification(emailAddress, notifiedHistoryId, options)` ~2743. Recovery branch (`options.recoverThreadId`/`recoverFromSender`) ~2845. Per-message loop ~2886. Cursor write-back at function end.
- Early-match block (the drop site) ~3110–3270: `earlySenderRole` resolution ~3118; SPPA transition ~3196 (`gp_returned` ~3200, `practice_returned` ~3219, "sender-role mismatch / not advancing" else ~3261).
- `matchResponseToTask(caseId, emailMeta)` ~2374 (Signal 1 thread match on `registration_tasks.gmail_thread_id`; Signal 2 via `task_messages`; Signal 3 AI).
- `getOpenPracticePackTasks()` — ⚠️ filters `related_document_key=in.(offer_contract,supervisor_cv)` (NO sppa_00) + `task_type=eq.practice_pack_child`. Used for the GLOBAL openTasks AI matcher; check whether any practice-reply path depends on it (sppa_00 would be invisible there).
- `preFilterEmail(emailMeta)` ~2501.
- `resolveCaseSenderInfo` ~2002 / `resolveCaseSenderEmail` / `resolveCaseSenderName`; hub logic in `lib/registration-hub.js`.
- recheck-thread endpoint: `POST /api/admin/va/task/{id}/sppa-recheck-thread` ~36796.
- process-gmail cron + reconcile sweep ~22411 (reconcile added before the final sendJson).

## 9. Environment / how-to (this machine)
- **Node** (no system node): `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"`.
- **Prod DB**: service key `SUPABASE_SERVICE_ROLE_KEY` in `.env` at the MAIN checkout root (NOT `.env.prod`). Query via REST: `curl "$SUPABASE_URL/rest/v1/<table>?..." -H "apikey: $K" -H "Authorization: Bearer $K"`. Schema quirks: `user_profiles` keyed by user_id (first_name/last_name/email, no full_name); `task_documents` cols: filename/message_id/attachment_url/is_current/mime_type/size_bytes/category/uploaded_by; `task_messages` cols: sender/recipient/direction/channel/gmail_message_id/gmail_thread_id; `task_timeline` (via `_logCaseEvent`) cols: case_id/task_id/event_type/title/detail/actor.
- **Google creds are BLANK locally** (`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` empty in `.env`) — you canNOT touch Gmail with local `.env`. BUT you can read the real key from Vercel with a **Vercel API token** (owner-provided, used in-memory only, **NOT persisted** — ask the owner for it again; see memory `vercel-api-access`). Token + team `team_CZsGx8ESlTxQ3Uc9sHG23vCY`, project `prj_LeHg7obiXjySqpjR23S46QmwSLXJ`:
  - List env: `GET https://api.vercel.com/v9/projects/{proj}/env?teamId={team}` → find id → `GET /v1/projects/{proj}/env/{id}?teamId={team}` → `.value`.
  - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` is type `encrypted` (readable). **The stored value has literal surrounding double-quotes AND literal `\n`** — normalize: `pk = value.trim().replace(/^"+|"+$/g,'').replace(/\\n/g,'\n')`. `GOOGLE_SERVICE_ACCOUNT_EMAIL = gplink-drive@sunlit-precinct-481010-j2.iam.gserviceaccount.com`.
  - Impersonate a mailbox: `new google.auth.JWT({email, key:pk, scopes:['https://www.googleapis.com/auth/gmail.readonly' or modify], subject:'registration@mygplink.com.au'})`. Run from a dir whose `node_modules` has `googleapis`, or `export NODE_PATH="<main checkout>/node_modules"`.
  - `CRON_SECRET` is type `sensitive` → NOT readable → you can't trigger `/api/cron/*` yourself. Use the admin dashboard "Set up / Renew watches" / "Pull recent emails now" buttons, or wait for the cron.
  - Vercel can't set env vars via MCP; use the REST API with the token (`POST /v10/projects/{proj}/env?...&upsert=true`) + redeploy (`POST /v13/deployments?...&forceNew=1` with `gitSource:{type:'github',repoId:'1169920708',ref:'main'}`).
- **Prod runtime logs** (gold for this bug): Vercel MCP `get_runtime_logs` (query by message id / task id / "Early response match" / "Error processing message"; `since:"1h"`). `get_runtime_errors` for clusters.
- **Push**: `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push origin HEAD:main` (keychain unavailable in bg jobs). Fetch+rebase first (main moves often).
- **Tests**: symlink `node_modules` from the main checkout into the worktree, then `npx vitest run` (652 tests, ~8s). `node --check server.js` before pushing.

## 10. The working manual-recovery logic (reference for §6)
Fetch via SA-impersonated registration@: `messages.get(userId:REG, id:19f0e79c…, format:'full')`; walk payload parts for `filename && body.attachmentId`; `messages.attachments.get(...)` → base64url → convert to std base64 (`replace(/-/g,'+').replace(/_/g,'/')`). Then service-key writes:
1. `task_messages` POST `{task_id, case_id, direction:'inbound', channel:'email', sender:<from hdr>, recipient:REG, subject, gmail_message_id, gmail_thread_id, created_at}` (return id).
2. `task_documents` PATCH `is_current=false` where task_id & is_current=true; then POST `{task_id, case_id, message_id:<task_message id>, filename, mime_type, size_bytes, attachment_url:'data:'+mime+';base64,'+b64, is_current:true, version:1, uploaded_by:'…'}`.
3. `registration_tasks` PATCH `{status:'in_progress', metadata:{…, sppa_state:'practice_returned', practice_returned_at, practice_returned_via}, updated_at}` (delete completeness_check/override).
4. `practice_doc_ops` PATCH `ops_status='under_review'` where case_id & document_key='sppa_00'.
5. `processed_gmail_messages` POST dedup row `{gmail_message_id, email_address:REG, sender, subject, result:'matched', processed_at}`.

## 11. Reference
- Memory: `sppa-gmail-pipeline-hardening` (full root-cause + fixes), `registration-email-hub-branch` (hub live), `vercel-api-access`, `temp-scoped-hello-watch` (now disabled 0514b87), `outbound-email-sender-identity`, `admins-removed-as-gps` (why khaleed has no case but is a user/RSO).
- The owner is non-technical — explain fixes in plain words (see CLAUDE.md rule 9).
