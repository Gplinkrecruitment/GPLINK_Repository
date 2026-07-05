# Phase 0 — Zoho Data Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While Zoho Recruit is still connected, pull ALL Job Openings, Clients/Accounts and Candidates into an owned Supabase archive, and build a name/email/phone re-engagement list of non-hired candidates — losing nothing when Zoho is later removed.

**Architecture:** Add pure, unit-testable helpers in a new `lib/zoho-archive.js` (hired detection, lead mapping, archive-row normalization). Add three bulk pagers + an archive writer + a lead writer + a capture orchestrator + one admin/cron-protected endpoint in `server.js`, reusing the existing Zoho auth (`getZohoRecruitAccessTokenAndDomain`), generic pager (`fetchZohoRecruitRecordsWithVariants`) and Supabase wrapper (`supabaseDbRequest`). Two new tables (`zoho_archive`, `candidate_leads`) via a migration applied to prod through the `exec_sql` RPC. The `zoho_archive` table is the authoritative retained store (full raw payload per record); no PII is committed to git.

**Tech Stack:** Node.js monolith (`server.js`), Supabase/PostgREST, Zoho Recruit v2 API, Vitest.

## Global Constraints

- Base branch: `worktree-zoho-decommission-masked-pipeline` off `origin/main` @ `ecfb5e7` (the live code; never base on the stale local `main`).
- Nothing Zoho is REMOVED in Phase 0 — capture only, fully reversible.
- Do not commit candidate PII (name/email/phone) to git. The retained store is the `zoho_archive` + `candidate_leads` tables in Supabase only.
- Exclude any candidate marked hired from `candidate_leads` (still archive them raw in `zoho_archive`).
- Preserve the raw Zoho record verbatim in `zoho_archive.payload` (jsonb).
- Supabase access: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (from the main checkout `.env`; the worktree has no `.env`). DDL via `POST {SUPABASE_URL}/rest/v1/rpc/exec_sql` with JSON body `{ "query": "<sql>" }` (returns void — verify with REST reads).
- Tests: `node node_modules/vitest/vitest.mjs run` using the local Node at `/tmp/node-v20.18.1-darwin-arm64/bin/node`. Mirror `tests/ats-zoho-optional.test.js` for server-harness tests; unit-test `lib/zoho-archive.js` by direct `require`.
- Commit after every green task. Push at end of plan. Do NOT open the PR yet (Phase 0 is one of several phases on this branch).

---

## File Structure

- **Create** `lib/zoho-archive.js` — pure helpers: `isZohoCandidateHired`, `toCandidateLead`, `normalizeArchiveRow`. No I/O, no `require` of server.js.
- **Create** `supabase/migrations/20260705120000_zoho_archive.sql` — `zoho_archive` + `candidate_leads` tables.
- **Create** `tests/zoho-archive-lib.test.js` — unit tests for `lib/zoho-archive.js`.
- **Create** `tests/zoho-archive-capture.test.js` — server-harness test for the pagers + capture endpoint (stubbed Zoho fetch, emulated PostgREST).
- **Modify** `server.js` — add `fetchAllZohoRecruitJobOpenings`, `fetchAllZohoRecruitClients`, `fetchAllZohoRecruitCandidates`, `writeZohoArchiveRecords`, `upsertCandidateLeads`, `captureZohoArchive`, the route `POST /api/integrations/zoho-recruit/archive-capture`, and expose the new functions on `module.exports.__testUtils`.
- **Create** `scripts/run-zoho-archive-capture.mjs` — one-off runner an operator (me) invokes to trigger the capture against prod via the admin endpoint (or directly), then verify counts.

---

## Data shapes (used across tasks)

```js
// lib/zoho-archive.js exports
// isZohoCandidateHired(record: object) -> boolean
// toCandidateLead(record: object) -> { name: string, email: string, phone: string, zoho_candidate_id: string } | null
// normalizeArchiveRow(entityType: string, record: object, pulledAtIso: string)
//    -> { entity_type: string, zoho_id: string, payload: object, pulled_at: string } | null
```

