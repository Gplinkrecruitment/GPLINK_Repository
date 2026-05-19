# Admin Task System Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the RSO Command Centre task system so every task has a clear owner ("ball with"), clear actions, and inline workflows — from practice pack document coordination through AHPRA officer email processing.

**Architecture:** Single monolithic server.js with admin UI in pages/admin.html. New capabilities: Gmail send API, enhanced email triage with task-response matching, AHPRA action item extraction, inline email/revision composers in Ops Queue, and a GP Profile Timeline tab. Two new Supabase tables (task_messages, task_documents) plus schema extensions.

**Tech Stack:** Node.js server (server.js), vanilla JS/HTML (pages/admin.html), Supabase (PostgreSQL), Gmail API (googleapis), DoubleTick WhatsApp API, Anthropic Claude API (AI triage/extraction).

**Spec:** `docs/superpowers/specs/2026-05-20-admin-task-system-redesign.md`

---

## File Map

### Files to Create
- `supabase/migrations/20260520000000_admin_task_redesign.sql` — All schema changes: new tables, new columns, constraint updates
- No new JS files — all logic goes in server.js and pages/admin.html per existing patterns

### Files to Modify
- `server.js` — Email send endpoint, WhatsApp freeform endpoint, enhanced triage, AHPRA processing, task cleanup, Section G auto-complete, response matching, ops queue API changes, timeline API
- `pages/admin.html` — Ops Queue UI redesign, inline expand with composers, GP Profile Timeline tab

---

## Task 1: Database Migrations

**Files:**
- Create: `supabase/migrations/20260520000000_admin_task_redesign.sql`

This migration adds all schema changes needed by subsequent tasks. Must run first.

- [ ] **Step 1: Write the migration file**

```sql
-- ============================================================
-- Admin Task System Redesign — Schema Changes
-- ============================================================

-- 1. New columns on registration_cases for AHPRA officer tracking
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_application_number TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_officer_name TEXT;
ALTER TABLE registration_cases ADD COLUMN IF NOT EXISTS ahpra_officer_email TEXT;

-- 2. New columns on registration_tasks
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS source_gmail_message_id TEXT;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ahpra_deadline DATE;

-- Note: gmail_thread_id already exists (20260508010000 migration)

-- 3. Widen task_type constraint to include new types
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops','whatsapp_help','email_triage',
    'ahpra_action_item','flagged_doc','doc_review'
  ));

-- 4. Widen status constraint to include 'deferred'
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external',
    'blocked','escalated','deferred'
  ));

-- 5. task_messages — conversation thread on a task
CREATE TABLE IF NOT EXISTS task_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  sender TEXT,
  recipient TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  doubletick_message_id TEXT,
  is_document_delivery BOOLEAN DEFAULT FALSE,
  ai_match_confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_messages_task_id ON task_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_task_messages_gmail_thread ON task_messages(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_task_messages_case_id ON task_messages(case_id);

-- 6. task_documents — document versions attached to a task
CREATE TABLE IF NOT EXISTS task_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES registration_tasks(id) ON DELETE CASCADE,
  case_id UUID REFERENCES registration_cases(id) ON DELETE CASCADE,
  message_id UUID REFERENCES task_messages(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  google_drive_file_id TEXT,
  google_drive_url TEXT,
  attachment_url TEXT,
  version INTEGER DEFAULT 1,
  is_current BOOLEAN DEFAULT TRUE,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_documents_task_id ON task_documents(task_id);
CREATE INDEX IF NOT EXISTS idx_task_documents_case_id ON task_documents(case_id);

-- 7. Indexes for AHPRA matching
CREATE INDEX IF NOT EXISTS idx_reg_cases_ahpra_app ON registration_cases(ahpra_application_number)
  WHERE ahpra_application_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reg_cases_ahpra_officer ON registration_cases(ahpra_officer_email)
  WHERE ahpra_officer_email IS NOT NULL;
```

- [ ] **Step 2: Apply migration to Supabase**

Run: `cd supabase && npx supabase db push` or apply via the Supabase dashboard SQL editor if CLI is not available. Verify all tables and columns were created by querying the schema.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260520000000_admin_task_redesign.sql
git commit -m "feat: add schema for admin task system redesign

