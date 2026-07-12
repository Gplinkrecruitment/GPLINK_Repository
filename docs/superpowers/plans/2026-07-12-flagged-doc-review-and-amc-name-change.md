# Flagged-Document Review Routing + AMC Name-Change Notice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every AI-flagged onboarding qualification reliably create an approve/reject task, route un-placed candidates' checks to the least-loaded RSO in a separate "Document checks" area, and surface an AMC name-change-evidence notice to the doctor once an RSO approves a name-mismatched document.

**Architecture:** All server logic lives in the monolith `server.js`; the least-loaded selector extends `lib/ceo-metrics.js`; two GP/admin pages are plain HTML with inline script (`pages/amc.html`, `pages/admin.html`). A new hourly cron reconciles orphaned documents. A small migration adds two `user_profiles` columns. The task-level `registration_tasks.assignee` column (already exists) is used to route candidate checks without assigning the case.

**Tech Stack:** Node http (`server.js`), Supabase REST (`supabaseDbRequest`), vitest (`tests/`), vanilla HTML/CSS/JS pages, Vercel cron.

## Global Constraints

- **Never assign the case for un-placed candidates.** Route via `registration_tasks.assignee` only; leave `registration_cases.assigned_rso`/`assigned_va` null. (Spec Part 2.)
- **Certification is out of scope here** — handled on branch `worktree-onboarding-cert-not-required`. Do not touch `isCertificationRequiredDocKey`.
- **`registration_cases` has no `metadata` column in prod** — the name-change flag lives on `user_profiles`.
- **Least-loaded = min `open_tasks`** among roster RSOs that are `active` and NOT `on_leave`, excluding the hello@ archive mailbox and the `__unassigned__` bucket. Tie-break: lowest `case_count`, then name.
- **Name-change flag is set only on RSO approval** of a qual doc whose scan `nameMatch === 'mismatch'`.
- **Anchor edits by grep**, not raw line numbers (they drift as you edit). Run `node --check server.js` after every server.js edit. Commit after each task with the SSH key: `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git ...`.
- Node binary for local commands: `/tmp/node-v20.18.1-darwin-arm64/bin/node`.

---

### Task 1: Migration — `user_profiles` name-change columns

**Files:**
- Create: `supabase/migrations/20260712140000_user_profiles_name_change.sql`

**Interfaces:**
- Produces: `user_profiles.name_change_detected boolean`, `user_profiles.name_change_note text`.

- [ ] **Step 1: Write the migration**

```sql
-- Name-change evidence flag: set when an RSO approves a qualification document
-- whose name differs from the account (a genuine name change). Drives the AMC
-- "Establishment" step name-change-evidence notice.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS name_change_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name_change_note text;
```

- [ ] **Step 2: Apply to prod** (memory: rpc/exec_sql with SERVICE_ROLE_KEY, param name `query`, schema-qualify names). Use a one-off node script reading `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) that POSTs to `/rest/v1/rpc/exec_sql` with `{ query: "<the ALTER above>" }`.

- [ ] **Step 3: Verify columns exist**

Run a node script: `GET /rest/v1/user_profiles?select=name_change_detected,name_change_note&limit=1`.
Expected: HTTP 200 with an array (empty or one row) — NOT a `42703 column does not exist` error.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260712140000_user_profiles_name_change.sql
git commit -m "feat(db): add user_profiles name_change_detected + name_change_note"
```

---

### Task 2: `pickLeastLoadedRso()` in `lib/ceo-metrics.js`

**Files:**
- Modify: `lib/ceo-metrics.js` (add export near `computeRsoWorkload`)
- Test: `tests/least-loaded-rso.test.js`

**Interfaces:**
- Consumes: `computeRsoWorkload(activeCases, tasks, rsoRoster, todayStr)` → array of `{rso_id, rso_name, case_count, open_tasks, overdue_tasks}` plus an `'__unassigned__'` entry.
- Produces: `pickLeastLoadedRso(activeCases, tasks, rsoRoster, todayStr, { excludeUserIds = [] } = {})` → `rso_id` string (user_id) of the least-loaded eligible RSO, or `null` if none eligible.

