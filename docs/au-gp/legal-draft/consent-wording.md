# Proposed consent wording

**DRAFT - FOR LEGAL REVIEW - NOT PUBLISHED**

Work package WP-25. Written 20 November 2026. None of these lines is on any
page. Each is a proposal for a lawyer to confirm or change, and each names the
package that would put it on a screen. The `[LEGAL REVIEW n]` numbers refer to
the list in `docs/au-gp/privacy-terms-legal-review.md`.

Rules followed in the wording:

- Short enough to sit under a button on a phone.
- The Australian variants never use the words the build bans for an Australian
  doctor (AGENT-RULES section 4). They say "right to work", never the banned
  word for it, and "Ahpra", never "AHPRA".
- A tick box that asks for something optional starts **unticked**, and the form
  works the same whether or not it is ticked.
- Every consent is **recorded**: what was agreed, when, and which version of the
  wording was shown. Each section says where.

What is on the pages today, for comparison:

| Place | Today's wording |
| --- | --- |
| `/start` booking form (`pages/site-start.html:453`) | "We'll only contact you about your enquiry. Privacy policy." |
| Sign-up (`pages/signin.html:1000`) | Footer links to the privacy policy and terms. No statement, no tick box. |
| Onboarding (`pages/onboarding.html`) | None. |
| Applying for a role (`pages/job.html:1507-1514`) | "Apply for an interview? You can interview for up to 3 positions per month…" Nothing about what is sent to the practice. |
| Practice lead form (`pages/site-employers.html:562`) | "By sending this you agree to us contacting you about GP placement. We never share your details." |
| Practice intake (`pages/practice-intake.html`) | The practice signs the Recruitment Services Agreement. No privacy line. |

---

## A. The `/start` booking form, and the future Australian landing page

Wired by: **WP-15** (the `/start` question), **WP-21** (the Australian landing
page). Recording: three new nullable columns on `site_enquiries`
(`consent_contact_at`, `consent_ai_call`, `consent_wording_version`), added by
whichever of those packages ships first.

### A1. Contact consent (shown under the submit button; not a tick box)

**Overseas audience**

> By continuing you agree that GP Link may contact you about your enquiry by
> email, WhatsApp and phone, and that we handle your details as set out in our
> [Privacy Policy]. You can ask us to stop at any time.

**Australian audience**

> By continuing you agree that GP Link may contact you about your enquiry by
> email, WhatsApp and phone, and that we handle your details as set out in our
> [Privacy Policy]. Your enquiry is confidential: we never contact your current
> practice. You can ask us to stop at any time.

Helper text under the email and phone fields, Australian audience only:

> Use a personal email and mobile, not your practice's.

`[LEGAL REVIEW 5]` Is "by continuing you agree" enough for email and WhatsApp
follow-ups (booking link, reminders, later updates), or must it be a tick box?
`[LEGAL REVIEW 8]` Can "we never contact your current practice" be promised
without exception?

### A2. AI-assisted phone calls (separate tick box, unticked, optional)

The same line for both audiences:

> ☐ Optional: I'm happy for GP Link's AI phone assistant to call me about my
> enquiry. I understand calls with the assistant are recorded and transcribed.
> If I leave this unticked, only a person will call me.

Why it is written this way:

- It asks permission for something that **may** happen. It does not say a call
  will come, so it is true today (when the assistant does not ring Australian
  numbers at all) and stays true if she is ever switched on for them.
- It covers the three things a lawyer is being asked about in one line: that it
  is an AI, that it is a phone call, and that it is recorded.
- Unticked means the lead must never be rung by the assistant. The code that
  decides whether to ring (`leadCallDecision` in `lib/lead-calls.js`) would need
  a new first check: no recorded `consent_ai_call`, no AI call.

`[LEGAL REVIEW 3]` `[LEGAL REVIEW 4]` Is this wording, with a tick, enough for
an AI call and for recording it, in every state and territory and for doctors
in the UK, Ireland and New Zealand? Should "recorded" be a separate tick?

**Three things the owner needs to know before this line is wired:**

1. **It would reduce calls to overseas leads.** Today the assistant rings
   overseas leads who filled in a form that said only "We'll only contact you
   about your enquiry". If the tick box goes on the overseas form and is
   honoured, she may only ring leads who ticked it. That is a business decision
   with a legal question behind it (`[LEGAL REVIEW 3]` asks whether today's
   calls to UK numbers have a sufficient basis).
2. **Facebook and Instagram lead forms never show this page.** A lead who fills
   in Meta's own form sees only what is written in that form. The same wording
   would have to be added there as a custom disclaimer and tick box (an owner
   action in Meta Ads), and the answer carried into the lead record.
3. **Old leads have no recorded consent.** Nothing here covers people who
   enquired before the wording went live.

### A3. Where a doctor is asked their mobile number again (booking confirmation, callback request)

No new consent. Add one line of reassurance for the Australian audience:

> We'll use this number only to reach you about your enquiry.

---

## B. Sign-up and onboarding

Wired by: **WP-05** (the Australian onboarding branch). Recording:
`gp_credentials.self_declared_at` already stamps when the doctor's answers are
saved; add `user_profiles.terms_accepted_at` and `terms_version` (new, nullable)
for B1.

### B1. Creating an account (both audiences; under the "Create account" button)

> By creating an account you agree to our [Terms of Service] and
> [Privacy Policy].

`[LEGAL REVIEW 15]` Is a statement under the button enough to bind a doctor to
the terms, or should it be a tick box?

### B2. Registration details

**Australian audience** (above the Ahpra number field)

> We ask for your Ahpra registration number and details so we only show you
> roles you can take up. We check them against the public Ahpra register. We
> never contact your current practice.

