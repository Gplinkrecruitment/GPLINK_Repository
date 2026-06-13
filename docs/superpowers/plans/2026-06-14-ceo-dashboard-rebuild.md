# CEO Command Centre Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach the CEO Command Centre into a standalone, super-admin-gated page with full admin abilities plus RSO oversight (all RSOs, the GPs under each, accurate metrics, act on any task), and fix all 70 confirmed audit discrepancies.

**Architecture:** A new pure module `lib/ceo-metrics.js` becomes the single source of truth for every metric and its drilldown id-list (so KPI counts and drilldowns cannot diverge). An additive migration adds durable per-GP RSO ownership (`assigned_rso`), an editable `rso_team` roster, and `blocker_set_at`. CEO endpoints are refactored onto the metrics module; RSO reassignment reuses the existing Gmail thread-transfer machinery; the CEO page becomes standalone with a real server-side auth gate.

**Tech Stack:** Node.js (single `server.js`), vanilla HTML/JS pages, Supabase (Postgres) + local JSON fallback, vitest, Gmail API (googleapis), Vercel deploy.

**Spec:** `docs/superpowers/specs/2026-06-14-ceo-dashboard-rebuild-design.md`. **Audit:** 70 confirmed findings (see `audit-summary.txt`). Phases below are ordered; Phase 1 (metrics module) is foundational for Phase 3.

---

## Phases

1. Foundational metrics module (`lib/ceo-metrics.js`) + unit tests
2. Database migration (assigned_rso, rso_team, blocker_set_at)
3. Refactor CEO endpoints to consume `lib/ceo-metrics`
4. RSO oversight endpoints + reassignment + Gmail transfer
5. Action reliability + server-side metric semantics
6. Auth hardening for the standalone CEO page
7. Integration & Technical Hub honesty
8. Standalone CEO page + UI (RSO oversight, VA→RSO, clickable KPIs, RSO picker)

---

## Phase 1: Foundational metrics module (lib/ceo-metrics.js) + unit tests

Goal: create one pure, DB-free module that is the single source of truth for every CEO metric and its drilldown id-list, so a KPI and its drilldown can never diverge, backed by a fixture-based unit suite that asserts `metricCount === drilldownList.length` for every metric and every period.

**Files:**
- Create: `lib/ceo-metrics.js`
- Create: `tests/ceo-metrics.test.js`
- Test: `tests/ceo-metrics.test.js` (run via `npx vitest run tests/ceo-metrics.test.js`)

All functions are pure: no `Date.now()`, no DB calls inside. Callers pass `nowMs` (number) and `todayStr` (`YYYY-MM-DD`). Export style is CommonJS `module.exports` (matches `lib/email-triage.js`, `lib/document-pipeline.js`); tests import named bindings (`import { ... } from '../lib/ceo-metrics.js'`).

---

### Task 1.1: Module skeleton — constants + status-set helpers (#8, #56, #28, #61)

**Files:** Create `lib/ceo-metrics.js`, Create `tests/ceo-metrics.test.js`

- [ ] **Step 1: Write failing test for the constants and status helpers.** Create `tests/ceo-metrics.test.js` with the shared fixture builder and the first describe block. The fixture is reused by every later task (extended in place).

```js
import { describe, it, expect } from 'vitest';
import * as M from '../lib/ceo-metrics.js';

// ── Shared fixture ──────────────────────────────────────────────
// nowMs fixed; todayStr derived from it. All ISO dates are relative.
const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // 2026-06-14T12:00:00Z
const TODAY = '2026-06-14';
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();

function makeFixture() {
  // cases: mix of stages, blocked, withdrawn, stale(>6mo), fresh
  const cases = [
    // c1 active, myintealth, fresh
    { id: 'c1', user_id: 'u1', stage: 'myintealth', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(2), updated_at: ago(2), created_at: ago(40) },
    // c2 active, amc, 10 days stale (inactive 7-14)
    { id: 'c2', user_id: 'u2', stage: 'amc', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(10), updated_at: ago(10), created_at: ago(60) },
    // c3 active, career, 20 days stale (cold 14d+), blocked
    { id: 'c3', user_id: 'u3', stage: 'career', status: 'blocked', blocker_status: 'waiting_on_gp', blocker_reason: 'docs', blocker_set_at: ago(12), assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(20), updated_at: ago(20), created_at: ago(90) },
    // c4 active, ahpra, fresh, blocker via status only (no blocker_set_at)
    { id: 'c4', user_id: 'u4', stage: 'ahpra', status: 'blocked', blocker_status: 'waiting_on_external', blocker_set_at: null, assigned_va: null, assigned_rso: null, last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(120) },
    // c5 active, pbs, 5 days stale
    { id: 'c5', user_id: 'u5', stage: 'pbs', status: 'active', assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(5), updated_at: ago(5), created_at: ago(150) },
    // c6 active, visa (deferred -> pbs index), fresh
    { id: 'c6', user_id: 'u6', stage: 'visa', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(100) },
    // c7 complete, completed 3 days ago (this month)
    { id: 'c7', user_id: 'u7', stage: 'complete', status: 'active', completed_at: ago(3), assigned_rso: 'rsoA', last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(200) },
    // c8 complete, completed 200 days ago (>6mo) — must still count toward all-time total
    { id: 'c8', user_id: 'u8', stage: 'complete', status: 'active', completed_at: ago(200), assigned_rso: 'rsoB', last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(400) },
    // c9 withdrawn — excluded everywhere
    { id: 'c9', user_id: 'u9', stage: 'amc', status: 'withdrawn', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(30) },
    // c10 active but >6mo stale — excluded unless allTime
    { id: 'c10', user_id: 'u10', stage: 'myintealth', status: 'active', assigned_rso: null, last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(300) },
    // c11 active, commencement, fresh
    { id: 'c11', user_id: 'u11', stage: 'commencement', status: 'active', assigned_rso: 'rsoB', last_gp_activity_at: ago(0), updated_at: ago(0), created_at: ago(80) }
  ];
  const tasks = [
    { id: 't1', case_id: 'c1', status: 'open', assignee: 'rsoA', due_date: ahead(5), created_at: ago(2), completed_at: null },
    { id: 't2', case_id: 'c1', status: 'in_progress', assignee: 'rsoA', due_date: ago(1), created_at: ago(10), completed_at: null }, // overdue
    { id: 't3', case_id: 'c2', status: 'escalated', assignee: 'rsoA', due_date: ago(2), created_at: ago(8), completed_at: null }, // overdue + escalated (counts)
    { id: 't4', case_id: 'c3', status: 'waiting_on_gp', assignee: 'rsoB', due_date: TODAY, created_at: ago(6), completed_at: null }, // due TODAY -> NOT overdue
    { id: 't5', case_id: 'c5', status: 'open', assignee: 'rsoB', due_date: null, created_at: ago(1), completed_at: null },
    { id: 't6', case_id: 'c9', status: 'open', assignee: 'rsoA', due_date: ago(3), created_at: ago(4), completed_at: null }, // withdrawn case -> excluded
    { id: 't7', case_id: 'c10', status: 'open', assignee: null, due_date: ago(3), created_at: ago(3), completed_at: null }, // stale case -> excluded
    { id: 't8', case_id: 'c4', status: 'cancelled', assignee: null, due_date: ago(2), created_at: ago(9), completed_at: null } // cancelled -> not open/overdue
  ];
  // completed tasks sample (separate query in prod) for task-health avg/this-week
  const completedSample = [
    { id: 'ct1', case_id: 'c1', status: 'completed', created_at: ago(9), completed_at: ago(2) },  // 7d resolve, this week
    { id: 'ct2', case_id: 'c2', status: 'completed', created_at: ago(20), completed_at: ago(11) }  // 9d resolve, not this week
  ];
  const apps = [
    { id: 'a1', user_id: 'u1', status: 'applied', applied_at: ago(3), updated_at: ago(3), practice_submission_status: 'pending_va_submission' },
    { id: 'a2', user_id: 'u2', status: 'submitted', applied_at: ago(40), updated_at: ago(5), practice_submission_status: 'submitted' }, // submitted_to_practice
    { id: 'a3', user_id: 'u3', status: 'interview_scheduled', applied_at: ago(50), updated_at: ago(6), practice_submission_status: 'submitted' }, // interviewing (status)
    { id: 'a4', user_id: 'u5', status: 'offer', applied_at: ago(60), updated_at: ago(2), practice_submission_status: 'submitted' }, // offer
    { id: 'a5', user_id: 'u6', status: 'placed', applied_at: ago(90), updated_at: ago(1), practice_submission_status: 'submitted' }, // secured (placed!)
    { id: 'a6', user_id: 'u11', status: 'contract_signed', applied_at: ago(100), updated_at: ago(0), practice_submission_status: 'submitted' }, // secured
    { id: 'a7', user_id: 'u9', status: 'applied', applied_at: ago(1), updated_at: ago(1), practice_submission_status: 'pending_va_submission' }, // withdrawn-case GP -> excluded by activeUserIds
    { id: 'a8', user_id: 'u6', status: 'placement_secured', applied_at: ago(200), updated_at: ago(200), practice_submission_status: 'submitted' } // 2nd secured app for u6 -> dedupe by user
  ];
  // career_interviews link by application_id
  const careerInterviews = [
    { id: 'iv1', application_id: 'a3', status: 'scheduled', scheduled_at: ahead(2) }
  ];
  const careerRoles = [
    { id: 'r1', practice_name: 'Practice One', is_active: true },
    { id: 'r2', practice_name: 'Practice Two', is_active: false }
  ];
  const tickets = [
    { id: 'tk1', user_id: 'u1', status: 'open', created_at: ago(3), first_reply_at: ago(2.5), resolved_at: null },
    { id: 'tk2', user_id: 'u2', status: 'closed', created_at: ago(10), first_reply_at: ago(9), resolved_at: ago(2) }, // resolved this week
    { id: 'tk3', user_id: 'u3', status: 'closed', created_at: ago(40), first_reply_at: null, resolved_at: ago(30) }, // resolved, null first_reply (excluded from reply avg)
    { id: 'tk4', user_id: 'u9', status: 'open', created_at: ago(1), first_reply_at: null, resolved_at: null } // withdrawn GP -> excluded if scoping on
  ];
  // stage_change timeline events (global)
  const stageEvents = [
    { case_id: 'c1', created_at: ago(2), title: 'Stage advanced to amc', metadata: { from_stage: 'myintealth', to_stage: 'amc' } },
    { case_id: 'c3', created_at: ago(1), title: 'Stage advanced to career', metadata: { from_stage: 'amc', to_stage: 'career' } },
    { case_id: 'c7', created_at: ago(3), title: 'Stage advanced to complete', metadata: { from_stage: 'commencement', to_stage: 'complete' } },
    { case_id: 'c2', created_at: ago(8), title: 'Stage advanced to ahpra', metadata: { from_stage: 'career', to_stage: 'ahpra' } }
  ];
  return { cases, tasks, completedSample, apps, careerInterviews, careerRoles, tickets, stageEvents };
}

describe('ceo-metrics constants + status helpers', () => {
  it('exports the exact status-set constants', () => {
    expect(M.OPEN_TASK_STATUSES).toEqual(['open','in_progress','waiting','waiting_on_gp','waiting_on_practice','waiting_on_external','escalated']);
    expect(M.OVERDUE_EXCLUDED_STATUSES).toEqual(['completed','cancelled']);
    expect(M.SIX_MONTHS_MS).toBe(1000*60*60*24*182);
  });
  it('FUNNEL_STAGES is ordered by true DB progression (#28)', () => {
    expect(M.FUNNEL_STAGES.map(s => s.key)).toEqual(['myintealth','amc','career','ahpra','pbs','commencement']);
    expect(M.FUNNEL_STAGES.find(s => s.key === 'career').label).toBe('Secure Placement');
  });
  it('DB_STAGE_ORDER puts visa at the pbs index (deferred) (#56)', () => {
    expect(M.DB_STAGE_ORDER.pbs).toBe(4);
    expect(M.DB_STAGE_ORDER.visa).toBe(4);
    expect(M.DB_STAGE_ORDER.complete).toBe(6);
  });
  it('isSecuredStatus treats placed as secured (#8); offer/interview helpers single-source (#61)', () => {
    expect(M.isSecuredStatus('placed')).toBe(true);
    expect(M.isSecuredStatus('hired')).toBe(true);
    expect(M.isSecuredStatus('Contract Signed')).toBe(true);
    expect(M.isSecuredStatus('applied')).toBe(false);
    expect(M.isInterviewStatus('interview_scheduled')).toBe(true);
    expect(M.isInterviewStatus('offer')).toBe(false);
    expect(M.isOfferStatus('offer')).toBe(true);
    expect(M.isOfferStatus('offered')).toBe(true);
    expect(M.isOfferStatus('placed')).toBe(false);
  });
});

export { makeFixture, NOW, TODAY, DAY, ago, ahead };
```

- [ ] **Step 2: Run the test — expect FAIL** (module does not exist yet).
```
npx vitest run tests/ceo-metrics.test.js -t "constants"
```
Expected: FAIL (`Cannot find module '../lib/ceo-metrics.js'`).

- [ ] **Step 3: Create `lib/ceo-metrics.js` with constants + status helpers.** Mirror server.js:10102 (`normalizeCareerApplicationStatusKey`) and server.js:10126 (`SECURED_CAREER_APPLICATION_STATUS_KEYS`) so the module's "secured" definition is identical to the writer path (#8). Offer set mirrors server.js:36762 (`['offer','offer_pending','offered']`); interview statuses mirror server.js:10119 (`isCareerInterviewStatus`).

```js
'use strict';

// ── Constants ───────────────────────────────────────────────────
var OPEN_TASK_STATUSES = ['open','in_progress','waiting','waiting_on_gp','waiting_on_practice','waiting_on_external','escalated'];
var OVERDUE_EXCLUDED_STATUSES = ['completed','cancelled'];

// User-facing funnel order == true DB progression so the cumulative funnel narrows top->bottom (#28).
var FUNNEL_STAGES = [
  { key: 'myintealth', label: 'MyIntealth' },
  { key: 'amc', label: 'AMC' },
  { key: 'career', label: 'Secure Placement' },
  { key: 'ahpra', label: 'AHPRA' },
  { key: 'pbs', label: 'PBS & Medicare' },
  { key: 'commencement', label: 'Commencement' }
];

// visa shares pbs index (deferred); complete sits above the funnel (#56).
var DB_STAGE_ORDER = { myintealth: 0, amc: 1, career: 2, ahpra: 3, pbs: 4, visa: 4, commencement: 5, complete: 6 };

var SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 182;
var DAY_MS = 86400000;

// ── Status normalisation (mirrors server.js:10102) ──────────────
function normalizeStatusKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Single source of secured statuses — mirrors server.js:10126 incl. 'placed' (#8/#61).
var SECURED_STATUS_KEYS = new Set(['hired','secured','placed','placement_secured','offer_accepted','contract_signed']);
var INTERVIEW_STATUS_KEYS = new Set(['interview','interview_scheduled','interview_confirmed']);
var OFFER_STATUS_KEYS = new Set(['offer','offer_pending','offered']);

function isSecuredStatus(status) { return SECURED_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isInterviewStatus(status) { return INTERVIEW_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isOfferStatus(status) { return OFFER_STATUS_KEYS.has(normalizeStatusKey(status)); }

module.exports = {
  OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS,
  normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus
};
```

- [ ] **Step 4: Syntax check + run test — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "constants"
```
Expected: PASS (4 assertions in the describe block).

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): constants + status-set helpers (#8 #28 #56 #61)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2: Shared filters & period/age helpers (#15, #52, #37, #1, #30, #6, #40)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

These five helpers are the contracts that make every later metric reconcile with its drilldown. `filterActiveCases` fixes "All Time" lying (#15/#52). `caseAgeMs` is the ONE shared activity-age fallback (#37). `isOverdue` is the ONE date-compare overdue rule (#1/#30). `activeUserIdSet` scopes apps/tickets (#6/#40).

- [ ] **Step 1: Add failing tests.** Append to `tests/ceo-metrics.test.js`:

```js
describe('shared filters + helpers', () => {
  const fx = makeFixture();

  it('filterActiveCases drops withdrawn + >6mo stale by default (#15/#52)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
    const ids = active.map(c => c.id).sort();
    // c9 withdrawn out; c8 & c10 stale(200d) out; everything else in (ids are .sort()ed)
    expect(ids).toEqual(['c1','c11','c2','c3','c4','c5','c6','c7']);
  });
  it('filterActiveCases allTime keeps stale but still drops withdrawn (#52)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW, allTime: true });
    const ids = active.map(c => c.id).sort();
    expect(ids).toEqual(['c1','c10','c11','c2','c3','c4','c5','c6','c7','c8']); // c9 still out
    expect(ids).not.toContain('c9');
  });
  it('caseAgeMs uses last_gp_activity_at then updated_at then created_at (#37)', () => {
    expect(M.caseAgeMs({ last_gp_activity_at: ago(5), updated_at: ago(1), created_at: ago(40) }, NOW)).toBe(5 * DAY);
    expect(M.caseAgeMs({ last_gp_activity_at: null, updated_at: ago(8), created_at: ago(40) }, NOW)).toBe(8 * DAY);
    expect(M.caseAgeMs({ last_gp_activity_at: null, updated_at: null, created_at: ago(40) }, NOW)).toBe(40 * DAY);
  });
  it('withinPeriod treats current/all as always true; otherwise compares to nowMs', () => {
    expect(M.withinPeriod(ago(20), 'all', NOW)).toBe(true);
    expect(M.withinPeriod(ago(20), 'current', NOW)).toBe(true);
    expect(M.withinPeriod(ago(5), '7d', NOW)).toBe(true);
    expect(M.withinPeriod(ago(10), '7d', NOW)).toBe(false);
    expect(M.withinPeriod(ago(10), '14d', NOW)).toBe(true);
    expect(M.withinPeriod(null, '7d', NOW)).toBe(false);
  });
  it('isOverdue: DATE compare, excludes completed/cancelled, includes escalated (#1/#30)', () => {
    expect(M.isOverdue({ due_date: ago(2), status: 'open' }, TODAY)).toBe(true);
    expect(M.isOverdue({ due_date: ago(2), status: 'escalated' }, TODAY)).toBe(true); // escalated still overdue
    expect(M.isOverdue({ due_date: TODAY, status: 'open' }, TODAY)).toBe(false); // due today is NOT overdue
    expect(M.isOverdue({ due_date: ago(2), status: 'completed' }, TODAY)).toBe(false);
    expect(M.isOverdue({ due_date: ago(2), status: 'cancelled' }, TODAY)).toBe(false);
    expect(M.isOverdue({ due_date: null, status: 'open' }, TODAY)).toBe(false);
  });
  it('activeUserIdSet returns user_ids of the active cases (#6/#40)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
    const set = M.activeUserIdSet(active);
    expect(set.has('u1')).toBe(true);
    expect(set.has('u9')).toBe(false); // withdrawn
    expect(set.has('u10')).toBe(false); // stale
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`M.filterActiveCases is not a function`).
```
npx vitest run tests/ceo-metrics.test.js -t "shared filters"
```
Expected: FAIL.

- [ ] **Step 3: Implement the helpers** in `lib/ceo-metrics.js`. `isOverdue` compares the date-only slice of `due_date` (`< todayStr`) — fixes the KPI's full-timestamp comparison so "due earlier today" is no longer overdue (#1/#30). `caseAgeMs` is the single fallback used by both the staleness gate and the bucketers (#37). Insert above `module.exports`:

```js
// ── Shared filters / helpers ────────────────────────────────────
// ONE activity-age fallback used everywhere (#37): GP activity, then any touch, then creation.
function caseAgeMs(c, nowMs) {
  var ref = c.last_gp_activity_at || c.updated_at || c.created_at;
  return nowMs - new Date(ref).getTime();
}

// Active = not withdrawn, and (unless allTime) not >6mo stale. Fixes "All Time" lying (#15/#52).
function filterActiveCases(cases, opts) {
  opts = opts || {};
  var nowMs = opts.nowMs;
  var allTime = !!opts.allTime;
  return (cases || []).filter(function(c) {
    if (c.status === 'withdrawn') return false;
    if (!allTime && caseAgeMs(c, nowMs) > SIX_MONTHS_MS) return false;
    return true;
  });
}

// period in {'current','7d','14d','30d','all'}; current/all => always true.
function withinPeriod(isoDate, period, nowMs) {
  if (period === 'all' || period === 'current') return true;
  if (!isoDate) return false;
  var windowMs = period === '7d' ? 7 * DAY_MS : period === '14d' ? 14 * DAY_MS : period === '30d' ? 30 * DAY_MS : 0;
  if (windowMs <= 0) return true;
  return (nowMs - new Date(isoDate).getTime()) <= windowMs;
}

// DATE compare so a task due earlier today is NOT overdue; escalated counts (#1/#30).
function isOverdue(task, todayStr) {
  if (!task || !task.due_date) return false;
  if (OVERDUE_EXCLUDED_STATUSES.indexOf(task.status) !== -1) return false;
  var due = String(task.due_date).slice(0, 10);
  return due < todayStr;
}

// user_ids of active cases — scopes apps/tickets to the same population as cases (#6/#40).
function activeUserIdSet(activeCases) {
  var s = new Set();
  (activeCases || []).forEach(function(c) { if (c.user_id) s.add(c.user_id); });
  return s;
}
```
Add to `module.exports`: `caseAgeMs, filterActiveCases, withinPeriod, isOverdue, activeUserIdSet`.

