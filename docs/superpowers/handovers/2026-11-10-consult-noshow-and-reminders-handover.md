# Consultation no-shows, reminders and the review's counting (10 Nov 2026)

Live on `main` as of `61bd497e` (deployed and confirmed through `GET /api/health`).
Full suite: 7,550 of 7,551 pass. The one failure, `tests/server-observability.test.js`
"covers every vercel.json cron", is not from this work: `zoho-reengage` and
`zoho-whatsapp-auto` are in `vercel.json` but not in the cron health registry.

## 1. Why this was built

The owner asked why consultations no-show and whether the reminders have gaps. Of 59
real consultations with a known outcome, 35 were attended and 24 were not. Reminders
were going out (day-before and 5 minutes before, by WhatsApp), so they were not the
cause. The gaps were:

- After a no-show nothing reached a funnel lead. `handleScheduledCallFailure` reads the
  email and phone from `user_profiles` by `call.user_id`, and a lead has no account.
- A doctor who replied to a reminder asking to move the call was not acted on.
- Nothing went out between the day before and 5 minutes before.
- Weekday slots from 12:00 UK showed 33% (6 of 18); weekend mornings 87% (13 of 15).
- The Ads hub review and the Overview counted Hazel's calls and attendance wrongly.

## 2. What is live

| Area | Where | Behaviour |
|---|---|---|
| No-show rescue | `lib/consult-noshow.js`, `recordConsultNoShowForCall`, `maybeRunConsultNoShowRescue` (consult-nudge cron) | A missed slot writes `consult.no_show = { call_at, detected_at, via, ring, email_at, wa_at }` on the lead. Email and WhatsApp go once, 60 minutes after the slot. Hazel rings once, 2 hours after, inside calling hours. |
| One-hour reminder | `lib/consult-reminders.js`, `lib/consult-whatsapp.js`, `runConsultCallReminders` | WhatsApp `call_hour_before` between 70 and 30 minutes before the call, marker `h1`. |
| Email reminders | same | Day-before and one-hour emails to `invitee_email`, markers `email_h24` and `email_h1`, independent of WhatsApp. |
| Lead's own time zone | same | Every time shown to the doctor is in their zone with a label ("UK time", "Irish time", "New Zealand time", "Sydney time"). |
| Reply paging | `handleConsultReminderReply`, hooked in `handleDoubleTickWebhook` | A WhatsApp from someone with a call in the next 48 hours, one that started in the past 2 hours, or one missed in the past 24 hours pages the owner (WhatsApp `gp_link_owner_lead_alert` plus email). Plain thank-yous before the call do not page; at most one page per person per 10 minutes. "I'll be there" stamps `confirmed_at`. |
| Hazel's slots | `pickSlots` in `lib/lead-calls.js` | Weekday slots from 12:00 in the doctor's time are held back unless they ask for an afternoon or nothing else is free. `LEAD_CALLS_AVOID_WEEKDAY_AFTERNOONS=false` switches it off. |
| Review counting | `lib/ads-context.js`, `adsReadAllRows` in `server.js` | Reads are paged (the call log passed PostgREST's 1,000-row cap on 8 Nov). Attended and no-show come from `consult.call_attended` and the sweep's fingerprint. The funnel gains `upcoming` and `unverified`. Internal test leads are left out. |
| Overview counting | `lib/ceo-overview.js` | "Held" and "missed" use the same truth; the three growing reads are paged. |

## 3. Decisions, so nobody "fixes" them back

- **Never backfill.** `CONSULT_NOSHOW_RESCUE_SINCE_MS` is 2026-11-11T00:00:00Z. Slots before
  it get no rescue. Do not lower it: 24 old no-shows would be messaged at once.
- **The missed-call ring is consumed on placement**, like `call_back_at`, so a bad number
  cannot loop. It waives age, attempts and spacing, never consent, pause or calling hours.
- **Hazel is given a fact, not lines.** `{{missed_call_note}}` at the end of the prompt's
  first paragraph says the doctor had a call booked and did not join. Owner rule: never
  write scripted lines for Hazel.
- **Rescue email is marketing category** (suppression list and unsubscribe apply). Reminder
  emails are transactional.
- **App users are skipped by the rescue**, because the existing re-invite already reaches them.

## 4. Outside the repo

- **WhatsApp templates** submitted through the DoubleTick API on 10 Nov:
  `gp_link_consult_call_1h` (quick replies "I'll be there" / "Need another time") and
  `gp_link_consult_missed_call`. Both fail soft until WhatsApp approves them; the emails
  go regardless. Check with `GET https://public.doubletick.io/templates`.
- **Retell:** agent version 61 was published with the prompt in `config/retell/hazel-prompt.md`
  (published prompt verified identical to the repo file). Do NOT run
  `scripts/retell-setup.js update` without diffing first: the live model is
  `claude-5.5-opus` and may differ from `config/retell/agent.json`.
- **Three draft-only prompt lines were dropped.** The unpublished draft (v61, based on v59)
  held three lines from the nightly routine that had never been published. Publishing the
  fact alone meant overwriting that draft, and Retell refused the edit that would have put
  them back ("Cannot update published LLM"). They were never live. Their text, for whoever
  owns that routine (position in the prompt was not recorded):
  - "If check_availability returns no match for the day or time asked, say so in one line and offer the nearest other day or time of day, or the booking link, in the same turn. Don't go quiet."
  - "If the doctor asks whether you are an AI, answer in one short sentence, then return to the last thing they said and offer the consultation time. Don't drop the booking."
  - "If a reply comes through garbled, ask again once at most; the second time, move on and offer the free half-hour consultation instead of repeating the same question."
- **DoubleTick's inbound webhook is still switched off** (since 8 Nov, on DoubleTick's side).
  Reply paging does nothing until the owner turns it back on in DoubleTick Settings > Webhooks.

## 5. Not verified

- No real no-show has gone through the rescue yet (the gate opens 11 Nov). The sweep-to-rescue
  chain is covered by unit and route tests, not against production.
- A quick-reply tap's payload shape is not pinned by a real fixture; the code matches the
  button title text.
- The word lists that decide "plain thank-you" versus "page the owner" are judgement, not
  drawn from reply history. When unsure the code pages.
- The website slot picker and Calendly still offer weekday afternoons. Only Hazel's offers changed.
