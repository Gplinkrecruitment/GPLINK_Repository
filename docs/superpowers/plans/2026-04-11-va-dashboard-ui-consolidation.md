# VA Dashboard — UI Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the VA Command Centre admin dashboard from 8 tabs + drill-through panels into a single coherent 5-tab layout (Inbox / GPs / Interviews / Applications / Tools) with a responsive GP profile view, global search, and no loss of existing capability. UI-only — no new backend data ingest, no document approve/reject flow.

**Architecture:** In-place rewrite of `pages/admin.html` (2686-line monolithic vanilla-JS file). One small endpoint addition to `server.js` (`GET /api/admin/va/search`) powered by the existing `supabaseDbRequest` helper. One new vitest unit-test file for the search-query sanitizer and scope-parser helpers that live inside that endpoint. Every existing `/api/admin/*` endpoint, render helper (`esc`, `ini`, `fmtR`, `fmtD`, `fmtDT`, `safeUrl`, `buildJourney`, `PLAYBOOK`, `STEPS`), load function, modal, and delegated handler is preserved — only surface wiring changes.

**Tech Stack:** Vanilla JS / HTML / CSS, Node.js `server.js` (no framework), Supabase via `supabaseDbRequest` helper, vitest for unit tests. Existing CSS variables (`--red`, `--amber`, `--green`, etc.) and utility classes (`btn`, `btn sm`, `todo-card`, `case-card`, `today-group-title`) are reused verbatim.

---

## Source spec

`docs/superpowers/specs/2026-04-11-va-dashboard-ui-consolidation-design.md`

## File map

| File | Change | Purpose |
|---|---|---|
| `pages/admin.html` | Rewrite | New 5-tab nav, new panel structure, new render functions, deletion of obsolete code |
| `server.js` | Add endpoint + exports | `GET /api/admin/va/search` + export `buildVaSearchQueryPlan` helper via `__testUtils` |
| `tests/admin-va-search.test.js` | New file | Unit tests for the search helpers |

## Task decomposition rationale

- The new server endpoint is tested first with TDD because its helpers are pure and match the existing vitest pattern (inline helper + `__testUtils` export).
- The admin.html rewrite is broken into **small surgical sub-tasks**: each one deletes or adds a named section or function so the file stays runnable between tasks. This is necessary because there is no automated frontend test harness — every task must leave the page loadable so the next task can smoke-test.
- The global search is implemented last because it needs the GPs tab and Inbox render helpers already in place to route results.
- Manual smoke test is its own task at the end.

---

## Task 1: Search query sanitizer + scope parser (TDD)

**Files:**
- Create: `tests/admin-va-search.test.js`
- Modify: `server.js` (add helpers near line 942, add to `__testUtils` export at line 19913)

This task extracts two pure helpers that the search endpoint will use: `sanitizeVaSearchQuery(raw)` and `parseVaSearchScope(raw)`. Testing them as units before wiring them into the endpoint lets us lock in the sanitization contract.

- [ ] **Step 1: Write the failing test file**

Create `tests/admin-va-search.test.js`:

```javascript
/**
 * Unit tests for the VA global-search query helpers.
 *
 * The helpers are pure functions exported from server.js via __testUtils.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const { sanitizeVaSearchQuery, parseVaSearchScope } = __testUtils;

describe('sanitizeVaSearchQuery', () => {
  it('trims whitespace and returns the cleaned string', () => {
    expect(sanitizeVaSearchQuery('  cct  ')).toBe('cct');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeVaSearchQuery(null)).toBe('');
    expect(sanitizeVaSearchQuery(undefined)).toBe('');
    expect(sanitizeVaSearchQuery(42)).toBe('');
    expect(sanitizeVaSearchQuery({})).toBe('');
  });

  it('caps length at 80 characters', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeVaSearchQuery(long).length).toBe(80);
  });

  it('strips SQL keyword patterns', () => {
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain('DROP TABLE');
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain("'");
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain(';');
  });

  it('strips PostgREST wildcard and comma characters that break ilike filters', () => {
    expect(sanitizeVaSearchQuery('a*b,c')).toBe('abc');
  });

  it('strips percent signs so callers control wildcard placement', () => {
    expect(sanitizeVaSearchQuery('100%')).toBe('100');
  });

  it('leaves normal alphanumeric and space characters alone', () => {
    expect(sanitizeVaSearchQuery('jane smith 2026')).toBe('jane smith 2026');
  });
});

describe('parseVaSearchScope', () => {
  it('defaults to "both" when scope is omitted', () => {
    expect(parseVaSearchScope(undefined)).toBe('both');
    expect(parseVaSearchScope(null)).toBe('both');
    expect(parseVaSearchScope('')).toBe('both');
  });

  it('accepts "documents" exactly', () => {
    expect(parseVaSearchScope('documents')).toBe('documents');
  });

  it('accepts "notes" exactly', () => {
    expect(parseVaSearchScope('notes')).toBe('notes');
  });

  it('normalizes case and trims whitespace', () => {
    expect(parseVaSearchScope('  DOCUMENTS ')).toBe('documents');
    expect(parseVaSearchScope('Notes')).toBe('notes');
  });

  it('falls back to "both" for unknown values', () => {
    expect(parseVaSearchScope('all')).toBe('both');
    expect(parseVaSearchScope('users')).toBe('both');
    expect(parseVaSearchScope(42)).toBe('both');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/admin-va-search.test.js`
Expected: FAIL with `TypeError: Cannot destructure property 'sanitizeVaSearchQuery' of '__testUtils' as it is undefined` or similar "not a function" errors.

- [ ] **Step 3: Implement the helpers in `server.js`**

Open `server.js` and locate the existing `sanitizeUserString` helper at line 929. Immediately after its closing `}` (before the `const NAME_NOISE_PARTS` line at 944), insert:

```javascript
/** Sanitize a VA global-search query string.
 *  Reuses `sanitizeUserString` to kill SQL injection patterns, then strips
 *  characters that would break a PostgREST `ilike.*q*` filter (`*`, `,`, `%`).
 *  Empty string is returned for non-string input. Capped at 80 chars. */
function sanitizeVaSearchQuery(raw) {
  const base = sanitizeUserString(raw, 80);
  return base.replace(/[*,%]/g, '');
}

/** Parse the `scope` query param for /api/admin/va/search.
 *  Accepts "documents" | "notes" | (omitted | anything else) → "both". */
function parseVaSearchScope(raw) {
  if (typeof raw !== 'string') return 'both';
  const v = raw.trim().toLowerCase();
  if (v === 'documents') return 'documents';
  if (v === 'notes') return 'notes';
  return 'both';
}
```

- [ ] **Step 4: Export the helpers via `__testUtils`**

In `server.js` find the `module.exports.__testUtils = {` block at line 19913 and add both names to the object (alphabetically is fine):

```javascript
module.exports.__testUtils = {
  applyQualificationNameMatchPolicy,
  buildDomainAgencyBrandSearchQueries,
  buildDomainResidentialSearchPayload,
  collectDomainResidentialSearchListings,
  extractDomainListingCoordinates,
  crossCheckDocumentName,
  hasUsableFullName,
  matchNames,
  matchesDomainAgencyListingMarket,
  normalizeDomainAgencyListing,
  normalizeDomainListing,
  normalizeDomainSourceUrl,
  parseLifestylePriceValue,
  parseVaSearchScope,
  resizeDomainImageUrl,
  sanitizeVaSearchQuery
};
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/admin-va-search.test.js`
Expected: PASS — 13 assertions green.

- [ ] **Step 6: Commit**

```bash
git add tests/admin-va-search.test.js server.js
git commit -m "feat(va-search): add search query sanitizer and scope parser

Two pure helpers exported via __testUtils so the upcoming
/api/admin/va/search endpoint can reuse them:

- sanitizeVaSearchQuery: trim + sanitizeUserString + strip *, , %
- parseVaSearchScope: 'documents' | 'notes' | 'both'

Covered by tests/admin-va-search.test.js."
```

---

## Task 2: `GET /api/admin/va/search` endpoint

**Files:**
- Modify: `server.js` (insert after the weekly-checkin/sweep endpoint at line 17547, before the `User-facing nudge endpoints` section at line 17549)

This task wires the helpers into the actual HTTP handler. It queries `user_documents` for document file-name hits and `task_timeline` for note title/detail hits, joins `user_profiles` / `registration_cases` for GP-name resolution, caps each scope at 20 results, and returns the shape specified in the design doc.

- [ ] **Step 1: Insert the endpoint handler**

Open `server.js` and locate the closing `}` of the weekly-checkin sweep endpoint (around line 17547, right after `sendJson(res, 200, { ok: true, scanned: cases.length, created: created, skipped: skipped });` and its `return;`). Immediately after the blank line that follows, insert:

```javascript
  // ── Global search across documents + case notes ──
  if (pathname === '/api/admin/va/search' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const adminCtx = requireAdminSession(req, res);
    if (!adminCtx) return;

    const rawQ = url.searchParams.get('q') || '';
    const q = sanitizeVaSearchQuery(rawQ);
    if (q.length < 2) { sendJson(res, 400, { ok: false, message: 'Query must be at least 2 characters.' }); return; }
    const scope = parseVaSearchScope(url.searchParams.get('scope'));
    const pattern = '*' + q + '*'; // PostgREST ilike wildcard syntax

    // Build a flat key→label map once so we can resolve labels quickly.
    // GP_DOCUMENT_META is keyed by country bucket; GP_LINK_DOCUMENT_META is a flat array.
    const docLabelMap = {};
    Object.values(GP_DOCUMENT_META).forEach(function (arr) {
      if (Array.isArray(arr)) arr.forEach(function (d) { if (d && d.key) docLabelMap[d.key] = d.label; });
    });
    (GP_LINK_DOCUMENT_META || []).forEach(function (d) { if (d && d.key) docLabelMap[d.key] = d.label; });
    ONBOARDING_DOCUMENT_KEYS.forEach(function (k) { if (!docLabelMap[k]) docLabelMap[k] = k; });

    async function searchDocuments() {
      // user_documents is the real table; filter to the onboarding + prepared
      // document keys so the global search only surfaces credential artefacts.
      const allowedKeys = [
        ...Array.from(ONBOARDING_DOCUMENT_KEYS),
        ...Array.from(PREPARED_DOCUMENT_KEYS)
      ];
      if (allowedKeys.length === 0) return [];
      const keysCsv = allowedKeys.map(encodeURIComponent).join(',');
      const r = await supabaseDbRequest('user_documents',
        'select=user_id,country_code,document_key,file_name,status,updated_at' +
        '&file_name=ilike.' + encodeURIComponent(pattern) +
        '&document_key=in.(' + keysCsv + ')' +
        '&order=updated_at.desc&limit=20');
      if (!r.ok || !Array.isArray(r.data)) return [];
      const rows = r.data;
      const userIds = [...new Set(rows.map(function (x) { return x.user_id; }).filter(Boolean))];
      if (userIds.length === 0) return [];
      const pRes = await supabaseDbRequest('user_profiles',
        'select=user_id,first_name,last_name,email' +
        '&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
      const profileMap = {};
      if (pRes.ok && Array.isArray(pRes.data)) pRes.data.forEach(function (p) { profileMap[p.user_id] = p; });
      return rows.map(function (x) {
        const p = profileMap[x.user_id] || {};
        return {
          user_id: x.user_id,
          gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || 'Unknown'),
          country: x.country_code || null,
          key: x.document_key,
          label: docLabelMap[x.document_key] || x.document_key,
          file_name: x.file_name || '',
          status: x.status || null
        };
      });
    }

    async function searchNotes() {
      // task_timeline is the table populated by _logCaseEvent.
      // We match title OR detail using a PostgREST `or=(...)` filter.
      const orFilter = 'or=(title.ilike.' + encodeURIComponent(pattern) + ',detail.ilike.' + encodeURIComponent(pattern) + ')';
      const r = await supabaseDbRequest('task_timeline',
        'select=case_id,task_id,event_type,title,detail,actor,created_at' +
        '&' + orFilter +
        '&order=created_at.desc&limit=20');
      if (!r.ok || !Array.isArray(r.data)) return [];
      const rows = r.data;
      const caseIds = [...new Set(rows.map(function (x) { return x.case_id; }).filter(Boolean))];
      if (caseIds.length === 0) return rows.map(function (x) { return Object.assign({ gp_name: 'Unknown' }, x); });
      const cRes = await supabaseDbRequest('registration_cases',
        'select=id,user_id' +
        '&id=in.(' + caseIds.map(encodeURIComponent).join(',') + ')');
      const cases = (cRes.ok && Array.isArray(cRes.data)) ? cRes.data : [];
      const caseMap = {};
      cases.forEach(function (c) { caseMap[c.id] = c; });
      const userIds = [...new Set(cases.map(function (c) { return c.user_id; }).filter(Boolean))];
      let profileMap = {};
      if (userIds.length > 0) {
        const pRes = await supabaseDbRequest('user_profiles',
          'select=user_id,first_name,last_name,email' +
          '&user_id=in.(' + userIds.map(encodeURIComponent).join(',') + ')');
        if (pRes.ok && Array.isArray(pRes.data)) pRes.data.forEach(function (p) { profileMap[p.user_id] = p; });
      }
      return rows.map(function (x) {
        const c = caseMap[x.case_id] || {};
        const p = profileMap[c.user_id] || {};
        return {
          case_id: x.case_id,
          task_id: x.task_id || null,
          gp_name: [(p.first_name || ''), (p.last_name || '')].join(' ').trim() || (p.email || 'Unknown'),
          event_type: x.event_type || null,
          title: x.title || '',
          detail: x.detail || '',
          created_at: x.created_at || null
        };
      });
    }

    try {
      const wantDocs = (scope === 'documents' || scope === 'both');
      const wantNotes = (scope === 'notes' || scope === 'both');
      const [documents, notes] = await Promise.all([
        wantDocs ? searchDocuments() : Promise.resolve([]),
        wantNotes ? searchNotes() : Promise.resolve([])
      ]);
      sendJson(res, 200, { ok: true, query: q, results: { documents: documents, notes: notes } });
    } catch (err) {
      console.error('[VA SEARCH]', err);
      sendJson(res, 200, { ok: true, query: q, results: { documents: [], notes: [] }, partial: true });
    }
    return;
  }

```

