# Handover — GP funnel (Facebook ad → sign-up → placement)

**Date:** 2026-07-18
**Session branch:** `worktree-gp-funnel-resume` (all work MERGED to `main`, HEAD `65d9ec2`)
**Working mode:** ship straight to `origin/main` (Vercel auto-deploys prod in ~60s)
**Author context:** resumed the Meta-ads GP funnel work from 14–15 July; this session verified it,
fixed a live 404, proved the browser flow, and closed two dashboard-visibility gaps the owner hit
while testing it live.

---

## 1. TL;DR — what state is the funnel in?

The **GP-facing funnel is feature-complete and verified working**, end to end, in a real browser
against production. A doctor can: click a Facebook ad → land on `/start` → be screened → book a
Calendly consult (real bookable times for UK doctors) → the booking now appears in the CEO
dashboard **Meetings** tab with full context → and every lead is visible in a new **Leads** tab.

**Not yet done (none blocking a soft launch):**
1. The **Facebook lead-form webhook is still 503** — three Vercel env vars unset. Ads sending
   traffic straight to `/start` work without it.
2. **`/favicon.ico` → 404** on `/start` — cosmetic (blank browser-tab icon).
3. **The auto-create path has never caught a REAL booking.** Khaleed's meeting is in the tab
   because I backfilled it by hand from his Calendly email. The code that creates it
   automatically is tested but unproven against a live webhook. **This is the one thing worth
   proving before ad spend** (see §7).
4. **3 pre-existing test failures** on main, none in the GP funnel, another session owns them.

---

## 2. The funnel, stage by stage (all traced from code / proven in prod)

| Stage | Route / mechanism | State lands in | Verified? |
|---|---|---|---|
| FB lead form (Door A) | `POST /api/webhooks/facebook-lead` (GP branch, `FB_GP_LEAD_FORM_IDS`) | `site_enquiries` kind=gp source=`meta_lead_ad` | **503 — envs unset** |
| Direct click (Door B) | `/start` → `POST /api/public/consult-lead` | source=`site_start_form` + utm | ✅ live |
| Screening | `screenConsultLead` — registered GP AND country ∈ uk/ie/nz | `metadata.consult.qualified` | ✅ proven on 3 real 15-Jul leads |
| Book a call | Calendly embed → `POST /api/public/consult-lead/booked` | `call_booked`, status `contacted` | ✅ browser + prod smoke |
| Chase (nudges) | `/api/cron/consult-nudge` @ `20 * * * *`; 2h/48h (not booked), 3d/7d (booked, no signup) | `metadata.consult.nudges[]` | ✅ **real cron → Resend → inbox, 16 Jul 13:20 UTC** |
| Sign up | `/pages/signin?signup=1&email=` | Supabase auth; cron stamps `converted` | ✅ live |
| Onboarding | `/pages/onboarding` — 5 steps | `user_state.gp_onboarding` | ✅ (404 fix, §3) |
| Journey | career → myintealth → amc → ahpra → visa → **pbs** (commencement VAULTED) | `registration_cases` | ✅ 6 visible stages |
| Placement | `finalizeInAppPlacement` → `gp_applications.status='placement_secured'` | that column is the source of truth | traced, not e2e'd |

**Screening truth:** `qualified` (asked + passed) ≠ `screened_out` (asked + failed) ≠ `not_screened`
(never asked — booked Calendly directly). All three are nudge-INELIGIBLE (cron only emails
`qualified===true`); only the middle one is a rejection. This distinction is load-bearing in the UI.

---

## 3. What shipped this session (10 commits, `254412b`..`65d9ec2`)

### a) BUG FIX — onboarding email 404 (`0119dbb`) — the important one
The first email a GP receives after finishing onboarding ("Profile Complete") had its
**"Start MyIntealth" button pointing at `/pages/myintealth.html`** — the real file is
`pages/myinthealth.html` (no `h` after `myint`). **Every GP who completed onboarding hit
"Not found" on their very next step.**

- **Why it hid:** `/pages/x.html` 302s to the clean `/pages/x` *before* any file check, and the
  auth gate then bounces anonymous requests to `/pages/signin`. So the link looks alive when
  logged out — only a **signed-in** GP sees the 404. Reproduce with `AUTH_DISABLED=true node server.js`:
  emailed URL → 404, correct spelling → 200.
