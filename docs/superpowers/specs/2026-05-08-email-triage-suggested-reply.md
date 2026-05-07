# Email Triage Task — Suggested Reply

**Date:** 2026-05-08
**Status:** Approved

## Overview

When the Gmail pipeline creates a task from an inbound email, the VA needs to see the email content, understand the GP's context, and craft a reply. This spec adds an expanded email task view with an AI-suggested reply drawn from all available GP data.

## Data Changes

### registration_tasks — new columns

| Column | Type | Purpose |
|---|---|---|
| `email_body_snippet` | text | First 2000 chars of email body, stored at task creation |
| `email_sender` | text | Sender email address |
| `gmail_thread_id` | text | Gmail thread ID for building the "Open in Gmail" URL |

These are populated by the Gmail triage pipeline when creating the task. No migration needed for `gmail_message_id` — it already exists on the table.

### Migration

```sql
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS email_body_snippet text,
  ADD COLUMN IF NOT EXISTS email_sender text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id text;
```

## Gmail Pipeline Changes (server.js)

When `_createRegTask` is called from the triage path, include:
- `email_body_snippet`: `emailMeta.bodyText` (first 2000 chars)
- `email_sender`: `emailMeta.sender`
- `gmail_thread_id`: `emailMeta.threadId` (from Gmail message metadata)

The `extractEmailMeta` function already has access to the Gmail message object which contains `threadId`. Add it to the returned object.

## API Endpoint

### POST /api/admin/email-triage/suggest-reply

**Auth:** Admin session required.

**Request body:**
```json
{ "taskId": "uuid" }
```

**What it does:**
1. Load the `registration_task` by ID — get `case_id`, `gmail_message_id`, `email_body_snippet`, `email_sender`
2. Load the registration case — get `user_id`, `stage`, `substage`, `practice_name`
3. Load GP profile — name, email, phone, country
4. Load open tasks for this case — titles, priorities, stages
5. Load qualification snapshot — required, approved, missing docs
6. Fetch recent DoubleTick messages via `GET /chat-messages` API (last 10 messages, if `DOUBLETICK_API_KEY` set and GP has phone)
7. Fetch the Gmail thread via Gmail API (`gmail.users.threads.get`) for the full conversation
8. Send all context to Claude with a system prompt instructing it to draft a professional reply from Hazel (the VA) based on all available information
9. Return `{ ok: true, suggestedReply: "...", context: { stage, practice, openTasks, qualStatus } }`

**Claude prompt structure:**
- System: "You are drafting an email reply for Hazel, a Virtual Assistant at GP Link who helps international GPs register to practice in Australia. Write a professional, helpful reply. Use the GP context provided to give accurate, specific information. Keep the tone warm but professional. Do not fabricate information — only reference what the context shows."
- User: The email thread + GP context JSON + "Draft a reply to this email."

**Error handling:** If any context source fails (DoubleTick down, Gmail thread fetch fails), proceed with whatever context is available. The reply will be less informed but still useful.

## Admin Page Changes (pages/admin.html)

### Email task card — expanded view

When a task has `task_type === 'email_triage'`, clicking it opens an expanded panel instead of the default task actions. The panel contains:

**Email section:**
- From: `{email_sender}`
- Subject: `{title}` (already stored, strip the emoji prefix for display)
- Body: `{email_body_snippet}` displayed in a readable format
- "Open in Gmail" button — `href="https://mail.google.com/mail/u/0/#inbox/{gmail_thread_id}"` opens in new tab

**GP Context section** (auto-loaded from the dashboard data already in memory):
- Current stage + substage
- Practice name (from placement)
- Open tasks count
- Qualification status (X/Y approved)

**Suggested Reply section:**
- "Generate Suggested Reply" button
- On click: calls `POST /api/admin/email-triage/suggest-reply` with the task ID
- Shows loading spinner while generating
- Displays the reply in an editable `<textarea>` (pre-filled with AI response)
- "Copy to Clipboard" button below the textarea
- Small note: "This is a suggestion — edit as needed before sending."

**Task actions:**
- "Mark Resolved" button — sets task status to `completed`
- No auto-close on expanding the task

### Rendering logic

The existing task card renderer checks `task_type` — add a branch for `email_triage` that renders the expanded view inline within the task list (not a modal). The expanded state toggles on click like the existing substep dropdowns.

## Context Sources for AI Reply

| Source | Data | How fetched |
|---|---|---|
| Email thread | Full conversation history | Gmail API `users.threads.get` |
| Registration case | Stage, substage, blocker status | Already in `S.cases` |
| GP profile | Name, email, phone, country | Already in dashboard users |
| Open tasks | Title, priority, stage for each | Already in `S.tasks` filtered by case |
| Qualification status | Required, approved, missing | Already in dashboard users |
| DoubleTick messages | Last 10 WhatsApp messages | DoubleTick `GET /chat-messages` API |
| Placement | Practice name, contact, location | Already in `practiceContactMap` |

## Out of Scope

- Auto-sending the reply from the app (VA copies and pastes into Gmail)
- Editing the email task title/description after creation
- Threading multiple email tasks (each email = one task)
- Attachment previews (VA opens Gmail to see attachments)