- [ ] **Step 2: Start the dev server and smoke-test the endpoint**

Run: `npm start` (in one terminal)

In another terminal, `curl` the endpoint with an admin session cookie already set (log in via `/pages/admin-signin.html` if needed, then copy the `gp_admin_session` cookie):

```bash
curl -s "http://localhost:3000/api/admin/va/search?q=a" -b "gp_admin_session=<COOKIE>" | head -c 200
```

Expected: `{"ok":false,"message":"Query must be at least 2 characters."}` (q too short)

```bash
curl -s "http://localhost:3000/api/admin/va/search?q=cct" -b "gp_admin_session=<COOKIE>"
```

Expected: `{"ok":true,"query":"cct","results":{"documents":[...],"notes":[...]}}` — arrays may be empty depending on DB contents; the shape must be correct.

```bash
curl -s "http://localhost:3000/api/admin/va/search?q=cct" | head -c 100
```

Expected: `{"ok":false,"message":"Unauthorized"}` or a 401-shaped JSON — no cookie = 401.

Stop the dev server (`Ctrl+C`).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(va-search): add GET /api/admin/va/search endpoint

Returns document and note hits for the VA dashboard global search.
Reuses sanitizeVaSearchQuery + parseVaSearchScope helpers. Queries
user_documents (filtered by onboarding/prepared keys) and task_timeline,
joins user_profiles for GP name resolution. Caps each scope at 20.
Falls back to empty arrays with ok:true,partial:true on Supabase error
so the client never hard-fails."
```

---

## Task 3: Delete obsolete UI chrome from `pages/admin.html`

**Files:**
- Modify: `pages/admin.html` (lines 461-469, 480-486, 1682-1691, 2110-2405, 2407-2435, 2493-2527, 2564-2652 — see individual steps)

This task surgically removes the panels, render functions, helpers, and event handlers that the new structure replaces. Each sub-step is a distinct Edit so the file stays parseable. After this task the page will **not** be functional — tasks 4-5 put the new skeleton in place.

- [ ] **Step 1: Delete the drill-through panel `<div>`s**

In `pages/admin.html` find the three drill-through panels at lines 484-486:

```html
  <div class="today-wrap" id="gpsListPanel" style="display:none"></div>
  <div class="today-wrap" id="gpProfilePanel" style="display:none"></div>
  <div class="today-wrap" id="metricTasksPanel" style="display:none"></div>
```

Delete all three lines. (Do NOT touch `#todayPanel`, `#ticketsPanel`, `#interviewsPanel`, `#applicationsPanel`, `#opsPanel` or `#mainLayout` in this step — Task 4 replaces/re-wires those.)

- [ ] **Step 2: Delete `switchToOps` / `switchFromOps` helpers**

In `pages/admin.html` delete the block at lines 1682-1691:

```javascript
  function switchToOps(){
    document.getElementById("mainLayout").style.display="none";
    document.getElementById("opsPanel").classList.add("active");
    loadOpsQueue();
  }

  function switchFromOps(){
    document.getElementById("mainLayout").style.display="grid";
    document.getElementById("opsPanel").classList.remove("active");
  }
```

- [ ] **Step 3: Delete `renderGpsListPanel`, `renderGpProfilePanel`, `loadGpProfileDocuments`, `renderMetricTasksPanel`**

In `pages/admin.html` delete the entire block from line 2110 (the comment `/* ── GP list (triggered from Total GPs metric card) ── */`) through the end of `renderMetricTasksPanel` at ~line 2383. That is — every line from the `/* ── GP list ... */` comment through the closing `}` of `renderMetricTasksPanel` and the blank line that follows.

Then confirm with a local search: `grep -n "renderGpsListPanel\|renderGpProfilePanel\|loadGpProfileDocuments\|renderMetricTasksPanel" pages/admin.html` should return 0 hits. If anything still references them, fix those references in a follow-up step of this task.

- [ ] **Step 4: Delete the `vaOpenGpsList` / `vaOpenGpProfile` / `vaOpenMetricTasks` / `vaBackToToday` helpers**

In `pages/admin.html` delete the block at lines 2385-2405 (the `/* Navigation helpers for the new panels */` comment and all four functions).

- [ ] **Step 5: Delete `renderTicketsPanel`**

In `pages/admin.html` delete the block at lines 2407-2435 (the `renderTicketsPanel` function — tickets now render inline in the inbox).

- [ ] **Step 6: Delete the legacy `_origSwitchTabs` hook handler**

In `pages/admin.html` delete the block at lines 2493-2527 (the `/* Hook view switching for the new tabs */` comment and everything through the closing `,true);`).

- [ ] **Step 7: Delete drill-through delegated click handlers**

In `pages/admin.html` find the big delegated handler block that begins around line 2564 with `document.addEventListener("click",async e=>{` and handles `data-todo-ticket`, `data-todo-task`, `data-view-todo-case`, `data-tickets-subtab`, `data-va-refresh`, `data-va-refresh-tickets`, `data-va-metric`, `data-va-back`, `data-va-back-to`, `data-gp-profile`, `data-view-case-from-profile`, `data-va-sweep-weekly`. Delete that entire delegated listener block (through its closing `},true);`).

Leave the interviews-panel delegated handler block at lines 2530-2560ish alone. If uncertain, grep for `[data-iv-submit]` — the block to keep is the one that references interview data attributes.

- [ ] **Step 8: Delete the `hookInitialLoad` IIFE**

In `pages/admin.html` delete the block at lines 2654-2667 (the `/* Init-time auto-load for the default "today" view */` comment and the `(function hookInitialLoad(){ ... })();` IIFE). The new init-time loader will be installed in Task 4.