- **The naming trap:** the server's stage key genuinely *is* `myintealth` (PAGE_STAGE_MAP value,
  WhatsApp templates) while the file *is* `myinthealth.html`. Both spellings live in the codebase,
  so the typo reads as correct. `mapRegistrationPath` rescues both spellings but ONLY for
  `/registration/*` paths, so it never covered this `/pages/` link.
- **Guard shipped:** `tests/email-cta-links-resolve.test.js` — every `/pages/*.html` URL built from
  `APP_BASE_URL`/`CONSULT_START_BASE` in server.js must exist on disk. Verified it FAILS on the bug.
- Memory: `onboarding-email-myintealth-404`.

### b) Calendly unmatched-booking fix (`0b4b1c5`) — the owner's "why isn't Khaleed in Meetings"
`handleCalendlyInviteeCreated` only ever UPDATED a pre-existing `scheduled_calls` row (the RSO
invite flow creates one with status=`invited` first). A `/start` booking is unsolicited → no
waiting row → it hit the bail-out and `return`ed. Proven from prod logs:
`[calendly invitee.created] No matching scheduled_call for email: ... | token: null`.

Now it CREATES the row. **Two traps that silently defeat a naive fix:**
- `host_kind` MUST be `'ceo'` — the Meetings read path scopes
  `or=(host_kind.eq.ceo,assigned_rso_email.eq.<session>)` and the column DEFAULTS to `'rso'`, so a
  row on the default saves fine and is invisible in the tab.
- `correlation_token` is `NOT NULL UNIQUE` — generate via `generateCorrelationToken()`.

Also captures the booker as a lead (via `buildConsultLeadRow`) but deliberately **unqualified** +
`not_screened:true` (owner asked to capture ANY booking; leaving them unqualified keeps a practice
owner off the GP nudge sequence). `gp_name` resolved from `site_enquiries` by `invitee_email` in one
batched query — the exact `or=(email.ilike.…)` shape was verified against live prod.

### c) CEO Leads tab (`6bc8093`) — leads had NO dashboard UI at all
`site_enquiries` (consult leads) had no UI — the old "Website" tab was removed; `listSiteEnquiryRows`
fed only the CSV export + nudge cron. Ad leads would have been invisible. Added `GET /api/ceo/leads`
(`requireCeoSession`) + `js/ceo-ats-leads.js`. Explicit field projection — **`metadata.ip` /
`user_agent` NEVER returned** (mutation-tested). Plain-English badges: Signed up / Call booked /
Qualified, no call yet / Not qualified / **Never screened**.

### d) Meeting detail panel (`e9feb2a`) — the owner's "I can't see what the GP said"
The Meetings row was just name/kind/time/status. Now it EXPANDS (click the row) to show, in plain
words: what they told us (GP? / country / where from), their question, their Calendly booking notes,
clickable email + `tel:` phone, call length, timezone.
- `invitee_notes` was ALREADY in the API (`select=*`) — the renderer just never drew it.
- The lead's answers weren't fetched — widened the existing batched lookup's `select` (still ONE
  query). `_mtgLeadProjection` names every field; `metadata` is never spread. Privacy test was
  passing VACUOUSLY (fixture had no ip) — now carries a real one.
- **Scope limit:** the prod lead lookup only covers rows with NO `user_id` (the pre-existing email
  set). A GP who already has an account AND came through the funnel won't get the panel in prod.
  Fine for ad leads (all pre-signup). Follow-up if wanted.

### e) Test debt / housekeeping (`254412b`, `7246e25`, `5a78cc7`, `b28f3fe`, 2 merges)
- Link-audit allowlist gained Google Fonts + the `/visa` page.
- 25 stale marketing-test assertions refreshed (redesign left them pinned to old busters/copy).
- `site.css` buster followed 20260715b → 20260717a (concurrent marketing fix).
- Visual flow map: `docs/mockups/gp-flow-map.html` (4 acts, code-traced, links open localhost pages).

---

## 4. ⚠️ Traps & gotchas the next session MUST know

1. **JS is NOT served no-cache** — CLAUDE.md is WRONG about this. Measured:
   `Cache-Control: public, max-age=3600, must-revalidate`. You MUST bump the `?v=YYYYMMDD[letter]`
   buster in the `<script>`/`<link>` tag when you edit a `/js/` or `/css/` file, or returning owners
   run the OLD file for up to an hour and never see your change. Then **grep `tests/` for the old
   buster** — several tests pin busters EXACTLY. Known pins: `ceo-ats-meetings.js`→`ats-interview-mgmt`,
   `ceo-ats.css`→`matching-board-ui`, `site.css`/`site.js`→3 site tests. Memory: `js-cache-buster-really-matters`.
