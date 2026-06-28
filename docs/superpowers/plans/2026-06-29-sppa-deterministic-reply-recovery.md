# Plan — Deterministic SPPA reply recovery (fixes the silent-drop of a practice/candidate return)

**Date:** 2026-06-29
**Picks up from:** `docs/superpowers/plans/2026-06-29-sppa-hub-reply-pickup-handover.md`
**Branch/worktree:** `worktree-sppa-recheck-thread-fetch`

## Verified root cause (this session, against prod Supabase)
The SPPA-00 practice reply was lost two different ways, and I confirmed both with direct DB reads:

1. **The automatic hourly reconcile sweep never even selected the task.** The sweep (server.js ~22530) filters
   `related_document_key=eq.sppa_00 & status=in.(waiting_on_gp,waiting_on_practice)`. But SPPA tasks DON'T use those
   `status` column values — an awaiting-practice SPPA task has `status` = `open`/`in_progress`, and the real awaiting
   state lives in `metadata.sppa_state` (`sent_to_practice` / `corrections_requested` / `sent_to_candidate` /
   `gp_corrections_requested`). **Verified:** that exact filter returns **0** sppa_00 tasks in prod; the only sppa_00
   task is `status=in_progress`. So the cron's automatic safety-net swept nothing.

2. **The recheck button's heuristic path silently dropped the surfaced reply.** The recheck DID surface khaleed's reply
   (handover §3) but `processGmailNotification`'s early-match chain (`earlyGpCase` resolution → `matchResponseToTask`)
   produced zero trace for it. Every DB precondition I checked says it *should* have matched (exact-lowercase
   `practice_contact_email` = khaleed on Smith's hired app; Smith has exactly one active case; task `gmail_thread_id`
   = `19f0df1232476fc3` and not stale; the owner/khaleed account has no case so it can't hijack `earlyGpCase`). The
   only remaining variable is the **live `emailMeta.threadId` of the recovered message at recheck time**, which needs
   live Gmail/Vercel logs to see and can't be confirmed offline. Rather than chase a runtime-only ghost, we remove the
   dependency on that fragile chain for the known-task path.

## The fix (handover §6 / §10, codified)
A **deterministic** recovery: given a known SPPA task that is awaiting a reply, pull the task's own Gmail thread and
pick up the newest message **from the expected sender** (`metadata.sent_to_practice_email` when awaiting practice,
`metadata.sent_to_candidate_email` when awaiting candidate) that carries an attachment and isn't already on the task —
then run the exact same state transition the inline auto-pickup runs. No `earlyGpCase`, no `matchResponseToTask`.

### Tasks
1. **Pure decision helper `selectSppaReplyMessage(messages, meta, alreadyAttachedIds)`** (TDD).
   - Gate on `meta.sppa_state`: awaiting-practice = `sent_to_practice`|`corrections_requested`;
     awaiting-candidate = `sent_to_candidate`|`gp_corrections_requested`; else → no pickup.
   - Expected sender from the matching `sent_to_*_email`; compare case-insensitively, tolerating `Name <email>`.
   - Require ≥1 attachment; skip ids already attached; choose newest by `internalDate`.
   - Returns `{ direction, message, expectedSender, reason }`. Exported via `__testUtils`.
2. **I/O wrapper `recoverSppaThreadReply(task, mailbox)`** — `getGmailClient(mailbox)` → `threads.get(full)` →
   `selectSppaReplyMessage` → on hit, perform the §10 writes (task_message; wipe prior current docs + insert
   task_documents from attachments; flip `sppa_state` + timestamps + `*_via='thread_recovery'`; `practice_doc_ops`
   ops_status; `processed_gmail_messages` dedup row) and the SPPA post-processing already used inline
   (`_runSppaCompletenessCheck` / `_maybeRunGpSectionScan`, `_uploadSppaDocToDrive`, alt-supervisor handling). Returns a
   structured result; logs one line either way (no more zero-trace).
3. **Wire into the recheck endpoint** (~36963): after the existing heuristic scan, if the task is still awaiting, run
   `recoverSppaThreadReply` over the same inbox list and include the result in the response + timeline event.
4. **Fix + wire the reconcile sweep** (~22530): select by `metadata->>sppa_state=in.(…awaiting…)` (with
   `gmail_thread_id` not null) instead of the wrong `status` filter, and call `recoverSppaThreadReply` per task.
5. **Diagnostic logging** in the inline early-match block so any *future* live drop is traceable (log resolved
   `earlyGpCase`/`earlySenderRole` and the `earlyMatch` outcome when a threaded sender resolves to a case but no match
   is produced).
6. Tests green (`npx vitest run`), `node --check server.js`, commit + push to main.

## Notes
- Self-contained recovery writes (don't refactor the working inline hot path) to de-risk; reuse the existing
  sub-helpers so behaviour matches an auto-pickup.
- Idempotent: skips ids already in `task_messages` and writes a `processed_gmail_messages` dedup row.
- Owner is non-technical — final summary in plain words.
