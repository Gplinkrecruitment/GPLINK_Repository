# Zoom Call Scheduling — Admin Setup Guide

This guide walks through the one-time configuration required to enable automated Zoom call scheduling for GP registration assistance. Once complete, GPs can book a call through the registration journey, receive WhatsApp and email confirmations, and have the meeting summary automatically attached to their admin profile.

---

## Prerequisites

Before starting, confirm you have access to:

- **Calendly Pro** (or Teams) plan — required for API access and webhook support
- **Zoom Workplace Pro** (or higher) — required for AI Companion meeting summaries
- **DoubleTick WhatsApp** account — already configured in this app
- **Resend** email account — already configured in this app

---

## Step 1: Calendly Setup

### 1a. Create the event type

1. Log in to [calendly.com](https://calendly.com) as the admin account
2. Go to **Event Types** → **New Event Type** → **One-on-One**
3. Set the following:
   - **Name:** `GP Registration Assistance`
   - **Duration:** 30 minutes
   - **Location:** Zoom (select from the location dropdown — Calendly will generate a unique Zoom link per booking)
4. Under **Invitee Questions**, add a custom field: `GP ID` (short text, optional). This is used to link the booking back to the GP's app account.
5. Save and publish the event type.

### 1b. Generate a Calendly API token

1. Go to [calendly.com/integrations/api_webhooks](https://calendly.com/integrations/api_webhooks)
2. Click **Generate New Token**
3. Give it a descriptive name: `GP Link App`
4. Copy the token — this becomes `CALENDLY_API_TOKEN`

### 1c. Get the event type URI

The event type URI is a stable identifier (e.g. `https://api.calendly.com/event_types/XXXXXXXX`) that you pass when creating scheduling links programmatically.

Run this API call (replace `YOUR_TOKEN`):

```bash
curl -s \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.calendly.com/event_types?organization=$(curl -s -H 'Authorization: Bearer YOUR_TOKEN' https://api.calendly.com/users/me | jq -r '.resource.current_organization')" \
  | jq '.collection[] | {name: .name, uri: .uri}'
```

Find the entry matching `GP Registration Assistance` and copy the `uri` value. This becomes `CALENDLY_EVENT_TYPE_URI`.

Also note the short scheduling URL (e.g. `https://calendly.com/your-org/gp-registration-assistance`) — this becomes `CALENDLY_EVENT_URL`.

### 1d. Configure the webhook

1. In the Calendly API/Webhooks page, click **Create Webhook**
2. Set the following:
   - **Subscriber URL:** `https://app.mygplink.com.au/api/webhooks/calendly`
   - **Events:** `invitee.created`, `invitee.canceled`
   - **Scope:** Organization
3. Copy the **signing key** shown after creation — this becomes `CALENDLY_WEBHOOK_SECRET`
4. Save the webhook.

### 1e. Verify UTM tracking data

When a GP books via the in-app scheduling link, UTM parameters are appended to the Calendly URL. Confirm the webhook payload includes `tracking.utm_content` (used to carry the internal GP user ID).

To test, open the Calendly event URL with a `?utm_content=test-gp-id` query param in a browser, complete a test booking, and inspect the webhook payload in your server logs or a tool like [webhook.site](https://webhook.site).

Confirm the payload contains:

```json
{
  "payload": {
    "tracking": {
      "utm_content": "test-gp-id"
    }
  }
}
```

---

## Step 2: Zoom AI Companion Setup

### 2a. Enable AI Companion meeting summaries

1. Log in to [zoom.us](https://zoom.us) as an admin
2. Go to **Admin** → **Account Management** → **Account Settings**
3. Under the **AI Companion** tab, enable:
   - **Meeting Summary with AI Companion**
   - Set distribution to **Auto-send to host and participants**
4. Save changes.

> **Important:** End-to-end encrypted meetings do NOT support AI Companion summaries. Ensure the GP Registration Assistance event type does not enforce E2E encryption.

### 2b. Configure the Zoom webhook

1. Go to [marketplace.zoom.us](https://marketplace.zoom.us) and sign in as admin
2. Click **Develop** → **Build App** → **Webhook Only** app
3. Give it a name: `GP Link Webhooks`
4. Under **Feature** → **Event Subscriptions**, add a subscription:
   - **Subscription Name:** `GP Link Meeting Events`
   - **Event notification endpoint URL:** `https://app.mygplink.com.au/api/webhooks/zoom`
   - **Events to subscribe:**
     - `meeting.ended`
     - `meeting.summary_completed`
5. Click **Validate** to confirm the endpoint responds (the server must be deployed first)
6. Copy the **Secret Token** shown — this becomes `ZOOM_WEBHOOK_SECRET`
7. Activate the app.

### 2c. Required OAuth scopes

If you later upgrade to a full Zoom OAuth app (for reading meeting data programmatically), ensure these scopes are added:

- `meeting:read:summary:admin` — read AI-generated meeting summaries
- `meeting:read:list_meetings:admin` — list meetings for a user

For the webhook-only setup in this guide, no OAuth scopes are required.

---

## Step 3: DoubleTick Template (Optional)

A WhatsApp message template (`zoom_call_invite`) can be submitted to DoubleTick for pre-approval to send rich formatted booking confirmations.

**Template name:** `zoom_call_invite`

**Sample body:**
```
Hi {{1}}, your GP registration assistance call is confirmed for {{2}} at {{3}} AEST.

Join Zoom: {{4}}

Reply CANCEL to cancel.
```

Until the template is approved by Meta (typically 24–48 hours), the system falls back to sending a plain-text WhatsApp message with the same information. No action is required to keep confirmations working during this period.

To submit the template:
1. Log in to your DoubleTick dashboard
2. Go to **Templates** → **New Template**
3. Category: **Utility**
4. Submit the body above with variable placeholders filled in with example values

---

## Step 4: Environment Variables

Add the following environment variables to Vercel. Use `vercel env add` or the Vercel dashboard under **Project Settings** → **Environment Variables**.

| Variable | Description | Where to get it |
|---|---|---|
| `CALENDLY_API_TOKEN` | Calendly personal access token | Step 1b above |
| `CALENDLY_EVENT_URL` | Public Calendly booking URL | Step 1c above |
| `CALENDLY_EVENT_TYPE_URI` | Calendly event type URI (API identifier) | Step 1c above |
| `CALENDLY_WEBHOOK_SECRET` | Signing key for verifying Calendly webhook payloads | Step 1d above |
| `ZOOM_WEBHOOK_SECRET` | Secret token for verifying Zoom webhook payloads | Step 2b above |
| `CRON_SECRET` | Shared secret for authenticated cron job endpoints | Already set if cron jobs are in use; generate a random string if not |

To add a variable via CLI:

```bash
vercel env add CALENDLY_API_TOKEN production
# Paste the value when prompted
```

Repeat for each variable. After adding all variables, redeploy:

```bash
vercel --prod
```

---

## Step 5: Database Migration

Apply the scheduled calls migration to your Supabase database.

**For production (Supabase dashboard):**

1. Go to [supabase.com](https://supabase.com) → your project → **SQL Editor**
2. Open the migration file locally:
   ```
   supabase/migrations/20260609000000_scheduled_calls.sql
   ```
3. Paste the contents into the SQL Editor and click **Run**
4. Confirm no errors are reported

**For local development:**

```bash
npx supabase db push
```

Or apply it directly:

```bash
npx supabase migration up
```

---

## Step 6: Smoke Test

Work through this checklist after all steps above are complete and the latest code is deployed.

- [ ] **Booking link visible in-app:** Log in as a test GP account that has reached the scheduling step. Confirm the "Book a call" button appears and opens the Calendly widget.
- [ ] **Booking creates a record:** Complete a test booking using a Calendly test invitee. Check the `scheduled_calls` table in Supabase for a new row with status `scheduled`.
- [ ] **WhatsApp confirmation sent:** Verify the test GP's phone receives a WhatsApp message within 30 seconds of booking. Check DoubleTick logs if no message arrives.
- [ ] **Email confirmation sent:** Verify the GP's email receives a booking confirmation from Resend. Check Resend dashboard logs if no email arrives.
- [ ] **Admin dashboard shows booking:** Log in as admin and navigate to the GP's profile. Confirm the scheduled call appears with correct date, time, and Zoom link.
- [ ] **Cancellation flow:** Cancel the test booking via Calendly. Confirm the `scheduled_calls` record updates to `canceled` and the GP receives a cancellation WhatsApp/email.
- [ ] **Zoom summary attached:** Host a test Zoom meeting using the generated link, end it, and wait for AI Companion to produce a summary (typically 2–5 minutes). Confirm the `meeting_summary` field on the `scheduled_calls` row is populated after the `meeting.summary_completed` webhook fires.
- [ ] **Webhook signature verification:** Intentionally send a malformed payload to `/api/webhooks/calendly` and `/api/webhooks/zoom`. Confirm both return `401` and nothing is written to the database.

---

## Troubleshooting

**Webhook payloads not arriving**
- Confirm the endpoint URL is exact: `https://app.mygplink.com.au/api/webhooks/calendly` (no trailing slash)
- Check Vercel function logs: `vercel logs --prod`
- Calendly and Zoom both have webhook delivery logs in their dashboards showing failed attempts with response codes

**AI Companion summary not generated**
- Confirm the meeting was NOT end-to-end encrypted
- Confirm AI Companion is enabled at the account level, not just the user level
- Summaries can take up to 10 minutes for longer calls

**WhatsApp messages not sending**
- Check that DoubleTick credentials are still valid (`DOUBLETICK_API_KEY`, `DOUBLETICK_INSTANCE_ID`)
- If using a template, confirm it has been approved in the DoubleTick dashboard
- Fall back to direct text message is automatic if template is unavailable

**`CRON_SECRET` missing**
- If cron endpoints return `401`, the `CRON_SECRET` env var is not set in Vercel
- Generate a secure random string: `openssl rand -hex 32`
- Add it via `vercel env add CRON_SECRET production`
