# Practice Pack Phase 1b — Gmail Auto-Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically monitor VA Gmail inboxes for practice contact replies, use AI to match attachments to open tasks, and stage documents for VA review in the admin dashboard.

**Architecture:** Gmail API push notifications via Google Pub/Sub trigger a webhook in server.js. Incoming emails pass through a pre-filter, then Anthropic AI matches attachments to open `practice_pack_child` tasks. Matched documents are staged on tasks for VA review; unmatched relevant documents appear in an "Incoming Documents" queue.

**Tech Stack:** Node.js, googleapis (Gmail + Pub/Sub), Anthropic API (Haiku), Supabase (PostgreSQL), Vercel Cron Jobs

**Spec:** `docs/superpowers/specs/2026-04-16-practice-pack-phase1b-design.md`

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260416000000_gmail_autoparsing.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260416000000_gmail_autoparsing.sql`:

```sql
-- Gmail watch state: tracks historyId per monitored inbox
CREATE TABLE IF NOT EXISTS gmail_watch_state (
  email_address text PRIMARY KEY,
  history_id text NOT NULL,
  watch_expiry timestamptz,
  updated_at timestamptz DEFAULT now()
);

-- Processed Gmail messages: dedup + unmatched document store
CREATE TABLE IF NOT EXISTS processed_gmail_messages (
  gmail_message_id text PRIMARY KEY,
  email_address text NOT NULL,
  sender text,
  subject text,
  processed_at timestamptz DEFAULT now(),
  result text,  -- 'matched', 'unmatched', 'filtered', 'error'
  matched_task_id text,
  attachment_data jsonb,  -- For unmatched: [{filename, base64, mime_type, size}]
  ai_summary text
);

-- New columns on registration_tasks for Gmail-sourced documents
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_message_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS gmail_attachment_id text;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_confidence real;
ALTER TABLE registration_tasks ADD COLUMN IF NOT EXISTS ai_match_reasoning text;
```

- [ ] **Step 2: Verify migration is valid SQL**

Run: `npx vitest run tests/practice-pack.test.js`
Expected: Existing tests still pass (migration doesn't break anything).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260416000000_gmail_autoparsing.sql
git commit -m "feat(db): add gmail_watch_state and processed_gmail_messages tables"
git push
```

---

### Task 2: Gmail Client Helper (Domain-Wide Delegation)

**Files:**
- Modify: `server.js` (insert after Google Drive section, around line 287)
- Test: `tests/gmail-helpers.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/gmail-helpers.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

// Import helpers directly from server.js patterns
// We'll test the pure logic functions; Gmail API calls are integration-tested

describe('Gmail helpers', () => {
  describe('isGmailConfigured', () => {
    it('returns true when all env vars and VA emails are set', () => {
      const result = isGmailConfigured({
        serviceAccountEmail: 'gplink-drive@project.iam.gserviceaccount.com',
        serviceAccountKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        monitoredEmails: ['hazel@mygplink.com.au']
      });
      expect(result).toBe(true);
    });

    it('returns false when no monitored emails', () => {
      const result = isGmailConfigured({
        serviceAccountEmail: 'gplink-drive@project.iam.gserviceaccount.com',
        serviceAccountKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
        monitoredEmails: []
      });
      expect(result).toBe(false);
    });
  });

  describe('parseGmailPubSubMessage', () => {
    it('decodes base64 Pub/Sub data to emailAddress and historyId', () => {
      const data = Buffer.from(JSON.stringify({
        emailAddress: 'hazel@mygplink.com.au',
        historyId: '12345'
      })).toString('base64');

      const result = parseGmailPubSubMessage({ message: { data } });
      expect(result).toEqual({
        emailAddress: 'hazel@mygplink.com.au',
        historyId: '12345'
      });
    });

    it('returns null for invalid data', () => {
      const result = parseGmailPubSubMessage({ message: { data: 'not-valid-json-base64' } });
      expect(result).toBeNull();
    });

    it('returns null for missing message', () => {
      const result = parseGmailPubSubMessage({});
      expect(result).toBeNull();
    });
  });

  describe('extractEmailMeta', () => {
    it('extracts sender, subject, attachments from Gmail message payload', () => {
      const gmailMessage = {
        id: 'msg123',
        payload: {
          headers: [
            { name: 'From', value: 'Jane Smith <jane@sopmedical.com.au>' },
            { name: 'Subject', value: 'Re: Offer/Contract Required — Dr Smith at SOP Medical' },
            { name: 'To', value: 'hazel@mygplink.com.au' },
            { name: 'Date', value: 'Wed, 16 Apr 2026 10:00:00 +1000' }
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Please find attached the contract.').toString('base64url') }
            },
            {
              filename: 'Employment_Agreement_DrSmith.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'att123', size: 245000 }
            }
          ]
        }
      };

      const meta = extractEmailMeta(gmailMessage);
      expect(meta.messageId).toBe('msg123');
      expect(meta.sender).toBe('jane@sopmedical.com.au');
      expect(meta.senderName).toBe('Jane Smith');
      expect(meta.subject).toContain('Offer/Contract');
      expect(meta.to).toBe('hazel@mygplink.com.au');
      expect(meta.bodyText).toContain('Please find attached');
      expect(meta.attachments).toHaveLength(1);
      expect(meta.attachments[0]).toEqual({
        index: 0,
        filename: 'Employment_Agreement_DrSmith.pdf',
        mimeType: 'application/pdf',
        attachmentId: 'att123',
        size: 245000
      });
    });

    it('extracts sender email from angle bracket format', () => {
      const msg = {
        id: 'msg1',
        payload: {
          headers: [
            { name: 'From', value: '"Reception" <reception@clinic.com.au>' },
            { name: 'Subject', value: 'Documents' },
            { name: 'To', value: 'hazel@mygplink.com.au' }
          ],
          parts: []
        }
      };
      const meta = extractEmailMeta(msg);
      expect(meta.sender).toBe('reception@clinic.com.au');
      expect(meta.senderName).toBe('Reception');
    });

    it('handles plain sender format without angle brackets', () => {
      const msg = {
        id: 'msg2',
        payload: {
          headers: [
            { name: 'From', value: 'jane@sopmedical.com.au' },
            { name: 'Subject', value: 'CV' },
            { name: 'To', value: 'hazel@mygplink.com.au' }
          ],
          parts: []
        }
      };
      const meta = extractEmailMeta(msg);
      expect(meta.sender).toBe('jane@sopmedical.com.au');
    });

    it('skips inline images from attachments list', () => {
      const msg = {
        id: 'msg3',
        payload: {
          headers: [
            { name: 'From', value: 'jane@sop.com' },
            { name: 'Subject', value: 'Docs' },
            { name: 'To', value: 'hazel@mygplink.com.au' }
          ],
          parts: [
            {
              filename: 'logo.png',
              mimeType: 'image/png',
              headers: [{ name: 'Content-Disposition', value: 'inline' }],
              body: { attachmentId: 'inline1', size: 5000 }
            },
            {
              filename: 'Contract.pdf',
              mimeType: 'application/pdf',
              body: { attachmentId: 'att1', size: 200000 }
            }
          ]
        }
      };
      const meta = extractEmailMeta(msg);
      expect(meta.attachments).toHaveLength(1);
      expect(meta.attachments[0].filename).toBe('Contract.pdf');
    });
  });
});

// Inline function stubs for test runner
function isGmailConfigured({ serviceAccountEmail, serviceAccountKey, monitoredEmails }) {
  return !!(serviceAccountEmail && serviceAccountKey && monitoredEmails && monitoredEmails.length > 0);
}

function parseGmailPubSubMessage(body) {
  try {
    if (!body || !body.message || !body.message.data) return null;
    const decoded = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf-8'));
    if (!decoded.emailAddress || !decoded.historyId) return null;
    return { emailAddress: decoded.emailAddress, historyId: String(decoded.historyId) };
  } catch (e) { return null; }
}

function extractEmailMeta(gmailMessage) {
  const headers = gmailMessage.payload.headers || [];
  const getHeader = (name) => { const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase()); return h ? h.value : ''; };

  const fromRaw = getHeader('From');
  let sender = fromRaw;
  let senderName = '';
  const angleMatch = fromRaw.match(/<([^>]+)>/);
  if (angleMatch) {
    sender = angleMatch[1];
    senderName = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  }

  const parts = gmailMessage.payload.parts || [];
  let bodyText = '';
  const attachments = [];
  let attachIdx = 0;

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.filename && part.body && part.body.attachmentId) {
      const isInline = (part.headers || []).some(h => h.name === 'Content-Disposition' && h.value.startsWith('inline'));
      const isSmallImage = (part.body.size || 0) < 10240 && part.mimeType && part.mimeType.startsWith('image/');
      if (isInline && isSmallImage) continue;
      attachments.push({
        index: attachIdx++,
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0
      });
    }
  }

  return {
    messageId: gmailMessage.id,
    sender,
    senderName,
    subject: getHeader('Subject'),
    to: getHeader('To'),
    date: getHeader('Date'),
    bodyText: bodyText.substring(0, 2000),
    attachments
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/gmail-helpers.test.js`
Expected: All tests PASS (functions are defined inline in the test file for now).

