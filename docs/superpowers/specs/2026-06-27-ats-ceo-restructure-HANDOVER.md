# HANDOVER — CEO Dashboard Restructure + In-App ATS

**Date:** 2026-06-27
**Status:** Design approved by owner. Clickable prototype built & signed-off-in-progress. **Ready for spec → build → preview.**
**Author of this handover:** prior Claude Code session (brainstorm + prototype).
**Audience:** a fresh Claude Code session that will write the formal spec and build the real feature.

---

## 0. START HERE (read this first)

You are continuing a large, already-designed piece of work. **The design is done and approved — do NOT re-brainstorm it from scratch.** Your job:

1. Read this whole doc.
2. Open the **prototype** (it is the visual + behavioural source of truth) — see §3.
3. Write the **formal spec** to `docs/superpowers/specs/2026-06-27-ats-ceo-restructure-design.md` (use `superpowers:writing-plans` after).
4. Build it for real, **subagent/workflow-driven**, on a **PREVIEW branch only**.
5. **Every single button/control must work end-to-end** (see §8 — this is a hard owner requirement).

**The owner is non-technical** — when you talk to them, use plain everyday words, no jargon (this is also in `CLAUDE.md` and memory).

### Three hard constraints from the owner (non-negotiable)
1. **A functional localhost prototype had to come first.** ✅ Done (this round). The owner has seen and approved it.
2. **Push to a PREVIEW branch, NEVER production.** Production = `git push origin main` (Vercel auto-builds main). So: build on a new branch (e.g. `ats-ceo-restructure` / a worktree), push that branch to origin, do **not** merge to `main` until the owner says so.
3. **Every single button must be functional and properly connected** end-to-end (UI → API → DB → read-back). No decorative/dead buttons. The spec must include a **control inventory** (§8).

---

## 1. What we're building (the vision, in plain words)

The CEO dashboard today is **one long page** of registration-process info (`pages/ceo-dashboard.html`). The owner wants it reorganised into a **row of master tabs**, and a real **ATS (applicant-tracking system, like Zoho Recruit) built into the app** — natively linked, unlike Zoho which is an external system.

**Target master tabs:**

```
[ Registration ]   [ Candidates ]   [ Jobs ]   [ Practices ]
```

- **Registration** — everything the CEO dashboard shows today, unchanged, just moved inside this tab.
- **Candidates** — every GP on file: profile, onboarding, AI call summaries, AI comms-engagement read, intent score, and pipeline position.
- **Jobs** — the ATS: job postings + a candidate hiring pipeline board.
- **Practices** — clinics/hospitals as first-class records: their details, jobs, and candidates.

**The big idea / advantage over Zoho:** a doctor is ONE person who can be in registration AND applying to jobs; every job belongs to a practice; everything is linked.

**Future stages (NOT this round):** doctors applying to jobs from their own app (user-facing), practice self-signup/portal/logins, and finally turning Zoho off.

---

## 2. Decisions already locked (do not re-litigate)

| Topic | Decision |
|---|---|
| Scope this round | Restructure **+** Candidates tab **+** Jobs ATS (postings + pipeline) **+** Practices (real records + basic tab). All four tabs. |
| Zoho | **Replace over time.** The in-app ATS becomes the system of record. Import existing Zoho data once, then own it. Keep one-way Zoho sync running during transition; new jobs are created natively. |
| Hiring pipeline stages | The **real flow**: `Applied → Submitted to Practice → Practice Reviewing → Interview → Offer → Hired`, plus a **Not Proceeding** lane. (Matches data already captured — see §5.) |
| Practices | **Create a real `practices` table now** + backfill from existing names + link jobs to practices + a basic Practices tab (view/add/edit). **No** practice logins/portal yet. |
| Candidates tab | Full GP record: profile, onboarding, AI Zoom call summaries, **AI comms-engagement & tone scan (DoubleTick + email)**, intent score, registration + ATS pipeline position, documents incl. CV/cover-letter tracking, AI handover summary. |
| Intent calculator | **NEW** (does not exist in code). 0–100 weighted score, bands **Hot ≥70 / Warm 40–69 / Cold <40**. Final signals/weights in §7. |
| Who uses it | CEO / super-admin only (same gate as the dashboard today). RSO access can come later. |
| Tab order | `Registration | Candidates | Jobs | Practices`. |

