# App Completion Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and harden the GP Link app for production/App-Store readiness across User, Admin, and CEO roles: fix the dead user-facing screens, restore admin↔CEO parity, connect the in-app ATS pipeline to the GP-facing career flow end-to-end, and close the security/docs gaps found in the 2026-07-02 four-way audit.

**Architecture:** Monolithic vanilla JS/HTML app; single `server.js` (46k lines) routes everything; Supabase in prod, local JSON in dev; ATS lives in `lib/ats-practices.js` + `/api/ats/*` (CEO-gated) alongside the older Zoho-synced `/api/career/*` GP flow. This plan CONNECTS the two systems rather than adding a third.

**Tech stack:** Node (no framework), vitest, Supabase PostgREST via `supabaseDbRequest`, Zoho Recruit, Zoom, Google Calendar.

## Global constraints

- Baseline: 906 tests green at branch start (`worktree-app-completion-audit`, base d226711). Suite must stay green after every task.
- Never break existing functionality; `node --check server.js` before every commit.
- Cache busters on changed script tags: `?v=20260702a`.
- All user-visible copy in plain, friendly English matching existing pages (e.g. "We'll take it from here", sentence case, no jargon).
- HTML escaping: wrap all user data in `escapeHtml(...)` in innerHTML templates.
- Commit after each task with a descriptive message; commit only your task's files (`git add <paths>`).
- DDL: write migration SQL files but DO NOT apply to prod; server code must tolerate the column not existing yet (allowlist-strip pattern like `atsInsertApplicationRow` at server.js:24035, or retry-without-column on PostgREST error).
- Push target: preview branch `worktree-app-completion-audit` only. NEVER push main.
- New/changed endpoints follow the existing dispatch style inside `handleApi` (`if (pathname === '…' && req.method === '…')`), auth via `requireSession` / `requireAdminSession` / `requireCeoSession`, respond with `sendJson`.

## Audit findings driving this plan (2026-07-02)

