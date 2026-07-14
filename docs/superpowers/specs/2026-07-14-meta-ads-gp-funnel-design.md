# Meta Ads → GP Funnel — Design Spec

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan
**Owner decisions baked in:** funnel shape A (landing page, both doors); owner takes all consultation calls on the existing Calendly (`calendly.com/hello-mygplink/30min`); leads tracked in-app with follow-up nudges; Meta Lead Ads qualify before the click; screening pass = registered GP in UK / Ireland / New Zealand; screen-outs see a polite no + optional "leave your email" list.

## 1. Problem

Meta (Facebook/Instagram) video ads for UK/IE GPs need a destination. Today every
marketing-site CTA goes straight to signup (`/pages/signin?signup=1`); the only
"talk first" option is a bare external Calendly link in a new tab. Hesitant
clickers — the majority — either bounce unrecorded or half-book and vanish.
There is no GP lead capture anywhere on the GP-facing site (the `gp` kind of
`site_enquiries` is valid but unused).

## 2. Shape of the solution

Two entry points, one landing page, two doors, automated chase-up, everything
converging on the existing signup → onboarding → approval → Secure Placement flow.

```
Meta lead form (qualifies GP + country, FB pre-fills contact details)
      └─ webhook → lead saved → magic-link email  ┐
Organic visitor ──────────────────────────────────┤
                                                  ▼
                              /start  (new landing page)
                       Door 1: Create free account → existing signup
                       Door 2: Book a free 30-min call
                            recognised lead → question box + Calendly (pre-filled)
                            stranger → short form + screening → Calendly | turn-down
                                                  ▼
                     nudges (didn't book / booked but didn't sign up)
                                                  ▼
                signup → onboarding wizard → team approval → in the app
```

## 3. Components

### 3.1 Meta Lead Ad form (configured in Meta Ads Manager, not code)

- Ads use Meta's native lead form. Facebook pre-fills name, email, phone.
- Qualifying questions (multiple choice):
  - "Are you a currently registered GP?" — No ends the form politely.
  - "Where are you registered?" — UK / Ireland / New Zealand / Somewhere else.
- Thank-you screen button: "Book your call" → `https://app.mygplink.com.au/start?src=fb#book`
  (use the app host until the www/apex DNS cutover — checklist item 0 in §7;
  after cutover, switch to the public-site host).
  Meta cannot inject per-lead identity into this URL (platform limitation) —
  hence the two bridges in 3.3.

### 3.2 Facebook lead webhook — extend existing handler

- `POST /api/webhooks/facebook-lead` (`handleFacebookLeadWebhook`, server.js)
  already exists for practice leads; disabled until `FB_LEAD_WEBHOOK_SECRET` +
  `FB_LEAD_VERIFY_TOKEN` are set. Signature verification, dedupe
  (`checkAndRecordWebhookEvent`) and rate limiting already in place.
- Extension: recognise GP lead-gen forms (allow-listed form IDs via new env
  `FB_GP_LEAD_FORM_IDS`, comma-separated) and route those to a **`site_enquiries`
  row** (kind `gp`) instead of a `practices` row. Unknown form IDs keep the
  current practice behaviour.
- Stored on the enquiry `metadata` (jsonb, already exists — **no migration
  needed**): `source: 'meta_lead_ad'`, raw FB answers, qualifying answers
  (`is_gp`, `registration_country`), `consult` sub-object (see 3.6), and a
  `lead_token` (crypto-random UUID) for the magic link.
- On insert: send the magic-link email immediately (Resend, existing outbound
  machinery): "Ready when you are, Dr <LastName>" + `/start?lead=<token>`.
  WhatsApp copy of the same link is a later option, not in scope.
- **Speed-to-lead alert:** the same insert also emails the owner
  (hello@mygplink.com.au) instantly — name, country, phone, their optional
  question — so hot leads can be called/WhatsApped personally within minutes.
  Sender for all lead-facing mail is hello@ (replies land in the owner's
  inbox and are read manually; hello@ is deliberately never auto-processed).

### 3.3 Landing page `/start` (new `pages/site-start.html`)

- Registered in `SITE_PAGE_ROUTES` (same mechanism as `/employers`, `/faq`);
  marketing-site look (reuse site-home styling patterns). Mobile-first —
  effectively 100% of Meta ad clicks are phones.
