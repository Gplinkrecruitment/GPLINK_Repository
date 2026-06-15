# CEO Phase 1 — Ops tasks under each RSO (separate build)

> Execute with the implement→review→fix loop. HARD CONSTRAINT: do NOT modify `pages/admin.html` (the RSO admin page). All UI work is in `pages/ceo-dashboard.html` (dark). New reads as `/api/ceo/*`; reuse existing `/api/admin/*` for actions only. After every task, `git diff --stat` must show `pages/admin.html` UNCHANGED.

**Goal:** In the CEO dashboard's RSO Oversight, opening an RSO shows that RSO's open ops tasks (grouped by GP), dark-themed, with view + mark-complete actions — pulled from a new `/api/ceo/rso/:id/ops` endpoint. Remove the separate "Ops Queue" nav link (ops now lives under RSO Oversight).

**Context (verified):** `/api/admin/ops/queue` (server.js:35871) loads active `registration_tasks` + enriches with case/GP (cases loaded `select=*` at 35906, so `assigned_rso` is available). `lib/ceo-metrics.js` `_caseRsoKey` (line ~206) = `c.assigned_rso || '__unassigned__'`. CEO page: `openRsoDetail(rsoId)` (ceo-dashboard.html:1981) fetches `/api/ceo/rso/:id/summary` and renders the GP list — add the ops section there. `requireSuperAdminSession` gates `/api/ceo/*`.

---

### Task 1.1: lib helper `opsTasksForRso` + tests

**Files:** Modify `lib/ceo-metrics.js`; Modify `tests/ceo-metrics.test.js`

- [ ] **Step 1 (test):** append a describe block to `tests/ceo-metrics.test.js` that builds a small fixture: tasks `[{id:'t1',case_id:'c1'},{id:'t2',case_id:'c2'},{id:'t3',case_id:null}]` and a caseById map `{c1:{assigned_rso:'rsoA'}, c2:{assigned_rso:null}}`. Assert `opsTasksForRso(tasks, caseById, 'rsoA').map(t=>t.id)` === `['t1']`; `opsTasksForRso(tasks, caseById, '__unassigned__').map(t=>t.id)` === `['t2','t3']` (c2 has null rso; t3 has no case). Run `npx vitest run tests/ceo-metrics.test.js -t "opsTasksForRso"` → FAIL (not a function).
- [ ] **Step 2 (impl):** add to `lib/ceo-metrics.js` (and export):
```js
function opsTasksForRso(tasks, caseById, rsoId) {
  var out = [];
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i];
    var c = t && t.case_id ? caseById[t.case_id] : null;
    var key = (c && c.assigned_rso) ? c.assigned_rso : '__unassigned__';
    if (key === rsoId) out.push(t);
  }
  return out;
}
```
- [ ] **Step 3:** run the test → PASS; `node --check lib/ceo-metrics.js`. Confirm `git diff --stat` shows no `pages/admin.html`.
- [ ] **Step 4:** commit `feat(ceo): opsTasksForRso lib helper for per-RSO ops grouping`.

---

### Task 1.2: server `GET /api/ceo/rso/:id/ops`

**Files:** Modify `server.js` (add the endpoint near the other `/api/ceo/rso/:id/*` handlers; reuse the data-loading approach of `/api/admin/ops/queue` at server.js:35871).

