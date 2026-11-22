# Australian WhatsApp templates: proposed, not submitted

Started by WP-09. Later packages add their templates as new rows.

**Nothing in this file has been sent to DoubleTick or Meta.** Each row is a
proposal for the owner to create and submit. Until a template is approved and
switched on, the Australian message it would carry goes by email only or is
skipped. It is never sent through one of the existing templates.

Why new templates rather than the existing ones: a WhatsApp template has fixed
wording that Meta approved, held by DoubleTick. That wording is not in this
repository, so the build cannot check what an existing template says about a
candidate. The existing ones were written for doctors moving to Australia from
another country.

## How to switch one on

1. Create the template in DoubleTick with exactly the name, variables and
   button below, and wait for Meta to approve it.
2. Then either:
   - set the environment variable `AU_WHATSAPP_APPROVED_TEMPLATES` to a
     comma-separated list of the keys (or template names) that are approved, for
     example `AU_WHATSAPP_APPROVED_TEMPLATES=practice_intro,practice_intro_cv`; or
   - set `approved: true` on the row in `lib/au-whatsapp-templates.js`.

Nothing else in the code changes. `lib/au-whatsapp-templates.js` is the only
place that decides whether an Australian WhatsApp may be sent.

## Templates

`{{1}}`, `{{2}}`, ... are the values the app fills in. Category for all:
UTILITY. Language: `en`. WhatsApp business account: the existing one.

| Key | Template name | Purpose | Proposed body | Header | Button | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `practice_intro` | `gp_link_au_practice_candidate_intro` | N10 / P02. Sent to a practice's main contact when staff submit a doctor on an Australian pathway, alongside the introduction email. Used when there is no CV to attach, or when only this one is approved. | Hi {{1}}, GP Link has a GP for your role at {{2}}.<br><br>{{3}}<br><br>Tap below to see their details, then approve and pick interview times, or decline. Please keep this introduction confidential. | none | URL button "Interview or decline" → `https://app.mygplink.com.au/pages/practice-decision.html?token={{1}}` (the same link as the email) | not submitted — owner action |
| `practice_intro_cv` | `gp_link_au_practice_candidate_intro_cv` | The same, with the doctor's CV attached. Used whenever a CV is on file and this one is approved. | Same body as `practice_intro`. | DOCUMENT (the CV, as a PDF). Sample for approval: any one-page sample CV. | Same button as `practice_intro`. | not submitted — owner action |

| `placement_secured` | `gp_link_au_placement_secured` | N11 (WP-11). Sent to a doctor on an Australian pathway when their placement is recorded, alongside the email and the bell item. | Hi {{1}}, congratulations: your placement at {{2}} is secured.<br><br>Your pre-start checklist is in the GP Link app: your start date, a Medicare provider number for the new practice location, your indemnity certificate and your credentialing documents.<br><br>Tap below to open it. Our team will be in touch to help with each step. | none | URL button "Open my checklist" → `https://app.mygplink.com.au/{{1}}` (the app fills `pages/my-documents`) | not submitted — owner action |

