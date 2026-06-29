# Interview scheduling — owner setup guide

Plain-English setup guide. Once these steps are done, interviews work like consultations: a real Zoom call is created automatically, the AI writes a summary when the call ends, and neither a consultation nor an interview can be accidentally double-booked over the other.

---

## What this feature does

When you click **Book interview** on a candidate's application in the Jobs board, the app emails the medical practice to ask when they are free. The practice replies in plain English ("any evening Tuesday through Thursday"). The app's AI reads that reply, then works out every time window in the next two weeks where the GP (who is overseas — UK, Ireland, or New Zealand), the practice (Australia), and you (Sydney) are all free at the same time, with daylight saving handled correctly. The GP sees a short list of those times (shown in their local time) and picks one. The app then creates a Zoom meeting automatically and writes the interview into your Google Calendar — so Calendly cannot book a consultation over it. When the interview ends, Zoom's AI Companion writes the summary and saves it automatically, the same way your standard consultations already work. Your new Meetings tab shows all of your Zoom meetings (consultations and interviews) in one list, and each candidate's Applications section shows their pipeline stage, interview summary, and a space for the offer and contract (coming later).

---

## Setup Step 1 — Connect your Google Calendar (the main step)

Your Google Calendar is the single source of truth for your time. It works in both directions: when we work out interview slots, we read your calendar so we never offer a time that clashes with a consultation already in your diary. When an interview is booked, we write it into your calendar so Calendly sees that time as busy and cannot let a consultation be booked over it. You need to do three things:

**1a. In Calendly — tell it to check your Google Calendar for conflicts**

1. Sign in to Calendly.
2. Go to **Account** → **Calendar connections** (or **Integrations** → **Calendar**).
3. Connect your Google Calendar if it is not connected already.
4. Once connected, find the setting **"Check for conflicts"** (sometimes labelled "Check this calendar for existing events"). Turn it on for your main work calendar.

This means: if an interview is booked and written to your Google Calendar, Calendly will treat that time as taken and will not offer it to a GP for a consultation.

**1b. In Calendly — make sure new consultations are added to the same Google Calendar**

1. Still in Calendly → **Calendar connections**.
2. Under **"Add events to calendar"**, confirm the calendar selected is the same one you just set for conflict-checking — your main work Google Calendar.

This means: every consultation Calendly books is written to that calendar, so when we compute interview slots we see those consultations as busy time and never offer them.

**1c. In the hosting dashboard — add the two settings that give the app access**

