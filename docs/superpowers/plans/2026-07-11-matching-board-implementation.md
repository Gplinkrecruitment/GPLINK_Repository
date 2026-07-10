# Matching Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the picker-based ATS Matching tab with a glanceable funnel board, add automatic 24h/2h match-expiry nudges with a "need more time" escape hatch, and enrich the GP match card + job page (website, map, unmasked opening, sticky accept).

**Architecture:** One new aggregate read endpoint (`GET /api/ats/matching/board`) renders the whole board without ever calling the AI; the existing ranking/shortlist/extend endpoints stay the write path. Cron gains one pass (2h final call) mirroring the existing 24h reminder. Frontend: full rewrite of `js/ceo-ats-matching.js` (classic script, same registration), surgical additions to `pages/career.html` and `pages/job.html`.

**Tech Stack:** Node monolith (`server.js`), Supabase PostgREST, vanilla JS classic scripts, Vitest with the in-memory PostgREST emulator harness (see `tests/ai-matching-cron.test.js`).

**Spec:** `docs/superpowers/specs/2026-07-11-matching-board-design.md` — read it before your task; Part D copy is verbatim-mandatory.

## Global Constraints

- NEVER reword Part D copy blocks (email subjects/CTAs, toast, banner, board labels, the 98% line).
- The board endpoint must NEVER trigger an Anthropic call. Only `⚡ Run AI ranking` / `↻ refresh` (existing GET matching endpoints, `force=1` for refresh) do.
- All new admin endpoints: `requireAtsSession`. All new GP endpoints: GP session cookie like `/api/career/match/respond` (server.js:34402).
- Cache busters move FORWARD only, format `?v=20260711<letter>`; check `sw.js` CORE_URLS pins when bumping career/job assets.
- Tests: extend the existing emulator harness patterns (`tests/ai-matching-cron.test.js`, `tests/ai-matching-gp-flow.test.js`). Run a file with `node node_modules/vitest/vitest.mjs run tests/<file> ` (npx is flaky in this shell). Node lives at `/tmp/node-v20.18.1-darwin-arm64/bin` — prepend to PATH.
- Commit after every task (`git add <specific files>` — never `git add -A`).
- Supabase prod DDL via `/Users/gplinkrecruitment/.claude/jobs/0f1988f7/tmp/apply-ddl.js` (read live state first; `SET search_path = public;` is prepended in apply mode; SELECT via exec_sql returns 204 — verify via REST probe reads).
- Timestamps `Date.now()` style consistent with surrounding server.js code; days_open = `Math.floor((now - posted)/86400000)`.

---

### Task 1: Migration — nudge stamp columns (+ apply to prod)

**Files:**
- Create: `supabase/migrations/20260711220000_match_nudges.sql`
- Test: `tests/ai-matching-nudges.test.js` (source-wiring block only, extended in Task 2)

**Interfaces:**
- Produces: `gp_applications.match_final_reminder_sent_at TIMESTAMPTZ`, `gp_applications.match_more_time_requested_at TIMESTAMPTZ` — used by Tasks 2, 3, 4, 6.

- [ ] **Step 1: Check for timestamp collisions** — `ls supabase/migrations/ | grep 202607` ; if `20260711220000` collides, rename forward (e.g. `20260711230000`).
- [ ] **Step 2: Write the migration**

