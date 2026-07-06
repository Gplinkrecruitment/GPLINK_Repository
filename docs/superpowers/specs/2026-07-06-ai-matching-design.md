# AI Matching — Design Spec (approved 2026-07-06)

Owner-approved across 12 visual rounds on the brainstorming companion. Approved mockups
are committed at `docs/mockups/matching/` (open in a browser):

| File | What it shows |
|---|---|
| `matching-email-popup-v3.html` | Match email + full-page popup (reasons ticks, shiny accept, area photo) |
| `matching-multi-timer-v5.html` | Multiple simultaneous matches + 5-day countdown states |
| `matching-rejection-v6.html` | "Position filled" redirect email + hired-trigger rules |
| `matching-rejection-app-v8.html` | In-app rejection state in the app's real card language |
| `matching-alerts-redesign-v9.html` | No-income similarity tags + Team Alerts app-wide redesign |
| `matching-career-lock-v12.html` | 3-strike career lock page (final: dropdown + timeline + sticky CTA) |

NOTE (styling ground rule from round 8): all GP-facing surfaces use the app's REAL
component language — `css/gp-tokens.css`, `.role-card` patterns from `pages/career.html`
(3px brand-gradient top bar, serif location headings, square uppercase tags, quiet
outline CTAs), the PEP-gate page skeleton from `pages/pep-pathway.html` for full-page
gates, and the Team Alerts panel in `js/updates-sync.js`. No invented visual styles.
The ONE deliberate standout: the glossy animated "Accept this match" button.

---

## 1. What this is

A "Matching" master tab in the ATS/CEO dashboard where the team uses AI to match GP
candidates to job positions, in both directions (pick a job → ranked GPs; pick a GP →
ranked jobs). A confirmed match shortlists the GP onto the job, notifies the GP
(branded email + one-time full-page in-app popup), starts a 5-day accept window, and
drives a complete downstream lifecycle: accept → applied → submitted to practice →
practice confirms availabilities → interview selection; hire → automatic graceful
redirect of all other live GPs on that job; plus anti-time-waster controls
(3 interviews/month cap, 3-strike career lock, application caps).

## 2. Where it lives (both audiences, one surface)

- The ATS master tabs live in `pages/ceo-dashboard.html` (`#masterTabs`,
  `.ats-master-tab[data-mtab]`) and serve BOTH the CEO (super_admin) and recruitment
  consultants (`applyConsultantMode()` hides only the Registration tab). One new
  Matching tab serves both. (`pages/admin.html` is the separate RSO ops dashboard —
  not part of this feature.)
- Add: `data-mtab="matching"` button; `<div class="master-panel ats-scope"
  id="panel-matching">`; `'matching'` in `MASTER_PANELS` (`js/ceo-ats-shared.js:104`);
  new `js/ceo-ats-matching.js` exposing `window.loadMatchingTab` (auto-invoked by
  `setActiveTab`), loaded from `pages/ceo-dashboard.html` next to the other
  `ceo-ats-*.js` scripts. Hash deep-link `#matching` works via existing shared code.
- New endpoints under `/api/ats/matching*`, gated by `requireAtsSession`
  (server.js:9952 — super_admin OR consultant), matching every other ATS route.
- The Matching tab's own visual design was NOT mocked up (all GP-facing surfaces
  were). Build it in the existing ATS tab idiom (`ceo-ats-jobs.js` / candidates
  patterns): left = picker (job or GP, toggle for direction), right = ranked results
  with score, why-reasons, eligibility notes, and per-row "Shortlist & notify" plus
  bulk action. Confirmation dialog before anything is sent.

## 3. The AI matcher

- Two-stage to control cost: (1) cheap deterministic pre-filter (eligibility rules
  below + same-state/preference heuristics) → (2) AI ranks/scores only the plausible
  set and writes 3–5 personalized plain-English reasons per pair.
- Data, GP side: `user_profiles` (incl. onboarding cols `preferred_city`,
  `target_arrival_date`, `who_moving`, `children_count`, `qualification_country`),
  `user_state.gp_career_state`, CV (`user_profiles.cv_file_name` /
  `user_documents`), `registration_cases.ai_handover_summary`, intent score.
