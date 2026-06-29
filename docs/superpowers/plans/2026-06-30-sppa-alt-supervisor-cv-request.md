# SPPA-00 Alternate Supervisor CV — request + auto-collect end-to-end

Date: 2026-06-30
Branch: worktree-sppa-recheck-thread-fetch
Owner ask (verbatim intent): "once the SPPA is returned that's when we find out there is an
alternative supervisor (AI scans). If there is one, send the practice an email requesting the
CV — this should be a NEW task for the admin. Also ensure the GP's profile creates a new
placeholder for the supervisor's CV. Ensure registration@ automatically matches the alternate
supervisor's CV to the task once the practice sends it, on the same thread OR a new thread."

## DESIGN CHANGE (2026-06-30, owner) — NOT auto-sent
The request email is **not** sent automatically. `_ensureAltSupervisorCvRequest` creates a NEW admin
task carrying a **suggested (pre-filled) email** (stored in task metadata: `suggested_subject`,
`suggested_body`, `practice_email`); the RSO reviews and **sends it from the dashboard email
composer** (the existing `.ops-email-composer` + `data-ops-send-email` → `/api/admin/email/send`,
flip status → `waiting_on_practice`). Everything else below (placeholder, sender-keyed auto-match of
the reply, deliver-to-profile, flag-clear) is unchanged.

## What already exists (verified in code, 2026-06-30)
- **Detection on return**: `extractAltSupervisorNames(pdfBuffer)` (lib/sppa-pdf-fill.js) reads the
  "Name of alternate supervisor 1/2" AcroForm fields with an AI fallback. Runs on all 3 return
  paths (recoverSppaThreadReply ~2433, inline Gmail auto-pickup ~3578, manual sppa-store-returned
  ~36667) and stores `metadata.alt_supervisor_names`. CONFIRMED for Smith → ["Ahmed Mahmoud"].
- **Profile placeholder**: `_createAltSupervisorCvPlaceholders(caseId, names)` (server.js ~1192)
  writes `user_documents` (status pending) + `gp_prepared_docs.docs.alt_supervisor_cv_N`
  (ready:false). Surfaces in My Documents + AHPRA "Supervised Practice" download box (ahpra.html
  scans `/^alt_supervisor_cv/`). CONFIRMED for Smith.
- **Auto-match inbound (basic)**: inline block ~3641 — when a hired-practice contact emails with
  attachments, `matchCvToAltSupervisor` (lib/alt-supervisor-cv-match.js) AI-matches each CV to a
  named alt supervisor, creates an `alt_supervisor_cv_review` task with the CV as task_documents.
  Keyed by SENDER (works new-thread), runs in the realtime push loop (instant). Default triage
  track is `attachments` (server.js 2842).
- **Review + deliver**: `/alt-cv-submit` (~37384) uploads CV to a Drive "Alternative Supervisor
  CVs" subfolder, writes `user_documents` alt_supervisor_cv_N status=approved + drive id, completes
  the review task. admin.html (`altCvSubmit` ~9037, panel ~5597) + ceo-dashboard parity (~4330).
- **Outbound-to-practice pattern to mirror**: sppa-request-corrections (~37235) —
  `resolveCaseSenderInfo(caseId)`→{from,fromName}, `resolveCaseSenderName(caseId)`→signoff,
  `sendGmailEmail({from,fromName,to,subject,bodyHtml,threadId})`→{ok,threadId,error}, then
  re-anchor `task.gmail_thread_id = emailResult.threadId` so the reply thread-matches.

## Gaps to fix
1. **No explicit CV request** when an alternate is detected on return. (The SPPA-send email asks
   for alt CVs up-front — line 5503 — but practices often omit them.) → NEW task + auto-sent email.
2. **Matched CV not tied to "the task"** the owner means — it spawns a separate review task but
   never resolves the request. → complete the request task on match.
3. **Completeness flag never clears** once the CV is collected: `_runSppaCompletenessCheck`
   inventory (~9631) only counts alt CVs as task_documents ON THE SPPA TASK, but delivery writes
   them to `user_documents` (profile). And `/alt-cv-submit` never re-runs the check. → make the
   inventory also read the profile copy + re-run the check on delivery.