- [ ] **Step 1: Write the failing test** `tests/least-loaded-rso.test.js`

```js
import { describe, it, expect } from 'vitest';
import { pickLeastLoadedRso } from '../lib/ceo-metrics.js';

const roster = [
  { user_id: 'rso-a', name: 'Aisha', active: true, on_leave: false },
  { user_id: 'rso-b', name: 'Ben',   active: true, on_leave: false },
  { user_id: 'rso-c', name: 'Cara',  active: true, on_leave: true  },
];
const today = '2026-07-12';
// helper: build N open tasks owned (via case) by an rso
function cases(map) { return Object.keys(map).map((id, i) => ({ id: 'case-'+i, assigned_rso: map[id] })); }
function tasksFor(counts) {
  const out = [];
  Object.keys(counts).forEach((caseId) => { for (let i=0;i<counts[caseId];i++) out.push({ id: caseId+'-t'+i, case_id: caseId, status: 'open' }); });
  return out;
}

describe('pickLeastLoadedRso', () => {
  it('returns the active RSO with the fewest open tasks', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 3, cb: 1 });
    expect(pickLeastLoadedRso(c, t, roster, today)).toBe('rso-b');
  });
  it('skips on-leave RSOs even if they have zero tasks', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 2, cb: 2 }); // rso-c (on leave) has 0 but is ineligible
    const picked = pickLeastLoadedRso(c, t, roster, today);
    expect(['rso-a','rso-b']).toContain(picked);
    expect(picked).not.toBe('rso-c');
  });
  it('honours excludeUserIds (e.g. archive mailbox)', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 1, cb: 5 });
    expect(pickLeastLoadedRso(c, t, roster, today, { excludeUserIds: ['rso-a'] })).toBe('rso-b');
  });
  it('returns null when no eligible RSO exists', () => {
    const onlyLeave = [{ user_id:'rso-c', name:'Cara', active:true, on_leave:true }];
    expect(pickLeastLoadedRso([], [], onlyLeave, today)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/least-loaded-rso.test.js`
Expected: FAIL — `pickLeastLoadedRso is not a function`.

- [ ] **Step 3: Implement `pickLeastLoadedRso`** in `lib/ceo-metrics.js` (add after `computeRsoWorkload`; export it the same way the module exports `computeRsoWorkload`).

```js
// Choose the RSO with the fewest OPEN tasks, for routing an un-placed candidate's
// document check. Excludes on-leave / inactive RSOs, the '__unassigned__' bucket,
// and any user_id in opts.excludeUserIds (e.g. the hello@ archive mailbox).
// Tie-break: fewest cases, then name. Returns a user_id string or null.
function pickLeastLoadedRso(activeCases, tasks, rsoRoster, todayStr, opts = {}) {
  const exclude = new Set((opts.excludeUserIds || []).filter(Boolean));
  const rows = computeRsoWorkload(activeCases, tasks, rsoRoster, todayStr)
    .filter((r) => r && r.rso_id && r.rso_id !== '__unassigned__' && !exclude.has(r.rso_id));
  const activeById = {};
  (rsoRoster || []).forEach((r) => { if (r && r.user_id) activeById[r.user_id] = r; });
  const eligible = rows.filter((r) => {
    const m = activeById[r.rso_id];
    return m && m.active !== false && m.on_leave !== true;
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    (a.open_tasks - b.open_tasks) ||
    (a.case_count - b.case_count) ||
    String(a.rso_name || '').localeCompare(String(b.rso_name || '')));
  return eligible[0].rso_id;
}
```

Add `pickLeastLoadedRso` to the module's exports alongside `computeRsoWorkload`.

