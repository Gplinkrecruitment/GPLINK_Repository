# Australian lead and consult messages: the copy deck

Written by WP-16. **Generated from the code** (`lib/au-lead-copy.js`, through the builders the server uses) by `tests/helpers/au-wp16-copy.js`; `tests/au-wp16-copy-snapshot.test.js` fails if this file and the code disagree. To change a word, change it in `lib/au-lead-copy.js` and regenerate (`WP16_WRITE_COPY=1 npx vitest run tests/au-wp16-copy-snapshot.test.js`).

**Who gets these.** Australian-segment leads only, and only with the Australian switch on. Every other lead, and every lead with the switch off, gets exactly the messages they get today.

**Two wordings.** "Main" goes to `au_vr` (vocationally registered, unrestricted) and `au_unknown` (Australian, detail not known yet), and is written to be true for any Ahpra-registered doctor. "Careful" goes to `au_restricted`, `au_non_vr` and `au_registrar`, which are built but not launched: it promises nothing about roles ("we'll talk through what fits your registration"). Where a message is only about being matched to roles, the careful group is not sent it at all.

**Rules every message keeps.** A confidential conversation about a better-fitting practice: billing mix, location, flexibility. No dollar figures, no percentages, no promise of a particular role or pay. The line "We never contact your current practice without asking you first." The regulator is written "Ahpra". Every email carries the unsubscribe link in its footer (the reminder emails are about a call the doctor booked and carry none, as today).

**Two send rules** (`docs/au-gp/CONVENTIONS.md` section 28):

- *Go-live.* A lead only enters a sequence if the event that starts it (they qualified, booked, attended, or missed a call) happened after Australian messages went live. Older leads get nothing automatic; the Leads tab marks them for a personal follow-up.
- *Quiet hours.* A message that goes out because time has passed is only sent between 08:00 and 20:00 on the doctor's own clock. Outside those hours it waits for the next run inside them. Reminders about a booked call and replies to something the doctor just did are not held.

**WhatsApp.** Five of these go by WhatsApp today, through existing templates whose approved wording was read and is neutral: the reminders an hour and five minutes before a call, the missed-call note, the after-the-call note and the set-up nudge. The others have no approved Australian template yet, so their WhatsApp is skipped (the reason is logged and shown on the Leads tab) and the email carries the message. What to submit is in `docs/au-gp/whatsapp-templates.md`; the drafts are also at the end of this file.

## The messages at a glance

| Message | Report ref | When | Channel | Main (`au_vr`, `au_unknown`) | Careful (`au_restricted`, `au_non_vr`, `au_registrar`) | Quiet hours | Go-live rule measured from |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Booking link (`booking_link`) | N01 | The moment an Australian-segment lead qualifies from a Meta lead form (the website form goes straight to the calendar, so it sends none). | email | sent | sent, careful wording | not held | not applied |
| Booking link (no personal link on file) (`booking_link_generic`) | N01 | Only when the booking-link tool is used for a lead with no personal link. That tool belongs to Hazel, who never rings an Australian-segment lead, so in practice this is not sent; the wording exists so the path can never fall back to the overseas email. | email | sent | sent, careful wording | not held | not applied |
| 5-minute note (`n01_5m`) | N01 | About 5 minutes after the lead qualifies, if they have not booked. (Not emailed when the booking-link email went in the last hour: two emails in five minutes would read as a glitch.) | WhatsApp when its template is approved; until then email | sent | sent, careful wording | held outside 08:00 to 20:00 | when they qualified |
| 1-hour note (`n01_1h`) | N01 | 1 hour after the lead qualifies, and never sooner than 40 minutes after the 5-minute note. | email (+ WhatsApp when its template is approved) | sent | sent, careful wording | held outside 08:00 to 20:00 | when they qualified |
| 24-hour note (`n01_24h`) | N01 | 24 hours after the lead qualifies, and never sooner than 12 hours after the 1-hour note. The last note before a booking. | email (+ WhatsApp when its template is approved) | sent | sent, careful wording | held outside 08:00 to 20:00 | when they qualified |
| Call booked (`n02_booked`) | N02 | Within 5 minutes of the lead booking a call. | email (+ WhatsApp confirmation when its template is approved) | sent | sent, careful wording | not held within 30 minutes of the event, then held | when they booked |
| Reminder, the day before (`n02_reminder_day`) | N02 | From 24 hours before the call (and at least 2 hours after the booking). | email (+ WhatsApp when its template is approved) | sent | sent, careful wording | not held | not applied |
| Reminder, an hour before (`n02_reminder_hour`) | N02 | Between 70 and 30 minutes before the call. | email (+ WhatsApp when its template is approved) | sent | sent, careful wording | not held | not applied |
| Missed call (`n02_noshow`) | N02 | 1 hour after a booked call the doctor did not join (not after 36 hours). | email (+ WhatsApp when its template is approved) | sent | sent, careful wording | held outside 08:00 to 20:00 | the slot they missed |
| After the call (`n03_after_call`) | N03 | The moment a call the doctor attended ends, if they have no account. | email (+ WhatsApp 10 minutes later when its template is approved) | sent | sent, careful wording | not held within 30 minutes of the event, then held | when the attended call ended |
| Week 1: how it works (`n03_week1`) | N03 | 7 days after an attended call, still no account. This REPLACES the overseas day-7 email ("AHPRA, AMC, visa, already solved"), which is never sent to an Australian-segment lead. | email | sent | **not sent** | held outside 08:00 to 20:00 | when the attended call ended |
| Week 2: how matching works (`n03_week2`) | N03 | 14 days after an attended call, still no account. | email | sent | **not sent** | held outside 08:00 to 20:00 | when the attended call ended |
| Week 3: last note (`n03_week3`) | N03 | 21 days after an attended call, still no account. The last message. | email | sent | **not sent** | held outside 08:00 to 20:00 | when the attended call ended |