Tick box, **required** to continue (this is a confirmation, not an optional
extra, so it is not pre-ticked and the form does not proceed without it):

> ☐ These details are correct to the best of my knowledge, and I agree to
> GP Link checking them on the public Ahpra register now and from time to time.

**Overseas audience** (the existing register check step; the regulator name is
filled in from the doctor's country)

> ☐ These details are correct to the best of my knowledge, and I agree to
> GP Link checking them on the public register of my medical regulator.

`[LEGAL REVIEW 14]` Is agreement needed at all to look someone up on a public
register, and is there any limit on recording what the register shows
(conditions, undertakings, reprimands)?

### B3. Conditions, the Medicare billing restriction, right to work, indemnity

**Australian audience** (one line above this group of questions)

> These answers are seen only by the GP Link team working with you. A practice
> sees nothing about you until you agree to be put forward to it.

`[LEGAL REVIEW 2]` Some of these answers may be "sensitive information" or
government identifiers. Does collecting them need its own express consent line,
separate from B2?

### B4. Uploading a CV or documents (both audiences; under the upload control)

> We use AI tools to read and check documents. A person makes the final call.
> [How we handle documents]

The link goes to the "AI tools" section of the privacy policy.
`[LEGAL REVIEW 7]`

---

## C. "Put me forward to this practice"

Wired by: **WP-22** (job page and apply carry-through) for the screen, **WP-09**
(the practice-facing introduction) for what is actually sent. Recording: new
nullable columns `gp_applications.profile_share_consent_at` and
`profile_share_consent_version`, written by `POST /api/career/apply`; for an
Australian doctor `submit-to-practice` refuses an application without them (see
`data-access-rule.md`, change C9).

Shown on the confirmation sheet, with the practice's name filled in. The button
is disabled until the box is ticked. One consent covers one practice.

**Australian audience**

> **Put me forward to [Practice name]?**
>
> We'll send [Practice name] your name, a short introduction, your CV and your
> Ahpra registration number. Nothing else, and nobody else.
>
> ☐ I agree to GP Link sending my details to [Practice name] for this role.
>
> We never contact your current practice. Tell us if there is anyone at
> [Practice name] who should not know yet.

**Overseas audience**

> **Apply for an interview at [Practice name]?**
>
> We'll send [Practice name] your name, a short introduction and your CV.
>
> ☐ I agree to GP Link sending my details to [Practice name] for this role.

Where a role is shown without the practice's name (a doctor who has not yet
uploaded a CV sees unnamed roles today), the doctor cannot give this consent,
because they cannot know who would receive their details. The sheet must name
the practice or not be offered.

When staff suggest a match and the doctor accepts it ("Fast-track me"), the
same sheet and the same tick apply. A match must never be sent to a practice on
the strength of an earlier consent to a different practice.

Withdrawing (on the application page, both audiences):

> Withdraw my application. [Practice name] will be told you've withdrawn. They
> may already have your CV; we will ask them to delete it.

`[LEGAL REVIEW 9]` Is per-practice consent worded like this sufficient, and
what must happen to information already sent when a doctor withdraws?
`[LEGAL REVIEW 8]` As for A1. `[LEGAL REVIEW 18]` Is the practice bound to
delete it?

Whether the registration number is included in what is sent is owner decision B
in `data-access-rule.md`. If the answer is no, delete "and your Ahpra
registration number" from the Australian line.

---

## D. Practices

Wired by: **WP-23** (employers page, practice lead form and intake).

### D1. Practice lead form (`/employers`), under the submit button

> By sending this you agree that GP Link may contact you about recruiting GPs,
> by email and phone, and that we handle your details as set out in our
> [Privacy Policy]. We don't pass your details to anyone else.

("We never share your details" on the live page is replaced: practice details
are shown to doctors on a role, which is a kind of sharing.)

### D2. Practice intake (the form a practice fills in before signing)

> The practice details you give us are used to prepare your agreement and your
> job listing. Doctors see the practice's name and the role; they see the
> street address and your team's contact details only after you accept them.
> [Privacy Policy]

### D3. On every candidate introduction a practice receives (email footer and decision page)

> Dr [Name] has agreed to be introduced to your practice for this role only.
> Please keep this confidential: do not contact their current practice or pass
> on their details. If you do not proceed, please delete their CV.

`[LEGAL REVIEW 18]` Should these obligations be in the Recruitment Services
Agreement rather than, or as well as, a line in an email? D3 is not a consent
from the practice; it only tells them the conditions.

### D4. Meetings with a practice or a doctor on Zoom (in the calendar invitation; both audiences)

> We use Zoom's AI note-taker to summarise our calls so we don't miss anything.
> Tell us at the start if you'd rather we didn't.

`[LEGAL REVIEW 19]`

---

## What each line needs before it can go live

| Line | Lawyer | Owner | Code |
| --- | --- | --- | --- |
| A1 | LR 5, 8 | Confirm the employer promise is one the business keeps (owner question 7) | WP-15 / WP-21 |
| A2 | LR 3, 4 | Decide whether to apply it to overseas forms; add it to Meta lead forms | WP-15 / WP-21, plus the dialler check |
| B1 | LR 15 | Effective dates | WP-05 |
| B2, B3 | LR 2, 14 | None | WP-05 |
| B4 | LR 7 | None | WP-05 / WP-07 |
| C | LR 8, 9, 18 | Decision B (registration number to practices); whether overseas doctors get the tick too | WP-22, WP-09 |
| D1 to D3 | LR 18 | None | WP-23, WP-09 |
| D4 | LR 19 | Confirm the note-taker is on for all calls | WP-17 |