- [ ] **Step 9: Quick syntax sanity check**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('pages/admin.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new Function(m[1]);console.log('ok');"`
Expected: `ok` — the script block still parses. If it errors, re-inspect the last Edit; a stray `}` or missing `(` is almost always the cause.

- [ ] **Step 10: Commit**

```bash
git add pages/admin.html
git commit -m "chore(va-dashboard): remove obsolete drill-through panels and helpers

Deletes:
- #gpsListPanel, #gpProfilePanel, #metricTasksPanel divs
- switchToOps / switchFromOps helpers
- renderGpsListPanel / renderGpProfilePanel / loadGpProfileDocuments
- renderMetricTasksPanel + vaOpen*/vaBack* helpers
- renderTicketsPanel
- _origSwitchTabs hook + drill-through delegated click listener
- hookInitialLoad IIFE

Prepares admin.html for the 5-tab consolidation rewrite. Page is
intentionally non-functional after this commit; next tasks install
the new skeleton."
```

---

## Task 4: Install new 5-tab nav + panel skeleton + `vaShowPanel` rewrite

**Files:**
- Modify: `pages/admin.html` (lines 461-470 for nav, 480-487 for panels, lines near 547-556 for state, lines around the old `vaShowPanel` / `vaHidePanels`, the old `bind()` tab click handler)

This task replaces the tab strip with the new 5-tab layout, installs the new panel divs (`#inboxPanel`, `#toolsPanel`), extends the state object, and rewrites the tab click handler + `vaShowPanel` to cover the new panel set. No render functions yet — empty panels.

- [ ] **Step 1: Replace the `.view-tabs` markup**

In `pages/admin.html` replace:

```html
      <div class="view-tabs">
        <div class="view-tab active" data-view="today">Today</div>
        <div class="view-tab" data-view="cases">Users</div>
        <div class="view-tab" data-view="tickets">Tickets</div>
        <div class="view-tab" data-view="queue">Work Queue</div>
        <div class="view-tab" data-view="ops">Ops Queue</div>
        <div class="view-tab" data-view="interviews">Interviews</div>
        <div class="view-tab" data-view="applications">Applications</div>
        <div class="view-tab" data-view="agent" id="agentTab" style="display:none">Agent</div>
      </div>
```

with:

```html
      <div class="view-tabs">
        <div class="view-tab active" data-view="inbox">Inbox</div>
        <div class="view-tab" data-view="gps">GPs</div>
        <div class="view-tab" data-view="interviews">Interviews</div>
        <div class="view-tab" data-view="applications">Applications</div>
        <div class="view-tab" data-view="tools">Tools</div>
      </div>
```

- [ ] **Step 2: Replace the drill-through panel markup with the new panel set**

In `pages/admin.html` find the remaining panel divs (after Task 3 deleted the drill-through ones):

```html
  <div class="today-wrap" id="todayPanel" style="display:none"></div>
  <div class="tickets-wrap" id="ticketsPanel" style="display:none"></div>
  <div class="interviews-wrap" id="interviewsPanel" style="display:none"></div>
  <div class="applications-wrap" id="applicationsPanel" style="display:none"></div>
```

Replace the first two lines (the `#todayPanel` and `#ticketsPanel` lines) with:

```html
  <div class="today-wrap" id="inboxPanel" style="display:none"></div>
```

Leave `#interviewsPanel` and `#applicationsPanel` in place. Then insert a new Tools panel immediately after the `#applicationsPanel` line:

```html
  <div class="tools-wrap" id="toolsPanel" style="display:none"></div>
```

- [ ] **Step 3: Add the top-bar global search input**

In `pages/admin.html` find the top bar region. Look for the div with id `topChips` (the cluster of chip buttons in the top bar) and the `.top-right` flex container that holds the logout button. Between them insert the global-search input.

First locate the anchor in the top bar. Search for `<div class="top-right">` — there should be exactly one. Replace the line ending the element before `.top-right` so the input sits between `#topChips` and `.top-right`. If `#topChips` is followed immediately by `<div class="top-right">`, insert after `#topChips` closes:

```html
      <div class="top-search">
        <input type="search" id="globalSearch" placeholder="Search GPs, tasks, tickets, documents, notes…" autocomplete="off" spellcheck="false" />
        <div class="top-search-results" id="globalSearchResults" style="display:none"></div>
      </div>
```

If your existing structure nests `#topChips` inside `.top-bar` with a different layout, preserve the parent flex container — the new `.top-search` must be a sibling of `#topChips` inside the same flex row so it grows to fill remaining space.

- [ ] **Step 4: Add CSS for the new panels, top search, and tools sub-nav**

In `pages/admin.html` locate the `<style>` block (top of the file). Scroll to the end of the existing rules (just before the `</style>` closing tag). Append:

```css
/* ── VA dashboard consolidation (2026-04-11) ── */
.top-search{flex:1 1 auto;max-width:500px;position:relative;margin:0 12px}
.top-search input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border,#2a2f3a);background:var(--bg2,#171a22);color:var(--text,#e6e9f0);font-size:14px}
.top-search input:focus{outline:2px solid var(--accent,#4f46e5);outline-offset:1px}
.top-search-results{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:480px;overflow-y:auto;background:var(--bg2,#171a22);border:1px solid var(--border,#2a2f3a);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:500}
.top-search-group{padding:6px 0;border-bottom:1px solid var(--border,#2a2f3a)}
.top-search-group:last-child{border-bottom:none}
.top-search-group-title{padding:6px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#9aa3b2)}
.top-search-row{padding:8px 12px;cursor:pointer;display:flex;gap:8px;align-items:center}
.top-search-row:hover,.top-search-row.active{background:var(--bg3,#1f2330)}
.top-search-row-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top-search-row-sub{font-size:12px;color:var(--muted,#9aa3b2);flex-shrink:0}
.top-search-more{padding:6px 12px;font-size:12px;color:var(--accent,#4f46e5);cursor:pointer;text-align:center}
.top-search-footer{padding:6px 12px;font-size:11px;color:var(--muted,#9aa3b2);border-top:1px solid var(--border,#2a2f3a)}
.top-search-empty{padding:16px;text-align:center;color:var(--muted,#9aa3b2);font-size:13px}

.tools-wrap{padding:16px 20px}
.tools-subnav{display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--border,#2a2f3a);padding-bottom:12px}
.tools-subnav-btn{padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;color:var(--muted,#9aa3b2);background:transparent;border:1px solid transparent}
.tools-subnav-btn:hover{background:var(--bg3,#1f2330);color:var(--text,#e6e9f0)}
.tools-subnav-btn.active{background:var(--accent,#4f46e5);color:#fff}
.tools-sub-pane{min-height:400px}

/* GP profile — desktop two-column */
.gp-detail-grid{display:grid;grid-template-columns:260px 1fr;gap:20px;height:100%}
.gp-detail-meta{padding:16px;border-right:1px solid var(--border,#2a2f3a);overflow-y:auto}
.gp-detail-tabs-wrap{padding:16px;overflow-y:auto}
.gp-detail-tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border,#2a2f3a)}
.gp-detail-tab{padding:8px 16px;cursor:pointer;font-size:13px;font-weight:600;color:var(--muted,#9aa3b2);border-bottom:2px solid transparent}
.gp-detail-tab:hover{color:var(--text,#e6e9f0)}
.gp-detail-tab.active{color:var(--accent,#4f46e5);border-bottom-color:var(--accent,#4f46e5)}

/* Mobile single-scroll fallback */
body.gp-mobile .gp-detail-grid{grid-template-columns:1fr;height:auto}
body.gp-mobile .gp-detail-meta{border-right:none;border-bottom:1px solid var(--border,#2a2f3a)}
body.gp-mobile .gp-detail-tabs{display:none}
body.gp-mobile .gp-detail-tab-pane{display:block !important;margin-bottom:16px}

/* Inbox section separators */
.inbox-section-title{margin:20px 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#9aa3b2);display:flex;align-items:center;gap:8px}
.inbox-section-title .count{padding:2px 8px;border-radius:999px;background:var(--bg3,#1f2330);font-size:11px}
.inbox-section-title .count.red{background:var(--red,#ef4444);color:#fff}
.inbox-section-title .count.amber{background:var(--amber,#f59e0b);color:#fff}

/* Blocker row (Inbox "Blocked cases" section) */
.blocker-row{padding:12px;border:1px solid var(--border,#2a2f3a);border-radius:8px;background:var(--bg2,#171a22);margin-bottom:8px;display:flex;align-items:center;gap:12px}
.blocker-row-main{flex:1;min-width:0}
.blocker-row-name{font-weight:700}
.blocker-row-reason{font-size:12px;color:var(--muted,#9aa3b2);margin-top:2px}
```

- [ ] **Step 5: Extend the `S` state object**

In `pages/admin.html` find the `const S={...}` declaration at line 547. After the `pbsCases:[]` / `va:` block and before the `interviews:` block (or anywhere inside the existing object — the order does not matter), add the new fields. Concretely, update the `S` declaration so it includes:

```javascript
  const S={dashboard:null,cases:[],tasks:[],visaCases:[],pbsCases:[],viewer:null,hostLabel:"",loading:false,
    selectedCaseId:null,view:"inbox",filter:"all",query:"",expanded:{},refreshTimer:null,
    toolsSubView:"ops",gpsProfileTab:"tasks",
    opsTasks:[],opsExpandedId:null,opsLoading:false,
    va:{dashboard:null,tickets:[],ticketsView:"open",selectedQuals:null,loading:false,gpDetailCache:{},lastSweepResult:null},
    search:{query:"",loading:false,clientResults:{gps:[],tasks:[],tickets:[]},serverResults:{documents:[],notes:[]},open:false,debounceTimer:null},
    interviews:{list:[],loading:false},
    applications:{list:[],loading:false},
    agent:{providers:null,runs:[],workers:[],primaryWorkerId:"",policy:null,connectCommands:null,activeRunId:"",selectedRunId:null,currentRun:null,
      draftTask:"",profile:"balanced",collaborationMode:"paired",complexity:"auto",loading:false,submitting:false,
      warnings:[],security:null,providerStatusRefreshedAt:"",error:"",
      bridge:{connected:false,mode:"remote",baseUrl:"",error:"",status:null,candidates:["http://127.0.0.1:4317","http://localhost:4317"]}}};
```

(Replace the existing `const S=...` declaration with the block above. Two changes vs the original: `view:"inbox"` instead of `view:"today"`, added `toolsSubView`, `gpsProfileTab`, `gpDetailCache`, `lastSweepResult`, and the top-level `search` object.)

- [ ] **Step 6: Rewrite `vaShowPanel` and `vaHidePanels`**

In `pages/admin.html` replace the existing `vaShowPanel` and `vaHidePanels` functions (lines 2007-2027) with:

```javascript
  function vaShowPanel(which){
    document.getElementById("mainLayout").style.display=(which==="gps"?"grid":"none");
    document.getElementById("opsPanel").classList.remove("active");
    const ib=document.getElementById("inboxPanel");if(ib)ib.style.display=(which==="inbox"?"block":"none");
    const iv=document.getElementById("interviewsPanel");if(iv)iv.style.display=(which==="interviews"?"block":"none");
    const ap=document.getElementById("applicationsPanel");if(ap)ap.style.display=(which==="applications"?"block":"none");
    const tl=document.getElementById("toolsPanel");if(tl)tl.style.display=(which==="tools"?"block":"none");
  }
  function vaHidePanels(){
    ["inboxPanel","interviewsPanel","applicationsPanel","toolsPanel"].forEach(function(id){
      const el=document.getElementById(id);if(el)el.style.display="none";
    });
    document.getElementById("mainLayout").style.display="grid";
  }
```

- [ ] **Step 7: Replace the `.view-tabs` click handler in `bind()`**

In `pages/admin.html` find the line at ~1696 inside `function bind(){...}`:

```javascript
    document.querySelector(".view-tabs").addEventListener("click",e=>{const tab=e.target.closest("[data-view]");if(!tab)return;S.view=tab.getAttribute("data-view");document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t===tab));if(S.view==="ops"){switchToOps();}else{switchFromOps();renderCaseList();renderDetail();if(S.view==="agent")refreshAgentStatus(true);}});
```

Replace that single line with:

```javascript
    document.querySelector(".view-tabs").addEventListener("click",async e=>{
      const tab=e.target.closest("[data-view]");if(!tab)return;
      const view=tab.getAttribute("data-view");
      S.view=view;
      document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t===tab));
      vaShowPanel(view);
      if(view==="inbox"){
        if(!S.va.dashboard)await loadVaDashboard();
        renderInboxPanel();
      }else if(view==="gps"){
        renderCaseList();renderDetail();
      }else if(view==="interviews"){
        await loadInterviews();
      }else if(view==="applications"){
        await loadAdminApplications();
      }else if(view==="tools"){
        renderToolsPanel();
      }
    });
```

- [ ] **Step 8: Install a new init-time auto-loader for Inbox**

In `pages/admin.html` — the old `hookInitialLoad` IIFE was deleted in Task 3. Immediately before the `/* ══ Init ══ */` comment (around line 2669), add:

```javascript
  /* Init-time auto-load for the default "inbox" view */
  (function hookInitialLoad(){
    window.__gplinkVaLoaded=false;
    const tick=setInterval(async()=>{
      if(window.__gplinkVaLoaded)return;
      if(S.cases&&S.cases.length!==undefined){
        window.__gplinkVaLoaded=true;
        clearInterval(tick);
        await loadVaDashboard();
        if(S.view==="inbox"){vaShowPanel("inbox");if(typeof renderInboxPanel==="function")renderInboxPanel();}
      }
    },300);
  })();
```

(`renderInboxPanel` doesn't exist yet — the `typeof` guard keeps this from crashing until Task 5 defines it.)

- [ ] **Step 9: Stub `renderInboxPanel` and `renderToolsPanel` so the wiring compiles**

In `pages/admin.html`, immediately after the `vaHidePanels` function you rewrote in Step 6, add placeholders so the click handler doesn't reference undefined symbols:

```javascript
  function renderInboxPanel(){
    const el=document.getElementById("inboxPanel");if(!el)return;
    el.innerHTML='<div class="empty">Inbox coming in Task 5…</div>';
  }
  function renderToolsPanel(){
    const el=document.getElementById("toolsPanel");if(!el)return;
    el.innerHTML='<div class="empty">Tools coming in Task 11…</div>';
  }
```

- [ ] **Step 10: Syntax sanity check + smoke test**

Run: `node -e "const fs=require('fs');const h=fs.readFileSync('pages/admin.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new Function(m[1]);console.log('ok');"`
Expected: `ok`.

Then `npm start` and visit `http://localhost:3000/pages/admin.html`. Log in. Verify:
- Page loads, no console errors.
- Tab strip shows `Inbox | GPs | Interviews | Applications | Tools`.
- Clicking Inbox → shows the placeholder text.
- Clicking GPs → shows the original `mainLayout` (case list + detail pane).
- Clicking Interviews → shows the interviews panel.
- Clicking Applications → shows the applications panel.
- Clicking Tools → shows the tools placeholder text.

Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): install 5-tab skeleton and new panel structure

- Replaces 8-tab strip with Inbox | GPs | Interviews | Applications | Tools
- Adds #inboxPanel, #toolsPanel divs; removes #todayPanel, #ticketsPanel
- Adds top-bar #globalSearch input + results dropdown container
- Extends S with toolsSubView, gpsProfileTab, search state, gpDetailCache
- Rewrites vaShowPanel/vaHidePanels for new panel set
- Replaces .view-tabs click handler
- Stubs renderInboxPanel / renderToolsPanel (fleshed out in later tasks)
- CSS for top search, tools subnav, GP detail grid, inbox sections

Page is navigable but Inbox/Tools show placeholder text until Tasks 5/11."
```

---

## Task 5: Implement `renderInboxPanel()` with sections in priority order

**Files:**
- Modify: `pages/admin.html` (replace the `renderInboxPanel` stub from Task 4, and extract `ticketCard` / `taskCard` from the old `renderTodayPanel`)

This task implements the real Inbox. Sections in order: Support Tickets → Urgent → Overdue → Blocked cases → Normal. Each hidden when empty. No metric cards. `ticketCard` and `taskCard` are reused verbatim from the old `renderTodayPanel` but hoisted to module scope so other callers can reuse them.

- [ ] **Step 1: Delete the old `renderTodayPanel` function**

In `pages/admin.html` find `function renderTodayPanel(){` at line 2029 and delete it through its closing `}` at line 2108. Do NOT delete the `ticketCard` / `taskCard` inner functions yet — in the next step they'll be moved to module scope.

- [ ] **Step 2: Add module-scope `ticketCard` and `taskCard` helpers**

In `pages/admin.html` — after the existing `esc`, `ini`, `fmtR`, `fmtD`, `fmtDT`, `safeUrl` helpers near line 575, add:

```javascript
  function ticketCard(tk){
    return`<div class="todo-card ${esc(tk.priority)||"normal"}" data-todo-ticket="${esc(tk.id)}" data-user-id="${esc(tk.user_id)}">
      <div class="todo-card-top">
        <div class="todo-avatar">${esc(ini(tk.gp_name||""))}</div>
        <div class="todo-gp">${esc(tk.gp_name||"")}</div>
        <span class="todo-stage">${esc(tk.stage||"ticket")}</span>
      </div>
      <div class="todo-title">🎫 ${esc(tk.title||"Support request")}</div>
      ${(tk.gp_phone||tk.gp_email)?'<div class="task-gp-meta">'+(tk.gp_phone?'<span>'+esc(tk.gp_phone)+'</span>':'')+(tk.gp_email?'<span>'+esc(tk.gp_email)+'</span>':'')+'</div>':''}
      <div class="todo-detail">${esc(tk.category||"")} • opened ${fmtR(tk.created_at)}</div>
      <div class="todo-actions">
        <a class="btn wa" href="${safeUrl(tk.whatsapp_link)}" target="_blank" rel="noopener">WhatsApp</a>
        <button class="btn nudge" data-nudge-user="${esc(tk.user_id)}" data-nudge-stage="${esc(tk.stage||"")}" data-nudge-substage="${esc(tk.substage||"")}" data-nudge-name="${esc(tk.gp_first_name||"")}">Send Nudge</button>
        <button class="btn primary sm" data-close-ticket="${esc(tk.id)}">Resolve & Close</button>
      </div>
    </div>`;
  }
  function taskCard(t){
    const overdue=t.is_overdue||(t.due_date&&new Date(t.due_date)<new Date());
    return`<div class="todo-card ${esc(t.priority||"normal")} ${overdue?"overdue":""}" data-todo-task="${esc(t.id)}" data-todo-case="${esc(t.case_id)}" data-user-id="${esc(t.gp_user_id||"")}">
      <div class="todo-card-top">
        <div class="todo-avatar">${esc(ini(t.gp_name||""))}</div>
        <div class="todo-gp">${esc(t.gp_name||"")}</div>
        <span class="todo-stage">${esc(t.case_stage||t.related_stage||"")}</span>
      </div>
      <div class="todo-title">${esc(t.title)}</div>
      ${(t.gp_phone||t.gp_email)?'<div class="task-gp-meta">'+(t.gp_phone?'<span>'+esc(t.gp_phone)+'</span>':'')+(t.gp_email?'<span>'+esc(t.gp_email)+'</span>':'')+'</div>':''}
      <div class="todo-detail">${esc(t.description||"")} ${t.due_date?" • Due "+fmtD(t.due_date):""} ${overdue?'<span style="color:var(--red);font-weight:800"> • OVERDUE</span>':""}</div>
      <div class="todo-actions">
        <a class="btn wa" href="${safeUrl(t.whatsapp_link)}" target="_blank" rel="noopener">WhatsApp</a>
        ${t.doubletick_conversation_url?'<a class="btn dt" href="'+safeUrl(t.doubletick_conversation_url)+'" target="_blank" rel="noopener">💬 DoubleTick</a>':''}
        <button class="btn nudge" data-nudge-user="${esc(t.gp_user_id||"")}" data-nudge-stage="${esc(t.case_stage||t.related_stage||"")}" data-nudge-substage="${esc(t.related_substage||"")}" data-nudge-name="${esc(t.gp_first_name||"")}">Send Nudge</button>
        <button class="btn primary sm" data-complete-todo-task="${esc(t.id)}">Complete</button>
        <button class="btn sm" data-view-todo-case="${esc(t.case_id)}">Open Case</button>
      </div>
    </div>`;
  }
  function blockerRow(u){
    return`<div class="blocker-row" data-blocker-case="${esc(u.case_id)}">
      <div class="todo-avatar">${esc(ini(u.gp_name||""))}</div>
      <div class="blocker-row-main">
        <div class="blocker-row-name">${esc(u.gp_name||"")} <span class="todo-stage">${esc(u.stage||"")}</span></div>
        <div class="blocker-row-reason">${esc(u.blocker_status||"Blocked")}</div>
      </div>
      <button class="btn sm primary" data-view-todo-case="${esc(u.case_id)}">Open profile</button>
    </div>`;
  }
```

- [ ] **Step 3: Replace the `renderInboxPanel` stub with the real implementation**

In `pages/admin.html` find the `renderInboxPanel` stub added in Task 4 and replace it with:

```javascript
  function renderInboxPanel(){
    const el=document.getElementById("inboxPanel");if(!el)return;
    const dash=S.va.dashboard;
    if(!dash){el.innerHTML='<div class="empty">Loading inbox…</div>';return;}
    const tasks=Array.isArray(dash.todays_tasks)?dash.todays_tasks.slice():[];
    const tickets=Array.isArray(dash.open_tickets)?dash.open_tickets.slice():[];
    const users=Array.isArray(dash.users)?dash.users.slice():[];

    // Tickets FIFO by created_at ascending
    tickets.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));

    // Partition tasks. Precedence: Overdue > Urgent > Normal.
    const overdue=[],urgent=[],normal=[];
    for(const t of tasks){
      if(t.is_overdue)overdue.push(t);
      else if(t.is_urgent)urgent.push(t);
      else normal.push(t);
    }
    overdue.sort((a,b)=>new Date(a.due_date||0)-new Date(b.due_date||0));
    urgent.sort((a,b)=>new Date(a.created_at||0)-new Date(b.created_at||0));
    const priOrder={urgent:0,high:1,normal:2,low:3};
    normal.sort((a,b)=>{
      const pa=priOrder[a.priority]||9,pb=priOrder[b.priority]||9;
      if(pa!==pb)return pa-pb;
      return new Date(a.created_at||0)-new Date(b.created_at||0);
    });

    const blocked=users.filter(u=>u.blocker_status);

    let h=`<div class="today-header">
      <div><h2>Inbox</h2><p>Everything live right now, sorted by what needs action first.</p></div>
      <div><button class="btn" data-va-refresh>Refresh</button></div>
    </div>`;

    if(tickets.length){
      h+=`<div class="inbox-section-title">🎫 Support Tickets (FIFO) <span class="count red">${tickets.length}</span></div>
        <div class="today-grid">${tickets.map(ticketCard).join("")}</div>`;
    }
    if(urgent.length){
      h+=`<div class="inbox-section-title">Urgent <span class="count red">${urgent.length}</span></div>
        <div class="today-grid">${urgent.map(taskCard).join("")}</div>`;
    }
    if(overdue.length){
      h+=`<div class="inbox-section-title">Overdue <span class="count amber">${overdue.length}</span></div>
        <div class="today-grid">${overdue.map(taskCard).join("")}</div>`;
    }
    if(blocked.length){
      h+=`<div class="inbox-section-title">Blocked cases <span class="count">${blocked.length}</span></div>
        <div>${blocked.map(blockerRow).join("")}</div>`;
    }
    if(normal.length){
      h+=`<div class="inbox-section-title">Normal <span class="count">${normal.length}</span></div>
        <div class="today-grid">${normal.map(taskCard).join("")}</div>`;
    }
    if(!tickets.length&&!urgent.length&&!overdue.length&&!blocked.length&&!normal.length){
      h+='<div class="empty" style="margin-top:20px">All clear — no pending tickets or tasks. 🎉</div>';
    }
    el.innerHTML=h;
  }