- Data, job side: `career_roles` columns (title, location_*, billing_model, dpa, mmm,
  tags, summary, employment_type, practice_type, booleans) + `practices`
  (`name`, `website`, `intro_video_url`) + `career_roles.header_image_url`
  (area photo; fallback = career city hero library; hide strip if none).
- Reasons are stored with the match and rendered identically in ATS, email, popup and
  card. **HARD RULE: no income, billing %, or money in any GP-facing reason or
  similarity tag** (round 9). Place/fit/visa/family reasons only. Job detail pages
  keep their own terms as today.
- Server plumbing: follow the standard AI endpoint recipe — `requireAtsSession`,
  `ANTHROPIC_API_KEY` 503 guard, `checkAnthropicBudget()` (server.js:6960), env-pinned
  model const, fence-stripping JSON parse; model `lib/ai-matching.js` is the template
  (30s AbortController, `parseAIMatchResponse`-style parsing, graceful degradation).
  Cache match results (e.g. 24h keyed by job+gp+profile-updated-at) like
  `ai_handover_summary`.

## 4. Eligibility — who can be matched (pool)

Included: onboarding complete + CV uploaded + no placement + account in good standing.
Excluded (owner-confirmed):
- Placed GPs.
- GPs currently at interview stage on ANY job.
- Career-locked GPs (3-strike rule, §10).
- Not-finished-onboarding / no-CV GPs (the apply gates in `/api/career/apply`
  server.js:30555/30657 would block their accept anyway).
- `under_review`, `pep_waitlist`, deleted accounts.
- DPA/moratorium: never match an ineligible GP to a DPA-restricted job (same rule
  that blurs the board).
- GPs who already have a live application on that job (merge instead, §7).

## 5. Shortlist stage + data model

- New kanban column/stage **`shortlisted`**, ordered BEFORE `applied`, added to
  `gp_applications.ats_stage` CHECK constraint. ⚠️ Read the LIVE prod constraint
  before altering — prod CHECK constraints have drifted from migrations before
  (see memory: sppa task_type).
- Shortlisting creates a `gp_applications` row (`ats_stage='shortlisted'`) carrying
  match metadata (new columns): `match_reasons jsonb`, `match_score`, `matched_by`,
  `matched_at`, `match_expires_at` (now + 5 days), `match_seen_at`,
  `match_outcome` (accepted / declined+reason / expired). Stage moves audit-log via
  existing `ats_stage_events`.
- Uniqueness: one row per (user_id, career_role_id); re-match after decline/expiry
  reuses/reopens with history preserved (§9).

## 6. GP notification (mockup v3 + v5)

**Email** — sent from the GP's assigned RSO mailbox (`@mygplink.com.au` sender rule;
default-RSO fallback). Contents, in order: GP Link brand bar; "✦ TEAM MATCH" chip;
"Dr <name>, we've matched you to a position."; copy: *team has specifically matched
you based on your preferences and experience — and on what the medical practice is
looking for*; job card with area photo + caption ("📍 Bargara Beach — 15 minutes from
the practice"), **practice name revealed**, role line, location + DPA line, 🌐 website
link; blue-tick "Why this matches you" (3–5 stored reasons, no income); practice intro
video thumbnail linking out (only if `intro_video_url` set; 98% callout: **"98% of GPs
we match are accepted by the practice."** (kept verbatim — owner decision); 5-day
urgency box: *"This match is reserved for you until <weekday day month>. After that we
may offer the position to another GP."*; glossy Accept button (static shine in email —
clients strip animation); "What happens next" note (accept → official offer with an
interview date); footer. Subject: *"You've been personally matched — <Practice>,
<City STATE>"*.
- The Accept deep link MUST survive the OTP sign-in bounce (reuse the
  ?next → ?route chain from the doc-delivery emails).

**Full-page popup** — next app open, once per match: dark hero gradient
(`--gp-grad-hero`), **animated falling confetti** (reuse the existing confetti
engine from the practice-accept flow — owner explicitly wants it dynamic), "✦ MATCHED
BY YOUR TEAM" badge, serif "You've been matched, Dr <name>", job card (photo,
practice, website), why-ticks, video card, 98% stat, 5-day reserve strip, shiny
animated Accept, "I'll look at this later". Rules: only the NEWEST match ever takes
over (no popup stacking); never shown to gated accounts (under_review, pep_waitlist,
mid-onboarding); shows once — after "later" the pinned card + badge do the work.

