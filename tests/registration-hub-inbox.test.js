// tests/registration-hub-inbox.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-hub-inbox.js';
const { groupConversations } = pkg;

const casesById = {
  c1: { id: 'c1', stage: 'ahpra', assigned_va: 'u-hazel', gp_name: 'Dr Sana Khan', practice_name: null },
  c2: { id: 'c2', stage: 'practice_contact', assigned_va: 'u-smith', gp_name: 'Dr Ade Okonkwo', practice_name: 'Greenslopes' }
};
const rsoNameByUserId = { 'u-hazel': 'Hazel', 'u-smith': 'Smith Miller' };
const messages = [
  { case_id: 'c1', direction: 'outbound', subject: 'AHPRA docs', body_text: 'Hi Sana...', created_at: '2026-06-12T09:14:00Z', read_at: null },
  { case_id: 'c1', direction: 'inbound', subject: 'Re: AHPRA docs', body_text: 'Thanks Hazel', created_at: '2026-06-12T16:02:00Z', read_at: null },
  { case_id: 'c2', direction: 'outbound', subject: 'Welcome', body_text: 'Hi Ade', created_at: '2026-06-24T11:20:00Z', read_at: '2026-06-24T12:00:00Z' }
];

describe('groupConversations', () => {
  it('one row per case, newest-message summary, needsReply from last direction', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    const c1 = out.find(x => x.caseId === 'c1');
    expect(c1.name).toBe('Dr Sana Khan');
    expect(c1.assignedRsoName).toBe('Hazel');
    expect(c1.lastDirection).toBe('inbound');
    expect(c1.needsReply).toBe(true);
    expect(c1.unread).toBe(true);          // an inbound message with read_at null
    expect(c1.lastPreview).toContain('Thanks Hazel');
  });
  it('scope=mine filters to the current user\'s cases', () => {
    const mine = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'mine', meUserId: 'u-hazel' });
    expect(mine.map(x => x.caseId)).toEqual(['c1']);
  });
  it('sorts newest conversation first', () => {
    const all = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    expect(all[0].caseId).toBe('c2'); // c2 last activity 24 Jun > c1 12 Jun
  });
  it('uses practice name + practice kind when present', () => {
    const all = groupConversations({ messages, casesById, rsoNameByUserId, scope: 'all', meUserId: 'u-hazel' });
    const c2 = all.find(x => x.caseId === 'c2');
    expect(c2.kind).toBe('practice');
    expect(c2.name).toBe('Greenslopes');
    expect(c2.unread).toBe(false); // its inbound (none here) — last msg outbound + read
  });
});

describe('groupConversations — per-thread split', () => {
  const casesById = { c1: { id:'c1', stage:'ahpra', assigned_va:'u-hazel', gp_name:'Dr Sana Khan', gp_email:'sana@example.com', practice_name:'Greenslopes Medical Centre' } };
  const rsoNameByUserId = { 'u-hazel':'Hazel' };
  // Same case c1, TWO gmail threads: one with the GP, one with the practice
  const messages = [
    { case_id:'c1', gmail_thread_id:'t-gp', direction:'outbound', sender:'registration@mygplink.com.au', recipient:'sana@example.com', subject:'Your AHPRA docs', body_text:'Hi Sana', created_at:'2026-06-12T09:00:00Z', read_at:null },
    { case_id:'c1', gmail_thread_id:'t-gp', direction:'inbound', sender:'sana@example.com', recipient:'registration@mygplink.com.au', subject:'Re', body_text:'Thanks', created_at:'2026-06-12T10:00:00Z', read_at:null },
    { case_id:'c1', gmail_thread_id:'t-prac', direction:'outbound', sender:'registration@mygplink.com.au', recipient:'reception@greenslopes.com.au', subject:'Contract', body_text:'Hi team', created_at:'2026-06-13T09:00:00Z', read_at:null },
    { case_id:'c1', gmail_thread_id:'t-prac', direction:'inbound', sender:'reception@greenslopes.com.au', recipient:'registration@mygplink.com.au', subject:'Re', body_text:'Signed', created_at:'2026-06-13T11:00:00Z', read_at:null }
  ];
  it('splits one case into two conversations, one per gmail thread', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    expect(out.length).toBe(2);
    expect(out.map(c => c.threadId).sort()).toEqual(['t-gp','t-prac']);
  });
  it('each conversation replies to its OWN counterparty (no cross-talk)', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    const gp = out.find(c => c.threadId === 't-gp');
    const prac = out.find(c => c.threadId === 't-prac');
    expect(gp.counterparty).toBe('sana@example.com');         // GP thread → reply to Sana
    expect(prac.counterparty).toBe('reception@greenslopes.com.au'); // practice thread → reply to practice
  });
  it('labels each thread by its OWN counterparty: GP thread → doctor name, practice thread → practice name', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    const gp = out.find(c => c.threadId === 't-gp');
    const prac = out.find(c => c.threadId === 't-prac');
    // The case HAS a practice, but the GP thread must still be labelled as the doctor.
    expect(gp.kind).toBe('doctor');
    expect(gp.name).toBe('Dr Sana Khan');
    expect(prac.kind).toBe('practice');
    expect(prac.name).toBe('Greenslopes Medical Centre');
  });
  it('matches the GP email case-insensitively and through a "Name <addr>" counterparty', () => {
    const msgs = [
      { case_id:'c1', gmail_thread_id:'t-gp2', direction:'inbound', sender:'Dr Sana Khan <SANA@example.com>', recipient:'registration@mygplink.com.au', subject:'Re', body_text:'hi', created_at:'2026-06-15T09:00:00Z', read_at:null }
    ];
    const out = groupConversations({ messages: msgs, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    expect(out[0].kind).toBe('doctor');
    expect(out[0].name).toBe('Dr Sana Khan');
  });
  it('per-thread stats are independent', () => {
    const out = groupConversations({ messages, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    const prac = out.find(c => c.threadId === 't-prac');
    expect(prac.lastDirection).toBe('inbound');   // practice last wrote
    expect(prac.needsReply).toBe(true);
    expect(prac.lastPreview).toContain('Signed');
  });
  it('messages with no gmail_thread_id fall into a single per-case bucket', () => {
    const noThread = [ { case_id:'c1', gmail_thread_id:null, direction:'inbound', sender:'x@example.com', recipient:'registration@mygplink.com.au', subject:'s', body_text:'b', created_at:'2026-06-14T09:00:00Z', read_at:null } ];
    const out = groupConversations({ messages: noThread, casesById, rsoNameByUserId, scope:'all', meUserId:'u-hazel' });
    expect(out.length).toBe(1);
    expect(out[0].threadId).toBe('');
    expect(out[0].counterparty).toBe('x@example.com');
  });
});
