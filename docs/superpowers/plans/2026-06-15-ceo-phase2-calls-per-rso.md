# CEO Phase 2 — Calls under each RSO (separate build)

> Implement→review→fix loop. HARD CONSTRAINT: do NOT modify `pages/admin.html`. All UI in `pages/ceo-dashboard.html` (dark). New reads as `/api/ceo/*`; reuse `/api/admin/*` for actions only. After each task `git diff --stat -- pages/admin.html` must be EMPTY.

**Goal:** In the CEO dashboard's RSO drill-in (`openRsoDetail`, ceo-dashboard.html), below the ops board, show that RSO's scheduled calls — grouped (Upcoming / Awaiting booking / Completed) — dark-themed, from a new `GET /api/ceo/rso/:id/calls`.

**Context (verified during scoping):** `scheduled_calls` rows carry `assigned_rso_email` AND `assigned_rso_name` and are normalized by `normalizeScheduledCallForApi` (server.js:~559, spreads the full row). `/api/admin/calls` (requireAdminSession) lists them. The CEO `:id` is the RSO's **user_id**, but calls link by **email** — so resolve `id → email` via `loadRsoTeam()` (server.js:~300) then filter by `assigned_rso_email`. `'__unassigned__'` → calls with no `assigned_rso_email`. RSO drill-in is `openRsoDetail(rsoId)` at ceo-dashboard.html:~1981; Phase 1 added `loadRsoOps`/`#ceoOpsBoard` there — add a calls section the same way.

---

### Task 2.1: lib helper `callsForRso` + tests

**Files:** Modify `lib/ceo-metrics.js`; Modify `tests/ceo-metrics.test.js`

- [ ] **Step 1 (test):** append a describe block: fixture calls `[{id:'k1',assigned_rso_email:'a@x.com'},{id:'k2',assigned_rso_email:'B@X.com'},{id:'k3',assigned_rso_email:''},{id:'k4'}]`. Assert `callsForRso(calls,'a@x.com').map(c=>c.id)` === `['k1']`; case-insensitive: `callsForRso(calls,'b@x.com').map(c=>c.id)` === `['k2']`; unassigned: `callsForRso(calls,null).map(c=>c.id)` === `['k3','k4']`. Run `-t "callsForRso"` → FAIL.
- [ ] **Step 2 (impl):** add + export in `lib/ceo-metrics.js`:
```js
function callsForRso(calls, rsoEmail) {
  var email = rsoEmail ? String(rsoEmail).trim().toLowerCase() : '';
  var out = [];
  for (var i = 0; i < (calls || []).length; i++) {
    var c = calls[i];
    var e = (c && c.assigned_rso_email) ? String(c.assigned_rso_email).trim().toLowerCase() : '';
    if (email) { if (e === email) out.push(c); }
    else { if (!e) out.push(c); }
  }
  return out;
}
```
- [ ] **Step 3:** test → PASS; `node --check lib/ceo-metrics.js`; `git diff --stat -- pages/admin.html` EMPTY.
- [ ] **Step 4:** commit `feat(ceo): callsForRso lib helper`.

---

### Task 2.2: server `GET /api/ceo/rso/:id/calls`

**Files:** Modify `server.js` (add beside `/api/ceo/rso/:id/ops`).

- [ ] **Step 1:** path-match `/^\/api\/ceo\/rso\/([^\/]+)\/calls$/` for GET; `decodeURIComponent` the id; `requireSuperAdminSession`; the same `isSupabaseDbConfigured` 503 guard as siblings.
- [ ] **Step 2:** resolve the RSO email: `var roster = await loadRsoTeam({includeInactive:true});` find the entry with `user_id === id`; `var rsoEmail = id === '__unassigned__' ? null : (entry && entry.email) || null`. (If id isn't `__unassigned__` and no entry/email is found, return `{ok:true, rso_id:id, calls:[]}`.)
- [ ] **Step 3:** load calls the way `/api/admin/calls` does (read that handler first and mirror its `scheduled_calls` query + `normalizeScheduledCallForApi` mapping). Filter with `ceoMetrics.callsForRso(calls, rsoEmail)`. Return `{ ok:true, rso_id:id, calls:filtered }`.
- [ ] **Step 4:** `node --check server.js`; confirm no `/api/admin/*` change and `pages/admin.html` untouched.
- [ ] **Step 5:** commit `feat(ceo): GET /api/ceo/rso/:id/calls — per-RSO scheduled calls`.

---

### Task 2.3: CEO page — calls section in the RSO drill-in

**Files:** Modify `pages/ceo-dashboard.html` (extend `openRsoDetail` / add a `loadRsoCalls` like `loadRsoOps`; dark CSS).

- [ ] **Step 1:** after the ops board container, append a `<div id="ceoCallsBoard">` section; after innerHTML, call `loadRsoCalls(rsoId)` which fetches `/api/ceo/rso/:id/calls` and renders the calls grouped into **Upcoming** (status booked/invited with a future `scheduled_at`), **Awaiting booking** (invited/no scheduled time), **Completed** (status completed). Each row: GP name, scheduled time (formatted), status pill, and a **Join/Zoom** link when a zoom/meeting URL field is present (use whatever URL field the normalized call carries — read the normalize output).
- [ ] **Step 2:** read-only for Phase 2 (view + open zoom link). No write actions needed; do NOT add admin.html changes.
- [ ] **Step 3:** add dark `.ceo-calls-*` CSS reusing existing tokens (match `.ceo-ops-*`/`.rso-gp-row`).
- [ ] **Step 4:** inline `<script>` compiles (vm.compileFunction); `git diff --stat -- pages/admin.html` EMPTY.
- [ ] **Step 5:** commit `feat(ceo): per-RSO scheduled-calls section in RSO Oversight drill-in`.

---

### Task 2.4: Phase 2 verification gate

- [ ] **Step 1:** `node --check server.js && node --check lib/ceo-metrics.js`.
- [ ] **Step 2:** inline-script compile both pages.
- [ ] **Step 3:** `npx vitest run` — full suite green.
- [ ] **Step 4 (HARD CONSTRAINT):** `git diff --stat origin/worktree-ceo-detach-email-routing -- pages/admin.html` must be EMPTY.
- [ ] **Step 5:** report totals; no commit.
