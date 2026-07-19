# Full-App User-POV Audit — Remediation Plan (2026-07-20)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every confirmed user-facing breakage found by the 2026-07-20 three-persona audit (doctor, practice, CEO) with small, safe changes.

**Architecture:** Monolithic `server.js` + plain HTML pages with inline JS. Fixes are surgical edits at audited file:line sites; server-side fixes get vitest coverage (existing harness boots real server instances); client-side fixes are re-verified by live headless-Chrome click-through after the batch.

**Tech Stack:** Node (temp binary `/tmp/node-v20.18.1-darwin-arm64/bin/node`), vitest, puppeteer-core driver in `$CLAUDE_JOB_DIR/tmp/driver`.

## Global Constraints

- Small and safe: never restructure; fix at the cited site; do not break working behavior.
- Every server behavior fix adds/updates a vitest test where the harness reaches it. Run the touched test file(s) before commit: `PATH="/tmp/node-v20.18.1-darwin-arm64/bin:$PATH" npx vitest run tests/<file>`.
- JS files under `js/` are cached 1h: bumping content requires bumping `?v=` busters on every referencing page AND the pinned busters in `tests/` (grep the exact old buster).
- Commit per task from the worktree; DO NOT push (main loop pushes at the end). Never `git add -A`; add exact files.
- Local dev server for verification: `PORT=3100 AUTH_DISABLED=false node server.js` (local JSON DB — worktree has no .env; NEVER add one).
- All file:line cites refer to worktree @ a7a5087.

---

### Task 1 [P0-dev, do first — unblocks live verification]: local-mode auth crash + local onboarding saves discarded

**Files:** Modify `server.js`; Test `tests/` (new file `tests/local-auth-dev.test.js` only if no existing local-mode auth test fits).

Defect A: inside `handleApi`, near the scheduled-calls handler (~server.js:33266) a `const now = new Date()` shadows the module-global function `now()` (defined server.js:7116). Later calls `now()` at ~33409 (`/api/auth/send-code`), ~34410 (`/api/auth/verify-code`), ~44037/44054 (`/api/auth/reset-password`) throw `TypeError: now is not a function` → 500. Fix: rename the shadowing const (e.g. `nowDate`) and its usages in that block only.

Defect B: local-DB branches of `POST /api/onboarding/save` (~server.js:42045-42060) and `/api/onboarding/complete` (~42152-42165) do `const dbState = loadDbState()` then mutate that fresh copy — but `saveDbState()` (server.js:7231) serializes the module-global `dbState`, so writes vanish. Fix: drop the shadowing `loadDbState()` copies; mutate the module-global `dbState` like `PUT /api/state` does.

- [ ] Failing test: local-mode `POST /api/auth/send-code` returns 200 and logs an OTP; local `POST /api/onboarding/save` followed by `GET /api/state` returns the saved blob.
- [ ] Fix both defects; run test file; commit `fix(dev): unshadow now() in handleApi + persist local onboarding saves`.

### Task 2 [P0]: failed re-scan deletes previously stored document (data loss)

**Files:** Modify `pages/my-documents.html` (no server change).

Defect: replace-upload on an already-stored slot runs the scan first; ALL THREE failure paths — `handleCertFailure` (:2564-2565), `showScanTechnicalError` (:2574-2575), `handlePreparedDocClassificationFailure` (:2761-2762) — do `delete state.docs[key]; deletePreparedDocumentFile(country, key)`, destroying the OLD stored server file (new one was never uploaded).

Fix: before starting a replace-scan, snapshot `const prior = state.docs[key]`. In each failure path: if `prior` existed, restore `state.docs[key] = prior`, do NOT call `deletePreparedDocumentFile`, and re-render so the slot still shows the stored doc (failure message still shown). Only when there was no prior stored file keep today's delete behavior.

- [ ] Implement; manually verify logic by reading all three paths end-to-end; add a code comment stating the invariant ("a failed re-scan must never remove the previously stored file").
- [ ] Commit `fix(docs): failed re-scan no longer deletes the previously stored document`.

