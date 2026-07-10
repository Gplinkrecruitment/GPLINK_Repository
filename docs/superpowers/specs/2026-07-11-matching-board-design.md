# Matching Board — glanceable funnel board + expiry nudges + richer match card

**Date:** 2026-07-11 · **Owner-approved:** 6 visual rounds (mockups in `docs/mockups/matching-board/`)
**Builds on:** the AI Matching program shipped 2026-07-07 (`docs/superpowers/specs/2026-07-06-ai-matching-design.md`). All eligibility rules, caps, strikes, emails-from-RSO-mailbox, and the 5-day window are unchanged unless stated here.

## What the owner asked for

The Matching tab (picker → ranked table) is not glanceable. Replace it with a board:
medical centres on the left with a visual (area photo) and status (time unfilled),
lines extending right through the GPs matched to each position. Plus: automatic
nudges 24h and 2h before a match expires, and a richer GP-facing match card
(website link, map, "see the full job opening" with the practice name unmasked,
sticky accept button).

## Approved design, round by round

- **R1:** "Radar rows" layout (option B) — one row per open position.
- **R2:** Inline run-AI-ranking (shimmer → results), compact GP nodes (6+ per row), detail panel under the row with reasons + tick-boxes + "Shortlist & notify".
- **R3:** KPI tiles, direction flip toggle ("Positions → GPs" / "GPs → Positions"), filter chips with live counts, area photo behind each centre card.
- **R4:** Whole funnel on the line (solid blue through pipeline GPs ordered most-progressed nearest the practice, fading to dashed for suggestions), expiring-<24h amber pulse, ranking age chip ("ranked 3d ago · ↻ refresh"), "Filled last 30 days" toggle with green rows.
- **R5:** Nudge CTAs land on the match card via the existing `?match=` deep link (auto-scroll + glow); 2h "need more time" → toast + team notified, nothing auto-extends.
- **R6:** Match card gains 🌐 website button, map preview ("Open in Maps ↗"), "See the full job opening →" (unmasked job page with website + map + why-matched), sticky Accept bar on both the career page and the job page.

---

## Part A — Board frontend (rewrite of `js/ceo-ats-matching.js`)

Same registration (MASTER_PANELS `matching`, `window.loadMatchingTab`, renders into `#panel-matching`). The picker UI is deleted; the board replaces it. Available to CEO + consultants exactly as today (requireAtsSession server-side).

### Layout, top to bottom
1. **KPI tiles** (click = apply the matching filter, click again = clear):
   - **Open positions** (count of rows)
   - **Unfilled 60+ days** (red accent)
   - **Awaiting GP reply** (live shortlisted matches, amber)
   - **Accepted this week** (match_outcome=accepted in last 7d, green)
2. **Top bar:** flip toggle `Positions → GPs` | `GPs → Positions` · filter chips with live counts (60d+, 30d+, No matches sent, Awaiting reply, state dropdown, DPA only) · sort (default: longest unfilled first) · search box (filters rows client-side by practice/GP/title) · `✓ Filled last 30 days (n)` toggle chip.
3. **Legend strip:** Offer · Interview · With practice · Awaiting reply · Expiring <24h · Suggested (not contacted).
4. **Rows** (first 25 rendered, "Show more" appends).

### Row anatomy (Positions → GPs)
- **Left block (250px):** area photo (`header_image_url`) behind a left-to-right dark fade; practice logo initials + name (click → practice file via existing open-practice) + 📍 suburb/city, state; urgency chip `N days unfilled` (red ≥60, amber ≥30, green <30 — also a 3px row edge in the same colour); position line `title · type · DPA`.
- **Track (rest of row):** the funnel line.
  - **Pipeline zone** — solid blue line. Nodes for every live application on the job (`ats_stage` in shortlisted/applied/submitted/reviewing/interview/offer), ordered most-progressed first (offer nearest the practice). Node = avatar initials + `Dr F. Surname` + stage sub-label:
    `Offer sent · awaiting sign` / `Interview · Tue 15 Jul` / `With practice · 2d` / `Awaiting · 3d left` (shortlisted matches also show the match score pill).
  - Shortlisted node extras: **expiring <24h → amber pulse** with sub-label `⏳ Expires in 14h`; after nudges are sent append `· nudged ✓`; if the GP asked for more time show `🙋 asked for more time` (amber, replaces the plain countdown).
  - **Suggestions zone** — dashed line, dimmed nodes from the latest cached AI ranking (GPs not yet contacted): avatar + name + score pill + `Suggested`. Max 6 nodes total on the line, then `+n ▸`.
  - **Age chip** at the line's end: `ranked today|Xd ago · ↻ refresh` (refresh = `force=1` re-rank, confirm dialog reminding it costs an AI run). No cached ranking and no pipeline → the line shows only `⚡ Run AI ranking`.
  - **Running state:** shimmer placeholder nodes + `🤖 Ranking N eligible GPs against this position… usually 10–20 seconds · N GPs auto-excluded (placed, mid-interview or paused)` (numbers from the response when it lands; while waiting show generic copy).