2. **Real browser IS available** — Chrome is installed (`/Applications/Google Chrome.app`). Screenshot
   via `--headless=new`; CLICK via `puppeteer-core` installed to a TEMP dir (NOT the repo). This
   session used it to prove the Calendly embed, the Leads tab, and the meeting panel. Memory:
   `browser-clickthrough-is-possible`. Gotchas: a 404 is NOT a `requestfailed` (use
   `page.on('response', r=>r.status()>=400)`); iframes mount lazily behind a click.
3. **CEO dashboard is host-gated** — `/pages/ceo-dashboard.html` 404s on plain localhost
   (server.js ~59290, needs a super-admin host). To view locally:
   `AUTH_DISABLED=true AUTH_SECRET=<any> SUPER_ADMIN_ALLOWED_HOSTS=localhost node server.js`, mint a
   `gp_admin_session` cookie (HMAC-sha512 over the payload with that AUTH_SECRET — see
   `tests/ceo-meetings-endpoints.test.js:31-45`), and hit the **clean URL** `/pages/ceo-dashboard`
   (the `.html` form 302s away).
4. **Prod `AUTH_SECRET` ≠ local `.env` `AUTH_SECRET`.** A locally-minted admin cookie is REJECTED by
   production (correct). So Claude CANNOT call authenticated prod `/api/ceo/*` or `/api/admin/*` —
   only the owner can visually confirm dashboard renders. Read-only DB checks go through the Supabase
   service key (in `.env`, NOT `.env.prod`).
5. **`.env` points at PROD Supabase.** Local dev with `.env` present hits prod. The worktree has no
   `.env` (gitignored) so `npm run init:db` + `node server.js` uses the local JSON db — safe by default.
   Any prod DB probe/seed must clean up after itself (this session seeded + deleted several test leads).
6. **No system node / npm / gh / vercel CLI.** Temp node: `/tmp/node-v20.18.1-darwin-arm64/bin/node`
   (re-download if missing). Push via SSH deploy key: `GIT_SSH_COMMAND="ssh -i ~/.ssh/gplink_deploy
   -o IdentitiesOnly=yes"`. Verify prod deploys via the Vercel MCP (project `prj_LeHg7obiXjySqpjR23S46QmwSLXJ`,
   team `team_CZsGx8ESlTxQ3Uc9sHG23vCY`). `timeout` command does NOT exist on this mac.
7. **`Date.now()` in bash prints colour codes** that break `$(( ))` arithmetic — grab the number
   cleanly. (Cost two wrong Vercel `since` timestamps this session — future-dated, returned empty.)

---

## 5. Test baseline (do NOT mistake these for regressions)

At session end, full suite = **3077 pass / 3 fail** (was 5; the practice-intake merge fixed 2). The
3 remaining fail on unmodified `main` and are NOT GP-funnel:
- `tests/eligibility-waitlist.test.js` — "never says bare RSO"
- `tests/onboarding-review-roundtrip.test.js` — "cache buster bumped"
- `tests/practice-status-page.test.js` — sign endpoint 400≠200

Always diff a suspected failure against a clean baseline worktree
(`git worktree add --detach <dir> origin/main` + symlink node_modules) before calling it yours.
Failure COUNT is slightly flaky run-to-run (5↔6) — some are timing-sensitive.

---

## 6. Prod verification done this session (evidence, not assertion)

- **Nudge send proven LIVE** — seeded a backdated lead; the REAL Vercel cron fired the 2h email at
  16 Jul 13:20:47 UTC and Resend delivered at 13:20:48 (verified via Gmail MCP). NOT manually triggered.
- **`/start` browser click-through** — all 6 booking states; Calendly iframe MOUNTS + LOADS (read
  inside the frame: "Finding The Perfect Australian Practice · 30 min" + live date grid);
  **ZERO CSP violations**; 375px no overflow. Only defect: `/favicon.ico` 404.
- **UK availability** — with `Europe/London` timezone genuinely applied, a UK doctor sees 11 bookable
  days, times 1:00–4:30pm UK. The spec's "empty calendar" worry is resolved.