```sql
-- zoho_archive: one row per raw Zoho record, authoritative retained copy
zoho_archive(
  id uuid pk default gen_random_uuid(),
  entity_type text not null,        -- 'job_opening' | 'client' | 'candidate'
  zoho_id text not null,            -- Zoho record id
  payload jsonb not null,           -- raw Zoho record verbatim
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(entity_type, zoho_id)
)

-- candidate_leads: name/email/phone re-engagement list (non-hired only)
candidate_leads(
  id uuid pk default gen_random_uuid(),
  zoho_candidate_id text unique,
  name text,
  email text not null,
  phone text,
  source text not null default 'zoho_recruit',
  unsubscribed boolean not null default false,   -- for the future signup campaign
  created_at timestamptz not null default now()
)
```

---

### Task 1: Migration — `zoho_archive` + `candidate_leads` tables

**Files:**
- Create: `supabase/migrations/20260705120000_zoho_archive.sql`

**Interfaces:**
- Produces: tables `zoho_archive(entity_type, zoho_id, payload, pulled_at, …)` and `candidate_leads(zoho_candidate_id, name, email, phone, source, unsubscribed, …)` consumed by Tasks 6, 7, 9.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260705120000_zoho_archive.sql`:

```sql
begin;

create table if not exists public.zoho_archive (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  zoho_id text not null,
  payload jsonb not null,
  pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (entity_type, zoho_id)
);
create index if not exists zoho_archive_entity_idx on public.zoho_archive (entity_type);
alter table public.zoho_archive disable row level security;
revoke all on public.zoho_archive from anon, authenticated;

create table if not exists public.candidate_leads (
  id uuid primary key default gen_random_uuid(),
  zoho_candidate_id text unique,
  name text,
  email text not null,
  phone text,
  source text not null default 'zoho_recruit',
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists candidate_leads_email_idx on public.candidate_leads (lower(email));
alter table public.candidate_leads disable row level security;
revoke all on public.candidate_leads from anon, authenticated;

commit;
```

- [ ] **Step 2: Apply to prod via exec_sql and verify**

Run (from the main checkout so `.env` loads):
```bash
cd "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/zoho-decommission-masked-pipeline"
set -a; source "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env"; set +a
SQL=$(tr '\n' ' ' < supabase/migrations/20260705120000_zoho_archive.sql)
curl -s "$SUPABASE_URL/rest/v1/rpc/exec_sql" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.stdin.read()}))' <<<"$SQL")" -w '\nHTTP %{http_code}\n'
# verify both tables are reachable (expect HTTP 200)
for t in zoho_archive candidate_leads; do
  echo -n "$t -> "; curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/$t?select=id&limit=1" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
done
```
Expected: exec_sql returns HTTP 204 (or 200); both table probes return `200`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260705120000_zoho_archive.sql
git commit -m "Phase 0: add zoho_archive + candidate_leads tables (applied to prod)"
```

---

### Task 2: `lib/zoho-archive.js` — pure helpers

**Files:**
- Create: `lib/zoho-archive.js`
- Test: `tests/zoho-archive-lib.test.js`

**Interfaces:**
- Produces: `isZohoCandidateHired(record)`, `toCandidateLead(record)`, `normalizeArchiveRow(entityType, record, pulledAtIso)` — consumed by Tasks 4, 6, 7.

- [ ] **Step 1: Write the failing tests**

Create `tests/zoho-archive-lib.test.js`:

```js
const { describe, it, expect } = require('vitest');
const { isZohoCandidateHired, toCandidateLead, normalizeArchiveRow } = require('../lib/zoho-archive.js');

describe('isZohoCandidateHired', () => {
  it('is true when Candidate_Status says Hired (any case)', () => {
    expect(isZohoCandidateHired({ Candidate_Status: 'Hired' })).toBe(true);
    expect(isZohoCandidateHired({ Candidate_Status: 'hired' })).toBe(true);
    expect(isZohoCandidateHired({ Status: 'Placed' })).toBe(true);
  });
  it('is false for active/other statuses', () => {
    expect(isZohoCandidateHired({ Candidate_Status: 'New' })).toBe(false);
    expect(isZohoCandidateHired({})).toBe(false);
  });
});

describe('toCandidateLead', () => {
  it('extracts name/email/phone/id', () => {
    expect(toCandidateLead({
      id: '123', Full_Name: 'Dr Jane Doe', Email: 'jane@example.com', Phone: '0400000000'
    })).toEqual({ name: 'Dr Jane Doe', email: 'jane@example.com', phone: '0400000000', zoho_candidate_id: '123' });
  });
  it('falls back to First+Last name and Mobile', () => {
    expect(toCandidateLead({
      id: '9', First_Name: 'Jane', Last_Name: 'Doe', Email: 'j@x.com', Mobile: '0411'
    })).toEqual({ name: 'Jane Doe', email: 'j@x.com', phone: '0411', zoho_candidate_id: '9' });
  });
  it('returns null when there is no email', () => {
    expect(toCandidateLead({ id: '1', Full_Name: 'No Email' })).toBeNull();
  });
});

describe('normalizeArchiveRow', () => {
  it('builds a row keyed by entity_type + zoho id', () => {
    const row = normalizeArchiveRow('candidate', { id: '77', Full_Name: 'X' }, '2026-07-05T00:00:00.000Z');
    expect(row).toEqual({
      entity_type: 'candidate', zoho_id: '77',
      payload: { id: '77', Full_Name: 'X' }, pulled_at: '2026-07-05T00:00:00.000Z'
    });
  });
  it('returns null when the record has no id', () => {
    expect(normalizeArchiveRow('client', { Full_Name: 'X' }, '2026-07-05T00:00:00.000Z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-lib.test.js`
Expected: FAIL — `Cannot find module '../lib/zoho-archive.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/zoho-archive.js`:

```js
// lib/zoho-archive.js — pure helpers for the Zoho data capture (no I/O).

function firstString(record, keys) {
  for (const k of keys) {
    const v = record && record[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// A candidate counts as hired if a status field reads hired/placed.
function isZohoCandidateHired(record) {
  const status = firstString(record || {}, ['Candidate_Status', 'Status', '$state']).toLowerCase();
  return /\b(hired|placed)\b/.test(status);
}

// Build a re-engagement lead (name/email/phone). Null when no email.
function toCandidateLead(record) {
  const r = record || {};
  const email = firstString(r, ['Email', 'Email_Address', 'Secondary_Email']);
  if (!email) return null;
  let name = firstString(r, ['Full_Name', 'Candidate_Name', 'Name']);
  if (!name) {
    const fn = firstString(r, ['First_Name']);
    const ln = firstString(r, ['Last_Name']);
    name = [fn, ln].filter(Boolean).join(' ');
  }
  const phone = firstString(r, ['Phone', 'Mobile', 'Contact_Number']);
  return { name: name, email: email, phone: phone, zoho_candidate_id: String(r.id || '') };
}

// Normalize any raw Zoho record into a zoho_archive row. Null when no id.
function normalizeArchiveRow(entityType, record, pulledAtIso) {
  const id = record && record.id != null ? String(record.id) : '';
  if (!id) return null;
  return { entity_type: String(entityType), zoho_id: id, payload: record, pulled_at: pulledAtIso };
}

module.exports = { isZohoCandidateHired, toCandidateLead, normalizeArchiveRow };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-lib.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/zoho-archive.js tests/zoho-archive-lib.test.js
git commit -m "Phase 0: pure helpers for Zoho capture (hired filter, lead mapping, archive row)"
```

---

### Task 3: Bulk pagers for Job Openings, Clients, Candidates

**Files:**
- Modify: `server.js` (add the three pagers near `fetchZohoRecruitRecordsWithVariants` @ ~19455; export on `__testUtils` @ ~50954)
- Test: `tests/zoho-archive-capture.test.js` (pager portion)

**Interfaces:**
- Consumes: `getZohoRecruitAccessTokenAndDomain()` (server.js:18757), `fetchZohoRecruitRecordsWithVariants(connection, accessToken, apiDomain, resourcePaths, queryParams)` (server.js:19455).
- Produces: `async fetchAllZohoRecruitJobOpenings(zoho)`, `async fetchAllZohoRecruitClients(zoho)`, `async fetchAllZohoRecruitCandidates(zoho)` — each returns `Array<rawRecord>`. `zoho = { accessToken, apiDomain, connection }`.

