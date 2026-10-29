# Hazel: efficiency, objection handling, learning and cost (29 October 2026)

## 1. Summary

- New script (agent version 44): no qualifying questions at all. Every lead told us on the form they are a GP, so Hazel treats them as one. The only check is a single casual aside inside the booking offer ("and you're all done with training now, or still finishing up?"), and only if it hasn't already come up.
- Objections are now handled by planning with the doctor (work back from their contract end or the kids' school year, bring the partner onto the call, pencil a movable slot) instead of rebutting and pushing for a time.
- The single biggest booking killer found in 300 simulated calls was Hazel refusing to answer ("I can't", "I won't guess", "the consultant goes through that") until the doctor gave up: 52 of 89 lost bookings. She now has straight answers, with ranges, for every question doctors actually pressed on.
- She learns three ways: a structured analysis of every call (11 fields), per-doctor memory across calls, and a daily routine that turns the day's calls into small script lessons, tests them on a fixed 20-call simulation suite, and publishes them only if the suite is not worse. Structural changes still wait for your APPLY.
- Cost: measured from the real bills, a call costs about $0.36 a minute on Opus. The knowledge base is off (it caused leaks and cost $0.005/min). Opus stays as the model: in the simulations it booked more and leaked less than Sonnet, and the $0.064/min saving is worth less than one extra booking per hundred calls.

## Results (simulated UK doctors, judged automatically)

| Script | Judge pass | Booked, of doctors who should book | Lost entirely (no booking, no link) |
|---|---|---|---|
| Previous long script v41, 300 calls | 27% | 51% (92 of 177) | not counted |
| v43 round 1, Opus, 50 calls | 34% | 47% (11 of 23) | 6 of 31 |
| v43 round 1, Sonnet, same 50 | 30% | 43% (10 of 23) | 10 of 31 |
| v43 round 2 (straight answers added), Opus, same 50 | 36% | 52% (12 of 23) | 3 of 31 |
| v43 final, fixed 20-call regression suite | 55% (11 of 20) | 50% (5 of 10) | 2 of 14 |

How to read this: "judge pass" is strict (one "fair enough" fails a call), and the simulated doctors are deliberately harder than average (sceptical, analytical, pressing for figures). Samples are small, so differences under ten points are noise. The clear movements: "I can't" fell from 70 to 39 across the same 50 calls and "I won't guess" from 8 to 1; doctors lost entirely fell from 6 to 3; rule breaks per call roughly halved against the previous script while bookings held or improved. Doctors who said they would rather pick a time from a link got it in 7 of 8 cases.

What is live now: agent version 44 (Opus, new script, knowledge base off, new settings). Version 40 is one click away in the Retell dashboard if you want to roll back.

## 2. What 300 simulated calls on the previous script found

Simulated UK GPs (varied qualification, personality, objection and diary preference) were played by another model; a judge graded each call; I read the failures.

Lost bookings, 89 of 182 bookable doctors:

| Cause | Calls |
|---|---|
| Refused to answer anything not spelled out, then had nothing left but "shall I book?" (fees, earnings, Khaleed's background, city, English test, visa, part time) | 52 |
| Volunteered "he's not a doctor" about Khaleed, then could not answer the follow-up | 5 (inside the 52) |
| Partner objection: accepted "I'll talk to my wife first" and sent a link instead of pencilling a movable slot | 8 |
| Doctor busy, asked for a callback (no pitch possible) | 8 |
| Treated "maybe in a year or two" as a callback request instead of a timing concern | 5 |
| Refused 1 to 3 month trainees who should have been booked | 3 |
| Read out "the number we have on file", doctor felt spied on | 3 |

Unhuman patterns: the same opener sentence verbatim in 155 calls, "is now an okay time" verbatim in 158, "I can't" opening 117 turns, "I won't guess" 122 times, "fair question" and its cousins 62 times, "co-founder" (banned) 111 times.

## 3. What the new script does differently

Rules (in priority order): spoken-only, no rules or records out loud; never ask if they are a GP; two short sentences a turn; engage with what they said before any question; one question a turn and never twice; never rate their question ("fair enough", "good question"); straight answers with ranges, and never "I can't".

Flow: opener, one hook question, one follow-up, then the booking move by about the fourth or fifth turn. Diary look-up, two times offered as a squeeze-in with Khaleed, email read-back, booking, Zoom link by email and WhatsApp. If nothing suits or they would rather pick themselves, the self-service link.

Concerns, planned with the doctor:
- Timing: ask what the date hinges on, then work back. Six months from first chat to seeing patients, the first two or three of which are just finding the practice, so starting now lands them when they want to go. Contract ending in summer: paperwork now, registration lands as it ends. Kids: aim for the Australian school year in late January or a term break.
- Partner: bring them onto the call; pencil a movable slot with them on it; if they still want to talk first, the link, no second ask.
- Money: seventy percent share, guaranteed minimum income, no figure on the call, the consultant shows actual contracts for their area. Said once.
- Costs: practice pays sponsorship, agent fee typically a few thousand dollars and often covered in part or full by the practice, relocation package, all in the contract before signing. GP Link's fee is paid by the practice, never from the doctor's pay.
- "What's in it for you": only paid when the doctor accepts and starts, the doctor chooses the practice, no exclusivity.
- Remote, CBD only, part time, English test, pre-2007 MRCGP, other agency, scam, in writing, process, elderly parents, undecided country: one line each, then the call.

Callbacks become bookings: when a doctor says "ring me back this evening", she offers to put the free half-hour itself in the diary for that evening instead.

Trainees: within three months ("about three months" counts) are booked like any GP. Further out: no diary, no link, app sign-up and a call a month before they finish, with the exact spoken wording.

Khaleed: named only once times are offered ("squeeze you in with Khaleed, our director"). If asked, "he heads up the team and has taken plenty of UK GPs through this exact route". Never "co-founder", never "fully booked".

## 4. How Hazel learns

1. Every call: Retell's post-call analysis now fills 11 fields: outcome, callback time, GP status, training finish date, timeframe, objections raised, whether the main objection was handled, the reason a booking was lost, questions she could not answer, her own slips, and notes for the consultant. This costs about two cents a call and is what the daily review reads.
2. Every doctor: contact memory is on, so if a doctor is called back, Hazel remembers the earlier conversation.
3. Every day (9pm UK, 5am your time): the routine reads every call, finds lost bookings and rule breaks, writes at most three lessons into a section at the end of her script called "Learned from calls" (how to respond, never new facts or figures), creates a draft, runs the fixed 20-call regression suite on it (about ten dollars), and publishes only if the pass count and the booking count are not worse than the live version. Otherwise it discards the draft and sends the lessons to you as proposals. Questions doctors asked that Hazel could not answer come to you in the email so you can supply the fact; anything structural comes as "Replace / With / Because" for your APPLY.

What it will never do on its own: add facts, figures, names or promises; change tools, voice, model or settings; publish a version that scored worse; run the suite on a day with nothing to learn. Pause it any time at https://claude.ai/code/routines/trig_01Md5qtVSSnSCubWbL3Aur2q. Roll back any version from the Retell dashboard.

## 5. Cost

Measured from the bill of a real 3-minute test call on Opus:

| Item | Per minute | Note |
|---|---|---|
| Claude Opus 5.5 | $0.128 | Sonnet would be $0.064 |
| ElevenLabs voice (v4 turbo) | $0.080 | Your Zee clone |
| LLM token surcharge | $0.06 to $0.15 | Not flat: it is the LLM cost multiplied by (average request tokens divided by 4,000, minus 1). Verified to the cent on two bills. With the full script the first request is already about 8,000 tokens and the average over a 5-minute call is about 8,500, so the LLM line effectively doubles: Opus $0.128 becomes about $0.27 a minute. On your 29 October test (5 min 26 s) the surcharge was $0.149 a minute, more than Opus itself. |
| Retell voice engine | $0.055 | Fixed |
| Background voice cancellation | $0.005 | Keep |
| Knowledge base | $0.005 | Now off |
| Haiku backup model | $0.003 | Keep (fallback if Opus is down) |
| Post-call analysis | $0.021 per call | Keep, it feeds the learning loop |
| Total | about $0.42 per minute with the full script on Opus | your 29 October test call cost $2.31 for 5 min 26 s |

Levers, in order of value:
- Shorter calls. The new script reaches the booking offer by turn four or five; every minute saved is about $0.42. Target under four minutes for a booked call.
- Sonnet instead of Opus. Because the surcharge multiplies the LLM price, the real gap is larger than the headline: with the full script Opus costs about $0.27 a minute for the LLM line and Sonnet about $0.14, so Sonnet saves about $0.14 a minute, roughly a third of the whole call (about $0.70 on a 5-minute call). In the simulations Sonnet booked 43% against Opus 47% and lost doctors entirely in 10 calls against 6, within noise on 50 calls. Opus stays for now because that is your call; if you want Sonnet, say so and I will switch it and run the 20-call suite on it.
- Shorter script. Every 1,000 tokens trimmed from the script saves about 12% of the LLM line. The script is about 4,300 tokens; a careful edit could take 800 to 1,000 out without losing an answer. Worth doing once the wording has settled.
- Knowledge base off: saves $0.005/min and removes the "knowledge base dump" leak. Facts live in the script.
- Simulation spend: $0.50 per simulated call. The daily routine only spends on days with a change (about $10). Avoid 1,000-call runs; 50 targeted calls per change is plenty.
- Telephony is extra when live: UK mobile numbers via Retell or Twilio are about $0.015 to $0.03 a minute outbound.

## 6. Agent settings changed on the draft

- Office ambience ("call-center" at 30% volume): a constant quiet background that masks the sentence-to-sentence noise changes you heard. Say the word and I will switch it off.
- Do-not-call detection: if a doctor says stop calling, Retell confirms once and marks the number.
- Backchannel words: "yeah, mm-hmm, right, okay, sure" while the doctor talks.
- Pronunciation: AHPRA as "AH-pra", Khaleed as "kah-LEED" (tell me if that is wrong).
- Silence reminder after 12 seconds, once.
- Tool descriptions shortened (fewer tokens per request).

## 7. What still needs you

1. Test the latest version in the Retell dashboard (it runs the newest version automatically) and tell me what you hear.
2. Confirm three facts I put in her mouth: the visa is the Skills in Demand visa (subclass 482) and usually takes a couple of months for doctors; school fees for temporary-visa families are typically a few thousand dollars a year per child in the states that charge; the consultants are placement and registration specialists rather than GPs.
3. Doctors who want a written answer before booking: Hazel now says the question goes in the notes so the consultant answers it first. If you are willing to reply by email to those questions (the daily report lists them), tell me and I will let her promise that; in the simulations it would have saved several bookings.
4. Go-live prerequisites unchanged: Twilio UK and AU numbers and SIP trunk, LEAD_CALLS_DIRECTOR_NAME and LEAD_CALLS_ENABLED on Vercel, and the app change for long trainee callbacks.
5. Optional: a read-only Retell API key for the routine's reading steps (it needs the full key for the publish step).
