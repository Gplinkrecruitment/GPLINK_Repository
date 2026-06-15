# CEO Phase 3b — GP file actions

> Implement→review→fix. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). REUSE existing `/api/admin/*` action endpoints (super-admin passes their `requireAdminSession`) and the CEO page's EXISTING action functions/modals where they exist. SAFETY: do NOT execute any live mutation during build/verify — wire the calls and verify by `node --check` + inline-compile + unit tests + code-tracing only. After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** Make the read-only GP file (Phase 3a) actionable so the CEO can complete/manage work directly from a GP's file. Reuse, don't reinvent.

**FIRST (every task):** grep `pages/ceo-dashboard.html` for existing action helpers to reuse — the original rebuild already added CEO action modals/functions (e.g. create-task, change-stage, set-blocker, send-nudge, add-note, `openReassignModal`, escalation resolve/respond). Reuse them (pass the GP's `caseId`/`taskId`); only add new wiring for actions that don't already exist. After every action succeeds, re-fetch the relevant GP data and re-render that sub-tab (and refresh `gpDetailCache`).

**Endpoints (verified; reuse as-is — do NOT modify):**
- Task update: `PUT /api/admin/task?id=<taskId>` body `{status|priority|due_date|blocker_reason|escalated_to|escalated_reason}` (statuses: open/in_progress/waiting/waiting_on_gp/waiting_on_practice/waiting_on_external/completed/cancelled/escalated/deferred).
- Create task: `POST /api/admin/task`. Add note (case): `POST /api/admin/case/note`. Add note (task): `POST /api/admin/task/note`.
- Update case: `PUT /api/admin/case?id=<caseId>` (stage, blocker_status, blocker_reason, next_followup_date, ...).
- Nudge: `POST /api/admin/va/nudge`. Doc: `POST /api/admin/va/task/upload-document`, `POST /api/admin/va/task/request-revision`.
- Calls: `POST /api/admin/calls/schedule`, `PATCH /api/admin/calls/:id` (status/notes/reschedule/no-show), `POST /api/admin/calls/:id/resend`.
- (read the exact request body of each before wiring — match what admin.html sends.)

---

### Task 3b.1: Task-level actions in the GP Tasks sub-tab

**Files:** `pages/ceo-dashboard.html` (`renderGpTasksTab` rows + handlers).

- [ ] **Step 1:** add per-task action buttons to each task row in the GP Tasks sub-tab: **Complete** (`PUT /api/admin/task?id=` `{status:'completed'}`), **Start** (`{status:'in_progress'}`), **Waiting** (`{status:'waiting'}`), **Escalate to CEO** (reuse the existing escalation flow/endpoint the CEO page already has if present; else `{status:'escalated', escalated_to:'CEO', escalated_reason:<prompt>}`). On success, re-fetch `GET /api/admin/case?id=` → update `gpDetailCache` → re-render the Tasks tab. Show a toast on failure (check `res.ok` AND parsed `{ok}`).
- [ ] **Step 2:** inline compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — task actions (complete/start/waiting/escalate)`.

---

### Task 3b.2: Header case actions — Add Task, Add Note, Change Stage, Set Blocker, Nudge

**Files:** `pages/ceo-dashboard.html` (GP file header buttons → existing modals/functions).

- [ ] **Step 1:** add a header action row to the GP file with buttons wired to the EXISTING CEO action helpers (grep first), passing the GP's `caseId`: **Add Task**, **Add Note**, **Change Stage**, **Set Blocker / On Hold**, **Send Nudge**. If a helper already opens a modal keyed by caseId, just call it; if a needed helper is missing, add a minimal one reusing the endpoints above. After the modal action completes, re-fetch + re-render the GP file.
- [ ] **Step 2:** Add Note should land in the Notes sub-tab on success (it creates a `event_type='note'` timeline entry — re-fetch case). inline compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — header case actions (add task/note, stage, blocker, nudge)`.

---

### Task 3b.3: Document actions in the Documents sub-tab — DEFERRED

> **DEFERRED (2026-06-15):** approve / request-revision operate on a document's underlying `registration_tasks` id, which the read-only `/api/admin/gp-documents` response does not expose. Wiring these needs a new `/api/ceo/gp-documents?case_id=` read endpoint that returns each document's task id + attachment-pending flag. Out of scope for now — the Documents tab stays read-only (view/open from Phase 3a), and document-review *tasks* remain actionable via the Tasks sub-tab (3b.1). Tracked as a follow-up.


**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('documents')` rows + handlers).

- [ ] **Step 1:** for documents that support it, add **Approve** and **Request revision** buttons wired to `POST /api/admin/va/task/upload-document` (approve) and `POST /api/admin/va/task/request-revision` (read the exact bodies admin.html sends — they key off the document/task). On success, re-fetch `GET /api/admin/gp-documents?case_id=` and re-render. Keep the existing View/Open links. (File upload from the CEO page may be deferred if it needs a file picker; if so, leave a note — approve/request-revision are the priority.)
- [ ] **Step 2:** inline compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — document approve / request-revision actions`.

---

### Task 3b.4: Call actions in the Calls sub-tab

**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('calls')` rows + handlers).

- [ ] **Step 1:** add call actions reusing the call endpoints: **Resend invite** (`POST /api/admin/calls/:id/resend`), **Cancel** / **No-show** / **Reschedule** (`PATCH /api/admin/calls/:id` with the appropriate body — read admin.html's call handlers for the exact shapes). Keep the **Join** link. On success, re-fetch `GET /api/admin/calls?case_id=` and re-render. (A full "schedule new call" modal may reuse an existing helper if present; otherwise note it as a follow-up.)
- [ ] **Step 2:** inline compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — call actions (resend/cancel/reschedule/no-show)`.

---

### Task 3b.5: Phase 3b verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals + list any deferred sub-actions (e.g. file upload, schedule-new-call); no commit.
