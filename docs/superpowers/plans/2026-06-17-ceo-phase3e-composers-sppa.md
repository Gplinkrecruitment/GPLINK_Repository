# CEO Phase 3e — Email composers (from hello@) + SPPA-00 review tool + PDF editor

> Implement→review→fix. **HARD CONSTRAINT: do NOT modify `pages/admin.html`** (read it only as the porting source). All UI in `pages/ceo-dashboard.html` (dark). NEW CEO sends go through NEW `/api/ceo/*` endpoints that force the sender to `hello@mygplink.com.au`; existing `/api/admin/*` endpoints must keep their current behavior (Hazel's page depends on them — additive/refactor only, no behavior change). SAFETY: **NEVER trigger a live email send** during build or verify — wire + `node --check` + inline-compile + unit tests + code-trace only. After EVERY task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal (user direction):** Close the Phase 3d gap by porting admin.html's deep document-workflow controls into the dark CEO GP-detail accordion: (A) the **email composers** (compose & send to practice/GP/AHPRA), and (B) the **SPPA-00 review tool** including its embedded **PDF editor**. CRITICAL: every email the CEO sends must be **FROM `hello@mygplink.com.au`** (the master-archive address), not from a VA/RSO mailbox.

**Verified mechanism (sender = hello@):**
- `sendGmailEmail({from, to, cc, subject, bodyHtml, bodyText, attachments, threadId, inReplyTo, caseId})` (server.js ~1460) calls `getGmailClient(from)` (server.js ~1422), which builds a Google service-account JWT with domain-wide delegation: `subject: userEmail`, scopes include `gmail.send` (line ~1444). So passing `from: 'hello@mygplink.com.au'` sends AS hello@ via the SAME path that already sends as hazel@. `hello@` is a real workspace mailbox (`MASTER_ARCHIVE_EMAIL`, server.js ~1393) already used for archive insertion. The first real send in prod is the ultimate confirmation; do NOT live-send during build.
- `MASTER_ARCHIVE_EMAIL` constant exists (server.js ~1393) = `hello@mygplink.com.au`.

**Verified admin source + reusable endpoints:**
- `POST /api/admin/email/send` (server.js ~23878): body `{to, cc, subject, bodyHtml|bodyText, taskId, caseId, attachments:[{url,filename}], threadId, inReplyTo}`; `requireAdminSession`; sender hardcoded to `MONITORED_VA_EMAILS[0]` (hazel@); does threading (resolve task→threadId), label management, case-event logging. **We will NOT change this** — instead factor its core into a helper or replicate it in a CEO endpoint that forces `from=hello@`.
- CC contacts: `GET /api/admin/va/case/:caseId/email-contacts` → `{ok, contacts:[{email_address, display_name, seen_count}]}` (reuse as-is).
- SPPA endpoints (server.js): preview `GET /api/admin/va/task/:taskId/sppa-pdf` (PDF binary), `POST /sppa-override-q7 {is_conflict, details}`, `POST /sppa-store-returned {from:'candidate'|'practice', file_data_url, file_name}`, `POST /sppa-save-fields {fields:[{name,value,page}]}`, `POST /sppa-submit` (delivers to GP, **NO email** — reuse as-is), and the LIVE-EMAIL sends `POST /sppa-send-to-candidate` + `/sppa-send-to-practice` (currently `from:'hazel@'`, ~32678/~32816). All `requireAdminSession`.
- PDF editor page `pages/pdf-editor.html` is standalone/self-contained: open with `?taskId=<id>[&highlight=<field>]`, it posts back `{type:'sppa-fields-saved', fields:[{name,value,page}]}` or `{type:'sppa-editor-cancel'}` via `postMessage`; parent persists via `POST /api/admin/va/task/:id/sppa-save-fields`.
- admin.html source fns to port: composer markup + `data-ops-send-email`/`-revision`/`-ahpra-email`/`-gp-email` handlers (~6549+); `loadCcContacts` (~5734); `openSppaReview`/`sppaSendToCandidate`/`sppaSendToPractice`/`sppaOverrideQ7`/`sppaMarkReturned`/`sppaSubmitFinal` (~7927+); `openPdfEditor` + postMessage listener (~8982+). LINE NUMBERS ARE APPROXIMATE — grep by NAME.

**CEO page reuse:** `apiFetch`, `esc`, `showToast`, `openModal`/`closeModal` (`#modalBox`/`#modalOverlay`), `findCeoTask`, `refreshGpDetailTasks`, `loadGpTaskDetail` + the `renderCeoOps*` views (3d.6) that currently render "Handled from RSO tools" notes where composers belong, `ceoSafeUrl`. Dark tokens per Phase 3d.

---

### Task 3e.1: Server — CEO send endpoints that force from=hello@

**Files:** `server.js`.

- [ ] **Step 1:** read `POST /api/admin/email/send` fully. Refactor its core (build MIME + `sendGmailEmail` + threading + label + case-event log) into an internal helper `sendAdminEmailCore(opts)` where `opts.from` defaults to `MONITORED_VA_EMAILS[0]` — so the existing admin handler calls it with NO behavior change (default sender unchanged). If a clean refactor is risky, instead replicate the handler body in the new CEO endpoint (do NOT alter the admin handler).
- [ ] **Step 2:** add `POST /api/ceo/email/send` — `requireSuperAdminSession`; same body as admin send; calls the core with `from = MASTER_ARCHIVE_EMAIL` (hello@) ALWAYS (ignore any client-supplied from). Returns the same `{ok, ...}` shape. Reuses task→thread resolution + logging.
- [ ] **Step 3:** add `POST /api/ceo/task/:taskId/sppa-send-to-candidate` and `POST /api/ceo/task/:taskId/sppa-send-to-practice` — `requireSuperAdminSession`; refactor the admin SPPA-send logic into a helper `sendSppaEmailCore(taskId, recipientKind, fromEmail)` (the admin endpoints call it with `fromEmail='hazel@...'`, unchanged; the CEO endpoints call it with `fromEmail=MASTER_ARCHIVE_EMAIL`). If refactor is risky, replicate the body in the CEO endpoints forcing from=hello@. Same response shape.
- [ ] **Step 4:** `node --check server.js`. Confirm the admin `/api/admin/email/send` and `/sppa-send-*` behavior is unchanged (default sender still hazel@) — add/adjust a unit test if a test file covers email send; otherwise code-trace. `git diff --stat -- pages/admin.html` EMPTY.
- [ ] **Step 5:** commit `feat(ceo): /api/ceo/email/send + SPPA sends — force sender hello@mygplink.com.au`.

---

### Task 3e.2: CEO email composer UI in the detail accordion

**Files:** `pages/ceo-dashboard.html` (renderCeoOps* views + a `ceoLoadCcContacts` + send handler).

- [ ] **Step 1:** port `loadCcContacts(caseId)` as `ceoLoadCcContacts(caseId, selectEl)` → `GET /api/admin/va/case/:caseId/email-contacts`, populate the CC `<select multiple>` (label `display_name <email> (seen Nx)`).
- [ ] **Step 2:** in the `renderCeoOps*` views (practice_pack_child, ahpra_action_item, generic) REPLACE the "Handled from RSO tools" composer notes with a dark compose block ported from admin (To input, CC multi-select, Subject input, contenteditable/textarea Body, optional attachment toggle), keyed by task id (`data-ceo-email-to/-cc/-subject/-body`). Pre-fill To/Subject/Body the way admin does for that task type (read admin's templates).
- [ ] **Step 3:** add `ceoSendComposerEmail(taskId, opts)` — gather To/CC/Subject/Body (+ optional current-doc attachment), POST to **`/api/ceo/email/send`** (NOT the admin one), then optional `PUT /api/admin/task?id=` `{status}`/`{metadata_merge}` exactly as admin's send handler does (read `data-ops-flip-status`/`data-ops-sppa-state`). On success: toast, refresh the task detail (re-run `loadGpTaskDetail`) + `refreshGpDetailTasks`. Check `res.ok` AND `{ok}`. Wire via delegation (`data-ceo-send-email`).
- [ ] **Step 4:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP detail email composers (send from hello@)`.

---

### Task 3e.3: SPPA-00 review tool (dark)

**Files:** `pages/ceo-dashboard.html` (SPPA overlay + handlers; wire into `renderCeoOpsSppa00`).

- [ ] **Step 1:** add a dark SPPA review overlay (mirror admin's `sppaReviewOverlay`) with an iframe; `ceoOpenSppaReview(taskId)` sets iframe src = `/api/admin/va/task/:taskId/sppa-pdf` and opens it. Add close handling (Esc + button).
- [ ] **Step 2:** port the SPPA action handlers, wiring `renderCeoOpsSppa00`'s controls: `ceoSppaOverrideQ7(taskId, currentIsConflict)` → `POST /api/admin/va/task/:taskId/sppa-override-q7 {is_conflict, details}` (reuse admin endpoint — not email); `ceoSppaMarkReturned(taskId, from)` → file picker → `POST .../sppa-store-returned {from, file_data_url, file_name}` (reuse); `ceoSppaSubmitFinal(taskId)` → `POST .../sppa-submit` (reuse — no email); and the LIVE-EMAIL sends `ceoSppaSendToCandidate/Practice(taskId)` → the **NEW `/api/ceo/task/:taskId/sppa-send-to-candidate|practice`** (from hello@). Confirm dialogs before each. On success: toast + `loadGpTaskDetail`/`refreshGpDetailTasks`.
- [ ] **Step 3:** replace the SPPA "Handled from RSO tools" notes in `renderCeoOpsSppa00` with these real controls (Preview / Override Q7 / Upload Returned / Send to Candidate / Send to Practice / Submit). Dark CSS for the overlay reusing tokens.
- [ ] **Step 4:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): SPPA-00 review tool (preview, Q7, returns, sends from hello@, submit)`.

---

### Task 3e.4: PDF editor embed

**Files:** `pages/ceo-dashboard.html` (PDF editor overlay + postMessage).

- [ ] **Step 1:** add a dark PDF-editor overlay with an iframe; `ceoOpenPdfEditor(taskId, amendField)` sets src = `/pages/pdf-editor?taskId=<id>[&highlight=<field>]` and opens it.
- [ ] **Step 2:** add the `window` `message` listener (scoped to when the CEO editor is open + correct origin check) handling `{type:'sppa-fields-saved', fields}` → `POST /api/admin/va/task/:taskId/sppa-save-fields {fields}` (reuse admin endpoint) then close + toast + refresh; and `{type:'sppa-editor-cancel'}` → close. Guard against double-binding the listener across re-renders (bind once).
- [ ] **Step 3:** wire an "Edit SPPA-00" control in `renderCeoOpsSppa00` → `ceoOpenPdfEditor`. (pages/pdf-editor.html is standalone — no changes to it needed.)
- [ ] **Step 4:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): SPPA-00 PDF editor embed (postMessage save)`.

---

### Task 3e.5: Phase 3e verification + parity gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** full suite — `node node_modules/vitest/vitest.mjs run` (NOT npx) — green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` EMPTY.
- [ ] **Step 5 (parity checklist):** confirm EVERY former "Handled from RSO tools" note is now a real control, and that ALL CEO email sends (composer + SPPA send-to-candidate/practice) route through `/api/ceo/*` with `from=hello@` (NOT the admin sender). Confirm the admin `/api/admin/email/send` + `/sppa-send-*` default behavior (from hazel@) is unchanged. List anything still deferred. State clearly that hello@ sending is verified by code-trace and the first real prod send is the live confirmation. No commit.
