# Zoho Decommission + Masked Practice Pipeline — Design

**Date:** 2026-07-05
**Branch:** `worktree-zoho-decommission-masked-pipeline` (based on `origin/main` @ `ecfb5e7` — the live production code; the local `main` checkout was stale/behind and must not be used as the base)
**Status:** Design approved in brainstorming; awaiting spec review before plan.

---

## Plain-English summary

Three things the owner asked for grew into a program of work once we traced them end-to-end:

1. **Mask the practice name that GPs see.** The public jobs board still shows real practice names in the job *title* ("Werribee Medical & Dental Centre"). Replace with `DPA - Suburb (City) - Billing`, add a blurred "name locked" box, and stop the real name reaching the browser until a GP is accepted.
2. **Let the owner enter practice + job details from the admin side** — the same fields a practice fills on the intake form — instead of only receiving them via the emailed form.
3. **Give every practice a contract slot** — view the e-signed PDF, or upload one manually.

Investigating those surfaced two more must-dos:

4. **DPA is wrong on the live site.** The database says 47/49 jobs are Non-DPA and the public board shows "Non-DPA · near Werribee", even though the owner considers them DPA and the real Zoho `DPA` field says "Yes". Cause: the Zoho sync mis-maps DPA and overwrites it on every run, so a one-time fix never sticks. DPA must become owner-controlled.
5. **Fully disconnect Zoho** (Recruit **and** Sign) while retaining all its data. Zoho is currently the source of jobs/clients, and Zoho Sign powers SPPA e-signing. Everything Zoho holds must be captured and moved into owned data before Zoho is removed.

Delivered as six sequenced phases: capture Zoho data → populate owned data → GP-facing masking/UX → admin manual entry → move SPPA e-sign in-app → remove Zoho. Each phase is committed, pushed and verified before the next. Zoho is only removed once everything replacing it is proven.

---

## Verified facts this design rests on (checked against live prod on 2026-07-05)

- **The masking feature is merged and live** on `origin/main` (`ecfb5e7`). The local `main` checkout on this machine is behind and lacks it — do not base work on it.
- **`practice_name` is correctly hidden** on `/api/public/jobs` (returns `null`), **but the job `title` still leaks the real name.** Masking uses `career_roles.masked_title`, which is empty on all 49 live jobs, so the mappers fall back to the raw `title` (= real name).
- **All 49 live jobs have `location_city` populated** (Erina, Frankston, Werribee, Karratha…), so every job can be masked properly. 39/49 have `billing_model`.
- **The full raw Zoho record is already retained per job** in `career_roles.source_payload.zoho` — 70 fields including `Client_Name` (id + name), the real `DPA` (Yes/No), `Billing_Type`, `City`, `State`, `Location`, `Zip_Code`, `Practice_Website`, `Contact_Name`, `Short_Intro`, benefits, `Number_of_Positions`, `No_of_Candidates_Hired`, etc.
- **Live DPA is wrong:** DB `career_roles.dpa` = false for 47/49, but sampled `source_payload.zoho.DPA` = "Yes". The sync overwrites `dpa` each run.
- **Practices table is nearly empty:** 1 row total. The Zoho "clients" behind the 49 jobs are not yet materialized as practice rows. `practices.zoho_client_id` exists for linking.
- **No `metadata` column on `career_roles`** (it exists on `practices`). Do not write role metadata to a non-existent column.
- **Zoho creds present in env:** `ZOHO_RECRUIT_*` (OAuth) and `ZOHO_SIGN_*` (incl. `ZOHO_SIGN_SPPA_TEMPLATE_ID`). A live pull is possible using the app's existing stored token.
- **Agreement has a non-circumvention / introduction-fee clause** (owner-confirmed), so showing the intro video to logged-in GPs is commercially safe.

---

## Locked design decisions

### Naming rule (Phase 2)
- Format: **`DPA - Suburb (City) - Billing`** — e.g. `DPA - Werribee (Melbourne) - Bulk Billing`.
  - Legacy/one-location jobs (only a town, no separate nearest city): `DPA - Werribee - Bulk Billing` (no parens).
  - Non-DPA jobs: `Non-DPA - …` prefix.
  - Missing billing: drop the billing part (`DPA - Cobblebank`).
  - No location at all: safe generic `GP Opportunity near <state>` — **never** the real title.
- Applied identically on the public website, the in-app GP jobs list, and the single-job view.
- A role with no masked name **never** falls back to its raw `title` for any non-revealed view.
- **Backfill `masked_title` for all existing jobs** so the leak closes immediately (Phase 1/2).

### Blurred "name locked" box (Phase 2)
- Sits under the masked title where the real name would be.
- **Website (anonymous):** "Practice name — visible to members only."
- **App (logged-in GP, pre-acceptance):** "Practice name revealed once your application is accepted."
- The real name is **never sent to the browser** for a non-revealed role — the blur is a placeholder graphic, not CSS over the real text. Reveal is server-controlled by the existing `canRevealPracticeIdentity` gate (admin_applied || revealed || accepted offer).

### Intro video — two-tier reveal (Phase 2)
- **Anonymous public website:** masked card only, no video, "sign in to learn more."
- **Logged-in GP (before applying):** intro video + richer role info shown — the confidence/anti-spam win. Safe because the agreement carries a non-circumvention clause.
- **After acceptance:** full identity (name, address, everything).
- **Admin approval step** (already requires a suburb header photo) also gates the video: nothing goes live with a video the owner hasn't reviewed.
- Intro video/text must be gated so they never appear on the anonymous public card (they can name the practice).