---

## 3. The prototype (visual + behavioural source of truth)

- **File:** `pages/ceo-dashboard-prototype.html` (on branch `worktree-ats-prototype`). Self-contained single HTML file, vanilla JS, dummy data. ~1,300 lines.
- **Run it:** `python3 -m http.server 8787 --bind 127.0.0.1` from repo root, then open `http://localhost:8787/pages/ceo-dashboard-prototype.html`.
- **Deep-links (for screenshots / jumping in):** `#candidates`, `#candidate=g3`, `#jobs`, `#board`, `#practices`, `#practice`.
- **Match its look & feel exactly** — it already uses the dashboard's dark theme tokens (`--bg:#0f1117`, `--panel:#1a1d27`, blue `#60a5fa` / purple `#a78bfa` accents, DM Sans + JetBrains Mono). The real build should feel identical, just wired to real data.

**The prototype is the UI spec.** When in doubt about layout/wording/behaviour, copy the prototype.

### What is REAL vs MOCK in the prototype
- **Real (genuinely functional in prototype):** tab switching, candidate list + search + sort by intent, candidate profile (all sections), the working intent calculator, the Jobs list + search, the **drag-and-drop pipeline board**, opening a job's board, candidate drawer + stage change + notes, "Add job" / "Add practice" forms, Practices list + detail, all cross-links (practice → its jobs/candidates, candidate → job apps).
- **Mock (pop a "demo only" toast — these MUST be wired for real in the build):** `Open RSO file`, `Schedule call` / `Schedule interview`, `Edit practice`, `Job settings`, and the filter dropdowns (`All states ▾`, `All stages ▾`, `All intent ▾`).

---

## 4. Where the new code should live (architecture)

Monolith: a single Node server (`server.js`) handles ALL routes (API + static + auth), deployed on Vercel via `@vercel/node`. Pages are plain HTML with inline `<script>`/`<style>`. CEO dashboard auth = **super_admin** role via `/api/admin/auth/session` (session cookie `gp_admin_session`).

**Recommended approach (keeps risk low + files manageable):**
- **Leave the existing `pages/ceo-dashboard.html` dashboard code UNTOUCHED** — wrap its current rendered output inside a `Registration` tab panel. Add the master-tab row + 3 new panels.
- Put the **new tab logic in dedicated JS module files** (e.g. `js/ceo-ats-jobs.js`, `js/ceo-ats-candidates.js`, `js/ceo-ats-practices.js`) loaded by the page, rather than bloating the 1,838-line dashboard file. Use cache-busters `?v=YYYYMMDD[letter]` per convention.
- New server endpoints under **`/api/ats/*`** (jobs, practices, pipeline) and **`/api/ceo/candidates*`** (candidate list/profile), reusing existing `/api/admin/*` and `/api/career/*` where sensible.
- DB changes via migrations in `supabase/migrations/` (Supabase prod; local JSON `data/app-db.json` dev fallback). Apply DDL in prod through `rpc/exec_sql` with the **service key** (schema-qualify names) — the service key lives in **`.env`** (NOT `.env.prod`, which is blank). See memory `supabase-migrations-exec-sql`, `prod-supabase-service-key-location`.

**Note (memory `dashboard-calls-parity`):** `pages/admin.html` (RSO) and `pages/ceo-dashboard.html` (CEO) duplicate a lot of per-GP logic (Calls, GP-file). If you reuse admin patterns, keep both in sync where relevant.

---

## 5. Existing data model — REUSE MAP (what exists vs what's new)

Investigated already. **Reuse these; don't duplicate.**