In the examples below the doctor is "Dr Citizen" and the call is Thursday 14 January, 10:30 am (Perth time). The time is always given on the doctor's own clock and names the city.

## Booking link (`booking_link`, N01)

**When:** The moment an Australian-segment lead qualifies from a Meta lead form (the website form goes straight to the calendar, so it sends none).

### Main wording

**Subject:** Your GP Link call: pick a time that suits you

**Heading:** A confidential chat, when it suits you

> Hi Dr Citizen,
>
> Thanks for getting in touch with GP Link. The next step is a free 30-minute call with me. It is a confidential conversation about what you would want from your next practice: billing mix, location, hours and flexibility.
>
> We never contact your current practice without asking you first.
>
> Your details are already saved, so booking takes about 20 seconds. Just pick a time that suits you.
>
> Khaleed
> CEO, GP Link
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** Your GP Link call: pick a time that suits you

**Heading:** A confidential chat, when it suits you

> Hi Dr Citizen,
>
> Thanks for getting in touch with GP Link. The next step is a free 30-minute call with me. It is a confidential conversation about where you are with your registration and what you are looking for, and we'll talk through what fits your registration.
>
> We never contact your current practice without asking you first.
>
> Your details are already saved, so booking takes about 20 seconds. Just pick a time that suits you.
>
> Khaleed
> CEO, GP Link
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## Booking link (no personal link on file) (`booking_link_generic`, N01)

**When:** Only when the booking-link tool is used for a lead with no personal link. That tool belongs to Hazel, who never rings an Australian-segment lead, so in practice this is not sent; the wording exists so the path can never fall back to the overseas email.

### Main wording

**Subject:** Your GP Link call: pick a time that suits you

**Heading:** A confidential chat, when it suits you

> Hi Dr Citizen,
>
> Thanks for getting in touch with GP Link. The next step is a free 30-minute call with me. It is a confidential conversation about what you would want from your next practice: billing mix, location, hours and flexibility.
>
> We never contact your current practice without asking you first.
>
> Booking takes about a minute. Just pick a time that suits you.
>
> Khaleed
> CEO, GP Link
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** Your GP Link call: pick a time that suits you

**Heading:** A confidential chat, when it suits you

> Hi Dr Citizen,
>
> Thanks for getting in touch with GP Link. The next step is a free 30-minute call with me. It is a confidential conversation about where you are with your registration and what you are looking for, and we'll talk through what fits your registration.
>
> We never contact your current practice without asking you first.
>
> Booking takes about a minute. Just pick a time that suits you.
>
> Khaleed
> CEO, GP Link
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## 5-minute note (`n01_5m`, N01)

**When:** About 5 minutes after the lead qualifies, if they have not booked. (Not emailed when the booking-link email went in the last hour: two emails in five minutes would read as a glitch.)

### Main wording

**Subject:** Thanks for getting in touch

**Heading:** Looking for a better-fitting practice?