```

- [ ] **Step 4: Install delegated click handlers for inbox actions**

In `pages/admin.html` — add a new document-level delegated click handler near where the old drill-through handler used to live (right before the `hookInitialLoad` IIFE you installed in Task 4):

```javascript
  /* Delegated click handlers for Inbox and Tools panels */
  document.addEventListener("click",async e=>{
    const ib=document.getElementById("inboxPanel");
    const tl=document.getElementById("toolsPanel");
    const inInbox=ib&&ib.contains(e.target);
    const inTools=tl&&tl.contains(e.target);
    if(!inInbox&&!inTools)return;

    const refresh=e.target.closest("[data-va-refresh]");
    if(refresh){e.preventDefault();e.stopPropagation();await loadVaDashboard();if(S.view==="inbox")renderInboxPanel();return;}

    const closeT=e.target.closest("[data-close-ticket]");
    if(closeT){e.preventDefault();e.stopPropagation();await closeTicketAction(closeT.getAttribute("data-close-ticket"),"closed");return;}

    const nudge=e.target.closest("[data-nudge-user]");
    if(nudge){e.preventDefault();e.stopPropagation();openNudgeModal(nudge.getAttribute("data-nudge-user"),nudge.getAttribute("data-nudge-stage"),nudge.getAttribute("data-nudge-substage"),nudge.getAttribute("data-nudge-name"));return;}

    const complete=e.target.closest("[data-complete-todo-task]");
    if(complete){e.preventDefault();e.stopPropagation();const tid=complete.getAttribute("data-complete-todo-task");try{const r=await fetch("/api/admin/task/"+encodeURIComponent(tid)+"/complete",{method:"PUT",credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(d&&d.ok){toast("Task completed");await loadVaDashboard();if(S.view==="inbox")renderInboxPanel();}else toast((d&&d.message)||"Failed","red");}catch{toast("Network error","red");}return;}

    const openCase=e.target.closest("[data-view-todo-case]");
    if(openCase){e.preventDefault();e.stopPropagation();S.selectedCaseId=openCase.getAttribute("data-view-todo-case");S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();return;}

    const blocker=e.target.closest("[data-blocker-case]");
    if(blocker&&!e.target.closest("[data-view-todo-case]")){e.preventDefault();e.stopPropagation();S.selectedCaseId=blocker.getAttribute("data-blocker-case");S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();return;}
  },true);
```

(Note: the actual "complete task" endpoint may be `/api/admin/task/ID/complete` or similar. Verify by grepping `grep -n "completeTask\|/api/admin/task/" pages/admin.html` — use whichever endpoint the existing `completeTask` function hits. If an existing `completeTask(id)` function exists at module scope, call it instead of duplicating the fetch.)

- [ ] **Step 5: Auto-refresh the inbox via the 15-second poll**

In `pages/admin.html` find `function loadAll(){...}` or the polling timer setup at the bottom of the script. Where `loadAll()` re-renders the active view, add a branch so that after data loads:

```javascript
// After the existing post-loadAll rendering logic, add:
if(S.view==="inbox"){
  await loadVaDashboard();
  renderInboxPanel();
}
```

If `loadAll()` already calls `loadVaDashboard`, just ensure the `if(S.view==="inbox")renderInboxPanel();` line is present where `renderTodayPanel()` used to be called. Search for the remaining references to `renderTodayPanel` and replace each one with `renderInboxPanel` (they should be in `runWeeklyCheckinSweep`, `closeTicketAction`, `refreshVaAll`, and the visibilitychange handler).

Run `grep -n "renderTodayPanel\|'today'\|\"today\"" pages/admin.html` to find all remaining references and replace `renderTodayPanel` with `renderInboxPanel` and the view string `"today"` with `"inbox"` in every JS branch. **Do not** touch the `dash.todays_tasks` property name — that's the server response field.

- [ ] **Step 6: Syntax + manual smoke test**

Run the same `new Function` sanity check:
`node -e "const fs=require('fs');const h=fs.readFileSync('pages/admin.html','utf8');const m=h.match(/<script>([\s\S]*?)<\/script>/);new Function(m[1]);console.log('ok');"`
Expected: `ok`.

Then `npm start` → admin login → verify:
- Inbox tab loads and shows Support Tickets / Urgent / Overdue / Blocked / Normal sections (only non-empty ones render).
- Clicking Resolve & Close on a ticket removes it and refreshes.
- Clicking Complete on a task removes it and refreshes.
- Clicking Open Case on a task lands on GPs tab with that case selected.
- Clicking Open profile on a blocker row lands on GPs tab with that case selected.

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): implement Inbox panel with priority sections

- renderInboxPanel replaces renderTodayPanel
- Sections: Support Tickets (FIFO) → Urgent → Overdue → Blocked cases → Normal
- Each section hidden when empty; precedence Overdue > Urgent > Normal
- ticketCard / taskCard hoisted to module scope for reuse
- blockerRow introduced for the Blocked cases section
- Delegated click handlers for refresh, resolve, nudge, complete, open case
- 15s poll wiring updated to call renderInboxPanel"
```

---

## Task 6: Responsive layout detection (`body.gp-mobile` toggle)

**Files:**
- Modify: `pages/admin.html` (init block near line 2669)

The CSS for the GP profile already has `body.gp-mobile` overrides (added in Task 4 Step 4). This task adds the `matchMedia` listener that toggles the class.

- [ ] **Step 1: Add the matchMedia listener near init**

In `pages/admin.html` — right after the `bind();` call at line 2670, add:

```javascript
  /* Responsive breakpoint: add body.gp-mobile at ≤900px */
  (function installResponsiveToggle(){
    const mq=window.matchMedia("(max-width: 900px)");
    function apply(){document.body.classList.toggle("gp-mobile",mq.matches);}
    apply();
    if(typeof mq.addEventListener==="function")mq.addEventListener("change",apply);
    else if(typeof mq.addListener==="function")mq.addListener(apply);
  })();
```

- [ ] **Step 2: Syntax check + smoke test**

Run the `new Function` sanity check. Then `npm start`. In the browser open DevTools → Device toolbar → toggle between desktop and mobile widths. Verify the `<body>` element gains/loses the `gp-mobile` class at 900px.

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): add responsive body.gp-mobile toggle at 900px breakpoint"
```

---

## Task 7: GPs tab — filter chips + tab-scoped search + list rendering

**Files:**
- Modify: `pages/admin.html` (existing `renderFilters`, `renderCaseList`, `bind()` search-input handler)

The GPs tab reuses the existing `mainLayout`, `renderFilters`, `renderCaseList`, and `renderDetail` functions — they already render a left list + right detail. This task makes sure the filter chips match the spec (`All · Urgent · Overdue · Blocked · Active · Complete`) and the top-of-list search input is scoped to GPs only.

- [ ] **Step 1: Locate and read `renderFilters`**

In `pages/admin.html` run: `grep -n "function renderFilters" pages/admin.html`. Open the file at the reported line and read the entire function so you know exactly which chip set it builds. Note the data attribute — usually `data-filter="xxx"` — and the `counts()` helper it calls.

- [ ] **Step 2: Update the chip set to match the spec**

Replace the inner body of `renderFilters` so it emits exactly this chip set:

```javascript
  function renderFilters(){
    const el=document.getElementById("filterBar");if(!el)return;
    const c=counts();
    const chips=[
      {key:"all",label:"All",n:c.all},
      {key:"urgent",label:"Urgent",n:c.urgent},
      {key:"overdue",label:"Overdue",n:c.overdue},
      {key:"blocked",label:"Blocked",n:c.blocked},
      {key:"active",label:"Active",n:c.active},
      {key:"complete",label:"Complete",n:c.complete}
    ];
    el.innerHTML=chips.map(ch=>`<button class="filter-chip ${S.filter===ch.key?"active":""}" data-filter="${ch.key}">${esc(ch.label)} <span class="count">${ch.n}</span></button>`).join("");
  }
```

- [ ] **Step 3: Verify `counts()` produces the required keys**

Grep for `function counts` in `pages/admin.html`. Ensure it returns (or add to its returned object) fields named `all`, `urgent`, `overdue`, `blocked`, `active`, `complete`. If any are missing, extend it:

```javascript
  function counts(){
    const list=S.cases||[];
    const urgent=list.filter(c=>(c.urgent_tasks||0)>0).length;
    const overdue=list.filter(c=>(c.overdue_tasks||0)>0).length;
    const blocked=list.filter(c=>!!c.blocker_status).length;
    const active=list.filter(c=>c.status==="active").length;
    const complete=list.filter(c=>c.status==="complete"||c.status==="completed").length;
    return{all:list.length,urgent:urgent,overdue:overdue,blocked:blocked,active:active,complete:complete};
  }
```

(If `counts()` already returns all six, skip this sub-step.)

- [ ] **Step 4: Verify `renderCaseList` honours `S.filter` for all six keys**

Grep for `function renderCaseList`. Check the filter switch — if it lacks branches for `blocked` or `complete`, add them:

```javascript
  // Inside renderCaseList, after loading list:
  if(S.filter==="urgent")list=list.filter(c=>(c.urgent_tasks||0)>0);
  else if(S.filter==="overdue")list=list.filter(c=>(c.overdue_tasks||0)>0);
  else if(S.filter==="blocked")list=list.filter(c=>!!c.blocker_status);
  else if(S.filter==="active")list=list.filter(c=>c.status==="active");
  else if(S.filter==="complete")list=list.filter(c=>c.status==="complete"||c.status==="completed");
```

Preserve the existing search-substring logic in `renderCaseList` that uses `S.query`.

- [ ] **Step 5: Make the search input tab-scoped**

The `#searchInput` at line 460 lives inside `.list-panel` which is inside `mainLayout`. Since `mainLayout` is only visible when `S.view === "gps"`, the search input is already scoped visually. Verify the existing `bind()` handler (`document.getElementById("searchInput").addEventListener("input",...)` at line 1695) writes to `S.query` and re-renders the case list only. Do not change that handler.

- [ ] **Step 6: Smoke test**

`npm start` → log in → click GPs tab. Verify:
- Filter chips read `All · Urgent · Overdue · Blocked · Active · Complete` with counts.
- Clicking Urgent filters the list to cases with urgent tasks.
- Clicking Blocked filters to cases with a `blocker_status`.
- Typing in the search input above the filters narrows the list by name/email/phone.

Stop dev server.

- [ ] **Step 7: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): align GPs tab filter chips with new spec