4. **Placeholder not flipped to Ready** on delivery (`/alt-cv-submit` writes user_documents but not
   `gp_prepared_docs`), so My Documents/AHPRA may still show "Preparing" after delivery. → call
   `_updatePreparedDocsState` on delivery.

## Tasks (one subagent each; server.js tasks run sequentially)

### Task 1 — lib + TDD (NEW file, isolated)
`lib/sppa-alt-supervisor-request.js`:
- `buildAltCvRequestEmail({ gpName, altNames, contactName, rsoSignoffName })` → `{subject, bodyHtml}`.
  Polite, references the returned SPPA-00, names the alternate(s), asks the practice to reply to
  THIS email with the signed CV(s) attached. HTML-escape interpolated names.
- `altSupervisorsNeedingCv(altNames, onFileNamesOrCount)` → names still needing a CV (pure).
Tests `tests/sppa-alt-supervisor-request.test.js`: email contains gp/alt/signoff, escaping,
needing-cv filtering (all present → []; none → all).

### Task 2 — server.js: request helper + wire into the 3 return paths
- Add `_ensureAltSupervisorCvRequest(caseId, sppaTask, altNames)` near
  `_createAltSupervisorCvPlaceholders`:
  - Resolve practice email: `metadata.sent_to_practice_email` || hired app `practice_contact_email`.
  - Idempotency: no-op if `metadata.alt_cv_request_sent` is true OR an open
    `alt_supervisor_cv_request` task already exists for the case OR all alt CVs already on file.
  - Create `alt_supervisor_cv_request` task (status open, related_document_key sppa_00,
    related_stage to group with SPPA; metadata: sppa_task_id, alt_supervisor_names, practice_email).
  - Build email (Task 1 lib), send via `sendGmailEmail` (from `resolveCaseSenderInfo`, threaded on
    `sppaTask.gmail_thread_id`), re-anchor the SPPA task's gmail_thread_id to emailResult.threadId,
    set `metadata.alt_cv_request_sent=true` + `alt_cv_requested_at`. Log a case event.
- Call it (fire-and-forget, .catch) right after each `_createAltSupervisorCvPlaceholders` (~2436,
  ~3582, ~36672). node --check + tests green.

### Task 3 — server.js: tie match → request task + delivery side-effects
- Auto-match block (~3683): after creating the review task, mark any open
  `alt_supervisor_cv_request` task for the case `completed` (log "alt CV received from practice").
- `/alt-cv-submit` (~37428 loop + after): for each delivered CV also call
  `_updatePreparedDocsState(userId, altDocKey, driveFileId, fileName)` (flip placeholder→Ready);
  after the loop, complete the request task and re-run
  `_runSppaCompletenessCheck(task.case_id, sppaTaskId)` (sppaTaskId from review task
  metadata.sppa_task_id, else look up the case's sppa_00 task). node --check + tests green.

### Task 4 — server.js: completeness inventory reads the profile copy
- In `_runSppaCompletenessCheck` (~9631) extend the alt-CV inventory: also query `user_documents`
  `document_key=like.alt_supervisor_cv_%` with `status in (approved,uploaded)` and merge into the
  count/list so a delivered CV is recognised. Keep the SPPA-task task_documents source too.
  node --check + tests green.

### Task 5 — admin.html + ceo-dashboard.html: surface the request task
- Add a human label/treatment for `alt_supervisor_cv_request` (mirror the
  `alt_supervisor_cv_review` branches at admin 5201/6430, ceo 4483): show alt name(s), "Requested
  <date> — awaiting practice reply", and a "Send request again" button hitting a small resend
  endpoint (optional; at minimum render cleanly, not raw). Bump script cache-buster. Mirror in
  ceo-dashboard.html for parity ([[dashboard-calls-parity]]).

## Verification
- `npm test` green throughout (664 baseline + new lib tests).
- `node --check server.js` clean before any push.
- End-to-end trace documented: return → detect → placeholder + request task + email → practice
  reply (same/new thread) → instant match → review → deliver → profile/Drive/MyDocuments/AHPRA
  Ready + request task done + completeness flag cleared.
- Live test still owner-only (no Google creds on this machine).
