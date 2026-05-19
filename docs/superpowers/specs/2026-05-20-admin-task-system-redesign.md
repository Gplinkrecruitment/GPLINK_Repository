# Admin Task System Redesign — MVP Spec

**Date:** 2026-05-20
**Scope:** Complete redesign of the RSO Command Centre task system — from task creation through completion, including Ops Queue UI, email sending, AHPRA officer integration, practice pack workflows, and GP response matching.

---

## 1. Guiding Principles

- **No hollow tasks.** Every task must have a clear action, a clear owner ("ball with"), and a clear completion criteria.
- **Task-first, not GP-first.** The Ops Queue answers: "What's the most urgent thing I need to do right now, across all GPs?"
- **Inline everything.** Hazel never leaves the Ops Queue to complete a task. Expand, act, done.
- **Auto-match responses.** When a GP or practice responds, the system links it to the existing task. Hazel shouldn't manually connect dots.
- **No token-saving shortcuts.** Every feature fully implemented, thoroughly tested, properly integrated.

---

## 2. Task Lifecycle Model

### 2.1 When Tasks Exist (and When They Don't)

| Stage | Tasks? | Detail |
|-------|--------|--------|
| Onboarding | Only if flagged | AI flags qualification doc for manual review → creates `flagged_doc` task |
| Placement | No | Auto-matched from Zoho Recruit, no admin involvement |
| MyIntealth | No proactive tasks | GP works independently. Support tasks only if GP reaches out |
| AMC | No proactive tasks | Same as MyIntealth. Hazel works on practice pack tasks during this time |
| AHPRA | Active | Action items from officer emails + support |
| Visa / PBS / Commencement | Deferred | Not in MVP |

### 2.2 Task Types

| Type | DB `task_type` | Trigger | Ball starts with |
|------|---------------|---------|-----------------|
| Practice pack doc | `practice_pack_child` | Placement secured | Hazel |
| AHPRA action item | `ahpra_action_item` | AHPRA officer email, AI-extracted | Hazel (she messages GP first) |
| Email triage (fallback) | `email_triage` | Inbound email, can't match to task | Hazel |
| Support (WhatsApp/ticket) | `whatsapp_help` / `blocker` | GP reaches out (existing infra) | Hazel |
| Flagged onboarding doc | `flagged_doc` | AI flags qualification doc | Hazel |

### 2.3 "Ball With" States

Replaces the old status system. Stored as `status` field on `registration_tasks`:

| Ball with | DB status value | Meaning |
|-----------|----------------|---------|
| Hazel | `open` or `in_progress` | Hazel needs to act |
| GP | `waiting_on_gp` | Waiting for GP to respond/deliver |
| Practice | `waiting_on_practice` | Waiting for practice to respond/deliver |
| AHPRA | `waiting_on_external` | Waiting for AHPRA (after Hazel sent docs to officer) |

### 2.4 Due Dates

| Task type | Due date rule |
|-----------|--------------|
| Practice pack | 4 weeks from creation |
| AHPRA action item | 10 days from officer email, OR actual deadline extracted from email body — whichever is sooner |
| Support / email triage | No due date |
| Flagged onboarding doc | No due date |

### 2.5 Nudge & Escalation

