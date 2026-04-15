# Practice Pack Phase 1b — Gmail Auto-Parsing Design Spec

## Overview

Phase 1b adds automatic email monitoring to the Practice Pack workflow. When practice contacts reply to VA emails with documents (contracts, supervisor CVs), the system automatically extracts attachments, uses AI to match them to the correct GP's task, and stages them for VA review.

## Architecture

```
Practice contact sends email to hazel@mygplink.com.au
        ↓
Gmail API watch → Google Pub/Sub → Webhook (POST /api/webhooks/gmail)
        ↓
Pre-filter (skip internal, no-attachment, spam/marketing)
        ↓
Dedup check (skip already-processed message IDs)
        ↓
AI Analysis (Anthropic API) — match email + attachments to open tasks
        ↓
High confidence (≥0.7) → auto-attach to task, notify VA in dashboard
Low confidence (<0.7) → flag as "unmatched" for VA manual assignment
        ↓
VA reviews in admin dashboard:
  → Approve: deliver to GP MyDocuments + Google Drive
  → Request Revision: Gmail draft created with doc attached, VA writes explanation, sends
  → Dismiss: wrong match, VA can reassign manually
```

## Gmail Watch + Pub/Sub Setup

### Google Cloud Resources Needed

1. **Pub/Sub topic**: `projects/sunlit-precinct-481010-j2/topics/gmail-push`
2. **Pub/Sub subscription**: `gmail-push-sub`, push endpoint: `https://www.mygplink.com.au/api/webhooks/gmail`
3. **Pub/Sub permission**: Grant `gmail-api-push@system.gserviceaccount.com` publish rights on the topic (required by Google)

### Watch Registration

The service account (with domain-wide delegation) calls `gmail.users.watch()` impersonating `hazel@mygplink.com.au`:

```javascript
gmail.users.watch({
  userId: 'hazel@mygplink.com.au',
  requestBody: {
    topicName: 'projects/sunlit-precinct-481010-j2/topics/gmail-push',
    labelIds: ['INBOX']
  }
});
```

Returns a `historyId` — store this to track which messages have been processed.

### Watch Renewal (Cron)

Gmail watches expire after 7 days. A Vercel cron job renews every 6 days:

```json
// vercel.json crons entry
{ "path": "/api/cron/renew-gmail-watch", "schedule": "0 0 */6 * *" }
```

Endpoint: `GET /api/cron/renew-gmail-watch`
- Authenticated via `CRON_SECRET` env var (Vercel sets `Authorization: Bearer <CRON_SECRET>`)
- Calls `gmail.users.watch()` for each monitored VA inbox
- Stores new `historyId`
- Logs success/failure

## Webhook Handler

### Endpoint: `POST /api/webhooks/gmail`

**Input:** Google Pub/Sub push message:
```json
{
  "message": {
    "data": "<base64-encoded JSON: { emailAddress, historyId }>",
    "messageId": "...",
    "publishTime": "..."
  },
  "subscription": "projects/sunlit-precinct-481010-j2/subscriptions/gmail-push-sub"
}
```

**Flow:**

1. Decode the Pub/Sub message to get `emailAddress` and `historyId`
2. Validate the email is a monitored VA inbox
3. Call `gmail.users.history.list()` with the stored `historyId` to get new messages since last check
4. For each new message, call `gmail.users.messages.get()` with `format: 'full'` to get headers, body, and attachment metadata
5. Run through pre-filter
6. If passes filter, run AI matching
7. Update stored `historyId` to the latest value
8. Return 200 OK (must respond quickly; Pub/Sub retries on failure)

**Important:** The webhook must respond within 10 seconds to avoid Pub/Sub retries. Strategy: respond 200 immediately after validating the Pub/Sub message, then continue processing in the same request (Vercel functions run up to 60s even after response is sent via `waitUntil` or simply continuing execution). If the function times out mid-processing, the dedup table prevents reprocessing — the next notification will pick up from the latest `historyId`.

## Pre-Filter

Before sending to AI, apply cheap filters to skip irrelevant emails:

| Filter | Rule | Reason |
|---|---|---|
| Internal | Sender domain is `mygplink.com.au` | Skip internal team emails |
| No attachments | Message has zero attachments | We're only looking for documents |
| Attachment type | No attachment with extension `.pdf`, `.doc`, `.docx`, `.jpg`, `.jpeg`, `.png` | Skip emails with only `.ics`, `.vcf`, or signature images |
| Marketing | Sender matches common no-reply patterns (`noreply@`, `newsletter@`, `marketing@`) OR has `List-Unsubscribe` header | Skip automated/bulk mail |
| Already processed | Message ID exists in `processed_gmail_messages` table | Dedup |
| Small inline images | All attachments are under 10KB and inline (`Content-Disposition: inline`) | Skip signature logos |

If any filter matches, skip the message. Log the skip reason for debugging.

## AI Matching

### Input to AI

For emails that pass the pre-filter, send to Anthropic API:

