# Connecting your Google Calendar — step-by-step walkthrough

**Why this matters.** Until this is done, the app books interviews without ever
looking at your diary, and without putting them in it. That means two things can
go wrong, both silently:

1. An interview can be offered to a doctor at a time you already have something on.
2. Calendly can book a consultation straight over an interview, because the
   interview was never written to the calendar Calendly checks.

## Status

Configured 2026-07-29. **An earlier version of this file claimed CONNECTED on
the strength of `ping ok: Yes` — that was wrong**, and the correction is the
most useful thing in this document. The freebusy call was returning HTTP 200
carrying a Google error in the body (`Google Calendar API has not been used in
project … or it is disabled`), and the code read the empty busy list as "the
diary is free". Everything looked green while clash protection was entirely
off. Do not treat a green card from before 2026-07-29 as evidence of anything.

The card now fails loudly on a lookup that did not genuinely resolve, and
echoes `calendar read:` so you can see which diary was opened. **Trust
`busy blocks next 24h` going non-zero against an event you can see** — that is
the only reading that proves the whole chain end to end.

**Leave the steps below in place.** They are the record of what was done, and
what to redo if the service account key is rotated, the Workspace delegation is
edited, the API is disabled, or the Vercel variables are lost.

**History:** the calendar had never been connected before this. A live
interview row in production was carrying `gcal_local_1` — the placeholder the
app wrote when it found no calendar configured. The feature had been fully
built for weeks; only the connection was missing, and nothing anywhere
reported that, which is why the Technical card now exists.

There are **four** parts. Do them in order — part 4 depends on part 2.

---

## Part 1 — Turn the Calendar API on (missed the first time; do this FIRST)

Enabling an API in the Cloud project is separate from granting the service
account permission. Drive was already on, so Drive worked and Calendar did not
— and because the failure arrives as a 200 with an error inside it, nothing
looked broken.

1. Go to
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
2. Check the project selector reads **sunlit-precinct-481010-j2**
   (project number **1059040771088**).
3. Click **Enable**.
4. Wait 2–3 minutes — Google takes a moment to propagate, and calls made in
   the meantime fail with the same "has not been used in project" message.

Symptom when this step is missing: `ping error: Google Calendar API has not
been used in project 1059040771088 before or it is disabled`.

---

## Part 2 — Google Workspace admin (give the app permission to read your calendar)

The app already has a Google "service account" that it uses for Google Drive. You
are giving that same account permission to see your calendar as well. Nothing new
is created.

The account is:

```
gplink-drive@sunlit-precinct-481010-j2.iam.gserviceaccount.com
```

**2.1 — Find the account's Client ID**

This is a long number, and it is *not* the email address above.

1. Go to <https://console.cloud.google.com/iam-admin/serviceaccounts>.
2. Make sure the project selected at the top is **sunlit-precinct-481010-j2**.
3. Click the service account named `gplink-drive`.
4. On the **Details** tab, copy the **Unique ID** — a long number, roughly 21 digits.

**2.2 — Grant it calendar access across your domain**

1. Go to <https://admin.google.com> (you must be signed in as a Workspace admin).
2. In the left menu: **Security** → **Access and data control** → **API controls**.
3. At the bottom, click **Manage domain-wide delegation**.
4. You should see an existing entry with the Client ID from step 2.1 — the Drive
   one. **Click it to edit rather than adding a second entry.**
   - If it is there: add the calendar scope to the existing comma-separated list.
   - If it is not there: click **Add new** and paste the Client ID.
5. In **OAuth scopes**, make sure this exact scope is present, alongside whatever
   Drive scopes are already listed:

```
https://www.googleapis.com/auth/calendar
```

6. Click **Authorise**.

> ⚠️ Keep the existing Drive scopes. If you replace the list instead of adding to
> it, Google Drive uploads will break.

**2.3 — Find your Calendar ID**

1. Open <https://calendar.google.com>.
2. Hover the calendar you actually live in under **My calendars** → click the
   three dots → **Settings and sharing**.
3. Scroll to **Integrate calendar** → copy the **Calendar ID**.

For a Workspace account this is almost always just your email address —
`hello@mygplink.com.au`. If you use a separate calendar for client work, use that
one's ID instead, and make sure it is the same calendar Calendly writes to
(part 4).

---

## Part 3 — Vercel settings (tell the app which calendar to use)

1. Go to <https://vercel.com> and open the GP Link project.
2. **Settings** → **Environment Variables**.
3. Add these two. Tick **Production** (and Preview, if offered):

| Name | Value |
|---|---|
| `GOOGLE_CALENDAR_ID` | the Calendar ID from step 2.3, e.g. `hello@mygplink.com.au` |
| `GOOGLE_CALENDAR_IMPERSONATE_EMAIL` | the Workspace account that owns it, e.g. `hello@mygplink.com.au` |

4. Click **Save**.
5. **Redeploy.** Environment variables only reach the app on a new deployment —
   saving alone changes nothing. Go to **Deployments**, open the most recent one,
   and choose **Redeploy**.

> The second variable is what lets the service account act *as you*. Without it
> the app authenticates as the robot account, which has no access to your
> personal diary, and every lookup comes back empty — which looks exactly like
> "you are always free".

---

## Part 4 — Calendly (so consultations and interviews see each other)

This is the half that stops a consultation landing on top of an interview.

**4.1 — Check for conflicts**

1. Sign in to Calendly.
2. **Account** → **Calendar connections**.
3. Connect your Google Calendar if it is not already connected.
4. Find **Check for conflicts** (sometimes "Check this calendar for existing
   events") and turn it **on** for the same calendar you used in step 2.3.

Now, when the app writes an interview into your calendar, Calendly treats that
time as taken and will not offer it for a consultation.

**4.2 — Add new events to that same calendar**

1. Still under **Calendar connections**, find **Add events to calendar**.
2. Confirm the calendar selected is the same one again.

Now every consultation Calendly books shows up in the calendar the app reads, so
interview slots are computed around them.

> Both settings must point at the **same** calendar as `GOOGLE_CALENDAR_ID`.
> Pointing them at different calendars is the most common way this ends up half
> working — each side thinks it is protected and neither is.

---

## What is already protected, even before you do any of this

As of 2026-07-29 the app also checks its **own** booked meetings — both
interviews *and* consultations — when working out which times to offer. So a
consultation booked through the app can no longer be double-booked with an
interview, with or without Google Calendar.

What that safety net cannot see is anything that lives **only** in your personal
diary: a dentist appointment, a school run, a meeting someone else invited you
to, or a consultation booked outside the app. That is what parts 1–4 fix.

Separately, the doctor and the practice already receive a proper calendar
invitation (`.ics`) attached to their booking confirmation email, so the
interview lands in *their* calendars regardless. Your diary was the gap.

---

## If the card still doesn't say "Connected"

The Technical card reports the reason. The usual causes, in order of likelihood:

| What it shows | What it means |
|---|---|
| `ping error: … API has not been used in project …` | Part 1 — the Calendar API is not enabled |
| `calendar_id_configured: false` | Part 3 not saved, or saved without a redeploy |
| `Degraded` + a `403` or `insufficient permission` ping error | Part 2.2 scope missing, or added to a different Client ID |
| `Degraded` + a `404` ping error | The Calendar ID is wrong, or that calendar isn't shared with the impersonated account |
| `impersonate_email_configured: false` | The second variable in part 3 is missing |
| `Connected`, `busy_blocks_next_24h: 0` | Only trustworthy if your diary really is empty — put a test event in the next 24h and confirm it becomes 1 |
