# Phase 1 — Owned Data + Masked Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize the 13 captured Zoho clients as practice/corporation rows, link all 54 jobs to their owners, restore correct DPA from the true Zoho data, move location details to job level, switch off the Zoho job sync (so nothing clobbers owned data again), and build the new `DPA - Suburb (City) - Billing` masked name for every job — closing the live real-name leak.

**Architecture:** Pure mappers in a new `lib/zoho-backfill.js` (client→practice row, job→backfill patch) + the reworked `buildMaskedTitle` in `lib/practice-pipeline.js`. Server gets `materializePracticesFromArchive()` + `backfillCareerRolesFromArchive()` using the existing `supabaseDbRequest`/`archiveDb` seam, exported on `__testUtils`. The Zoho job sync is disabled with a hard kill-switch (data now owned). Backfill is run locally against prod (reads `zoho_archive` + `career_roles.source_payload`; needs no Zoho API), then verified against the live public board.

**Tech Stack:** Node monolith (`server.js`), Supabase/PostgREST, Vitest.

## Global Constraints

- Branch `worktree-zoho-decommission-masked-pipeline`; base = current HEAD (Phase 0 complete, f6f52a2 on main). Push to main only after the full suite is green (owner-authorized direct-to-main).
- Masked name format (owner-locked): `DPA - Suburb (City) - Billing` → e.g. `DPA - Werribee (Melbourne) - Bulk Billing`. Rules: prefix `DPA` when dpa===true else `Non-DPA`; location = `Suburb (City)` when both present, else whichever exists alone (no parens); billing appended only when known; joiner is `' - '`; when NO suburb/city at all → `GP Opportunity near <state>` (never the real title).
- The archive is the source of truth for backfill: `zoho_archive` rows (`entity_type` in job_opening/client) and `career_roles.source_payload.zoho`. True DPA = zoho `DPA` field ('Yes'/'No').
- Corporations seeded: **ForHealth Group** (zoho_id 11734000000817081) and **GP West Group** (11734000000772001) get `org_type='corporation'`; all others 'practice'.
- Practices materialization must MERGE with existing rows (match by `zoho_client_id` first, then case-insensitive `name`) — never create a duplicate for e.g. the existing Bay Village row. Never overwrite a non-empty owner-entered contact field with an empty Zoho value.
- The Zoho JOB sync must be disabled via kill-switch (`syncZohoRecruitRoles` early-return + cron entry removed from vercel.json). Other Zoho endpoints (OAuth, webhooks) stay untouched until Phase 5.
- Tests: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run <file>`; vitest is ESM-only (import syntax; use createRequire for CommonJS libs). node_modules is a symlink — leave it.
- The worktree has NO `.env`. For prod runs, parse `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env` with the robust KEY=VALUE parser (values may be empty; line 71 is malformed — never `source` it in zsh). Never print secrets or candidate PII.
- Commit after every green task.

---

## File Structure

- **Modify** `lib/practice-pipeline.js` — rework `buildMaskedTitle` to the new format (same export name).
- **Create** `lib/zoho-backfill.js` — pure: `mapZohoClientToPracticeRow(clientPayload, zohoId)`, `buildCareerRoleBackfillPatch(roleRow, practiceIdByZohoClientId)`.
- **Create** `tests/zoho-backfill.test.js` — unit tests for both mappers.
- **Modify** `tests/practice-pipeline.test.js` (or wherever buildMaskedTitle is asserted — grep first) — update to the new format.
- **Modify** `server.js` — kill-switch in `syncZohoRecruitRoles`; add `materializePracticesFromArchive()` + `backfillCareerRolesFromArchive()`; `__testUtils` exports.
- **Modify** `vercel.json` — remove the zoho-recruit cron-sync entry.
- **Create** `supabase/migrations/20260706100000_org_type_job_details.sql` — `practices.org_type`, `career_roles.address`, `career_roles.details`.

---

### Task 1: Migration — org_type + job-level detail columns (apply to prod)

**Files:**
- Create: `supabase/migrations/20260706100000_org_type_job_details.sql`

**Interfaces:**
- Produces: `practices.org_type` text ('practice'|'corporation'); `career_roles.address` text; `career_roles.details` jsonb — consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the migration**

```sql
begin;

alter table public.practices
  add column if not exists org_type text not null default 'practice';
do $$ begin
  alter table public.practices
    add constraint practices_org_type_check check (org_type in ('practice','corporation'));
exception when duplicate_object then null; end $$;