This is the step you ask the technical team to do, the same way you set other settings like the Zoom credentials or the email address. In the Vercel hosting dashboard (where all the app's settings live), add these two settings:

- **`GOOGLE_CALENDAR_ID`** — your calendar's ID, which is usually just your Google Workspace email address (for example, `hello@mygplink.com.au`). If you are unsure, open Google Calendar in a browser, go to **Settings** → click your calendar under "My calendars" → scroll down to **"Calendar ID"** and copy it.
- **`GOOGLE_CALENDAR_IMPERSONATE_EMAIL`** — the Google Workspace email address that owns the calendar (the same account, for example `hello@mygplink.com.au`).

The app already has Google service-account credentials in the dashboard (`GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`) — these are the same ones used for Google Drive. For Calendar access to work, that service account needs to have **Google Calendar permission** as well. In your Google Workspace admin console, this is called domain-wide delegation and you need to ensure the scope `https://www.googleapis.com/auth/calendar` is included. If you are not sure this has been done, ask your technical team to check — it is a one-time addition to the same service account that already handles Drive.

> **What happens if this step is not done yet?** Interviews will still be created — the Zoom meeting is made, the booking is recorded, and the AI summary saves automatically — but the interview will NOT be written to your Google Calendar, which means Calendly could book a consultation over that same time slot. The two-way protection only switches on once `GOOGLE_CALENDAR_ID` is set. The app detects this and quietly skips the calendar step until it is configured.

---

## Setup Step 2 — Zoom

The app already uses Zoom via your Server-to-Server OAuth credentials to read meeting summaries. To create interview meetings it needs one additional permission and one account setting:

1. **Create-meeting permission.** In your Zoom Marketplace account, open the Server-to-Server OAuth app the team set up. In its **Scopes** section, confirm that `meeting:write` (or "Create a meeting") is listed. If it is not there, add it and save. This is a one-time change.

2. **AI Companion summaries must be turned on.** In your Zoom account settings (zoom.us → Settings → AI Companion), confirm that **"Meeting summary with AI Companion"** is enabled for your host account. This is already required for consultation summaries to save — if consultations are already producing summaries, this setting is already on and you do not need to change anything.

No new Calendly event type is needed. Interviews do not go through Calendly — the app handles the booking itself and uses your Google Calendar (see Step 1) to keep everything in sync.

---

## Setup Step 3 — Apply the database update

The new interview columns need to be added to the live database. This is a safe, additive change — nothing is removed or changed for consultations; it only adds new fields. Your technical team applies it using the normal process (running the migration via exec_sql with the service key):

**File to apply:** `supabase/migrations/20260630120000_interview_meetings.sql`

After applying, ask the team to reload the database schema. Until this is done, the interview features will produce an error in production because the new fields do not exist yet. This step does not affect any existing data or any currently working features.

---

## How it works day to day

Once the three setup steps above are done, here is what happens when you use the feature:

1. **You click "Book interview"** on a candidate's application in the Jobs board. A short confirmation appears ("Send Dr X's practice an availability request?"). You confirm.
2. **The practice gets an email** asking which evenings or weekends over the next two weeks suit an interview with that GP.
3. **The practice replies** in plain English. Their reply is read by the AI, which works out the windows they are available.
4. **The app computes interview slots** — times where the GP, the practice, and you (reading your Google Calendar) are all free, spread across the next two weeks, shown in each person's local time.
5. **The GP gets a notification** and opens the app to see a short list of available times (in their local time — UK, Irish, or New Zealand time as appropriate). They pick one.
6. **The app checks one more time** that the slot is still free against your live Google Calendar, then creates the Zoom meeting, writes the interview into your Google Calendar (blocking that time for Calendly), and sends calendar invites to you, the practice, and the GP — each showing the time in their own timezone.
7. **The interview happens.** When the Zoom call ends, Zoom's AI Companion writes the summary automatically and it is saved to the interview record.
8. **In your Meetings tab** you can see the interview listed alongside your consultations, with the summary once it is saved. The candidate's Applications section also shows the pipeline stage, the interview summary, and the offer/contract placeholder.

---

## Honest note — one piece requires a manual step for now

Detecting the practice's email reply automatically (without anyone pasting it in) would require the app to monitor the main registration inbox and identify which replies belong to which interview request. That auto-detection was deliberately not built in this release to avoid any risk to the registration email system, which handles all GP registration mail and must not be disrupted.

**What this means for you:** when the practice replies to the availability request, someone on the team uses the "ingest reply" action — this is a button or action in the admin panel (it calls the `/api/ats/interview/ingest-reply` endpoint) where you paste or forward the practice's reply text and link it to the application. The AI then reads it and generates the available slots.

Full automatic reply detection — where the system spots and processes the practice's reply with no manual step — is planned as a separately-tested follow-up, once it can be proven safe alongside the registration inbox.

---

## Known limitation — practice location and timezone

Interview slots are calculated based on each party's local time. For practices, the app currently defaults to **Sydney time (AEST/AEDT)** if the practice's specific state is not stored. This is correct for practices in New South Wales, Victoria, and the ACT.

If you are working with practices in **Western Australia** (Perth, 2–3 hours behind Sydney), **South Australia** (Adelaide, 30 minutes behind), or the **Northern Territory** (Darwin, 1.5 hours behind), their suggested interview windows could be off by that difference. The slots would still work — the practice's reply narrows the actual windows — but the "default" windows used as a fallback may not perfectly reflect their local hours.

This will be corrected once the app wires through each practice's specific state or city. In the meantime, if you are working with a practice outside Sydney/Melbourne time, the practice's own emailed reply will take priority and override the defaults.