> Hi Dr Citizen,
>
> Khaleed here from GP Link. Thank you for getting in touch.
>
> I help GPs who are registered in Australia find a practice that fits them better, whether that is the billing mix, the location or more flexibility in the week. I would rather have a proper conversation than send you a brochure, so if it is easier, pick a time that suits you below.
>
> It is confidential. We never contact your current practice without asking you first.
>
> One quick question so I can point you the right way: what is the one thing you would change about where you work now?
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** Thanks for getting in touch

**Heading:** Thanks for reaching out

> Hi Dr Citizen,
>
> Khaleed here from GP Link. Thank you for getting in touch.
>
> I would like to understand where you are with your registration and what you are looking for, and we'll talk through what fits your registration. I would rather have a proper conversation than send you a brochure, so if it is easier, pick a time that suits you below.
>
> It is confidential. We never contact your current practice without asking you first.
>
> One quick question so I can point you the right way: what are you hoping to do next?
>
> Pick a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## 1-hour note (`n01_1h`, N01)

**When:** 1 hour after the lead qualifies, and never sooner than 40 minutes after the 5-minute note.

### Main wording

**Subject:** A quick one from me at GP Link

**Heading:** No pressure at all

> Hi Dr Citizen,
>
> Khaleed again. I know a form is easy to fill in between patients, so no pressure at all.
>
> If it helps, just reply with the one thing you would most want from your next practice (billing mix, location, hours, the team) and I will answer it myself.
>
> Or, if you would rather talk it through in one go, grab a time below. Thirty minutes, free, confidential, no obligation.
>
> We never contact your current practice without asking you first.
>
> Book a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** A quick one from me at GP Link

**Heading:** No pressure at all

> Hi Dr Citizen,
>
> Khaleed again. I know a form is easy to fill in between patients, so no pressure at all.
>
> If it helps, just reply with where you are with your registration and what you are hoping for, and I will tell you honestly what we can help with.
>
> Or grab a time below and we'll talk through what fits your registration. Thirty minutes, free, confidential, no obligation.
>
> We never contact your current practice without asking you first.
>
> Book a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## 24-hour note (`n01_24h`, N01)

**When:** 24 hours after the lead qualifies, and never sooner than 12 hours after the 1-hour note. The last note before a booking.

### Main wording

**Subject:** Last note from me

**Heading:** Whenever the time is right

> Hi Dr Citizen,
>
> Last note from me, I promise.
>
> If a change of practice is a someday thing rather than a right-now thing, that is completely fine and I am happy to leave it here. If you do want to talk it through at some point, you can book straight in whenever suits you, and you are always welcome to just reply to this email.
>
> Either way, it stays between us. We never contact your current practice without asking you first.
>
> Khaleed
>
> Book a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** Last note from me

**Heading:** Whenever the time is right

> Hi Dr Citizen,
>
> Last note from me, I promise.
>
> If now is not the right time, that is completely fine and I am happy to leave it here. If you would like a conversation at some point, book in whenever suits you and we'll talk through what fits your registration. You are always welcome to just reply to this email.
>
> Either way, it stays between us. We never contact your current practice without asking you first.
>
> Khaleed
>
> Book a time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## Call booked (`n02_booked`, N02)

**When:** Within 5 minutes of the lead booking a call.

### Main wording

**Subject:** Your GP Link call is booked: Thursday 14 January, 10:30 am (Perth time)

> You are booked in, Dr Citizen.
>
> Thanks for booking a call with me for Thursday 14 January, 10:30 am (Perth time). I am looking forward to it.
>
> So you know what to expect: we will talk about what you want from your next practice, including billing mix (bulk, mixed or private), location, hours and flexibility. I will explain how the roles we work on tend to be set up and how matching works, and we will cover timing, including your notice period.
>
> It is a conversation, not a commitment. We never contact your current practice without asking you first.
>
> Where you are:
> 1. Booked: Done. Your call is in the diary.
> 2. Account (you are here): Two minutes. Your preferences and your Ahpra registration details in one place.
> 3. Matched: When a role fits what you told us and your registration, we show it to you. You choose which to look at.
> 4. Interview: You meet the practice. Your details go to a practice only when you say yes.
> 5. Start date: You agree a start date that works with your notice period.
>
> If you would like a head start, create your free GP Link account before we speak. Your preferences will be ready when we talk, and nothing in it is shared with a practice until you say so.
>
> If the time stops suiting you, just reply to this email and we will find another.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t0

### Careful wording