### Task 3 [P0]: position-filled fan-out leaks real practice name

**Files:** Modify `server.js` (~28631 `sendRedirectEmail` fallback chain; ~37269-37276 `mmPositionFilled`); Test `tests/` (extend the file covering `/api/career/matches` or redirect emails; else new `tests/position-filled-masking.test.js`).

Defect: `redirectOthersForJob` targets statuses including never-revealed self-applies; `mmPositionFilled` sets `practiceName: job.practice_name || r.practice_name || ''` raw, and the redirect email fallback chain includes `jobRow.practice_name`. Masked alternates already exist (`_redirectAltPracticeName` :28436-28444) and reveal gate is `canRevealPracticeIdentityCore` (used :36177/:36614/:38217/:38028).

Fix: in both sites, only use the real practice name when the application is revealed (same check the other surfaces use); otherwise use the masked display name used elsewhere (or generic "The practice"). Keep payload shape identical.

- [ ] Failing test: unrevealed application + position filled → `/api/career/matches` payload and redirect-email body contain no real practice name; revealed application still sees it.
- [ ] Fix; run test file; commit `fix(career): mask practice name in position-filled card + email for unrevealed applicants`.

### Task 4 [P1]: signin supabase-js SRI pin (prod OAuth dead)

**Files:** Modify `pages/signin.html:928`.

Defect: `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" integrity="sha384-...">` — floating version + fixed hash → browser blocks the script whenever jsdelivr serves a newer v2 (reproduced ×10 locally). Kills Apple/Google sign-in + supabase-session-login.