- [ ] **Step 1: Write the pager implementation (shared loop)**

Add to `server.js` immediately after `fetchZohoRecruitRecordsWithVariants` (~line 19500):

```js
// Page every record from a Zoho Recruit module, following more_records.
async function fetchAllZohoRecruitModule(zoho, resourcePaths) {
  const out = [];
  const perPage = ZOHO_RECRUIT_SYNC_PAGE_SIZE || 200;
  const maxPages = ZOHO_RECRUIT_SYNC_MAX_PAGES || 25;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchZohoRecruitRecordsWithVariants(
      zoho.connection, zoho.accessToken, zoho.apiDomain, resourcePaths, { page: page, per_page: perPage }
    );
    const records = (result && result.records) || [];
    for (const r of records) out.push(r);
    const more = result && result.data && result.data.info && result.data.info.more_records;
    if (!more || records.length === 0) break;
  }
  return out;
}

async function fetchAllZohoRecruitJobOpenings(zoho) {
  return fetchAllZohoRecruitModule(zoho, ['JobOpenings', 'jobopenings', 'Job_Openings']);
}
async function fetchAllZohoRecruitClients(zoho) {
  return fetchAllZohoRecruitModule(zoho, ['Clients', 'clients']);
}
async function fetchAllZohoRecruitCandidates(zoho) {
  return fetchAllZohoRecruitModule(zoho, ['Candidates', 'candidates']);
}
```

- [ ] **Step 2: Export on `__testUtils`**

In the `module.exports.__testUtils = { ... }` object (~server.js:50954), add:

```js
  fetchAllZohoRecruitModule,
  fetchAllZohoRecruitJobOpenings,
  fetchAllZohoRecruitClients,
  fetchAllZohoRecruitCandidates,
```

- [ ] **Step 3: Write the failing pager test**

Create `tests/zoho-archive-capture.test.js` with a stubbed `fetchZohoRecruitRecordsWithVariants` via `__testUtils` injection. Because the pagers call the module-scoped `fetchZohoRecruitRecordsWithVariants`, test the loop logic by exposing a seam: add (Step 1 already did) `fetchAllZohoRecruitModule(zoho, paths)` and in the test pass a `zoho` whose calls are intercepted through a test-only override.

Add a test-only injection point in `server.js` (~after the pagers):

```js
// test seam: allow tests to stub the underlying record fetcher
let _zohoRecordFetcherForTests = null;
function __setZohoRecordFetcherForTests(fn) { _zohoRecordFetcherForTests = fn; }
```
and change `fetchAllZohoRecruitModule` to use it when set:
```js
    const result = _zohoRecordFetcherForTests
      ? await _zohoRecordFetcherForTests(resourcePaths, { page: page, per_page: perPage })
      : await fetchZohoRecruitRecordsWithVariants(zoho.connection, zoho.accessToken, zoho.apiDomain, resourcePaths, { page: page, per_page: perPage });
```
Export `__setZohoRecordFetcherForTests` on `__testUtils`.

Now the test:

```js
const { describe, it, expect, beforeAll, afterAll } = require('vitest');
let U;
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  U = mod.__testUtils || (mod.default && mod.default.__testUtils);
});

describe('fetchAllZohoRecruitModule', () => {
  it('follows more_records across pages and concatenates', async () => {
    const pages = {
      1: { records: [{ id: '1' }, { id: '2' }], data: { info: { more_records: true } } },
      2: { records: [{ id: '3' }], data: { info: { more_records: false } } },
    };
    U.__setZohoRecordFetcherForTests(async (_paths, q) => pages[q.page] || { records: [], data: { info: { more_records: false } } });
    const all = await U.fetchAllZohoRecruitModule({}, ['Candidates']);
    expect(all.map(r => r.id)).toEqual(['1', '2', '3']);
    U.__setZohoRecordFetcherForTests(null);
  });
});
```