- **All existing marketing-site "Book a call" buttons are repointed from the
  external Calendly link to `/start#book`**, so every consultation — ad-driven
  or organic — flows through the same tracked funnel. Raw Calendly links
  disappear from the public site.
- Content: ad-continuity hero (UK/IE/NZ GP → practising in Australia, whole
  journey handled, free for doctors), 3-step "how it works", small trust strip,
  then the two doors with equal visual weight.
- `#book` anchor scrolls to Door 2. `?utm_*` params are captured and stored with
  any lead created from the page.
- **Door 1** → `/pages/signin?signup=1` (recognised leads append their email for
  prefill — requires a small signin-page enhancement to honour an `email` param
  in signup mode).
- **Door 2** behaviour depends on recognition:
  - `?lead=<token>` present and valid → greet by first name; form collapses to
    one optional field ("Anything you'd like to cover on the call?") + embedded
    Calendly pre-filled with name/email.
  - Arrived via `?src=fb` without token → single email field ("so we can match
    your Facebook details"). Match → collapsed experience above. No match →
    full stranger form.
  - Stranger → full short form: name, email, phone, "Are you a currently
    registered GP?" (yes/no), "Where are you registered?" (UK / Ireland /
    New Zealand / Somewhere else), optional question. Saved via the existing
    `POST /api/public/enquiry` (kind `gp`) **before** Calendly is shown —
    honeypot + 5/hr/IP rate limit already built in.
  - Consent: the form carries a link to `/pages/privacy` and one honest line —
    "We'll contact you about your enquiry" — covering the follow-up emails
    under UK/EU data rules. (Meta separately requires the same privacy URL on
    the lead form itself; see activation checklist.)

### 3.4 Screening & turn-down

- Pass = is_gp `yes` AND country ∈ {uk, ie, nz} → Calendly appears.
- Fail → polite message ("We currently work with GPs registered in the UK,
  Ireland and New Zealand…") + optional "leave your email and we'll let you
  know if that changes". No Calendly. Lead stored with
  `metadata.screened_out: true` (excluded from all nudges); the optional email
  goes on the same row.
- Meta-side screening already filtered ad traffic; this protects the organic path.

### 3.5 Recognition + booked-signal endpoints (new, public, minimal)

- `GET /api/public/consult-lead?token=…` → `{ displayName, email, qualified }`
  for a valid token only (displayName = "Dr <surname>", matching the email
  greeting). Tokens are unguessable; no email enumeration path.
- `POST /api/public/consult-lead/match` `{ email }` → returns `{ displayName }`
  only when a recent (≤30 days) non-screened FB lead matches; otherwise a
  generic not-found. Rate-limited like the enquiry endpoint. Deliberately
  returns nothing beyond first name (privacy: an email guess must not expose
  phone or answers).
  - **Implemented deviation:** the response is actually
    `{ displayName, token }`, not `{ displayName }` alone — the page needs
    the token client-side to send the booked signal (below) and to prefill
    Calendly the same way the magic-link path does. This does not widen the
    privacy guarantee: every token endpoint in this section still only ever
    reveals `displayName` + `email`, never phone, answers, or anything else.
- Booked signal: the Calendly inline embed fires a `calendly.event_scheduled`
  browser event; the page then calls
  `POST /api/public/consult-lead/booked` `{ token | enquiryId }` which flips
  `metadata.consult.call_booked = true` and status `new → contacted`.
  If the signal is missed (embed quirk), nothing breaks — nudge copy says
  "if you've already booked, ignore this".

### 3.6 Follow-up nudges (extend the existing hourly cron pattern)

State lives in `metadata.consult`: `{ call_booked, call_booked_at, nudges: [ {kind, sent_at} ], unsubscribed }`.

- **Sequence A — qualified, never booked** (covers FB leads who never clicked
  through AND site-form leads who stopped before Calendly): at ~2 h and ~2 d —
  "Still want that chat?" + booking link (magic link where available).
  Stops when: booked, signed up, unsubscribed, or screened out.
- **Sequence B — booked, never signed up**: at ~3 d and ~7 d after
  `call_booked_at` — "Ready to get started?" + signup link. Copy is no-show
  tolerant: it also says "if we missed each other, grab another time" with the
  booking link, since we don't know whether the call actually happened.
  Stops the moment their email exists in `users` (case-insensitive match),
  or on unsubscribe.
- De-dupe by email across rows (a person who submits twice gets one sequence).
- Unsubscribe: same POST-link pattern as the onboarding nudge emails; flag on
  metadata silences both sequences.
- Status auto-transitions: `new` → `contacted` (booked) → `converted` (signed
  up; reuses the status already added for practice conversion — verified in
  `20260706200000_enquiry_convert_statuses.sql`).

### 3.7 Admin visibility

- No new screens. Leads appear as GP-kind rows in the existing CEO lead
  browser / CSV export (`listSiteEnquiryRows`), with status showing the journey.
- Owner keeps receiving Calendly's own booking emails unchanged.

## 4. Explicitly out of scope (deliberate)

- Meta Pixel / Conversions API on `/start` (worth a later pass so Meta's
  delivery optimises toward bookings/signups).
- Attribution stamped onto user accounts for Door-1 direct signups.
- A funnel stats view (leads → booked → signed up per source) — the CSV export
  covers v1.
- Pre-filling the onboarding wizard from lead-form answers.
- WhatsApp copy of the magic-link message (DoubleTick).
- Any change to the existing signup/onboarding/approval flow beyond the
  optional email-prefill param on the signin page.

## 5. Edge cases

- Already-registered email fills the form → lead stored, but nudges check
  `users` and stay silent; Sequence B never fires.
- Duplicate submissions → nudge selection de-dupes by email, newest row wins.
- Calendly booked-signal missed → lead stays `new`; Sequence A's copy is
  tolerant; owner sees the booking via Calendly email regardless.
- Webhook down / envs unset → FB leads simply don't flow (webhook returns
  503 as today); the site path is unaffected. Activation checklist below.
