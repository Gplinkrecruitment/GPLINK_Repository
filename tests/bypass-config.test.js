import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

// js/bypass-config.js ships NO plaintext personal email — temporary bypass
// entries are keyed by the SHA-256 hex digest of the lowercase email. These
// tests prove the embedded digest matches the intended email and that the
// hash-compare activation behaves exactly like the old plaintext lookup.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'js', 'bypass-config.js');
const source = readFileSync(SOURCE_PATH, 'utf8');

// The SHIPPED digest map is empty (owner 2026-09-02: the test account lives
// the real new-GP experience, gateways included). The machinery still has to
// work for any FUTURE temporary bypass, so these tests inject a synthetic
// fixture entry into the source before running it.
const BYPASS_EMAIL = 'bypass-machinery-fixture@example.com';
const EXPECTED_DIGEST = createHash('sha256').update(BYPASS_EMAIL).digest('hex');
const EXPIRY = '2027-01-31T23:59:59.000Z';
const EMPTY_MAP = 'var TEMPORARY_BYPASS_LOCK_DIGESTS = {}';
const fixtureSource = source.replace(
  EMPTY_MAP,
  'var TEMPORARY_BYPASS_LOCK_DIGESTS = { "' + EXPECTED_DIGEST + '": "' + EXPIRY + '" }'
);

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// Runs js/bypass-config.js in a sandboxed "browser" with a fixed clock.
function runBypassConfig({ email, nowIso, localStorageSeed = {} } = {}) {
  const localStorage = makeStorage(localStorageSeed);
  const sessionStorage = makeStorage();
  const fixedNow = Date.parse(nowIso);
  const sandbox = {
    window: {},
    localStorage,
    sessionStorage,
    TextEncoder,
    console,
    // The script only uses Date.now() and Date.parse(); pin the clock.
    Date: { now: () => fixedNow, parse: Date.parse },
  };
  sandbox.window.crypto = globalThis.crypto; // Node 20 WebCrypto (crypto.subtle)
  if (email) sandbox.window.gpSessionProfile = { email };
  vm.createContext(sandbox);
  vm.runInContext(fixtureSource, sandbox, { filename: 'bypass-config.js' });
  return { sandbox, localStorage };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe('bypass-config hashed allowlist', () => {
  it('ships an EMPTY temporary digest map and no plaintext personal email', () => {
    expect(source).toContain(EMPTY_MAP);
    expect(source).not.toContain('@gmail.com');
    // The machinery tests below run on an injected fixture entry:
    expect(fixtureSource).toContain(EXPECTED_DIGEST);
    expect(sha256Hex(BYPASS_EMAIL)).toBe(EXPECTED_DIGEST);
  });

  it('activates the bypass for the matching email before expiry (async hash path)', async () => {
    const { sandbox, localStorage } = runBypassConfig({ email: BYPASS_EMAIL, nowIso: '2026-08-01T00:00:00.000Z' });
    const activated = await waitFor(() => sandbox.BYPASS_LOCK_EMAILS[BYPASS_EMAIL] === true);
    expect(activated).toBe(true);
    // Same observable behavior as the old plaintext entry:
    expect(sandbox.BYPASS_LOCK_EMAILS[BYPASS_EMAIL]).toBe(true);
    expect(localStorage.getItem('gp_ahpra_progress__intro_seen')).toBe('1');
    // Match is cached for the synchronous fast-path on later page loads.
    const cached = JSON.parse(localStorage.getItem('gp_bypass_digest_match'));
    expect(cached).toMatchObject({ email: BYPASS_EMAIL, digest: EXPECTED_DIGEST, expiresAt: EXPIRY });
  });

  it('reports the bypass as inactive after the expiry date', async () => {
    const { sandbox } = runBypassConfig({ email: BYPASS_EMAIL, nowIso: '2027-02-01T00:00:00.000Z' });
    const defined = await waitFor(() => Object.prototype.hasOwnProperty.call(sandbox.BYPASS_LOCK_EMAILS, BYPASS_EMAIL));
    expect(defined).toBe(true);
    expect(sandbox.BYPASS_LOCK_EMAILS[BYPASS_EMAIL]).toBe(false);
  });

  it('does not activate anything for a non-matching email', async () => {
    const { sandbox, localStorage } = runBypassConfig({ email: 'someone.else@example.com', nowIso: '2026-08-01T00:00:00.000Z' });
    // Give the async hash time to complete, then confirm no entry appeared.
    await new Promise((r) => setTimeout(r, 100));
    expect(Object.prototype.hasOwnProperty.call(sandbox.BYPASS_LOCK_EMAILS, 'someone.else@example.com')).toBe(false);
    expect(localStorage.getItem('gp_bypass_digest_match')).toBe(null);
    // Company address stays a plain allow-listed entry.
    expect(sandbox.BYPASS_LOCK_EMAILS['hello@mygplink.com.au']).toBe(true);
  });

  it('activates synchronously from the cached digest match (fast-path used by ahpra.html)', () => {
    const seed = {
      gp_bypass_digest_match: JSON.stringify({ email: BYPASS_EMAIL, digest: EXPECTED_DIGEST, expiresAt: EXPIRY }),
    };
    const { sandbox } = runBypassConfig({ email: BYPASS_EMAIL, nowIso: '2026-08-01T00:00:00.000Z', localStorageSeed: seed });
    // No await — the cached match must activate before the script returns.
    expect(sandbox.BYPASS_LOCK_EMAILS[BYPASS_EMAIL]).toBe(true);
  });
});