- [ ] **Step 4: Run to verify fail then pass**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-capture.test.js`
Expected: FAIL before Step 1–2 wiring is complete (e.g. `U.fetchAllZohoRecruitModule is not a function`), PASS after.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/zoho-archive-capture.test.js
git commit -m "Phase 0: bulk Zoho pagers for Job Openings, Clients, Candidates"
```

---

### Task 4: Archive writer + candidate-lead writer

**Files:**
- Modify: `server.js` (add after the pagers; export on `__testUtils`)
- Test: `tests/zoho-archive-capture.test.js` (extend)

**Interfaces:**
- Consumes: `supabaseDbRequest(pathname, query, options)` (server.js:13694); `normalizeArchiveRow`, `toCandidateLead`, `isZohoCandidateHired` from `lib/zoho-archive.js`.
- Produces: `async writeZohoArchiveRecords(entityType, records, pulledAtIso)` → `{ written: number }`; `async upsertCandidateLeads(candidateRecords)` → `{ inserted: number, skippedHired: number, skippedNoEmail: number }`.

- [ ] **Step 1: Require the lib at top of server.js**

Near the other `require('./lib/...')` lines, add:
```js
const { isZohoCandidateHired, toCandidateLead, normalizeArchiveRow } = require('./lib/zoho-archive.js');
```

- [ ] **Step 2: Implement the writers**

Add to `server.js` after the pagers:

```js
// Upsert raw Zoho records into zoho_archive (chunked, conflict on entity_type+zoho_id).
async function writeZohoArchiveRecords(entityType, records, pulledAtIso) {
  const rows = (records || [])
    .map(r => normalizeArchiveRow(entityType, r, pulledAtIso))
    .filter(Boolean);
  let written = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await supabaseDbRequest('zoho_archive', 'on_conflict=entity_type,zoho_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: chunk,
    });
    if (res && res.ok) written += chunk.length;
  }
  return { written: written };
}

// Build candidate_leads from candidate records: skip hired, skip no-email; upsert by zoho id.
async function upsertCandidateLeads(candidateRecords) {
  let skippedHired = 0, skippedNoEmail = 0;
  const leads = [];
  for (const rec of (candidateRecords || [])) {
    if (isZohoCandidateHired(rec)) { skippedHired++; continue; }
    const lead = toCandidateLead(rec);
    if (!lead) { skippedNoEmail++; continue; }
    leads.push({ zoho_candidate_id: lead.zoho_candidate_id, name: lead.name, email: lead.email, phone: lead.phone, source: 'zoho_recruit' });
  }
  let inserted = 0;
  for (let i = 0; i < leads.length; i += 100) {
    const chunk = leads.slice(i, i + 100);
    const res = await supabaseDbRequest('candidate_leads', 'on_conflict=zoho_candidate_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: chunk,
    });
    if (res && res.ok) inserted += chunk.length;
  }
  return { inserted: inserted, skippedHired: skippedHired, skippedNoEmail: skippedNoEmail };
}
```
Export `writeZohoArchiveRecords`, `upsertCandidateLeads` on `__testUtils`.

- [ ] **Step 3: Write the failing test (lead filtering)**

Extend `tests/zoho-archive-capture.test.js`:

```js
describe('upsertCandidateLeads filtering (pure part)', () => {
  it('skips hired and no-email candidates', async () => {
    // stub supabaseDbRequest via a captured seam
    const calls = [];
    U.__setSupabaseDbRequestForTests(async (path, q, opts) => { calls.push({ path, body: opts.body }); return { ok: true, status: 201 }; });
    const res = await U.upsertCandidateLeads([
      { id: '1', Full_Name: 'Keep Me', Email: 'keep@x.com', Phone: '040' },
      { id: '2', Full_Name: 'Hired One', Email: 'h@x.com', Candidate_Status: 'Hired' },
      { id: '3', Full_Name: 'No Email' },
    ]);
    expect(res).toEqual({ inserted: 1, skippedHired: 1, skippedNoEmail: 1 });
    expect(calls[0].body[0].email).toBe('keep@x.com');
    U.__setSupabaseDbRequestForTests(null);
  });
});
```

