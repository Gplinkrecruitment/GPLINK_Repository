# Zoho placements + job-openings update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the owner's PDF instructions — mark past-Zoho placements filled/closed (silently), delete Four Corners, create Carrara + 5 Spectrum practices, apply ForHealth/GP West billing terms, regenerate all "About the role" summaries, and add view-in-app/website buttons to the admin Jobs board.

**Architecture:** All practice/job data lives in **prod Supabase** (not git). Data changes (Parts 1–4) are applied by verified Node scripts hitting the Supabase REST API with the service-role key from `.env`, each previewing → applying → reading back. The one code change (view buttons) is edited in this worktree and shipped as a draft PR.

**Tech Stack:** Node 20 (`/tmp/node-v20.18.1-darwin-arm64/bin/node`), Supabase REST (PostgREST), Anthropic API for AI summaries, vanilla JS (`js/ceo-ats-jobs.js`), vitest.

## Global Constraints

- **NO notifications** may fire to practices or candidates. Only write DB columns via `career_roles`/`practices` PATCH/POST/DELETE. Never call the offer-accept flow. `job_status` writes are side-effect-free (verified `server.js:26024`, `49909`).
- **Privacy:** every AI `summary` must NOT leak the practice name or exact street address/suburb-precision beyond a general area.
- Scripts live in `$CLAUDE_JOB_DIR/tmp` (operational tooling, not committed). Never `git add -A` in the shared checkout.
- Filled/closed roles: set `is_active=false` so they drop from candidate + public lists.
- Record filling GPs in `source_payload.gpLink.filledBy` (array of names) — no accounts created.
- Money/terms strings are copied verbatim from the PDF.
- Node script env-load: parse `.env` for `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.

### Verbatim commercial-terms blocks (use exactly)

**ForHealth Group (35 roles) — `details.benefits`:**
```
["High-Earning Potential: Approximate yearly income of $500k",
 "Competitive Billings: 70% billings split",
 "Sign-On Bonus: $15,000 (2-year agreement) or $22,500 (3-year agreement)",
 "Minimum Income Guarantee: $150 per hour",
 "Full Visa & PR Sponsorship Offered",
 "Supervision Available"]
```
`earnings_text="$500k"`, `visa_pathway_aligned=true`, add tags `"Visa Sponsorship"`,`"Supervision Available"`.

**GP West Group (9 roles) — `details.benefits`:**
```
["High-Earning Potential: Approximate yearly income of $500k",
 "Competitive Billings: 70% billings split",
 "Relocation / Sign-On Support: $10,000 (2-year agreement)",
 "Minimum Income Guarantee: $150 per hour",
 "Supervision Available"]
```
`earnings_text="$500k"`, `visa_pathway_aligned=false`, add tag `"Supervision Available"`.

**Carrara (new, Non-DPA) — `details.benefits`:**
```
["High-Earning Potential: Approximate yearly income of $700k",
 "Competitive Billings: 70% billings split",
 "Sign-On Bonus: $15,000 (2-year agreement) or $22,500 (3-year agreement)",
 "Minimum Income Guarantee: $150 per hour",
 "Full Visa & PR Sponsorship Offered",
 "Supervision Available"]
```
`billing_model="Bulk Billing"`, `earnings_text="$700k"`, `visa_pathway_aligned=true`, `dpa=false`.

**Spectrum 5 (new, DPA) — `details.benefits`:**
```
["High-Earning Potential: Approximate yearly income of $500k",
 "Competitive Billings: 70% billings split",
 "Sign-On Bonus: $10,000 (2-year agreement)",
 "Minimum Income Guarantee: $150 per hour",
 "Supervision Available"]
