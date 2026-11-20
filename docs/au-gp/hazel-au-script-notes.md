# Hazel's Australian script: what it is, and why it is not switched on

Written by WP-19. For the owner. Nothing described here is live.

## 1. In short

- There is now a second script for Hazel (the AI voice caller on Retell), written
  for a GP who **already works in Australia** and holds fellowship (segment A).
  It is the file `config/retell/hazel-prompt-au.md`.
- It is a **draft on paper only**. It has not been loaded into Retell, no code
  reads it, and Hazel cannot ring an Australian lead with it or with anything
  else. No Retell setting was read or changed to produce it.
- It stays that way until you have legal advice on AI phone calls to Australian
  numbers (owner decision 7, finding COM-34). Section 4 lists the questions to
  put to a lawyer.
- One thing to know now, before any of that: see the note in section 3 about
  `RETELL_FROM_NUMBER_AU` (it now matters for New Zealand leads only).

## 2. What the script does

It keeps the shape and manner of the existing script (short turns, one question
at a time, no filler, the same five tools) and changes the conversation:

- **The angle.** A confidential chat about a practice that fits better: billing
  model, area, sessions and flexibility, notice period, restraint clauses.
  Nothing about moving country, registration pathways or sponsorship. A test
  (`tests/au-wp19-hazel-au-script.test.js`) fails if any of the words an
  Australian doctor must never hear appears anywhere in the file.
- **Confidentiality first.** Hazel says nothing about why she is calling until
  the doctor has confirmed who they are and that they can talk privately. She
  never leaves a voicemail or a message with someone else, never contacts the
  current practice, and checks the email is a personal one before anything is
  sent to it.
- **Honest about being an AI, and about recording.** Unlike the existing script
  (which says she is an AI only when asked), the Australian draft has her say so
  in her first line, together with the fact that the call is recorded. This is
  the cautious choice while the legal position is unknown; the lawyer may say it
  can be relaxed or must be worded differently.
- **No numbers about pay.** She may talk about the billing model in words (bulk,
  mixed, private). She never says a dollar figure, a share or a range. The
  consultant covers figures on the call (owner decision 9).
- **Questions for the consultant.** Registered with Ahpra? Fellowship (FRACGP or
  FACRRM)? Any conditions, undertakings or notations? Does the 19AB moratorium
  apply (yes / no / not sure, asked neutrally)? Work rights? State and area?
  Notice period? What they want to change?
- **Doctors who are not segment A.** If the answers show limited or provisional
  registration, a registrar or non-fellow, a condition on registration, 19AB
  applying or "not sure", or work rights tied to an employer, Hazel does not
  book, does not advise and does not say whether GP Link can help. She says a
  consultant will be in touch and records exactly what the doctor said. "Not
  sure" is treated the same way as "yes" (the build's fail-closed rule).
- **No advice, no promises.** No medical, legal, contract, tax, registration or
  immigration advice; no promise of a role, area, income or date.

## 3. Why it cannot be dialled today

