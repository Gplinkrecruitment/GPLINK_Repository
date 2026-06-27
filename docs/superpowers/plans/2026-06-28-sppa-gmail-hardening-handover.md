# Handover — SPPA-00 + Gmail ingestion hardening

**Date:** 2026-06-28
**Prior session:** 80d35942 (background job)
**Shipped commit:** `cd1d26a` on `origin/main` (Vercel auto-builds)
**Status:** ✅ Code shipped + 614/614 tests pass. ⏳ Needs live verification + Smith Miller recovery action.

---

## 1. Why this work happened
User report: "The practice returned the completed SPPA-00, but the system scanned an empty one and flagged it; I asked the practice for a corrected version, they sent it, and now the system isn't picking it up. Run a thorough scan of the whole system and stop bugs at every step."

## 2. Ground-truth diagnosis (from prod Supabase — verified, not guessed)
- Test case: **Smith Miller**, user_id `a505f0b8-fb62-490d-9d63-2c09f800366f`, case `10a3c2d8-aefc-43c7-af3c-7ae5c014ea97`, SPPA task `30ee082d-1032-4227-866c-e4cfdd2bbaa4`. Assigned RSO = **hello@mygplink.com.au** (so all sends go FROM hello@; replies return there). Gmail thread `19f089d641c9a855`.
- On 06-27 there were **ZERO processed inbound emails from the practice (khaleed@gmail)** across both watched mailboxes. Every inbound on the task was the **candidate's** single message `19f08a4572d56998`, attached 3×.
- The "practice returned" event at 13:13 was that candidate message **re-read** by a manual `history_id='1'` recovery → falsely flipped `sent_to_practice → practice_returned`. The AI then scanned the candidate's half-blank form → correctly flagged blank supervisor/employer/signature sections (it was the wrong document).
- The **"Request Corrections" email started a brand-new Gmail thread** — its handler never SELECTed `gmail_thread_id`, so `threadId` was `undefined`. The practice's corrected reply therefore could never thread-match the task. Combined with **no daily catch-up scan for hello@**, the reply was never ingested. **This is the live "not picked up" root cause.**

## 3. ⚠️ HONEST LIMITS (carry these forward)
- **No Google creds on this machine.** `.env` has `GOOGLE_SERVICE_ACCOUNT_EMAIL` but `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` is **blank**. So you CANNOT inspect the real Gmail inbox or trigger a server-side Gmail pull locally. You can only see what the system processed (Supabase). Do not claim the practice "did" or "didn't" reply — only that the system has/has-no record.
- Smith's corrections email was sent BEFORE the threading fix, so his `task.gmail_thread_id` still points at the OLD candidate thread, not the corrections thread. The recheck endpoint's AI content-match should still recover a sitting reply; once attached, future replies self-heal via message-thread matching.

## 4. What shipped in `cd1d26a` (4 files)
**server.js**
- Sender-identity guard on SPPA transitions (`earlySenderRole` 'candidate'/'practice' in early-match ~3030): `gp_returned` requires `!== 'practice'`, `practice_returned` requires `!== 'candidate'`; mismatch → record + status 'open' + logged event, NO advance. Fail-open.
- Per-task idempotency (~3060): skip if `task_messages` already has `(task_id, gmail_message_id)`. Survives dedup-table deletion.
- 404-recovery (~2833): stop advancing `history_id` BEFORE processing; window 30→50.
- Daily `process-gmail` cron (~22352): now also polls `TEST_WATCH_INBOXES` (hello@).
- `sppa-request-corrections` (~36481): SELECT + thread on `gmail_thread_id` + persist returned thread + clear stale completeness.
- `sppa-send-to-candidate`/`-to-practice`: pass `threadId`, persist `emailResult.threadId`, store `emailResult.gmailMessageId` (was `.messageId` = always null).
- Recursive attachment extraction via `emailMeta.attachments` + lazy is_current wipe (never leaves zero docs).
- Completeness verdict reset on every fresh practice_returned (auto + manual `sppa-store-returned`).
- **NEW** `POST /api/admin/va/task/{id}/sppa-recheck-thread` — idempotent on-demand "pull the practice reply now".

