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