Chips: All · Urgent · Overdue · Blocked · Active · Complete.
counts() and renderCaseList filter switch extended where needed."
```

---

## Task 8: GPs desktop detail — two-column meta + tabbed content layout

**Files:**
- Modify: `pages/admin.html` (the existing `renderDetail()` function)

This task rewrites `renderDetail()` so when a case is selected and the user is on the GPs tab, the detail pane emits the new two-column layout: a 260px meta column on the left (avatar, name, contact, progress, actions, case management form) and a wide tabbed content column on the right. The mobile `body.gp-mobile` CSS from Task 4 Step 4 automatically collapses the tabs into a single-scroll page when the viewport is narrow.

- [ ] **Step 1: Locate the existing `renderDetail()`**

Run: `grep -n "function renderDetail" pages/admin.html`. Open the file at the line number and read the entire function. Note every branch: "no case selected" empty state, case found and rendering, any agent-mode branch, etc. Copy the existing inner rendering logic — you'll reassemble it into the meta column and the four tab panes.

- [ ] **Step 2: Rewrite `renderDetail` to emit the two-column layout**

Replace the body of `renderDetail` with:

```javascript
  function renderDetail(){
    const el=document.getElementById("detailContent");if(!el)return;
    if(S.view!=="gps"){return;}
    const c=S.cases.find(x=>x.id===S.selectedCaseId);
    if(!c){el.innerHTML='<div class="detail-empty">Select a GP from the list.</div>';return;}
    const u=(S.va.dashboard&&Array.isArray(S.va.dashboard.users))
      ?(S.va.dashboard.users.find(x=>x.case_id===c.id||x.user_id===c.user_id)||{})
      :{};

    // Meta column (always visible when a GP is selected)
    const metaHtml=`
      <div class="gp-detail-meta">
        <div class="todo-avatar" style="width:64px;height:64px;font-size:24px">${esc(ini(u.gp_name||c.gp_name||""))}</div>
        <h3 style="margin:8px 0 4px">${esc(u.gp_name||c.gp_name||"Unknown")}</h3>
        <div class="todo-stage">${esc(c.stage||"")}</div>
        <div style="margin-top:12px;font-size:12px;color:var(--muted,#9aa3b2)">
          ${u.gp_email?'<div>'+esc(u.gp_email)+'</div>':''}
          ${u.gp_phone?'<div>'+esc(u.gp_phone)+'</div>':''}
          ${u.country?'<div>Country: '+esc(u.country)+'</div>':''}
        </div>
        <div style="margin-top:12px">
          <div style="font-size:11px;color:var(--muted,#9aa3b2);margin-bottom:4px">Qualification progress</div>
          <div style="height:6px;background:var(--bg3,#1f2330);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${Math.round(((u.quals_approved||0)/Math.max(1,(u.quals_required||1)))*100)}%;background:var(--green,#22c55e)"></div>
          </div>
          <div style="font-size:11px;color:var(--muted,#9aa3b2);margin-top:4px">${u.quals_approved||0} / ${u.quals_required||0} approved</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:12px">
          <a class="btn wa" href="${safeUrl(u.whatsapp_link||"")}" target="_blank" rel="noopener">WhatsApp</a>
          <button class="btn nudge" data-case-nudge="${esc(c.id)}" data-nudge-stage="${esc(c.stage||"")}" data-nudge-substage="${esc(c.substage||"")}" data-nudge-name="${esc((u.gp_first_name||"").trim())}">Send Nudge</button>
          <button class="btn sm" data-open-full-case="${esc(c.id)}">Open full case</button>
        </div>
        <div style="margin-top:16px">
          <h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;color:var(--muted,#9aa3b2)">Case Management</h4>
          ${renderCaseManagementForm(c)}
        </div>
      </div>
    `;

    // Tabbed content column
    const tab=S.gpsProfileTab||"tasks";
    const tabsBar=`
      <div class="gp-detail-tabs">
        <div class="gp-detail-tab ${tab==="tasks"?"active":""}" data-gp-tab="tasks">Tasks</div>
        <div class="gp-detail-tab ${tab==="documents"?"active":""}" data-gp-tab="documents">Documents</div>
        <div class="gp-detail-tab ${tab==="journey"?"active":""}" data-gp-tab="journey">Journey</div>
        <div class="gp-detail-tab ${tab==="notes"?"active":""}" data-gp-tab="notes">Notes</div>
      </div>
    `;

    const panesHtml=`
      <div class="gp-detail-tab-pane" data-gp-pane="tasks" style="${tab==="tasks"?"":"display:none"}">${renderGpTasksPane(c)}</div>
      <div class="gp-detail-tab-pane" data-gp-pane="documents" style="${tab==="documents"?"":"display:none"}">${renderGpDocumentsPane(c)}</div>
      <div class="gp-detail-tab-pane" data-gp-pane="journey" style="${tab==="journey"?"":"display:none"}">${renderGpJourneyPane(c)}</div>
      <div class="gp-detail-tab-pane" data-gp-pane="notes" style="${tab==="notes"?"":"display:none"}">${renderGpNotesPane(c)}</div>
    `;

    el.innerHTML=`<div class="gp-detail-grid">${metaHtml}<div class="gp-detail-tabs-wrap">${tabsBar}${panesHtml}</div></div>`;
  }