## 7. Waiting state, countdown, accept (mockups v3/v5)

- **My Practice pinned section** "✦ Your team matches (n)" above all roles; one full
  card per match: ribbon + live countdown chip, area photo, practice name + website,
  first 2 reasons + "+n more", 98% chip, video chip, shiny Accept, quiet "Not the
  right fit? Let your team know" (decline with reason → team sees it, can re-match).
  Nav badge shows count; bell alert mirrors.
- **Countdown**: days 1–4 blue chip; final 24h amber pulsing chip + amber card border +
  button copy "Accept before it expires" + one reminder email + bell alert; expiry →
  card removed, ATS shows "Expired — no response" (team: re-match / extend 5 days /
  call). Late click on an old email → graceful expired page ("the role may still be
  open — your team has been told you're interested").
- `match_seen_at` set when popup/card first rendered → ATS shows
  "seen — awaiting response".
- **Accept** (email/popup/card): confirm sheet stating: *"We'll confirm your interest
  with <practice>. Once they confirm their availability, you'll choose an interview
  time."* + interview-cap note (§9) with meter ("2 of 3 interviews used — resets
  1 Aug"). On accept: stage → `applied`; ops email to team; ATS updates; then the
  standard flow: **applied → submitted to practice → practice confirms availabilities
  → interview selection** (existing interview machinery / `career_interviews`).
- **Self-apply on a matched job = accepting the match** (owner rule) — identical flow.
  Self-apply and matching also merge the other way: matching someone with an existing
  live application is blocked (§4).
- Decline/expire/accept all notify the team (ops-email pattern) and update the ATS
  instantly.
- Hourly cron runs reminders, expiries, and lock checks (same machinery as the
  onboarding nudge cron).

## 8. Hired → redirect everyone else (mockups v6 + v8 + v9)

- Trigger: marking any application Hired. Confirmation dialog first: *"N other GPs are
  still active on this job — send them the redirect email?"*
- Everyone else on the job in shortlisted/applied/submitted/interview →
  `not_proceeding` + redirect email. Already-`not_proceeding` GPs skipped.
- Same for a job closed/filled/withdrawn by ANY path (manual close included).
- **Redirect email** (v6): "POSITION UPDATE" chip; *"Dr <name>, the <city> position
  has been filled."*; position-filled card (practice, role, red chip); green
  reassurance box (*"This changes nothing about how the practices see you… timing
  favoured another candidate"*); "✦ Already matched for you — similar positions":
  up to 3 alternatives picked PER GP from live open jobs — same state/region first,
  then similar expected income INTERNALLY, but GP-facing tags are place/fit only
  ("Same coastal region", "Visa pathway aligned", "Family friendly") — excluding jobs
  the GP is already on; if none open, fallback line "reply and <RSO> will match you
  personally"; shiny "See all roles picked for you". NO 98% stat, NO countdown here.
- **In-app** (v8/v9): match card removed; dismissible "Position filled" notice in the
  real card language (red uppercase tag, practice name serif, one kind line);
  "Picked for you next (n)" section with alternative cards in the REAL `.role-card`
  pattern; amber ACT bell alert ("Bundaberg position filled — we've picked 2 similar
  roles for you"). No full-page takeover for bad news.

## 9. Anti-time-waster controls (owner rules, mockups v10–v12)

- **Interview cap: 3 positions per month** (calendar month), told upfront at accept
  confirm (note + meter) and at slot selection; 4th booking blocked with friendly
  explanation.
- **Application cap: 3 active at a time** (shortlisted+applied+submitted+interview);
  4th Apply disabled: "You have 3 active applications — focus on those first, or
  withdraw one."
- **Deliberate apply**: every self-apply shows the confirm sheet (interview
  commitment + caps) — kills drive-by clicking.
- **Velocity flag**: 5+ applies/day → "high application velocity" flag on the ATS
  candidate row + intent-score signal. Team-only.
- **Late withdrawal counts as a strike** (withdrawing after submit-to-practice).
- **Re-matching after a "no": allowed**, manual, with history visible.

## 10. 3-strike career lock (mockup v12 — FINAL version)

- Strike = completed interview with no acceptance (declined or withdrew), plus late
  withdrawals (§9). **3 strikes → automatic lock**: browsing roles, applying, and
  accepting matches all disabled **server-enforced** (deep links + old email buttons
  blocked); the lock page replaces My Practice; **intent score cut 50%** at lock time
  (ATS shows e.g. "62 → 31 (−50% on lock)"; CEO can restore).
- **Lock page** — EXACT `pep-pathway.html` skeleton (system font, centered white card,
  grey bg, dot-badge, hairline dividers, sign-out link). Final v12 layout:
  1. Card: amber badge "APPLICATIONS PAUSED"; h1 *"Let's talk before your next
     interview"*; two short paragraphs (three practices, real time, how to reopen).
  2. **Interviews dropdown** (collapsed by default): calendar icon, "Your last three
     interviews", amber progress line *"0 of 3 answered — tap to tell us what wasn't
     right"*, chevron, bouncing "↑ Start here" nudge; open state shows each interview
     (practice, location, date) with a reason field; answered rows get green
     "✓ Answered" chips and the header counts up ("1 of 3 answered — keep going").
  3. **"What happens next" numbered timeline** (kept from v10): 1 answer three quick
     questions → 2 book a call with the team → 3 your career page reopens.
  4. **Sticky bottom CTA**: frosted bar pinned to the viewport, button **"Book a
     call"**, subline *"Applications stay paused until this conversation happens."*
- **Wording rule: GP-facing says "book a call with the team" — never "Zoom", never
  "CEO".** (Internally it books via the existing meeting-booking machinery.)
- **Unlock**: GP submits answers + books the call → after the call the CEO taps
  **Release** in the dashboard (one-click, waitlist-release pattern). Optional
  "Restore intent score" button. Nothing reopens automatically.
- **Admin visibility** (v11 right panel, owner-required): "Interviews & strikes" panel
  in the GP's file: every interview (practice · location · date), red "DID NOT
  PROCEED" outcome, the GP's post-lock reason verbatim (or "Not provided yet"),
  header chips "CAREER LOCKED" + "STRIKES 3/3", amber bar with intent 62→31 and
  call-booked status, actions: Release career page / Restore intent score /
  View call booking.

## 11. Team Alerts redesign — app-wide (mockup v9)

The current panel in `js/updates-sync.js` (single-row bar+title+tag) is replaced
everywhere (one shared component, injected on every page):
- Serif "Team Alerts" header + "n NEW" chip + "Mark all read" + close.
- Filter chips: All / Actions / Updates / Replies.
- NEW / EARLIER groups (uppercase micro-labels).
- Items: 36px tinted line-icon square (amber=action, blue=update, green=reply/support),
  13px bold title, one-line 12px detail, kind + relative time meta, blue unread dot,
  optional inline action link ("See what's picked for you →"); unread = soft blue wash;
  read = faded. "See all updates" footer keeps the /pages/messages link behavior.
- Keep all existing behavior (localStorage store, nudge merge, badge refresh,
  mark-read, navigation) — this is a rendering upgrade, not a data change.

## 12. Cross-cutting build notes

- 98% line: keep verbatim as designed (owner decision; no admin setting needed now).
- Cache busters `?v=YYYYMMDD[letter]` on touched script tags; JS served no-cache.
- Tests: vitest; extend suite (currently ~1598 passing) — cover: eligibility filter,
  stage transitions incl. shortlisted, expiry/reminder cron, hired-redirect fan-out
  (+skip rules), caps (interview/month, active apps, velocity), strike counting +
  lock + intent −50% + release, self-apply-as-accept merge, seen tracking, no-income
  rule in reason rendering, alerts rendering.
- Anthropic model: env-pinned const (do NOT hardcode new IDs; note temperature gotcha
  on newest models — see server.js:242-246).
- Migrations via exec_sql pattern when applying to prod; schema-qualify; verify LIVE
  CHECK constraints first.
- End-to-end rule (CLAUDE.md #8): every surface traced UI → API → DB → back before
  ship.

## 13. Explicitly out of scope

- `pages/admin.html` (RSO ops dashboard) gets no Matching tab.
- No practice-facing UI changes (practice confirmation of availabilities uses the
  existing interview machinery).
- No change to job detail pages' display of terms/billing.
