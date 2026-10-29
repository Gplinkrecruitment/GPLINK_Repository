# Twilio for Hazel, UK calling only (29 October 2026)

Hazel phones UK GPs from a UK mobile number. Retell cannot sell UK numbers, so the number comes from Twilio and is connected to Retell over an Elastic SIP trunk. Cost: the number is USD 2.50 a month, calls to UK mobiles are USD 0.0265 a minute (about 6 percent of what a Hazel minute costs). Australia can be added later with the same trunk.

There are two ways to do this. Either way, step 1 is yours.

## Step 1 (you, 5 minutes): the Twilio account

1. Sign up at https://www.twilio.com/try-twilio with hello@mygplink.com.au.
2. Upgrade out of trial: Console, Billing, add a payment method and top up (USD 20 is plenty to start; the number is 2.50 a month and a 5-minute call is about 13 cents).
3. Then choose path A or path B.

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
RETELL_FROM_NUMBER_UK=+447...
LEAD_CALLS_DIRECTOR_NAME=Khaleed
LEAD_CALLS_TEST_NUMBERS=+61...        # your mobile, for the soft launch
LEAD_CALLS_ENABLED=true
```
Twilio's own credentials are not needed by the app: Retell places the calls and the app only talks to Retell.

## Then

1. One real test call to your own mobile: `node scripts/retell-setup.js test-call --to +61... --from +447...` (or `POST /api/ceo/lead-calls/test`).
2. Soft launch with `LEAD_CALLS_TEST_NUMBERS` set to your number: submit a test lead and watch it get called within minutes inside UK calling hours (Mon to Fri 9:00 to 19:30, Sat 10:00 to 16:00, UK time).
3. Go live by removing `LEAD_CALLS_TEST_NUMBERS`.

UK rule of thumb: automated calls are only made to people who enquired (they did, through the form), and a doctor who asks not to be called again is marked do-not-call by Retell automatically.