- [ ] **Step 4: Run test to verify it passes**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/least-loaded-rso.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ceo-metrics.js tests/least-loaded-rso.test.js
git commit -m "feat(rso): pickLeastLoadedRso selector for routing candidate checks"
```

---

### Task 3: Route flagged-doc tasks to the least-loaded RSO (server.js)

**Files:**
- Modify: `server.js` — `createFlaggedDocTask` (grep `function createFlaggedDocTask`) and its callers/`_createRegTask` usage.

**Interfaces:**
- Consumes: `pickLeastLoadedRso` (Task 2), `computeRsoWorkload`, `loadRsoTeam()`, `supabaseDbRequest`.
- Produces: a helper `async function resolveCandidateCheckAssignee(caseRow)` → returns a user_id (least-loaded RSO) when `caseRow` has no `assigned_rso` and no `assigned_va`, else `null` (assigned cases keep case-derived visibility, no task assignee needed).

- [ ] **Step 1:** Add `resolveCandidateCheckAssignee` near `createFlaggedDocTask`. It: returns null if the case is assigned (`assigned_rso || assigned_va`); otherwise loads active cases (`registration_cases?select=id,assigned_rso,assigned_va&status=eq.active`), open tasks (`registration_tasks?select=id,case_id,status,assignee&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,escalated)`), the roster (`loadRsoTeam()`), computes `todayStr` (`new Date().toISOString().slice(0,10)`), and returns `pickLeastLoadedRso(cases, tasks, roster, todayStr, { excludeUserIds: [<archive mailbox user_id if resolvable>] })`. Import `pickLeastLoadedRso` from `./lib/ceo-metrics.js` where `computeRsoWorkload` is already required.

```js
async function resolveCandidateCheckAssignee(caseRow) {
  if (!caseRow) return null;
  if (caseRow.assigned_rso || caseRow.assigned_va) return null; // assigned → case scoping covers it
  try {
    const [casesRes, tasksRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=id,assigned_rso,assigned_va&status=eq.active'),
      supabaseDbRequest('registration_tasks', 'select=id,case_id,status,assignee&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,escalated)')
    ]);
    const activeCases = casesRes.ok && Array.isArray(casesRes.data) ? casesRes.data : [];
    const tasks = tasksRes.ok && Array.isArray(tasksRes.data) ? tasksRes.data : [];
    const roster = await loadRsoTeam();
    const todayStr = new Date().toISOString().slice(0, 10);
    return pickLeastLoadedRso(activeCases, tasks, roster, todayStr) || null;
  } catch (e) { console.error('[candidate-check] assignee resolution failed:', e && e.message); return null; }
}
```

- [ ] **Step 2:** In `createFlaggedDocTask` (and `createDocReviewTask` if it is the one used for onboarding origin), before `_createRegTask(...)`, fetch the case row (it already resolves `gpCase`), call `resolveCandidateCheckAssignee(gpCase)`, and include `assignee: <result>` in the task payload when non-null. Keep `assignee` unset for assigned cases.

- [ ] **Step 3: Verify syntax**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 4: Sanity check the routing** with a node script that requires `lib/ceo-metrics.js` and simulates one unassigned case + roster to confirm a user_id comes back (no server needed). Expected: prints a roster user_id.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(tasks): route un-placed candidate doc checks to least-loaded RSO"
```

---

### Task 4: Reconciliation cron for orphaned `under_review` docs (server.js + vercel.json)

**Files:**
- Modify: `server.js` — add `pathname === '/api/cron/reconcile-doc-tasks'` handler (model on `/api/cron/reconcile-followups`, grep it).
- Modify: `vercel.json` — add cron entry.

**Interfaces:**
- Consumes: `createFlaggedDocTask` / `resolveCandidateCheckAssignee` (Task 3), `supabaseDbRequest`.

- [ ] **Step 1:** Add the cron handler. Guard with `CRON_SECRET` exactly like `reconcile-followups` (`String(process.env.CRON_SECRET||'').trim()`; accept `Authorization: Bearer`, `x-cron-secret`, or `?secret=`). Logic: query `user_documents?select=id,user_id,document_key,country_code,status,flag_reason&status=eq.under_review` (and also rows with a non-empty `flag_reason`). For each, resolve the GP's case; check for an existing OPEN review task for that `(case_id, canonicalQualKey(document_key))` (`registration_tasks?...&task_type=in.(flagged_doc,doc_review)&status=in.(open,in_progress,waiting)`); if none, create it via the same reasoned path used at upload (reuse `createFlaggedDocTask(userId, documentKey, label, reason, reviewStage)` with `reviewStage` inferred from the doc key / origin). Return JSON `{ ok:true, scanned, created }`. Cap the batch (e.g. 200) and `log` if capped.