### Reuse as-is (with small additions)
| Concept | Table | Key columns / notes |
|---|---|---|
| **Jobs / openings** | `career_roles` | `id` (bigint), `provider='zoho_recruit'`, `provider_role_id` (unique), `title`, `practice_name` (TEXT — to be linked), `location_city/state/country`, `is_active`, `employment_type`, `practice_type`, `tags[]`, `earnings_text`, `summary`, `source_payload` (jsonb), `published_at`, `synced_at`. Synced via `syncZohoRecruitRoles()`. Endpoints `/api/career/roles`, `/api/career/role`. UI today: `pages/job.html`, `pages/career.html`. |
| **Applications / pipeline** | `gp_applications` | `id` (uuid), `user_id`, `career_role_id`, `provider_role_id`, `status` (default `applied`), `applied_at`; **plus the VA practice-submission workflow:** `practice_submission_status` (default `pending_va_submission` → `submitted_to_practice` → `client_reviewed` → `client_approved`/`client_rejected` → `interview_ready`), `practice_contact_name/email`, `submitted_to_practice_at/by`, `submission_task_id`. `UNIQUE(user_id, provider_role_id)`. Status values seen: `applied/submitted/interviewing/offer/offered/hired/placement_secured/offer_accepted/contract_signed`. |
| **Interviews** | `career_interviews` | `application_id`, `user_id`, `scheduled_at`, `format`, `status` (`scheduled/confirmed`), `zoom_meeting_id/join_url/host_url/passcode`, `interviewer_name/role/email`, `gp_notes`, `internal_notes`. |
| **Candidates (the person)** | `user_profiles` + `user_state` | `user_profiles`: `user_id` (uuid), `email`, `first_name`, `last_name`, `registration_country`, `registration_number`, `phone`, `account_status` (`active/under_review/archived`), `onboarding_completed_at`, `target_arrival_date`, `preferred_city`, `zoho_candidate_id`. `user_state.state` JSON holds `gp_career_state` (applications array, `isPlacementSecured`) and `gp_onboarding`. |
| **Onboarding data** | `user_state.state.gp_onboarding` (+ `20260309000000_add_onboarding_profile_columns.sql`) | `country`, `qualDocs[mrcgp_cert/micgp_cert/frnzcgp_cert/primary_med_degree].status` & `.scanResult.nameFound`, `idVerification.status`, `targetDate`, `childrenAges[]`, `who_moving`, `accountReviewFlag` (→ `account_status='under_review'`), `completedAt`. Wizard = `js/onboarding.js`. |
| **Registration pipeline position** | `registration_cases` | `stage` (vs `STAGE_ORDER` const in `server.js`), `status` (`active/on_hold/blocked/complete/withdrawn`), `blocker_status`, `blocker_reason`, `blocker_set_at`, `assigned_va`, `ai_handover_summary`. Stage order ≈ `Secure Placement → MyIntealth → AMC → AHPRA → PBS & Medicare → Commencement` (+ `career`). |
| **Calls + AI summaries** | `scheduled_calls` (+ `career_interviews`) | `scheduled_at`, `status` (`invited/booked/completed/no_show/cancelled`), `zoom_join_url`, **`meeting_summary`**, **`meeting_action_items`**, `summary_status`, `summary_saved_at`, `invitee_notes`, `admin_notes`, `origin_task_id`. |
| **AI handover summary** | `registration_cases.ai_handover_summary` | Served by `/api/admin/candidate-summary?case_id=` (24h cached; `force=1` to refresh). |
| **Documents** | `gp_documents_prep`, `gp_prepared_docs`, `user_documents` | For CV / cover letter / degree / ID tracking. (CV signed/dated & certification checks already exist.) |
| **Pipeline status helpers** | `lib/ceo-metrics.js` | `normalizeStatusKey`, `isSecuredStatus`, `isOfferStatus`, `isInterviewStatus`. Reuse for bucketing. |
| **Messaging (for AI comms scan)** | DoubleTick (WhatsApp) + email | `20260406000000_doubletick_integration.sql`, `doubletick_customer_id`; email triage (`gmail_autoparsing`, `email_triage`). |

### CRITICAL GAP — must build new
1. **`practices` table** (first-class). Practices today are ONLY denormalised text (`career_roles.practice_name`, `gp_applications.practice_contact_*`, `registration_cases.practice_name/contact`, `practice_detected_contacts`, `practice_doc_ops.practice_contact`, `pending_hires.practice_name`). New table (proposed):
   `id (uuid)`, `name (unique)`, `location_city/state/country`, `contact_name`, `contact_email`, `contact_phone`, `practice_type`, `registration_number/ahpra`, `source` (`zoho_sync/internal_ats/manual`), `created_at`, `updated_at`.
   Then add `career_roles.practice_id (fk)` and **backfill** by deduping existing `practice_name` strings.
