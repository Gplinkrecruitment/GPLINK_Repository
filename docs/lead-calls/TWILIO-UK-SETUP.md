# Twilio for Hazel, UK calling only (29 October 2026)

> Status 30 October 2026: DONE through to the Retell import. Twilio Primary Customer Profile approved; UK mobile bundle BU455c6a1ff50e16ad49226a016c988831 approved; number **+44 7862 121872** (PNceb0067197e9da584057f8914591fd39) on trunk `gplink-retell` (TK0a7add8f4e4d14e87d05b7dc8eaee4c6, domain gplink-retell.pstn.twilio.com, credential user gplinkretell, Retell IPs 18.98.16.120/30 allow-listed, origination sip:sip.retellai.com); SMS webhook set to /api/webhooks/twilio-sms; imported into Retell as "Hazel UK outbound" bound to Hazel for inbound and outbound. Remaining: Vercel variables (below), first real test call, soft launch.

Hazel phones UK GPs from a UK mobile number. Retell cannot sell UK numbers, so the number comes from Twilio and is connected to Retell over an Elastic SIP trunk. Cost: the number is USD 2.50 a month, calls to UK mobiles are USD 0.0265 a minute (about 6 percent of what a Hazel minute costs). Australia can be added later with the same trunk.

There are two ways to do this. Either way, step 1 is yours.

## Step 1 (you, 5 minutes): the Twilio account

1. Sign up at https://www.twilio.com/try-twilio with hello@mygplink.com.au.
2. Upgrade out of trial: Console, Billing, add a payment method and top up (USD 20 is plenty to start; the number is 2.50 a month and a 5-minute call is about 13 cents).
3. Then choose path A or path B.

## Step 2 (you, 5 minutes): the Primary Customer Profile

Twilio will not sell a number or create a trunk until the account's identity check is approved, and this profile can only be created in the Console (the API only creates reseller sub-profiles). Console, Account (top right), Trust Hub, Customer Profiles, Create, Business:

- Business name `GP Link Recruitment Australia Pty Ltd`; address `60A Erina Valley Road, Erina NSW 2250, Australia`
- Business type Corporation (or Private Company if offered); industry Professional Services; registration ACN `693259737`; regions of operation Asia Pacific (add Europe if offered); website `https://www.mygplink.com.au`
- Authorised representative Khaleed Ibanez, CEO, `+61406281243`, `hello@mygplink.com.au`
- Notifications by email; accept the terms; submit. Approval usually lands within a business day or two.

## Path A (me, via the API): paste two values

From the Console home page copy the **Account SID** (starts with AC) and the **Auth Token** (click to reveal), and paste them in the chat. I will then:

1. file the UK mobile regulatory form (business name, your business address, your name as the authorised representative; no documents are needed for a UK mobile number held by a non-UK business),
2. buy a UK mobile number (07 prefix) once the form is approved,
3. enable United Kingdom under Voice geo permissions for SIP trunking,
4. create the SIP trunk `gplink-retell` with credential authentication, Retell's IP block 18.98.16.120/30, origination to sip:sip.retellai.com, and attach the number,
5. import the number into Retell with `node scripts/retell-setup.js import-number ...` and bind it to Hazel,
6. hand you the Vercel values below.

Rotate the Auth Token afterwards (Console, Account, API keys and tokens) if you prefer; everything created stays in place.

## Path B (you, 20 minutes in the Console)

1. **Regulatory form.** Phone Numbers, Regulatory Compliance, Bundles, Create: country United Kingdom, number type Mobile, business. Enter the business name, business address (Australia is fine) and your name. Submit. Approval is usually within hours.
2. **Buy the number.** Phone Numbers, Buy a number: country United Kingdom, capabilities Voice, type Mobile. Pick any 07 number, attach the approved bundle and address, buy.
3. **Geo permissions.** Voice, Settings, Geo permissions, tab Elastic SIP Trunking: tick United Kingdom (low-risk numbers). Save.
4. **SIP trunk.** Elastic SIP Trunking, Trunks, Create:
   - name `gplink-retell`
   - Termination: domain `gplink-retell.pstn.ashburn.twilio.com`; under Authentication create a Credential List (username `gplink`, a strong password, save both); under IP Access Control Lists create one containing `18.98.16.120/30`.
   - Origination: add `sip:sip.retellai.com`, priority 10, weight 10.
   - Numbers: add the UK number.
5. Give me: the number (+44...), the SIP username and password. I import the number into Retell and bind it to Hazel.

## Vercel environment variables (after the number is imported)

```
RETELL_FROM_NUMBER_UK=+447862121872
LEAD_CALLS_DIRECTOR_NAME=Khaleed
LEAD_CALLS_TEST_NUMBERS=+61406281243  # your mobile, for the soft launch
LEAD_CALLS_ENABLED=true
TWILIO_AUTH_TOKEN=...                 # only for the SMS webhook below (use the rotated token)
TWILIO_SMS_FORWARD_TO=hello@mygplink.com.au
```
Retell places the calls, so the app never needs Twilio for voice. The Auth Token is used only to verify texts.

## Texts to the UK number

Twilio has no inbox, so the app handles texts: `POST /api/webhooks/twilio-sms` (set as the number's SMS webhook when the number is bought) verifies Twilio's signature, emails the text to `TWILIO_SMS_FORWARD_TO` (subject "Text to Hazel's number from +44..."), and replies once per sender per day: "Hi, this is GP Link. This number is our call line and texts here aren't read straight away. For anything about GP work in Australia, message us on WhatsApp at +61494391968 or email hello@mygplink.com.au and we'll come straight back to you." Opt-out words (STOP and the like) are forwarded but never answered. Code: `lib/twilio-sms.js`, handler `handleTwilioSms` in `server.js`, tests `tests/twilio-sms-lib.test.js`.

## Then

1. One real test call to your own mobile: `node scripts/retell-setup.js test-call --to +61... --from +447...` (or `POST /api/ceo/lead-calls/test`).
2. Soft launch with `LEAD_CALLS_TEST_NUMBERS` set to your number: submit a test lead and watch it get called within minutes inside UK calling hours (Mon to Fri 9:00 to 19:30, Sat 10:00 to 16:00, UK time).
3. Go live by removing `LEAD_CALLS_TEST_NUMBERS`.

UK rule of thumb: automated calls are only made to people who enquired (they did, through the form), and a doctor who asks not to be called again is marked do-not-call by Retell automatically.
