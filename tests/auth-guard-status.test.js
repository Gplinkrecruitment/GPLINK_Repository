import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// auth-guard.js is a browser IIFE, so these tests extract the account-status
// gate logic from the source (Phase 6B bug #8: fail directions were both wrong,
// network failure fail-CLOSED into a false "Under Review" wall, and unknown
// account_status values fail-OPENED to full access).

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'auth-guard.js'),
  'utf8'
);

function extractGate() {
  const m = src.match(/function applyAccountStatusGate\(status\) \{[\s\S]*?\n {6}\}/);
  if (!m) throw new Error('applyAccountStatusGate not found in js/auth-guard.js');
  return m[0];
}

function runGate(status, { pepGateReturns = false } = {}) {
  const calls = { enforced: 0, setFlag: 0, removedFlag: 0, pepChecked: 0 };
  const stubs = {
    applyPepGate: (s) => { calls.pepChecked++; return pepGateReturns; },
    enforceRestrictedUI: () => { calls.enforced++; },
    localStorage: {
      setItem: (k, v) => { if (k === 'gp_account_under_review' && v === 'true') calls.setFlag++; },
      removeItem: (k) => { if (k === 'gp_account_under_review') calls.removedFlag++; }
    }
  };
  const fn = new Function(
    'applyPepGate', 'enforceRestrictedUI', 'localStorage',
    extractGate() + '\nreturn applyAccountStatusGate;'
  )(stubs.applyPepGate, stubs.enforceRestrictedUI, stubs.localStorage);
  fn(status);
  return calls;
}

describe('auth-guard applyAccountStatusGate', () => {
  it('active grants full access (clears the restricted flag, no overlay)', () => {
    const calls = runGate('active');
    expect(calls.removedFlag).toBe(1);
    expect(calls.setFlag).toBe(0);
    expect(calls.enforced).toBe(0);
  });

  it('under_review keeps the legitimate restricted mode', () => {
    const calls = runGate('under_review');
    expect(calls.setFlag).toBe(1);
    expect(calls.enforced).toBe(1);
  });

  it('an UNKNOWN status denies by default instead of failing open', () => {
    for (const weird of ['archived', 'banana', 'ACTIVE ', '']) {
      const calls = runGate(weird);
      expect(calls.setFlag, `status "${weird}" must restrict`).toBe(1);
      expect(calls.enforced, `status "${weird}" must restrict`).toBe(1);
      expect(calls.removedFlag).toBe(0);
    }
  });

  it('consults the PEP gate first and stops if it redirected', () => {
    const calls = runGate('pep_waitlist', { pepGateReturns: true });
    expect(calls.pepChecked).toBe(1);
    expect(calls.enforced).toBe(0);
    expect(calls.setFlag).toBe(0);
  });
});

describe('auth-guard network-failure direction', () => {
  it('retries the status check instead of instantly walling the user', () => {
    expect(src).toContain('attemptStatusCheck(retriesLeft - 1');
  });

  it('no longer fabricates a restricted state on fetch failure', () => {
    expect(src).not.toContain('defaulting to restricted');
    // The final catch must not set the under-review flag or enforce the overlay.
    const catchBlock = src.match(/\.catch\(\(err\) => \{[\s\S]*?keeping cached state[\s\S]*?\}\);/);
    expect(catchBlock, 'fail-safe catch block present').toBeTruthy();
    expect(catchBlock[0]).not.toContain('setItem("gp_account_under_review"');
    expect(catchBlock[0]).not.toContain('enforceRestrictedUI()');
  });
});