- **7 days waiting:** Visual indicator on task row: "7 days waiting — follow up?" Hazel acts manually.
- **Overdue:** Task turns red, "OVERDUE" label in Due column.
- **3 days past due:** Auto-escalates to CEO dashboard with context (task title, GP name, days overdue, what's blocking). Uses existing escalation infrastructure.

---

## 3. Ops Queue UI

### 3.1 Stats Bar

Replaces old dropdown filters. Clickable toggle cards:

| Stat | Color | Counts |
|------|-------|--------|
| Open | Blue | All active tasks |
| Overdue | Red | Past due date |
| Hazel's ball | Blue | `open` or `in_progress` status |
| GP's ball | Amber | `waiting_on_gp` status |
| Practice | Purple | `waiting_on_practice` status |
| Blocked | Grey | `blocked` status |

Clicking a stat filters the table to that subset. Click again to clear. Stats update in real-time.

Remove old filters: "All Domains" dropdown, "All Active" dropdown, "All Priorities" dropdown, "Overdue only" checkbox, "Refresh" button (auto-refresh instead). Remove "Domain" stat, "Needs Follow-up" stat, "Escalated" stat (show escalated only when count > 0).

### 3.2 Table Layout — Flat Table (Option A)

| Column | Width | Content |
|--------|-------|---------|
| GP | 15% | Name as clickable link → navigates to GP detail pane |
| Task | 40% | Title + subtitle line (source context, application number, etc.) |
| Ball with | 12% | Color-coded pill: Hazel (blue), GP (amber), Practice (purple), AHPRA (teal) |
| Due | 15% | Days left. Amber at <=5 days, red at <=2 days, "OVERDUE" when past |
| Action | 18% | Contextual link: "View email", "Email practice", "Check status", "Review", etc. |

Priority shown as colored left border on the row:
- Red: urgent / overdue
- Amber: high priority
- Green: normal

### 3.3 Sorting

- Primary: overdue first, then ascending days until due
- Secondary: Hazel's ball before GP/Practice/AHPRA (actionable items first)
- Effect: most urgent actionable item is always at the top

### 3.4 Row Expand — Inline Action

Clicking a task row expands it inline. Content varies by task type and state (detailed in sections 4 and 5). General structure:

```
[Task header: title, ball with, due, source info]

[Context section]
  - Original email / request / action item summary
  - Link to open full email in Gmail

[Conversation thread]
  - Chronological messages: Hazel's outbound, GP/practice responses
  - Document deliveries prominent at top with preview
  - Conversation messages below, timestamped
  - Old doc versions dimmed with "Previous version" label

[Document preview area]
  - Auto-matched attachments with filename, size, preview link
  - Previous versions shown dimmed

[Action buttons]
  - Green CTA (contextual per task type)
  - Secondary actions
  - Revision request

[Composer area] (shown when action button clicked)
  - Email composer: To, CC, Subject, Body (pre-filled, editable), Attachments
  - Revision composer: text area for notes, channel badge showing delivery method
```

### 3.5 Completed Tasks

- Disappear from Ops Queue immediately on completion
- Viewable via "Timeline" sub-nav on GP profile (see Section 8)
- No "show completed" toggle in Ops Queue — it's a pure action queue

---

## 4. Practice Pack Task Flow

### 4.1 Tasks Created

When placement is secured, create:

| Task | Behaviour |
|------|-----------|
| SPPA-00 | Deferred for now. Created with `status = 'deferred'` — hidden from Ops Queue (query excludes deferred). Future: pre-filled PDF template flow where Hazel sends to practice, practice returns completed, Hazel sends to GP, GP returns completed, Hazel checks and uploads. |
| Section G | Auto-completes silently when GP reaches AHPRA stage. Never appears in Ops Queue. Created with `status = 'deferred'` until auto-complete triggers. |
| Position Description | Full practice pack flow (below) |
| Offer / Contract | Full practice pack flow (below) |
| Supervisor CV | Full practice pack flow (below) |

**Section G auto-complete implementation:** In the state-update handler, when the stage transition to `ahpra` is detected (i.e. `newStage === 'ahpra'` and `regCase.stage !== 'ahpra'`), find any deferred/open Section G task (`related_document_key = 'section_g'`) for that case and auto-complete it with timeline entry "Section G auto-delivered to GP." This happens in the same block that already handles stage transitions and sends the AHPRA unlocked email.

### 4.2 Initial State — Ball with Hazel, No Response Yet

Expanded row shows:
- Practice contact info (name, email — from Zoho placement data / registration case)
- Pre-filled email composer:
  - To: practice contact email
  - Subject: "[Doc name] needed for Dr [GP name] — GP Link"
  - Body: professional template requesting the specific document, editable by Hazel
- Action buttons:
  - **Email Practice** (green CTA) — sends email via Gmail API, ball flips to Practice, timeline logged
  - **Message GP** — WhatsApp/email to GP if Hazel needs to coordinate with them about this doc

### 4.3 Practice Responds — Ball Flips to Hazel

Gmail auto-triage matches incoming practice email to the task (by thread ID or content analysis). Attachment auto-previewed inline.

Expanded row shows:
- Practice response with message content and confidence %
- Document preview (filename, size, preview link)
- Action buttons:
  - **Submit to Drive & Complete** (green CTA)
    1. Upload to Google Drive → GP's folder → document-type subfolder
    2. Update GP's My Documents page ("Preparing / Not ready yet" → shows uploaded document)
    3. Task marked complete, timeline logged
  - **Upload Different Version** — file picker, replaces auto-matched doc, returns to review state
  - **Request Revision** — Hazel writes notes, reply sent on same email thread to practice, ball flips back to Practice

### 4.4 Revision Cycle

1. Hazel clicks "Request Revision", writes notes
2. Reply sent on same email thread (practice communication is always email)
3. Ball flips to Practice, task stays open, due date unchanged
4. Practice sends updated doc → auto-matched to same task, ball flips to Hazel
5. Expanded row shows both versions:
   - Latest version: prominent, full preview
   - Previous version: dimmed, labelled "Previous version"
6. Hazel reviews latest and acts (Submit or Request Revision again)

---

## 5. AHPRA Officer Email Processing

### 5.1 Officer Email Arrives — GP Matching

AI triage matches to GP using weighted signals (not all required):

1. **GP email in CC** — strongest signal, direct user match
2. **AHPRA application number in subject** (APP-XXXXXXXXXX) — matched against stored case number
3. **GP name in body** — fuzzy match against registered GPs
4. **Email thread ID** — inherit GP match from tracked thread
5. **Officer email** — look up cases with this officer, use content to disambiguate when same officer handles multiple GPs

High confidence (>80%): auto-assign to GP.
Low confidence: create standalone `email_triage` task with "May relate to" suggestions.

### 5.2 First Officer Email — Store Metadata

When the first AHPRA officer email is matched to a GP:
- Extract and store **AHPRA application number** (APP-XXXXXXXXXX from subject) on `registration_cases`
- Store **officer name and email** on `registration_cases`
- New columns: `ahpra_application_number`, `ahpra_officer_name`, `ahpra_officer_email`

### 5.3 Action Item Extraction

AI reads the officer email body and extracts individual requests. Each becomes a separate `ahpra_action_item` task:

- Title: the specific request (e.g. "Provide certified copies of qualifications")
- Ball with: Hazel (always — she needs to message GP first with instructions)
- Due date: 10 days from email, or actual deadline from email body if sooner (AI extracts dates like "no later than 29 August 2025")
- Linked to: source Gmail message ID, GP's case, application number
- Each action item is a separate task — one document per email for record-keeping

### 5.4 AHPRA Action Item Lifecycle

**Phase 1: Ball with Hazel — initial outreach**
- Expanded row shows: original AHPRA email content (with "Open full email" link), extracted action item
- Action buttons:
  - **Message GP** (green CTA) — composer defaults to WhatsApp (DoubleTick freeform) as primary GP channel, with toggle to switch to email if GP doesn't have WhatsApp. Message explains what AHPRA needs in plain language.
  - On send: message sent via selected channel, ball flips to GP, timeline logged with channel and message content

**Phase 2: Ball with GP — waiting for response**
- Task sits in queue at "GP's ball"
- At 7 days: visual nudge indicator appears
- GP may send conversation messages (questions, acknowledgements) — these attach to the task as thread updates but ball does NOT flip. Hazel gets notified and can reply inline.

**Phase 3: GP delivers document — ball flips to Hazel**
- AI detects document delivery (message with attachment + content matching the action item)
- Auto-matched to task with confidence %
- Ball flips to Hazel
- Expanded row shows: original request, conversation thread, document preview
- Action buttons:
  - **Email AHPRA Officer** (green CTA)
    1. Pre-filled reply on same email thread as officer's original email
    2. To: officer email (from case), CC: GP email
    3. Subject: "Re: [original subject with APP number]"
    4. Body: AI-generated professional response referencing the request and listing attachments, editable by Hazel
    5. Attachments: auto-attached from task
    6. On send: email sent via Gmail API on same thread, docs auto-upload to Drive "AHPRA Requested Additional Documents" folder, task completes
  - **Upload Different Version** — file picker, replaces GP's doc, returns to review state
  - **Request Revision** — Hazel writes notes, sent via same channel GP used (email → email thread reply, WhatsApp → DoubleTick freeform), ball flips back to GP

### 5.5 Response Classification

When an incoming message matches a GP with open AHPRA action items:

| Signal | Classification | Ball behaviour |
|--------|---------------|---------------|
| High confidence match (>80%) + has document attachment | **Document delivery** | Flips to Hazel |
| High confidence match (>80%) + no attachment | **Conversation update** | Stays with GP, notification to Hazel |
| Medium confidence (50-80%) | **Uncertain — flag for review** | Flips to Hazel: "GP may have responded — review needed" |
| Low confidence (<50%) | **Standalone email triage** | New task with "May relate to" suggestions |

### 5.6 Conversation Thread

The expanded task row shows a chronological thread of all messages:
- Hazel's initial outreach to GP
- GP's questions / acknowledgements
- Hazel's replies
- Document deliveries (prominent, at top of thread)
- Revision requests and subsequent re-deliveries
- Previous document versions shown dimmed with "Previous version" label

---

## 6. Email Sending Infrastructure

### 6.1 New Capability

Add Gmail send capability to the app. Currently the app receives and triages via Gmail API but cannot send.

### 6.2 Implementation

- Use existing Gmail OAuth / service account setup
- Send from the monitored VA email address (Hazel's GP Link email)
- Support: To, CC, Subject, Body (HTML), Attachments (from URLs or uploaded files)
- Support replying on existing threads using Gmail `threadId` + `In-Reply-To` / `References` headers
- Every sent email logged in task timeline with: recipient, subject, attachment names
- New server endpoint: `POST /api/admin/email/send`
  - Body: `{ to, cc, subject, bodyHtml, attachments: [{name, url}], threadId?, messageId? }`
  - Returns: `{ ok, gmailMessageId, threadId }`

### 6.3 Email Contexts

| Action | To | CC | Thread | Trigger |
|--------|----|----|--------|---------|
| Email Practice (initial request) | Practice contact email | — | New thread | Hazel clicks "Email Practice" on practice pack task |
| Email Practice (revision) | Practice contact email | — | Same thread | Hazel clicks "Request Revision" on practice pack task |
| Email AHPRA Officer | Officer email (from case) | GP email | Same thread as officer's email | Hazel clicks "Email AHPRA Officer" |
| Request Revision from GP (email) | GP email | — | Same thread GP responded on | Hazel clicks "Request Revision" on AHPRA task where GP used email |

### 6.4 Pre-fill Logic

All email composers are pre-filled with AI-generated content based on task context:
- Subject: auto-generated or "Re: [original subject]" for thread replies
- Body: professional template with task-specific content, always editable by Hazel before sending
- Attachments: auto-attached from task (document deliveries)
- To/CC: auto-filled from case data

---

## 7. GP Matching & Response Matching

### 7.1 GP Matching for Incoming Emails

Enhanced triage to handle AHPRA officer emails correctly:

1. **GP email in CC** — direct match to user account (strongest)
2. **AHPRA application number in subject** — regex `APP-\d{10,13}`, matched against `registration_cases.ahpra_application_number`
3. **GP name in body** — fuzzy match against `user_profiles.first_name` + `last_name`
4. **Email thread ID** — if replying to a tracked thread, inherit the GP match
5. **Officer email** — look up `registration_cases.ahpra_officer_email`, use content signals to disambiguate

### 7.2 Response Matching to Open Tasks

When a message is matched to a GP, check if it relates to an existing open task:

1. **Thread matching** — email reply on a tracked thread → direct task match
2. **Content analysis** — AI compares message against open task titles/descriptions for that GP
3. **Attachment detection** — presence of document attachment that could fulfil a task requirement

Results:
- High + attachment → document delivery, attach to task, ball → Hazel
- High + no attachment → conversation update, attach to task, ball unchanged, notify Hazel
- Medium → attach to task, flag for review, ball → Hazel (safe default)
- Low → standalone `email_triage` task with "May relate to" suggested links

### 7.3 Manual Linking (Fallback)

When AI creates a standalone task with "May relate to" suggestions:
- Suggestions show open task titles with match confidence %
- "Link to this task" button on each suggestion
- On click: email/message content and attachments merge into the target task, standalone task auto-closes

---

## 8. GP Profile Timeline

### 8.1 New Sub-Nav Tab

Add "Timeline" tab alongside existing Tasks / Notes / Documents on the GP detail pane.

### 8.2 Content

Chronological history of all completed Ops Queue tasks for that GP, plus key events:
- Task completed: title, what was done, who acted, when
- Emails sent: to whom, subject, attachments
- Documents uploaded: filename, destination folder
- Revisions requested: notes sent, channel used
- Stage changes: from → to
- Escalations: reason, resolution

### 8.3 Purpose

Audit trail. Hazel or CEO can see exactly what happened for any GP — what was sent to AHPRA, what docs were uploaded, full conversation threads on completed tasks.

---

## 9. Cleanup — Remove Existing Noise

### 9.1 Remove Auto-Created "Verify" Tasks

These are hollow tasks with no real workflow:

- **MyIntealth verify tasks**: "Verify account establishment documents", "Review uploaded qualification documents", "Confirm EPIC verification issued" — remove the `_createRegTask` calls in the MyIntealth state transition block
- **AMC verify tasks**: "Review AMC credentials uploaded", "Monitor AMC verification progress", "Confirm AMC qualifications verified" — remove the `_createRegTask` calls in the AMC state transition block
- **"Verify secured placement with practice"** — already removed

### 9.2 Remove "Kickoff" Tasks

"Review X stage progress" tasks created by admin sync endpoint — generic placeholders with no action. Remove the kickoff task creation logic.

### 9.3 Keep

- Practice pack children (`practice_pack_child`)
- Email triage (`email_triage`)
- Support / WhatsApp (`whatsapp_help`, `blocker`)
- Weekly chase (`chase`)

---

## 10. Database Changes

### 10.1 New Columns on `registration_cases`

```sql
ALTER TABLE registration_cases ADD COLUMN ahpra_application_number TEXT;
ALTER TABLE registration_cases ADD COLUMN ahpra_officer_name TEXT;
ALTER TABLE registration_cases ADD COLUMN ahpra_officer_email TEXT;
```

### 10.2 New Columns on `registration_tasks`

```sql
-- For tracking email threads on tasks
ALTER TABLE registration_tasks ADD COLUMN gmail_thread_id TEXT;
-- For linking AHPRA action items to the source email
ALTER TABLE registration_tasks ADD COLUMN source_gmail_message_id TEXT;
-- For storing the extracted deadline from AHPRA emails
ALTER TABLE registration_tasks ADD COLUMN ahpra_deadline DATE;
```

### 10.3 New Table: `task_messages`

Stores the conversation thread on a task (inbound and outbound messages):

```sql
CREATE TABLE task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id),
  case_id UUID REFERENCES registration_cases(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]',
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  doubletick_message_id TEXT,
  is_document_delivery BOOLEAN DEFAULT FALSE,
  ai_match_confidence REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_messages_task_id ON task_messages(task_id);
CREATE INDEX idx_task_messages_gmail_thread ON task_messages(gmail_thread_id);
```

### 10.4 New Table: `task_documents`

Stores document versions attached to a task:

```sql
CREATE TABLE task_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id),
  case_id UUID REFERENCES registration_cases(id),
  message_id UUID REFERENCES task_messages(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  google_drive_file_id TEXT,
  google_drive_url TEXT,
  attachment_url TEXT,
  version INTEGER DEFAULT 1,
  is_current BOOLEAN DEFAULT TRUE,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_documents_task_id ON task_documents(task_id);
```

---

## 11. WhatsApp via DoubleTick (Freeform)

- "Message GP" and "Request Revision" (WhatsApp channel) send freeform text via DoubleTick API
- Paid feature enables messaging at any time without 24-hour window constraint
- Messages logged in `task_messages` with `channel = 'whatsapp'`
- Existing DoubleTick integration extended to support freeform send from task context
- New server endpoint: `POST /api/admin/whatsapp/send`
  - Body: `{ phone, message, taskId?, caseId? }`
  - Returns: `{ ok, doubletickMessageId }`

---

## 12. Implementation Notes

- **No token-saving shortcuts.** Every feature fully implemented with thorough testing.
- **Email sending is the critical new infrastructure.** Must be implemented first as AHPRA flow and practice pack flow both depend on it.
- **AI quality matters.** The action item extraction, response matching, and GP matching are the intelligence layer. These need careful prompt engineering and testing with real AHPRA email examples.
- **Thread tracking is essential.** Gmail thread IDs must be stored on tasks so reply-matching works reliably. This is more reliable than content-based matching.
- **Practice contact info must flow from Zoho.** The practice pack flow depends on having the practice contact email available on the case. Verify this data path exists.
- **Section G auto-complete is a small change** but important — must trigger when stage transitions to AHPRA, not create a visible task.
- **Existing support/WhatsApp/email triage infrastructure stays.** This redesign enhances it (response matching, thread tracking) but doesn't replace the core triage logic.
- **"Open full email" links** use the Gmail web URL format: `https://mail.google.com/mail/u/0/#inbox/<messageId>`. This opens the full email in Gmail in a new tab.
- **Ops Queue queries must exclude `deferred` and `completed`/`cancelled` statuses.** The API filter should be: `status=in.(open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated)`.
- **The `deferred` status is new** — add it to the status enum/constraint on `registration_tasks` if one exists. Tasks with this status are invisible to the Ops Queue but still exist in the database for future activation (SPPA-00) or auto-complete (Section G).
