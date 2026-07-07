# AI Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AI Matching program end-to-end per `docs/superpowers/specs/2026-07-06-ai-matching-design.md` (READ IT FIRST — all copy, rules and mockup references live there; mockups in `docs/mockups/matching/`).

**Architecture:** Monolith `server.js` (all routes), vanilla-JS pages, Supabase via `supabaseDbRequest`. New: one migration, one AI lib, ~10 endpoints, one ATS tab module, GP-facing popup/cards/lock page, one cron, an app-wide alerts-panel restyle.

**Tech Stack:** Node (no framework), Supabase REST, Resend email, Anthropic Messages API, vitest.

## Global Constraints (from spec — every task inherits these)

- **No income/billing %/money in ANY GP-facing match reason, similarity tag, or copy.** Internal ranking may use earnings.
- GP-facing wording: **"book a call with the team"** — never "Zoom", never "CEO".
- The 98% line verbatim: **"98% of GPs we match are accepted by the practice."**
- 5-day accept window; final-24h amber state; expiry returns the GP to the team, never auto-deletes data.
- GP-facing UI uses existing component language: `css/gp-tokens.css`, `.role-card` idiom (`pages/career.html:939-1114`), PEP-gate skeleton (`pages/pep-pathway.html:31-181`), Team Alerts (`js/updates-sync.js`). Mockups are the source of truth for layout/copy.
- Server auth: `requireAtsSession` for `/api/ats/matching*`; GP session (`requireSession`) for `/api/career/*`.
- Anthropic: env-pinned model (`ANTHROPIC_MATCH_MODEL || ANTHROPIC_MODEL`), `checkAnthropicBudget()` guard, 503 when no `ANTHROPIC_API_KEY`, fence-stripping JSON parse, 30s AbortController. Template: `lib/ai-matching.js`.
- TDD with vitest (`npx vitest run tests/<file>.test.js`); commit after each task; bump cache busters `?v=20260707a` on every touched `<script src>` tag.
- End-to-end rule: trace UI → API → DB → back for every surface.

## Shared contract (exact names — all tasks must match)

- New stage key: `'shortlisted'` (label **Shortlist**), ordered FIRST, before `applied`. Stage arrays: `js/ceo-ats-jobs.js:16-25` (`STAGES`, `REJECT`, `ALL_STAGES`).
- `gp_applications` new columns: `match_reasons jsonb`, `match_score int`, `matched_by text`, `matched_at timestamptz`, `match_expires_at timestamptz`, `match_seen_at timestamptz`, `match_reminder_sent_at timestamptz`, `match_outcome text` (`accepted|declined|expired|position_filled`), `decline_reason text`, `redirect_alternatives jsonb`.
- New table: `match_cache (id uuid pk default gen_random_uuid(), subject_type text, subject_id text, payload jsonb, generated_at timestamptz default now(), UNIQUE(subject_type, subject_id))`.
- Career lock state lives in `user_state.state.career_lock`: `{ strikes:[{applicationId,practiceName,location,interviewedAt,source:'interview'|'late_withdrawal'}], locked_at, reasons:{<applicationId>:text}, answers_submitted_at, released_at, intent_halved_at }`.
- Endpoints created here: `GET /api/ats/matching/candidates?job_id=`, `GET /api/ats/matching/jobs?user_id=`, `POST /api/ats/matching/shortlist`, `POST /api/ats/career-lock/release`, `POST /api/ats/career-lock/restore-intent`, `GET /api/career/matches`, `POST /api/career/match/seen`, `POST /api/career/match/respond`, `GET /api/career/interview-usage`, `POST /api/career/lock/answers`, `GET /api/cron/match-lifecycle`.
- Lib: `lib/ai-candidate-job-match.js` exports `checkMatchEligibility(gp, job)`, `aiRankCandidatesForJob(job, candidates, opts)`, `aiRankJobsForGp(gp, jobs, opts)`, `parseMatchRanking(raw)`.
- Key existing helpers (verified locations): `supabaseDbRequest` server.js:14400; `sendEmail({to,subject,html,from,replyTo,scheduledAt,...})` :23006; `buildRsoEmailFromOpts(rso)` :979; `sendGpNotificationEmail` :23375; apply handler + gates `POST /api/career/apply` :29299 (onboarding gate :29335, CV gate :29343, payload `{roleId}`); pipeline fetch `/api/ats/job/pipeline` (client js/ceo-ats-jobs.js:311), stage PATCH `/api/ats/application` (client :472); cron auth snippet server.js:26201-26203; hourly cron example `/api/cron/onboarding-nudge` :26200; interviews table + status values (`isCareerInterviewStatus` :14567; statuses scheduled/confirmed/cancelled/completed/no_show); intent write `atsStoreIntentForCase(caseId, intent, facts)` :25074, calc `lib/ats-intent.js`; candidates list `GET /api/ceo/candidates` :49389; candidate drawer `detailHtml(c)` js/ceo-ats-candidates.js:363; alerts store `js/updates-sync.js` (`UPDATES_KEY='gp_link_updates'`, item `{type:'info'|'success'|'action', title, detail, ts}`, `saveGpLinkUpdates`, `buildAlertItems` :133); confetti `launchConfetti()` pages/offer-review.html:968; account status setter `setGpAccountStatus` :7407 (do NOT use for career lock — career lock is career-scoped, not app-wide); Anthropic fetch example :1382-1391 + `recordAnthropicSpend`.