```sql
-- 20260711220000_match_nudges.sql
-- Two nudge stamps for the match-expiry automation (spec 2026-07-11 Part B).
-- NOTE prod drift: verify live gp_applications columns before applying; these
-- ADD COLUMN IF NOT EXISTS statements are idempotent.
ALTER TABLE public.gp_applications
  ADD COLUMN IF NOT EXISTS match_final_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS match_more_time_requested_at TIMESTAMPTZ;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Write failing source-wiring test** (`tests/ai-matching-nudges.test.js`): migration file exists and contains both column names; run `node node_modules/vitest/vitest.mjs run tests/ai-matching-nudges.test.js` → PASS after Step 2 (file-existence tests pass immediately — that's fine for a DDL task).
- [ ] **Step 4: Apply to prod** — `node /Users/gplinkrecruitment/.claude/jobs/0f1988f7/tmp/apply-ddl.js read` (sanity: constraints unchanged), then `... apply supabase/migrations/20260711220000_match_nudges.sql`, then `... reload`.
- [ ] **Step 5: Verify via REST probe** — GET `<SUPABASE_URL>/rest/v1/gp_applications?select=id,match_final_reminder_sent_at,match_more_time_requested_at&limit=1` with the service key from `.env` → HTTP 200 (not 400 "column does not exist").
- [ ] **Step 6: Commit** — `git add supabase/migrations/20260711220000_match_nudges.sql tests/ai-matching-nudges.test.js && git commit -m "feat(matching): nudge stamp columns (applied to prod)"`

---

### Task 2: 24h copy upgrade + 2h final-call nudge (cron + email)

**Files:**
- Modify: `server.js` — `buildMatchEmailHtml` (~26137), `sendMatchEmail` (~26285/26303), `/api/cron/match-lifecycle` handler (~29959, reminder pass ~29972), `PATCH /api/ats/application` match_extend branch (~55006)
- Test: `tests/ai-matching-nudges.test.js` (extend Task 1's file)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `sendMatchEmail(row, { reminder:true })` (recopy) and `sendMatchEmail(row, { finalCall:true })`; cron final pass stamps `match_final_reminder_sent_at`; extend clears `match_reminder_sent_at`, `match_final_reminder_sent_at`, `match_more_time_requested_at`. Tasks 4/6 read these stamps.

- [ ] **Step 1: Read the current reminder implementation** — `buildMatchEmailHtml` opts.reminder branches (banner ~26220, suppressed video/next-steps ~26203/26236) and the cron reminder pass (~29972-30014) including the checked-stamp-write pattern.
- [ ] **Step 2: Write failing tests** in `tests/ai-matching-nudges.test.js` (emulator boot copied from `tests/ai-matching-cron.test.js`; seed shortlisted rows with `match_expires_at` at now+90m, now+20h, now+30h, plus one already-stamped and one accepted):
  - 24h pass email subject equals `` `24 hours left — ${practiceName} is holding your spot` `` and HTML contains `Review &amp; accept my match` and `Not the right fit? Tell us why` and the verbatim 98% line.
  - 2h pass: row at now+90m with `match_reminder_sent_at` set gets ONE email, subject matches `/^Final call — your match expires at \d{1,2}:\d{2} (am|pm) (today|tomorrow)$/`, HTML contains `Accept before it expires` and `I&#39;m interested — I need more time` (check actual escaping used by the builder — assert on a distinctive substring like `need more time`), and the link `needtime=1`; `match_final_reminder_sent_at` stamped; second cron run sends nothing.
  - Row at now+90m that is already `match_outcome='accepted'` → no final email.
  - Response shape now `{ ok, reminded, finalCalled, expired, errors, timedOut }`.
  - Extend test: PATCH `/api/ats/application?id=` `{match_extend:true}` on a row with all three stamps set → row now has all three NULL.
- [ ] **Step 3: Run to verify failures** — `node node_modules/vitest/vitest.mjs run tests/ai-matching-nudges.test.js` → new tests FAIL.
- [ ] **Step 4: Implement.**
  - `sendMatchEmail`: reminder subject → the new verbatim string; add `opts.finalCall` → subject built from `match_expires_at` formatted `h:mm am/pm` in the same timezone helper existing emails use (grep how sendMatchEmail/cron formats dates; if none, use `Australia/Brisbane` via `toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Australia/Brisbane'})`; append `today`/`tomorrow` by comparing calendar dates in that timezone).
  - `buildMatchEmailHtml`: reminder branch → primary button label `Review & accept my match`, add secondary link `Not the right fit? Tell us why` (same acceptUrl). New finalCall branch: short body, red/amber chip, no video/next-steps, primary `Accept before it expires` (acceptUrl), secondary button `I'm interested — I need more time` → `acceptUrl + '%26needtime%3D1'` — careful: build it as `APP_BASE_URL + '/pages/signin?next=' + encodeURIComponent('/pages/career?match=' + applicationId + '&needtime=1')`. Keep 98% line in both.
  - Cron: new pass between reminder and expiry — select `ats_stage=eq.shortlisted&matched_at=not.is.null&match_final_reminder_sent_at=is.null&match_outcome=is.null&match_expires_at=gte.<now>&match_expires_at=lte.<now+2h>` order soonest, limit 200; `sendMatchEmail(row,{finalCall:true})`; checked stamp write of `match_final_reminder_sent_at` (mirror the reminder stamp pattern incl. error surfacing); count as `finalCalled`.
  - match_extend branch: add `match_reminder_sent_at:null, match_final_reminder_sent_at:null, match_more_time_requested_at:null` to its PATCH body.
