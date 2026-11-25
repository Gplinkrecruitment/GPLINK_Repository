# Australian GP placements: handover

Written 23 November 2026 for the owner; brought up to date 24 November 2026
after the seventh independent review. Plain English first; technical detail
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
- A brand-new sign-up who has not yet answered the first question ("Are you
  already registered with Ahpra and working in Australia?") gets a neutral
  welcome after an hour and at most one neutral reminder, instead of today's
  overseas welcome and reminder series. The moment they answer "No" they get
  today's welcome and reminders (items 136, 141). A doctor who goes straight
  through today's wizard gets today's emails unchanged.
- Sign-in page wording is neutral, and onboarding starts with that one extra
  question. An overseas doctor's saved onboarding gains one extra recorded
  answer.
- If the app cannot read a doctor's details at a moment it needs them, it now
  holds back rather than guessing (for example roles shown blurred, a
  placement's follow-up steps held until the next visit). `CONVENTIONS.md`
  section 2 lists each case.
- On staff task screens, protected Australian tasks can only be changed
  through their own buttons (item 144). Ordinary overseas tasks are unchanged;
  with the switch on, some staff task actions make one or two extra database
  reads.

## Database changes (all additive; none applied to the live database)

Fourteen migration files, named `*au_gp*` in `supabase/migrations/`. They add new
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
| `20261123110000_au_gp_fr1_server_owned_columns_guard.sql` | A lock so a signed-in doctor cannot write the new pathway fields on their own profile directly through the database (the first review's blocker). Protects only the new fields |
| `20261123120000_au_gp_fr1_doctor_details_cascade.sql` | A deleted doctor's referee and notice details are deleted with their account |
| `20261124100000_au_gp_fr2_server_owned_records.sql` | A server-only record that a doctor has finished onboarding; a doctor cannot mark their own Australian document "approved"; two more protected settings |
| `20261124110000_au_gp_fr3_reviewed_documents_and_cleanup.sql` | An approved Australian document changed by the doctor goes back for review; a deleted doctor's onboarding record is deleted with them |

**Apply them in filename order.** The last four must follow the first ten.
After applying, run the checks written at the top of the last two files
(checks (a) to (g)); if check (a) fails, turn nothing on. Three of the files
widen a list of allowed values by replacing the rule, so the live lists for
case stage and task type must be re-read immediately before applying, in case
the live site has gained a value since 20 November. One of the files writes
one small server-only record per doctor who has already finished onboarding;
it rewrites no existing row.

**Until the lock file is applied to a database, that database has no
protection against a doctor writing "Australian VR GP, confirmed" onto their
own profile.** That is why the switch must not go on anywhere real before the
files are applied and checked.

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
2. Apply the fourteen database files, in filename order, to the live database (already done if you
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
| `final-review.md` | The seven independent reviews: every defect, its severity and its status |
| `PULL-REQUEST.md` | The title and description for the draft pull request |
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

Seven independent reviews were run, each by a fresh agent that was given the
review report, the coverage file and the branch, and not my conclusions. Each
one reviewed and reported; none fixed anything. After each, the blockers and
required defects were fixed and the result went to a new reviewer.

| Round | Commit reviewed | Blockers | Required | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `b22e69eb` | 1 | 9 | A doctor could make themselves a "confirmed" Australian VR GP through the database; fixed with a database lock |
| 2 | `3226d824` | 0 | 5 | Three round-1 items only partly fixed |
| 3 | `073b3f4e` | 0 | 2 | Both introduced by the welcome-email fix |
| 4 | `f9f40b0b` | 0 | 1 | "Download my data" listed staff task titles |
| 5 | `1040e58b` | 0 | 1 | "Download my data" contained overseas wording |
| 6 | `df0a0bb4` | 0 | 2 | The round-5 fix was too broad: it cut doctors' own support messages. Removed and replaced |
| 7 | `efe22200` | 0 | 0 | **No blocker and no required defect remains** |
| 8 | `9052d3fd` | 0 | 1 | Reviewed the "known problems" fix bundle (FR-7). One required defect it introduced (a start-date box pre-filled with a date nobody chose) was fixed straight after and re-checked |

Every round's verdict was the same on one point: ready for the owner to test
on the local stack; not to be switched on for real doctors until the open
items were closed. Round 7 closed them. `final-review.md` has every defect
with how it was reproduced.

What the last review confirmed by running it (not by reading code): the test
suite (11,906 pass; the one failure fails identically on `main`); with the
switch off, signed-out public pages are byte-identical to `main`, a UK
doctor's 18 screens and three emails match, a placed overseas doctor's saved
data and download match a server running `main`, the number of database
requests over a whole overseas journey is equal, and 410 staff task actions
on an overseas case match; nothing rewrites what a doctor typed; an Australian
VR GP goes from sign-up to commencement at phone width with no overseas
wording on any screen or in any message; restricted and non-VR doctors stay
held; nothing left the machine.

### Found by the reviews and NOT fixed

Fix bundle FR-7 (25 November 2026) closed the items that were listed here.
What is still open, plainly:

- From round 8 (the review of FR-7 itself), still open:
  - On the admin screen, the row's main button still says "Mark Complete" on a
    restraint check with no outcome, and "Complete" on the RSO's view of the
    CEO's invoice task. Pressing it shows a red refusal (S8-03).
  - The "Mark placement secured" start date on the CEO candidate page has no
    date limits or clock line (the rest of S8-05 is fixed: the doctor's
    "Date you gave notice" now follows the practice's clock).
  - On "Send offer", the sessions figure the doctor sees does not always
    match what was typed in the new form: 7.5 shows as "Sessions —" (S8-06).
  - If the message ledger is unwritable for a long spell, a new overseas
    doctor can end up with only the neutral welcome (S8-01, S8-02).

- Owner decisions from round 1, unchanged: an unverified, self-declared VR
  doctor can apply to a DPA role (S-07); a placed Australian doctor who
  deletes their account (S-12); who owns a self-signed-up doctor before they
  are submitted (S-13); the case closing itself at week 12 with the invoice
  unsent (S-14). Turning the switch off is not a clean rollback for a placed
  Australian doctor (S-06, accepted).
- Re-read the live value lists immediately before applying the database
  files (S-09).
- Three parts of round 1's S-15: money written without a symbol can slip
  through the match-reason filter; a failed ledger write can lose a week 4,
  8 or 12 message; practice emails cite "clause 7" even when the agreement on
  file is unknown.
- The word filter on shared screens removes a whole sentence that carries a
  banned word (by design).
- About 27 older email call sites put a name into an email without escaping
  it, or escape only part of it. All but two are today's live code and were
  not changed (item 139; the table is in the FR-7 report). Every Australian
  builder was checked: each name is cleaned and escaped once.
- While the task guard's own read is failing, a status change on an overseas
  task answers "try again" (switch on only).

### Rough edges found while following the testing guide

An agent followed every step of Part 1 of `TESTING.md` on screen. Fix bundle
FR-7 fixed these: the RSO who has the case after a placement is now named
(timeline, an email to the placing consultant and the CEO, and an
explanation on an empty RSO list); date boxes and refusals follow and name
the practice's clock; a message held until the doctor's morning is announced
on screen with its real send time; "sessions a week" is a proper form;
an invite link opened where another doctor is signed in shows the password
screen; the Australian introduction email has one honestly named button; the
DPA question comes back when a practice intake is reopened; "View" opens a
document.

Still there, and why:

- **A held message goes later than 8am in the eastern states.** Messages to a
  doctor only go between 8am and 8pm on their clock. One that was held is
  sent by the next morning run, which waits for 8am to arrive everywhere in
  Australia: 8am in Perth, 10am or 11am in Sydney. The screen now says the
  real time. Bringing it forward means an extra scheduled run (owner action
  151).
- **A practice card can show the wrong town** ("Bunbury, NSW") when the
  address was typed by hand. This is in today's live product (owner action
  152).
- **"20 applied" on a role card and "Applications 0" after a placement** are
  today's live rules (owner action 153).
- The agreement preview shows as a grey box on the test copy (item 91); with
  AI off several screens show raw "AI review failed" messages (test copy
  only).

### What no review could check

- What the AI actually writes (AI is off on the local stack).
- The preview website end to end (the live database does not have the new
  fields yet).
- A physical phone.
- Several overseas staff actions that cannot be driven to a real write on the
  local stack (sending SPPA forms, alternative supervisor CV, approving or
  cropping documents): they returned the same response on `main`, with the
  switch off and with it on, but were not fully exercised.
- Google sign-up, and the week 1 to 12 emails inside their real sending
  hours (they were checked from the queue and by building them).
- Segment B's own actions as a full journey.

## WP-29: who sees which roles, registrars, the register check, choosing location (25 and 26 November 2026)

Asked for by the owner after the reviews. It changes two of the owner
decisions this build was made on, so read this before relying on the sections
above.

**What changed in the owner decisions**

- **Decision 1** used to hold every segment B doctor (restricted) until staff
  acted. Now a restricted doctor who is a vocationally registered GP is
  **shown the roles they could work in**: priority-area (DPA) roles when a
  location limit applies, and, if their right to work is tied to an employer,
  only roles whose practice says it offers sponsorship. Supervision never
  hides a role (every GP Link practice accepts supervised doctors). Limited
  and provisional registration is still "not vocationally registered" and
  still held.
- **Decision 2** (fail closed on 19AB) used to mean a doctor saw only DPA
  roles until **staff** confirmed 19AB does not apply. Now the best answer
  available decides what the **doctor sees**: staff first, then the Ahpra
  register (when the lookup is on and the name matches), then the doctor's own
  sign-up answer. A doctor who says "it does not apply" sees and can apply for
  roles outside a DPA straight away. "Applies", "Not sure", no answer and
  anything unreadable still mean DPA roles only. **A practice is never
  contacted on the doctor's word alone:** "Submit to practice" refuses until
  the register check is complete and, for a practice outside a DPA, until the
  register or a staff member says the doctor is free to work there. Staff see
  an amber line on such an application.
- **Registrars** (doctors in training) are not placed. They see "We place
  fully qualified GPs" on the finish screen, Careers, home and in their email,
  with a Message us button, and staff are not asked to review them. If they
  later change their answers, that goes to a person.
- **Non-VR doctors who are not registrars** are held exactly as before
  (decision 5 unchanged).

**The one rule.** Every Australian doctor is sorted into one of four groups
("Can work anywhere", "Priority areas only (DPA)", "Registrar: not placed",
"Non-VR: held"), possibly marked "Needs a person", by one function
(`lib/au-work-sorting.js`). Staff see the group, the reason in a sentence and
any flags on the candidate page and in the Candidates list. The plain-English
description, the table of cases and the limits are in
`docs/au-gp/ahpra-register-lookup.md`.

**The Ahpra register lookup.** Built, tested against saved pages, and
**switched off**. When you turn it on (`AHPRA_LOOKUP_PROVIDER=ahpra_public`)
the app reads one doctor's public register entry when they finish sign-up,
sorts them from it, and completes the register check without a person when
everything it read was clean. Everything else is handed to staff with the
form filled in and the reasons listed.

**Choosing location.** The first Australian sign-up screen now asks "Where
are you based?" (a search over a built-in list of 17,731 Australian suburbs
and towns; no outside service) and "How far would you go for the right
practice?" (a commute, the state, specific places, or anywhere). Roles are
put in order by it and each role says how far it is ("About 12 km from
Parramatta" / "Outside the area you chose"). It never hides a role. The same
choice is in Account, staff see it in words, and the AI match is told about
it (suburb level only, never an address).

**What is NOT possible**

- The Ahpra register does **not** show whether section 19AB applies. The app
  works it out from what the register does show (the pathway named, the
  primary medical degree, the first registration date) plus the doctor's right
  to work. That is a simplification of the law: exemptions and scaling cannot
  be seen, so it errs to "restricted" and staff can override.
- Ahpra offers no open connection to the register. The contracted one
  (Practitioner Information Exchange, PIE) needs a signed agreement and fees.
  The lookup reads the public web page instead; that page can change, and
  Ahpra has objected to bulk automated collection (this is one lookup per
  onboarding doctor, never bulk).
- Fellowship and right to work are not on the register: they still come from
  the doctor and from staff.
- "About 45 minutes" is measured as 45 km in a straight line.

**No database change.** WP-29 added no table and no column. What the lookup
found and the location choice are kept in the server-only store the build
already uses (`runtime_kv`).

**Left as they were, on purpose (for you or the lead to decide)**

- The red "Needs review" label still shows on every unconfirmed or segment B
  doctor, beside the new group label, even when the register check completed
  by itself. "Needs a person" is the label that means a person really has to
  look.
- The "nothing has happened for a while" reminder still skips segment B
  doctors at the matching stage.
- When the lookup finds a problem (wrong name, not found), the doctor has
  already seen "You're all set" a moment earlier; Careers then shows the
  holding card. The lookup runs after the doctor's request so that sign-up
  never waits on Ahpra's website.
- On the live hosting that background run is best effort; if it does not
  finish, the Ahpra check card says no lookup has run and the button runs it.

Owner actions 156 to 165. Tests: `tests/au-wp29-*.test.js` (five files).

