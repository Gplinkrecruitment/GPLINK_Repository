# Australian GP placements: handover

Written 23 November 2026 for the owner. Plain English first; technical detail
is in the documents this page points to.

## Where things stand

GP Link can now take an Australian GP (already in Australia, already registered
with Ahpra) from the website through to the end of the 12-week guarantee,
**on the testing branch `au-gp-testing` only**. Nothing is live. Nothing was
pushed to `main`. The live database was not changed. No real email, WhatsApp
or call was sent, and nothing was changed in DoubleTick, Retell, Meta, Google
Ads, Calendly, Zoom or Xero.

Everything Australian sits behind one switch, `AU_PATHWAY_ENABLED`. It is on
for local testing and for the preview website, and off on the live site unless
you set it. With the switch off the product behaves as it does today.

All 28 work packages of the review's build plan were built. `coverage.md` has
one row for every finding in the review and every new message, saying what was
done, in which commit, and why anything was deferred.

## What an Australian GP gets now (switch on)

1. **Website.** A page written for them (`/australian-gps`), a home page with
   two doors ("Moving to Australia" / "Already practising in Australia"), and
   a booking form whose first question is "Are you currently registered with
   Ahpra?". A "Yes" qualifies them whatever country they trained in. They are
   never told the service is for overseas doctors.
2. **As a lead.** Tagged as Australian from their own answers (never guessed
   from a phone number). Their messages are Australian wording, sent between
   8am and 8pm in their own state's time. Hazel never rings them.
3. **Sign-up and onboarding.** A short Australian path: Ahpra number, type of
   registration, fellowship, conditions, the 19AB question, right to work,
   notice period, when they could start, where they want to work. They are
   never shown "Not yet eligible".
4. **Staff check.** Staff get a task to check the public Ahpra register, record
   the registration type, conditions and expiry, confirm the 19AB position and
   confirm the pathway. Staff can also add an Australian doctor themselves.
5. **Jobs.** They see the roles they may take. Until staff confirm the 19AB
   moratorium does not apply, they see roles in DPA areas only (the safe
   default). Job facts are the ones that matter to a local GP. They can apply
   (with a clear consent step saying exactly what is sent to which practice),
   interview at times shown in their own time zone, receive an offer and sign
   the contract in the app.
