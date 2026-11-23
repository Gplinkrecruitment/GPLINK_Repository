# WhatsApp templates: what is really in DoubleTick (WP-18, research half)

**Read taken:** 22 November 2026, 06:49 UTC (5:49 pm Sydney time).
**How:** one read-only request to DoubleTick's public API
(`GET /v2/templates?allWabaPhoneNumbers=true&status=ALL`), the same listing the
app already reads for its own status checks. Nothing was created, edited,
submitted, deleted or sent, and no chats, contacts or messages were read.
Code line numbers refer to `au-gp-testing` at commit `fed518ae`.

## Status now (corrected 23 November 2026, FR-1 R-06)

This document began as the research read of 22 November. Its "AU today"
columns described the code **before** the WP-18 code half switched the reusable
templates on. The columns below have been corrected so that this file, the code
(`lib/au-whatsapp-templates.js`) and `scheduled-jobs.md` say the same thing.

**With the switch on, these nine existing templates are sent to an Australian
recipient by default** (no owner action; switch one off by listing its key in
`AU_WHATSAPP_DISABLED_TEMPLATES`):

| Key | Template | Who receives it |
| --- | --- | --- |
| `practice_intro` | `gp_link_practice_candidate_intro` | the practice, about an Australian candidate |
| `practice_intro_cv` | `gp_link_practice_candidate_intro_cv` | the same, with the CV |
| `lead_call_hour_before` | `gp_link_consult_call_1h` | any Australian-segment lead with a booked call |
| `lead_call_starting` | `gp_link_consult_call_starting_5m` | the same |
| `lead_call_missed` | `gp_link_consult_missed_call` | any Australian-segment lead who missed a call |
| `lead_post_call_onboard` | `gp_link_consult_post_call_onboard_v3` | **segment A (`au_vr`) leads only** |
| `lead_onboarding_incomplete` | `gp_link_consult_onboarding_nudge` | **segment A (`au_vr`) leads only** |
| `match_invitation` | `gp_link_app_match_invitation` | an Australian doctor who is matched |
| `account_released` | `gp_link_account_released` | an Australian doctor released from review |