- [ ] **Step 2:** Add to `vercel.json` `crons`:

```json
{ "path": "/api/cron/reconcile-doc-tasks", "schedule": "30 * * * *" }
```

- [ ] **Step 3: Verify** `node --check server.js` (exit 0) and `node -e "JSON.parse(require('fs').readFileSync('vercel.json'))"` (no throw).

- [ ] **Step 4:** Local smoke test: start the server locally (`PORT=3000 node server.js` with `.env`) and `curl` the endpoint with the secret; expect `{ ok:true, scanned:<n>, created:<n> }` (may be 0/0 locally without prod DB — acceptable; the goal is no crash). If local DB access is unavailable, skip and rely on prod verification in Task 9.

- [ ] **Step 5: Commit**

```bash
git add server.js vercel.json
git commit -m "feat(cron): hourly reconcile of under_review docs missing a review task"
```

---

### Task 5: Task feeds honour `assignee` on unassigned cases (server.js + test)

**Files:**
- Modify: `server.js` — `GET /api/admin/ops/queue` (grep `'/api/admin/ops/queue'`) filter; `GET /api/admin/tasks` (grep `'/api/admin/tasks'`) filter.
- Test: `tests/candidate-check-scoping.test.js` (follow style of `tests/admin-gp-scoping.test.js`).

**Interfaces:**
- Consumes: `gpScopeAllowsCase(scope, caseRow)`, `caseAssignedToRso`.
- Produces: a predicate `taskVisibleToRso(scope, task, caseRow)` = `gpScopeAllowsCase(scope, caseRow)` OR (`task.assignee && scope.rsoUserId && task.assignee === scope.rsoUserId`). Super-admins keep full visibility.

- [ ] **Step 1: Write the failing test** `tests/candidate-check-scoping.test.js` covering: (a) assigned-case task visible to that RSO; (b) unassigned-case task with `assignee === me` visible to me; (c) unassigned-case task assigned to someone else NOT visible; (d) super-admin sees all. Import the exported `taskVisibleToRso` from server (or a small extracted module — if extraction is cleaner, put the predicate in `lib/task-scoping.js` and require it in server.js; mirror how `admin-gp-scoping.test.js` imports what it tests).

- [ ] **Step 2: Run test → FAIL** (`taskVisibleToRso` undefined). Command: `/tmp/node-v20.18.1-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/candidate-check-scoping.test.js`.

- [ ] **Step 3: Implement** `taskVisibleToRso` and use it in BOTH feeds in place of the current `gpScopeAllowsCase(opsScope, caseMap[t.case_id])` filter. Keep the super-admin path unchanged (it already returns true via `gpScopeAllowsCase`).

```js
function taskVisibleToRso(scope, task, caseRow) {
  if (gpScopeAllowsCase(scope, caseRow)) return true;
  if (scope && scope.superAdmin) return true;
  return !!(task && task.assignee && scope && scope.rsoUserId && task.assignee === scope.rsoUserId);
}
```

- [ ] **Step 4: Run test → PASS.** Then run the existing scoping suite to ensure no regression: `/tmp/node-v20.18.1-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/admin-gp-scoping.test.js`. Expected: PASS. Then `node --check server.js`.

- [ ] **Step 5: Commit**

```bash
git add server.js lib/task-scoping.js tests/candidate-check-scoping.test.js
git commit -m "feat(scoping): show assignee-owned tasks on unassigned cases to that RSO"
```

---

### Task 6: Name-change flag on approval + expose via `/api/state` (server.js)

**Files:**
- Modify: `server.js` — the doc-review approve handler (grep the endpoint that sets a qual doc to `approved` from the RSO modal, near `status: 'approved'` with `rejection_reason: ''`); the `/api/state` GET builder; and the scan-cache shape in `/api/admin/va/doc-review/ai-scan` (ensure a mismatch is discoverable at approval time).

