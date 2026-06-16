# CEO Phase 3d — GP detail RSO parity (exact layout + controls, dark theme)

> Implement→review→fix. **HARD CONSTRAINT: do NOT modify `pages/admin.html`** (read it only as the porting source of truth). All UI in `pages/ceo-dashboard.html` (dark). REUSE existing `/api/admin/*` endpoints unchanged and the CEO page's existing handlers/modals where present. SAFETY: NO live mutations/sends during build/verify — wire + `node --check` + inline-compile + code-trace only. After EVERY task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal (user's words):** *"the exact same controls that the RSO has for each task. the gp profile layout, tasks layout, etc should be exactly the same as the RSO has just in black theme."* So the CEO GP-file (opened via RSO Oversight → RSO → GP) must become a faithful **dark clone** of admin.html's GP-detail view — same profile header, same stage-grouped task layout, same per-task controls (the ••• menu, guided action, schedule-call, badges), the email-triage panel, and the task-detail accordion.

**Source of truth (READ-ONLY) — admin.html GP-detail (light theme):**
- `renderDetail()` 3420–3515; profile bar markup 3445–3478; `renderCaseManagementForm(c)` 2542–2562; Zoom button 3463; View-as-GP 3464.
- `renderGpTasksPane(c)` 2678–2855; `groupTasksByStage(tasks)` 2563–2577; `STAGE_ORDER` 1542; `getGuidedAction(t)` 2608; `scheduleCallButtonHtml(t,email)` 9329 + `scheduleCallFromTask(taskId,caseId,stage)` 9335.
- task-row markup 2728–2795; ••• dropdown 2771–2795; email-triage `et-panel` 2798–2830; task-detail accordion container 2835.
- `loadGpTaskDetail(taskId)` 5762; detail renderers `renderOpsPracticePackChild` 5100, `renderOpsSppa00` 4797, `renderOpsAhpraActionItem` 5267, `renderOpsAltSupervisorCvReview` 5069, `renderOpsEmailTriage` 5560, `renderOpsGeneric` 5597.
- task action fns: `completeTask` 4009, `startTask` 4037, `updateTaskStatus` 4043, `resolveEmailTask` 4018, escalate handler 6100–6119, set-waiting 6123, `saveCase` 4349, impersonate handler 6388.
- CSS: profile-bar 855–865; stage-group 926–935; stage-task + st-* 937–961; et-panel 964–976; st-dropdown 977–981; gp-subtabs 984–989; gp-task-detail 327–328.
- All endpoints used are `requireAdminSession` (a super-admin passes): `PUT /api/admin/task?id=`, `POST /api/admin/calls/schedule`, `GET /api/admin/task/messages?taskId=`, `GET /api/admin/task/documents?taskId=`, `POST /api/admin/email-triage/suggest-reply`, `POST /api/admin/email-triage/check-reply`, `GET /api/admin/impersonate?user_id=`, `PUT /api/admin/case?id=`, the doc endpoints already wired in the CEO page.

**CEO target (ceo-dashboard.html) — current state to REPLACE/EXTEND:**
- `openGpDetail(caseId,rsoId)` 2461–2533 (renders header + sub-tabs into `#rsoContent`/`#gpDetailPane`); `gpDetailCache = {caseId,rsoId,case,tasks,timeline}`.
- Reduced `renderGpTasksTab()` 2600–2654 + `gpTasksByStage` 2566–2590 (REPLACE with the admin-parity render).
- Reusable handlers already present: `ceoGpTaskAction(ev,taskId,status)` (PUT task status), `ceoGpTaskEscalate`, `refreshGpDetailTasks()`, `ceoDocUpload/ceoDocApprove/ceoDocRequestRevision/ceoDriveUpload`, `openCreateTaskModal/openNoteModal/openStageChangeModal/openBlockerModal/openNudgeModal`, `openReassignModal/submitReassign`, `apiFetch`, `esc`, `showToast`, `statusPill/priorityPill/pillClass`, `STAGE_LABELS`, `relativeTime`, `opsDueIndicator`.
- Dark tokens: `--panel #1a1d27`, `--bg-elevated #13151e`, `--panel-border`, `--panel-border-hover`, `--text #e2e8f0`, `--text-muted`, `--text-dim`, `--blue #60a5fa` (+`--blue-dim`), `--red/--green/--amber/--purple` (+ `-dim`), `--radius 10px`, `--radius-lg 14px`.

