import { describe, it, expect } from 'vitest';
const crypto = require('crypto');

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

    it('maps cancelled to waiting_on_gp (task stays open as needs-rebooking)', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('cancelled')).toBe('waiting_on_gp');
    });

    it('maps no_show to waiting_on_gp', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('no_show')).toBe('waiting_on_gp');
    });
  });

  describe('computeCallFailureOutcome (2-strike auto-close)', () => {
    const { computeCallFailureOutcome } = require('../server-test-helpers.js');

    it('first GP-driven failure keeps the task open (rebooking grace)', () => {
      const out = computeCallFailureOutcome(0);
      expect(out).toEqual({ newCount: 1, autoClose: false });
    });

    it('second GP-driven failure auto-closes the task', () => {
      const out = computeCallFailureOutcome(1);
      expect(out).toEqual({ newCount: 2, autoClose: true });
    });

    it('treats null/undefined previous count as zero', () => {
      expect(computeCallFailureOutcome(null)).toEqual({ newCount: 1, autoClose: false });
      expect(computeCallFailureOutcome(undefined)).toEqual({ newCount: 1, autoClose: false });
    });

    it('stays auto-closed for any further failures', () => {
      expect(computeCallFailureOutcome(2).autoClose).toBe(true);
      expect(computeCallFailureOutcome(5).autoClose).toBe(true);
    });
  });

  describe('scheduled_calls payload builders', () => {
    it('builds insert payload with migration column names', () => {
      const { buildScheduledCallInsertPayload } = require('../server-test-helpers.js');
      const nowIso = '2026-06-09T12:00:00.000Z';
      const payload = buildScheduledCallInsertPayload({
        caseId: 'case-1',
        userId: 'user-1',
        stage: 'ahpra',
        adminNotes: 'Needs help with portal',
        correlationToken: 'abc123',
        bookingUrl: 'https://calendly.example/gp?utm_content=call_abc123',
        calendlyEventTypeUri: 'https://api.calendly.com/event_types/event-1',
        createdBy: 'admin@example.com',
        nowIso
      });

      expect(payload).toEqual({
        case_id: 'case-1',
        user_id: 'user-1',
        stage: 'ahpra',
        status: 'invited',
        admin_notes: 'Needs help with portal',
        correlation_token: 'abc123',
        calendly_booking_url: 'https://calendly.example/gp?utm_content=call_abc123',
        calendly_event_type_uri: 'https://api.calendly.com/event_types/event-1',
        duration_minutes: 30,
        summary_status: 'not_requested',
        created_by: 'admin@example.com',
        created_at: nowIso,
        updated_at: nowIso
      });
      expect(payload).not.toHaveProperty('booking_url');
      expect(payload).not.toHaveProperty('scheduled_by');
      expect(payload).not.toHaveProperty('task_id');
    });

    it('builds notification patch with JSONB channel state and message id columns', () => {
      const { buildScheduledCallNotificationPatch } = require('../server-test-helpers.js');
      const nowIso = '2026-06-09T12:10:00.000Z';
      const patch = buildScheduledCallNotificationPatch(
        { ok: true, messageId: 'wa-1' },
        { ok: false, error: 'Resend disabled' },
        { whatsappRequested: true, emailRequested: true, resendCount: 2, nowIso }
      );

      expect(patch).toEqual({
        invite_sent_at: nowIso,
        notification_channels: {
          whatsapp: { requested: true, sent: true, message_id: 'wa-1' },
          email: { requested: true, sent: false, message_id: null, error: 'Resend disabled' }
        },
        whatsapp_message_id: 'wa-1',
        email_message_id: null,
        updated_at: nowIso,
        resend_count: 2
      });
      expect(patch).not.toHaveProperty('whatsapp_sent');
      expect(patch).not.toHaveProperty('email_sent');
    });

    it('normalizes scheduled call API aliases without requiring legacy columns', () => {
      const { normalizeScheduledCallForApi, getScheduledCallRegistrationTaskId } = require('../server-test-helpers.js');
      const call = normalizeScheduledCallForApi({
        id: 'call-1',
        registration_task_id: 'task-1',
        calendly_booking_url: 'https://calendly.example/book',
        calendly_event_uri: 'https://api.calendly.com/events/event-1'
      });

      expect(getScheduledCallRegistrationTaskId(call)).toBe('task-1');
      expect(call.task_id).toBe('task-1');
      expect(call.booking_url).toBe('https://calendly.example/book');
      expect(call.calendly_event_url).toBe('https://api.calendly.com/events/event-1');
    });
  });

  describe('verifyCalendlySignature', () => {
    const secret = 'test-calendly-webhook-secret';

    function makeCalendlySignature(timestamp, body, signingKey) {
      const hmac = crypto.createHmac('sha256', signingKey);
      hmac.update(timestamp + '.', 'utf8');
      hmac.update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
      const sig = hmac.digest('hex');
      return 't=' + timestamp + ',v1=' + sig;
    }

    it('accepts a valid signature with Calendly Unix seconds timestamp', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = '{"event":"invitee.created"}';
      const ts = String(Math.floor(Date.now() / 1000));
      const header = makeCalendlySignature(ts, body, secret);
      expect(verifyCalendlySignature(header, body, secret)).toBe(true);
    });

    it('accepts a valid signature over raw body bytes', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = Buffer.from('{"event":"invitee.created","name":"Jose"}', 'utf8');
      const ts = String(Math.floor(Date.now() / 1000));
      const header = makeCalendlySignature(ts, body, secret);
      expect(verifyCalendlySignature(header, body, secret)).toBe(true);
    });

    it('accepts a valid signature when multiple v1 values are present', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = '{"event":"invitee.created"}';
      const ts = String(Math.floor(Date.now() / 1000));
      const header = makeCalendlySignature(ts, body, secret) + ',v1=' + '0'.repeat(64);
      expect(verifyCalendlySignature(header, body, secret)).toBe(true);
    });

    it('rejects an invalid signature', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = '{"event":"invitee.created"}';
      const ts = String(Math.floor(Date.now() / 1000));
      const header = makeCalendlySignature(ts, body, 'wrong-secret');
      expect(verifyCalendlySignature(header, body, secret)).toBe(false);
    });

    it('rejects a stale timestamp (> 5 min old)', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = '{"event":"invitee.created"}';
      const ts = String(Math.floor(Date.now() / 1000) - 6 * 60);
      const header = makeCalendlySignature(ts, body, secret);
      expect(verifyCalendlySignature(header, body, secret)).toBe(false);
    });

    it('rejects a malformed signature without throwing', () => {
      const { verifyCalendlySignature } = require('../server-test-helpers.js');
      const body = '{"event":"invitee.created"}';
      const ts = String(Math.floor(Date.now() / 1000));
      expect(verifyCalendlySignature('t=' + ts + ',v1=not-hex', body, secret)).toBe(false);
    });
  });

  describe('verifyZoomWebhookSignature', () => {
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
});