```
`earnings_text="$500k"`, `visa_pathway_aligned=false`, `dpa=true`.

---

### Task 0: Shared prod-DB helper + display-field verification

**Files:**
- Create: `$CLAUDE_JOB_DIR/tmp/db.mjs` (env-load + `sel/patch/ins/del` REST helpers)
- Read: `pages/job.html` (render), `pages/career.html` (role modal), `server.js` GET `/api/career/role` mapping (~`29771`), `mapCareerRoleRow*`

**Interfaces:**
- Produces: `db.mjs` exporting `sel(path)`, `patch(table, idFilter, body)`, `ins(table, body)`, `del(table, idFilter)`, and `URL/KEY/ANTHROPIC`.

- [ ] **Step 1:** Write `db.mjs` (parse `.env`, headers `apikey`+`Authorization: Bearer`, `Prefer: return=representation` on writes).
- [ ] **Step 2:** Confirm exactly which fields the job page renders for commercial terms. Read `pages/job.html` benefits + about-role render and the server role-mapping. Record: does `details.benefits` show as "Why GPs consider this role"? Is `summary` the About-the-role? Does `earnings_text`/`visa_pathway_aligned` surface anywhere? Adjust the term-write targets in later tasks if the render disagrees.
- [ ] **Step 3:** Snapshot current state to `$CLAUDE_JOB_DIR/tmp/before.json` (all 55 roles full rows) as a rollback reference.

**Verify:** `db.mjs` prints role #7 title on a smoke run; `before.json` has 55 rows.

---

### Task 1: Mark filled/closed (5 roles) — silent

**Files:** Create `$CLAUDE_JOB_DIR/tmp/01-fill.mjs`

Targets (role id → status → filledBy):
- #53 Halekulani → `closed` → ["Dr Mohsen Dashti","Dr Sana Ahsan"]
- #50 Mount Hutton Family Practice → `filled` → ["Dr Musharraf"]
- #56 Kennedy Drive → `filled` → ["Dr Yan Win"]
- #54 Perfect Medical → `filled` → ["Dr Joseph Iyanda"]
- #57 Thornton → `filled` → ["Dr Sameer Shereef"]

- [ ] **Step 1:** For each, PATCH `career_roles`: `{ job_status, is_active:false, source_payload: {...existing, gpLink:{...existing.gpLink, filledBy:[names], filledAt:'2026-07-11', filledSource:'zoho_past_placement'}} }`. Merge source_payload in JS (read row first, spread).
- [ ] **Step 2 (test):** Read back all 5; assert `job_status` + `is_active===false` + `filledBy` present.
- [ ] **Step 3:** Grep the patched code path mentally — confirm no email/automation (pure REST PATCH; nothing server-side runs). Note in run log.

**Verify:** 5 rows show new status; nothing sent (PATCH is DB-only).

---

### Task 2: Retitle Complete Family Care (#1)

**Files:** Create `$CLAUDE_JOB_DIR/tmp/02-retitle.mjs`

- [ ] **Step 1:** PATCH role #1 `title` "General Practitioner - Hanna Elkhoury" → "General Practitioner || Complete Family Care". Leave `practice_name` ("Complete Family Care") as-is. If `masked_title` embeds the name, refresh it too.
- [ ] **Step 2 (test):** Read back #1; assert title no longer contains "Hanna" or "Elkhoury".

**Verify:** title updated; person name gone.

---

### Task 3: Delete Four Corners completely

**Files:** Create `$CLAUDE_JOB_DIR/tmp/03-delete-fourcorners.mjs`

- [ ] **Step 1 (FK sweep):** SELECT counts referencing role #5 / practice `02f9e43a-3149-49d4-9baa-39823b4cd00c` across `gp_applications(career_role_id)`, `ats_offers`, `placements`, `pending_hires`, and scan `user_state` for `gp_career_state` referencing it. Print all. Abort if any non-zero (report to owner) — expected zero.
- [ ] **Step 2:** DELETE `career_roles?id=eq.5`, then DELETE `practices?id=eq.02f9e43a-...`.
- [ ] **Step 3 (test):** Read back both — assert 404/empty (gone).

**Verify:** role + practice absent; no orphan refs.

---

### Task 4: ForHealth Group billing terms (35 roles)

**Files:** Create `$CLAUDE_JOB_DIR/tmp/04-forhealth.mjs`

- [ ] **Step 1:** SELECT all `career_roles?practice_name=eq.ForHealth Group`. For each, PATCH: merge `details.benefits` = ForHealth block (replace, not append-dupe), set `earnings_text`, `visa_pathway_aligned=true`, union `tags` with visa+supervision. Preserve `details.website/shortIntro/positions`.
- [ ] **Step 2 (test):** Read back 3 sample rows; assert benefits array equals the ForHealth block and `visa_pathway_aligned===true`. Count patched === 35.

**Verify:** 35 rows carry ForHealth terms.

---

### Task 5: GP West Group billing terms (9 roles)

**Files:** Create `$CLAUDE_JOB_DIR/tmp/05-gpwest.mjs`

- [ ] **Step 1:** SELECT `career_roles?practice_name=eq.GP West Group`. PATCH each with GP West block, `earnings_text="$500k"`, `visa_pathway_aligned=false`, union tag "Supervision Available".
- [ ] **Step 2 (test):** Read back all 9; assert benefits === GP West block; no visa benefit present.

**Verify:** 9 rows carry GP West terms.

---

### Task 6: Create Carrara Family Practice + job

**Files:** Create `$CLAUDE_JOB_DIR/tmp/06-carrara.mjs`

Facts: website `https://carrarafamilypractice.com.au/`; Carrara is a Gold Coast QLD suburb; Non-DPA.