- [ ] **Step 1:** add a handler for `GET /api/ceo/rso/<id>/ops` (parse `id` from the path like the existing `/api/ceo/rso/:id/summary`). `var admin = requireSuperAdminSession(req,res); if(!admin) return;`.
- [ ] **Step 2:** load the same active tasks + cases the ops queue uses (active `registration_tasks` statuses open/in_progress/waiting/waiting_on_gp/waiting_on_practice/waiting_on_external/escalated; cases `select=id,user_id,assigned_rso,practice_name`; GP names from user_profiles). Build `caseById`. Filter with `ceoMetrics.opsTasksForRso(tasks, caseById, id)`.
- [ ] **Step 3:** enrich each returned task to a display shape: `{ id, title, task_type, status, priority, due_date, gp_name, gp_user_id, case_id, gmail_thread_id, gmail_message_id, email_sender }` (mirror the fields the admin ops queue enrichment exposes at server.js:35926-35940, plus gp_name). Sort by priority/urgency then due_date. Return `sendJson(res,200,{ ok:true, rso_id:id, tasks:enriched })`.
- [ ] **Step 4:** `node --check server.js`. Confirm no `/api/admin/*` endpoint was modified and `pages/admin.html` untouched (`git diff --stat`).
- [ ] **Step 5:** commit `feat(ceo): GET /api/ceo/rso/:id/ops — per-RSO ops task list`.

---

### Task 1.3: CEO page — render the per-RSO ops board in the RSO drill-in

**Files:** Modify `pages/ceo-dashboard.html` (extend `openRsoDetail`, ceo-dashboard.html:1981-2013; add CSS for ops rows using existing dark tokens).

- [ ] **Step 1:** after the GP list in `openRsoDetail` (after the `rso-gp-list` block, before `c.innerHTML = html`), append an Ops section container and, after setting innerHTML, fetch `/api/ceo/rso/:id/ops` and render into it (or build the ops HTML inline after a second await). Render tasks **grouped by `gp_name`** (collapsible GP header like the RSO has), each task row showing: title, a `task_type` subtitle, a due/overdue indicator, and action buttons.
- [ ] **Step 2:** actions (reuse existing endpoints, no admin.html changes):
  - For email tasks (`task_type` includes `email`): a **View email** button → open the Gmail thread (if `gmail_thread_id`) in a new tab, or a read-only viewer.
  - **Mark done** button → `PATCH /api/admin/tasks?id=<taskId>` body `{status:'completed'}` (the existing task-update endpoint), then refresh the ops list. (Confirm the exact admin task-update route/shape by reading server.js before wiring.)
  - **Open GP** → switch to that GP (for now, no-op placeholder or scroll; full GP detail is Phase 3).
- [ ] **Step 3:** add dark CSS for `.ceo-ops-*` rows reusing `--panel/--panel-border/--text/--text-muted/--red/--blue` tokens (match the existing `.rso-gp-row` styling).
- [ ] **Step 4:** verify inline `<script>` compiles (`vm.compileFunction`). Confirm `git diff --stat` shows `pages/admin.html` UNCHANGED.
- [ ] **Step 5:** commit `feat(ceo): per-RSO ops task board in RSO Oversight drill-in`.

---

### Task 1.4: CEO nav — drop the separate "Ops Queue" link (ops now under RSO Oversight)

**Files:** Modify `pages/ceo-dashboard.html` (nav at ~905-915); Modify `tests/ceo-standalone-ui.test.js`.

- [ ] **Step 1:** remove the `<a class="nav-item" href="/pages/admin?view=tools">Ops Queue</a>` nav item from the CEO top nav (ops is now reached by opening an RSO under RSO Oversight). Leave the other operational links for now (they convert in later phases).
- [ ] **Step 2:** update `tests/ceo-standalone-ui.test.js`: remove/replace the assertion that the CEO nav links to `?view=tools`; keep the others. Add an assertion that the CEO page contains the per-RSO ops wiring (e.g. a fetch to `/api/ceo/rso/` ... `/ops`). Run `npx vitest run tests/ceo-standalone-ui.test.js` → PASS.
- [ ] **Step 3:** commit `feat(ceo): ops lives under RSO Oversight; drop standalone Ops Queue nav link`.

---

### Task 1.5: Phase 1 verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages (vm.compileFunction over each `<script>` in ceo-dashboard.html and admin.html).
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT CHECK):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY (admin.html unchanged vs the pushed baseline). If not empty, revert the admin.html changes.
- [ ] **Step 5:** report totals; no commit (verification only).