6. **The practice** is introduced to them accurately ("a vocationally
   registered GP (FRACGP)… Ahpra registration verified… available from…"),
   with no mention of being internationally trained.
7. **On placement** they get a pre-start checklist (notice and start date,
   indemnity certificate, Medicare provider number for the new location,
   credentialing). No SPPA-00, Section G, supervisor CV, MyIntealth, AMC,
   Ahpra application or visa task, page or message is created.
8. **Commencement.** Staff press "Confirm commenced". The app works out the fee
   from the agreement the practice actually signed, creates a task for you to
   raise the invoice by hand, and schedules check-ins at week 1 and weeks 4, 8
   and 12 of the guarantee. Nothing commercial is ever sent to the doctor.
9. **Dashboards** show them under an Australian pipeline (Matched, Interview,
   Contract, Pre-start, Commenced, Guarantee), never as "MyIntealth" or "GB",
   and no reminder job chases them about overseas steps.

For everyone else: an overseas doctor's journey, messages, tasks and dashboard
numbers are unchanged, and with the switch off the product matches `main`. The
deliberate exceptions are listed below.

## What was built for segments B and C, and what is not launched

Segment B (already here with restrictions) and segment C (non-VR GPs and
registrars) are **built but not launched**. A doctor who lands in either
completes onboarding, is told "our team is confirming your details and will be
in touch", cannot apply by themselves, and is flagged to staff with a task.
Staff can place them by hand where a role allows it. For segment B the visa
transfer and supervision machinery exists but does nothing automatically:
staff get decision tasks. Launching either segment needs the regulatory
confirmations in `OWNER-ACTIONS.md` (item 59) and one small change.

## Deliberate exceptions to "switch off = exactly as today"

These are recorded in `CONVENTIONS.md` section 2. Each was chosen because the
alternative was worse.

1. **Hazel never rings an Australian lead, switch on or off** (your decision
   7). On the live site today this changes nothing in practice, because no
   Australian outbound number is configured; the only visible difference is
   the wording of the refusal if someone presses "ring now" on an Australian
   lead.
2. **A case that is on the Australian journey is never rewritten by the
   overseas stage logic, switch on or off.** No such case can exist on the
   live site today, because the live database rejects the Australian stage
   values until the new fields are added.
3. **A small guard** stops an overseas case being parked on the Australian
   stage "placement" (a write that already fails on the live database today).

## Things that change for existing doctors or practices once the switch is ON

Nothing changes while the switch is off. With it on, these touch people who
are not Australian GPs, and each is an owner action so you can decide:

- Practice reminder emails follow the practice's own weekend instead of the
  UTC day (item 41).
- A brand-new sign-up's welcome email waits until they answer the first
  onboarding question, at most an hour (item 76).
- Newly written job-board practice profiles are written for both audiences
  (item 96), and signed-out visitors to the public job board no longer see
  earnings or split figures (item 112).
- The public site shows the "Australian GPs" menu item, the two-door home
  page and a neutral footer line (items 99, 103).

## Database changes (all additive; none applied to the live database)

Ten migration files, named `*au_gp*` in `supabase/migrations/`. They add new
empty fields and tables and widen lists of allowed values. Nothing is dropped,
renamed or narrowed, and no existing row is rewritten. Each was applied to a
local copy of the live database's structure and re-applied to prove it is safe
to run twice.

| File | What it adds |
| --- | --- |
| `20261120100000_au_gp_wp02_pathway_credentials.sql` | Pathway fields and location/availability preferences on doctor profiles; pathway on cases; the new `gp_credentials` table (staff-only) |
| `20261120110000_au_gp_wp03_stages.sql` | Allows the Australian journey stages on cases and on booked calls |
| `20261120120000_au_gp_wp06_task_types.sql` | Allows the Australian staff task types; one open Ahpra check per case; "placing consultant" on cases |
| `20261120130000_au_gp_wp08_role_fields.sql` | Role fields (VR requirement, registrars, supervised doctors, sessions, interests, three-way DPA status); preferred locations; "flags reviewed" stamp |
| `20261120140000_au_gp_wp09_profile_share_consent.sql` | Consent to be introduced to a practice, per application |
| `20261121100000_au_gp_wp12_prestart_details.sql` | New-location provider number fields; referees, notice and existing numbers |
| `20261121110000_au_gp_wp13_placement_commercials.sql` | Fee tier, commencement, invoice and guarantee fields on placements; a rule that derived tasks cannot be duplicated |
| `20261121120000_au_gp_wp14_visa_transfer.sql` | Nomination-transfer fields on visa cases (segment B) |
| `20261122100000_au_gp_fb2_placement_tasks_and_offer_sessions.sql` | A rule that pre-start tasks cannot be duplicated; numeric sessions a week on offers |
| `20261123100000_au_gp_wp23_practice_source_website_lead.sql` | Allows the value the website's practice form has always written (this one also repairs a problem on the live site today: item 116) |

`CONVENTIONS.md` section 11 lists every new field so each can be confirmed
after applying. **If the code runs with the switch on and a field is missing,
it treats every doctor as an overseas doctor rather than guessing.**

## What you need to do (the short list)

`OWNER-ACTIONS.md` has every item with its reason. The ones that matter first:

1. **Give the go-ahead to add the new fields to the live database** so the
   preview website can be tested. They only add empty fields; they change
   nothing for current doctors.
2. **Set `NOTIFY_TEST_RECIPIENTS` on the Vercel Preview environment** to email
   addresses and phone numbers you own (item 1). Until then the preview sends
   nothing at all, which is safe but means you will not receive test messages.
3. **Decide on the live "Request doctors" form problem** (item 116): it
   appears unable to create practice records on the live site today.
4. **Read the wording**: the Australian lead messages (`au-lead-copy.md`),
   the doctor and practice messages (`au-lifecycle-copy.md`), the new website
   pages, and the WhatsApp submission sheet (`whatsapp-templates.md`).
5. **Legal reviews**: privacy, terms and consent drafts; the draft Australian
   agreement variant; AI calls to Australian numbers; the regulatory
   assumptions (19AB, provider numbers, supervision, visa transfer).
6. **Outside accounts** (nothing was created in any of them): submit the
   WhatsApp templates in DoubleTick; build the Australian Meta lead form and a
   separate conversion dataset; decide on Hazel for Australian numbers.
7. **Sales**: sign metro and non-DPA practices. All live roles today are in
   DPA areas, so an unrestricted Australian GP has nothing new to look at
   until that changes. The employers page and practice intake are ready for
   them (switch on).

## Problems found in today's live product along the way

None of these was caused by this build, and none was changed, so that nothing
changes for current doctors without your say-so. Each has a ready fix
described in `OWNER-ACTIONS.md`.

- The employers page "Request doctors" form cannot create a practice record
  (item 116).
- An RSO assigned to a doctor can open that doctor's identity document through
  one admin address that skips the usual check (item 13).
- The live privacy page says Meta never receives email or phone; hashed email
  and phone are sent for Facebook and Instagram form leads (item 14).
- Hazel only says she is an AI if asked and never mentions recording (item 15).
- The six-month identity-document deletion never starts for doctors placed
  through the app (item 16).
- Some documents copied to Google Drive are briefly viewable by anyone with
  the link; weekly backups are never pruned (item 18).
- The agreement PDFs, including the discounted rate card, are at a guessable
  public address (item 10).
- After an offer, doctors are told "Offer accepted" before they sign; the
  Careers page can lag ten minutes; pale text in dark mode; "Hi Dr,"
  greetings; "countersigned contract" (item 90).
- A PDF contract cannot be shown inside the app, only downloaded (item 91).
- A placed overseas doctor's Careers page may make requests in a loop
  (item 84).
- The overseas "add my GMC number" WhatsApp is rejected by Meta (item 74).
- The public site's job and location counts disagree with each other
  (item 101).
- The daily job's "escalation" notes and its overdue tasks are silently
  rejected by the live database (items 87 and walk finding P1-S1).

## What could not be verified

- **No real AI output was read.** Every test uses a stand-in for the AI, and
  AI is blocked on the local stack. The instructions given to the AI and the
  safety net that checks its output are tested; what a real model writes from
  them has not been seen by anyone (item 93).
- **Nothing was run on the preview website end to end**, because the live
  database does not have the new fields yet. Everything was run on a local
  copy of the live database's structure with fake data.
- **Nothing was checked on a physical phone.** Screens were checked in an
  automated browser at phone width.
- **Outside services were never called**, so the exact behaviour of Meta,
  Google, DoubleTick template approval, Calendly webhooks and Zoom is as the
  code expects, not as observed.
- **The regulatory rules are assumptions** (19AB, provider number per
  location, supervision paperwork, visa nomination transfer). Each lives in
  one place in the code and takes the restrictive option when unknown.
- **Segment B and C** were tested by automated tests and partly on screen,
  not as full journeys.

## Going live, when you are ready

Do these in order. Each step is yours to take; none has been done.

1. Finish testing on the preview website (see `TESTING.md`).
2. Apply the ten database files to the live database (already done if you
   gave the go-ahead for preview testing: the preview and the live site share
   one database). Confirm each new field exists (`CONVENTIONS.md` section 11).
3. Merge the draft pull request from `au-gp-testing` into `main`. The live
   site redeploys by itself. **With the switch still off, the live product
   behaves as it does today**, apart from the three exceptions above.
4. Check the live site is healthy and that an existing overseas doctor's
   journey looks as it did.
5. Set the supporting settings you have decided on (WhatsApp templates
   approved, the gone-quiet threshold, the lead-message go-live time,
   Australian ad settings). See `OWNER-ACTIONS.md`.
6. Set `AU_PATHWAY_ENABLED=true` on the Vercel Production environment and
   redeploy. That is the moment Australian GPs can use the product.
7. Do not turn the switch off again once real Australian doctors exist
   without asking for a check first (items 32 and 89).

## Where everything is

| Document | What it is |
| --- | --- |
| `TESTING.md` | Step-by-step guide to test it yourself |
| `OWNER-ACTIONS.md` | Every decision and outside-account action waiting on you |
| `coverage.md` | Every finding and message from the review, and what happened to it |
| `walk-findings.md` | Every defect found by walking the running app, and its status |
| `review-report.md` | The original review and build plan |
| `LOCAL-STACK.md` | The private local test setup |
| `ENVIRONMENT.md` | What the preview and local setups are connected to |
| `au-lead-copy.md`, `au-lifecycle-copy.md` | Every Australian message, word for word |
| `whatsapp-templates.md`, `whatsapp-live-templates.md` | What to submit in DoubleTick; the live templates as read |
| `metrics.md`, `scheduled-jobs.md` | How each number and each scheduled job treats Australian doctors |
| `legal-draft/`, `privacy-terms-legal-review.md`, `agreement-au-variant-legal-review.md`, `hazel-au-script-notes.md` | Drafts and questions for legal review |
| `ads-tracking-setup.md`, `ads-au-house-context.md`, `meta-au-lead-form.md` | What to set up in the ad accounts |
| `site-content-backlog.md` | Website pages not built, and why |
| `CONVENTIONS.md`, `AGENT-RULES.md` | Technical reference for whoever works on this next |

## Final review

_To be completed when the independent final review has reported and its
blockers and required defects are fixed: what it checked, what it found, what
was fixed, and the remaining "should" and "minor" items._
