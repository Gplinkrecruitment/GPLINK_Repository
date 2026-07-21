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
        meeting_reason: null,
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

    it('stores the GP-visible meeting reason when provided, separate from internal admin notes', () => {
      const { buildScheduledCallInsertPayload } = require('../server-test-helpers.js');
      const payload = buildScheduledCallInsertPayload({
        caseId: 'case-2',
        userId: 'user-2',
        stage: 'amc',
        adminNotes: 'internal: chase missing passport scan',
        meetingReason: 'We want to walk you through your AMC documents.',
        correlationToken: 'def456',
        bookingUrl: 'https://calendly.example/hazel?utm_content=call_def456'
      });
      expect(payload.meeting_reason).toBe('We want to walk you through your AMC documents.');
      expect(payload.admin_notes).toBe('internal: chase missing passport scan');
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

  describe('buildScheduledCallFromCalendly (unmatched/direct Calendly booking)', () => {
    const { buildScheduledCallFromCalendly } = require('../lib/interview-meetings.js');
    const { generateCorrelationToken } = require('../server-test-helpers.js');
    const NOW = '2026-07-16T09:00:00.000Z';

    function build(extra) {
      return buildScheduledCallFromCalendly(Object.assign({
        correlationToken: generateCorrelationToken(),
        nowIso: NOW,
        inviteeEmail: 'khaleedmahmoud1211@gmail.com',
        timezone: 'Europe/London',
        calendlyInviteeUri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
        calendlyEventUri: 'https://api.calendly.com/scheduled_events/EVT'
      }, extra || {}));
    }

    // The three fields that make the meeting visible and correct in the CEO tab.
    it('is CEO-hosted — host_kind MUST be ceo or /api/ceo/meetings never returns it', () => {
      expect(build().host_kind).toBe('ceo');
    });

    it('is a consultation (renders as "Standard consultation")', () => {
      expect(build().meeting_kind).toBe('consultation');
    });

    it('is already booked (the invitee picked a time; nobody invited them)', () => {
      expect(build().status).toBe('booked');
    });

    it('carries a correlation_token — the column is NOT NULL UNIQUE', () => {
      const row = build();
      expect(row.correlation_token).toMatch(/^[a-f0-9]{32}$/);
      expect(buildScheduledCallFromCalendly({
        correlationToken: generateCorrelationToken(), nowIso: NOW
      }).correlation_token).not.toBe(row.correlation_token);
    });

    it('leaves case_id/user_id/stage/application_id/task ids null (a stranger has no case)', () => {
      const row = build();
      expect(row.case_id).toBeNull();
      expect(row.user_id).toBeNull();
      expect(row.stage).toBeNull();
      expect(row.application_id).toBeNull();
      expect(row.registration_task_id).toBeNull();
      expect(row.origin_task_id).toBeNull();
    });

    it('mirrors the match path: booked_at/invitee_email/timezone/calendly uris + timestamps', () => {
      const row = build();
      expect(row.booked_at).toBe(NOW);
      expect(row.created_at).toBe(NOW);
      expect(row.updated_at).toBe(NOW);
      expect(row.invitee_email).toBe('khaleedmahmoud1211@gmail.com');
      expect(row.timezone).toBe('Europe/London');
      expect(row.calendly_invitee_uri).toBe('https://api.calendly.com/scheduled_events/EVT/invitees/INV');
      expect(row.calendly_event_uri).toBe('https://api.calendly.com/scheduled_events/EVT');
    });

    it('includes optional scheduled_at/zoom/notes only when present', () => {
      const full = build({
        scheduledAt: '2026-07-20T04:30:00.000Z',
        zoomJoinUrl: 'https://zoom.us/j/123',
        zoomMeetingId: '123',
        zoomPasscode: 'pw',
        inviteeNotes: 'Keen to hear about visas'
      });
      expect(full.scheduled_at).toBe('2026-07-20T04:30:00.000Z');
      expect(full.zoom_join_url).toBe('https://zoom.us/j/123');
      expect(full.zoom_meeting_id).toBe('123');
      expect(full.zoom_passcode).toBe('pw');
      expect(full.invitee_notes).toBe('Keen to hear about visas');

      const bare = build();
      expect(bare).not.toHaveProperty('scheduled_at');
      expect(bare).not.toHaveProperty('zoom_join_url');
      expect(bare).not.toHaveProperty('zoom_meeting_id');
      expect(bare).not.toHaveProperty('zoom_passcode');
      expect(bare).not.toHaveProperty('invitee_notes');
    });

    it('is pure — same input, identical row (no clock read inside)', () => {
      const token = generateCorrelationToken();
      const a = buildScheduledCallFromCalendly({ correlationToken: token, nowIso: NOW, inviteeEmail: 'a@b.com' });
      const b = buildScheduledCallFromCalendly({ correlationToken: token, nowIso: NOW, inviteeEmail: 'a@b.com' });
      expect(a).toEqual(b);
    });

    it('normalizeMeetingForApi labels it "Standard consultation", not an interview', () => {
      const { normalizeMeetingForApi } = require('../lib/interview-meetings.js');
      const api = normalizeMeetingForApi(build());
      expect(api.is_interview).toBe(false);
      expect(api.meeting_kind_label).toBe('Standard consultation');
    });
  });

  describe('pickScheduledCallRso (assigned-RSO auto-host + CEO override)', () => {
    const roster = [
      { user_id: 'rso-hazel', name: 'Hazel', email: 'hazel@mygplink.com.au' },
      { user_id: 'rso-omar', name: 'Omar', email: 'omar@mygplink.com.au' },
      { user_id: 'rso-priya', name: 'Priya', email: 'priya@mygplink.com.au' }
    ];

    it('honors an explicit RSO email when the requester is a CEO/super-admin', () => {
      const { pickScheduledCallRso } = require('../server-test-helpers.js');
      const rso = pickScheduledCallRso(roster, {
        explicitEmail: 'Omar@MyGPLink.com.au',
        isCeo: true,
        caseAssigneeUserId: 'rso-hazel'
      });
      expect(rso && rso.user_id).toBe('rso-omar');
    });

    it('ignores an explicit RSO email for a non-CEO and uses the case assignee', () => {
      const { pickScheduledCallRso } = require('../server-test-helpers.js');
      const rso = pickScheduledCallRso(roster, {
        explicitEmail: 'omar@mygplink.com.au',
        isCeo: false,
        caseAssigneeUserId: 'rso-hazel'
      });
      expect(rso && rso.user_id).toBe('rso-hazel');
    });

    it('falls back to the case assignee when no explicit email is supplied', () => {
      const { pickScheduledCallRso } = require('../server-test-helpers.js');
      const rso = pickScheduledCallRso(roster, {
        explicitEmail: '',
        isCeo: true,
        caseAssigneeUserId: 'rso-priya'
      });
      expect(rso && rso.user_id).toBe('rso-priya');
    });

    it('returns null when nothing matches', () => {
      const { pickScheduledCallRso } = require('../server-test-helpers.js');
      const rso = pickScheduledCallRso(roster, {
        explicitEmail: 'nobody@mygplink.com.au',
        isCeo: true,
        caseAssigneeUserId: 'rso-unknown'
      });
      expect(rso).toBe(null);
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

  describe('classifyCallAttendance (Zoom no-show detection)', () => {
    const rso = { email: 'hazel@mygplink.com.au', name: 'Hazel' };
    it('attended when a non-host participant is present', () => {
      const { classifyCallAttendance } = require('../server-test-helpers.js');
      const parts = [
        { email: 'hazel@mygplink.com.au', name: 'Hazel', duration: 1800 },
        { email: 'smithmiller1234@gmail.com', name: 'Smith Miller', duration: 1500 }
      ];
      expect(classifyCallAttendance(parts, rso)).toBe('attended');
    });
    it('no_show when only the host (RSO) joined', () => {
      const { classifyCallAttendance } = require('../server-test-helpers.js');
      expect(classifyCallAttendance([{ email: 'hazel@mygplink.com.au', name: 'Hazel', duration: 600 }], rso)).toBe('no_show');
    });
    it('no_show when nobody joined', () => {
      const { classifyCallAttendance } = require('../server-test-helpers.js');
      expect(classifyCallAttendance([], rso)).toBe('no_show');
    });
    it('treats a guest GP (no email, name not the host) as attended', () => {
      const { classifyCallAttendance } = require('../server-test-helpers.js');
      const parts = [{ name: 'Hazel', email: 'hazel@mygplink.com.au' }, { name: 'Smith Miller', email: '' }];
      expect(classifyCallAttendance(parts, rso)).toBe('attended');
    });
    it('excludes the host when they joined without a linked email (name match)', () => {
      const { classifyCallAttendance } = require('../server-test-helpers.js');
      expect(classifyCallAttendance([{ name: 'Hazel', email: '' }], rso)).toBe('no_show');
    });
  });

  describe('isNoShowCandidate (booked call past its end + grace)', () => {
    const base = { status: 'booked', duration_minutes: 30 };
    const now = Date.parse('2026-06-19T12:00:00.000Z');
    it('is a candidate once end + grace has passed', () => {
      const { isNoShowCandidate } = require('../server-test-helpers.js');
      // started 11:00, 30m call ends 11:30, +15 grace = 11:45 < 12:00 now
      expect(isNoShowCandidate({ ...base, scheduled_at: '2026-06-19T11:00:00.000Z' }, now, 15)).toBe(true);
    });
    it('is NOT a candidate before end + grace', () => {
      const { isNoShowCandidate } = require('../server-test-helpers.js');
      // started 11:50, ends 12:20 — still in progress
      expect(isNoShowCandidate({ ...base, scheduled_at: '2026-06-19T11:50:00.000Z' }, now, 15)).toBe(false);
    });
    it('ignores calls that are not booked, or already completed / flagged', () => {
      const { isNoShowCandidate } = require('../server-test-helpers.js');
      const old = '2026-06-19T10:00:00.000Z';
      expect(isNoShowCandidate({ status: 'invited', scheduled_at: old, duration_minutes: 30 }, now, 15)).toBe(false);
      expect(isNoShowCandidate({ ...base, scheduled_at: old, completed_at: old }, now, 15)).toBe(false);
      expect(isNoShowCandidate({ ...base, scheduled_at: old, no_show_at: old }, now, 15)).toBe(false);
    });
  });

  describe('buildRsoEmailFromOpts (send invite as the assigned RSO)', () => {
    it('sets From + Reply-To for an @mygplink.com.au RSO', () => {
      const { buildRsoEmailFromOpts } = require('../server-test-helpers.js');
      const opts = buildRsoEmailFromOpts({ name: 'Hazel', email: 'hazel@mygplink.com.au' });
      expect(opts.from).toEqual({ email: 'hazel@mygplink.com.au', name: 'Hazel (GP Link)' });
      expect(opts.replyTo).toBe('hazel@mygplink.com.au');
    });

    it('sets only Reply-To for a non-mygplink RSO (e.g. a Gmail address)', () => {
      const { buildRsoEmailFromOpts } = require('../server-test-helpers.js');
      const opts = buildRsoEmailFromOpts({ name: 'Khaleed', email: 'khaleed@gmail.com' });
      expect(opts.from).toBeUndefined();
      expect(opts.replyTo).toBe('khaleed@gmail.com');
    });

    it('returns empty opts when there is no RSO / no email', () => {
      const { buildRsoEmailFromOpts } = require('../server-test-helpers.js');
      expect(buildRsoEmailFromOpts(null)).toEqual({});
      expect(buildRsoEmailFromOpts({ name: 'X' })).toEqual({});
    });
  });
});
