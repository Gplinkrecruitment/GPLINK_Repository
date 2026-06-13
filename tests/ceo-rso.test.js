import { describe, it, expect } from 'vitest';
import { resolveRsoReassignmentTarget } from '../lib/ceo-metrics.js';

var ROSTER = [
  { user_id: 'a1', name: 'Khaleed Mahmoud', email: 'khaleedmahmoud1211@gmail.com', active: true },
  { user_id: 'b2', name: 'Hazel', email: 'hazel@mygplink.com.au', active: true },
  { user_id: 'c3', name: 'Inactive Person', email: 'inactive@x.com', active: false }
];
var MAILBOXES = [
  { user_id: 'b2', email_address: 'hazel@mygplink.com.au', display_name: 'Hazel' }
];

describe('resolveRsoReassignmentTarget', () => {
  it('rejects __unassigned__ (cannot reassign TO unassigned via transfer)', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, '__unassigned__');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unassigned/i);
  });
  it('rejects an RSO not on the roster', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'does-not-exist');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a registered RSO/i);
  });
  it('rejects an RSO with no va_gmail_accounts mailbox (no silent no-op)', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'a1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Gmail mailbox/i);
    expect(r.rso.name).toBe('Khaleed Mahmoud');
  });
  it('resolves an RSO that has a mailbox', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'b2');
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.mailbox.email_address).toBe('hazel@mygplink.com.au');
    expect(r.rso.name).toBe('Hazel');
  });
  it('lock-step: resolved RSO user_id is what the handler assigns to the mailbox owner', () => {
    var r = resolveRsoReassignmentTarget(ROSTER, MAILBOXES, 'b2');
    expect(r.ok).toBe(true);
    expect(r.rso.user_id).toBe('b2'); // handler sets patch.assigned_va = r.rso.user_id
  });
});
