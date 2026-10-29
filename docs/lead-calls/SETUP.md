# Hazel outbound calling — what you need to set up by hand

Everything in the app is built and switched OFF by default. Nothing dials until
`LEAD_CALLS_ENABLED` is set to `true`, and even then only leads that arrived in
the last 3 days are ever called. Work through these in order; each step says what
to hand back.

## 1. Voice recording (needs your team member, 15 minutes)

- Script: `~/Desktop/GP Link voice clone/RECORDING-SCRIPT.md`
- Put the nine files in `~/Desktop/GP Link voice clone/clips/`
- Hand back: nothing, just say when the clips are there. The clone is run from the files.

## 2. Retell account (10 minutes)

1. Sign up at https://www.retellai.com and add prepaid credit (Billing).
2. Dashboard → **API Keys** → create a key, select it and click **"Set as
   Webhook Key"**. Retell signs every webhook AND every mid-call tool request
   with whichever key carries the webhook badge — if that is not the key in
   `RETELL_API_KEY`, the app answers 401 "Invalid signature" and Hazel cannot
   check the diary or book (seen live 2026-10-27).
3. Hand back: the key, as `RETELL_API_KEY=...` in the app's `.env`
   (`/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env`).

Everything else in Retell (voice clone, the Hazel agent, number import) is done
for you by `scripts/retell-setup.js` once the key is in place.

## 3. Twilio numbers and SIP trunk (20 minutes, plus approval wait)

> 2026-10-29: UK-only launch first. Follow docs/lead-calls/TWILIO-UK-SETUP.md (UK mobile number, one trunk); the Australian number below can be added later on the same trunk.

Retell's own numbers can only dial the US, so the UK and Australian numbers come
from Twilio and are connected to Retell over a SIP trunk.

1. Sign up at https://www.twilio.com, upgrade out of trial (add a payment method).
2. **Phone Numbers → Buy a number**: one United Kingdom number and one Australia
   number, voice-capable. Both countries require a *regulatory bundle*
   (business address, ID). Twilio approves these in hours to a couple of
   business days. Start this today.
3. **Voice → Settings → Geo permissions** (search "geo" in the console):
   under **Elastic SIP Trunking**, enable United Kingdom, Ireland, Australia and
   New Zealand.
4. **Elastic SIP Trunking → Trunks → Create**:
   - Name: `gplink-retell`
   - **Termination**: domain `gplink-retell.pstn.ashburn.twilio.com`
     (Retell's servers are in the US; Ashburn is closest). Under
     *Authentication* create a **Credential List** (any username, a strong
     password). Also, under *IP Access Control Lists*, allow Retell's block
     `18.98.16.120/30`.
   - **Origination**: add origination URI `sip:sip.retellai.com`, priority 10, weight 10.
   - **Numbers**: add both purchased numbers to this trunk.
5. Hand back, in `.env`:
   ```
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_SIP_TERMINATION_URI=gplink-retell.pstn.ashburn.twilio.com
   TWILIO_SIP_USERNAME=...
   TWILIO_SIP_PASSWORD=...
   RETELL_FROM_NUMBER_UK=+44...
   RETELL_FROM_NUMBER_AU=+61...
   ```
   The numbers are then imported into Retell with
   `node scripts/retell-setup.js import-number ...` (done for you).

## 4. Calendly (5 minutes)

Booking on the call uses Calendly's scheduling API, which needs a **paid**
Calendly plan (you already have one: the app registers Calendly webhooks, which
also need it).

1. Confirm the token already in `.env` as `CALENDLY_API_TOKEN` is a *personal
   access token* for the account that owns the consultation event type
   (Calendly → Integrations & apps → API & webhooks). If unsure, create a new
   one there and replace it.
2. Confirm `CALENDLY_EVENT_TYPE_URI` in `.env` points at the consultation event
   type Hazel should book (the one the `/start` page uses).
3. If that event type's location is Zoom, nothing else to do. If it asks the
   invitee to choose a location, tell me and I'll set `CALENDLY_LOCATION_KIND`.

## 5. Two names and a number (1 minute)

Add to `.env`:
```
LEAD_CALLS_DIRECTOR_NAME=<the director's first name, as Hazel should say it>
LEAD_CALLS_TRANSFER_NUMBER=+61...   # your mobile, for "can I speak to a person" (optional)
```

## 6. Facts check (5 minutes)

Open `config/retell/hazel-prompt.md`, section **"Facts you can use"**, and
correct anything that isn't how you'd say it (college names, pathway wording,
visa wording). Hazel never quotes salary figures; the consultation does.

## 7. Then, in order (done for you once the above is in)

1. Clone the voice from the clips → `voice_id`.
2. Create the Hazel agent in Retell, pointed at the live app.
3. Import the two Twilio numbers into Retell.
4. Apply the `lead_calls` database migration.
5. Set the env vars on Vercel and redeploy.
6. **Test call to your own mobile** (`POST /api/ceo/lead-calls/test`, or
   `node scripts/retell-setup.js test-call --to +61...`). Listen, tweak the
   prompt and voice settings, repeat until it sounds right.
7. Soft launch: set `LEAD_CALLS_TEST_NUMBERS=+61...` (your number) and
   `LEAD_CALLS_ENABLED=true`, submit a test lead with your own number through
   the Meta form or `/start`, and watch it get called within 5–10 minutes
   inside calling hours.
8. Go live: remove `LEAD_CALLS_TEST_NUMBERS`. From then on every qualified GP
   lead with a phone number is called within minutes of enquiring (Mon–Fri
   9:00–19:30, Sat 10:00–16:00 in the lead's own time zone), up to twice,
   3 hours apart. Outcomes show on the CEO Leads tab.

## Kill switch

Set `LEAD_CALLS_ENABLED=false` on Vercel (or remove it). Calls already in
progress finish; nothing new is dialled from the next 5-minute tick.