---

### Task 1: Migration + Shortlist stage plumbing

**Files:**
- Create: `supabase/migrations/20260707190000_ai_matching.sql`
- Modify: `js/ceo-ats-jobs.js:16-25` (STAGES), server.js ats-stage validation (grep `not_proceeding` in server.js to find the allowed-stage list(s) used by `/api/ats/application` PATCH and pipeline grouping — update every list)
- Test: `tests/ai-matching-stage.test.js`

**Interfaces — Produces:** stage `'shortlisted'` accepted server-side; new columns + `match_cache` table exist (guarded, idempotent).

- [ ] Migration SQL (all guarded `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`; for the CHECK constraint use a DO block that drops the existing `gp_applications_ats_stage_check` if present and re-adds with `('shortlisted','applied','submitted','reviewing','interview','offer','hired','not_proceeding')`). Add comment header warning: **verify LIVE constraint name/values in prod before apply (constraint drift precedent)**.
- [ ] `match_cache` table + RLS service-role policy (copy practices RLS block pattern from `supabase/migrations/20260627100000_ats_practices.sql`).
- [ ] Add `{ key:'shortlisted', label:'Shortlist', color:'#7c3aed' }` as FIRST element of `STAGES`; verify board renders a Shortlist column (it derives columns from STAGES).
- [ ] Update every server-side stage whitelist to include `shortlisted` (search `'not_proceeding'` literals).
- [ ] Tests: server stage validator accepts `shortlisted` & rejects junk; STAGES order has shortlisted first (import the file or regex-check). Run suite subset, then commit.

### Task 2: Matching engine lib + ATS endpoints

**Files:**
- Create: `lib/ai-candidate-job-match.js`
- Modify: `server.js` (new routes near other `/api/ats/` routes)
- Test: `tests/ai-candidate-job-match.test.js`

**Interfaces — Produces:** the three `/api/ats/matching/*` endpoints; `checkMatchEligibility(gp, job)` → `{eligible:boolean, blocks:[string]}`; ranked results `[{user_id|role_id, score:0-100, reasons:[3-5 strings]}]`.