- **Click anywhere on the row (or any node)** → expand panel under the row (accordion, one open at a time):
  - Header: `RANKED MATCHES — review, tick, then notify. Nothing is sent until you click.`
  - Pipeline GPs listed first (stage pill, no checkbox), then suggestions with checkbox + score + reason ticks + situation line, per-row `Shortlist & notify` + bulk bar `Shortlist n & notify ➜` (existing POST /api/ats/matching/shortlist; server re-checks eligibility as today).
  - Per-node actions where relevant: `Extend 5 days` (existing PATCH /api/ats/application `match_extend:true`) shown for shortlisted matches expiring <24h, expired ones, and any `asked for more time`; `Open GP file` (`atsOpenCandidate`); `Open job board` (`atsOpenJobBoard`).
  - Footer: `N GPs were excluded before ranking (…) — see why` (from ranking payload) · age + `Re-run fresh`.

### Filled rows (under the toggle chip, off by default)
Green-tinted rows for jobs with `job_status='filled'` whose hired application moved to `hired` in the last 30 days: `✓ FILLED — Dr Priya Krishnan · 28 Jun` + `N other GPs redirected to similar roles · redirect emails sent ✓` (count of `match_outcome='position_filled'` rows on that job).

### GPs → Positions (flip)
Mirrored rows. Left block: GP avatar + name (click → GP file) + training/country line; urgency chip `On the books Nd · no matches sent` (red ≥21d with nothing sent, amber ≥7d, green otherwise — based on `users.created_at` and whether any match was ever sent); preference line from their stated preferences when available (`Wants: …`), else onboarding country/type. Track: live matches/applications as position nodes (practice initials + `Practice · City` + stage/score), then dashed suggestions from the GP-side cached ranking, `⚡ Run AI ranking` when empty (GET /api/ats/matching/jobs?user_id=). Same expand panel and shortlist actions. Default sort: nothing-sent + oldest first. KPI tiles stay position-centric (they describe the book of jobs) — in flip view the tiles remain but don't re-filter GP rows except "Awaiting GP reply".

### Data source — new endpoint, board never triggers AI
**`GET /api/ats/matching/board?direction=positions|gps&q=` (requireAtsSession).** One call renders the board; it must never call Anthropic. Response (positions):

```
{ ok, kpis:{open, unfilled60, awaiting, accepted_week},
  rows:[{ job:{id,title,practice_id,practice_name,city,state,suburb,type,dpa,
              header_image_url, posted, days_open, job_status},
          pipeline:[{application_id,user_id,name,ats_stage,stage_updated_at,
                     interview_at?,   // next scheduled interview when stage=interview
                     match:{score,matched_at,expires_at,seen_at,outcome,
                            reminder_sent_at,final_reminder_sent_at,
                            more_time_requested_at} | null }],
          suggestions:[{user_id,name,score,reasons,chips}],   // cached ranking minus pipeline user_ids
          ranking:{generated_at, age_hours, excluded_count} | null }],
  filled:[{job:{…}, hired:{name, at}, redirected_count}] }
```

`days_open` = whole days since `published_at || created_at`. Suggestions come from `match_cache (subject_type='job')` **regardless of age** (rows are already never deleted — serve stale, label with age). `direction=gps` mirrors the shape (`gp:{…}`, live:[…], suggestions from `subject_type='gp'`), limited to the 150 most relevant GPs (any live match/cached ranking first, then eligible GPs oldest-first; `q=` searches server-side). Reuse the ranking endpoints' pool/eligibility helpers — do not duplicate the rules.

