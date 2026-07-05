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
5. **Fully disconnect Zoho** (Recruit **and** Sign) while retaining all its data. Zoho Recruit is the current source of jobs/clients. **Zoho Sign is NOT actually used** — it was scaffolded but is dead code (see verified facts); SPPA e-signing already runs on emailed-PDF signing coordinated by admin tasks + AI signature checks. So removing Zoho Sign is just deleting unused code/env, not migrating a live flow.

Delivered as **five** sequenced phases: capture Zoho data → populate owned data → GP-facing masking/UX → admin manual entry → remove Zoho (Recruit sync/API + the dead Zoho Sign scaffolding). Each phase is committed, pushed and verified before the next. Zoho Recruit is only removed once everything replacing it is proven. (An earlier draft had a sixth phase to "move SPPA e-sign in-app" — dropped, because SPPA never used Zoho Sign, so there is nothing to migrate.)

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
- **Zoho Sign is dead code for SPPA** (traced on `origin/main`). The live SPPA-00 is signed by emailing the PDF (`sendGmailEmail` with an `SPPA-00.pdf` attachment, "reply with the signed document attached", server.js ~42231/42385); the PDF comes from `task_documents.attachment_url`; state is tracked in `taskMeta.sppa_state` + `practice_doc_ops`. The Zoho Sign envelope helpers (`createEnvelopeFromTemplate` @ ~15911, and siblings) have **zero callers**; nothing ever writes `zoho_sign_envelope_id` (only read @ ~41330/41339) or inserts a `zoho_sign_envelopes` row; the OAuth connect/callback/webhook/token-refresh cron are reachable but a dead end for SPPA. Task table is `registration_tasks` (queried by `related_document_key=eq.sppa_00`). **Nothing to migrate — removal is deletion.**

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

### Organisation model — practices vs corporations, and where details live (owner directive 2026-07-06)
- A client entity is either a **practice** or a **corporation** (`practices.org_type`, default 'practice'). Corporations (e.g. ForHealth Group, GP West Group) own many job locations. Manual "Add practice" offers the choice; existing entities are toggleable. Seed ForHealth Group + GP West Group as corporations in the Phase 1 migration.
- **Slim practice/corporation record.** The entity detail page (both CEO + RSO/admin dashboards) holds ONLY: primary contact, email, phone, Stage, Agreement (e-signed PDF or manually uploaded contract). It is the relationship+contract level.
- **All operational detail lives on the JOB** (career_roles): billing type, DPA, suburb/nearest city, address, earnings, % split, MMM, visa, GP count, intro text/video, and every intake-form answer. Each job = one location's facts. New columns/`details` jsonb on career_roles as needed.
- **Intake flow split:** the practice-intake form is unchanged for the practice, but on submit/sign the contact + agreement land on the practice row; every other answer lands on the created job.
- Reveal gating is unchanged: job-level masked facts (suburb, billing, DPA) are public; practice identity + exact address stay locked until acceptance.

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

### Zoho scope (Phases 0, 5)
- Remove **Zoho Recruit** (jobs/clients/candidates sync, OAuth, crons, API) **and Zoho Sign** (dead scaffolding).
- **No SPPA migration needed** — SPPA signing already runs on emailed-PDF signing (not Zoho Sign), so Zoho Sign removal is straightforward dead-code deletion in Phase 5. Verify (grep + tests) that nothing reachable breaks; keep the emailed-PDF SPPA flow untouched.

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

### Phase 1 — Populate owned data from the archive (+ close the title leak)
- Migration: `practices.org_type` ('practice'|'corporation'); `career_roles.address` + `career_roles.details` jsonb (job-level home for intake answers/benefits/etc.).
- Create a `practices` row per Zoho client (slim: contact/stage/agreement + identity); seed ForHealth Group + GP West Group as `corporation`; link jobs via `career_roles.practice_id` ↔ `practices.zoho_client_id` (from each job's `Client_Name.id`).
- Backfill `career_roles` from `source_payload.zoho` at JOB level: `dpa` (real `DPA` field), `billing_model`, `suburb` (`City`), `address` (`Location`+`Zip_Code`), `details` (benefits, GP count, intro, website, etc.).
- Implement the NEW masked-name format `DPA - Suburb (City) - Billing` (legacy town-only variant without parens) in `buildMaskedTitle` and **backfill `masked_title` for all jobs** — this closes the live real-name leak immediately (pulled forward from Phase 2).
- Output: app runs entirely on owned data; DPA correct; titles masked; org model in place.

### Phase 2 — GP-facing masking/UX
- No-fallback-to-real-title in `mapCareerRoleRowToPublicJob`, `mapCareerRoleRowToClient`, single-role view (masked format itself ships in Phase 1).
- Blurred name box (web + app copy variants).
- Two-tier intro video reveal + admin video review at approval.
- Sync preserves owner-set DPA (until the sync is removed in Phase 5).
- Search + address leak fixes.
- Update automated tests for the new title format; add cache-buster bumps on changed JS.

### Phase 3 — Admin org UI, manual entry + contract slot
- Slim practice/corporation detail view (contact/email/phone/Stage/Agreement only) on BOTH dashboards; Practice/Corporation type on Add + Edit; corporation badge on cards.
- Job-level detail editor: the full intake-parity field set (billing, DPA toggle, suburb, address, earnings, split, intro…) lives on the JOB under the practice; server reuse of intake validation + job creation; suburb-photo upload + approve in-admin; idempotent update.
- Intake submit/sign routes practice-level fields (contact, agreement) to the practice row and everything else to the created job.
- Contract card with manual upload endpoint (practice/corporation level).

### Phase 5 — Remove Zoho entirely (Recruit + the dead Sign scaffolding)
- Remove all Zoho Recruit code (sync, OAuth, crons, API, admin UI) **and** the unused Zoho Sign scaffolding (`lib/zoho-sign.js`, OAuth connect/callback, token-refresh cron, webhook receiver, envelope helpers, `zoho_sign_envelopes` handling, `ZOHO_*` env usage, admin "connect Zoho Sign" UI).
- **Do NOT touch the emailed-PDF SPPA flow** (`registration_tasks` + `task_documents` + `sendGmailEmail`) — it is the real signing mechanism and is independent of Zoho.
- Keep the Phase 0 archive. Verify (grep for `zoho`/`Zoho` + full test suite) that nothing reachable references Zoho at runtime.
- (There is no separate SPPA-migration phase: SPPA never used Zoho Sign, so nothing needs replacing.)

---

## Non-negotiables / risks
- **Never** show the real practice name (title, search, intro, address) to a non-accepted GP. Fail closed.
- Capture Zoho data **before** removing anything; verify counts match before disconnect.
- The emailed-PDF SPPA flow is the real signing mechanism and must be left untouched when Zoho Sign is deleted; confirm no reachable SPPA code path depends on `lib/zoho-sign.js`.
- DPA is a real regulatory eligibility fact — backfill from the true Zoho `DPA` field, not assumptions.
- Every phase: commit, push, run the test suite, verify against live/real behavior before proceeding.

## Out of scope (for now)
- The actual "sign up for the app" email campaign send (only the list is built here).
- Facebook Lead Ads webhook wiring (owner-side Vercel config, tracked separately).