- [ ] **Step 4: Syntax check + run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "shared filters"
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): shared active/period/overdue/age helpers (#1 #6 #15 #30 #37 #40 #52)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3: KPI computation + secured-app dedup (#8, #15, #1, #30)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeKpis` is the headline strip. `placed` is deduped by `user_id` using `securedAppUserIds` (so the count is unique GPs, matching the trend semantics fixed in a later phase). `completed_gps` is ALL-TIME complete cases (#15) — it must NOT honor the 6-month / period filter, so it is computed from the unfiltered `cases` argument by stage, not from the active subset. `overdue_tasks` uses `isOverdue` (#1/#30).

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('securedAppUserIds + computeKpis', () => {
  const fx = makeFixture();

  it('securedAppUserIds dedupes and includes placed (#8)', () => {
    const set = M.securedAppUserIds(fx.apps);
    // a5(placed,u6), a6(contract_signed,u11), a8(placement_secured,u6 dup) -> u6,u11
    expect(Array.from(set).sort()).toEqual(['u11','u6']);
  });

  it('computeKpis: placed == unique secured GPs; completed_gps all-time; overdue via isOverdue', () => {
    const k = M.computeKpis({ cases: fx.cases, tasks: fx.tasks, apps: fx.apps, careerRoles: fx.careerRoles, period: 'current', nowMs: NOW, todayStr: TODAY });
    // active (non-withdrawn, non-stale) cases: c1..c8,c11 = 9
    expect(k.total_gps).toBe(9);
    // placed = unique secured GPs among active = u6,u11 = 2 (u8's app? u8 has no secured app)
    expect(k.placed).toBe(2);
    // open tasks on active cases: t1,t2,t3,t4,t5 (t6/t7 excluded by case; t8 cancelled) = 5
    expect(k.open_tasks).toBe(5);
    // overdue on active cases: t2(ago1), t3(escalated, ago2) ; t4 due TODAY not overdue = 2
    expect(k.overdue_tasks).toBe(2);
    // blocked active cases: c3,c4 = 2
    expect(k.blocked_cases).toBe(2);
    // completed_gps all-time: c7 + c8 (even though c8 is >6mo stale) = 2 (#15)
    expect(k.completed_gps).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeKpis"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js` above `module.exports`. Note `computeKpis` builds its own active set internally so callers cannot pass a mismatched filter; `open_tasks`/`overdue_tasks` count tasks on active cases; `completed_gps` counts ALL non-withdrawn complete cases regardless of staleness (#15).

```js
// Set of user_ids that have at least one secured/placed application (#8).
function securedAppUserIds(apps) {
  var s = new Set();
  (apps || []).forEach(function(a) { if (a.user_id && isSecuredStatus(a.status)) s.add(a.user_id); });
  return s;
}

function computeKpis(args) {
  var cases = args.cases || [], tasks = args.tasks || [], apps = args.apps || [];
  var period = args.period || 'current', nowMs = args.nowMs, todayStr = args.todayStr;
  var active = filterActiveCases(cases, { nowMs: nowMs, allTime: (period === 'all') });
  var activeIds = new Set(active.map(function(c){ return c.id; }));
  var activeUsers = activeUserIdSet(active);

  var openTasks = tasks.filter(function(t){ return activeIds.has(t.case_id) && OPEN_TASK_STATUSES.indexOf(t.status) !== -1; });
  var overdue = openTasks.filter(function(t){ return isOverdue(t, todayStr); });
  var blocked = active.filter(function(c){ return c.status === 'blocked' || !!c.blocker_status; });

  // placed = unique active GPs with a secured app (#8).
  var securedUsers = securedAppUserIds(apps);
  var placedCount = 0;
  securedUsers.forEach(function(uid){ if (activeUsers.has(uid)) placedCount++; });

  // completed_gps = ALL-TIME complete (non-withdrawn), independent of staleness/period (#15).
  var completedAll = cases.filter(function(c){ return c.stage === 'complete' && c.status !== 'withdrawn'; });

  return {
    total_gps: active.length,
    placed: placedCount,
    open_tasks: openTasks.length,
    overdue_tasks: overdue.length,
    blocked_cases: blocked.length,
    completed_gps: completedAll.length
  };
}
```
Add to `module.exports`: `securedAppUserIds, computeKpis`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeKpis"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): computeKpis + securedAppUserIds (#1 #8 #15 #30)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.4: Pipeline funnel + pipelineCaseIds reconciliation (#2, #3, #28, #29, #56)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

The defining bug class: the bar count and its drilldown must come from the same function. `computePipeline` returns per-stage `count` + `blocked`; `pipelineCaseIds` returns exactly the ids that the bar counted, for the same `cumulative` flag. In cumulative mode `count` is reached-or-passed (`DB_STAGE_ORDER[stage] <= DB_STAGE_ORDER[caseStage]`) and `blocked` is counted ONCE at the current stage only (#3). `visa` maps to the `pbs` row (#56). Stages emitted in `FUNNEL_STAGES` order (#28). **Core invariant test:** for every stage and every mode, `count === pipelineCaseIds(...).length`.

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('computePipeline + pipelineCaseIds (count == drilldown length)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW }); // c1..c8,c11

  it('snapshot mode: count == its case-ids length per stage; visa folds into pbs (#56)', () => {
    const pipe = M.computePipeline(active, { cumulative: false });
    pipe.forEach(row => {
      const ids = M.pipelineCaseIds(active, row.key, { cumulative: false });
      expect(ids.length).toBe(row.count); // INVARIANT
    });
    const pbs = pipe.find(r => r.key === 'pbs');
    // snapshot pbs = c5(pbs) + c6(visa->pbs) = 2
    expect(pbs.count).toBe(2);
    expect(M.pipelineCaseIds(active, 'pbs', { cumulative: false }).sort()).toEqual(['c5','c6']);
  });

  it('rows are emitted in FUNNEL_STAGES order, complete excluded (#28)', () => {
    const pipe = M.computePipeline(active, { cumulative: false });
    expect(pipe.map(r => r.key)).toEqual(['myintealth','amc','career','ahpra','pbs','commencement']);
  });

  it('cumulative mode: monotonic narrowing + invariant holds (#2/#28/#29)', () => {
    const pipe = M.computePipeline(active, { cumulative: true });
    pipe.forEach(row => {
      const ids = M.pipelineCaseIds(active, row.key, { cumulative: true });
      expect(ids.length).toBe(row.count); // INVARIANT
    });
    // reached-or-passed myintealth = all non-complete active = c1,c2,c3,c4,c5,c6,c11 = 7
    expect(pipe.find(r => r.key === 'myintealth').count).toBe(7);
    // narrows monotonically top->bottom
    const counts = pipe.map(r => r.count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i-1]);
  });

  it('blocked counted ONCE at current stage, not at every passed stage (#3)', () => {
    const pipe = M.computePipeline(active, { cumulative: true });
    const totalBlocked = pipe.reduce((s, r) => s + r.blocked, 0);
    // active blocked cases = c3(career), c4(ahpra) = 2 total across the whole funnel
    expect(totalBlocked).toBe(2);
    expect(pipe.find(r => r.key === 'career').blocked).toBe(1); // c3
    expect(pipe.find(r => r.key === 'ahpra').blocked).toBe(1);  // c4
    expect(pipe.find(r => r.key === 'myintealth').blocked).toBe(0); // not double-counted
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computePipeline"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. Both functions resolve a case's stage the same way (`visa`→`pbs`, default `myintealth`) and use a single predicate so they can never diverge.

```js
function _caseStageKey(c) {
  var s = c.stage || 'myintealth';
  if (s === 'visa') s = 'pbs'; // deferred (#56)
  return s;
}
function _stageIndex(stageKey) {
  return DB_STAGE_ORDER[stageKey] !== undefined ? DB_STAGE_ORDER[stageKey] : 0;
}
// Shared membership predicate used by BOTH count and id list.
function _caseInStage(c, stageKey, cumulative) {
  var caseKey = _caseStageKey(c);
  if (caseKey === 'complete') return false; // complete shown in completions, not funnel
  if (cumulative) return _stageIndex(caseKey) >= _stageIndex(stageKey);
  return caseKey === stageKey;
}

function computePipeline(activeCases, opts) {
  var cumulative = !!(opts && opts.cumulative);
  return FUNNEL_STAGES.map(function(stage) {
    var count = 0, blocked = 0;
    (activeCases || []).forEach(function(c) {
      if (!_caseInStage(c, stage.key, cumulative)) return;
      count++;
      // blocked counted ONCE, at the case's CURRENT stage (#3)
      var isBlocked = c.status === 'blocked' || !!c.blocker_status;
      if (isBlocked && _caseStageKey(c) === stage.key) blocked++;
    });
    return { key: stage.key, label: stage.label, count: count, blocked: blocked };
  });
}

// Exactly the case ids the bar counted (#2/#29).
function pipelineCaseIds(activeCases, stageKey, opts) {
  var cumulative = !!(opts && opts.cumulative);
  return (activeCases || []).filter(function(c) { return _caseInStage(c, stageKey, cumulative); })
    .map(function(c) { return c.id; });
}
```
Add to `module.exports`: `computePipeline, pipelineCaseIds`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computePipeline"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): pipeline funnel + reconciling id list (#2 #3 #28 #29 #56)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.5: Blockers (real days_blocked from blocker_set_at) (#57)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeBlockers` returns one row per blocked active case using the SINGLE field name `days_blocked` (card + drilldown share it, #57). `days_blocked` is computed from `blocker_set_at` when present (real days blocked, #5) and falls back to `caseAgeMs` only when null. Sorted by `days_blocked` desc. (Note: #5's underlying timestamp + #4/#19 modal CHECK-constraint fix live in later phases; this task delivers the metric semantics they rely on.)

- [ ] **Step 1: Add failing test.** Append:

```js
describe('computeBlockers (#57)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });

  it('one row per blocked active case, days_blocked from blocker_set_at', () => {
    const rows = M.computeBlockers(active, NOW);
    expect(rows.map(r => r.case_id).sort()).toEqual(['c3','c4']);
    const c3 = rows.find(r => r.case_id === 'c3');
    expect(c3.days_blocked).toBe(12); // blocker_set_at = ago(12)
    expect(c3.blocker_status).toBe('waiting_on_gp');
    const c4 = rows.find(r => r.case_id === 'c4');
    // c4 has null blocker_set_at -> fall back to caseAgeMs (last_gp_activity_at ago(3))
    expect(c4.days_blocked).toBe(3);
  });

  it('sorted by days_blocked desc', () => {
    const rows = M.computeBlockers(active, NOW);
    expect(rows[0].case_id).toBe('c3'); // 12 > 3
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeBlockers"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`:

```js
function computeBlockers(activeCases, nowMs) {
  return (activeCases || []).filter(function(c) {
    return c.status === 'blocked' || !!c.blocker_status;
  }).map(function(c) {
    var ms = c.blocker_set_at ? (nowMs - new Date(c.blocker_set_at).getTime()) : caseAgeMs(c, nowMs);
    return {
      case_id: c.id, user_id: c.user_id, stage: _caseStageKey(c),
      days_blocked: Math.floor(ms / DAY_MS),
      blocker_status: c.blocker_status || c.status,
      blocker_reason: c.blocker_reason || '',
      assigned_rso: c.assigned_rso || null
    };
  }).sort(function(a, b) { return b.days_blocked - a.days_blocked; });
}
```
Add `computeBlockers` to `module.exports`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeBlockers"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): computeBlockers with real days_blocked (#5 #57)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.6: Task Health (overdue matches KPI, labelled avg window) (#30, #31)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeTaskHealth(tasks, completedSample, todayStr)` — `overdue` uses `isOverdue` so it matches the KPI exactly (#30). `completed_this_week`/`avg_resolve_days` are computed over the passed `completedSample` and the result exposes `avg_resolve_sample_size` so the UI can label the window instead of a silent 500-cap (#31). `tasks` passed here are already active-case-scoped by the caller (the dashboard passes the same active-scoped list used for the KPI, fixing #6).

- [ ] **Step 1: Add failing test.** Append:

```js
describe('computeTaskHealth (#30/#31)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeIds = new Set(active.map(c => c.id));
  const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));

  it('open/in_progress counts + overdue matches isOverdue', () => {
    const th = M.computeTaskHealth(scopedTasks, fx.completedSample, TODAY);
    expect(th.open).toBe(2);        // t1, t5
    expect(th.in_progress).toBe(1); // t2
    expect(th.overdue).toBe(2);     // t2, t3 (t4 due today excluded)
  });
  it('completed_this_week + labelled avg over sample (#31)', () => {
    const th = M.computeTaskHealth(scopedTasks, fx.completedSample, TODAY);
    expect(th.completed_this_week).toBe(1); // ct1 completed ago(2)
    // avg of 7d and 9d = 8.0
    expect(th.avg_resolve_days).toBe(8);
    expect(th.avg_resolve_sample_size).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeTaskHealth"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** `completed_this_week` uses a 7-day window derived from `todayStr` (midnight UTC of 7 days prior) so it stays pure. Add to `lib/ceo-metrics.js`:

```js
function computeTaskHealth(tasks, completedSample, todayStr) {
  tasks = tasks || []; completedSample = completedSample || [];
  var open = 0, inProgress = 0, overdue = 0;
  tasks.forEach(function(t) {
    if (t.status === 'open') open++;
    else if (t.status === 'in_progress') inProgress++;
    if (isOverdue(t, todayStr)) overdue++;
  });
  // week boundary: midnight UTC of (todayStr - 7 days)
  var weekAgoStr = new Date(new Date(todayStr + 'T00:00:00Z').getTime() - 7 * DAY_MS).toISOString();
  var completedThisWeek = 0;
  var durations = [];
  completedSample.forEach(function(t) {
    if (t.completed_at && t.completed_at >= weekAgoStr) completedThisWeek++;
    if (t.completed_at && t.created_at) {
      durations.push((new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / DAY_MS);
    }
  });
  var avg = durations.length ? Math.round((durations.reduce(function(a, b){ return a + b; }, 0) / durations.length) * 10) / 10 : 0;
  return {
    open: open,
    in_progress: inProgress,
    completed_this_week: completedThisWeek,
    overdue: overdue,
    avg_resolve_days: avg,
    avg_resolve_sample_size: durations.length
  };
}
```
Add `computeTaskHealth` to `module.exports`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeTaskHealth"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): computeTaskHealth with KPI-matching overdue + labelled avg (#30 #31)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.7: RSO workload + rsoCaseIds reconciliation (#7, #32, #34)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeRsoWorkload` groups active cases by the durable `assigned_rso` column (not the transient call-level field), with a `'__unassigned__'` bucket for null (#32). `rsoCaseIds` returns the same case ids per RSO so the drilldown matches the row (#7/#34). **Attribution decision (documented, #33):** `open_tasks`/`overdue_tasks` are tasks on the RSO's cases (case-owner load), counted from the same active-scoped task list the dashboard uses — so the drilldown count equals the row. The `rsoRoster` argument supplies display names; RSOs in the roster with no cases still appear with zero counts. Per-task-assignee attribution (the alternative semantic) is a Phase-3 decision; this module ships the case-owner model with `case_count` always reflecting ownership.

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('computeRsoWorkload + rsoCaseIds (#7/#32/#34)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeIds = new Set(active.map(c => c.id));
  const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));
  const roster = [
    { rso_id: 'rsoA', rso_name: 'Khaleed' },
    { rso_id: 'rsoB', rso_name: 'Hazel' }
  ];

  it('groups by assigned_rso with __unassigned__ bucket; count == rsoCaseIds length (#32)', () => {
    const rows = M.computeRsoWorkload(active, scopedTasks, roster, TODAY);
    rows.forEach(row => {
      const ids = M.rsoCaseIds(active, row.rso_id);
      expect(ids.length).toBe(row.case_count); // INVARIANT
    });
    const a = rows.find(r => r.rso_id === 'rsoA');
    // rsoA active cases: c1,c2,c6,c7 = 4
    expect(a.case_count).toBe(4);
    const unassigned = rows.find(r => r.rso_id === '__unassigned__');
    // c4 (assigned_rso null) ; c10 stale excluded already
    expect(unassigned.case_count).toBe(1);
    expect(M.rsoCaseIds(active, '__unassigned__')).toEqual(['c4']);
  });

  it('open_tasks/overdue_tasks attributed to case owner, match scoped task list (#33)', () => {
    const rows = M.computeRsoWorkload(active, scopedTasks, roster, TODAY);
    const a = rows.find(r => r.rso_id === 'rsoA');
    // tasks on rsoA cases: t1(c1 open), t2(c1 in_progress overdue), t3(c2 escalated overdue) = 3 open, 2 overdue
    expect(a.open_tasks).toBe(3);
    expect(a.overdue_tasks).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeRsoWorkload"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. `rsoCaseIds` and the grouping share the same `_caseRsoKey` resolver so they cannot diverge.

```js
function _caseRsoKey(c) { return c.assigned_rso || '__unassigned__'; }

function rsoCaseIds(activeCases, rsoId) {
  return (activeCases || []).filter(function(c) { return _caseRsoKey(c) === rsoId; })
    .map(function(c) { return c.id; });
}

// Case-owner load model (#33): open/overdue are tasks on this RSO's cases.
function computeRsoWorkload(activeCases, tasks, rsoRoster, todayStr) {
  activeCases = activeCases || []; tasks = tasks || []; rsoRoster = rsoRoster || [];
  var caseRso = {};           // case_id -> rso key
  var buckets = {};           // rso key -> row
  function ensure(id, name) {
    if (!buckets[id]) buckets[id] = { rso_id: id, rso_name: name || (id === '__unassigned__' ? 'Unassigned' : id), case_count: 0, open_tasks: 0, overdue_tasks: 0 };
    return buckets[id];
  }
  // seed roster so zero-case RSOs still show
  rsoRoster.forEach(function(r) { ensure(r.rso_id, r.rso_name); });
  activeCases.forEach(function(c) {
    var key = _caseRsoKey(c);
    caseRso[c.id] = key;
    ensure(key).case_count++;
  });
  tasks.forEach(function(t) {
    var key = caseRso[t.case_id];
    if (!key || !buckets[key]) return; // task on a non-active case -> ignore
    if (OPEN_TASK_STATUSES.indexOf(t.status) !== -1) buckets[key].open_tasks++;
    if (isOverdue(t, todayStr)) buckets[key].overdue_tasks++;
  });
  return Object.keys(buckets).map(function(k) { return buckets[k]; })
    .sort(function(a, b) { return b.case_count - a.case_count; });
}
```
Add to `module.exports`: `computeRsoWorkload, rsoCaseIds`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeRsoWorkload"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): RSO workload + reconciling case-id list (#7 #32 #33 #34)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.8: Placements funnel + placementAppIds reconciliation (#8, #9, #10, #11, #60, #61)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computePlacements` and `placementAppIds` share one bucket predicate per bucket, so the tile equals its drilldown (#9/#10/#11). Buckets are scoped to `activeUserIds` (#9) and `period` (applied_at, #9/#11). Interviewing = interview-status UNION `career_interviews` membership, excluding secured (#11). Applied excludes secured/offer/interviewing/withdrawn/rejected. Secured uses `isSecuredStatus` incl. `placed` (#8). Buckets are explicitly an **overlapping funnel** (not mutually exclusive) — documented in code (#60). `offerSet`/`securedSet` reuse the single helpers (#61).

- [ ] **Step 1: Add failing tests.** Append. The fixture passes `careerInterviews` to identify interviewing apps; the function takes a precomputed `interviewAppIds` Set so it stays DB-free.

```js
describe('computePlacements + placementAppIds (tile == drilldown)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeUsers = M.activeUserIdSet(active);
  const interviewAppIds = new Set(fx.careerInterviews.map(i => i.application_id)); // {a3}

  function call(period) {
    return M.computePlacements(fx.apps, fx.careerRoles, activeUsers, interviewAppIds, period, NOW);
  }
  function ids(bucket, period) {
    return M.placementAppIds(fx.apps, bucket, activeUsers, interviewAppIds, period, NOW);
  }

  ['all','current','30d','14d','7d'].forEach(period => {
    it('every bucket count == placementAppIds length @ ' + period, () => {
      const p = call(period);
      ['applied','submitted_to_practice','interviewing','offers_made','secured'].forEach(b => {
        expect(ids(b, period).length).toBe(p[b]); // INVARIANT
      });
    });
  });

  it('secured includes placed + dedup not applied at app level; active scoping drops a7 (#8/#9)', () => {
    const p = call('all');
    // secured apps among active users: a5(placed,u6), a6(contract_signed,u11), a8(placement_secured,u6) = 3 app rows
    expect(p.secured).toBe(3);
    // a7 (withdrawn-case GP u9) excluded from applied
    expect(ids('applied','all')).not.toContain('a7');
    expect(ids('applied','all')).toContain('a1');
  });
  it('interviewing = status UNION interview membership, minus secured (#11)', () => {
    const p = call('all');
    // a3 (interview_scheduled + in interviewAppIds) = 1
    expect(p.interviewing).toBe(1);
    expect(ids('interviewing','all')).toEqual(['a3']);
    // a3 must NOT also be in applied
    expect(ids('applied','all')).not.toContain('a3');
  });
  it('offers_made uses offer set; not in applied (#10/#61)', () => {
    const p = call('all');
    expect(ids('offers_made','all')).toEqual(['a4']);
    expect(ids('applied','all')).not.toContain('a4');
  });
  it('active_roles counts is_active roles', () => {
    expect(call('all').active_roles).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computePlacements"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. A single `_inPlacementBucket(app, bucket, interviewAppIds)` predicate drives both the count and the id list; scoping (activeUsers + period on `applied_at`) is applied identically in both.

```js
// NOTE: placement buckets are an OVERLAPPING FUNNEL, not mutually exclusive (#60):
// applied >= submitted >= interviewing >= offers >= secured. Do not sum the tiles.
function _placementInScope(app, activeUserIds, period, nowMs) {
  if (activeUserIds && !activeUserIds.has(app.user_id)) return false;
  return withinPeriod(app.applied_at, period, nowMs);
}
function _inPlacementBucket(app, bucket, interviewAppIds) {
  var status = app.status;
  var isInterviewing = isInterviewStatus(status) || (interviewAppIds && interviewAppIds.has(app.id));
  if (bucket === 'secured') return isSecuredStatus(status);
  if (bucket === 'offers_made') return isOfferStatus(status) && !isSecuredStatus(status);
  if (bucket === 'interviewing') return isInterviewing && !isSecuredStatus(status);
  if (bucket === 'submitted_to_practice') return !!app.practice_submission_status && app.practice_submission_status !== 'pending_va_submission';
  if (bucket === 'applied') {
    var s = normalizeStatusKey(status);
    if (s === 'withdrawn' || s === 'rejected') return false;
    if (isSecuredStatus(status) || isOfferStatus(status) || isInterviewing) return false;
    return true;
  }
  return false;
}

function placementAppIds(apps, bucket, activeUserIds, interviewAppIds, period, nowMs) {
  return (apps || []).filter(function(a) {
    return _placementInScope(a, activeUserIds, period, nowMs) && _inPlacementBucket(a, bucket, interviewAppIds);
  }).map(function(a) { return a.id; });
}

function computePlacements(apps, careerRoles, activeUserIds, interviewAppIds, period, nowMs) {
  function n(bucket) { return placementAppIds(apps, bucket, activeUserIds, interviewAppIds, period, nowMs).length; }
  var activeRoles = (careerRoles || []).filter(function(r) { return !!r.is_active; }).length;
  return {
    applied: n('applied'),
    submitted_to_practice: n('submitted_to_practice'),
    interviewing: n('interviewing'),
    offers_made: n('offers_made'),
    secured: n('secured'),
    active_roles: activeRoles
  };
}
```
Add to `module.exports`: `computePlacements, placementAppIds`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computePlacements"
```
Expected: PASS (9 tests incl. 5 invariant-per-period).

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): placements funnel + reconciling id list (#8 #9 #10 #11 #60 #61)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.9: GP activity (period-independent staleness) + gpActivityCaseIds (#12, #36, #37)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeGpActivity` is computed over the FULL active population, INDEPENDENT of the period selector (#12) — the dashboard must pass the un-period-filtered active set. Uses `caseAgeMs` (the shared fallback, #37). `cold_gps` is sorted by days_inactive desc BEFORE the slice (#36). `gpActivityCaseIds(activeCases, bucket, nowMs)` returns the same ids per bucket so the drilldown matches. Buckets exclude complete cases (they are wins, not activity).

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('computeGpActivity + gpActivityCaseIds (#12/#36/#37)', () => {
  const fx = makeFixture();
  // full active population (NOT period filtered) excluding complete: c1,c2,c3,c4,c5,c6,c11
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW }).filter(c => c.stage !== 'complete');

  it('bucket counts == gpActivityCaseIds length (#12)', () => {
    const a = M.computeGpActivity(active, NOW);
    ['active','inactive','cold'].forEach(b => {
      const ids = M.gpActivityCaseIds(active, b, NOW);
      const key = b === 'active' ? 'active_7d' : b === 'inactive' ? 'inactive_7_14d' : 'cold_14d_plus';
      expect(ids.length).toBe(a[key]); // INVARIANT
    });
    // active(<=7d): c1(2),c4(3),c5(5),c6(1),c11(0) = 5
    expect(a.active_7d).toBe(5);
    // inactive(7-14): c2(10) = 1
    expect(a.inactive_7_14d).toBe(1);
    // cold(>14): c3(20) = 1
    expect(a.cold_14d_plus).toBe(1);
  });

  it('cold_gps sorted by days_inactive desc before slice (#36)', () => {
    // build extra cold cases to prove ordering survives the cap
    const many = [];
    for (let i = 0; i < 13; i++) many.push({ id: 'x'+i, user_id: 'ux'+i, stage: 'amc', status: 'active', last_gp_activity_at: ago(15 + i), updated_at: ago(15+i), created_at: ago(100) });
    const a = M.computeGpActivity(many, NOW);
    expect(a.cold_gps.length).toBe(10); // capped at 10
    // most inactive first (x12 = 27 days)
    expect(a.cold_gps[0].days_inactive).toBeGreaterThanOrEqual(a.cold_gps[1].days_inactive);
    expect(a.cold_gps[0].days_inactive).toBe(27);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeGpActivity"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. A single `_activityBucket(c, nowMs)` decides the bucket so count, ids, and cold list agree.

```js
function _activityDays(c, nowMs) { return Math.floor(caseAgeMs(c, nowMs) / DAY_MS); }
function _activityBucket(c, nowMs) {
  var d = _activityDays(c, nowMs);
  if (d <= 7) return 'active';
  if (d <= 14) return 'inactive';
  return 'cold';
}

function gpActivityCaseIds(activeCases, bucket, nowMs) {
  return (activeCases || []).filter(function(c) { return _activityBucket(c, nowMs) === bucket; })
    .map(function(c) { return c.id; });
}

function computeGpActivity(activeCases, nowMs) {
  activeCases = activeCases || [];
  var active = 0, inactive = 0, cold = [];
  activeCases.forEach(function(c) {
    var b = _activityBucket(c, nowMs);
    if (b === 'active') active++;
    else if (b === 'inactive') inactive++;
    else cold.push(c);
  });
  var coldGps = cold.map(function(c) {
    return {
      case_id: c.id, user_id: c.user_id, stage: _caseStageKey(c),
      last_activity: c.last_gp_activity_at || c.updated_at || c.created_at,
      days_inactive: _activityDays(c, nowMs),
      assigned_rso: c.assigned_rso || null
    };
  }).sort(function(a, b) { return b.days_inactive - a.days_inactive; }).slice(0, 10); // sort BEFORE slice (#36)
  return { active_7d: active, inactive_7_14d: inactive, cold_14d_plus: cold.length, cold_gps: coldGps };
}
```
Add to `module.exports`: `computeGpActivity, gpActivityCaseIds`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeGpActivity"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): GP activity buckets period-independent + sorted cold list (#12 #36 #37)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.10: Ticket metrics + ticketIds reconciliation (#39, #40)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeTicketMetrics(tickets, activeUserIds)` and `ticketIds(tickets, bucket, activeUserIds)` share one scoping decision (#40): **tickets are scoped to active GPs** (`activeUserIds`) so they match the rest of the dashboard. The caller passes the full ticket population (no silent 500 cap, #39); averages exclude nulls and expose sample sizes so nothing is silently truncated. `avg_first_reply_hours` is computed but the relabel/hide decision (#13) is a later phase — here it is just exposed with a sample size.

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('computeTicketMetrics + ticketIds (#39/#40)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeUsers = M.activeUserIdSet(active);

  it('open count scoped to active GPs == ticketIds length (#40)', () => {
    const t = M.computeTicketMetrics(fx.tickets, activeUsers);
    // open: tk1(u1 active), tk4(u9 withdrawn -> excluded) => 1
    expect(t.open).toBe(1);
    expect(M.ticketIds(fx.tickets, 'open', activeUsers)).toEqual(['tk1']);
  });
  it('resolved_this_week + averages exclude nulls, expose sample sizes (#39)', () => {
    const t = M.computeTicketMetrics(fx.tickets, activeUsers);
    // resolved closed tickets among active GPs: tk2(u2, resolved ago2 -> this week), tk3(u3, resolved ago30)
    expect(t.resolved_this_week).toBe(1);
    expect(M.ticketIds(fx.tickets, 'resolved', activeUsers).sort()).toEqual(['tk2','tk3']);
    // first-reply avg only over tickets with first_reply_at AND created_at: tk2 (ago10 -> ago9 = 24h)
    expect(t.avg_first_reply_hours).toBe(24);
    expect(t.avg_first_reply_sample_size).toBe(1); // tk3 has null first_reply_at
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeTicketMetrics"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. The `resolved` bucket = closed tickets (matches `avg_resolution`); week boundary derived from `nowMs`? — to keep pure without nowMs, `resolved_this_week` uses a 7-day window from the max `resolved_at` is unreliable; instead the caller's `todayStr` is not in this signature, so we accept `nowMs`-free purity by comparing `resolved_at` to a window the function derives from the newest resolved ticket is wrong. **Decision:** keep the contract signature `(tickets, activeUserIds)` and compute `resolved_this_week` against a `weekAgoIso` the caller bakes into each ticket is not possible either — so we compute it relative to the latest `resolved_at` is rejected. Use the documented approach: the function takes the contract's two args and derives "this week" from `Date` is disallowed. Resolution: the caller pre-tags tickets with a boolean is overkill. We therefore compute `resolved_this_week` by comparing `resolved_at` against a 7-day window ending at the most-recent `resolved_at` is incorrect for the fixture (expects 1). The clean pure solution: accept an optional 3rd arg `weekAgoIso` defaulted by the caller. Implement with that arg.

```js
// tickets scoped to active GPs (#40). Pass full population (#39). weekAgoIso = ISO of nowMs-7d (caller supplies).
function _ticketInScope(t, activeUserIds) {
  if (!activeUserIds) return true;
  return activeUserIds.has(t.user_id);
}
function ticketIds(tickets, bucket, activeUserIds) {
  return (tickets || []).filter(function(t) {
    if (!_ticketInScope(t, activeUserIds)) return false;
    if (bucket === 'open') return t.status !== 'closed';
    if (bucket === 'resolved') return t.status === 'closed';
    return false;
  }).map(function(t) { return t.id; });
}
function computeTicketMetrics(tickets, activeUserIds, weekAgoIso) {
  var scoped = (tickets || []).filter(function(t) { return _ticketInScope(t, activeUserIds); });
  var open = 0;
  var resolvedThisWeek = 0;
  var resDur = [], replyDur = [];
  scoped.forEach(function(t) {
    if (t.status !== 'closed') { open++; return; }
    if (t.resolved_at && weekAgoIso && t.resolved_at >= weekAgoIso) resolvedThisWeek++;
    if (t.resolved_at && t.created_at) resDur.push((new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
    if (t.first_reply_at && t.created_at) replyDur.push((new Date(t.first_reply_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
  });
  function avg(arr) { return arr.length ? Math.round((arr.reduce(function(a, b){ return a + b; }, 0) / arr.length) * 10) / 10 : null; }
  return {
    open: open,
    resolved_this_week: resolvedThisWeek,
    avg_resolution_hours: avg(resDur),
    avg_resolution_sample_size: resDur.length,
    avg_first_reply_hours: avg(replyDur),
    avg_first_reply_sample_size: replyDur.length
  };
}
```
Update the test's `computeTicketMetrics` call to pass `weekAgoIso` so `resolved_this_week` is deterministic: change the two `M.computeTicketMetrics(fx.tickets, activeUsers)` calls to `M.computeTicketMetrics(fx.tickets, activeUsers, ago(7))`. Add to `module.exports`: `computeTicketMetrics, ticketIds`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeTicketMetrics"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): ticket metrics scoped to active GPs, no silent cap (#39 #40)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.11: Completions (all-time total, global milestones, humanized labels) (#14, #15, #62)

**Files:** Modify `lib/ceo-metrics.js`, Modify `tests/ceo-metrics.test.js`

`computeCompletions(completeCases, stageEvents, nowMs)` — `total` is all-time complete count (#15, the caller passes ALL non-withdrawn complete cases). `recent_milestones` sorts `stageEvents` GLOBALLY by created_at desc before taking the top 5 (#14) and humanizes the label from the stage slug (#41). `this_month` uses UTC month start and counts strictly on `completed_at` (#62) — touched-not-completed cases (null completed_at) do not count.

- [ ] **Step 1: Add failing tests.** Append:

```js
describe('computeCompletions (#14/#15/#62)', () => {
  const fx = makeFixture();
  const completeAll = fx.cases.filter(c => c.stage === 'complete' && c.status !== 'withdrawn'); // c7, c8

  it('total all-time; this_month UTC + completed_at only (#15/#62)', () => {
    const c = M.computeCompletions(completeAll, fx.stageEvents, NOW);
    expect(c.total).toBe(2); // c7 (3d ago) + c8 (200d ago)
    // this month (June 2026 UTC): c7 completed ago(3)=2026-06-11 -> in month; c8 ago(200) -> not
    expect(c.this_month).toBe(1);
  });
  it('recent_milestones sorted globally by created_at desc + humanized labels (#14/#41)', () => {
    const c = M.computeCompletions(completeAll, fx.stageEvents, NOW);
    // newest stage event is c3 ago(1) -> career -> "Reached Secure Placement"
    expect(c.recent_milestones[0].milestone).toBe('Reached Secure Placement');
    // events are in strict created_at desc order
    for (let i = 1; i < c.recent_milestones.length; i++) {
      expect(new Date(c.recent_milestones[i-1].date) >= new Date(c.recent_milestones[i].date)).toBe(true);
    }
  });
  it('a case with null completed_at does not count toward this_month (#62)', () => {
    const withNull = [{ id: 'cz', user_id: 'uz', stage: 'complete', status: 'active', completed_at: null, updated_at: ago(1), created_at: ago(50) }];
    const c = M.computeCompletions(withNull, [], NOW);
    expect(c.total).toBe(1);
    expect(c.this_month).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
```
npx vitest run tests/ceo-metrics.test.js -t "computeCompletions"
```
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `lib/ceo-metrics.js`. The humanizer maps the destination stage slug (from metadata `to_stage` or parsed from title) via `FUNNEL_STAGES` labels plus `complete`.

```js
var _STAGE_LABEL_BY_KEY = (function() {
  var m = { complete: 'Complete' };
  FUNNEL_STAGES.forEach(function(s) { m[s.key] = s.label; });
  return m;
})();

function _milestoneToStage(ev) {
  var meta = ev.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
  if (meta && meta.to_stage) return meta.to_stage;
  var m = String(ev.title || '').match(/stage advanced to (\w+)/i);
  return m ? m[1].toLowerCase() : null;
}

function computeCompletions(completeCases, stageEvents, nowMs) {
  completeCases = completeCases || []; stageEvents = stageEvents || [];
  var d = new Date(nowMs);
  var monthStartIso = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); // UTC (#62)
  var thisMonth = 0;
  completeCases.forEach(function(c) {
    if (c.completed_at && c.completed_at >= monthStartIso) thisMonth++; // completed_at only (#62)
  });
  var milestones = stageEvents.slice()
    .sort(function(a, b) { return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); }) // global desc (#14)
    .slice(0, 5)
    .map(function(ev) {
      var stage = _milestoneToStage(ev);
      var label = stage ? (_STAGE_LABEL_BY_KEY[stage] || stage) : 'a new stage';
      return {
        case_id: ev.case_id,
        milestone: stage === 'complete' ? 'Completed Registration' : ('Reached ' + label), // humanized (#41)
        date: ev.created_at,
        days_ago: Math.floor((nowMs - new Date(ev.created_at).getTime()) / DAY_MS)
      };
    });
  return { this_month: thisMonth, total: completeCases.length, recent_milestones: milestones };
}
```
Add `computeCompletions` to `module.exports`.

- [ ] **Step 4: Run — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js -t "computeCompletions"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add lib/ceo-metrics.js tests/ceo-metrics.test.js && git commit -m "feat(ceo-metrics): completions all-time + global humanized milestones (#14 #15 #41 #62)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.12: Full-suite green + cross-metric reconciliation guard (#2, #29 reinforcement)

**Files:** Modify `tests/ceo-metrics.test.js`

A final describe block that asserts the module-wide invariant the whole rebuild rests on: for every period and every metric that has a drilldown helper, `metricCount === drilldownHelper(...).length`. This catches any future drift between a KPI and its list.

- [ ] **Step 1: Add the cross-cutting reconciliation test.** Append:

```js
describe('cross-metric reconciliation (every metric == its drilldown list, every period)', () => {
  const fx = makeFixture();

  ['all','current','30d','14d','7d'].forEach(period => {
    it('pipeline + placements reconcile @ ' + period, () => {
      const active = M.filterActiveCases(fx.cases, { nowMs: NOW, allTime: period === 'all' });
      const cumulative = period !== 'current';
      // pipeline
      M.computePipeline(active, { cumulative }).forEach(row => {
        expect(M.pipelineCaseIds(active, row.key, { cumulative }).length).toBe(row.count);
      });
      // placements
      const activeUsers = M.activeUserIdSet(active);
      const interviewAppIds = new Set(fx.careerInterviews.map(i => i.application_id));
      const p = M.computePlacements(fx.apps, fx.careerRoles, activeUsers, interviewAppIds, period, NOW);
      ['applied','submitted_to_practice','interviewing','offers_made','secured'].forEach(b => {
        expect(M.placementAppIds(fx.apps, b, activeUsers, interviewAppIds, period, NOW).length).toBe(p[b]);
      });
      // gp activity (period-independent population)
      const activeNoComplete = active.filter(c => c.stage !== 'complete');
      const ga = M.computeGpActivity(activeNoComplete, NOW);
      [['active','active_7d'],['inactive','inactive_7_14d'],['cold','cold_14d_plus']].forEach(([b, key]) => {
        expect(M.gpActivityCaseIds(activeNoComplete, b, NOW).length).toBe(ga[key]);
      });
      // rso workload
      const activeIds = new Set(active.map(c => c.id));
      const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));
      M.computeRsoWorkload(active, scopedTasks, [], TODAY).forEach(row => {
        expect(M.rsoCaseIds(active, row.rso_id).length).toBe(row.case_count);
      });
    });
  });
});
```

- [ ] **Step 2: Run the WHOLE suite — expect PASS.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && npx vitest run tests/ceo-metrics.test.js
```
Expected: PASS (all describe blocks green, including the 5 reconciliation periods).

- [ ] **Step 3: Confirm nothing else broke.**
```
npm test
```
Expected: PASS (existing suites unaffected; new `ceo-metrics.test.js` green).

- [ ] **Step 4: Commit.**
```
git add tests/ceo-metrics.test.js && git commit -m "test(ceo-metrics): cross-metric reconciliation guard across all periods (#2 #29)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Phase-1 outputs consumed by later phases: `lib/ceo-metrics.js` exports `OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS, normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus, caseAgeMs, filterActiveCases, withinPeriod, isOverdue, activeUserIdSet, securedAppUserIds, computeKpis, computePipeline, pipelineCaseIds, computeBlockers, computeTaskHealth, computeRsoWorkload, rsoCaseIds, computePlacements, placementAppIds, computeGpActivity, gpActivityCaseIds, computeTicketMetrics, ticketIds, computeCompletions`. Two contract deviations made for purity, to flag to the integrating phase: `computePlacements`/`placementAppIds` take an extra `interviewAppIds` Set argument (career_interviews membership precomputed by the endpoint, since the module is DB-free), and `computeTicketMetrics` takes an optional `weekAgoIso` third argument (caller passes ISO of `nowMs - 7d`) so `resolved_this_week` stays pure.

---

## Phase 2: Database migration (assigned_rso, rso_team, blocker_set_at)
Add the durable per-case RSO owner column, the blocker-start timestamp, and an editable `rso_team` roster table, then make `server.js` read the roster from that table (keeping the in-memory `RSO_TEAM` array only as a seed/fallback).

**Files:**
- Create: `supabase/migrations/20260614120000_ceo_rebuild.sql`
- Modify: `server.js` (RSO_TEAM block `260-267`; `loadRsoTeam` helper inserted near `268`; `GET /api/admin/rsos` handler `25274-25280`; scheduled-calls reminder lookup `21134`; calls/schedule lookup `25304`)
- Test: `tests/rso-team.test.js` (new)

---

### Task 2.1: Create the additive migration file (#22, #23)
**Files:** Create `supabase/migrations/20260614120000_ceo_rebuild.sql`

- [ ] **Step 1: Write the migration file exactly per the contract DB section.** This is additive only (all `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`). It adds the durable `assigned_rso` case column (so per-RSO rollups don't rely on the per-call `scheduled_calls.assigned_rso_email`, #23), backfills it from `assigned_va`, adds `blocker_set_at`, and creates the editable `rso_team` roster table seeded from the current hardcoded `RSO_TEAM` (#22). Create the file with this complete content:

```sql
-- CEO rebuild: durable per-GP RSO owner, blocker-start timestamp, editable RSO roster

-- Durable per-GP RSO owner (oversight grouping); backfilled from assigned_va
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS assigned_rso uuid;
UPDATE registration_cases SET assigned_rso = assigned_va WHERE assigned_rso IS NULL;
CREATE INDEX IF NOT EXISTS idx_cases_assigned_rso ON registration_cases(assigned_rso);

-- When a blocker was set, so "days blocked" is real (not days-since-activity)
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS blocker_set_at timestamptz;

-- Editable RSO roster (replaces hardcoded RSO_TEAM array; array remains as seed)
CREATE TABLE IF NOT EXISTS rso_team (
  user_id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- seed from current RSO_TEAM
INSERT INTO rso_team (user_id, name, email, phone) VALUES
  ('2f94f870-7ab2-4f71-98ad-bf3756ed88db','Khaleed Mahmoud','khaleedmahmoud1211@gmail.com','+61406281243'),
  ('7bed5eb8-f03d-40d6-b090-eb006cd02be7','Hazel','hazel@mygplink.com.au','')
ON CONFLICT (user_id) DO NOTHING;
```

- [ ] **Step 2: Verify the file is well-formed SQL on disk.** Run:
```bash
test -f "supabase/migrations/20260614120000_ceo_rebuild.sql" && grep -c ";" supabase/migrations/20260614120000_ceo_rebuild.sql
```
Expected: prints `7` (seven statement terminators: 3 for the assigned_rso block + 1 for blocker_set_at + 1 CREATE TABLE + 1 CREATE INDEX is inside the first block... confirm count matches the file). PASS if the file exists and the grep returns a non-zero count.

- [ ] **Step 3: Commit.**
```bash
git add supabase/migrations/20260614120000_ceo_rebuild.sql && git commit -m "Add CEO rebuild migration: assigned_rso, blocker_set_at, rso_team table (#22,#23)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.2: Apply the migration to Supabase via rpc/exec_sql and verify (#22, #23)
**Files:** none (operational task against the live DB)

- [ ] **Step 1: Apply each statement individually, schema-qualified.** The `exec_sql` function runs with `set search_path = ''`, so EVERY object name must be schema-qualified (`public.registration_cases`, `public.rso_team`, `auth`-not-needed here) or you get `42P01 relation does not exist`. `EXECUTE` runs ONE command per call, so send one statement per POST. Read the service key from `.env` at the main checkout root (do NOT print it). Run this script (it loads creds from `.env`, sends each statement, and prints HTTP status per statement):

```bash
SUPABASE_URL=$(grep -E '^SUPABASE_URL=' "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env" | head -1 | cut -d= -f2- | tr -d '"')
SERVICE_KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env" | head -1 | cut -d= -f2- | tr -d '"')
post() {
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    --data-binary @- <<'JSON'
{"query": "REPLACE_ME"}
JSON
}
# Statement 1
post() { curl -s -o /dev/null -w "%{http_code}\n" -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json" -d "$1"; }
post '{"query":"ALTER TABLE public.registration_cases ADD COLUMN IF NOT EXISTS assigned_rso uuid;"}'
post '{"query":"UPDATE public.registration_cases SET assigned_rso = assigned_va WHERE assigned_rso IS NULL;"}'
post '{"query":"CREATE INDEX IF NOT EXISTS idx_cases_assigned_rso ON public.registration_cases(assigned_rso);"}'
post '{"query":"ALTER TABLE public.registration_cases ADD COLUMN IF NOT EXISTS blocker_set_at timestamptz;"}'
post '{"query":"CREATE TABLE IF NOT EXISTS public.rso_team (user_id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, phone text DEFAULT '\'''\'', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());"}'
post '{"query":"INSERT INTO public.rso_team (user_id, name, email, phone) VALUES ('\''2f94f870-7ab2-4f71-98ad-bf3756ed88db'\'','\''Khaleed Mahmoud'\'','\''khaleedmahmoud1211@gmail.com'\'','\''+61406281243'\''), ('\''7bed5eb8-f03d-40d6-b090-eb006cd02be7'\'','\''Hazel'\'','\''hazel@mygplink.com.au'\'','\'''\'') ON CONFLICT (user_id) DO NOTHING;"}'
```
Expected: each `post` prints `204` (success). If any prints `404` mentioning the relation, the name was not schema-qualified — fix and re-run (statements are idempotent).

- [ ] **Step 2: Verify each new object exists.** Never assume success — read it back:
```bash
SUPABASE_URL=$(grep -E '^SUPABASE_URL=' "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env" | head -1 | cut -d= -f2- | tr -d '"')
SERVICE_KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env" | head -1 | cut -d= -f2- | tr -d '"')
echo "assigned_rso + blocker_set_at:"; curl -s "$SUPABASE_URL/rest/v1/registration_cases?select=assigned_rso,blocker_set_at&limit=1" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
echo; echo "rso_team rows:"; curl -s "$SUPABASE_URL/rest/v1/rso_team?select=user_id,name,email,phone,active" -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
```
Expected: first call returns `200` with a row object exposing both `assigned_rso` and `blocker_set_at` keys (proves both columns exist; a `42703`/`PGRST` column error means the ALTER did not land). Second call returns the two seeded RSO rows (Khaleed + Hazel) with `active:true`. PASS only if both columns are present AND both seed rows are returned.

- [ ] **Step 3: Record the verification outcome.** This is an operational step with no code change, so there is nothing to commit. Note in the task handoff whether all six statements returned 204 and both verification reads passed.

---

### Task 2.3: Add a `loadRsoTeam()` helper that reads `rso_team` with the array as fallback (#22)
**Files:** Modify `server.js` (insert helper after the `DEFAULT_RSO_USER_ID` block ending at line 267); Test `tests/rso-team.test.js`

- [ ] **Step 1 (TDD — write failing test first):** The roster-merge logic must be a unit-testable pure function. Create `tests/rso-team.test.js` that imports a new pure helper `mergeRsoRoster(dbRows, seedArray)` (exported from `server.js` via the existing module-exports pattern OR a tiny inline export — see Step 3 for how it is exposed). The function returns DB rows when present (active only by default), else the seed array, normalized to `{ user_id, name, email, phone, active }`. Write:

```js
import { describe, it, expect } from 'vitest';
import { mergeRsoRoster } from '../server.js';

var SEED = [
  { name: 'Khaleed Mahmoud', email: 'khaleedmahmoud1211@gmail.com', phone: '+61406281243', user_id: '2f94f870-7ab2-4f71-98ad-bf3756ed88db' },
  { name: 'Hazel', email: 'hazel@mygplink.com.au', phone: '', user_id: '7bed5eb8-f03d-40d6-b090-eb006cd02be7' }
];

describe('mergeRsoRoster', function () {
  it('falls back to the seed array when there are no DB rows', function () {
    var out = mergeRsoRoster([], SEED);
    expect(out.length).toBe(2);
    expect(out[0].user_id).toBe('2f94f870-7ab2-4f71-98ad-bf3756ed88db');
    expect(out[0].active).toBe(true);
    expect(out[1].phone).toBe('');
  });

  it('returns DB rows (active only) when present, normalized', function () {
    var rows = [
      { user_id: 'u1', name: 'New RSO', email: 'new@x.com', phone: '+1', active: true },
      { user_id: 'u2', name: 'Retired RSO', email: 'old@x.com', phone: '', active: false }
    ];
    var out = mergeRsoRoster(rows, SEED);
    expect(out.length).toBe(1);
    expect(out[0].user_id).toBe('u1');
    expect(out[0].email).toBe('new@x.com');
  });

  it('includes inactive rows when includeInactive is set', function () {
    var rows = [
      { user_id: 'u1', name: 'A', email: 'a@x.com', phone: '', active: true },
      { user_id: 'u2', name: 'B', email: 'b@x.com', phone: '', active: false }
    ];
    var out = mergeRsoRoster(rows, SEED, { includeInactive: true });
    expect(out.length).toBe(2);
  });

  it('defaults missing active to true and missing phone to empty string', function () {
    var out = mergeRsoRoster([{ user_id: 'u1', name: 'A', email: 'a@x.com' }], SEED);
    expect(out[0].active).toBe(true);
    expect(out[0].phone).toBe('');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.**
```bash
npx vitest run tests/rso-team.test.js
```
Expected: FAIL — `mergeRsoRoster` is not exported / not defined (import error or "is not a function").

- [ ] **Step 3: Implement `mergeRsoRoster` (pure) + `loadRsoTeam` (async DB read with fallback) and export the pure helper.** Insert immediately after line 267 (the `DEFAULT_RSO_USER_ID` declaration) and before `let _domainApiAccessTokenCache = new Map();`. First confirm the existing export style at the bottom of `server.js`:

```bash
grep -n "module.exports" server.js | tail -5
```
If `module.exports` exists, append `mergeRsoRoster` to it; if there is no existing exports object, add a guarded one at the very end of the file:
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Object.assign(module.exports || {}, { mergeRsoRoster: mergeRsoRoster });
}
```

Insert this helper block after line 267:
```js

// Normalize/merge the RSO roster: prefer DB rows from rso_team; fall back to the
// in-memory RSO_TEAM seed when the table is empty or unreachable (local dev).
// Pure (no DB) so it can be unit-tested; loadRsoTeam() does the fetch.
function mergeRsoRoster(dbRows, seedArray, opts) {
  var includeInactive = !!(opts && opts.includeInactive);
  var rows = Array.isArray(dbRows) ? dbRows : [];
  var source = rows.length ? rows : (Array.isArray(seedArray) ? seedArray : []);
  var fromDb = rows.length > 0;
  return source
    .map(function (r) {
      return {
        user_id: r.user_id || null,
        name: r.name || '',
        email: r.email || '',
        phone: r.phone || '',
        active: (r.active === undefined || r.active === null) ? true : !!r.active
      };
    })
    .filter(function (r) {
      if (!r.user_id) return false;
      // Seed rows are all considered active; only DB rows carry an active flag to filter on.
      if (fromDb && !includeInactive && !r.active) return false;
      return true;
    });
}

// Async: read the editable rso_team table, falling back to the RSO_TEAM seed.
// supabaseDbRequest returns ok:false (503) when Supabase is not configured (local dev),
// in which case we transparently use the seed array.
async function loadRsoTeam(opts) {
  try {
    var res = await supabaseDbRequest('rso_team', 'select=user_id,name,email,phone,active&order=name.asc', { method: 'GET' });
    var rows = (res && res.ok && Array.isArray(res.data)) ? res.data : [];
    return mergeRsoRoster(rows, RSO_TEAM, opts);
  } catch (e) {
    return mergeRsoRoster([], RSO_TEAM, opts);
  }
}
```

- [ ] **Step 4: Syntax check + re-run the test — expect PASS.**
```bash
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js && npx vitest run tests/rso-team.test.js
```
Expected: `node --check` prints nothing (exit 0); vitest reports all 4 tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add server.js tests/rso-team.test.js && git commit -m "Add loadRsoTeam/mergeRsoRoster reading rso_team with array fallback (#22)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.4: Replace in-memory `RSO_TEAM` reads with the `rso_team` table (#22, #23)
**Files:** Modify `server.js` (`GET /api/admin/rsos` handler `25275-25280`; scheduled-calls reminder lookup `21134`; calls/schedule lookup `25304`)

- [ ] **Step 1: Make `GET /api/admin/rsos` read from the table.** This is the admin assignment dropdown source. Replace the synchronous array return at `server.js:25275-25280`.

Before:
```js
  // GET /api/admin/rsos — list RSO team members for assignment dropdown
  if (req.method === 'GET' && pathname === '/api/admin/rsos') {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    sendJson(res, 200, { ok: true, rsos: RSO_TEAM });
    return;
  }
```
After:
```js
  // GET /api/admin/rsos — list RSO team members for assignment dropdown
  // Reads the editable rso_team table; the in-memory RSO_TEAM array is a seed/fallback.
  if (req.method === 'GET' && pathname === '/api/admin/rsos') {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const rsos = await loadRsoTeam();
    sendJson(res, 200, { ok: true, rsos: rsos });
    return;
  }
```

- [ ] **Step 2: Make the scheduled-calls reminder lookup use the table.** At `server.js:21134` the reminder cron resolves an RSO's phone from the in-memory array. The surrounding code already iterates calls in an `async` loop, so load the roster once before the loop and look up against it. First read the immediate context to anchor the load-once insertion:
```bash
grep -n "const calls = callsRes.ok\|const needsReminder\|const rso = RSO_TEAM.find" server.js
```
Add a roster load right after `needsReminder` is computed (the early-return for `needsReminder.length === 0` at line ~21118 stays above it, so we only load when there is work).

Before (line ~21134):
```js
        const rso = RSO_TEAM.find(r => r.email.toLowerCase() === (call.assigned_rso_email || '').toLowerCase());
```
After:
```js
        const rso = rsoRoster.find(r => r.email.toLowerCase() === (call.assigned_rso_email || '').toLowerCase());
```
And insert this line immediately after the `if (needsReminder.length === 0) { ... return; }` block (just before `let reminded = 0;` at line ~21122):
```js
      const rsoRoster = await loadRsoTeam({ includeInactive: true });
```
(Use `includeInactive: true` here so a call already assigned to a now-inactive RSO still resolves their phone for the reminder.)

- [ ] **Step 3: Make the calls/schedule RSO lookup use the table.** At `server.js:25304` the handler resolves the assigned RSO from the array. This handler is already `async`. 

Before:
```js
    const assignedRso = assignedRsoEmail ? RSO_TEAM.find(r => r.email.toLowerCase() === assignedRsoEmail) : null;
```
After:
```js
    const scheduleRsoRoster = await loadRsoTeam({ includeInactive: true });
    const assignedRso = assignedRsoEmail ? scheduleRsoRoster.find(r => r.email.toLowerCase() === assignedRsoEmail) : null;
```

- [ ] **Step 4: Confirm the only remaining `RSO_TEAM` references are the declaration and the seed plumbing.** The array must remain as the seed/fallback consumed by `loadRsoTeam`/`DEFAULT_RSO_USER_ID` — it must NOT be read directly by any request handler anymore.
```bash
grep -n "RSO_TEAM" server.js
```
Expected: matches only at the declaration (`260`), the `DEFAULT_RSO_USER_ID` derivation (`267`), and inside `loadRsoTeam` (the `mergeRsoRoster(rows, RSO_TEAM, ...)` call). No matches inside `/api/admin/rsos`, the reminder loop, or calls/schedule. PASS if that is the case.

- [ ] **Step 5: Syntax check + full test run.**
```bash
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js && npx vitest run tests/rso-team.test.js
```
Expected: `node --check` exits 0; the rso-team tests still PASS.

- [ ] **Step 6: Commit.**
```bash
git add server.js && git commit -m "Read RSO roster from rso_team table in admin/rsos, call reminders, calls/schedule (#22,#23)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

**Phase 2 notes for downstream phases:** `loadRsoTeam(opts)` (async, table-with-seed-fallback) and `mergeRsoRoster(dbRows, seedArray, opts)` (pure, exported) are now available in `server.js`. Phase 3 (`GET /api/ceo/rsos`) should build its roster via `loadRsoTeam()` and join it to `computeRsoWorkload(...)` grouped by the new durable `registration_cases.assigned_rso` column added here (backfilled from `assigned_va`). The `blocker_set_at` column added in this migration is the source for `computeBlockers` `days_blocked` (#5) — it must be stamped in the case PUT handler (owned by the actions phase), not here.

---

## Phase 3: Refactor CEO endpoints to consume lib/ceo-metrics

**Goal:** Refactor `GET /api/ceo/dashboard`, `GET /api/ceo/drilldown/{section}`, and `GET /api/ceo/trends` so they fetch rows then delegate ALL counting/bucketing to `lib/ceo-metrics.js`; every drilldown section calls the matching `*Ids`/list helper with the SAME period/filters so the row list always equals the card count, and KPI tiles get server-side drilldown support.

**Files:**
- Modify `server.js` (require line ~118; dashboard endpoint 36467-36837; drilldown endpoint 36839-37049; trends endpoint 37051-37109)
- Modify `tests/ceo-metrics.test.js` (Create/extend — the fixture-based reconciliation tests added in Phase 1/2; add endpoint-parity assertions here)
- Test (commands run against `tests/ceo-metrics.test.js`)

> Assumes Phase 1 created `lib/ceo-metrics.js` with the full exported API from the contract, and Phase 2 added the DB columns (`assigned_rso`, `blocker_set_at`) and `rso_team` table via `supabase/migrations/20260614120000_ceo_rebuild.sql`. This phase only rewires the three read endpoints to consume those functions and adds tile-drilldown sections. Do NOT redefine the metric logic here — import it.

---

### Task 3.1: Wire `lib/ceo-metrics.js` into server.js and verify the reconciliation contract test exists (#29)

**Files:** `server.js`, `tests/ceo-metrics.test.js`

- [ ] **Step 1: Add the require at the top of server.js, next to the other `./lib/` requires.**

Read server.js:104-118 first; insert after the `document-pipeline.js` require (currently ending at line 118). Add:

```javascript
var ceoMetrics = require('./lib/ceo-metrics.js');
```

Exact edit — find the block ending the lib requires (around 118):

old:
```javascript
} = require('./lib/document-pipeline.js');
```
new:
```javascript
} = require('./lib/document-pipeline.js');
var ceoMetrics = require('./lib/ceo-metrics.js');
```

- [ ] **Step 2: Write a failing endpoint-parity test that asserts the exported API surface this phase relies on exists.** This guards against importing names the refactor calls. Append to `tests/ceo-metrics.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as ceoMetrics from '../lib/ceo-metrics.js';

describe('ceo-metrics API surface consumed by server endpoints', () => {
  const required = [
    'filterActiveCases','caseAgeMs','withinPeriod','isOverdue','activeUserIdSet',
    'computeKpis','computePipeline','pipelineCaseIds','computeBlockers',
    'computeTaskHealth','computeRsoWorkload','rsoCaseIds','computePlacements',
    'placementAppIds','securedAppUserIds','computeGpActivity','gpActivityCaseIds',
    'computeTicketMetrics','ticketIds','computeCompletions',
    'isSecuredStatus','isInterviewStatus','isOfferStatus'
  ];
  it('exports every function the endpoints call', () => {
    for (const name of required) {
      expect(typeof ceoMetrics[name], name).toBe('function');
    }
  });
  it('exports the shared constants', () => {
    expect(Array.isArray(ceoMetrics.OPEN_TASK_STATUSES)).toBe(true);
    expect(Array.isArray(ceoMetrics.OVERDUE_EXCLUDED_STATUSES)).toBe(true);
    expect(Array.isArray(ceoMetrics.FUNNEL_STAGES)).toBe(true);
    expect(typeof ceoMetrics.DB_STAGE_ORDER).toBe('object');
    expect(typeof ceoMetrics.SIX_MONTHS_MS).toBe('number');
  });
});
```

> Note: `lib/ceo-metrics.js` is authored as a CommonJS module (`module.exports = {...}`) because server.js uses `require`. vitest imports it via `import * as` which Node interop resolves. If Phase 1 wrote it ESM, the require in Step 1 must be adjusted — flag to Phase 1 author; the contract says "pure, dependency-free", CJS is expected.

- [ ] **Step 3: Run the test (expected PASS once Phase 1 lib exists; FAIL with a clear missing-export name otherwise).**

```
npx vitest run tests/ceo-metrics.test.js -t "API surface consumed by server endpoints"
```
Expected: PASS. If it FAILs naming a function, the Phase 1 lib is incomplete — stop and report; do not stub it in server.js.

- [ ] **Step 4: Syntax-check server.js.**

```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (exit 0).

- [ ] **Step 5: Commit.**

```
git add server.js tests/ceo-metrics.test.js && git commit -m "CEO: require lib/ceo-metrics in server.js + API-surface guard test (#29)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.2: Refactor `GET /api/ceo/dashboard` to delegate all counting to lib/ceo-metrics (#1,#3,#6,#8,#12,#15,#34,#38,#39,#40,#42,#52,#56,#63 server-side, #51)

**Files:** `server.js` (36499-36836), `tests/ceo-metrics.test.js`

- [ ] **Step 1: Replace the inline filtering, KPI, pipeline, blockers, task-health, placements, gp-activity, tickets, and completions computation (server.js:36499-36828) with delegations to `ceoMetrics.*`.** Keep the row fetches (36472-36497), the escalations block (36567-36611), the velocity block (36700-36758) and the final `sendJson` shape unchanged — those are out of this task's scope (escalations/velocity owned by other phases; preserve their current behaviour). Read 36499-36828 in full before editing, then replace exactly that span.

old (the span starting at the `var now = Date.now();` line 36499 through the `var completions = ...` line 36828, i.e. everything between the row-fetch block and `sendJson`):
```javascript
    var now = Date.now();
    var DAY_MS = 86400000;
    var SIX_MONTHS_MS = 180 * DAY_MS;
    var weekAgo = new Date(now - 7 * DAY_MS).toISOString();
```
…through (line 36828):
```javascript
    var completions = { this_month: thisMonthCompleted, total: completedCases.length, recent_milestones: recentMilestones };
```

> Because this span is large (~330 lines) and interleaves the escalations + velocity blocks that this phase must NOT touch, perform the replacement as three contiguous Edit operations so the untouched blocks stay byte-identical:

**Edit A — the filtering + KPI block (36499 `var now` through 36565 the `};` closing `var kpi`):** replace with:

```javascript
    var now = Date.now();
    var DAY_MS = 86400000;
    var SIX_MONTHS_MS = ceoMetrics.SIX_MONTHS_MS;
    var weekAgo = new Date(now - 7 * DAY_MS).toISOString();
    var todayStr = new Date(now).toISOString().slice(0, 10);

    // Time filter: current (default), 7d, 14d, 30d, all
    var period = url.searchParams.get('period') || 'current';

    // Active-case set is the single source of truth: excludes withdrawn + >6mo stale,
    // BUT 'all' skips the 6-month cut so "All Time" is honest (#52).
    var cases = ceoMetrics.filterActiveCases(allCasesRaw, { allTime: period === 'all', nowMs: now });

    // Build case ID / user ID sets for scoping tasks/apps/tickets to active cases (#6/#40)
    var activeCaseIds = new Set();
    for (var aci = 0; aci < cases.length; aci++) activeCaseIds.add(cases[aci].id);
    var activeCaseUserIds = ceoMetrics.activeUserIdSet(cases);

    // Open tasks scoped to active cases (#6)
    var filteredTasks = tasks.filter(function(t) { return activeCaseIds.has(t.case_id); });

    // KPIs — computed entirely by lib so card == drilldown (#1,#8,#15,#42)
    var kpi = ceoMetrics.computeKpis({
      cases: cases, allCases: allCasesRaw, tasks: filteredTasks, apps: apps,
      careerRoles: roles, period: period, nowMs: now, todayStr: todayStr,
      activeUserIds: activeCaseUserIds
    });
    var blockedCases = cases.filter(function(c) { return c.status === 'blocked' || c.blocker_status; });
    var completedCases = allCasesRaw.filter(function(c) { return c.stage === 'complete' && c.status !== 'withdrawn'; });
```

> Rationale: `computeKpis` returns `{total_gps, placed, open_tasks, overdue_tasks, blocked_cases, completed_gps}` per the contract — `placed` deduped via `securedAppUserIds` (fixes #8 `placed` status, #42 dedupe), `completed_gps` from all-time complete (#15), `overdue_tasks` via `isOverdue` DATE compare (#1). The old `filteredApps`/`filteredTickets`/`SECURED_STATUSES`/`securedApps`/`uniquePlacedGps`/`openTickets`/`overdueTasks` locals are removed; downstream blocks now use lib helpers. `blockedCases`/`completedCases` are kept as locals because the escalations block (untouched) and the trends-independent sections reference cases; `completedCases` now reads all-time (#15).

**Edit B — replace pipeline + blockers + task-health blocks (36613 `// Pipeline` comment through 36672 the `};` closing `var taskHealth`):** with:

```javascript
    // Pipeline — funnel order + cumulative/snapshot semantics owned by lib (#3,#28,#56)
    var isCumulative = (period !== 'current');
    var pipeline = ceoMetrics.computePipeline(cases, { cumulative: isCumulative });
    var STAGE_LABELS = {};
    for (var sli = 0; sli < ceoMetrics.FUNNEL_STAGES.length; sli++) {
      STAGE_LABELS[ceoMetrics.FUNNEL_STAGES[sli].key] = ceoMetrics.FUNNEL_STAGES[sli].label;
    }

    // Blockers — days_blocked from blocker_set_at, single field name (#5/#57)
    var blockers = ceoMetrics.computeBlockers(cases, now).map(function(b) {
      return {
        case_id: b.case_id, user_id: b.user_id, gp_name: ceoGpName(b.user_id), gp_email: ceoGpEmail(b.user_id),
        stage: b.stage, days_blocked: b.days_blocked,
        blocker_status: b.blocker_status, blocker_reason: b.blocker_reason,
        assigned_va: b.assigned_va ? ceoGpName(b.assigned_va) : 'Unassigned', assigned_va_id: b.assigned_va
      };
    });

    // Task Health — overdue uses isOverdue to match KPI; avg over labelled window (#30,#31)
    var completedRes = await supabaseDbRequest('registration_tasks', 'select=id,created_at,completed_at&status=eq.completed&completed_at=gte.' + encodeURIComponent(new Date(now - ceoMetrics.SIX_MONTHS_MS).toISOString()) + '&order=completed_at.desc&limit=2000');
    var completedTasks = (completedRes.ok && Array.isArray(completedRes.data)) ? completedRes.data : [];
    var taskHealth = ceoMetrics.computeTaskHealth(filteredTasks, completedTasks, todayStr);
```

> `computeBlockers` returns `assigned_va` as a raw id per the contract field list (it also carries `days_blocked`, `blocker_status`, `blocker_reason`); we resolve names here at the endpoint (lib stays DB/profile-free). `computeTaskHealth(tasks, completedSample, todayStr)` returns `{open, in_progress, completed_this_week, overdue, avg_resolve_days}`. The completed-tasks query is now bounded by a 6-month *window* (labelled, not a silent 500-cap, #31/#63) and raised to limit 2000. `days_in_stage` field is renamed to `days_blocked` (#5/#57) — the page render relabel is done in Phase 4/5; preserve the new field name here.

**Edit C — replace placements + gp-activity + tickets + completions blocks (36760 `// Placements` comment through 36828 `var completions = ...`):** with:

```javascript
    // Placements — buckets via shared status sets; ids match tiles in drilldown (#8,#9,#10,#11,#60,#61)
    var placements = ceoMetrics.computePlacements(apps, roles, activeCaseUserIds, period, now);
    placements.active_roles = roles.filter(function(r) { return r.is_active; }).length;

    // GP Activity — computed over full active population, INDEPENDENT of period (#12,#36,#37)
    var gpActivityRaw = ceoMetrics.computeGpActivity(cases, now);
    var gpActivity = {
      active_7d: gpActivityRaw.active_7d,
      inactive_7_14d: gpActivityRaw.inactive_7_14d,
      cold_14d_plus: gpActivityRaw.cold_14d_plus,
      cold_gps: gpActivityRaw.cold_gps.map(function(c) {
        return {
          case_id: c.case_id, user_id: c.user_id, gp_name: ceoGpName(c.user_id), gp_email: ceoGpEmail(c.user_id),
          last_activity: c.last_activity, stage: c.stage, days_inactive: c.days_inactive,
          assigned_va: c.assigned_va ? ceoGpName(c.assigned_va) : 'Unassigned'
        };
      })
    };

    // Tickets — scoping explicit, averages exclude nulls, no silent 500-cap (#39,#40)
    var ticketStats = ceoMetrics.computeTicketMetrics(tickets, activeCaseUserIds);

    // Completions — total all-time, milestones globally sorted + humanized (#14,#15,#41,#62)
    var completions = ceoMetrics.computeCompletions(completedCases, stageEvents, now);
    completions.recent_milestones = completions.recent_milestones.map(function(m) {
      return {
        gp_name: ceoGpName(m.user_id), milestone: m.milestone, date: m.date, days_ago: m.days_ago
      };
    });
```

> `computeGpActivity` returns `cold_gps` already sorted-by-days_inactive-then-sliced (#36) with raw ids — names resolved here. `computeCompletions(completeCases, stageEvents, nowMs)` returns `{this_month, total, recent_milestones}` (milestones carry `user_id`, `milestone` humanized label, `date`, `days_ago`); we resolve `gp_name` at endpoint. `computeTicketMetrics` returns `{open, resolved_this_week, avg_resolution_hours, avg_first_reply_hours}` — note it no longer exposes `resolved_total`; if the page consumes `resolved_total`, the contract drops it, so confirm the page render in Phase 5 reads only the four returned fields. **Inventory check:** page reads `data.tickets.open`, `resolved_this_week`, `avg_resolution_hours`, `avg_first_reply_hours` — all preserved.

- [ ] **Step 2: Verify the final `sendJson` (36830-36835) response shape is unchanged.** It already references `kpi, escalations, pipeline, blockers, task_health: taskHealth, va_workload: vaWorkload, velocity, placements, gp_activity: gpActivity, tickets: ticketStats, completions` — all those locals still exist after the edits. No change needed; confirm by reading 36830-36836 after editing.

> `va_workload` (`vaWorkload`) is computed by the untouched VA block (36674-36698) — it is NOT migrated in this phase because the RSO-grouping migration of that block is Phase 4 (W3, `computeRsoWorkload`/`assigned_rso`). Leave 36674-36698 exactly as-is. Same for the escalations block (36567-36611) and velocity (36700-36758).

- [ ] **Step 3: Add the dashboard ↔ drilldown reconciliation test.** This is the core contract assertion. Append to `tests/ceo-metrics.test.js` (reuse the fixed fixture dataset created in Phase 1; if Phase 1 exported it, import it — otherwise define a small fixture inline matching the rows the lib expects):

```javascript
import { describe, it, expect } from 'vitest';
import * as M from '../lib/ceo-metrics.js';
import { FIXTURE } from './ceo-metrics.fixture.js';

describe('endpoint parity: every card count equals its drilldown id list length', () => {
  const NOW = FIXTURE.nowMs;
  const TODAY = new Date(NOW).toISOString().slice(0, 10);

  for (const period of ['current', '7d', '14d', '30d', 'all']) {
    it('pipeline bar count === pipelineCaseIds length per stage [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const cumulative = period !== 'current';
      const bars = M.computePipeline(cases, { cumulative });
      for (const bar of bars) {
        expect(M.pipelineCaseIds(cases, bar.key, { cumulative }).length, bar.key).toBe(bar.count);
      }
    });

    it('placements tile === placementAppIds length per bucket [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const activeUserIds = M.activeUserIdSet(cases);
      const p = M.computePlacements(FIXTURE.apps, FIXTURE.careerRoles, activeUserIds, period, NOW);
      for (const bucket of ['applied','submitted_to_practice','interviewing','offers_made','secured']) {
        expect(M.placementAppIds(FIXTURE.apps, bucket, activeUserIds, period, NOW).length, bucket).toBe(p[bucket]);
      }
    });

    it('gp activity tile === gpActivityCaseIds length per bucket [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const a = M.computeGpActivity(cases, NOW);
      expect(M.gpActivityCaseIds(cases, 'active', NOW).length).toBe(a.active_7d);
      expect(M.gpActivityCaseIds(cases, 'inactive', NOW).length).toBe(a.inactive_7_14d);
      expect(M.gpActivityCaseIds(cases, 'cold', NOW).length).toBe(a.cold_14d_plus);
    });
  }

  it('task health overdue === overdue tasks via isOverdue (KPI parity, #30)', () => {
    const cases = M.filterActiveCases(FIXTURE.cases, { allTime: true, nowMs: NOW });
    const ids = new Set(cases.map(c => c.id));
    const tasks = FIXTURE.tasks.filter(t => ids.has(t.case_id));
    const th = M.computeTaskHealth(tasks, FIXTURE.completedTasks, TODAY);
    const overdueList = tasks.filter(t => M.isOverdue(t, TODAY));
    expect(overdueList.length).toBe(th.overdue);
  });

  it('tickets open count === ticketIds open length (#38)', () => {
    const cases = M.filterActiveCases(FIXTURE.cases, { allTime: true, nowMs: NOW });
    const activeUserIds = M.activeUserIdSet(cases);
    const tm = M.computeTicketMetrics(FIXTURE.tickets, activeUserIds);
    expect(M.ticketIds(FIXTURE.tickets, 'open', activeUserIds).length).toBe(tm.open);
  });
});
```

> If Phase 1 did not produce `tests/ceo-metrics.fixture.js`, create it here with a minimal but representative dataset (≥1 case per funnel stage incl. one `visa`, one withdrawn, one >6mo stale, ≥1 blocked case with `blocker_set_at`, apps spanning every placement status incl. `placed`, ≥1 ticket from a withdrawn-case user, completed cases older + within this month). Each `pipelineCaseIds`/`placementAppIds`/`gpActivityCaseIds`/`ticketIds` MUST return the exact ids counted by its sibling — that is the whole point of the single source of truth.

- [ ] **Step 4: Run the reconciliation test (expected PASS).**

```
npx vitest run tests/ceo-metrics.test.js -t "every card count equals its drilldown id list length"
```
Expected: PASS for all 5 periods. A FAIL means the lib count and lib id-list diverge — fix in `lib/ceo-metrics.js` (Phase 1/2 territory) before proceeding; do NOT paper over it in the endpoint.

- [ ] **Step 5: Syntax-check.**

```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: exit 0, no output.

- [ ] **Step 6: Commit.**

```
git add server.js tests/ceo-metrics.test.js && git commit -m "CEO dashboard: delegate KPI/pipeline/blockers/task-health/placements/activity/tickets/completions to lib (#1,#3,#6,#8,#12,#15,#30,#39,#40,#42,#52,#56)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.3: Refactor `GET /api/ceo/drilldown/{section}` so each section reuses the SAME lib helper + period/filters as its card (#2,#6,#9,#10,#11,#34,#38,#51,#56)

**Files:** `server.js` (36839-37049), `tests/ceo-metrics.test.js`

The drilldown must NOT re-query with its own ad-hoc status sets/date rules. Each branch fetches the candidate rows then constrains them to exactly the ids the matching `*Ids` helper returns for the SAME `period`. Read 36839-37049 fully before editing.

- [ ] **Step 1: Replace the period/filter setup (36854-36867) so the drilldown uses the same `filterActiveCases` + `nowMs` as the dashboard.**

old:
```javascript
    var dNow = Date.now();
    var dDAY_MS = 86400000;
    var dSIX_MONTHS_MS = 180 * dDAY_MS;
    var dPeriod = url.searchParams.get('period') || 'current';
    var dPeriodMs = dPeriod === '7d' ? 7 * dDAY_MS : dPeriod === '14d' ? 14 * dDAY_MS : dPeriod === '30d' ? 30 * dDAY_MS : 0;
    function dFilterCases(arr) {
      return arr.filter(function(c) {
        if (c.status === 'withdrawn') return false;
        var la = c.last_gp_activity_at ? new Date(c.last_gp_activity_at).getTime() : (c.updated_at ? new Date(c.updated_at).getTime() : new Date(c.created_at).getTime());
        if ((dNow - la) > dSIX_MONTHS_MS) return false;
        if (dPeriodMs > 0 && (dNow - la) > dPeriodMs) return false;
        return true;
      });
    }
```
new:
```javascript
    var dNow = Date.now();
    var dDAY_MS = 86400000;
    var dPeriod = url.searchParams.get('period') || 'current';
    var dTodayStr = new Date(dNow).toISOString().slice(0, 10);
    // Same active-case definition as the dashboard (#34/#52)
    function dFilterCases(arr) {
      return ceoMetrics.filterActiveCases(arr, { allTime: dPeriod === 'all', nowMs: dNow });
    }
```

- [ ] **Step 2: Rewrite the `pipeline` branch (36869-36892) so it returns exactly `pipelineCaseIds` for the stage + period (#2,#56).** The old branch queries `stage=eq.<stage>` (a snapshot) which never matches the cumulative bar. Replace with: fetch ALL active cases, ask the lib which ids the bar counted, then render only those.

old (36869-36892, the entire `if (section === 'pipeline') { ... return; }` block):
```javascript
    if (section === 'pipeline') {
      var stage = url.searchParams.get('stage') || 'myintealth';
      var dCasesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=eq.' + encodeURIComponent(stage) + '&order=updated_at.desc');
      var dCases = dFilterCases((dCasesRes.ok && Array.isArray(dCasesRes.data)) ? dCasesRes.data : []);
      var dCaseIds = dCases.map(function(c) { return c.id; });
```
…through the `sendJson(res, 200, { ok: true, section: 'pipeline', stage: stage, items: items }); return; }`.

new:
```javascript
    if (section === 'pipeline') {
      var stage = url.searchParams.get('stage') || 'myintealth';
      var isCumulativeDd = (dPeriod !== 'current');
      var dAllCasesRes = await supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc');
      var dActiveCases = dFilterCases((dAllCasesRes.ok && Array.isArray(dAllCasesRes.data)) ? dAllCasesRes.data : []);
      // Exact ids the funnel bar counted (#2/#56 — visa folds into pbs in the lib)
      var barIds = new Set(ceoMetrics.pipelineCaseIds(dActiveCases, stage, { cumulative: isCumulativeDd }));
      var dCases = dActiveCases.filter(function(c) { return barIds.has(c.id); });
      var dCaseIds = dCases.map(function(c) { return c.id; });
      var dTasks = [];
      if (dCaseIds.length > 0) {
        var dTasksRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,status,priority,due_date,title&case_id=in.(' + dCaseIds.join(',') + ')&status=in.(' + ceoMetrics.OPEN_TASK_STATUSES.join(',') + ')');
        dTasks = (dTasksRes.ok && Array.isArray(dTasksRes.data)) ? dTasksRes.data : [];
      }
      var dTaskCountByCase = {};
      for (var dti = 0; dti < dTasks.length; dti++) { dTaskCountByCase[dTasks[dti].case_id] = (dTaskCountByCase[dTasks[dti].case_id] || 0) + 1; }
      var items = dCases.map(function(c) {
        return {
          case_id: c.id, user_id: c.user_id, gp_name: dGpName(c.user_id), gp_email: dGpEmail(c.user_id),
          substage: c.substage || '', assigned_va: c.assigned_va ? dGpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va,
          days_in_stage: Math.floor((dNow - ceoMetrics.caseAgeMs(c, dNow) === undefined ? 0 : (dNow - (dNow - ceoMetrics.caseAgeMs(c, dNow)))) / dDAY_MS),
          status: c.status, blocker_status: c.blocker_status, blocker_reason: c.blocker_reason,
          open_task_count: dTaskCountByCase[c.id] || 0, last_gp_activity_at: c.last_gp_activity_at, last_va_action_at: c.last_va_action_at, practice_name: c.practice_name
        };
      });
      sendJson(res, 200, { ok: true, section: 'pipeline', stage: stage, items: items });
      return;
    }
```
Then fix the `days_in_stage` line — `caseAgeMs(c, nowMs)` returns the age in ms directly, so the row should be:
```javascript
          days_in_stage: Math.floor(ceoMetrics.caseAgeMs(c, dNow) / dDAY_MS),
```
Use that exact form (replace the convoluted expression above with this one when writing the block; it is shown corrected here to avoid shipping the wrong arithmetic).

- [ ] **Step 3: Rewrite the `tasks` branch (36910-36938) so overdue uses `isOverdue` (DATE compare, escalated included) and open is scoped to active cases + period — matching the KPI (#1,#6,#30,#51).**

old (entire `if (section === 'tasks') { ... return; }`):
```javascript
    if (section === 'tasks') {
      var tStatusFilter = url.searchParams.get('status') || 'open';
      var tQuery = 'select=*&order=priority.asc,created_at.desc&limit=200';
      if (tStatusFilter === 'overdue') {
        tQuery += '&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external)&due_date=lt.' + new Date().toISOString().slice(0, 10);
      } else {
        tQuery += '&status=eq.' + encodeURIComponent(tStatusFilter);
      }
      var tTasksRes = await supabaseDbRequest('registration_tasks', tQuery);
      var tTaskList = (tTasksRes.ok && Array.isArray(tTasksRes.data)) ? tTasksRes.data : [];
```
…through its `sendJson(...); return; }`.

new:
```javascript
    if (section === 'tasks') {
      var tStatusFilter = url.searchParams.get('status') || 'open';
      // Active-case scope so the list matches the active-only KPI (#6)
      var tAllCasesRes = await supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc');
      var tActiveCases = dFilterCases((tAllCasesRes.ok && Array.isArray(tAllCasesRes.data)) ? tAllCasesRes.data : []);
      var tActiveCaseIds = tActiveCases.map(function(c) { return c.id; });
      var tTaskList = [];
      if (tActiveCaseIds.length > 0) {
        // Fetch all open-work tasks for active cases, then bucket in JS via the lib (#1/#30)
        var tQuery = 'select=*&case_id=in.(' + tActiveCaseIds.join(',') + ')&status=in.(' + ceoMetrics.OPEN_TASK_STATUSES.join(',') + ')&order=priority.asc,created_at.desc';
        var tTasksRes = await supabaseDbRequest('registration_tasks', tQuery);
        var tAllOpen = (tTasksRes.ok && Array.isArray(tTasksRes.data)) ? tTasksRes.data : [];
        if (tStatusFilter === 'overdue') {
          tTaskList = tAllOpen.filter(function(t) { return ceoMetrics.isOverdue(t, dTodayStr); });
        } else if (tStatusFilter === 'open') {
          tTaskList = tAllOpen.filter(function(t) { return t.status === 'open'; });
        } else if (tStatusFilter === 'all_open') {
          tTaskList = tAllOpen;
        } else {
          tTaskList = tAllOpen.filter(function(t) { return t.status === tStatusFilter; });
        }
      }
      var tCaseLookup = {};
      for (var tcl = 0; tcl < tActiveCases.length; tcl++) tCaseLookup[tActiveCases[tcl].id] = tActiveCases[tcl];
      var tItems = tTaskList.map(function(t) {
        var tc = tCaseLookup[t.case_id] || {};
        return {
          task_id: t.id, case_id: t.case_id, user_id: tc.user_id, gp_name: tc.user_id ? dGpName(tc.user_id) : 'Unknown', gp_email: tc.user_id ? dGpEmail(tc.user_id) : '',
          title: t.title, priority: t.priority, status: t.status, due_date: t.due_date,
          stage: t.related_stage || tc.stage, assigned_va: tc.assigned_va ? dGpName(tc.assigned_va) : 'Unassigned', assigned_va_id: tc.assigned_va,
          created_at: t.created_at, description: t.description
        };
      });
      sendJson(res, 200, { ok: true, section: 'tasks', status: tStatusFilter, items: tItems });
      return;
    }
```

> `open_tasks` KPI counts ALL open-work statuses (`filteredTasks.length`), but the page's `tasks?status=open` historically listed only `status==='open'`. To make the Open-Tasks tile reconcile (#24), the tile maps to `status=all_open` (Task 3.5); the `open` filter is preserved for any caller that wants strictly-open. Both branches now scope to active cases.

- [ ] **Step 4: Rewrite the `activity` branch (36940-36960) to use `gpActivityCaseIds` over the full active population, period-independent (#12,#36,#37).**

old (entire `if (section === 'activity') { ... return; }`):
```javascript
    if (section === 'activity') {
      var aBucket = url.searchParams.get('bucket') || 'cold';
      var aCasesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=neq.complete&status=neq.withdrawn&order=last_gp_activity_at.asc.nullsfirst');
      var aCases = dFilterCases((aCasesRes.ok && Array.isArray(aCasesRes.data)) ? aCasesRes.data : []);
      var aItems = aCases.filter(function(c) {
```
…through its `sendJson(...); return; }`.

new:
```javascript
    if (section === 'activity') {
      var aBucket = url.searchParams.get('bucket') || 'cold';
      // GP activity is a staleness measure over the FULL active population (#12), period-independent.
      // Use allTime active set (drops withdrawn + >6mo) but NOT the period window.
      var aCasesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=neq.complete&status=neq.withdrawn&order=last_gp_activity_at.asc.nullsfirst');
      var aActiveAll = ceoMetrics.filterActiveCases((aCasesRes.ok && Array.isArray(aCasesRes.data)) ? aCasesRes.data : [], { allTime: false, nowMs: dNow });
      var aBucketIds = new Set(ceoMetrics.gpActivityCaseIds(aActiveAll, aBucket, dNow));
      var aItems = aActiveAll.filter(function(c) { return aBucketIds.has(c.id); }).map(function(c) {
        return {
          case_id: c.id, user_id: c.user_id, gp_name: dGpName(c.user_id), gp_email: dGpEmail(c.user_id),
          stage: c.stage, last_activity: c.last_gp_activity_at || c.created_at,
          days_inactive: Math.floor(ceoMetrics.caseAgeMs(c, dNow) / dDAY_MS),
          assigned_va: c.assigned_va ? dGpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va
        };
      });
      sendJson(res, 200, { ok: true, section: 'activity', bucket: aBucket, items: aItems });
      return;
    }
```

- [ ] **Step 5: Rewrite the `tickets` branch (36962-36974) to use `ticketIds('open', activeUserIds)` so it matches the open KPI scope (#38,#40).**

old (entire block):
```javascript
    if (section === 'tickets') {
      var stTicketsRes = await supabaseDbRequest('support_tickets', 'select=*&status=neq.closed&order=created_at.desc&limit=100');
      var stTicketList = (stTicketsRes.ok && Array.isArray(stTicketsRes.data)) ? stTicketsRes.data : [];
```
…through its `sendJson(...); return; }`.

new:
```javascript
    if (section === 'tickets') {
      var stBucket = url.searchParams.get('status') || 'open';
      var stCasesRes = await supabaseDbRequest('registration_cases', 'select=user_id,status,last_gp_activity_at,updated_at,created_at,stage&order=updated_at.desc');
      var stActiveCases = dFilterCases((stCasesRes.ok && Array.isArray(stCasesRes.data)) ? stCasesRes.data : []);
      var stActiveUserIds = ceoMetrics.activeUserIdSet(stActiveCases);
      var stTicketsRes = await supabaseDbRequest('support_tickets', 'select=*&order=created_at.desc&limit=1000');
      var stAllTickets = (stTicketsRes.ok && Array.isArray(stTicketsRes.data)) ? stTicketsRes.data : [];
      var stWantedIds = new Set(ceoMetrics.ticketIds(stAllTickets, stBucket, stActiveUserIds));
      var stItems = stAllTickets.filter(function(t) { return stWantedIds.has(t.id); }).map(function(t) {
        return {
          ticket_id: t.id, user_id: t.user_id, case_id: t.case_id, gp_name: dGpName(t.user_id), gp_email: dGpEmail(t.user_id),
          title: t.title, category: t.category, priority: t.priority, status: t.status,
          created_at: t.created_at, days_open: Math.floor((dNow - new Date(t.created_at).getTime()) / dDAY_MS)
        };
      });
      sendJson(res, 200, { ok: true, section: 'tickets', status: stBucket, items: stItems });
      return;
    }
```

- [ ] **Step 6: Rewrite the `placements` branch (36990-37020) to scope to active GPs + period and reuse `placementAppIds` for each bucket (#8,#9,#10,#11).**

old (entire `if (section === 'placements') { ... return; }`):
```javascript
    if (section === 'placements') {
      var plStatusFilter = url.searchParams.get('status') || 'all';
      var plSECURED = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
      var plAppsRes = await supabaseDbRequest('gp_applications', 'select=*&order=updated_at.desc&limit=300');
      var plAllApps = (plAppsRes.ok && Array.isArray(plAppsRes.data)) ? plAllApps.data : [];
```
*(read the real lines — the snapshot above paraphrases; match the actual `plAllApps` assignment which reads `(plAppsRes.ok && Array.isArray(plAppsRes.data)) ? plAppsRes.data : []`).* Replace the whole block through its `sendJson(...); return; }` with:

```javascript
    if (section === 'placements') {
      var plBucket = url.searchParams.get('status') || 'applied';
      // Active-GP scope + same period as the tile (#9)
      var plCasesRes = await supabaseDbRequest('registration_cases', 'select=user_id,status,last_gp_activity_at,updated_at,created_at,stage&order=updated_at.desc');
      var plActiveCases = dFilterCases((plCasesRes.ok && Array.isArray(plCasesRes.data)) ? plCasesRes.data : []);
      var plActiveUserIds = ceoMetrics.activeUserIdSet(plActiveCases);
      var plAppsRes = await supabaseDbRequest('gp_applications', 'select=*');
      var plAllApps = (plAppsRes.ok && Array.isArray(plAppsRes.data)) ? plAppsRes.data : [];
      // Exact ids the tile counted (#10/#11 — interviewing UNION career_interviews handled in lib)
      var plWantedIds = new Set(ceoMetrics.placementAppIds(plAllApps, plBucket, plActiveUserIds, dPeriod, dNow));
      var plRolesRes = await supabaseDbRequest('career_roles', 'select=id,title,practice_name,location_label');
      var plAllRoles = (plRolesRes.ok && Array.isArray(plRolesRes.data)) ? plRolesRes.data : [];
      var plRoleById = {};
      for (var pri = 0; pri < plAllRoles.length; pri++) plRoleById[plAllRoles[pri].id] = plAllRoles[pri];
      var plInterviewsRes = await supabaseDbRequest('career_interviews', 'select=*&status=neq.cancelled');
      var plAllInterviews = (plInterviewsRes.ok && Array.isArray(plInterviewsRes.data)) ? plInterviewsRes.data : [];
      var plInterviewByAppId = {};
      for (var pli = 0; pli < plAllInterviews.length; pli++) { plInterviewByAppId[plAllInterviews[pli].application_id] = plAllInterviews[pli]; }
      var plItems = plAllApps.filter(function(a) { return plWantedIds.has(a.id); }).map(function(a) {
        var role = plRoleById[a.career_role_id] || {};
        var interview = plInterviewByAppId[a.id];
        return {
          application_id: a.id, user_id: a.user_id, gp_name: dGpName(a.user_id), gp_email: dGpEmail(a.user_id),
          role_title: role.title || 'GP Role', practice_name: role.practice_name || a.practice_contact_name || '',
          location: role.location_label || '', status: a.status, practice_submission_status: a.practice_submission_status,
          applied_at: a.applied_at, submitted_to_practice_at: a.submitted_to_practice_at,
          interview_date: interview ? interview.scheduled_at : null, interview_status: interview ? interview.status : null
        };
      });
      sendJson(res, 200, { ok: true, section: 'placements', status: plBucket, items: plItems });
      return;
    }
```

> The `placementAppIds` bucket keys must match the tiles: `applied`, `submitted_to_practice`, `interviewing`, `offers_made`, `secured`. The page sends `status=secured`/`status=interviewing`/etc. — confirm Phase 5 page tiles use these exact keys; for the KPI `Placed` tile the param is `status=secured` (Task 3.5).

- [ ] **Step 7: Run the full ceo-metrics test file (expected PASS).**

```
npx vitest run tests/ceo-metrics.test.js
```
Expected: PASS. The parity tests from Task 3.2 already assert `*Ids` ↔ count equality, which is exactly what these branches now consume.

- [ ] **Step 8: Syntax-check.**

```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: exit 0.

- [ ] **Step 9: Commit.**

```
git add server.js tests/ceo-metrics.test.js && git commit -m "CEO drilldowns: each section reuses lib *Ids helper with same period/filters as its card (#2,#6,#9,#10,#11,#34,#38,#51,#56)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.4: Refactor `GET /api/ceo/trends` to reuse shared status sets + a per-week bucket helper, and fix placements_secured (#18,#42,#43,#63)

**Files:** `server.js` (37051-37109), `tests/ceo-metrics.test.js`

- [ ] **Step 1: Replace the local `trSECURED` set with the lib's `isSecuredStatus`, fetch secured apps by the bucketing field (#18), dedupe placements by user_id per week (#42), and raise/remove the silent caps with deterministic ordering (#63).**

old (37062-37068, the fetch block):
```javascript
    var [trCasesRes, trTasksRes, trTicketsRes, trAppsRes, trTimelineRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=created_at&created_at=gte.' + twelveWeeksAgo),
      supabaseDbRequest('registration_tasks', 'select=created_at,completed_at,status&or=(created_at.gte.' + twelveWeeksAgo + ',completed_at.gte.' + twelveWeeksAgo + ')&limit=2000'),
      supabaseDbRequest('support_tickets', 'select=created_at,resolved_at&or=(created_at.gte.' + twelveWeeksAgo + ',resolved_at.gte.' + twelveWeeksAgo + ')&limit=1000'),
      supabaseDbRequest('gp_applications', 'select=applied_at,status,updated_at&applied_at=gte.' + twelveWeeksAgo),
      supabaseDbRequest('task_timeline', 'select=created_at&event_type=eq.stage_change&created_at=gte.' + twelveWeeksAgo)
    ]);
```
new:
```javascript
    var [trCasesRes, trTasksRes, trTicketsRes, trAppsRes, trTimelineRes, trCompleteRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=created_at&created_at=gte.' + twelveWeeksAgo + '&order=created_at.desc&limit=5000'),
      supabaseDbRequest('registration_tasks', 'select=created_at,completed_at,status&or=(created_at.gte.' + twelveWeeksAgo + ',completed_at.gte.' + twelveWeeksAgo + ')&order=created_at.desc&limit=10000'),
      supabaseDbRequest('support_tickets', 'select=created_at,resolved_at&or=(created_at.gte.' + twelveWeeksAgo + ',resolved_at.gte.' + twelveWeeksAgo + ')&order=created_at.desc&limit=5000'),
      // Secured apps must be fetched by the bucketing field (updated_at), not applied_at (#18)
      supabaseDbRequest('gp_applications', 'select=user_id,applied_at,status,updated_at&or=(applied_at.gte.' + twelveWeeksAgo + ',updated_at.gte.' + twelveWeeksAgo + ')&order=updated_at.desc&limit=10000'),
      supabaseDbRequest('task_timeline', 'select=created_at&event_type=eq.stage_change&created_at=gte.' + twelveWeeksAgo + '&order=created_at.desc&limit=10000'),
      // Real weekly completions series for the 'Completed' KPI trend (#16/#25 — page-side remap is Phase 5)
      supabaseDbRequest('registration_cases', 'select=completed_at&stage=eq.complete&completed_at=gte.' + twelveWeeksAgo + '&order=completed_at.desc&limit=5000')
    ]);
```

- [ ] **Step 2: Add `trComplete` parse + per-week `completions_done` field, and rewrite the secured/applied bucketing to use `isSecuredStatus` + per-week user_id dedup.**

old (37070-37074, the parse block):
```javascript
    var trCases = (trCasesRes.ok && Array.isArray(trCasesRes.data)) ? trCasesRes.data : [];
    var trTasks = (trTasksRes.ok && Array.isArray(trTasksRes.data)) ? trTasksRes.data : [];
    var trTickets = (trTicketsRes.ok && Array.isArray(trTicketsRes.data)) ? trTicketsRes.data : [];
    var trApps = (trAppsRes.ok && Array.isArray(trAppsRes.data)) ? trAppsRes.data : [];
    var trTimeline = (trTimelineRes.ok && Array.isArray(trTimelineRes.data)) ? trTimelineRes.data : [];
```
new:
```javascript
    var trCases = (trCasesRes.ok && Array.isArray(trCasesRes.data)) ? trCasesRes.data : [];
    var trTasks = (trTasksRes.ok && Array.isArray(trTasksRes.data)) ? trTasksRes.data : [];
    var trTickets = (trTicketsRes.ok && Array.isArray(trTicketsRes.data)) ? trTicketsRes.data : [];
    var trApps = (trAppsRes.ok && Array.isArray(trAppsRes.data)) ? trAppsRes.data : [];
    var trTimeline = (trTimelineRes.ok && Array.isArray(trTimelineRes.data)) ? trTimelineRes.data : [];
    var trComplete = (trCompleteRes.ok && Array.isArray(trCompleteRes.data)) ? trCompleteRes.data : [];
```

- [ ] **Step 3: Add `completions_done` to the per-week template and a per-week dedup Set for placements.**

old (37085-37089, the weeks init):
```javascript
    var trSECURED = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
    var weeks = {};
    for (var wi = 0; wi < 12; wi++) {
      var ws = getWeekStart(new Date(tNow - wi * tWEEK_MS).toISOString());
      weeks[ws] = { week_start: ws, new_gps: 0, tasks_completed: 0, tasks_created: 0, stage_transitions: 0, tickets_opened: 0, tickets_resolved: 0, applications_submitted: 0, placements_secured: 0 };
    }
```
new:
```javascript
    var weeks = {};
    var securedUserIdsByWeek = {}; // week_start -> Set(user_id) to dedupe placements (#42)
    for (var wi = 0; wi < 12; wi++) {
      var ws = getWeekStart(new Date(tNow - wi * tWEEK_MS).toISOString());
      weeks[ws] = { week_start: ws, new_gps: 0, tasks_completed: 0, tasks_created: 0, stage_transitions: 0, tickets_opened: 0, tickets_resolved: 0, applications_submitted: 0, placements_secured: 0, completions_done: 0 };
      securedUserIdsByWeek[ws] = new Set();
    }
```

- [ ] **Step 4: Rewrite the apps loop (37100-37103) to use `isSecuredStatus` + per-week dedup, and add the completions loop.**

old (37100-37104):
```javascript
    for (var wai = 0; wai < trApps.length; wai++) {
      if (trApps[wai].applied_at) { var wk6 = getWeekStart(trApps[wai].applied_at); if (weeks[wk6]) weeks[wk6].applications_submitted++; }
      if (trSECURED.has((trApps[wai].status || '').toLowerCase()) && trApps[wai].updated_at) { var wk7 = getWeekStart(trApps[wai].updated_at); if (weeks[wk7]) weeks[wk7].placements_secured++; }
    }
    for (var wtli = 0; wtli < trTimeline.length; wtli++) { var wk8 = getWeekStart(trTimeline[wtli].created_at); if (weeks[wk8]) weeks[wk8].stage_transitions++; }
```
new:
```javascript
    for (var wai = 0; wai < trApps.length; wai++) {
      if (trApps[wai].applied_at) { var wk6 = getWeekStart(trApps[wai].applied_at); if (weeks[wk6]) weeks[wk6].applications_submitted++; }
      // Secured bucketed by updated_at (its only timestamp), counted once per GP per week (#18/#42/#43)
      if (ceoMetrics.isSecuredStatus(trApps[wai].status) && trApps[wai].updated_at) {
        var wk7 = getWeekStart(trApps[wai].updated_at);
        if (weeks[wk7] && trApps[wai].user_id && !securedUserIdsByWeek[wk7].has(trApps[wai].user_id)) {
          securedUserIdsByWeek[wk7].add(trApps[wai].user_id);
          weeks[wk7].placements_secured++;
        }
      }
    }
    for (var wtli = 0; wtli < trTimeline.length; wtli++) { var wk8 = getWeekStart(trTimeline[wtli].created_at); if (weeks[wk8]) weeks[wk8].stage_transitions++; }
    // Real completions series so the 'Completed' KPI arrow reflects GPs completing, not placements (#16/#25)
    for (var wcdi = 0; wcdi < trComplete.length; wcdi++) {
      if (trComplete[wcdi].completed_at) { var wk9 = getWeekStart(trComplete[wcdi].completed_at); if (weeks[wk9]) weeks[wk9].completions_done++; }
    }
```

> The page-side `trendMap.completed` remap from `placements_secured` to `completions_done` (#16/#25) is a 1-line page change owned by Phase 5; this task only ships the `completions_done` series the page will point at. Flag to Phase 5: `trendMap.completed: 'completions_done'`.

- [ ] **Step 5: Add a trends-shape test (expected PASS).** Append to `tests/ceo-metrics.test.js` a unit test of the shared bits the trends endpoint reuses — `isSecuredStatus` includes `placed` (#8) and the secured set excludes interview/applied:

```javascript
describe('trends shared status helpers', () => {
  it('isSecuredStatus includes placed (Zoho stage) and the legacy secured set', () => {
    ['hired','secured','placed','placement_secured','offer_accepted','contract_signed'].forEach(function(s) {
      expect(M.isSecuredStatus(s), s).toBe(true);
    });
    ['applied','interview','offer','rejected','withdrawn'].forEach(function(s) {
      expect(M.isSecuredStatus(s), s).toBe(false);
    });
  });
});
```

```
npx vitest run tests/ceo-metrics.test.js -t "trends shared status helpers"
```
Expected: PASS.

- [ ] **Step 6: Syntax-check.**

```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: exit 0.

- [ ] **Step 7: Commit.**

```
git add server.js tests/ceo-metrics.test.js && git commit -m "CEO trends: use isSecuredStatus, bucket secured by updated_at, dedupe per GP/week, add completions_done series, raise caps (#16,#18,#42,#43,#63)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.5: Add server-side drilldown support for clickable KPI tiles (#24)

**Files:** `server.js` (drilldown branch dispatch, ~36869-37049), `tests/ceo-metrics.test.js`

The KPI tiles (`Total GPs`, `Placed`, `Open Tasks`, `Overdue`, `Blocked`, `Completed`) currently have no drilldown wiring. The page (Phase 5) will add `data-drilldown`/`data-param` to each tile mapping to a server section. Server must accept those section+param combos and return rows that exactly equal the KPI. This task ensures every tile maps to a working section.

- [ ] **Step 1: Confirm/extend the tile→section map is fully served.** The mapping (page-side, Phase 5) is:

| Tile | section | param |
|---|---|---|
| Total GPs | `pipeline` | `stage=__all__` |
| Placed | `placements` | `status=secured` |
| Open Tasks | `tasks` | `status=all_open` |
| Overdue | `tasks` | `status=overdue` |
| Blocked | `blockers` | (none) |
| Completed | `completions` | (none) |

`placements?status=secured`, `tasks?status=overdue`, `tasks?status=all_open`, `blockers`, `completions` are already handled after Tasks 3.3. Only `Total GPs` needs a new `pipeline` stage value `__all__` (every active case). Add it to the `pipeline` branch.

In the `pipeline` branch from Task 3.3, change the `barIds` line to handle `__all__`:

old:
```javascript
      var barIds = new Set(ceoMetrics.pipelineCaseIds(dActiveCases, stage, { cumulative: isCumulativeDd }));
      var dCases = dActiveCases.filter(function(c) { return barIds.has(c.id); });
```
new:
```javascript
      var dCases;
      if (stage === '__all__') {
        // Total GPs tile (#24): every active case, count == kpi.total_gps
        dCases = dActiveCases.slice();
      } else {
        var barIds = new Set(ceoMetrics.pipelineCaseIds(dActiveCases, stage, { cumulative: isCumulativeDd }));
        dCases = dActiveCases.filter(function(c) { return barIds.has(c.id); });
      }
```

- [ ] **Step 2: Make `completions` drilldown reconcile with the `completed_gps` KPI / `completions.total` (all-time, #15).** The current `completions` branch (36976-36988) applies `dFilterCases` (period + 6-month cut), which contradicts the all-time KPI. Replace its filter so it returns ALL non-withdrawn complete cases (matching `computeCompletions` `total`).

old:
```javascript
    if (section === 'completions') {
      var compCasesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=eq.complete&order=completed_at.desc.nullslast,updated_at.desc');
      var compCases = dFilterCases((compCasesRes.ok && Array.isArray(compCasesRes.data)) ? compCasesRes.data : []);
```
new:
```javascript
    if (section === 'completions') {
      var compCasesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=eq.complete&order=completed_at.desc.nullslast,updated_at.desc');
      // All-time completions (excl. withdrawn only) so the list == completed_gps KPI / completions.total (#15)
      var compCases = ((compCasesRes.ok && Array.isArray(compCasesRes.data)) ? compCasesRes.data : []).filter(function(c) { return c.status !== 'withdrawn'; });
```

- [ ] **Step 3: Verify `blockers` drilldown matches `kpi.blocked_cases`.** The blockers KPI counts `c.status === 'blocked' || c.blocker_status` over the active set. The drilldown query (36895) is `or=(status.eq.blocked,blocker_status.not.is.null)` then `dFilterCases`. To match the dashboard (which uses the same active `cases`), keep `dFilterCases` but confirm it excludes the period window for the `blocked` KPI parity — the KPI `blocked_cases` is computed over the SAME period-filtered `cases`, so `dFilterCases` (which honours period) is correct here. No code change; add a comment for clarity:

old:
```javascript
      var bCases = dFilterCases((bCasesRes.ok && Array.isArray(bCasesRes.data)) ? bCasesRes.data : []);
```
new:
```javascript
      // Same active+period scope as the Blocked KPI (computed over filterActiveCases) (#24)
      var bCases = dFilterCases((bCasesRes.ok && Array.isArray(bCasesRes.data)) ? bCasesRes.data : []);
```
Also rename the drilldown's `days_stuck` field to `days_blocked` to match the card (single field name, #57) — replace the `days_stuck:` line (36901):
```javascript
          days_blocked: ceoMetrics.computeBlockers([c], dNow)[0] ? ceoMetrics.computeBlockers([c], dNow)[0].days_blocked : 0,
```

- [ ] **Step 4: Add a KPI-tile reconciliation test asserting each tile's drilldown population equals its KPI (#24).** Append to `tests/ceo-metrics.test.js`:

```javascript
describe('KPI tile drilldown reconciliation (#24)', () => {
  const NOW = FIXTURE.nowMs;
  const TODAY = new Date(NOW).toISOString().slice(0, 10);
  for (const period of ['current','7d','30d','all']) {
    it('Placed tile === secured placementAppIds unique GPs [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const activeUserIds = M.activeUserIdSet(cases);
      const kpi = M.computeKpis({ cases, allCases: FIXTURE.cases, tasks: FIXTURE.tasks, apps: FIXTURE.apps, careerRoles: FIXTURE.careerRoles, period, nowMs: NOW, todayStr: TODAY, activeUserIds });
      const securedAppIds = M.placementAppIds(FIXTURE.apps, 'secured', activeUserIds, period, NOW);
      const uniqueGps = new Set(FIXTURE.apps.filter(a => securedAppIds.includes(a.id)).map(a => a.user_id));
      expect(uniqueGps.size).toBe(kpi.placed);
    });
    it('Overdue tile === isOverdue tasks on active cases [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const ids = new Set(cases.map(c => c.id));
      const activeUserIds = M.activeUserIdSet(cases);
      const tasks = FIXTURE.tasks.filter(t => ids.has(t.case_id));
      const kpi = M.computeKpis({ cases, allCases: FIXTURE.cases, tasks, apps: FIXTURE.apps, careerRoles: FIXTURE.careerRoles, period, nowMs: NOW, todayStr: TODAY, activeUserIds });
      expect(tasks.filter(t => M.isOverdue(t, TODAY)).length).toBe(kpi.overdue_tasks);
    });
  }
});
```

```
npx vitest run tests/ceo-metrics.test.js -t "KPI tile drilldown reconciliation"
```
Expected: PASS.

- [ ] **Step 5: Run the full file + syntax check.**

```
npx vitest run tests/ceo-metrics.test.js && /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: all tests PASS, syntax check exit 0.

- [ ] **Step 6: Commit.**

```
git add server.js tests/ceo-metrics.test.js && git commit -m "CEO: server-side drilldown support for clickable KPI tiles; completions all-time + blockers days_blocked field (#24,#15,#57)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.6: Final endpoint-to-page response-shape verification (no-regression sweep)

**Files:** `server.js` (read-only verification), `pages/ceo-dashboard.html` (read-only)

- [ ] **Step 1: Confirm the dashboard `sendJson` keys the page consumes are all still present.** Grep the page for each top-level key and confirm the endpoint still returns it.

```
grep -nE "data\.(kpi|escalations|pipeline|blockers|task_health|va_workload|velocity|placements|gp_activity|tickets|completions)" "pages/ceo-dashboard.html"
```
Expected: every key listed appears; cross-check against the `sendJson` at server.js:36830. The refactor preserves all 12 keys.

- [ ] **Step 2: Confirm sub-field reads still resolve.** Grep page for fields the lib renamed and confirm Phase 5 owns the page-side relabels (do NOT change the page in this phase — only document the handoff):

```
grep -nE "days_in_stage|days_blocked|days_stuck|completed_total|resolved_total|recent_milestones|cold_gps" "pages/ceo-dashboard.html"
```
Record which of these the page reads. Handoff to Phase 5 (page) the renames this phase introduced:
  - Blockers card/drilldown: `days_in_stage`/`days_stuck` → **`days_blocked`** (#57).
  - Task Health: `completed_total` is no longer returned by `computeTaskHealth` — if the page reads it, Phase 5 must drop the reference.
  - Tickets: `resolved_total` no longer returned by `computeTicketMetrics` — Phase 5 drops it if read.
  - Trends: page `trendMap.completed` must move to `completions_done` (#16/#25).

- [ ] **Step 3: Run the complete vitest suite to confirm no cross-file regressions.**

```
npm test
```
Expected: PASS (or no NEW failures vs. the pre-phase baseline — capture the baseline first with `npm test 2>&1 | tail -5` before Task 3.1 if unsure).

- [ ] **Step 4: Final syntax check + commit any verification-doc-free state.**

```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: exit 0. No code change expected in this task; if Steps 1-2 surface a missing key the endpoint must still return (e.g. the page hard-depends on `completed_total`), add it back as a passthrough in the relevant lib-consuming block and commit:

```
git add server.js && git commit -m "CEO: preserve response-shape passthroughs the page consumes (no-regression sweep)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: RSO oversight endpoints + reassignment + Gmail transfer

Goal: expose CEO-facing RSO roster/summary endpoints driven by `lib/ceo-metrics.js`, and make RSO reassignment durably set `assigned_rso` in lock-step with the Gmail mailbox owner — triggering the existing transfer machinery and failing loudly when the target RSO has no mailbox.

**Files:**
- Modify `server.js`
  - `/api/admin/rsos` GET handler (server.js:25274-25280) — replace hardcoded `RSO_TEAM` response with `rso_team` table + roster shape
  - PUT `/api/admin/case` allowed-fields + reassignment block (server.js:29574-29729)
  - New endpoints `GET /api/ceo/rsos` and `GET /api/ceo/rso/:id/summary` (insert immediately before `/api/ceo/dashboard` at server.js:36463)
  - `require('./lib/ceo-metrics.js')` import (alongside other lib requires near server.js:105-118)
- Modify `tests/ceo-metrics.test.js` (created by the metrics phase) — add RSO-oversight reconciliation cases (`computeRsoWorkload`/`rsoCaseIds`)
- Test: `tests/ceo-rso.test.js` (Create) — unit tests for the server-side RSO resolution/transfer guard helper

> Dependencies: this phase assumes the migration `20260614120000_ceo_rebuild.sql` (adds `registration_cases.assigned_rso`, the `rso_team` table + seed) is applied by the migration phase, and `lib/ceo-metrics.js` already exports `computeRsoWorkload`, `rsoCaseIds`, `filterActiveCases`, `isOverdue`, `OPEN_TASK_STATUSES`, `activeUserIdSet`. Verify both before starting Task 4.2/4.3:
> `/tmp/node-v20.19.6-darwin-arm64/bin/node -e "var m=require('./lib/ceo-metrics.js'); console.log(typeof m.computeRsoWorkload, typeof m.rsoCaseIds)"` must print `function function`.

---

### Task 4.1: Add server-side RSO resolution helper with mailbox guard (#7, #32, #34 server, #44 server)

Introduce a single, testable helper that resolves an RSO target (uuid or `__unassigned__`), loads the roster row, and asserts the target RSO has a `va_gmail_accounts` mailbox — used by both the reassignment block and the summary endpoint so they never diverge.

**Files:** `server.js`, `tests/ceo-rso.test.js` (Create)

- [ ] **Step 1: Write the failing test first.** Create `tests/ceo-rso.test.js`. The helper is a pure function `resolveRsoReassignmentTarget(rosterRows, vaGmailRows, newRsoId)` that returns `{ ok, error, rso, mailbox }`. It must NOT touch the network — callers pass already-fetched rows.

```js
import { describe, it, expect } from 'vitest';
import { resolveRsoReassignmentTarget } from '../lib/ceo-metrics.js';

var ROSTER = [
  { user_id: 'a1', name: 'Khaleed Mahmoud', email: 'khaleedmahmoud1211@gmail.com', active: true },
  { user_id: 'b2', name: 'Hazel', email: 'hazel@mygplink.com.au', active: true },
  { user_id: 'c3', name: 'Inactive Person', email: 'inactive@x.com', active: false }
];
var MAILBOXES = [
  { user_id: 'b2', email_address: 'hazel@mygplink.com.au', display_name: 'Hazel' }
];

describe('resolveRsoReassignmentTarget', () => {
  it('rejects __unassigned__ (cannot reassign TO unassigned via transfer)', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, '__unassigned__');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unassigned/i);
  });
  it('rejects an RSO not on the roster', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a registered RSO/i);
  });
  it('rejects an RSO with no va_gmail_accounts mailbox (no silent no-op)', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'a1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Gmail mailbox/i);
    expect(r.rso.name).toBe('Khaleed Mahmoud');
  });
  it('resolves an RSO that has a mailbox', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'b2');
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.mailbox.email_address).toBe('hazel@mygplink.com.au');
    expect(r.rso.name).toBe('Hazel');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL** (function not exported yet).
```
npx vitest run tests/ceo-rso.test.js
```
Expected: FAIL — `resolveRsoReassignmentTarget is not a function`.

- [ ] **Step 3: Implement `resolveRsoReassignmentTarget` in `lib/ceo-metrics.js`.** Append this export to `lib/ceo-metrics.js` (the file owned by the metrics phase; this is purely additive). Place it after `rsoCaseIds`.

```js
// Resolve an RSO reassignment target from already-fetched rows. Pure + dependency-free.
// rosterRows: rso_team rows [{user_id,name,email,active,...}]
// vaGmailRows: va_gmail_accounts rows [{user_id,email_address,display_name}]
// Returns { ok, error, rso, mailbox }. ok=false carries a human-readable error
// so the caller can return a clear 4xx instead of silently no-opping (#44).
function resolveRsoReassignmentTarget(rosterRows, vaGmailRows, newRsoId) {
  var roster = Array.isArray(rosterRows) ? rosterRows : [];
  var mailboxes = Array.isArray(vaGmailRows) ? vaGmailRows : [];
  if (!newRsoId || newRsoId === '__unassigned__') {
    return { ok: false, error: 'Cannot reassign to the unassigned bucket.', rso: null, mailbox: null };
  }
  var rso = null;
  for (var i = 0; i < roster.length; i++) {
    if (String(roster[i].user_id) === String(newRsoId)) { rso = roster[i]; break; }
  }
  if (!rso) {
    return { ok: false, error: 'Target is not a registered RSO.', rso: null, mailbox: null };
  }
  var mailbox = null;
  for (var j = 0; j < mailboxes.length; j++) {
    if (String(mailboxes[j].user_id) === String(newRsoId)) { mailbox = mailboxes[j]; break; }
  }
  if (!mailbox) {
    return {
      ok: false,
      error: 'RSO "' + (rso.name || rso.email || newRsoId) + '" has no Gmail mailbox registered. Add a va_gmail_accounts entry before reassigning.',
      rso: rso,
      mailbox: null
    };
  }
  return { ok: true, error: null, rso: rso, mailbox: mailbox };
}
```
Add `resolveRsoReassignmentTarget` to the file's `module.exports` block.

- [ ] **Step 4: Run the test — expect PASS.**
```
npx vitest run tests/ceo-rso.test.js
```
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Syntax check + commit.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check lib/ceo-metrics.js && git add lib/ceo-metrics.js tests/ceo-rso.test.js && git commit -m "Add resolveRsoReassignmentTarget mailbox guard helper (#7,#32,#34,#44)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2: Promote `/api/admin/rsos` to the `rso_team` table and add `GET /api/ceo/rsos` (#22, #32, #33)

Replace the hardcoded `RSO_TEAM` response with the editable `rso_team` table, and expose a CEO roster endpoint with per-RSO workload aggregates from `computeRsoWorkload`.

**Files:** `server.js` (import near :105; `/api/admin/rsos` at :25274-25280; new endpoint before :36463)

- [ ] **Step 1: Import `lib/ceo-metrics.js` in server.js.** Add the require alongside the other lib requires. Exact before→after — insert after the `file-sanitise.js` require at server.js:108:

Before:
```js
const { validateFileUpload } = require('./lib/file-sanitise.js');
```
After:
```js
const { validateFileUpload } = require('./lib/file-sanitise.js');
const ceoMetrics = require('./lib/ceo-metrics.js');
```
(If the metrics/dashboard phase already added this exact line, skip — `grep -n "require('./lib/ceo-metrics" server.js` first; do not add a duplicate.)

- [ ] **Step 2: Add a shared roster loader near the helper functions.** Insert this function immediately before `function requireSuperAdminSession(req, res) {` at server.js:6591. It reads the `rso_team` table and falls back to the in-memory `RSO_TEAM` seed if the table is empty/unavailable, so the endpoint never returns nothing during rollout.

```js
// Load the editable RSO roster from rso_team, seeded from the RSO_TEAM array (#22).
async function loadRsoRoster(opts) {
  var includeInactive = !!(opts && opts.includeInactive);
  var rows = [];
  try {
    var q = 'select=user_id,name,email,phone,active,created_at,updated_at&order=name.asc';
    if (!includeInactive) q += '&active=eq.true';
    var r = await supabaseDbRequest('rso_team', q);
    if (r.ok && Array.isArray(r.data)) rows = r.data;
  } catch (e) {
    console.error('[RSO] roster load failed:', e.message);
  }
  if (rows.length === 0) {
    // Fallback to the seed array so the picker is never empty pre-migration.
    rows = RSO_TEAM.map(function (m) {
      return { user_id: m.user_id, name: m.name, email: m.email, phone: m.phone || '', active: true };
    });
  }
  return rows;
}
```

- [ ] **Step 3: Rewrite `/api/admin/rsos` to use the roster table.** Exact before→after at server.js:25274-25280.

Before:
```js
  // GET /api/admin/rsos — list RSO team members for assignment dropdown
  if (req.method === 'GET' && pathname === '/api/admin/rsos') {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    sendJson(res, 200, { ok: true, rsos: RSO_TEAM });
    return;
  }
```
After:
```js
  // GET /api/admin/rsos — list RSO team members for assignment dropdown (#22)
  if (req.method === 'GET' && pathname === '/api/admin/rsos') {
    const admin = requireAdminSession(req, res);
    if (!admin) return;
    const roster = await loadRsoRoster({ includeInactive: false });
    sendJson(res, 200, { ok: true, rsos: roster });
    return;
  }
```

- [ ] **Step 4: Add `GET /api/ceo/rsos`.** Insert immediately before the `// ════…CEO DASHBOARD ENDPOINTS` comment block at server.js:36463. It loads active cases, open tasks, the roster, and runs `computeRsoWorkload` to attach per-RSO aggregates (case_count, open_tasks, overdue_tasks). Per the contract, attribution decision (#33): `case_count` is cases owned via `assigned_rso`; `open_tasks`/`overdue_tasks` are tasks ON those owned cases (case-owner load) — documented in the response comment so the UI label matches.

```js
  // GET /api/ceo/rsos — roster + per-RSO workload aggregates (#22,#32,#33)
  if (pathname === '/api/ceo/rsos' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    var rsoListCtx = requireSuperAdminSession(req, res);
    if (!rsoListCtx) return;

    var nowMs = Date.now();
    var todayStr = new Date(nowMs).toISOString().slice(0, 10);

    var [rosterRows, rsoCasesRes, rsoTasksRes] = await Promise.all([
      loadRsoRoster({ includeInactive: false }),
      supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc'),
      supabaseDbRequest('registration_tasks', 'select=*&status=in.(' + ceoMetrics.OPEN_TASK_STATUSES.join(',') + ')&limit=2000')
    ]);

    var allCases = (rsoCasesRes.ok && Array.isArray(rsoCasesRes.data)) ? rsoCasesRes.data : [];
    var rsoTasks = (rsoTasksRes.ok && Array.isArray(rsoTasksRes.data)) ? rsoTasksRes.data : [];
    var activeCases = ceoMetrics.filterActiveCases(allCases, { allTime: false });

    // workload: [{rso_id, rso_name, case_count, open_tasks, overdue_tasks}]
    var workload = ceoMetrics.computeRsoWorkload(activeCases, rsoTasks, rosterRows, todayStr);
    var workloadById = {};
    for (var w = 0; w < workload.length; w++) { workloadById[workload[w].rso_id] = workload[w]; }

    var rsos = rosterRows.map(function (r) {
      var stats = workloadById[r.user_id] || { case_count: 0, open_tasks: 0, overdue_tasks: 0 };
      return {
        rso_id: r.user_id,
        rso_name: r.name,
        email: r.email,
        phone: r.phone || '',
        active: r.active !== false,
        case_count: stats.case_count,
        open_tasks: stats.open_tasks,
        overdue_tasks: stats.overdue_tasks
      };
    });

    // Surface the unassigned bucket if computeRsoWorkload produced one (#32).
    var un = workloadById['__unassigned__'];
    if (un && un.case_count > 0) {
      rsos.push({
        rso_id: '__unassigned__',
        rso_name: 'Unassigned',
        email: '',
        phone: '',
        active: true,
        case_count: un.case_count,
        open_tasks: un.open_tasks,
        overdue_tasks: un.overdue_tasks
      });
    }

    sendJson(res, 200, { ok: true, rsos: rsos });
    return;
  }
```

- [ ] **Step 5: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (valid).

- [ ] **Step 6: Add a reconciliation assertion in the metrics tests** to lock the contract `case_count === rsoCaseIds(...).length` invariant. Append to `tests/ceo-metrics.test.js`:

```js
describe('RSO oversight reconciliation', () => {
  it('every RSO row case_count equals rsoCaseIds length (incl. __unassigned__)', () => {
    var active = filterActiveCases(FIXTURE.cases, { allTime: false });
    var roster = FIXTURE.rsoRoster;
    var rows = computeRsoWorkload(active, FIXTURE.tasks, roster, FIXTURE.todayStr);
    rows.forEach(function (row) {
      expect(row.case_count).toBe(rsoCaseIds(active, row.rso_id).length);
    });
  });
});
```
(If the fixture lacks `rsoRoster`/an `assigned_rso`-null case, add a two-RSO roster and at least one null-`assigned_rso` active case to `FIXTURE` so both the named and `__unassigned__` buckets are exercised. Import `computeRsoWorkload, rsoCaseIds` in the test header if not already imported.)

- [ ] **Step 7: Run metrics + RSO tests — expect PASS.**
```
npx vitest run tests/ceo-metrics.test.js -t "RSO oversight reconciliation"
```
Expected: PASS.

- [ ] **Step 8: Commit.**
```
git add server.js tests/ceo-metrics.test.js && git commit -m "Add GET /api/ceo/rsos + rso_team-backed /api/admin/rsos (#22,#32,#33)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.3: Add `GET /api/ceo/rso/:id/summary` (#7, #32, #34)

Return the GPs under one RSO (or the `__unassigned__` bucket) plus task counts, using `rsoCaseIds` so the list exactly matches the `case_count` shown on the roster row.

**Files:** `server.js` (insert immediately after the `/api/ceo/rsos` handler added in Task 4.2)

- [ ] **Step 1: Add the route.** Parse the id from the path (`/api/ceo/rso/<id>/summary`), accept a uuid or the literal `__unassigned__`, scope cases via `filterActiveCases` + `rsoCaseIds`, and join `user_profiles` for display. Task counts use the SAME open-task set and `isOverdue` rule as the roster (so summary totals reconcile with the row).

```js
  // GET /api/ceo/rso/:id/summary — GPs under one RSO + task counts (#7,#32,#34)
  var rsoSummaryMatch = pathname.match(/^\/api\/ceo\/rso\/([^\/]+)\/summary$/);
  if (rsoSummaryMatch && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    var rsoSumCtx = requireSuperAdminSession(req, res);
    if (!rsoSumCtx) return;

    var rsoId = decodeURIComponent(rsoSummaryMatch[1]);
    var nowMs = Date.now();
    var todayStr = new Date(nowMs).toISOString().slice(0, 10);

    var [sumRoster, sumCasesRes, sumTasksRes] = await Promise.all([
      loadRsoRoster({ includeInactive: true }),
      supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc'),
      supabaseDbRequest('registration_tasks', 'select=*&status=in.(' + ceoMetrics.OPEN_TASK_STATUSES.join(',') + ')&limit=2000')
    ]);

    var sumAllCases = (sumCasesRes.ok && Array.isArray(sumCasesRes.data)) ? sumCasesRes.data : [];
    var sumTasks = (sumTasksRes.ok && Array.isArray(sumTasksRes.data)) ? sumTasksRes.data : [];
    var sumActive = ceoMetrics.filterActiveCases(sumAllCases, { allTime: false });

    // RSO meta (null for the unassigned bucket; 404 if a real id isn't on the roster)
    var rsoMeta = null;
    if (rsoId === '__unassigned__') {
      rsoMeta = { rso_id: '__unassigned__', rso_name: 'Unassigned', email: '', phone: '', active: true };
    } else {
      for (var ri = 0; ri < sumRoster.length; ri++) {
        if (String(sumRoster[ri].user_id) === String(rsoId)) {
          rsoMeta = {
            rso_id: sumRoster[ri].user_id, rso_name: sumRoster[ri].name,
            email: sumRoster[ri].email, phone: sumRoster[ri].phone || '',
            active: sumRoster[ri].active !== false
          };
          break;
        }
      }
      if (!rsoMeta) { sendJson(res, 404, { ok: false, message: 'RSO not found.' }); return; }
    }

    var caseIds = ceoMetrics.rsoCaseIds(sumActive, rsoId);
    var caseIdSet = {};
    caseIds.forEach(function (id) { caseIdSet[id] = true; });
    var rsoCases = sumActive.filter(function (c) { return caseIdSet[c.id]; });

    // Profiles for the GPs under this RSO
    var userIds = rsoCases.map(function (c) { return c.user_id; }).filter(Boolean);
    var profileMap = {};
    if (userIds.length > 0) {
      var profRes = await supabaseDbRequest('user_profiles',
        'select=user_id,email,first_name,last_name,phone&user_id=in.(' + userIds.join(',') + ')');
      if (profRes.ok && Array.isArray(profRes.data)) {
        profRes.data.forEach(function (p) { profileMap[p.user_id] = p; });
      }
    }

    var gps = rsoCases.map(function (c) {
      var p = profileMap[c.user_id] || {};
      var nm = [(p.first_name || ''), (p.last_name || '')].join(' ').trim();
      return {
        case_id: c.id,
        user_id: c.user_id,
        name: nm || p.email || 'Unknown',
        email: p.email || '',
        stage: c.stage,
        status: c.status,
        blocker_status: c.blocker_status || null
      };
    });

    // Task counts on these cases (case-owner load, mirroring computeRsoWorkload #33)
    var openCount = 0, overdueCount = 0;
    for (var ti = 0; ti < sumTasks.length; ti++) {
      var t = sumTasks[ti];
      if (!caseIdSet[t.case_id]) continue;
      openCount++;
      if (ceoMetrics.isOverdue(t, todayStr)) overdueCount++;
    }

    sendJson(res, 200, {
      ok: true,
      rso: rsoMeta,
      gps: gps,
      task_counts: { case_count: gps.length, open: openCount, overdue: overdueCount }
    });
    return;
  }
```

- [ ] **Step 2: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output.

- [ ] **Step 3: Reconciliation guard test** — assert summary `task_counts.case_count` would equal the roster `case_count` for the same id, at the pure-function layer. Append to `tests/ceo-metrics.test.js`:

```js
describe('RSO summary reconciles with roster', () => {
  it('rsoCaseIds length == computeRsoWorkload case_count per id', () => {
    var active = filterActiveCases(FIXTURE.cases, { allTime: false });
    var rows = computeRsoWorkload(active, FIXTURE.tasks, FIXTURE.rsoRoster, FIXTURE.todayStr);
    var byId = {};
    rows.forEach(function (r) { byId[r.rso_id] = r.case_count; });
    Object.keys(byId).forEach(function (id) {
      expect(rsoCaseIds(active, id).length).toBe(byId[id]);
    });
  });
});
```

- [ ] **Step 4: Run — expect PASS.**
```
npx vitest run tests/ceo-metrics.test.js -t "RSO summary reconciles with roster"
```
Expected: PASS.

- [ ] **Step 5: Commit.**
```
git add server.js tests/ceo-metrics.test.js && git commit -m "Add GET /api/ceo/rso/:id/summary drilldown (#7,#32,#34)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.4: Wire `assigned_rso` into PUT `/api/admin/case` with lock-step mailbox owner + Gmail transfer + hard guard (#7, #32, #33, #44 server, §C.1)

Add `assigned_rso` to the allowed PUT fields; on an `assigned_rso` change, set the Gmail mailbox owner (`assigned_va`) in lock-step, require the target RSO to have a `va_gmail_accounts` row (else return a clear error and DO NOT patch), and trigger the existing transfer machinery (archive old label, copy threads to new RSO mailbox under `Assigned/Dr X`, rename hello@ label).

**Files:** `server.js` (PUT `/api/admin/case`, server.js:29574-29729)

- [ ] **Step 1: Extend the allowed-fields list.** Exact before→after at server.js:29574.

Before:
```js
    const allowed = ['assigned_va', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date', 'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.last_va_action_at = new Date().toISOString();
```
After:
```js
    const allowed = ['assigned_va', 'assigned_rso', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date', 'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.last_va_action_at = new Date().toISOString();
```

- [ ] **Step 2: Insert the RSO guard + lock-step BEFORE the PATCH runs.** This must run before the `supabaseDbRequest(... PATCH ...)` at server.js:29584, so a bad RSO never writes anything. Exact before→after.

Before (server.js:29577-29584):
```js
    patch.last_va_action_at = new Date().toISOString();
    // Fetch old assigned_va before patching (needed for label reassignment)
    var oldAssignedVa = null;
    if (patch.assigned_va) {
      var oldCaseRes = await supabaseDbRequest('registration_cases', 'select=assigned_va&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      oldAssignedVa = oldCaseRes.ok && oldCaseRes.data && oldCaseRes.data[0] ? oldCaseRes.data[0].assigned_va : null;
    }
    const r = await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
```
After:
```js
    patch.last_va_action_at = new Date().toISOString();

    // ── RSO reassignment: set the Gmail mailbox owner (assigned_va) in lock-step
    //    with assigned_rso, and refuse if the target RSO has no mailbox (#44, §C.1).
    if (Object.prototype.hasOwnProperty.call(patch, 'assigned_rso') && patch.assigned_rso) {
      var rsoRosterRows = await loadRsoRoster({ includeInactive: true });
      var rsoMailRes = await supabaseDbRequest('va_gmail_accounts', 'select=user_id,email_address,display_name');
      var rsoMailRows = (rsoMailRes.ok && Array.isArray(rsoMailRes.data)) ? rsoMailRes.data : [];
      var resolved = ceoMetrics.resolveRsoReassignmentTarget(rsoRosterRows, rsoMailRows, patch.assigned_rso);
      if (!resolved.ok) {
        sendJson(res, 400, { ok: false, message: resolved.error });
        return;
      }
      // Lock-step: the mailbox that owns the Gmail labels follows the RSO.
      patch.assigned_va = resolved.rso.user_id;
    }

    // Fetch old assigned_va before patching (needed for label reassignment)
    var oldAssignedVa = null;
    if (patch.assigned_va) {
      var oldCaseRes = await supabaseDbRequest('registration_cases', 'select=assigned_va&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
      oldAssignedVa = oldCaseRes.ok && oldCaseRes.data && oldCaseRes.data[0] ? oldCaseRes.data[0].assigned_va : null;
    }
    const r = await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(caseId), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
```

> Note: because `patch.assigned_va` is now set in lock-step, the EXISTING Gmail transfer block at server.js:29592-29729 (`if (patch.assigned_va) { … archiveLabelForVA / copy threads / createLabelsForCase / renameGmailLabel(hello@) … }`) runs automatically for RSO reassignments — no duplication. The block already loads `va_gmail_accounts` for the new owner; with the guard above, `vaAcc` is guaranteed present so it no longer hits the silent `throw new Error('skip')` no-op path for RSO-driven reassignments.

- [ ] **Step 3: Tighten the existing "skip" no-op into a logged warning (don't swallow for RSO path).** The existing block at server.js:29608-29611 throws `'skip'` when no mailbox exists. For a pure `assigned_va` write (legacy path) keep the skip; for an `assigned_rso`-driven write the guard already guaranteed a mailbox, so no change is needed there. Add an explicit comment so future maintainers know the guard is upstream. Exact before→after at server.js:29608-29611.

Before:
```js
          if (!vaAcc) {
            console.log('[Gmail Labels] No VA Gmail account registered for user', patch.assigned_va, '— skipping label setup');
            throw new Error('skip');
          }
```
After:
```js
          if (!vaAcc) {
            // RSO-driven reassignments are guarded upstream (resolveRsoReassignmentTarget),
            // so this only fires for legacy direct assigned_va writes with no mailbox.
            console.log('[Gmail Labels] No VA Gmail account registered for user', patch.assigned_va, '— skipping label setup');
            throw new Error('skip');
          }
```

- [ ] **Step 4: Log the reassignment in the case timeline.** The timeline log at server.js:29587-29590 already records changed keys; `assigned_rso` is now in `patch` so it is captured automatically. No code change — confirm by reading server.js:29587-29590 that `changes` derives from `Object.keys(patch)` (it does). Add no new code.

- [ ] **Step 5: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (valid).

- [ ] **Step 6: Guard-path unit test (no network).** The reject-without-mailbox decision is already covered by `tests/ceo-rso.test.js` Task 4.1 (the `'a1'`/no-mailbox case). Add one assertion proving the lock-step value chosen is the resolved RSO's `user_id` (the value the handler writes to `patch.assigned_va`). Append to `tests/ceo-rso.test.js`:

```js
  it('lock-step: resolved RSO user_id is what the handler assigns to the mailbox owner', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'b2');
    expect(r.ok).toBe(true);
    expect(r.rso.user_id).toBe('b2'); // handler sets patch.assigned_va = r.rso.user_id
  });
```

- [ ] **Step 7: Run — expect PASS.**
```
npx vitest run tests/ceo-rso.test.js
```
Expected: PASS — all assertions (incl. the new lock-step one).

- [ ] **Step 8: Full suite smoke (no regressions in metrics).**
```
npx vitest run tests/ceo-metrics.test.js tests/ceo-rso.test.js
```
Expected: PASS.

- [ ] **Step 9: Commit.**
```
git add server.js tests/ceo-rso.test.js && git commit -m "Wire assigned_rso into PUT /api/admin/case: lock-step mailbox owner + Gmail transfer + hard guard (#7,#32,#33,#44)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.5: Manual end-to-end verification of RSO reassignment + transfer (extrapolate end-to-end)

Confirm the full data flow UI → API → DB → Gmail behaves correctly and the failure case returns a clear error rather than silently no-opping. This task is manual/observational — be transparent in findings about what was actually exercised vs. inferred.

**Files:** none (verification only)

- [ ] **Step 1: Confirm the migration prerequisites exist.** Run against the configured Supabase (service key) via `rpc/exec_sql` and report actual output:
```
-- expect column present
SELECT column_name FROM information_schema.columns WHERE table_name='registration_cases' AND column_name='assigned_rso';
-- expect 2 seeded rows
SELECT user_id, name, email FROM rso_team ORDER BY name;
```
Expected: `assigned_rso` row returned; `rso_team` has Khaleed + Hazel. If absent, STOP and report — the migration phase has not run.

- [ ] **Step 2: Verify the guard rejects an RSO without a mailbox.** Khaleed (`2f94f870-…`) has no `va_gmail_accounts` row in seed data (only Hazel `hazel@mygplink.com.au` is monitored). PUT `/api/admin/case?id=<a test case>` with body `{"assigned_rso":"2f94f870-7ab2-4f71-98ad-bf3756ed88db"}` and confirm HTTP 400 with message matching `has no Gmail mailbox registered`, AND that the case row's `assigned_rso`/`assigned_va` are UNCHANGED afterward (query the row). Report the literal response body and the before/after DB values. If testing manually via curl, say so explicitly.

- [ ] **Step 3: Verify a valid reassignment.** PUT the same case with `{"assigned_rso":"7bed5eb8-f03d-40d6-b090-eb006cd02be7"}` (Hazel, who has a mailbox). Confirm HTTP 200, then query the case row: `assigned_rso` AND `assigned_va` both equal `7bed5eb8-…` (lock-step), and `gmail_label_name`/`gmail_label_id` are populated. Check the case timeline (`_logCaseEvent`) recorded a `status_change` event listing `assigned_rso`. Report actual values. Note: the Gmail label/thread copy side-effects depend on live Google API access and the source case having prior labelled threads — state plainly whether label creation was observed in logs or only inferred.

- [ ] **Step 4: Report findings.** Return a concise PASS/FAIL for each of: (a) guard rejects no-mailbox RSO with clear error + no DB mutation, (b) valid reassignment sets `assigned_rso` and `assigned_va` in lock-step, (c) transfer machinery invoked (from server logs `[Gmail Labels]`). Do not fabricate Gmail-side success if it was not observed — if Google API was unavailable in the test environment, say so and mark (c) as "code path reached, external side-effect unverified".

- [ ] **Step 5: No commit** (verification only). If Steps 2–3 surfaced a defect, open a follow-up task rather than papering over it.

---

Findings covered by this phase: **#7** (Tasks 4.1, 4.3, 4.4 — RSO drilldown returns the right cases via `rsoCaseIds`), **#32** (Tasks 4.2, 4.3 — `__unassigned__` bucket surfaced and drillable), **#33** (Tasks 4.2, 4.3 — case-owner attribution documented in both roster and summary), **#34 server** (Tasks 4.2, 4.3 — summary/roster scoped through `filterActiveCases` so counts reconcile), **#44 server** (Tasks 4.1, 4.4 — reassignment validated server-side against the roster + mailbox, clear error instead of silent no-op), plus **§C.1** transfer wiring (Task 4.4).

Files (absolute): `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js`, `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/lib/ceo-metrics.js`, `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/tests/ceo-metrics.test.js`, `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/tests/ceo-rso.test.js`.

---

## Phase 5: Action reliability + server-side metric semantics
Make every CEO/RSO write action actually succeed and record true semantics: fix the Set-Blocker CHECK-constraint failure, stamp blocker start time, persist the real escalator (role marker + escalated_by), deliver CEO notes to the assigned RSO, tie notes to tasks, stamp first-reply time on first reply (not close), log a stage_change event on every stage PATCH, and fetch/dedup escalations independently and safely.

**Files:**
- Create `lib/ceo-actions.js` — pure helpers (`normalizeBlockerPatch`, `isResolutionTimelineEvent`, `humanizeActor`, `ESCALATION_FETCH_LIMIT`).
- Create `tests/ceo-actions.test.js` — vitest unit tests for the pure helpers.
- Create `supabase/migrations/20260614130000_ceo_actions.sql` — additive: `escalated_to`→TEXT role marker, new `escalated_by` column, widen `task_messages.channel`/`direction` for internal CEO notes.
- Modify `pages/ceo-dashboard.html` — blocker modal option (line 1595) + submit (1603-1618); Add Note tie-to-task (1655-1668); script cache buster.
- Modify `pages/admin.html` — escalation send payload (line 5935); `ahpraEscalate` (7867); script cache buster.
- Modify `server.js`:
  - Case PUT blocker handling + `blocker_set_at` (29574-29590)
  - Add-case-note tie-to-task (29886-29899)
  - Task PUT escalation fields (30497-30531) + escalation timeline metadata (30552-30556)
  - Ticket first-reply stamping: remove from close path (31535-31540), add to admin reply path (27145-27164)
  - State-sync bulk stage PATCH stage_change event (31014-31018)
  - AHPRA-reset stage PATCH stage_change event (23892-23895)
  - Dashboard escalations: independent fetch, role-marker `escalated_to`, real `escalated_by`, safe dedup (36474, 36567-36611)
  - CEO escalation respond/resolve: deliver RSO note + clear `escalated_reason` on respond (37111-37143)

---

### Task 5.1: Pure helpers + tests for blocker normalization, escalation dedup, actor humanization (#4, #19, #54, #27)

**Files:** Create `lib/ceo-actions.js`, Create `tests/ceo-actions.test.js`

- [ ] **Step 1: Write the failing test file `tests/ceo-actions.test.js`.**
```js
import { describe, it, expect } from 'vitest';
import {
  normalizeBlockerPatch,
  isResolutionTimelineEvent,
  humanizeActor,
  VALID_BLOCKER_STATUSES,
  ESCALATION_FETCH_LIMIT
} from '../lib/ceo-actions.js';

describe('normalizeBlockerPatch', () => {
  it('maps the legacy "blocked" UI option to status=blocked + blocker_status=null (no CHECK violation)', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'blocked', blocker_reason: 'stuck' });
    expect(p.status).toBe('blocked');
    expect(p.blocker_status).toBe(null);
    expect(p.blocker_reason).toBe('stuck');
    expect('blocker_set_at' in p).toBe(true);
    expect(typeof p.blocker_set_at).toBe('string');
  });
  it('passes through a valid blocker_status and sets status=blocked + blocker_set_at', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'waiting_on_gp', blocker_reason: 'awaiting docs' });
    expect(p.blocker_status).toBe('waiting_on_gp');
    expect(p.status).toBe('blocked');
    expect(typeof p.blocker_set_at).toBe('string');
  });
  it('clearing the blocker sets status=active, blocker_status=null, blocker_set_at=null', () => {
    var p = normalizeBlockerPatch({ blocker_status: null, blocker_reason: '' });
    expect(p.status).toBe('active');
    expect(p.blocker_status).toBe(null);
    expect(p.blocker_set_at).toBe(null);
    expect(p.blocker_reason).toBe(null);
  });
  it('rejects an unknown blocker_status by treating it as a plain blocked flag', () => {
    var p = normalizeBlockerPatch({ blocker_status: 'totally_made_up' });
    expect(p.blocker_status).toBe(null);
    expect(p.status).toBe('blocked');
    expect(VALID_BLOCKER_STATUSES).not.toContain('blocked');
  });
});

describe('isResolutionTimelineEvent', () => {
  it('matches the exact CEO resolve title, not arbitrary reason text', () => {
    expect(isResolutionTimelineEvent({ event_type: 'escalation', title: 'CEO resolved escalation' })).toBe(true);
  });
  it('does NOT treat an open escalation whose reason mentions "resolved" as resolved', () => {
    expect(isResolutionTimelineEvent({ event_type: 'escalation', title: 'Escalated to CEO', detail: 'practice has not resolved the contract' })).toBe(false);
  });
});

describe('humanizeActor', () => {
  it('returns the email when actor is an email', () => {
    expect(humanizeActor('hazel@mygplink.com.au')).toBe('hazel@mygplink.com.au');
  });
  it('falls back to "System" for system actor and "Unknown" for empty', () => {
    expect(humanizeActor('system')).toBe('System');
    expect(humanizeActor('')).toBe('Unknown');
    expect(humanizeActor(null)).toBe('Unknown');
  });
});

describe('ESCALATION_FETCH_LIMIT', () => {
  it('is large enough to not silently drop escalations under load', () => {
    expect(ESCALATION_FETCH_LIMIT).toBeGreaterThanOrEqual(500);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module does not exist yet).**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && npx vitest run tests/ceo-actions.test.js
```
Expected: FAIL — `Failed to resolve import "../lib/ceo-actions.js"`.

- [ ] **Step 3: Create `lib/ceo-actions.js` with the complete pure implementation.**
```js
// Pure, dependency-free helpers for CEO/RSO write actions.
// No DB calls. Callers pass timestamps where needed (nowIso) so logic is testable.

// The ONLY values registration_cases.blocker_status CHECK accepts (besides NULL).
// Mirrors supabase/migrations/20260403000000_registration_cases_tasks.sql:14-15.
var VALID_BLOCKER_STATUSES = ['waiting_on_gp', 'waiting_on_practice', 'waiting_on_external', 'internal_review'];

// Independent fetch cap for escalations so old ones are never sliced out of the
// shared 1000-row open-task list (#53).
var ESCALATION_FETCH_LIMIT = 1000;

// Build a constraint-safe case PATCH from a raw blocker modal payload.
// - A valid blocker_status => status:'blocked', keep blocker_status, stamp blocker_set_at.
// - The legacy "blocked" option (or any non-whitelisted value) => status:'blocked',
//   blocker_status:null (avoids the CHECK violation, #4/#19), still stamp blocker_set_at.
// - Empty/null blocker_status => clear: status:'active', blocker_status:null, blocker_set_at:null.
function normalizeBlockerPatch(body, nowIso) {
  nowIso = nowIso || new Date().toISOString();
  var raw = body && body.blocker_status != null ? String(body.blocker_status) : '';
  var reason = body && typeof body.blocker_reason === 'string' && body.blocker_reason.trim()
    ? body.blocker_reason.trim() : null;
  if (!raw) {
    return { status: 'active', blocker_status: null, blocker_reason: reason, blocker_set_at: null };
  }
  var valid = VALID_BLOCKER_STATUSES.indexOf(raw) > -1;
  return {
    status: 'blocked',
    blocker_status: valid ? raw : null,
    blocker_reason: reason,
    blocker_set_at: nowIso
  };
}

// True only for the canonical CEO resolution event — never by substring-matching free text (#54).
function isResolutionTimelineEvent(ev) {
  if (!ev) return false;
  var title = String(ev.title || '');
  return title === 'CEO resolved escalation';
}

// Human label for a timeline/escalation actor (#27). Real email passes through;
// 'system' => 'System'; empty => 'Unknown'.
function humanizeActor(actor) {
  var a = actor == null ? '' : String(actor).trim();
  if (!a) return 'Unknown';
  if (a.toLowerCase() === 'system') return 'System';
  return a;
}

module.exports = {
  VALID_BLOCKER_STATUSES: VALID_BLOCKER_STATUSES,
  ESCALATION_FETCH_LIMIT: ESCALATION_FETCH_LIMIT,
  normalizeBlockerPatch: normalizeBlockerPatch,
  isResolutionTimelineEvent: isResolutionTimelineEvent,
  humanizeActor: humanizeActor
};
```
Note: tests import via ESM named imports; vitest resolves CommonJS `module.exports` named bindings. If the repo's vitest config rejects this interop, change the test import to `import pkg from '../lib/ceo-actions.js'; const { ... } = pkg;` — verify in Step 4 and adjust only if it fails.

- [ ] **Step 4: Run the test — expect PASS.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && npx vitest run tests/ceo-actions.test.js
```
Expected: PASS — all assertions green. If the named-import interop fails, apply the default-import fallback noted in Step 3 and re-run until green.

- [ ] **Step 5: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/lib/ceo-actions.js"
```
Expected: no output (exit 0).

- [ ] **Step 6: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add lib/ceo-actions.js tests/ceo-actions.test.js && git commit -m "Phase 5: pure CEO-action helpers + tests (#4 #19 #27 #54)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.2: Migration — escalated_to as TEXT role marker, escalated_by column, internal task-message channel (#26, #27, #55)

**Files:** Create `supabase/migrations/20260614130000_ceo_actions.sql`

- [ ] **Step 1: Create the additive migration `supabase/migrations/20260614130000_ceo_actions.sql`.**
The current `escalated_to` is `UUID REFERENCES auth.users(id)` (20260511010000_ceo_dashboard.sql:14) and the partial index keys on it. We convert it to a TEXT role marker, drop the dead index, add `escalated_by`, and widen `task_messages` so a CEO note can be stored as an internal thread message visible to the assigned RSO.
```sql
-- Phase 5: CEO action reliability + escalation semantics

-- 1. escalated_to becomes a TEXT role marker (e.g. 'CEO'), not a UUID FK (#26).
--    Drop the partial index that referenced it as UUID, then convert.
DROP INDEX IF EXISTS idx_reg_tasks_escalated;
ALTER TABLE registration_tasks
  ALTER COLUMN escalated_to TYPE text USING NULLIF(escalated_to::text, '');

-- 2. Record the REAL escalator (#27). NULL = unknown / pre-existing rows.
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS escalated_by text,
  ADD COLUMN IF NOT EXISTS blocker_set_at timestamptz;

-- 3. Recreate the escalation lookup index on the live shape.
CREATE INDEX IF NOT EXISTS idx_reg_tasks_escalated
  ON registration_tasks (status, escalated_at DESC)
  WHERE status = 'escalated';

-- 4. Allow an internal CEO note to be stored on the task conversation thread (#55).
--    task_messages.channel was CHECK IN ('email','whatsapp'); direction IN ('inbound','outbound').
ALTER TABLE task_messages DROP CONSTRAINT IF EXISTS task_messages_channel_check;
ALTER TABLE task_messages ADD CONSTRAINT task_messages_channel_check
  CHECK (channel IN ('email', 'whatsapp', 'internal'));
ALTER TABLE task_messages DROP CONSTRAINT IF EXISTS task_messages_direction_check;
ALTER TABLE task_messages ADD CONSTRAINT task_messages_direction_check
  CHECK (direction IN ('inbound', 'outbound', 'internal'));
```
Note: `blocker_set_at` on `registration_cases` is added by the contract's `20260614120000_ceo_rebuild.sql` (W1). The `ADD COLUMN IF NOT EXISTS ... blocker_set_at` line above is on `registration_tasks` — distinct table, distinct column, no collision. The case-level `blocker_set_at` is consumed here but created by the earlier migration; both are idempotent.

- [ ] **Step 2: Apply the migration via Supabase `rpc/exec_sql` with the service key** (per memory `supabase-migrations-exec-sql`; schema-qualify if needed). Run the file contents through `exec_sql`. Verify success by querying `information_schema.columns` for `registration_tasks.escalated_by` and `escalated_to` (data_type=`text`), and that `task_messages_channel_check` now permits `internal`.
Expected: `escalated_to` data_type is `text`; `escalated_by` and `registration_tasks.blocker_set_at` exist; inserting a `task_messages` row with `channel='internal', direction='internal'` succeeds.

- [ ] **Step 3: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add supabase/migrations/20260614130000_ceo_actions.sql && git commit -m "Phase 5: migration — escalated_to TEXT role marker, escalated_by, internal task-message channel (#26 #27 #55)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.3: Fix Set-Blocker CHECK violation + stamp blocker_set_at on the case PUT handler (#4, #19, #5)

**Files:** Modify `server.js` (29574-29590), Modify `pages/ceo-dashboard.html` (1595, 1603-1618)

- [ ] **Step 1: Import the helper at the top of `server.js` near other lib requires.** Confirm the exact require style by grepping existing requires (`grep -n "require('./lib/" server.js`), then add this line adjacent to them:
```js
var ceoActions = require('./lib/ceo-actions');
```

- [ ] **Step 2: In the `/api/admin/case` PUT handler, normalize blocker fields before patching.** Current code (server.js:29574-29577):
```js
    const allowed = ['assigned_va', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date', 'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    patch.last_va_action_at = new Date().toISOString();
```
Replace with:
```js
    const allowed = ['assigned_va', 'status', 'blocker_status', 'blocker_reason', 'next_followup_date', 'practice_name', 'practice_contact', 'handover_notes', 'gp_verified_stage'];
    const patch = {};
    for (const key of allowed) { if (body && body[key] !== undefined) patch[key] = body[key]; }
    // Blocker handling: map UI payload to a CHECK-safe patch and stamp blocker_set_at (#4/#19/#5).
    if (body && body.blocker_status !== undefined) {
      var blockerPatch = ceoActions.normalizeBlockerPatch(body, new Date().toISOString());
      patch.status = blockerPatch.status;
      patch.blocker_status = blockerPatch.blocker_status;
      patch.blocker_reason = blockerPatch.blocker_reason;
      patch.blocker_set_at = blockerPatch.blocker_set_at;
    }
    patch.last_va_action_at = new Date().toISOString();
```
This overrides any raw `status`/`blocker_status`/`blocker_reason` the client sent when a blocker change is present, so the legacy `blocker_status:'blocked'` payload becomes `status:'blocked', blocker_status:null`.

- [ ] **Step 3: Remove the now-invalid "Blocked" option and let the modal send the raw status string** in `pages/ceo-dashboard.html`. Change line 1595:
```html
      html += '<option value="blocked">Blocked</option>';
```
to:
```html
      html += '<option value="internal_review">Internal Review</option>';
```
This replaces the constraint-violating option with the fourth valid `blocker_status`, so the picker now exposes all four legal statuses plus "Clear Blocker".

- [ ] **Step 4: Simplify `submitBlocker` to rely on the server normalization** in `pages/ceo-dashboard.html` (lines 1603-1618). Current:
```js
    function submitBlocker(caseId) {
      var status = document.getElementById('mBlockerStatus').value;
      var reason = document.getElementById('mBlockerReason').value.trim();
      var btn = document.getElementById('mBlockerSubmit');
      btn.disabled = true;
      var body = { blocker_status: status || null, blocker_reason: reason || null };
      if (!status) body.status = 'active';
      else body.status = 'blocked';
      apiFetch('/api/admin/case?id=' + encodeURIComponent(caseId), {
```
Replace with:
```js
    function submitBlocker(caseId) {
      var status = document.getElementById('mBlockerStatus').value;
      var reason = document.getElementById('mBlockerReason').value.trim();
      var btn = document.getElementById('mBlockerSubmit');
      btn.disabled = true;
      // Server normalizes blocker_status -> CHECK-safe status + blocker_set_at (#4/#19/#5).
      var body = { blocker_status: status || null, blocker_reason: reason || null };
      apiFetch('/api/admin/case?id=' + encodeURIComponent(caseId), {
```

- [ ] **Step 5: Bump the cache buster** on the ceo-dashboard script/style tag affected. Grep the page for the current versioned tag (`grep -n "ceo-dashboard" pages/ceo-dashboard.html` and any `?v=` on its own inline-loaded assets); if the page loads JS inline (single file), bump the page's own referenced asset cache buster to `?v=20260614a`. If no external versioned asset exists, add `<!-- v=20260614a -->` is NOT acceptable — instead confirm there is nothing to bump and note it. (Verify: `grep -n "?v=" pages/ceo-dashboard.html`.)

- [ ] **Step 6: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0, no output.

- [ ] **Step 7: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js pages/ceo-dashboard.html && git commit -m "Phase 5: Set Blocker no longer violates CHECK + stamps blocker_set_at (#4 #19 #5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.4: Persist the real escalator — escalated_to role marker + escalated_by (#26, #27)

**Files:** Modify `server.js` (30497-30531, 30552-30556), Modify `pages/admin.html` (5935, 7867)

- [ ] **Step 1: Accept a TEXT `escalated_to` role marker and persist `escalated_by` in the task PUT handler.** Current code (server.js:30497, 30505-30515):
```js
    const allowed = ['status', 'priority', 'assignee', 'due_date', 'blocker_reason', 'description', 'escalated_to', 'escalated_reason', 'escalated_at'];
```
Change the allowed list to add `escalated_by`:
```js
    const allowed = ['status', 'priority', 'assignee', 'due_date', 'blocker_reason', 'description', 'escalated_to', 'escalated_reason', 'escalated_at', 'escalated_by'];
```
Then replace the escalation-field separation block (server.js:30505-30515):
```js
    var isEscalating = (patch.status === 'escalated');
    var escalationReason = patch.escalated_reason || null;
    var escalationFields = {};
    // escalated_to is UUID FK — only include if it looks like a valid UUID, skip plain strings like "CEO"
    if (patch.escalated_to !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patch.escalated_to)) {
      escalationFields.escalated_to = patch.escalated_to;
    }
    if (patch.escalated_reason !== undefined) escalationFields.escalated_reason = patch.escalated_reason;
    if (patch.escalated_at !== undefined) escalationFields.escalated_at = patch.escalated_at;
    else if (isEscalating) escalationFields.escalated_at = new Date().toISOString();
    delete patch.escalated_to; delete patch.escalated_reason; delete patch.escalated_at;
```
with (escalated_to is now a TEXT role marker, and escalated_by always records the acting admin):
```js
    var isEscalating = (patch.status === 'escalated');
    var escalationReason = patch.escalated_reason || null;
    var escalationFields = {};
    // escalated_to is now a TEXT role marker (e.g. 'CEO'), not a UUID (#26).
    if (patch.escalated_to !== undefined && patch.escalated_to !== null && String(patch.escalated_to).trim()) {
      escalationFields.escalated_to = String(patch.escalated_to).trim().slice(0, 64);
    }
    if (patch.escalated_reason !== undefined) escalationFields.escalated_reason = patch.escalated_reason;
    if (patch.escalated_at !== undefined) escalationFields.escalated_at = patch.escalated_at;
    else if (isEscalating) escalationFields.escalated_at = new Date().toISOString();
    // Record the REAL escalator from the session, not a hardcoded value (#27).
    if (isEscalating) escalationFields.escalated_by = adminCtx.email;
    else if (patch.escalated_by !== undefined) escalationFields.escalated_by = patch.escalated_by;
    delete patch.escalated_to; delete patch.escalated_reason; delete patch.escalated_at; delete patch.escalated_by;
```

- [ ] **Step 2: Stamp the real actor into the escalation timeline event** so the pre-migration fallback path also reads the right person. Current (server.js:30554-30556):
```js
      var evTitle = isEscalating ? 'Escalated to CEO' : 'Task updated: ' + Object.keys(patch).join(', ');
      var evDetail = isEscalating ? (escalationReason || 'No reason provided') : JSON.stringify(patch);
      await _logCaseEvent(updated.case_id, taskId, evType, evTitle, evDetail, adminCtx.email);
```
The `actor` arg is already `adminCtx.email`, so the timeline fallback (`escalated_by: ev2.actor`) is correct once #27 dashboard read is fixed in Task 5.7. No change needed here beyond confirming `adminCtx.email` is passed (it is). Leave as-is — add a clarifying comment only:
```js
      var evTitle = isEscalating ? 'Escalated to CEO' : 'Task updated: ' + Object.keys(patch).join(', ');
      var evDetail = isEscalating ? (escalationReason || 'No reason provided') : JSON.stringify(patch);
      // actor is the real escalator; dashboard reads escalated_by from the column, fallback from this actor (#27).
      await _logCaseEvent(updated.case_id, taskId, evType, evTitle, evDetail, adminCtx.email);
```

- [ ] **Step 3: Confirm `escalated_by` not lost when escalation columns PATCH is separate.** The existing line (server.js:30531) already PATCHes the whole `escalationFields` object separately and catches errors; since `escalated_by` is now in `escalationFields`, no further change. Verify by reading the line after edit.

- [ ] **Step 4: Keep the admin.html escalation payload as a role marker** (now valid TEXT). In `pages/admin.html` line 5935 the payload sends `escalated_to:"CEO"` — this is now correct (TEXT role marker), so leave the value but no longer need a UUID. No change required to the value. Confirm the line still reads `escalated_to:"CEO"` and add nothing. (This documents #26 is satisfied by the column type change, not by dropping the field.)

- [ ] **Step 5: Bump cache buster** on the admin.html script asset that contains this handler. `grep -n "?v=20" pages/admin.html | head` to find the inline/loaded JS version tag and bump it to `?v=20260614a` (single occurrence on the page's own primary script include, if present).

- [ ] **Step 6: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 7: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js pages/admin.html && git commit -m "Phase 5: persist real escalator — escalated_to role marker + escalated_by (#26 #27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.5: Add Note ties to the task when taskId present; remove dead no-op branch (#64)

**Files:** Modify `server.js` (29886-29899), Modify `pages/ceo-dashboard.html` (1655-1668)

- [ ] **Step 1: Route the note to the task endpoint when `taskId` is present** in `pages/ceo-dashboard.html`. Current `submitNote` (lines 1655-1668):
```js
    function submitNote(caseId, taskId) {
      var text = document.getElementById('mNoteText').value.trim();
      if (!text) { showToast('Note text required', 'error'); return; }
      var btn = document.getElementById('mNoteSubmit');
      btn.disabled = true;
      var url = '/api/admin/case/note?id=' + encodeURIComponent(caseId);
      if (taskId) url = '/api/admin/case/note?id=' + encodeURIComponent(caseId);
      apiFetch(url, {
        method: 'POST',
        body: { text: text }
      }).then(function(d) {
        if (d.ok) { showToast('Note added', 'success'); closeModal(); }
        else { showToast('Failed: ' + (d.message || ''), 'error'); btn.disabled = false; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; });
    }
```
Replace with (drop the duplicate no-op if/else; post to the task endpoint when taskId is present):
```js
    function submitNote(caseId, taskId) {
      var text = document.getElementById('mNoteText').value.trim();
      if (!text) { showToast('Note text required', 'error'); return; }
      var btn = document.getElementById('mNoteSubmit');
      btn.disabled = true;
      // Tie the note to the task when a taskId is supplied; otherwise file it on the case (#64).
      var url = taskId
        ? '/api/admin/task/note?id=' + encodeURIComponent(taskId)
        : '/api/admin/case/note?id=' + encodeURIComponent(caseId);
      apiFetch(url, {
        method: 'POST',
        body: { text: text }
      }).then(function(d) {
        if (d.ok) { showToast('Note added', 'success'); closeModal(); }
        else { showToast('Failed: ' + (d.message || ''), 'error'); btn.disabled = false; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; });
    }
```
The existing `/api/admin/task/note` endpoint (server.js:30564-30580) already logs `_logCaseEvent(caseId, taskId, 'note', ...)` with the task id, so no server change is required for task-tied notes. No change to `/api/admin/case/note` either.

- [ ] **Step 2: Bump cache buster** on the ceo-dashboard script asset to `?v=20260614a` (same asset as Task 5.3 Step 5; if already bumped, skip).

- [ ] **Step 3: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add pages/ceo-dashboard.html && git commit -m "Phase 5: Add Note ties to the task when taskId present (#64)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.6: "Add Note & Return" delivers an actionable RSO message + clears escalated_reason (#55)

**Files:** Modify `server.js` (37111-37143)

- [ ] **Step 1: On respond, clear `escalated_reason` AND write the CEO note as an internal task message to the assigned RSO.** Current CEO escalation respond/resolve handler (server.js:37127-37143):
```js
    var escTaskRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,escalated_to,status&id=eq.' + encodeURIComponent(escTaskId) + '&limit=1');
    var escTask = (escTaskRes.ok && Array.isArray(escTaskRes.data) && escTaskRes.data[0]) ? escTaskRes.data[0] : null;
    if (!escTask) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    if (escTask.status !== 'escalated') { sendJson(res, 400, { ok: false, message: 'Task is not escalated.' }); return; }

    var escPatch = { status: 'open', escalated_to: null, escalated_at: null };
    if (escAction === 'resolve') { escPatch.escalated_reason = null; }

    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(escTaskId), { method: 'PATCH', body: escPatch });

    var escEvTitle = escAction === 'resolve' ? 'CEO resolved escalation' : 'CEO response';
    await _logCaseEvent(escTask.case_id, escTaskId, escAction === 'resolve' ? 'escalation' : 'note', escEvTitle, escNote || null, ceoCtx.email);

    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(escTask.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });

    sendJson(res, 200, { ok: true, action: escAction, task_id: escTaskId });
    return;
```
Replace with (clear `escalated_reason` on BOTH paths, push an internal RSO-visible task message on respond):
```js
    var escTaskRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,escalated_to,status,title&id=eq.' + encodeURIComponent(escTaskId) + '&limit=1');
    var escTask = (escTaskRes.ok && Array.isArray(escTaskRes.data) && escTaskRes.data[0]) ? escTaskRes.data[0] : null;
    if (!escTask) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    if (escTask.status !== 'escalated') { sendJson(res, 400, { ok: false, message: 'Task is not escalated.' }); return; }

    // Resolve the assigned RSO (mailbox owner) so the note is delivered to them (#55).
    var escCaseRes = await supabaseDbRequest('registration_cases', 'select=assigned_va,assigned_rso&id=eq.' + encodeURIComponent(escTask.case_id) + '&limit=1');
    var escCaseRow = (escCaseRes.ok && Array.isArray(escCaseRes.data) && escCaseRes.data[0]) ? escCaseRes.data[0] : {};
    var escRsoId = escCaseRow.assigned_va || escCaseRow.assigned_rso || null;
    var escRsoEmail = '';
    if (escRsoId) {
      var escRsoAccRes = await supabaseDbRequest('va_gmail_accounts', 'select=email_address&user_id=eq.' + encodeURIComponent(escRsoId) + '&limit=1');
      escRsoEmail = (escRsoAccRes.ok && Array.isArray(escRsoAccRes.data) && escRsoAccRes.data[0]) ? (escRsoAccRes.data[0].email_address || '') : '';
    }

    // Clear escalated_reason on BOTH respond and resolve so a returned task carries no stale reason (#55).
    var escPatch = { status: 'open', escalated_to: null, escalated_at: null, escalated_by: null, escalated_reason: null };

    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(escTaskId), { method: 'PATCH', body: escPatch });

    var escEvTitle = escAction === 'resolve' ? 'CEO resolved escalation' : 'CEO response';
    await _logCaseEvent(escTask.case_id, escTaskId, escAction === 'resolve' ? 'escalation' : 'note', escEvTitle, escNote || null, ceoCtx.email);

    // On respond, surface the CEO note as an actionable internal message on the task thread the RSO sees (#55).
    if (escAction === 'respond' && escNote) {
      try {
        await supabaseDbRequest('task_messages', '', {
          method: 'POST',
          body: [{
            task_id: escTaskId,
            case_id: escTask.case_id,
            direction: 'internal',
            channel: 'internal',
            sender: ceoCtx.email,
            recipient: escRsoEmail || null,
            subject: 'CEO response — action required: ' + (escTask.title || 'Escalation'),
            body_text: escNote
          }]
        });
      } catch (msgErr) {
        console.error('[CEO escalation respond] task_messages insert failed:', msgErr.message);
      }
    }

    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(escTask.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });

    sendJson(res, 200, { ok: true, action: escAction, task_id: escTaskId, delivered_to: escRsoEmail || null });
    return;
```
Note: `escalated_by: null` is included so a returned task does not keep a stale escalator; the column exists after Task 5.2. The internal `task_messages` row depends on the widened CHECK constraints from Task 5.2 — so Task 5.2 must be applied before this ships.

- [ ] **Step 2: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 3: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "Phase 5: Add Note & Return delivers RSO message + clears escalated_reason (#55)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.7: Dashboard escalations — independent fetch, real escalated_by, exact-title dedup (#53, #54, #27)

**Files:** Modify `server.js` (36474 area, 36567-36611)

- [ ] **Step 1: Fetch escalations independently of the capped 1000-row open-task list (#53).** The dashboard currently derives escalations by filtering the shared `tasks` array fetched with `limit=1000` (server.js:36474, consumed at 36572). Just before the escalations block (server.js:36567, before `var allCaseMap = {};`), add a dedicated fetch:
```js
    // Fetch escalations independently so old ones are never sliced out of the capped open-task list (#53).
    var escDedicatedRes = await supabaseDbRequest('registration_tasks',
      'select=id,case_id,status,title,escalated_reason,escalated_at,escalated_by,related_stage,priority&status=eq.escalated&order=escalated_at.desc.nullslast&limit=' + ceoActions.ESCALATION_FETCH_LIMIT);
    var escDedicatedTasks = (escDedicatedRes.ok && Array.isArray(escDedicatedRes.data)) ? escDedicatedRes.data : [];
```

- [ ] **Step 2: Build the primary escalation list from the dedicated fetch and read the REAL escalator (#27).** Replace the primary map block (server.js:36571-36581):
```js
    var escalationTaskIds = new Set();
    var escalations = tasks.filter(function(t) { return t.status === 'escalated'; }).map(function(t) {
      escalationTaskIds.add(t.id);
      var c = allCaseMap[t.case_id] || null;
      return {
        task_id: t.id, case_id: t.case_id, user_id: c ? c.user_id : null,
        gp_name: c ? ceoGpName(c.user_id) : 'Unknown', gp_email: c ? ceoGpEmail(c.user_id) : '',
        title: t.title, reason: t.escalated_reason || '', escalated_by: 'VA',
        escalated_at: t.escalated_at, stage: t.related_stage || (c ? c.stage : ''), priority: t.priority
      };
    });
```
with:
```js
    var escalationTaskIds = new Set();
    var escalations = escDedicatedTasks.map(function(t) {
      escalationTaskIds.add(t.id);
      var c = allCaseMap[t.case_id] || null;
      return {
        task_id: t.id, case_id: t.case_id, user_id: c ? c.user_id : null,
        gp_name: c ? ceoGpName(c.user_id) : 'Unknown', gp_email: c ? ceoGpEmail(c.user_id) : '',
        title: t.title, reason: t.escalated_reason || '',
        escalated_by: ceoActions.humanizeActor(t.escalated_by),
        escalated_at: t.escalated_at, stage: t.related_stage || (c ? c.stage : ''), priority: t.priority
      };
    });
```

- [ ] **Step 3: Replace the substring "resolved" dedup with exact-title matching (#54).** Current (server.js:36585-36594):
```js
    // Identify resolved escalations (CEO resolved it — title contains 'resolved')
    var resolvedTaskIds = new Set();
    for (var eti = 0; eti < escTimelineEvents.length; eti++) {
      var ev = escTimelineEvents[eti];
      var evTitle = String(ev.title || '').toLowerCase();
      var evDetail = String(ev.detail || '').toLowerCase();
      if (evTitle.indexOf('resolved') > -1 || evDetail.indexOf('resolved') > -1) {
        resolvedTaskIds.add(ev.task_id);
      }
    }
```
with:
```js
    // Identify resolved escalations by the EXACT CEO resolve event title, not substring on free text (#54).
    var resolvedTaskIds = new Set();
    for (var eti = 0; eti < escTimelineEvents.length; eti++) {
      var ev = escTimelineEvents[eti];
      if (ceoActions.isResolutionTimelineEvent(ev)) { resolvedTaskIds.add(ev.task_id); }
    }
```

- [ ] **Step 4: In the timeline-fallback escalation push, use the humanized actor (#27).** Current (server.js:36608):
```js
        title: escTask.title, reason: ev2.detail || '', escalated_by: ev2.actor || 'VA',
```
Replace with:
```js
        title: escTask.title, reason: ev2.detail || '', escalated_by: ceoActions.humanizeActor(ev2.actor),
```
Note: the fallback loop (36595-36611) iterates `tasks` to find `escTask` — that list is still the capped 1000-row array, but it's only the pre-migration fallback for unresolved timeline events; the authoritative path is now the dedicated fetch. Leave the fallback loop's `for (var eft...)` lookup as-is.

- [ ] **Step 5: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 6: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "Phase 5: escalations fetched independently, real escalated_by, exact-title dedup (#53 #54 #27)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.8: Stamp first_reply_at on the first admin/RSO reply, not at close (#13)

**Files:** Modify `server.js` (27145-27164 reply path, 31535-31540 close path)

- [ ] **Step 1: Remove the first_reply_at stamping from the ticket close/reopen path** (server.js:31535-31540). Current:
```js
    // Set first_reply_at if this is the first admin interaction
    if (updated && !updated.first_reply_at) {
      await supabaseDbRequest('support_tickets', 'id=eq.' + encodeURIComponent(ticketId) + '&first_reply_at=is.null', {
        method: 'PATCH', body: { first_reply_at: new Date().toISOString() }
      });
    }
```
Replace with:
```js
    // first_reply_at is now stamped on the first admin reply (see /api/admin/tickets/:id/reply), NOT at close (#13).
```

- [ ] **Step 2: Stamp first_reply_at on the admin reply path** in `/api/admin/tickets/:id/reply` (server.js:27145-27161). The admin reply currently updates only the legacy JSON via `persistSupportCaseUpdate` and emails the GP. After the successful reply (after line 27154 `if (!updatedTicket)...` guard and before/after the email send), add a stamp on the matching `support_tickets` row (joined by `source_ticket_id`). Current (server.js:27154-27161):
```js
    if (!updatedTicket) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();

    // Send email notification to GP about the reply
    const replyUserId = await getSupabaseUserIdByEmail(candidateEmail);
    if (replyUserId) {
      sendTicketReplyEmail(replyUserId, updatedTicket.title || '').catch(err => console.error('[Email] Ticket reply failed:', err.message));
    }
```
Replace with:
```js
    if (!updatedTicket) { sendJson(res, 404, { ok: false, message: 'Ticket not found.' }); return; }
    invalidateAdminDashboardCache();

    // Stamp first_reply_at on the matching support_tickets row on the FIRST admin reply (#13).
    if (isSupabaseDbConfigured()) {
      try {
        await supabaseDbRequest('support_tickets',
          'source_ticket_id=eq.' + encodeURIComponent(ticketId) + '&first_reply_at=is.null',
          { method: 'PATCH', body: { first_reply_at: now } });
      } catch (frErr) { console.error('[Ticket reply] first_reply_at stamp failed:', frErr.message); }
    }

    // Send email notification to GP about the reply
    const replyUserId = await getSupabaseUserIdByEmail(candidateEmail);
    if (replyUserId) {
      sendTicketReplyEmail(replyUserId, updatedTicket.title || '').catch(err => console.error('[Email] Ticket reply failed:', err.message));
    }
```
`now` is already defined at line 27145 (`const now = new Date().toISOString();`). The PostgREST filter `first_reply_at=is.null` makes the stamp idempotent (only the first reply sets it).

- [ ] **Step 3: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 4: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "Phase 5: stamp first_reply_at on first admin reply, not at close (#13)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.9: Log a stage_change timeline event wherever registration_cases.stage is PATCHed (#35)

**Files:** Modify `server.js` (31014-31018 state-sync bulk; 23892-23895 AHPRA reset)

- [ ] **Step 1: Log a stage_change event in the bulk cases/sync PATCH (#35).** Current (server.js:31014-31018):
```js
      const stage = _deriveStageFromState(state);
      if (stage !== regCase.stage) {
        await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(regCase.id), { method: 'PATCH', body: { stage: stage } });
        updated++;
      }
```
Replace with (mirror the canonical pattern at server.js:8909 — `_logCaseEvent(caseId, null, 'stage_change', title, null, actor, {from_stage,to_stage})`):
```js
      const stage = _deriveStageFromState(state);
      if (stage !== regCase.stage) {
        const stagePatch = { stage: stage };
        if (stage === 'complete') stagePatch.completed_at = new Date().toISOString();
        await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(regCase.id), { method: 'PATCH', body: stagePatch });
        // Log the transition so velocity samples are not biased by silent sync advances (#35).
        await _logCaseEvent(regCase.id, null, 'stage_change', 'Stage advanced to ' + stage, null, 'system', { from_stage: regCase.stage, to_stage: stage });
        updated++;
      }
```

- [ ] **Step 2: Log a stage_change event in the AHPRA-reset PATCH (#35).** Current (server.js:23892-23895):
```js
      // 3. Set case stage to 'ahpra'
      await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(resetCaseId), {
        method: 'PATCH', body: { stage: 'ahpra' }
      });
```
Replace with:
```js
      // 3. Set case stage to 'ahpra'
      var resetFromStage = resetCase.stage || null;
      await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(resetCaseId), {
        method: 'PATCH', body: { stage: 'ahpra' }
      });
      // Log the transition so reset-driven stage changes contribute a velocity sample (#35).
      if (resetFromStage !== 'ahpra') {
        await _logCaseEvent(resetCaseId, null, 'stage_change', 'Stage advanced to ahpra', null, 'system', { from_stage: resetFromStage, to_stage: 'ahpra' });
      }
```
`resetCase` is already in scope (read at server.js:23888). The other stage PATCH sites — the live GP path at 8907 (already logs at 8909) and the gp_verified_stage path via `/api/admin/case` — already emit events; the two PATCH-only sites above are the gaps named in #35.

- [ ] **Step 3: Verify no other bare stage PATCH exists.** Run:
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && grep -n "body: { stage\|body: {stage\|stage: stage\|stage: 'ahpra'" server.js
```
Expected: only the live path (8901, logs at 8909), the two now-fixed sites (23894, 31016), and the gp_verified_stage handler appear. If any other bare PATCH surfaces, add the same `_logCaseEvent(... 'stage_change' ..., {from_stage, to_stage})` call there.

- [ ] **Step 4: Syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 5: Commit.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "Phase 5: log stage_change timeline event on every stage PATCH (#35)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5.10: Phase verification — full test run + cross-finding check

**Files:** (no source changes; verification only)

- [ ] **Step 1: Run the phase unit tests.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && npx vitest run tests/ceo-actions.test.js
```
Expected: PASS (all assertions).

- [ ] **Step 2: Run the full suite to confirm no regressions.**
```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && npm test
```
Expected: the suite passes (or only pre-existing unrelated failures remain — diff against a baseline run on `main` if any failure appears, and confirm it is not introduced by Phase 5 files: `lib/ceo-actions.js`, `server.js` escalation/blocker/ticket/stage paths).

- [ ] **Step 3: Final server syntax check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node --check "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing/server.js"
```
Expected: exit 0.

- [ ] **Step 4: Confirm every assigned finding has a task** — #4 (5.1/5.3), #19 (5.1/5.3), #5 (5.1/5.3), #26 (5.2/5.4), #27 (5.2/5.4/5.7), #55 (5.2/5.6), #64 (5.5), #13 (5.8), #35 (5.9), #53 (5.1/5.7), #54 (5.1/5.7). No `git commit` needed for this verification task unless Step 2 required a fix; if a fix was applied, commit it with a message referencing the affected finding number.

---

## Phase 6: Auth hardening for the standalone CEO page

Goal: serve `pages/ceo-dashboard.html` only with a valid super-admin session on the super-admin host scope, mirroring the `admin.html` protection block, and resolve the inconsistent `requireCeoSession` CEO_EMAIL branch.

**Files:**
- Modify `server.js` — page-serving host gate (line 37603), CEO-page serving block (insert after the `admin.html` block at 37666-37680, before the generic fallback at 37682), and `requireCeoSession` (lines 6601-6611).
- Modify `pages/ceo-dashboard.html` — `checkAuth()` redirect target + cache buster (lines 998-1016 and the page's own script/style tags).
- Create `tests/ceo-auth.test.js` — integration test that unauth / non-super-admin / wrong-host all get 302/403/404, and a valid super-admin on the super-admin host gets the page.

---

### Task 6.1: Write failing integration test for CEO-page auth gating (#50, #69, #70)

**Files:** Create `tests/ceo-auth.test.js`

- [ ] **Step 1: Inspect the existing admin-session test login flow so the test can mint a real session.** Before writing, confirm how an admin/super-admin session cookie is obtained in tests by grepping the existing OTP/admin sign-in endpoints used in `tests/oauth.test.js` and any admin login route.

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && grep -n "admin/auth\|admin-signin\|gp_admin_session\|setAdminSession\|/api/admin/auth/login\|sendAdminOtp\|verifyAdminOtp" server.js | head -30
```
Use whatever admin sign-in endpoint pair this reveals to log a super-admin in. If no password/OTP admin-login endpoint is callable headlessly in test mode, mint the `gp_admin_session` cookie directly using the same `AUTH_SECRET`/signing helper the server uses (mirror how `tests/oauth.test.js` constructs sessions), and assert against the page-serving path only — the page gate reads `getAdminSession(req)` + `getAdminRoleFromSession` + `getAdminHostScope`, all cookie/host driven.

- [ ] **Step 2: Create the test file.** Boot the server exactly like `tests/oauth.test.js` (force test env, import `createServer`, listen on 127.0.0.1), but additionally configure two distinct admin hosts via env so host scope is exercised. The `get()` helper sends a `Host` header to drive `getRequestHostname`.

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const PORT = 0;
let server;
let addrPort;

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-test.local';   // mapped to super_admin scope
const ADMIN_HOST = 'staff-test.local'; // mapped to employee admin scope

// GET that lets us set an arbitrary Host header (drives getAdminHostScope)
function getWithHost(path, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = {};
    if (host) hdrs.Host = host;
    if (cookie) hdrs.Cookie = cookie;
    const opts = {
      host: '127.0.0.1',
      port: addrPort,
      path,
      method: 'GET',
      headers: hdrs,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          raw: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'production';            // so loopback is NOT auto-granted 'local' scope
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-ceo-auth-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ceo-auth-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = 'staff@gplink-test.local';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      addrPort = server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const fs = await import('fs');
  try { fs.unlinkSync(`/tmp/gplink-ceo-auth-${RUN_ID}.json`); } catch {}
});

describe('CEO dashboard page auth gating', () => {
  it('unknown host returns 404 (#69)', async () => {
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: 'random.example.com' });
    expect(r.status).toBe(404);
  });

  it('super-admin host, no session -> redirect to admin-signin (#50)', async () => {
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: SUPER_HOST });
    expect(r.status).toBe(302);
    expect(r.location).toContain('/pages/admin-signin');
  });

  it('employee admin host, no session -> 404 (CEO page not served off super-admin scope) (#69)', async () => {
    // ADMIN_HOST is an allowed admin host, so it passes the 404 host gate at 37603,
    // but must NOT serve the CEO page because scope !== super_admin.
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: ADMIN_HOST });
    // With no session it 302s to admin-signin; the load-bearing assertion is it never
    // returns the HTML body.
    expect([302, 403, 404]).toContain(r.status);
    expect(r.raw).not.toContain('<!DOCTYPE');
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL.** The current code at line 37682 explicitly excludes `/pages/ceo-dashboard.html` from the auth fallback and falls through to `serveStatic`, so the "no session -> redirect" case will fail (it serves HTML / 200 instead of 302).

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/ceo-auth.test.js
```
Expected: FAIL — at minimum the "no session -> redirect to admin-signin" assertion fails because the page is served unauthenticated.

- [ ] **Step 4: Commit the failing test.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add tests/ceo-auth.test.js && git commit -m "test: failing CEO-page auth gating test (#50,#69,#70)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.2: Restrict the CEO page 404 host gate to super-admin scope (#69)

**Files:** Modify `server.js` (line 37603)

- [ ] **Step 1: Split `ceo-dashboard.html` out of the broad `isAllowedAdminHost` 404 gate so it 404s on any host whose scope is not `super_admin`.** Replace the single combined guard at line 37603 with two guards: one for the admin-family pages (unchanged behaviour) and a dedicated one for the CEO page bound to super-admin host scope.

Exact old string (server.js:37603-37607):
```js
  if ((pathname === '/pages/admin.html' || pathname === '/pages/admin-signin.html' || pathname === '/pages/admin-visa.html' || pathname === '/pages/admin-pbs.html' || pathname === '/pages/ceo-dashboard.html') && !isAllowedAdminHost(req)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
```

Exact new string:
```js
  if ((pathname === '/pages/admin.html' || pathname === '/pages/admin-signin.html' || pathname === '/pages/admin-visa.html' || pathname === '/pages/admin-pbs.html') && !isAllowedAdminHost(req)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // CEO dashboard is delivered ONLY on the super-admin host scope (#69).
  if (pathname === '/pages/ceo-dashboard.html' && getAdminHostScope(req) !== 'super_admin') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
```

- [ ] **Step 2: Syntax check.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (exit 0).

- [ ] **Step 3: Commit.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "fix: serve ceo-dashboard.html only on super-admin host scope (#69)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.3: Require a valid super-admin session before serving the CEO page (#50)

**Files:** Modify `server.js` (insert after the `admin.html` block ending at 37680, before line 37682; update line 37682 fallback)

- [ ] **Step 1: Add a server-side session+role gate for `ceo-dashboard.html`, mirroring the `admin.html` block but additionally requiring super-admin.** Insert a new block immediately after the closing `}` of the `admin.html` block (line 37680) and before the generic fallback at 37682.

Insert this new block (place it directly after the `if (pathname === '/pages/admin.html') { ... }` block at line 37680):
```js
  if (pathname === '/pages/ceo-dashboard.html') {
    if (!adminSession) {
      res.writeHead(302, { Location: '/pages/admin-signin' });
      res.end();
      return;
    }
    const ceoRole = getAdminRoleFromSession(adminSession);
    const ceoHostScope = getAdminHostScope(req);
    // Must be on the super-admin host scope AND hold a super-admin role.
    if (ceoHostScope !== 'super_admin' || !doesAdminRoleMatchHost(ceoRole, ceoHostScope) || !isSuperAdminRole(ceoRole)) {
      clearAdminSession(res);
      res.writeHead(302, { Location: '/pages/admin-signin' });
      res.end();
      return;
    }
  }
```
Note: `doesAdminRoleMatchHost(role, 'super_admin')` already returns true only when the role is `super_admin`, and `isSuperAdminRole` is an explicit belt-and-braces check matching `requireSuperAdminSession` (server.js:6594). Both are kept so the CEO page mirrors the exact gate used by the data endpoints.

- [ ] **Step 2: Remove `ceo-dashboard.html` from the generic unauthenticated-fallback exclusion at line 37682, since it now has its own gate above.**

Exact old string (server.js:37682):
```js
  if (pathname !== '/pages/admin.html' && pathname !== '/pages/ceo-dashboard.html' && !isPublic && !session && !adminSession && (pathname.endsWith('.html') || pathname === '/')) {
```

Exact new string:
```js
  if (pathname !== '/pages/admin.html' && !isPublic && !session && !adminSession && (pathname.endsWith('.html') || pathname === '/')) {
```
Rationale: `ceo-dashboard.html` is now fully handled by the dedicated block above (which always `return`s for that path when unauthenticated/unauthorized), so it no longer needs the exclusion. Leaving the exclusion would let an unauthenticated request fall through to `serveStatic` only if the dedicated block somehow didn't return — but since the block above unconditionally handles the path, removing the exclusion is safe and closes the original loophole (#50).

- [ ] **Step 3: Syntax check.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (exit 0).

- [ ] **Step 4: Run the auth test from Task 6.1 — expect PASS.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/ceo-auth.test.js
```
Expected: PASS — all three cases (unknown host 404, super-admin host no-session 302, employee-admin host no HTML body) pass.

- [ ] **Step 5: Commit.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "fix: require super-admin session to serve ceo-dashboard.html (#50)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.4: Add an authenticated super-admin happy-path test and a non-super-admin denial test (#50, #70)

**Files:** Modify `tests/ceo-auth.test.js`

- [ ] **Step 1: Determine the headless way to mint a `gp_admin_session` cookie for a super-admin and a plain-admin in test mode.** Use the endpoint(s) found in Task 6.1 Step 1. Grep the session helpers to confirm cookie name and signing:

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && grep -n "gp_admin_session\|function setAdminSession\|function getAdminSession\|signSession\|createSessionToken\|userProfile" server.js | head -25
```

- [ ] **Step 2: Add an authenticated super-admin case (must get 200 + the page HTML) and a plain-admin case (must NOT get the page).** Append these tests inside the existing `describe` block. Build `cookie` via the admin sign-in flow (or signed-cookie helper) discovered in Step 1; the example below assumes a helper `superCookie()` / `adminCookie()` resolving to a `gp_admin_session=...` string.

```js
  it('super-admin session on super-admin host -> serves CEO page (#50)', async () => {
    const cookie = await superCookie();   // gp_admin_session for super@gplink-test.local
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: SUPER_HOST, cookie });
    expect(r.status).toBe(200);
    expect(r.raw).toContain('<!DOCTYPE');
  });

  it('plain-admin session on super-admin host -> denied, no HTML (#50,#70)', async () => {
    const cookie = await adminCookie();   // gp_admin_session for staff@gplink-test.local
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: SUPER_HOST, cookie });
    expect(r.status).toBe(302);
    expect(r.location).toContain('/pages/admin-signin');
    expect(r.raw).not.toContain('<!DOCTYPE');
  });

  it('super-admin session but on employee admin host -> 404 (wrong host scope) (#69)', async () => {
    const cookie = await superCookie();
    const r = await getWithHost('/pages/ceo-dashboard.html', { host: ADMIN_HOST, cookie });
    expect(r.status).toBe(404); // blocked by the super-admin host gate before session check
    expect(r.raw).not.toContain('<!DOCTYPE');
  });
```
If the admin sign-in flow cannot be driven headlessly (no callable OTP/password admin-login in test mode), implement `superCookie()`/`adminCookie()` by directly constructing and signing a `gp_admin_session` value with the same helper the server uses (the session-signing function found in Step 1, keyed by `process.env.AUTH_SECRET`), embedding `userProfile.adminRole='super_admin'` and `='admin'` respectively, plus the matching email. Do NOT fabricate a bypass that the server doesn't actually accept — if neither path works, state so and assert only the unauth/wrong-host cases (Task 6.1), and note the happy-path is unverified rather than faking a pass.

- [ ] **Step 3: Run the full test file — expect PASS.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/ceo-auth.test.js
```
Expected: PASS — unauth 302, plain-admin denied (no HTML), super-admin on wrong host 404, super-admin on super-admin host 200 with HTML.

- [ ] **Step 4: Commit.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add tests/ceo-auth.test.js && git commit -m "test: super-admin happy-path + non-super-admin denial for CEO page (#50,#70)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.5: Reconcile `requireCeoSession` with the host-scope model (#70)

**Files:** Modify `server.js` (lines 6601-6611)

- [ ] **Step 1: Resolve the inconsistent `CEO_EMAIL` branch.** Current `requireCeoSession` (6601-6611) calls `requireAdminSession` (which 403s any non-`super_admin` role on the super-admin host) and then re-checks `CEO_EMAIL || role==='super_admin'`. On the super-admin host a `CEO_EMAIL`-only user is already 403'd by `requireAdminSession`, so the `isCeo` branch is dead; on the employee host the role check is moot. The decided model (per contract: CEO page + data are super-admin-only) is to make `requireCeoSession` an alias of `requireSuperAdminSession`, eliminating the unreachable/contradictory `CEO_EMAIL` path.

Exact old string (server.js:6601-6611):
```js
function requireCeoSession(req, res) {
  var adminCtx = requireAdminSession(req, res);
  if (!adminCtx) return null;
  var isCeo = CEO_EMAIL && adminCtx.email.toLowerCase() === CEO_EMAIL;
  var isSuperAdmin = adminCtx.role === 'super_admin';
  if (!isCeo && !isSuperAdmin) {
    sendJson(res, 403, { ok: false, message: 'Super admin access required.' });
    return null;
  }
  return adminCtx;
}
```

Exact new string:
```js
// CEO access is super-admin access: it requires the super-admin host scope AND a
// super-admin role (same gate as requireSuperAdminSession). The legacy CEO_EMAIL-only
// branch was unreachable on the super-admin host (requireAdminSession 403s non-super
// roles there) and contradictory on the employee host, so it is removed (#70).
function requireCeoSession(req, res) {
  return requireSuperAdminSession(req, res);
}
```
This keeps `CEO_EMAIL` defined (server.js:259) for any other consumers but stops it from granting a second, inconsistent access path. If a grep shows other callers of `requireCeoSession` relying on a non-super-admin CEO, surface that in the implementation note rather than silently changing their behaviour.

- [ ] **Step 2: Verify no remaining caller depends on the removed CEO_EMAIL semantics.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && grep -n "requireCeoSession\|CEO_EMAIL" server.js
```
Expected: every `requireCeoSession(...)` call site still receives a valid super-admin context; `CEO_EMAIL` is now referenced only at its definition (line 259) unless another deliberate consumer exists (note any).

- [ ] **Step 3: Syntax check.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
```
Expected: no output (exit 0).

- [ ] **Step 4: Commit.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add server.js && git commit -m "fix: make requireCeoSession an alias of requireSuperAdminSession (#70)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.6: Align the client-side `checkAuth()` redirect and bump cache buster (#50)

**Files:** Modify `pages/ceo-dashboard.html` (lines 998-1016 and the page's own `<script src>`/`<link>` cache-buster tags)

- [ ] **Step 1: Confirm the client redirect target matches the new server gate.** The server now 302s unauthenticated/unauthorized CEO-page loads to `/pages/admin-signin`. The existing `checkAuth()` (lines 1003, 1008, 1013) already redirects to `/pages/admin-signin` when not embedded, which matches. No logic change is required to the redirect target. Add a clarifying comment so future edits keep them aligned.

Exact old string (pages/ceo-dashboard.html:1000):
```js
    function checkAuth() {
```

Exact new string:
```js
    // Client-side check is defence-in-depth only; the server gate in server.js
    // (ceo-dashboard.html block) is authoritative and 302s to /pages/admin-signin.
    function checkAuth() {
```

- [ ] **Step 2: Bump the cache buster on this page's own changed script/style tags to `?v=20260614a`.** Identify the page's self-referenced versioned assets and update them. First locate them:

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && grep -n "?v=" pages/ceo-dashboard.html
```
For each matched `src=`/`href=` tag that this phase's HTML edit touched, change its `?v=YYYYMMDD[letter]` suffix to `?v=20260614a`. Apply each as an exact old→new Edit, e.g. (replace with the real strings the grep returns):
```
old: src="/js/auth-guard.js?v=20260601a"
new: src="/js/auth-guard.js?v=20260614a"
```
If `pages/ceo-dashboard.html` has no `?v=` tags (it is largely inline JS/CSS), record that there is nothing to bump and skip — do not invent a tag.

- [ ] **Step 3: Verify HTML still parses (no broken tags) via a quick grep sanity check and a Node-based DOCTYPE presence check.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && head -1 pages/ceo-dashboard.html | grep -qi DOCTYPE && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Commit.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add pages/ceo-dashboard.html && git commit -m "chore: align CEO page client checkAuth comment + cache buster v=20260614a (#50)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.7: Full-suite regression run for the auth changes

**Files:** Test only (`tests/ceo-auth.test.js`, `tests/oauth.test.js`)

- [ ] **Step 1: Run the CEO-auth test plus the existing oauth/admin-session test to confirm no regression in the shared page-serving path.**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && /tmp/node-v20.19.6-darwin-arm64/bin/node ./node_modules/.bin/vitest run tests/ceo-auth.test.js tests/oauth.test.js</parameter>
```
Expected: PASS for both files. In particular, `admin.html` serving behaviour (302 when no session, 200 for matching role) must be unchanged — only `ceo-dashboard.html` gained a stricter gate.

- [ ] **Step 2: Commit any test-only fixups made during this run (if none, skip the commit).**

```
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/ceo-detach-email-routing" && git add -A tests/ && git commit -m "test: stabilize CEO-auth regression run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Phase 7: Integration & Technical Hub honesty
Make every Technical Hub integration card, reconnect button, and super-admin tool report the truth — real probes, real per-mailbox state, honest success/failure toasts, and no dead controls.

**Files:**
- Modify `server.js` — Gmail processed-count query + Gmail card hardcoded mailbox (37155-37190), DoubleTick probe (37237-37244), Gmail reconnect ok flag (37363-37371), Zoho Sign reconnect OAuth path (37405-37420), client-errors SELECT (37505 + 37535), Reset GP body parse (23875)
- Modify `pages/admin.html` — SA-tools toasts/no-ops (6692-6696), dead Agent Control init (8340-8341), Gmail reconnect per-mailbox toast (8395-8406)
- Test `tests/ceo-integrations.test.js` (Create) — pure-logic assertions for the Gmail reconnect ok-flag rule and the Gmail card multi-mailbox aggregation, plus a `node --check` gate

Note on line numbers: the audit cited older offsets; the ranges below are the **current** locations verified against the working tree. The before-strings are exact.

---

### Task 7.1: Fix Gmail processed-count query to use real columns (#20)

**Files:** `server.js` (37154-37159, 37169)

- [ ] **Step 1: Fix the query to select an existing column and filter on `processed_at`.** The table `processed_gmail_messages` has PK `gmail_message_id` and timestamp `processed_at` — there is no `id` or `created_at` (`supabase/migrations/20260416000000_gmail_autoparsing.sql:10-20`). Replace the broken fetch.

  Before (`server.js:37158`, inside the `Promise.all` array):
  ```js
      supabaseDbRequest('processed_gmail_messages', 'select=id&created_at=gte.' + new Date(Date.now() - 86400000).toISOString() + '&limit=500')
  ```
  After:
  ```js
      supabaseDbRequest('processed_gmail_messages', 'select=gmail_message_id&processed_at=gte.' + new Date(Date.now() - 86400000).toISOString() + '&limit=1000')
  ```

- [ ] **Step 2: Verify the row-count read still works (no column rename needed downstream).** Confirm line 37169 still reads `processedCountRes.data.length` (it does — it counts array rows, not a specific field), so no further edit is required there.

  Confirm with:
  ```
  grep -n "processedCountRes.ok && Array.isArray(processedCountRes.data) ? processedCountRes.data.length" server.js
  ```
  Expected: one hit at ~37169.

- [ ] **Step 3: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 4: Commit.**
  ```
  git add server.js && git commit -m "Fix Gmail processed-24h count to query real columns (#20)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.2: Gmail card reflects all monitored mailboxes, not just hazel (#47)

**Files:** `server.js` (37154-37191)

- [ ] **Step 1: Fetch watch state and client errors for every `MONITORED_VA_EMAILS` mailbox.** `MONITORED_VA_EMAILS` is defined at `server.js:1334`. Replace the single hardcoded `gmail_watch_state` fetch in the `Promise.all` and the hazel-only hydration below it.

  Before (`server.js:37154-37159`):
  ```js
    var [gmailWatchRes, zrConn, zsConn, processedCountRes] = await Promise.all([
      supabaseDbRequest('gmail_watch_state', 'select=*&email_address=eq.hazel@mygplink.com.au&limit=1'),
      getZohoRecruitConnection(),
      getZohoSignConnection(),
      supabaseDbRequest('processed_gmail_messages', 'select=gmail_message_id&processed_at=gte.' + new Date(Date.now() - 86400000).toISOString() + '&limit=1000')
    ]);
  ```
  After:
  ```js
    var gmailMonitored = (Array.isArray(MONITORED_VA_EMAILS) && MONITORED_VA_EMAILS.length) ? MONITORED_VA_EMAILS : ['hazel@mygplink.com.au'];
    var [gmailWatchRes, zrConn, zsConn, processedCountRes] = await Promise.all([
      supabaseDbRequest('gmail_watch_state', 'select=*&email_address=in.(' + gmailMonitored.map(function (em) { return encodeURIComponent(em); }).join(',') + ')'),
      getZohoRecruitConnection(),
      getZohoSignConnection(),
      supabaseDbRequest('processed_gmail_messages', 'select=gmail_message_id&processed_at=gte.' + new Date(Date.now() - 86400000).toISOString() + '&limit=1000')
    ]);
  ```

- [ ] **Step 2: Build per-mailbox state and a worst-case aggregate.** Replace the hazel-only `gmailWatch`/`gmailClientError`/status block.

  Before (`server.js:37166-37191`):
  ```js
    var gmailWatch = gmailWatchRes.ok && Array.isArray(gmailWatchRes.data) && gmailWatchRes.data[0] ? gmailWatchRes.data[0] : null;
    var gmailConfigured = isGmailConfigured();
    var gmailClientError = _gmailClientErrors['hazel@mygplink.com.au'] || null;
    var processedCount24h = processedCountRes.ok && Array.isArray(processedCountRes.data) ? processedCountRes.data.length : 0;

    var integrations = [];

    // Gmail
    var gmailStatus = 'disconnected';
    if (gmailConfigured && gmailWatch && !gmailClientError) {
      var watchExpiry = gmailWatch.watch_expiry ? new Date(gmailWatch.watch_expiry) : null;
      gmailStatus = (watchExpiry && watchExpiry.getTime() > Date.now()) ? 'connected' : 'degraded';
    } else if (gmailConfigured) { gmailStatus = 'degraded'; }
    integrations.push({
      key: 'gmail', name: 'Gmail (Auto-Parse)', status: gmailStatus,
      details: {
        monitored_email: 'hazel@mygplink.com.au',
        watch_expiry: gmailWatch ? gmailWatch.watch_expiry : null,
        watch_active: gmailWatch ? !!(gmailWatch.watch_expiry && new Date(gmailWatch.watch_expiry).getTime() > Date.now()) : false,
        last_history_id: gmailWatch ? gmailWatch.history_id : null,
        processed_count_24h: processedCount24h,
        client_error: gmailClientError,
        configured: gmailConfigured
      },
      can_reconnect: true, reconnect_action: 'setup_watch'
    });
  ```
  After:
  ```js
    var gmailConfigured = isGmailConfigured();
    var gmailWatchRows = (gmailWatchRes.ok && Array.isArray(gmailWatchRes.data)) ? gmailWatchRes.data : [];
    var gmailWatchByEmail = {};
    for (var gwi = 0; gwi < gmailWatchRows.length; gwi++) { gmailWatchByEmail[gmailWatchRows[gwi].email_address] = gmailWatchRows[gwi]; }
    var processedCount24h = processedCountRes.ok && Array.isArray(processedCountRes.data) ? processedCountRes.data.length : 0;

    var integrations = [];

    // Gmail — aggregate across every monitored mailbox (worst-case status)
    var gmailMailboxes = gmailMonitored.map(function (em) {
      var w = gmailWatchByEmail[em] || null;
      var active = !!(w && w.watch_expiry && new Date(w.watch_expiry).getTime() > Date.now());
      var clientError = _gmailClientErrors[em] || null;
      var mbStatus = 'disconnected';
      if (gmailConfigured && w && !clientError) mbStatus = active ? 'connected' : 'degraded';
      else if (gmailConfigured) mbStatus = 'degraded';
      return { email: em, watch_expiry: w ? w.watch_expiry : null, watch_active: active, last_history_id: w ? w.history_id : null, client_error: clientError, status: mbStatus };
    });
    var gmailStatus = 'connected';
    if (!gmailConfigured) gmailStatus = 'disconnected';
    else if (gmailMailboxes.some(function (m) { return m.status === 'disconnected'; })) gmailStatus = 'disconnected';
    else if (gmailMailboxes.some(function (m) { return m.status === 'degraded'; })) gmailStatus = 'degraded';
    integrations.push({
      key: 'gmail', name: 'Gmail (Auto-Parse)', status: gmailStatus,
      details: {
        monitored_emails: gmailMonitored,
        mailboxes: gmailMailboxes,
        processed_count_24h: processedCount24h,
        configured: gmailConfigured
      },
      can_reconnect: true, reconnect_action: 'setup_watch'
    });
  ```

- [ ] **Step 3: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 4: Commit.**
  ```
  git add server.js && git commit -m "Gmail card aggregates all MONITORED_VA_EMAILS mailboxes (#47)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.3: DoubleTick health probe throws on any non-2xx (#45)

**Files:** `server.js` (37236-37244)

- [ ] **Step 1: Replace the `/me` probe that only fails on 401/403 with a real read call that throws on any non-2xx.** DoubleTick's documented authenticated read endpoint is `/whatsapp/templates`; treat anything that is not OK as a failure (mirroring the Anthropic check at 37232 `if (!r.ok) throw new Error('HTTP ' + r.status)`).

  Before (`server.js:37237-37244`):
  ```js
      // DoubleTick: verify API key with a read-only call
      DOUBLETICK_API_KEY ? pingWithTimeout(async function (signal) {
        var r = await fetch(DOUBLETICK_BASE_URL + '/me', {
          method: 'GET', signal: signal,
          headers: { 'Authorization': DOUBLETICK_API_KEY, 'Content-Type': 'application/json' }
        });
        if (r.status === 401 || r.status === 403) throw new Error('Invalid API key (HTTP ' + r.status + ')');
        return {};
      }) : Promise.resolve({ ok: false, ms: 0, error: 'No API key', extra: {} }),
  ```
  After:
  ```js
      // DoubleTick: verify API key with a read-only authenticated call; any non-2xx is unhealthy
      DOUBLETICK_API_KEY ? pingWithTimeout(async function (signal) {
        var r = await fetch(DOUBLETICK_BASE_URL + '/whatsapp/templates', {
          method: 'GET', signal: signal,
          headers: { 'Authorization': DOUBLETICK_API_KEY, 'Content-Type': 'application/json' }
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return {};
      }) : Promise.resolve({ ok: false, ms: 0, error: 'No API key', extra: {} }),
  ```

- [ ] **Step 2: Confirm the status mapping no longer fakes healthy.** The card status block at `server.js:37322-37325` sets `connected` only when `dtPing.ok && DOUBLETICK_WEBHOOK_SECRET`, and `degraded` when `dtPing.ok` alone or `DOUBLETICK_API_KEY` present. With the probe now throwing on non-2xx, `dtPing.ok` is false on a dead key, so the card drops to `degraded`/`disconnected`. No edit needed there — just verify:
  ```
  grep -n "if (dtPing.ok && DOUBLETICK_WEBHOOK_SECRET) dtStatus" server.js
  ```
  Expected: one hit at ~37323.

- [ ] **Step 3: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 4: Commit.**
  ```
  git add server.js && git commit -m "DoubleTick health probe throws on non-2xx, no fake-healthy (#45)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.4: Gmail reconnect returns honest ok flag (#46)

**Files:** `tests/ceo-integrations.test.js` (Create), `server.js` (37363-37371), `pages/admin.html` (8395-8406)

- [ ] **Step 1 (TDD — write failing test): create `tests/ceo-integrations.test.js` with the ok-flag rule as a pure function.** The reconnect ok flag must be true only when every mailbox renewal succeeded. Extract the rule so it is testable without DB. Add this exported helper to the test file's import target by first adding it to a tiny pure module — but since Phase 7 has no `lib/ceo-metrics.js` additions, test the rule inline as a spec of the expected behavior.

  ```js
  import { describe, it, expect } from 'vitest';

  // Mirrors the reconnect ok rule implemented in server.js:
  //   ok = results.length > 0 && results.every(r => r.success)
  function gmailReconnectOk(results) {
    return Array.isArray(results) && results.length > 0 && results.every(function (r) { return !!r.success; });
  }

  describe('gmail reconnect ok flag (#46)', function () {
    it('is false when every mailbox renewal failed', function () {
      var results = [
        { email: 'hazel@mygplink.com.au', success: false, error: 'GOOGLE_PUBSUB_TOPIC missing' }
      ];
      expect(gmailReconnectOk(results)).toBe(false);
    });
    it('is false when any mailbox renewal failed', function () {
      var results = [
        { email: 'a@x.com', success: true },
        { email: 'b@x.com', success: false, error: 'auth' }
      ];
      expect(gmailReconnectOk(results)).toBe(false);
    });
    it('is true only when all renewals succeeded', function () {
      var results = [
        { email: 'a@x.com', success: true },
        { email: 'b@x.com', success: true }
      ];
      expect(gmailReconnectOk(results)).toBe(true);
    });
    it('is false on empty results', function () {
      expect(gmailReconnectOk([])).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run the test — it passes immediately (the helper is the spec).** This task's failing-first gate is the server behavior, not the helper; the helper locks the rule.
  ```
  npx vitest run tests/ceo-integrations.test.js -t "gmail reconnect ok flag"
  ```
  Expected: PASS (4 assertions).

- [ ] **Step 3: Apply the same rule in the server reconnect handler.**

  Before (`server.js:37363-37371`):
  ```js
    if (intKey === 'gmail') {
      var results = [];
      for (var vi = 0; vi < MONITORED_VA_EMAILS.length; vi++) {
        var wr = await setupGmailWatch(MONITORED_VA_EMAILS[vi]);
        results.push({ email: MONITORED_VA_EMAILS[vi], success: !!(wr && wr.ok), expiry: wr && wr.ok ? wr.expiry : null, error: wr && !wr.ok ? wr.error : null });
      }
      sendJson(res, 200, { ok: true, action: 'watch_renewed', results: results });
      return;
    }
  ```
  After:
  ```js
    if (intKey === 'gmail') {
      var results = [];
      var gmailReconnectEmails = (Array.isArray(MONITORED_VA_EMAILS) && MONITORED_VA_EMAILS.length) ? MONITORED_VA_EMAILS : ['hazel@mygplink.com.au'];
      for (var vi = 0; vi < gmailReconnectEmails.length; vi++) {
        var wr = await setupGmailWatch(gmailReconnectEmails[vi]);
        results.push({ email: gmailReconnectEmails[vi], success: !!(wr && wr.ok), expiry: wr && wr.ok ? wr.expiry : null, error: wr && !wr.ok ? (wr.error || 'Watch renewal failed') : null });
      }
      var gmailReconnectOk = results.length > 0 && results.every(function (r) { return r.success; });
      sendJson(res, gmailReconnectOk ? 200 : 502, { ok: gmailReconnectOk, action: 'watch_renewed', results: results, message: gmailReconnectOk ? null : 'One or more mailboxes failed to renew.' });
      return;
    }
  ```

- [ ] **Step 4: Surface per-mailbox failures in the reconnect toast.** The admin handler already shows a green toast on `d.ok`; make the failure path list which mailboxes failed instead of a generic message.

  Before (`pages/admin.html:8395-8405`):
  ```js
      fetch("/api/ceo/integrations/"+encodeURIComponent(key)+"/reconnect",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"}}).then(function(r){return r.json();}).then(function(d){
        if(d.ok){
          toast("Reconnected successfully","green");
          setTimeout(loadIntegrations,2000);
        }else if(d.action==="oauth_required"&&d.oauthUrl){
          toast("Redirecting to re-authorize...","blue");
          window.location.href=d.oauthUrl;
          return;
        }else{toast(d.message||"Reconnect failed","red");}
        reconBtn.textContent="Reconnect";reconBtn.disabled=false;
      }).catch(function(){toast("Network error","red");reconBtn.textContent="Reconnect";reconBtn.disabled=false;});
  ```
  After:
  ```js
      fetch("/api/ceo/integrations/"+encodeURIComponent(key)+"/reconnect",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"}}).then(function(r){return r.json();}).then(function(d){
        if(d.ok){
          toast("Reconnected successfully","green");
          setTimeout(loadIntegrations,2000);
        }else if(d.action==="oauth_required"&&d.oauthUrl){
          toast("Redirecting to re-authorize...","blue");
          window.location.href=d.oauthUrl;
          return;
        }else{
          var failedMb=(Array.isArray(d.results)?d.results.filter(function(x){return !x.success;}):[]);
          var failMsg=failedMb.length?("Reconnect failed: "+failedMb.map(function(x){return x.email+" ("+(x.error||"error")+")";}).join(", ")):(d.message||"Reconnect failed");
          toast(failMsg,"red");
        }
        reconBtn.textContent="Reconnect";reconBtn.disabled=false;
      }).catch(function(){toast("Network error","red");reconBtn.textContent="Reconnect";reconBtn.disabled=false;});
  ```

- [ ] **Step 5: Syntax check + rerun test.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js && npx vitest run tests/ceo-integrations.test.js -t "gmail reconnect ok flag"
  ```
  Expected: server check no output (PASS); test PASS.

- [ ] **Step 6: Commit.**
  ```
  git add server.js pages/admin.html tests/ceo-integrations.test.js && git commit -m "Gmail reconnect returns honest ok + per-mailbox failures (#46)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.5: Zoho Sign reconnect re-auth path (#65)

**Files:** `server.js` (37405-37420)

- [ ] **Step 1: On Zoho Sign refresh failure, build the Sign OAuth auth URL and return `action:'oauth_required'`, mirroring Zoho Recruit (37386-37402).** The Sign auth URL is built the same way as the existing `/api/admin/integrations/zoho-sign/auth-url` handler (`server.js:24653-24660`): `getZohoSignAccountsServer() + '/oauth/v2/auth'`, scope `ZOHO_SIGN_SCOPES.join(',')`, redirect `getZohoSignOauthRedirectUri()`, state from `createZohoSignOauthState(adminUserId, email, returnOrigin)`. The frontend already handles `oauth_required` (admin.html:8399-8402).

  Before (`server.js:37405-37420`):
  ```js
    if (intKey === 'zoho_sign') {
      var zsConn2 = await getZohoSignConnection();
      if (zsConn2 && zsConn2.refreshToken) {
        var zsRefreshed = await refreshZohoSignAccessToken(zsConn2);
        // Verify the token was actually obtained — don't trust HTTP status alone
        var zsAfter = await getZohoSignConnection();
        var zsNewExpiry = zsAfter && zsAfter.tokenExpiresAt ? Date.parse(zsAfter.tokenExpiresAt) : 0;
        if (zsRefreshed.ok && zsRefreshed.data && zsRefreshed.data.access_token && zsNewExpiry > Date.now()) {
          sendJson(res, 200, { ok: true, action: 'token_refreshed', token_expires_at: zsAfter.tokenExpiresAt });
          return;
        }
      }
      var zsErr = 'Token refresh failed.';
      sendJson(res, 200, { ok: false, message: zsErr + ' Please reconnect via the Zoho Sign card on the Integrations tab (GPs > Integrations).' });
      return;
    }
  ```
  After:
  ```js
    if (intKey === 'zoho_sign') {
      var zsConn2 = await getZohoSignConnection();
      if (zsConn2 && zsConn2.refreshToken) {
        var zsRefreshed = await refreshZohoSignAccessToken(zsConn2);
        // Verify the token was actually obtained — don't trust HTTP status alone
        var zsAfter = await getZohoSignConnection();
        var zsNewExpiry = zsAfter && zsAfter.tokenExpiresAt ? Date.parse(zsAfter.tokenExpiresAt) : 0;
        if (zsRefreshed.ok && zsRefreshed.data && zsRefreshed.data.access_token && zsNewExpiry > Date.now()) {
          sendJson(res, 200, { ok: true, action: 'token_refreshed', token_expires_at: zsAfter.tokenExpiresAt });
          return;
        }
      }
      // Refresh failed (or no refresh token) — offer full OAuth re-auth like Zoho Recruit
      if (!ZOHO_SIGN_CLIENT_ID || !ZOHO_SIGN_CLIENT_SECRET) {
        sendJson(res, 200, { ok: false, message: 'Zoho Sign is not configured (missing client credentials).' });
        return;
      }
      var zsAdminUserId = getSessionSupabaseUserId(ceoCtx.session) || '';
      var zsReturnOrigin = (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || 'admin.mygplink.com.au');
      var zsOauthState = await createZohoSignOauthState(zsAdminUserId, ceoCtx.email || '', zsReturnOrigin);
      var zsAuthUrl = new URL(getZohoSignAccountsServer() + '/oauth/v2/auth');
      zsAuthUrl.searchParams.set('response_type', 'code');
      zsAuthUrl.searchParams.set('client_id', ZOHO_SIGN_CLIENT_ID);
      zsAuthUrl.searchParams.set('scope', ZOHO_SIGN_SCOPES.join(','));
      zsAuthUrl.searchParams.set('redirect_uri', getZohoSignOauthRedirectUri());
      zsAuthUrl.searchParams.set('access_type', 'offline');
      zsAuthUrl.searchParams.set('prompt', 'consent');
      zsAuthUrl.searchParams.set('state', zsOauthState);
      sendJson(res, 200, { ok: false, action: 'oauth_required', oauthUrl: zsAuthUrl.toString(), message: 'Zoho Sign token expired. Redirecting to re-authorize...' });
      return;
    }
  ```

- [ ] **Step 2: Confirm `ceoCtx` exposes `.session`.** The reconnect handler binds `var ceoCtx = requireCeoSession(req, res)` at 37359; `getSessionSupabaseUserId` (server.js:19663) takes a session object. Verify the shape:
  ```
  grep -n "function requireCeoSession" server.js
  ```
  Expected: one hit. (If `requireCeoSession` returns `{email, session}` like `requireAdminSession`, `ceoCtx.session` is valid; if it returns a bare session, change `ceoCtx.session` to `ceoCtx` in Step 1. Verify the returned object's keys before finalizing the edit.)

- [ ] **Step 3: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 4: Commit.**
  ```
  git add server.js && git commit -m "Zoho Sign Technical Hub reconnect offers OAuth re-auth (#65)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.6: User Bugs panel shows stack trace + first-seen date (#21, #48)

**Files:** `server.js` (37505, 37535)

- [ ] **Step 1: Add `error_stack` and `first_seen_at` to the client-errors SELECT.** The `client_errors` table has both columns (`supabase/migrations/20260512000000_technical_hub.sql:31,39`), and `pages/admin.html:8540,8542` already renders `e.first_seen_at` and `e.error_stack` — they are always undefined because the server omits them.

  Before (`server.js:37505`):
  ```js
    var ceSafeSelect = 'id,error_message,page_url,user_email,user_agent,browser_info,error_hash,user_context,occurrence_count,status,created_at,last_seen_at,resolved_by,resolved_at';
  ```
  After:
  ```js
    var ceSafeSelect = 'id,error_message,error_stack,page_url,user_email,user_agent,browser_info,error_hash,user_context,occurrence_count,status,created_at,first_seen_at,last_seen_at,resolved_by,resolved_at';
  ```

- [ ] **Step 2: Echo the same fields in the PATCH representation select.**

  Before (`server.js:37535`):
  ```js
      var r = await supabaseDbRequest('client_errors', 'id=eq.' + encodeURIComponent(errorId) + '&select=id,error_message,page_url,user_email,user_agent,browser_info,error_hash,user_context,occurrence_count,status,created_at,last_seen_at,resolved_by,resolved_at', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
  ```
  After:
  ```js
      var r = await supabaseDbRequest('client_errors', 'id=eq.' + encodeURIComponent(errorId) + '&select=id,error_message,error_stack,page_url,user_email,user_agent,browser_info,error_hash,user_context,occurrence_count,status,created_at,first_seen_at,last_seen_at,resolved_by,resolved_at', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
  ```

- [ ] **Step 3: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 4: Commit.**
  ```
  git add server.js && git commit -m "User Bugs panel returns error_stack + first_seen_at (#21, #48)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.7: SA Tools honest toasts (Sync/Sweep) and visible no-op tools (Ops Queue/Zoho Sign), Reset GP confirmation (#67, #68)

**Files:** `pages/admin.html` (6692-6696)

- [ ] **Step 1: `zoho-recruit-sync` checks HTTP + `{ok}` before claiming success (#67).** `fetch` only rejects on network failure, so a 502/503 currently shows "sync started".

  Before (`pages/admin.html:6692`):
  ```js
      else if(tool==="zoho-recruit-sync"){try{await fetch("/api/admin/integrations/zoho-recruit/sync",{method:"POST",credentials:"same-origin"});alert("Zoho Recruit sync started.");}catch{alert("Sync failed.");}}
  ```
  After:
  ```js
      else if(tool==="zoho-recruit-sync"){try{var zr=await fetch("/api/admin/integrations/zoho-recruit/sync",{method:"POST",credentials:"same-origin"});var zrd=await zr.json().catch(function(){return{};});alert(zr.ok&&zrd.ok!==false?"Zoho Recruit sync started.":"Failed: "+(zrd.message||("HTTP "+zr.status)));}catch{alert("Sync failed.");}}
  ```

- [ ] **Step 2: `weekly-sweep` checks HTTP + `{ok}` before claiming success (#67).**

  Before (`pages/admin.html:6695`):
  ```js
      else if(tool==="weekly-sweep"){try{var sr=await fetch("/api/admin/va/weekly-checkin/sweep",{method:"POST",credentials:"same-origin"});var sd=await sr.json();alert("Sweep done: "+sd.created+" tasks created, "+sd.escalated+" escalated (scanned "+sd.scanned+")");}catch{alert("Sweep failed.");}}
  ```
  After:
  ```js
      else if(tool==="weekly-sweep"){try{var sr=await fetch("/api/admin/va/weekly-checkin/sweep",{method:"POST",credentials:"same-origin"});var sd=await sr.json().catch(function(){return{};});alert(sr.ok&&sd.ok!==false?("Sweep done: "+(sd.created||0)+" tasks created, "+(sd.escalated||0)+" escalated (scanned "+(sd.scanned||0)+")"):"Failed: "+(sd.message||("HTTP "+sr.status)));}catch{alert("Sweep failed.");}}
  ```

- [ ] **Step 3: `ops-queue` switches to the Tools view + Ops sub-tab so the refreshed panel is visible (#68).** State keys verified: `S.view`, `S.toolsSubView` (default `"ops"` at admin.html:1482), `vaShowPanel('tools')` (7110), `renderToolsPanel()` (7459) which calls `loadOpsQueue()` when `toolsSubView==='ops'` (7471).

  Before (`pages/admin.html:6694`):
  ```js
      else if(tool==="ops-queue"&&typeof loadOpsQueue==="function")loadOpsQueue();
  ```
  After:
  ```js
      else if(tool==="ops-queue"){S.view="tools";S.toolsSubView="ops";if(typeof setActiveViewTab==="function")setActiveViewTab("tools");vaShowPanel("tools");renderToolsPanel();}
  ```

- [ ] **Step 4: `zoho-sign` switches to the Tools view + Integrations sub-tab so the refreshed status is visible (#68).** `renderToolsPanel()` calls `loadZohoSignStatus()` + `loadZohoRecruitStatus()` when `toolsSubView==='integrations'` (admin.html:7474), so the explicit `loadZohoSignStatus()` and the misleading "refreshed" alert are no longer needed.

  Before (`pages/admin.html:6693`):
  ```js
      else if(tool==="zoho-sign"&&typeof loadZohoSignStatus==="function"){loadZohoSignStatus();alert("Zoho Sign status refreshed.");}
  ```
  After:
  ```js
      else if(tool==="zoho-sign"){S.view="tools";S.toolsSubView="integrations";if(typeof setActiveViewTab==="function")setActiveViewTab("tools");vaShowPanel("tools");renderToolsPanel();}
  ```

- [ ] **Step 5: Bump the cache buster on the admin.html script/style tag changed in this phase.** Update the version query on `pages/admin.html`'s own asset/script reference (or the `?v=` token used on its inline-page cache marker) to `?v=20260614a`.

  Run to locate the current token, then edit the single matching tag:
  ```
  grep -n "admin.html?v=\|admin.js?v=\|\?v=2026" pages/admin.html | head
  ```
  Apply `old→new`: replace the existing `?v=YYYYMMDD[letter]` on the changed tag with `?v=20260614a`. If admin.html carries no self-versioned tag (it is server-served with no-cache headers), skip this step and note "no cache-buster tag present in admin.html".

- [ ] **Step 6: Commit.**
  ```
  git add pages/admin.html && git commit -m "SA Tools: honest Sync/Sweep toasts + visible Ops/Zoho-Sign tools (#67, #68)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.8: Remove dead Agent Control tab reference (#66)

**Files:** `pages/admin.html` (8340-8341)

- [ ] **Step 1: Delete the init code that references the non-existent `#agentTab`.** There is no `data-view="agent"` element in `.view-tabs` (admin.html:1306-1315); `getElementById("agentTab")` is always null, so this is dead. The Agent feature stays reachable via the Ops Queue Tools "Agent" sub-tab (`renderToolsPanel`, admin.html:7469/7473). Per the rebuild contract, the standalone CEO page owns CEO-only tabs; admin.html should not carry a dead tab stub.

  Before (`pages/admin.html:8339-8342`):
  ```js
      if(isSA()){
        const agentTab=document.getElementById("agentTab");
        if(agentTab)agentTab.style.display="";
        var saWrap=document.getElementById("saToolsWrap");
  ```
  After:
  ```js
      if(isSA()){
        var saWrap=document.getElementById("saToolsWrap");
  ```

- [ ] **Step 2: Confirm no other live reference to `agentTab` remains.**
  ```
  grep -n "agentTab" pages/admin.html
  ```
  Expected: no hits (the only references were the two deleted lines). The `S.view==="agent"` render branches at 1943/1951/2409/2455/3317/3347 stay — they back the Tools > Agent sub-tab and are not dead.

- [ ] **Step 3: Commit.**
  ```
  git add pages/admin.html && git commit -m "Remove dead Agent Control tab init referencing missing #agentTab (#66)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.9: Reset GP body-parse fallback for local runtime (#49)

**Files:** `server.js` (23875)

- [ ] **Step 1: Replace the `req.body`-only read with a `readJsonBody` fallback.** On Vercel `@vercel/node` populates `req.body`, but local `npm start` (raw `http.createServer`) leaves it undefined, so `resetEmail` is empty and the route 400s. `readJsonBody(req)` is defined at server.js:5345 and used throughout (e.g. 5615, 20270).

  Before (`server.js:23875`):
  ```js
      var resetBody = typeof req.body === 'object' && req.body ? req.body : {};
  ```
  After:
  ```js
      var resetBody; try { resetBody = (typeof req.body === 'object' && req.body) ? req.body : await readJsonBody(req); } catch (e) { resetBody = {}; }
  ```

- [ ] **Step 2: Syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 3: Commit.**
  ```
  git add server.js && git commit -m "Reset GP route falls back to readJsonBody on local runtime (#49)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7.10: Phase 7 verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full server syntax check.**
  ```
  /tmp/node-v20.19.6-darwin-arm64/bin/node --check server.js
  ```
  Expected: no output (PASS).

- [ ] **Step 2: Run the Phase 7 test file.**
  ```
  npx vitest run tests/ceo-integrations.test.js
  ```
  Expected: PASS (all gmail-reconnect-ok-flag assertions green).

- [ ] **Step 3: Confirm no lingering hardcoded-hazel or broken-column references remain in the Gmail integration card.**
  ```
  grep -n "email_address=eq.hazel\|select=id&created_at=gte\|_gmailClientErrors\['hazel" server.js
  ```
  Expected: no hits inside the `/api/ceo/integrations` handler (37148-37354).

- [ ] **Step 4: Confirm full test suite is not regressed by Phase 7.**
  ```
  npm test
  ```
  Expected: no new failures attributable to Phase 7 files (`server.js`, `pages/admin.html`, `tests/ceo-integrations.test.js`).

- [ ] **Step 5: Commit any verification-driven fixups (if none, skip).**
  ```
  git add -A && git commit -m "Phase 7 verification fixups (integrations honesty)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Phase 8: Standalone CEO page + UI (RSO oversight, VA→RSO, clickable KPIs, RSO picker, modal fixes)
Make `pages/ceo-dashboard.html` a true standalone page with its own top nav, relabel every user-facing "VA"→"RSO", wire clickable KPI tiles, replace the free-text VA-ID reassign box with an RSO `<select>`, add an RSO oversight panel, fix the action-modal payloads, render `in_progress` on Task Health, humanize milestone labels, and strip the now-dead CEO iframe/tab from `pages/admin.html`.

**Files:**
- Modify `pages/ceo-dashboard.html` — header/nav (lines 859–897), KPI strip + `kpiCard` (1052–1122), escalation render (1147–1149), Task Health (1224–1234), VA Workload → RSO Workload (1242–1259), Completions milestone render (1360–1366), drilldown actions/labels (1426–1500), action modals (1542–1669), drilldown click + event delegation (1384–1424, 1746–1770), section grid render (1068–1079), init/auth (998–1016, 1822–1835)
- Modify `pages/admin.html` — view-tabs (1306–1315), CEO iframe panel (1451), `renderAdminView` ceo-home branch (2017–2022), tab-click ceo-home branch (5688–5690), panel map (7112), SA init tab reveal (8344–8345)
- Test `tests/ceo-standalone-ui.test.js` (Create) — static assertions over the rendered HTML source (no DOM): relabels present, dead iframe gone, RSO picker markup, modal payload shape

This phase is UI/markup wiring (no new `lib/ceo-metrics.js` functions), so it is verified primarily by source-grep assertions in one vitest file plus a `node --check`-style HTML script-block extraction. Where a unit assertion is meaningful (the relabel sweep, the dead-iframe removal, the RSO picker), `tests/ceo-standalone-ui.test.js` provides a real failing→passing gate.

Note on field names: Phases W1/W3 refactor `/api/ceo/dashboard` so `va_workload` items and the `rso` drilldown use the contract shape `{rso_id, rso_name, case_count, open_tasks, overdue_tasks}` and drill by `rso_id` (section `rso`). All UI in this phase consumes those exact names. If W1/W3 land after this phase in the same branch, the standalone page is written to the contract names from the start.

---

### Task 8.1: Failing test harness for the standalone-page UI contract (#W0, #24, #44, #59)
**Files:** `tests/ceo-standalone-ui.test.js` (Create)

- [ ] **Step 1: Write the failing test file.** Asserts against the raw source of the two HTML files (string/regex checks — no jsdom). It encodes the Phase-8 contract: standalone nav exists, no "VA Workload" label, KPI tiles carry `data-drilldown`, the reassign modal has a `<select id="mRsoSelect">` not a free-text `mVaId`, Task Health renders In Progress, and admin.html no longer ships the CEO iframe.
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ceo = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'pages/admin.html'), 'utf8');

describe('CEO standalone page UI', () => {
  it('relabels all user-facing VA to RSO', () => {
    // No user-facing "VA Workload" / "Reassign VA" / "Assigned VA" labels remain
    expect(ceo).not.toMatch(/VA Workload/);
    expect(ceo).not.toMatch(/Reassign VA/);
    expect(ceo).not.toMatch(/Assigned VA/);
    expect(ceo).not.toMatch(/'No VAs assigned/);
    expect(ceo).toMatch(/RSO Workload/);
  });

  it('has its own standalone top nav (not iframe-only)', () => {
    expect(ceo).toMatch(/class="ceo-topnav"/);
    expect(ceo).toMatch(/href="\/pages\/admin"/); // back-to-admin link
  });

  it('makes KPI tiles clickable via data-drilldown', () => {
    // kpiCard must emit a data-drilldown attribute for the 4 wired tiles
    expect(ceo).toMatch(/data-drilldown="placements"[^>]*data-param="status=secured"/);
    expect(ceo).toMatch(/kpiDrillMap/);
  });

  it('reassign modal uses an RSO <select>, not a free-text user id box', () => {
    expect(ceo).not.toMatch(/id="mVaId"/);
    expect(ceo).toMatch(/id="mRsoSelect"/);
    expect(ceo).toMatch(/assigned_rso:/);
  });

  it('Set Blocker modal no longer offers an invalid "Blocked" option', () => {
    expect(ceo).not.toMatch(/<option value="blocked">Blocked<\/option>/);
  });

  it('Add Note posts to the task endpoint when a taskId is present', () => {
    expect(ceo).toMatch(/\/api\/admin\/task\/note/);
  });

  it('Task Health renders an In Progress cell', () => {
    expect(ceo).toMatch(/In Progress/);
  });

  it('RSO oversight panel + endpoints are wired', () => {
    expect(ceo).toMatch(/\/api\/ceo\/rsos/);
    expect(ceo).toMatch(/\/api\/ceo\/rso\//);
    expect(ceo).toMatch(/renderRsoOversight/);
  });

  it('admin.html no longer ships the CEO iframe or Home Dashboard tab', () => {
    expect(admin).not.toMatch(/ceoHomeIframe/);
    expect(admin).not.toMatch(/data-view="ceo-home"/);
    expect(admin).not.toMatch(/id="ceoHomePanel"/);
  });
});
```
- [ ] **Step 2: Run it — expect FAIL.** Every assertion fails because the current source still has the old markup.
```
npx vitest run tests/ceo-standalone-ui.test.js
```
Expected: FAIL (all 9 cases red). This is the TDD red baseline that Tasks 8.2–8.9 turn green.
- [ ] **Step 3: Commit the failing test.**
```
git add tests/ceo-standalone-ui.test.js && git commit -m "test(ceo): failing UI contract for standalone CEO page (#24,#44,#59)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.2: Add a standalone top nav to the CEO page (#W0)
**Files:** `pages/ceo-dashboard.html` (CSS ~96–148, header markup 859–897, init 1822–1835)

- [ ] **Step 1: Add nav CSS.** Insert a `.ceo-topnav` style block right after the `.refresh-meta`/`.auto-toggle` styles (before the `/* ═══ CONTENT ═══ */` marker at line 150). The existing `.time-filter-bar` references undefined `--border`/`--accent` vars; fix those to defined tokens at the same time.

old (lines 96–100):
```
    .time-filter-bar { display: flex; align-items: center; gap: 6px; padding: 8px 24px; background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--border); }
    .time-filter-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-right: 4px; }
    .time-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer; transition: all 0.15s; }
    .time-btn:hover { border-color: var(--accent); color: var(--text); }
    .time-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
```
new:
```
    .time-filter-bar { display: flex; align-items: center; gap: 6px; padding: 8px 24px; background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--panel-border); }
    .time-filter-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-right: 4px; }
    .time-btn { padding: 5px 14px; border-radius: 6px; border: 1px solid var(--panel-border); background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer; transition: all 0.15s; }
    .time-btn:hover { border-color: var(--blue); color: var(--text); }
    .time-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
    /* ═══ STANDALONE TOP NAV ═══ */
    .ceo-topnav { display: flex; align-items: center; gap: 4px; padding: 0 24px; background: var(--bg-elevated); border-bottom: 1px solid var(--panel-border); position: sticky; top: 60px; z-index: 90; }
    .ceo-topnav a, .ceo-topnav .nav-item { padding: 11px 14px; font-size: 13px; font-weight: 600; color: var(--text-muted); text-decoration: none; border-bottom: 2px solid transparent; cursor: pointer; transition: color 0.15s, border-color 0.15s; }
    .ceo-topnav .nav-item:hover, .ceo-topnav a:hover { color: var(--text); }
    .ceo-topnav .nav-item.active { color: var(--text); border-bottom-color: var(--blue); }
    .ceo-topnav .nav-spacer { flex: 1; }
    .ceo-topnav .nav-back { color: var(--text-dim); font-weight: 500; }
```
- [ ] **Step 2: Insert the nav bar markup** between the closing `</header>` (line 878) and the `<!-- TIME FILTER -->` comment (line 880).

old (lines 878–881):
```
    </header>

    <!-- TIME FILTER -->
    <div class="time-filter-bar" id="timeFilterBar">
```
new:
```
    </header>

    <!-- STANDALONE TOP NAV -->
    <nav class="ceo-topnav" id="ceoTopNav">
      <div class="nav-item active" data-tab="overview">Overview</div>
      <div class="nav-item" data-tab="rsos">RSO Oversight</div>
      <div class="nav-spacer"></div>
      <a class="nav-back" href="/pages/admin" title="Back to Admin">&#x2190; Admin</a>
    </nav>

    <!-- TIME FILTER -->
    <div class="time-filter-bar" id="timeFilterBar">
```
- [ ] **Step 3: Add the tab-switch handler + view containers.** The dashboard renders into `#mainContent`. Add a second container `#rsoContent` and a nav handler. Replace the CONTENT block (lines 890–896).

old (lines 890–896):
```
    <!-- CONTENT -->
    <div class="content" id="mainContent">
      <div class="page-loading" id="pageLoading">
        <div class="spinner"></div>
        <div class="loading-text">Authenticating &amp; loading dashboard...</div>
      </div>
    </div>
```
new:
```
    <!-- CONTENT -->
    <div class="content" id="mainContent">
      <div class="page-loading" id="pageLoading">
        <div class="spinner"></div>
        <div class="loading-text">Authenticating &amp; loading dashboard...</div>
      </div>
    </div>
    <div class="content" id="rsoContent" style="display:none"></div>
```
- [ ] **Step 4: Wire the nav tab handler.** Insert right before the `/* ═══ INIT ═══ */` block (line 1822). `loadRsoOversight` is defined in Task 8.7.
```js
    /* ── Standalone top-nav tabs ── */
    var currentTab = 'overview';
    document.getElementById('ceoTopNav').addEventListener('click', function(e) {
      var item = e.target.closest('.nav-item[data-tab]');
      if (!item) return;
      var tab = item.getAttribute('data-tab');
      if (tab === currentTab) return;
      currentTab = tab;
      var items = document.querySelectorAll('#ceoTopNav .nav-item');
      for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i].getAttribute('data-tab') === tab);
      document.getElementById('mainContent').style.display = (tab === 'overview') ? '' : 'none';
      document.getElementById('rsoContent').style.display = (tab === 'rsos') ? '' : 'none';
      if (tab === 'rsos') loadRsoOversight();
    });
```
- [ ] **Step 5: Bump cache busters.** The page loads `/js/error-reporter.js?v=20260527a` (line 857). Leave third-party scripts; this page has no other versioned local tags, but bump the error-reporter tag to confirm a fresh deploy.

old (line 857):
```
<script src="/js/error-reporter.js?v=20260527a"></script>
```
new:
```
<script src="/js/error-reporter.js?v=20260614a"></script>
```
- [ ] **Step 6: Syntax-check the inline script.** Extract the inline `<script>` body and run `node --check`.
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
```
Expected: prints `OK` (no syntax error).
- [ ] **Step 7: Re-run the UI test — nav assertion now passes.**
```
npx vitest run tests/ceo-standalone-ui.test.js -t "standalone top nav"
```
Expected: PASS for "has its own standalone top nav".
- [ ] **Step 8: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "feat(ceo): standalone top nav for CEO command centre (#W0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.3: Wire clickable KPI tiles to drilldowns (#24)
**Files:** `pages/ceo-dashboard.html` (`kpiCard` 1094–1122, callers 1056–1061, event delegation 1746–1770)

KPI tiles look interactive but are dead. The four tiles with real drilldowns are: Placed → `placements?status=secured`, Open Tasks → `tasks?status=open`, Overdue → `tasks?status=overdue`, Blocked → `blockers`. Total GPs and Completed have no single drilldown section so they stay non-clickable.

- [ ] **Step 1: Add a tile→drilldown map and emit `data-drilldown`/`data-param` on clickable tiles.** Replace `kpiCard` (lines 1094–1122).

old:
```
    function kpiCard(label, value, accent, trendKey) {
      var trendHtml = '';
      if (trendsData && trendsData.weeks && trendsData.weeks.length >= 2) {
        var tw = trendsData.weeks[trendsData.weeks.length - 1];
        var lw = trendsData.weeks[trendsData.weeks.length - 2];
        var trendMap = {
          total_gps: 'new_gps',
          open_tasks: 'tasks_created',
          overdue: null,
          blocked: null,
          placed: 'placements_secured',
          completed: 'placements_secured'
        };
        var field = trendMap[trendKey];
        if (field && tw && lw) {
          var cur = tw[field] || 0;
          var prev = lw[field] || 0;
          var diff = cur - prev;
          if (diff > 0) trendHtml = '<div class="kpi-trend up">&#x25B2; +' + diff + ' this week</div>';
          else if (diff < 0) trendHtml = '<div class="kpi-trend down">&#x25BC; ' + diff + ' this week</div>';
          else trendHtml = '<div class="kpi-trend flat">&#x2014; unchanged</div>';
        }
      }
      return '<div class="kpi-card ' + accent + '">' +
        '<div class="kpi-label">' + esc(label) + '</div>' +
        '<div class="kpi-value">' + esc(value) + '</div>' +
        trendHtml +
        '</div>';
    }
```
new:
```
    // tile key -> { section, param } for the four tiles that have a matching drilldown
    var kpiDrillMap = {
      placed: { section: 'placements', param: 'status=secured' },
      open_tasks: { section: 'tasks', param: 'status=open' },
      overdue: { section: 'tasks', param: 'status=overdue' },
      blocked: { section: 'blockers', param: '' }
    };

    function kpiCard(label, value, accent, trendKey) {
      var trendHtml = '';
      if (trendsData && trendsData.weeks && trendsData.weeks.length >= 2) {
        var tw = trendsData.weeks[trendsData.weeks.length - 1];
        var lw = trendsData.weeks[trendsData.weeks.length - 2];
        var trendMap = {
          total_gps: 'new_gps',
          open_tasks: 'tasks_created',
          overdue: null,
          blocked: null,
          placed: 'placements_secured',
          completed: 'completions'
        };
        var field = trendMap[trendKey];
        if (field && tw && lw) {
          var cur = tw[field] || 0;
          var prev = lw[field] || 0;
          var diff = cur - prev;
          if (diff > 0) trendHtml = '<div class="kpi-trend up">&#x25B2; +' + diff + ' new this week</div>';
          else if (diff < 0) trendHtml = '<div class="kpi-trend down">&#x25BC; ' + diff + ' vs last week</div>';
          else trendHtml = '<div class="kpi-trend flat">&#x2014; unchanged</div>';
        }
      }
      var drill = kpiDrillMap[trendKey];
      var drillAttr = drill ? ' data-drilldown="' + drill.section + '" data-param="' + drill.param + '" style="cursor:pointer"' : '';
      return '<div class="kpi-card ' + accent + '"' + drillAttr + '>' +
        '<div class="kpi-label">' + esc(label) + '</div>' +
        '<div class="kpi-value">' + esc(value) + '</div>' +
        trendHtml +
        '</div>';
    }
```
Note: the `completed` trend field is changed from `placements_secured` to `completions` here so the arrow under Completed reflects real completions (the trends endpoint gains a `completions` per-week series in the W2/trends phase — #16/#25). If that series is absent the field simply yields no arrow.

**This also resolves #17** (trend arrows implied a snapshot delta). The caption wording above is deliberately FLOW language — "▲ +N new this week" and "▼ N vs last week" — never the bare "+N this week" that read as "the displayed total rose by N". The arrow describes weekly inflow (e.g. `tasks_created`, `new_gps`), not the change in the snapshot value shown above it. Do NOT revert these strings to a snapshot-delta phrasing. (Verify in the UI test below that no `kpi-trend` caption renders the bare "+N this week" form.)

- [ ] **Step 2: Route KPI-tile drilldowns into the section panels.** The four KPI drilldowns reuse the existing section drilldown panels (`dd-placements`, `dd-tasks`, `dd-blockers`). The current event delegation (lines 1747–1756) already handles any `[data-drilldown]` element and finds its `.section-card` via `closest`. A KPI tile is NOT inside a section card, so `cardEl`/`panel` lookup must target the section panel by name. Update `handleDrilldownClick` to resolve the panel by section id (it already does: `document.getElementById('dd-' + section)`), so the only gap is that clicking a KPI tile should scroll the matching section into view. Replace the `data-drilldown` branch in the click delegation (lines 1749–1756).

old:
```
      var ddEl = e.target.closest('[data-drilldown]');
      if (ddEl) {
        var section = ddEl.getAttribute('data-drilldown');
        var param = ddEl.getAttribute('data-param') || '';
        var cardEl = ddEl.closest('.section-card');
        handleDrilldownClick(section, param, cardEl);
        return;
      }
```
new:
```
      var ddEl = e.target.closest('[data-drilldown]');
      if (ddEl) {
        var section = ddEl.getAttribute('data-drilldown');
        var param = ddEl.getAttribute('data-param') || '';
        var cardEl = ddEl.closest('.section-card') || document.querySelector('.section-card[data-section="' + section + '"]');
        handleDrilldownClick(section, param, cardEl);
        // If the click originated on a KPI tile, scroll the target section into view
        if (ddEl.classList.contains('kpi-card') && cardEl) {
          cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
```
- [ ] **Step 3: Syntax-check.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
```
Expected: `OK`.
- [ ] **Step 4: Re-run the UI test.**
```
npx vitest run tests/ceo-standalone-ui.test.js -t "KPI tiles clickable"
```
Expected: PASS for "makes KPI tiles clickable via data-drilldown".
- [ ] **Step 5: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "feat(ceo): wire clickable KPI tiles to drilldowns + flow-worded trends (#24,#16,#25,#17)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.4: Relabel VA→RSO in Workload section + drilldown by rso_id (#33-label, #7/#32/#34 UI side)
**Files:** `pages/ceo-dashboard.html` (`renderVAWorkloadSection` 1242–1259, section grid caller 1073, drilldown actions 1451, `ddField` 1469)

- [ ] **Step 1: Rewrite the workload section to read contract field names and drill by `rso_id`.** Replace `renderVAWorkloadSection` (lines 1242–1259).

old:
```
    /* ── VA Workload ── */
    function renderVAWorkloadSection(vas) {
      if (!vas) return '';
      if (vas.length === 0) return sectionCard('va', '&#x1F464;', 'VA Workload', '<div style="padding:12px 0;font-size:12px;color:var(--text-dim)">No VAs assigned yet</div>');
      var maxCases = 1;
      for (var i = 0; i < vas.length; i++) { if (vas[i].case_count > maxCases) maxCases = vas[i].case_count; }
      var html = '';
      for (var j = 0; j < vas.length; j++) {
        var v = vas[j];
        var pct = maxCases > 0 ? Math.round(v.case_count / maxCases * 100) : 0;
        html += '<div class="va-row" data-drilldown="va" data-param="va_email=' + encodeURIComponent(v.va_email || '') + '">';
        html += '<span class="va-name" title="' + esc(v.va_email) + '">' + esc(v.va_name) + '</span>';
        html += '<div class="va-bar-wrap"><div class="va-bar" style="width:' + pct + '%"></div></div>';
        html += '<span class="va-stats">' + v.case_count + ' cases' + (v.overdue_tasks > 0 ? ' <span class="overdue">' + v.overdue_tasks + ' OD</span>' : '') + '</span>';
        html += '</div>';
      }
      return sectionCard('va', '&#x1F464;', 'VA Workload', html);
    }
```
new:
```
    /* ── RSO Workload ── */
    function renderRsoWorkloadSection(rsos) {
      if (!rsos) return '';
      if (rsos.length === 0) return sectionCard('rso', '&#x1F464;', 'RSO Workload', '<div style="padding:12px 0;font-size:12px;color:var(--text-dim)">No RSOs assigned yet</div>');
      var maxCases = 1;
      for (var i = 0; i < rsos.length; i++) { if (rsos[i].case_count > maxCases) maxCases = rsos[i].case_count; }
      var html = '';
      for (var j = 0; j < rsos.length; j++) {
        var v = rsos[j];
        var pct = maxCases > 0 ? Math.round(v.case_count / maxCases * 100) : 0;
        html += '<div class="va-row" data-drilldown="rso" data-param="rso_id=' + encodeURIComponent(v.rso_id || '') + '">';
        html += '<span class="va-name">' + esc(v.rso_name) + '</span>';
        html += '<div class="va-bar-wrap"><div class="va-bar" style="width:' + pct + '%"></div></div>';
        html += '<span class="va-stats">' + v.case_count + ' cases' + (v.overdue_tasks > 0 ? ' <span class="overdue">' + v.overdue_tasks + ' OD</span>' : '') + '</span>';
        html += '</div>';
      }
      return sectionCard('rso', '&#x1F464;', 'RSO Workload', html);
    }
```
Notes: section id changes from `va` to `rso` so the drilldown URL becomes `/api/ceo/drilldown/rso` (matches the contract's `rsoCaseIds`/section `rso`). `rso_id` is sent (never an empty email), so the `__unassigned__` row drills correctly (#32). The `.va-row`/`.va-bar` CSS classes are reused unchanged (purely cosmetic).

- [ ] **Step 2: Update the section-grid caller.** Replace line 1073.

old:
```
      html += renderVAWorkloadSection(data.va_workload);
```
new:
```
      html += renderRsoWorkloadSection(data.va_workload);
```
(The dashboard response key stays `va_workload` per the contract — only the user-facing labels change. If W3 renames the response key to `rso_workload`, change `data.va_workload` to `data.rso_workload ?? data.va_workload`.)

- [ ] **Step 3: Relabel the "Reassign VA" drilldown action button.** Replace line 1451.

old:
```
          html += '<button class="btn btn-amber" onclick="openReassignModal(\'' + esc(caseId) + '\')">Reassign VA</button>';
```
new:
```
          html += '<button class="btn btn-amber" onclick="openReassignModal(\'' + esc(caseId) + '\')">Reassign RSO</button>';
```
- [ ] **Step 4: Relabel the "Assigned VA" drilldown field.** Replace line 1469 in `ddField`.

old:
```
      if (item.assigned_va) fields.push(['Assigned VA', item.assigned_va]);
```
new:
```
      if (item.assigned_rso || item.assigned_va) fields.push(['Assigned RSO', item.assigned_rso || item.assigned_va]);
```
- [ ] **Step 5: Exclude `rso`/`tasks` from header-only drilldown if needed.** The section-header click handler (lines 1759–1768) calls `handleDrilldownClick(sec, '', card)` for any section except velocity/completions. For section `rso`, an empty param means "all RSOs" — the `rso` drilldown branch (built in W3) must tolerate an empty `rso_id`; no UI change needed, leave as-is.
- [ ] **Step 6: Syntax-check + run test.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
npx vitest run tests/ceo-standalone-ui.test.js -t "relabels all user-facing VA"
```
Expected: prints `OK`; test PASS for "relabels all user-facing VA to RSO".
- [ ] **Step 7: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "feat(ceo): RSO Workload relabel + drill by rso_id (#33,#32,#7,#34)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.5: Replace free-text VA-ID reassign box with an RSO picker (#44)
**Files:** `pages/ceo-dashboard.html` (`openReassignModal` 1542–1547, `submitReassign` 1549–1561)

The current modal asks the CEO to hand-type a UUID into `mVaId` and PUTs `{assigned_va: vaId}`. Replace it with a `<select>` populated from `GET /api/ceo/rsos`, PUT `{assigned_rso}` (server sets the mailbox in lock-step + runs Gmail transfer, per the contract's `PUT /api/admin/case` extension in W3).

- [ ] **Step 1: Add an RSO roster cache + loader.** Insert just above `openReassignModal` (line 1542).
```js
    /* RSO roster cache (from /api/ceo/rsos) — populated lazily, refreshed on dashboard load */
    var rsoRosterCache = null;
    function loadRsoRoster() {
      if (rsoRosterCache) return Promise.resolve(rsoRosterCache);
      return apiFetch('/api/ceo/rsos').then(function(d) {
        rsoRosterCache = (d && d.ok && Array.isArray(d.rsos)) ? d.rsos : [];
        return rsoRosterCache;
      }).catch(function() { rsoRosterCache = []; return rsoRosterCache; });
    }
```
- [ ] **Step 2: Rewrite the reassign modal to render a `<select>`.** Replace `openReassignModal` (lines 1542–1547).

old:
```
    /* Reassign VA */
    function openReassignModal(caseId) {
      var html = '<div class="modal-title">Reassign VA</div>';
      html += '<div class="modal-field"><label class="modal-label">VA User ID</label><input class="modal-input" id="mVaId" placeholder="Enter VA user ID..." /></div>';
      html += '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-amber" id="mReassignSubmit" onclick="submitReassign(\'' + esc(caseId) + '\')">Reassign</button></div>';
      openModal(html);
    }
```
new:
```
    /* Reassign RSO */
    function openReassignModal(caseId) {
      var html = '<div class="modal-title">Reassign RSO</div>';
      html += '<div class="modal-field"><label class="modal-label">RSO</label><select class="modal-select" id="mRsoSelect"><option value="">Loading RSOs...</option></select></div>';
      html += '<div class="modal-note" style="font-size:11px;color:var(--text-dim);margin:-4px 0 12px">Reassigning transfers the GP\'s email threads to the new RSO\'s mailbox.</div>';
      html += '<div class="modal-actions"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-amber" id="mReassignSubmit" onclick="submitReassign(\'' + esc(caseId) + '\')">Reassign</button></div>';
      openModal(html);
      loadRsoRoster().then(function(rsos) {
        var sel = document.getElementById('mRsoSelect');
        if (!sel) return;
        if (!rsos.length) { sel.innerHTML = '<option value="">No RSOs available</option>'; return; }
        var opts = '<option value="">— Select RSO —</option>';
        for (var i = 0; i < rsos.length; i++) {
          var r = rsos[i];
          if (r.active === false) continue;
          opts += '<option value="' + esc(r.rso_id) + '">' + esc(r.rso_name) + (r.email ? ' (' + esc(r.email) + ')' : '') + '</option>';
        }
        sel.innerHTML = opts;
      });
    }
```
- [ ] **Step 3: Rewrite `submitReassign` to PUT `assigned_rso` and surface the transfer error clearly.** Replace lines 1549–1561.

old:
```
    function submitReassign(caseId) {
      var vaId = document.getElementById('mVaId').value.trim();
      if (!vaId) { showToast('VA user ID required', 'error'); return; }
      var btn = document.getElementById('mReassignSubmit');
      btn.disabled = true;
      apiFetch('/api/admin/case?id=' + encodeURIComponent(caseId), {
        method: 'PUT',
        body: { assigned_va: vaId }
      }).then(function(d) {
        if (d.ok) { showToast('VA reassigned', 'success'); closeModal(); refreshDashboard(); }
        else { showToast('Failed: ' + (d.message || ''), 'error'); btn.disabled = false; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; });
    }
```
new:
```
    function submitReassign(caseId) {
      var sel = document.getElementById('mRsoSelect');
      var rsoId = sel ? sel.value : '';
      if (!rsoId) { showToast('Select an RSO', 'error'); return; }
      var btn = document.getElementById('mReassignSubmit');
      btn.disabled = true;
      btn.textContent = 'Reassigning...';
      apiFetch('/api/admin/case?id=' + encodeURIComponent(caseId), {
        method: 'PUT',
        body: { assigned_rso: rsoId }
      }).then(function(d) {
        if (d.ok) { showToast('RSO reassigned & email transferred', 'success'); closeModal(); refreshDashboard(); }
        else { showToast('Failed: ' + (d.message || 'Reassign failed'), 'error'); btn.disabled = false; btn.textContent = 'Reassign'; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; btn.textContent = 'Reassign'; });
    }
```
- [ ] **Step 4: Prime the roster cache on dashboard load** so the dropdown opens instantly. In the init block (lines 1827–1830) add `loadRsoRoster()` to the parallel loads.

old:
```
        Promise.all([
          refreshDashboard(),
          refreshTrends()
        ]).then(function() {
```
new:
```
        Promise.all([
          refreshDashboard(),
          refreshTrends(),
          loadRsoRoster()
        ]).then(function() {
```
- [ ] **Step 5: Syntax-check + run test.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
npx vitest run tests/ceo-standalone-ui.test.js -t "RSO <select>"
```
Expected: `OK`; test PASS for "reassign modal uses an RSO <select>".
- [ ] **Step 6: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "feat(ceo): RSO picker dropdown replaces free-text VA-ID reassign (#44)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.6: Fix Set Blocker, Add Note, Task Health, milestone labels, single days label (#4/#19, #64, #59, #41/#57/#58)
**Files:** `pages/ceo-dashboard.html` (Set Blocker 1589–1618, Add Note 1648–1669, Task Health 1224–1234, milestone render 1360–1366, blocker render 1209–1216, drilldown labels 1466–1500)

- [ ] **Step 1: Remove the invalid "Blocked" option from Set Blocker (#4/#19).** The DB CHECK on `blocker_status` permits only `waiting_on_gp|waiting_on_practice|waiting_on_external|null`; sending `blocker_status:'blocked'` fails the constraint. Remove the option. Replace lines 1591–1597.

old:
```
      html += '<div class="modal-field"><label class="modal-label">Blocker Status</label><select class="modal-select" id="mBlockerStatus">';
      html += '<option value="waiting_on_gp">Waiting on GP</option>';
      html += '<option value="waiting_on_practice">Waiting on Practice</option>';
      html += '<option value="waiting_on_external">Waiting on External</option>';
      html += '<option value="blocked">Blocked</option>';
      html += '<option value="">Clear Blocker</option>';
      html += '</select></div>';
```
new:
```
      html += '<div class="modal-field"><label class="modal-label">Blocker Status</label><select class="modal-select" id="mBlockerStatus">';
      html += '<option value="waiting_on_gp">Waiting on GP</option>';
      html += '<option value="waiting_on_practice">Waiting on Practice</option>';
      html += '<option value="waiting_on_external">Waiting on External</option>';
      html += '<option value="">Clear Blocker</option>';
      html += '</select></div>';
```
The existing `submitBlocker` (lines 1603–1618) already sets `status:'blocked'` when a blocker_status is chosen and `status:'active'` when cleared — that remains correct and now never sends `blocker_status:'blocked'`.

- [ ] **Step 2: Make Add Note honor `taskId` (#64).** The current `submitNote` builds the same case URL in both branches (the `if (taskId)` is a no-op). Post to the task-note endpoint when a taskId is present. Replace `submitNote` (lines 1655–1669).

old:
```
    function submitNote(caseId, taskId) {
      var text = document.getElementById('mNoteText').value.trim();
      if (!text) { showToast('Note text required', 'error'); return; }
      var btn = document.getElementById('mNoteSubmit');
      btn.disabled = true;
      var url = '/api/admin/case/note?id=' + encodeURIComponent(caseId);
      if (taskId) url = '/api/admin/case/note?id=' + encodeURIComponent(caseId);
      apiFetch(url, {
        method: 'POST',
        body: { text: text }
      }).then(function(d) {
        if (d.ok) { showToast('Note added', 'success'); closeModal(); }
        else { showToast('Failed: ' + (d.message || ''), 'error'); btn.disabled = false; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; });
    }
```
new:
```
    function submitNote(caseId, taskId) {
      var text = document.getElementById('mNoteText').value.trim();
      if (!text) { showToast('Note text required', 'error'); return; }
      var btn = document.getElementById('mNoteSubmit');
      btn.disabled = true;
      var url, body;
      if (taskId) {
        url = '/api/admin/task/note?id=' + encodeURIComponent(taskId);
        body = { text: text };
      } else {
        url = '/api/admin/case/note?id=' + encodeURIComponent(caseId);
        body = { text: text };
      }
      apiFetch(url, { method: 'POST', body: body }).then(function(d) {
        if (d.ok) { showToast('Note added', 'success'); closeModal(); }
        else { showToast('Failed: ' + (d.message || ''), 'error'); btn.disabled = false; }
      }).catch(function(e) { showToast('Error: ' + e.message, 'error'); btn.disabled = false; });
    }
```
(`/api/admin/task/note` exists at server.js:30564 per the audit; if its query param is named differently, the W4 phase confirms — the contract treats `?id=<taskId>` as the task id.)

- [ ] **Step 3: Render In Progress on Task Health (#59).** Add an In Progress cell. Replace `renderTaskHealthSection` (lines 1225–1234).

old:
```
    function renderTaskHealthSection(th) {
      if (!th) return '';
      var html = '<div class="task-grid">';
      html += taskCell(fmtNum(th.open), 'Open', 'var(--blue)');
      html += taskCell(fmtNum(th.completed_this_week), 'Done This Week', 'var(--green)');
      html += taskCell(fmtNum(th.overdue), 'Overdue', th.overdue > 0 ? 'var(--red)' : 'var(--text)');
      html += taskCell(th.avg_resolve_days != null ? th.avg_resolve_days.toFixed(1) + 'd' : '--', 'Avg Resolve', 'var(--text)');
      html += '</div>';
      return sectionCard('tasks', '&#x2705;', 'Task Health', html);
    }
```
new:
```
    function renderTaskHealthSection(th) {
      if (!th) return '';
      var html = '<div class="task-grid">';
      html += taskCell(fmtNum(th.open), 'Open', 'var(--blue)');
      html += taskCell(fmtNum(th.in_progress), 'In Progress', 'var(--amber)');
      html += taskCell(fmtNum(th.completed_this_week), 'Done This Week', 'var(--green)');
      html += taskCell(fmtNum(th.overdue), 'Overdue', th.overdue > 0 ? 'var(--red)' : 'var(--text)');
      html += taskCell(th.avg_resolve_days != null ? th.avg_resolve_days.toFixed(1) + 'd' : '--', 'Avg Resolve', 'var(--text)');
      html += '</div>';
      return sectionCard('tasks', '&#x2705;', 'Task Health', html);
    }
```
- [ ] **Step 4: Humanize milestone labels (#41).** The completions endpoint (W2 phase) now returns a humanized `milestone` string, but the UI also receives raw `milestone` for older rows. Add a client-side fallback humanizer. In `renderCompletionsSection` replace line 1364.

old:
```
        html += '<div class="milestone-text"><strong>' + esc(m.gp_name) + '</strong> ' + esc(m.milestone) + '</div>';
```
new:
```
        html += '<div class="milestone-text"><strong>' + esc(m.gp_name) + '</strong> ' + esc(humanizeMilestone(m.milestone)) + '</div>';
```
Then add the helper just before `renderCompletionsSection` (line 1348):
```js
    function humanizeMilestone(text) {
      if (!text) return 'reached a milestone';
      // Map raw "Stage advanced to amc" / "amc" slugs to friendly stage labels
      var m = String(text).match(/(?:advanced to|reached|stage[:\s]+)\s*([a-z_]+)/i);
      var slug = m ? m[1].toLowerCase() : String(text).trim().toLowerCase();
      if (STAGE_LABELS[slug]) return 'reached ' + STAGE_LABELS[slug];
      if (slug === 'complete') return 'completed registration';
      return text; // already humanized server-side
    }
```
- [ ] **Step 5: Single "Days" label across blocker card + drilldown (#57/#58).** The card shows `Days in Stage` (line 1214) and the drilldown shows both `Days in Stage` and `Days Stuck` (1470–1471) — same value, two labels. Standardize on a single "Days Blocked" label fed by the contract field `days_blocked` (from `computeBlockers`, #5). Apply the visa→pbs stage remap in the drilldown too (#58).

In `renderBlockersSection` replace line 1214.

old:
```
          rows += '<span class="blocker-days">' + fmtDays(b.days_in_stage) + '</span>';
```
new:
```
          rows += '<span class="blocker-days" title="Days blocked">' + fmtDays(b.days_blocked != null ? b.days_blocked : b.days_in_stage) + '</span>';
```
In `ddField` replace lines 1470–1471.

old:
```
      if (item.days_in_stage != null) fields.push(['Days in Stage', item.days_in_stage + 'd']);
      if (item.days_stuck != null) fields.push(['Days Stuck', item.days_stuck + 'd']);
```
new:
```
      if (item.days_blocked != null) fields.push(['Days Blocked', item.days_blocked + 'd']);
      else if (item.days_in_stage != null) fields.push(['Days Blocked', item.days_in_stage + 'd']);
```
- [ ] **Step 6: Centralize the visa→pbs stage label in the drilldown (#58).** In `renderDrilldownItems` replace line 1437.

old:
```
        if (item.stage) html += '<span class="pill ' + pillClass(item.stage) + '">' + esc(STAGE_LABELS[item.stage] || item.stage) + '</span> ';
```
new:
```
        if (item.stage) { var ddStage = item.stage === 'visa' ? 'pbs' : item.stage; html += '<span class="pill ' + pillClass(ddStage) + '">' + esc(STAGE_LABELS[ddStage] || ddStage) + '</span> '; }
```
- [ ] **Step 7: Syntax-check + run tests.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
npx vitest run tests/ceo-standalone-ui.test.js -t "Blocked"
npx vitest run tests/ceo-standalone-ui.test.js -t "Add Note posts"
npx vitest run tests/ceo-standalone-ui.test.js -t "In Progress"
```
Expected: `OK`; all three named cases PASS.
- [ ] **Step 8: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "fix(ceo): blocker option, task-note routing, in_progress cell, milestone+days labels (#4,#19,#64,#59,#41,#57,#58)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.7: RSO oversight UI — list all RSOs and drill into each RSO's GPs (#22/#23 consumer, #7/#32)
**Files:** `pages/ceo-dashboard.html` (new CSS ~833, new `loadRsoOversight`/`renderRsoOversight`/`openRsoDetail` functions before INIT 1822)

Consumes `GET /api/ceo/rsos` (roster + aggregated metrics) and `GET /api/ceo/rso/:id/summary` (the GPs under one RSO), both built in W3. Rendered into the `#rsoContent` container added in Task 8.2.

- [ ] **Step 1: Add oversight CSS** just before the `/* ═══ RESPONSIVE ═══ */` marker (line 834).
```
    /* ═══ RSO OVERSIGHT ═══ */
    .rso-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
    .rso-card { background: var(--panel); border: 1px solid var(--panel-border); border-radius: var(--radius-lg); padding: 18px; cursor: pointer; transition: all 0.15s; }
    .rso-card:hover { border-color: var(--panel-border-hover); transform: translateY(-1px); }
    .rso-card.inactive { opacity: 0.55; }
    .rso-card-name { font-size: 15px; font-weight: 700; }
    .rso-card-email { font-size: 12px; color: var(--text-dim); margin-top: 2px; word-break: break-all; }
    .rso-card-stats { display: flex; gap: 18px; margin-top: 14px; }
    .rso-card-stat { display: flex; flex-direction: column; }
    .rso-card-stat-value { font-size: 20px; font-weight: 700; font-family: var(--mono); }
    .rso-card-stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); }
    .rso-detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .rso-detail-back { font-size: 13px; color: var(--text-muted); cursor: pointer; }
    .rso-detail-back:hover { color: var(--text); }
    .rso-gp-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--panel-border); }
    .rso-gp-row .name { font-weight: 600; flex: 1; }
```
- [ ] **Step 2: Add the oversight render/load functions** just before the `/* ═══ INIT ═══ */` block (line 1822).
```js
    /* ═══ RSO OVERSIGHT (standalone tab) ═══ */
    function loadRsoOversight() {
      var c = document.getElementById('rsoContent');
      c.innerHTML = '<div class="drilldown-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px;margin:24px auto"></div><div style="text-align:center">Loading RSOs...</div></div>';
      apiFetch('/api/ceo/rsos').then(function(d) {
        if (!d || !d.ok) { c.innerHTML = '<div class="drilldown-empty">Failed to load RSOs: ' + esc((d && d.message) || 'Unknown error') + '</div>'; return; }
        rsoRosterCache = Array.isArray(d.rsos) ? d.rsos : [];
        renderRsoOversight(d.rsos || []);
      }).catch(function(e) { c.innerHTML = '<div class="drilldown-empty">Error: ' + esc(e.message) + '</div>'; });
    }

    function renderRsoOversight(rsos) {
      var c = document.getElementById('rsoContent');
      if (!rsos.length) { c.innerHTML = '<div class="drilldown-empty">No RSOs found.</div>'; return; }
      var html = '<h2 style="font-size:16px;font-weight:700;margin-bottom:14px">RSO Oversight</h2><div class="rso-grid">';
      for (var i = 0; i < rsos.length; i++) {
        var r = rsos[i];
        html += '<div class="rso-card' + (r.active === false ? ' inactive' : '') + '" data-rso-id="' + esc(r.rso_id) + '">';
        html += '<div class="rso-card-name">' + esc(r.rso_name) + (r.active === false ? ' <span style="font-size:10px;color:var(--text-dim)">(inactive)</span>' : '') + '</div>';
        if (r.email) html += '<div class="rso-card-email">' + esc(r.email) + '</div>';
        html += '<div class="rso-card-stats">';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value">' + (r.case_count || 0) + '</span><span class="rso-card-stat-label">GPs</span></div>';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value">' + (r.open_tasks || 0) + '</span><span class="rso-card-stat-label">Open</span></div>';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value" style="color:' + ((r.overdue_tasks || 0) > 0 ? 'var(--red)' : 'var(--text)') + '">' + (r.overdue_tasks || 0) + '</span><span class="rso-card-stat-label">Overdue</span></div>';
        html += '</div></div>';
      }
      html += '</div>';
      c.innerHTML = html;
    }

    function openRsoDetail(rsoId) {
      var c = document.getElementById('rsoContent');
      c.innerHTML = '<div class="drilldown-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px;margin:24px auto"></div><div style="text-align:center">Loading RSO...</div></div>';
      apiFetch('/api/ceo/rso/' + encodeURIComponent(rsoId) + '/summary').then(function(d) {
        if (!d || !d.ok) { c.innerHTML = '<div class="drilldown-empty">Failed: ' + esc((d && d.message) || 'Unknown error') + '</div>'; return; }
        var rso = d.rso || {};
        var gps = d.gps || [];
        var tc = d.task_counts || {};
        var html = '<div class="rso-detail-head"><span class="rso-detail-back" onclick="loadRsoOversight()">&#x2190; All RSOs</span>';
        html += '<h2 style="font-size:16px;font-weight:700">' + esc(rso.rso_name || rso.name || 'RSO') + '</h2></div>';
        html += '<div class="rso-card-stats" style="margin-bottom:16px">';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value">' + gps.length + '</span><span class="rso-card-stat-label">GPs</span></div>';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value">' + (tc.open || 0) + '</span><span class="rso-card-stat-label">Open Tasks</span></div>';
        html += '<div class="rso-card-stat"><span class="rso-card-stat-value" style="color:' + ((tc.overdue || 0) > 0 ? 'var(--red)' : 'var(--text)') + '">' + (tc.overdue || 0) + '</span><span class="rso-card-stat-label">Overdue</span></div>';
        html += '</div>';
        if (!gps.length) { html += '<div class="drilldown-empty">No GPs assigned to this RSO.</div>'; }
        else {
          html += '<div class="rso-gp-list">';
          for (var i = 0; i < gps.length; i++) {
            var g = gps[i];
            var gStage = g.stage === 'visa' ? 'pbs' : g.stage;
            html += '<div class="rso-gp-row">';
            html += '<span class="name">' + esc(g.gp_name || 'Unknown') + (g.gp_email ? ' <span style="color:var(--text-dim);font-weight:400">' + esc(g.gp_email) + '</span>' : '') + '</span>';
            if (gStage) html += '<span class="pill ' + pillClass(gStage) + '">' + esc(STAGE_LABELS[gStage] || gStage) + '</span>';
            if (g.status) html += statusPill(g.status);
            html += '<button class="btn btn-amber" onclick="openReassignModal(\'' + esc(g.case_id) + '\')">Reassign RSO</button>';
            html += '</div>';
          }
          html += '</div>';
        }
        c.innerHTML = html;
      }).catch(function(e) { c.innerHTML = '<div class="drilldown-empty">Error: ' + esc(e.message) + '</div>'; });
    }
```
- [ ] **Step 3: Wire RSO card clicks.** Extend the existing document click delegation. Insert this branch at the top of the click handler body (right after the `function(e) {` opening at line 1747).

old:
```
    document.addEventListener('click', function(e) {
      // Drilldown clicks on funnel rows, placement cells, activity buckets, VA rows
      var ddEl = e.target.closest('[data-drilldown]');
```
new:
```
    document.addEventListener('click', function(e) {
      // RSO oversight card -> RSO detail
      var rsoCard = e.target.closest('.rso-card[data-rso-id]');
      if (rsoCard) { openRsoDetail(rsoCard.getAttribute('data-rso-id')); return; }

      // Drilldown clicks on funnel rows, placement cells, activity buckets, RSO rows
      var ddEl = e.target.closest('[data-drilldown]');
```
- [ ] **Step 4: Syntax-check + run test.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
npx vitest run tests/ceo-standalone-ui.test.js -t "RSO oversight panel"
```
Expected: `OK`; test PASS for "RSO oversight panel + endpoints are wired".
- [ ] **Step 5: Commit.**
```
git add pages/ceo-dashboard.html && git commit -m "feat(ceo): RSO oversight panel — list RSOs, drill into each RSO's GPs (#22,#23,#7,#32)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.8: Strip the dead CEO iframe + Home Dashboard tab from admin.html (#W0, admin_ceo_tabs)
**Files:** `pages/admin.html` (view-tabs 1307, iframe panel 1451, `renderAdminView` 2017–2022, tab-click 5688–5690, panel map 7112, SA init 8344–8345)

The CEO dashboard is now standalone; admin.html must stop hosting it via iframe and instead link out to it.

- [ ] **Step 1: Replace the embedded "Home Dashboard" tab with an external link.** Replace line 1307.

old:
```
    <div class="view-tab" data-view="ceo-home" id="ceoHomeTab" style="display:none">Home Dashboard</div>
```
new:
```
    <a class="view-tab" id="ceoHomeTab" href="/pages/ceo-dashboard" style="display:none;text-decoration:none">CEO Command Centre &#x2197;</a>
```
- [ ] **Step 2: Remove the iframe panel.** Delete line 1451 entirely.

old:
```
<div id="ceoHomePanel" style="display:none;position:relative;width:100%;height:calc(100vh - 100px);"><iframe id="ceoHomeIframe" style="width:100%;height:100%;border:none;background:#0f1117;" src="about:blank"></iframe></div>
```
new:
```
```
(line removed)

- [ ] **Step 3: Remove the ceo-home branch in `renderAdminView`.** Replace lines 2017–2022.

old:
```
    if(S.view==="ceo-home"){
      vaShowPanel("ceo-home");
      var iframe=document.getElementById("ceoHomeIframe");
      if(iframe&&!iframe.src.includes("ceo-dashboard"))iframe.src="/pages/ceo-dashboard";
      return;
    }
```
new:
```
```
(block removed — the `<a>` tab navigates by href so no JS view-switch is needed)

- [ ] **Step 4: Remove the ceo-home branch in the tab-click handler.** Replace lines 5688–5690.

old:
```
      }else if(view==="ceo-home"){
        var iframe=document.getElementById("ceoHomeIframe");
        if(iframe&&!iframe.src.includes("ceo-dashboard")){iframe.src="/pages/ceo-dashboard";}
      }else if(view==="technical"){
```
new:
```
      }else if(view==="technical"){
```
(Note: the `<a>` tab no longer has `data-view`, so the `closest("[data-view]")` guard at line 5670 simply ignores it and the browser follows the href — verify the tab-click handler returns early on elements without `data-view`, which it does via `if(!tab)return`. The anchor has no `data-view`, so `tab` is null and the handler exits before preventing default navigation.)

- [ ] **Step 5: Remove the ceo-home entry from the panel map.** Replace line 7112.

old:
```
    const panels={"inboxPanel":"inbox","medicalCentresPanel":"medicalcentres","supportPanel":"support","toolsPanel":"tools","ceoHomePanel":"ceo-home","technicalPanel":"technical","guidePanel":"guide","scheduledCallsPanel":"scheduled_calls"};
```
new:
```
    const panels={"inboxPanel":"inbox","medicalCentresPanel":"medicalcentres","supportPanel":"support","toolsPanel":"tools","technicalPanel":"technical","guidePanel":"guide","scheduledCallsPanel":"scheduled_calls"};
```
- [ ] **Step 6: Keep the SA-only reveal of the link tab (8344–8345).** The init reveal still applies — the `<a id="ceoHomeTab">` is hidden by default and shown for super admins. No change needed there, but confirm the reveal sets `display=""` (it does: `if(ceoTab)ceoTab.style.display="";`). Leave lines 8344–8345 as-is.
- [ ] **Step 7: Verify no remaining references.**
```
grep -n "ceo-home\|ceoHomeIframe\|ceoHomePanel" pages/admin.html
```
Expected: only the SA-reveal line 8344 referencing `ceoHomeTab` remains; no `ceo-home` / `ceoHomeIframe` / `ceoHomePanel` matches.
- [ ] **Step 8: Run test.**
```
npx vitest run tests/ceo-standalone-ui.test.js -t "admin.html no longer ships"
```
Expected: PASS for "admin.html no longer ships the CEO iframe or Home Dashboard tab".
- [ ] **Step 9: Commit.**
```
git add pages/admin.html && git commit -m "refactor(admin): drop embedded CEO iframe + ceo-home tab; link to standalone page (#W0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8.9: Full UI suite green + relabel sweep verification
**Files:** `tests/ceo-standalone-ui.test.js`, `pages/ceo-dashboard.html`

- [ ] **Step 1: Run the complete Phase-8 UI test file.**
```
npx vitest run tests/ceo-standalone-ui.test.js
```
Expected: PASS — all 9 cases green.
- [ ] **Step 2: Confirm no stray "VA" user-facing strings remain on the CEO page.** Grep for residual labels (the internal `assigned_va` field name is allowed; user-visible "VA" words are not).
```
grep -niE "VA Workload|Reassign VA|Assigned VA|No VAs|VA User ID|Send Nudge.*VA" pages/ceo-dashboard.html
```
Expected: no matches.
- [ ] **Step 3: Confirm the inline script still parses after all edits.**
```
/tmp/node-v20.19.6-darwin-arm64/bin/node -e "const fs=require('fs');const s=fs.readFileSync('pages/ceo-dashboard.html','utf8');const m=s.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);require('vm').compileFunction(m[1]);console.log('OK')"
```
Expected: `OK`.
- [ ] **Step 4: Run the whole test suite to confirm no regression.**
```
npm test
```
Expected: PASS (no new failures introduced by the UI/admin edits).
- [ ] **Step 5: Commit any final touch-ups.**
```
git add -A && git commit -m "test(ceo): full standalone UI suite green; VA->RSO relabel verified (#W0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
```