- [ ] **Step 5: Run tests** → PASS; also `node node_modules/vitest/vitest.mjs run tests/ai-matching-cron.test.js tests/ai-matching-stage.test.js` (guard regressions; the old reminder-subject assertion in ai-matching-cron.test.js may reference the old subject — update THAT assertion to the new verbatim subject if so).
- [ ] **Step 6: Commit** — `feat(matching): 24h nudge recopy + 2h final-call nudge + extend clears stamps`

---

### Task 3: POST /api/career/match/need-more-time

**Files:**
- Modify: `server.js` — new route next to `/api/career/match/still-interested` (~34337); reuse its row-loading/session pattern
- Test: `tests/ai-matching-nudges.test.js` (extend)

**Interfaces:**
- Consumes: Task 1 column `match_more_time_requested_at`.
- Produces: `POST /api/career/match/need-more-time {applicationId}` → `{ok, state:'noted'|'already'|'expired'|'resolved'}`; ops email. Task 6 calls it from career.html.

- [ ] **Step 1: Write failing tests** (same file, GP-session boot pattern from `tests/ai-matching-gp-flow.test.js`):
  - Live shortlisted match, unstamped → `{ok:true, state:'noted'}`, column stamped, exactly one Resend call to `hello@mygplink.com.au` with subject `` `GP asked for more time — ${gpName} × ${practiceName}` `` and body containing `Extend 5 days`.
  - Second call → `{ok:true, state:'already'}`, no new email.
  - Expired row (`match_expires_at` past) → `{ok:true, state:'expired'}`, no stamp, no email. Accepted row → `state:'resolved'`.
  - Wrong-user session → 404/403 consistent with respond's ownership check.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** — clone the still-interested route skeleton: resolve session user, load the application by id + user_id, classify live/expired/resolved with the same expiry math as respond; on live+unstamped PATCH `{match_more_time_requested_at: nowIso}` (checked write), then `sendEmail`/ops-email helper the cron summary uses (`GP_OWNER_EMAIL`) with subject above and a body linking `Open the Matching board and hit Extend 5 days if you agree` + GP/practice/expiry details.
- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `feat(career): need-more-time endpoint + ops email`

---

### Task 4: GET /api/ats/matching/board

**Files:**
- Modify: `server.js` — new route beside `/api/ats/matching/candidates` (~54737); small pure helpers near the matching helpers (~26943)
- Test: `tests/matching-board-endpoint.test.js`

