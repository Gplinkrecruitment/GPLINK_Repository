# Handover — Leads tab rebuilt around Hazel (2026-10-30)

**Status:** live on `main` (this commit). Pure rules + endpoints are tested
(`tests/lead-calls-lib.test.js`, `tests/ceo-leads-endpoint.test.js`,
`tests/ceo-leads-tab-wiring.test.js`); the page was rendered in headless Chrome against
seeded data before shipping (list, drawer, schedule box, pause round-trip, mobile width).

## 1. What the owner asked for

Hazel (the Retell voice agent, `docs/lead-calls/README.md`) is about to ring **past** leads
to book consultations. The old Leads tab listed leads with chase-email counts and one line
about "AI call: voicemail · attempt 1". The owner wanted to see, per lead, how the call went,
whether the lead is burnt or unqualified, whether a follow-up call is coming, whether a
meeting got booked — and a cleaner page.

## 2. What is live

**Page** (`js/ceo-ats-leads.js`, `css/ceo-ats.css` `lead-*` block, `?v=20261030a`):

- A one-line **dialler status** strip: on/off, "rings qualified, unbooked leads up to N days
  old", attempts + spacing, whether the UK / AU numbers exist, test mode, last cron run.
  Booleans and limits only — no secret is ever sent.
- **Six tiles** (Open · Queued for Hazel · Call-backs scheduled · Called by Hazel · Booked by
  Hazel · Burnt). Clicking one sets the matching filter; clicking again clears it.
- **Stage chips** (All · Open · Booked · Signed up · Burnt · Not qualified · Never screened),
  a **Hazel select** (queued / scheduled / on a call / called / spoke / booked by Hazel / link
  sent / no answer / gave up / burnt on the call / will not ring / never called) and search
  (name, email, phone digits).
- **Rows**: avatar · lead (name, contact, flag, source, arrived, their question) · **Hazel**
  (coloured dot + plan, e.g. "Queued — next calling window · Mon 9:00 am UK", "Retry scheduled
  · after voicemail", "Call-back scheduled by you", "Gave up after 2 attempts", "Older than
  the dialler's 3-day limit — schedule a call-back to ring anyway…", "Not a GP — no more
  calls"; then the last call: outcome, attempt n of max, length, when, Hazel's one-line
  summary) · chase (consult time + "via Hazel" pill, emails + WhatsApps, stopped reason) ·
  **one stage pill** with small "Hazel paused" / "Call-back …" tags.
- **Drawer** (click a row): next step + controls, consultation details (your time and their
  time, booked by Hazel / Calendly link / phone match, completed), their question, every call
  (outcome pill, attempt, length, mood, cost; summary; "what Hazel learned": who they are,
  move timeframe, concerns raised and whether she answered them, unanswered questions, why no
  booking, call back when, notes for the consultant, script slips; "Open recording ↗";
  "Show transcript"), and the chase log.
- **Controls**: *Call now with Hazel* (confirm shows the doctor's local clock and the usual
  hours), *Schedule a call-back* (datetime, local to the viewer), *Clear call-back*, *Pause /
  Resume Hazel*, *Do not call* (confirm). A do-not-call lead gets no phone controls at all.

**Server** (`server.js`, "CEO Leads tab" section after the Retell tools; `lib/lead-calls.js`):

- `leadStage(row)` and `leadCallPlan({row, nowMs, cfg})` are pure and tested; the server
  projects them. `GET /api/ceo/leads` gained `hazel=`, `counts` (stage), `hazel_counts`,
  `tiles`, `hazel` (status). New: `GET /api/ceo/leads/:id`, `POST /api/ceo/leads/:id/call`,
  `POST /api/ceo/leads/:id/hazel`. Field list in `docs/lead-calls/README.md` → "Leads tab".
- Recording URLs are links that open in a new tab: the page CSP is `media-src 'self' blob:`,
  so an inline `<audio>` on Retell's URL would be blocked. Proxying audio through the app is
  the obvious next step if the owner wants in-page playback.

## 3. Decisions — do not "fix" these back

