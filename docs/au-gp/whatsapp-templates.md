# Australian WhatsApp templates: what to submit, and what already works

*Generated from `lib/au-whatsapp-templates.js` and `lib/au-whatsapp-submission.js`. Do not edit by hand: change the code and regenerate (`WP18_WRITE_SHEET=1 npx vitest run tests/au-wp18-sheet.test.js`).*

**Nothing in this file has been sent to DoubleTick or Meta.** It is the list of what you would create there, in the words to type.

## In short

- **9 messages already go by WhatsApp** to Australian GPs and their practices, through templates you already have. On 22 November 2026 we read the approved wording of every existing template and these ones say nothing about moving country, visas or registering. Nothing to submit. (Section 1.)
- **18 new templates to submit** in DoubleTick. Until each is approved, its message goes by email instead. Nothing is lost in the meantime. (Section 2.)
- **8 templates drafted earlier are not needed.** (Section 3.)
- **One decision for you:** five existing messages say "your Registration Support Officer". For Australian GPs they are switched off and the email goes instead. You can switch any of them back on with one setting. (Section 4.)
- An Australian GP is **never** sent one of the overseas templates (MyIntealth, AMC, AHPRA, visa, "your move", the UK hello and the rest). That is fixed in the code and cannot be switched on.

### How to switch a template on