**Subject:** Your GP Link call is booked: Thursday 14 January, 10:30 am (Perth time)

> You are booked in, Dr Citizen.
>
> Thanks for booking a call with me for Thursday 14 January, 10:30 am (Perth time). I am looking forward to it.
>
> So you know what to expect: I would like to understand where you are with your registration and what you are looking for, and we'll talk through what fits your registration. I will be straight with you about what we can and cannot help with right now.
>
> It is a conversation, not a commitment. We never contact your current practice without asking you first.
>
> If you would like a head start, create your free GP Link account before we speak. It keeps your registration details in one place, and nothing in it is shared with a practice until you say so.
>
> If the time stops suiting you, just reply to this email and we will find another.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t0

## Reminder, the day before (`n02_reminder_day`, N02)

**When:** From 24 hours before the call (and at least 2 hours after the booking).

### Main wording

**Subject:** Your GP Link call: Thursday 14 January, 10:30 am (Perth time)

**Heading:** Looking forward to speaking with you

> Hi Dr Citizen,
>
> Just a quick reminder that your free 30-minute call with me is coming up on Thursday 14 January, 10:30 am (Perth time).
>
> The button below is your link to join when it is time. Bring whatever you would like to talk through: the kind of practice you want, billing mix, location, hours and timing. You will get straight answers.
>
> It is confidential. We never contact your current practice without asking you first.
>
> If the time no longer suits, just reply to this email and we will happily find another.
>
> Speak soon,
> Khaleed, CEO, GP Link
>
> Join the call: https://zoom.example/j/123456

### Careful wording

**Subject:** Your GP Link call: Thursday 14 January, 10:30 am (Perth time)

**Heading:** Looking forward to speaking with you

> Hi Dr Citizen,
>
> Just a quick reminder that your free 30-minute call with me is coming up on Thursday 14 January, 10:30 am (Perth time).
>
> The button below is your link to join when it is time. Bring your questions about your registration and what you are looking for, and we'll talk through what fits your registration.
>
> It is confidential. We never contact your current practice without asking you first.
>
> If the time no longer suits, just reply to this email and we will happily find another.
>
> Speak soon,
> Khaleed, CEO, GP Link
>
> Join the call: https://zoom.example/j/123456

## Reminder, an hour before (`n02_reminder_hour`, N02)

**When:** Between 70 and 30 minutes before the call.

### Main wording

**Subject:** Your GP Link call is in about an hour (10:30 am (Perth time))

**Heading:** We speak in about an hour

> Hi Dr Citizen,
>
> A quick reminder that your call with me is in about an hour, at 10:30 am (Perth time).
>
> The button below takes you straight into the call. It works on a phone or a laptop, and you can join a few minutes early if that suits.
>
> If clinic is running over or something has come up, that is completely fine. Just reply to this email if you need another time, and we will sort it out.
>
> Speak soon,
> Khaleed, CEO, GP Link
>
> Join the call: https://zoom.example/j/123456

### Careful wording

The same words as the main wording.

## Missed call (`n02_noshow`, N02)

**When:** 1 hour after a booked call the doctor did not join (not after 36 hours).

### Main wording

**Subject:** Sorry we missed each other

**Heading:** Shall we find another time?

> Hi Dr Citizen,
>
> I had our call in the diary for Thursday 14 January at 10:30 am (Perth time) and it looks like we missed each other. No problem at all, I know how quickly a clinic day can change.
>
> If you would still like to talk through what you want from your next practice, you can pick a new time below. It takes about 20 seconds.
>
> Or just reply to this email with a time that suits you and I will make it work.
>
> As always, it is confidential. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Pick a new time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

### Careful wording

**Subject:** Sorry we missed each other

**Heading:** Shall we find another time?

> Hi Dr Citizen,
>
> I had our call in the diary for Thursday 14 January at 10:30 am (Perth time) and it looks like we missed each other. No problem at all, I know how quickly a clinic day can change.
>
> If you would still like a conversation, pick a new time below and we'll talk through what fits your registration. It takes about 20 seconds.
>
> Or just reply to this email with a time that suits you and I will make it work.
>
> As always, it is confidential. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Pick a new time: https://app.mygplink.com.au/start?lead=EXAMPLE#book

## After the call (`n03_after_call`, N03)

**When:** The moment a call the doctor attended ends, if they have no account.

### Main wording

**Subject:** Good to speak with you, Dr Citizen: the next step