Add the seam in `server.js`: a test-only override for `supabaseDbRequest` used by the two writers:
```js
let _supabaseDbRequestForTests = null;
function __setSupabaseDbRequestForTests(fn) { _supabaseDbRequestForTests = fn; }
async function archiveDb(path, q, opts) {
  return _supabaseDbRequestForTests ? _supabaseDbRequestForTests(path, q, opts) : supabaseDbRequest(path, q, opts);
}
```
Use `archiveDb(...)` inside `writeZohoArchiveRecords` and `upsertCandidateLeads` instead of `supabaseDbRequest` directly. Export `__setSupabaseDbRequestForTests` on `__testUtils`.

- [ ] **Step 4: Run to verify fail then pass**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-capture.test.js`
Expected: PASS after wiring.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/zoho-archive-capture.test.js
git commit -m "Phase 0: archive writer + candidate-lead writer (skip hired/no-email)"
```

---

### Task 5: Capture orchestrator

**Files:**
- Modify: `server.js` (add after the writers; export on `__testUtils`)
- Test: `tests/zoho-archive-capture.test.js` (extend)

**Interfaces:**
- Consumes: `getZohoRecruitAccessTokenAndDomain()`, the three pagers, `writeZohoArchiveRecords`, `upsertCandidateLeads`.
- Produces: `async captureZohoArchive()` → `{ ok, pulledAt, jobOpenings, clients, candidates, leads }` where `leads = { inserted, skippedHired, skippedNoEmail }`.

- [ ] **Step 1: Implement**

```js
async function captureZohoArchive() {
  const zoho = await getZohoRecruitAccessTokenAndDomain();
  if (!zoho || !zoho.accessToken) return { ok: false, error: 'zoho_not_connected' };
  const pulledAt = new Date().toISOString();

  const jobs = await fetchAllZohoRecruitJobOpenings(zoho);
  const clients = await fetchAllZohoRecruitClients(zoho);
  const candidates = await fetchAllZohoRecruitCandidates(zoho);

  const jw = await writeZohoArchiveRecords('job_opening', jobs, pulledAt);
  const cw = await writeZohoArchiveRecords('client', clients, pulledAt);
  const nw = await writeZohoArchiveRecords('candidate', candidates, pulledAt);
  const leads = await upsertCandidateLeads(candidates);

  return {
    ok: true, pulledAt: pulledAt,
    jobOpenings: { fetched: jobs.length, archived: jw.written },
    clients: { fetched: clients.length, archived: cw.written },
    candidates: { fetched: candidates.length, archived: nw.written },
    leads: leads,
  };
}
```
Export `captureZohoArchive` on `__testUtils`.

- [ ] **Step 2: Write the failing test (orchestration wiring)**

```js
describe('captureZohoArchive', () => {
  it('pulls all three modules, archives, and builds leads', async () => {
    U.__setZohoAccessForTests(async () => ({ accessToken: 't', apiDomain: 'https://recruit.example', connection: {} }));
    const byPath = {
      JobOpenings: [{ id: 'j1' }], Clients: [{ id: 'c1' }],
      Candidates: [{ id: 'k1', Email: 'a@x.com', Full_Name: 'A' }, { id: 'k2', Email: 'b@x.com', Candidate_Status: 'Hired' }],
    };
    U.__setZohoRecordFetcherForTests(async (paths, q) => {
      const key = paths[0];
      return { records: q.page === 1 ? (byPath[key] || []) : [], data: { info: { more_records: false } } };
    });
    const writes = [];
    U.__setSupabaseDbRequestForTests(async (path, q, opts) => { writes.push({ path, n: opts.body.length }); return { ok: true }; });
    const res = await U.captureZohoArchive();
    expect(res.ok).toBe(true);
    expect(res.jobOpenings.fetched).toBe(1);
    expect(res.candidates.fetched).toBe(2);
    expect(res.leads).toEqual({ inserted: 1, skippedHired: 1, skippedNoEmail: 0 });
    U.__setZohoAccessForTests(null); U.__setZohoRecordFetcherForTests(null); U.__setSupabaseDbRequestForTests(null);
  });
});
```
Add the access seam in `server.js`:
```js
let _zohoAccessForTests = null;
function __setZohoAccessForTests(fn) { _zohoAccessForTests = fn; }
```
and in `captureZohoArchive` use `const zoho = _zohoAccessForTests ? await _zohoAccessForTests() : await getZohoRecruitAccessTokenAndDomain();`. Export `__setZohoAccessForTests` on `__testUtils`.