alter table public.career_roles
  add column if not exists address text not null default '',
  add column if not exists details jsonb not null default '{}'::jsonb;

commit;
```

- [ ] **Step 2: Apply via exec_sql (strip begin/commit — the RPC rejects transaction commands) and verify**

Apply with the standard curl → `rpc/exec_sql` `{"query": ...}` pattern using SUPABASE_URL + SERVICE_ROLE_KEY parsed from the main checkout `.env`. Verify:
```bash
curl -s "$SUPABASE_URL/rest/v1/practices?select=id,org_type&limit=1" ... # expect 200 with org_type
curl -s "$SUPABASE_URL/rest/v1/career_roles?select=id,address,details&limit=1" ... # expect 200
```

- [ ] **Step 3: Commit** — `git add supabase/migrations/20260706100000_org_type_job_details.sql && git commit -m "Phase 1: org_type on practices + job-level address/details columns (applied to prod)"`

---

### Task 2: New masked-name format in buildMaskedTitle (TDD)

**Files:**
- Modify: `lib/practice-pipeline.js` (buildMaskedTitle, ~line 240)
- Modify: whichever test file asserts the old `GP Job near … | …` format — find with `grep -rn "GP Job near" tests/` and update those assertions to the new format.

**Interfaces:**
- Produces: `buildMaskedTitle({ suburb, nearestCity, billingStyle, dpa, visaSponsorship, earningsText, state })` → string in the new format. Same export; extra param `state` added; `visaSponsorship`/`earningsText` accepted but no longer rendered (kept for call-site compatibility).

- [ ] **Step 1: Write failing tests** (in the existing test file that covers practice-pipeline, matching its import style):

```js
// New-format cases
expect(buildMaskedTitle({ suburb: 'Werribee', nearestCity: 'Melbourne', billingStyle: 'bulk', dpa: true }))
  .toBe('DPA - Werribee (Melbourne) - Bulk Billing');
expect(buildMaskedTitle({ suburb: 'Erina', billingStyle: 'Private Billing', dpa: true }))
  .toBe('DPA - Erina - Private Billing');                 // legacy: town only, raw label passthrough
expect(buildMaskedTitle({ nearestCity: 'Melbourne', billingStyle: 'mixed', dpa: false }))
  .toBe('Non-DPA - Melbourne - Mixed Billing');
expect(buildMaskedTitle({ suburb: 'Cobblebank', dpa: true }))
  .toBe('DPA - Cobblebank');                              // no billing → drop part
expect(buildMaskedTitle({ dpa: true, state: 'NSW' }))
  .toBe('GP Opportunity near NSW');                        // no location at all
expect(buildMaskedTitle({ dpa: false }))
  .toBe('GP Opportunity near you');
```

- [ ] **Step 2: Run → expect FAIL** (old format returned).

- [ ] **Step 3: Implement**

```js
function normalizeBillingLabel(billingStyle) {
  const raw = String(billingStyle || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[\s_-]*billing$/i, '').replace(/[\s_-]/g, '');
  if (BILLING_LABELS[key]) return BILLING_LABELS[key];
  if (/^bulk/.test(key)) return 'Bulk Billing';
  if (/^mixed/.test(key)) return 'Mixed Billing';
  if (/^private/.test(key)) return 'Private Billing';
  return raw; // already a human label we don't recognize — pass through
}

