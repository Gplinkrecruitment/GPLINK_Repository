# DESIGN SPEC — CEO Dashboard Restructure + In-App ATS

**Date:** 2026-06-27
**Branch:** `worktree-ats-prototype` (PREVIEW ONLY — never merge to `main` until owner approves)
**Status:** BUILT + verified (see Build Status below). Ground-truth verified against the live codebase (10-agent investigation + adversarial critic).

---

## BUILD STATUS — 2026-06-27 (core complete + verified)

**Done & verified** (all on `worktree-ats-prototype`, pushed; 671/671 tests pass; all 4 tabs screenshotted on the real gated page running locally):
- DB: 6 additive migrations (practices, career_roles ATS cols, gp_applications.ats_stage, registration_cases intent+comms cols, career_interviews summary cols, ats_stage_events). **Written + committed; NOT yet applied to the shared Supabase** (kept preview-only; applying them — additive/safe — is the step that makes a Vercel preview show real data).
- Libs: `lib/ats-intent.js` (intent calc), `lib/ats-practices.js`, `lib/ats-comms.js` + 53 unit tests.
- Backend: 15 dual-mode endpoints (`/api/ats/*`, `/api/ceo/candidate*`) + recompute-intent cron + 13 endpoint tests. Comms scan calls Claude over real WhatsApp/email.
- Frontend: master-tab shell in `ceo-dashboard.html` (existing dashboard wrapped, untouched) + `css/ceo-ats.css` + `js/ceo-ats-shared.js` (+ hash deep-linking) + 3 tab modules. Local-JSON seed (`scripts/seed-ats-dev.js`) mirrors the prototype so the localhost build runs the *real* code.
- Verified visually: Candidates list (sorted by real intent), candidate profile (intent 97/100, rail, docs, comms, Zoom summaries), Jobs list + drag-drop board, Practices directory + detail. Registration tab wraps the existing dashboard unchanged (sticky fix correct).