**lib/sppa-completeness-check.js** — fail-OPEN on unparseable AI (`_error:'parse_error'` in defaults); neutral wording.

**pages/admin.html** — corrections_requested "Resend Request" now opens a real composer (was a dead no-op); new "Check for practice reply now" button → `sppaRecheckThread()`.

**pages/ceo-dashboard.html** — parity: completeness panel, GP-section banner, corrections action branches, human state labels, PDF cache-bust.

## 5. IMMEDIATE NEXT ACTIONS
1. **Confirm Vercel deploy finished** (push was `10309d4..cd1d26a`).
2. **Recover Smith's case:** open his SPPA card in admin, click **"Check for practice reply now"**. If the practice genuinely replied to hello@ it gets found + attached (status → practice_returned + fresh AI check). If not found → use **"Upload Corrected Return"** to attach the file directly. His state is correctly `corrections_requested` — do NOT reset it.
3. **Browser-test the new UI** (not yet done live): admin "Resend Request" composer + "Check for practice reply now"; CEO completeness panel / corrections branches. Hard-refresh after deploy.

## 6. Remaining known-LOW follow-ups (audit found, deliberately deferred)
- Atomic up-front dedup "claim" row (with delete-on-error) instead of end-of-branch logging.
- Webhook/`processGmailNotification` concurrency lock (overlapping Pub/Sub deliveries).
- SPPA filename heuristic: a practice that renames the form can make the wrong attachment the "primary SPPA".
- `_disambiguatePracticeEmail` returns null on a tie → silently drops to triage track.
- Thread an explicit doc-id into `_runSppaCompletenessCheck` (so it can't pick a stale doc).
- Centralize the Anthropic model id (3 SPPA libs hardcode `claude-opus-4-6` fallback). See memory `anthropic-model-id-pinning`.

## 7. Environment / how-to for the next session
- **Local checkout is ~340+ commits BEHIND origin/main.** Read DEPLOYED code from `origin/main` (`git show origin/main:server.js`) or work in a fresh worktree off origin/main (EnterWorktree does this).
- **Node** (no system node): `export PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"` (v20.18.1).
- **Tests:** symlink `node_modules` from the main checkout into the worktree, then `npx vitest run` (614 tests, ~8s).
- **Syntax check inline HTML JS:** extract `<script>` blocks (filter out `src=`) and `node --check`.
- **Push:** `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push origin HEAD:main` (keychain unavailable in bg jobs).
- **Prod DB (read ground truth):** Supabase service key is in `.env` as `SUPABASE_SERVICE_ROLE_KEY` (NOT `.env.prod`, which is blank). Query via REST: `curl "$SUPABASE_URL/rest/v1/<table>?select=...&<filter>" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"`. Note odd schemas: `user_profiles` keyed by `user_id` (no `id`/`full_name`; has first_name/last_name/email); `task_documents` uses `filename`/`message_id` (not file_name); `task_messages` uses `sender`/`recipient` (not from_email).
- **SPPA states:** ready_to_send → sent_to_candidate → gp_returned → sent_to_practice → practice_returned → completed; plus gp_corrections_requested (candidate redo) + corrections_requested (practice redo). Stored in `registration_tasks.metadata.sppa_state`.

## 8. Reference artifacts
- Memory: `sppa-gmail-pipeline-hardening` (this work), `sppa-completeness-check`, `gmail-watch-history-renewal-bug`, `sppa-gp-section-return-scan`, `outbound-email-sender-identity`, `temp-scoped-hello-watch` (hello@ TEST_WATCH allowlist).
- Full 38-bug audit JSON (this session): `/private/tmp/claude-501/-Users-.../tasks/wkudrrkoo.output` (workflow run `wf_510c2c7b-26c`) — may be cleaned up; the confirmed bugs are summarized in §4 + §6.