## Porting rules (apply in EVERY task)

1. **Token-alias trick (keeps layout identical, flips dark):** wrap the entire ported GP-detail subtree in a container `<div class="gp-parity"> … </div>` and add ONE CSS block that re-declares admin's CSS custom-property NAMES to the CEO dark palette so admin's CSS rules resolve dark automatically:
   ```css
   .gp-parity { --line: var(--panel-border); --muted: var(--text-muted); --bg2: var(--bg-elevated); --bg3: rgba(255,255,255,0.06); --shadow: var(--shadow-lg); }
   ```
   (`--panel`, `--text`, `--blue`, `--green`, `--amber`, `--red`, `--purple`, `--radius` already exist dark in the CEO page — do not redeclare.) Then port admin's CSS RULES for the GP-detail classes **verbatim**, prefixed/scoped under `.gp-parity` (e.g. `.gp-parity .stage-task{…}`), EXCEPT convert any **hard-coded light hex** to dark: `#fff`/`#ffffff`→`var(--panel)`; `#f8fafc`→`var(--bg-elevated)`; `#cbd5e1`→`var(--panel-border-hover)`; `#eff6ff`→`var(--blue-dim)`; `#fef2f2`/`#fef3c7`/`#fffbeb`→`var(--amber-dim)` or `var(--red-dim)`; `#fecaca`→`rgba(239,68,68,0.3)`; light text on light bg (`#b45309` etc.) → the matching dark token (`--amber`). Keep ALL spacing/sizes/layout/flex exactly as admin.
2. **Data-source adaptation:** admin reads `c` (case), `u` (dashboard user), `S.tasks`. The CEO reads `gpDetailCache.case`, `gpDetailCache.tasks`. Map: `c`→`gpDetailCache.case`; task list→`gpDetailCache.tasks`; `u.gp_email`/phone/name→`gpDetailCache.case.gp_email`/`gp_phone`/`gp_name`; RSO name→from `rsoRosterCache` by `gpDetailCache.rsoId` (fallback "Unassigned"); AI confidence→`task.ai_confidence||task.ai_match_confidence`; relative time `fmtR`→`relativeTime`. Where a datum is NOT available in gpDetailCache (e.g. `quals_approved/quals_required`, WhatsApp/DoubleTick link), GRACEFULLY OMIT just that sub-element (render the rest) — do not invent data, do not block.
3. **Reuse, don't duplicate handlers:** prefer the CEO page's existing functions/modals; only add a new handler when admin has a control the CEO lacks. Every action that mutates calls the existing `/api/admin/*` endpoint with the SAME body admin sends, then refreshes via `refreshGpDetailTasks()` (or the relevant refresh) and re-renders.
4. **Escaping:** every interpolated value through `esc()`. URLs (mailto, WhatsApp, Gmail, Drive) must be safe — mirror admin's handling.
5. After each task: `node --check` is N/A for HTML; instead inline-compile the `<script>` (extract non-src `<script>` blocks, `new vm.Script(code)`), and `git diff --stat -- pages/admin.html` must be EMPTY.

---

### Task 3d.1: Foundation CSS — `.gp-parity` container + token aliases + ported GP-detail CSS (dark)

**Files:** `pages/ceo-dashboard.html` (CSS `<style>` only).