Checked by reading the code on branch `au-gp-testing` (WP-01's work):

| Guard | Where | What it does |
| --- | --- | --- |
| `auHazelBlocked(lead)` | `lib/au-lead.js` | Answers "is this an Australian lead Hazel must not ring?" |
| `leadCallDecision` | `lib/lead-calls.js` | Calls `auHazelBlocked` before anything else and returns skip reason `au_segment`. Covers the regular schedule, call-backs and the call owed after a missed consultation. |
| `placeLeadCall` | `server.js` | Last line of defence: refuses to dial an Australian lead whatever path reached it. |
| `ceoLeadCallNow` | `server.js` | The Leads tab "Call now with Hazel" button answers "Hazel does not ring Australian GPs". |
| The script file itself | `config/retell/hazel-prompt-au.md` | Nothing reads it. `scripts/retell-setup.js` only ever loads `hazel-prompt.md`. The test proves no file in `scripts/`, `lib/` or `server.js` mentions the Australian file. |

**These guards no longer depend on the Australian switch (changed by WP-04).**
When this note was first written all three code guards sat behind
`AU_PATHWAY_ENABLED` (`lib/au-pathway-flag.js`), which is off in production, so
the only thing stopping Hazel ringing an Australian lead with the existing
script for doctors moving country was that no Australian outbound number was
configured. WP-04 removed the switch from the Hazel block: `auHazelBlocked`,
`leadCallDecision`, `placeLeadCall` and `ceoLeadCallNow` now refuse an
Australian-segment lead **whether the switch is on or off**, with the reason
`au_segment`. That includes a lead with no country on file whose row or number
would be dialled as Australian. Tests pin the refusal in both switch states
(`tests/au-wp01-lead-hold-lib.test.js`, `tests/au-wp01-lead-hold-endpoints.test.js`,
`tests/lead-calls-lib.test.js`, `tests/ceo-leads-endpoint.test.js`). This is the
one deliberate exception to "switch off behaves exactly like today"; it is
recorded in `CONVENTIONS.md` section 2.

**About `RETELL_FROM_NUMBER_AU`.** The same number is used for New Zealand
leads, and New Zealand leads are **not** blocked: they are doctors moving
country, which is what the existing script is for. So setting that variable in
Vercel would make New Zealand leads diallable (from an Australian number, with
the existing script) and would still not make Australian leads diallable. I did
not read the production settings, so I cannot tell you whether the variable is
set; the handover of 30 October describes it as "AU later". Setting it is still
your decision, for the New Zealand reason alone.

What still depends on the switch: the hold on automated **emails and
WhatsApps** to an Australian lead (`auMessagesHeld`). With the switch off those
go out as they do today, until WP-16 writes Australian copy.

## 4. The open legal question (COM-34): what to ask a lawyer

Nobody on this build has checked the law. The points below are **questions, not
answers**. Where something is described as "we understand", it is working
knowledge that a lawyer needs to confirm.

**About the call itself**

1. Is a call from GP Link to a doctor who filled in an enquiry form a
   "telemarketing call" under the Do Not Call Register Act 2006? If so, does the
   doctor's enquiry count as consent to be called, for how long after the
   enquiry does that consent last, and does it cover a second or third attempt?
2. Does it matter that the caller is an AI voice rather than a person? Are there
   separate rules for automated, synthetic or recorded-voice calls?
3. Do we need to check ("wash") numbers against the Do Not Call Register before
   calling a doctor who enquired? What about old leads who enquired months ago
   (the past-leads campaign)?
4. We understand there is an industry standard for telemarketing and research
   calls that sets permitted calling days and hours and what a caller must say
   about who they are. Does it apply to these calls? If so, what hours and days
   does it allow (including public holidays, which differ by state), what must
   Hazel say and when, and what caller ID must be shown?
5. What wording should the enquiry form carry so that consent to an AI phone
   call is clear? Should the form say the call may come from an AI assistant and
   may be recorded?
6. When a doctor says "stop calling", what must we do, how quickly, and for how
   long must it be honoured? (Today a do-not-call request stops all further
   calls to that lead permanently.)

**About messages**

7. We understand the Spam Act 2003 is about commercial electronic messages
   (email, SMS and similar), not voice calls. Is that right, and if so does it
   apply to the email and WhatsApp that follow a call (the booking confirmation,
   the booking link, reminders)? What consent and unsubscribe wording do those
   need for an Australian recipient?

**About recording**

8. Every Hazel call is recorded and transcribed, and stored by Retell. The rules
   on recording a phone call differ between states and territories, and there is
   also Commonwealth law on intercepting calls. For a call from our system to a
   doctor in each state and territory: is telling the doctor at the start
   enough, or do we need their express agreement? Does it matter which state the
   doctor is in, and we do not always know that before the call?
9. If a doctor says they do not want to be recorded, the draft script ends the
   call and has a consultant contact them instead, because Hazel cannot switch
   recording off mid-call. Is ending the call sufficient, and must the partial
   recording be deleted?
10. Recordings, transcripts and the notes Hazel takes (registration status,
    conditions on registration, work rights, the fact that the doctor is looking
    for a new job) are personal information held by an overseas provider. What
    does the Privacy Act require: what must the privacy policy and the form say,
    how long may recordings be kept, and what applies to sending this
    information outside Australia?

**About the AI and what it says**

11. Is there any requirement to tell the person they are speaking to an AI? Is
    the draft's first-line disclosure adequate, more than is needed, or wrongly
    worded?
12. Hazel is told never to give legal, contract or immigration advice, and never
    to say whether a restraint clause is enforceable. Is there any risk in her
    asking about restraint clauses, notice periods, registration conditions or
    work rights at all?
13. The script says "we never contact your current practice" and "your details
    go to a practice only after you have agreed". Are those promises the
    business can keep in every case, and should they be in the written terms?

## 5. Proposed calling hours by state (a proposal; none of it is built)

Today the code gives every Australian lead Sydney time
(`lib/interview-meetings.js`, `gpTzForCountry`), and the calling hours in
`lib/lead-calls.js` were tuned for doctors in the UK (weekdays 9:00 to 19:30,
plus weekends). The lead record does not hold the doctor's state (finding
WEB-02 / WEB-03).