### DPA ownership (Phase 1 + 2)
- DPA becomes an **owner-controlled** field (admin toggle in the practice/job editor).
- Backfill each job's `dpa` from the true `source_payload.zoho.DPA` value.
- Once Zoho Recruit sync is removed (Phase 5), nothing overwrites DPA again. Until then (Phases 1–4 still have the sync running), the sync must be changed to **preserve** an owner-set DPA rather than overwrite it.

### Manual entry parity (Phase 3)
- Admin editor exposes the **same fields the intake form collects** (`INTAKE_FIELDS`): billing_style, dpa, mmm, visa_sponsorship, ownership, years_operating, nursing_on_site, gp_count, percentage_split, incentives, earnings_text, suburb, nearest_city, state, address, general_location, role_title, role_summary, intro_text, intro_video_url — plus existing contact fields.
- Saving runs the **same server logic** as a real intake submission (reuse `validatePracticeIntakePayload` + `createPendingJobFromIntake`, do not duplicate): creates/updates the masked job in `approval_status='pending'` → upload suburb photo → approve → live & masked.
- **Idempotent:** re-saving updates the existing job, never creates a duplicate.

### Contract slot (Phase 3)
- Every practice always shows a **Contract card**.
- If e-signed via the flow → "View signed PDF" (existing behavior).
- Always → "Upload signed contract (PDF)": stored under a **separate** key (e.g. `practices/<id>/agreement-uploaded.pdf`) so it never overwrites a genuine e-signed original; sets `agreement_status='signed'`, stamps `agreement_signed_at`/`agreement_signed_by='Uploaded by admin'`.
- Before anything on file → "No contract yet — Upload signed PDF".

### Side-door leak fixes (Phase 2)
- Public/GP job **search** matches only masked fields (suburb, city, billing, DPA) — never the real name or raw title.
- Exact **street address** and any `location_label` carrying a street/name are never sent to the browser pre-reveal (suburb + city + state only).

### Zoho scope (Phases 0, 4, 5)
- Remove **Zoho Recruit** (jobs/clients/candidates sync, OAuth, crons, API) **and Zoho Sign** (SPPA e-signature).
- **SPPA e-signing must move in-app first** (Phase 4) using the same pdf-lib signing the practice agreement uses, before Zoho Sign is removed.

### Candidate export (Phase 0)
- Pull candidates but store **only name, email, phone**.
- **Exclude any candidate marked hired** in Zoho Recruit.
- Store as a re-engagement **email list** for a future "sign up for the app" campaign. Include an unsubscribe mechanism when that campaign is built.

---

## Phased architecture

### Phase 0 — Capture & retain (Zoho still connected; nothing removed)
- Reuse the app's existing Zoho Recruit OAuth token to pull **all Job Openings** and **all Clients/Accounts** (full detail), and **candidates** (name/email/phone, excluding hired).
- Persist to an owned archive: a snapshot table (e.g. `zoho_archive` with `entity_type`, `zoho_id`, `payload jsonb`, `pulled_at`) **and** a committed/exported JSON file for belt-and-braces.
- Build the candidate re-engagement list (e.g. `marketing_leads` / `candidate_email_list`: name, email, phone, source='zoho_recruit', hired=excluded).
- Output: everything Zoho holds is retained locally. Fully reversible.

### Phase 1 — Populate owned data from the archive
- Create a `practices` row per Zoho client; link jobs via `practice_id` / `zoho_client_id`.
- Backfill `career_roles` fields from `source_payload.zoho`: `dpa` (from real `DPA`), `billing_model`, `suburb`/`nearest_city` (from `City`/`Location`/`Zip_Code`), contacts, benefits, positions, intro text.
- Build `masked_title` for every job.
- Output: app runs entirely on owned data; DPA correct; titles masked.

### Phase 2 — GP-facing masking/UX
- New `buildMaskedTitle` format + no-fallback-to-real-title in `mapCareerRoleRowToPublicJob`, `mapCareerRoleRowToClient`, single-role view.
- Blurred name box (web + app copy variants).
- Two-tier intro video reveal + admin video review at approval.
- DPA admin toggle; sync preserves owner-set DPA.
- Search + address leak fixes.
- Update automated tests for the new title format; add cache-buster bumps on changed JS.

### Phase 3 — Admin manual entry + contract slot
- Expand `js/ceo-ats-practices.js` editor to the full parity field set; server reuse of intake validation + job creation; suburb-photo upload + approve in-admin; idempotent update.
- Contract card with manual upload endpoint.

### Phase 4 — Move SPPA e-sign in-app (off Zoho Sign) ⚠️ own mini-design
- Requires a dedicated investigation of the current SPPA Zoho Sign flow (templates, callbacks, completeness checks) before design. Replace with in-app pdf-lib signing modeled on the practice-agreement signing. Highest risk; compliance-sensitive.

### Phase 5 — Remove Zoho entirely
- Remove all Zoho Recruit + Zoho Sign code, crons, OAuth endpoints, env usage, and UI. Keep the Phase 0 archive. Verify nothing references Zoho at runtime.

---

## Non-negotiables / risks
- **Never** show the real practice name (title, search, intro, address) to a non-accepted GP. Fail closed.
- Capture Zoho data **before** removing anything; verify counts match before disconnect.
- Phase 4 (SPPA e-sign) touches a live compliance flow — gets its own design pass and careful verification; do not fold it into Phase 5.
- DPA is a real regulatory eligibility fact — backfill from the true Zoho `DPA` field, not assumptions.
- Every phase: commit, push, run the test suite, verify against live/real behavior before proceeding.

## Out of scope (for now)
- The actual "sign up for the app" email campaign send (only the list is built here).
- Facebook Lead Ads webhook wiring (owner-side Vercel config, tracked separately).