Fix: pin an exact version and its matching hash: `curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.x.y/dist/umd/supabase.js | openssl dgst -sha384 -binary | openssl base64 -A` (pick the latest 2.x.y jsdelivr resolves today; verify the page's usage still works — it only needs `createClient`). Update src to the exact-versioned URL + new integrity.

- [ ] Pin + verify hash matches downloaded bytes; commit `fix(auth): pin supabase-js to exact version so SRI hash cannot rot`.

### Task 5 [P1]: CEO Overview placement buckets blind to ATS writes (F1)

**Files:** Modify `lib/ceo-metrics.js` (:33-35, 494-508), `server.js` (dashboard :56651/:56854, drilldown :57080-57087); Test: extend existing ceo-metrics/dashboard test file.

Defect: Offers/Interviewing/Secured tiles bucket on legacy `gp_applications.status` + `career_interviews` only; modern flows write `ats_stage` (offer :59318-59342, interview :61501 + `scheduled_calls` :59575-59586, hired :59050/:36442) without those statuses. Offers tile ≈ structurally 0 while the ATS funnel strip (:56894, counts `ats_stage`) shows the offer.

Fix: bucket an application as offer/interview/secured when EITHER legacy status matches OR `ats_stage` ∈ {offer}/{interview}/{hired} (union; follow the caps counter pattern :28941-28962 which already unions `scheduled_calls`+`career_interviews` for interviews). Apply the same predicate to tile counts AND their drilldowns so they stay equal.

- [ ] Failing test: app with `ats_stage='offer'`, legacy status untouched → Offers tile counts 1 and drilldown lists it; same for interview via scheduled_calls booking and hired via board drag.
- [ ] Fix; run ceo test files; commit `fix(ceo): count ats_stage offers/interviews/hires in Overview placement tiles + drilldowns`.

### Task 6 [P1]: CEO one-line consistency batch (F3, F4, F5, F10, F13)

**Files:** Modify `server.js` (:60253, :60376, :60281, :56190, :56253, :57020, :57108), `lib/ats-practices.js:74`; Test: extend existing files covering these endpoints.

- F3: `/api/ceo/candidates` (:60253) + `/api/ceo/pipeline-summary` (:60376) add `status=neq.withdrawn` (and local-mode equivalent filter).
- F4: add `created_at` to the select at :60281 so `hasFreshApply`'s fallback (lib/ats-practices.js:174) works.
- F5: pass `nowMs: Date.now()` at :56190 and :56253 (`filterActiveCases` currently gets NaN → staleness cut disabled).
- F10: pass the request's `allTime` flag into activity drilldown (:57020) and placed drilldown (:57108) instead of hardcoded false.
- F13: `lib/ats-practices.js:74` add `secured`, `placed` to the 'hired' mapping.

- [ ] One failing test per sub-fix (skip only where no harness reaches it — say so in the commit body); fix; run; commit `fix(ceo): candidates/waitlist filters, staleness cut, drilldown windows, hired mapping`.

### Task 7 [P1]: archived GPs inflate CEO counts (F2) + withdrawn interview ghosts (F9) + placements list fallback (F12) + funnel agreement dual-source (F14)

**Files:** Modify `server.js`; Test: extend existing.

- F2: in `/api/ceo/dashboard` (:56647), `/api/ceo/candidates` (:60253), `/api/ceo/pipeline-summary` (:60376): exclude cases whose `user_profiles.account_status='archived'` (fetch archived user_ids once per request; both DB modes). Do NOT build a new archived UI (out of scope — noted outstanding).
- F9: GP withdraw path (~:38888) also cancels matching `scheduled_calls` rows (`meeting_kind='interview'`, same application/GP, status booked/invited → cancelled).
- F12: `/api/ats/placements` derive-fallback (:59538-59547) matches only `status=eq.placement_secured`; broaden to the same secured set as the tile (SECURED_STATUS_KEYS ∪ ats_stage='hired').
- F14: conversion-funnel (:57232 block) reads `agreement_status` column only; also treat `metadata.pipeline_agreement.status==='signed'` as signed (same dual-read as :34930/:59953/:60182).

- [ ] Failing tests (archived GP excluded from dashboard counts; withdraw cancels scheduled call; hired-status app appears in placements fallback; metadata-signed practice counts in funnel); fix; run; commit `fix(ceo): archived exclusion, withdraw cancels interviews, placements+funnel dual-source reads`.

### Task 8 [P1]: practice interview timezone guessed from name (tz correctness)

**Files:** Modify `server.js` (`atsGetApplicationContext` :30082 → return `location_state`/city from the practice/role row; call sites :61343, :61523, :31896, :31935), `lib/interview-meetings.js:19-27`; Test: extend interview-scheduler/meetings test.

Fix: `practiceTzForLocation(state || city || name)` — prefer the stored `location_state` (e.g. 'WA' → Australia/Perth), fall back to existing name sniffing. Add state-code map to `practiceTzForLocation` if missing.

- [ ] Failing test: context with `location_state='WA'`, name with no city hint → Perth tz in config + email label; fix; run; commit `fix(interviews): derive practice timezone from stored state, not the practice name`.

### Task 9 [P1]: career page mobile clip at 375px

**Files:** Modify `pages/career.html` (layout CSS around `.shell` / `HEADER.at-mast` / `.at-filters`).

Defect (measured live): `.shell` lays out at 425px in a 375px viewport under an overflow-hidden ancestor → ~50px clipped (tabs badge, filters, hero text). Fix: find the fixed width/min-width causing 425px (grep `425` / fixed px widths / grid min sizes in career.html CSS) and make the container fluid (`max-width:100%`, `minmax(0,…)`, `flex-wrap` on `.at-filters`) under a ≤430px media query. Smallest change that removes the overflow; verify with the driver at 375×812 (`document.documentElement.scrollWidth<=375` inside the frame AND `.at-mast` scrollWidth<=clientWidth) and screenshot desktop 1280 to confirm no regression.

- [ ] Fix + both viewport verifications; commit `fix(career): remove 50px mobile clip at 375px`.

### Task 10 [P1/P2]: doctor-side batch — Recent Updates escaping, demo placement bleed, decline toast, alerts upsert

**Files:** Modify `pages/index.html` (:1430-1438, :1454-1462), `pages/career.html` (:11199-11201, :12163-12177), `server.js` (:38989-38999); Test: server-side for alerts upsert.

- index.html: interpolate `${title}`/`${detail}` through the existing `esc()` (used :2189-2216) — match the bell panel.
- career.html placement: when `hasServerPlacement`, fall back to `""` (not FB demo values) for `startDateIso` and `location` (renderer already prints "Start date to be confirmed"); keep the existing contact/contract guards (:11233-11239).
- career.html `submitMatchDecline` (:12163): mirror `submitMatchAccept`'s `!res.ok` handling; server: check the decline PATCH result (:37597-37600) before `{ok:true}`.
- server alerts (:38989): use `upsertSupabaseUserState` instead of blind PATCH.

- [ ] Failing test for alerts upsert (fresh user, POST then GET returns true) + decline PATCH-failure 500; fix all; run; commit `fix(gp): escape home feed, no demo placement data for real placements, honest decline/alerts results`.

### Task 11 [P2]: practice batch

**Files:** Modify `server.js` (:20887, :35100-35114, :10818-10821), `pages/practice-intake.html` (success panel ~:602 area, `STORE` :1415), `pages/site-employers.html` (:137, :145), `pages/practice-status.html` + `/api/practice/status` (:35471); Test: server-side where reachable.

- Enquiry dead-end: `maybeNotifySiteEnquiry` (:20887) falls back to hello@mygplink.com.au when `SITE_ENQUIRY_NOTIFY_EMAIL` unset (constant, or existing owner-email constant if one exists in server.js).
- Signer email: sign handler sends the countersigned-PDF/status-link email to `practice.contact_email` AND `body.email` when different (:35100-35114).
- Fail-open token: when the intake-token persist PATCH fails (:10818-10821), abort the send (return error) instead of emailing a dead token.
- Success panel: already-signed reopen (`showSuccess`) gains a "Track your listing" link to `/pages/practice-status?token=<token>` (token available in page context).
- Draft key: `STORE = 'gplink_intake_draft_v3:' + token` (fall back to legacy key read-once for migration).
- Employers CTA: `/pages/signin?signup=1` (:137, :145) → in-page enquiry anchor (the form section id) so practices aren't routed into GP signup.
- Status page: `/api/practice/status` also reports `filled` when the job row's `job_status='filled'` (:35471 currently only is_active?live:pending); page renders a "Position filled" badge alongside existing Live/Pending.

- [ ] Tests where server-reachable (status filled, enquiry fallback recipient, persist-fail abort); fix; run; commit `fix(practice): enquiry notify fallback, signer email, status link + filled state, scoped drafts, CTA`.

### Task 12 [P2]: click-through batch — CSP images, apply error copy, ID-step support fallback, commencement redirect, favicon, AHPRA overlay clip, AMC external link, housing 401 backoff

**Files:** Modify `server.js` (CSP :9561; stage-gate blocked commencement → 302 `/pages/index`; favicon route), `pages/career.html` (apply error mapping ~ the overlay that prints server error; housing-search retry stop on 401), `js/onboarding.js` (ID step: add the same "Contact Support" fallback the qual slots have → sets `support_requested`, which step-complete logic already accepts + renders :1228; bump `?v=` buster on all pages referencing onboarding.js + pinned busters in tests/), `pages/ahpra.html` (locked-state CTA overlap), `pages/amc.html` (external MyIntealth link — verify the real Intealth portal URL via web before changing; if unverifiable, change to text without a fake domain).

- CSP img-src: add `https://www.homely.com.au` and the Domain API image hosts (grep :22205 area for the actual hostnames, e.g. domainstatic) to img-src only.
- Apply overlay: map non-OK responses to friendly copy ("Something went wrong on our side — please try again"), keeping known coded messages (cap reached, CV gate, dup) as-is; never print raw `error` strings.
- favicon: serve an existing icon (manifest icon file) at `/favicon.ico`.

- [ ] Verify each visually/curl where cheap; commit `fix(ux): CSP image hosts, friendly apply errors, ID-step support fallback, commencement redirect, favicon, locked-state overlap`.

### Task 13 [P2]: busters + sw.js + friendly 404 + FAQ fake counts

**Files:** Modify `sw.js:44` (+ any stale CORE_URLS busters), pages referencing `js/error-reporter.js` / `js/nav-shell-bridge.js` / `js/perf-cache.js` with old busters (align each file to its newest existing buster value), matching pinned busters in `tests/`; Create `pages/not-found.html` (small branded 404, no JS); Modify `server.js` final 404 path to serve it for non-API HTML GETs; Modify `pages/messages.html` FAQ tab (remove fabricated "N views" counts; keep articles).

- [ ] Run the buster-pinning tests; curl `/totally-bogus-url` → branded page, `/api/bogus` → JSON 404 unchanged; commit `fix(shell): align cache busters, branded 404 page, honest FAQ`.

### Task 14 [P2]: CEO leftovers — caps alignment (F11 easy), inactive-RSO fold-in (F6), onboarding-complete stamp (F7 minimal), calls join-link gating (F8 minimal)

**Files:** Modify `server.js` (:56648 tasks limit → match drilldown; :56649 tickets 500→1000; :57607/:57602 + :57657/:57645 summary/list caps aligned; :56201-56228 fold non-roster workload buckets into Unassigned row; :42122-42123 write `onboarding_completed_at` stamp unconditionally on completion), `pages/ceo-dashboard.html` (:6751-6752 join-link gating match admin's booked-only); Test where reachable.

- [ ] Fix; run; commit `fix(ceo): cap alignment, orphaned-RSO cases visible, completion stamp always written, calls gating parity`.

### Task 15 [P2, discovered during Task 1]: remaining local-mode lost-write sites (loadDbState-shadow pattern)

**Files:** Modify `server.js`; Test: extend `tests/local-auth-dev.test.js` style.

Task 1 proved the pattern (`const dbState = loadDbState()` copy mutated then `saveDbState()` which serializes the module-global → write vanishes + stale state re-persisted). Same mutate+save pattern remains at: 8959 (`setGpAccountStatus` local), 9008 (`upsertPepWaitlistRow`), 9049 (`markPepNotifyRequested`), 9105 (`sendPepLaunchBroadcast`), 9132 (`releasePepWaitlist`), 42927 (`/api/account/set-status`), 43225 (`/api/support/qualification-help`), 43313/43376/43437 (`/api/support/tickets` POST), 43670 (`/api/account/update-name`). Read-only uses at 8974, 9117, 42838, 43260, 43493 are fine — leave them.

- [ ] Failing test: local-mode support-ticket POST then GET returns the ticket; account update-name persists. Fix all listed sites the same way as Task 1B; run; commit `fix(dev): persist remaining local-mode writes (support, account, pep)`.

---

## Deliberately NOT fixed (report as outstanding)

Multi-clinic intake resume collapse (no data loss); practice-kind enquiries CEO tab (email fallback covers the dead-end); F7 full three-way predicate unification (stamp fix removes the main gap); F8 full shared call-card renderer; F11 volume-dependent remainder; F15 local-mode matching board; F16 pep store divergence (needs live prod check); demo career roles shown on prod API outage (deliberate demo dataset — product decision); dead `/api/practice/respond` flow (~220 lines unreachable); mobile Registration-Process sheet dead code (invisible to users); signed-out `?next=` iframe-capture race (observed once — investigate separately); `favicon` beyond ico; orphan `pages/inbox.html` (harmless redirect shim).

## Verification (after Task 14)

1. Full suite quiet-machine: `npx vitest run` → expect 3210+new all green (2 known load-flake files rerun serially if they time out).
2. Restart :3100 server; live click-throughs: doctor re-check (signup now works locally, docs re-scan failure keeps file, 375px career, apply error copy), practice persona (intake → sign → decision → availability → interview book), CEO persona (`SUPER_ADMIN_ALLOWED_HOSTS=localhost:3100`; tiles vs lists using the data the personas created).
3. Push branch, report.