1. **`consult.stopped` no longer blocks the phone wholesale.** Only `do_not_call`,
   `not_interested`, `unsubscribed`, `signed_up` do (`CALL_STOP_REASONS`). `exhausted` and
   `replied` are states of the EMAIL sequence; nearly every past lead is `exhausted`, so the
   old rule would have made the past-leads campaign ring nobody.
2. **A due call-back waives the dialler's self-pacing guards** (age limit, attempt cap, retry
   spacing, screening flag, a terminal outcome such as `link_sent`) because a person asked for
   it — the doctor via Hazel's `callback_requested`, or the owner via the drawer. It never
   waives consent, the number checks, the `LEAD_CALLS_TEST_NUMBERS` allow-list or local
   calling hours (Mon–Fri 9–19:30, Sat 10–16, never Sunday, in the lead's zone).
3. **`placeLeadCall` clears `call_back_at` on every attempt, placed or failed** (keeps
   `call_back_done_at`). Otherwise a due call-back on an undialable number would retry every
   five minutes for ever, since spacing is waived.
4. **A live call blocks everything** — `call_in_progress` is now checked right after consent,
   before age/attempts, so "ring now" on an old lead shows "On the phone now" rather than
   "blocked".
5. **"Ring now" ignores age, attempts, spacing and hours** — the owner decides, the page shows
   the doctor's local time before they confirm. It still refuses do-not-call, foreign/missing
   numbers, test mode, a live call, and missing config (with the env var named).
6. **Stage chips are exclusive.** "Booked" used to include signed-up and never-screened
   bookers; now each lead sits under exactly one chip. Legacy `filter=qualified|converted`
   still answer for a browser that has not reloaded.
7. **"Burnt"** = the owner's word for "they told us to stop": unsubscribed, asked not to be
   called, not interested, or Hazel found they are not a GP. "Not qualified" = screened and
   turned down. "Never screened" = nobody asked (direct Calendly booking or plain website
   enquiry) — kept distinct on purpose (see the 2026-07 comments in the endpoint test).
8. Class names: `lead-*` only, never `ad-`/`-ad` — EasyList hides `.lead-ad` / `.lead-ads`
   and the owner's browser runs such a blocker (Ads hub lesson, 2026-10-29). The wiring test
   asserts this.

## 4. Verified data shapes

- `hazel.state` ∈ queued | scheduled | retry | in_progress | done | gave_up | burnt | blocked |
  paused | none. `hazel.due_at` is set for queued (window opens), scheduled (call-back time)
  and retry (last call + `LEAD_CALLS_RETRY_AFTER_MIN`).
- `booked_via` ∈ hazel | calendly | phone_match | '' — `hazel` when `ai_call.tool_outcome ===
  'booked'`, any history entry has outcome `booked`, or `booking_utm.source === 'ai_call'`
  (the Calendly tracking block the book-consult tool sends).
- `calls[]` in the detail: the lead's `consult.ai_calls` (always, local DB included) overlaid
  by `lead_calls` rows where `enquiry_id` is a UUID and Supabase is configured. `learned` only
  carries the post-call fields the agent is configured to extract
  (`config/retell/agent.json` → `post_call_analysis_data`; the tuning branch's list adds
  `training_finish`, `objections`, `objection_handled`, `lost_booking_reason`,
  `unanswered_questions`, `agent_slips`, all of which the drawer already renders).

## 5. Still owner-side / open

- Hazel is **not rung in production yet**: `LEAD_CALLS_ENABLED`, the Twilio UK number →
  `RETELL_FROM_NUMBER_UK` (AU later), and `LEAD_CALLS_MAX_LEAD_AGE_DAYS` for the past-leads
  campaign (default 3; the tab says so on every blocked row). Until then every row shows what
  Hazel *would* do, "Call now" returns the plain-English 503, and the status strip is red.
- Daily review routine (`docs/lead-calls/daily-routine-prompt.md`) reads Retell directly; it
  could instead read `/api/ceo/leads?hazel=called` once there is a service token — not done.
- In-page audio playback needs a same-origin proxy (CSP). Not done; recordings open in a tab.
- Bulk actions (queue / pause many leads at once) were deliberately left out: with the age
  limit raised the cron is the bulk mechanism, 5 calls per 5-minute tick.