The two marked "segment A only" have fixed wording that promises matching ("I
can start matching you to practices", "we can start matching you with
Australian practices"). For a lead in a segment that is not launched
(`au_restricted`, `au_non_vr`, `au_registrar`) or whose segment is not known,
their WhatsApp is **skipped by name** (reason `au_template_promises_roles`, shown
on the Leads tab) and the careful email carries the message. Every other
Australian WhatsApp (the `gp_link_au_*` rows and the five `_existing` rows) is
skipped by name until the owner has it approved or switches it on.

## Summary for the owner

- **80 templates exist** in the account, all on the one GP Link WhatsApp
  number, all in English. 79 are approved by Meta and 1 is rejected
  (`gp_link_onboarding_step_register`, the "add my GMC number" nudge, so that
  nudge is not reaching overseas doctors on WhatsApp either).
- **The app can send 42 of them.** The other 38 are leftovers: the previous
  developer's bot, old campaigns, retired versions and one-off notes. Nothing
  in the code sends those.
- **Of the 42, 11 have wording that is safe for an Australian GP as it
  stands**, 8 are safe apart from one small thing (mostly the phrase
  "Registration Support Officer"), 22 must never go to an Australian GP, and 1
  is the rejected one.
- **The ones that matter most:**
  1. **The two practice introduction templates are neutral.** Only the middle
     paragraph describes the doctor, and the app already fills that with the
     Australian wording. They can carry an Australian candidate today with a
     two-line setting change. Nothing new to submit.
  2. **Three of the call messages are neutral** (one hour before, five minutes
     before, missed call), and so are the after-the-call "set up your account"
     note and the "finish your set-up" nudge. Same: a setting change, nothing
     to submit.
  3. **The booking confirmation and the day-before reminder are not neutral.**
     Both say "Bring every question you have about registration, visas,
     earnings and life in Australia". The review guessed these were reusable;
     they are not. New Australian ones are needed.
  4. **Three messages an Australian doctor is being sent today** (interview
     times ready, interview confirmed, contract ready), plus the "thanks for
     accepting your match" note, contain no banned word, but each says "your
     Registration Support Officer". That is a should-fix, not a blocker.
     Decision needed: accept that wording for now, or go email-only for
     Australian doctors until new versions are approved.
  5. **One overseas message can still reach an Australian doctor and should
     not:** the "I'm your dedicated Registration Support Officer ... getting
     registered to work as a GP in Australia" welcome, sent when a staff member
     is assigned to the case. No check for the doctor's pathway was found
     there (found by reading the code, not by running it).
- **What you would need to submit** (wording in section 5 and in
  `whatsapp-templates.md`): six lead-funnel templates (hello, one-hour
  check-in, last note, call booked, day-before reminder, sign-up welcome),
  placement secured, the two first-week check-ins, and, if you do not want
  "Registration Support Officer" in front of Australian doctors, new versions
  of interview times ready, interview confirmed, contract ready, match
  accepted and the staff welcome. Five of the eleven lead templates drafted
  earlier and both practice templates do **not** need submitting.
- Three of the drafted templates end with a link, which Meta rejects. Corrected
  wording is in section 5.

## 1. What the code can send (inventory)

"AU today" means: with the Australian switch on, can a doctor on an Australian
pathway, an Australian-segment lead, or a practice receiving an Australian
candidate be sent this template right now. All of this was checked by reading
the code; nothing was run.

### Leads (consult funnel)

Sender: `maybeSendConsultWa` (`server.js:31998`) and
`sendConsultWhatsAppTemplate` (`server.js:31720`); names in
`lib/consult-whatsapp.js:44-95`. For an Australian-segment lead every one of
these is swapped for the Australian row `lead_<kind>` in
`lib/au-whatsapp-templates.js`, and skipped with `au_template_not_approved`
while that row is not approved (`server.js:32014-32019`, `:32960-32967`,
`:38708-38712`, `:61792-61794`, `:61844-61852`, `:32458`).

| Template | Kind | Trigger | Variables | AU today |
| --- | --- | --- | --- | --- |
| `gp_link_consult_hello_5m` | `hello_5m` | 5 minutes after a lead qualifies | 1 first name, 2 booking link | skipped by name |
| `gp_link_consult_check_in_1h` | `check_in_1h` | 1 hour after | 1 first name, 2 booking link | skipped by name |
| `gp_link_consult_day_after_24h` | `day_after_24h` | 24 hours after | 1 first name, 2 booking link | skipped by name |
| `gp_link_consult_call_booked` | `call_booked` | Calendly booking (`server.js:38092`) | 1 first name, 2 time on the lead's own clock | skipped by name |
| `gp_link_consult_call_reminder` | `call_reminder` | day before the call (`/api/cron/call-reminders`, `server.js:32985`) | 1 first name, 2 time, 3 join link | skipped by name |
| `gp_link_consult_call_1h` | `call_hour_before` | about an hour before | 1 first name, 2 clock time (with city label for an Australian lead), 3 join link; two quick replies the app reads | **sent** to an Australian-segment lead (reused: the row is approved by default since the WP-18 code half) |
| `gp_link_consult_call_starting_5m` | `call_starting` | 5 minutes before | 1 first name, 2 join link | **sent** to an Australian-segment lead (reused: the row is approved by default since the WP-18 code half) |
| `gp_link_consult_missed_call` | `call_missed` | an hour after a missed call (`server.js:38715`) | 1 first name, 2 re-book link | **sent** to an Australian-segment lead (reused: the row is approved by default since the WP-18 code half) |
| `gp_link_consult_post_call_onboard_v3` | `post_call_onboard` | 10 minutes after an attended call, no account (`server.js:61883`) | 1 first name, 2 sign-up link | **sent to a segment A (`au_vr`) lead only**; skipped by name (`au_template_promises_roles`) for `au_restricted`, `au_non_vr`, `au_registrar` and an unknown segment, because the fixed text promises matching (FR-1, R-06) |
| `gp_link_consult_signup_welcome` | `signed_up` | lead creates an account (`server.js:38225`, `:61718`, `:61745`) | 1 first name | skipped by name |
| `gp_link_consult_onboarding_nudge` | `onboarding_incomplete` | a day after sign-up, set-up unfinished (`server.js:61817`) | 1 first name | **sent to a segment A (`au_vr`) lead only**; skipped by name (`au_template_promises_roles`) for `au_restricted`, `au_non_vr`, `au_registrar` and an unknown segment, because the fixed text promises matching (FR-1, R-06) |
| `gp_link_owner_lead_alert` | `owner_lead_alert` | lead has not booked 20 minutes after the 1-hour note; goes to the **owner's** phone (`server.js:32129`) | 1 lead name, 2 lead phone, 3 what they answered, 4 status | sent (to the owner, about any lead) |
| `gp_link_khaleed_personal_checkin` | personal note | a note the owner wrote and scheduled for one lead (`server.js:38761`, `lib/consult-personal-note.js:29`) | 1 name, 2 and 3 the owner's own sentences | sent if the owner schedules one |
| `gp_link_reengage_hayley` | Zoho re-engagement | staff-run sweep of the imported old lead list, UK mobile numbers only (`server.js:41851`, `:43641`, `:59867`) | 1 first name | unreachable (UK mobiles only) |

### Doctors

| Template | Sent from | Trigger | Variables | AU today |
| --- | --- | --- | --- | --- |
| `gp_link_app_myintealth_introductiory_message_` | `sendDoubleTickTemplate(…, 'myintealth')` `server.js:33273` | doctor first opens MyIntealth | 1 first name | unreachable (`auNoOverseasStageMsgs`, `server.js:33212`, `:33266`) |
| `gp_link_app_amc_introductiory_message_` | `server.js:33289` | MyIntealth finished | 1 first name | unreachable (same guard, `:33287`) |
| `gp_link_app_ahpra_introductiory_message` | `server.js:33487`, fallback at `:34354` | AHPRA stage unlocked | 1 first name | unreachable (`:33485`; `_maybeNotifyAhpraDocsReady` returns early, `:34252-34262`) |
| `gp_link_ahpra_docs_complete` | `server.js:34350` | all three document groups complete | 1 first name, 2 link | unreachable (same early return) |
| `gp_link_visa_passports` | `server.js:33553`, `:85340` | registration granted; staff "send request" | 1 first name, 2 link | unreachable (`:33539` break; `auRefuseOverseasPracticeAction` `:85297`) |
| `gp_link_visa_passports_reminder` | `server.js:35010` | staff passport reminder | 1 first name, 2 who is outstanding, 3 link | unreachable (same route guard) |
| `gp_link_app_rso_welcome` | `ensureRsoWelcomeSent` `server.js:31398` (called at `:76070`, `:83945`, `:94425`, `:95205`) | first time a staff member is assigned to the case | 1 doctor first name, 2 and 3 staff first name | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_app_match_invitation` | `sendMatchWhatsAppToGp` `server.js:53119` via `announceShortlistToGp` `:53197`; builder `lib/match-whatsapp.js:108` | staff match a doctor to a role | 1 first name, 2 practice and place, 3 the "held until" line, 4 link | **sent** (no pathway branch) |
| `gp_link_app_match_accepted` | `sendMatchAcceptedWhatsAppToGp` `server.js:53376` (called at `:70055`, `:71169`); plain-text fallback with the same words `:53290` | doctor accepts a match | 1 first name, 2 practice | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_interview_times_ready` | `sendInterviewWhatsappTemplate` `server.js:31579`, called at `:56016` and `:104432` | practice approves and offers times | 1 first name, 2 practice; button = application id | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_interview_confirmed_gp` | `server.js:104248`; re-send `:103869` | doctor books a time; staff re-send | 1 first name, 2 practice, 3 time in the doctor's zone, 4 join link | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_contract_ready` | `sendContractReadyWhatsAppToGp` `server.js:53305` | contract submitted to the doctor; staff re-send | 1 first name, 2 practice; button = application id | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_account_released` | `sendAccountReleasedWhatsApp` `server.js:51145` (via `:78197`, `:90748`, `:99683`) | staff release an account from review | 1 first name; fixed button to the job board | **sent** (no pathway branch) |
| `gp_link_reg_call_reminder`, `gp_link_reg_call_starting` | call-reminder cron, `registration` track `server.js:32807` | a booked call hosted by a staff member (not the CEO), day before and 15 minutes before | 1 first name, 2 time, 3 join link / 1 first name, 2 join link | **skipped by default** for a doctor on an Australian pathway (and when the pathway cannot be read); the email still goes. Checked against the code in fix bundle FR-2. |
| `gp_link_onboarding_step_start`, `_move`, `_register`, `_id` | `maybeSendDropoffWa` `server.js:32647` from the onboarding crons `:60795`, `:60865` | a day or more away from an unfinished sign-up step | 1 first name; button = step number | unreachable for an Australian doctor, and for **any account not positively known to be overseas** (`auBlocksOverseasTemplates` needs overseas evidence; an account nothing is known about gets at most one neutral email and no WhatsApp) |
| `gp_link_start_practice_search`, `gp_link_upload_cv_nudge` | `maybeSendDropoffWa` from `/api/cron/dropoff-nudge` `server.js:60965` | set-up finished but no application / no CV | 1 first name | unreachable (`dnAu.excludesUser` `:60911`) |
| `gp_link_resume_onboarding_start`, `_move`, `_id`, `gp_link_offer_signature_nudge` | named in `lib/dropoff-nudges.js:30-37` only | none: kept so old log rows still name them | 1 first name | unreachable (no live send path) |
| `gp_link_au_placement_secured` | `auSendPlacementSecuredToGp` `server.js:8262` | placement recorded (N11) | 1 first name, 2 practice; button `pages/my-documents` | skipped by name (template does not exist yet) |
| `gp_link_au_first_week_checkin` | `lib/au-commencement.js:1017` | a week after the start (N18) | 1 first name, 2 practice | skipped by name |

Two stage names the code passes have no template at all and never send:
`'career'` (`server.js:33309`) and `'support_ticket_received'` (`:33580`).
The hourly interview reminders are plain text, not templates, and are outside
this review.

### Practices

| Template | Sent from | Trigger | Variables | AU today |
| --- | --- | --- | --- | --- |
| `gp_link_practice_candidate_intro` | `lib/practice-submission-whatsapp.js:59`; sent at `server.js:75685` | staff submit a doctor to a practice, no CV to attach | 1 contact name, 2 practice, 3 introduction paragraph (at most 550 characters); button = decision token | **sent** for an Australian candidate (reused: approved by default since the WP-18 code half; `{{3}}` is the Australian paragraph) |
| `gp_link_practice_candidate_intro_cv` | same | the same, with the CV as a document header | same | **sent** for an Australian candidate (reused: approved by default since the WP-18 code half; `{{3}}` is the Australian paragraph) |
| `gp_link_interview_confirmed_practice` | `server.js:104249`; re-send `:103904` | doctor books an interview time | 1 contact name, 2 doctor name, 3 time in the practice's zone, 4 join link | **sent** |
| `gp_link_au_practice_first_week_checkin` | `lib/au-commencement.js:997` | a week after the start (N18) | 1 contact, 2 doctor | skipped by name |

## 2. What is in the account

- 80 templates. Language `en` for all. 37 UTILITY, 43 MARKETING.
- 79 APPROVED, 1 REJECTED, none pending or paused. The API gives no reason
  for the rejection and no last-updated time. Quality score reads "Pending"
  for every one. **No template has a footer.**
- 53 were created through the API (the app's era), 26 in the dashboard by the
  owner's login, 1 by the previous developer's bot login.
- Every name the code can send exists in the account. The only one that is
  not approved is `gp_link_onboarding_step_register` (REJECTED).
- None of the 25 `gp_link_au_*` names exists yet (expected: not submitted).
- **No approved body starts or ends with a variable.** Every one has fixed
  words after its last `{{n}}`.

The full list, with every body word for word, is in the appendix.

## 3. Verdict for each template the code can send

Judged against AGENT-RULES section 4 for a segment A doctor (vocationally
registered, already in Australia) or a practice being sent one.

### Reusable as it stands (11)

| Template | Fixed text | Variables: Australian-safe? |
| --- | --- | --- |
| `gp_link_practice_candidate_intro` | "Hello {{1}}, this is GP Link. We have just submitted a GP candidate for your vacancy at {{2}}. / {{3}} / Their full introduction, CV and our recommendation are in your email inbox. Tap the button below to review the candidate and accept or decline." Button "Accept or decline". | Yes. `{{3}}` is already the Australian paragraph for an Australian doctor (`buildAuCandidateIntro`). |
| `gp_link_practice_candidate_intro_cv` | The same with "Their CV is attached here, and their full introduction with our recommendation is in your email inbox. Tap the button below to review the candidate and choose to interview or decline." Button "Interview or decline". CV as a document header. | Yes, as above. |
| `gp_link_consult_call_1h` | "Hi {{1}}, a quick reminder that your call with me is in about an hour, at {{2}}. / Here is your link to join: / {{3}} / If clinic is running over or something has come up, that is completely fine. Just tap below or reply here and we will find another time. / Speak soon, / Khaleed, CEO, GP Link". Quick replies "I'll be there", "Need another time". | Yes. The time is already on the lead's own clock with the city named. |
| `gp_link_consult_call_starting_5m` | "Hi {{1}}, your consultation with GP Link starts in 5 minutes. Tap here to join: / {{2}} / I am on the call ready for you. If you are running a few minutes late that is completely fine, just join when you can. If something has come up and you would rather rebook, reply to this message and we will sort it out. / See you shortly! / Khaleed, CEO, GP Link" | Yes. |
| `gp_link_consult_missed_call` | "Hi {{1}}, sorry we missed each other for our call. No problem at all, I know how quickly a clinic day can change. / You can pick a new time here: {{2}} / Or just reply with a time that suits you and I will make it work. / Khaleed, CEO, GP Link" | Yes. |
| `gp_link_consult_post_call_onboard_v3` | "Thanks for jumping on today {{1}}, keen to get the ball rolling for you. / Next step is a quick one: set up your GP Link account (about 5 minutes) and upload your CV. Once that's in I can start matching you to practices that fit what we talked about, and you'll be able to browse the roles we have open right now to get a feel for what's out there. / Here's your link: {{2}} / Shout if anything's unclear. I read these myself." | Yes. Owner to confirm "about 5 minutes" and "upload your CV" suit the Australian sign-up. |
| `gp_link_consult_onboarding_nudge` | "Hi {{1}}! Khaleed here, CEO of GP Link. / You are so close! Just a few quick steps left to unlock your dashboard. It takes about 5 minutes, and the moment it is done we can start matching you with Australian practices that genuinely fit what you are looking for. / Sign back in at https://app.mygplink.com.au and pick up where you left off. / Stuck on anything? Reply here and I will personally make sure you are looked after. / Khaleed" | Yes. |
| `gp_link_app_match_invitation` | "Hi {{1}} / Great news — you have been personally matched with {{2}}. / {{3}} / Have a look and let us know if you would like to go forward to an interview: / {{4}} / Not the right fit? Just reply here and tell us why — it helps us find you a better one." | Yes. `{{3}}` is only ever the "held until <date>" line (`lib/match-whatsapp.js:68-88`). |
| `gp_link_account_released` | "Hi Dr {{1}}, good news — your GP Link account has been reviewed and released. You now have full access, including the job board. / Tap below to browse the practices looking for GPs right now, and we will start matching you as soon as you have had a look." Button "Browse jobs". | Yes. |
| `gp_link_khaleed_personal_checkin` | "Hi {{1}}, Khaleed here from GP Link. Hope all is well! / {{2}} / {{3}} / Warm regards, / Khaleed" | The fixed text is neutral; `{{2}}` and `{{3}}` are whatever the owner types. |
| `gp_link_owner_lead_alert` | "Lead needs a personal follow-up. Name: {{1}}. Phone: {{2}}. They said: {{3}}. Status: {{4}}. Reply from DoubleTick or call them now." | Goes to the owner, never to a doctor. |

### Reusable with care (8)

| Template | Fixed text | The issue |
| --- | --- | --- |
| `gp_link_interview_times_ready` | "Hi {{1}}, great news — {{2}} would like to interview you, and their available times are ready for you to choose from. / Tap the button below to pick the time that suits you best. It only takes a moment, and your Registration Support Officer will be on the call with you, so you are never in the room alone. / If none of the times work for you, just reply to this message and we will arrange others." Button "Choose your time". | No banned word. Says "your Registration Support Officer" (should-level), and promises that person will be on the call, which may not be how an Australian interview is run. |
| `gp_link_interview_confirmed_gp` | "Hi {{1}}, your interview with {{2}} is confirmed for {{3}}. / Join the video call here when it is time: / {{4}} / Your Registration Support Officer will be on the call with you. If you need to reschedule, just reply to this message and we will sort it out." | Same phrase, same promise. |
| `gp_link_interview_confirmed_practice` | "Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}. / Join the video call here when it is time: / {{4}} / A GP Link Registration Support Officer will also be on the call. If you need to reschedule, just reply to this message and we will arrange a new time." | Same phrase, to the practice. Says nothing about where the doctor trained. |
| `gp_link_contract_ready` | "Congratulations {{1}} {{2}} has offered you the position. / All that is left is to secure it: review your employment agreement and sign it. Tap the button below to complete your agreement. If something needs adjusting before you can sign, you can request a change on the same page. / Any questions, reply here and your Registration Support Officer will help." Button "Complete agreement". | Same phrase. |
| `gp_link_app_match_accepted` | "Hi {{1}}, thanks for accepting your match with {{2}}. Your Registration Support Officer is now arranging your interview — we'll send you interview times to choose from, usually within a couple of business days. Reply here if you have any questions." | Same phrase. The plain-text fallback in the code (`server.js:53290`) repeats it. |
| `gp_link_upload_cv_nudge` | "Hi Dr {{1}}, Khaleed from GP Link here. Practices are ready to look at you, and the only thing missing is your CV. Upload it here and you can apply for any position straight away: https://app.mygplink.com.au/pages/career / It only needs to be your current CV, and our system checks it in seconds. Reply here if you'd like a hand with it. / Khaleed, CEO of GP Link" | No banned word. "any position" overstates it for a doctor whose roles are filtered or capped. Not sent to Australian doctors today. |
| `gp_link_onboarding_step_id`, `gp_link_resume_onboarding_id` | "…All that's left is a quick photo of your passport or driving licence…" / "…The last step is a quick photo ID check…", both ending "start browsing GP positions across Australia". | No banned word. Only correct if the Australian sign-up has the same photo ID step at the same place. Not sent to Australian doctors today. |

### Not for Australian recipients (22)

| Template | Offending text |
| --- | --- |
| `gp_link_consult_call_booked` | "Bring every question you have about registration, **visas**, earnings and life in Australia" |
| `gp_link_consult_call_reminder` | the same sentence |
| `gp_link_consult_hello_5m` | "I help **UK** GPs work out whether a **move to Australia** is realistic" |
| `gp_link_consult_check_in_1h` | "the one thing you'd most want answered about **moving to Australia** (registration, **the visa**, money, timing, family)" |
| `gp_link_consult_day_after_24h` | "If Australia is a someday thing rather than a right-now thing" (assumes a change of country) |
| `gp_link_consult_signup_welcome` | "walk you step by step from **UK** practice to your first day in an Australian clinic" |
| `gp_link_app_rso_welcome` | "your dedicated **Registration Support Officer** … guide you through every step of **getting registered to work as a GP in Australia** … start this next chapter in life" |
| `gp_link_reg_call_reminder`, `gp_link_reg_call_starting` | "your GP Link **registration support call** … Your **registration support officer** will walk you through your current step" |
| `gp_link_app_myintealth_introductiory_message_` | header "Myintealth Step Begun"; "you've begun the **MyIntealth** step" |
| `gp_link_app_amc_introductiory_message_` | header "**AMC** Step Begun" |
| `gp_link_app_ahpra_introductiory_message` | header "AHPRA Step Begun"; "preparing your supervision plan … before you submit it in your registration application via AHPRA" |
| `gp_link_ahpra_docs_complete` | "every document needed for your AHPRA registration is now complete" |
| `gp_link_visa_passports` | "your AHPRA registration has come through. Next step is the **visa** … everyone moving with you" |
| `gp_link_visa_passports_reminder` | "For your **visa** we are still waiting on" |
| `gp_link_onboarding_step_start` | "a few easy questions about **your move**" |
| `gp_link_onboarding_step_move` | "You stopped at planning **your move**: when you'd like to arrive … who is coming with you"; button "Plan my move" |
| `gp_link_resume_onboarding_start` | "starting your pathway to practising in Australia" |
| `gp_link_resume_onboarding_move` | "setting up **your move** to Australia" |
| `gp_link_start_practice_search` | "our team then walks you through the registration paperwork around it" |
| `gp_link_offer_signature_nudge` | "Once it's signed your position is locked in and we begin your registration together" |
| `gp_link_reengage_hayley` | "**UK** GPs are being hired right now and the fast-track registration route is open" |

### Unknown / not usable (1)

`gp_link_onboarding_step_register`: REJECTED by Meta, and its text names
"GMC, IMC or MCNZ number" (button "Add my GMC number"), so it would be "not
for Australian recipients" even if approved.

### Where this differs from the review's guesses

| The review said | What the live text shows |
| --- | --- |
| Likely reusable: call booked | **No.** Mentions visas. |
| Likely reusable: the three call reminders | **Two of three.** One hour and five minutes: yes. Day before: no (visas). |
| Likely reusable: missed call | Yes. |
| Likely reusable: match invitation | Yes. (Match *accepted* was not on the list: with care.) |
| Likely reusable: interview templates, contract ready | With care: "Registration Support Officer" in all four. |
| Likely reusable: account released | Yes. |
| Likely reusable: upload CV nudge | With care ("any position"). |
| Likely reusable: practice candidate introduction | Yes, both. |
| New approval needed: AU post-call onboard | **Not needed.** The existing v3 note is neutral. |
| Never send: MyIntealth, AMC and AHPRA introductions, AHPRA docs complete, visa passports and reminder | Confirmed, and all six are already blocked in code. |
| (not listed) | Also never: the staff welcome (`gp_link_app_rso_welcome`, **not blocked**), the two registration-call reminders (**not blocked**), sign-up welcome, the three pre-booking notes, the step nudges. |
| (not listed) | The set-up nudge `gp_link_consult_onboarding_nudge` is reusable. |

## 4. Each Australian message: reuse, new, or email only

"Setting change" means editing the row in `lib/au-whatsapp-templates.js`:
set `templateName` to the existing name and `approved: true`. (The environment
variable `AU_WHATSAPP_APPROVED_TEMPLATES` can only switch a row on; it cannot
point a row at a different name, so a reuse needs the one-line code edit.)

| Message | Key | Answer | Change |
| --- | --- | --- | --- |
| N01 hello, 5 min | `lead_hello_5m` | New template | Owner submits `gp_link_au_lead_hello` (corrected wording, section 5) |
| N01 check-in, 1 h | `lead_check_in_1h` | New template | Owner submits `gp_link_au_lead_check_in` (corrected) |
| N01 last note, 24 h | `lead_day_after_24h` | New template | Owner submits `gp_link_au_lead_last_note` |
| N02 call booked | `lead_call_booked` | New template | Owner submits `gp_link_au_lead_call_booked` |
| N02 day-before reminder | `lead_call_reminder` | New template | Owner submits `gp_link_au_lead_call_reminder` |
| N02 one hour before | `lead_call_hour_before` | **Reuse** | `templateName: 'gp_link_consult_call_1h', approved: true` |
| N02 five minutes before | `lead_call_starting` | **Reuse** | `templateName: 'gp_link_consult_call_starting_5m', approved: true` |
| N02 missed call | `lead_call_missed` | **Reuse** | `templateName: 'gp_link_consult_missed_call', approved: true` |
| N03 after the call | `lead_post_call_onboard` | **Reuse** (owner to confirm wording) | `templateName: 'gp_link_consult_post_call_onboard_v3', approved: true` |
| N04 welcome (lead who signs up) | `lead_signed_up` | New template | Owner submits `gp_link_au_lead_signup_welcome` |
| N04 welcome when staff are assigned | none yet | New template, and block the overseas one | Add a key (suggest `team_welcome`) and stop `ensureRsoWelcomeSent` sending `gp_link_app_rso_welcome` to an Australian doctor; draft in section 5 |
| N05 set-up not finished (lead) | `lead_onboarding_incomplete` | **Reuse** | `templateName: 'gp_link_consult_onboarding_nudge', approved: true` |
| N05 step-by-step nudges | none | Email only | The four step templates talk about "your move" and a GMC number. Australian doctors are already left out of those sweeps. New ones only if the owner wants them. |
| N09 match | not in the map | **Reuse, no change** | `gp_link_app_match_invitation` is already sent and is neutral. Record it as confirmed. |
| Match accepted | none yet | With care | Owner decision (below) |
| Interview times ready | none yet | With care | Owner decision (below) |
| Interview confirmed, doctor | none yet | With care | Owner decision (below) |
| Interview confirmed, practice | none yet | With care | Owner decision (below) |
| Contract ready | none yet | With care | Owner decision (below) |
| N10 practice introduction, no CV | `practice_intro` | **Reuse** | `templateName: 'gp_link_practice_candidate_intro', approved: true` |
| N10 practice introduction, CV | `practice_intro_cv` | **Reuse** | `templateName: 'gp_link_practice_candidate_intro_cv', approved: true` |
| N11 placement secured | `placement_secured` | New template | Owner submits `gp_link_au_placement_secured` |
| N16 cleared to start | none yet | New template or email only | No existing template fits. Draft in section 5 if a WhatsApp is wanted. |
| N18 first week, doctor | `commencement_checkin` | New template | Owner submits `gp_link_au_first_week_checkin` |
| N18 first week, practice | `commencement_checkin_practice` | New template | Owner submits `gp_link_au_practice_first_week_checkin` |
| Account released | not in the map | Reuse, no change | `gp_link_account_released` is neutral and already sent. |

### The owner decision on the five "with care" messages (R6, W3-D7)

These five reach Australian doctors and practices today with "Registration
Support Officer" in them. Two ways to close R6:

- **A. Accept the wording for now.** No banned word is sent. Record the five
  as "confirmed, with a known should-level phrase" and leave the sends as they
  are. Submit the neutral versions in section 5 when convenient.
- **B. Hold to the rule strictly** (recommended, because the messages also
  promise a staff member on the interview call, which may not be true for an
  Australian doctor). Add five rows to `lib/au-whatsapp-templates.js`
  (`match_accepted`, `interview_times_ready`, `interview_confirmed_gp`,
  `interview_confirmed_practice`, `contract_ready`) pointing at the new
  `gp_link_au_*` names, not approved; for an Australian doctor send through
  `auDoctorWhatsAppPlan(key)` at `server.js:53399` (and no plain-text fallback
  at `:53415`), `:56016`, `:104432`, `:104248-104253`, `:103869`, `:103904`
  and `:53309`. Until approved the doctor and practice get the emails, which
  already carry the same links.

Either way the same rows let the owner switch later with one line.

Also needed whichever is chosen (both are overseas wording reaching an
Australian doctor with no check):

- `ensureRsoWelcomeSent` (`server.js:31398`): skip for a doctor on an
  Australian pathway, or send the Australian welcome once approved.
- The `registration` call-reminder track (`server.js:32807`, send at
  `:32985`): skip `gp_link_reg_call_reminder` / `gp_link_reg_call_starting`
  when the booking's doctor is on an Australian pathway.

## 5. Corrections to the drafted Australian templates

What the 79 approved templates and the earlier create calls show about what
passes:

- A body never starts or ends with a variable. Meta rejects one that does.
- A link as a body variable passes, provided fixed words follow it.
- `Hi {{1}},` as the opening passes everywhere.
- A dynamic URL button has a fixed address and the variable as the last part
  (`…?token={{1}}`, `…?applicationId={{1}}`, `…?step={{1}}`). One dynamic
  button per template.
- Creating through the API needs a sample value for every variable
  (`components.body.example`, a flat list), a sample for a button variable,
  and a sample file link for a document header. Without the body samples the
  create call fails.
- A template can be edited only 24 hours after its last edit, and an edit
  sends it back to review. Get the wording right before submitting.
- Meta decides the category. Send `allowCategoryUpdate: true`.

### Corrections

1. **Three drafts end with the link and would be rejected.** Add a closing
   line. The same change is needed in `lib/au-lead-copy.js`
   (`PROPOSED_WHATSAPP_TEMPLATES`) and `docs/au-gp/au-lead-copy.md`, because
   `tests/au-wp16-copy-snapshot.test.js` pins them together.
   - `gp_link_au_lead_hello`: end with "…Or pick a time for a chat here:
     {{2}}" then a new last line "Khaleed, GP Link".
   - `gp_link_au_lead_check_in`: end with "…free and confidential: {{2}}" then
     "Khaleed, GP Link".
   - `gp_link_au_lead_missed_call`: only matters if the owner prefers it to
     the existing missed-call template: end with "…pick a new time here:
     {{2}}" then "Or reply with a time that suits you and I will make it
     work."
2. **Five lead drafts and both practice drafts need not be submitted**:
   `gp_link_au_lead_call_1h`, `gp_link_au_lead_call_starting_5m`,
   `gp_link_au_lead_missed_call`, `gp_link_au_lead_post_call`,
   `gp_link_au_lead_onboarding_nudge`, `gp_link_au_practice_candidate_intro`,
   `gp_link_au_practice_candidate_intro_cv`. Existing approved templates cover
   them (section 4).
3. **Categories.** The existing sign-up welcome and set-up nudge were approved
   as MARKETING; expect `gp_link_au_lead_signup_welcome` to be classed the
   same, not UTILITY as drafted. The existing after-the-call note was approved
   as UTILITY, so `gp_link_au_lead_post_call` (if ever submitted) could go in
   as UTILITY. The first-week check-ins ask an open question and may be
   re-classed as MARKETING.
4. **`gp_link_au_placement_secured` button.** The draft makes the whole path
   the variable (`https://app.mygplink.com.au/{{1}}`). Every approved dynamic
   button has a fixed page and a variable value. Safer: a fixed button to
   `https://app.mygplink.com.au/pages/my-documents`, as
   `gp_link_account_released` does, and drop the button value from the send at
   `server.js:8277`. If the draft is kept, give `pages/my-documents` as the
   button sample.
5. **`gp_link_au_lead_call_booked`** says "we will send it here before the
   call as well". That is true once the one-hour and five-minute reminders are
   switched on by reuse (section 4); switch them on together.
6. **Quick replies.** If `gp_link_au_lead_call_1h` is ever submitted, its two
   buttons must read exactly "I'll be there" and "Need another time": the app
   matches on those words, and the live template uses them.
7. **Sample values to submit with each** (obviously fake):
   first name "Sam"; practice "Test Metro Practice"; time "Thursday 14
   January, 10:30 am (Perth time)"; booking link
   "https://app.mygplink.com.au/start?lead=sample#book"; join link
   "https://zoom.us/j/0000000000"; contact "Alex"; doctor "Dr Jane Citizen".
8. No draft breaks the wording rules: none contains a banned word, a dollar
   figure or a percentage, and none mentions registration steps or a change of
   country.

### Drafts for the messages that have none yet

All UTILITY, `en`. Variables match what the code already passes, so the app
needs no other change.

| Suggested key | Template name | Body | Button |
| --- | --- | --- | --- |
| `interview_times_ready` | `gp_link_au_interview_times_ready` | Hi {{1}}, great news: {{2}} would like to interview you, and their available times are ready for you to choose from.<br><br>Tap the button below to pick the time that suits you best. It only takes a moment.<br><br>If none of the times work for you, just reply to this message and we will arrange others. | URL "Choose your time" → `https://app.mygplink.com.au/pages/secure-interview?applicationId={{1}}` |
| `interview_confirmed_gp` | `gp_link_au_interview_confirmed_gp` | Hi {{1}}, your interview with {{2}} is confirmed for {{3}}.<br><br>Join the video call here when it is time:<br>{{4}}<br><br>If you need to reschedule, just reply to this message and we will sort it out. | none |
| `interview_confirmed_practice` | `gp_link_au_interview_confirmed_practice` | Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}.<br><br>Join the video call here when it is time:<br>{{4}}<br><br>If you need to reschedule, just reply to this message and we will arrange a new time. | none |
| `contract_ready` | `gp_link_au_contract_ready` | Congratulations {{1}}, {{2}} has offered you the position.<br><br>The next step is to review your employment agreement and sign it. Tap the button below to open it. If something needs adjusting before you can sign, you can request a change on the same page.<br><br>Any questions, reply here and our team will help. | URL "Complete agreement" → `https://app.mygplink.com.au/pages/offer-review?applicationId={{1}}` |
| `match_accepted` | `gp_link_au_match_accepted` | Hi {{1}}, thanks for accepting your match with {{2}}. We are now arranging your interview and will send you times to choose from, usually within a couple of business days. Reply here if you have any questions. | none |
| `team_welcome` | `gp_link_au_team_welcome` | Hi Dr {{1}}, welcome to GP Link.<br><br>I'm {{2}}, and I will be your main point of contact from here to your first day at your new practice.<br><br>Whenever you have a question or need a hand, just send me a message here.<br><br>Warm regards,<br>{{3}}<br>GP Link | none |
| `cleared_to_start` (N16, optional) | `gp_link_au_cleared_to_start` | Hi {{1}}, good news: everything on your pre-start checklist is complete, and you are cleared to start at {{2}} on {{3}}.<br><br>If anything changes before then, reply here and we will help. | none |