Proposal for Australian calls, subject to the lawyer's answer to question 4:
**weekdays only, 09:00 to 19:00 in the doctor's own local time, no weekends, no
public holidays.**

| State / territory | Time zone name | Daylight saving? |
| --- | --- | --- |
| NSW, ACT | Australia/Sydney | Yes |
| VIC | Australia/Melbourne | Yes |
| TAS | Australia/Hobart | Yes |
| SA | Australia/Adelaide | Yes (half an hour behind the east coast all year) |
| QLD | Australia/Brisbane | No |
| NT | Australia/Darwin | No (half an hour behind QLD all year) |
| WA | Australia/Perth | No |

- Daylight saving runs from early October to early April in the states that
  have it. Using the time zone names above means the code follows it
  automatically; never store a fixed offset.
- Practical effect: in summer, 09:00 in Perth is midday in Sydney, so one
  national window is not possible. Each lead needs its own state.
- A mobile number does not reveal the state. If the state is unknown, the safe
  rule is to ring only when it is inside the window in **every** Australian time
  zone at once (in summer that is roughly midday to 19:00 Sydney time), or not
  to ring until the state is known.
- Confidentiality cuts across this: most of 09:00 to 19:00 on a weekday is
  clinic time, when the doctor may not be alone. The script handles that by
  asking for a private moment and taking a call-back time. Early evening is
  likely to work best; that is a guess, not data.
- Public holidays differ by state and are not held anywhere in the code.
- A few places do not follow their state's time (for example Broken Hill). Not
  handled; would be an accepted gap.

## 6. What the script expects from the system

**Uses only values that exist today** (built per call by
`buildLeadCallVariables` in `lib/lead-calls.js`): `agent_name`, `full_name`,
`first_name`, `enquiry_when`, `enquiry_source`, `enquiry_question`,
`email_on_file`, `local_time_now`, `director_name`, `missed_call_note`. The test
checks that the script uses no other placeholder.

**Things it needs that do not exist yet:**