1. Create it in DoubleTick exactly as written in section 2 and wait for Meta to approve it.
2. Add its **key** to the setting `AU_WHATSAPP_APPROVED_TEMPLATES` (a comma-separated list in the app's environment settings in Vercel), then redeploy. Example: `AU_WHATSAPP_APPROVED_TEMPLATES=lead_hello_5m,placement_secured`.

That is the whole change: each key turns on that one message and nothing else. To switch one **off** (including one from section 1), add its key to `AU_WHATSAPP_DISABLED_TEMPLATES` the same way.

### Every Australian message and its WhatsApp today

| Message | Goes to | WhatsApp today | Template | Key | Meanwhile, by email |
| --- | --- | --- | --- | --- | --- |
| N01 hello (5 minutes) | lead | awaiting approval | `gp_link_au_lead_hello` | `lead_hello_5m` | The 5-minute note goes by email instead |
| N01 check-in (1 hour) | lead | awaiting approval | `gp_link_au_lead_check_in` | `lead_check_in_1h` | The 1-hour email |
| N01 last note (24 hours) | lead | awaiting approval | `gp_link_au_lead_last_note` | `lead_day_after_24h` | The 24-hour email |
| N02 call booked | lead | awaiting approval | `gp_link_au_lead_call_booked` | `lead_call_booked` | "Your call is booked" email |
| N02 reminder, the day before | lead | awaiting approval | `gp_link_au_lead_call_reminder` | `lead_call_reminder` | The day-before reminder email |
| N02 reminder, an hour before | lead | reused | `gp_link_consult_call_1h` | `lead_call_hour_before` | The one-hour reminder email also goes |
| N02 "starts in 5 minutes" | lead | reused | `gp_link_consult_call_starting_5m` | `lead_call_starting` | (WhatsApp only, as for an overseas lead) |
| N02 missed call | lead | reused | `gp_link_consult_missed_call` | `lead_call_missed` | The missed-call email also goes |
| N03 after the call: set up your account | lead | reused | `gp_link_consult_post_call_onboard_v3` | `lead_post_call_onboard` | The after-the-call email also goes |
| N04 welcome (a lead who signs up) | lead | awaiting approval | `gp_link_au_lead_signup_welcome` | `lead_signed_up` | The Australian welcome email (N04) |
| N04 welcome (direct sign-up) | doctor | awaiting approval | `gp_link_au_welcome` | `welcome` | The Australian welcome email (N04) |
| N05 finish your set-up (a lead who signed up) | lead | reused | `gp_link_consult_onboarding_nudge` | `lead_onboarding_incomplete` | The "finish your profile" reminder emails (N05) also go |
| N05 finish your profile | doctor | awaiting approval | `gp_link_au_onboarding_nudge` | `onboarding_nudge` | The "finish your profile" reminder emails (N05) |
| N09 match invitation | doctor | reused | `gp_link_app_match_invitation` | `match_invitation` | The match email also goes |
| N09 thanks for accepting your match | doctor | awaiting approval (or your choice, section 4) | `gp_link_au_match_accepted` | `match_accepted` | "Application received" email (and the same words as a plain WhatsApp when the doctor has written to us in the last day) |
| Interview times are ready | doctor | awaiting approval (or your choice, section 4) | `gp_link_au_interview_times_ready` | `interview_times_ready` | "Your interview times are ready" email |
| Interview confirmed (doctor) | doctor | awaiting approval (or your choice, section 4) | `gp_link_au_interview_confirmed_gp` | `interview_confirmed` | "Your interview is confirmed" email |
| Interview confirmed (practice) | practice | awaiting approval (or your choice, section 4) | `gp_link_au_interview_confirmed_practice` | `interview_confirmed_practice` | The interview confirmation email to the practice |
| Contract ready to sign | doctor | awaiting approval (or your choice, section 4) | `gp_link_au_contract_ready` | `contract_ready` | "Congratulations: the position is yours" email |
| N10 introduction to the practice | practice | reused | `gp_link_practice_candidate_intro` | `practice_intro` | The introduction email also goes |
| N10 introduction to the practice, with the CV | practice | reused | `gp_link_practice_candidate_intro_cv` | `practice_intro_cv` | The introduction email also goes |
| Account released | doctor | reused | `gp_link_account_released` | `account_released` | The "account released" email also goes |
| N11 placement secured | doctor | awaiting approval | `gp_link_au_placement_secured` | `placement_secured` | The "placement secured" email and in-app notice (N11) |
| Hello from the assigned team member | doctor | awaiting approval | `gp_link_au_team_welcome` | `rso_welcome` | None: nothing is sent, and the skip is written on the case timeline. The placement email (N11) introduces the team. |
| N16 cleared to start | doctor | awaiting approval | `gp_link_au_cleared_to_start` | `cleared_to_start` | The "cleared to start" email and in-app notice (N16) |
| N18 first-week check-in (doctor) | doctor | awaiting approval | `gp_link_au_first_week_checkin` | `commencement_checkin` | The first-week email and in-app notice (N18) |
| N18 first-week check-in (practice) | practice | awaiting approval | `gp_link_au_practice_first_week_checkin` | `commencement_checkin_practice` | The first-week email to the practice (N18) |
| Reminder for a call booked with a staff member | doctor | email only | none |  | The Australian call-reminder email (the day before, and as it starts) |

The other Australian messages (N06, N07, N08, N12 to N15, N17, N19 to N21) are email only by design and have no WhatsApp.

## 1. Already working: nothing to submit

These existing templates carry an Australian message as they are. Each was read word for word on 22 November 2026 (the wording is quoted in `whatsapp-live-templates.md`).

| Key | Existing template | Carries | What the app fills in |
| --- | --- | --- | --- |
| `practice_intro` | `gp_link_practice_candidate_intro` | N10: the introduction a practice gets when we put an Australian GP forward (no CV to attach). | contact name; practice name; the Australian introduction paragraph (for example "Dr Jane Citizen is a vocationally registered GP (FRACGP) based in Victoria..."); the button opens the same decision page as the email. |
| `practice_intro_cv` | `gp_link_practice_candidate_intro_cv` | N10: the same introduction with the CV attached. | the same three values, the CV as the attached document, and the same button. |
| `lead_call_hour_before` | `gp_link_consult_call_1h` | N02: the reminder about an hour before the call. | first name; the clock time with the city named, for example "10:30 am (Perth time)"; the link to join. |
| `lead_call_starting` | `gp_link_consult_call_starting_5m` | N02: "your call starts in 5 minutes". | first name; the link to join. |
| `lead_call_missed` | `gp_link_consult_missed_call` | N02: the note after a missed call. | first name; the link to pick a new time. |
| `lead_post_call_onboard` | `gp_link_consult_post_call_onboard_v3` | N03: "set up your account", ten minutes after a call the doctor attended. | first name; the sign-up link. |
| `lead_onboarding_incomplete` | `gp_link_consult_onboarding_nudge` | N05: "finish your set-up", a day after a lead signs up. | first name. |
| `match_invitation` | `gp_link_app_match_invitation` | N09: "you have been matched with a practice". | first name; the practice and place; the "held until" line; the link to the match. |
| `account_released` | `gp_link_account_released` | "Your account has been released" (staff release an account from review). | first name. The button opens the job board. |

One thing to confirm: the after-the-call note (`lead_post_call_onboard`) says setting up an account takes "about 5 minutes" and asks the doctor to "upload your CV". If that does not suit the Australian sign-up, add `lead_post_call_onboard` to `AU_WHATSAPP_DISABLED_TEMPLATES` and the email carries it alone.

## 2. To submit in DoubleTick

For every template: **language** English (`en`); **WhatsApp number** the existing GP Link one; **header** none; **footer** none. Type the body exactly, keeping `{{1}}`, `{{2}}` where they are. DoubleTick asks for a sample for each one: use the samples given. Meta decides the final category; if it offers to change it, accept.

Wording rules these keep, which matter if you edit one: no body starts or ends with a `{{n}}`; nothing about registration steps, changing country or where the doctor trained; no dollar figure or percentage. A template can only be edited 24 hours after its last edit, and an edit sends it back for review, so check the wording before you submit.

### Leads

#### `gp_link_au_lead_hello`

- **Turns on:** N01: the hello, about 5 minutes after an Australian GP fills in the form.
- **Category to choose:** MARKETING
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, Khaleed here from GP Link. Thanks for getting in touch.
> 
> I help GPs who are registered in Australia find a practice that fits them better: billing mix, location, flexibility. It is confidential. We never contact your current practice without asking you first.
> 
> What is the one thing you would change about where you work now? Or pick a time for a chat here: {{2}}
> 
> Khaleed, GP Link

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` booking link: "https://app.mygplink.com.au/start?lead=sample#book"
- **Buttons:** none
- **Once Meta approves it, add this key:** `lead_hello_5m`

#### `gp_link_au_lead_check_in`

- **Turns on:** N01: the check-in, an hour after the form.
- **Category to choose:** MARKETING
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, Khaleed again. No pressure at all.
> 
> If it helps, reply with the one thing you would most want from your next practice and I will answer it myself. Or grab a time here, 30 minutes, free and confidential: {{2}}
> 
> Khaleed, GP Link

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` booking link: "https://app.mygplink.com.au/start?lead=sample#book"
- **Buttons:** none
- **Once Meta approves it, add this key:** `lead_check_in_1h`

#### `gp_link_au_lead_last_note`

- **Turns on:** N01: the last note, a day after the form.
- **Category to choose:** MARKETING
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, last note from me. If a change of practice is a someday thing, that is completely fine and I will leave it here.
> 
> If you would like to talk it through at some point, you can book whenever suits you: {{2}}
> 
> Either way it stays between us. We never contact your current practice without asking you first.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` booking link: "https://app.mygplink.com.au/start?lead=sample#book"
- **Buttons:** none
- **Once Meta approves it, add this key:** `lead_day_after_24h`

#### `gp_link_au_lead_call_booked`

- **Turns on:** N02: "your call is booked".
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, your GP Link call is booked for {{2}}. The link to join will arrive by email, and we will send it here before the call as well.
> 
> It is a confidential conversation. We never contact your current practice without asking you first.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` the time on their own clock: "Thursday 14 January, 10:30 am (Perth time)"
- **Buttons:** none
- **Once Meta approves it, add this key:** `lead_call_booked`

#### `gp_link_au_lead_call_reminder`

- **Turns on:** N02: the reminder the day before the call.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, a reminder that your GP Link call is coming up on {{2}}.
> 
> Join here when it is time: {{3}}
> 
> If the time no longer suits, just reply and we will find another.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` the time on their own clock: "Thursday 14 January, 10:30 am (Perth time)"; `{{3}}` link to join: "https://zoom.us/j/0000000000"
- **Buttons:** none
- **Once Meta approves it, add this key:** `lead_call_reminder`

#### `gp_link_au_lead_signup_welcome`

- **Turns on:** N04: the welcome for a lead who creates an account.
- **Category to choose:** MARKETING
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Welcome to GP Link, {{1}}. Your account is set up. A few short questions in the app tell us what you want from your next practice, and nothing is shared with a practice until you say so.

- **Samples:** `{{1}}` first name: "Sam"
- **Buttons:** none
- **Note:** Meta classed the existing welcome as MARKETING; expect the same here.
- **Once Meta approves it, add this key:** `lead_signed_up`

### Matching, interviews and the contract

#### `gp_link_au_match_accepted`

- **Turns on:** "Thanks for accepting your match" (N09).
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, thanks for accepting your match with {{2}}. We are now arranging your interview and will send you times to choose from, usually within a couple of business days. Reply here if you have any questions.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"
- **Buttons:** none
- **Once Meta approves it, add this key:** `match_accepted`

#### `gp_link_au_interview_times_ready`

- **Turns on:** "Your interview times are ready".
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, great news: {{2}} would like to interview you, and their available times are ready for you to choose from.
> 
> Tap the button below to pick the time that suits you best. It only takes a moment.
> 
> If none of the times work for you, just reply to this message and we will arrange others.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"
- **Buttons:** Visit website, text "Choose your time", address `https://app.mygplink.com.au/pages/secure-interview?applicationId={{1}}` (sample for the `{{1}}` at the end: "00000000-0000-4000-8000-000000000000")
- **Once Meta approves it, add this key:** `interview_times_ready`

#### `gp_link_au_interview_confirmed_gp`

- **Turns on:** "Your interview is confirmed", to the doctor.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, your interview with {{2}} is confirmed for {{3}}.
> 
> Join the video call here when it is time:
> {{4}}
> 
> If you need to reschedule, just reply to this message and we will sort it out.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"; `{{3}}` the time on the doctor's own clock: "Thursday 14 January, 10:30 am (Perth time)"; `{{4}}` link to join: "https://zoom.us/j/0000000000"
- **Buttons:** none
- **Once Meta approves it, add this key:** `interview_confirmed`

#### `gp_link_au_interview_confirmed_practice`

- **Turns on:** "Your interview is confirmed", to the practice, when the candidate is an Australian GP.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}.
> 
> Join the video call here when it is time:
> {{4}}
> 
> If you need to reschedule, just reply to this message and we will arrange a new time.

