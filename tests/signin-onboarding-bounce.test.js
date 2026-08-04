// Owner report 2026-08-03: "when he logged in to his account he hit the
// onboarding screens" — for a doctor whose onboarding finished on 23 July, with
// BOTH server markers set (user_profiles.onboarding_completed_at and
// user_state.gp_onboarding_complete). Two independent defects put him there,
// either of which is enough on its own.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const signinHtml = fs.readFileSync(path.join(ROOT, 'pages/signin.html'), 'utf8');

// ── Defect 1: sign-in DELETED the completion flag it was handed ──────────────
// Supabase stores user_state as JSONB, so gp_onboarding_complete arrives as a
// real boolean `true`. The bootstrap loop only kept values that were already
// strings and removed everything else — so the one flag pages/index.html checks
// (=== "true") was wiped at the exact moment of sign-in.
describe('sign-in keeps the onboarding flag it was just given', () => {
  // The page is one IIFE with no jsdom here, so the loop is executed against a
  // fake localStorage rather than re-implemented.
  function runBootstrapLoop(state) {
    const start = signinHtml.indexOf('BOOTSTRAP_STATE_KEYS.forEach((key) => {\n        const value = state[key];');
    expect(start).toBeGreaterThan(-1);
    const end = signinHtml.indexOf('\n      });', start);
    const loop = signinHtml.slice(start, end + 9);

    const store = new Map();
    const fn = new Function('BOOTSTRAP_STATE_KEYS', 'state', 'safeSetStorage', 'safeRemoveStorage', 'localStorage', 'SAVE_BATCH_META_SUFFIX', loop);
    fn(
      ['gp_onboarding_complete', 'gp_career_state', 'gp_selected_country', 'gp_onboarding'],
      state,
      (_s, k, v) => store.set(k, v),
      (_s, k) => store.delete(k),
      {},
      '__save_batch_meta'
    );
    return store;
  }

  it('a boolean true is stored as "true" — the value index.html actually tests for', () => {
    const store = runBootstrapLoop({ gp_onboarding_complete: true });
    expect(store.get('gp_onboarding_complete')).toBe('true');
    // The gateway's exact test.
    expect(signinHtml.length).toBeGreaterThan(0);
    expect(store.get('gp_onboarding_complete') === 'true').toBe(true);
  });

  it('a string "true" still works — the old path is not broken', () => {
    const store = runBootstrapLoop({ gp_onboarding_complete: 'true' });
    expect(store.get('gp_onboarding_complete')).toBe('true');
  });

  it('objects survive as JSON instead of being dropped', () => {
    const store = runBootstrapLoop({ gp_career_state: { applications: [{ id: 'a1' }] } });
    expect(JSON.parse(store.get('gp_career_state')).applications[0].id).toBe('a1');
  });

  it('a genuinely absent key is still cleared, so it cannot leak between accounts', () => {
    const store = runBootstrapLoop({ gp_selected_country: null, gp_onboarding: undefined });
    expect(store.has('gp_selected_country')).toBe(false);
    expect(store.has('gp_onboarding')).toBe(false);
  });
});

// ── Defect 2: the sign-in redirect failed CLOSED ─────────────────────────────
describe('the sign-in redirect only sends someone to onboarding on a definite no', () => {
  const idx = serverSrc.indexOf('async function resolveOnboardingCompleteOrUnknown');
  const helperSrc = serverSrc.slice(idx, serverSrc.indexOf('\n}', idx) + 2);

  // Executed, not just pattern-matched: the whole point is the tri-state.
  function makeHelper({ profileRows, throws, ok = true }) {
    const fn = new Function('supabaseDbRequest', 'isSupabaseDbConfigured', helperSrc + '\nreturn resolveOnboardingCompleteOrUnknown;')(
      async () => {
        if (throws) throw new Error('supabase down');
        return { ok, data: profileRows };
      },
      () => true
    );
    return fn;
  }

  it('state says complete → complete, without even asking for the profile', async () => {
    let asked = false;
    const fn = new Function('supabaseDbRequest', 'isSupabaseDbConfigured', helperSrc + '\nreturn resolveOnboardingCompleteOrUnknown;')(
      async () => { asked = true; return { ok: true, data: [] }; },
      () => true
    );
    expect(await fn('gp@example.com', { gp_onboarding_complete: true })).toBe(true);
    expect(asked).toBe(false);
  });

  it('the profile marker rescues a doctor whose state row lost the flag', async () => {
    // This is the case the canonical marker exists for — a reset/lost state row.
    const fn = makeHelper({ profileRows: [{ onboarding_completed_at: '2026-07-23T16:21:14Z' }] });
    expect(await fn('gp@example.com', {})).toBe(true);
    expect(await fn('gp@example.com', null)).toBe(true);
  });

  it('a genuinely new account is a definite NO, so onboarding still happens', async () => {
    const fn = makeHelper({ profileRows: [{ onboarding_completed_at: null }] });
    expect(await fn('new@example.com', {})).toBe(false);
  });

  it('THE BUG: a failed or unreadable lookup is "unknown", never "not onboarded"', async () => {
    expect(await makeHelper({ throws: true })('gp@example.com', {})).toBe(null);
    expect(await makeHelper({ ok: false, profileRows: null })('gp@example.com', {})).toBe(null);
    expect(await makeHelper({ profileRows: 'not-an-array' })('gp@example.com', {})).toBe(null);
    // No profile row AND no readable state row is also not a conclusion.
    expect(await makeHelper({ profileRows: [] })('gp@example.com', null)).toBe(null);
  });

  it('the login path redirects ONLY on an explicit false', () => {
    const loginIdx = serverSrc.indexOf('let loginRedirect =');
    const block = serverSrc.slice(loginIdx, loginIdx + 1400);
    expect(block).toContain('resolveOnboardingCompleteOrUnknown(email, stateObj)');
    expect(block).toContain('if (onboardedAnswer === false) {');
    // The old shape must not come back: a bare falsy test on the state key, or
    // collapsing an unreadable state row to {}.
    expect(block).not.toContain('if (!stateObj.gp_onboarding_complete)');
    expect(block).not.toMatch(/typeof stateCheck\.state === 'object' \? stateCheck\.state : \{\}/);
  });

  it('resolveOnboardingCompleteFlag is untouched — other callers still fail closed', () => {
    // /api/state's flag answers a different question and must keep its own
    // behaviour; only the redirect needed the tri-state.
    const flagIdx = serverSrc.indexOf('async function resolveOnboardingCompleteFlag');
    const flagSrc = serverSrc.slice(flagIdx, serverSrc.indexOf('\n}', flagIdx));
    expect(flagSrc).toContain('return false;');
  });
});
