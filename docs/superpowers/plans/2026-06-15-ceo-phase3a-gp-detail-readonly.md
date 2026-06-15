# CEO Phase 3a — GP file (read-only) under each RSO

> Implement→review→fix. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). Phase 3a is **read-only display** — reuse existing GET endpoints; NO write/action wiring (that is Phase 3b). After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** In RSO Oversight, clicking a GP row in an RSO's drill-in opens that GP's full file (dark), rendered into `#rsoContent` with a back link to the RSO. Sub-tabs: **Tasks · Notes · Timeline · Documents · Calls** — all read-only.

**Flow:** RSO Oversight → `openRsoDetail(rsoId)` (GPs + ops + calls) → click a GP → `openGpDetail(caseId, rsoId)` renders the GP file into `#rsoContent`; a "← back" link calls `openRsoDetail(rsoId)`.

**Verified data (reuse these GET endpoints; do not modify them):**
- `GET /api/admin/case?id=<caseId>` → `{ ok, case, tasks, timeline }`. `case`: id,user_id,stage,substage,status,blocker_status,blocker_reason,next_followup_date,practice_name,practice_contact(JSON string),handover_notes,ahpra_*,ai_handover_summary,gp_name,gp_email,gp_phone,created_at,updated_at. `tasks[]`: id,task_type,title,description,priority,status,due_date,related_stage,completed_at,created_at. `timeline[]`: id,task_id,event_type,title,detail,actor,metadata,created_at.
- `GET /api/admin/case/timeline?id=<caseId>` → `{ ok, timeline[], messages[] }` (messages: direction,channel,sender,recipient,subject,body_text,created_at,...).
- `GET /api/admin/gp-documents?case_id=<caseId>` → `{ ok, documents:{ directToAhpra[], preparedByCandidate[], preparedByGpLink[], otherFiles[] }, driveFolder }`. Doc fields: label/document_key, status/ops_status, file_url/webViewLink, file_name/name, updated_at.
- `GET /api/admin/calls?case_id=<caseId>` → `{ ok, calls[] }` (status, scheduled_at, zoom_join_url, meeting_summary, assigned_rso_name, admin_notes,...).
- (lazy/optional) `GET /api/admin/candidate-summary?case_id=<caseId>` → `{ ok, summary:{overview,action_items[],concerns[],recent_comms[],outstanding_requirements[],key_history}, meta }` — AI, expensive; only fetch on explicit expand.
- Notes = `timeline` entries with `event_type === 'note'` (no separate notes store).

All of these are gated by `requireAdminSession` and a super-admin passes — call them directly from the CEO page (read-only). The RSO drill-in is `openRsoDetail(rsoId)` at ceo-dashboard.html (Phase 1/2 added `loadRsoOps`/`loadRsoCalls` there); the GP rows are `.rso-gp-row` (each has `g.case_id`).

---

### Task 3a.1: `openGpDetail` shell — profile header + sub-tab nav + GP-row wiring

**Files:** `pages/ceo-dashboard.html` (add `openGpDetail`, a GP-row click/Open affordance in `openRsoDetail`, dark CSS).

- [ ] **Step 1:** in `openRsoDetail`, give each `.rso-gp-row` a way to open detail — add an "Open" button (or make the name clickable) carrying `data-gp-case="<case_id>"` and `data-gp-rso="<rsoId>"`; wire a click handler that calls `openGpDetail(caseId, rsoId)`. (Keep the existing "Reassign RSO" button.)
- [ ] **Step 2:** add `openGpDetail(caseId, rsoId)`: render a loading spinner into `#rsoContent`, fetch `GET /api/admin/case?id=<caseId>`, then render a header: back link (`onclick` → `openRsoDetail(rsoId)`), GP name, email/phone, stage pill (visa→pbs remap, reuse `STAGE_LABELS`/`pillClass`), status pill, practice name, and blocker (if `blocker_status`). Cache the fetched `{case,tasks,timeline}` in a module var (e.g. `gpDetailCache`) so the sub-tabs reuse it without refetching.
- [ ] **Step 3:** render a sub-tab nav (`Tasks · Notes · Timeline · Documents · Calls`) with a `gpDetailTab` state var (default `tasks`) and a `<div id="gpDetailPane">` body. Clicking a sub-tab calls `renderGpDetailTab(tab)` (a dispatcher; for 3a.1 only `tasks` needs to render — others can show a spinner/placeholder filled by later tasks). Wire the sub-tab click handler.
- [ ] **Step 4:** add dark `.ceo-gp-detail-*` CSS reusing existing tokens (match `.rso-gp-row`/`.ceo-ops-*`).
- [ ] **Step 5:** inline `<script>` compiles; `git diff --stat -- pages/admin.html` EMPTY. Commit `feat(ceo): GP file shell (header + sub-tab nav) in RSO drill-in`.

---

### Task 3a.2: Tasks sub-tab (read-only)

**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('tasks')`).

- [ ] **Step 1:** render the cached `tasks[]` for the case: show active tasks (exclude completed/cancelled by default, with a toggle to show all), grouped by `related_stage` (or status), each row: title, `task_type` subtitle, priority pill, status pill, due/overdue indicator. Read-only — no action buttons in 3a.
- [ ] **Step 2:** compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — Tasks sub-tab (read-only)`.

---

### Task 3a.3: Notes + Timeline sub-tabs (read-only)

**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('notes')`, `renderGpDetailTab('timeline')`; add `loadGpTimeline(caseId)`).

- [ ] **Step 1 (Notes):** render notes = cached `timeline` entries where `event_type === 'note'`, newest first, each showing `detail`/`title`, `actor`, and `created_at` (formatted). (Add-note input is deferred to Phase 3b.)
- [ ] **Step 2 (Timeline):** `renderGpDetailTab('timeline')` fetches `GET /api/admin/case/timeline?id=<caseId>` (once, cached), merges `timeline[]` + `messages[]`, sorts by `created_at` desc, and renders each event with an icon by `event_type`/`channel`, its `title`/`detail` or message subject+snippet, `actor`/`sender`, and time. Read-only.
- [ ] **Step 3:** compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — Notes + Timeline sub-tabs (read-only)`.

---

### Task 3a.4: Documents sub-tab (read-only)

**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('documents')`, `loadGpDocuments(caseId)`).

- [ ] **Step 1:** fetch `GET /api/admin/gp-documents?case_id=<caseId>` (cached); render the four categories (Direct to AHPRA, Prepared by Candidate, Prepared by GP LINK, Other Files) as dark sections; each doc shows label, a status pill (status/ops_status), and a **View/Open** link when a `file_url`/`webViewLink` is present (open in new tab). Show the Drive folder link if `driveFolder`. Read-only (no upload/approve — that's 3b).
- [ ] **Step 2:** compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — Documents sub-tab (read-only)`.

---

### Task 3a.5: Calls sub-tab (read-only)

**Files:** `pages/ceo-dashboard.html` (`renderGpDetailTab('calls')`, `loadGpCalls(caseId)`).

- [ ] **Step 1:** fetch `GET /api/admin/calls?case_id=<caseId>` (cached); render the call history newest-first: status pill, scheduled time, assigned RSO, admin notes, and meeting summary for completed calls; a **Join** link when `zoom_join_url` is present. Read-only (resend/cancel/reschedule are 3b).
- [ ] **Step 2:** compiles; admin.html EMPTY diff. Commit `feat(ceo): GP file — Calls sub-tab (read-only)`.

---

### Task 3a.6: Phase 3a verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals; no commit.