- **Samples:** `{{1}}` contact name: "Alex"; `{{2}}` the doctor: "Dr Jane Citizen"; `{{3}}` the time on the practice's own clock: "Thursday 14 January, 1:30 pm (Sydney time)"; `{{4}}` link to join: "https://zoom.us/j/0000000000"
- **Buttons:** none
- **Once Meta approves it, add this key:** `interview_confirmed_practice`

#### `gp_link_au_contract_ready`

- **Turns on:** "Your contract is ready to sign".
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Congratulations {{1}}, {{2}} has offered you the position.
> 
> The next step is to review your employment agreement and sign it. Tap the button below to open it. If something needs adjusting before you can sign, you can request a change on the same page.
> 
> Any questions, reply here and our team will help.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"
- **Buttons:** Visit website, text "Complete agreement", address `https://app.mygplink.com.au/pages/offer-review?applicationId={{1}}` (sample for the `{{1}}` at the end: "00000000-0000-4000-8000-000000000000")
- **Once Meta approves it, add this key:** `contract_ready`

### Placement and the first week

#### `gp_link_au_placement_secured`

- **Turns on:** N11: "your placement is secured".
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, congratulations: your placement at {{2}} is secured.
> 
> Your pre-start checklist is in the GP Link app: your start date, a Medicare provider number for the new practice location, your indemnity certificate and your credentialing documents.
> 
> Tap below to open it. Our team will be in touch to help with each step.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"
- **Buttons:** Visit website, text "Open my checklist", address `https://app.mygplink.com.au/pages/prestart` (a fixed address: no variable)
- **Note:** The button is a fixed page: there is no button variable to fill in.
- **Once Meta approves it, add this key:** `placement_secured`