> Thanks for the conversation, Dr Citizen.
>
> The next step is your free GP Link account. It takes about two minutes.
>
> It is where you tell us what you want from your next practice (billing mix, location, hours, the kind of team), so that we only bring you roles worth your time.
>
> Where you are:
> 1. Booked: Done. We have spoken.
> 2. Account (you are here): Two minutes. Your preferences and your Ahpra registration details in one place.
> 3. Matched: When a role fits what you told us and your registration, we show it to you. You choose which to look at.
> 4. Interview: You meet the practice. Your details go to a practice only when you say yes.
> 5. Start date: You agree a start date that works with your notice period.
>
> Nothing in your account is shared with a practice until you say so. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t1

### Careful wording

**Subject:** Good to speak with you, Dr Citizen: the next step

> Thanks for the conversation, Dr Citizen.
>
> The next step is your free GP Link account. It takes about two minutes.
>
> It keeps your registration details and what you are looking for in one place, so we can follow up on what we discussed. From there we'll talk through what fits your registration.
>
> Nothing in your account is shared with a practice until you say so. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t1

## Week 1: how it works (`n03_week1`, N03)

**When:** 7 days after an attended call, still no account. This REPLACES the overseas day-7 email ("AHPRA, AMC, visa, already solved"), which is never sent to an Australian-segment lead.

### Main wording

**Subject:** What happens after you create your account

> Five steps, and the first is already done.
>
> Here is the whole path, Dr Citizen, so there are no surprises.
>
> The five steps:
> 1. Booked: Done. We have spoken.
> 2. Account (you are here): Two minutes. Your preferences and your Ahpra registration details in one place.
> 3. Matched: When a role fits what you told us and your registration, we show it to you. You choose which to look at.
> 4. Interview: You meet the practice. Your details go to a practice only when you say yes.
> 5. Start date: You agree a start date that works with your notice period.
>
> You stay in control at every step. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t2

### Careful wording

