// Phase 6 D1b, practice one-click action tokens.
//
// Pure unit tests over the signed-token helpers (no server boot). The tokens
// reuse the createSignedPurposeToken/parseSignedPurposeToken HMAC scheme
// (AUTH_SECRET, purpose-tagged, expiring): round-trips must verify, and
// tampered / expired / wrong-purpose / malformed tokens must ALL be rejected
// indistinguishably ({ ok:false }).
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.AGENT_SKIP_DOTENV = 'true';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'practice-action-token-test-secret';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const { makePracticeActionToken, verifyPracticeActionToken, createSignedPurposeToken } = __testUtils;

describe('makePracticeActionToken / verifyPracticeActionToken', () => {
  it('round-trips every valid action', () => {
    for (const action of ['accept', 'decline', 'request_interview']) {
      const token = makePracticeActionToken({ applicationId: 'app-42', action });
      const out = verifyPracticeActionToken(token);
      expect(out).toEqual({ ok: true, applicationId: 'app-42', action });
    }
  });

  it('refuses to MINT a token for an unknown action or a missing applicationId', () => {
    expect(() => makePracticeActionToken({ applicationId: 'app-1', action: 'reveal_identity' })).toThrow();
    expect(() => makePracticeActionToken({ applicationId: '', action: 'accept' })).toThrow();
    expect(() => makePracticeActionToken({ action: 'accept' })).toThrow();
  });

  it('rejects a tampered signature', () => {
    const token = makePracticeActionToken({ applicationId: 'app-42', action: 'accept' });
    const flipped = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyPracticeActionToken(flipped)).toEqual({ ok: false });
  });

  it('rejects a tampered payload (action swap) even with the original signature', () => {
    const token = makePracticeActionToken({ applicationId: 'app-42', action: 'decline' });
    const dot = token.lastIndexOf('.');
    const sig = token.slice(dot + 1);
    const payload = JSON.parse(Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    payload.data.action = 'accept';
    const forgedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(verifyPracticeActionToken(forgedPayload + '.' + sig)).toEqual({ ok: false });
  });

  it('rejects an expired token', async () => {
    // Tiny positive expDays → the token expires within a millisecond.
    const token = makePracticeActionToken({ applicationId: 'app-42', action: 'accept', expDays: 1e-9 });
    await new Promise((r) => setTimeout(r, 10));
    expect(verifyPracticeActionToken(token)).toEqual({ ok: false });
  });

  it('rejects a token minted for a DIFFERENT purpose with the same payload shape', () => {
    const wrongPurpose = createSignedPurposeToken('admin_mfa_challenge', { applicationId: 'app-42', action: 'accept' }, 60000);
    expect(verifyPracticeActionToken(wrongPurpose)).toEqual({ ok: false });
  });

  it('rejects a token whose payload carries an action the verifier does not allow', () => {
    const badAction = createSignedPurposeToken('practice_action', { applicationId: 'app-42', action: 'reveal_identity' }, 60000);
    expect(verifyPracticeActionToken(badAction)).toEqual({ ok: false });
  });

  it('rejects garbage / empty / session-shaped inputs', () => {
    expect(verifyPracticeActionToken('')).toEqual({ ok: false });
    expect(verifyPracticeActionToken('not-a-token')).toEqual({ ok: false });
    expect(verifyPracticeActionToken('aaaa.bbbb')).toEqual({ ok: false });
    expect(verifyPracticeActionToken(null)).toEqual({ ok: false });
  });
});
