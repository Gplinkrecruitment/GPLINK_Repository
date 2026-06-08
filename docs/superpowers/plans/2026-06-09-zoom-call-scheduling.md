# Zoom Call Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins schedule Zoom assistance calls with GPs at the MyIntealth, AMC, or AHPRA stages, using Calendly for self-service booking and Zoom AI Companion for post-call summaries saved to the GP's admin profile.

**Architecture:** Calendly handles availability/booking/timezone. Zoom handles the meeting + AI summary. Our system ties them together: admin triggers an invite from the case dashboard → GP gets a Calendly link → webhooks update status → Zoom summary is fetched post-call and stored. All new backend logic lives in `server.js` following existing patterns. New UI lives in `pages/admin.html`.

**Tech Stack:** Node.js (server.js), Supabase (PostgreSQL), Calendly API + webhooks, Zoom Server-to-Server OAuth + webhooks, DoubleTick (WhatsApp), Resend (email), Vitest (tests)

**Spec:** `docs/superpowers/specs/2026-06-09-zoom-call-scheduling-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/20260609000000_scheduled_calls.sql` | Create | DB schema: `scheduled_calls` table, `webhook_events` table, indexes, constraints, add `zoom_call` to task type check |
| `server.js` | Modify | All API endpoints, webhook handlers, Calendly/Zoom helpers, cron handler |
| `pages/admin.html` | Modify | Schedule modal, Zoom task card, Scheduled Calls tab, Call History section |
| `tests/scheduled-calls.test.js` | Create | Unit tests for status mapping, webhook signature verification, correlation token, idempotency |
| `docs/setup-zoom-scheduling.md` | Create | Step-by-step admin setup guide for Calendly, Zoom, DoubleTick, env vars |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260609000000_scheduled_calls.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Zoom call scheduling tables
-- Spec: docs/superpowers/specs/2026-06-09-zoom-call-scheduling-design.md

-- 1. Add zoom_call to registration_tasks task_type constraint
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_task_type_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_task_type_check
  CHECK (task_type IN (
    'kickoff','verify','review','followup','blocker','escalation',
    'practice_pack','practice_pack_child','manual','system',
    'visa_stage','visa_doc','questionnaire','sponsor','migration_agent',
    'sla_overdue','chase','document_ops','whatsapp_help','email_triage',
    'ahpra_action_item','flagged_doc','doc_review',
    'zoom_call'
  ));