// Owner-locked GP-facing name: "DPA - Suburb (City) - Billing".
// Legacy rows with only a town render "DPA - Town - Billing" (no parens).
// visaSponsorship/earningsText are accepted for call-site compatibility but
// no longer rendered in the title (they still appear in display_label/details).
function buildMaskedTitle({ suburb, nearestCity, billingStyle, dpa, visaSponsorship, earningsText, state } = {}) {
  const sub = String(suburb || '').trim();
  const city = String(nearestCity || '').trim();
  const loc = sub && city && sub.toLowerCase() !== city.toLowerCase()
    ? sub + ' (' + city + ')'
    : (sub || city);
  if (!loc) return 'GP Opportunity near ' + (String(state || '').trim() || 'you');
  const dpaPart = dpa === true ? 'DPA' : 'Non-DPA';
  const billingLabel = normalizeBillingLabel(billingStyle);
  return [dpaPart, loc, billingLabel].filter(Boolean).join(' - ');
}
```
(Keep `BILLING_LABELS` as is; note its keys — mixed/bulk/private — align with the normalized key.)

- [ ] **Step 4: Run the file's full test suite + `grep -rn "GP Job near" tests/ lib/ server.js`** — update every stale assertion; the only remaining "GP Job near" references should be none (the fallback is now "GP Opportunity near").

- [ ] **Step 5: Run the FULL suite** (intake flow tests exercise the title via createPendingJobFromIntake) — all green.

- [ ] **Step 6: Commit** — `"Phase 1: masked name format DPA - Suburb (City) - Billing"`

---

### Task 3: Zoho job-sync kill-switch

**Files:**
- Modify: `server.js` (`syncZohoRecruitRoles` ~18300s — grep exact line), `vercel.json` (remove the cron entry for `/api/integrations/zoho-recruit/cron-sync`)
- Test: extend `tests/zoho-archive-capture.test.js`

**Interfaces:**
- Produces: `syncZohoRecruitRoles()` returns `{ ok: false, disabled: true, error: 'zoho_job_sync_decommissioned' }` immediately (before any Zoho/DB call). Exported on `__testUtils` (export the function itself).

- [ ] **Step 1: Failing test** — `U.syncZohoRecruitRoles()` resolves to the disabled object without needing any seam stubs (proves it exits before I/O).
- [ ] **Step 2: Implement** — first line of `syncZohoRecruitRoles`:
```js
  // Phase 1 (Zoho decommission): job data is now owned (zoho_archive + backfill).
  // The sync would overwrite owner-controlled dpa/billing/practice_name — hard off.
  return { ok: false, disabled: true, error: 'zoho_job_sync_decommissioned' };