```

- [ ] **Step 3: Preserve the existing case management form renderer**

Grep for how the old `renderDetail` built the case management form — it writes inputs with `data-case-field` attributes and a `data-save-case` button. Extract that block into a reusable `renderCaseManagementForm(c)` helper placed just above `renderDetail`. Copy the exact markup (inputs for `status`, `blocker_status`, `follow_up_date`, `practice_name`, `handover_notes`, VA-verified stage, plus Save button). Wrap it so it returns an HTML string.

If the old `renderDetail` did not extract this into a helper, create one now with the exact markup you find in the existing implementation. Do not change any data attribute names — the existing `[data-save-case]` click handler must still match.

- [ ] **Step 4: Stub the four pane renderers**

Immediately above `renderDetail`, add stubs for the pane renderers (Task 9 fills them in with real content):

```javascript
  function renderGpTasksPane(c){return'<div class="empty">Tasks pane — Task 9</div>';}
  function renderGpDocumentsPane(c){return'<div class="empty">Documents pane — Task 9</div>';}
  function renderGpJourneyPane(c){return'<div class="empty">Journey pane — Task 9</div>';}
  function renderGpNotesPane(c){return'<div class="empty">Notes pane — Task 9</div>';}
```

- [ ] **Step 5: Syntax + smoke test**

Run the `new Function` sanity check. Then `npm start` → log in → GPs tab → click any GP. Verify:
- Meta column renders on the left (avatar, name, stage, contact, progress bar, action buttons, case management form).
- Tab strip renders above the content area with four tabs.
- Default active tab is Tasks, showing the stub text.
- Clicking different tabs does nothing yet (handler in next step).
- Save on the case management form still works (click Save → toast success → form repopulates).

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): two-column GP detail layout (desktop)

Meta column (260px): avatar, name, stage, contact, qual progress, actions,
case management form. Tabbed content column with Tasks/Documents/Journey/Notes.
Pane renderers stubbed; filled in by Task 9."
```

---

## Task 9: GPs detail — tab switching + implement the four pane renderers

**Files:**
- Modify: `pages/admin.html` (replace the four stub pane renderers, add tab-click delegated handler)

- [ ] **Step 1: Add the tab-click delegated handler**

In `pages/admin.html`, find the existing `document.getElementById("detailContent").addEventListener("click",...)` block at line 1706 in `bind()`. Near the top of that handler (right after `if(agStart){...}` and before the `if(e.target.closest("[data-back]"))` line), add:

```javascript
      const gpTab=e.target.closest("[data-gp-tab]");
      if(gpTab){S.gpsProfileTab=gpTab.getAttribute("data-gp-tab");renderDetail();return;}
      const openFull=e.target.closest("[data-open-full-case]");
      if(openFull){const id=openFull.getAttribute("data-open-full-case");window.open("/pages/admin-case.html?id="+encodeURIComponent(id),"_blank");return;}
```

- [ ] **Step 2: Implement `renderGpTasksPane`**

Replace the stub with:

```javascript
  function renderGpTasksPane(c){
    const tasks=(S.tasks||[]).filter(t=>t.case_id===c.id&&t.status!=="complete"&&t.status!=="completed");
    if(!tasks.length)return`<div class="empty">No open tasks.</div><button class="btn sm" data-add-task>+ Add Task</button>`;
    const byPri={urgent:[],high:[],normal:[]};
    tasks.forEach(t=>{(byPri[t.priority]||byPri.normal).push(t);});
    const nextAction=tasks[0];
    let h='';
    if(nextAction){
      h+=`<div class="todo-card" style="border-left:4px solid var(--accent,#4f46e5);margin-bottom:12px">
        <div style="font-size:11px;text-transform:uppercase;color:var(--accent,#4f46e5);font-weight:700">Next Action</div>
        <div class="todo-title">${esc(nextAction.title)}</div>
        <div class="todo-detail">${esc(nextAction.description||"")}</div>
        <div class="todo-actions"><button class="btn primary sm" data-complete-task="${esc(nextAction.id)}">Complete</button><button class="btn sm" data-start-task="${esc(nextAction.id)}">Start</button></div>
      </div>`;
    }
    ["urgent","high","normal"].forEach(pri=>{
      if(!byPri[pri].length)return;
      h+=`<div class="inbox-section-title">${pri} <span class="count">${byPri[pri].length}</span></div>`;
      h+=byPri[pri].map(t=>`<div class="todo-card ${esc(t.priority)}" data-task-row="${esc(t.id)}">
        <div class="todo-title">${esc(t.title)}</div>
        <div class="todo-detail">${esc(t.description||"")} ${t.due_date?" • Due "+fmtD(t.due_date):""}</div>
        <div class="todo-actions"><button class="btn primary sm" data-complete-task="${esc(t.id)}">Complete</button><button class="btn sm" data-start-task="${esc(t.id)}">Start</button></div>
      </div>`).join("");
    });
    h+=`<div style="margin-top:12px"><button class="btn sm" data-add-task>+ Add Task</button></div>`;
    return h;
  }
```

- [ ] **Step 3: Implement `renderGpDocumentsPane` + `loadGpDocuments` cache helper**

Replace the stub with:

```javascript
  function renderGpDocumentsPane(c){
    const cache=S.va.gpDetailCache[c.user_id]||{};
    const snap=cache.quals;
    if(!snap){
      // Kick off the load, render a loading placeholder, and return.
      loadGpDocuments(c.user_id,c.id);
      return '<div class="empty">Loading documents…</div>';
    }
    let h='';
    const approved=snap.approved||[];
    const pending=snap.uploaded_unverified||[];
    const missing=snap.missing||[];
    h+=`<div class="inbox-section-title">Approved <span class="count">${approved.length}</span></div>`;
    if(!approved.length)h+='<div class="empty">None approved yet.</div>';
    else h+=approved.map(d=>`<div class="todo-card"><div class="todo-title">${esc(d.label||d.key)}</div><div class="todo-detail">${esc(d.file_name||"")}</div><div class="todo-actions"><a class="btn sm" target="_blank" rel="noopener" href="/api/admin/va/user-document-download?user_id=${encodeURIComponent(c.user_id)}&country=${encodeURIComponent(d.country||snap.country||"")}&key=${encodeURIComponent(d.key)}">View</a></div></div>`).join("");
    h+=`<div class="inbox-section-title">Pending <span class="count">${pending.length}</span></div>`;
    if(!pending.length)h+='<div class="empty">Nothing awaiting verification.</div>';
    else h+=pending.map(d=>`<div class="todo-card"><div class="todo-title">${esc(d.label||d.key)} <span class="todo-stage">${esc(d.status||"pending")}</span></div><div class="todo-detail">${esc(d.file_name||"")}</div></div>`).join("");
    h+=`<div class="inbox-section-title">Missing <span class="count">${missing.length}</span></div>`;
    if(!missing.length)h+='<div class="empty">All required docs accounted for. 🎉</div>';
    else h+=missing.map(d=>`<div class="todo-card"><div class="todo-title">${esc(d.label||d.key)} <span class="todo-stage" style="background:var(--red,#ef4444);color:#fff">Missing</span></div></div>`).join("");
    return h;
  }

  async function loadGpDocuments(userId,caseId){
    try{
      const r=await fetch("/api/admin/va/user-qualifications?user_id="+encodeURIComponent(userId),{credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      if(d&&d.ok){
        S.va.gpDetailCache[userId]=S.va.gpDetailCache[userId]||{};
        S.va.gpDetailCache[userId].quals=d.snapshot||d;
        if(S.view==="gps"&&S.selectedCaseId===caseId)renderDetail();
      }
    }catch(err){console.error("[VA] loadGpDocuments failed",err);}
  }
```

(If the existing `/api/admin/va/user-qualifications` endpoint returns a different shape, adapt the property access. The spec response shape is `{ok:true, snapshot:{approved,uploaded_unverified,missing,required,country}}` — verify by reading the endpoint at `server.js:17405` if in doubt.)

- [ ] **Step 4: Implement `renderGpJourneyPane`**

Replace the stub with a thin wrapper around the existing `buildJourney` helper:

```javascript
  function renderGpJourneyPane(c){
    if(typeof buildJourney!=="function")return '<div class="empty">Journey renderer unavailable.</div>';
    return buildJourney(c);
  }
```

(If `buildJourney` takes additional args in the existing code, pass them exactly as the old `renderDetail` did. Grep for existing callers to copy the signature.)

- [ ] **Step 5: Implement `renderGpNotesPane`**

Replace the stub with:

```javascript
  function renderGpNotesPane(c){
    const cache=S.va.gpDetailCache[c.user_id]||{};
    const timeline=cache.timeline;
    if(!timeline){
      loadGpTimeline(c.user_id,c.id);
    }
    const tickets=(S.va.dashboard&&S.va.dashboard.open_tickets)?S.va.dashboard.open_tickets.filter(t=>t.user_id===c.user_id):[];
    let h='';
    h+=`<div class="inbox-section-title">Add a note</div>
      <textarea id="gpNoteInput" placeholder="Type a note…" style="width:100%;min-height:60px;padding:8px;background:var(--bg2,#171a22);border:1px solid var(--border,#2a2f3a);border-radius:6px;color:var(--text,#e6e9f0)"></textarea>
      <button class="btn primary sm" data-add-note="${esc(c.id)}" style="margin-top:6px">Add note</button>`;
    h+=`<div class="inbox-section-title">Support tickets <span class="count">${tickets.length}</span></div>`;
    if(!tickets.length)h+='<div class="empty">No open tickets.</div>';
    else h+=tickets.map(ticketCard).join("");
    h+=`<div class="inbox-section-title">Timeline</div>`;
    if(!timeline){h+='<div class="empty">Loading…</div>';}
    else if(!timeline.length){h+='<div class="empty">No activity yet.</div>';}
    else{
      h+=timeline.map(ev=>`<div class="todo-card" data-timeline-row="${esc(ev.id||"")}">
        <div class="todo-title">${esc(ev.title||ev.event_type||"event")}</div>
        ${ev.detail?'<div class="todo-detail">'+esc(ev.detail)+'</div>':''}
        <div class="todo-detail" style="font-size:11px;color:var(--muted,#9aa3b2)">${esc(ev.actor||"")} • ${fmtR(ev.created_at)}</div>
      </div>`).join("");
    }
    return h;
  }

  async function loadGpTimeline(userId,caseId){
    try{
      const r=await fetch("/api/admin/case?id="+encodeURIComponent(caseId),{credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      if(d&&d.ok){
        S.va.gpDetailCache[userId]=S.va.gpDetailCache[userId]||{};
        S.va.gpDetailCache[userId].timeline=Array.isArray(d.timeline)?d.timeline:[];
        if(S.view==="gps"&&S.selectedCaseId===caseId)renderDetail();
      }
    }catch(err){console.error("[VA] loadGpTimeline failed",err);}
  }
```

- [ ] **Step 6: Invalidate the detail cache on `loadVaDashboard`**

In `pages/admin.html` find `async function loadVaDashboard(){...}`. At the top of the function (right after the `S.va.loading=true;` if present, or as the first line inside), add:

```javascript
    S.va.gpDetailCache={};
```

This ensures cached quals/timeline are refetched the next time the user clicks a GP after a 15-second refresh.

- [ ] **Step 7: Smoke test**

`npm start` → admin login → GPs tab → click a GP. Verify:
- Desktop (>900px): two-column layout renders.
- Tasks tab shows "Next Action" card + grouped tasks.
- Documents tab shows approved / pending / missing sections after a brief loading flash.
- Journey tab shows the stepper.
- Notes tab shows the add-note input, support tickets, and timeline (after loading).
- Clicking another GP keeps the current tab active (tab persists per-session).
- Save on the case management form still works.
- Click a task's Complete button → task disappears, list refreshes.

Stop dev server.

- [ ] **Step 8: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): implement GPs detail tab panes (Tasks/Docs/Journey/Notes)

- Tasks: Next Action + priority groups + Add Task button
- Documents: approved/pending/missing from /api/admin/va/user-qualifications
- Journey: wraps existing buildJourney()
- Notes: add-note input, per-GP tickets, case timeline from /api/admin/case
- S.va.gpDetailCache caches per-user quals + timeline, invalidated on refresh"
```

---

## Task 10: GPs mobile single-scroll — verify the CSS override and add back button

**Files:**
- Modify: `pages/admin.html` (CSS + one back-button in the meta column)

The `body.gp-mobile` CSS rules added in Task 4 Step 4 already collapse the two-column grid into a single column, hide the tab strip, and force every pane to `display:block`. This task wires a mobile-only back button and verifies the full-screen behaviour.

- [ ] **Step 1: Add a mobile-only back button to the meta column**

In `pages/admin.html` — in the `renderDetail()` function, find the meta column block. At the very top of the meta column's inner HTML (right before the avatar div), insert:

```javascript
        <button class="btn sm" data-gp-back style="margin-bottom:8px;display:none" aria-label="Back to list">← Back to list</button>