- [ ] Lib: system prompt instructs: compare GP (preferences, family, qualifications, CV summary, handover summary) vs job (`career_roles` fields + practice name/type); return STRICT JSON `{"ranked":[{"id":"...","score":0-100,"reasons":["…"]}]}`; reasons plain-English, personal, **never mention money/billing/percentages**; 3-5 reasons. Reuse `parseAIMatchResponse` fence-stripping approach (own copy `parseMatchRanking`). 30s AbortController. Batch candidates into one call (cap ~25 per call, chunk if more).
- [ ] Eligibility (pure function, unit-tested; server assembles inputs): blocks for — onboarding incomplete; no CV; placed (`gp_career_state.career_secured` / placement in state); live application on this job; any application at stage `interview` (or career_interviews scheduled/confirmed); `career_lock.locked_at` unreleased; account_status not active; DPA-restricted job vs non-DPA-eligible GP (reuse the board's server-side DPA gate logic — grep `dpa` gates used by `/api/career/roles` masking); pep/under_review.
- [ ] `GET /api/ats/matching/candidates?job_id=&force=` — `requireAtsSession`; load job + practice; load candidate pool (profiles + state + registration_cases incl. `ai_handover_summary`, intent); apply eligibility; check `match_cache` (`subject_type='job'`, 24h TTL, `force=1` bypass); else AI rank; store cache; respond `{job, ranked:[{candidate summary, score, reasons, eligible chips}], excluded_count}`.
- [ ] `GET /api/ats/matching/jobs?user_id=&force=` — mirror (`subject_type='gp'`; jobs pool = `job_status='open' AND is_active`).
- [ ] `POST /api/ats/matching/shortlist` `{items:[{user_id, career_role_id}]}` — per item: if existing row live → 409 skip w/ note; if prior declined/expired/not_proceeding row → reopen SAME row (stage `shortlisted`, clear outcome, append prior outcome into `match_reasons._history`); else insert. Set `match_*` fields (`match_expires_at = now()+5 days`, `matched_by` = admin email, score+reasons from cache). Then send match email + push alert (STUBS in this task: call `sendMatchEmail(applicationRow)` if defined, else skip silently — Task 4 provides it; keep a TODO-free seam: `if (typeof sendMatchEmail === 'function')`). Respond per-item results. Budget+key guards on AI routes.
- [ ] Tests: eligibility matrix (each block), parseMatchRanking (fenced/dirty JSON), shortlist insert/reopen/dedupe logic (mock `supabaseDbRequest`). Commit.

### Task 3: Matching tab UI + kanban states

**Files:**
- Create: `js/ceo-ats-matching.js`
- Modify: `pages/ceo-dashboard.html` (`#masterTabs` ~:1331-1353, panels ~:1388-1391, script block ~:6684-6688), `js/ceo-ats-shared.js:104` (MASTER_PANELS), `js/ceo-ats-jobs.js` (Shortlist card sub-labels), server.js pipeline select (return match_* fields)
- Test: `tests/ai-matching-pipeline.test.js`

**Interfaces — Consumes:** Task 2 endpoints. **Produces:** `window.loadMatchingTab`.

- [ ] Tab button `<button class="ats-master-tab" data-mtab="matching">Matching</button>`; `<div class="master-panel ats-scope" id="panel-matching" style="display:none"></div>`; `'matching'` in MASTER_PANELS; `<script src="/js/ceo-ats-matching.js?v=20260707a">`.
- [ ] `js/ceo-ats-matching.js` (follow `ceo-ats-jobs.js` idiom, `window.ATS.api`): direction toggle (Find GPs for a job / Find jobs for a GP); pickers reuse `/api/ats/jobs` + `/api/ceo/candidates`; результат list rows: score badge, name/title, reason list, chips, per-row **Shortlist & notify** + select-all bulk; confirm dialog: `Send the match email and in-app notification to N GP(s) for "<job title>"?`; Refresh (force=1); links `#candidate=<id>` / `#board=<jobId>`.
- [ ] Pipeline: server `/api/ats/job/pipeline` select adds match fields; kanban Shortlist cards show status line: `expired — no response` (outcome expired), `seen — awaiting response` (match_seen_at set), else `⏳ Nd Nh left`; amber text when <24h. Extend drawer stage-move with per-row "Extend 5 days" action for expired (PATCH `/api/ats/application` `{match_extend:true}` → server resets expiry+stage shortlisted).
- [ ] Tests: pipeline payload includes match fields; extend endpoint resets correctly. Commit.

### Task 4: GP surfaces — match email, popup, pinned cards, respond

**Files:**
- Create: `js/match-popup.js`
- Modify: `server.js` (email builder `buildMatchEmailHtml` + `sendMatchEmail`; `/api/career/matches|match/seen|match/respond|interview-usage`; wire real `sendMatchEmail` into shortlist endpoint), `pages/career.html` (pinned section in `renderRoles()` :10860 area + styles + `?match=` deep link), `pages/app-shell.html` (script tag for match-popup)
- Test: `tests/ai-matching-gp-flow.test.js`

**Interfaces — Consumes:** rows from Task 2. **Produces:** GP endpoints above; `sendMatchEmail(applicationRow)`.

- [ ] `buildMatchEmailHtml` — implement mockup `matching-email-popup-v3.html` + v5 urgency box, copy VERBATIM from spec §6 (team-match chip, headline, personalized paragraph, job card w/ `header_image_url` photo+caption, practice name, 🌐 website, why-ticks from `match_reasons`, intro-video thumb block only if `intro_video_url`, 98% callout, "reserved for you until <date>" line, glossy static-shine Accept button, next-steps box, footer). From = assigned RSO via `buildRsoEmailFromOpts`; fallback default RSO. Accept URL: `https://app.mygplink.com.au/pages/sign-in?next=` + encoded `/pages/career?match=<applicationId>` (verify the live sign-in bounce param by grepping `?next` handling in sign-in page; use the doc-delivery deep-link pattern).
- [ ] `GET /api/career/matches` (GP session): live `shortlisted` rows + job+practice join (name, website, intro_video_url, header_image_url, city/state, dpa) + reasons + expires + seen + `locked` flag (career_lock) + recent `position_filled` rows w/ `redirect_alternatives`. `POST /api/career/match/seen` sets `match_seen_at` once. `POST /api/career/match/respond {applicationId, action, reason?}`: expired → 410 + ops email "GP clicked expired match — still interested"; accept → stage `applied`, `match_outcome='accepted'`, run the same post-apply effects as `/api/career/apply` (extract shared helper from :29299 body rather than duplicating), ops email; decline → `not_proceeding`, outcome declined + reason, ops email. `GET /api/career/interview-usage` → `{used, limit:3, resetsAt}` counting career_interviews (scheduled/confirmed/completed) in current calendar month.
- [ ] `js/match-popup.js` (loaded by app-shell): fetch matches; if unseen match & not locked → full-screen overlay per v3 mockup (dark `--gp-grad-hero`, ANIMATED falling confetti — copy `launchConfetti` canvas from `pages/offer-review.html:968` adapted to loop gently, badge, serif headline, job card, why-ticks, video card, 98% stat, 5-day strip, shiny animated accept, "I'll look at this later"); POST seen on render; accept → respond → success + `gp-shell-route` to career; later → dismiss. Never render when parent page is gated (auth-guard handles account gates before this loads).
- [ ] `pages/career.html`: pinned "✦ Your team matches (n)" section above role grid per v5 (per-card countdown chip blue→amber pulsing <24h, photo, practice+site, 2 reasons + "+n more" expander, 98% chip, video chip, shiny Accept w/ confirm sheet incl. cap meter from interview-usage + copy "…Once they confirm their availability, you'll choose an interview time.", decline link w/ reason prompt); `?match=<id>` scroll/highlight + expired graceful notice (spec §7); push a `{type:'success', title:'You were matched to a position — <city>', detail:'Matched by your team…', ts}` into `gpLinkUpdates` when a new match first appears client-side; position-filled state renders v8/v9: dismissible notice card + "Picked for you next" `.role-card`s from `redirect_alternatives` + amber `{type:'action'}` update.
- [ ] Tests: respond transitions incl. 410 expired + accept reuses apply effects; seen once; usage math (month boundary); email HTML contains practice name, website, 98% line, NO `%`-billing strings in reasons block; matches endpoint shape. Commit.

### Task 5: Cron — reminders + expiry

**Files:**
- Modify: `server.js` (handler near other crons), `vercel.json` (add `{"path":"/api/cron/match-lifecycle","schedule":"0 * * * *"}`)
- Test: `tests/ai-matching-cron.test.js`

- [ ] `GET /api/cron/match-lifecycle` (auth = Bearer CRON_SECRET pattern server.js:26201-26203; time-box ~45s like nudge cron): (a) reminder pass — `shortlisted`, `match_reminder_sent_at IS NULL`, expires within 24h → send short amber-urgency reminder email (subject `⏳ 24 hours left — your matched position in <city>`; reuse buildMatchEmailHtml w/ urgency variant flag) + stamp; (b) expiry pass — `shortlisted`, `match_expires_at < now()` → stage `not_proceeding`, `match_outcome='expired'`, one summary ops email listing expiries; (c) lock pass placeholder call `evaluateCareerLocks()` if defined (Task 8 seam).
- [ ] Tests: selection windows, idempotent reminder, expiry transition + summary (mock supabase + sendEmail). Commit.

### Task 6: Hired → redirect fan-out

**Files:**
- Modify: `server.js` (`/api/ats/application` PATCH hired path; job-close path in `/api/ats/job` PATCH), `js/ceo-ats-jobs.js` (confirm dialog on hire/close w/ live count → sends `redirect_others:true`)
- Test: `tests/ai-matching-redirect.test.js`

- [ ] Server `redirectOthersForJob(jobId, hiredAppId|null)`: rows in (`shortlisted,applied,submitted,reviewing,interview`) minus hired → per GP: pick ≤3 alternatives from open+active roles excluding GP's live jobs, ranked same `location_state`/region first then internal earnings similarity; write `redirect_alternatives` (place/fit tag strings ONLY — build from dpa/visa_pathway_aligned/family_friendly/regional/metro/practice_type/location, NEVER earnings); stage → `not_proceeding`, `match_outcome='position_filled'`; send redirect email per spec §8 verbatim (POSITION UPDATE chip, filled card, green reassurance box, "✦ Already matched for you", alt cards w/ photos+tags, shiny "See all roles picked for you", zero-alternatives fallback line, NO 98%/countdown); skip already-not_proceeding.
- [ ] Trigger only when client passes `redirect_others:true` (hire PATCH and job close PATCH). Client dialogs: `N other GPs are still active on this job — send them the redirect email?` (hire) / same on close-to-filled/closed.
- [ ] Tests: candidate-set selection, skip rules, alternatives exclusion + no-income tags, flag honored, close-path trigger. Commit.

### Task 7: Caps, velocity, self-apply-as-accept

**Files:**
- Modify: `server.js` (`/api/career/apply` :29299, interview book endpoints `/api/career/interview/book` :29246 + `/api/ats/interview/book` :48906, `/api/ceo/candidates` row flags, `lib/ats-intent.js` input (velocity signal)), `pages/job.html` (deliberate-apply confirm sheet w/ cap note+meter at :2529 flow)
- Test: `tests/ai-matching-caps.test.js`

- [ ] Active-app cap: helper `countActiveApplications(userId)` (stages shortlisted/applied/submitted/reviewing/interview); `/api/career/apply` 4th → 409 `{error:'active_cap'}`, client sheet shows "You have 3 active applications — focus on those first, or withdraw one."
- [ ] Self-apply-as-accept: in apply handler, existing `shortlisted` row for (user, role) → route through the Task-4 accept path, respond `{ok:true, matched:true}`.
- [ ] Interview cap: both book endpoints count month's interviews (scheduled/confirmed/completed) → 3rd+1 blocked 409 `{error:'interview_cap', resetsAt}` (ATS side gets clear error toast). job.html + accept confirm sheets show note verbatim: *"You can interview for up to 3 positions per month — so accept the roles you're genuinely serious about."* + meter "N of 3 interviews used — resets <1st of next month>".
- [ ] Velocity: on apply/accept count user's applies last 24h; ≥5 → `state.application_velocity_flag={count,at}`; expose chip in `/api/ceo/candidates` rows (`high application velocity`); add negative intent signal in `atsIntentInputFromFacts` facts when flag <7d old.
- [ ] Stage-move UI: moving to `not_proceeding` from `submitted`+ offers reason select incl. "GP withdrew after submission" → stored in `ats_stage_events` payload (strike source, Task 8 reads it).
- [ ] Tests: cap math + boundaries, self-apply merge, velocity flag set/expire, book-block both endpoints. Commit.

### Task 8: Strikes, career lock, lock page, admin panel, release

**Files:**
- Create: `pages/career-paused.html`
- Modify: `server.js` (strike/lock helpers + enforcement + `/api/career/lock/answers` + `/api/ats/career-lock/release|restore-intent` + candidates payload), `pages/career.html` + `pages/job.html` (locked → replace to `/pages/career-paused`), `js/ceo-ats-candidates.js` `detailHtml` (Interviews & strikes section)
- Test: `tests/ai-matching-lock.test.js`

- [ ] `computeCareerStrikes(userId)` → completed interviews whose application ended without acceptance + `gp_withdrew` events; `evaluateCareerLocks()` (called from cron + after interview PATCH to completed): strikes ≥3 since last `released_at` → set `career_lock.locked_at`, halve intent via `atsStoreIntentForCase` (once — guard `intent_halved_at`), ops email.
- [ ] Enforcement: `/api/career/roles`, `/api/career/apply`, `/api/career/match/respond` (accept), `/api/career/interview/book` → 423 `{locked:true}` when locked. `/api/career/matches` returns `locked:true` so pages redirect.
- [ ] `pages/career-paused.html` — EXACT v12 mockup (`matching-career-lock-v12.html`) on the pep-pathway skeleton (copy its CSS approach/system font): amber dot-badge APPLICATIONS PAUSED; h1 "Let's talk before your next interview"; two paragraphs (spec §10); collapsed interviews dropdown (calendar icon, "0 of 3 answered — tap to tell us what wasn't right", chevron, "↑ Start here" nudge; open → 3 strike interviews w/ textareas, ✓ Answered chips, "N of 3 answered — keep going"); "What happens next" numbered timeline (answer → **book a call with the team** → page reopens); sticky bottom bar CTA **"Book a call"** + subline "Applications stay paused until this conversation happens."; Sign out. Data via `GET /api/career/matches` lock payload (strikes list); answers `POST /api/career/lock/answers {answers:{<appId>:text}}` (saves into `career_lock.reasons`, `answers_submitted_at`); Book a call → the existing GP call-booking flow (grep the Zoom-assistance "Book Your Time Slot" URL builder ~server.js:25352 / scheduled-calls flow and reuse; store `call_booked_at` when booked if hookable, else link out).
- [ ] Admin (`detailHtml`): "Interviews & strikes" section per v11 right panel — chips `CAREER LOCKED` + `STRIKES n/3`; rows practice · location · date · `DID NOT PROCEED` + GP reason verbatim or *Not provided yet*; intent line "X → Y (−50% on lock)" + call-booked status; buttons → `POST /api/ats/career-lock/release {user_id}` (sets `released_at`, clears locked_at, ops log; GP eligible again), `POST /api/ats/career-lock/restore-intent {user_id}` (recompute intent without halving). Candidates payload extended with `career_lock` + strikes + velocity chip.
- [ ] Tests: strike counting (incl. withdraw events), lock at 3 + single intent-halving, 423 enforcement, answers saved, release restores matchability, admin payload. Commit.

### Task 9: Team Alerts redesign (independent of Tasks 2-8)

**Files:**
- Modify: `js/updates-sync.js` (ensurePanelStyles CSS + ensurePanelRoot/renderPanel markup ONLY — keep storage, item building, mark-read, nudge pull, badges, public API unchanged), bump `updates-sync.js?v=` busters everywhere it's referenced (grep).
- Test: syntax `node --check js/updates-sync.js` + existing suite.

- [ ] Implement `matching-alerts-redesign-v9.html` panel: serif "Team Alerts" + `n NEW` chip + Mark all read + close; filter chips All/Actions/Updates/Replies (client-side kind filter; Replies = `support`); NEW (unread) / EARLIER (read) groups w/ uppercase micro-labels; item = 36px tinted line-SVG icon square (amber `action` / blue `update` / green `support`), 13px bold title, 12px one-line `detail` (now rendered — items already carry `detail`), kind + relative-time meta (`timeAgo(ts)` helper), blue unread dot, inline action link when `target` set; unread soft-blue wash; read faded; "See all updates" footer preserves existing navigate behavior. Keep `#gp-alert-center` id + `data-alert-close` + `.show` mechanics so nothing else breaks. Commit.

### Task 10: Ship

- [ ] Full suite `npm test` — fix all fallout.
- [ ] Grep-check: no GP-facing income strings in match surfaces; every touched script tag busted `?v=20260707a`; `node --check server.js`.
- [ ] Merge latest `origin/main` into branch; re-run suite.
- [ ] Push branch; merge to `main` and push (owner's explicit instruction).
- [ ] Apply migration to prod via `exec_sql` RPC (service key in main checkout `.env`; param name `query`; FIRST read live `ats_stage` CHECK constraint def and adapt; then guarded DDL; then PostgREST `NOTIFY pgrst, 'reload schema'`).
- [ ] Verify Vercel deploy READY; update memory + spec status.

## Self-review notes
- Spec coverage: §2→T3, §3→T2, §4→T2, §5→T1/T2, §6→T4, §7→T4/T5, §8→T6, §9→T7, §10→T8, §11→T9, §12→T10. Popup gating (§6) rides on auth-guard ordering (T4 note). "Extend 5 days" (§7) in T3.
- Type consistency: stage key `shortlisted`, `match_*` column names, endpoint paths identical across tasks (single contract section above).
- No placeholders: seams between T2→T4 (`sendMatchEmail`) and T5→T8 (`evaluateCareerLocks`) are explicit optional-call seams, filled by their owning tasks.