**Interfaces:**
- Consumes: `atsGetMatchCache` (26943), pool/eligibility helpers used by the ranking endpoints (candidates ~54737, jobs ~54806 — reuse, don't duplicate), `atsJobCard` fields (28670), stamps from Task 1.
- Produces: response exactly as spec Part A "Data source" block — Task 5 renders it verbatim. Key invariants: `rows` sorted `days_open` desc; `suggestions` = cached ranking minus live-pipeline user_ids (any non-terminal stage) minus terminal-outcome matches; `ranking.age_hours` integer; `kpis` as spec'd; `filled` = last-30d hired.

- [ ] **Step 1: Write failing tests** (emulator; seed 3 jobs: 74d old with pipeline rows across stages + a stale 3d-old job cache containing one pipeline user + one fresh GP; 41d job with no cache; filled job with hired row 5d ago + 2 `position_filled` rows):
  - Shape: `{ok, kpis, rows, filled}`; row fields incl. `job.days_open` (74), `job.header_image_url`; pipeline entries carry `match.{expires_at,reminder_sent_at,final_reminder_sent_at,more_time_requested_at,outcome,score}`; suggestion list EXCLUDES the user already in the pipeline; `ranking.age_hours >= 72`; job with no cache → `ranking:null, suggestions:[]`.
  - `kpis.unfilled60===1`, `kpis.awaiting` counts live shortlisted, `kpis.accepted_week` counts `match_outcome='accepted'` with `ats_stage_updated_at` in 7d.
  - `filled[0].hired.name` set, `redirected_count===2`; a job filled 40d ago is absent.
  - `direction=gps`: returns `rows[].gp.days_on_books`, live entries, suggestions from `subject_type='gp'` cache; `q=` filters by name server-side.
  - Never calls Anthropic: assert the mocked Anthropic fetch count is 0 for the whole request.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.** Positions direction: one gp_applications select for all non-terminal stages + recent terminal (`or=(ats_stage.neq.not_proceeding,and(match_outcome.eq.accepted,...))` — simplest: fetch all rows for open jobs' role ids in one `in.()` query and bucket in JS), one career_roles select (open + is_active, plus `job_status=eq.filled&updated_at=gte.<30d>` for filled), one `match_cache?subject_type=eq.job&subject_id=in.(...)` batch, users batch for names. Order/bucket in JS with small pure helpers `matchingBoardDaysOpen(postedIso, nowMs)` and `matchingBoardStageRank(stage)` (offer=0 … shortlisted=5) — export nothing; keep classic style. GPs direction: reuse the SAME eligible-pool builder the jobs ranking endpoint uses (extract it into a shared helper if it's inline — mechanical extraction, no logic change), limit 150 (live/cached first, then oldest `created_at`), `q` matches name/email ilike. `interview_at`: reuse whatever the jobs pipeline board uses for scheduled interviews if trivially available (`scheduled_calls`/`career_interviews` lookup by application) — else omit the field and drop its test (do not build new interview plumbing; note the choice in the task report).
- [ ] **Step 4: Run tests** → PASS; run `tests/ai-matching-pipeline.test.js` too. **Step 5: Commit** — `feat(ats): matching board aggregate endpoint`

---

### Task 5: Board frontend — rewrite js/ceo-ats-matching.js

**Files:**
- Rewrite: `js/ceo-ats-matching.js` (keep IIFE style, `window.ATS` guard, `window.loadMatchingTab`, `#panel-matching`)
- Modify: `pages/ceo-dashboard.html` script tag → `/js/ceo-ats-matching.js?v=20260711a` (and add board CSS beside the existing `.ats-match-*` styles; prune dead picker CSS)
- Test: `tests/matching-board-ui.test.js`

**Interfaces:**
- Consumes: Task 4 response; existing `GET /api/ats/matching/candidates|jobs` (+`&force=1` for refresh), `POST /api/ats/matching/shortlist`, `PATCH /api/ats/application` `{match_extend:true}`; `ATS.esc/escAttr/initials/avatarColor/emptyHtml/loadingHtml/setOverlay`, `window.atsOpenCandidate`, `window.atsOpenJobBoard`, practices open via `ATS.showMaster`+practice click pattern.
- Produces: the whole visible board. Structure it as pure builder functions taking data and returning HTML strings — `mbKpisHtml(kpis)`, `mbRowHtml(row, state)`, `mbNodeHtml(entry)`, `mbExpandHtml(row, selection)`, `mbGpRowHtml(row)` — with one delegated click handler, so tests can drive them.

- [ ] **Step 1: Read** the spec Part A + `docs/mockups/matching-board/round3-full-board.html` and `round4-funnel-line.html` (they ARE the design: class structure, colours, legend, states — port their CSS to `ats-`prefixed classes in ceo-dashboard.html's style block).
- [ ] **Step 2: Failing UI tests** — follow `tests/alerts-panel.test.js`'s technique for exercising a classic script (read file text; `vm.runInNewContext` with a stubbed `window`/`document`/`ATS`): assert `mbRowHtml` renders `74 days unfilled` red bucket ≥60 / amber ≥30 / green <30; node sub-labels for each stage incl. `⏳ Expires in {X}h`, `· nudged ✓` when `final_reminder_sent_at` set, `🙋 asked for more time`; suggestions dimmed with `Suggested`; age chip `ranked 3d ago · ↻ refresh` vs `ranked today · ↻ refresh`; empty → `⚡ Run AI ranking`; max 6 nodes then `+n ▸`; expand panel contains the verbatim header + bulk bar strings; filled row verbatim strings; all user text escaped via `ATS.esc` (assert a `<script>` practice name renders escaped).
- [ ] **Step 3: Run to verify failures.**
- [ ] **Step 4: Implement** the module: state `{direction, boardData, expandedJobId|expandedUserId, filters{urgency,status,state,dpa,filled,q,sort}, selection{}, runningIds{}}`. `loadMatchingTab` → fetch `/api/ats/matching/board?direction=` → render. KPI clicks toggle filters; flip refetches; filters/sort/search client-side; first 25 rows + Show more. Row click → expand (fetch nothing — data already loaded; suggestions detail from board payload's reasons). `⚡ Run AI ranking`/`↻ refresh` → set runningIds, render shimmer + verbatim running copy, GET candidates/jobs (+force for refresh, with `confirm()` noting an AI run), then refetch the board row data (simplest: refetch whole board, preserve expansion). Shortlist per-row/bulk → existing endpoint → optimistic refetch; Extend → PATCH match_extend + refetch; node/GP-name click → candidate file; practice/job title → job board / practice file. Bump buster to `?v=20260711a`.
- [ ] **Step 5: Run tests** → PASS. **Step 6: Manual sanity** — `node --check js/ceo-ats-matching.js`; grep ceo-dashboard.html for the new buster. **Step 7: Commit** — `feat(ats): Matching tab rebuilt as the funnel board`

---

### Task 6: Career page — matches payload + richer card + sticky accept + needtime + client nudge alerts

**Files:**
- Modify: `server.js` — `/api/career/matches` (~34174: add `mapQuery` per match, same source as `/role`'s `revealedMapQuery`)
- Modify: `pages/career.html` — `buildMatchCardHtml` (~11767), `renderTeamMatches` (~11830), `handleMatchDeepLink` (~11989), `pushMatchTeamAlert` (~1730) area
- Test: `tests/matching-card-enrichment.test.js`

**Interfaces:**
- Consumes: `/api/career/matches` fields (`website`, `headerImageUrl`, + new `mapQuery`), Task 3 endpoint, existing confirm sheet `openMatchConfirmSheet`.
- Produces: card UI; sticky bar; `?needtime=1` handling. Task 7's job.html links come FROM here: `See the full job opening →` → `/pages/job.html?id={roleId}&match={applicationId}`.

- [ ] **Step 1: Failing tests** — server side (emulator): `/api/career/matches` items now include `mapQuery` (practice address when known else `"{practiceName}, {city} {state}"`). Client side (file-content assertions, pattern used by `tests/apply-sheet-mobile-fit.test.js` style checks): career.html contains `🌐 Visit website`, `Open in Maps ↗`, `maps.google.com/maps?q=` + `output=embed`, `See the full job opening`, `job.html?id=` + `&match=`, sticky bar markup with verbatim sub-line `— your spot is reserved until then`, `needtime=1` handling calling `/api/career/match/need-more-time`, verbatim toast text, and localStorage-deduped nudge alerts keyed per application+threshold (`match-nudge-24h-`/`match-nudge-2h-` keys).
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement server** — in the matches mapper add `mapQuery` (reuse `/role`'s address resolution; grep `revealedMapQuery` ~33203 for the source expression; extract a tiny shared helper if inline).
- [ ] **Step 4: Implement card** (keep existing structure; insert under ticks): website button only when `m.website`; lazy map `<iframe loading="lazy" src="https://maps.google.com/maps?q={encodeURIComponent(mapQuery)}&output=embed">` in a rounded container with overlay link `Open in Maps ↗` → `https://www.google.com/maps?q=...` new tab; `See the full job opening →` row. **Sticky bar:** rendered once when ≥1 live match; fixed bottom respecting `var(--gp-shell-bottom-clearance, 0px)`; button `Accept this match` → `openMatchConfirmSheet` for the deep-linked (else newest) match; sub-line with live countdown text reusing the card countdown helper; hide after respond/expiry and when zero live matches. **needtime:** in `handleMatchDeepLink`, when `params.needtime==='1'` and card state live → POST need-more-time; on `state:'noted'|'already'` show the verbatim toast (reuse existing toast/sheet pattern in career.html; if none, minimal fixed toast div). **Client nudge alerts:** after matches render, for each live match compute hours left; `<24` or `<2` → `pushMatchTeamAlert`-style update (reuse its writer) with dedupe keys above.
- [ ] **Step 5: Run tests + regressions** — new file PASS + `node node_modules/vitest/vitest.mjs run tests/ai-matching-gp-flow.test.js` (matches mapper change). **Step 6: Commit** — `feat(career): richer match card (website/map/opening) + sticky accept + needtime + nudge alerts`

---

### Task 7: Job page — matched GP sees the full picture

**Files:**
- Modify: `server.js` — shortlist reopen branch (`msPatch` ~54958: add `revealed:true`); `/api/career/role` (~33196: add `website` when revealed; add `match` block when a live shortlisted match exists for this user+role: `{applicationId, expiresAt, reasons, score}`)
- Modify: `pages/job.html` — revealed rendering + matched banner/ticks + sticky accept
- Test: `tests/matching-job-unmask.test.js`

**Interfaces:**
- Consumes: reveal gate `canRevealPracticeIdentityCore` (lib/practice-pipeline.js:283), `extractCareerWebsiteUrl` (~16247), practices.website; Task 6 links arrive as `job.html?id={roleId}&match={applicationId}`.
- Produces: unmasked matched job view; accept-from-job-page via the existing self-apply merge path.

- [ ] **Step 1: Failing tests** (emulator, GP session):
  - Reopen path: shortlist a GP whose prior row on that job is terminal → row now has `revealed:true` (this is the bug fix; assert directly on the emulator row).
  - `/api/career/role` for a matched GP returns `website` (from practices.website; falls back to `extractCareerWebsiteUrl(source_payload)`) and `match:{applicationId, expiresAt, reasons[], score}`; for a non-matched GP: no `website`, no `match`, masked title unchanged (regression assert).
  - job.html source contains the verbatim banner string, a `Why this matches you` section fed by `match.reasons`, sticky bar with `Accept this match` + verbatim sub-line, website link + `output=embed` map when revealed.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement server** (two small patches + the `match` lookup: one gp_applications select by user+role, live shortlisted, non-expired).
- [ ] **Step 4: Implement job.html** — when payload `revealed`: render `realPracticeName` (exists), add `🌐 {website} ↗` + map embed (same pattern as Task 6, query `revealedMapQuery`); when payload `match` present AND url `match` param matches: blue banner (verbatim), `Why this matches you` ticks from `match.reasons`, sticky bar whose button triggers the EXISTING apply confirm sheet relabelled `Accept this match` with countdown sub-line (server already merges self-apply on a matched job into accept — do not add a new accept call; verify the confirm copy mentions accepting the match when `match` present).
- [ ] **Step 5: Run tests + `tests/career-internal-apply.test.js`** (self-apply merge regression) → PASS. **Step 6: Commit** — `feat(job): matched GPs get the unmasked opening + sticky accept (reopen reveals again)`

---

### Task 8: Ship

**Files:** none new (buster/sw sweep only if missed earlier)

- [ ] **Step 1: Full suite** — `node node_modules/vitest/vitest.mjs run` → ALL green (record the count).
- [ ] **Step 2: Buster/sw sweep** — confirm ceo-dashboard tag `?v=20260711a`; career.html/job.html mostly inline but check `sw.js` CORE_URLS for pinned versions of any touched asset; bump forward if needed; `node --check server.js`.
- [ ] **Step 3: Push** — `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy -o IdentitiesOnly=yes" git push origin worktree-ai-matching-build:main` (fast-forward only; if main moved, fetch + rebase + rerun full suite first).
- [ ] **Step 4: Verify deploy** — Vercel deployment READY for the pushed SHA; `curl -s -o /dev/null -w "%{http_code}" https://app.mygplink.com.au/` → 200.
- [ ] **Step 5: Update memory** (`ai-matching-design.md` + MEMORY.md line) — board shipped, nudges live, owed browser click-through.

## Self-Review

- **Spec coverage:** Part A → Tasks 4+5; Part B → Tasks 1+2+3 (+6 client alerts); Part C → Tasks 6+7; Part D enforced via verbatim-string tests in 2,3,5,6,7; Part F → Task 8. Gap check: KPI accepted_week needs `ats_stage_updated_at` on accept — respond already sets it (server.js:34402 path) ✓; "extend clears stamps" spec line → Task 2 ✓; interview_at marked droppable in Task 4 (matching spec's optional `?`).
- **Placeholders:** none — every step names exact routes/columns/strings; Task 4 Step 3 gives the query strategy rather than full 200-line code, with hard invariants pinned by tests (acceptable: implementer sees the real neighboring code).
- **Type consistency:** stamps named `match_final_reminder_sent_at`/`match_more_time_requested_at` everywhere; board response field names match between Task 4 tests and Task 5 consumers (`days_open`, `ranking.age_hours`, `suggestions`, `filled[].redirected_count`); deep-link param `needtime=1` consistent across Tasks 2/3/6.
