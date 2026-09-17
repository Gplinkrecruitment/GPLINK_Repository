// Deleting a GP and signing up again with the SAME email in the SAME browser
// used to hand the brand-new account the old localStorage — including
// gp_walkthrough_state with every tour marked seen — so no first-run
// experience ever fired. Owner 2026-09-18: "there was no tutorial walkthrough
// or slide pages when onboarding was complete, fix this once and for all".
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const sync = read('js/state-sync.js');
const fn = sync.slice(sync.indexOf('function enforceOwnership'), sync.indexOf('function flushBatchedStorageKey'));

describe('state ownership is keyed on the account, not just the address', () => {
  it('keeps the account id in its own key so the five email readers still work', () => {
    expect(sync).toContain("const SESSION_OWNER_UID_KEY = 'gp_state_owner_uid';");
    // gp_state_owner must still hold a bare email for these consumers.
    for (const f of ['js/auth-guard.js', 'js/app-shell.js', 'js/gp-cache.js', 'js/onboarding.js', 'js/bypass-config.js']) {
      expect(read(f), f).toContain('gp_state_owner');
    }
    expect(fn).toContain('localStorage.setItem(SESSION_OWNER_KEY, email);');
  });

  it('wipes when the same email comes back on a DIFFERENT account id', () => {
    expect(fn).toContain('var recreatedAccount = !!(currentUid && uid && currentUid !== uid);');
    expect(fn).toContain('if (differentEmail || recreatedAccount) {');
    expect(fn).toContain('clearTrackedLocalState();');
  });

  it('never wipes just because the id is unknown — existing browsers hold none', () => {
    // BOTH ids must be present before the mismatch counts: the guard reads
    // currentUid && uid && currentUid !== uid, never a bare comparison.
    const guard = fn.slice(fn.indexOf('var recreatedAccount'), fn.indexOf('if (differentEmail'));
    expect(guard).toMatch(/!!\(currentUid && uid && currentUid !== uid\)/);
    // And an unknown id must not even reach the setter as an empty string.
    expect(fn).toContain('if (uid) localStorage.setItem(SESSION_OWNER_UID_KEY, uid);');
  });

  it('drops the response cache too, since it is keyed per URL not per user', () => {
    expect(fn).toContain("window.gpCache && typeof window.gpCache.clear === 'function'");
  });

  it('reads the account id off the session the app already fetches', () => {
    expect(sync).toContain("if (typeof session.profile.supabaseUserId === 'string') sessionUserId = session.profile.supabaseUserId;");
    expect(sync).toContain('enforceOwnership(sessionEmail, sessionUserId);');
    // The server really does put it there.
    expect(read('server.js')).toContain('profile: session.userProfile');
    expect(read('server.js')).toContain('session.userProfile.supabaseUserId');
  });

  it('the walkthrough flags it protects are tracked state, so a wipe reaches them', () => {
    const keys = sync.slice(sync.indexOf('const STATE_KEYS'), sync.indexOf('const ADMIN_READONLY_KEYS'));
    expect(keys).toContain("'gp_walkthrough_state'");
    expect(keys).toContain("'gp_career_intro_seen'");
  });

  it('busters moved with the file', () => {
    expect(read('pages/index.html')).toContain('state-sync.js?v=20260918b');
    expect(read('sw.js')).toContain('var VERSION = "20260918f"');
  });
});