**Remaining (flagged, lower priority — can't be verified without external services):**
1. **Apply the additive migrations** to the shared Supabase (one-time, safe) so a preview deployment shows real data. Then run a one-time **practices backfill** (dedup `career_roles.practice_name` → `practices` rows via `lib/ats-practices.normalizePracticeName`) + the recompute-intent cron once.
2. **Interview Zoom-summary mechanism**: `career_interviews` summary columns exist; still to wire = generalise `fetchAndSaveZoomSummary(table,row)`, extend the Zoom webhook to match `career_interviews`, set the AI Companion flag in `createZoomMeeting`. (Registration-call summaries already surface on the profile — real, via Zoom AI Companion.)
3. **Outbound WhatsApp persistence**: add a `direction='outbound'` insert in `sendDoubleTick*` so comms engagement is two-sided (column/CHECK already allow it).

Items 2–3 depend on Zoom/DoubleTick being configured, so they're deployed-env-only.
**Source of truth for UI/behaviour:** `pages/ceo-dashboard-prototype.html` (approved by owner).
**Companion doc:** `2026-06-27-ats-ceo-restructure-HANDOVER.md` (vision + decisions).

### BUILD STATUS — 2026-06-28 (increment: total-pipeline widget + movement plumbing)

**Done & verified** (same branch; **682/682 tests pass**; 3 Candidates-tab views screenshotted on the real gated page):
- **Total-pipeline widget** at the top of the Candidates tab — counts every GP **once**, by their furthest active stage, into 8 buckets that partition the universe (sum == total). New `'unassociated'` bucket = GPs with no applications; it appears **only** here (never on the per-job boards). A GP whose every application was passed on falls into `'not_proceeding'`. Each segment is a button that filters the candidate list to that bucket (toggle + Clear).
- **Movement plumbing — how candidates move through the pipeline:**
  - *Entry* — "＋ Add to a job" on a candidate's page creates a `gp_applications` row at `ats_stage='applied'` (moves them Unassociated → Applied). Idempotent on `(user_id, provider_role_id)`.
  - *Move* — per-application **stage dropdown** on the candidate page (mirrors the job-board drag-and-drop), reusing the existing `PATCH /api/ats/application`. Every move records an `ats_stage_events` row and refreshes the widget.
- New backend: `bucketForApps`/`PIPELINE_BUCKETS`/`PIPELINE_BUCKET_LABELS` in `lib/ats-practices.js`; `atsInsertApplicationRow` + `POST /api/ats/application` + `GET /api/ceo/pipeline-summary` + an `ats_bucket` filter (and `pipeline_bucket` per row) on `/api/ceo/candidates`. 9 new tests (pure bucketing + endpoints).
- Reuses existing `gp_applications` columns only — **no new migrations** for this increment.



> **Plain-English summary (for the owner).** Today the CEO dashboard is one long page about the registration process. We are turning it into four tabs across the top — **Registration | Candidates | Jobs | Practices** — and building a real recruitment system (ATS) inside the app, like Zoho but natively connected to everything else. "Registration" is your current dashboard, untouched, just moved inside the first tab. "Candidates" is every doctor on file with a profile, an automatic "how keen are they" intent score, their AI call summaries and message engagement, and where they sit in every pipeline. "Jobs" is the recruitment board where you drag a doctor from "Applied" to "Hired". "Practices" is every clinic as a proper record linked to its jobs and doctors. Every button will really work — nothing decorative.

---

## 0. What changed after investigation (read this before building)

The investigation **corrected several assumptions** from the handover. These are facts, verified in code:

| # | Reality (verified) | Consequence for the build |
|---|---|---|
| R1 | **`registration_cases.blocker_set_at` already exists** (`20260614120000_ceo_rebuild.sql:9`; `server.js:40212` computes `days_blocked`). | The intent "days blocked" signal uses this real column. Do **not** add it. |
| R2 | **No `practices` table, no kanban/`ats_stage` column, no intent columns exist.** A "practice" is denormalised free text in **7** places. | We create a `practices` table + `gp_applications.ats_stage` + intent columns (§4). |
| R3 | **`gp_applications` has two status fields:** `status` (free text, no constraint) and `practice_submission_status` (CHECK, 6 values). Both contain `submitted_to_practice`. | The board uses a **new dedicated `ats_stage`** column, backfilled from both — never overload the existing two (§4.3). |
| R4 | **"AI joins & summarises every Zoom call" is only real for registration calls.** `scheduled_calls.meeting_summary` is a **pass-through of Zoom's native AI Companion** (no bot joins, no transcript stored). `career_interviews` has **zero** summary capability, and `createZoomMeeting` sets `auto_recording:'none'` with no AI Companion flag. | We surface the **real** registration-call summaries on the candidate profile (honest). We add the interview-summary *mechanism* (columns + webhook + companion flag) but label it "works once Zoom AI Companion is enabled on the host account" — we will not claim a bot joins calls (§8). |
| R5 | **The AI comms-engagement scan is genuinely feasible today.** Inbound WhatsApp is stored (`doubletick_messages`), outbound email bodies are stored (`task_messages`), and `/api/admin/candidate-summary` already aggregates them into a Claude call. | We build a real comms scan reusing that exact pattern. The only missing signal is **outbound** WhatsApp (small additive fix) and full inbound email bodies (snippet-only) — documented, not hidden (§8). |
| R6 | **The real `ceo-dashboard.html` 404s on localhost** (`server.js:41314` requires host scope `super_admin`; loopback resolves to `local`). | Local verification uses (a) seeded **local-JSON** dual-mode endpoints + a configured local super-admin host, and (b) vitest. The standalone prototype remains the no-auth demo (§13–14). |
| R7 | **`lib/anthropic-model.js` does NOT exist on this branch** (only on an unmerged branch). | AI calls use the env constants `ANTHROPIC_MODEL` (`claude-opus-4-6`, general, `temperature:0`) and `ANTHROPIC_SCAN_MODEL` (`claude-opus-4-8`, vision). Do not import the helper. |
| R8 | The prototype's master tabs use `class="master-tabs" id="masterTabs"` with **`data-tab`** + count chips + SVG icons. The existing inner sub-nav `#ceoTopNav` **also** uses `data-tab`. | Port the prototype markup verbatim, but **scope each click handler to its own `<nav>` element** so the two `data-tab` layers never collide (§6.1). |

**Non-negotiable honesty rule (CLAUDE.md #1, #2, #5):** every banner/label must describe what actually happens. Where a capability depends on an external setting (Zoom AI Companion) or is approximated (engagement from one-sided WhatsApp), the UI says so plainly.

---

## 1. Architecture & where the code lives

Monolith: one Node server (`server.js`, ~41.5k lines) handles **all** routes (API + static + auth), deployed on Vercel. Pages are plain HTML with inline `<script>`/`<style>`. CEO dashboard auth = **super_admin** via the `gp_admin_session` cookie.

**Files we add / change:**

| File | Change |
|---|---|
| `pages/ceo-dashboard.html` | Add the master-tab row + 3 new panels; wrap the existing dashboard in a Registration panel. **No change to existing dashboard internals.** |
| `js/ceo-ats-candidates.js` *(new)* | Candidates tab: list + profile + intent UI + comms/calls/handover. |
| `js/ceo-ats-jobs.js` *(new)* | Jobs tab: list + native create + drag-and-drop pipeline board + candidate drawer. |
| `js/ceo-ats-practices.js` *(new)* | Practices tab: directory + create/edit + detail. |
| `js/ceo-ats-shared.js` *(new)* | Master-tab switcher + shared helpers (avatar colours, intent rendering, escaping) reused by the three module files. |
| `lib/ats-intent.js` *(new, CommonJS)* | **Pure** intent calculator (ported from the prototype's `intentFor()`), so it is unit-testable in isolation. |
| `lib/ats-practices.js` *(new, CommonJS)* | **Pure** helpers: practice-name normalisation/dedup for backfill, job/candidate bucketing. |
| `lib/ats-comms.js` *(new, CommonJS)* | **Pure** helpers for the comms scan: build the prompt, parse/normalise the AI verdict, compute approximate reply-latency from message timestamps. |
| `server.js` | New endpoints `/api/ats/*` (jobs, practices, pipeline) + `/api/ceo/candidate*` (list, profile, comms-scan, recompute-intent) + a `/api/cron/recompute-intent` cron; new local-JSON collections; generalise `fetchAndSaveZoomSummary` to also serve interviews. |
| `supabase/migrations/2026XXXX_*.sql` *(new)* | `practices`, `career_roles` ATS columns, `gp_applications.ats_stage`, `registration_cases` intent + comms columns, `career_interviews` summary columns. |
| `vercel.json` | Add the intent-recompute cron. |
| `tests/*` | `ats-intent.test.js`, `ats-practices.test.js`, `ats-comms.test.js` (lib unit), `ats-endpoints.test.js` (booted server), plus new invariants in `ceo-standalone-ui.test.js`. |

**Conventions:** cache-buster `?v=YYYYMMDD[letter]` on every new `<script src>`; JS served `no-cache`; event-delegation; `node --check server.js` before each push; commit + push after each change (CLAUDE.md #6). Inline-script regexes in `ceo-dashboard.html` must use `\xNN` escapes, never literal control bytes (`pages-no-control-bytes.test.js`).

**Routing recipe (verified):** new endpoints are `if (pathname === '/api/...' && req.method === 'X') { ...; return; }` blocks inserted in `handleApi` (`server.js:21579`) **before** the final `sendJson(res,404,...)` (`server.js:41238`). Guard idiom: `var ctx = requireCeoSession(req,res); if(!ctx) return;` (the guard sends its own 401/403). Reads/writes via `supabaseDbRequest(table,query,opts)` in prod; `dbState.<collection>` + `saveDbState()` in local-JSON dev. INSERT body is an **array**; add `headers:{Prefer:'return=representation'}` to get the row back; UPDATE via `query:'id=eq.'+id` + `method:'PATCH'`.

---

## 2. Data-model reuse map (what we read, unchanged)

| Concept | Table / source | Used by |
|---|---|---|
| Jobs | `career_roles` (+ new ATS columns) | Jobs tab |
| Applications / pipeline | `gp_applications` (+ new `ats_stage`) | Jobs board, candidate profile |
| Interviews | `career_interviews` (+ new summary columns) | Jobs drawer, candidate calls |
| The candidate (person) | `user_profiles` + `user_state.state` blob | Candidates tab |
| Onboarding | `user_state.state.gp_onboarding` (`country, qualDocs, idVerification, targetDate, preferredCity, whoMoving, childrenCount, completedAt`) | Candidate profile, intent |
| Registration pipeline | `registration_cases` (`stage`, `status`, `blocker_status`, `blocker_set_at`, `assigned_va/rso`, `ai_handover_summary`, + new intent/comms cols) | Candidate profile, intent |
| Calls + AI summaries | `scheduled_calls` (`meeting_summary`, `meeting_action_items`, `summary_status`, `status`) | Candidate "Zoom call summaries" |
| AI handover summary | `registration_cases.ai_handover_summary` via `/api/admin/candidate-summary?case_id=` | Candidate profile |
| Documents | `user_documents` (`cv_signed_dated` [AU + uk/ie/nz], `career_cover_letter` [AU], `primary_medical_degree`/`onboarding_primary_med_degree`) + `user_profiles.id_copy_data_url` (ID) | Candidate docs + intent |
| WhatsApp (inbound) | `doubletick_messages` | Comms scan |
| Email (outbound, full body) | `task_messages` | Comms scan |
| Status bucketing | `lib/ceo-metrics.js` (`normalizeStatusKey`, `isSecuredStatus`, `isOfferStatus`, `isInterviewStatus`) | Pipeline + intent |
| RSO roster | `rso_team` table via `loadRsoTeam()` (UUID `assigned_rso`, not email) | "Assigned RSO", reassign |
| Open RSO file | deep-link `window.open('/pages/admin?gp='+userId,'_blank')` | Candidate "Open RSO file" |

---

## 3. Reality vs prototype — what is real vs labelled

| Feature | In this build |
|---|---|
| Master tabs, wrap Registration | **Real**, exact prototype look. |
| Candidates list + search + sort-by-intent + filters | **Real** (all filters wired server-side). |
| Intent calculator (score, band, full signal breakdown) | **Real** — `lib/ats-intent.js`, ported formula, real data sources (§7). |
| Candidate profile (profile, pipeline rail, onboarding, docs, handover) | **Real** — reuses existing endpoints + new aggregate. |
| AI comms-engagement scan | **Real** Claude call over real inbound WhatsApp + outbound emails + email snippets. Banner states the data sources honestly; engagement is an AI estimate. Outbound-WhatsApp persistence added (small fix) so it is two-sided. |
| Zoom call summaries on profile | **Real** for registration calls (Zoom AI Companion pass-through). Interview summaries: mechanism wired; banner says summaries appear "automatically once the call's Zoom AI Companion has run" — **no claim that a bot joins**. |
| Jobs list, native "Add job", search, filters | **Real** (native jobs `provider='internal_ats'`). |
| Drag-and-drop board → persists `ats_stage` (+ audit) | **Real**. |
| Candidate drawer: stage change, notes, **Schedule interview** | **Real** — interview scheduling reuses `/api/admin/career/interview/schedule`. |
| Job settings | **Real** — `GET/PATCH /api/ats/job?id=`. |
| Practices directory, **Add practice**, **Edit**, detail with linked jobs/candidates | **Real**. |
| "Open RSO file", "Schedule call" | **Real** — deep-link + existing `/api/admin/calls/schedule`. |
| Zoho | One-way sync stays; native jobs created in-app. Backfill practices from existing names. No Zoho-off this round. |

**No dead buttons.** Every interactive control is enumerated in the control inventory (§9) with its full chain.

---

## 4. Database changes (additive migrations)

All migrations are **additive** (new tables, new nullable/defaulted columns) — they do not alter or break anything the live app reads. Applied to the shared Supabase via the `exec_sql` RPC with the service key (from the main checkout's `.env`), **one statement per call, every name schema-qualified** (`public.…`), verified with a REST `GET`. RLS mirrors the repo convention: `enable row level security` + `for all using (auth.role() = 'service_role')`. Each table/column also gets a **local-JSON** home so dev mode works without Supabase.

### 4.1 `practices` (NEW)
```sql
create table if not exists public.practices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_city text not null default '',
  location_state text not null default '',
  location_country text not null default 'Australia',
  practice_type text not null default '',
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  ahpra_number text not null default '',
  zoho_client_id text,
  source text not null default 'internal_ats'
    check (source in ('zoho_sync','internal_ats','manual','backfill')),
  notes text not null default '',
  is_active boolean not null default true,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_practices_name_lower on public.practices (lower(name));
create index if not exists idx_practices_active on public.practices (is_active, name);
alter table public.practices enable row level security;
create policy practices_service_all on public.practices
  for all using (auth.role() = 'service_role');
```
**Backfill:** dedup distinct `career_roles.practice_name` (then `pending_hires.practice_name`, `registration_cases.practice_name`) via `lib/ats-practices.js` `normalizePracticeName()`; insert one `practices` row per unique name (`source='backfill'`), carrying location from the most recent `career_roles` row. Then set `career_roles.practice_id` by name match.

### 4.2 `career_roles` ATS columns
```sql
alter table public.career_roles
  add column if not exists practice_id uuid references public.practices(id) on delete set null,
  add column if not exists job_status text not null default 'open'
    check (job_status in ('open','filled','closed')),
  add column if not exists posted_by text not null default '',
  add column if not exists ats_created boolean not null default false;
create index if not exists idx_career_roles_practice on public.career_roles (practice_id);
```
Native jobs: `provider='internal_ats'`, `provider_role_id='ats_'+uuid` (keeps the `unique(provider,provider_role_id)` key valid), `ats_created=true`, `is_active=true`, `job_status='open'`. **Zoho sync gotcha:** `syncZohoRecruitRoles()` only upserts `on_conflict=provider,provider_role_id`, so native `internal_ats` rows are never touched by Zoho. (No change needed to the sync.)

### 4.3 `gp_applications.ats_stage` (the board column)
```sql
alter table public.gp_applications
  add column if not exists ats_stage text not null default 'applied'
    check (ats_stage in ('applied','submitted','reviewing','interview','offer','hired','not_proceeding')),
  add column if not exists ats_stage_updated_at timestamptz,
  add column if not exists ats_notes text not null default '';
create index if not exists idx_gp_applications_ats_stage on public.gp_applications (ats_stage);
```
Stage keys **match the prototype exactly** (`applied → submitted → reviewing → interview → offer → hired`, plus `not_proceeding` lane). **Backfill** from the two existing signals + interviews (pure rule in `lib/ats-practices.js` `deriveAtsStage(app, hasInterview)`):
- `status` `hired`/`placement_secured`/`offer_accepted`/`contract_signed` → `hired`
- `status` `rejected`/`withdrawn` → `not_proceeding`
- `status` `offer`/`offered` OR `practice_submission_status='client_approved'` → `offer`
- `status` `interview_scheduled`/`interviewing` OR a `career_interviews` row exists OR `practice_submission_status='interview_ready'` → `interview`
- `practice_submission_status` `client_reviewed` → `reviewing`
- `practice_submission_status` `submitted_to_practice` OR `status='submitted_to_practice'` → `submitted`
- else → `applied`

Moving a card **only** writes `ats_stage` (+ `ats_stage_updated_at`, + a `task_timeline`-style audit row); it does **not** rewrite `status`/`practice_submission_status` (those stay owned by the Zoho/VA workflow).

### 4.4 `registration_cases` intent + comms columns
```sql
alter table public.registration_cases
  add column if not exists intent_score integer,
  add column if not exists intent_band text check (intent_band in ('hot','warm','cold')),
  add column if not exists intent_signals jsonb,
  add column if not exists intent_computed_at timestamptz,
  add column if not exists comms_engagement jsonb,
  add column if not exists comms_engagement_at timestamptz;
create index if not exists idx_registration_cases_intent
  on public.registration_cases (intent_score desc nulls last);
```
`intent_signals` = the full `[{label,w,v,points}]` breakdown (so the UI is transparent, never a black box). `comms_engagement` = `{messages30d, avgReplyHrs, tone, engagementVal, aiRead, generated_at}`.

### 4.5 `career_interviews` summary columns (interview AI-summary mechanism)
```sql
alter table public.career_interviews
  add column if not exists meeting_summary text,
  add column if not exists meeting_action_items jsonb,
  add column if not exists meeting_summary_raw jsonb,
  add column if not exists summary_status text not null default 'not_requested'
    check (summary_status in ('not_requested','pending','saved','not_available','error')),
  add column if not exists summary_fetch_attempts integer not null default 0,
  add column if not exists summary_error text,
  add column if not exists zoom_meeting_uuid text;
```
These mirror `scheduled_calls` so `fetchAndSaveZoomSummary()` can be generalised to a `(table, row)` signature and the Zoom webhook can match interviews too. `createZoomMeeting()` is updated to request AI Companion / cloud-recording on interview meetings. **Honest caveat:** interview summaries only populate if the host's Zoom account has AI Companion entitlement — surfaced in the UI as a status, never asserted as done.

---

## 5. Local-JSON dual-mode (so the localhost build is clickable)

To honour constraint #1 ("functional localhost prototype first") without touching prod, every new endpoint runs in **both** backends:

- `createEmptyState()` (`server.js:4959`) gains collections: `atsPractices`, `atsJobs`, `atsApplications`, `atsCandidates`, plus per-case `intentByCase`/`commsByCase` maps. `loadDbState()` merge (~4989) guards each.
- A dev seed (`npm run init:db` extension, or a one-shot `scripts/seed-ats-dev.js`) loads the **prototype's dummy data** (5 practices, 5 jobs, 14 board candidates, 13 GPs with onboarding/docs/calls/comms shapes) into local-JSON. Result: the real `ceo-dashboard.html`, running locally against the real endpoints + real `lib/ats-intent.js`, looks and behaves exactly like the approved prototype.
- To view the gated page locally, run with `SUPER_ADMIN_ALLOWED_HOSTS` including the dev host and a minted super-admin session (documented in §14).

In prod/preview (Supabase configured) the same endpoints read the real tables.

---

## 6. Per-tab design

### 6.1 Tab shell (Registration wrap)
- Insert the master-tab `<nav class="master-tabs" id="masterTabs">` immediately **after** `</header>` (`ceo-dashboard.html:1297`), markup copied from the prototype (4 buttons, SVG icons, count chips).
- Wrap the existing dashboard surface (lines **1299–1327**: `#ceoTopNav` + `#timeFilterBar` + `#mainContent`/`#rsoContent`/`#mcContent`/`#techContent`) inside `<div class="master-panel" id="panel-registration">` — **zero changes to internals**, so `renderDashboard()`, the `#ceoTopNav` sub-tab dispatcher, the 30s refresh loop, and `checkAuth()` all keep working.
- Add 3 sibling hidden panels: `#panel-candidates`, `#panel-jobs`, `#panel-practices` (before `page-wrap` closes at 1328).
- **Collision fix:** the master switcher binds to `#masterTabs` only; the existing sub-tab handler stays bound to `#ceoTopNav` only — both use `data-tab` but never see each other's clicks.
- **Sticky fix:** master bar takes `top:60px`; move `.ceo-topnav` to `top:108px` (or non-sticky) to avoid overlap.
- Lazy loaders resolved from `window` at click-time (`window.loadCandidatesTab` etc.), mirroring the existing `loadTechnical` lazy guard, because the module files load after the inline script.
- New `<script src>` tags appended after the inline `</script>` (line 6112), with `?v=` busters.
- Count chips: Candidates = total GPs; Jobs = open jobs; Practices = total practices (populated by the loaders).

### 6.2 Candidates tab
- **List** (`GET /api/ceo/candidates`): rows = avatar+name+email · country · registration-stage pill (red if blocked) · intent (bar+score+band) · onboarding (Complete/%) · docs (CV ✓/✗, Cover ✓/✗). Default sort **intent DESC**. Search (name/email). Filters: stage, intent band, account status, RSO — all server-side query params.
- **Profile** (`GET /api/ceo/candidate?case_id=`) renders, top-to-bottom matching the prototype: Profile · **Intent calculator** (score/100 + band + full signal breakdown with the "first proposal — tell me what to change" note) · **Pipeline position** (registration journey rail from `STAGE_ORDER`/`DB_STAGE_ORDER` with blocked state + ATS job-application rows) · Onboarding · Documents on file · **Communication & engagement (AI)** · **Zoom call summaries** · AI handover summary.
- **Actions (real):** "Open RSO file" → `window.open('/pages/admin?gp='+userId)`; "Schedule call" → existing schedule-call modal (`POST /api/admin/calls/schedule`).

### 6.3 Jobs tab (ATS)
- **List** (`GET /api/ats/jobs`): title · linked practice · location · type · billing · `job_status` pill · #in-pipeline · per-stage spark. `+ Add job` (`POST /api/ats/jobs`, native). Search + filters (state, open-only) wired server-side.
- **Board** (`GET /api/ats/job/pipeline?id=`): columns `Applied → Submitted to Practice → Practice Reviewing → Interview → Offer → Hired` + `Not Proceeding`. Drag a card → `PATCH /api/ats/application?id=` sets `ats_stage` (+ audit); counts update. Click a card → drawer: candidate, applying-for, **stage select**, **Schedule interview** (`POST /api/admin/career/interview/schedule`), internal notes (saved to `ats_notes`). `Job settings` → `GET/PATCH /api/ats/job?id=`.

### 6.4 Practices tab
- **Directory** (`GET /api/ats/practices`): cards (name, location, type, #jobs, #candidates). `+ Add practice` (`POST /api/ats/practices`). Search.
- **Detail** (`GET /api/ats/practice?id=`): fields + its jobs (click → that job's board) + its candidates in pipeline (stage pills). `Edit` → `PATCH /api/ats/practice?id=`.

---

## 7. Intent calculator (exact, transparent)

Ported verbatim from the prototype `intentFor()` into **`lib/ats-intent.js`** as a pure function `computeIntent(input) → {score, band, signals}`. Weighted sum, each signal normalised 0–1 × weight. **Bands: Hot ≥70 · Warm 40–69 · Cold <40.** Weights are the owner-revised 2026-06-27 set (total 100); `intent_signals` stores the breakdown so the UI shows every signal's bar + points.

| # | Signal | Weight | Normalisation (0–1) | Real source |
|---|---|---|---|---|
| 1 | Comms engagement & tone (AI) | 18 | `comms_engagement.engagementVal` (0 if no scan) | `registration_cases.comms_engagement` (from the comms scan) |
| 2 | Onboarding completed | 18 | `1` if `gp_onboarding.completedAt`; else fraction of key fields filled | `user_state.state.gp_onboarding` |
| 3 | Documents (CV, cover, ID, degree) | 16 | share of 4 present | `user_documents` (+ `user_profiles.id_copy_data_url`) via `getCandidateDocFlags()` |
| 4 | Registration progress | 14 | `DB_STAGE_ORDER` index ÷ max, **minus** blocked-days penalty (`blocker_set_at`→days, cap 0.4) | `registration_cases` |
| 5 | Call attendance | 14 | completed ÷ (completed + no_show + cancelled), default 0.5 if none | `scheduled_calls` |
| 6 | Recent app activity | 10 | decay: ≤7d=1, ≤14d=.6, ≤30d=.3, else .1 | `registration_cases.last_gp_activity_at` |
| 7 | Job pipeline engagement | 10 | best `ats_stage`: hired 1 / offer .85 / interview .7 / reviewing .5 / submitted .4 / applied .3 / none 0 | `gp_applications.ats_stage` |

**Computed + stored** by `/api/cron/recompute-intent` (daily) and on-demand (`POST /api/ceo/candidate/recompute-intent`), so the list is sortable/filterable without recomputing per request. The list endpoint serves the stored value; the profile endpoint recomputes live if stale (>24h) and shows the breakdown. The renamed-for-clarity label for signal 7 in the UI tooltip: "how far their furthest job application has progressed."

---

## 8. AI features — honest scope

### 8.1 Comms-engagement scan (real)
`POST /api/ceo/candidate/comms-scan?case_id=` (force refresh; else 24h cache on `comms_engagement_at`):
1. Parallel-fetch (reusing the `/api/admin/candidate-summary` shape): `doubletick_messages` (inbound WhatsApp, last ~50), `task_messages` (outbound emails, full body), live Gmail snippets via `searchGmailForGP` (if Google creds), `scheduled_calls`.
2. `lib/ats-comms.js` builds the prompt + computes approximate reply-latency from message timestamps.
3. Claude call exactly like `server.js:32006` (`ANTHROPIC_MODEL`, `temperature:0`, cached system prompt), gated by `checkAnthropicBudget()` / `recordAnthropicSpend()`.
4. Returns + stores `{messages30d, avgReplyHrs, tone, engagementVal (0–1), aiRead, generated_at}`. Feeds intent signal #1.
- **Two-sided fix:** add an additive `doubletick_messages` insert with `direction='outbound'` inside `sendDoubleTickTemplate/Nudge/ZoomCallInvite` (the column + CHECK already allow `outbound`) so engagement reflects both sides. **Preview-branch only** until merged.
- **Banner wording (honest):** "AI reads your real WhatsApp and email threads with this doctor to gauge how often they engage, how fast they reply, and their tone." (No claim about read-receipts or message content we don't have.)

### 8.2 Zoom call summaries (registration = real; interview = mechanism)
- **Registration calls:** read `scheduled_calls` for the case; show `meeting_summary` + `meeting_action_items` for `status='completed'` calls, plus upcoming calls. This is Zoom AI Companion output, already automatic — **no new pipeline**.
- **Interview calls:** add the summary columns (§4.5), generalise `fetchAndSaveZoomSummary(table,row)`, extend the Zoom webhook to match `career_interviews` by `zoom_meeting_id`, and set the AI Companion flag in `createZoomMeeting`. UI shows `summary_status` truthfully (e.g. "Summary will appear after the call once Zoom AI Companion has processed it").
- **Banner wording (honest):** "Zoom calls are summarised automatically by Zoom's AI once the call ends — no manual notes." (We do **not** say a GP-Link bot joins the call; it doesn't.)
- **Runtime assumption flagged to owner:** whether Zoom AI Companion is enabled on the RSO/host Zoom accounts is a Zoom setting, not code — if off, summaries stay empty and the UI says "not available".

---

## 9. Control inventory (hard requirement — no dead buttons)

Every interactive control, its full chain. Build + verify each.

| Tab | Control | Click does… | Endpoint | DB effect | Read-back |
|---|---|---|---|---|---|
| Shell | Master tab (Registration/Candidates/Jobs/Practices) | switch panel + lazy-load | — | — | panel shows; chip counts |
| Registration | (all existing controls) | unchanged | existing `/api/ceo/*` | unchanged | unchanged |
| Candidates | Search box | filter list | `GET /api/ceo/candidates?q=` | — | list filters |
| Candidates | Sort: Intent/Name | re-sort | `GET …?sort=` | — | order changes |
| Candidates | Stage filter | filter | `GET …?stage=` | — | list filters |
| Candidates | Intent-band filter | filter | `GET …?band=` | — | list filters |
| Candidates | Account-status filter | filter | `GET …?account_status=` | — | list filters |
| Candidates | RSO filter | filter | `GET …?rso=` | — | list filters |
| Candidates | Row click | open profile | `GET /api/ceo/candidate?case_id=` | — | profile renders |
| Candidates | ‹ All candidates | back to list | — | — | list shows |
| Candidates | Open RSO file | open RSO GP file (new tab) | `/pages/admin?gp=<userId>` | — | RSO file opens |
| Candidates | Schedule call | open schedule-call modal → save | `POST /api/admin/calls/schedule` | insert `scheduled_calls` | call under Upcoming |
| Candidates | Run/refresh comms scan | AI comms scan | `POST /api/ceo/candidate/comms-scan?case_id=` | upsert `registration_cases.comms_engagement` | engagement card updates |
| Candidates | Refresh AI handover | `force=1` summary | `GET /api/admin/candidate-summary?case_id=&force=1` | upsert `ai_handover_summary` | summary updates |
| Candidates | Recompute intent | recompute + store | `POST /api/ceo/candidate/recompute-intent?case_id=` | upsert intent cols | score updates |
| Jobs | Search box | filter jobs | `GET /api/ats/jobs?q=` | — | list filters |
| Jobs | State filter | filter | `GET /api/ats/jobs?state=` | — | list filters |
| Jobs | Open-only filter | filter | `GET /api/ats/jobs?status=open` | — | list filters |
| Jobs | + Add job | create form → save | `POST /api/ats/jobs` | insert `career_roles` (`internal_ats`) | new job in list |
| Jobs | Job card click | open board | `GET /api/ats/job/pipeline?id=` | — | board renders |
| Jobs | Drag card → column | move stage | `PATCH /api/ats/application?id=` | update `ats_stage` + audit | card moves, counts update |
| Jobs | Job settings | open/save settings | `GET/PATCH /api/ats/job?id=` | update `career_roles` | settings saved |
| Jobs | Card click → drawer | open drawer | (uses loaded data) | — | drawer opens |
| Jobs | Drawer stage select | change stage | `PATCH /api/ats/application?id=` | update `ats_stage` | board reflects |
| Jobs | Drawer Schedule interview | schedule Zoom interview | `POST /api/admin/career/interview/schedule` | insert `career_interviews` (+ Zoom) | interview shown; GP notified |
| Jobs | Drawer Save (notes) | save notes | `PATCH /api/ats/application?id=` | update `ats_notes` | notes persist |
| Jobs | ‹ All jobs | back | — | — | list shows |
| Practices | Search box | filter | `GET /api/ats/practices?q=` | — | list filters |
| Practices | + Add practice | create → save | `POST /api/ats/practices` | insert `practices` | new card |
| Practices | Practice card click | open detail | `GET /api/ats/practice?id=` | — | detail renders |
| Practices | Edit | edit form → save | `PATCH /api/ats/practice?id=` | update `practices` | changes shown |
| Practices | Mini-job click | go to that job's board | `GET /api/ats/job/pipeline?id=` | — | board opens |
| Practices | Candidate row click | open candidate drawer/profile | (loaded data) | — | drawer/profile |
| Practices | ‹ All practices | back | — | — | list shows |

---

## 10. New API endpoints

All guarded by `requireCeoSession` (super-admin). Dual-mode (Supabase + local-JSON).

| Method | Path | Returns / does |
|---|---|---|
| GET | `/api/ceo/candidates` | `{ok, candidates:[{user_id, case_id, name, email, country, reg_stage, blocked, intent_score, intent_band, onboarding_pct, docs:{cv,coverLetter}}…]}` filtered by `q/stage/band/account_status/rso/sort` |
| GET | `/api/ceo/candidate?case_id=` (or `user_id=`) | full profile aggregate: profile, intent(+signals), pipeline(rail + apps), onboarding, docs(4), comms, calls(scheduled_calls), handover |
| POST | `/api/ceo/candidate/comms-scan?case_id=` | run/refresh AI comms scan → `comms_engagement` |
| POST | `/api/ceo/candidate/recompute-intent?case_id=` | recompute + store intent |
| GET | `/api/ats/jobs` | list jobs (+ practice + pipeline counts + spark), filters `q/state/status` |
| POST | `/api/ats/jobs` | create native job |
| GET | `/api/ats/job?id=` | one job (for settings) |
| PATCH | `/api/ats/job?id=` | update job (title, practice_id, city, state, type, billing, job_status) |
| GET | `/api/ats/job/pipeline?id=` | candidates grouped by `ats_stage` for the job |
| PATCH | `/api/ats/application?id=` | update `ats_stage` and/or `ats_notes` (+ audit) |
| GET | `/api/ats/practices` | list practices (+ #jobs, #candidates), filter `q` |
| POST | `/api/ats/practices` | create practice |
| GET | `/api/ats/practice?id=` | practice + its jobs + its candidates |
| PATCH | `/api/ats/practice?id=` | edit practice |
| POST | `/api/cron/recompute-intent` | (cron-secret) recompute intent for all active cases |

**Reused, unchanged:** `/api/admin/case?id=`, `/api/admin/candidate-summary?case_id=`, `/api/admin/calls/schedule`, `/api/admin/career/interview/schedule`, `/pages/admin?gp=`.

---

## 11. Build sequence (subagent/workflow-driven)

1. **Pure libs first (TDD):** `lib/ats-intent.js`, `lib/ats-practices.js`, `lib/ats-comms.js` + their unit tests (`tests/ats-*.test.js`). Frozen-clock fixtures, exact-number assertions, API-surface guards (mirror `ceo-metrics.test.js`).
2. **Migrations + local-JSON:** write the 5 migration files; add `createEmptyState`/`loadDbState` collections; write `scripts/seed-ats-dev.js` (prototype dummy data). Apply additive migrations to the shared Supabase via `exec_sql` (verify each with a REST GET).
3. **Backend endpoints:** add the `/api/ats/*` + `/api/ceo/candidate*` + cron handlers in `server.js` (dual-mode); generalise `fetchAndSaveZoomSummary`; extend the Zoom webhook + `createZoomMeeting`; add outbound-WhatsApp persistence. `node --check server.js`.
4. **Endpoint tests:** `tests/ats-endpoints.test.js` (boot `createServer`, super-admin cookie, host header; assert no-500 + JSON shape for every new route).
5. **Tab shell:** edit `ceo-dashboard.html` (master tabs + wrap + 3 panels + CSS + switcher + `<script>` tags). Verify the existing dashboard still renders.
6. **Tab modules:** `js/ceo-ats-shared.js`, `…-candidates.js`, `…-jobs.js`, `…-practices.js` — port the prototype's render/drag/drawer/modal logic, wired to the real endpoints.
7. **Wire every control** (§9) + remove every prototype `toast('Demo only…')`.
8. **Verify end-to-end** (§13): `npm test`, `node --check server.js`, run locally with a super-admin host + seeded data, click every control, screenshot.
9. **Commit + push to `worktree-ats-prototype`** (NOT main). Update `ceo-standalone-ui.test.js` invariants.

Each numbered step is one subagent/workflow task; review each before the next.

---

## 12. Testing plan

- **Lib unit tests** (no server/DB): `ats-intent.test.js` (port the prototype's expected scores as fixtures; assert bands + exact points; deterministic; null-safe; API-surface guard), `ats-practices.test.js` (normalisation/dedup + `deriveAtsStage` truth table), `ats-comms.test.js` (prompt build + latency math + verdict parse).
- **Endpoint tests** (`ats-endpoints.test.js`): boot `createServer()` on port 0; mint `gp_admin_session` (HMAC-**SHA512** over base64url payload, key `AUTH_SECRET`); `Host: <SUPER_HOST>` + `SUPER_ADMIN_ALLOWED_HOSTS`; unreachable-loopback Supabase trick (handlers run on empty data, no 503) for read shape; JSON-file fallback (`SUPABASE_URL=''`) for write-persist assertions. Assert: not 500, no "Internal Server Error", 200, expected JSON keys, and host-gate rejection for a wrong host.
- **Must-not-break guards:** `pages-no-control-bytes.test.js` (escape all control bytes in new inline regexes) and `ceo-standalone-ui.test.js` (add invariants for the 4 master tabs + new endpoints; don't break existing RSO/topnav assertions).
- **Full suite:** `npm test` (vitest, currently passing) must stay green.

---

## 13. Verification (before claiming done)

1. `node --check server.js` → clean.
2. `npm test` → all green (existing + new).
3. Run the server locally (temp Node) in local-JSON mode with seeded ATS data + a configured super-admin host; open `ceo-dashboard.html`; click **every** control in §9; confirm each does what the inventory says (screenshots). Specifically verify drag→persist (reload shows the moved card), Add job/practice (appears + persists), filters, intent sort, profile sections, comms scan, schedule call/interview deep-links.
4. Confirm the **existing** Registration dashboard is visually + functionally unchanged.
5. Report honestly which controls are verified live vs which depend on prod-only data (e.g. real Zoom summaries need a real completed call).

---

## 14. Deployment & the localhost gate

- **Preview only.** Build + commit + push `worktree-ats-prototype` to origin. **Do not** merge to `main`.
- The real `ceo-dashboard.html` 404s on localhost (host scope). To view locally: start the server with `SUPER_ADMIN_ALLOWED_HOSTS=<dev-host>` (+ `NODE_ENV` non-prod), send `Host: <dev-host>`, and use a minted super-admin session — or rely on the seeded local-JSON + tests + screenshots.
- **Migrations:** additive only; applied to the shared Supabase via `exec_sql` + the service key (main checkout `.env`). These do not change the live app (it doesn't read the new columns/tables yet). Flagged to owner as "added new storage; live app unaffected."
- For the owner to click the real thing on a Vercel **preview** deployment, the preview host must be in the super-admin host set (`PREVIEW_SUPER_ADMIN_HOSTS`) — confirm/raise with owner.

---

## 15. Risks, assumptions, open questions

- **A1 (assumption):** intent weights = the owner-revised 2026-06-27 set (handover §7). Tunable post-demo.
- **A2 (assumption):** ATS endpoints are CEO/super-admin-only (matches the dashboard). RSO access is a later stage.
- **R-Zoom:** interview AI summaries depend on Zoom AI Companion entitlement on the host account (cannot verify from code). UI states status truthfully.
- **R-comms:** engagement is an AI estimate from inbound WhatsApp + outbound email (+ snippets); outbound WhatsApp persistence is added but inbound email bodies remain snippet-only. Stated in the banner.
- **R-migrate:** applying additive migrations to the shared Supabase is the repo's standard pattern but still touches the production database; done only additively and flagged to the owner before relying on real data in the preview.
- **Q-open (carry to owner):** confirm final intent weights; confirm the "Job pipeline engagement" label; whether a long blocker should subtract or be neutral; whether to enable Zoom AI Companion on interview meetings now.

---

## 16. Out of scope (this round)

- Doctors applying to jobs from their own app (user-facing direct apply).
- Practice self-signup / portal / logins.
- Turning Zoho off (this round lays the foundation to own the data).
- A bot that auto-joins/records Zoom calls (we use Zoom's native AI Companion only).