- **§7 smoke test (spec)** — `metadata->consult->>token` lookup + `updateSiteEnquiryRow` PATCH proven
  against prod; token/qualified/nudges preserved. (POST /booked needs an `Origin` header or 403s.)
- **DPA blur risk GONE** — 57/58 active roles `dpa=true` (was 47/49 wrong on 5 Jul; the Zoho sync that
  clobbered it is decommissioned).
- **Meeting panel** — browser-verified with Khaleed's real prod shape; IP + user-agent canary did NOT
  reach the response.

---

## 7. Owner action list (in priority order)

1. **Run the live end-to-end test** (the real proof the auto-create path works — Khaleed was
   hand-backfilled). Use a FRESH `+alias` you control, NOT `hello@` (that's a registered user, so the
   lead instantly converts and NO nudge fires). Steps:
   - Phone → `https://app.mygplink.com.au/start?src=fb#book` (what an ad click does)
   - Fill as a UK GP → you should get the calendar, not the turndown
   - Book a real slot → **it should appear on its own in Meetings → Standard consultation, name +
     details resolved, WITHOUT anyone touching the DB.** Cancel the slot after.
   - (Optional) don't book, wait for the 2h nudge at :20 past the hour to prove the chase.
2. **Open the Facebook door** (only if running FB lead-form ads, vs. ads → `/start` directly): set
   `FB_LEAD_WEBHOOK_SECRET`, `FB_LEAD_VERIFY_TOKEN`, `FB_GP_LEAD_FORM_IDS` in Vercel; point Meta's Lead
   Ads webhook at `/api/webhooks/facebook-lead?secret=…`. Ads must use the **`app.`** host until the
   www DNS cutover (apex still serves the legacy site).
3. **Fix the favicon 404** (cosmetic, but it's the ad landing page) — small polish task.
4. **Check Calendly availability maps to UK hours** — confirmed there ARE UK-friendly slots today;
   keep it that way (their 9am–12pm ≈ owner 6–10pm AEST).

---

## 8. Known follow-ups / smaller debt

- Sign-up doesn't write back to the lead row — conversion is discovered lazily by the cron, so
  unsubscribed-then-signed-up is never counted `converted` (funnel stats under-report).
- Offer path has NO interview gate — a GP can be placed with no interview booked (may be deliberate;
  flagged, not changed).
- `kind='gp'` in `site_enquiries` also covers plain website-enquiry rows with no `metadata.consult`
  — the Leads/Meetings UI renders those as "Never screened" (inaccurate for a website enquiry).
- Meeting detail panel doesn't cover funnel leads who already have an account (prod lookup is
  no-`user_id` only).
- `/start` could send `utm_content=call_<token>` so future funnel bookings MATCH by token instead of
  needing the create path (would make the whole Calendly fix moot for funnel traffic — nice-to-have).
- `handleScheduledCallFailure` on cancel of a null-case/user row is UNVERIFIED.
- Onboarding: stale "7-stage" comments (it's 6), `isSkippable()` dead-returns false, nudge step
  labels drift from the real wizard steps. Cosmetic.

---

## 9. Key files

| Area | File |
|---|---|
| Everything routes through | `server.js` (~60k lines — targeted greps only) |
| Consult funnel logic | `lib/consult-lead.js`, `pages/site-start.html` |
| Calendly webhook | `handleCalendlyInviteeCreated` (server.js ~17819) |
| Meeting builder | `buildScheduledCallFromCalendly` in `lib/interview-meetings.js` |
| Meetings tab | `js/ceo-ats-meetings.js`, `GET /api/ceo/meetings` |
| Leads tab | `js/ceo-ats-leads.js`, `GET /api/ceo/leads` |
| Onboarding | `js/onboarding.js`, `sendOnboardingCompleteEmail` (server.js ~25627) |
| Flow map | `docs/mockups/gp-flow-map.html` |
| Specs | `docs/superpowers/specs/2026-07-14-meta-ads-gp-funnel-design.md` |

## 10. Related memories
`meta-ads-gp-funnel` · `onboarding-email-myintealth-404` · `calendly-unmatched-booking-and-leads-tab` ·
`js-cache-buster-really-matters` · `browser-clickthrough-is-possible` · `onboarding-resume-reject-deeplink` ·
`preview-branch-working-mode` · `machine-environment-quirks`
