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

    it('maps cancelled to cancelled', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('cancelled')).toBe('cancelled');
    });

    it('maps no_show to waiting_on_gp', () => {
      const { mapCallStatusToTaskStatus } = require('../server-test-helpers.js');
      expect(mapCallStatusToTaskStatus('no_show')).toBe('waiting_on_gp');
    });
  });

  describe('verifyCalendlySignature', () => {
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