Verified facts:
- `pages/interview-prep.html` (1086 lines) has ZERO fetch calls — fully static prototype with a hardcoded interview date (`:812`) and 3 dead buttons (`:817` Join Zoom, `:821` Add to Calendar, `:825` Mock Interview).
- `pages/offer-review.html` has 2 dead CTAs (`:744` Request Changes, `:748` Download Full Contract); only Accept Offer is wired.
- ATS-created jobs are `provider: 'internal_ats'` (server.js:45093) but the GP roles endpoint merges only `provider='manual'` rows with Zoho-live (server.js:26697/26711/26757, DB fallback ~26773) → in-app jobs invisible to GPs.
- `/api/career/apply` (server.js:26925) has no already-placed guard and unconditionally does Zoho candidate/application creation (breaks for internal_ats roles).
- Zoho status sync (`syncZohoRecruitApplicationStatuses`, server.js:17238) writes `gp_applications.status` but never `ats_stage` → CEO kanban drifts. Only automation: interview-book → 'interview' (server.js:45451).
- CEO GP-file Calls pane lacks admin's "Send meeting invite" (admin.html:10648) and "Fetch Summary" (admin.html:10733–10736); CEO Notes tab is read-only (ceo-dashboard.html:4985–4987); confirm dialogs say "Calendly" though it's Zoom (admin.html:10436,10466; ceo-dashboard.html:5724).
- `js/bypass-config.js:12`, `js/onboarding.js:246`, `pages/ahpra.html:16` ship a real user email (PII) to every client.
- `.gitignore` misses `.env.prod` / `.env.production`.
- Cron secret resolution re-inlined ~10× (server.js:24589,24749,24898,24924,25032,25047,25193,25252,38178,44945) instead of `isValidCronSecret` (server.js:100).
- Docs drift: CLAUDE.md says visa deferred (it's live, step 5, server.js:8440–8461) and 8-step onboarding (code = 5 steps, js/onboarding.js:4).
- No native iOS project (Capacitor configured, `npx cap add ios` never run) → no NSCameraUsageDescription; camera used at js/qualification-camera.js:181.

---

### Task 1: Security quick wins (gitignore, client PII, cron-secret consolidation)

**Files:** Modify `.gitignore`, `js/bypass-config.js`, `js/onboarding.js`, `pages/ahpra.html`, `server.js`. Test: extend an existing tests file or add `tests/bypass-config.test.js`.

- [ ] Add `.env.prod` and `.env.production` lines to `.gitignore` next to the other `.env*` entries.
- [ ] Remove the plaintext personal email from client-shipped files. First grep ALL consumers of `BYPASS_LOCK_EMAILS` in js/ and pages/ to learn how the list is read. Preferred design: keep `hello@mygplink.com.au` inline (company address, not PII), and replace the temporary personal-email entry with SHA-256 hex digests + expiry (`{ "<sha256-of-email>": "2026-09-30T23:59:59.000Z" }`); compare via `crypto.subtle.digest` of the current lowercase email (async is fine — the IIFE only sets localStorage flags; make the consumer functions await or callback). If any consumer needs a synchronous boolean, fall back to hashing at first load and caching the boolean in a module var before consumers run, or convert consumers to the async path. Behavior for the bypass user must be unchanged — verify by unit test of the hash-compare helper.
- [ ] server.js is NOT client-shipped: leave its bypass literals as-is.
- [ ] Consolidate the ~10 inline cron-secret checks onto the existing `isValidCronSecret` helper (server.js:100), first confirming identical env-var fallback semantics per site (each site may check `CRON_SECRET || ZOHO_RECRUIT_SYNC_CRON_SECRET`); do not change accepted secrets.
- [ ] `node --check server.js`; run full suite; commit.

### Task 2: CEO ↔ Admin parity (calls actions, add-note, Zoom copy)

**Files:** Modify `pages/ceo-dashboard.html`, `pages/admin.html` (copy only).

**Interfaces consumed:** `POST /api/admin/calls/schedule`, `POST /api/admin/calls/<id>/resend`, `PATCH /api/admin/calls/<id>`, `POST /api/admin/calls/<id>/fetch-summary`, `POST /api/admin/case/note` — all already exist and are super-admin accessible.

- [ ] Port admin's "+ Send meeting invite" button (admin.html:10648 and its handler) into CEO `renderGpCallsTab` (ceo-dashboard.html:5656/5609), reusing CEO's existing `ceoGpCall*` action-function style (ceo:5704–5747).
- [ ] Port admin's "Fetch Summary" button for completed-without-summary calls (admin.html:10733–10736 / `retryZoomSummary` 10475) into CEO `renderGpCallCard` (ceo:5528).
- [ ] Make CEO Notes tab writable: add-note textarea + button in `renderGpNotesTab` (ceo:4987) posting to the same endpoint admin uses (see admin.html:3364–3365 handler for exact endpoint + payload), then re-render the pane. Remove the stale "deferred to Phase 3b" comment (ceo:4985).
- [ ] Fix Calendly→Zoom wording in confirm dialogs: admin.html:10436, 10466 and ceo-dashboard.html:5724 (grep both files for "Calendly" and fix every instance that refers to the Zoom-invite flow; leave genuine Calendly-integration references in the RSO meeting-invite config untouched).
- [ ] Fix the stale "Phase 3" placeholder comments at ceo-dashboard.html:3243–3245.
- [ ] Run suite; commit.

### Task 3: Bring interview-prep + offer-review to life (user-facing)

**Files:** Modify `pages/interview-prep.html`, `pages/offer-review.html`, `server.js`. Test: `tests/career-interview-user.test.js` (new).

**Interfaces produced:** `GET /api/career/my-interviews` → `{ ok, interviews: [{ id, scheduled_at, duration_minutes, timezone, format, status, zoom_join_url, practice_name, job_title, interviewer_name }] }` (session-gated, current user only; merge `scheduled_calls` where `meeting_kind='interview' AND user_id=me` with `career_interviews` where `user_id=me`, upcoming first; never expose `zoom_host_url`).

- [ ] Add `GET /api/career/my-interviews` per the interface above (pattern-match `GET /api/career/applications` at server.js:27121 for session handling and shape).
- [ ] interview-prep.html: on load, fetch `/api/career/my-interviews`; render the next upcoming interview into the hero (replacing the hardcoded "Thursday 17 April · 2:00 PM AEST" at :812) with date formatted in the user's timezone; wire "Join Zoom" (:817) to `zoom_join_url` (hidden/disabled with explanatory copy if missing); wire "Add to Calendar" (:821) to a client-generated `.ics` download (Blob URL — title, start, duration, Zoom link in description); if there is no interview, show a friendly empty state ("No interview booked yet — we'll let you know as soon as one is scheduled") and hide the action tiles.
- [ ] Replace the dead "Mock Interview" tile (:825) with an in-page anchor link to the page's existing prep-questions section (keep the tile look).
- [ ] offer-review.html: wire "Download Full Contract" (:748) the same way `application-detail.html:645` resolves its offer/contract link (reuse that exact data source; hide the button with fallback copy if no contract attachment exists); wire "Request Changes" (:744) to navigate to Messages with a prefilled context (`/pages/messages` route via shell postMessage per convention `gp-shell-route`), matching how other pages deep-link to messages.
- [ ] Bump cache busters on any changed script tags; run suite; commit.

### Task 4: Internal ATS jobs visible + applyable by GPs; already-placed guard

**Files:** Modify `server.js`. Test: extend `tests/ats-endpoints.test.js` + career apply tests.

- [ ] In the three `/api/career/roles` merge sites (server.js:26697, 26711, 26757) and the DB-fallback path (~26773), also include `provider='internal_ats'` rows that are `is_active` AND `job_status='open'` (add a helper `listInternalAtsOpenRoles()` or widen `listCareerRoleRows` usage — keep 'manual' behavior identical).
- [ ] In `POST /api/career/apply` (server.js:26925): load the role row; when `provider === 'internal_ats'`, skip `ensureZohoRecruitCandidateIdForUser` + `createZohoRecruitApplication` (no Zoho side effects), still insert `gp_applications` (status 'applied', ats_stage default 'applied'), still create the VA follow-up task + notifications. Keep dedupe/rate-limit/CV gates identical.
- [ ] Already-placed guard: before inserting, if any of the user's `gp_applications` has a placement-secured status (reuse the exact regex/helper used at server.js:41382 / `isCareerPlacementSecuredStatus`), reject 409 `{ ok:false, code:'already_placed', message: "You already have a secured placement — contact your recruitment officer if anything needs to change." }`. Verify `career.html` apply handler surfaces server error messages (it does for 403 requiresCv; extend if needed).
- [ ] Tests: internal role appears in roles list; apply to internal role creates gp_applications without Zoho calls; placed user gets 409; unplaced user unaffected.
- [ ] `node --check server.js`; run suite; commit.

### Task 5: Pipeline automation — Zoho↔ats_stage reconciliation + GP stage notifications

**Files:** Modify `server.js`, `lib/ats-practices.js` (if a mapping helper is needed). Test: extend `tests/ats-endpoints.test.js` / `tests/ats-practices.test.js`.

**Interfaces consumed:** `deriveAtsStage(app, hasInterview)` (lib/ats-practices.js:65), `atsUpdateApplicationStageRow` (server.js:24057), `atsRecordStageEvent` (server.js:24073), `sendPushNotification`, GP email via the `sendGpNotificationEmail` pattern.

- [ ] Reconciliation: in `syncZohoRecruitApplicationStatuses` (server.js:17238), after a row's `status`/`practice_submission_status` changes, compute `deriveAtsStage(updatedApp, hasInterview)`; if it differs from stored `ats_stage` AND moves forward (or moves to `not_proceeding`), call `atsUpdateApplicationStageRow` with actor `'zoho_sync'`. Never move a manually-set stage backwards.
- [ ] Central stage-change notifier: one helper `notifyGpOfAtsStageChange(app, fromStage, toStage)` — for `interview`, `offer`, `hired`, `not_proceeding` only, send push + branded email to the GP with plain-English copy per stage (match the tone of the existing application-submitted notification at server.js:27097–27105); fire-and-forget with `.catch` logging. Call it from BOTH the manual `PATCH /api/ats/application` (server.js:45162) and the reconciliation path. `not_proceeding` copy must be kind ("This one didn't work out — we're already looking at other options for you").
- [ ] Offer acceptance: find the Accept Offer endpoint used by offer-review.html's `#acceptOfferBtn`; on acceptance advance that application's `ats_stage` to `hired` via the same helpers (actor `'gp_accept_offer'`).
- [ ] Tests: sync advances stage + writes event + never regresses manual stage; notifier fires only on the four stages; accept-offer advances stage.
- [ ] Run suite; commit.

### Task 6: Practice linkage + CEO live hiring funnel

**Files:** Create `supabase/migrations/20260702090000_gp_applications_practice_id.sql` (NOT applied). Modify `server.js`, `pages/ceo-dashboard.html`. Test: extend ATS tests.

- [ ] Migration file: `ALTER TABLE public.gp_applications ADD COLUMN IF NOT EXISTS practice_id uuid REFERENCES public.practices(id);` + index on practice_id. Comment at top: "Apply via exec_sql per docs — code is tolerant of the column being absent."
- [ ] On apply (both Zoho and internal paths): resolve practice — `career_roles.practice_id` if set, else look up `practices` by lower(name)=lower(career_roles.practice_name) (reuse the existing ensure/lookup helper in lib/ats-practices.js or server ats helpers if present; create-if-missing with `source:'backfill'`). Write `practice_id` on the gp_applications insert using the tolerate-missing-column pattern (attempt with column; on PostgREST unknown-column error retry without and log once).
- [ ] CEO Overview live hiring funnel: extend `GET /api/ceo/pipeline-summary` (server.js:45662) response with `ats: { applied, submitted, reviewing, interview, offer, hired, not_proceeding }` counts from `gp_applications.ats_stage`, and render a compact "Hiring pipeline" strip in `renderPipelineSection` (ceo-dashboard.html:1719) under the existing registration funnel, using existing funnel styles and `ATS_STAGE_LABELS` wording.
- [ ] Tests: apply writes practice_id when resolvable; summary endpoint returns ats counts; missing-column path doesn't 500.
- [ ] Run suite; commit.

### Task 7: Docs truth-up + iOS App Store checklist

**Files:** Modify `CLAUDE.md`, `docs/deferred-visa-application.md` (verify), `js/onboarding.js` (comment only if any). Create `docs/ios-app-store-checklist.md`.

- [ ] CLAUDE.md: registration flow line → include Visa as live step 5 (Secure Placement → MyIntealth → AMC → AHPRA → Visa → PBS & Medicare → Commencement); onboarding described as 5-step (matches TOTAL_STEPS=5).
- [ ] `docs/ios-app-store-checklist.md`: concrete pre-submission checklist — run `npx cap add ios`; Info.plist keys with exact suggested strings (`NSCameraUsageDescription` — "GP Link uses your camera to scan your qualification and identity documents.", `NSPhotoLibraryUsageDescription`, push-notification entitlement + `aps-environment`); confirm account-deletion (done — account.html), privacy policy (done — pages/privacy.html), terms (done), Sign in with Apple (done); App Store Connect metadata/screenshots; `AUTH_DISABLED` must be unset in prod env; TestFlight smoke items (camera scan, push permission, deep links via `js/native-bridge.js` appUrlOpen).
- [ ] Commit.

### Task 8: Final verification + ship preview

- [ ] Full suite green; `node --check server.js`.
- [ ] Push `worktree-app-completion-audit` to origin; open DRAFT PR to main titled for preview review; PR body = plain-English summary + full gap analysis (built vs deferred).

## Gap analysis (P4) — running list

**Built by this plan:** dead user buttons (T3), GP visibility of in-app jobs + apply (T4), already-placed apply guard (T4), pipeline stage reconciliation + audit events consumption (T5), GP notifications on hiring-stage changes (T5), offer-accept automation (T5), GP→practice first-class link (T6), CEO live hiring funnel (T6), CEO parity: send-invite/fetch-summary/add-note (T2), Zoom copy consistency (T2), client PII removal (T1), .gitignore + cron-secret hygiene (T1), iOS submission checklist + docs truth-up (T7).

**Identified, deliberately deferred (documented for follow-up):**
- Native iOS project generation + real device/push testing (needs Xcode; checklist provided).
- CEO GP-file Emails sub-tab (admin's `createHubEmailView` port) — view-only ops composers on CEO remain redirects by design.
- Persistent `placements` table (placement still derived from Zoho per request; needs product decision on backfill).
- Stage-machine transition guardrails (kanban stays any→any like Zoho; events now audited + consumed).
- `career_interviews` vs `scheduled_calls` consolidation (new code reads both; merge is a data migration).
- Medical Centres tab unification with the ATS `practices` table.
- `handleApi` decomposition (21k-line function) + 125 swallowed catches — post-launch refactor.
- Legacy `#inboxPanel` removal in admin.html.