Not sent to this group (reason on the lead's record: `au_segment_not_launched`).

## Week 2: how matching works (`n03_week2`, N03)

**When:** 14 days after an attended call, still no account.

### Main wording

**Subject:** How we match GPs to practices

> We would rather send you nothing than waste your time.
>
> When we match a GP to a practice we look at the billing model (bulk, mixed or private), the location, the hours and the support around you. We only put a role in front of you when it fits what you told us and your registration.
>
> Some weeks that is a few roles. Some weeks it is none. Either way, you decide which ones are worth a conversation, and your details go to a practice only when you say yes.
>
> Your account is where you set those preferences. It takes about two minutes.
>
> We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Set my preferences: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t3

### Careful wording

Not sent to this group (reason on the lead's record: `au_segment_not_launched`).

## Week 3: last note (`n03_week3`, N03)

**When:** 21 days after an attended call, still no account. The last message.

### Main wording

**Subject:** Last note from me, Dr Citizen

> I will leave it here.
>
> This is my last note about setting up your account. If the timing is not right, that is completely fine.
>
> The button below stays open whenever you are ready, and you are always welcome to reply to this email if a question comes up.
>
> Either way, our conversation stays between us. We never contact your current practice without asking you first.
>
> Khaleed
> CEO, GP Link
>
> Create my free account: https://app.mygplink.com.au/pages/signin?signup=1&ref=nudge-t4

### Careful wording

Not sent to this group (reason on the lead's record: `au_segment_not_launched`).

## Drafted WhatsApp templates

Six need submitting (an owner action: `docs/au-gp/whatsapp-templates.md` has them ready to type in). Five do not: an existing approved template already carries that message, and the draft is kept here only in case its wording is preferred later.

| Key | Drafted name | Purpose | Body | Variables | Buttons | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `lead_hello_5m` | `gp_link_au_lead_hello` | N01, about 5 minutes after an Australian-segment lead qualifies. (MARKETING) | Hi {{1}}, Khaleed here from GP Link. Thanks for getting in touch.<br><br>I help GPs who are registered in Australia find a practice that fits them better: billing mix, location, flexibility. It is confidential. We never contact your current practice without asking you first.<br><br>What is the one thing you would change about where you work now? Or pick a time for a chat here: {{2}}<br><br>Khaleed, GP Link | `{{1}}` first name; `{{2}}` booking link | none | not submitted: owner action |
| `lead_check_in_1h` | `gp_link_au_lead_check_in` | N01, 1 hour after the lead qualifies. (MARKETING) | Hi {{1}}, Khaleed again. No pressure at all.<br><br>If it helps, reply with the one thing you would most want from your next practice and I will answer it myself. Or grab a time here, 30 minutes, free and confidential: {{2}}<br><br>Khaleed, GP Link | `{{1}}` first name; `{{2}}` booking link | none | not submitted: owner action |
| `lead_day_after_24h` | `gp_link_au_lead_last_note` | N01, 24 hours after the lead qualifies. The last note. (MARKETING) | Hi {{1}}, last note from me. If a change of practice is a someday thing, that is completely fine and I will leave it here.<br><br>If you would like to talk it through at some point, you can book whenever suits you: {{2}}<br><br>Either way it stays between us. We never contact your current practice without asking you first. | `{{1}}` first name; `{{2}}` booking link | none | not submitted: owner action |
| `lead_call_booked` | `gp_link_au_lead_call_booked` | N02, booking confirmation. (UTILITY) | Hi {{1}}, your GP Link call is booked for {{2}}. The link to join will arrive by email, and we will send it here before the call as well.<br><br>It is a confidential conversation. We never contact your current practice without asking you first. | `{{1}}` first name; `{{2}}` the time on their own clock, for example "Thursday 14 January, 10:30 am (Perth time)" | none | not submitted: owner action |
| `lead_call_reminder` | `gp_link_au_lead_call_reminder` | N02, the day before the call. (UTILITY) | Hi {{1}}, a reminder that your GP Link call is coming up on {{2}}.<br><br>Join here when it is time: {{3}}<br><br>If the time no longer suits, just reply and we will find another. | `{{1}}` first name; `{{2}}` the time on their own clock; `{{3}}` join link | none | not submitted: owner action |
| `lead_call_hour_before` | `gp_link_au_lead_call_1h` | N02, about an hour before the call. (UTILITY) | Hi {{1}}, your GP Link call is in about an hour, at {{2}}.<br><br>Join here: {{3}}<br><br>If clinic is running over, just let us know. | `{{1}}` first name; `{{2}}` the time on their own clock; `{{3}}` join link | Quick replies: "I'll be there", "Need another time" (the same two the existing one-hour template has: the app reads them) | not needed: the existing template `gp_link_consult_call_1h` carries it |
| `lead_call_starting` | `gp_link_au_lead_call_starting_5m` | N02, 5 minutes before the call. (UTILITY) | Hi {{1}}, your GP Link call starts in 5 minutes. Tap to join: {{2}}<br><br>Running a few minutes late is fine. | `{{1}}` first name; `{{2}}` join link | none | not needed: the existing template `gp_link_consult_call_starting_5m` carries it |
| `lead_call_missed` | `gp_link_au_lead_missed_call` | N02, an hour after a call the doctor did not join. (UTILITY) | Hi {{1}}, it looks like we missed each other today. No problem at all, I know how quickly a clinic day can change.<br><br>If you would still like to talk, pick a new time here: {{2}}<br><br>Or reply with a time that suits you and I will make it work. | `{{1}}` first name; `{{2}}` link to pick a new time | none | not needed: the existing template `gp_link_consult_missed_call` carries it |
| `lead_post_call_onboard` | `gp_link_au_lead_post_call` | N03, 10 minutes after a call the doctor attended, if they have no account. (MARKETING) | Thanks for the conversation today, {{1}}. The next step is your free GP Link account. It takes about two minutes and it is where you tell us what you want from your next practice: {{2}}<br><br>Nothing in it is shared with a practice until you say so. | `{{1}}` first name; `{{2}}` sign-up link | none | not needed: the existing template `gp_link_consult_post_call_onboard_v3` carries it |
| `lead_signed_up` | `gp_link_au_lead_signup_welcome` | When a lead creates their account. (WP-17 owns onboarding wording; proposed here so the skip has a name.) (MARKETING) | Welcome to GP Link, {{1}}. Your account is set up. A few short questions in the app tell us what you want from your next practice, and nothing is shared with a practice until you say so. | `{{1}}` first name | none | not submitted: owner action |
| `lead_onboarding_incomplete` | `gp_link_au_lead_onboarding_nudge` | A day after sign-up, if the short set-up questions are not finished. (WP-17 owns onboarding wording.) (UTILITY) | Hi {{1}}, your GP Link account is nearly ready. A couple of minutes in the app to finish your details and we can start looking at what fits. Reply here if anything is unclear. | `{{1}}` first name | none | not needed: the existing template `gp_link_consult_onboarding_nudge` carries it |