- Token link forwarded/reopened → token only reveals first name + email prefill;
  it cannot log anyone in or expose other data.

## 6. Testing

- Vitest: GP-form routing in the webhook handler (form-ID allow-list, enquiry
  row shape, token generation), match-endpoint privacy behaviour (no
  enumeration beyond first name, 30-day window), screening pass/fail matrix
  (is_gp × country), nudge selection (both sequences: timing, stop conditions,
  de-dupe, unsubscribe), booked-signal transition.
- Manual click-through before ad spend: organic pass, organic screen-out,
  magic-link arrival, thank-you-button email match, full booking on the
  embedded Calendly, and one end-to-end signup.

## 7. Owner activation checklist (one-time, guided at ship time)

0. Set `SITE_PUBLIC_BASE_URL=https://app.mygplink.com.au` in Vercel (verified
   2026-07-15: apex and www still serve the legacy site; only app. serves
   this app). Revisit after the www DNS cutover — then switch ads + links to
   the public site host. Also do a one-time prod smoke test after the first
   deploy: hit the consult-lead token lookup endpoint and confirm a
   `metadata` PATCH actually lands on the row.
1. Create the Meta lead form with the two qualifying questions; choose the
   **"higher intent"** form type (adds a review step — cuts junk leads); attach
   the privacy policy URL (`https://app.mygplink.com.au/pages/privacy` — app
   host until the DNS cutover, same caveat as items 0/3) — Meta requires it;
   note the form ID.
2. Connect the webhook in Meta's developer settings; set `FB_LEAD_VERIFY_TOKEN`,
   `FB_LEAD_WEBHOOK_SECRET`, `FB_GP_LEAD_FORM_IDS` in Vercel.
3. Point every ad's destination / thank-you button at
   `https://app.mygplink.com.au/start?src=fb#book` — the same host as item 0.
   ⚠️ Do NOT use the bare `mygplink.com.au` address yet: until the DNS cutover
   it still serves the old website, and ad clicks would dead-end there. After
   the cutover, update the ads to the public-site host.
4. Calendly: no config changes — but **check your availability windows map to
   sane UK hours** (UK is 9–10 h behind AEST: their 9am–12pm ≈ your 6–10pm).
   If no UK-friendly slots exist, UK leads will see an empty calendar and the
   funnel stalls at the last step. NZ (+2 h) needs nothing special.