**Interfaces:**
- Consumes: the cached scan `nameMatch` on the task metadata (from `/api/admin/va/doc-review/ai-scan`), `supabaseDbRequest`.
- Produces: on approve of a qual doc with `nameMatch==='mismatch'`, sets `user_profiles.name_change_detected=true` and `name_change_note='Document name: <nameFound>'`; `/api/state` response includes `nameChangeDetected` (bool) and `nameChangeNote` (string).

- [ ] **Step 1:** In the approve handler, after the doc is marked approved: determine whether this doc's scan showed a name mismatch. Prefer the cached `task.metadata.ai_scan.scan.nameMatch === 'mismatch'` (already stored by the ai-scan endpoint); fall back to comparing `scan.nameFound` vs the profile name via the existing `matchNames(...)`. If mismatch, PATCH `user_profiles?user_id=eq.<uid>` with `{ name_change_detected: true, name_change_note: 'Document name: ' + nameFound }`.

- [ ] **Step 2:** In the `/api/state` GET response builder, read `user_profiles.name_change_detected, name_change_note` for the session user and include `nameChangeDetected` and `nameChangeNote` in the returned state object (default false/'' when absent).

- [ ] **Step 3: Verify** `node --check server.js` (exit 0).

- [ ] **Step 4:** Local/prod check via node script: PATCH a throwaway test profile's `name_change_detected=true`, then GET the profile column back; confirm round-trip. (Do NOT mutate Mercy here — that happens in Task 9 via the real approve flow.)

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(namechange): flag on RSO approval of a name-mismatched doc; expose in /api/state"
```

---

### Task 7: RSO dashboard — "Document checks" section + name-difference in review modal

**Files:**
- Modify: `pages/admin.html` — Ops Queue rendering (grep `renderOpsTable` / `loadOpsQueue`) and the doc-review modal scan display.

**Interfaces:**
- Consumes: `/api/admin/ops/queue` rows (now including candidate-check tasks with `assignee===me`, `case_stage`/assignment fields, `gp_name`, `related_document_key`, `ai_match_reasoning`).

- [ ] **Step 1:** In the ops-queue render, split rows into two groups: **caseload tasks** (case assigned to me) and **document checks** (task `assignee===me` AND case unassigned — detect via the row's assignment fields; if the endpoint doesn't already expose `assigned_rso_email`/`assignee`, add those fields to the `/api/admin/ops/queue` enrichment in server.js as part of this task). Render "Document checks" as a distinct section with the framing copy from the spec/mockup ("Candidate not placed — just verify this document; you won't be guiding them.") and a **Review document** button that opens the existing doc-review modal. Candidate rows must NOT appear in the assigned caseload list.

- [ ] **Step 2:** In the doc-review modal scan display, when `scan.nameMatch === 'mismatch'` (or name differs), render a prominent red line: "Name on document (<nameFound>) differs from account (<profileName>) — likely a name change. Approving records this as a name change." (Match the mockup's red banner.)

- [ ] **Step 3: Verify** the page parses: `/tmp/node-v20.18.1-darwin-arm64/bin/node -e "require('fs').readFileSync('pages/admin.html','utf8')"` and a bracket/tag sanity check; then load it in the local server and confirm no console errors (Task 9 covers the live check).

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html server.js
git commit -m "feat(admin): Document checks section for un-placed candidates + name-diff callout"
```

---

### Task 8: AMC page — name-change notice + "Show me where" modal + asset

**Files:**
- Create: `media/images/amc-name-change-reference.png` (copy the owner-provided AMC "2.4 Evidence" screenshot into the repo).
- Modify: `pages/amc.html` — `.warn-danger` CSS; conditional red notice + action-card block + modal, all gated on `currentTabKey === 'upload_credentials'` and `state.nameChangeDetected`.

**Interfaces:**
- Consumes: `state.nameChangeDetected` from `/api/state` (Task 6). `openModal(el, triggerEl)` / `data-close` modal machinery (already in amc.html).

- [ ] **Step 1:** Copy the asset. The source path uses a macOS narrow-space filename — copy with a glob:
```bash
cp /Users/gplinkrecruitment/Desktop/Screenshot*11.08.18*PM.png "media/images/amc-name-change-reference.png"
```
Confirm bytes > 0.