If the interview drafts should still say someone from GP Link joins the call,
add "Someone from the GP Link team will be on the call with you." only if that
is true for Australian interviews.

## Appendix: every template in the account, word for word

Read 22 November 2026, 06:49 UTC. People's surnames in the fixed text are
removed; sample file addresses are left out. "Made by" is how the template was
created: the API (the app's era), the dashboard under the owner's login, or
the previous developer's bot login. No template has a footer.

### A. The 42 templates the code can send

| Name | Category | Status | Made by | Header | Body | Buttons |
| --- | --- | --- | --- | --- | --- | --- |
| `gp_link_account_released` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, good news — your GP Link account has been reviewed and released. You now have full access, including the job board.<br><br>Tap below to browse the practices looking for GPs right now, and we will start matching you as soon as you have had a look. | URL "Browse jobs" → `https://app.mygplink.com.au/pages/career` |
| `gp_link_ahpra_docs_complete` | UTILITY | APPROVED | API | none | Hi {{1}}, fantastic news — every document needed for your AHPRA registration is now complete and accepted! ✅<br><br>Your AHPRA registration step is unlocked and ready. Please begin as soon as possible to keep your registration moving: {{2}}<br><br>If you need any help at any point, just reply to this message and we'll assist you right away. | none |
| `gp_link_app_ahpra_introductiory_message` | UTILITY | APPROVED | dashboard | TEXT: AHPRA Step Begun | Hey Dr {{name}}, great to see you’re moving into the AHPRA step!<br><br>On our end, we’ve started preparing your supervision plan along with the rest of the required documents, these will be uploaded to your app for you to review as they’re completed.<br><br>In the meantime, please make sure you’ve prepared and had all your required documents certified and uploaded to the app so that we can verify before you submit it in your registration application via AHPRA. <br><br>If you’re unsure about anything or want me to check a document, just send it through anytime.<br><br>Warm regards,<br>Hazel<br>GP Link | none |
| `gp_link_app_amc_introductiory_message_` | UTILITY | APPROVED | dashboard | TEXT: AMC Step Begun | Hey Dr {{name}}, great to see you’ve started the AMC step!<br><br>This is an important stage and things should begin moving through nicely from here. <br><br>If anything feels unclear or you want me to double check something along the way, just send me a message... happy to help wherever needed.<br><br>Warm regards,<br>Hazel<br>GP Link | none |
| `gp_link_app_match_accepted` | UTILITY | APPROVED | API | none | Hi {{1}}, thanks for accepting your match with {{2}}. Your Registration Support Officer is now arranging your interview — we’ll send you interview times to choose from, usually within a couple of business days. Reply here if you have any questions. | none |
| `gp_link_app_match_invitation` | MARKETING | APPROVED | API | none | Hi {{1}} 👋<br><br>Great news — you have been personally matched with {{2}}.<br><br>{{3}}<br><br>Have a look and let us know if you would like to go forward to an interview:<br>{{4}}<br><br>Not the right fit? Just reply here and tell us why — it helps us find you a better one. | none |
| `gp_link_app_myintealth_introductiory_message_` | UTILITY | APPROVED | dashboard | TEXT: Myintealth Step Begun | Hey Dr {{name}}, I can see you’ve begun the MyIntealth step 👏<br><br>Just a quick note to say you’re on the right track. If you need any help at all while setting up your account or uploading documents, feel free to reach out anytime. I’m here to guide you through it step by step.<br><br>Warm regards,<br>Hazel [surname removed]<br>GP Link Recruitment | none |
| `gp_link_app_rso_welcome` | UTILITY | APPROVED | API | none | Hi Dr {{1}}, welcome to GP Link 👋<br><br>I'm {{2}}, your dedicated Registration Support Officer. I'll be your main point of contact and will guide you through every step of getting registered to work as a GP in Australia.<br><br>Whenever you have a question or need a hand, just shoot me a message. Excited to be working with you and in helping you start this next chapter in life!<br><br>Warm regards,<br>{{3}}<br>Registration Support Officer<br>GP Link | none |
| `gp_link_consult_call_1h` | UTILITY | APPROVED | API | none | Hi {{1}}, a quick reminder that your call with me is in about an hour, at {{2}}.<br><br>Here is your link to join:<br>{{3}}<br><br>If clinic is running over or something has come up, that is completely fine. Just tap below or reply here and we will find another time.<br><br>Speak soon,<br>Khaleed, CEO, GP Link | QUICK_REPLY "I'll be there"; QUICK_REPLY "Need another time" |
| `gp_link_consult_call_booked` | UTILITY | APPROVED | API | none | Hi {{1}}! Fantastic news, your free 30-minute consultation with GP Link is locked in for {{2}}. 🎉<br><br>I am really looking forward to this one. Bring every question you have about registration, visas, earnings and life in Australia, and you will get straight answers. The meeting link will arrive by email before the call.<br><br>Speak soon!<br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_call_reminder` | UTILITY | APPROVED | API | none | Hi {{1}}, just a quick reminder that your free 30-minute consultation with GP Link is coming up on {{2}}.<br><br>Here is your link to join when it is time:<br>{{3}}<br><br>Bring every question you have about registration, visas, earnings and life in Australia, and you will get straight answers. If the time no longer suits, just reply here and we will happily move it.<br><br>Speak soon!<br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_call_starting_5m` | UTILITY | APPROVED | API | none | Hi {{1}}, your consultation with GP Link starts in 5 minutes. Tap here to join:<br>{{2}}<br><br>I am on the call ready for you. If you are running a few minutes late that is completely fine, just join when you can. If something has come up and you would rather rebook, reply to this message and we will sort it out.<br><br>See you shortly!<br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_check_in_1h` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed again. I know a form is easy to fill in on the way to something else, so no pressure at all. If it helps, just reply with the one thing you'd most want answered about moving to Australia (registration, the visa, money, timing, family) and I'll answer it myself. Or if you'd rather cover it all in one go, grab a time here: {{2}} Thirty minutes, free, no obligation. | none |
| `gp_link_consult_day_after_24h` | MARKETING | APPROVED | API | none | Hi {{1}}, last note from me, I promise. If Australia is a someday thing rather than a right-now thing, that's completely fine, and I'm happy to leave it here. If you do want to talk it through at some point, you can book straight in whenever suits you: {{2}} Either way, I hope the week is treating you kindly. Khaleed | none |
| `gp_link_consult_hello_5m` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed here from GP Link. I just saw your form come through, thank you. I help UK GPs work out whether a move to Australia is realistic for them, and I'd rather have a proper chat than send you a brochure. If it's easier, pick a time that suits you here: {{2}} One quick question so I can point you the right way: are you thinking this year, or next? | none |
| `gp_link_consult_missed_call` | UTILITY | APPROVED | API | none | Hi {{1}}, sorry we missed each other for our call. No problem at all, I know how quickly a clinic day can change.<br><br>You can pick a new time here: {{2}}<br><br>Or just reply with a time that suits you and I will make it work.<br><br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_onboarding_nudge` | MARKETING | APPROVED | API | none | Hi {{1}}! Khaleed here, CEO of GP Link. 👋<br><br>You are so close! Just a few quick steps left to unlock your dashboard. It takes about 5 minutes, and the moment it is done we can start matching you with Australian practices that genuinely fit what you are looking for.<br><br>Sign back in at https://app.mygplink.com.au and pick up where you left off.<br><br>Stuck on anything? Reply here and I will personally make sure you are looked after.<br>Khaleed | none |
| `gp_link_consult_post_call_onboard_v3` | UTILITY | APPROVED | API | none | Thanks for jumping on today {{1}}, keen to get the ball rolling for you.<br><br>Next step is a quick one: set up your GP Link account (about 5 minutes) and upload your CV. Once that's in I can start matching you to practices that fit what we talked about, and you'll be able to browse the roles we have open right now to get a feel for what's out there.<br><br>Here's your link: {{2}}<br><br>Shout if anything's unclear. I read these myself. | none |
| `gp_link_consult_signup_welcome` | MARKETING | APPROVED | API | none | Hi {{1}}, welcome to GP Link! 🎉<br><br>Khaleed here, the CEO. I am thrilled to have you on board. Your account is live, and the app will walk you step by step from UK practice to your first day in an Australian clinic.<br><br>Your next step takes about 5 minutes: finish setting up your profile so we can start matching you with practices that truly fit what you are looking for.<br><br>Need anything at all? Reply right here. My team and I read every message.<br>Khaleed, CEO, GP Link | none |
| `gp_link_contract_ready` | UTILITY | APPROVED | API | none | Congratulations {{1}} 🎉 {{2}} has offered you the position.<br><br>All that is left is to secure it: review your employment agreement and sign it. Tap the button below to complete your agreement. If something needs adjusting before you can sign, you can request a change on the same page.<br><br>Any questions, reply here and your Registration Support Officer will help. | URL "Complete agreement" → `https://app.mygplink.com.au/pages/offer-review?applicationId={{1}}` |
| `gp_link_interview_confirmed_gp` | UTILITY | APPROVED | API | none | Hi {{1}}, your interview with {{2}} is confirmed for {{3}}. 🎉<br><br>Join the video call here when it is time:<br>{{4}}<br><br>Your Registration Support Officer will be on the call with you. If you need to reschedule, just reply to this message and we will sort it out. | none |
| `gp_link_interview_confirmed_practice` | UTILITY | APPROVED | API | none | Hello {{1}}, this is GP Link. Your interview with {{2}} is confirmed for {{3}}.<br><br>Join the video call here when it is time:<br>{{4}}<br><br>A GP Link Registration Support Officer will also be on the call. If you need to reschedule, just reply to this message and we will arrange a new time. | none |
| `gp_link_interview_times_ready` | UTILITY | APPROVED | API | none | Hi {{1}}, great news — {{2}} would like to interview you, and their available times are ready for you to choose from.<br><br>Tap the button below to pick the time that suits you best. It only takes a moment, and your Registration Support Officer will be on the call with you, so you are never in the room alone.<br><br>If none of the times work for you, just reply to this message and we will arrange others. | URL "Choose your time" → `https://app.mygplink.com.au/pages/secure-interview?applicationId={{1}}` |
| `gp_link_khaleed_personal_checkin` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed here from GP Link. Hope all is well!<br><br>{{2}}<br><br>{{3}} 😊<br><br>Warm regards,<br>Khaleed | none |
| `gp_link_offer_signature_nudge` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, congratulations again, your position offer is waiting for you. The last step is to review and sign your agreement, and it only takes a few minutes: https://app.mygplink.com.au/pages/career<br>Once it's signed your position is locked in and we begin your registration together. Any questions about the agreement? Reply here and I'll answer them personally.<br>Khaleed, CEO of GP Link | none |
| `gp_link_onboarding_step_id` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. You're one step away from finishing your GP Link profile. All that's left is a quick photo of your passport or driving licence, which takes under a minute. Tap the button below to finish, and you can start browsing GP positions across Australia straight away.<br><br>Any trouble with the upload? Reply here and I'll sort it out with you.<br><br>Khaleed, CEO of GP Link | URL "Finish my profile" → `https://app.mygplink.com.au/pages/onboarding.html?step={{1}}` |
| `gp_link_onboarding_step_move` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. You stopped at planning your move: when you'd like to arrive, which city appeals and who is coming with you. It takes about a minute, and it's how we shortlist practices that suit you and your family. Tap the button below to carry on.<br><br>Any questions about working or living in Australia? Reply here and I'll answer them personally.<br><br>Khaleed, CEO of GP Link | URL "Plan my move" → `https://app.mygplink.com.au/pages/onboarding.html?step={{1}}` |
| `gp_link_onboarding_step_register` | MARKETING | REJECTED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. Good news: you no longer need to upload any certificates to finish your profile. Just pick the country you qualified in and enter your GMC, IMC or MCNZ number, and we confirm you on the public register. It takes about a minute. Tap the button below to continue.<br><br>If anything is unclear, reply here and my team will sort it out with you.<br><br>Khaleed, CEO of GP Link | URL "Add my GMC number" → `https://app.mygplink.com.au/pages/onboarding.html?step={{1}}` |
| `gp_link_onboarding_step_start` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. Your account is ready, but your profile is still empty, so my team can't start looking for practices for you yet. It takes about 3 minutes and starts with a few easy questions about your move. Tap the button below to pick up where you left off.<br><br>If anything is holding you back, just reply here and I'll help you personally.<br><br>Khaleed, CEO of GP Link | URL "Start my profile" → `https://app.mygplink.com.au/pages/onboarding.html?step={{1}}` |
| `gp_link_owner_lead_alert` | UTILITY | APPROVED | API | none | Lead needs a personal follow-up. Name: {{1}}. Phone: {{2}}. They said: {{3}}. Status: {{4}}. Reply from DoubleTick or call them now. | none |
| `gp_link_practice_candidate_intro` | UTILITY | APPROVED | API | none | Hello {{1}}, this is GP Link. We have just submitted a GP candidate for your vacancy at {{2}}.<br><br>{{3}}<br><br>Their full introduction, CV and our recommendation are in your email inbox. Tap the button below to review the candidate and accept or decline. | URL "Accept or decline" → `https://app.mygplink.com.au/pages/practice-decision.html?token={{1}}` |
| `gp_link_practice_candidate_intro_cv` | UTILITY | APPROVED | API | DOCUMENT (sample file) | Hello {{1}}, this is GP Link. We have just submitted a GP candidate for your vacancy at {{2}}.<br><br>{{3}}<br><br>Their CV is attached here, and their full introduction with our recommendation is in your email inbox. Tap the button below to review the candidate and choose to interview or decline. | URL "Interview or decline" → `https://app.mygplink.com.au/pages/practice-decision.html?token={{1}}` |
| `gp_link_reengage_hayley` | MARKETING | APPROVED | API | none | Hi {{1}}, it's Hayley from GP Link. You registered with us a while back about GP work in Australia. UK GPs are being hired right now and the fast-track registration route is open. Still interested? Tap below and I'll give you a quick call, or book a free consultation. Reply STOP to opt out. | QUICK_REPLY "Yes, call me"; QUICK_REPLY "Not right now"; URL "Book a call" → `https://app.mygplink.com.au/start?src=wa` |
| `gp_link_reg_call_reminder` | UTILITY | APPROVED | API | none | Hi {{1}}, a quick reminder that your GP Link registration support call is coming up on {{2}}.<br><br>Here is your link to join when it is time:<br>{{3}}<br><br>Your registration support officer will walk you through your current step and answer anything you are unsure about, so bring your questions. If the time no longer suits, just reply here and we will rearrange it.<br><br>See you then,<br>The GP Link team | none |
| `gp_link_reg_call_starting` | UTILITY | APPROVED | API | none | Hi {{1}}, your GP Link registration support call is starting now. Tap here to join:<br>{{2}}<br><br>Your registration support officer is waiting for you. If you are running a few minutes late that is no problem at all, just join when you can. If you need to rebook, reply to this message and we will sort it out.<br><br>See you shortly,<br>The GP Link team | none |
| `gp_link_resume_onboarding_id` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. You're one step away from finishing your GP Link setup. The last step is a quick photo ID check. It takes under a minute and keeps your account and documents secure. Finish here: https://app.mygplink.com.au/pages/index<br>As soon as it's done you can start browsing GP positions across Australia. Any trouble with the upload? Reply here and I'll sort it out with you.<br>Khaleed, CEO of GP Link | none |
| `gp_link_resume_onboarding_move` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. You're most of the way through setting up your move to Australia, only a couple of questions to go. Continue here: https://app.mygplink.com.au/pages/index<br>Once that's done we can start lining up GP positions that fit your plans. A move like this is a big step, so if you have any questions at all, reply here and I'll answer them personally.<br>Khaleed, CEO of GP Link | none |
| `gp_link_resume_onboarding_start` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, it's Khaleed from GP Link. Your account is ready and you're only a few minutes away from starting your pathway to practising in Australia. Pick up right where you left off here: https://app.mygplink.com.au/pages/index<br>It takes less than 5 minutes, and then my team gets to work finding practices that suit you. If anything is holding you back, just reply here and I'll personally help.<br>Khaleed, CEO of GP Link | none |
| `gp_link_start_practice_search` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. Your GP Link profile is set up, so the exciting part can begin: finding your practice in Australia. Browse the positions we have open and tell us which ones interest you: https://app.mygplink.com.au/pages/career<br>Securing your position is the first step, and our team then walks you through the registration paperwork around it. If you'd rather talk it through first, reply here and we'll set up a quick call.<br>Khaleed, CEO of GP Link | none |
| `gp_link_upload_cv_nudge` | MARKETING | APPROVED | API | none | Hi Dr {{1}}, Khaleed from GP Link here. Practices are ready to look at you, and the only thing missing is your CV. Upload it here and you can apply for any position straight away: https://app.mygplink.com.au/pages/career<br>It only needs to be your current CV, and our system checks it in seconds. Reply here if you'd like a hand with it.<br>Khaleed, CEO of GP Link | none |
| `gp_link_visa_passports` | UTILITY | APPROVED | API | none | Great news {{1}}, your AHPRA registration has come through. Next step is the visa. Your practice is engaging a migration agent now, and we need a clear photo of the passport photo page for you and everyone moving with you. Upload them here: {{2}} Shout if anything is unclear, I read these myself. | none |
| `gp_link_visa_passports_reminder` | UTILITY | APPROVED | API | none | Hi {{1}}, a quick reminder from GP Link. For your visa we are still waiting on {{2}}. Please upload a clear photo of the passport photo page for each person here: {{3}} If a passport is delayed, just reply here and let me know. | none |

### B. The 38 templates in the account that no code sends

Leftovers: the previous developer's bot and early campaigns (dashboard-made, no `gp_link_` prefix), retired versions of current templates, and one-off notes. Almost all assume a doctor moving to Australia. Neutral ones that could be useful later: `gp_link_consult_running_behind`, `gp_link_consult_reschedule_request`, `gp_link_consult_missed_reschedule`, `gp_link_khaleed_personal_note`, `1hr_meeting_reminder_v2`, `2_hour_detailed_reminder_v2`.

| Name | Category | Status | Made by | Header | Body | Buttons |
| --- | --- | --- | --- | --- | --- | --- |
| `1hr_meeting_reminder_v2` | UTILITY | APPROVED | dashboard | none | Nearly there, our meeting will begin in exactly one hour at {{meetingtime}}!<br><br>Once it's time you can click the link below to join.<br>{{zoomjoinlink}}<br><br>Speak soon! | none |
| `24_hour_meeting_reminder_v2` | UTILITY | APPROVED | dashboard | none | Just wanting to remind you of our meeting tomorrow at {{meetingtime}} to discuss your move to Australia as a GP. <br><br>Once it's time you can click the link below to join.<br>{{zoomjoinlink}}<br><br>If you wish to reschedule please do asap so we can offer this slot to another doctor.<br>{{zommreschedulelink}}<br><br>Looking forwards in meeting and talking with you! | none |
| `2_hour_detailed_reminder_v2` | UTILITY | APPROVED | dashboard | none | Our meeting starts in exactly 2 hours. See you soon! | none |
| `6month_followup_low_intent_v2` | MARKETING | APPROVED | previous developer's bot login | none | Hi Dr {{name}}, hope you’re well!<br><br>Checking in regarding your relocation to Australia. <br><br>Since it’s been 6 months, you might now be entering the 12-month window where practices can begin forecasting and interviewing.<br><br>Are you ready to start exploring active opportunities? | none |
| `6month_followup_low_intent_v3` | MARKETING | APPROVED | dashboard | none | Hi Dr {{name}}, hope you’re well!<br><br>Checking in regarding your relocation to Australia. <br><br>Since it’s been 6 months, you might now be entering the 12-month window where practices can begin forecasting and interviewing.<br><br>Are you ready to start exploring active opportunities? | QUICK_REPLY "I'm Ready to Start!" |
| `calendly_reminder_24hrs_v2` | UTILITY | APPROVED | dashboard | TEXT: Dr {{name}} Meeting Reminder | This is a reminder of our meeting tomorrow to discuss your move to Australia as a GP. <br><br>You should have been emailed the the Zoom meeting link sent by hello@mygplink.com.au<br><br>If you can no longer make it, please let us know right now so we can offer this slot to another doctor.<br><br>Can you confirm your attendance?  | none |
| `candidate_job_opening_v4` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}},<br><br>We've found some job openings for you! 🎉<br><br>Please have a look over the opening details and the practice, and let me know if you'd like to proceed — or which option you'd prefer, if there's more than one. <br><br>Happy to talk any of them through. Once confirmed, we'll get everything underway.<br><br>Happy to talk any of them through. Once confirmed, we’ll get everything underway.<br><br>Please see these job openings:<br><br>{{links}}<br><br>Please reply with the opening number you'd like to proceed with (e.g., "Opening 1" or "Opening 2"), or let me know if you have any questions.<br><br>Looking forward to hearing from you!<br><br>Warm Regards,<br><br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `candidate_job_opening_v5` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}},<br><br>We've found some job openings for you! 🎉<br><br>Please reply to this message so we can share the full details with you immediately.<br><br>Warm Regards,<br><br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `candidate_job_opening_v6` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}},<br><br>We've found some job openings for you! 🎉<br><br>Please let us know if you would like to receive the full details and practice locations now.<br><br>Warm Regards,<br><br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `candidate_job_opening_v7` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}},<br><br>We've found some job openings for you! 🎉<br><br>Please let us know if you would like to receive the full details and practice locations now.<br><br>Warm Regards,<br><br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | QUICK_REPLY "Show me openings"; QUICK_REPLY "Not interested" |
| `checkup_v2` | UTILITY | APPROVED | dashboard | none | Hello Dr {{name}}, yet to receive documents needed to progress. Let me know if you’re wanting to begin looking for medical centres.<br><br>Warm Regards | none |
| `chris` | UTILITY | APPROVED | dashboard | none | Hi {{name}}, just a reminder of the interview tomorrow at 5pm.  | none |
| `facebook_new_candidate_followup1_v2` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}}, this is Khaleed.<br><br>Thank you for filling out our form on Facebook regarding your move to Australia as a GP. We’d love to have a chat in which we can discuss further.<br><br>We use a new government pathway to get GPs immigrated asap, this could close at any time so we strongly encourage you to book in a time asap.<br><br>https://calendly.com/hello-mygplink/30min<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `facebook_new_candidate_followup2_v2` | MARKETING | APPROVED | dashboard | none | Hello Dr {{name}}, seems you have not booked in a 1-1 consultation with myself. What doubts are you having with your potential move to Australia?<br><br>I’ve attached the booking link below once again<br><br>https://calendly.com/hello-mygplink/30min<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `facebook_new_candidate_followup3_v2` | MARKETING | APPROVED | dashboard | none | Okay Dr {{name}}, this will be our last time reaching out to you unless you directly reach out.<br><br>I worry the expedited pathway may close soon due to an huge influx in GP’s immigrating at the moment.<br><br>I want to be of help and get you secured in the pathway.<br><br>If this is still of interest please book in a personal 1-1 consultation.<br><br>https://calendly.com/hello-mygplink/30min<br><br>Best of luck Dr {{name}}<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `forhealth_followup_form` | MARKETING | APPROVED | dashboard | none | Hey Dr {{name}} Got your reply.<br><br>In the meeting, they’ll take the time to understand your current situation, what you’re looking for, and walk you through what to expect working as a GP in Australia, including details of their clinics and opportunities.<br><br>If it’s not the right fit, that’s not an issue — we have a wide range of other roles available and can explore those with you afterwards.<br><br>Warm Regards,<br>Khaleed<br>CEO<br>GP Link | URL "Secure Your Spot" → `https://zfrmz.com.au/lXq1lI5lQ28Reg7prJsc` |
| `forhealth_inperson_campaign` | MARKETING | APPROVED | dashboard | TEXT: We'd love to meet you in-person | Hi Dr {{name}},<br>One of our key partners, ForHealth, will be in the UK shortly meeting GPs in person regarding opportunities to relocate and practise in Australia.<br><br>If you’d be open to a face-to-face discussion while they’re there, let me know and I can arrange a time. | none |
| `gp_link_consult_book_nudge` | MARKETING | APPROVED | API | none | Hi {{1}}! Khaleed here, CEO of GP Link. 👋<br><br>Thank you so much for your interest in working as a GP in Australia. This is genuinely one of the best moves a UK trained GP can make, and I would love to show you exactly how it works on a free 30-minute call. Registration, visa, timing, earnings, I will cover it all and answer anything you want to know.<br><br>Grab a time that suits you here: {{2}}<br><br>Speak soon!<br>Khaleed | none |
| `gp_link_consult_book_nudge_2` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed again from GP Link. 👋<br><br>I know life as a GP gets busy, so this is just a gentle reminder. UK trained GPs who make the move to Australia tell me the same thing: they wish they had started sooner. A free 30-minute call is all it takes to see what your own pathway would look like, with no obligation at all.<br><br>Pick a time that works for you: {{2}}<br><br>Happy to answer anything in the meantime, just reply here.<br>Khaleed | none |
| `gp_link_consult_book_nudge_3` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed here, last note from me. 😊<br><br>I do not want to keep messaging if the timing is not right, so this is my final nudge. If you would still like to talk through registration, visas, timing or earnings for a GP career in Australia, my calendar is open and the call is free.<br><br>Book here whenever suits: {{2}}<br><br>If now is not the moment, no problem at all. You are welcome to reach out any time in the future. Wishing you all the best.<br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_call_starting` | UTILITY | APPROVED | API | none | Hi {{1}}, your consultation with GP Link is starting now. Tap here to join:<br>{{2}}<br><br>Khaleed here, CEO of GP Link, and I am on the call ready for you. If you are running a few minutes late that is completely fine, just join when you can. If something has come up and you would rather rebook, reply to this message and we will sort it out.<br><br>See you shortly!<br>Khaleed, CEO, GP Link | none |
| `gp_link_consult_missed_reschedule` | UTILITY | APPROVED | API | none | Hi Dr {{1}}, not a worry at all that you missed our meeting!<br><br>We can reschedule for {{2}} if that works for you?<br><br>Just reply here to confirm and I'll send through the meeting link. | none |
| `gp_link_consult_post_call_followup` | UTILITY | APPROVED | API | none | Hello dr {{1}}, it was a pleasure.<br><br>Let me know once you have decided you are happy to get the ball rolling and we can begin matching you with a practice we think would be a good fit in line with our conversation!<br><br>In the meantime I have also reached out to the GP i mentioned from Newcastle to see if he would be happy to chat with you and share his experience<br><br>Have you managed to onboard onto the GP Link App? | none |
| `gp_link_consult_post_call_onboard` | UTILITY | APPROVED | API | none | Hi {{1}}, Khaleed here. Thanks for your time today. Really enjoyed the chat and I'm keen to get the ball rolling for you.<br><br>Next step is a quick one: set up your GP Link account (about 5 minutes) and upload your CV. Once that's in I can start matching you to practices that fit what we talked about, and you'll be able to browse the roles we have open right now to get a feel for what's out there.<br><br>Here's your link: {{2}}<br><br>Shout if anything's unclear. I read these myself. | none |
| `gp_link_consult_post_call_onboard_v2` | UTILITY | APPROVED | API | none | Really enjoyed that chat today, {{1}}. Thanks for making the time. I came off the call keen to get the ball rolling for you.<br><br>Next step is a quick one: set up your GP Link account (about 5 minutes) and upload your CV. Once that's in I can start matching you to practices that fit what we talked about, and you'll be able to browse the roles we have open right now to get a feel for what's out there.<br><br>Here's your link: {{2}}<br><br>Shout if anything's unclear. I read these myself. | none |
| `gp_link_consult_reschedule_request` | UTILITY | APPROVED | API | none | Hi Dr {{1}},<br><br>I'm very sorry, but our scheduling system had a malfunction and accidentally double booked a number of our GPs, including your consultation on {{2}}.<br><br>Would you be available anytime between {{3}}, or at {{4}} instead? Just reply here with whatever suits you best and we'll confirm the new time straight away.<br><br>We sincerely apologise for the mix up and hope you understand.<br><br>Khaleed<br>CEO, GP Link | none |
| `gp_link_consult_running_behind` | UTILITY | APPROVED | API | none | Hi {{1}}, Khaleed here, CEO of GP Link.<br><br>I'm very sorry, we are running a little behind schedule today. Would you be available at {{2}} instead of {{3}} for your consultation?<br><br>Just reply here to let me know if that works, or suggest another time that suits you, and we'll confirm straight away.<br><br>Apologies for the change, and thank you for your understanding.<br>Khaleed, CEO, GP Link | none |
| `gp_link_curious_followup` | MARKETING | APPROVED | API | none | Hi {{1}}, Khaleed here from GP Link. You said you're curious rather than planning a date, which is exactly where most of the GPs I speak to start, and that's fine.<br><br>No pressure on timing. If there's one thing you'd most like to know, how AHPRA registration works for a UK-trained GP, the visa, how practices are set up, or what a typical week looks like, reply here and I'll answer it in writing.<br><br>If a quick chat would suit better, pick any 30 minutes that works and we'll go through whatever you're curious about. Completely free for doctors, start to finish. | QUICK_REPLY "Ask a question"; QUICK_REPLY "Not right now"; URL "Pick a time" → `https://calendly.com/hello-mygplink/30min` |
| `gp_link_khaleed_personal_note` | MARKETING | APPROVED | API | none | Hi {{1}}, hope all is well!<br><br>{{2}}<br><br>{{3}} 😊<br><br>Warm regards,<br>Khaleed | none |
| `gp_link_pep_pathway_open` | MARKETING | APPROVED | API | none | Good news {{1}}, the PEP pathway is now open on GP Link.<br><br>Your account is unlocked, so you can start looking for a position today. Browse the practices hiring right now and tell us which ones interest you. Once you have a practice lined up, our team walks you through the registration around it.<br><br>Here's your link: {{2}}<br><br>Reply here if you'd rather talk it through first. I read these myself.<br><br>Khaleed, CEO of GP Link | none |
| `gp_link_reengage_hayley_v2` | MARKETING | APPROVED | API | none | Hi {{1}}, it's Hayley from GP Link. You registered with us a while back about GP work in Australia. Practices are hiring UK GPs right now and the fast-track registration route is open. Would a quick call help you see where you stand? Reply YES and I'll ring you, or book a time that suits you here: https://app.mygplink.com.au/start?src=wa<br><br>Reply STOP to opt out. | none |
| `low_intent_candidate_follow_up_v2` | MARKETING | APPROVED | dashboard | none | Thanks for the update, Dr {{name}}! 🚀<br><br>Since you’re ready to move within 12 months, let’s get a call in the diary to discuss your preferences and what’s available right now.<br><br>You can book a time that suits you here: https://calendly.com/hello-mygplink/30min<br><br>Warm regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `low_intent_candidate_welcome_message_v2` | MARKETING | APPROVED | dashboard | none | Hi Dr {{name}},<br><br>While we would love to help you secure a role immediately, the current market reality is that practices rarely recruit more than a year in advance. Because vacancies change quickly, we work exclusively with GPs moving within a 6-12 month window to ensure the roles we present to you are live and secure.<br><br>Here is how we can help right now: Attached is our comprehensive Relocation Guide. Please feel free to review this as you finalise your decision-making process.<br><br>We definitely want to work with you when the timing is right. Please reach out when you are within a year out from your move date so we can present you with active opportunities.<br><br>If your timeline has shifted and you are now looking to move sooner, simply let us know by clicking below!<br><br>Warm Regards<br>Khaleed<br>Co-Founder<br>GP Link | none |
| `low_intent_candidate_welcome_message_v3` | MARKETING | APPROVED | dashboard | DOCUMENT (sample file) | Hi Dr {{name}},<br><br>While we would love to help you secure a role immediately, the current market reality is that practices rarely recruit more than a year in advance. Because vacancies change quickly, we work exclusively with GPs moving within a 6-12 month window to ensure the roles we present to you are live and secure.<br><br>Here is how we can help right now: Attached is our comprehensive Relocation Guide. Please feel free to review this as you finalise your decision-making process.<br><br>We definitely want to work with you when the timing is right. Please reach out when you are within a year out from your move date so we can present you with active opportunities.<br><br>If your timeline has shifted and you are now looking to move sooner, simply let us know by clicking below!<br><br>Warm Regards<br>Khaleed<br>Co-Founder<br>GP Link | QUICK_REPLY "Moving This Year" |
| `send_calendly_confirmation_v2` | UTILITY | APPROVED | dashboard | none | Fantastic news, Dr {{name}}!<br><br>I’ve just received confirmation of your booking. I am really looking forward to our 1-1 consultation to discuss your potential move to Australia.<br><br>Please check your email for the calendar invite and the meeting link.<br><br>Speak soon!<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `shortlist_forhealth_campaign` | MARKETING | APPROVED | dashboard | none | Hey Dr {{name}} Got your reply.<br>Here’s the form to secure a meeting with ForHealth while they’re in the UK.<br><br>London: 11th–19th May<br>Manchester: 14th May (subject to demand)<br><br>Please complete this to be considered for the shortlist | URL "Complete Application" → `https://zfrmz.com.au/lXq1lI5lQ28Reg7prJsc` |
| `welcome_message_2_v2` | MARKETING | APPROVED | dashboard | TEXT: Dr {{name}} to Australia | Hello Dr {{name}}, this is Khaleed.<br><br>Looks like you're planning on moving to Australia to continue your career as a General Practitioner. We’d love to have a chat in which we can discuss further.<br><br>We use a new government pathway to get GPs immigrated asap, this could close at any time so we strongly encourage you to book in a time asap.<br><br>{{DT_LINK_0}}<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
| `welcome_message_2_v3` | MARKETING | APPROVED | dashboard | TEXT: Dr {{name}} to Australia | Hello Dr {{name}}, this is Khaleed.<br><br>Looks like you're planning on moving to Australia to continue your career as a General Practitioner. We’d love to have a chat in which we can discuss further.<br><br>We use a new government pathway to get GPs immigrated asap, this could close at any time so we strongly encourage you to book in a time asap.<br><br>https://calendly.com/hello-mygplink/30min<br><br>Warm Regards,<br>Khaleed [surname removed]<br>Co-Founder<br>GP Link | none |
