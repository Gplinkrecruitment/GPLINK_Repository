# Lead calls: Hazel on Retell AI (developer overview)

Fresh GP leads (website enquiry form or Meta lead ads, rows in `site_enquiries`)
get an outbound phone call from "Hazel", an AI voice agent hosted on
[Retell AI](https://docs.retellai.com). Hazel qualifies the doctor, books the
consultation with the director straight into Calendly, or sends the booking
link. Everything the app does is deterministic and tested; Retell owns the
telephony, speech and the LLM conversation loop.

## Architecture

```
site_enquiries row (POST /api/public/enquiry, Meta lead webhook)
        │
        │  every 5 min  (vercel.json cron)
        ▼
GET /api/cron/lead-calls ──► lib/lead-calls.leadCallDecision()
        │                    local calling window, lead age, attempts,
        │                    stopped flags, LEAD_CALLS_TEST_NUMBERS allow-list
        ▼
POST api.retellai.com/v2/create-phone-call
   { from_number (by country), to_number, override_agent_id,
     metadata { enquiry_id }, retell_llm_dynamic_variables }
        │
        ▼                       Twilio SIP trunk (number imported into Retell)
   Retell ────────────────────────────────────────────► the doctor's phone

   Retell ──► POST /api/webhooks/retell   call_started / call_ended / call_analyzed
                 │  X-Retell-Signature (HMAC, 5-min window) verified first
                 ├─► site_enquiries.metadata.consult.ai_call / ai_calls   (compact)
                 └─► public.lead_calls                                    (full record)

   Hazel's mid-call tools (Retell ──► app, same signature check):
     POST /api/retell/tools/check-availability ──► Calendly available_times ──► 2–3 spoken slots
     POST /api/retell/tools/book-consult       ──► Calendly POST /invitees   ──► booked
     POST /api/retell/tools/send-booking-link  ──► email + WhatsApp with the Calendly link
     POST /api/retell/tools/mark-outcome       ──► consult.ai_call.tool_outcome
```

| Piece | Where |
| --- | --- |
| Pure rules (window, decision, variables, outcome mapping, Calendly slot picking) | `lib/lead-calls.js`, tests in `tests/lead-calls-lib.test.js` |
| Routes: cron, webhook, four tool endpoints | `server.js`, tests in `tests/lead-calls-endpoints.test.js` |
| Cron schedule | `vercel.json` (`/api/cron/lead-calls`) |
| Agent definition (prompt, voice/behaviour settings, post-call analysis) | `config/retell/hazel-prompt.md`, `config/retell/agent.json` |
| Provisioning CLI | `scripts/retell-setup.js`, tests in `tests/retell-setup-script.test.js` |
| Retell ids for this environment (gitignored, ids only) | `config/retell/state.json` |
| Full call records | `supabase/migrations/20261027120000_lead_calls.sql` (`public.lead_calls`) |

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `LEAD_CALLS_ENABLED` | Master switch for the cron. Anything but `true` means the cron only logs. | off |
| `RETELL_API_KEY` | Retell API key. Signs webhooks/tool calls too (HMAC secret). | required |
| `RETELL_AGENT_ID` | The published Hazel agent (`agent_...`) the cron dials with. | required |
| `RETELL_FROM_NUMBER_UK` | E.164 number imported into Retell, used for UK and Irish leads. | required for uk/ie |
| `RETELL_FROM_NUMBER_AU` | E.164 number used for Australian and New Zealand leads. | required for au/nz |
| `LEAD_CALLS_MAX_ATTEMPTS` | Calls per lead before giving up (no-answer / voicemail / failed count). | `2` |
| `LEAD_CALLS_RETRY_AFTER_MIN` | Minutes between attempts. | `180` |
| `LEAD_CALLS_MIN_LEAD_AGE_MIN` | Do not ring a lead younger than this (lets the confirmation email land first). | `3` |
| `LEAD_CALLS_MAX_LEAD_AGE_DAYS` | Launch guard: never ring leads older than this (no back-catalogue). | `3` |
| `LEAD_CALLS_PER_RUN` | Max calls placed per cron tick. | `5` |
| `LEAD_CALLS_TEST_NUMBERS` | Comma-separated E.164 allow-list. When set, ONLY these numbers are ever dialled. | unset (= everyone) |
| `LEAD_CALLS_IGNORE_HOURS` | Test-only: skip the calling-hours check. Honoured ONLY when `NODE_ENV=test`; ignored in production. | unset |
| `LEAD_CALLS_DIRECTOR_NAME` | Spoken as `{{director_name}}` ("a consultation with ..."). | `our director` |
| `LEAD_CALLS_AGENT_NAME` | Spoken as `{{agent_name}}`. | `Hazel` |
| `LEAD_CALLS_TRANSFER_NUMBER` | E.164 number for the warm `transfer_to_team` tool. Unset = no transfer tool. | unset |
| `CALENDLY_API_TOKEN` | Calendly personal access token (availability + invitee creation). | required for booking |
| `CALENDLY_EVENT_TYPE_URI` | `https://api.calendly.com/event_types/<uuid>` of the consultation event type. | required for booking |
| `CALENDLY_LOCATION_KIND` | Optional `location.kind` sent when booking (e.g. `zoom_conference`); unset = event type default. | unset |
| `APP_BASE_URL` | Used for the webhook and tool URLs baked into the agent. | `https://app.mygplink.com.au` |
| `RETELL_API_URL` | Test override for `https://api.retellai.com` (endpoint tests point it at a local emulator). | Retell |
| `CALENDLY_API_BASE` | Test override for `https://api.calendly.com`. | Calendly |

Calling hours are fixed in `lib/lead-calls.js` (`CALL_WINDOWS`): Mon–Fri 09:00–19:30,
Sat 10:00–16:00, never Sunday, always in the lead's own timezone
(`gpTzForCountry`: uk → Europe/London, ie → Europe/Dublin, nz → Pacific/Auckland, au → Australia/Sydney).

## Lead state (`site_enquiries.metadata.consult`)

```jsonc
{
  "qualified": true, "country": "uk",            // existing consult-funnel fields
  "ai_call": {                                   // the latest call (what the cron looks at)
    "call_id": "call_abc", "attempt": 1, "status": "ended",      // placed | ongoing | ended
    "started_at": "...", "answered_at": "...", "analyzed_at": "...",
    "from_number": "+44...", "outcome": "booked", "tool_outcome": "booked",
    "duration_s": 212, "disconnection_reason": "agent_hangup",
    "summary": "...", "sentiment": "Positive", "recording_url": "...",
    "callback_note": "tomorrow after 2pm", "gp_status": "gp", "timeframe": "...", "notes": "..."
  },
  "ai_calls": [ { "...one entry per completed attempt, last 10..." } ],
  "stopped": "do_not_call",                      // or "not_interested" (plus the pre-existing values)
  "calls_paused": true,                          // owner paused Hazel for this lead (Leads tab)
  "call_back_at": "2026-11-03T17:00:00.000Z",    // owner-scheduled call-back; consumed when placed
  "call_back_done_at": "..."                     // the call_back_at that was consumed
}
```

Outcomes (`OUTCOMES` in `lib/lead-calls.js`): `booked`, `link_sent`, `callback_requested`,
`not_interested`, `not_a_gp`, `wrong_number`, `do_not_call`, `already_booked`, `transferred`
are terminal (never ring again); `voicemail`, `no_answer`, `failed`, `unclear` count as an
attempt and retry after `LEAD_CALLS_RETRY_AFTER_MIN`. A tool-stamped `tool_outcome` always
beats the post-call analysis. `do_not_call` / `not_interested` also set `consult.stopped`.
The full transcript, recording, analysis JSON and cost go to `public.lead_calls` (one row per
`call_id`, `enquiry_id` back to the lead).

**Which `consult.stopped` values stop the phone** (`CALL_STOP_REASONS`, 2026-10-30):
only `do_not_call`, `not_interested`, `unsubscribed` and `signed_up`. The nudge cron's
`exhausted` (every chase email went) and `replied` describe the email sequence, not the
person's consent, so those leads stay ringable — they are exactly who the past-leads
calling campaign is for.

**Owner call-backs** (`consult.call_back_at`, set from the Leads tab): the dialler waits for
the time, then rings even if the lead is older than `LEAD_CALLS_MAX_LEAD_AGE_DAYS`, has used
its attempts, is inside the retry spacing, has a terminal outcome such as `link_sent`, or was
never screened. It never overrides consent (`stopped`), a missing/foreign number, the
`LEAD_CALLS_TEST_NUMBERS` allow-list or local calling hours. `placeLeadCall` clears
`call_back_at` on every attempt (placed or failed) so a bad number cannot loop. Hazel's own
`callback_requested` + `callback_at`, once due, likewise ignores the age guard.
`consult.calls_paused` skips the lead until the owner resumes it.

## Leads tab (CEO dashboard)

`js/ceo-ats-leads.js` (rebuilt 2026-10-30) shows every GP lead with one stage badge, a
Hazel column and the owner's controls. Pure helpers in `lib/lead-calls.js`:

| Helper | Returns |
| --- | --- |
| `leadStage(row)` | `{ key, label, mod, reason }` — `signed_up`, `unscreened`, `booked` (label "Consult done" once `call_completed_at` is set), `burnt` (unsubscribed / asked not to be called / not interested / not a GP), `not_qualified`, `open` |
| `leadCallPlan({ row, nowMs, cfg })` | `{ state, label, detail, due_at, reason }` — `queued`, `scheduled`, `retry`, `in_progress`, `done`, `gave_up`, `burnt`, `blocked`, `paused`, `none`; `reason` is the `leadCallDecision` skip reason |
| `nextCallWindowStart(nowMs, tz)` | first ms at/after `nowMs` inside the calling window (15-min grid, 7 days out) |

Endpoints (all `requireCeoSession`; tests in `tests/ceo-leads-endpoint.test.js`):

| Route | Purpose |
| --- | --- |
| `GET /api/ceo/leads?filter=&hazel=&q=&limit=&offset=` | projected leads (`stage`, `hazel.{state,label,detail,due_at,attempts,max_attempts,spoke,booked,last}`, `booked_via`, `calls_paused`, `call_back_at`, …), `counts` per stage chip, `hazel_counts` per Hazel filter within the stage, `tiles`, and `hazel` = dialler status (booleans + limits + last cron run, never a secret). `filter`: all, open, booked, signed_up, burnt, not_qualified, unscreened (legacy qualified/converted still answer). `hazel`: any, queued, scheduled, in_progress, called, spoke, booked, link_sent, no_answer, gave_up, burnt, blocked, not_called. `q` matches name, email or phone digits. |
| `GET /api/ceo/leads/:id` | `lead` + `calls` (the lead's `ai_calls` history overlaid with `lead_calls` rows: transcript, recording_url, cost, `learned` = the post-call analysis fields by name) + `chase` (nudges + WhatsApp) |
| `POST /api/ceo/leads/:id/call` | ring now via `placeLeadCall` (source `ceo-manual`). Refuses: Retell not configured (503), no usable phone / foreign number (400), test-mode allow-list (409), `stopped = do_not_call` (409), a call already live (409), no from-number for the country (503). Age, attempts, spacing and hours are the owner's call — the page shows the doctor's local time before confirming. |
| `POST /api/ceo/leads/:id/hazel` | `{ action: pause \| resume \| schedule (+ `at` ISO, future, ≤ 1 year) \| unschedule \| do_not_call }`; `schedule` also clears a pause; `do_not_call` sets `consult.stopped` |

To ring the back-catalogue: set `LEAD_CALLS_MAX_LEAD_AGE_DAYS` high enough (the tab's
status line and every blocked row say what the current limit is), `LEAD_CALLS_ENABLED=true`,
and the from-numbers. Or schedule call-backs lead by lead from the drawer.

## Provisioning (`scripts/retell-setup.js`)

Run from the repo root with Node 20+. The script loads `<repo>/.env` (or `--env <path>`),
needs `RETELL_API_KEY`, and keeps the resulting ids in `config/retell/state.json`.
On any non-2xx it prints the HTTP status and body and exits 1.

```
node scripts/retell-setup.js --help
node scripts/retell-setup.js clone-voice --dir ~/hazel-samples --name "Hazel" [--files 03,05]
node scripts/retell-setup.js create   [--voice-id <id>] [--dry-run]
node scripts/retell-setup.js update   [--dry-run]           # after editing config/retell/*
node scripts/retell-setup.js publish  [--version <n>]
node scripts/retell-setup.js import-number --number +44... --termination-uri gplink.pstn.london.twilio.com --username <u> --password <p> --nickname "UK outbound"
node scripts/retell-setup.js list-numbers
node scripts/retell-setup.js list-voices --query hazel
node scripts/retell-setup.js get-agent [--json]
node scripts/retell-setup.js test-call --to +44... --name "Test Doctor" --country uk
```

Order for a new environment: `clone-voice` → `create` → set `RETELL_AGENT_ID` (and the
from-numbers) in Vercel → `publish` → `import-number` → `test-call`. `create` builds the
Response Engine (`POST /create-retell-llm`: prompt + `llm` block + the tool list from
`buildTools`) and then the Agent (`POST /create-agent`: `agent` block + `response_engine`,
`webhook_url = APP_BASE_URL/api/webhooks/retell`, `webhook_events`, `voice_id`, top-level
`post_call_analysis_data`). `update` PATCHes both in place and creates new draft versions;
Retell only uses a version for calls once it is published, so run `publish` after every
`update`. `agent.json` may write `model_config.primary` as a plain model name; the script
converts it to the `{ model }` object the API expects.

Tool endpoints Hazel calls (all `POST`, `timeout_ms` 20 s, `X-Retell-Signature` checked):

| Tool | Path | Arguments |
| --- | --- | --- |
| `check_availability` | `/api/retell/tools/check-availability` | `preferred_day?` (today / tomorrow / weekday / YYYY-MM-DD), `time_of_day?` (morning / afternoon / evening / any) |
| `book_consult` | `/api/retell/tools/book-consult` | `slot_id` (from check_availability), `email?` |
| `send_booking_link` | `/api/retell/tools/send-booking-link` | none |
| `mark_outcome` | `/api/retell/tools/mark-outcome` | `outcome` (callback_requested / not_interested / not_a_gp / wrong_number / already_booked), `callback_hours?`, `note?` |

Plus Retell-native `end_call` and, only when `LEAD_CALLS_TRANSFER_NUMBER` is set, a warm
`transfer_call` named `transfer_to_team`.

## Applying the migration

`supabase/migrations/20261027120000_lead_calls.sql` creates `public.lead_calls` (RLS on,
service-role-only policy, indexes on `enquiry_id` and `started_at desc`, `updated_at`
trigger). Until it is applied the webhook still updates the lead's `consult` blob; only the
full-record insert is skipped (logged). Apply it the usual way for this repo
(see `docs/practice-client-pipeline.md`, "Apply it via rpc/exec_sql"): POST the file's
contents to the Supabase `exec_sql` RPC with the **service-role** key, parameter `query`,
table names schema-qualified (they already are):

```sh
SQL=$(cat supabase/migrations/20261027120000_lead_calls.sql)
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/exec_sql" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg q "$SQL" '{query: $q}')"
```

A 204 means it ran. Then record it in the ledger so the super-admin
`GET /api/admin/migration-status` page stops listing it as unapplied
(`POST /api/admin/migration-status/mark-all-applied`, see `tests/migration-ledger.test.js`).
Verify with `select count(*) from public.lead_calls` through the same RPC.

## Testing

```sh
export NODE_OPTIONS="--experimental-require-module"
node node_modules/vitest/vitest.mjs run tests/lead-calls-lib.test.js tests/lead-calls-endpoints.test.js tests/retell-setup-script.test.js
```

The endpoint tests boot `server.js` against an in-memory PostgREST emulator and point
`RETELL_API_URL` / `CALENDLY_API_BASE` at local stubs, so no real call, booking or
Retell request is ever made. `scripts/retell-setup.js` exports its pure builders
(`buildTools`, `buildLlmPayload`, `buildAgentPayload`, `parseArgs`) and only runs the CLI
when executed directly; `create --dry-run` / `update --dry-run` print the exact payloads
without contacting Retell.