- [ ] **Step 2:** Add `.warn.warn-danger` CSS next to `.warn` (grep `.warn {`): red variant using `--gp-red*` tokens (border/left-border `--gp-red`, bg `--gp-red-soft`, title/text `--gp-red-ink`).

- [ ] **Step 3:** Add a hidden modal (clone `#supportModal`, grep it) `#nameChangeModal` whose `.modal-card` contains `<img src="/media/images/amc-name-change-reference.png" alt="AMC portal step 2.4 Evidence — where to upload name-change evidence" style="width:100%;border-radius:var(--gp-r-md)">` and a `<button data-close="nameChangeModal">Close</button>`.

- [ ] **Step 4:** In `renderStepContent` (grep `renderStepContent`), when `currentTabKey === 'upload_credentials'` and the loaded state has `nameChangeDetected` truthy: (a) show `#stepWarning` with the `warn-danger` class, title "Name change detected — extra evidence required", text as per mockup; (b) append a red name-change block to the `.action-card` HTML listing Marriage Certificate / Change of Name legal document / Deed Poll / Birth Certificate; (c) add a "Show me where" button wired to `openModal(document.getElementById('nameChangeModal'), thatButton)`. Read the flag from the same state object the page already hydrates (ensure the page captures `nameChangeDetected` from `/api/state`; if it doesn't read `/api/state` fields today, add a light read in the existing state-load path).

- [ ] **Step 5:** Bump the amc.html cache-buster (`?v=YYYYMMDD` convention) if the page is referenced with one; otherwise ensure no-cache (JS served no-cache already).

- [ ] **Step 6: Verify** `node -e "require('fs').readFileSync('pages/amc.html','utf8')"`; bracket/tag balance check; then in the local server, load `/pages/amc.html`, force `nameChangeDetected=true` in the state fixture, switch to the Establishment tab, confirm the red notice shows and "Show me where" opens the screenshot.

- [ ] **Step 7: Commit**

```bash
git add pages/amc.html media/images/amc-name-change-reference.png
git commit -m "feat(amc): name-change evidence notice + Show me where modal on Establishment step"
```

---

### Task 9: End-to-end verification (the Mercy path)

**Files:** none (verification + prod data action).

- [ ] **Step 1:** Run the full test suite: `/tmp/node-v20.18.1-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/least-loaded-rso.test.js tests/candidate-check-scoping.test.js tests/admin-gp-scoping.test.js`. Expected: all PASS.
- [ ] **Step 2:** Start the app locally with `.env`; drive the two screens (admin Ops Queue "Document checks"; amc Establishment with a name-change fixture). Capture screenshots. Confirm they match the approved mockup.
- [ ] **Step 3 (after the PR is merged/deployed — NOT before):** trigger Mercy's real flow: re-run the AI verification on her `onboarding_primary_med_degree` (via the RSO ai-scan/re-scan or by setting the doc `under_review` and letting the reconcile cron route it) so the SYSTEM creates the routed flagged-doc task. Confirm it appears in the least-loaded RSO's "Document checks". Do not hand-fabricate the task.
- [ ] **Step 4:** Confirm approving Mercy's degree sets `user_profiles.name_change_detected=true` and that her AMC Establishment step shows the notice.
- [ ] **Step 5:** Report results (screenshots + what was verified) to the owner in plain English.

---

## Self-Review

- **Spec coverage:** Part 1 → Tasks 3 (reliable/routed create) + 4 (reconcile cron). Part 2 → Tasks 2 (selector) + 3 (route) + 5 (visibility) + 7 (UI). Part 3 → Tasks 1 (columns) + 6 (flag+state) + 7 (RSO name-diff) + 8 (AMC notice). Verification → Task 9. All spec sections covered.
- **Placeholders:** none — real SQL, real selector code, real predicate, real cron guard, concrete grep anchors.
- **Type consistency:** `pickLeastLoadedRso(...)` and `taskVisibleToRso(scope, task, caseRow)` and `resolveCandidateCheckAssignee(caseRow)` names are used identically across tasks. `nameChangeDetected`/`nameChangeNote` (camel, API) vs `name_change_detected`/`name_change_note` (snake, DB) are used consistently on their respective sides.