New tables: task_messages (conversation threads), task_documents (versioned attachments).
New columns on registration_cases: ahpra_application_number, ahpra_officer_name, ahpra_officer_email.
New columns on registration_tasks: source_gmail_message_id, ahpra_deadline.
Widened task_type to include ahpra_action_item, flagged_doc.
Widened status to include deferred."
```

---

## Task 2: Gmail Send Capability

**Files:**
- Modify: `server.js` — Add `sendGmailEmail()` function and `POST /api/admin/email/send` endpoint

**Context:**
- Gmail OAuth already has `gmail.compose` scope (server.js line 436)
- Gmail draft creation code exists at line 25427 — adapt this pattern for sending
- `getGmailClient(userEmail)` at line 416 returns an authenticated Gmail client
- MONITORED_VA_EMAILS contains the VA email addresses (Hazel's)
- The existing draft code builds RFC 2822 messages with base64 encoding

- [ ] **Step 1: Add sendGmailEmail helper function**

Add after the existing `getGmailClient` function (around line 455). This function:
- Takes `{ from, to, cc, subject, bodyHtml, bodyText, attachments, threadId, inReplyTo }` 
- Builds an RFC 2822 MIME message with multipart/mixed for attachments
- Uses `gmail.users.messages.send()` API
- Supports thread replies via `threadId` and `In-Reply-To`/`References` headers
- Returns `{ ok, gmailMessageId, threadId }` or `{ ok: false, error }`

The `from` parameter should be the monitored VA email. Attachments are `[{ filename, mimeType, content (base64) }]` — content can be fetched from URLs (Google Drive, attachment_url) before calling this function.

Key implementation detail: for thread replies, set `In-Reply-To` and `References` headers to the `inReplyTo` message ID (RFC 2822 Message-ID, not Gmail message ID). The Gmail API requires `threadId` in the request body to place the reply in the correct thread.

- [ ] **Step 2: Add fetchAttachmentContent helper**

A helper that takes a URL (Google Drive file URL, or attachment_url) and returns `{ filename, mimeType, content }` with content as base64. This is needed to attach documents to outgoing emails.

For Google Drive files: use `drive.files.get({ fileId, alt: 'media' })`.
For HTTP URLs: use `fetch(url)` and convert to base64.

- [ ] **Step 3: Add POST /api/admin/email/send endpoint**

Add in the admin API routing section (around line 23393). Requires admin session.

Request body:
```json
{
  "to": "recipient@example.com",
  "cc": "cc@example.com",
  "subject": "Subject line",
  "bodyHtml": "<p>Email body</p>",
  "bodyText": "Email body plain text",
  "attachments": [
    { "filename": "doc.pdf", "url": "https://drive.google.com/..." }
  ],
  "threadId": "gmail-thread-id",
  "inReplyTo": "rfc2822-message-id",
  "taskId": "task-uuid",
  "caseId": "case-uuid"
}
```

Endpoint logic:
1. Validate required fields (to, subject, bodyHtml or bodyText)
2. Fetch attachment content from URLs via `fetchAttachmentContent`
3. Call `sendGmailEmail()` using the first MONITORED_VA_EMAIL as sender
4. If `taskId` provided: create a `task_messages` record with direction='outbound', channel='email'
5. If `taskId` provided: log timeline event "Email sent to [recipient] — [subject]"
6. Return `{ ok, gmailMessageId, threadId }`

- [ ] **Step 4: Test the endpoint**

Use curl or the browser console to send a test email:
```bash
curl -X POST https://app.mygplink.com.au/api/admin/email/send \
  -H "Content-Type: application/json" \
  -H "Cookie: gp_admin_session=..." \
  -d '{"to":"test@example.com","subject":"Test from GP Link","bodyHtml":"<p>Test email</p>"}'
```

Verify the email arrives and is from the VA email address.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add Gmail send capability via /api/admin/email/send

Supports To, CC, Subject, HTML/text body, file attachments (fetched from URLs),
and thread replies (threadId + In-Reply-To headers). Logs to task_messages
and task_timeline when taskId is provided."
```

---

## Task 3: WhatsApp Freeform Send Endpoint

**Files:**
- Modify: `server.js` — Add `POST /api/admin/whatsapp/send` endpoint

**Context:**
- `sendDoubleTickNudge()` at line 5452 already sends freeform text via DoubleTick API
- DoubleTick base URL and API key are configured at lines 124-125
- The endpoint `POST {DOUBLETICK_BASE_URL}/whatsapp/message/text` sends freeform messages

- [ ] **Step 1: Add POST /api/admin/whatsapp/send endpoint**

Add in the admin API routing section. Requires admin session.

Request body:
```json
{
  "phone": "+61400000000",
  "message": "Hi Dr Miller, AHPRA has requested certified copies of your qualifications...",
  "taskId": "task-uuid",
  "caseId": "case-uuid"
}
```

Endpoint logic:
1. Validate required fields (phone, message)
2. Normalize phone via `normalizePhone()` (line 2852)
3. Send via DoubleTick text API: `POST {DOUBLETICK_BASE_URL}/whatsapp/message/text` with body `{ to: phone, text: message }`
4. If `taskId` provided: create `task_messages` record with direction='outbound', channel='whatsapp'
5. If `taskId` provided: log timeline event "WhatsApp sent to [phone]"
6. Return `{ ok, doubletickMessageId }`

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add WhatsApp freeform send via /api/admin/whatsapp/send