2. **Intent score storage** — e.g. `registration_cases.intent_score (int)` + `intent_band (text)` + `intent_signals (jsonb)` + `intent_computed_at`. Compute on a schedule/trigger and store so it's sortable/filterable (don't recompute per request).
3. **ATS pipeline stage** — either add `gp_applications.ats_stage` (enum for the 6 board columns + `not_proceeding`) initialised from existing `status`/`practice_submission_status`, OR derive the board column from those two fields. A dedicated `ats_stage` column is cleaner (lets staff drag freely). Moving a card updates it.
4. **Native job creation** — `career_roles` needs to accept rows with `source='internal_ats'` (not just Zoho sync) + a `posted_by`, `status` (`open/closed/filled`).
5. **AI Zoom meeting auto-capture** — owner wants AI to auto-join/record/summarise EVERY Zoom call (not just manual notes). `scheduled_calls.meeting_summary`/`meeting_action_items`/`summary_status` fields already exist (partial infra). Need the capture+summarise pipeline. (Scope/confirm: bot auto-join vs post-call transcript ingestion.)
6. **AI comms-engagement scan** — new: AI reads DoubleTick + email threads per candidate to produce volume, reply-speed, tone/sentiment, an engagement 0–1, and a short read. Feed into intent + show on profile.

---

## 6. Per-tab build detail

### 6.1 Registration tab
- Wrap the **existing** dashboard (KPI strip, time filter, 9 section cards, drilldowns, escalations) unchanged inside a `Registration` panel. Default active tab. Endpoints stay: `/api/ceo/dashboard`, `/api/ceo/trends`, `/api/ceo/drilldown/{section}`.

### 6.2 Candidates tab
**List view:** searchable/sortable table of all GPs. Columns: candidate (avatar+name+email), country, **registration stage pill** (red if blocked), **intent score** (bar + number + Hot/Warm/Cold), onboarding (Complete / %), documents (CV ✓/✗, Cover ✓/✗). Default sort: intent DESC. Filters: stage, intent band, (RSO, account status). Sources: `user_profiles` + `registration_cases` + computed intent.

**Profile view (click a candidate):**
- **Profile** — email, phone, registration country, registration no., account status, assigned RSO, Zoho id. (`user_profiles`, `registration_cases.assigned_va`)
- **Intent calculator** — score /100, band, **full signal breakdown** (label + bar + points). Must be transparent (never a black box). See §7.
- **Pipeline position** — registration **journey rail** (stages from `STAGE_ORDER` vs `registration_cases.stage`, blocked state in red) **and** job applications (rows from `gp_applications`, each with ATS stage pill).
- **Onboarding information** — qualification country, specialty, target arrival, preferred city, family/who's moving, identity verified, completion %. (`gp_onboarding`)
- **Documents on file** — CV, cover letter, primary medical degree, identity doc → uploaded/not. (`user_documents`/`gp_prepared_docs`/`gp_documents_prep`)
- **Communication & engagement (AI)** — tone pill, messages/30d, avg reply time, engagement /100, + AI tone/engagement read. Banner: "AI reads every DoubleTick (WhatsApp) & email thread…". (NEW — §5 gap 6)
- **Zoom call summaries** — banner "AI automatically joins, records & summarises every Zoom call"; per call: AI summary + AI-extracted action items; upcoming calls listed. (`scheduled_calls` + `career_interviews`; §5 gap 5)
- **AI handover summary** — `registration_cases.ai_handover_summary` via `/api/admin/candidate-summary`.
- **Actions (must be real):** `Open RSO file` (deep-link to the RSO GP file), `Schedule call` (the existing schedule-call modal/flow).

### 6.3 Jobs tab (ATS)
- **List:** title, practice (linked), location, type, billing, status (open/filled/closed), # candidates in pipeline, a per-stage spark. `+ Add job` → create a NATIVE job (`source='internal_ats'`). Search + filters (state, open-only) — **wire the filters for real.**
- **Pipeline board (click a job):** columns `Applied → Submitted to Practice → Practice Reviewing → Interview → Offer → Hired` + `Not Proceeding` lane. Cards = candidates. **Drag a card → updates `ats_stage`** (persist + audit). Click a card → drawer with candidate, **schedule interview** (reuse `career_interviews` + Zoom), notes, stage select. `Job settings` button must be real.