- [ ] **Step 1:** add the `.gp-parity { --line:…; --muted:…; --bg2:…; --bg3:…; --shadow:… }` alias block (rule 1).
- [ ] **Step 2:** port admin.html's CSS rules for these classes, scoped under `.gp-parity `, dark-converted per rule 1: `.profile-bar` + `.pb-*` (855–865), `.stage-group`/`.sg-*` (926–935), `.stage-task` + `.st-*` (937–961), `.et-panel` + `.et-*` (964–976), `.st-dropdown`/`.st-dropdown-item`/`.st-dropdown-sep` (977–981), `.gp-subtabs`/`.gp-subtab` (984–989), `.gp-task-detail`/`.gp-task-detail-inner` (327–328), plus the badge/pill classes used inline (`urgent-badge`, `overdue-badge`, `st-waiting-pill`, `st-waiting-days`, `st-nudge-reminder`/`st-nudge-btn`, `st-guide`, `st-doc-chip`, `case-stage-pill`).
- [ ] **Step 3:** inline-compile OK (CSS change can't break JS, but confirm the `<style>` is well-formed and the page still compiles); admin.html EMPTY diff. Commit `feat(ceo): GP-detail parity CSS (admin layout, dark theme)`.

---

### Task 3d.2: Profile header parity (avatar, full meta line, header buttons, case-management panel)

**Files:** `pages/ceo-dashboard.html` (`openGpDetail` header render).

- [ ] **Step 1:** replace the CEO profile header (`.ceo-gp-detail-profile`) with a dark port of admin's `.profile-bar` (3445–3478): avatar (initials), name, meta line (`email · phone · country · practice(link) · RSO: <name|Unassigned> · last activity` with the colored activity dot using `relativeTime` + the same 7d/3-7d/<3d red/amber/green thresholds — derive "last activity" from `gpDetailCache.case.updated_at` if no better field), stage pill (reuse `pillClass`/`STAGE_LABELS`), quals counter ONLY if available (rule 2 — likely omit), WhatsApp button ONLY if a link is available (else omit). Keep the existing back-link.
- [ ] **Step 2:** header buttons row, ported from admin (3458–3464) + the existing CEO buttons, wired to existing handlers where present: **Nudge** → `openNudgeModal`; **Add Task** → `openCreateTaskModal`; **Add Note** → `openNoteModal`; **Change Stage** → `openStageChangeModal`; **Set Blocker** → `openBlockerModal`; **Zoom** → port `openZoomScheduleModal` (admin 9074) OR a minimal scheduler that POSTs `/api/admin/calls/schedule` (reuse if a CEO equivalent exists); **View as GP** → `window.open('/api/admin/impersonate?user_id='+enc(userId),'_blank')`; **Expand** toggle → an expandable panel.
- [ ] **Step 3:** the expandable case-management panel, ported from `renderCaseManagementForm` (2542–2562), dark: **Assigned RSO** (reuse `openReassignModal`, or an inline dropdown that PUTs `/api/admin/case?id=` `{assigned_rso}` then triggers the existing reassignment/thread-transfer), **Status** dropdown (active/on_hold/complete/withdrawn → `PUT /api/admin/case?id=` `{status}`), **Verified Stage** dropdown (`{gp_verified_stage}`), **Save Changes**. On save: refresh + re-render.
- [ ] **Step 4:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP profile header parity (meta line, header actions, case-management panel)`.

---

### Task 3d.3: Task list structure parity (stage groups + task-row layout + primary/schedule buttons)

**Files:** `pages/ceo-dashboard.html` (REPLACE `renderGpTasksTab`; add ported helpers).

- [ ] **Step 1:** port `STAGE_ORDER` (1542), `groupTasksByStage` (2563–2577), and `getGuidedAction(t)` (2608) into the CEO page (adapt to read `gpDetailCache`). Keep the existing show-all toggle behavior.
- [ ] **Step 2:** rewrite `renderGpTasksTab()` to produce admin's structure (2700–2795), reading `gpDetailCache.tasks`: **stage-group headers** (`.stage-group`/`.sg-dot`/`.sg-label`/`.sg-count` + "Upcoming"/"Current stage" badges, future/locked styling vs `gpDetailCache.case.stage`), then per task a `.stage-task` row with: title + `urgent-badge`/`overdue-badge` (use `opsDueIndicator` + priority), doc chip (`attachment_filename` + AI confidence), guided prompt line (`getGuidedAction`), escalated pill, waiting pill + waiting-days, nudge-reminder (≥7 days waiting). In `.st-actions`: the primary **guided-action button** (when `guided.action`), the **schedule-call button** (port `scheduleCallButtonHtml`), and the **••• more button** (`data-more-menu`) whose dropdown is built in 3d.4.
- [ ] **Step 3:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP Tasks pane — admin parity layout (stage groups, badges, row structure)`.

---

### Task 3d.4: Per-task ••• dropdown + control wiring (Complete/Start/Waiting-on-External/Email/WhatsApp/Nudge/Escalate) + guided + schedule

**Files:** `pages/ceo-dashboard.html` (dropdown markup + delegated handlers).

- [ ] **Step 1:** port the ••• dropdown markup (2771–2795): when NOT escalated — **✓ Mark Complete**, **▶ Start / In Progress**, **⏳ Waiting on External**, sep, **✉ Email GP** (mailto, if `gp_email`), **💬 WhatsApp** (if link available — else omit), **💌 Send Nudge**, sep, **🚨 Escalate to CEO**; when escalated — the "🚨 Escalated to CEO — awaiting decision" note. Port the open/close behavior (toggle `.open`, close on outside-click) via delegation.
- [ ] **Step 2:** wire each item, reusing CEO handlers: Mark Complete→`ceoGpTaskAction(…, 'completed')` (for `email_triage` tasks, route to the resolve flow from 3d.5 instead); Start→`'in_progress'`; Waiting on External→`'waiting_on_external'` (extend `ceoGpTaskAction` to accept any status); Email GP→mailto; WhatsApp→open link; Send Nudge→`openNudgeModal`; Escalate→`ceoGpTaskEscalate`. Wire the **guided-action** buttons (map `getGuidedAction` actions to the existing `ceoDoc*`/doc handlers or the relevant action) and the **schedule-call** button → port `scheduleCallFromTask` (`POST /api/admin/calls/schedule` `{case_id,stage}` then `PUT /api/admin/task?id=` `{status:'waiting_on_gp'}`), refresh after.
- [ ] **Step 3:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP Tasks — per-task ••• menu + guided/schedule controls (RSO parity)`.

---

### Task 3d.5: Email-triage expanded panel parity

**Files:** `pages/ceo-dashboard.html` (et-panel markup + handlers).

- [ ] **Step 1:** for `task_type==='email_triage'` rows, port the `.et-panel` (2798–2830) dark: Email (from/subject/body snippet + Open-in-Gmail link), GP Context grid (stage/practice/open-tasks/quals — omit quals if absent), **Generate Suggested Reply** (`POST /api/admin/email-triage/suggest-reply`), reply textarea + **Copy to Clipboard** + **Open Gmail to Reply**, **✓ Mark Resolved** (`POST /api/admin/email-triage/check-reply` → if replied, complete; else show the "reply via Gmail first" error). Toggle the panel open on row click (mirror admin 5982–6017).
- [ ] **Step 2:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP Tasks — email-triage panel parity (suggest reply, resolve)`.

---

### Task 3d.6: Task-detail accordion parity (document / AHPRA / SPPA detail views)

**Files:** `pages/ceo-dashboard.html` (`loadGpTaskDetail` + renderOps* ports + expand wiring).

- [ ] **Step 1:** port `loadGpTaskDetail(taskId)` (5762) — fetch `GET /api/admin/task/messages?taskId=` + `GET /api/admin/task/documents?taskId=`, then dispatch by `task_type` to ported dark renderers: `renderOpsPracticePackChild` (5100), `renderOpsSppa00` (4797), `renderOpsAhpraActionItem` (5267), `renderOpsAltSupervisorCvReview` (5069), else `renderOpsGeneric` (5597). REUSE the CEO page's existing `ceoDocUpload/ceoDocApprove/ceoDocRequestRevision` for document controls inside these views where they overlap; port the message-thread display.
- [ ] **Step 2:** wire the expand-on-click (`data-gp-expand-task`) for the task types that have a detail panel (mirror admin 6240–6246): clicking the row toggles the `.gp-task-detail` panel and calls `loadGpTaskDetail`.
- [ ] **Step 3:** inline-compile OK; admin.html EMPTY diff. Commit `feat(ceo): GP Tasks — task-detail accordion parity (doc/AHPRA/SPPA detail + controls)`.
- [ ] **NOTE:** if a renderOps* function depends on an admin-only helper that is impractical to port faithfully, port what is cleanly portable, render the rest read-only, and record the exact gap in the task report (do NOT fake parity).

---

### Task 3d.7: Phase 3d verification + parity review gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5 (parity checklist):** produce a side-by-side checklist confirming EACH admin per-task control + header element now exists in the dark CEO GP-detail (profile meta line, header buttons, case-mgmt panel, stage-group headers, task badges, ••• menu items, guided/schedule buttons, email-triage panel, task-detail accordion). List any deferred/omitted items with the reason. No commit.
