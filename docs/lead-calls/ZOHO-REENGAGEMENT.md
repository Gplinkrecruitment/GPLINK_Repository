# Zoho leads → Hayley

> **2026-10-31, owner:** "we already have their consent" — so the Zoho candidates are
> **imported as leads and rung directly**; the WhatsApp opt-in template below is
> built and kept, but parked (drip off, nothing sent).

## Direct import (what is live)

`GET /api/cron/zoho-import` (CRON_SECRET; not on any schedule) — `?dry_run` by
default only counts, `?confirm=1` writes. Each UK-mobile, non-unsubscribed
candidate that is not already a lead (same phone or email) becomes a
`site_enquiries` row: `metadata.source = 'zoho_import'`, `zoho_candidate_id`,
`consult.qualified = true`, `is_gp = null`, `country = 'uk'`,
`nudges_disabled = 'not_booked'` (no automated pre-booking emails/WhatsApp; the
post-booking sign-up drip still runs), and **the candidate's own `created_at`** so
the dialler's newest-first scan reaches them only after every newer real lead.
Imported leads are exempt from `LEAD_CALLS_MAX_LEAD_AGE_DAYS`
(`isAgeExemptSource`). Hayley's variables: `enquiry_when = 'a while back'`,
`enquiry_source = 'your earlier registration with GP Link'`; script v56 opens
with "you registered with GP Link a while back about GP work in Australia, and
I'm just checking whether that's still on the cards".

## Dialler changes that came with it (lib/lead-calls.js, server.js)

- **Backlog windows**: a lead older than `LEAD_CALLS_BACKLOG_AFTER_HOURS` (24)
  with no call-back due rings only Mon–Fri 12:30–13:30 and 17:30–19:30, Sat
  10:00–13:00 (`BACKLOG_WINDOWS`; `LEAD_CALLS_BACKLOG_WINDOWS=false` turns it off).
  Fresh leads keep 9:00–19:30 / Sat 10–16.
- **Chaining**: the Retell `call_ended` webhook for a dialler-placed call runs
  `runLeadCallsPass` immediately, so the next doctor is rung the moment a call
  ends; the 5-minute cron is the fallback and what starts the chain when a
  window opens. `LEAD_CALLS_CHAIN=false` disables.
- **One at a time**: a pass never places a call while any lead has a call in
  flight (`callInFlight`: registered/ongoing, under 15 min, no completion);
  `LEAD_CALLS_ONE_AT_A_TIME=false` lifts it.

Tests: `tests/lead-calls-backlog.test.js`, `tests/zoho-reengage-endpoints.test.js`.

---

# (Parked) Zoho WhatsApp re-engagement → Hayley

The 815 `candidate_leads` imported from Zoho Recruit never came through the website
or a Meta form, so Hayley must not cold-call them (no consent to an automated call).
Instead each UK mobile gets **one** approved WhatsApp template asking whether they
are still interested. A **"Yes, call me"** tap turns the candidate into an ordinary
qualified consult lead (`site_enquiries`, `metadata.source = 'zoho_reengagement'`)
that the dialler rings within minutes during UK calling hours.

Code: `lib/zoho-reengage.js` (pure: who, what, how a reply is read) and the
storage/HTTP wiring in `server.js` (search `zohoReengage`). Tests:
`tests/zoho-reengage-lib.test.js`, `tests/zoho-reengage-endpoints.test.js`.

## The message (DoubleTick template `gp_link_reengage_hayley`, MARKETING, en)

> Hi {{1}}, it's Hayley from GP Link. You registered with us a while back about GP
> work in Australia. UK GPs are being hired right now and the fast-track registration
> route is open. Still interested? Tap below and I'll give you a quick call, or book a
> free consultation. Reply STOP to opt out.
>
> [Yes, call me] [Not right now] [Book a call → https://app.mygplink.com.au/start?src=wa]

Submitted to Meta on 2026-10-31 from WABA 61494391968. Sends fail until Meta approves it.

## Who gets it

`pickReengageBatch`: not unsubscribed, phone is a UK mobile (`+44 7…`), newest
registration first, one message per number ever. "Already messaged" is a
`webhook_events` row (`provider = 'zoho_reengage'`, `event_id` = candidate id,
`payload = { phone, name, email, sent_at }`) — the same dedupe table the lead
webhooks use, so no migration. If that table cannot be read, nothing is sent.

## How to run it

- **CEO dashboard → Leads tab → "Candidate leads & Zoho archive" card**: the
  *Hayley WhatsApp re-engagement* box shows eligible / messaged / yes / not now /
  stopped, with **Send to the next 25 now** and **Send a test to my phone**.
- `POST /api/ceo/reengage/zoho` `{ dry_run: true }` previews, `{ limit: 25 }` sends,
  `{ test_phone: '+61…' }` sends one test (not recorded).
- Daily drip: cron `GET /api/cron/zoho-reengage` at 10:00 UTC weekdays sends
  `ZOHO_REENGAGE_PER_DAY` (default **0 = off**; max 200) inside UK weekday daytime
  only. `?dry_run=1` just counts.

## Replies (DoubleTick webhook, before the help-request classifier)

`handleZohoReengageReply` runs for any inbound number we messaged:

| reply | what happens |
|---|---|
| yes / "Yes, call me" | qualified lead created (country uk, GP question not asked), owner alert, WhatsApp reply "Hayley will ring you from +44 7862 121872 … or pick a time: /start?lead=…", marker → `replied_yes` |
| no / "Not right now" | marker → `replied_no`, polite WhatsApp reply, nothing else |
| STOP / unsubscribe | marker → `stopped`, `candidate_leads.unsubscribed = true`, no reply |
| anything else | marker → `replied_other`, message continues to the human WhatsApp queue as a known person (never dropped) |

Hayley's variables for these leads: `enquiry_source = 'our WhatsApp message'`,
`enquiry_question` = the reply they sent.

## Caveat: button taps

DoubleTick documents only TEXT/IMAGE/AUDIO/VIDEO webhook payloads. The parser
reads a quick-reply tap from `message.text`, `message.button.text|payload`,
`message.buttonText`, `message.payload`, `message.title`,
`message.interactive.button_reply.title`. If a tap still arrives in another shape
the webhook logs `message.type` and the message keys ("Sanitize rejected payload")
— send a test to the owner's phone, tap the button, read the Vercel log, add the
field to `buttonReplyText`.

## Rollout

1. Wait for Meta template approval (DoubleTick → Templates).
2. "Send a test to my phone" → tap "Yes, call me" → confirm the dashboard shows
   said yes = 1 and Hayley rings the owner's number (the owner's number must be in
   `candidate_leads` for the reply to match; otherwise the tap just proves the payload).
3. "Send to the next 25 now", watch replies for a day.
4. Set `ZOHO_REENGAGE_PER_DAY` (e.g. 40) on Vercel for the weekday drip.