#### `gp_link_au_team_welcome`

- **Turns on:** The hello from the team member assigned to the doctor's case.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi Dr {{1}}, welcome to GP Link.
> 
> I'm {{2}}, and I will be your main point of contact from here to your first day at your new practice.
> 
> Whenever you have a question or need a hand, just send me a message here.
> 
> Warm regards,
> {{3}}
> GP Link

- **Samples:** `{{1}}` doctor's first name: "Sam"; `{{2}}` the team member's first name: "Jordan"; `{{3}}` the same name again, as the sign-off: "Jordan"
- **Buttons:** none
- **Once Meta approves it, add this key:** `rso_welcome`

#### `gp_link_au_cleared_to_start`

- **Turns on:** N16: "you are cleared to start".
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, good news: everything on your pre-start checklist is complete, and you are cleared to start at {{2}} on {{3}}.
> 
> If anything changes before then, reply here and we will help.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"; `{{3}}` the start date: "15 February 2027"
- **Buttons:** none
- **Note:** Optional: the email and the in-app notice already carry this one.
- **Once Meta approves it, add this key:** `cleared_to_start`

#### `gp_link_au_first_week_checkin`

- **Turns on:** N18: the first-week check-in, to the doctor.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, you have finished your first week at {{2}}. We hope it went well.
> 
> How are you settling in? If anything is not as you expected, reply here or message us in the GP Link app and we will help sort it out with the practice.