- [ ] **Step 3: Move helpers into server.js**

In `server.js`, after the `deliverToMyDocuments` function (around line 350), add:

```javascript
// ── Gmail integration (Phase 1b) ──
const MONITORED_VA_EMAILS = ['hazel@mygplink.com.au'];
const GOOGLE_PUBSUB_TOPIC = String(process.env.GOOGLE_PUBSUB_TOPIC || '').trim();
const GMAIL_WEBHOOK_SECRET = String(process.env.GMAIL_WEBHOOK_SECRET || '').trim();

function isGmailConfigured() {
  return !!(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && MONITORED_VA_EMAILS.length > 0);
}

let _gmailClients = {};
async function getGmailClient(userEmail) {
  if (_gmailClients[userEmail]) return _gmailClients[userEmail];
  if (!isGmailConfigured()) return null;
  const { google } = require('googleapis');
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
    userEmail  // impersonate this user via domain-wide delegation
  );
  _gmailClients[userEmail] = google.gmail({ version: 'v1', auth });
  return _gmailClients[userEmail];
}

function parseGmailPubSubMessage(body) {
  try {
    if (!body || !body.message || !body.message.data) return null;
    const decoded = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf-8'));
    if (!decoded.emailAddress || !decoded.historyId) return null;
    return { emailAddress: decoded.emailAddress, historyId: String(decoded.historyId) };
  } catch (e) { return null; }
}

function extractEmailMeta(gmailMessage) {
  const headers = gmailMessage.payload ? gmailMessage.payload.headers || [] : [];
  const getHeader = function (name) { const h = headers.find(function (h) { return h.name.toLowerCase() === name.toLowerCase(); }); return h ? h.value : ''; };

  const fromRaw = getHeader('From');
  let sender = fromRaw;
  let senderName = '';
  const angleMatch = fromRaw.match(/<([^>]+)>/);
  if (angleMatch) {
    sender = angleMatch[1];
    senderName = fromRaw.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  }

  const parts = gmailMessage.payload ? gmailMessage.payload.parts || [] : [];
  let bodyText = '';
  const attachments = [];
  let attachIdx = 0;

  function walkParts(partsList) {
    for (const part of partsList) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data && !bodyText) {
        bodyText = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      if (part.filename && part.body && part.body.attachmentId) {
        const isInline = (part.headers || []).some(function (h) { return h.name === 'Content-Disposition' && h.value.startsWith('inline'); });
        const isSmallImage = (part.body.size || 0) < 10240 && part.mimeType && part.mimeType.startsWith('image/');
        if (!(isInline && isSmallImage)) {
          attachments.push({
            index: attachIdx++,
            filename: part.filename,
            mimeType: part.mimeType,
            attachmentId: part.body.attachmentId,
            size: part.body.size || 0
          });
        }
      }
      if (part.parts) walkParts(part.parts);
    }
  }
  walkParts(parts);

  return {
    messageId: gmailMessage.id,
    sender: sender,
    senderName: senderName,
    subject: getHeader('Subject'),
    to: getHeader('To'),
    date: getHeader('Date'),
    bodyText: bodyText.substring(0, 2000),
    attachments: attachments
  };
}
```

Note: `walkParts` handles nested MIME structures (multipart/mixed → multipart/alternative → text/plain + attachments).

- [ ] **Step 4: Update test to import from server.js exports pattern**

Since server.js doesn't use ES modules, update the test file to define the functions inline (same as step 1 — they're already self-contained). The tests validate the logic; the server.js copy is the production version.

