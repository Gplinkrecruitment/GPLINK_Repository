# Zoom API + per-interview AI summaries — setup guide

Turns on real per-interview Zoom meetings **and** the AI Companion meeting
summary that shows on the CEO dashboard. One-time setup in your Zoom account +
four environment variables in Vercel. ~15 minutes.

The code is already wired: GP Link creates the meeting, and Zoom's webhook
delivers the summary back automatically. You only need to (A) create a Zoom app,
(B) turn on AI Companion summaries, (C) add a webhook, (D) set 4 env vars.

---

## Prerequisites

- A **paid Zoom plan** with **AI Companion** (Pro or higher — AI Companion is
  included on paid plans). AI Companion Meeting Summary is required for summaries.
- Admin access to your Zoom account and the Zoom App Marketplace.

---

## A. Create a Server-to-Server OAuth app (gets the 3 credentials)

1. Go to https://marketplace.zoom.us/ → sign in → **Develop → Build App**.
2. Choose **Server-to-Server OAuth** → **Create**. Name it e.g. `GP Link Interviews`.
3. On the **App Credentials** page, copy these three values:
   - **Account ID** → `ZOOM_ACCOUNT_ID`
   - **Client ID** → `ZOOM_CLIENT_ID`
   - **Client Secret** → `ZOOM_CLIENT_SECRET`
4. Fill in the basic **Information** fields (company name, contact) — Zoom
   requires them before you can activate.

### Scopes (Scopes tab → Add Scopes)

Add these (search by name; Zoom's exact labels vary slightly by account, add the
closest match under each area):

- **Meeting**
  - `meeting:write:admin` — create the interview meeting
  - `meeting:read:admin` — read meeting + past-participant attendance
  - `meeting:read:summary:admin` (a.k.a. *View a meeting summary* / `meeting_summary:read:admin`) — **fetch the AI summary**

If your account shows granular scopes, add: *View and manage all user meetings*,
*View meeting summaries*, and *View past meeting participants*.

Then **Activate** the app (Activation tab).

---

## B. Turn on AI Companion Meeting Summary (so a summary is generated)

In the Zoom web portal → **Settings → AI Companion** (or **Meeting → AI
Companion**):

1. Enable **Meeting Summary with AI Companion**.
2. Turn ON **Automatically start Meeting Summary for all meetings** (or "allow
   summary to start automatically"). GP Link already asks Zoom to auto-start the
   summary on each interview, but the account setting must permit it.
3. (Recommended) Set summaries to be **shared with the host and saved to the
   account** so the API can retrieve them.

Without this, meetings still work but every summary fetch comes back
"not available".

---

## C. Add the webhook (delivers the summary back to GP Link)

You can add this on the SAME Server-to-Server app: **Feature → Event Subscriptions
→ + Add Event Subscription**.

1. **Event notification endpoint URL:**
   `https://app.mygplink.com.au/api/webhooks/zoom`
2. Copy the **Secret Token** shown on this page → `ZOOM_WEBHOOK_SECRET`.
3. **Add Events** → subscribe to:
   - **Meeting → End Meeting** (`meeting.ended`)
   - **Meeting → Meeting Summary completed** (`meeting.summary_completed`)
4. **Save**. (After you set the env var below and redeploy, use Zoom's
   **Validate** button — GP Link answers the validation challenge automatically.)

---

## D. Set the environment variables in Vercel

Vercel → project **gplink-repository** → **Settings → Environment Variables** →
add these for **Production** (then redeploy, or just push any commit):

```
ZOOM_ACCOUNT_ID       = (from step A3)
ZOOM_CLIENT_ID        = (from step A3)
ZOOM_CLIENT_SECRET    = (from step A3)
ZOOM_WEBHOOK_SECRET   = (from step C2)
```

Once these are set you can leave `INTERVIEW_MEETING_URL` blank — GP Link now
creates a real, unique Zoom meeting per interview.

---

## How it works after setup

1. A doctor books an interview slot → GP Link calls Zoom to create a unique
   meeting (auto-start summary on) and stores the join link.
2. The "Join Meeting" link (email, app, CEO dashboard, reminders) opens that
   real Zoom meeting; GP + practice + RSO join.
3. When the meeting ends, Zoom sends `meeting.ended` → GP Link marks it complete
   and waits for the summary.
4. Minutes later Zoom sends `meeting.summary_completed` → GP Link fetches the
   summary and saves it. A daily retry cron + a manual "Fetch Summary" button are
   backstops if a webhook is ever missed.
5. The summary appears on the **CEO dashboard** candidate drawer (and feeds the
   AI handover context).

## Verify it's working

- After booking one test interview, the booked `scheduled_calls` row should have
  a non-empty `zoom_meeting_id` + `zoom_join_url` (real `zoom.us/j/...`).
- Zoom Marketplace → your app → **Event Subscriptions → Validate** should pass.
- After a real (or short test) meeting ends and Zoom finishes the summary, the
  CEO dashboard interview row shows the summary; `summary_status` moves
  `pending → saved`.

## Notes / limits

- The meeting host is your Zoom account owner; attendees can **join before host**
  (no waiting room), so the interview starts even if the owner doesn't attend.
- Summaries need AI Companion (step B). If a summary is genuinely never produced,
  fetches settle at `not_available` after a few retries — harmless.
- The older admin-scheduled interview path (`career_interviews`) does **not**
  produce summaries; the doctor-facing slot booking (`scheduled_calls`) does.