Uses DoubleTick text API for freeform messaging. Logs to task_messages
and task_timeline when taskId is provided."
```

---

## Task 4: Cleanup Hollow Tasks + Section G Auto-Complete + SPPA-00 Deferred

**Files:**
- Modify: `server.js` — Remove verify task creation for MyIntealth/AMC, remove kickoff task creation, add Section G auto-complete, set SPPA-00 and Section G to deferred status

**Context:**
- MyIntealth verify tasks created at line 5639 with `_hasOpenTask(caseId, 'myintealth', 'verify')` guard
- AMC verify tasks created at line 5661 with `_hasOpenTask(caseId, 'amc', 'verify')` guard
- Kickoff tasks created at line 23703 in the sync endpoint
- Section G practice pack child created at line 5690 (in the loop over packLabels)
- SPPA-00 practice pack child also created in the same loop
- Stage transition to AHPRA is detected around line 5793-5812 (AHPRA unlocked logic)
- `_deriveStageFromState()` is at line 5039

- [ ] **Step 1: Remove MyIntealth verify task creation**

Find the block around line 5635-5645 that creates verify tasks for MyIntealth substages (account_establishment, upload_qualifications, verification_issued). The block looks like:
```javascript
for (const key of ['account_establishment', 'upload_qualifications', 'verification_issued']) {
  if (!pc[key] && nc[key] === true) {
    if (!(await _hasOpenTask(caseId, 'myintealth', 'verify'))) {
      await _createRegTask(caseId, { task_type: 'verify', title: epicLabels[key], ... });
    }
```
Remove the `_createRegTask` call and its `_hasOpenTask` guard. Keep the stage transition logic (emails, DoubleTick, stage_change events) — only remove the verify task creation.

- [ ] **Step 2: Remove AMC verify task creation**

Find the similar block around line 5657-5667 for AMC substages (upload_credentials, waiting_verification, qualifications_verified). Remove the `_createRegTask` call and guard. Keep stage transition logic.

- [ ] **Step 3: Remove kickoff task creation**

Find the block around line 23703 that creates kickoff tasks: `await _createRegTask(caseId, { task_type: 'kickoff', title: 'Review ' + stage + ' stage progress', ...})`. Remove it. This is in the admin sync endpoint.

- [ ] **Step 4: Set SPPA-00 and Section G to deferred status on creation**

In the practice pack creation loop (around line 5688-5693), modify SPPA-00 and Section G to use `status: 'deferred'`:
```javascript
const packLabels = { sppa_00: 'SPPA-00', section_g: 'Section G', position_description: 'Position Description', offer_contract: 'Offer / Contract', supervisor_cv: 'Supervisor CV' };
const deferredKeys = new Set(['sppa_00', 'section_g']);
for (const dk of Object.keys(packLabels)) {
  const taskData = { task_type: 'practice_pack_child', title: packLabels[dk], source_trigger: 'career_secured', related_stage: 'career', related_document_key: dk, _actor: 'system' };
  if (deferredKeys.has(dk)) taskData.status = 'deferred';
  await _createRegTask(caseId, taskData);
}
```

- [ ] **Step 5: Add Section G auto-complete on AHPRA stage transition**

In the stage transition block where AHPRA unlocked email is sent (around line 5793-5812), add after the email/DoubleTick sending:
```javascript
// Auto-complete Section G when GP reaches AHPRA
const sgTasks = await supabaseDbRequest('registration_tasks',
  'select=id&case_id=eq.' + encodeURIComponent(caseId) + '&related_document_key=eq.section_g&task_type=eq.practice_pack_child&status=in.(open,in_progress,waiting,deferred)&limit=1');
if (sgTasks.ok && Array.isArray(sgTasks.data)) {
  for (const t of sgTasks.data) {
    await _completeRegTask(t.id, caseId, 'system');
    await _logCaseEvent(caseId, t.id, 'completed', 'Section G auto-delivered to GP', null, 'system');
  }
}
```

- [ ] **Step 6: Update practice pack due dates to 4 weeks**

Find `_autoAssignDueDate` function and ensure practice_pack_child tasks get a 28-day due date. Check the existing logic and update if it uses a different default.

- [ ] **Step 7: Wire up flagged_doc task creation for onboarding**

In the qualification verification flow (around the `verifyQualification` / AI scan logic), when a document is flagged for manual review (e.g. name mismatch, low confidence, max retries exceeded), create a `flagged_doc` task:
```javascript
await _createRegTask(caseId, {
  task_type: 'flagged_doc',
  title: 'Review flagged qualification: ' + docLabel,
  description: 'AI flagged this document for manual review. Reason: ' + flagReason,
  priority: 'high',
  source_trigger: 'qualification_scan',
  related_stage: 'myintealth',
  _actor: 'system'
});
```

Find the existing code where docs are flagged (search for `manual_review` or `account_status.*under_review` in the qualification verification endpoint) and add the task creation there.

- [ ] **Step 8: Update Ops Queue API to exclude deferred tasks**

In the ops queue endpoint (around line 27322), ensure the default status filter excludes 'deferred'. The default filter string should be:
`'open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated'`
(already excludes deferred since it's not in the list, but verify).

- [ ] **Step 9: Commit**

```bash
git add server.js
git commit -m "fix: remove hollow verify/kickoff tasks, add Section G auto-complete

Removed auto-created verify tasks for MyIntealth and AMC substeps.
Removed kickoff tasks from admin sync. SPPA-00 and Section G now
created with deferred status. Section G auto-completes when GP
reaches AHPRA stage. Practice pack due dates set to 4 weeks."
```

---

## Task 5: Enhanced AHPRA Email Triage — GP Matching + Metadata Storage

**Files:**
- Modify: `server.js` — Enhance the email triage AI prompt, add AHPRA metadata extraction, update the `processGmailNotification` flow

**Context:**
- Email triage AI prompt is in `aiMatchEmail()` at line 549
- AHPRA emails are already detected by `@ahpra.gov.au` sender domain (line 1043)
- The triage creates `email_triage` tasks — we need to enhance this to create `ahpra_action_item` tasks instead when AHPRA officer emails contain document requests
- New columns `ahpra_application_number`, `ahpra_officer_name`, `ahpra_officer_email` on registration_cases need to be populated

- [ ] **Step 1: Add AHPRA application number extraction function**

```javascript
function extractAhpraApplicationNumber(subject, bodyText) {
  const pattern = /APP[-–—]?\s*(\d{10,13})/i;
  const match = (subject || '').match(pattern) || (bodyText || '').match(pattern);
  return match ? 'APP-' + match[1] : null;
}
```

- [ ] **Step 2: Add AHPRA officer metadata extraction**

```javascript
function extractAhpraOfficerInfo(emailMeta) {
  const sender = emailMeta.sender || '';
  const fromMatch = sender.match(/^([^<]+)<([^>]+)>/);
  return {
    name: fromMatch ? fromMatch[1].trim() : sender.split('@')[0],
    email: fromMatch ? fromMatch[2].trim().toLowerCase() : sender.trim().toLowerCase()
  };
}
```

- [ ] **Step 3: Enhance GP matching for AHPRA emails**

In the email triage flow (around line 1029-1041), when `isAhpra` is true, add enhanced matching:

1. Extract application number from subject
2. If found, query `registration_cases` by `ahpra_application_number`
3. Check CC recipients — match against `user_profiles.email` 
4. Extract GP name from body — fuzzy match against `user_profiles`
5. Check `gmail_thread_id` — if this is a reply to a tracked thread, inherit the GP match
6. Check officer email — query `registration_cases.ahpra_officer_email` and use body content to disambiguate

Combine signals with confidence scoring. If confidence > 80%, assign to GP. Otherwise create standalone email_triage.

- [ ] **Step 4: Store AHPRA metadata on first officer email**

After matching to a GP case, if the case doesn't already have AHPRA metadata:
```javascript
if (isAhpra && gpCase && gpCase.id) {
  const appNum = extractAhpraApplicationNumber(emailMeta.subject, emailMeta.bodyText);
  const officerInfo = extractAhpraOfficerInfo(emailMeta);
  const ahpraPatch = {};
  if (appNum) ahpraPatch.ahpra_application_number = appNum;
  if (officerInfo.name) ahpraPatch.ahpra_officer_name = officerInfo.name;
  if (officerInfo.email) ahpraPatch.ahpra_officer_email = officerInfo.email;
  if (Object.keys(ahpraPatch).length > 0) {
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(gpCase.id), {
      method: 'PATCH', body: ahpraPatch
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: enhanced AHPRA email GP matching + metadata storage

Extracts APP-XXXXXXXXXX application number from email subject.
Matches AHPRA emails to GPs via CC email, application number, GP name,
thread ID, and officer email. Stores officer name/email and application
number on registration_cases."
```

---

## Task 6: AHPRA Action Item Extraction

**Files:**
- Modify: `server.js` — Add AI action item extraction, create `ahpra_action_item` tasks from officer emails

**Context:**
- When an AHPRA officer email is matched to a GP (from Task 5), we need to extract individual document/information requests and create separate tasks
- The AI prompt should analyze the email body and return structured action items
- Each action item becomes an `ahpra_action_item` task with 10-day due date (or extracted deadline, whichever is sooner)
- Uses Anthropic Claude API — existing pattern at line 3324 (`classifyQualificationWithAI`)

- [ ] **Step 1: Add extractAhpraActionItems function**

```javascript
async function extractAhpraActionItems(emailMeta) {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const prompt = [
    'You are analyzing an email from an AHPRA (Australian Health Practitioner Regulation Agency) officer to a GP registration support team.',
    'Extract each individual document or information request from this email.',
    'Also extract any deadline mentioned (e.g. "no later than 29 August 2025").',
    'For each action item, determine who needs to act:',
    '- "gp" if the GP needs to provide a personal document (e.g. certified copies of their qualifications)',
    '- "practice" if the practice/employer needs to provide something (e.g. letter from practice owner)',
    '- "hazel" if the support team needs to create/revise a document (e.g. revise supervision plan)',
    'Return strict JSON array: [{"title": "short action title", "description": "full detail of what is needed", "owner": "gp|practice|hazel"}]',
    'Also include a top-level "deadline" field (ISO date string or null) if a deadline is mentioned.',
    'Return format: {"deadline": "2025-08-29" or null, "items": [...]}',
    '',
    'Email subject: ' + String(emailMeta.subject || '').slice(0, 500),
    'Email from: ' + String(emailMeta.sender || '').slice(0, 200),
    'Email body: ' + String(emailMeta.bodyText || '').slice(0, 8000)
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        temperature: 0,
        system: 'Extract action items from AHPRA officer emails. Return JSON only.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    const text = data.content && data.content[0] ? data.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { deadline: null, items: [] };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[AHPRA] Action item extraction failed:', err.message);
    return { deadline: null, items: [] };
  }
}
```

- [ ] **Step 2: Integrate into email triage flow for AHPRA emails**

In the processGmailNotification flow, after matching an AHPRA email to a GP case, instead of creating a generic `email_triage` task:

1. Call `extractAhpraActionItems(emailMeta)`
2. If items are extracted, create one `ahpra_action_item` task per item
3. Calculate due date: 10 days from email, or extracted deadline, whichever is sooner
4. Set initial status to `open` (ball with Hazel — she messages GP first)
5. Store `source_gmail_message_id`, `gmail_thread_id`, `ahpra_deadline` on each task
6. Create a `task_messages` record linking the original AHPRA email to each task
7. If no action items extracted, fall back to creating a regular `email_triage` task

```javascript
if (isAhpra && gpCase) {
  const extraction = await extractAhpraActionItems(emailMeta);
  if (extraction.items && extraction.items.length > 0) {
    const tenDaysFromNow = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
    const ahpraDeadline = extraction.deadline || null;
    const dueDate = ahpraDeadline && ahpraDeadline < tenDaysFromNow ? ahpraDeadline : tenDaysFromNow;

    for (const item of extraction.items) {
      const task = await _createRegTask(gpCase.id, {
        task_type: 'ahpra_action_item',
        title: item.title,
        description: item.description,
        priority: 'high',
        due_date: dueDate,
        source_trigger: 'ahpra_officer_email',
        related_stage: 'ahpra',
        source_gmail_message_id: currentMsgId,
        gmail_thread_id: emailMeta.threadId || '',
        ahpra_deadline: ahpraDeadline,
        _actor: 'system'
      });
      if (task) {
        // Store original email as first task_message
        await supabaseDbRequest('task_messages', '', {
          method: 'POST',
          body: [{
            task_id: task.id,
            case_id: gpCase.id,
            direction: 'inbound',
            channel: 'email',
            sender: emailMeta.sender || '',
            subject: emailMeta.subject || '',
            body_text: (emailMeta.bodyText || '').substring(0, 5000),
            gmail_message_id: currentMsgId,
            gmail_thread_id: emailMeta.threadId || '',
            is_document_delivery: false
          }]
        });
      }
    }
    // Skip normal email_triage task creation — action items handle it
    continue; // or return, depending on loop structure
  }
  // Fallback: no action items extracted → create regular email_triage task
}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: AI extraction of AHPRA officer action items

AHPRA officer emails are analyzed by Claude to extract individual
document/information requests. Each becomes an ahpra_action_item task
with 10-day due date. Original email stored in task_messages.
Falls back to email_triage if no action items found."
```

---

## Task 7: Response Matching — Link Incoming Messages to Open Tasks

**Files:**
- Modify: `server.js` — Enhance email triage to match responses to existing tasks, add AI response classification

**Context:**
- When a GP or practice emails/WhatsApps, the system needs to check if it relates to an existing open task
- Thread matching (gmail_thread_id) is the strongest signal
- Content analysis via AI is the fallback
- Responses are stored in task_messages and attached to the task
- "Ball with" flips based on response classification (document delivery vs conversation)

- [ ] **Step 1: Add matchResponseToTask function**

This function takes an incoming email/message and tries to match it to an existing open task for the GP:

```javascript
async function matchResponseToTask(caseId, emailMeta) {
  if (!caseId || !isSupabaseDbConfigured()) return null;

  // Signal 1: Thread matching — strongest
  if (emailMeta.threadId) {
    const threadMatch = await supabaseDbRequest('registration_tasks',
      'select=id,task_type,title,status,gmail_thread_id&case_id=eq.' + encodeURIComponent(caseId) +
      '&gmail_thread_id=eq.' + encodeURIComponent(emailMeta.threadId) +
      '&status=in.(open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external)&limit=1');
    if (threadMatch.ok && Array.isArray(threadMatch.data) && threadMatch.data.length > 0) {
      return { task: threadMatch.data[0], confidence: 0.95, method: 'thread_match' };
    }
  }

  // Signal 2: Check task_messages for thread matches
  if (emailMeta.threadId) {
    const msgMatch = await supabaseDbRequest('task_messages',
      'select=task_id&gmail_thread_id=eq.' + encodeURIComponent(emailMeta.threadId) + '&limit=1');
    if (msgMatch.ok && Array.isArray(msgMatch.data) && msgMatch.data.length > 0) {
      const taskId = msgMatch.data[0].task_id;
      const taskRes = await supabaseDbRequest('registration_tasks',
        'select=id,task_type,title,status&id=eq.' + encodeURIComponent(taskId) +
        '&status=in.(open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external)&limit=1');
      if (taskRes.ok && Array.isArray(taskRes.data) && taskRes.data.length > 0) {
        return { task: taskRes.data[0], confidence: 0.93, method: 'message_thread_match' };
      }
    }
  }

  // Signal 3: AI content matching against open tasks
  const openTasks = await supabaseDbRequest('registration_tasks',
    'select=id,task_type,title,description,status,related_document_key&case_id=eq.' + encodeURIComponent(caseId) +
    '&status=in.(open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external)&limit=20');
  if (!openTasks.ok || !Array.isArray(openTasks.data) || openTasks.data.length === 0) return null;

  return await aiMatchResponseToTask(emailMeta, openTasks.data);
}
```

- [ ] **Step 2: Add AI response-to-task matching**

```javascript
async function aiMatchResponseToTask(emailMeta, openTasks) {
  if (!process.env.ANTHROPIC_API_KEY || openTasks.length === 0) return null;
  const taskList = openTasks.map(t => ({ id: t.id, title: t.title, type: t.task_type, doc_key: t.related_document_key }));
  const prompt = [
    'An email/message was received. Match it to the most relevant open task, if any.',
    'Tasks: ' + JSON.stringify(taskList),
    'Message from: ' + String(emailMeta.sender || '').slice(0, 200),
    'Subject: ' + String(emailMeta.subject || '').slice(0, 300),
    'Body: ' + String(emailMeta.bodyText || '').slice(0, 3000),
    'Has attachments: ' + (emailMeta.hasAttachments ? 'yes' : 'no'),
    '',
    'Return JSON: {"matched_task_id": "uuid or null", "confidence": 0.0-1.0, "is_document_delivery": true/false, "reason": "brief explanation"}',
    'is_document_delivery = true if the message contains/references a document that fulfils the task requirement.',
    'is_document_delivery = false if the message is a question, acknowledgement, or conversation about the task.',
    'If no task matches well, return matched_task_id: null.'
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 300, temperature: 0,
        messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = data.content && data.content[0] ? data.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const result = JSON.parse(jsonMatch[0]);
    if (!result.matched_task_id) return null;
    const matchedTask = openTasks.find(t => t.id === result.matched_task_id);
    if (!matchedTask) return null;
    return { task: matchedTask, confidence: result.confidence || 0.5, method: 'ai_content_match', isDocumentDelivery: result.is_document_delivery || false };
  } catch (err) {
    console.error('[ResponseMatch] AI matching failed:', err.message);
    return null;
  }
}
```

- [ ] **Step 3: Integrate response matching into email triage flow**

In the `processGmailNotification` flow, after GP matching but BEFORE creating an email_triage task, attempt response matching:

1. Call `matchResponseToTask(gpCase.id, emailMeta)`
2. If matched with high confidence (>0.8):
   - If `isDocumentDelivery`: store as task_message with `is_document_delivery=true`, extract attachments into `task_documents`, flip task status to `open` (Hazel's ball)
   - If not document delivery: store as task_message (conversation update), do NOT flip status, but log a notification
3. If matched with medium confidence (0.5-0.8): store as task_message, flip status to `open` (Hazel reviews), set a flag "GP may have responded — review needed"
4. If low/no match: create standalone email_triage task with "May relate to" suggestions stored in description

- [ ] **Step 4: Add attachment extraction for matched responses**

When a response is matched as a document delivery, extract email attachments and store in `task_documents`:

```javascript
async function extractAndStoreAttachments(gmail, emailAddress, messageId, taskId, caseId, taskMessageId) {
  const msg = await gmail.users.messages.get({ userId: emailAddress, id: messageId, format: 'full' });
  const parts = msg.data.payload.parts || [];
  const docs = [];
  for (const part of parts) {
    if (part.filename && part.body && part.body.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: emailAddress, messageId: messageId, id: part.body.attachmentId
      });
      // Store attachment data (base64) — upload to Drive or store URL
      const doc = await supabaseDbRequest('task_documents', '', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: [{ task_id: taskId, case_id: caseId, message_id: taskMessageId,
          filename: part.filename, mime_type: part.mimeType, size_bytes: part.body.size || 0,
          uploaded_by: 'system', is_current: true }]
      });
      if (doc.ok && doc.data && doc.data[0]) docs.push(doc.data[0]);
    }
  }
  // Mark previous versions as not current
  if (docs.length > 0) {
    const newIds = docs.map(d => d.id);
    await supabaseDbRequest('task_documents',
      'task_id=eq.' + encodeURIComponent(taskId) + '&id=not.in.(' + newIds.join(',') + ')',
      { method: 'PATCH', body: { is_current: false } });
  }
  return docs;
}
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: auto-match incoming messages to open tasks

Thread matching (gmail_thread_id) used as strongest signal.
AI content analysis as fallback. Responses classified as document
delivery or conversation. Documents extracted and stored in
task_documents. Ball-with status updated based on classification."
```

---

## Task 8: Ops Queue UI — Stats Bar + Flat Table

**Files:**
- Modify: `pages/admin.html` — Replace stats bar, replace table columns, update sorting

**Context:**
- Current stats bar at line 3260 (`renderOpsStats`)
- Current table at line 3282 (`renderOpsTable`)
- Current filters use dropdowns (opsDomain, opsStatus, opsPriority, opsOverdue)
- Stats HTML is in the `<div class="ops-stats" id="opsStats">` container
- Filter bar HTML is around line 880-895

- [ ] **Step 1: Replace stats bar HTML and rendering**

Replace the filter dropdowns and old stats with clickable stat cards. Update `renderOpsStats()` to render:
- Open (blue) | Overdue (red) | Hazel's ball (blue) | GP's ball (amber) | Practice (purple) | Blocked (grey)

Each card is a clickable filter toggle. Clicking sets `S._opsStatFilter` and re-renders. Clicking again clears.

Remove the old dropdown filters (opsDomain, opsStatus, opsPriority, opsOverdue select/checkbox elements).

- [ ] **Step 2: Replace table columns**

Update `renderOpsTable()` to render 5 columns:
1. **GP** — clickable name linking to GP detail pane via `data-ops-view-case`
2. **Task** — title + subtitle (source context, app number, etc.)
3. **Ball with** — color-coded pill based on status mapping:
   - `open`/`in_progress` → "Hazel" (blue)
   - `waiting_on_gp` → "GP" (amber)
   - `waiting_on_practice` → "Practice" (purple)
   - `waiting_on_external` → "AHPRA" (teal)
   - `blocked` → "Blocked" (red)
   - `escalated` → "Escalated" (red)
4. **Due** — days left, color-coded: <=2 red, <=5 amber, "OVERDUE" when past
5. **Action** — contextual link based on task type and state

Priority as colored left border: red (urgent/overdue), amber (high), green (normal).

- [ ] **Step 3: Update sorting logic**

Sort tasks before rendering:
1. Overdue first (has due_date and due_date < now)
2. Then by days until due (ascending, nulls last)
3. Within same due urgency: Hazel's ball first (open/in_progress), then GP/Practice/AHPRA

- [ ] **Step 4: Update loadOpsQueue to use stat filter**

Replace the old filter logic with the new stat-card-based filtering. When `S._opsStatFilter` is set:
- 'overdue': add `&overdue=true`
- 'hazel': add `&status=open,in_progress`
- 'gp': add `&status=waiting_on_gp`
- 'practice': add `&status=waiting_on_practice`
- 'blocked': add `&status=blocked`
- null: use default (all active)

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: Ops Queue UI redesign — stats bar + flat table

Replaced dropdown filters with clickable stat cards (Open, Overdue,
Hazel's ball, GP's ball, Practice, Blocked). Table simplified to
5 columns: GP, Task, Ball with, Due, Action. Sorted by urgency.
Priority shown as colored left border."
```

---

## Task 9: Ops Queue — Inline Expand with Actions

**Files:**
- Modify: `pages/admin.html` — Add expanded row rendering with contextual content, email composer, revision composer, document preview

**Context:**
- Current expand is in `renderOpsTable` lines 3305-3328 — basic detail with editable fields
- Need to replace with rich contextual expand based on task type and state
- Must include: conversation thread from task_messages, document preview from task_documents, action buttons, email composer, revision composer

- [ ] **Step 1: Add task detail fetch on expand**

When a row is clicked and expanded, fetch additional data:
- `GET /api/admin/task/messages?taskId={id}` — fetch task_messages for conversation thread
- `GET /api/admin/task/documents?taskId={id}` — fetch task_documents for attachments

Add these two new API endpoints in server.js (simple Supabase selects).

- [ ] **Step 2: Render expanded row based on task type and state**

Create a `renderExpandedTask(task, messages, documents)` function that renders contextual content:

**For `practice_pack_child` tasks:**
- Initial state (no messages, ball with Hazel): show email composer pre-filled for practice
- Waiting on practice (has outbound message): show conversation thread + waiting indicator
- Response received (has inbound message with docs): show response banner + doc preview + action buttons (Submit to Drive & Complete / Upload Different Version / Request Revision)

**For `ahpra_action_item` tasks:**
- Initial state (ball with Hazel, no outbound): show original AHPRA email + Message GP button (green CTA)
- Waiting on GP (outbound sent): show conversation thread + waiting indicator
- GP responded with doc: show response + doc preview + Email AHPRA Officer (green CTA) / Upload Different Version / Request Revision
- GP responded without doc (conversation): show thread, ball stays with GP, Hazel can reply

**For `email_triage` tasks:**
- Show email content, sender, subject
- If has "May relate to" suggestions: show suggestion cards with "Link to this task" buttons
- Mark Resolved button

- [ ] **Step 3: Build email composer component**

An inline email composer that appears when Hazel clicks "Email Practice", "Email AHPRA Officer", etc:

```html
<div class="ops-email-composer" data-task-id="...">
  <div class="email-field"><label>To:</label><input type="text" data-email="to" value="..." /></div>
  <div class="email-field"><label>CC:</label><input type="text" data-email="cc" value="..." /></div>
  <div class="email-field"><label>Subject:</label><input type="text" data-email="subject" value="..." /></div>
  <div class="email-body" contenteditable="true">Pre-filled body...</div>
  <div class="email-attachments"><!-- attachment chips --></div>
  <div class="email-actions">
    <button class="btn primary" data-send-email="...">Send & Complete Task</button>
    <button class="btn" data-cancel-compose>Cancel</button>
  </div>
</div>
```

Pre-fill logic per context:
- Practice initial request: To=practice contact, Subject="[Doc] needed for Dr [GP] — GP Link", Body=request template
- AHPRA officer reply: To=officer email, CC=GP email, Subject="Re: [original subject]", Body=professional response with attachment list, threadId from task
- Revision to GP/practice: reply on same thread

On "Send": POST to `/api/admin/email/send`, then update task status and refresh.

- [ ] **Step 4: Build revision composer component**

Similar to email composer but simpler — text area for notes + channel indicator:

```html
<div class="ops-revision-composer" data-task-id="...">
  <div class="revision-channel"><span class="channel-badge">Email</span> Replying on same thread</div>
  <textarea placeholder="Write revision notes..."></textarea>
  <button class="btn danger" data-send-revision="...">Send Revision Request</button>
</div>
```

Channel auto-detected from the last inbound message on the task (email → email, whatsapp → whatsapp).

On send: POST to `/api/admin/email/send` or `/api/admin/whatsapp/send`, flip task status back to waiting_on_gp/waiting_on_practice.

- [ ] **Step 5: Build document preview component**

Show attached documents with filename, size, preview link, and version indicator:
- Current version: prominent, with Preview link (opens in new tab)
- Previous versions: dimmed, labelled "Previous version"

For practice pack tasks: "Submit to Drive & Complete" button uploads current doc via existing Google Drive integration, updates GP's state, completes task.

- [ ] **Step 6: Wire up action button event handlers**

Add event delegation for all action buttons:
- `data-send-email`: collect composer fields, POST to /api/admin/email/send, update task, refresh
- `data-send-revision`: collect revision text, determine channel, send via email or whatsapp API, flip status
- `data-submit-drive`: upload current document to GP's Google Drive folder, update My Documents state, complete task
- `data-upload-own`: show file picker, upload to task_documents as new version
- `data-message-gp`: show WhatsApp/email composer for GP, send via /api/admin/whatsapp/send or /api/admin/email/send
- `data-link-to-task`: link standalone email_triage to target task (merge messages/docs, close standalone)

- [ ] **Step 7: Add Message GP flow for AHPRA action items**

When Hazel clicks "Message GP" on an AHPRA action item (initial state), show a composer that:
- Defaults to WhatsApp (with toggle to email)
- Pre-fills message explaining what AHPRA needs in plain language
- On send: creates task_message (outbound, whatsapp/email), flips task to waiting_on_gp

- [ ] **Step 8: Commit**

```bash
git add server.js pages/admin.html
git commit -m "feat: Ops Queue inline expand with full task workflows

Expanded rows show contextual content per task type: conversation thread,
document preview, email/revision composers. Email Practice, Email AHPRA
Officer, Message GP, Submit to Drive, Request Revision all functional.
Responses auto-preview with action buttons."
```

---

## Task 10: Overdue Auto-Escalation to CEO Dashboard

**Files:**
- Modify: `server.js` — Add overdue check in the daily cron/weekly sweep, auto-escalate tasks 3 days past due

**Context:**
- Weekly sweep cron exists (creates chase tasks for stalled GPs) — around line 24610
- CEO dashboard escalation infrastructure exists (escalated_to, escalated_reason, escalated_at columns)
- Tasks with status 'escalated' already show in CEO dashboard

- [ ] **Step 1: Add overdue escalation logic to daily/weekly sweep**

In the existing sweep logic, add a check for tasks that are 3+ days overdue:

```javascript
// Auto-escalate tasks 3+ days past due
const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
const overdueRes = await supabaseDbRequest('registration_tasks',
  'select=id,case_id,title,due_date&status=in.(open,in_progress,waiting_on_gp,waiting_on_practice,waiting_on_external)' +
  '&due_date=lt.' + encodeURIComponent(threeDaysAgo) + '&limit=50');
if (overdueRes.ok && Array.isArray(overdueRes.data)) {
  for (const t of overdueRes.data) {
    const daysOverdue = Math.floor((Date.now() - new Date(t.due_date).getTime()) / 86400000);
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(t.id), {
      method: 'PATCH', body: { status: 'escalated', escalated_reason: 'Auto-escalated: ' + daysOverdue + ' days overdue', escalated_at: new Date().toISOString() }
    });
    await _logCaseEvent(t.case_id, t.id, 'escalation', 'Task auto-escalated — ' + daysOverdue + ' days overdue', t.title, 'system');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: auto-escalate tasks to CEO dashboard when 3+ days overdue"
```

---

## Task 11: GP Profile Timeline Tab

**Files:**
- Modify: `pages/admin.html` — Add Timeline sub-nav tab on GP detail pane, render chronological history
- Modify: `server.js` — Add `/api/admin/case/timeline` endpoint if not already sufficient

**Context:**
- GP detail pane has sub-nav tabs: Tasks, Notes, Documents (around line 1917-1920 in admin.html)
- Task timeline data already exists in `task_timeline` table
- task_messages table (new) contains conversation history
- Need to merge both into a chronological timeline view

- [ ] **Step 1: Add Timeline tab to GP detail pane sub-nav**

Add a "Timeline" tab alongside Tasks / Notes / Documents in the sub-nav HTML.

- [ ] **Step 2: Add timeline rendering function**

Create `renderGpTimeline(caseId)` that:
1. Fetches from task_timeline: `select=*&case_id=eq.{caseId}&order=created_at.desc&limit=100`
2. Fetches from task_messages: `select=*&case_id=eq.{caseId}&order=created_at.desc&limit=100`
3. Merges into one chronological list
4. Renders each entry as a timeline card showing: timestamp, event type icon, title, detail, actor
5. Groups by date for readability
6. For completed tasks: show full conversation thread expandable
7. For emails sent: show recipient, subject, attachment count
8. For documents uploaded: show filename, destination

- [ ] **Step 3: Style the timeline**

Vertical timeline with date separators, event type icons (email sent, doc uploaded, task completed, stage change, escalation), and expandable detail for each entry.

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html server.js
git commit -m "feat: GP Profile Timeline tab showing completed task history

New Timeline sub-nav on GP detail pane. Shows chronological history
of all task activity: emails sent, documents uploaded, revisions
requested, task completions, stage changes. Merged from task_timeline
and task_messages tables."
```

---

## Task 12: Integration Testing & Deploy

**Files:**
- Modify: `server.js`, `pages/admin.html` — Bug fixes from testing

- [ ] **Step 1: Test practice pack flow end-to-end**

1. Trigger career_secured for a test GP
2. Verify 3 active practice pack tasks created (Position Description, Offer/Contract, Supervisor CV) + 2 deferred (SPPA-00, Section G)
3. Open Ops Queue — verify tasks appear with "Ball with: Hazel", 4-week due dates
4. Expand a task — verify email composer appears with practice contact pre-filled
5. Send test email to practice — verify task flips to "Ball with: Practice"
6. Simulate practice response (send email to monitored inbox) — verify auto-match, doc preview appears
7. Click "Submit to Drive & Complete" — verify doc uploads to Drive, task completes, disappears from queue

- [ ] **Step 2: Test AHPRA action item flow end-to-end**

1. Send a test email to monitored inbox from a fake @ahpra.gov.au address (or use real example)
2. Verify GP matching works (CC the GP's email)
3. Verify AHPRA metadata stored on case (application number, officer name/email)
4. Verify action items extracted and tasks created with 10-day due dates
5. Expand task — verify original email shown, "Message GP" button (green CTA)
6. Send message to GP via WhatsApp — verify task flips to "Ball with: GP"
7. Simulate GP response with attachment — verify auto-match, doc preview, "Email AHPRA Officer" button
8. Click "Email AHPRA Officer" — verify pre-filled reply, send, doc uploads to Drive AHPRA folder, task completes

- [ ] **Step 3: Test response matching edge cases**

1. GP sends question (no attachment) — verify it attaches as conversation, ball stays with GP
2. GP sends wrong document — verify Hazel can request revision, ball flips back to GP
3. Practice sends vague email — verify fallback to email_triage with "May relate to" suggestions
4. Manual linking — verify "Link to this task" merges content and closes standalone task

- [ ] **Step 4: Test Ops Queue UI**

1. Verify stats bar counts are correct
2. Click each stat card — verify filtering works
3. Verify sorting: overdue first, then by due date, then Hazel's ball first
4. Verify expanded rows render correctly for each task type
5. Verify GP name links navigate to GP detail pane
6. Verify Timeline tab shows completed task history

- [ ] **Step 5: Test cleanup**

1. Verify no MyIntealth/AMC verify tasks are created on state transitions
2. Verify no kickoff tasks created on admin sync
3. Verify Section G auto-completes when GP reaches AHPRA stage
4. Verify SPPA-00 stays deferred and doesn't appear in Ops Queue

- [ ] **Step 6: Deploy**

```bash
git push
vercel --prod --yes
```

- [ ] **Step 7: Verify in production**

Open https://app.mygplink.com.au/pages/admin.html and verify:
- Ops Queue renders with new stats bar and flat table
- Existing tasks display correctly with ball-with pills
- Inline expand works
- No regressions in GP detail pane, support tab, or other admin features

---

## Dependency Graph

```
Task 1 (DB migrations)
  ├── Task 2 (Gmail send) ──────────┐
  ├── Task 3 (WhatsApp send) ───────┤
  ├── Task 4 (Cleanup) ────────────┤
  ├── Task 5 (AHPRA GP matching) ──┤
  │     └── Task 6 (Action items) ──┤
  │           └── Task 7 (Response matching) ──┐
  ├── Task 8 (Ops Queue UI) ───────────────────┤
  │     └── Task 9 (Inline expand) ────────────┤
  ├── Task 10 (Overdue escalation) ────────────┤
  └── Task 11 (GP Timeline) ──────────────────┤
                                                └── Task 12 (Integration testing)
```

Tasks 2, 3, 4, 5, 8, 10, 11 can be parallelized after Task 1. Tasks 6 depends on 5. Task 7 depends on 6. Task 9 depends on 2, 3, 7, 8. Task 12 depends on all.