What the app puts in the variables of `placement_secured`: `{{1}}` the
doctor's first name, `{{2}}` the practice's name (or "your new practice"). The
fixed words say nothing about registration steps, a move, or where the doctor
trained, and must stay that way: the same template goes to every Australian
segment. Until it is approved the WhatsApp is skipped (the reason is written
on the case's timeline) and the doctor still gets the email and the bell item.

### WP-13: the first-week check-in (N18)

Sent by the daily lifecycle job one week after staff confirm the doctor
started, alongside the emails. Neither has a button. N19 (weeks 4, 8, 12) and
N20 (twelve weeks in) are email only and have no template.

| Key | Template name | Purpose | Proposed body | Header | Button | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `commencement_checkin` | `gp_link_au_first_week_checkin` | N18 to the doctor. | Hi {{1}}, you have finished your first week at {{2}}. We hope it went well.<br><br>How are you settling in? If anything is not as you expected, reply here or message us in the GP Link app and we will help sort it out with the practice. | none | none | not submitted — owner action |
| `commencement_checkin_practice` | `gp_link_au_practice_first_week_checkin` | N18 to the practice's main contact. | Hi {{1}}, {{2}} has now completed the first week at your practice. We hope it has gone well.<br><br>How are they settling in? If anything needs attention, reply here or to our email and we will help. | none | none | not submitted — owner action |

What the app puts in the variables: for `commencement_checkin`, `{{1}}` the
doctor's first name and `{{2}}` the practice's name (or "your new practice");
for `commencement_checkin_practice`, `{{1}}` the contact's name (or "there")
and `{{2}}` the doctor ("Dr Jane Citizen"). The fixed words carry nothing
commercial (no fee, invoice, credit or guarantee wording) and nothing about
where the doctor trained, and must stay that way. Until each is approved its
WhatsApp is skipped with the reason logged (and, for the doctor's, written on
the case's timeline); the emails and the doctor's bell item still go. The
practice WhatsApp is only attempted in the same run as the practice email, so
it cannot go twice.

What the app puts in the variables for both practice templates:

- `{{1}}` the contact's name, or "<practice name> team".
- `{{2}}` the practice's name.
- `{{3}}` the Australian introduction, one paragraph, at most 550 characters.
  Example: "Dr Test Auvr is a vocationally registered GP (FRACGP) based in
  Victoria. GP Link has verified Dr Auvr's Ahpra registration on the public
  register, so there is no registration wait. Dr Auvr is available from
  15 January 2027."
- Button `{{1}}` the decision-link token.

The body's fixed words must stay neutral about where the doctor trained and
must not mention registration timelines or a move to Australia: the same
template carries VR GPs, registrars and doctors with a Medicare billing
restriction, and `{{3}}` says which.

### WP-16: the lead and consult funnel (N01, N02, N03)

For an **Australian-segment lead** (someone who told the booking form they are
registered with Ahpra, or trained in Australia), with the switch on. One row
for every WhatsApp the funnel sends an overseas lead today. Each takes **the
same variables in the same order** as the existing template for the same
touch, so the app fills it with no other change. The wording is held in
`lib/au-lead-copy.js` (`PROPOSED_WHATSAPP_TEMPLATES`) and repeated in the copy
deck, `docs/au-gp/au-lead-copy.md`; `tests/au-wp16-copy-snapshot.test.js`
fails if this table and the code disagree.

Until a row is approved its WhatsApp is **skipped**: the reason
(`au_template_not_approved`) is logged and shown on the Leads tab drawer
("WhatsApp skipped: no approved Australian template"), and the email carries
the message. The 5-minute note, which is WhatsApp-only for an overseas lead,
goes by email instead. An Australian-segment lead is never sent one of the
existing `gp_link_consult_*` templates.

| Key | Template name | Purpose | Category | Proposed body | Variables | Buttons | Existing template it mirrors | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lead_hello_5m` | `gp_link_au_lead_hello` | N01, about 5 minutes after an Australian-segment lead qualifies. | MARKETING | Hi {{1}}, Khaleed here from GP Link. Thanks for getting in touch.<br><br>I help GPs who are registered in Australia find a practice that fits them better: billing mix, location, flexibility. It is confidential. We never contact your current practice without asking you first.<br><br>What is the one thing you would change about where you work now? Or pick a time for a chat here: {{2}} | `{{1}}` first name; `{{2}}` booking link | none | `gp_link_consult_hello_5m` | not submitted: owner action |
| `lead_check_in_1h` | `gp_link_au_lead_check_in` | N01, 1 hour after the lead qualifies. | MARKETING | Hi {{1}}, Khaleed again. No pressure at all.<br><br>If it helps, reply with the one thing you would most want from your next practice and I will answer it myself. Or grab a time here, 30 minutes, free and confidential: {{2}} | `{{1}}` first name; `{{2}}` booking link | none | `gp_link_consult_check_in_1h` | not submitted: owner action |
| `lead_day_after_24h` | `gp_link_au_lead_last_note` | N01, 24 hours after the lead qualifies. The last note. | MARKETING | Hi {{1}}, last note from me. If a change of practice is a someday thing, that is completely fine and I will leave it here.<br><br>If you would like to talk it through at some point, you can book whenever suits you: {{2}}<br><br>Either way it stays between us. We never contact your current practice without asking you first. | `{{1}}` first name; `{{2}}` booking link | none | `gp_link_consult_day_after_24h` | not submitted: owner action |
| `lead_call_booked` | `gp_link_au_lead_call_booked` | N02, booking confirmation. | UTILITY | Hi {{1}}, your GP Link call is booked for {{2}}. The link to join will arrive by email, and we will send it here before the call as well.<br><br>It is a confidential conversation. We never contact your current practice without asking you first. | `{{1}}` first name; `{{2}}` the time on their own clock, for example "Thursday 14 January, 10:30 am (Perth time)" | none | `gp_link_consult_call_booked` | not submitted: owner action |
| `lead_call_reminder` | `gp_link_au_lead_call_reminder` | N02, the day before the call. | UTILITY | Hi {{1}}, a reminder that your GP Link call is coming up on {{2}}.<br><br>Join here when it is time: {{3}}<br><br>If the time no longer suits, just reply and we will find another. | `{{1}}` first name; `{{2}}` the time on their own clock; `{{3}}` join link | none | `gp_link_consult_call_reminder` | not submitted: owner action |
| `lead_call_hour_before` | `gp_link_au_lead_call_1h` | N02, about an hour before the call. | UTILITY | Hi {{1}}, your GP Link call is in about an hour, at {{2}}.<br><br>Join here: {{3}}<br><br>If clinic is running over, just let us know. | `{{1}}` first name; `{{2}}` the time on their own clock; `{{3}}` join link | Quick replies: "I'll be there", "Need another time" (the same two the existing one-hour template has: the app reads them) | `gp_link_consult_call_1h` | not submitted: owner action |
| `lead_call_starting` | `gp_link_au_lead_call_starting_5m` | N02, 5 minutes before the call. | UTILITY | Hi {{1}}, your GP Link call starts in 5 minutes. Tap to join: {{2}}<br><br>Running a few minutes late is fine. | `{{1}}` first name; `{{2}}` join link | none | `gp_link_consult_call_starting_5m` | not submitted: owner action |
| `lead_call_missed` | `gp_link_au_lead_missed_call` | N02, an hour after a call the doctor did not join. | UTILITY | Hi {{1}}, it looks like we missed each other today. No problem at all, I know how quickly a clinic day can change.<br><br>If you would still like to talk, pick a new time here: {{2}} | `{{1}}` first name; `{{2}}` link to pick a new time | none | `gp_link_consult_missed_call` | not submitted: owner action |
| `lead_post_call_onboard` | `gp_link_au_lead_post_call` | N03, 10 minutes after a call the doctor attended, if they have no account. | MARKETING | Thanks for the conversation today, {{1}}. The next step is your free GP Link account. It takes about two minutes and it is where you tell us what you want from your next practice: {{2}}<br><br>Nothing in it is shared with a practice until you say so. | `{{1}}` first name; `{{2}}` sign-up link | none | `gp_link_consult_post_call_onboard_v3` | not submitted: owner action |
| `lead_signed_up` | `gp_link_au_lead_signup_welcome` | When a lead creates their account. (WP-17 owns onboarding wording; proposed here so the skip has a name.) | UTILITY | Welcome to GP Link, {{1}}. Your account is set up. A few short questions in the app tell us what you want from your next practice, and nothing is shared with a practice until you say so. | `{{1}}` first name | none | `gp_link_consult_signup_welcome` | not submitted: owner action |
| `lead_onboarding_incomplete` | `gp_link_au_lead_onboarding_nudge` | A day after sign-up, if the short set-up questions are not finished. (WP-17 owns onboarding wording.) | UTILITY | Hi {{1}}, your GP Link account is nearly ready. A couple of minutes in the app to finish your details and we can start looking at what fits. Reply here if anything is unclear. | `{{1}}` first name | none | `gp_link_consult_onboarding_nudge` | not submitted: owner action |

Rules the fixed words keep, and must keep: nothing about registration steps,
changing country or where the doctor trained; no dollar figure or percentage;
no promise of a role; the confidentiality line in its agreed wording where the
message is about a conversation ("We never contact your current practice without asking you first.").
The same template goes to every Australian segment, so the fixed words cannot
assume the doctor is vocationally registered.

**For WP-18 (the template review).** The app sends these existing templates to
overseas leads and **skips them for an Australian-segment lead**, because their
approved wording lives in DoubleTick and nobody on the build has read it:
`gp_link_consult_hello_5m`, `gp_link_consult_check_in_1h`, `gp_link_consult_day_after_24h`, `gp_link_consult_call_booked`, `gp_link_consult_call_reminder`, `gp_link_consult_call_1h`, `gp_link_consult_call_starting_5m`, `gp_link_consult_missed_call`, `gp_link_consult_post_call_onboard_v3`, `gp_link_consult_signup_welcome`, `gp_link_consult_onboarding_nudge`.
If WP-18 reads a template's live body and finds it neutral (the call reminders
`gp_link_consult_call_reminder`, `gp_link_consult_call_1h` and
`gp_link_consult_call_starting_5m` are the likely ones: a time and a join link),
the cheapest way to use it for Australian leads is to point the Australian
row at it: change that row's `templateName` in `lib/au-whatsapp-templates.js`
to the existing name and mark it approved. No other code changes, and no
new template needs Meta's approval. That is an owner decision, not assumed.

## A possible shortcut (owner decision)

If the wording of the two existing templates (`gp_link_practice_candidate_intro`
and `gp_link_practice_candidate_intro_cv`) turns out to say nothing about where
the doctor trained or about registration, they could carry the Australian
introduction as they are, because only `{{3}}` describes the candidate. Nobody
on the build has seen that wording, so this has not been assumed. To use it,
paste the two approved bodies to the lead; if they are neutral, the two
`templateName` values in `lib/au-whatsapp-templates.js` are pointed at the
existing names and marked approved.