| Needed | Why | Status |
| --- | --- | --- |
| Outcome `needs_consultant` on the `mark_outcome` tool | For "a consultant will contact you" (not segment A, declined recording, asked for a person, no private contact). The existing choices would either make Hazel ring back (`callback_requested`) or close the lead (`not_interested`). It also needs to alert the owner or consultant and show on the Leads tab. | Does not exist. `config/retell/tools.json`, the server's outcome list and the Leads tab would all need it. |
| Correct `local_time_now` for the doctor's state | Today every Australian lead is given Sydney time, so Hazel would tell a Perth doctor the wrong time and offer diary times labelled wrongly. | Does not exist (WEB-03). |
| The doctor's state on the lead | Calling hours and "your time". | Does not exist (WEB-02). |
| Voicemail set to "hang up, say nothing" | The voicemail message is an agent setting in Retell, not part of the script. The current one says "you'd enquired with us about GP work in Australia", which would reveal a job search on a shared phone. | Would be set on the Australian agent only. |
| No automatic WhatsApp after a missed call | The dialler can send the booking link by WhatsApp after a voicemail or no answer (`textAfterMissedCall`). For an Australian doctor that message must not go, or must be worded so it reveals nothing. | Not handled for Australian leads. |
| Australian wording for the booking confirmation, booking link and reminders | The emails and WhatsApps the tools trigger are still written for doctors moving country and are currently held back for Australian leads (`auMessagesHeld` in `lib/au-lead.js`). | WP-16 / WP-18. |
| `missed_call_note` | Reused as is; its wording is neutral. The call after a missed consultation is itself blocked for Australian leads today. | Exists. |

Nice to have later, not required by the draft: the segment and the answers the
doctor already gave on the form (registered, fellowship, 19AB, work rights), so
Hazel does not ask twice.

## 7. What switching it on would involve

**NOT DONE. OWNER DECISION REQUIRED.** None of these steps has been started,
and none should be until the lawyer has answered section 4.

1. **Legal advice in writing** on section 4. Change the script, the form wording
   and the calling hours to match it.
2. **Decide the consent wording** on the Australian enquiry form and ship it
   first, so only doctors who enquired after that date are ever called.
3. **Build the missing pieces** in section 6: the doctor's state and time zone
   on the lead, Australian calling hours, the `needs_consultant` outcome and its
   alert, and Australian wording for every message a call can trigger.
4. **Choose how Hazel gets the Australian script.** Either (a) a second Retell
   agent with its own prompt, voicemail setting and number, chosen by the code
   per lead; or (b) one agent whose prompt is chosen per call. A second agent is
   the safer of the two: the existing agent, which is ringing leads every day,
   is never touched, and an Australian doctor can never be given the other
   script by a prompt mix-up.
5. **Before changing anything in Retell, compare the repo with the live agent.**
   The live agent's model and settings may differ from `config/retell/agent.json`.
   Publishing overwrites any unpublished draft held in Retell, and a published
   prompt cannot be edited afterwards (this cost three draft lines on
   10 November; see the no-show handover, section 4). `scripts/retell-setup.js`
   must not be run for this without that comparison, and it would need changing
   first, because it only knows the one prompt file.
6. **Remove the banner block** at the top of `hazel-prompt-au.md` when loading
   it (everything down to "PROMPT STARTS BELOW"), and update the test that pins
   the banner.
7. **Australian outbound number.** Buy or port a +61 number, complete the
   carrier's identity checks, connect it to Retell. Remember the existing code
   uses the same number for New Zealand leads; decide whether that is wanted
   before `RETELL_FROM_NUMBER_AU` is set (see the warning in section 3).
8. **Remove the block deliberately.** `auHazelBlocked` in `lib/au-lead.js` is
   marked permanent. Enabling Australian calls means changing it on purpose (to
   allow only confirmed segment A leads who enquired after the consent wording
   went live), together with the matching guards in `placeLeadCall` and
   `ceoLeadCallNow` in `server.js`, and the tests that pin them
   (`tests/au-wp01-lead-hold-lib.test.js`, `tests/au-wp01-lead-hold-endpoints.test.js`).
9. **Test calls to your own mobile only** (`LEAD_CALLS_TEST_NUMBERS`), listening
   for: the private-moment check, the AI and recording line, no voicemail left,
   no pay figures, the hand-off for a doctor who is not segment A, and "stop
   calling" ending the call at once.
10. **Soft launch** with a handful of real leads, every call listened to, before
    the test list is removed.