```
You are a document-matching assistant for GP Link, a medical recruitment company.

An email has arrived with attachments. Match each attachment to the correct open task.

EMAIL:
- From: {sender_email} ({sender_name})
- To: {recipient_email}
- Subject: {subject}
- Date: {date}
- Body (first 2000 chars): {body_text}
- Attachments: {list of filename + size + mime_type}

OPEN TASKS WAITING FOR DOCUMENTS:
{JSON array of tasks with: task_id, document_type (offer_contract/supervisor_cv),
 gp_name, practice_name, practice_contact_email, practice_contact_name,
 practice_location, task_status}

For each attachment, return a JSON object:
{
  "matches": [
    {
      "attachment_index": 0,
      "task_id": "xxx" or null,
      "document_type": "offer_contract" or "supervisor_cv",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation"
    }
  ],
  "is_relevant": true/false,
  "summary": "one-line description of what this email is about"
}

Rules:
- Match based on sender domain vs practice email domain, GP names mentioned in subject/body/filename, document type clues in filename/subject
- If sender domain matches a practice contact's domain, that's a strong signal even if the exact email differs
- "offer", "contract", "agreement", "employment" in filename → likely offer_contract
- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv
- If you cannot confidently match, set task_id to null
- Confidence guide: 0.9+ exact match (same sender, reply thread, clear filename), 0.7-0.9 strong signals (domain match + relevant filename), 0.5-0.7 partial signals, <0.5 uncertain
```

### AI Response Handling

- **confidence ≥ 0.7**: Auto-attach to the matched task. Set task status to `in_progress`. Log the match reasoning.
- **confidence 0.4–0.7**: Attach to the task but flag as "Needs VA confirmation" — VA sees a yellow badge.
- **confidence < 0.4 or `is_relevant: false`**: Skip. Don't create noise for VA.
- **`task_id: null` but `is_relevant: true`**: Show in an "Unmatched documents" queue in admin dashboard for VA to manually assign.

### Cost Control

- Use `claude-haiku-4-5-20251001` for matching (fast, cheap, sufficient for structured matching)
- Only send first 2000 chars of email body (not full thread)
- Don't send attachment content to AI — only metadata (filename, size, type)
- Pre-filter eliminates ~80% of emails before AI runs
- Track daily AI spend against existing `ANTHROPIC_DAILY_LIMIT_USD`

## Document Attachment Flow

When AI matches an attachment to a task:

1. Download the attachment from Gmail API: `gmail.users.messages.attachments.get()`
2. Store in the task record:
   - `attachment_url`: base64-encoded file data
   - `attachment_filename`: original filename
   - `gmail_message_id`: source email message ID (for reference)
   - `gmail_attachment_id`: Gmail attachment ID
   - `ai_match_confidence`: the confidence score
   - `ai_match_reasoning`: the AI's reasoning
   - `status`: `in_progress` (was `waiting_on_practice`)