---

## Part B — Automatic expiry nudges (24h + 2h)

Extends `/api/cron/match-lifecycle` (hourly). The existing 24h reminder pass is upgraded; a new 2h final-call pass is added. A nudge is sent at most once (stamped), and never when the match is already accepted/declined/expired.

- **24h nudge (existing pass, new copy).** Window unchanged (`match_expires_at` within 24h, `match_reminder_sent_at IS NULL`).
  - Subject: `24 hours left — {Practice Name} is holding your spot`
  - Primary CTA: **Review & accept my match** → existing deep link (`/pages/signin?next=/pages/career?match={applicationId}`)
  - Secondary text link: `Not the right fit? Tell us why` → same deep link (the card's decline flow lives there)
  - Keeps the amber urgency banner and the verbatim line `98% of GPs we match are accepted by the practice.`
- **2h final call (new pass).** `match_expires_at` within 2h, `match_final_reminder_sent_at IS NULL`, reminder pass runs first.
  - Subject: `Final call — your match expires at {h:mm am/pm} today` (format the expiry in the app's standard email timezone; if the expiry date differs from send date use "tomorrow" instead of "today")
  - Short single-purpose body (no intro video, no next-steps block), red/amber countdown chip.
  - Primary CTA: **Accept before it expires** → same deep link
  - Secondary button: **I'm interested — I need more time** → `/pages/signin?next=/pages/career?match={applicationId}%26needtime=1`
  - Stamp `match_final_reminder_sent_at` with the same checked-write pattern as the reminder stamp.
- **In-app mirror (client-side, like the existing match alert):** when career.html loads and sees a live match entering the <24h or <2h window, it pushes a one-time updates-panel alert (deduped per application+threshold in localStorage). No new server infrastructure.

### "I need more time" flow
- career.html on `?match=<id>&needtime=1`: after the card renders, POST **`/api/career/match/need-more-time` `{applicationId}`** (GP session; new endpoint) → if the match is live and unstamped: set `match_more_time_requested_at=now`, send an ops email to hello@ (subject `GP asked for more time — {GP name} × {Practice}`, body links the extend action: "Open the Matching board and hit Extend 5 days if you agree"), return `{ok, state:'noted'}`. Idempotent (already stamped → `{ok, state:'already'}`); expired/resolved → `{ok, state:'expired'|'resolved'}` and no toast.
- Toast (verbatim): **"We've let the team know you need more time. They may extend your window — watch your alerts. Accepting now still works."**
- Nothing auto-extends. The board shows `🙋 asked for more time` on the node; Extend stays a human action. Extending clears the nudge stamps and `match_more_time_requested_at` (alongside the existing outcome/stage reset) so a re-extended match gets fresh nudges.

### Migration (apply to prod via exec_sql runner, live-constraint check first)
`supabase/migrations/20260711220000_match_nudges.sql` (verify the timestamp doesn't collide with any migration on origin/main at build time; rename forward if it does):
`ALTER TABLE gp_applications ADD COLUMN IF NOT EXISTS match_final_reminder_sent_at TIMESTAMPTZ; ADD COLUMN IF NOT EXISTS match_more_time_requested_at TIMESTAMPTZ;` + PostgREST reload.

---

## Part C — Richer GP match card + unmasked job opening

### Match card on career.html (design R6)
Existing pinned card keeps photo header, badge, title/location, countdown chip, reason ticks, decline link, 98% line — and gains, in order under the ticks:
1. **`🌐 Visit website`** button — only when the practice website is known (`/api/career/matches` already returns `website`); opens in a new tab.
2. **Map preview** — Google Maps embed iframe (`https://maps.google.com/maps?q={encoded practice address or "practice_name, city state"}&output=embed`, lazy-loaded), with an `Open in Maps ↗` overlay linking the same query to the Maps site/app. Requires `/api/career/matches` to also return the practice address/map query for live matches (same value `/api/career/role` exposes as `revealedMapQuery`).
3. **`See the full job opening →`** row → `/pages/job.html?id={roleId}&match={applicationId}`.
- **Sticky accept bar:** while at least one live match card exists, a sticky bar pins above the shell nav (respect `--gp-shell-bottom-clearance`): shiny **Accept this match** + sub-line `⏳ {time left} — your spot is reserved until then`. Tapping opens the existing confirm sheet for the (topmost/deep-linked) match. Bar hides when no live match or after respond.

### Job page (job.html) for a matched GP
A matched GP already passes the reveal gate (shortlist sets `revealed:true`). Changes:
- **Fix (server):** the shortlist **reopen** branch must also set `revealed: true` (today only fresh inserts do).
- **`/api/career/role`** additionally returns `website` when revealed (it already returns `realPracticeName`, `practiceAddress`, `revealedMapQuery`; website today only exists on `/matches` — close the gap; source: `practices.website` or `extractCareerWebsiteUrl(source_payload)` same as matches).
- job.html when revealed shows: real practice name (exists), `🌐 {website} ↗` link, map embed (same pattern as the card), and — when arriving with `&match={applicationId}` that maps to a live shortlisted match — a blue banner (verbatim): *“Your team matched you here for a reason — this page normally hides the practice name, but your match unlocks the full picture.”*, a "Why this matches you" tick list (from the match's `match_reasons`), and a **sticky Accept bar** identical to the career one. Accepting from here uses the existing self-apply-merge path (self-apply on a matched job = accepting the match) via its confirm sheet, relabelled **Accept this match** with the countdown sub-line.
- Non-matched GPs see exactly what they see today (masked). No public/`atsJobCard` changes.

---

## Part D — Copy blocks (verbatim, do not reword)

- Board empty line: `⚡ Run AI ranking`
- Running: `🤖 Ranking {N} eligible GPs against this position… usually 10–20 seconds`
- Age chip: `ranked today · ↻ refresh` / `ranked {X}d ago · ↻ refresh`
- Expiring node: `⏳ Expires in {X}h` (+ ` · nudged ✓` once final nudge sent)
- More-time node: `🙋 asked for more time`
- Filled row: `✓ FILLED — {Dr Name} · {D Mon}` / `{N} other GPs redirected to similar roles · redirect emails sent ✓`
- Panel header: `RANKED MATCHES — review, tick, then notify. Nothing is sent until you click.`
- Bulk bar: `{n} selected` · `each gets the match email + 5-day window · moves to Shortlist stage` · `Shortlist {n} & notify ➜`
- 24h subject: `24 hours left — {Practice Name} is holding your spot` · CTA `Review & accept my match` · secondary `Not the right fit? Tell us why`
- 2h subject: `Final call — your match expires at {h:mm am/pm} today` · CTA `Accept before it expires` · secondary `I'm interested — I need more time`
- Need-more-time toast: `We've let the team know you need more time. They may extend your window — watch your alerts. Accepting now still works.`
- Job-page banner: `Your team matched you here for a reason — this page normally hides the practice name, but your match unlocks the full picture.`
- Sticky bar sub-line: `⏳ {time left} — your spot is reserved until then`
- The 98% line stays verbatim everywhere it already appears: `98% of GPs we match are accepted by the practice.`

## Part E — Non-goals / explicitly out of scope

- No admin notifications subsystem (team signals stay: ops emails + board badges).
- No auto-extend; no changes to eligibility rules, caps, strikes, redirect fan-out, or the 5-day window.
- No WhatsApp nudges. No changes to public/marketing job payloads or masking for non-matched GPs.
- No Google Maps API key (embed + link only). No changes to the Practices tab grid.

## Part F — Testing & rollout

- Vitest coverage in the style of `tests/ai-matching-*.test.js`: board endpoint (shape, days_open math, stale-ranking served with age, suggestions exclude pipeline user_ids, gps direction, q search, filled rows), cron final-call pass (window math, stamping, no double-send, skip resolved), need-more-time endpoint (live/stamped/expired paths + ops email), respond/extend clearing the new stamps, /role website-when-revealed, reopen-sets-revealed fix.
- Frontend: cache-buster bumps on ceo-dashboard script tags (and sw.js CORE_URLS if pinned); board rewrite keeps `window.loadMatchingTab` name.
- Prod DDL via the exec_sql runner (read live constraints first — they have drifted before), PostgREST reload, verify columns via probe read.
- Ship: commit per task, full suite green, push to origin/main (auto-deploys), verify Vercel READY + smoke-check.
