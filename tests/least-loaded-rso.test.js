import { describe, it, expect } from 'vitest';
import { pickLeastLoadedRso } from '../lib/ceo-metrics.js';

const roster = [
  { user_id: 'rso-a', name: 'Aisha', active: true, on_leave: false },
  { user_id: 'rso-b', name: 'Ben',   active: true, on_leave: false },
  { user_id: 'rso-c', name: 'Cara',  active: true, on_leave: true  },
];
const today = '2026-07-12';
// helper: build N open tasks owned (via case) by an rso
function cases(map) { return Object.keys(map).map((id, i) => ({ id: 'case-'+i, assigned_rso: map[id] })); }
function tasksFor(counts) {
  const out = [];
  Object.keys(counts).forEach((caseId) => { for (let i=0;i<counts[caseId];i++) out.push({ id: caseId+'-t'+i, case_id: caseId, status: 'open' }); });
  return out;
}

describe('pickLeastLoadedRso', () => {
  it('returns the active RSO with the fewest open tasks', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 3, cb: 1 });
    expect(pickLeastLoadedRso(c, t, roster, today)).toBe('rso-b');
  });
  it('skips on-leave RSOs even if they have zero tasks', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 2, cb: 2 }); // rso-c (on leave) has 0 but is ineligible
    const picked = pickLeastLoadedRso(c, t, roster, today);
    expect(['rso-a','rso-b']).toContain(picked);
    expect(picked).not.toBe('rso-c');
  });
  it('honours excludeUserIds (e.g. archive mailbox)', () => {
    const c = [{ id:'ca', assigned_rso:'rso-a' }, { id:'cb', assigned_rso:'rso-b' }];
    const t = tasksFor({ ca: 1, cb: 5 });
    expect(pickLeastLoadedRso(c, t, roster, today, { excludeUserIds: ['rso-a'] })).toBe('rso-b');
  });
  it('returns null when no eligible RSO exists', () => {
    const onlyLeave = [{ user_id:'rso-c', name:'Cara', active:true, on_leave:true }];
    expect(pickLeastLoadedRso([], [], onlyLeave, today)).toBeNull();
  });
});