- [ ] **Step 1:** POST `practices` `{ name:"Carrara Family Practice", location_city:"Carrara", location_state:"QLD", location_country:"Australia", website, dpa:false, stage:"active", is_active:true, suburb:"Carrara", source:"internal_ats", org_type:"practice", billing_style:"Bulk Billing" }`. Capture new practice id.
- [ ] **Step 2:** POST/insert `career_roles` `{ provider:"internal_ats", provider_role_id:"ats_carrara_gp", practice_id, practice_name:"Carrara Family Practice", title:"General Practitioner || Carrara Family Practice", location_city:"Carrara", location_state:"QLD", location_country:"Australia", billing_model:"Bulk Billing", earnings_text:"$700k", dpa:false, visa_pathway_aligned:true, employment_type:"Permanent", is_active:true, job_status:"open", approval_status:"approved", ats_created:true, suburb:"Carrara", nearest_city:"Gold Coast", masked_title:"Non-DPA - Gold Coast - Bulk Billing", tags:["Bulk Billing","Visa Sponsorship","Supervision Available"], details:{ website, positions:"1", benefits:<Carrara block>, shortIntro:"" } }`.
- [ ] **Step 3 (suburb pic):** Set `header_image_url` via the Wikimedia suburb resolver pattern (query "Carrara Queensland"/"Gold Coast" scenic) or reuse an existing Gold Coast hero image. If none, leave for lazy on-read resolver.
- [ ] **Step 4 (AI About-the-role):** Deferred to Task 8 (covers all active roles) — Carrara included there.
- [ ] **Step 5 (test):** Read back; assert practice + role exist, dpa=false, terms present.

**Verify:** Carrara practice + 1 open job created with correct terms.

---

### Task 7: Create Spectrum Group corporation + 5 DPA practices/jobs

**Files:** Create `$CLAUDE_JOB_DIR/tmp/07-spectrum.mjs`; research via subagents (one per site).

Sites → suburb (WA):
- theheightsmedical.com.au → Modbury Heights? **Confirm from site** (name "The Heights")
- connollydrivemedical.com.au → Connolly, WA
- pearsallmedical.com.au → Pearsall, WA
- rainbowhealth.com.au → **confirm suburb from site**
- mandurahmedical.com.au → Mandurah, WA

- [ ] **Step 1 (research):** Dispatch one subagent per site to WebFetch it and return `{ practiceName, suburb, state, city, servicesSummary, alliedHealth, billing }` (JSON). Confirm real suburb/state (some may be SA/WA).
- [ ] **Step 2:** POST corporation practice `{ name:"Spectrum Group", org_type:"corporation", stage:"active", is_active:true, source:"internal_ats" }`. Capture `spectrumId`.
- [ ] **Step 3:** For each site, POST child `practices` `{ name:<practiceName>, location_city, location_state, website, dpa:true, stage:"active", is_active:true, suburb, org_type:"practice", parent_corporation_id:spectrumId, source:"internal_ats" }`; then insert a `career_roles` row (like Task 6) with the Spectrum block, `dpa:true`, `visa_pathway_aligned:false`, `job_status:"open"`, `approval_status:"approved"`, `masked_title:"DPA - <nearestCity> - <billing>"`.
- [ ] **Step 4 (suburb pics):** Set `header_image_url` per suburb (Wikimedia resolver / existing library) or leave for lazy resolver.
- [ ] **Step 5 (test):** Read back; assert 1 corporation + 5 child practices + 5 open DPA jobs, each linked via `parent_corporation_id`.

**Verify:** Spectrum corp + 5 DPA jobs created.

---

### Task 8: Regenerate AI "About the role" for all active jobs

**Files:** Create `$CLAUDE_JOB_DIR/tmp/08-summaries.mjs`

