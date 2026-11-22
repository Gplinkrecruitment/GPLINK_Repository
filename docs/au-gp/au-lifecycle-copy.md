# Australian lifecycle messages: the copy deck

Written by WP-17. **Generated from the code** (`lib/au-messages.js`, the registry `AU_MESSAGES` and the builders the server sends through) by `tests/helpers/au-wp17-copy.js`; `tests/au-wp17-copy.test.js` fails if this file and the code disagree. To change a word, change it in the builder and regenerate (`WP17_WRITE_COPY=1 npx vitest run tests/au-wp17-copy.test.js`).

**Who gets these.** Doctors on an Australian pathway and the practices hiring them, and only with the Australian switch on. Every other doctor and practice, and everyone with the switch off, gets exactly the messages they get today. The messages a *lead* gets before they have an account (N01 to N03) are in `au-lead-copy.md`.

**Rules every message keeps.** None of the words a doctor already working in Australia should never read (MyIntealth, AMC, EPIC, visa, relocation, "your move", overseas, internationally trained, GMC, SPPA, Section G, supervisor CV, "Not yet eligible"); the one named exception is N21 to a segment B doctor whose right to work is tied to a sponsor. No dollar figures and no percentages. Nothing commercial ever reaches a doctor: no fee, invoice or credit, and not the word "guarantee". A practice is never told a doctor is "internationally trained" or on the "Expedited Specialist Pathway". The line "We never contact your current practice without asking you first." in exactly those words. The regulator is written "Ahpra". Dates are Australian calendar dates ("1 February 2027"); no message states a clock time.

**Once each.** Every part of every message (the email, the bell item, the email to the practice, the WhatsApp) is claimed in the once-ever ledger (`gp_nudge_log`) before it is sent, so a double click, two overlapping jobs or a retry never sends it twice. A part that could not be sent gives its claim back and is tried again.

**Quiet hours.** A message that goes because time has passed, or because a staff member did something at whatever hour they happened to be working, is only sent between 08:00 and 20:00 on the doctor's own clock. Outside those hours it waits, unmarked, for the next run inside them. A message that answers something the doctor just did is not held.

**WhatsApp.** Of these, only the match invitation goes by WhatsApp today (through the existing template, whose approved wording was read and is neutral). For the others no Australian template is approved yet, so the WhatsApp leg is skipped (the reason is written on the case timeline) and the email carries the message. What to submit is in `whatsapp-templates.md`; the drafts are also at the end of this file.

**Who the doctor is told is looking after them.** Before a placement: "your GP Link consultant". After it: "your GP Link team". The job title "Registration Support Officer" is never written to an Australian doctor; an overseas doctor still reads it exactly as before.

## The messages at a glance