- **Samples:** `{{1}}` first name: "Sam"; `{{2}}` practice name: "Test Metro Practice"
- **Buttons:** none
- **Note:** It asks an open question, so Meta may class it as MARKETING. That is fine.
- **Once Meta approves it, add this key:** `commencement_checkin`

#### `gp_link_au_practice_first_week_checkin`

- **Turns on:** N18: the first-week check-in, to the practice.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, {{2}} has now completed the first week at your practice. We hope it has gone well.
> 
> How are they settling in? If anything needs attention, reply here or to our email and we will help.

- **Samples:** `{{1}}` contact name: "Alex"; `{{2}}` the doctor: "Dr Jane Citizen"
- **Buttons:** none
- **Note:** It asks an open question, so Meta may class it as MARKETING. That is fine.
- **Once Meta approves it, add this key:** `commencement_checkin_practice`

### Sign-up

#### `gp_link_au_welcome`

- **Turns on:** N04: the welcome for an Australian GP who signs up directly.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, welcome to GP Link. Your account is ready.
> 
> The next step is to finish your profile. It takes a few minutes: have your Ahpra registration number to hand.
> 
> We never contact your current practice without asking you first.

- **Samples:** `{{1}}` first name: "Sam"
- **Buttons:** Visit website, text "Finish my profile", address `https://app.mygplink.com.au/pages/onboarding` (a fixed address: no variable)
- **Note:** A doctor who came through the lead form and whose `lead_signed_up` template is also on would get two welcomes. Switch on one of the pair, or both only if that is acceptable.
- **Once Meta approves it, add this key:** `welcome`

#### `gp_link_au_onboarding_nudge`

- **Turns on:** N05: "finish your profile" reminders.
- **Category to choose:** UTILITY
- **Language:** English (`en`)
- **Header:** none
- **Body:**