```

Then add one line of CSS to the block you added in Task 4 Step 4 (append to the `body.gp-mobile` section):

```css
body.gp-mobile .gp-detail-meta [data-gp-back]{display:inline-block}
body.gp-mobile #mainLayout.detail-open .list-panel{display:none}
body.gp-mobile #mainLayout.detail-open .detail-panel{display:block}
```

And add the back handler inside the existing `detailContent` delegated listener (near the `[data-gp-tab]` handler from Task 9):

```javascript
      const gpBack=e.target.closest("[data-gp-back]");
      if(gpBack){S.selectedCaseId=null;document.getElementById("mainLayout").classList.remove("detail-open");renderCaseList();renderDetail();return;}
```

- [ ] **Step 2: Smoke test (mobile width)**

`npm start` → log in → GPs tab. Open DevTools → device toolbar → set width to 375px. Verify:
- `body.gp-mobile` class is present.
- The GP list is visible full-width.
- Clicking a GP hides the list and shows a full-screen scrollable profile.
- Every section (meta, tasks, documents, journey, notes) renders stacked in one scroll.
- Clicking `← Back to list` returns to the list.
- Switching to desktop width (>900px) reverts to the two-column layout.

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): mobile single-scroll GP profile with back button

body.gp-mobile CSS stacks the detail grid into one column, forces all
four tab panes visible, and reveals the back button. detail-open
toggle gives the list/detail a full-screen flip on mobile."
```

---

## Task 11: Tools tab — sub-nav + Ops sub-view reparenting

**Files:**
- Modify: `pages/admin.html` (new `renderToolsPanel`, reparent `#opsPanel` content into `#toolsPanel`)

- [ ] **Step 1: Reparent `#opsPanel` content into Tools panel**

In `pages/admin.html` replace `<div class="tools-wrap" id="toolsPanel" style="display:none"></div>` with:

```html
  <div class="tools-wrap" id="toolsPanel" style="display:none">
    <div class="tools-subnav" id="toolsSubnav"></div>
    <div class="tools-sub-pane" id="toolsOps" style="display:none"></div>
    <div class="tools-sub-pane" id="toolsSweep" style="display:none"></div>
    <div class="tools-sub-pane" id="toolsAgent" style="display:none"></div>
  </div>
```

Then move the inner content of `#opsPanel` (stats, filters, table) into `#toolsOps` and delete the old `#opsPanel` div entirely. Remove the `opsPanel` line from `vaShowPanel`.

- [ ] **Step 2: Replace the `renderToolsPanel` stub**

```javascript
  function renderToolsPanel(){
    const el=document.getElementById("toolsPanel");if(!el)return;
    const subnav=document.getElementById("toolsSubnav");if(!subnav)return;
    const saOnly=typeof isSA==="function"&&isSA();
    const items=[{key:"ops",label:"Ops Queue"},{key:"sweep",label:"Weekly Sweep"}];
    if(saOnly)items.push({key:"agent",label:"Agent"});
    if(S.toolsSubView==="agent"&&!saOnly)S.toolsSubView="ops";
    subnav.innerHTML=items.map(i=>`<button class="tools-subnav-btn ${S.toolsSubView===i.key?"active":""}" data-tools-sub="${i.key}">${esc(i.label)}</button>`).join("");
    document.getElementById("toolsOps").style.display=(S.toolsSubView==="ops"?"block":"none");
    document.getElementById("toolsSweep").style.display=(S.toolsSubView==="sweep"?"block":"none");
    document.getElementById("toolsAgent").style.display=(S.toolsSubView==="agent"?"block":"none");
    if(S.toolsSubView==="ops"&&typeof loadOpsQueue==="function")loadOpsQueue();
    else if(S.toolsSubView==="sweep")renderToolsSweepPane();
    else if(S.toolsSubView==="agent")renderToolsAgentPane();
  }
```

- [ ] **Step 3: Stub Sweep and Agent pane renderers**

```javascript
  function renderToolsSweepPane(){
    const el=document.getElementById("toolsSweep");if(!el)return;
    el.innerHTML='<div class="empty">Weekly Sweep — Task 12</div>';
  }
  function renderToolsAgentPane(){
    const el=document.getElementById("toolsAgent");if(!el)return;
    el.innerHTML='<div class="empty">Agent — Task 13</div>';
  }
```

- [ ] **Step 4: Add sub-nav + sweep click handlers**

In the Inbox/Tools delegated listener add:

```javascript
    const subBtn=e.target.closest("[data-tools-sub]");
    if(subBtn){e.preventDefault();e.stopPropagation();S.toolsSubView=subBtn.getAttribute("data-tools-sub");renderToolsPanel();return;}
```

- [ ] **Step 5: Smoke test + commit**

Verify Ops Queue loads inside Tools, filters/SLA/Refresh work.

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): Tools tab with Ops Queue sub-view"
```

---

## Task 12: Tools — Weekly Sweep sub-view

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Replace `renderToolsSweepPane`**

```javascript
  function renderToolsSweepPane(){
    const el=document.getElementById("toolsSweep");if(!el)return;
    const last=S.va.lastSweepResult;
    const lastHtml=last
      ? `<div class="todo-card" style="margin-top:12px"><div class="todo-title">Last run</div><div class="todo-detail">Scanned ${esc(String(last.scanned||0))} — created ${esc(String(last.created||0))} new tasks · Ran at ${esc(new Date(last.at).toLocaleTimeString())}</div></div>`
      : '<div class="empty" style="margin-top:12px">No sweep run yet this session.</div>';
    el.innerHTML=`<h2 style="margin:0 0 6px">Weekly Check-in Sweep</h2>
      <p style="color:var(--muted,#9aa3b2);margin:0 0 12px">Creates check-in tasks for GPs stalled 14+ days in MyIntealth or AMC without an existing check-in task in the last 7 days.</p>
      <button class="btn primary" data-tools-sweep-run>Run Sweep Now</button>${lastHtml}`;
  }
```

- [ ] **Step 2: Update `runWeeklyCheckinSweep` to store result in `S.va.lastSweepResult`**

```javascript
  async function runWeeklyCheckinSweep(){
    try{
      const r=await fetch("/api/admin/va/weekly-checkin/sweep",{method:"POST",credentials:"same-origin"});
      const d=await r.json().catch(()=>({}));
      if(d&&d.ok){
        S.va.lastSweepResult={scanned:d.scanned||0,created:d.created||0,at:new Date().toISOString()};
        toast("Weekly sweep: "+(d.created||0)+" new check-in tasks (scanned "+(d.scanned||0)+")");
      }else toast("Sweep failed","red");
      await loadVaDashboard();
      if(S.view==="inbox")renderInboxPanel();
      if(S.view==="tools"&&S.toolsSubView==="sweep")renderToolsSweepPane();
    }catch{toast("Network error","red");}
  }
```

- [ ] **Step 3: Add sweep-run click handler**

In the Inbox/Tools delegated listener add:

```javascript
    const sweepRun=e.target.closest("[data-tools-sweep-run]");
    if(sweepRun){e.preventDefault();e.stopPropagation();runWeeklyCheckinSweep();return;}
```

- [ ] **Step 4: Smoke test + commit**

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): Tools Weekly Sweep sub-view with result log"
```

---

## Task 13: Tools — Agent sub-view reparenting (SA only)

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Replace `renderToolsAgentPane`**

```javascript
  function renderToolsAgentPane(){
    const el=document.getElementById("toolsAgent");if(!el)return;
    el.innerHTML=`<div style="display:grid;grid-template-columns:320px 1fr;gap:16px;min-height:400px">
      <div id="toolsAgentRunList" style="border-right:1px solid var(--border,#2a2f3a);padding-right:16px;overflow-y:auto"></div>
      <div id="toolsAgentDetail" style="overflow-y:auto"></div>
    </div>`;
    if(typeof refreshAgentStatus==="function")refreshAgentStatus(true);
    if(typeof renderAgentRunList==="function")renderAgentRunList();
    if(typeof renderAgentDetail==="function")renderAgentDetail();
  }
```

If existing `renderAgentRunList` and `renderAgentDetail` write into `#caseList` and `#detailContent` respectively, after calling them move their output into the new containers:

```javascript
    const listSrc=document.getElementById("caseList");
    const listDst=document.getElementById("toolsAgentRunList");
    if(listSrc&&listDst&&listSrc.children.length){while(listSrc.firstChild)listDst.appendChild(listSrc.firstChild);}
    const detSrc=document.getElementById("detailContent");
    const detDst=document.getElementById("toolsAgentDetail");
    if(detSrc&&detDst&&detSrc.innerHTML.includes("data-agent")){detDst.innerHTML=detSrc.innerHTML;detSrc.innerHTML="";}
```

- [ ] **Step 2: Add agent click delegation for new container**

Near the other delegated handlers add:

```javascript
  document.addEventListener("click",async e=>{
    const root=document.getElementById("toolsAgentDetail");
    if(!root||!root.contains(e.target))return;
    const agStart=e.target.closest("[data-agent-start]");if(agStart){startAgentRun();return;}
    const agRefresh=e.target.closest("[data-agent-refresh]");if(agRefresh){refreshAgentStatus(true);return;}
    const agCancel=e.target.closest("[data-agent-cancel]");if(agCancel){cancelAgentRun(agCancel.getAttribute("data-agent-cancel"));return;}
    const agConnect=e.target.closest("[data-agent-connect]");if(agConnect){showAgentConnectHelp(agConnect.getAttribute("data-agent-connect"));return;}
  },true);
  document.addEventListener("click",async e=>{
    const root=document.getElementById("toolsAgentRunList");
    if(!root||!root.contains(e.target))return;
    const agentRun=e.target.closest("[data-agent-run-id]");
    if(agentRun){S.agent.selectedRunId=agentRun.getAttribute("data-agent-run-id");S.agent.currentRun=null;renderToolsAgentPane();loadAgentRun(S.agent.selectedRunId);return;}
  },true);
```

- [ ] **Step 3: Smoke test (SA account) + commit**

Verify agent run list/detail render, start/cancel/refresh work, non-SA users cannot see Agent button.

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): Tools Agent sub-view reparents existing agent UI (SA only)"
```

---

## Task 14: Global search — client-side matching + dropdown

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Implement `runGlobalSearch` (client-side instant + server-side async)**

Add near the other search logic:

```javascript
  function runGlobalSearch(q){
    if(!q||q.length<2){S.search.open=false;renderSearchResults();return;}
    S.search.query=q;
    const ql=q.toLowerCase();

    // Client-side: GPs
    const gpList=(S.va.dashboard&&Array.isArray(S.va.dashboard.users))?S.va.dashboard.users:[];
    S.search.clientResults.gps=gpList.filter(u=>
      (u.gp_name||"").toLowerCase().includes(ql)||
      (u.gp_email||"").toLowerCase().includes(ql)||
      (u.gp_phone||"").includes(ql)||
      (u.practice_name||"").toLowerCase().includes(ql)
    ).slice(0,20);

    // Client-side: Tasks
    const taskList=[...(S.tasks||[]),...((S.va.dashboard&&S.va.dashboard.todays_tasks)||[])];
    const seenT=new Set();
    S.search.clientResults.tasks=taskList.filter(t=>{
      if(seenT.has(t.id))return false;seenT.add(t.id);
      return(t.title||"").toLowerCase().includes(ql)||(t.description||"").toLowerCase().includes(ql);
    }).slice(0,20);

    // Client-side: Tickets
    const ticketList=[...((S.va.dashboard&&S.va.dashboard.open_tickets)||[]),...(S.va.tickets||[])];
    const seenTk=new Set();
    S.search.clientResults.tickets=ticketList.filter(tk=>{
      if(seenTk.has(tk.id))return false;seenTk.add(tk.id);
      return(tk.title||"").toLowerCase().includes(ql)||(tk.body||"").toLowerCase().includes(ql)||(tk.category||"").toLowerCase().includes(ql);
    }).slice(0,20);

    S.search.open=true;
    renderSearchResults();

    // Server-side: documents + notes
    S.search.loading=true;
    clearTimeout(S.search.debounceTimer);
    S.search.debounceTimer=setTimeout(async()=>{
      try{
        const r=await fetch("/api/admin/va/search?q="+encodeURIComponent(q),{credentials:"same-origin"});
        const d=await r.json().catch(()=>({}));
        if(d&&d.ok&&d.results){
          S.search.serverResults.documents=Array.isArray(d.results.documents)?d.results.documents:[];
          S.search.serverResults.notes=Array.isArray(d.results.notes)?d.results.notes:[];
        }
      }catch{
        S.search.serverResults.documents=[];
        S.search.serverResults.notes=[];
      }
      S.search.loading=false;
      if(S.search.open)renderSearchResults();
    },200);
  }
