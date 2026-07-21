import { describe, it, expect } from 'vitest';
import server from '../server.js';

// The launch handoff: new registration cases default to hello@ (GP Link Admin)
// so the owner handles all doc-checking/support during the first GP rollout,
// then hands to Hazel later by setting LAUNCH_DEFAULT_RSO_EMAIL. This guards the
// pure resolver — the one place the launch-vs-Hazel decision is made.
const { pickDefaultCaseRsoUserId } = server.__testUtils;

const ROSTER = [
  { user_id: 'hello-id', name: 'GP Link Admin', email: 'hello@mygplink.com.au' },
  { user_id: 'hazel-id', name: 'Hazel', email: 'hazel@mygplink.com.au' },
  { user_id: 'kh-id',    name: 'Khaleed', email: 'khaleedmahmoud1211@gmail.com' }
];

describe('pickDefaultCaseRsoUserId — launch default RSO for new cases', () => {
  it('defaults to hello@ (GP Link Admin) when the env is unset (launch config)', () => {
    // null/undefined rawEmail = env unset = the launch default (owner handles all).
    expect(pickDefaultCaseRsoUserId(ROSTER, null)).toBe('hello-id');
    expect(pickDefaultCaseRsoUserId(ROSTER, undefined)).toBe('hello-id');
  });

  it('hands new cases to Hazel when set to her email (the later handoff)', () => {
    expect(pickDefaultCaseRsoUserId(ROSTER, 'hazel@mygplink.com.au')).toBe('hazel-id');
    // case-insensitive + trims
    expect(pickDefaultCaseRsoUserId(ROSTER, '  HAZEL@MyGPLink.com.au ')).toBe('hazel-id');
  });

  it('leaves new cases unassigned for the sentinels (pre-launch behaviour)', () => {
    for (const v of ['none', 'None', 'unassigned', 'off', '']) {
      expect(pickDefaultCaseRsoUserId(ROSTER, v)).toBeNull();
    }
  });

  it('returns null (unassigned) rather than guessing when the email is not on the roster', () => {
    expect(pickDefaultCaseRsoUserId(ROSTER, 'nobody@example.com')).toBeNull();
  });

  it('never throws on a malformed roster', () => {
    expect(pickDefaultCaseRsoUserId(null, 'hello@mygplink.com.au')).toBeNull();
    expect(pickDefaultCaseRsoUserId([{}, { email: null }], 'hello@mygplink.com.au')).toBeNull();
  });
});