### 6.4 Practices tab
- **Directory:** practice cards (name, location, type, # jobs, # candidates). `+ Add practice` (real create). Search.
- **Detail (click a practice):** fields (contact, email, phone, type, AHPRA/reg no.) + **its jobs** (click → that job's board) + **its candidates in pipeline** (with stage pills). `Edit` button must be real.

---

## 7. Intent calculator — exact spec (owner-revised 2026-06-27)

0–100 weighted sum of signals, each normalised to 0–1 then × weight. **Bands: Hot ≥70 · Warm 40–69 · Cold <40.** Weights are still tunable — confirm with owner if changing.

| # | Signal | Weight | Normalisation (0–1) | Source |
|---|---|---|---|---|
| 1 | **Comms engagement & tone (AI)** | 18 | AI engagement read 0–1 (volume + reply speed + sentiment) | DoubleTick + email (NEW scan) |
| 2 | Onboarding completed | 18 | 1 if completed; else fraction of fields filled | `gp_onboarding` / `onboarding_completed_at` |
| 3 | Documents (CV, cover letter, ID, degree) | 16 | share of the 4 uploaded/verified | document tables |
| 4 | Registration progress | 14 | stage index ÷ max; **minus** blocked-days penalty (cap 0.4) | `registration_cases` |
| 5 | Call attendance | 14 | completed ÷ (completed + no_show + cancelled) | `scheduled_calls` |
| 6 | Recent app activity | 10 | decay: ≤7d=1, ≤14d=0.6, ≤30d=0.3, else 0.1 | last activity (confirm a real source, e.g. `user_state.updated_at`) |
| 7 | Job pipeline engagement | 10 | best `gp_applications` stage: hired 1 / offer .85 / interview .7 / reviewing .5 / submitted .4 / applied .3 / none 0 | `gp_applications` |

**Total = 100.** (Removed the old "English/exam progress" signal at owner's request.) See the exact JS reference implementation in the prototype: `intentFor()` and the `COMMS` map.

**Open question for owner (carry forward):** confirm final weights; whether to rename "Job pipeline engagement" (owner asked what it means — it = how far along their furthest job application is); whether a long blocker should subtract or be neutral.

---

## 8. The control inventory (hard requirement — no dead buttons)

The owner explicitly requires **every button/control functional and properly connected**. The spec MUST include a table listing every interactive control and its full chain. Build + verify each before shipping. Template:

| Tab | Control | Click does… | API endpoint | DB effect | Read-back / UI result |
|---|---|---|---|---|---|
| Candidates | Open RSO file | navigates to RSO GP file | (existing route) | — | RSO file opens for that GP |
| Candidates | Schedule call | opens schedule-call modal | `/api/admin/...calls...` (existing) | inserts `scheduled_calls` | call appears under Upcoming |
| Jobs | + Add job | opens create form → save | `POST /api/ats/jobs` | inserts `career_roles` (`source=internal_ats`) | new job in list |
| Jobs | drag card | move candidate stage | `PATCH /api/ats/application/:id/stage` | updates `gp_applications.ats_stage` (+ audit) | card moves, counts update |
| Jobs | Job settings | opens job settings | `GET/PATCH /api/ats/job?id=` | updates `career_roles` | settings saved |
| Practices | + Add practice | create practice | `POST /api/ats/practices` | inserts `practices` | new practice in directory |
| Practices | Edit | edit practice | `PATCH /api/ats/practice?id=` | updates `practices` | changes shown |
| All | filter dropdowns | filter list | (query param) | — | list filters |

…extend to cover **100%** of controls (every dropdown, link, drawer action, save). Per `CLAUDE.md` rule #8 (extrapolate end-to-end) and #2 (never fabricate results).

---

## 9. Build sequence (suggested) + workflow approach

Use **subagent / workflow-driven development** (one subagent per task — `CLAUDE.md` rule #7; ultracode = Workflow tool). Suggested order:

1. **DB foundation** — migrations: `practices` table + `career_roles.practice_id` + backfill; `gp_applications.ats_stage`; intent storage on `registration_cases`; native-job columns. Apply via `exec_sql` + service key. Add tests.
2. **Tab shell** — master-tab row + 4 panels in `ceo-dashboard.html`; wrap existing dashboard in Registration; new JS modules + cache busters. Verify nothing in the current dashboard breaks.
3. **Candidates tab** — list + profile (reuse existing data); then AI comms scan + AI Zoom capture pipelines; intent compute + storage.
4. **Jobs tab** — list + native create + pipeline board (drag → persist) + interview scheduling.
5. **Practices tab** — directory + create/edit + detail with linked jobs/candidates.
6. **Wire EVERY control** (§8) + the mock prototype buttons.
7. **Verify end-to-end** (`superpowers:verification-before-completion`), run `npm test` (vitest), `node --check server.js` before each push.
8. **Commit + push to the PREVIEW branch** (NOT main). Give the owner the preview URL/branch.

---

## 10. Conventions & gotchas (from CLAUDE.md + memory)

- **Commands:** `npm start` (node server.js, port 3000), `npm test` (vitest run), `npm run init:db`. Single test: `npx vitest run tests/x.test.js`.
- **Always `node --check server.js` before pushing.** Commit + push after every change.
- **Push (background sessions):** keychain unavailable; push via SSH deploy key `~/.ssh/gplink_deploy`. Push from the main loop, not a subagent. (memory `git-push-ssh-deploy-key`, `machine-environment-quirks`.) NOTE: **no Node/npm/gh/vercel CLI on this Mac by default** — a temp Node is at `/tmp/node-v20.18.1-darwin-arm64/bin/node`; python3 at `/usr/bin/python3`; Chrome (for screenshots) at `/Applications/Google Chrome.app/...`.
- **Deploy model:** production = `git push origin main` (Vercel auto-build). So a **preview branch is any non-main branch** pushed to origin. `admin.html` host is 302-gated (`admin.mygplink.com.au`). (memory `deploy-verification-admin-host`.)
- **Cache busters** on script tags `?v=YYYYMMDD[letter]`; JS served `no-cache`.
- **Supabase migrations** applied via `rpc/exec_sql` + service key (schema-qualify). Service key in `.env`, not `.env.prod`. (memory `supabase-migrations-exec-sql`, `prod-supabase-service-key-location`.)
- **Anthropic model** for any AI (comms scan, summaries): use `lib/anthropic-model.js` (centralised; Opus 4.6 with auto-upgrade; strips temperature on 4.7/4.8). Model IDs are hardcoded in ~10 `server.js` spots. (memory `anthropic-model-id-pinning`, `sppa-ai-model-and-completeness`.)
- **RSO roster** lives in the `rso_team` Supabase table (not the hardcoded `RSO_TEAM` array). (memory `rso-roster-live-source`.)
- **`country_code` must be lowercase** (`uk/ie/nz`). (memory `user-documents-country-code-casing`.)
- **Admins are not GPs** — `_ensureRegCase` returns null for admin/VA. (memory `admins-removed-as-gps`.)
- **CEO ↔ RSO duplication** — keep `ceo-dashboard.html` and `admin.html` per-GP logic in sync. (memory `dashboard-calls-parity`, `ceo-gpfile-task-parity`.)
- Restricted mode: `account_status='under_review'` limits GP access — relevant to the under-review candidates shown.

---

## 11. What's explicitly OUT of scope this round
- Doctors applying to jobs from their own app (user-facing direct apply).
- Practice self-signup / portal / logins.
- Actually turning Zoho off (this round only lays the foundation to own the data).

---

## 12. Quick reference — files
- Prototype (UI source of truth): `pages/ceo-dashboard-prototype.html` (branch `worktree-ats-prototype`).
- Existing CEO dashboard to wrap: `pages/ceo-dashboard.html`.
- Existing RSO dashboard (patterns to mirror/sync): `pages/admin.html`.
- Pipeline helpers: `lib/ceo-metrics.js`. Onboarding: `js/onboarding.js`. Anthropic: `lib/anthropic-model.js`.
- This handover: `docs/superpowers/specs/2026-06-27-ats-ceo-restructure-HANDOVER.md`.

**Next concrete action for the fresh session:** read the prototype, then write `docs/superpowers/specs/2026-06-27-ats-ceo-restructure-design.md` (formal spec incl. the §8 control inventory), get owner sign-off, then build on a preview branch.