```
Remove the `{ "path": "/api/integrations/zoho-recruit/cron-sync", ... }` entry from vercel.json's crons array. Do NOT touch other Zoho endpoints (OAuth/webhooks/status) — the webhook handler calls syncZohoRecruitRoles and now becomes a no-op via the same switch.
- [ ] **Step 3: Full suite green** (fix any test that asserted the sync runs — update it to assert the disabled contract instead; do not delete coverage).
- [ ] **Step 4: Commit** — `"Phase 1: hard-disable Zoho job sync (data now owned; prevents dpa/billing clobber)"`

---

### Task 4: Pure backfill mappers (TDD)

**Files:**
- Create: `lib/zoho-backfill.js`, `tests/zoho-backfill.test.js`

**Interfaces:**
- Consumes: nothing (pure; CommonJS module.exports like lib/zoho-archive.js).
- Produces:
  - `mapZohoClientToPracticeRow(clientPayload, zohoId)` → `{ zoho_client_id, name, org_type, contact_name, contact_email, contact_phone, location_city, location_state, source: 'zoho_import', is_active: true }` (org_type='corporation' iff zohoId ∈ {'11734000000817081','11734000000772001'}; name from `Client_Name`; email from `Client_Email`; phone from `Client_Phone_Number` || `Contact_Number`; city/state from `Billing_City`/`Billing_State`; every field String-trimmed, missing → '').
  - `buildCareerRoleBackfillPatch(roleRow, practiceIdByZohoClientId)` → patch object or null. From `roleRow.source_payload.zoho`: `dpa` = (String(z.DPA).toLowerCase()==='yes'); `suburb` = z.City; `address` = [z.Location, z.Zip_Code] joined ', ' (skip empties); `billing_model` = keep existing roleRow.billing_model if non-empty else z.Billing_Type; `practice_id` = practiceIdByZohoClientId[z.Client_Name.id] || undefined (omit key when unknown); `details` = { benefits: [z.Benefit_1..3 non-empty], gpCount: z.Current_Amount_of_General_Practiti, positions: z.Number_of_Positions, website: z.Practice_Website, shortIntro: z.Short_Intro, alliedHealth: z.Allied_Health, pathology: z.Pathology_on_Site, yearsOperating: z.Years_of_Operation, visaSponsorship: z.Visa_Sponsorship_Available, avgConsult: z.Average_Standard_Consult }; `masked_title` = buildMaskedTitle({ suburb: z.City, nearestCity: roleRow.nearest_city, billingStyle: (roleRow.billing_model || z.Billing_Type), dpa: <the computed dpa>, state: roleRow.location_state }). Returns null when roleRow.source_payload?.zoho is missing (non-Zoho rows — never patch those).

- [ ] **Step 1: Failing tests** covering: corporation seeding by id; contact extraction; dpa Yes/No/absent (absent → false); billing preference (existing row value wins over Zoho); address join; details assembly (empty benefits dropped); masked_title uses computed dpa + suburb; null for non-Zoho rows; practice_id omitted when client unknown.
- [ ] **Step 2-4: red → implement → green.** Import `buildMaskedTitle` via `require('./practice-pipeline.js')`.
- [ ] **Step 5: Commit** — `"Phase 1: pure backfill mappers (client→practice, job patch incl masked_title)"`

---

### Task 5: Server backfill runners + wiring

**Files:**
- Modify: `server.js` (after captureZohoArchive; require lib/zoho-backfill.js at top), extend `tests/zoho-archive-capture.test.js`

**Interfaces:**
- Consumes: `archiveDb` seam (Task 4 of Phase 0), `lib/zoho-backfill.js` mappers.
- Produces (exported on `__testUtils`):
  - `materializePracticesFromArchive()` → `{ ok, created, updated, byId }`: reads `zoho_archive?entity_type=eq.client`, reads existing `practices` rows, for each client: match existing by zoho_client_id then lower(name); INSERT missing (mapZohoClientToPracticeRow) or PATCH existing (fill zoho_client_id + org_type + only EMPTY contact fields — never overwrite non-empty owner data); returns `byId` = { [zoho_client_id]: practices.id }.
  - `backfillCareerRolesFromArchive()` → `{ ok, patched, skipped }`: calls `materializePracticesFromArchive()` for the id map, reads all `career_roles?provider=eq.zoho_recruit&select=id,billing_model,nearest_city,location_state,source_payload`, builds patch via `buildCareerRoleBackfillPatch`, PATCHes each row by id (skip null patches).

- [ ] **Step 1: Failing tests** using the `__setSupabaseDbRequestForTests` seam: seed fake archive clients + practices + roles through the stub; assert (a) new practice INSERTed with org_type corporation for ForHealth id; (b) existing practice matched by name gets zoho_client_id but its non-empty contact_email is NOT overwritten; (c) role rows get PATCHes containing dpa/masked_title/practice_id; (d) non-Zoho role skipped.
- [ ] **Step 2-3: red → implement → green.** Chunk/patch sequentially; every DB call through `archiveDb`.
- [ ] **Step 4: Full suite green. Commit** — `"Phase 1: practice materialization + career_roles backfill runners"`

---

### Task 6: Operator run against prod + live verification (main loop, not a subagent)

- [ ] **Step 1:** Push branch; merge origin/main if moved; full suite; push to main; wait for Vercel (poll a deploy-signature).
- [ ] **Step 2:** Run the backfill LOCALLY against prod (no Zoho API needed): one-shot .mjs (robust .env parse; NODE_ENV='test'; dynamic import server.js; `await U.backfillCareerRolesFromArchive()`); print counts only.
- [ ] **Step 3: Verify (counts + booleans, no PII):**
  - practices total = 14–15 (13 clients merged/created + pre-existing Test Practice; Bay Village must NOT be duplicated — assert exactly one row matching bay village name)
  - org_type='corporation' exactly 2
  - career_roles: all provider=zoho_recruit rows have practice_id set, masked_title non-empty, dpa matching payload DPA (spot-tally: count dpa=true vs count payload DPA=Yes — MUST be equal)
  - LIVE `https://app.mygplink.com.au/api/public/jobs?limit=100`: zero titles containing any real practice name (compare against the 13 client names case-insensitively); zero `practice_name` values; titles match `/^(DPA|Non-DPA) - / or GP Opportunity/`
  - CEO Practices tab endpoint still returns ~9+ cards (virtual→real merge intact; ForHealth job_count 35)
- [ ] **Step 4:** Ledger + memory update; report with real counts.

---

## Self-Review

- Spec coverage: org model (T1, T5), correct DPA + job-level details (T4, T5), masked name + leak closure (T2, T4, T6), sync clobber prevention (T3), merge-not-duplicate (T5, verified T6). ✅
- The 6am cron risk is eliminated in T3 BEFORE the backfill lands in T6 (task order matters — keep it).
- buildMaskedTitle signature change is backward-compatible (extra param; unused params tolerated); the two runtime call sites pass the old shape and still work — intake-created jobs get the new format automatically.
- Placeholder scan: T2 Step 1 lists exact expected strings; T4 lists exact field mappings; T5 describes exact merge rules. T2's "whichever test file" requires a grep first — acceptable read-and-copy instruction.
- Type consistency: `byId` map keyed by zoho_client_id (string) consumed by buildCareerRoleBackfillPatch's practiceIdByZohoClientId. ✅