-- 2. Create scheduled_calls table
CREATE TABLE IF NOT EXISTS scheduled_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES registration_cases(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  registration_task_id UUID REFERENCES registration_tasks(id),
  stage TEXT NOT NULL CHECK (stage IN ('myintealth','amc','ahpra')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','booked','completed','cancelled','no_show')),
  admin_notes TEXT,
  correlation_token TEXT NOT NULL UNIQUE,
  calendly_booking_url TEXT,
  calendly_event_type_uri TEXT,
  calendly_event_uri TEXT,
  calendly_invitee_uri TEXT,
  calendly_old_invitee_uri TEXT,
  calendly_webhook_event_id TEXT,
  invitee_email TEXT,
  scheduled_at TIMESTAMPTZ,
  booked_at TIMESTAMPTZ,
  timezone TEXT,
  duration_minutes INT NOT NULL DEFAULT 30,
  zoom_meeting_id TEXT,
  zoom_meeting_uuid TEXT,
  zoom_join_url TEXT,
  zoom_passcode TEXT,
  meeting_summary TEXT,
  meeting_action_items JSONB,
  meeting_summary_raw JSONB,
  summary_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (summary_status IN ('not_requested','pending','saved','not_available','error')),
  summary_fetch_attempts INT NOT NULL DEFAULT 0,
  summary_error TEXT,
  summary_saved_at TIMESTAMPTZ,
  invite_sent_at TIMESTAMPTZ,
  resend_count INT NOT NULL DEFAULT 0,
  notification_channels JSONB,
  whatsapp_message_id TEXT,
  email_message_id TEXT,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  no_show_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_calls_calendly_invitee
  ON scheduled_calls (calendly_invitee_uri) WHERE calendly_invitee_uri IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_calls_zoom_meeting
  ON scheduled_calls (zoom_meeting_id) WHERE zoom_meeting_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_calls_correlation
  ON scheduled_calls (correlation_token);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_calls_case_created
  ON scheduled_calls (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_calls_status_scheduled
  ON scheduled_calls (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_calls_summary_pending
  ON scheduled_calls (summary_status, completed_at)
  WHERE summary_status IN ('pending','error');

-- RLS: admin/service-role only
ALTER TABLE scheduled_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_calls_service_only ON scheduled_calls
  FOR ALL USING (false) WITH CHECK (false);
-- Service role key bypasses RLS, so admin API access works via supabaseDbRequest

-- 3. Create webhook_events idempotency table
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_provider_event
  ON webhook_events (provider, event_id);

-- Updated_at trigger for scheduled_calls
CREATE OR REPLACE FUNCTION update_scheduled_calls_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scheduled_calls_updated_at
  BEFORE UPDATE ON scheduled_calls
  FOR EACH ROW EXECUTE FUNCTION update_scheduled_calls_updated_at();
```

- [ ] **Step 2: Apply migration to Supabase**

Run: `npx supabase db push` (or apply via Supabase dashboard SQL editor for production)

Expected: Tables created, constraint updated, no errors.

- [ ] **Step 3: Verify migration**

Run in Supabase SQL editor:
```sql
SELECT conname, consrc FROM pg_constraint WHERE conname = 'registration_tasks_task_type_check';
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'scheduled_calls' ORDER BY ordinal_position;
SELECT indexname FROM pg_indexes WHERE tablename = 'scheduled_calls';
```

Expected: `zoom_call` appears in task_type constraint; all columns present; all indexes created.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260609000000_scheduled_calls.sql
git commit -m "feat: add scheduled_calls table and zoom_call task type"
git push origin main
```

---

### Task 2: Server — Env Vars, Constants, and Helpers

**Files:**
- Modify: `server.js` (near top, around line 76 where other env vars are defined)

- [ ] **Step 1: Write tests for correlation token generation and status mapping**

Create `tests/scheduled-calls.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

// We'll test the exported helpers once they exist.
// For now, define the expected behavior.

describe('scheduled-calls helpers', () => {

  describe('generateCorrelationToken', () => {
    it('generates a 32-char hex string', () => {
      const { generateCorrelationToken } = require('../server-test-helpers.js');
      const token = generateCorrelationToken();
      expect(token).toMatch(/^[a-f0-9]{32}$/);
    });

    it('generates unique tokens', () => {
      const { generateCorrelationToken } = require('../server-test-helpers.js');
      const a = generateCorrelationToken();
      const b = generateCorrelationToken();
      expect(a).not.toBe(b);
    });
  });

  describe('mapCallStatusToTaskStatus', () => {
    it('maps invited to waiting_on_gp', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('invited')).toBe('waiting_on_gp');
    });

    it('maps booked to waiting', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('booked')).toBe('waiting');
    });

    it('maps completed to completed', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('completed')).toBe('completed');
    });

    it('maps cancelled to cancelled', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('cancelled')).toBe('cancelled');
    });

    it('maps no_show to waiting_on_gp', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('no_show')).toBe('waiting_on_gp');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: FAIL — `server-test-helpers.js` doesn't exist yet.

- [ ] **Step 3: Add env vars and constants to server.js**

Add near line 76 (after existing env var declarations like `ZOHO_RECRUIT_SYNC_CRON_SECRET`):

```javascript
// ── Zoom Call Scheduling (Calendly + Zoom AI Companion) ──
const CALENDLY_API_TOKEN = String(process.env.CALENDLY_API_TOKEN || '').trim();
const CALENDLY_EVENT_URL = String(process.env.CALENDLY_EVENT_URL || '').trim();
const CALENDLY_EVENT_TYPE_URI = String(process.env.CALENDLY_EVENT_TYPE_URI || '').trim();
const CALENDLY_WEBHOOK_SECRET = String(process.env.CALENDLY_WEBHOOK_SECRET || '').trim();
const ZOOM_WEBHOOK_SECRET = String(process.env.ZOOM_WEBHOOK_SECRET || '').trim();
const CALL_SCHEDULING_CRON_SECRET = String(process.env.CRON_SECRET || '').trim();
```

Add the status mapping and correlation token generator (place after the env vars, near other helper functions):

```javascript
// ── Scheduled Calls helpers ──
const CALL_STATUS_TO_TASK_STATUS = {
  invited: 'waiting_on_gp',
  booked: 'waiting',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'waiting_on_gp'
};

function mapCallStatusToTaskStatus(callStatus) {
  return CALL_STATUS_TO_TASK_STATUS[callStatus] || 'open';
}

function generateCorrelationToken() {
  return require('crypto').randomBytes(16).toString('hex');
}

function buildCalendlyBookingUrl(correlationToken) {
  if (!CALENDLY_EVENT_URL) return '';
  const sep = CALENDLY_EVENT_URL.includes('?') ? '&' : '?';
  return CALENDLY_EVENT_URL + sep + 'utm_source=gplink&utm_medium=registration_call&utm_content=call_' + correlationToken;
}
```

- [ ] **Step 4: Create server-test-helpers.js to export testable functions**

Create `server-test-helpers.js` at project root:

```javascript
// Thin wrapper to export server.js helpers for unit testing.
// These functions are duplicated here to avoid importing the full server.
const crypto = require('crypto');

const CALL_STATUS_TO_TASK_STATUS = {
  invited: 'waiting_on_gp',
  booked: 'waiting',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'waiting_on_gp'
};

function mapCallStatusToTaskStatus(callStatus) {
  return CALL_STATUS_TO_TASK_STATUS[callStatus] || 'open';
}

function generateCorrelationToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { mapCallStatusToTaskStatus, generateCorrelationToken };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js server-test-helpers.js tests/scheduled-calls.test.js
git commit -m "feat: add scheduled calls env vars, helpers, and status mapping tests"
git push origin main
```

---

### Task 3: Server — Calendly Webhook Signature Verification

**Files:**
- Modify: `server.js`
- Modify: `tests/scheduled-calls.test.js`
- Modify: `server-test-helpers.js`

- [ ] **Step 1: Write tests for Calendly signature verification**

Append to `tests/scheduled-calls.test.js`:

```javascript
describe('verifyCalendlySignature', () => {
  const crypto = require('crypto');
  const secret = 'test-calendly-webhook-secret';

  function makeCalendlySignature(timestamp, body, signingKey) {
    const payload = timestamp + '.' + body;
    const sig = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
    return 't=' + timestamp + ',v1=' + sig;
  }

  it('accepts a valid signature', () => {
    const { verifyCalendlySignature } = require('../server-test-helpers.js');
    const body = '{"event":"invitee.created"}';
    const ts = String(Date.now());
    const header = makeCalendlySignature(ts, body, secret);
    expect(verifyCalendlySignature(header, body, secret)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    const { verifyCalendlySignature } = require('../server-test-helpers.js');
    const body = '{"event":"invitee.created"}';
    const ts = String(Date.now());
    const header = makeCalendlySignature(ts, body, 'wrong-secret');
    expect(verifyCalendlySignature(header, body, secret)).toBe(false);
  });

  it('rejects a stale timestamp (> 5 min old)', () => {
    const { verifyCalendlySignature } = require('../server-test-helpers.js');
    const body = '{"event":"invitee.created"}';
    const ts = String(Date.now() - 6 * 60 * 1000);
    const header = makeCalendlySignature(ts, body, secret);
    expect(verifyCalendlySignature(header, body, secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: FAIL — `verifyCalendlySignature` not exported.

- [ ] **Step 3: Implement Calendly signature verification**

Add to `server.js` (after the scheduled calls helpers from Task 2):

```javascript
function verifyCalendlySignature(signatureHeader, rawBody, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = {};
  for (const pair of signatureHeader.split(',')) {
    const [key, val] = pair.split('=', 2);
    if (key && val) parts[key.trim()] = val.trim();
  }
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) return false;
  // Reject timestamps older than 5 minutes
  const age = Date.now() - Number(timestamp);
  if (age > 5 * 60 * 1000 || age < -60 * 1000) return false;
  const expected = require('crypto')
    .createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody)
    .digest('hex');
  return require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

- [ ] **Step 4: Add to server-test-helpers.js**

Append to `server-test-helpers.js`:

```javascript
function verifyCalendlySignature(signatureHeader, rawBody, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = {};
  for (const pair of signatureHeader.split(',')) {
    const [key, val] = pair.split('=', 2);
    if (key && val) parts[key.trim()] = val.trim();
  }
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) return false;
  const age = Date.now() - Number(timestamp);
  if (age > 5 * 60 * 1000 || age < -60 * 1000) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

// Update module.exports
module.exports = { mapCallStatusToTaskStatus, generateCorrelationToken, verifyCalendlySignature };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: All 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js server-test-helpers.js tests/scheduled-calls.test.js
git commit -m "feat: add Calendly webhook signature verification"
git push origin main
```

---

### Task 4: Server — Zoom Webhook Signature Verification

**Files:**
- Modify: `server.js`
- Modify: `tests/scheduled-calls.test.js`
- Modify: `server-test-helpers.js`

- [ ] **Step 1: Write tests for Zoom signature verification and endpoint validation**

Append to `tests/scheduled-calls.test.js`:

```javascript
describe('verifyZoomWebhookSignature', () => {
  const crypto = require('crypto');
  const secret = 'test-zoom-webhook-secret';

  it('accepts a valid Zoom signature', () => {
    const { verifyZoomWebhookSignature } = require('../server-test-helpers.js');
    const body = '{"event":"meeting.ended"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const message = 'v0:' + ts + ':' + body;
    const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
    const sig = 'v0=' + hash;
    expect(verifyZoomWebhookSignature(ts, body, sig, secret)).toBe(true);
  });

  it('rejects an invalid Zoom signature', () => {
    const { verifyZoomWebhookSignature } = require('../server-test-helpers.js');
    const body = '{"event":"meeting.ended"}';
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyZoomWebhookSignature(ts, body, 'v0=bad', secret)).toBe(false);
  });
});

describe('buildZoomValidationResponse', () => {
  it('returns plainToken and encryptedToken', () => {
    const { buildZoomValidationResponse } = require('../server-test-helpers.js');
    const result = buildZoomValidationResponse('abcdef123', 'my-secret');
    expect(result.plainToken).toBe('abcdef123');
    expect(result.encryptedToken).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement Zoom webhook verification helpers**

Add to `server.js` (after `verifyCalendlySignature`):

```javascript
function verifyZoomWebhookSignature(timestamp, rawBody, signature, secret) {
  if (!timestamp || !signature || !secret) return false;
  const message = 'v0:' + timestamp + ':' + rawBody;
  const expected = 'v0=' + require('crypto').createHmac('sha256', secret).update(message).digest('hex');
  if (expected.length !== signature.length) return false;
  return require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function buildZoomValidationResponse(plainToken, secret) {
  const encryptedToken = require('crypto').createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}
```

- [ ] **Step 4: Add to server-test-helpers.js**

Append to `server-test-helpers.js` (before `module.exports`):

```javascript
function verifyZoomWebhookSignature(timestamp, rawBody, signature, secret) {
  if (!timestamp || !signature || !secret) return false;
  const message = 'v0:' + timestamp + ':' + rawBody;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function buildZoomValidationResponse(plainToken, secret) {
  const encryptedToken = crypto.createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}

module.exports = {
  mapCallStatusToTaskStatus, generateCorrelationToken,
  verifyCalendlySignature, verifyZoomWebhookSignature, buildZoomValidationResponse
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: All 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server.js server-test-helpers.js tests/scheduled-calls.test.js
git commit -m "feat: add Zoom webhook signature verification and endpoint validation"
git push origin main
```

---

### Task 5: Server — Webhook Idempotency Helper

**Files:**
- Modify: `server.js`
- Modify: `tests/scheduled-calls.test.js`

- [ ] **Step 1: Write the webhook idempotency helper in server.js**

Add after the Zoom helpers:

```javascript
async function checkAndRecordWebhookEvent(provider, eventId, eventType, payload) {
  // Returns true if event already processed (duplicate), false if new
  if (!eventId) return false;
  const existing = await supabaseDbRequest('webhook_events', '?provider=eq.' + encodeURIComponent(provider) + '&event_id=eq.' + encodeURIComponent(eventId) + '&select=id', { method: 'GET' });
  if (existing && existing.length > 0) return true;
  // Record the event
  const redactedPayload = payload ? { event: payload.event, created_at: payload.created_at } : null;
  await supabaseDbRequest('webhook_events', '', {
    method: 'POST',
    body: [{ provider, event_id: eventId, event_type: eventType, payload: redactedPayload }]
  });
  return false;
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add webhook event idempotency helper"
git push origin main
```

---

### Task 6: Server — POST /api/admin/calls/schedule Endpoint

**Files:**
- Modify: `server.js`

This is the core admin endpoint. It creates the `scheduled_calls` record, the `registration_tasks` record, and sends notifications.

- [ ] **Step 1: Add the DoubleTick Zoom call invite helper**

Add near the existing `sendDoubleTickTemplate` function (around line 7908 in server.js):

```javascript
async function sendDoubleTickZoomCallInvite(toPhone, gpFirstName, stage, bookingUrl) {
  if (!process.env.DOUBLETICK_API_KEY) return { ok: false, error: 'DoubleTick not configured' };
  const stageDisplay = { myintealth: 'MyIntealth', amc: 'AMC', ahpra: 'AHPRA' }[stage] || stage;
  // Use direct message until template is approved
  const messageText = 'Hi ' + gpFirstName + ', your GP Link registration support officer has scheduled a Zoom assistance call to help you with your ' + stageDisplay + ' stage. Please book a time that suits you:\n\n' + bookingUrl + '\n\nThis link will let you choose from available time slots.';
  try {
    const resp = await fetch((process.env.DOUBLETICK_BASE_URL || 'https://public.doubletick.io/whatsapp') + '/message/text', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.DOUBLETICK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: toPhone, body: messageText }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, messageId: data.messageId || data.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 2: Add the Zoom call email helper**

Add near the existing `sendEmail` usage for career interviews:

```javascript
function buildZoomCallInviteEmailHtml(gpFirstName, stageDisplay, bookingUrl) {
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">'
    + '<h2 style="color:#0f172a;font-size:20px">Zoom Assistance Call</h2>'
    + '<p style="color:#334155;font-size:14px;line-height:1.6">Hi ' + gpFirstName + ',</p>'
    + '<p style="color:#334155;font-size:14px;line-height:1.6">Your GP Link registration support officer would like to schedule a Zoom call to help you with your <strong>' + stageDisplay + '</strong> stage.</p>'
    + '<p style="color:#334155;font-size:14px;line-height:1.6">Please click the button below to choose a time that works for you:</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + bookingUrl + '" style="display:inline-block;padding:12px 28px;background:#2D8CFF;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Book Your Time Slot</a>'
    + '</div>'
    + '<p style="color:#64748b;font-size:12px">If the button doesn\'t work, copy this link: ' + bookingUrl + '</p>'
    + '</div>';
}
```

- [ ] **Step 3: Add the schedule endpoint**

Find the admin API route block in `server.js` (near the career interview endpoints around line 24049). Add before the career interview routes:

```javascript
// ── Zoom Call Scheduling ──

if (method === 'POST' && pathname === '/api/admin/calls/schedule') {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }
  if (!CALENDLY_EVENT_URL) { sendJson(res, 503, { ok: false, message: 'Calendly not configured' }); return; }

  const body = await parseJsonBody(req);
  if (!body) { sendJson(res, 400, { ok: false, message: 'Invalid JSON' }); return; }

  const { case_id, user_id, stage, admin_notes, notify_whatsapp, notify_email } = body;
  if (!case_id || !user_id || !stage) { sendJson(res, 400, { ok: false, message: 'case_id, user_id, and stage are required' }); return; }
  if (!['myintealth', 'amc', 'ahpra'].includes(stage)) { sendJson(res, 400, { ok: false, message: 'stage must be myintealth, amc, or ahpra' }); return; }

  // Verify case belongs to user
  const cases = await supabaseDbRequest('registration_cases', '?id=eq.' + case_id + '&user_id=eq.' + user_id + '&select=id,user_id,stage', { method: 'GET' });
  if (!cases || cases.length === 0) { sendJson(res, 404, { ok: false, message: 'Case not found or does not belong to user' }); return; }

  // Get GP profile for notifications
  const profiles = await supabaseDbRequest('user_profiles', '?user_id=eq.' + user_id + '&select=first_name,last_name,email,phone_number,phone', { method: 'GET' });
  const gp = profiles && profiles[0];
  if (!gp) { sendJson(res, 404, { ok: false, message: 'GP profile not found' }); return; }

  const correlationToken = generateCorrelationToken();
  const bookingUrl = buildCalendlyBookingUrl(correlationToken);
  const stageDisplay = { myintealth: 'MyIntealth', amc: 'AMC', ahpra: 'AHPRA' }[stage];
  const notesText = (admin_notes || '').slice(0, 2000);

  // Create scheduled_calls record
  const callRows = await supabaseDbRequest('scheduled_calls', '', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{
      case_id, user_id, stage,
      status: 'invited',
      admin_notes: notesText,
      correlation_token: correlationToken,
      calendly_booking_url: bookingUrl,
      calendly_event_type_uri: CALENDLY_EVENT_TYPE_URI || null,
      duration_minutes: 30,
      summary_status: 'not_requested',
      created_by: admin.email || 'admin'
    }]
  });
  const call = callRows && callRows[0];
  if (!call) { sendJson(res, 500, { ok: false, message: 'Failed to create scheduled call' }); return; }

  // Create registration task
  const task = await _createRegTask(case_id, {
    task_type: 'zoom_call',
    title: 'Zoom Assistance Call \u2014 ' + stageDisplay,
    description: 'Waiting for GP to book a time slot',
    status: 'waiting_on_gp',
    priority: 'normal',
    source_trigger: 'admin_scheduled',
    related_stage: stage,
    _actor: admin.email || 'admin'
  });

  // Link task to scheduled call
  if (task && task.id) {
    await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
      method: 'PATCH',
      body: { registration_task_id: task.id }
    });
  }

  // Send notifications
  const notifications = {};
  const gpPhone = gp.phone_number || gp.phone || '';
  const gpEmail = gp.email || '';
  const gpName = gp.first_name || 'Doctor';

  if (notify_whatsapp !== false && gpPhone) {
    const waResult = await sendDoubleTickZoomCallInvite(gpPhone, gpName, stage, bookingUrl);
    notifications.whatsapp = waResult;
  }

  if (notify_email !== false && gpEmail) {
    const emailResult = await sendEmail({
      to: gpEmail,
      subject: 'Book Your Zoom Assistance Call \u2014 GP Link',
      html: buildZoomCallInviteEmailHtml(gpName, stageDisplay, bookingUrl)
    });
    notifications.email = emailResult;
  }

  // Update call with notification results
  await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
    method: 'PATCH',
    body: {
      invite_sent_at: new Date().toISOString(),
      notification_channels: notifications,
      whatsapp_message_id: (notifications.whatsapp && notifications.whatsapp.messageId) || null,
      email_message_id: (notifications.email && notifications.email.id) || null
    }
  });

  sendJson(res, 201, { ok: true, call: { id: call.id, status: 'invited', correlation_token: correlationToken, booking_url: bookingUrl }, notifications });
  return;
}
```

- [ ] **Step 4: Run the dev server and test manually**

Run: `npm start`

Test with curl (will need a valid admin session cookie):
```bash
curl -X POST http://localhost:3000/api/admin/calls/schedule \
  -H "Content-Type: application/json" \
  -H "Cookie: gp_admin_session=YOUR_SESSION" \
  -d '{"case_id":"TEST_CASE_ID","user_id":"TEST_USER_ID","stage":"ahpra","admin_notes":"Test call","notify_whatsapp":false,"notify_email":false}'
```

Expected: 201 response with call ID and correlation token (notifications will fail gracefully without real credentials).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add POST /api/admin/calls/schedule endpoint with notifications"
git push origin main
```

---

### Task 7: Server — GET /api/admin/calls and GET /api/admin/calls/:id

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the list and detail endpoints**

Add after the schedule endpoint in `server.js`:

```javascript
if (method === 'GET' && pathname === '/api/admin/calls') {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }

  const url = new URL(req.url, 'http://localhost');
  let query = '?select=id,case_id,user_id,stage,status,admin_notes,scheduled_at,timezone,duration_minutes,zoom_join_url,summary_status,created_at,booked_at,correlation_token,calendly_booking_url&order=created_at.desc';

  const stage = url.searchParams.get('stage');
  if (stage && ['myintealth', 'amc', 'ahpra'].includes(stage)) query += '&stage=eq.' + stage;

  const status = url.searchParams.get('status');
  if (status && ['invited', 'booked', 'completed', 'cancelled', 'no_show'].includes(status)) query += '&status=eq.' + status;

  const caseId = url.searchParams.get('case_id');
  if (caseId) query += '&case_id=eq.' + caseId;

  const summaryStatus = url.searchParams.get('summary_status');
  if (summaryStatus) query += '&summary_status=eq.' + summaryStatus;

  const from = url.searchParams.get('from');
  if (from) query += '&created_at=gte.' + from;
  const to = url.searchParams.get('to');
  if (to) query += '&created_at=lte.' + to;

  const rows = await supabaseDbRequest('scheduled_calls', query, { method: 'GET' });
  sendJson(res, 200, { ok: true, calls: rows || [] });
  return;
}

if (method === 'GET' && pathname.match(/^\/api\/admin\/calls\/[a-f0-9-]+$/)) {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }

  const callId = pathname.split('/').pop();
  const rows = await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId, { method: 'GET' });
  if (!rows || rows.length === 0) { sendJson(res, 404, { ok: false, message: 'Call not found' }); return; }
  sendJson(res, 200, { ok: true, call: rows[0] });
  return;
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add GET /api/admin/calls list and detail endpoints"
git push origin main
```

---

### Task 8: Server — PATCH /api/admin/calls/:id and POST /api/admin/calls/:id/resend

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the update and resend endpoints**

Add after the GET detail endpoint:

```javascript
if (method === 'PATCH' && pathname.match(/^\/api\/admin\/calls\/[a-f0-9-]+$/)) {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }

  const callId = pathname.split('/').pop();
  const body = await parseJsonBody(req);
  if (!body) { sendJson(res, 400, { ok: false, message: 'Invalid JSON' }); return; }

  // Fetch current call
  const rows = await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId + '&select=id,status,registration_task_id', { method: 'GET' });
  if (!rows || rows.length === 0) { sendJson(res, 404, { ok: false, message: 'Call not found' }); return; }
  const call = rows[0];

  const patch = {};

  // Update admin notes
  if (body.admin_notes !== undefined) {
    patch.admin_notes = String(body.admin_notes || '').slice(0, 2000);
  }

  // Mark no-show
  if (body.status === 'no_show' && call.status === 'booked') {
    patch.status = 'no_show';
    patch.no_show_at = new Date().toISOString();
    if (call.registration_task_id) {
      await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
        method: 'PATCH', body: { status: 'waiting_on_gp', description: 'No-show — reschedule needed' }
      });
    }
  }

  // Cancel
  if (body.status === 'cancelled' && ['invited', 'booked'].includes(call.status)) {
    patch.status = 'cancelled';
    patch.cancelled_at = new Date().toISOString();
    if (call.registration_task_id) {
      await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
        method: 'PATCH', body: { status: 'cancelled' }
      });
    }
  }

  if (Object.keys(patch).length === 0) { sendJson(res, 400, { ok: false, message: 'Nothing to update' }); return; }

  await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId, { method: 'PATCH', body: patch });
  sendJson(res, 200, { ok: true, updated: patch });
  return;
}

if (method === 'POST' && pathname.match(/^\/api\/admin\/calls\/[a-f0-9-]+\/resend$/)) {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }

  const callId = pathname.split('/')[4];
  const rows = await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId + '&select=*', { method: 'GET' });
  if (!rows || rows.length === 0) { sendJson(res, 404, { ok: false, message: 'Call not found' }); return; }
  const call = rows[0];

  if (call.status !== 'invited') { sendJson(res, 400, { ok: false, message: 'Can only resend for invited calls' }); return; }

  // Get GP profile
  const profiles = await supabaseDbRequest('user_profiles', '?user_id=eq.' + call.user_id + '&select=first_name,email,phone_number,phone', { method: 'GET' });
  const gp = profiles && profiles[0];
  if (!gp) { sendJson(res, 404, { ok: false, message: 'GP profile not found' }); return; }

  const gpName = gp.first_name || 'Doctor';
  const gpPhone = gp.phone_number || gp.phone || '';
  const gpEmail = gp.email || '';
  const stageDisplay = { myintealth: 'MyIntealth', amc: 'AMC', ahpra: 'AHPRA' }[call.stage];
  const bookingUrl = call.calendly_booking_url;
  const notifications = {};

  if (gpPhone) {
    notifications.whatsapp = await sendDoubleTickZoomCallInvite(gpPhone, gpName, call.stage, bookingUrl);
  }
  if (gpEmail) {
    notifications.email = await sendEmail({
      to: gpEmail,
      subject: 'Reminder: Book Your Zoom Assistance Call \u2014 GP Link',
      html: buildZoomCallInviteEmailHtml(gpName, stageDisplay, bookingUrl)
    });
  }

  await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId, {
    method: 'PATCH',
    body: { resend_count: (call.resend_count || 0) + 1, notification_channels: notifications }
  });

  sendJson(res, 200, { ok: true, resent: true, notifications });
  return;
}
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: add PATCH and resend endpoints for scheduled calls"
git push origin main
```

---

### Task 9: Server — Calendly Webhook Handler

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the Calendly webhook route**

This route must be registered **before** same-origin enforcement in `server.js`. Find the block where DoubleTick webhook is routed (around line 5105) and add the Calendly route nearby:

```javascript
if (method === 'POST' && pathname === '/api/webhooks/calendly') {
  return handleCalendlyWebhook(req, res);
}
```

- [ ] **Step 2: Implement the Calendly webhook handler**

Add the handler function near the other webhook handlers:

```javascript
async function handleCalendlyWebhook(req, res) {
  if (!CALENDLY_WEBHOOK_SECRET) { sendJson(res, 503, { ok: false, message: 'Webhook not configured' }); return; }
  if (!supabase) { sendJson(res, 503, { ok: false, message: 'Database not available' }); return; }

  // Read raw body for signature verification
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  const sigHeader = req.headers['calendly-webhook-signature'] || '';
  if (!verifyCalendlySignature(sigHeader, rawBody, CALENDLY_WEBHOOK_SECRET)) {
    sendJson(res, 401, { ok: false, message: 'Invalid signature' });
    return;
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch (e) { sendJson(res, 400, { ok: false, message: 'Invalid JSON' }); return; }

  const event = payload.event;
  if (!event) { sendJson(res, 400, { ok: false, message: 'Missing event type' }); return; }

  // Deduplicate
  const eventId = (payload.created_at || '') + '_' + (event || '');
  const isDup = await checkAndRecordWebhookEvent('calendly', eventId, event, payload);
  if (isDup) { sendJson(res, 200, { ok: true, message: 'Duplicate event' }); return; }

  // Filter: only handle our event type if configured
  if (CALENDLY_EVENT_TYPE_URI && payload.payload && payload.payload.event_type) {
    const eventTypeUri = typeof payload.payload.event_type === 'string' ? payload.payload.event_type : (payload.payload.event_type.uri || '');
    if (eventTypeUri && eventTypeUri !== CALENDLY_EVENT_TYPE_URI) {
      sendJson(res, 200, { ok: true, message: 'Ignored: different event type' });
      return;
    }
  }

  if (event === 'invitee.created') {
    await handleCalendlyInviteeCreated(payload);
  } else if (event === 'invitee.canceled') {
    await handleCalendlyInviteeCanceled(payload);
  }

  sendJson(res, 200, { ok: true });
}

async function handleCalendlyInviteeCreated(payload) {
  const invitee = payload.payload || {};
  const inviteeUri = invitee.uri || '';
  const inviteeEmail = (invitee.email || '').toLowerCase();
  const scheduledEventUri = invitee.scheduled_event ? (typeof invitee.scheduled_event === 'string' ? invitee.scheduled_event : invitee.scheduled_event.uri) : '';
  const tz = invitee.timezone || '';

  // Extract correlation token from tracking or UTM
  let correlationToken = '';
  const tracking = invitee.tracking || {};
  const utmContent = tracking.utm_content || '';
  if (utmContent.startsWith('call_')) {
    correlationToken = utmContent.slice(5);
  }

  // Match by correlation token first
  let calls = null;
  if (correlationToken) {
    calls = await supabaseDbRequest('scheduled_calls', '?correlation_token=eq.' + correlationToken + '&status=eq.invited&select=*', { method: 'GET' });
  }
  // Fallback: match by email + invited status (only if unambiguous)
  if ((!calls || calls.length === 0) && inviteeEmail) {
    const profileRows = await supabaseDbRequest('user_profiles', '?email=eq.' + encodeURIComponent(inviteeEmail) + '&select=user_id', { method: 'GET' });
    if (profileRows && profileRows.length === 1) {
      calls = await supabaseDbRequest('scheduled_calls', '?user_id=eq.' + profileRows[0].user_id + '&status=eq.invited&select=*&order=created_at.desc&limit=1', { method: 'GET' });
    }
  }

  if (!calls || calls.length === 0) return;
  const call = calls[0];

  // Extract Zoom details from event location if available
  let zoomJoinUrl = '';
  let zoomMeetingId = '';
  let zoomPasscode = '';
  const location = invitee.scheduled_event_location || invitee.location || {};
  if (location.join_url) zoomJoinUrl = location.join_url;
  if (location.data && location.data.id) zoomMeetingId = String(location.data.id);
  if (location.data && location.data.password) zoomPasscode = location.data.password;

  // Parse scheduled time from the event
  let scheduledAt = null;
  if (invitee.scheduled_event && typeof invitee.scheduled_event === 'object' && invitee.scheduled_event.start_time) {
    scheduledAt = invitee.scheduled_event.start_time;
  }

  // If we don't have event details inline, fetch from Calendly API
  if ((!scheduledAt || !zoomJoinUrl) && scheduledEventUri && CALENDLY_API_TOKEN) {
    try {
      const eventResp = await fetch(scheduledEventUri, {
        headers: { 'Authorization': 'Bearer ' + CALENDLY_API_TOKEN },
        signal: AbortSignal.timeout(10000)
      });
      if (eventResp.ok) {
        const eventData = await eventResp.json();
        const resource = eventData.resource || eventData;
        if (!scheduledAt && resource.start_time) scheduledAt = resource.start_time;
        if (!zoomJoinUrl && resource.location && resource.location.join_url) zoomJoinUrl = resource.location.join_url;
        if (!zoomMeetingId && resource.location && resource.location.data && resource.location.data.id) zoomMeetingId = String(resource.location.data.id);
      }
    } catch (e) { /* non-fatal */ }
  }

  await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
    method: 'PATCH',
    body: {
      status: 'booked',
      booked_at: new Date().toISOString(),
      scheduled_at: scheduledAt,
      timezone: tz || null,
      calendly_event_uri: scheduledEventUri || null,
      calendly_invitee_uri: inviteeUri || null,
      invitee_email: inviteeEmail || null,
      zoom_meeting_id: zoomMeetingId || null,
      zoom_join_url: zoomJoinUrl || null,
      zoom_passcode: zoomPasscode || null
    }
  });

  // Update linked registration task
  if (call.registration_task_id) {
    const scheduledDisplay = scheduledAt ? new Date(scheduledAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }) : 'TBC';
    await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
      method: 'PATCH',
      body: { status: 'waiting', description: 'Zoom call booked: ' + scheduledDisplay }
    });
  }
}

async function handleCalendlyInviteeCanceled(payload) {
  const invitee = payload.payload || {};
  const inviteeUri = invitee.uri || '';
  const isReschedule = invitee.rescheduled === true || (invitee.cancellation && invitee.cancellation.rescheduled);

  if (!inviteeUri) return;

  const calls = await supabaseDbRequest('scheduled_calls', '?calendly_invitee_uri=eq.' + encodeURIComponent(inviteeUri) + '&select=*', { method: 'GET' });
  if (!calls || calls.length === 0) return;
  const call = calls[0];

  if (isReschedule) {
    // Store old URI; the new invitee.created will update the record
    await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
      method: 'PATCH',
      body: {
        calendly_old_invitee_uri: inviteeUri,
        calendly_invitee_uri: null,
        status: 'invited',
        scheduled_at: null,
        booked_at: null
      }
    });
    if (call.registration_task_id) {
      await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
        method: 'PATCH', body: { status: 'waiting_on_gp', description: 'GP is rescheduling' }
      });
    }
  } else {
    await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
      method: 'PATCH',
      body: { status: 'cancelled', cancelled_at: new Date().toISOString() }
    });
    if (call.registration_task_id) {
      await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
        method: 'PATCH', body: { status: 'cancelled' }
      });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add Calendly webhook handler with correlation token matching"
git push origin main
```

---

### Task 10: Server — Zoom Webhook Handler

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the Zoom webhook route**

Register before same-origin enforcement, near the Calendly route:

```javascript
if (method === 'POST' && pathname === '/api/webhooks/zoom') {
  return handleZoomSchedulingWebhook(req, res);
}
```

- [ ] **Step 2: Implement the Zoom webhook handler**

```javascript
async function handleZoomSchedulingWebhook(req, res) {
  // Read raw body
  const rawBody = await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  let payload;
  try { payload = JSON.parse(rawBody); } catch (e) { sendJson(res, 400, { ok: false }); return; }

  // Handle Zoom endpoint validation challenge
  if (payload.event === 'endpoint.url_validation') {
    if (!ZOOM_WEBHOOK_SECRET) { sendJson(res, 503, { ok: false }); return; }
    const plainToken = payload.payload && payload.payload.plainToken;
    if (!plainToken) { sendJson(res, 400, { ok: false }); return; }
    const validationResp = buildZoomValidationResponse(plainToken, ZOOM_WEBHOOK_SECRET);
    sendJson(res, 200, validationResp);
    return;
  }

  // Verify signature for all other events
  if (!ZOOM_WEBHOOK_SECRET) { sendJson(res, 503, { ok: false }); return; }
  const timestamp = req.headers['x-zm-request-timestamp'] || '';
  const signature = req.headers['x-zm-signature'] || '';
  if (!verifyZoomWebhookSignature(timestamp, rawBody, signature, ZOOM_WEBHOOK_SECRET)) {
    sendJson(res, 401, { ok: false, message: 'Invalid signature' });
    return;
  }

  if (!supabase) { sendJson(res, 503, { ok: false }); return; }

  const event = payload.event;
  const eventId = (payload.event_ts || '') + '_' + (event || '');
  const isDup = await checkAndRecordWebhookEvent('zoom', eventId, event, payload);
  if (isDup) { sendJson(res, 200, { ok: true, message: 'Duplicate' }); return; }

  if (event === 'meeting.ended') {
    await handleZoomMeetingEnded(payload);
  } else if (event === 'meeting.summary_completed') {
    await handleZoomSummaryCompleted(payload);
  }

  sendJson(res, 200, { ok: true });
}

async function handleZoomMeetingEnded(payload) {
  const meetingObj = (payload.payload && payload.payload.object) || {};
  const meetingId = String(meetingObj.id || '');
  const meetingUuid = meetingObj.uuid || '';
  if (!meetingId) return;

  const calls = await supabaseDbRequest('scheduled_calls', '?zoom_meeting_id=eq.' + meetingId + '&status=eq.booked&select=id,registration_task_id', { method: 'GET' });
  if (!calls || calls.length === 0) return;
  const call = calls[0];

  await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
    method: 'PATCH',
    body: {
      status: 'completed',
      completed_at: new Date().toISOString(),
      zoom_meeting_uuid: meetingUuid || null,
      summary_status: 'pending'
    }
  });

  if (call.registration_task_id) {
    await supabaseDbRequest('registration_tasks', '?id=eq.' + call.registration_task_id, {
      method: 'PATCH', body: { status: 'completed', description: 'Zoom call completed — summary pending' }
    });
  }
}

async function handleZoomSummaryCompleted(payload) {
  const meetingObj = (payload.payload && payload.payload.object) || {};
  const meetingId = String(meetingObj.id || '');
  if (!meetingId) return;

  const calls = await supabaseDbRequest('scheduled_calls', '?zoom_meeting_id=eq.' + meetingId + '&summary_status=eq.pending&select=id,zoom_meeting_uuid', { method: 'GET' });
  if (!calls || calls.length === 0) return;
  const call = calls[0];

  await fetchAndSaveZoomSummary(call);
}

async function fetchAndSaveZoomSummary(call) {
  try {
    const token = await getZoomAccessToken();
    if (!token) throw new Error('No Zoom token');

    // Use meeting UUID if available, otherwise meeting ID
    let meetingIdForApi = call.zoom_meeting_uuid || call.zoom_meeting_id || call.id;
    // Double-encode UUIDs that start with / or contain //
    if (meetingIdForApi && (meetingIdForApi.startsWith('/') || meetingIdForApi.includes('//'))) {
      meetingIdForApi = encodeURIComponent(encodeURIComponent(meetingIdForApi));
    }

    // First try to get from the scheduled_calls zoom_meeting_id
    const rows = await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id + '&select=zoom_meeting_id,zoom_meeting_uuid,summary_fetch_attempts', { method: 'GET' });
    const current = rows && rows[0];
    if (!current) return;

    const apiMeetingId = current.zoom_meeting_uuid || current.zoom_meeting_id;
    if (!apiMeetingId) {
      await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
        method: 'PATCH', body: { summary_status: 'not_available', summary_error: 'No meeting ID available' }
      });
      return;
    }

    let encodedId = apiMeetingId;
    if (encodedId.startsWith('/') || encodedId.includes('//')) {
      encodedId = encodeURIComponent(encodeURIComponent(encodedId));
    }

    const resp = await fetch('https://api.zoom.us/v2/meetings/' + encodedId + '/meeting_summary', {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(15000)
    });

    if (resp.status === 404 || resp.status === 403) {
      await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
        method: 'PATCH',
        body: {
          summary_status: 'not_available',
          summary_error: 'Zoom returned ' + resp.status,
          summary_fetch_attempts: (current.summary_fetch_attempts || 0) + 1
        }
      });
      return;
    }

    if (!resp.ok) {
      await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
        method: 'PATCH',
        body: {
          summary_status: 'error',
          summary_error: 'Zoom returned ' + resp.status,
          summary_fetch_attempts: (current.summary_fetch_attempts || 0) + 1
        }
      });
      return;
    }

    const data = await resp.json();
    const summaryContent = data.summary_content || data.meeting_summary || '';
    const nextSteps = data.next_steps || [];

    await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
      method: 'PATCH',
      body: {
        meeting_summary: summaryContent,
        meeting_action_items: { next_steps: nextSteps, raw_keys: Object.keys(data) },
        meeting_summary_raw: data,
        summary_status: 'saved',
        summary_saved_at: new Date().toISOString(),
        summary_fetch_attempts: (current.summary_fetch_attempts || 0) + 1,
        summary_error: null
      }
    });
  } catch (e) {
    await supabaseDbRequest('scheduled_calls', '?id=eq.' + call.id, {
      method: 'PATCH',
      body: { summary_status: 'error', summary_error: e.message }
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add Zoom webhook handler with meeting.ended and summary fetch"
git push origin main
```

---

### Task 11: Server — Summary Retry Cron and Manual Fetch

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the cron endpoint and manual fetch trigger**

Add near the other cron endpoints in `server.js`:

```javascript
if (method === 'POST' && pathname === '/api/cron/call-summary-retry') {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!CALL_SCHEDULING_CRON_SECRET || token !== CALL_SCHEDULING_CRON_SECRET) {
    sendJson(res, 401, { ok: false, message: 'Unauthorized' });
    return;
  }
  if (!supabase) { sendJson(res, 503, { ok: false }); return; }

  // Find calls needing summary retry: completed, summary pending or error, < 10 attempts
  const pending = await supabaseDbRequest('scheduled_calls',
    '?status=eq.completed&summary_status=in.(pending,error)&summary_fetch_attempts=lt.10&select=id,zoom_meeting_id,zoom_meeting_uuid,summary_fetch_attempts&order=completed_at.asc&limit=5',
    { method: 'GET' }
  );

  if (!pending || pending.length === 0) {
    sendJson(res, 200, { ok: true, message: 'No pending summaries', retried: 0 });
    return;
  }

  let retried = 0;
  for (const call of pending) {
    await fetchAndSaveZoomSummary(call);
    retried++;
  }

  sendJson(res, 200, { ok: true, retried });
  return;
}
```

Add the manual admin-triggered fetch (near the other admin calls endpoints):

```javascript
if (method === 'POST' && pathname.match(/^\/api\/admin\/calls\/[a-f0-9-]+\/fetch-summary$/)) {
  const admin = requireAdminSession(req, res);
  if (!admin) return;
  if (!supabase) { sendJson(res, 503, { ok: false }); return; }

  const callId = pathname.split('/')[4];
  const rows = await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId + '&select=id,status,zoom_meeting_id,zoom_meeting_uuid,summary_status,summary_fetch_attempts', { method: 'GET' });
  if (!rows || rows.length === 0) { sendJson(res, 404, { ok: false, message: 'Call not found' }); return; }
  const call = rows[0];

  if (call.status !== 'completed') { sendJson(res, 400, { ok: false, message: 'Call must be completed first' }); return; }
  if (call.summary_status === 'saved') { sendJson(res, 400, { ok: false, message: 'Summary already saved' }); return; }

  await fetchAndSaveZoomSummary(call);

  // Fetch updated record
  const updated = await supabaseDbRequest('scheduled_calls', '?id=eq.' + callId + '&select=summary_status,summary_error', { method: 'GET' });
  sendJson(res, 200, { ok: true, summary_status: updated && updated[0] ? updated[0].summary_status : 'unknown' });
  return;
}
```

- [ ] **Step 2: Add cron to vercel.json**

Read `vercel.json` first to understand the existing structure, then add:

```json
{
  "path": "/api/cron/call-summary-retry",
  "schedule": "0 */2 * * *"
}
```

(Every 2 hours — Hobby tier supports daily crons only, so this may need to be `0 0 * * *` on Hobby. Adjust based on tier.)

- [ ] **Step 3: Commit**

```bash
git add server.js vercel.json
git commit -m "feat: add summary retry cron and manual fetch-summary endpoint"
git push origin main
```

---

### Task 12: Admin UI — Schedule Zoom Call Modal

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add modal CSS**

Add to the `<style>` block in `admin.html` (near the end of existing styles):

```css
.zoom-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
.zoom-modal-overlay.open{opacity:1;pointer-events:all}
.zoom-modal{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.15);width:480px;max-width:90vw;max-height:90vh;overflow-y:auto}
.zoom-modal-header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.zoom-modal-header h2{font-size:16px;font-weight:800;flex:1;margin:0}
.zoom-modal-close{width:28px;height:28px;border-radius:8px;border:1px solid var(--line);background:#fff;display:grid;place-items:center;font-size:14px;color:var(--muted);cursor:pointer}
.zoom-modal-body{padding:20px}
.zoom-form-group{margin-bottom:16px}
.zoom-form-label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);margin-bottom:6px}
.zoom-form-select,.zoom-form-textarea{width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--line);font-size:13px;font-family:inherit;background:#fff}
.zoom-form-textarea{min-height:100px;resize:vertical}
.zoom-form-hint{font-size:10px;color:var(--muted);margin-top:4px;font-style:italic}
.zoom-form-checkboxes{display:flex;gap:14px}
.zoom-form-checkboxes label{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;cursor:pointer}
.zoom-modal-footer{padding:14px 20px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}
.zoom-gp-block{background:#f0f7ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px}
.zoom-gp-block .case-avatar{width:36px;height:36px;font-size:12px}
```

- [ ] **Step 2: Add modal HTML**

Add before the closing `</body>` tag in `admin.html`:

```html
<div class="zoom-modal-overlay" id="zoomScheduleOverlay">
  <div class="zoom-modal">
    <div class="zoom-modal-header">
      <div style="width:28px;height:28px;border-radius:8px;background:#2D8CFF;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:800">Z</div>
      <h2>Schedule Assistance Call</h2>
      <div class="zoom-modal-close" onclick="closeZoomScheduleModal()">&times;</div>
    </div>
    <div class="zoom-modal-body">
      <div class="zoom-gp-block" id="zoomGpBlock"></div>
      <div class="zoom-form-group">
        <label class="zoom-form-label">Registration Stage</label>
        <select class="zoom-form-select" id="zoomStageSelect">
          <option value="myintealth">MyIntealth</option>
          <option value="amc">AMC</option>
          <option value="ahpra">AHPRA</option>
        </select>
      </div>
      <div class="zoom-form-group">
        <label class="zoom-form-label">Internal Notes <span style="font-weight:500;text-transform:none;letter-spacing:0;color:#b45309">(admin only — GP won't see this)</span></label>
        <textarea class="zoom-form-textarea" id="zoomAdminNotes" placeholder="What does the GP need help with? What should you review before the call?"></textarea>
      </div>
      <div class="zoom-form-group">
        <label class="zoom-form-label">Notify GP via</label>
        <div class="zoom-form-checkboxes">
          <label><input type="checkbox" id="zoomNotifyWhatsapp" checked> WhatsApp</label>
          <label><input type="checkbox" id="zoomNotifyEmail" checked> Email</label>
        </div>
      </div>
    </div>
    <div class="zoom-modal-footer">
      <button class="btn" onclick="closeZoomScheduleModal()">Cancel</button>
      <button class="btn primary" id="zoomScheduleBtn" style="background:#2D8CFF;border-color:#2D8CFF" onclick="submitZoomSchedule()">Send Calendly Invite</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add modal JavaScript**

Add to the `<script>` section in `admin.html`:

```javascript
// ── Zoom Call Scheduling Modal ──
let _zoomScheduleCase = null;

function openZoomScheduleModal(caseData) {
  _zoomScheduleCase = caseData;
  const overlay = document.getElementById('zoomScheduleOverlay');
  const gpBlock = document.getElementById('zoomGpBlock');
  const stageSelect = document.getElementById('zoomStageSelect');
  const notesField = document.getElementById('zoomAdminNotes');

  const initials = ((caseData.first_name || '')[0] || '') + ((caseData.last_name || '')[0] || '');
  gpBlock.innerHTML = '<div class="case-avatar" style="width:36px;height:36px;font-size:12px">' + initials.toUpperCase() + '</div>'
    + '<div><div style="font-size:13px;font-weight:700">' + (caseData.first_name || '') + ' ' + (caseData.last_name || '') + '</div>'
    + '<div style="font-size:11px;color:var(--muted)">' + (caseData.email || '') + (caseData.phone ? ' · ' + caseData.phone : '') + '</div></div>';

  stageSelect.value = caseData.stage || 'myintealth';
  notesField.value = '';
  document.getElementById('zoomNotifyWhatsapp').checked = true;
  document.getElementById('zoomNotifyEmail').checked = true;
  document.getElementById('zoomScheduleBtn').disabled = false;
  document.getElementById('zoomScheduleBtn').textContent = 'Send Calendly Invite';

  overlay.classList.add('open');
}

function closeZoomScheduleModal() {
  document.getElementById('zoomScheduleOverlay').classList.remove('open');
  _zoomScheduleCase = null;
}

async function submitZoomSchedule() {
  if (!_zoomScheduleCase) return;
  const btn = document.getElementById('zoomScheduleBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const resp = await fetch('/api/admin/calls/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        case_id: _zoomScheduleCase.case_id,
        user_id: _zoomScheduleCase.user_id,
        stage: document.getElementById('zoomStageSelect').value,
        admin_notes: document.getElementById('zoomAdminNotes').value.trim(),
        notify_whatsapp: document.getElementById('zoomNotifyWhatsapp').checked,
        notify_email: document.getElementById('zoomNotifyEmail').checked
      })
    });
    const data = await resp.json();
    if (data.ok) {
      closeZoomScheduleModal();
      showToast('Calendly invite sent to GP');
      renderDetail();
    } else {
      alert('Failed: ' + (data.message || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = 'Send Calendly Invite';
    }
  } catch (e) {
    alert('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send Calendly Invite';
  }
}
```

- [ ] **Step 4: Add "Schedule Zoom Call" button to the case detail header**

In the `renderDetail()` function (around line 3193 in `admin.html`), find where action buttons are rendered in `d-actions`. Add the Zoom button. Look for the line that creates action buttons (near `pb-pills` or the nudge button) and add:

```javascript
+ '<button class="btn" style="background:#2D8CFF;color:#fff;border-color:#2D8CFF" onclick="openZoomScheduleModal({case_id:\'' + c.id + '\',user_id:\'' + c.user_id + '\',stage:\'' + (c.stage||'') + '\',first_name:\'' + (gp.first_name||'').replace(/'/g,"\\'") + '\',last_name:\'' + (gp.last_name||'').replace(/'/g,"\\'") + '\',email:\'' + (gp.email||'') + '\',phone:\'' + (gp.phone_number||gp.phone||'') + '\'})">📹 Schedule Zoom Call</button>'
```

- [ ] **Step 5: Test in browser**

Run: `npm start`, open http://localhost:3000/pages/admin.html, select a GP case, click "Schedule Zoom Call" button.

Expected: Modal opens with GP info pre-filled, stage dropdown defaults to current stage, notes field is empty, both notification checkboxes checked.

- [ ] **Step 6: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Schedule Zoom Call modal to admin dashboard"
git push origin main
```

---

### Task 13: Admin UI — Zoom Task Card on Case

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add Zoom task card CSS**

Add to the `<style>` block:

```css
.zoom-task-card{background:linear-gradient(135deg,#f0f7ff,#e8f4fd);border:1px solid #bfdbfe;border-radius:10px;padding:12px;margin-top:8px}
.zoom-task-card.completed{background:linear-gradient(135deg,#ecfdf5,#d1fae5);border-color:#a7f3d0}
.zoom-task-card.cancelled{background:#f8fafc;border-color:var(--line);opacity:.6}
.zoom-task-card.no-show{background:#fef2f2;border-color:#fecaca}
.zoom-task-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.zoom-task-icon{width:24px;height:24px;border-radius:6px;background:#2D8CFF;display:grid;place-items:center;color:#fff;font-size:11px;font-weight:800}
.zoom-task-title{font-size:13px;font-weight:700;color:#1e40af;flex:1}
.zoom-task-time{font-size:12px;color:var(--text);font-weight:600}
.zoom-task-details{display:grid;gap:4px}
.zoom-task-detail{font-size:11px;color:var(--muted)}
.zoom-task-detail strong{color:var(--text);font-weight:600}
.zoom-task-notes{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin-top:8px;font-size:11px}
.zoom-task-notes-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--amber);margin-bottom:3px}
.zoom-task-actions{display:flex;gap:6px;margin-top:8px}
.zoom-summary-toggle{cursor:pointer;color:var(--blue);font-weight:700;font-size:12px;margin-top:8px}
.zoom-summary-content{margin-top:8px;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;background:#fff;border-radius:8px;padding:10px;border:1px solid var(--line)}
.zoom-action-items{margin-top:6px;padding:0 0 0 16px}
.zoom-action-items li{font-size:11px;color:var(--text);margin:3px 0}
```

- [ ] **Step 2: Add the Zoom task card render function**

Add to the `<script>` section:

```javascript
function renderZoomTaskCard(call) {
  const stageDisplay = {myintealth:'MyIntealth',amc:'AMC',ahpra:'AHPRA'}[call.stage] || call.stage;
  const statusClass = call.status === 'completed' ? 'completed' : call.status === 'cancelled' ? 'cancelled' : call.status === 'no_show' ? 'no-show' : '';
  let h = '<div class="zoom-task-card ' + statusClass + '">';
  h += '<div class="zoom-task-header"><div class="zoom-task-icon">Z</div>';

  if (call.status === 'invited') {
    h += '<div class="zoom-task-title">Waiting for GP to book</div>';
    h += '</div>';
    h += '<div class="zoom-task-details"><div class="zoom-task-detail"><strong>Stage:</strong> ' + stageDisplay + '</div>';
    h += '<div class="zoom-task-detail"><strong>Invited:</strong> ' + new Date(call.created_at).toLocaleDateString('en-AU', {dateStyle:'medium'}) + '</div></div>';
    h += '<div class="zoom-task-actions"><button class="btn sm primary" style="background:#2D8CFF;border-color:#2D8CFF" onclick="resendZoomInvite(\'' + call.id + '\')">Resend Invite</button></div>';
  } else if (call.status === 'booked') {
    const dt = call.scheduled_at ? new Date(call.scheduled_at).toLocaleString('en-AU', {dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney'}) : 'TBC';
    h += '<div class="zoom-task-title">Booked: ' + dt + '</div>';
    h += '</div>';
    h += '<div class="zoom-task-details"><div class="zoom-task-detail"><strong>Stage:</strong> ' + stageDisplay + '</div>';
    h += '<div class="zoom-task-detail"><strong>Duration:</strong> ' + (call.duration_minutes || 30) + ' min</div>';
    if (call.timezone) h += '<div class="zoom-task-detail"><strong>GP Timezone:</strong> ' + call.timezone + '</div>';
    h += '</div>';
    h += '<div class="zoom-task-actions">';
    if (call.zoom_join_url) h += '<button class="btn sm primary" onclick="window.open(\'' + call.zoom_join_url + '\',\'_blank\')">Join Zoom</button>';
    h += '<button class="btn sm" onclick="cancelZoomCall(\'' + call.id + '\')">Cancel</button>';
    h += '<button class="btn sm" style="color:var(--red)" onclick="markZoomNoShow(\'' + call.id + '\')">No-show</button></div>';
  } else if (call.status === 'completed') {
    const dt = call.scheduled_at ? new Date(call.scheduled_at).toLocaleString('en-AU', {dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney'}) : '';
    h += '<div class="zoom-task-title" style="color:#166534">Completed' + (dt ? ' — ' + dt : '') + '</div>';
    h += '</div>';
    if (call.summary_status === 'saved' && call.meeting_summary) {
      h += '<div class="zoom-summary-toggle" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'">View Meeting Summary ▾</div>';
      h += '<div style="display:none"><div class="zoom-summary-content">' + escapeHtml(call.meeting_summary) + '</div>';
      if (call.meeting_action_items && call.meeting_action_items.next_steps && call.meeting_action_items.next_steps.length) {
        h += '<div style="font-size:11px;font-weight:700;margin-top:8px;color:var(--amber)">Action Items:</div><ul class="zoom-action-items">';
        call.meeting_action_items.next_steps.forEach(function(s) { h += '<li>' + escapeHtml(typeof s === 'string' ? s : s.text || JSON.stringify(s)) + '</li>'; });
        h += '</ul>';
      }
      h += '</div>';
    } else if (call.summary_status === 'pending') {
      h += '<div class="zoom-task-detail" style="margin-top:4px;color:var(--amber);font-weight:600">Summary processing...</div>';
      h += '<div class="zoom-task-actions"><button class="btn sm" onclick="retryZoomSummary(\'' + call.id + '\')">Retry Fetch</button></div>';
    } else if (call.summary_status === 'error' || call.summary_status === 'not_available') {
      h += '<div class="zoom-task-detail" style="margin-top:4px;color:var(--red);font-weight:600">Summary ' + (call.summary_status === 'error' ? 'fetch failed' : 'not available') + '</div>';
      h += '<div class="zoom-task-actions"><button class="btn sm" onclick="retryZoomSummary(\'' + call.id + '\')">Retry</button></div>';
    }
  } else if (call.status === 'cancelled') {
    h += '<div class="zoom-task-title" style="color:var(--muted)">Cancelled</div></div>';
  } else if (call.status === 'no_show') {
    h += '<div class="zoom-task-title" style="color:var(--red)">No-show</div></div>';
    h += '<div class="zoom-task-actions"><button class="btn sm primary" style="background:#2D8CFF;border-color:#2D8CFF" onclick="openZoomScheduleModal({case_id:\'' + call.case_id + '\',user_id:\'' + call.user_id + '\',stage:\'' + call.stage + '\'})">Reschedule</button></div>';
  }

  // Admin notes (all statuses)
  if (call.admin_notes) {
    h += '<div class="zoom-task-notes"><div class="zoom-task-notes-label">Admin Notes (internal)</div>' + escapeHtml(call.admin_notes) + '</div>';
  }

  h += '</div>';
  return h;
}

async function resendZoomInvite(callId) {
  if (!confirm('Resend Calendly invite to GP?')) return;
  const r = await fetch('/api/admin/calls/' + callId + '/resend', { method: 'POST' });
  const d = await r.json();
  if (d.ok) showToast('Invite resent');
  else alert('Failed: ' + (d.message || 'Unknown error'));
}

async function cancelZoomCall(callId) {
  if (!confirm('Cancel this Zoom call?')) return;
  const r = await fetch('/api/admin/calls/' + callId, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status:'cancelled'}) });
  const d = await r.json();
  if (d.ok) { showToast('Call cancelled'); renderDetail(); }
  else alert('Failed: ' + (d.message || 'Unknown error'));
}

async function markZoomNoShow(callId) {
  if (!confirm('Mark GP as no-show?')) return;
  const r = await fetch('/api/admin/calls/' + callId, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status:'no_show'}) });
  const d = await r.json();
  if (d.ok) { showToast('Marked as no-show'); renderDetail(); }
  else alert('Failed: ' + (d.message || 'Unknown error'));
}

async function retryZoomSummary(callId) {
  const r = await fetch('/api/admin/calls/' + callId + '/fetch-summary', { method: 'POST' });
  const d = await r.json();
  showToast('Summary fetch: ' + (d.summary_status || 'attempted'));
  renderDetail();
}
```

- [ ] **Step 3: Integrate Zoom task cards into the Tasks tab rendering**

Find the function that renders tasks for a GP case (likely `renderGpTasksPane` or the task rendering loop inside `renderDetail`). After the existing task rows are rendered, add a block to fetch and render scheduled calls:

```javascript
// Inside renderGpTasksPane or similar, after rendering regular tasks:
// Fetch scheduled calls for this case
fetch('/api/admin/calls?case_id=' + caseId)
  .then(r => r.json())
  .then(data => {
    if (!data.ok || !data.calls || !data.calls.length) return;
    const container = document.getElementById('zoom-calls-' + caseId);
    if (!container) return;
    let h = '<div style="margin-top:12px"><div class="section-title" style="font-size:13px">Zoom Calls <span class="cnt">' + data.calls.length + '</span></div>';
    data.calls.forEach(function(call) { h += renderZoomTaskCard(call); });
    h += '</div>';
    container.innerHTML = h;
  });
```

Add a container div `<div id="zoom-calls-{caseId}"></div>` in the tasks pane HTML output.

- [ ] **Step 4: Test in browser**

Open admin dashboard, select a GP case. Verify Zoom call cards render for any calls created via the schedule endpoint.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Zoom task cards to GP case Tasks tab"
git push origin main
```

---

### Task 14: Admin UI — Scheduled Calls Tab

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add the Scheduled Calls tab to top-level navigation**

Find where view tabs are defined (around line 1903 in the tab switching logic). Add `scheduled_calls` as a new view option. Add a tab element in the view-tabs HTML:

```javascript
// In the view tab bar HTML, add:
'<div class="view-tab' + (S.view === 'scheduled_calls' ? ' active' : '') + '" data-view="scheduled_calls">Calls</div>'
```

In the view switching logic, add:

```javascript
if (S.view === 'scheduled_calls') { renderScheduledCallsPanel(); return; }
```

- [ ] **Step 2: Add the Scheduled Calls panel render function**

```javascript
async function renderScheduledCallsPanel() {
  const panel = document.querySelector('.detail-panel') || document.querySelector('.list-panel');
  // Use the full layout area for the calls view
  const layout = document.querySelector('.layout');
  if (layout) layout.innerHTML = '<div style="padding:20px;background:var(--bg);overflow-y:auto;height:calc(100vh - 48px)" id="scheduledCallsView"></div>';
  const container = document.getElementById('scheduledCallsView');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading calls...</div>';

  const resp = await fetch('/api/admin/calls');
  const data = await resp.json();
  if (!data.ok) { container.innerHTML = '<div style="padding:20px;color:var(--red)">Failed to load calls</div>'; return; }

  const calls = data.calls || [];

  // Group by date
  const today = new Date(); today.setHours(0,0,0,0);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
  const groups = { today: [], thisWeek: [], later: [], unbooked: [] };

  calls.forEach(function(c) {
    if (c.status === 'invited') { groups.unbooked.push(c); return; }
    if (!c.scheduled_at) { groups.unbooked.push(c); return; }
    const d = new Date(c.scheduled_at); d.setHours(0,0,0,0);
    if (d.getTime() === today.getTime()) groups.today.push(c);
    else if (d < weekEnd) groups.thisWeek.push(c);
    else groups.later.push(c);
  });

  let h = '<div style="max-width:900px;margin:0 auto">';
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px"><h2 style="font-size:20px;font-weight:800;margin:0">Scheduled Calls</h2>';
  h += '<div style="font-size:12px;color:var(--muted);font-weight:600">' + calls.filter(function(c){return c.status==='booked'}).length + ' upcoming</div></div>';

  h += '<div style="background:#fff;border-radius:12px;border:1px solid var(--line);overflow:hidden">';

  function renderCallGroup(label, groupCalls, labelColor) {
    if (!groupCalls.length) return '';
    let g = '<div style="padding:8px 16px 4px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:' + (labelColor || 'var(--muted)') + '">' + label + '</div>';
    groupCalls.forEach(function(c) {
      const stageDisplay = {myintealth:'MyIntealth',amc:'AMC',ahpra:'AHPRA'}[c.stage] || c.stage;
      const dt = c.scheduled_at ? new Date(c.scheduled_at) : null;
      const statusBadge = c.status === 'booked' ? '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#ecfdf5;color:#166534">Confirmed</span>'
        : c.status === 'completed' ? '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#eff6ff;color:#1d4ed8">Completed</span>'
        : c.status === 'invited' ? '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#fffbeb;color:#92400e">Awaiting booking</span>'
        : c.status === 'cancelled' ? '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#f1f5f9;color:#64748b">Cancelled</span>'
        : c.status === 'no_show' ? '<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#fef2f2;color:#dc2626">No-show</span>' : '';

      g += '<div style="display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid #f1f5f9;cursor:pointer" onclick="navigateToCase(\'' + c.case_id + '\')">';
      if (dt) {
        g += '<div style="text-align:center;min-width:50px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted)">' + dt.toLocaleDateString('en-AU',{weekday:'short'}) + '</div>';
        g += '<div style="font-size:20px;font-weight:800;line-height:1.1">' + dt.getDate() + '</div>';
        g += '<div style="font-size:11px;font-weight:600;color:var(--blue)">' + dt.toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit',timeZone:'Australia/Sydney'}) + '</div></div>';
      } else {
        g += '<div style="text-align:center;min-width:50px;color:var(--muted);font-size:11px">No date</div>';
      }
      g += '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700">' + escapeHtml(c.admin_notes ? c.admin_notes.slice(0,60) : 'Zoom Call') + '</div>';
      g += '<div style="font-size:11px;color:var(--muted);margin-top:2px"><span class="case-stage-pill stage-' + c.stage + '" style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:800;text-transform:uppercase">' + stageDisplay + '</span></div></div>';
      g += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">' + statusBadge;
      if (c.status === 'booked' && c.zoom_join_url) g += '<button class="btn sm primary" style="background:#2D8CFF;border-color:#2D8CFF" onclick="event.stopPropagation();window.open(\'' + c.zoom_join_url + '\',\'_blank\')">Join</button>';
      g += '</div></div>';
    });
    return g;
  }

  h += renderCallGroup('Today', groups.today, 'var(--red)');
  h += renderCallGroup('This Week', groups.thisWeek);
  h += renderCallGroup('Later', groups.later);
  h += renderCallGroup('Awaiting Booking', groups.unbooked, 'var(--amber)');

  if (!calls.length) h += '<div style="padding:40px;text-align:center;color:var(--muted);font-size:14px">No scheduled calls yet</div>';

  h += '</div></div>';
  container.innerHTML = h;
}

function navigateToCase(caseId) {
  S.view = 'gps';
  S.selectedCase = caseId;
  loadAll();
}
```

- [ ] **Step 3: Test in browser**

Navigate to admin dashboard, click the "Calls" tab. Verify it shows grouped calls (or empty state).

- [ ] **Step 4: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Scheduled Calls tab to admin dashboard"
git push origin main
```

---

### Task 15: Admin UI — Call History Section on GP Case

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Add Call History as a new GP detail sub-tab**

Find the tab bar in the GP detail rendering (around line 3201 where "Tasks", "Notes", "Documents", "Timeline" tabs are defined). Add a "Call History" tab:

```javascript
'<div class="gp-subtab ' + (tab === 'call_history' ? 'active' : '') + '" data-gp-tab="call_history">Calls</div>'
```

- [ ] **Step 2: Add the call history pane render function**

```javascript
async function renderGpCallHistoryPane(caseId) {
  const resp = await fetch('/api/admin/calls?case_id=' + caseId + '&status=completed');
  const data = await resp.json();
  const calls = (data.ok && data.calls) ? data.calls : [];

  if (!calls.length) return '<div style="padding:20px;color:var(--muted);text-align:center;font-size:13px">No completed calls yet</div>';

  let h = '';
  calls.forEach(function(call) {
    const stageDisplay = {myintealth:'MyIntealth',amc:'AMC',ahpra:'AHPRA'}[call.stage] || call.stage;
    const dt = call.scheduled_at ? new Date(call.scheduled_at).toLocaleString('en-AU', {dateStyle:'medium',timeStyle:'short',timeZone:'Australia/Sydney'}) : 'Unknown date';

    h += '<div class="section" style="margin-bottom:12px">';
    h += '<div class="section-title" style="font-size:13px"><span style="color:#2D8CFF;margin-right:6px">📹</span>' + stageDisplay + ' Call — ' + dt + '</div>';

    if (call.admin_notes) {
      h += '<div style="font-size:11px;color:var(--amber);font-weight:700;margin-bottom:4px">PRE-CALL NOTES</div>';
      h += '<div style="font-size:12px;color:var(--text);margin-bottom:12px;background:#fffbeb;border-radius:8px;padding:8px 10px;border:1px solid #fde68a">' + escapeHtml(call.admin_notes) + '</div>';
    }

    if (call.summary_status === 'saved' && call.meeting_summary) {
      h += '<div style="font-size:11px;color:var(--green);font-weight:700;margin-bottom:4px">MEETING SUMMARY</div>';
      h += '<div style="font-size:12px;line-height:1.6;white-space:pre-wrap;background:#ecfdf5;border-radius:8px;padding:10px;border:1px solid #a7f3d0">' + escapeHtml(call.meeting_summary) + '</div>';

      if (call.meeting_action_items && call.meeting_action_items.next_steps && call.meeting_action_items.next_steps.length) {
        h += '<div style="font-size:11px;color:var(--amber);font-weight:700;margin-top:8px;margin-bottom:4px">ACTION ITEMS</div>';
        h += '<ul style="margin:0;padding:0 0 0 16px">';
        call.meeting_action_items.next_steps.forEach(function(s) {
          h += '<li style="font-size:12px;margin:3px 0">' + escapeHtml(typeof s === 'string' ? s : s.text || JSON.stringify(s)) + '</li>';
        });
        h += '</ul>';
      }
    } else if (call.summary_status === 'pending') {
      h += '<div style="font-size:12px;color:var(--amber);font-weight:600">Summary processing...</div>';
    } else {
      h += '<div style="font-size:12px;color:var(--muted)">No summary available</div>';
    }

    h += '</div>';
  });

  return h;
}
```

- [ ] **Step 3: Wire the tab content into renderDetail**

In the tab content rendering section (where `renderGpTasksPane`, `renderGpNotesPane` etc. are called), add:

```javascript
if (S.gpsProfileTab === 'call_history') {
  renderGpCallHistoryPane(c.id).then(function(html) {
    const pane = document.getElementById('gp-tab-content');
    if (pane) pane.innerHTML = html;
  });
}
```

- [ ] **Step 4: Test in browser**

Select a GP with completed calls, click the "Calls" sub-tab. Verify summaries and action items render.

- [ ] **Step 5: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Call History sub-tab to GP case detail"
git push origin main
```

---

### Task 16: AI Profile Summary Integration

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Find the AI profile summary generation code**

Locate the endpoint or function that generates the AI summary for GP profiles. It likely calls the Anthropic API with GP context. Find where the prompt is assembled.

- [ ] **Step 2: Add call history to the AI summary context**

When building the context for the AI profile summary, fetch completed calls with summaries:

```javascript
// Fetch call history for AI context
let callHistoryContext = '';
if (supabase && caseId) {
  const callRows = await supabaseDbRequest('scheduled_calls',
    '?case_id=eq.' + caseId + '&status=eq.completed&summary_status=eq.saved&select=stage,scheduled_at,admin_notes,meeting_summary,meeting_action_items&order=scheduled_at.desc&limit=5',
    { method: 'GET' }
  );
  if (callRows && callRows.length) {
    callHistoryContext = '\n\n## Assistance Call History (internal admin records)\n';
    callRows.forEach(function(c) {
      const stageDisplay = {myintealth:'MyIntealth',amc:'AMC',ahpra:'AHPRA'}[c.stage] || c.stage;
      callHistoryContext += '\n### ' + stageDisplay + ' Call — ' + (c.scheduled_at || 'unknown date') + '\n';
      if (c.admin_notes) callHistoryContext += 'Admin pre-call notes: ' + c.admin_notes + '\n';
      if (c.meeting_summary) callHistoryContext += 'Meeting summary: ' + c.meeting_summary + '\n';
      if (c.meeting_action_items && c.meeting_action_items.next_steps) {
        callHistoryContext += 'Action items: ' + c.meeting_action_items.next_steps.map(function(s) { return typeof s === 'string' ? s : s.text || ''; }).join('; ') + '\n';
      }
    });
  }
}
```

Append `callHistoryContext` to the existing prompt context, clearly labelled so the AI knows it's internal admin data.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: include call history in AI profile summary context"
git push origin main
```

---

### Task 17: Setup Documentation

**Files:**
- Create: `docs/setup-zoom-scheduling.md`

- [ ] **Step 1: Write the setup guide**

```markdown
# Zoom Call Scheduling — Setup Guide

## Prerequisites

- **Calendly Pro** (or Teams) plan — needed for API access and webhooks
- **Zoom Workplace Pro** (or higher) — needed for AI Companion meeting summaries
- **DoubleTick** WhatsApp account (already configured)
- **Resend** email account (already configured)

---

## Step 1: Calendly Setup

### 1a. Create the Event Type

1. Log in to [calendly.com](https://calendly.com)
2. Click **Create** → **Event Type** → **One-on-One**
3. Configure:
   - **Name:** GP Registration Assistance
   - **Duration:** 30 minutes
   - **Location:** Zoom (connect your Zoom account if not already)
4. Under **Availability**, set your recurring weekly schedule
5. Save the event type
6. Copy the **scheduling link** (e.g., `https://calendly.com/yourname/gp-registration-assistance`)

### 1b. Generate API Token

1. Go to [calendly.com/integrations/api_webhooks](https://calendly.com/integrations/api_webhooks)
2. Click **Generate New Token**
3. Copy the token — this is your `CALENDLY_API_TOKEN`

### 1c. Get Event Type URI

1. Using your API token, call:
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" https://api.calendly.com/event_types?user=https://api.calendly.com/users/YOUR_USER_ID
   ```
2. Find the event type with name "GP Registration Assistance"
3. Copy its `uri` — this is your `CALENDLY_EVENT_TYPE_URI`

### 1d. Configure Webhook

1. Go to Calendly webhook settings or use the API:
   ```bash
   curl -X POST https://api.calendly.com/webhook_subscriptions \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://app.mygplink.com.au/api/webhooks/calendly",
       "events": ["invitee.created", "invitee.canceled"],
       "organization": "https://api.calendly.com/organizations/YOUR_ORG_ID",
       "scope": "organization",
       "signing_key": "YOUR_CHOSEN_SECRET"
     }'
   ```
2. The `signing_key` you choose becomes your `CALENDLY_WEBHOOK_SECRET`

### 1e. Test Webhook Payload

1. Create a test booking on your Calendly link
2. Verify the webhook fires and includes UTM tracking data (`utm_content`)
3. If UTM tracking is not included, configure a required custom question in Calendly and update the correlation matching logic

---

## Step 2: Zoom AI Companion Setup

### 2a. Enable AI Companion

1. Log in to [zoom.us/signin](https://zoom.us/signin) as admin
2. Go to **Settings** → **AI Companion**
3. Enable **Meeting summary with AI Companion**
4. Set **Automatically start summary** to On
5. Under summary sharing, ensure API access is enabled (not email-only)

### 2b. Configure Webhook

1. Go to [marketplace.zoom.us](https://marketplace.zoom.us) → your Server-to-Server OAuth app
2. Under **Feature** → **Event Subscriptions**, add:
   - Event: `meeting.ended`
   - Event: `meeting.summary_completed`
   - Endpoint URL: `https://app.mygplink.com.au/api/webhooks/zoom`
3. Copy the **Secret Token** — this is your `ZOOM_WEBHOOK_SECRET`
4. Save and activate

### 2c. Add Required Scopes

1. In your Server-to-Server OAuth app, go to **Scopes**
2. Add: `meeting:read:summary:admin` (or `meeting_summary:read:admin`)
3. Save changes

---

## Step 3: DoubleTick Template (Optional)

Submit a new WhatsApp template `zoom_call_invite` with placeholders:
- `{{1}}` — GP first name
- `{{2}}` — Stage name
- `{{3}}` — Booking URL

Until the template is approved, the system sends direct text messages.

---

## Step 4: Set Environment Variables

Add these to Vercel (via CLI or dashboard):

```bash
vercel env add CALENDLY_API_TOKEN
vercel env add CALENDLY_EVENT_URL
vercel env add CALENDLY_EVENT_TYPE_URI
vercel env add CALENDLY_WEBHOOK_SECRET
vercel env add ZOOM_WEBHOOK_SECRET
```

Ensure `CRON_SECRET` is set (may already exist).

Redeploy after setting all variables.

---

## Step 5: Run the Migration

Apply `supabase/migrations/20260609000000_scheduled_calls.sql` to your Supabase project.

---

## Step 6: Smoke Test

1. **Schedule a call** from the admin dashboard for a test GP
2. **Book the call** using the Calendly link — verify the task updates to "Booked"
3. **Check the Scheduled Calls tab** — verify the call appears
4. **Start and end a short Zoom call** — verify status changes to "Completed"
5. **Wait for summary** — verify the AI Companion summary appears (or trigger retry manually)
6. **Check Call History tab** — verify the summary and action items display
7. **Test cancellation** — cancel a booking and verify status updates
8. **Test reschedule** — reschedule a booking via Calendly and verify the record updates correctly
```

- [ ] **Step 2: Commit**

```bash
git add docs/setup-zoom-scheduling.md
git commit -m "docs: add Zoom call scheduling setup guide"
git push origin main
```

---

### Task 18: Verification and Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run all tests**

Run: `npx vitest run tests/scheduled-calls.test.js`

Expected: All tests PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: No regressions.

- [ ] **Step 3: Start dev server and verify end-to-end**

Run: `npm start`

Verify in browser at http://localhost:3000/pages/admin.html:
- [ ] "Schedule Zoom Call" button appears on GP cases
- [ ] Modal opens and submits without errors
- [ ] Zoom task cards render in Tasks tab
- [ ] Scheduled Calls tab loads and groups calls
- [ ] Call History sub-tab shows completed calls
- [ ] No console errors

- [ ] **Step 4: Deploy to Vercel**

Run: `vercel --prod` (after env vars are set)

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: zoom call scheduling final cleanup"
git push origin main
```