| # | Message | To | When | Channel | Quiet hours | Once | Built |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N04 | Welcome | doctor | When a new account is known to be an Australian doctor's: at email verification if the address matches an Australian-segment lead, otherwise the moment they answer "yes" to the first onboarding question. It replaces the overseas welcome, which such a doctor never receives. | email; WhatsApp only through the Australian template `welcome` (not approved: skipped, the reason is recorded) | not held | once ever | built new in WP-17 |
| N05 | Finish your profile (reminders) | doctor | A doctor who started the Australian onboarding branch (or was added by staff on an Australian pathway) and has not finished it: 1 hour, 24 hours, 3 days and 7 days after they were last active. Stops when they finish, unsubscribe or turn reminder emails off; starts again from the top if they come back and leave again. | email; WhatsApp only through the Australian template `onboarding_nudge` (not approved: skipped, the reason is recorded) | held | once per reminder per spell away | built new in WP-17 |
| N06 | Ahpra check result | doctor | When staff save the Ahpra register check. "Verified" only once the doctor is fully cleared (number matched, launched segment, staff-confirmed, nothing flagged). "Not matched" whenever the number could not be matched. | email; bell | not held | verified: once ever; not matched: once per number | finalised (first cut by WP-06) |
| N07 | Segment review (staff task) | staff | When the Ahpra check shows a condition, undertaking or notation, or the doctor is in segment B or C. A task for a person; nothing is sent to the doctor. | a staff task (`segment_review`): nothing is sent | not applicable | one open task per case | confirmed (built by WP-06) |
| N08 | Profile complete | doctor | The moment a doctor finishes the Australian onboarding branch. Replaces "Profile Complete: the next step is MyIntealth", which an Australian doctor never receives. | email | not held | once ever | built new in WP-17 |
| N09 | Match invitation, reminder, final call | doctor | When staff shortlist the doctor for a role; again with 24 hours left and with 2 hours left. These are the existing match emails. For an Australian doctor the reasons are the Australian ones and the tags that do not apply are hidden. | email; bell; WhatsApp only through the Australian template `match_invitation` (approved) | invitation and 24-hour reminder: not held; final call: held | once per invitation | confirmed (the existing emails; reasons and tags by WP-08) |
| N10 | Introduction to the practice | practice | When staff submit the doctor to a practice. Says only what is on file. | email; WhatsApp only through the Australian template `practice_intro` (approved) | not held | once per submission | confirmed (built by WP-09) |
| N11 | Placement secured: your pre-start checklist | doctor | When a placement is recorded for the doctor. | email; bell; WhatsApp only through the Australian template `placement_secured` (not approved: skipped, the reason is recorded) | not held | once per placement | finalised (first cut by WP-11) |
| N12 | Placement confirmed | practice | When a placement is recorded. Replaces the overseas "Placement confirmed", which promises AHPRA steps. | email | not held | once per placement | finalised (first cut by WP-11) |
| N13 | Needed before you start | doctor | When staff ask for a pre-start item, and automatically 3 and 7 days after the placement for required documents still missing. | email; bell | held (the automatic reminders); not held (a staff request) | once per request | finalised (first cut by WP-11) |
| N14 | What we need from your practice | practice | When staff ask the practice to sign or supply something before the start date. | email | not held | once per request | finalised (first cut by WP-11) |
| N15 | Notice given, start date confirmed | doctor and practice | Twice: when the doctor records in the app that they have given notice, and when staff confirm the start date. A start date that later changes sends one correction. | email; bell; email to the practice | notice: not held; start date: held | once per notice date; once per confirmed start date | built new in WP-17 |
| N16 | Cleared to start | doctor | When the last of the four pre-start tasks is completed (start date confirmed, indemnity certificate approved, provider number recorded, credentialing pack sent), and checked again by the daily job in case that moment was missed. | email; bell; WhatsApp only through the Australian template `cleared_to_start` (not approved: skipped, the reason is recorded) | held | once per placement | built new in WP-17 |
| N17 | A quick reminder (stalled) | doctor | 14 and 28 days after the milestone the case is aged from (profile finished, for a doctor not yet placed; the placement recorded, for pre-start), and only if something is waiting on the doctor: a match they have not answered, a required document not uploaded, notice not recorded, referees not given, a provider number not recorded. With nothing of theirs outstanding, nothing is sent. | email | held | once per mark (day 14, day 28) | built new in WP-17 |
| N18 | First week check-in | doctor and practice | 7 days after staff confirm the doctor started. | email; bell; email to the practice; WhatsApp only through the Australian template `commencement_checkin` (not approved: skipped, the reason is recorded) | held (on the practice's clock) | once per placement | finalised (first cut by WP-13) |
| N19 | Check-ins at weeks 4, 8 and 12 | doctor and practice | 4, 8 and 12 weeks after the doctor started. | email; bell; email to the practice | held (on the practice's clock) | once per placement and week | finalised (first cut by WP-13) |
| N20 | Twelve weeks in: thank you | doctor | The day after the twelve weeks end. A thank-you and a referral ask. No reward is offered: none exists. | email; bell | held (on the practice's clock) | once per placement | finalised (first cut by WP-13) |
| N21 | What we have confirmed (segment B) | doctor and practice | Only when a staff member ticks "I have checked each outcome" on the Segment B card and chooses who to send it to. Never automatic. | email; email to the practice | not held | once per set of outcomes per recipient | finalised (first cut by WP-14) |
| N22 | Australian pipeline (owner digest block) | owner | Inside the weekly owner digest, when there is at least one doctor on an Australian pathway. A week with none leaves the digest exactly as it was. | inside the weekly digest email | not applicable | once a week, with the digest | built new in WP-17 |

## What each segment gets

Segment A (`au_vr`) is launched. Segments B (`au_restricted`) and C (`au_non_vr`, `au_registrar`) are built but not launched: a doctor in one of them is never promised roles.

| # | Message | A | B | C | Why |
| --- | --- | --- | --- | --- | --- |
| N04 | Welcome | sent | sent, careful wording | sent, careful wording | The segment is usually not known this early. The main wording is true for any Ahpra-registered doctor; the careful wording is used when a segment B or C answer is already on file. |
| N05 | Finish your profile (reminders) | sent | sent, same words | sent, same words | It is only about finishing the profile and promises nothing about roles, so every segment reads the same words. |
| N06 | Ahpra check result | sent | verified: not sent (a person decides first, N07); not matched: sent | verified: not sent (a person decides first, N07); not matched: sent |  |
| N07 | Segment review (staff task) | raised only when something is flagged | raised | raised |  |
| N08 | Profile complete | sent | sent, careful wording | sent, careful wording | Segments B and C are told a person will be in touch about what fits their registration. No roles are promised. |
| N09 | Match invitation, reminder, final call | sent | not sent (a doctor in an unlaunched segment cannot be matched) | not sent (a doctor in an unlaunched segment cannot be matched) |  |
| N10 | Introduction to the practice | sent | sent, with the 19AB and supervision chips | sent, never called vocationally registered |  |
| N11 | Placement secured: your pre-start checklist | sent | sent, with one extra line about registration | sent, with one extra line about registration |  |
| N12 | Placement confirmed | sent | sent, with a supervision line when the registration needs it | sent |  |
| N13 | Needed before you start | sent | sent | sent |  |
| N14 | What we need from your practice | sent | sent | sent |  |
| N15 | Notice given, start date confirmed | sent | sent | sent | It confirms facts already on file about a placement that exists; it promises nothing. |
| N16 | Cleared to start | sent | not sent | not sent | For segments B and C "cleared to start" can depend on things this checklist does not hold (a nomination transfer, supervision paperwork, a program approval), and those rules are not confirmed. A person tells them. Recorded on the timeline as skipped. |
| N17 | A quick reminder (stalled) | sent | pre-start: sent; before a placement: not sent | pre-start: sent; before a placement: not sent | Before a placement a doctor in an unlaunched segment has nothing they can do, so there is nothing to remind them of. |
| N18 | First week check-in | sent | sent | sent |  |
| N19 | Check-ins at weeks 4, 8 and 12 | sent | sent | sent |  |
| N20 | Twelve weeks in: thank you | sent | sent | sent |  |
| N21 | What we have confirmed (segment B) | not sent | sent by staff only | not sent | The one message where the word "visa" may appear, and only for a segment B doctor whose right to work is tied to a sponsor (the WP-14 exception). |
| N22 | Australian pipeline (owner digest block) | counted | counted, and flagged as needing a person | counted, and flagged as needing a person |  |

In the examples below the doctor is "Dr Test Auvr", the practice is "Test Metro Practice (FAKE)" and the start date is 1 February 2027. `{{name}}` is the doctor's first name.

## N04: Welcome

**When:** When a new account is known to be an Australian doctor's: at email verification if the address matches an Australian-segment lead, otherwise the moment they answer "yes" to the first onboarding question. It replaces the overseas welcome, which such a doctor never receives.

**To:** doctor. **Channel:** email; WhatsApp only through the Australian template `welcome` (not approved: skipped, the reason is recorded).

**Quiet hours:** not held. It answers something the doctor just did (verified their email, or started the Australian branch).

**Once:** once ever (`au_n04_welcome`).

**In the code:** builder `buildWelcomeMessage`; sent by `auSendWelcomeMessage`.

### Main wording (to the doctor)

**Subject:** Welcome to GP Link: finish your profile in a few minutes

**Heading:** Welcome to GP Link, {{name}}

> Your account is ready. GP Link helps Ahpra-registered GPs find a practice that fits better: the billing mix, the location and the hours you want.
>
> The next step is to finish your profile. It takes a few minutes and you will need:
> • Your Ahpra registration number
> • When you could be available
> • Your notice period
>
> Once that is done we check your registration on the public Ahpra register and come back to you about the roles that fit.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Finish my profile (https://app.mygplink.com.au/pages/onboarding)

**Footer:** Questions? Reply to this email and our team will help.

### Careful wording (segment B or C already on file) (to the doctor)

**Subject:** Welcome to GP Link: finish your profile in a few minutes

**Heading:** Welcome to GP Link, {{name}}

> Your account is ready. GP Link helps Ahpra-registered GPs find a practice that fits better: the billing mix, the location and the hours you want.
>
> The next step is to finish your profile. It takes a few minutes and you will need:
> • Your Ahpra registration number
> • When you could be available
> • Your notice period
>
> Once that is done we check your registration on the public Ahpra register and come back to you about what fits your registration.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Finish my profile (https://app.mygplink.com.au/pages/onboarding)

**Footer:** Questions? Reply to this email and our team will help.

## N05: Finish your profile (reminders)

**When:** A doctor who started the Australian onboarding branch (or was added by staff on an Australian pathway) and has not finished it: 1 hour, 24 hours, 3 days and 7 days after they were last active. Stops when they finish, unsubscribe or turn reminder emails off; starts again from the top if they come back and leave again.

**To:** doctor. **Channel:** email; WhatsApp only through the Australian template `onboarding_nudge` (not approved: skipped, the reason is recorded).

**Quiet hours:** held. It goes because time has passed.

**Once:** once per reminder per spell away (`the reminder row (onboarding_reminders.steps_sent), as for the overseas reminders`).

**In the code:** builder `buildOnboardingNudgeMessage`; sent by `auOnboardingNudgeStep`.

### After 1 hour, stopped on step 3 (to the doctor)

**Subject:** Finish your GP Link profile: a few minutes left

**Heading:** You are nearly there, {{name}}

> You started your GP Link profile and it is saved where you left it. You have 4 short steps left, starting with "Your Ahpra registration".
>
> Have your Ahpra registration number to hand and it takes a few minutes.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Continue my profile (https://app.mygplink.com.au/pages/onboarding)

### After 24 hours, stopped on step 3 (to the doctor)

**Subject:** Your GP Link profile is waiting

**Heading:** Pick up where you left off, {{name}}

> Your GP Link profile is still waiting for you. You have 4 short steps left, starting with "Your Ahpra registration".
>
> Once it is finished we check your registration on the public Ahpra register and come back to you about what fits.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Continue my profile (https://app.mygplink.com.au/pages/onboarding)

### After 3 days, stopped on step 3 (to the doctor)

**Subject:** A few minutes to finish your GP Link profile

**Heading:** Still interested, {{name}}?

> It has been a few days since you started your GP Link profile. You have 4 short steps left, starting with "Your Ahpra registration".
>
> If something in the form is unclear, reply to this email and we will help.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Continue my profile (https://app.mygplink.com.au/pages/onboarding)

### After 7 days (the last), stopped on step 6 (to the doctor)

**Subject:** Last reminder: your GP Link profile

**Heading:** This is our last reminder, {{name}}

> This is the last reminder we will send about finishing your GP Link profile. You have 1 short step left, starting with "Confirm your identity".
>
> Your answers stay saved, and you are welcome back whenever you are ready.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Continue my profile (https://app.mygplink.com.au/pages/onboarding)

## N06: Ahpra check result

**When:** When staff save the Ahpra register check. "Verified" only once the doctor is fully cleared (number matched, launched segment, staff-confirmed, nothing flagged). "Not matched" whenever the number could not be matched.

**To:** doctor. **Channel:** email; bell.

**Quiet hours:** not held. It is the result of a check a person has just saved.

**Once:** verified: once ever; not matched: once per number (`au_n06_ahpra_verified / au_n06_ahpra_not_matched:<number>`).

**In the code:** builder `buildAhpraVerifiedMessage, buildAhpraNotMatchedMessage (lib/au-staff-tools.js)`; sent by `auNotifyAhpraCheckResult`.

### Verified (to the doctor)

**Subject:** Your Ahpra registration is confirmed

**Heading:** You are verified, {{name}}

> We have checked your registration on the public Ahpra register and everything matches.
>
> You can now see the GP roles that fit your profile and apply in a couple of taps. Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** See GP roles (https://app.mygplink.com.au/pages/career)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Ahpra registration confirmed: We have checked your registration on the public register. You can now browse GP roles and apply.

### Number not matched (to the doctor)

**Subject:** We could not match your Ahpra number

**Heading:** Please check your Ahpra number, {{name}}

> We looked up the registration number you gave us on the public Ahpra register and could not match it to your name.
>
> This is usually a typing slip. Your number starts with MED followed by ten digits. You can find it on your registration certificate, or by searching your name on the Ahpra register.
>
> Please reply to this email with the correct number and we will check it again straight away.

**Button:** Find my number on the Ahpra register (https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx)

**Footer:** Nothing else is needed from you for now.

**Bell:** Please check your Ahpra number: We could not match the registration number you gave us on the public register. Reply to our email with the correct number and we will check it again.

## N07: Segment review (staff task)

**When:** When the Ahpra check shows a condition, undertaking or notation, or the doctor is in segment B or C. A task for a person; nothing is sent to the doctor.

**To:** staff. **Channel:** a staff task (`segment_review`): nothing is sent.

**Quiet hours:** not applicable. A staff task, not a message.

**Once:** one open task per case (`one open segment_review task per case`).

**In the code:** builder `auStaffTools.buildSegmentReviewTask`; sent by `auRaiseSegmentReviewTask`.

Nothing is sent to the doctor: this is a task for a person.

## N08: Profile complete

**When:** The moment a doctor finishes the Australian onboarding branch. Replaces "Profile Complete: the next step is MyIntealth", which an Australian doctor never receives.

**To:** doctor. **Channel:** email.

**Quiet hours:** not held. It answers something the doctor just did.

**Once:** once ever (`au_n08_profile_complete`).

**In the code:** builder `buildProfileCompleteMessage`; sent by `auSendProfileCompleteMessage`.

### Main wording (segment A) (to the doctor)

**Subject:** Your profile is complete: we are lining up matches

**Heading:** You are all set, {{name}}

> Thanks for finishing your profile.
>
> Here is what happens now:
> • We check your registration on the public Ahpra register, usually within two business days, and email you as soon as it is done.
> • We line up the GP roles that fit what you told us: location, billing mix and hours.
> • When a role looks right you can apply in a couple of taps, or we send you a match to look at.
>
> You can browse roles in the app in the meantime.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** See GP roles (https://app.mygplink.com.au/pages/career)

**Footer:** Questions? Reply to this email and our team will help.

### Careful wording (segments B and C) (to the doctor)

**Subject:** Your GP Link profile is complete

**Heading:** Thanks, {{name}}

> Thanks for finishing your profile.
>
> Here is what happens now:
> • We check your registration on the public Ahpra register.
> • One of our team then looks at your details and gets in touch to talk through what fits your registration.
>
> There is nothing more you need to do for now.
>
> Your enquiry is confidential. We never contact your current practice without asking you first.

**Button:** Open GP Link (https://app.mygplink.com.au/pages/career)

**Footer:** Questions? Reply to this email and our team will help.

## N09: Match invitation, reminder, final call

**When:** When staff shortlist the doctor for a role; again with 24 hours left and with 2 hours left. These are the existing match emails. For an Australian doctor the reasons are the Australian ones and the tags that do not apply are hidden.

**To:** doctor. **Channel:** email; bell; WhatsApp only through the Australian template `match_invitation` (approved).

**Quiet hours:** invitation and 24-hour reminder: not held; final call: held. The invitation follows a staff action and the 24-hour reminder is anchored on the invitation's own deadline. The final call (2 hours before the deadline) is only sent between 08:00 and 20:00 on the doctor's clock; if the deadline passes overnight it is not sent at all.

**Once:** once per invitation (`the application row (match_reminder_sent_at, match_final_call_sent_at)`).

**In the code:** builder `buildMatchEmailHtml (server.js)`; sent by `sendMatchEmail`.

These are the existing emails (their wording is in `server.js`, not repeated here). `tests/au-wp17-existing-messages-server.test.js` renders all three for an Australian doctor and scans them for the banned words.

## N10: Introduction to the practice

**When:** When staff submit the doctor to a practice. Says only what is on file.

**To:** practice. **Channel:** email; WhatsApp only through the Australian template `practice_intro` (approved).

**Quiet hours:** not held. A staff action.

**Once:** once per submission (`the application row`).

**In the code:** builder `careerIntro.buildAuCandidateIntro (lib/career-intro.js)`; sent by `auPracticeIntroFor`.

### A staff-confirmed segment A doctor (to the practice)

**Subject:** (the introduction email)

> Dr Test Auvr is a vocationally registered GP (FRACGP) based in Victoria. GP Link has verified Dr Auvr’s Ahpra registration on the public register, so there is no registration wait. Dr Auvr has about 4 weeks’ notice to give.
>
> Dr Test Auvr has agreed to be introduced to your practice for this role only. Please keep this confidential: do not contact their current practice or pass on their details. If you do not proceed, please delete their CV.

## N11: Placement secured: your pre-start checklist

**When:** When a placement is recorded for the doctor.

**To:** doctor. **Channel:** email; bell; WhatsApp only through the Australian template `placement_secured` (not approved: skipped, the reason is recorded).

**Quiet hours:** not held. It follows the placement being recorded.

**Once:** once per placement (`au_n11_placement_secured:<placement>`).

**In the code:** builder `buildPlacementSecuredMessage (lib/au-placement-messages.js)`; sent by `auSendPlacementSecuredToGp`.

### Segment A (to the doctor)

**Subject:** Your placement is secured: your pre-start checklist

**Heading:** Congratulations, {{name}}

> Your placement at Test Metro Practice (FAKE) is secured. Your expected start date is 1 February 2027.
>
> Before your first day there are a few things to line up. Your pre-start checklist:
> • Notice period and start date: tell us your notice period so we can confirm your start date with the practice.
> • Medicare provider number: you will need a provider number for the new practice location. Let us know once you have applied, and the number when it is issued.
> • Indemnity: upload your current medical indemnity certificate of currency.
> • Credentialing: we put together the pack the practice needs (your Ahpra registration, your indemnity certificate and your other pre-start documents) and send it to them for you.
>
> You can upload your documents and see what is still needed in the app. A member of our team will be in touch to help with each step.
>
> We never contact your current practice without asking you first.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Your placement is secured: Your pre-start checklist is ready: start date, a Medicare provider number for the new location, your indemnity certificate and credentialing. Expected start date: 1 February 2027.

### Segments B and C (to the doctor)

**Subject:** Your placement is secured: your pre-start checklist

**Heading:** Congratulations, {{name}}

> Your placement at Test Metro Practice (FAKE) is secured. Your expected start date is 1 February 2027.
>
> Before your first day there are a few things to line up. Your pre-start checklist:
> • Notice period and start date: tell us your notice period so we can confirm your start date with the practice.
> • Medicare provider number: you will need a provider number for the new practice location. Let us know once you have applied, and the number when it is issued.
> • Indemnity: upload your current medical indemnity certificate of currency.
> • Credentialing: we put together the pack the practice needs (your Ahpra registration, your indemnity certificate and your other pre-start documents) and send it to them for you.
> • Registration: our team will be in touch about anything your registration needs for the new practice.
>
> You can upload your documents and see what is still needed in the app. A member of our team will be in touch to help with each step.
>
> We never contact your current practice without asking you first.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Your placement is secured: Your pre-start checklist is ready: start date, a Medicare provider number for the new location, your indemnity certificate and credentialing. Expected start date: 1 February 2027.

## N12: Placement confirmed

**When:** When a placement is recorded. Replaces the overseas "Placement confirmed", which promises AHPRA steps.

**To:** practice. **Channel:** email.

**Quiet hours:** not held. It follows the placement being recorded.

**Once:** once per placement (`au_n12_placement_confirmed:<placement>`).

**In the code:** builder `buildPlacementConfirmedPracticeMessage (lib/au-placement-messages.js)`; sent by `auSendPlacementConfirmedToPractice`.

### Segment A (to the practice)

**Subject:** Placement confirmed: Dr Test Auvr

> Hi Pat,
>
> Good news: Dr Test Auvr has confirmed the placement for General Practitioner at your practice.
>
> What happens next
> - Start date: the expected start date is 1 February 2027. We confirm Dr Test Auvr's notice period and tell you straight away if that date moves.
> - Provider number: Dr Test Auvr applies for a Medicare provider number for your practice location. We let you know when it is issued.
> - Credentialing: we send you Dr Test Auvr's credentialing pack (Ahpra registration, indemnity certificate and supporting documents) before the start date.
> - Guarantee period: a 12-week guarantee period applies to permanent placements, starting on the day Dr Test Auvr commences. We check in with you and with Dr Test Auvr during that time. The terms are in clause 7 of your Recruitment Services Agreement.
>
> If you have any questions, reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

## N13: Needed before you start

**When:** When staff ask for a pre-start item, and automatically 3 and 7 days after the placement for required documents still missing.

**To:** doctor. **Channel:** email; bell.

**Quiet hours:** held (the automatic reminders); not held (a staff request). The automatic reminders go because time has passed.

**Once:** once per request (`au_n13_prestart_item:<request>`).

**In the code:** builder `buildPrestartItemRequestMessage (lib/au-placement-messages.js)`; sent by `auSendPrestartItemRequest`.

### Two items, automatic reminder (to the doctor)

**Subject:** A few things we need before you start

**Heading:** A few things we need from you, {{name}}

> A quick reminder. To keep your start on 1 February 2027 on track, we need a few things from you:
>
> • Medical indemnity certificate of currency: Upload your current certificate.
> • Your Medicare provider number for the new location: Let us know once you have applied, and send us the number when it is issued.
>
> You can upload documents in the app. For anything else, just reply to this email.

**Button:** Open the app (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** A few things needed before you start: Medical indemnity certificate of currency; Your Medicare provider number for the new location.

## N14: What we need from your practice

**When:** When staff ask the practice to sign or supply something before the start date.

**To:** practice. **Channel:** email.

**Quiet hours:** not held. A staff action.

**Once:** once per request (`au_n14_practice_form:<request>`).

**In the code:** builder `buildPracticeFormNeededMessage (lib/au-placement-messages.js)`; sent by `auSendPracticeFormNeeded`.

### Two items (to the practice)

**Subject:** Dr Test Auvr: what we need from your practice before the start date

> Hi Pat,
>
> To have everything ready for Dr Test Auvr's start on 1 February 2027, we need the following from your practice:
>
> - The details of your practice location that the doctor needs for the Medicare provider number application (practice name, street address and the location's details)
> - First-day details for the doctor: who to ask for, start time and rooms
>
> You can reply to this email with the details or attachments. Thank you.
>
> Kind regards,
> GP Link Recruitment Team

## N15: Notice given, start date confirmed

**When:** Twice: when the doctor records in the app that they have given notice, and when staff confirm the start date. A start date that later changes sends one correction.

**To:** doctor and practice. **Channel:** email; bell; email to the practice.

**Quiet hours:** notice: not held; start date: held. The notice confirmation answers something the doctor just did. The start-date confirmation follows a staff action that can happen at any hour, so it waits for the doctor's day.

**Once:** once per notice date; once per confirmed start date (`au_n15_notice_gp:<placement>:<date> / au_n15_start_gp:<placement>:<date> (and the practice twins)`).

**In the code:** builder `buildNoticeStartGpMessage, buildNoticeStartPracticeMessage`; sent by `auSendNoticeStartMessages`.

### The doctor recorded notice (to the doctor)

**Subject:** Your notice is recorded

**Heading:** Notice recorded, {{name}}

> Thanks for letting us know. We have recorded that you gave notice on 7 December 2026.
>
> Your expected start date at Test Metro Practice (FAKE) is 1 February 2027. We will confirm it with the practice and let you know.
>
> We have told Test Metro Practice (FAKE) that you have given notice. If anything changes on your side, tell your GP Link team straight away.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Your notice is recorded: You gave notice on 7 December 2026. We will confirm your start date with the practice.

### The doctor recorded notice (to the practice)

**Subject:** Dr Test Auvr has given notice

> Hi Pat,
>
> Dr Test Auvr has let us know that notice was given on 7 December 2026.
>
> The expected start date at your practice is 1 February 2027. We will confirm it with you as soon as it is settled.
>
> If you have any questions, reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

### Start date confirmed (to the doctor)

**Subject:** Your start date is confirmed: 1 February 2027

**Heading:** Your start date is confirmed, {{name}}

> Your start date at Test Metro Practice (FAKE) is confirmed: 1 February 2027.
>
> Your notice period is recorded as 8 weeks. You told us you gave notice on 7 December 2026.
>
> The practice has the same date. If anything changes on your side, tell your GP Link team straight away so we can sort it out with the practice.
>
> Your pre-start checklist shows what is still to do before your first day.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Your start date is confirmed: Start date at Test Metro Practice (FAKE): 1 February 2027.

### Start date confirmed (to the practice)

**Subject:** Dr Test Auvr: start date confirmed, 1 February 2027

> Hi Pat,
>
> The start date for Dr Test Auvr at your practice is confirmed: 1 February 2027.
>
> Dr Test Auvr's notice period is 8 weeks. Notice was given on 7 December 2026.
>
> Dr Test Auvr has the same date. Before then we will send you the credentialing pack, and let you know when the Medicare provider number for your location is issued.
>
> If you have any questions, reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

### Start date changed (the correction) (to the doctor)

**Subject:** Your start date has changed: 15 February 2027

**Heading:** A change to your start date, {{name}}

> Your start date at Test Metro Practice (FAKE) has changed. The new confirmed date is 15 February 2027.
>
> Your notice period is recorded as 8 weeks.
>
> The practice has the same date. If anything changes on your side, tell your GP Link team straight away so we can sort it out with the practice.
>
> Your pre-start checklist shows what is still to do before your first day.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Your start date has changed: New start date at Test Metro Practice (FAKE): 15 February 2027.

### Start date changed (the correction) (to the practice)

**Subject:** Dr Test Auvr: start date changed to 15 February 2027

> Hi Pat,
>
> The start date for Dr Test Auvr at your practice has changed. The new confirmed date is 15 February 2027.
>
> Dr Test Auvr's notice period is 8 weeks.
>
> Dr Test Auvr has the same date. Before then we will send you the credentialing pack, and let you know when the Medicare provider number for your location is issued.
>
> If you have any questions, reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

## N16: Cleared to start

**When:** When the last of the four pre-start tasks is completed (start date confirmed, indemnity certificate approved, provider number recorded, credentialing pack sent), and checked again by the daily job in case that moment was missed.

**To:** doctor. **Channel:** email; bell; WhatsApp only through the Australian template `cleared_to_start` (not approved: skipped, the reason is recorded).

**Quiet hours:** held. It follows a staff action that can happen at any hour.

**Once:** once per placement (`au_n16_cleared_to_start:<placement>`).

**In the code:** builder `buildClearedToStartMessage`; sent by `auMaybeSendClearedToStart`.

### Segment A (to the doctor)

**Subject:** You are cleared to start on 1 February 2027

**Heading:** You are cleared to start, {{name}}

> Everything on your pre-start checklist is done. You are cleared to start at Test Metro Practice (FAKE) on 1 February 2027.
>
> What is in place:
> • Your start date is confirmed with the practice.
> • Your Medicare provider number for the new location is recorded.
> • Your indemnity certificate is on file.
> • Your credentialing pack has gone to the practice.
>
> There is nothing more you need to send us. If anything changes before your first day, tell your GP Link team straight away.
>
> We will check in with you after your first week.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** You are cleared to start: Your pre-start checklist is complete. Start date at Test Metro Practice (FAKE): 1 February 2027.

## N17: A quick reminder (stalled)

**When:** 14 and 28 days after the milestone the case is aged from (profile finished, for a doctor not yet placed; the placement recorded, for pre-start), and only if something is waiting on the doctor: a match they have not answered, a required document not uploaded, notice not recorded, referees not given, a provider number not recorded. With nothing of theirs outstanding, nothing is sent.

**To:** doctor. **Channel:** email.

**Quiet hours:** held. It goes because time has passed.

**Once:** once per mark (day 14, day 28) (`au_n17_stalled:match:<mark> / au_n17_stalled:prestart:<placement>:<mark>`).

**In the code:** builder `buildStalledReminderMessage`; sent by `auSendStalledReminder`.

### Pre-start, three things waiting on the doctor (to the doctor)

**Subject:** Before you start: a few things are waiting on you

**Heading:** A quick reminder, {{name}}

> To keep your start at Test Metro Practice (FAKE) on 1 February 2027 on track, there are a few things that only you can do:
>
> • Tell us when you have given notice: Record the date in your checklist so we can confirm your start date.
> • Medical indemnity certificate of currency: Upload your current certificate.
> • Two referees: Give us two people we can speak to. We ask you before contacting anyone at your current practice.
>
> Everything else is with us or the practice, and we will tell you when anything changes. If something is holding you up, reply to this email and your GP Link team will help.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

### Not yet placed, one match not answered (to the doctor)

**Subject:** One thing is waiting on you

**Heading:** A quick reminder, {{name}}

> A quick reminder about something that is waiting on you:
>
> • A role we matched you to is waiting for your answer: Open it in the app and tell us yes or no. Either answer helps.
>
> If a role is not right, say so in the app and tell us why: it helps us find a better fit. If you would like to talk it through first, reply to this email and your GP Link consultant will be in touch.
>
> We never contact your current practice without asking you first.

**Button:** Open GP Link (https://app.mygplink.com.au/pages/career)

**Footer:** Questions? Reply to this email and our team will help.

## N18: First week check-in

**When:** 7 days after staff confirm the doctor started.

**To:** doctor and practice. **Channel:** email; bell; email to the practice; WhatsApp only through the Australian template `commencement_checkin` (not approved: skipped, the reason is recorded).

**Quiet hours:** held (on the practice's clock). It goes because time has passed.

**Once:** once per placement (`au_lc:week1:<placement> (owner) + au_n18_week1_gp / au_n18_week1_practice`).

**In the code:** builder `buildCommencementCheckinGpMessage, buildCommencementCheckinPracticeMessage (lib/au-placement-messages.js)`; sent by `runLifecycleSweep`.

### To the doctor (to the doctor)

**Subject:** How was your first week?

**Heading:** One week in, {{name}}

> You have finished your first week at Test Metro Practice (FAKE). We hope it went well.
>
> How are you settling in? If anything is not as you expected (your rooms, the systems, your bookings, your provider number), tell us and we will help sort it out with the practice.
>
> Just reply to this email, or message your GP Link team in the app. We will check in with you again over the coming weeks.

**Button:** Message us (https://app.mygplink.com.au/pages/messages)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** How was your first week?: We hope your first week at Test Metro Practice (FAKE) went well. Tell us if anything needs sorting out.

### To the practice (to the practice)

**Subject:** Dr Test Auvr: first week check-in

> Hi Pat,
>
> Dr Test Auvr has now completed the first week at your practice. We hope it has gone well.
>
> How is Dr Test Auvr settling in? If anything needs attention (rooms, systems, bookings, or anything you expected to be in place and is not), please let us know early so we can help.
>
> We will check in with you and with Dr Test Auvr again at weeks 4, 8 and 12.
>
> Just reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

## N19: Check-ins at weeks 4, 8 and 12

**When:** 4, 8 and 12 weeks after the doctor started.

**To:** doctor and practice. **Channel:** email; bell; email to the practice.

**Quiet hours:** held (on the practice's clock). It goes because time has passed.

**Once:** once per placement and week (`au_lc:checkin:<placement>:w4|w8|w12 (owner) + au_n19_checkin_w<N>_gp / _practice`).

**In the code:** builder `buildWeekCheckinGpMessage, buildWeekCheckinPracticeMessage (lib/au-placement-messages.js)`; sent by `runLifecycleSweep`.

### Week 4, to the doctor (to the doctor)

**Subject:** Checking in: 4 weeks at Test Metro Practice (FAKE)

**Heading:** 4 weeks in, {{name}}

> You are 4 weeks in at Test Metro Practice (FAKE). This is our week 4 check-in.
>
> How is it going? We would like to hear what is working well and anything that is not: your patient bookings, the support you are getting, or anything you were told to expect that has not happened.
>
> Reply to this email, or message your GP Link team in the app, and one of us will be in touch.

**Button:** Message us (https://app.mygplink.com.au/pages/messages)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Week 4 check-in: You are 4 weeks in at Test Metro Practice (FAKE). Tell us how it is going.

### Week 4, to the practice (to the practice)

**Subject:** Dr Test Auvr: week 4 check-in

> Hi Pat,
>
> Dr Test Auvr has now been with your practice for 4 weeks. This is our week 4 check-in.
>
> How is the placement going from your side? Please tell us about anything that is not working, however small, so we can help early.
>
> These check-ins are part of the 12-week guarantee period, which runs until 26 April 2027. The terms, including what we need you to tell us and when, are in clause 7 of your Recruitment Services Agreement.
>
> Just reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

### Week 12, to the doctor (to the doctor)

**Subject:** Checking in: 12 weeks at Test Metro Practice (FAKE)

**Heading:** 12 weeks in, {{name}}

> You are 12 weeks in at Test Metro Practice (FAKE). This is our week 12 check-in.
>
> How is it going? We would like to hear what is working well and anything that is not: your patient bookings, the support you are getting, or anything you were told to expect that has not happened.
>
> Reply to this email, or message your GP Link team in the app, and one of us will be in touch. This is the last of our scheduled check-ins, but we are always here if you need us.

**Button:** Message us (https://app.mygplink.com.au/pages/messages)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Week 12 check-in: You are 12 weeks in at Test Metro Practice (FAKE). Tell us how it is going.

### Week 12, to the practice (to the practice)

**Subject:** Dr Test Auvr: week 12 check-in

> Hi Pat,
>
> Dr Test Auvr has now been with your practice for 12 weeks. This is our week 12 check-in.
>
> How is the placement going from your side? Please tell us about anything that is not working, however small, so we can help early.
>
> This is the last check-in of the 12-week guarantee period, which ends on 26 April 2027. The terms are in clause 7 of your Recruitment Services Agreement.
>
> Just reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

## N20: Twelve weeks in: thank you

**When:** The day after the twelve weeks end. A thank-you and a referral ask. No reward is offered: none exists.

**To:** doctor. **Channel:** email; bell.

**Quiet hours:** held (on the practice's clock). It goes because time has passed.

**Once:** once per placement (`au_lc:referral:<placement> (owner) + au_n20_referral_ask:<placement>`).

**In the code:** builder `buildReferralAskMessage (lib/au-placement-messages.js)`; sent by `runLifecycleSweep`.

### To the doctor (to the doctor)

**Subject:** Twelve weeks in: thank you

**Heading:** Thank you, {{name}}

> You have now been at Test Metro Practice (FAKE) for twelve weeks. Thank you for letting us be part of it.
>
> If you know another GP who is thinking about a new role, we would be glad to help them too. Reply to this email with their name, or simply pass on our details, and we will take it from there. We only ever contact someone who has agreed to hear from us.
>
> And if you ever need anything, your GP Link team is a message away.

**Button:** Message us (https://app.mygplink.com.au/pages/messages)

**Footer:** Questions? Reply to this email and our team will help.

**Bell:** Twelve weeks in: thank you: Know another GP thinking about a new role? We would be glad to help them too.

## N21: What we have confirmed (segment B)

**When:** Only when a staff member ticks "I have checked each outcome" on the Segment B card and chooses who to send it to. Never automatic.

**To:** doctor and practice. **Channel:** email; email to the practice.

**Quiet hours:** not held. A staff action.

**Once:** once per set of outcomes per recipient (`au_n21_segment_b_gp:<placement>:<outcomes> / au_n21_segment_b_practice:…`).

**In the code:** builder `buildSegmentBOutcomeGpMessage, buildSegmentBOutcomePracticeMessage (lib/au-placement-messages.js)`; sent by `auSendSegmentBN21`.

### To the doctor (a citizen or permanent resident: no visa part) (to the doctor)

**Subject:** Your new practice: what we have confirmed

**Heading:** An update for you, {{name}}

> Here is where things stand for your new role at Test Metro Practice (FAKE). Our team has confirmed each of these.
>
> Section 19AB
> We have confirmed that section 19AB applies to you at the moment. That means the locations we can place you in are Distribution Priority Areas, and Test Metro Practice (FAKE) is one.
>
> Supervision
> No new supervision paperwork is needed for this change of practice.
>
> If anything here does not match your situation, tell your GP Link team straight away.

**Button:** Open your checklist (https://app.mygplink.com.au/pages/prestart)

**Footer:** Questions? Reply to this email and our team will help.

### To the practice (to the practice)

**Subject:** Dr Test Auvr: what we have confirmed before the start date

> Hi Pat,
>
> Here is what we have confirmed for Dr Test Auvr's start at your practice, and what we need from you.
>
> - Section 19AB: we have confirmed that section 19AB applies to Dr Test Auvr, so Dr Test Auvr can only work in a Distribution Priority Area. We have checked your practice location against that.
> - Supervision: no supervision paperwork is needed from your practice for Dr Test Auvr.
>
> If you have any questions, reply to this email and our team will help.
>
> Kind regards,
> GP Link Recruitment Team

## N22: Australian pipeline (owner digest block)

**When:** Inside the weekly owner digest, when there is at least one doctor on an Australian pathway. A week with none leaves the digest exactly as it was.

**To:** owner. **Channel:** inside the weekly digest email.

**Quiet hours:** not applicable. Part of the existing weekly email to the owner.

**Once:** once a week, with the digest (`the digest's own weekly marker`).

**In the code:** builder `auPipelineCounts, buildOwnerDigestBlock`; sent by `auOwnerDigestBlock`.

### Nine Australian doctors (to the owner)

**Subject:** (inside the weekly digest)

> Australian GPs: Profile not finished: 2 · Matching: 3 · Pre-start: 2 · Started (first week): 1 · In the guarantee period: 1 · Complete: 0
> Segment A (vocationally registered): 7 · Segment B (restricted): 1 · Segment C (non-VR and registrars): 1

## Staff nudge defaults for an Australian case

When a staff member sends a "nudge" without typing their own message, the default now depends on the doctor. An overseas doctor gets the existing defaults, unchanged. A doctor on an Australian pathway gets one of these, chosen by the stage their case is on; a stage that is not theirs (a staff member typing "myintealth") falls back to their case's own stage.

| Stage | Title | Message |
| --- | --- | --- |
| onboarding | Need a hand finishing your profile? | Your GP Link profile is nearly done. If anything in the form is unclear, reply here or message us and we will help. |
| placement | Anything we can help with? | Just checking in. If you have a question about a role, your profile or what happens next, reply here and we will help. |
| prestart | Need a hand with your pre-start checklist? | Is anything on your pre-start checklist holding you up? Reply here and we will help you sort it out. |
| commenced | How are you settling in? | We hope your first days have gone well. If anything is not as you expected, reply here and we will help sort it out with the practice. |
| guarantee | How is it going? | Just checking in on how things are going at your new practice. If anything needs sorting out, reply here and we will help. |
| anything else | Anything we can help with? | Just checking in. If you have a question or something is holding you up, reply here and we will help. |

## Composer templates for an Australian case

The staff email composer's "Insert template" list, when it is opened for a doctor on an Australian pathway, leaves out the defaults written for a doctor registering from another country (`request_document_gp`, `chase_practice_sppa`, `ahpra_followup`, `welcome_next_steps`) and offers these instead. `{{firstName}}` and the like are filled in by the composer; staff read and edit before sending.

### Australian GP: request a document

**Subject:** A document we need from you: {{documentName}}

> Hi {{firstName}},
>
> Before your first day we need a copy of your {{documentName}}. You can upload it in the GP Link app under your pre-start checklist, or reply to this email with it attached.
>
> If anything is unclear, just reply and we will help.
>
> Kind regards,
> {{rsoName}}
> GP Link

### Australian GP: welcome and next steps

**Subject:** Welcome to GP Link: your next steps

> Hi {{firstName}},
>
> Welcome to GP Link. Here is what happens next:
> 1. Finish your profile in the app. Have your Ahpra registration number to hand.
> 2. We check your registration on the public Ahpra register.
> 3. We come back to you about the roles that fit: location, billing mix and hours.
>
> We never contact your current practice without asking you first.
>
> If you have any questions, just reply to this email.
>
> Kind regards,
> {{rsoName}}
> GP Link

### Australian GP: pre-start check-in

**Subject:** Checking in before your start date

> Hi {{firstName}},
>
> Just checking in ahead of your start at {{practiceName}}. Your pre-start checklist in the GP Link app shows what is done and what is still to do.
>
> If anything is holding you up, reply to this email and we will help.
>
> Kind regards,
> {{rsoName}}
> GP Link

## The practice intake invite

With the Australian switch on, the invite a practice gets to complete its placement application gains one paragraph, after the one about doctors from the UK, Ireland and New Zealand:

> We also place GPs who are already registered and working in Australia and are looking for a practice that fits them better. If you would like to hear about them as well, just tell us.

## Proposed WhatsApp templates

Nothing here has been submitted. Until a row is approved its WhatsApp is skipped and the email carries the message. Rows marked "stands in for" replace an existing template whose approved wording says "your Registration Support Officer": an Australian doctor is not sent the existing one unless the owner switches it on (`whatsapp-templates.md`, section 4).

| Key | Template name | For | Stands in for | Variables | Button | Proposed body |
| --- | --- | --- | --- | --- | --- | --- |
| `welcome` | `gp_link_au_welcome` | N04 |  | {{1}} first name | URL button: "Finish my profile" to https://app.mygplink.com.au/pages/onboarding | Hi {{1}}, welcome to GP Link. Your account is ready.<br><br>The next step is to finish your profile. It takes a few minutes: have your Ahpra registration number to hand.<br><br>We never contact your current practice without asking you first. |
| `onboarding_nudge` | `gp_link_au_onboarding_nudge` | N05 |  | {{1}} first name | URL button: "Continue my profile" to https://app.mygplink.com.au/pages/onboarding | Hi {{1}}, your GP Link profile is saved where you left it and takes a few minutes to finish. Have your Ahpra registration number to hand.<br><br>If anything in the form is unclear, reply here and we will help. |
| `cleared_to_start` | `gp_link_au_cleared_to_start` | N16 |  | {{1}} first name, {{2}} practice name, {{3}} the start date | none | Hi {{1}}, good news: everything on your pre-start checklist is complete, and you are cleared to start at {{2}} on {{3}}.<br><br>If anything changes before then, reply here and we will help. |
| `match_accepted` | `gp_link_au_match_accepted` | N09 | `gp_link_app_match_accepted` | {{1}} first name, {{2}} practice name | none | Hi {{1}}, thanks for accepting your match with {{2}}. We are now arranging your interview and will send you times to choose from, usually within a couple of business days. Reply here if you have any questions. |
| `interview_times_ready` | `gp_link_au_interview_times_ready` | existing "interview times ready" | `gp_link_interview_times_ready` | {{1}} first name, {{2}} practice name | URL button: "Choose your time" to https://app.mygplink.com.au/pages/secure-interview?applicationId={{1}} (the app fills the application id) | Hi {{1}}, great news: {{2}} would like to interview you, and their available times are ready for you to choose from.<br><br>Tap the button below to pick the time that suits you best. It only takes a moment.<br><br>If none of the times work for you, just reply to this message and we will arrange others. |
| `interview_confirmed` | `gp_link_au_interview_confirmed_gp` | existing "interview confirmed" (to the doctor) | `gp_link_interview_confirmed_gp` | {{1}} first name, {{2}} practice name, {{3}} the time on the doctor's own clock, {{4}} the link to join | none | Hi {{1}}, your interview with {{2}} is confirmed for {{3}}.<br><br>Join the video call here when it is time:<br>{{4}}<br><br>If you need to reschedule, just reply to this message and we will sort it out. |
| `interview_confirmed_practice` | `gp_link_au_interview_confirmed_practice` | existing "interview confirmed" (to the practice) | `gp_link_interview_confirmed_practice` | {{1}} contact name, {{2}} the doctor, {{3}} the time on the practice's own clock, {{4}} the link to join | none | Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}.<br><br>Join the video call here when it is time:<br>{{4}}<br><br>If you need to reschedule, just reply to this message and we will arrange a new time. |
| `contract_ready` | `gp_link_au_contract_ready` | existing "contract ready" | `gp_link_contract_ready` | {{1}} first name, {{2}} practice name | URL button: "Complete agreement" to https://app.mygplink.com.au/pages/offer-review?applicationId={{1}} (the app fills the application id) | Congratulations {{1}}, {{2}} has offered you the position.<br><br>The next step is to review your employment agreement and sign it. Tap the button below to open it. If something needs adjusting before you can sign, you can request a change on the same page.<br><br>Any questions, reply here and our team will help. |
| `rso_welcome` | `gp_link_au_team_welcome` | existing "RSO welcome" (F47) | `gp_link_app_rso_welcome` | {{1}} first name, {{2}} the team member's first name, {{3}} the same name again as the sign-off (the same three variables as the existing template) | none | Hi Dr {{1}}, welcome to GP Link.<br><br>I'm {{2}}, and I will be your main point of contact from here to your first day at your new practice.<br><br>Whenever you have a question or need a hand, just send me a message here.<br><br>Warm regards,<br>{{3}}<br>GP Link |