3. Upload to Google Drive (GP's folder) as a staging copy
4. Log case event: "Document received from [sender] — [filename] (AI confidence: X%)"

## VA Review in Admin Dashboard

### Task Card Changes

When a task has a Gmail-matched attachment, show:

- **Document preview**: "Review Document" button (existing flow)
- **Source info**: "Received from reception@sopmedical.com.au on 16 Apr 2026"
- **AI confidence badge**: Green (≥0.7), Yellow (0.4–0.7)
- **AI reasoning**: Collapsible "Why this match?" text
- **Actions**:
  - **"Approve & Send to GP"** — delivers to MyDocuments + Drive, completes task (existing flow)
  - **"Request Revision"** — creates Gmail draft (new, see below)
  - **"Dismiss"** — removes the attachment from the task, resets to `waiting_on_practice`

### Unmatched Documents Queue

New section in admin dashboard: **"Incoming Documents"**

Shows emails that were `is_relevant: true` but had no confident task match. Each row shows:
- Sender, subject, date
- Attachment filenames
- "Assign to task" dropdown → VA selects the correct task → attachment moves to that task

### Request Revision Flow

1. VA clicks **"Request Revision"** on a task
2. Server creates a Gmail draft in Hazel's inbox via Gmail API:
   ```javascript
   gmail.users.drafts.create({
     userId: 'hazel@mygplink.com.au',
     requestBody: {
       message: {
         // RFC 2822 formatted email
         // To: practice contact email
         // Subject: Re: [original subject] (to keep thread)
         // Attachment: the incorrect document
         // Body: empty (VA fills in)
       }
     }
   });
   ```
3. Server returns the draft URL: `https://mail.google.com/mail/#drafts/[draftId]`
4. Frontend opens this URL in a new tab — Hazel sees the draft with document attached
5. Hazel writes explanation of what's wrong, hits send
6. Task status resets to `waiting_on_practice`
7. Case event logged: "Revision requested for [document type]"

## Dedup / State Storage

### New Database Table: `gmail_watch_state`

```sql
CREATE TABLE IF NOT EXISTS gmail_watch_state (
  email_address text PRIMARY KEY,
  history_id text NOT NULL,
  watch_expiry timestamptz,
  updated_at timestamptz DEFAULT now()
);
```

### New Database Table: `processed_gmail_messages`

```sql
CREATE TABLE IF NOT EXISTS processed_gmail_messages (
  gmail_message_id text PRIMARY KEY,
  email_address text NOT NULL,
  sender text,
  subject text,
  processed_at timestamptz DEFAULT now(),
  result text,  -- 'matched', 'unmatched', 'filtered', 'error'
  matched_task_id text,
  attachment_data jsonb,  -- For unmatched docs: [{filename, base64, mime_type, size}]
  ai_summary text         -- AI's one-line summary of what the email is about
);
```

The `attachment_data` column stores the actual file data for unmatched documents so the VA can preview and manually assign them from the "Incoming Documents" panel. Once assigned to a task, the data moves to the task record and is cleared from this table.

### Migration: `registration_tasks` additions

```sql
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_message_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_attachment_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_confidence real;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_reasoning text;
```

## Server Changes (server.js)

### New Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/webhooks/gmail` | POST | Pub/Sub push handler |
| `GET /api/cron/renew-gmail-watch` | GET | Cron: renew Gmail watch |
| `POST /api/admin/va/task/:taskId/request-revision` | POST | Create Gmail draft with doc attached |
| `GET /api/admin/va/unmatched-documents` | GET | List unmatched incoming documents |
| `POST /api/admin/va/assign-document` | POST | Manually assign an unmatched doc to a task |
| `POST /api/admin/va/task/:taskId/dismiss-attachment` | POST | Dismiss a wrong AI match |

### New Helper Functions

- `getGmailClient(userEmail)` — creates Gmail API client impersonating the given user via domain-wide delegation
- `setupGmailWatch(userEmail)` — registers/renews Gmail push notifications
- `processGmailNotification(emailAddress, historyId)` — fetches new messages, runs filter + AI
- `preFilterEmail(message)` — returns `{ pass: boolean, reason: string }`
- `aiMatchEmail(emailMeta, openTasks)` — calls Anthropic API, returns structured matches
- `attachGmailDocToTask(taskId, messageId, attachmentId, filename, buffer)` — stores attachment on task
- `createRevisionDraft(vaEmail, toEmail, subject, attachmentBuffer, attachmentFilename)` — creates Gmail draft

### Monitored Inboxes

Store as an env var or in-code config:

```javascript
const MONITORED_VA_EMAILS = ['hazel@mygplink.com.au'];
```

When more VAs are added, add their email here and call `setupGmailWatch()` for each.

## Admin Dashboard Changes (pages/admin.html)

### Task Card Updates

- Add source info line when `gmail_message_id` is present
- Add AI confidence badge (green/yellow)
- Add collapsible "Why this match?" section
- Add "Request Revision" button
- Add "Dismiss" button

### New: Incoming Documents Panel

- Shows above the task list (or as a tab)
- Lists unmatched documents with sender, subject, attachments
- "Assign to task" dropdown per document
- Auto-refreshes or shows count badge

## Environment Variables (new)

| Variable | Purpose |
|---|---|
| `GOOGLE_PUBSUB_TOPIC` | Full topic name for Gmail push (e.g. `projects/sunlit-precinct-481010-j2/topics/gmail-push`) |
| `GMAIL_WEBHOOK_SECRET` | Shared secret to verify Pub/Sub push authenticity |
| `CRON_SECRET` | Vercel cron authentication |

## Google Cloud Setup Required

1. Enable Pub/Sub API: `gcloud services enable pubsub.googleapis.com --project=sunlit-precinct-481010-j2`
2. Create topic: `gcloud pubsub topics create gmail-push --project=sunlit-precinct-481010-j2`
3. Grant Gmail publish rights: `gcloud pubsub topics add-iam-policy-binding gmail-push --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher" --project=sunlit-precinct-481010-j2`
4. Create push subscription: `gcloud pubsub subscriptions create gmail-push-sub --topic=gmail-push --push-endpoint="https://www.mygplink.com.au/api/webhooks/gmail" --project=sunlit-precinct-481010-j2`
5. Enable Gmail API: `gcloud services enable gmail.googleapis.com --project=sunlit-precinct-481010-j2` (already done)

## Dependencies

- `googleapis` npm package (already installed for Drive)
- No new npm packages needed — Gmail API is part of `googleapis`

## Accepted File Types

PDF, DOC, DOCX, JPG, JPEG, PNG — any document format a practice contact might reasonably send.

## Phase 1a Integration Points

- Reuses `deliverToMyDocuments()` for approve flow
- Reuses `uploadToGoogleDrive()` for staging and delivery
- Reuses `ensureGPDriveFolder()` for folder management
- Reuses `_completeRegTask()` for task completion
- Reuses `_logCaseEvent()` for timeline logging
- Extends existing task card rendering in admin.html