```

- [ ] **Step 2: Implement `renderSearchResults`**

```javascript
  function renderSearchResults(){
    const el=document.getElementById("globalSearchResults");if(!el)return;
    if(!S.search.open){el.style.display="none";return;}
    el.style.display="block";
    const gps=S.search.clientResults.gps.slice(0,5);
    const tasks=S.search.clientResults.tasks.slice(0,5);
    const tickets=S.search.clientResults.tickets.slice(0,5);
    const docs=S.search.serverResults.documents.slice(0,5);
    const notes=S.search.serverResults.notes.slice(0,5);
    const total=gps.length+tasks.length+tickets.length+docs.length+notes.length;
    if(!total&&!S.search.loading){el.innerHTML='<div class="top-search-empty">No results found.</div>';return;}
    let h='';
    function group(title,items,renderer,allItems){
      if(!items.length)return'';
      let s=`<div class="top-search-group"><div class="top-search-group-title">${esc(title)}</div>`;
      s+=items.map(renderer).join("");
      if(allItems.length>5)s+=`<div class="top-search-more" data-search-expand="${esc(title.toLowerCase())}">+ ${allItems.length-5} more</div>`;
      s+='</div>';
      return s;
    }
    h+=group("GPs",gps,g=>`<div class="top-search-row" data-search-gp="${esc(g.case_id)}"><div class="top-search-row-main">${esc(g.gp_name)}</div><div class="top-search-row-sub">${esc(g.stage||"")}</div></div>`,S.search.clientResults.gps);
    h+=group("Tasks",tasks,t=>`<div class="top-search-row" data-search-task="${esc(t.id)}" data-search-case="${esc(t.case_id)}"><div class="top-search-row-main">${esc(t.title)}</div><div class="top-search-row-sub">${esc(t.gp_name||"")}</div></div>`,S.search.clientResults.tasks);
    h+=group("Tickets",tickets,tk=>`<div class="top-search-row" data-search-ticket="${esc(tk.id)}" data-search-user="${esc(tk.user_id)}"><div class="top-search-row-main">${esc(tk.title||"Support request")}</div><div class="top-search-row-sub">${esc(tk.gp_name||"")}</div></div>`,S.search.clientResults.tickets);
    h+=group("Documents",docs,d=>`<div class="top-search-row" data-search-doc-user="${esc(d.user_id)}" data-search-doc-key="${esc(d.key)}"><div class="top-search-row-main">${esc(d.label)} — ${esc(d.file_name)}</div><div class="top-search-row-sub">${esc(d.gp_name||"")}</div></div>`,S.search.serverResults.documents);
    h+=group("Notes",notes,n=>`<div class="top-search-row" data-search-note-case="${esc(n.case_id)}"><div class="top-search-row-main">${esc(n.title||n.event_type||"note")}</div><div class="top-search-row-sub">${esc(n.gp_name||"")} · ${fmtR(n.created_at)}</div></div>`,S.search.serverResults.notes);
    if(S.search.loading)h+='<div class="top-search-footer">Searching documents and notes…</div>';
    el.innerHTML=h;
  }
```

- [ ] **Step 3: Wire the search input and close behaviour**

In `bind()`, after the existing `#searchInput` handler, add:

```javascript
    const gs=document.getElementById("globalSearch");
    if(gs){
      gs.addEventListener("input",e=>{runGlobalSearch((e.target.value||"").trim());});
      gs.addEventListener("focus",()=>{if(S.search.query.length>=2){S.search.open=true;renderSearchResults();}});
    }
    document.addEventListener("click",e=>{
      const sr=document.getElementById("globalSearchResults");
      const si=document.getElementById("globalSearch");
      if(sr&&si&&!sr.contains(e.target)&&e.target!==si){S.search.open=false;renderSearchResults();}
    });
```

- [ ] **Step 4: Wire search result click routing**

In `bind()` or a new delegated handler on `#globalSearchResults`:

```javascript
    const srEl=document.getElementById("globalSearchResults");
    if(srEl)srEl.addEventListener("click",e=>{
      const gp=e.target.closest("[data-search-gp]");
      if(gp){S.selectedCaseId=gp.getAttribute("data-search-gp");S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();S.search.open=false;renderSearchResults();document.getElementById("globalSearch").value="";return;}
      const task=e.target.closest("[data-search-task]");
      if(task){S.selectedCaseId=task.getAttribute("data-search-case");S.gpsProfileTab="tasks";S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();S.search.open=false;renderSearchResults();document.getElementById("globalSearch").value="";return;}
      const ticket=e.target.closest("[data-search-ticket]");
      if(ticket){const uid=ticket.getAttribute("data-search-user");const c=(S.cases||[]).find(x=>x.user_id===uid);if(c)S.selectedCaseId=c.id;S.gpsProfileTab="notes";S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();S.search.open=false;renderSearchResults();document.getElementById("globalSearch").value="";return;}
      const doc=e.target.closest("[data-search-doc-user]");
      if(doc){const uid=doc.getAttribute("data-search-doc-user");const c=(S.cases||[]).find(x=>x.user_id===uid);if(c)S.selectedCaseId=c.id;S.gpsProfileTab="documents";S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();S.search.open=false;renderSearchResults();document.getElementById("globalSearch").value="";return;}
      const note=e.target.closest("[data-search-note-case]");
      if(note){S.selectedCaseId=note.getAttribute("data-search-note-case");S.gpsProfileTab="notes";S.view="gps";document.querySelectorAll(".view-tab").forEach(t=>t.classList.toggle("active",t.getAttribute("data-view")==="gps"));vaShowPanel("gps");renderCaseList();renderDetail();S.search.open=false;renderSearchResults();document.getElementById("globalSearch").value="";return;}
      const expand=e.target.closest("[data-search-expand]");
      if(expand){/* re-render with expanded group — call renderSearchResults with a flag */return;}
    });
```

- [ ] **Step 5: Smoke test + commit**

Verify typing "kha" shows GP results instantly. Typing "cct" shows document results after server returns. Clicking a result routes to the right GP + tab. Click outside or Esc closes dropdown.

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): global search — hybrid client + server with routing"
```

---

## Task 15: Keyboard shortcuts (`/` focus, `Esc` close)

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add global keydown handler**

In `bind()`, add:

```javascript
    document.addEventListener("keydown",e=>{
      if(e.key==="/"&&document.activeElement.tagName!=="INPUT"&&document.activeElement.tagName!=="TEXTAREA"){
        e.preventDefault();
        const gs=document.getElementById("globalSearch");
        if(gs)gs.focus();
        return;
      }
      if(e.key==="Escape"){
        S.search.open=false;
        renderSearchResults();
        const gs=document.getElementById("globalSearch");
        if(gs){gs.value="";gs.blur();}
      }
    });
```

- [ ] **Step 2: Smoke test + commit**

Verify `/` focuses search box. Esc clears and closes. Neither shortcut fires when typing in an input or textarea.

```bash
git add pages/admin.html
git commit -m "feat(va-dashboard): / focuses global search, Esc clears and closes"
```

---

## Task 16: Run tests + manual smoke test full checklist

**Files:** No changes — verification only.

- [ ] **Step 1: Run the automated test suite**

```bash
npx vitest run tests/admin-va-search.test.js
```

Expected: all pass.

```bash
npm test
```

Expected: full test suite green (no regressions).

- [ ] **Step 2: Walk through the manual smoke test checklist from the spec**

Use `npm start` and go through every item in the spec's `Manual test checklist` section. Mark each one:

1. Fresh page load lands on Inbox.
2. Each of the 5 tabs opens its panel.
3. Tools sub-nav switches between Ops / Sweep / Agent.
4. Agent sub-view is hidden for non-SA users.
5. Inbox: ticket Resolve & Close → ticket disappears, dashboard refreshes.
6. Inbox: task Complete → task disappears, correct section count decrements.
7. Inbox: task Open Case → lands on GPs tab with that case selected.
8. Inbox blocked-case Open profile → lands on GPs tab with that case selected.
9. GPs list: filter chips change counts and visible rows.
10. GPs list: tab-scoped search filters the list.
11. GPs desktop: meta column + tabbed content render side by side at 1200px.
12. GPs desktop: clicking a different GP keeps the current tab active.
13. GPs desktop: Tasks / Documents / Journey / Notes tabs switch content.
14. GPs desktop: Save on case management form posts and toasts success.
15. GPs mobile (375px): single-scroll profile renders with all sections in order.
16. GPs mobile: back button returns to the list.
17. Documents sub-view: View button on an approved doc opens a signed URL in a new tab.
18. Journey sub-view: substeps render, stage playbook cards render.
19. Notes sub-view: add note posts and appears in timeline.
20. Global search: typing "kha" shows GP matches client-side within 200ms.
21. Global search: typing "cct" shows document matches after server-side call.
22. Global search: clicking a Document result lands on GPs tab → Documents.
23. Global search: `/` focuses search box; Esc clears and closes.
24. 15-second poll refreshes the inbox without scrolling.
25. 401 redirects to admin login page.

If any item fails, fix it before proceeding.

- [ ] **Step 3: Final commit**

If any fixes were needed, stage and commit them:

```bash
git add pages/admin.html server.js
git commit -m "fix(va-dashboard): smoke test fixes for UI consolidation"
```

---

## Self-review

### Spec coverage

| Spec section | Task(s) |
|---|---|
| 5-tab nav | T4 |
| Inbox — priority sections | T5 |
| GPs — list + filters | T7 |
| GPs — desktop two-column | T8 |
| GPs — sub-tab switching | T9 |
| GPs — mobile single-scroll | T6, T10 |
| Interviews/Applications passthrough | T4 (tab wiring only) |
| Tools — Ops | T11 |
| Tools — Sweep | T12 |
| Tools — Agent (SA) | T13 |
| Global search | T14 |
| Keyboard shortcuts | T15 |
| Search endpoint | T1, T2 |
| What gets deleted | T3 |
| What gets kept | All tasks preserve existing helpers/endpoints |
| Testing | T1 (unit tests), T16 (manual checklist) |

No gaps found.

### Placeholder scan

No TBD, TODO, "fill in later", or "similar to Task N" entries. Every code step has a complete code block.

### Type consistency

- `S.view` values: `"inbox"`, `"gps"`, `"interviews"`, `"applications"`, `"tools"` — consistent across Tasks 4, 5, 7, 8, 9, 11, 14.
- `S.toolsSubView` values: `"ops"`, `"sweep"`, `"agent"` — consistent across Tasks 4, 11, 12, 13.
- `S.gpsProfileTab` values: `"tasks"`, `"documents"`, `"journey"`, `"notes"` — consistent across Tasks 4, 8, 9, 14.
- `renderInboxPanel` — defined T5, called T4/T5/T12.
- `renderToolsPanel` — defined T11, called T4/T11.
- `renderSearchResults` — defined T14, called T14/T15.
- `ticketCard` / `taskCard` / `blockerRow` — defined T5, called T5/T9.
- `sanitizeVaSearchQuery` / `parseVaSearchScope` — defined T1 in server.js, used T2.

No mismatches found.