Covers all `career_roles` with `is_active=true` (post-delete/fill set ≈ ForHealth 35 + GP West 9 + Carrara 1 + Spectrum 5 + Complete Family Care 1 + Bay Village 1 + SOP + any still-active = the live catalogue). Filled/closed inactive roles: regenerate too if owner's "all" intent includes them — default: **active only** (they're the visible ones); note skipped inactive count.

- [ ] **Step 1:** For each role: get website from `details.website` (else practice-group site else none). `fetch()` HTML, strip tags → text (cap ~6k chars).
- [ ] **Step 2:** Call Anthropic (`claude-...`, model per `lib/anthropic-model.js` or a current Sonnet id) with a privacy-preserving prompt: "Write a 60–90 word 'About the role' for a candidate GP: describe the general area's lifestyle + the practice's services/allied-health from the scanned text. NEVER name the practice or give exact address/suburb precision; refer to it as 'this practice' and the area generally. No billing/money." Return plain text.
- [ ] **Step 3:** PATCH `career_roles.summary` (and optional `details.shortIntro`). Rate-limit (small concurrency, e.g. 4). Log each.
- [ ] **Step 4 (test):** Sample 5 summaries; assert non-empty, no practice `name` substring, no street/exact-suburb leak (regex check against practice_name tokens). Count updated.

**Verify:** all active roles have a fresh privacy-safe About-the-role.

---

### Task 9: View-in-app + View-in-website buttons (CODE — draft PR)

**Files:**
- Modify: `js/ceo-ats-jobs.js` (job card render + a pure link-builder)
- Create: `tests/ceo-ats-jobs-links.test.js`
- Read first: `js/ceo-ats-jobs.js` card render (~line 186), `buildCareerRolePublicId`/`mapCareerRoleRowToPublicJob` in `server.js` for the public-id encoding, and `/api/ats/jobs` response shape (what id fields a job object exposes to the client).

**Interfaces:**
- Produces: `buildJobViewLinks(job)` → `{ appUrl, websiteUrl }` where `appUrl="/pages/job.html?id="+publicId`, `websiteUrl="/jobs/view?id="+publicId`. `publicId` derived from the job's provider + provider_role_id exactly as the public API encodes it.

- [ ] **Step 1 (confirm encoding):** Read `server.js` public-id builder; write down exact `publicId` format (e.g. `provider + ':' + provider_role_id` or a slug). Confirm the client job object has the fields needed (or add them to the `/api/ats/jobs` mapping if missing — minimal).
- [ ] **Step 2 (failing test):** `tests/ceo-ats-jobs-links.test.js` — import `buildJobViewLinks`, assert for a sample job it returns the correct `/pages/job.html?id=…` and `/jobs/view?id=…`.
- [ ] **Step 3:** Run `npx vitest run tests/ceo-ats-jobs-links.test.js` → FAIL (not defined).
- [ ] **Step 4:** Implement `buildJobViewLinks` as an exported pure function in `js/ceo-ats-jobs.js` (guard for `module.exports` so vitest can import while browser keeps global).
- [ ] **Step 5:** Run vitest → PASS.
- [ ] **Step 6:** Wire two buttons into each job card (open in new tab). Website button disabled/hidden when the role isn't publicly visible (`job_status!=='open' || !is_active`). Cache-buster bump on the script tag in `pages/ceo-dashboard.html` (`?v=YYYYMMDD`).
- [ ] **Step 7 (verify):** `node --check js/ceo-ats-jobs.js`; run full `npx vitest run` (no regressions). Manually reason through the card DOM.
- [ ] **Step 8:** Commit; push branch; `gh pr create --draft`.

**Verify:** vitest green; buttons render with correct URLs; PR opened.

---

## Self-Review

- **Spec coverage:** Items 1–9 → Tasks 3,1,1,6,1,1,1,2,9. Part 2 → Tasks 4,5. Part 3 → Task 7. Part 4 → Task 8. All covered.
- **Placeholder scan:** Term blocks are verbatim; Spectrum suburbs flagged "confirm from site" (Task 7 Step 1 resolves). No TBD in executable steps.
- **Type consistency:** `buildJobViewLinks` name consistent across Task 9. `db.mjs` `sel/patch/ins/del` consistent across Tasks 1–8. `filledBy` shape consistent (Task 1).
- **Notification safety:** Every data task uses REST PATCH/POST/DELETE only — reaffirmed in Global Constraints.