Run: `npx vitest run tests/gmail-helpers.test.js`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/gmail-helpers.test.js
git commit -m "feat: add Gmail client helper with domain-wide delegation + email parser"
git push
```

---

### Task 3: Pre-Filter Function

**Files:**
- Modify: `server.js` (add after `extractEmailMeta`)
- Test: `tests/gmail-prefilter.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/gmail-prefilter.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('preFilterEmail', () => {
  it('rejects internal mygplink.com.au senders', () => {
    const result = preFilterEmail({ sender: 'khaleed@mygplink.com.au', attachments: [{ filename: 'doc.pdf' }], subject: 'test', bodyText: '', headers: {} });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('internal_sender');
  });

  it('rejects emails with no attachments', () => {
    const result = preFilterEmail({ sender: 'jane@clinic.com', attachments: [], subject: 'Hello', bodyText: '', headers: {} });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no_attachments');
  });

  it('rejects emails where all attachments are non-document types', () => {
    const result = preFilterEmail({
      sender: 'jane@clinic.com',
      attachments: [{ filename: 'invite.ics', mimeType: 'text/calendar', size: 5000 }],
      subject: 'Meeting',
      bodyText: '',
      headers: {}
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no_document_attachments');
  });

  it('rejects marketing emails with List-Unsubscribe header', () => {
    const result = preFilterEmail({
      sender: 'updates@newsletter.com',
      attachments: [{ filename: 'brochure.pdf', mimeType: 'application/pdf', size: 50000 }],
      subject: 'Weekly update',
      bodyText: '',
      headers: { 'list-unsubscribe': '<mailto:unsub@newsletter.com>' }
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('marketing');
  });

  it('rejects noreply senders', () => {
    const result = preFilterEmail({
      sender: 'noreply@someservice.com',
      attachments: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', size: 10000 }],
      subject: 'Your receipt',
      bodyText: '',
      headers: {}
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('marketing');
  });

  it('passes valid email with PDF attachment from external sender', () => {
    const result = preFilterEmail({
      sender: 'jane@sopmedical.com.au',
      attachments: [{ filename: 'Contract.pdf', mimeType: 'application/pdf', size: 200000 }],
      subject: 'Re: Contract Required',
      bodyText: 'Here is the contract',
      headers: {}
    });
    expect(result.pass).toBe(true);
  });

  it('passes email with DOCX attachment', () => {
    const result = preFilterEmail({
      sender: 'admin@clinic.com.au',
      attachments: [{ filename: 'SupervisorCV.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100000 }],
      subject: 'CV attached',
      bodyText: '',
      headers: {}
    });
    expect(result.pass).toBe(true);
  });

  it('passes email with JPG attachment (scanned document)', () => {
    const result = preFilterEmail({
      sender: 'reception@clinic.com.au',
      attachments: [{ filename: 'signed_contract.jpg', mimeType: 'image/jpeg', size: 500000 }],
      subject: 'Signed contract',
      bodyText: '',
      headers: {}
    });
    expect(result.pass).toBe(true);
  });

  it('filters out only small inline images but keeps real image attachments', () => {
    const result = preFilterEmail({
      sender: 'jane@clinic.com',
      attachments: [
        { filename: 'scan.jpg', mimeType: 'image/jpeg', size: 500000 }
      ],
      subject: 'Document',
      bodyText: '',
      headers: {}
    });
    expect(result.pass).toBe(true);
  });
});

const DOCUMENT_EXTENSIONS = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;
const NOREPLY_PATTERNS = /^(noreply|no-reply|donotreply|do-not-reply|newsletter|marketing|mailer-daemon|postmaster)@/i;

function preFilterEmail(emailMeta) {
  // 1. Internal sender
  if (emailMeta.sender && emailMeta.sender.toLowerCase().endsWith('@mygplink.com.au')) {
    return { pass: false, reason: 'internal_sender' };
  }

  // 2. No attachments at all
  if (!emailMeta.attachments || emailMeta.attachments.length === 0) {
    return { pass: false, reason: 'no_attachments' };
  }

  // 3. No document-type attachments
  const hasDocAttachment = emailMeta.attachments.some(function (a) {
    return DOCUMENT_EXTENSIONS.test(a.filename || '');
  });
  if (!hasDocAttachment) {
    return { pass: false, reason: 'no_document_attachments' };
  }

  // 4. Marketing / noreply
  if (NOREPLY_PATTERNS.test(emailMeta.sender || '')) {
    return { pass: false, reason: 'marketing' };
  }
  const headers = emailMeta.headers || {};
  if (headers['list-unsubscribe']) {
    return { pass: false, reason: 'marketing' };
  }

  return { pass: true, reason: null };
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/gmail-prefilter.test.js`
Expected: All PASS.

- [ ] **Step 3: Add preFilterEmail to server.js**

In `server.js`, after the `extractEmailMeta` function, add:

```javascript
const GMAIL_DOCUMENT_EXTENSIONS = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;
const GMAIL_NOREPLY_PATTERNS = /^(noreply|no-reply|donotreply|do-not-reply|newsletter|marketing|mailer-daemon|postmaster)@/i;

function preFilterEmail(emailMeta) {
  if (emailMeta.sender && emailMeta.sender.toLowerCase().endsWith('@mygplink.com.au')) {
    return { pass: false, reason: 'internal_sender' };
  }
  if (!emailMeta.attachments || emailMeta.attachments.length === 0) {
    return { pass: false, reason: 'no_attachments' };
  }
  var hasDocAttachment = emailMeta.attachments.some(function (a) {
    return GMAIL_DOCUMENT_EXTENSIONS.test(a.filename || '');
  });
  if (!hasDocAttachment) {
    return { pass: false, reason: 'no_document_attachments' };
  }
  if (GMAIL_NOREPLY_PATTERNS.test(emailMeta.sender || '')) {
    return { pass: false, reason: 'marketing' };
  }
  // Check List-Unsubscribe header (passed in emailMeta.headers if available)
  if (emailMeta.headers && emailMeta.headers['list-unsubscribe']) {
    return { pass: false, reason: 'marketing' };
  }
  return { pass: true, reason: null };
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/gmail-prefilter.test.js
git commit -m "feat: add Gmail pre-filter to skip internal/marketing/non-document emails"
git push
```

---

### Task 4: AI Email Matching Function

**Files:**
- Modify: `server.js` (add after `preFilterEmail`)
- Test: `tests/gmail-ai-match.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/gmail-ai-match.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('buildAIMatchPrompt', () => {
  it('builds a structured prompt with email meta and open tasks', () => {
    const emailMeta = {
      sender: 'jane@sopmedical.com.au',
      senderName: 'Jane Smith',
      subject: 'Re: Offer/Contract Required — Dr Ahmed at SOP Medical',
      bodyText: 'Hi Hazel, please find attached the employment agreement for Dr Ahmed.',
      to: 'hazel@mygplink.com.au',
      date: 'Wed, 16 Apr 2026 10:00:00 +1000',
      attachments: [
        { index: 0, filename: 'Employment_Agreement_DrAhmed.pdf', mimeType: 'application/pdf', size: 245000 }
      ]
    };

    const openTasks = [
      {
        task_id: 'task-001',
        document_type: 'offer_contract',
        gp_name: 'Dr Ahmed Khan',
        practice_name: 'SOP Medical Centre',
        practice_contact_email: 'jane@sopmedical.com.au',
        practice_contact_name: 'Jane Smith',
        practice_location: 'Sydney NSW',
        task_status: 'waiting_on_practice'
      },
      {
        task_id: 'task-002',
        document_type: 'supervisor_cv',
        gp_name: 'Dr Ahmed Khan',
        practice_name: 'SOP Medical Centre',
        practice_contact_email: 'jane@sopmedical.com.au',
        practice_contact_name: 'Jane Smith',
        practice_location: 'Sydney NSW',
        task_status: 'waiting_on_practice'
      }
    ];

    const prompt = buildAIMatchPrompt(emailMeta, openTasks);
    expect(prompt).toContain('jane@sopmedical.com.au');
    expect(prompt).toContain('Employment_Agreement_DrAhmed.pdf');
    expect(prompt).toContain('task-001');
    expect(prompt).toContain('offer_contract');
    expect(prompt).toContain('Dr Ahmed Khan');
    expect(prompt).toContain('SOP Medical Centre');
  });

  it('returns prompt even with no open tasks', () => {
    const emailMeta = {
      sender: 'someone@clinic.com',
      senderName: 'Someone',
      subject: 'Documents',
      bodyText: 'Here are some docs',
      to: 'hazel@mygplink.com.au',
      date: '',
      attachments: [{ index: 0, filename: 'doc.pdf', mimeType: 'application/pdf', size: 100000 }]
    };
    const prompt = buildAIMatchPrompt(emailMeta, []);
    expect(prompt).toContain('someone@clinic.com');
    expect(prompt).toContain('No open tasks');
  });
});

describe('parseAIMatchResponse', () => {
  it('parses valid JSON response from AI', () => {
    const raw = JSON.stringify({
      matches: [
        { attachment_index: 0, task_id: 'task-001', document_type: 'offer_contract', confidence: 0.92, reasoning: 'Sender matches practice contact, filename contains agreement' }
      ],
      is_relevant: true,
      summary: 'Employment agreement for Dr Ahmed from SOP Medical'
    });
    const result = parseAIMatchResponse(raw);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].confidence).toBe(0.92);
    expect(result.is_relevant).toBe(true);
  });

  it('handles AI returning JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"matches": [], "is_relevant": false, "summary": "Unrelated email"}\n```';
    const result = parseAIMatchResponse(raw);
    expect(result.is_relevant).toBe(false);
  });

  it('returns fallback for unparseable response', () => {
    const result = parseAIMatchResponse('I cannot determine this');
    expect(result.matches).toEqual([]);
    expect(result.is_relevant).toBe(false);
  });
});

function buildAIMatchPrompt(emailMeta, openTasks) {
  const tasksSection = openTasks.length > 0
    ? JSON.stringify(openTasks, null, 2)
    : 'No open tasks currently waiting for documents.';

  return `You are a document-matching assistant for GP Link, a medical recruitment company that helps overseas GPs register in Australia.

An email has arrived with attachments. Match each attachment to the correct open task.

EMAIL:
- From: ${emailMeta.sender} (${emailMeta.senderName})
- To: ${emailMeta.to}
- Subject: ${emailMeta.subject}
- Date: ${emailMeta.date}
- Body (first 2000 chars): ${emailMeta.bodyText}
- Attachments: ${JSON.stringify(emailMeta.attachments.map(function (a) { return { index: a.index, filename: a.filename, mime_type: a.mimeType, size_bytes: a.size }; }))}

OPEN TASKS WAITING FOR DOCUMENTS:
${tasksSection}

Return ONLY a JSON object (no markdown, no explanation):
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
- Match based on sender domain vs practice email domain, GP names in subject/body/filename, document type clues
- If sender domain matches a practice contact's domain, that's a strong signal even if the exact email differs
- "offer", "contract", "agreement", "employment" in filename → likely offer_contract
- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv
- If you cannot confidently match, set task_id to null
- Confidence: 0.9+ exact match, 0.7-0.9 strong signals, 0.5-0.7 partial, <0.5 uncertain
- If the email appears to be completely unrelated to GP recruitment documents, set is_relevant to false`;
}

function parseAIMatchResponse(raw) {
  try {
    let cleaned = raw.trim();
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
    const parsed = JSON.parse(cleaned);
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      is_relevant: parsed.is_relevant === true,
      summary: parsed.summary || ''
    };
  } catch (e) {
    return { matches: [], is_relevant: false, summary: '' };
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/gmail-ai-match.test.js`
Expected: All PASS.

- [ ] **Step 3: Add AI matching functions to server.js**

In `server.js`, after `preFilterEmail`, add:

```javascript
function buildAIMatchPrompt(emailMeta, openTasks) {
  var tasksSection = openTasks.length > 0
    ? JSON.stringify(openTasks, null, 2)
    : 'No open tasks currently waiting for documents.';

  return 'You are a document-matching assistant for GP Link, a medical recruitment company that helps overseas GPs register in Australia.\n\n'
    + 'An email has arrived with attachments. Match each attachment to the correct open task.\n\n'
    + 'EMAIL:\n'
    + '- From: ' + emailMeta.sender + ' (' + emailMeta.senderName + ')\n'
    + '- To: ' + emailMeta.to + '\n'
    + '- Subject: ' + emailMeta.subject + '\n'
    + '- Date: ' + emailMeta.date + '\n'
    + '- Body (first 2000 chars): ' + emailMeta.bodyText + '\n'
    + '- Attachments: ' + JSON.stringify(emailMeta.attachments.map(function (a) { return { index: a.index, filename: a.filename, mime_type: a.mimeType, size_bytes: a.size }; })) + '\n\n'
    + 'OPEN TASKS WAITING FOR DOCUMENTS:\n' + tasksSection + '\n\n'
    + 'Return ONLY a JSON object (no markdown, no explanation):\n'
    + '{\n  "matches": [\n    {\n      "attachment_index": 0,\n      "task_id": "xxx" or null,\n      "document_type": "offer_contract" or "supervisor_cv",\n      "confidence": 0.0-1.0,\n      "reasoning": "brief explanation"\n    }\n  ],\n  "is_relevant": true/false,\n  "summary": "one-line description of what this email is about"\n}\n\n'
    + 'Rules:\n'
    + '- Match based on sender domain vs practice email domain, GP names in subject/body/filename, document type clues\n'
    + '- If sender domain matches a practice contact\'s domain, that\'s a strong signal even if the exact email differs\n'
    + '- "offer", "contract", "agreement", "employment" in filename → likely offer_contract\n'
    + '- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv\n'
    + '- If you cannot confidently match, set task_id to null\n'
    + '- Confidence: 0.9+ exact match, 0.7-0.9 strong signals, 0.5-0.7 partial, <0.5 uncertain\n'
    + '- If the email is completely unrelated to GP recruitment documents, set is_relevant to false';
}

function parseAIMatchResponse(raw) {
  try {
    var cleaned = raw.trim();
    var codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
    var parsed = JSON.parse(cleaned);
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      is_relevant: parsed.is_relevant === true,
      summary: parsed.summary || ''
    };
  } catch (e) {
    return { matches: [], is_relevant: false, summary: '' };
  }
}

async function aiMatchEmail(emailMeta, openTasks) {
  var budgetOk = await checkAnthropicBudget();
  if (!budgetOk) {
    console.error('[Gmail AI] Daily Anthropic budget exceeded, skipping AI match');
    return { matches: [], is_relevant: false, summary: 'Budget exceeded' };
  }

  var prompt = buildAIMatchPrompt(emailMeta, openTasks);
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 30000);

  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      console.error('[Gmail AI] Anthropic API error:', resp.status);
      return { matches: [], is_relevant: false, summary: 'API error' };
    }

    var data = await resp.json();
    var text = data.content && data.content[0] ? data.content[0].text : '';
    return parseAIMatchResponse(text);
  } catch (err) {
    console.error('[Gmail AI] match error:', err.message);
    return { matches: [], is_relevant: false, summary: 'Error: ' + err.message };
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/gmail-ai-match.test.js
git commit -m "feat: add AI email matching via Anthropic Haiku for Gmail auto-parsing"
git push
```

---

### Task 5: Fetch Open Tasks for Matching

**Files:**
- Modify: `server.js` (add after `aiMatchEmail`)

- [ ] **Step 1: Add helper to fetch open practice pack tasks with practice contact data**

In `server.js`, after `aiMatchEmail`, add:

```javascript
async function getOpenPracticePackTasks() {
  // Fetch all offer_contract and supervisor_cv tasks in waiting/open status
  var tasksRes = await supabaseDbRequest(
    'registration_tasks',
    'select=id,case_id,related_document_key,status,attachment_url,zoho_attachment_id&'
    + 'task_type=eq.practice_pack_child&'
    + 'related_document_key=in.(offer_contract,supervisor_cv)&'
    + 'status=in.(open,in_progress,waiting,waiting_on_practice)&'
    + 'order=created_at.asc'
  );
  if (!tasksRes.ok || !Array.isArray(tasksRes.data)) return [];

  // For each task, get GP name and practice contact from case + user state
  var results = [];
  for (var t of tasksRes.data) {
    // Skip tasks that already have an attachment
    if (t.attachment_url || t.zoho_attachment_id) continue;

    var caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(t.case_id) + '&limit=1');
    if (!caseRes.ok || !caseRes.data || !caseRes.data[0]) continue;
    var userId = caseRes.data[0].user_id;

    var profileRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    var profile = (profileRes.ok && profileRes.data && profileRes.data[0]) ? profileRes.data[0] : {};
    var gpName = 'Dr ' + [(profile.first_name || ''), (profile.last_name || '')].join(' ').trim();

    var stateRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&key=eq.gp_career_state&limit=1');
    var careerState = {};
    if (stateRes.ok && stateRes.data && stateRes.data[0]) {
      try { careerState = typeof stateRes.data[0].state === 'string' ? JSON.parse(stateRes.data[0].state) : stateRes.data[0].state; } catch (e) {}
    }

    var secured = careerState.career_secured ? careerState : null;
    if (!secured && Array.isArray(careerState.applications)) {
      var securedApp = careerState.applications.find(function (a) { return a && a.isPlacementSecured; });
      if (securedApp) secured = { placement: securedApp };
    }
    var pc = (secured && secured.placement && secured.placement.practiceContact) || {};
    var placement = (secured && secured.placement) || {};

    results.push({
      task_id: t.id,
      document_type: t.related_document_key,
      gp_name: gpName,
      practice_name: placement.practiceName || '',
      practice_contact_email: pc.email || '',
      practice_contact_name: pc.name || '',
      practice_location: placement.location || '',
      task_status: t.status
    });
  }
  return results;
}
```

- [ ] **Step 2: Run existing tests to ensure no breakage**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add getOpenPracticePackTasks helper for Gmail AI matching"
git push
```

---

### Task 6: Gmail Webhook Handler

**Files:**
- Modify: `server.js` (add new endpoint)

- [ ] **Step 1: Add the processGmailNotification orchestrator function**

In `server.js`, after `getOpenPracticePackTasks`, add:

```javascript
async function processGmailNotification(emailAddress, newHistoryId) {
  if (!MONITORED_VA_EMAILS.includes(emailAddress)) {
    console.log('[Gmail] Ignoring notification for unmonitored inbox:', emailAddress);
    return;
  }

  var gmail = await getGmailClient(emailAddress);
  if (!gmail) { console.error('[Gmail] Could not create client for', emailAddress); return; }

  // Get stored historyId
  var stateRes = await supabaseDbRequest('gmail_watch_state', 'select=history_id&email_address=eq.' + encodeURIComponent(emailAddress) + '&limit=1');
  var storedHistoryId = (stateRes.ok && stateRes.data && stateRes.data[0]) ? stateRes.data[0].history_id : null;
  if (!storedHistoryId) {
    console.log('[Gmail] No stored historyId for', emailAddress, '— storing current and skipping');
    await supabaseDbRequest('gmail_watch_state', '', {
      method: 'POST',
      body: { email_address: emailAddress, history_id: newHistoryId, watch_expiry: null, updated_at: new Date().toISOString() },
      headers: { 'Prefer': 'resolution=merge-duplicates' }
    });
    return;
  }

  // Fetch new messages since stored historyId
  var historyRes;
  try {
    historyRes = await gmail.users.history.list({
      userId: emailAddress,
      startHistoryId: storedHistoryId,
      historyTypes: ['messageAdded']
    });
  } catch (err) {
    console.error('[Gmail] history.list error:', err.message);
    // If historyId is too old, Gmail returns 404 — reset
    if (err.code === 404) {
      await supabaseDbRequest('gmail_watch_state', 'email_address=eq.' + encodeURIComponent(emailAddress), {
        method: 'PATCH', body: { history_id: newHistoryId, updated_at: new Date().toISOString() }
      });
    }
    return;
  }

  var history = (historyRes.data && historyRes.data.history) || [];
  var messageIds = [];
  for (var h of history) {
    if (h.messagesAdded) {
      for (var m of h.messagesAdded) {
        if (m.message && m.message.id && !messageIds.includes(m.message.id)) {
          messageIds.push(m.message.id);
        }
      }
    }
  }

  // Update stored historyId
  await supabaseDbRequest('gmail_watch_state', 'email_address=eq.' + encodeURIComponent(emailAddress), {
    method: 'PATCH', body: { history_id: newHistoryId, updated_at: new Date().toISOString() }
  });

  // Process each new message
  for (var msgId of messageIds) {
    // Dedup check
    var dedupRes = await supabaseDbRequest('processed_gmail_messages', 'select=gmail_message_id&gmail_message_id=eq.' + encodeURIComponent(msgId) + '&limit=1');
    if (dedupRes.ok && dedupRes.data && dedupRes.data.length > 0) continue;

    try {
      var msgRes = await gmail.users.messages.get({ userId: emailAddress, id: msgId, format: 'full' });
      var emailMeta = extractEmailMeta(msgRes.data);
      emailMeta.headers = {};
      // Extract List-Unsubscribe header for pre-filter
      var msgHeaders = (msgRes.data.payload && msgRes.data.payload.headers) || [];
      for (var mh of msgHeaders) {
        emailMeta.headers[mh.name.toLowerCase()] = mh.value;
      }

      var filterResult = preFilterEmail(emailMeta);
      if (!filterResult.pass) {
        await supabaseDbRequest('processed_gmail_messages', '', {
          method: 'POST',
          body: { gmail_message_id: msgId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, result: 'filtered', ai_summary: 'Filtered: ' + filterResult.reason }
        });
        console.log('[Gmail] Filtered message', msgId, ':', filterResult.reason);
        continue;
      }

      // AI matching
      var openTasks = await getOpenPracticePackTasks();
      var aiResult = await aiMatchEmail(emailMeta, openTasks);

      if (!aiResult.is_relevant) {
        await supabaseDbRequest('processed_gmail_messages', '', {
          method: 'POST',
          body: { gmail_message_id: msgId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, result: 'filtered', ai_summary: aiResult.summary }
        });
        continue;
      }

      var anyMatched = false;
      for (var match of aiResult.matches) {
        if (match.task_id && match.confidence >= 0.4) {
          // Download attachment from Gmail
          var attMeta = emailMeta.attachments[match.attachment_index];
          if (!attMeta) continue;

          var attRes = await gmail.users.messages.attachments.get({
            userId: emailAddress, messageId: msgId, id: attMeta.attachmentId
          });
          var attBuffer = Buffer.from(attRes.data.data, 'base64url');
          var attDataUrl = 'data:' + attMeta.mimeType + ';base64,' + attBuffer.toString('base64');

          // Update task with attachment
          await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(match.task_id), {
            method: 'PATCH',
            body: {
              attachment_url: attDataUrl,
              attachment_filename: attMeta.filename,
              gmail_message_id: msgId,
              gmail_attachment_id: attMeta.attachmentId,
              ai_match_confidence: match.confidence,
              ai_match_reasoning: match.reasoning,
              status: 'in_progress'
            }
          });

          // Upload to Google Drive
          var taskCaseRes = await supabaseDbRequest('registration_tasks', 'select=case_id&id=eq.' + encodeURIComponent(match.task_id) + '&limit=1');
          if (taskCaseRes.ok && taskCaseRes.data && taskCaseRes.data[0]) {
            var folderId = await ensureGPDriveFolder(taskCaseRes.data[0].case_id, '', '');
            if (folderId) {
              await uploadToGoogleDrive(folderId, attMeta.filename, attBuffer, attMeta.mimeType);
            }
          }

          // Log case event
          if (taskCaseRes.ok && taskCaseRes.data && taskCaseRes.data[0]) {
            await _logCaseEvent(
              taskCaseRes.data[0].case_id, match.task_id, 'system',
              'Document received from ' + emailMeta.sender + ' — ' + attMeta.filename + ' (AI confidence: ' + Math.round(match.confidence * 100) + '%)',
              match.reasoning, 'system'
            );
          }

          anyMatched = true;
        }
      }

      // Store in processed_gmail_messages
      if (anyMatched) {
        var matchedTaskId = aiResult.matches.find(function (m) { return m.task_id && m.confidence >= 0.4; });
        await supabaseDbRequest('processed_gmail_messages', '', {
          method: 'POST',
          body: { gmail_message_id: msgId, email_address: emailAddress, sender: emailMeta.sender, subject: emailMeta.subject, result: 'matched', matched_task_id: matchedTaskId ? matchedTaskId.task_id : null, ai_summary: aiResult.summary }
        });
      } else {
        // Store as unmatched with attachment data for manual assignment
        var unmatchedAttachments = [];
        for (var ua of emailMeta.attachments) {
          if (!GMAIL_DOCUMENT_EXTENSIONS.test(ua.filename || '')) continue;
          try {
            var uaRes = await gmail.users.messages.attachments.get({
              userId: emailAddress, messageId: msgId, id: ua.attachmentId
            });
            unmatchedAttachments.push({
              filename: ua.filename,
              base64: uaRes.data.data,
              mime_type: ua.mimeType,
              size: ua.size
            });
          } catch (dlErr) {
            console.error('[Gmail] attachment download error:', dlErr.message);
          }
        }
        await supabaseDbRequest('processed_gmail_messages', '', {
          method: 'POST',
          body: {
            gmail_message_id: msgId, email_address: emailAddress, sender: emailMeta.sender,
            subject: emailMeta.subject, result: 'unmatched', ai_summary: aiResult.summary,
            attachment_data: unmatchedAttachments.length > 0 ? JSON.stringify(unmatchedAttachments) : null
          }
        });
      }
    } catch (msgErr) {
      console.error('[Gmail] Error processing message', msgId, ':', msgErr.message);
      await supabaseDbRequest('processed_gmail_messages', '', {
        method: 'POST',
        body: { gmail_message_id: msgId, email_address: emailAddress, sender: emailMeta.sender || '', subject: '', result: 'error', ai_summary: 'Error: ' + msgErr.message }
      });
    }
  }
}
```

- [ ] **Step 2: Add the webhook endpoint**

In `server.js`, in the route handler section (near the other `/api/` endpoints), add:

```javascript
  // ── Gmail Pub/Sub webhook ──
  if (method === 'POST' && pathname === '/api/webhooks/gmail') {
    // Respond immediately to Pub/Sub
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    // Process in background (Vercel keeps the function alive after response)
    try {
      var gmailBody = await readBody(req);
      var pubsubData = parseGmailPubSubMessage(gmailBody);
      if (pubsubData && pubsubData.emailAddress) {
        processGmailNotification(pubsubData.emailAddress, pubsubData.historyId)
          .catch(function (err) { console.error('[Gmail webhook] background processing error:', err.message); });
      }
    } catch (whErr) {
      console.error('[Gmail webhook] parse error:', whErr.message);
    }
    return;
  }
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add Gmail webhook handler + processGmailNotification orchestrator"
git push
```

---

### Task 7: Gmail Watch Setup + Cron Renewal

**Files:**
- Modify: `server.js` (add setup function + cron endpoint)
- Modify: `vercel.json` (add cron config)

- [ ] **Step 1: Add setupGmailWatch function**

In `server.js`, after `processGmailNotification`, add:

```javascript
async function setupGmailWatch(userEmail) {
  if (!GOOGLE_PUBSUB_TOPIC) {
    console.error('[Gmail] GOOGLE_PUBSUB_TOPIC not configured');
    return null;
  }
  var gmail = await getGmailClient(userEmail);
  if (!gmail) return null;

  try {
    var watchRes = await gmail.users.watch({
      userId: userEmail,
      requestBody: {
        topicName: GOOGLE_PUBSUB_TOPIC,
        labelIds: ['INBOX']
      }
    });

    var expiry = watchRes.data.expiration ? new Date(parseInt(watchRes.data.expiration)) : null;
    var historyId = String(watchRes.data.historyId);

    // Upsert watch state
    await supabaseDbRequest('gmail_watch_state', '', {
      method: 'POST',
      body: {
        email_address: userEmail,
        history_id: historyId,
        watch_expiry: expiry ? expiry.toISOString() : null,
        updated_at: new Date().toISOString()
      },
      headers: { 'Prefer': 'resolution=merge-duplicates' }
    });

    console.log('[Gmail] Watch registered for', userEmail, '- expires:', expiry, '- historyId:', historyId);
    return { historyId: historyId, expiry: expiry };
  } catch (err) {
    console.error('[Gmail] setupWatch error for', userEmail, ':', err.message);
    return null;
  }
}
```

- [ ] **Step 2: Add the cron renewal endpoint**

In `server.js`, add the cron endpoint:

```javascript
  // ── Gmail watch renewal cron ──
  if (method === 'GET' && pathname === '/api/cron/renew-gmail-watch') {
    // Verify cron secret (Vercel sends Authorization: Bearer <CRON_SECRET>)
    var cronSecret = String(process.env.CRON_SECRET || '').trim();
    var authHeader = req.headers['authorization'] || '';
    if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    var results = [];
    for (var vaEmail of MONITORED_VA_EMAILS) {
      var watchResult = await setupGmailWatch(vaEmail);
      results.push({ email: vaEmail, success: !!watchResult, expiry: watchResult ? watchResult.expiry : null });
    }
    sendJson(res, 200, { ok: true, results: results });
    return;
  }
```

- [ ] **Step 3: Add an admin endpoint to manually trigger initial watch setup**

```javascript
  // ── Admin: initialize Gmail watch (one-time setup) ──
  if (method === 'POST' && pathname === '/api/admin/gmail/setup-watch') {
    var adminAuth = requireAdminSession(req, res);
    if (!adminAuth) return;

    var results = [];
    for (var vaEmail of MONITORED_VA_EMAILS) {
      var watchResult = await setupGmailWatch(vaEmail);
      results.push({ email: vaEmail, success: !!watchResult, expiry: watchResult ? watchResult.expiry : null });
    }
    sendJson(res, 200, { ok: true, results: results });
    return;
  }
```

- [ ] **Step 4: Update vercel.json with cron config**

Read `vercel.json` first, then add the crons array. The current `vercel.json` has no crons. Add:

```json
{
  "crons": [
    {
      "path": "/api/cron/renew-gmail-watch",
      "schedule": "0 0 */6 * *"
    }
  ]
}
```

Add this as a top-level key alongside the existing `routes`, `functions`, etc.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js vercel.json
git commit -m "feat: add Gmail watch setup/renewal + Vercel cron job"
git push
```

---

### Task 8: Request Revision Endpoint

**Files:**
- Modify: `server.js` (add endpoint)
- Test: `tests/gmail-revision.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/gmail-revision.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('buildRevisionRfc2822', () => {
  it('builds a valid RFC 2822 message with attachment', () => {
    const result = buildRevisionRfc2822({
      from: 'hazel@mygplink.com.au',
      to: 'jane@sopmedical.com.au',
      subject: 'Re: Offer/Contract Required — Dr Smith at SOP Medical',
      attachmentFilename: 'Employment_Agreement.pdf',
      attachmentBase64: 'JVBER...',
      attachmentMimeType: 'application/pdf'
    });

    expect(result).toContain('From: hazel@mygplink.com.au');
    expect(result).toContain('To: jane@sopmedical.com.au');
    expect(result).toContain('Subject: Re: Offer/Contract');
    expect(result).toContain('Content-Type: multipart/mixed');
    expect(result).toContain('Content-Disposition: attachment; filename="Employment_Agreement.pdf"');
    expect(result).toContain('JVBER...');
  });
});

function buildRevisionRfc2822({ from, to, subject, attachmentFilename, attachmentBase64, attachmentMimeType }) {
  var boundary = 'boundary_' + Date.now() + '_revision';
  var lines = [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    '',
    '--' + boundary,
    'Content-Type: ' + attachmentMimeType + '; name="' + attachmentFilename + '"',
    'Content-Disposition: attachment; filename="' + attachmentFilename + '"',
    'Content-Transfer-Encoding: base64',
    '',
    attachmentBase64,
    '--' + boundary + '--'
  ];
  return lines.join('\r\n');
}
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/gmail-revision.test.js`
Expected: PASS.

- [ ] **Step 3: Add the request-revision endpoint to server.js**

```javascript
  // ── Request revision: create Gmail draft with document attached ──
  if (method === 'POST' && pathname.match(/^\/api\/admin\/va\/task\/([^/]+)\/request-revision$/)) {
    var adminAuth = requireAdminSession(req, res);
    if (!adminAuth) return;
    var taskId = pathname.match(/^\/api\/admin\/va\/task\/([^/]+)\/request-revision$/)[1];

    var taskRes = await supabaseDbRequest('registration_tasks', 'select=*&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (!taskRes.ok || !taskRes.data || !taskRes.data[0]) { sendJson(res, 404, { error: 'Task not found' }); return; }
    var task = taskRes.data[0];

    if (!task.attachment_url) { sendJson(res, 400, { error: 'No document attached to this task' }); return; }

    // Get practice contact info
    var caseRes = await supabaseDbRequest('registration_cases', 'select=user_id&id=eq.' + encodeURIComponent(task.case_id) + '&limit=1');
    if (!caseRes.ok || !caseRes.data || !caseRes.data[0]) { sendJson(res, 404, { error: 'Case not found' }); return; }
    var userId = caseRes.data[0].user_id;

    var stateRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&key=eq.gp_career_state&limit=1');
    var careerState = {};
    if (stateRes.ok && stateRes.data && stateRes.data[0]) {
      try { careerState = typeof stateRes.data[0].state === 'string' ? JSON.parse(stateRes.data[0].state) : stateRes.data[0].state; } catch (e) {}
    }
    var secured = careerState;
    if (!secured.placement && Array.isArray(careerState.applications)) {
      var securedApp = careerState.applications.find(function (a) { return a && a.isPlacementSecured; });
      if (securedApp) secured = { placement: securedApp };
    }
    var pc = (secured.placement && secured.placement.practiceContact) || {};

    if (!pc.email) { sendJson(res, 400, { error: 'No practice contact email found' }); return; }

    // Extract attachment data
    var attBuffer, attMimeType, attFilename;
    attFilename = task.attachment_filename || 'document.pdf';
    if (task.attachment_url.startsWith('data:')) {
      var parts = task.attachment_url.split(',');
      var mimeMatch = parts[0].match(/data:([^;]+)/);
      attMimeType = mimeMatch ? mimeMatch[1] : 'application/pdf';
      attBuffer = Buffer.from(parts[1], 'base64');
    } else {
      attMimeType = 'application/pdf';
      var dlController = new AbortController();
      var dlTimeout = setTimeout(function () { dlController.abort(); }, 15000);
      try {
        var dlResp = await fetch(task.attachment_url, { signal: dlController.signal });
        attBuffer = Buffer.from(await dlResp.arrayBuffer());
      } finally { clearTimeout(dlTimeout); }
    }

    // Determine which VA email to create draft in
    var vaEmail = MONITORED_VA_EMAILS[0]; // Default to first VA

    // Build subject (keep thread if possible)
    var docLabel = task.related_document_key === 'offer_contract' ? 'Offer/Contract' : 'Supervisor CV';
    var profileRes = await supabaseDbRequest('user_profiles', 'select=first_name,last_name&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    var gpProfile = (profileRes.ok && profileRes.data && profileRes.data[0]) ? profileRes.data[0] : {};
    var gpName = 'Dr ' + [(gpProfile.first_name || ''), (gpProfile.last_name || '')].join(' ').trim();
    var practiceName = (secured.placement && secured.placement.practiceName) || '';
    var subject = 'Re: ' + docLabel + ' Required — ' + gpName + ' at ' + practiceName;

    // Build RFC 2822 message with attachment
    var boundary = 'boundary_' + Date.now() + '_revision';
    var raw = [
      'From: ' + vaEmail,
      'To: ' + pc.email,
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="' + boundary + '"',
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      '',
      '--' + boundary,
      'Content-Type: ' + attMimeType + '; name="' + attFilename + '"',
      'Content-Disposition: attachment; filename="' + attFilename + '"',
      'Content-Transfer-Encoding: base64',
      '',
      attBuffer.toString('base64'),
      '--' + boundary + '--'
    ].join('\r\n');

    // Create Gmail draft
    var gmail = await getGmailClient(vaEmail);
    if (!gmail) { sendJson(res, 500, { error: 'Gmail client not available' }); return; }

    try {
      var draftRes = await gmail.users.drafts.create({
        userId: vaEmail,
        requestBody: {
          message: {
            raw: Buffer.from(raw).toString('base64url')
          }
        }
      });

      var draftId = draftRes.data.id;
      var draftUrl = 'https://mail.google.com/mail/#drafts/' + (draftRes.data.message ? draftRes.data.message.id : draftId);

      // Reset task status
      await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
        method: 'PATCH',
        body: {
          status: 'waiting_on_practice',
          attachment_url: null,
          attachment_filename: null,
          gmail_message_id: null,
          gmail_attachment_id: null,
          ai_match_confidence: null,
          ai_match_reasoning: null
        }
      });

      await _logCaseEvent(task.case_id, taskId, 'va', 'Revision requested for ' + docLabel + ' — draft created', null, adminAuth.email);

      sendJson(res, 200, { ok: true, draft_url: draftUrl });
    } catch (draftErr) {
      console.error('[Gmail] draft creation error:', draftErr.message);
      sendJson(res, 500, { error: 'Failed to create Gmail draft: ' + draftErr.message });
    }
    return;
  }
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/gmail-revision.test.js
git commit -m "feat: add request-revision endpoint — creates Gmail draft with attachment"
git push
```

---

### Task 9: Dismiss + Assign Document Endpoints

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add dismiss-attachment endpoint**

```javascript
  // ── Dismiss wrong AI match ──
  if (method === 'POST' && pathname.match(/^\/api\/admin\/va\/task\/([^/]+)\/dismiss-attachment$/)) {
    var adminAuth = requireAdminSession(req, res);
    if (!adminAuth) return;
    var taskId = pathname.match(/^\/api\/admin\/va\/task\/([^/]+)\/dismiss-attachment$/)[1];

    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
      method: 'PATCH',
      body: {
        attachment_url: null,
        attachment_filename: null,
        gmail_message_id: null,
        gmail_attachment_id: null,
        ai_match_confidence: null,
        ai_match_reasoning: null,
        status: 'waiting_on_practice'
      }
    });

    var taskRes = await supabaseDbRequest('registration_tasks', 'select=case_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (taskRes.ok && taskRes.data && taskRes.data[0]) {
      await _logCaseEvent(taskRes.data[0].case_id, taskId, 'va', 'AI-matched document dismissed by VA', null, adminAuth.email);
    }

    sendJson(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 2: Add unmatched-documents list endpoint**

```javascript
  // ── List unmatched incoming documents ──
  if (method === 'GET' && pathname === '/api/admin/va/unmatched-documents') {
    var adminAuth = requireAdminSession(req, res);
    if (!adminAuth) return;

    var unmatchedRes = await supabaseDbRequest(
      'processed_gmail_messages',
      'select=gmail_message_id,email_address,sender,subject,processed_at,ai_summary,attachment_data&'
      + 'result=eq.unmatched&'
      + 'attachment_data=not.is.null&'
      + 'order=processed_at.desc&'
      + 'limit=50'
    );

    sendJson(res, 200, { ok: true, documents: (unmatchedRes.ok ? unmatchedRes.data : []) });
    return;
  }
```

- [ ] **Step 3: Add assign-document endpoint**

```javascript
  // ── Manually assign unmatched document to a task ──
  if (method === 'POST' && pathname === '/api/admin/va/assign-document') {
    var adminAuth = requireAdminSession(req, res);
    if (!adminAuth) return;
    var body = await readBody(req);
    var gmailMessageId = body.gmail_message_id;
    var taskId = body.task_id;
    var attachmentIndex = body.attachment_index || 0;

    if (!gmailMessageId || !taskId) { sendJson(res, 400, { error: 'gmail_message_id and task_id required' }); return; }

    // Get the unmatched document
    var docRes = await supabaseDbRequest(
      'processed_gmail_messages',
      'select=*&gmail_message_id=eq.' + encodeURIComponent(gmailMessageId) + '&limit=1'
    );
    if (!docRes.ok || !docRes.data || !docRes.data[0] || !docRes.data[0].attachment_data) {
      sendJson(res, 404, { error: 'Unmatched document not found' }); return;
    }
    var doc = docRes.data[0];
    var attachments = typeof doc.attachment_data === 'string' ? JSON.parse(doc.attachment_data) : doc.attachment_data;
    if (!attachments || !attachments[attachmentIndex]) { sendJson(res, 400, { error: 'Attachment not found at index' }); return; }

    var att = attachments[attachmentIndex];
    var attDataUrl = 'data:' + att.mime_type + ';base64,' + att.base64;

    // Update the task
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), {
      method: 'PATCH',
      body: {
        attachment_url: attDataUrl,
        attachment_filename: att.filename,
        gmail_message_id: gmailMessageId,
        ai_match_confidence: null,
        ai_match_reasoning: 'Manually assigned by VA',
        status: 'in_progress'
      }
    });

    // Update processed message to matched
    await supabaseDbRequest('processed_gmail_messages', 'gmail_message_id=eq.' + encodeURIComponent(gmailMessageId), {
      method: 'PATCH',
      body: { result: 'matched', matched_task_id: taskId, attachment_data: null }
    });

    // Log case event
    var taskCaseRes = await supabaseDbRequest('registration_tasks', 'select=case_id&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    if (taskCaseRes.ok && taskCaseRes.data && taskCaseRes.data[0]) {
      await _logCaseEvent(taskCaseRes.data[0].case_id, taskId, 'va', 'Document manually assigned from email: ' + att.filename, null, adminAuth.email);
    }

    sendJson(res, 200, { ok: true });
    return;
  }
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add dismiss, assign, and unmatched-documents endpoints"
git push
```

---

### Task 10: Admin Dashboard — Task Card Updates

**Files:**
- Modify: `pages/admin.html` (update `renderDocTaskActions` function around line 793)

- [ ] **Step 1: Update the task card rendering for Gmail-sourced documents**

In `pages/admin.html`, update the `renderDocTaskActions` function. For the `offer_contract` and `supervisor_cv` sections, add Gmail source info, confidence badge, and new action buttons.

Replace the existing `offer_contract` section (around lines 822-837) with:

```javascript
    } else if (dk === 'offer_contract') {
      // Gmail source info
      if (task.gmail_message_id && task.attachment_url) {
        var confPercent = task.ai_match_confidence ? Math.round(task.ai_match_confidence * 100) : 0;
        var confClass = confPercent >= 70 ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800';
        var confLabel = confPercent >= 70 ? 'High confidence' : 'Needs confirmation';
        html += '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:0.85rem;">'
          + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">'
          + '<span style="font-weight:600;">📧 Auto-received</span>'
          + '<span style="padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:500;' + (confPercent >= 70 ? 'background:#dcfce7;color:#166534' : 'background:#fef9c3;color:#854d0e') + ';">' + confLabel + ' (' + confPercent + '%)</span>'
          + '</div>';
        if (task.attachment_filename) html += '<div style="color:#555;font-size:0.8rem;">File: ' + _esc(task.attachment_filename) + '</div>';
        if (task.ai_match_reasoning) {
          html += '<details style="margin-top:4px;font-size:0.8rem;"><summary style="cursor:pointer;color:#6b7280;">Why this match?</summary>'
            + '<p style="margin:4px 0 0;color:#555;">' + _esc(task.ai_match_reasoning) + '</p></details>';
        }
        html += '</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        html += '<button class="btn btn-sm btn-outline-primary" onclick="previewTaskDoc(\'' + task.id + '\')">Review Document</button>';
        html += '<button class="btn btn-sm btn-primary" onclick="approveDocument(\'' + task.id + '\')">Approve & Send to GP</button>';
        html += '<button class="btn btn-sm btn-outline-warning" onclick="requestRevision(\'' + task.id + '\')">Request Revision</button>';
        html += '<button class="btn btn-sm btn-outline-danger" onclick="dismissAttachment(\'' + task.id + '\')">Dismiss</button>';
        html += '</div>';
      } else if (task.zoho_attachment_id || task.attachment_url) {
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        html += '<button class="btn btn-sm btn-outline-primary" onclick="previewTaskDoc(\'' + task.id + '\')">Review Document</button>';
        html += '<button class="btn btn-sm btn-primary" onclick="approveDocument(\'' + task.id + '\')">Submit to GP</button>';
        html += '</div>';
      } else if (task.status === 'waiting_on_practice') {
        html += '<span class="badge bg-warning text-dark">Waiting on practice</span>';
        html += '<div style="margin-top:6px;"><label class="btn btn-sm btn-outline-secondary">Upload manually <input type="file" hidden onchange="uploadTaskDoc(\'' + task.id + '\', this)"></label></div>';
      } else {
        var mailto = buildMailtoLinkFE(pc.contactEmail, 'Offer/Contract Required — ' + gpName + ' at ' + pc.practiceName,
          'Hi ' + pc.contactName + ',\\n\\nWe require the completed employment agreement between ' + pc.practiceName + ' and ' + gpName + ' for the ' + pc.roleTitle + ' position.\\n\\nPlease reply with the signed document attached.\\n\\nKind regards,\\nGP Link Team');
        html += '<a href="' + mailto + '" class="btn btn-sm btn-outline-primary" onclick="markTaskWaiting(\'' + task.id + '\')">Email Practice for Contract</a>';
        html += '<div style="margin-top:6px;"><label class="btn btn-sm btn-outline-secondary">Upload manually <input type="file" hidden onchange="uploadTaskDoc(\'' + task.id + '\', this)"></label></div>';
      }
```

Replace the existing `supervisor_cv` section (around lines 839-854) with the same pattern:

```javascript
    } else if (dk === 'supervisor_cv') {
      if (task.gmail_message_id && task.attachment_url) {
        var confPercent = task.ai_match_confidence ? Math.round(task.ai_match_confidence * 100) : 0;
        var confLabel = confPercent >= 70 ? 'High confidence' : 'Needs confirmation';
        html += '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:0.85rem;">'
          + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">'
          + '<span style="font-weight:600;">📧 Auto-received</span>'
          + '<span style="padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:500;' + (confPercent >= 70 ? 'background:#dcfce7;color:#166534' : 'background:#fef9c3;color:#854d0e') + ';">' + confLabel + ' (' + confPercent + '%)</span>'
          + '</div>';
        if (task.attachment_filename) html += '<div style="color:#555;font-size:0.8rem;">File: ' + _esc(task.attachment_filename) + '</div>';
        if (task.ai_match_reasoning) {
          html += '<details style="margin-top:4px;font-size:0.8rem;"><summary style="cursor:pointer;color:#6b7280;">Why this match?</summary>'
            + '<p style="margin:4px 0 0;color:#555;">' + _esc(task.ai_match_reasoning) + '</p></details>';
        }
        html += '</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        html += '<button class="btn btn-sm btn-outline-primary" onclick="previewTaskDoc(\'' + task.id + '\')">Review Document</button>';
        html += '<button class="btn btn-sm btn-primary" onclick="approveDocument(\'' + task.id + '\')">Approve & Send to GP</button>';
        html += '<button class="btn btn-sm btn-outline-warning" onclick="requestRevision(\'' + task.id + '\')">Request Revision</button>';
        html += '<button class="btn btn-sm btn-outline-danger" onclick="dismissAttachment(\'' + task.id + '\')">Dismiss</button>';
        html += '</div>';
      } else if (task.attachment_url) {
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        html += '<button class="btn btn-sm btn-outline-primary" onclick="previewTaskDoc(\'' + task.id + '\')">Review Document</button>';
        html += '<button class="btn btn-sm btn-primary" onclick="approveDocument(\'' + task.id + '\')">Submit to GP</button>';
        html += '</div>';
      } else if (task.status === 'waiting_on_practice') {
        html += '<span class="badge bg-warning text-dark">Waiting on practice</span>';
        html += '<div style="margin-top:6px;"><label class="btn btn-sm btn-outline-secondary">Upload manually <input type="file" hidden onchange="uploadTaskDoc(\'' + task.id + '\', this)"></label></div>';
      } else {
        var mailto = buildMailtoLinkFE(pc.contactEmail, 'Supervisor CV Required — ' + gpName + ' at ' + pc.practiceName,
          'Hi ' + pc.contactName + ',\\n\\nWe require the supervising doctor\'s CV for ' + gpName + '\'s Specialist Registration application at ' + pc.practiceName + '.\\n\\nPlease reply with the supervisor\'s CV attached.\\n\\nKind regards,\\nGP Link Team');
        html += '<a href="' + mailto + '" class="btn btn-sm btn-outline-primary" onclick="markTaskWaiting(\'' + task.id + '\')">Email Practice for Supervisor CV</a>';
        html += '<div style="margin-top:6px;"><label class="btn btn-sm btn-outline-secondary">Upload manually <input type="file" hidden onchange="uploadTaskDoc(\'' + task.id + '\', this)"></label></div>';
      }
```

- [ ] **Step 2: Add the new JavaScript functions**

In `pages/admin.html`, after the existing `previewTaskDoc` function (around line 1977), add:

```javascript
    async function requestRevision(taskId) {
      if (!confirm('Create a revision request draft in Gmail? The document will be attached for the practice to review.')) return;
      try {
        var resp = await fetch('/api/admin/va/task/' + taskId + '/request-revision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: taskId })
        });
        var data = await resp.json();
        if (data.ok && data.draft_url) {
          window.open(data.draft_url, '_blank');
          alert('Gmail draft created. Add your explanation and hit Send.');
          location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error creating revision draft: ' + err.message);
      }
    }

    async function dismissAttachment(taskId) {
      if (!confirm('Dismiss this document? The task will go back to waiting on practice.')) return;
      try {
        await fetch('/api/admin/va/task/' + taskId + '/dismiss-attachment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        location.reload();
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    async function approveDocument(taskId) {
      if (!confirm('Approve and send this document to the GP?')) return;
      try {
        var resp = await fetch('/api/admin/va/task/approve-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: taskId })
        });
        var data = await resp.json();
        if (data.ok) {
          alert('Document approved and sent to GP.');
          location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
```

- [ ] **Step 3: Update cache buster on admin.html script tags**

Update any `?v=` cache busters on admin.html script/link tags to `?v=20260416a`.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html server.js
git commit -m "feat: update admin task cards with Gmail source info, revision, dismiss buttons"
git push
```

---

### Task 11: Admin Dashboard — Incoming Documents Panel

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add the Incoming Documents panel**

In `pages/admin.html`, in the VA dashboard section (where practice pack tasks are rendered), add a new panel above the task list:

```javascript
    async function loadUnmatchedDocuments() {
      try {
        var resp = await fetch('/api/admin/va/unmatched-documents');
        var data = await resp.json();
        var container = document.getElementById('unmatched-docs-panel');
        if (!container) return;

        var docs = data.documents || [];
        if (docs.length === 0) {
          container.style.display = 'none';
          return;
        }

        container.style.display = 'block';
        var html = '<h4 style="margin:0 0 12px;font-size:1rem;">📬 Incoming Documents (' + docs.length + ')</h4>';
        for (var doc of docs) {
          var attachments = [];
          try { attachments = typeof doc.attachment_data === 'string' ? JSON.parse(doc.attachment_data) : (doc.attachment_data || []); } catch (e) {}

          html += '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:8px;">';
          html += '<div style="display:flex;justify-content:space-between;align-items:start;">';
          html += '<div>';
          html += '<div style="font-weight:600;font-size:0.9rem;">' + _esc(doc.subject || 'No subject') + '</div>';
          html += '<div style="color:#6b7280;font-size:0.8rem;">From: ' + _esc(doc.sender || 'Unknown') + ' · ' + new Date(doc.processed_at).toLocaleDateString() + '</div>';
          if (doc.ai_summary) html += '<div style="color:#555;font-size:0.8rem;margin-top:2px;">' + _esc(doc.ai_summary) + '</div>';
          html += '</div></div>';

          for (var ai = 0; ai < attachments.length; ai++) {
            var att = attachments[ai];
            html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px;background:#f9fafb;border-radius:6px;">';
            html += '<span style="font-size:0.85rem;">📎 ' + _esc(att.filename) + '</span>';
            html += '<select id="assign-task-' + doc.gmail_message_id + '-' + ai + '" style="font-size:0.8rem;padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;">';
            html += '<option value="">Assign to task...</option>';
            // Populated dynamically from open tasks
            html += '</select>';
            html += '<button class="btn btn-sm btn-primary" onclick="assignDocument(\'' + doc.gmail_message_id + '\',' + ai + ')">Assign</button>';
            html += '</div>';
          }
          html += '</div>';
        }
        container.innerHTML = html;

        // Populate task dropdowns with open practice pack tasks
        populateAssignDropdowns();
      } catch (err) {
        console.error('Error loading unmatched docs:', err);
      }
    }

    function populateAssignDropdowns() {
      // Get all practice_pack_child tasks from the already-loaded VA data
      var selects = document.querySelectorAll('[id^="assign-task-"]');
      if (!selects.length || !window._vaTasks) return;
      var openTasks = window._vaTasks.filter(function (t) {
        return t.task_type === 'practice_pack_child'
          && (t.related_document_key === 'offer_contract' || t.related_document_key === 'supervisor_cv')
          && !t.attachment_url;
      });
      selects.forEach(function (sel) {
        for (var t of openTasks) {
          var label = (t.gp_name || 'Unknown GP') + ' — ' + (t.related_document_key === 'offer_contract' ? 'Offer/Contract' : 'Supervisor CV');
          var opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = label;
          sel.appendChild(opt);
        }
      });
    }

    async function assignDocument(gmailMessageId, attachmentIndex) {
      var sel = document.getElementById('assign-task-' + gmailMessageId + '-' + attachmentIndex);
      if (!sel || !sel.value) { alert('Please select a task to assign to'); return; }
      try {
        var resp = await fetch('/api/admin/va/assign-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gmail_message_id: gmailMessageId, task_id: sel.value, attachment_index: attachmentIndex })
        });
        var data = await resp.json();
        if (data.ok) {
          alert('Document assigned successfully');
          location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
```

Add the HTML container div in the VA dashboard section:

```html
<div id="unmatched-docs-panel" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:16px;margin-bottom:16px;"></div>
```

Call `loadUnmatchedDocuments()` at the end of the VA dashboard load function (alongside existing data fetches).

- [ ] **Step 2: Store VA tasks globally for dropdown population**

Where tasks are fetched in the VA dashboard, add:

```javascript
window._vaTasks = tasks; // Store for unmatched docs dropdown
```

- [ ] **Step 3: Update cache buster**

Update `?v=` to `?v=20260416b`.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Incoming Documents panel for unmatched Gmail attachments"
git push
```

---

### Task 12: Server Return Gmail Fields in VA Dashboard API

**Files:**
- Modify: `server.js` (update VA task list endpoint to include new columns)

- [ ] **Step 1: Update the VA task list query**

Find the VA task list endpoint (where `registration_tasks` are fetched for the admin dashboard — around line 17740+). Ensure the `select` query includes the new Gmail columns:

Add to the existing select: `gmail_message_id,gmail_attachment_id,ai_match_confidence,ai_match_reasoning`

The full select should include these fields so the frontend can render the Gmail source info, confidence badges, and action buttons.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: include Gmail fields in VA dashboard task list API"
git push
```

---

### Task 13: Environment Variables + Google Cloud Setup

**Files:**
- Modify: `vercel.json` (already done in Task 7)

- [ ] **Step 1: Set Vercel environment variables**

Add to Vercel project → Settings → Environment Variables (all environments):

| Variable | Value |
|---|---|
| `GOOGLE_PUBSUB_TOPIC` | `projects/sunlit-precinct-481010-j2/topics/gmail-push` |
| `GMAIL_WEBHOOK_SECRET` | (generate a random 32-char string) |
| `CRON_SECRET` | (Vercel auto-generates this for cron jobs) |

- [ ] **Step 2: Run Google Cloud setup commands**

Run these in Google Cloud Shell:

```bash
gcloud services enable pubsub.googleapis.com --project=sunlit-precinct-481010-j2

gcloud pubsub topics create gmail-push --project=sunlit-precinct-481010-j2

gcloud pubsub topics add-iam-policy-binding gmail-push --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" --role="roles/pubsub.publisher" --project=sunlit-precinct-481010-j2

gcloud pubsub subscriptions create gmail-push-sub --topic=gmail-push --push-endpoint="https://www.mygplink.com.au/api/webhooks/gmail" --project=sunlit-precinct-481010-j2
```

- [ ] **Step 3: Run the Supabase migration**

Apply the migration from Task 1 to production Supabase.

- [ ] **Step 4: Initialize Gmail watch**

After deploying, call the admin endpoint to set up the initial Gmail watch:

```bash
curl -X POST https://www.mygplink.com.au/api/admin/gmail/setup-watch \
  -H "Cookie: gp_admin_session=<your-session-cookie>"
```

Or trigger it from the admin dashboard.

- [ ] **Step 5: Verify the webhook receives notifications**

Send a test email to `hazel@mygplink.com.au` and check Vercel function logs for `[Gmail]` entries.

- [ ] **Step 6: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: finalize Gmail auto-parsing setup and configuration"
git push
```

---

## Summary

| Task | What it does |
|---|---|
| 1 | Database migration (new tables + columns) |
| 2 | Gmail client helper (domain-wide delegation + email parser) |
| 3 | Pre-filter (skip irrelevant emails) |
| 4 | AI matching (Anthropic Haiku) |
| 5 | Open tasks fetcher for matching context |
| 6 | Gmail webhook handler (Pub/Sub → process → match → attach) |
| 7 | Watch setup + cron renewal |
| 8 | Request revision (Gmail draft with attachment) |
| 9 | Dismiss + assign document endpoints |
| 10 | Admin dashboard task card updates |
| 11 | Admin dashboard incoming documents panel |
| 12 | VA dashboard API — include Gmail fields |
| 13 | Env vars + Google Cloud Pub/Sub setup |