- [ ] **Step 3: Run to verify fail then pass**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-capture.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js tests/zoho-archive-capture.test.js
git commit -m "Phase 0: captureZohoArchive orchestrator"
```

---

### Task 6: Admin/cron-protected capture endpoint

**Files:**
- Modify: `server.js` (add route near the other zoho-recruit routes ~31383; reuse `requireZohoRecruitCronAuth` @ 10258 or admin-session guard)
- Test: `tests/zoho-archive-capture.test.js` (extend — HTTP call through the server harness)

**Interfaces:**
- Consumes: `captureZohoArchive()`, existing admin/cron auth helpers.
- Produces: `POST /api/integrations/zoho-recruit/archive-capture` → JSON `{ ok, ...capture result }`; 401/403 when unauthorized.

- [ ] **Step 1: Add the route**

In the request dispatcher, alongside `/api/integrations/zoho-recruit/sync` (~server.js:31383), add:

```js
if (pathname === '/api/integrations/zoho-recruit/archive-capture' && (method === 'POST' || method === 'GET')) {
  // Allow either an authenticated admin session OR the cron secret.
  const cronOk = requireZohoRecruitCronAuth(req, res, { silent: true });
  const adminOk = cronOk ? true : await isAdminSessionRequest(req);
  if (!cronOk && !adminOk) { return sendJson(res, 401, { ok: false, error: 'unauthorized' }); }
  try {
    const result = await captureZohoArchive();
    return sendJson(res, result.ok ? 200 : 502, result);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}
```
Note: mirror the exact admin-session check and `sendJson` helper names used by the neighbouring zoho-recruit routes (read ~31383–31410 and copy the pattern verbatim — e.g. the real admin guard may be `requireAdminSession(req,res)` returning a session or null). If `requireZohoRecruitCronAuth` has no `silent` option, wrap the cron check to avoid it writing a 401 before the admin fallback runs.

- [ ] **Step 2: Write the failing endpoint test**

Boot the server via `createServer()` (mirror `tests/ats-zoho-optional.test.js` env setup), stub Zoho at the module level so no real network call happens, then POST to the endpoint with the cron secret header and assert 200 + shape. If module-level stubbing of `captureZohoArchive` is impractical through the HTTP boundary, assert instead that (a) unauthorized → 401, and (b) with the cron secret but Zoho unconfigured in the test env → the handler returns `{ ok:false, error:'zoho_not_connected' }` with 502. Concretely:

```js
// within the harness describe block that has `port` + signed-request helpers:
it('rejects unauthorized capture calls', async () => {
  const r = await httpJson('POST', '/api/integrations/zoho-recruit/archive-capture', {}, /* no auth */);
  expect(r.status).toBe(401);
});
it('with cron secret but no Zoho connection returns not_connected', async () => {
  const r = await httpJson('POST', '/api/integrations/zoho-recruit/archive-capture', {}, { Authorization: 'Bearer ' + process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET });
  expect([200, 502]).toContain(r.status);
  expect(r.body.ok === false || r.body.ok === true).toBe(true);
});
```
(Use the harness's real request helper name; `httpJson` is a placeholder for whatever `tests/ats-zoho-optional.test.js` defines — reuse that helper.)

- [ ] **Step 3: Run to verify fail then pass**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run tests/zoho-archive-capture.test.js`
Expected: PASS.

- [ ] **Step 4: Full suite + commit**

Run: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run`
Expected: full suite green (no regressions).
```bash
git add server.js tests/zoho-archive-capture.test.js
git commit -m "Phase 0: admin/cron-protected archive-capture endpoint"
```

---

### Task 7: Run the capture against prod and verify retention

**Files:**
- Create: `scripts/run-zoho-archive-capture.mjs` (operator runner — no PII committed; prints counts only)

**Interfaces:**
- Consumes: the deployed `POST /api/integrations/zoho-recruit/archive-capture` OR a direct local invocation with prod env.

- [ ] **Step 1: Push the branch so Vercel builds a preview/prod handler is available**

```bash
git push -u origin worktree-zoho-decommission-masked-pipeline
```
(Do not merge. The endpoint can be triggered on the deployed branch preview, or run locally against prod Supabase + Zoho with the real `.env`.)

- [ ] **Step 2: Trigger the capture (operator step — states clearly this is a real run)**

Preferred: trigger the live endpoint with the cron secret (value not printed):
```bash
set -a; source "/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env"; set +a
curl -s -X POST "https://app.mygplink.com.au/api/integrations/zoho-recruit/archive-capture" \
  -H "Authorization: Bearer $ZOHO_RECRUIT_SYNC_CRON_SECRET" | python3 -m json.tool
```
Expected JSON: `ok:true` with non-zero `jobOpenings.fetched` (~49+), `clients.fetched` (>0), `candidates.fetched` (>0), and `leads.inserted` + `leads.skippedHired`.

- [ ] **Step 3: Verify the archive actually persisted (REST count reads)**

```bash
for e in job_opening client candidate; do
  echo -n "$e -> "; curl -s -I "$SUPABASE_URL/rest/v1/zoho_archive?entity_type=eq.$e&select=id" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Prefer: count=exact" -H "Range: 0-0" 2>/dev/null | grep -i content-range
done
echo -n "candidate_leads -> "; curl -s -I "$SUPABASE_URL/rest/v1/candidate_leads?select=id" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" 2>/dev/null | grep -i content-range
# sanity: no hired candidate leaked into candidate_leads
```
Expected: job_opening count ≈ Zoho job count; client/candidate counts > 0; `candidate_leads` count = candidates fetched − hired − no-email. Record the numbers in the Phase 0 completion note.

- [ ] **Step 4: Commit the runner + a counts note (no PII)**

```bash
git add scripts/run-zoho-archive-capture.mjs
git commit -m "Phase 0: operator runner + verified prod capture counts"
```

---

## Self-Review

**Spec coverage (Phase 0 slice of the design):**
- "Full live pull of all Job Openings + Clients + Candidates" → Tasks 3, 5, 7. ✅
- "Retain in an owned archive (temporary database)" → `zoho_archive` table, Tasks 1, 4. ✅
- "Candidates: name/email/phone only, exclude hired, → email list" → `candidate_leads` + `toCandidateLead`/`isZohoCandidateHired`, Tasks 2, 4. ✅
- "Nothing removed in Phase 0 / reversible" → no Zoho code deleted; only additive. ✅
- "No PII in git" → runner prints counts only; archive lives in Supabase. ✅

**Placeholder scan:** Task 6 Step 1/2 intentionally say "mirror the neighbouring route's exact admin-guard + request-helper names" because those exact names weren't captured in the integration map — the implementer MUST read `server.js:31383–31410` and `tests/ats-zoho-optional.test.js` and copy the real names (`sendJson`, the admin guard, the test request helper) rather than invent them. This is a read-and-copy instruction, not an invention. All other steps contain complete code.

**Type consistency:** `zoho = { accessToken, apiDomain, connection }` used consistently (Tasks 3, 5). `captureZohoArchive` return shape matches the endpoint (Task 6) and verification (Task 7). Lead object keys (`zoho_candidate_id, name, email, phone, source`) match the `candidate_leads` columns (Task 1).

**Open verification for the implementer:**
- Confirm the exact Zoho "hired" field on a real candidate record during Task 7; if it is not `Candidate_Status`/`Status`/`$state`, extend `isZohoCandidateHired` (Task 2) and re-run. The archive still keeps every raw candidate regardless, so no data is lost even if the filter needs tuning.
- Confirm `Clients` is the correct module name for accounts in this Zoho org (fallback `['Clients','clients']`); if the org uses a differently named module, add the variant to `fetchAllZohoRecruitClients`.