> Hi {{1}}, your GP Link profile is saved where you left it and takes a few minutes to finish. Have your Ahpra registration number to hand.
> 
> If anything in the form is unclear, reply here and we will help.

- **Samples:** `{{1}}` first name: "Sam"
- **Buttons:** Visit website, text "Continue my profile", address `https://app.mygplink.com.au/pages/onboarding` (a fixed address: no variable)
- **Note:** A doctor who came through the lead form already gets the existing set-up nudge (section 1). With this one on as well they would get both. Leave it off unless you want direct sign-ups nudged on WhatsApp too.
- **Once Meta approves it, add this key:** `onboarding_nudge`

## 3. Not needed

Earlier in the build these were proposed as new templates. An existing approved template already does the job, so do not submit them.

| Drafted earlier | Covered by the existing template |
| --- | --- |
| `gp_link_au_practice_candidate_intro` | `gp_link_practice_candidate_intro` |
| `gp_link_au_practice_candidate_intro_cv` | `gp_link_practice_candidate_intro_cv` |
| `gp_link_au_lead_call_1h` | `gp_link_consult_call_1h` |
| `gp_link_au_lead_call_starting_5m` | `gp_link_consult_call_starting_5m` |
| `gp_link_au_lead_missed_call` | `gp_link_consult_missed_call` |
| `gp_link_au_lead_post_call` | `gp_link_consult_post_call_onboard_v3` |
| `gp_link_au_lead_onboarding_nudge` | `gp_link_consult_onboarding_nudge` |
| `gp_link_au_match_invitation` | `gp_link_app_match_invitation` |

## 4. Your decision

Five existing templates contain no wrong word, but each says "your Registration Support Officer", and the interview ones promise that person will be on the call. That is the overseas team's job title, and may not be how an Australian interview runs.

**Today, for Australian GPs:** these five WhatsApps are off. The doctor (and the practice) still get the email for each, with the same link, so nobody misses anything.

**Your two options, per message:**

- **Wait for the neutral version.** Submit the matching template in section 2. Once approved, add its key. (Recommended.)
- **Keep the existing one for now.** Add the key below to `AU_WHATSAPP_APPROVED_TEMPLATES`. Australian GPs then get the existing WhatsApp, wording as it is. When the neutral version is approved and its key added, the neutral one takes over by itself.

| Message | Existing template | It says | Key to keep it on | Neutral version (section 2) |
| --- | --- | --- | --- | --- |
| "Thanks for accepting your match" | `gp_link_app_match_accepted` | "Your Registration Support Officer is now arranging your interview" | `match_accepted_existing` | `gp_link_au_match_accepted` (key `match_accepted`) |
| "Your contract is ready to sign" | `gp_link_contract_ready` | "reply here and your Registration Support Officer will help" | `contract_ready_existing` | `gp_link_au_contract_ready` (key `contract_ready`) |
| "Your interview times are ready" | `gp_link_interview_times_ready` | "your Registration Support Officer will be on the call with you, so you are never in the room alone" | `interview_times_ready_existing` | `gp_link_au_interview_times_ready` (key `interview_times_ready`) |
| "Your interview is confirmed" (to the doctor) | `gp_link_interview_confirmed_gp` | "Your Registration Support Officer will be on the call with you" | `interview_confirmed_existing` | `gp_link_au_interview_confirmed_gp` (key `interview_confirmed`) |
| "Your interview is confirmed" (to the practice) | `gp_link_interview_confirmed_practice` | "A GP Link Registration Support Officer will also be on the call" | `interview_confirmed_practice_existing` | `gp_link_au_interview_confirmed_practice` (key `interview_confirmed_practice`) |

The overseas staff welcome ("I'm your dedicated Registration Support Officer... getting registered to work as a GP in Australia") is not on this list and cannot be switched on for an Australian GP. Its Australian version is `gp_link_au_team_welcome` in section 2.

