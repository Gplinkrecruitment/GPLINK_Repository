// tests/registration-hub-inbox.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-hub-inbox.js';
const { groupConversations, normalizeSubject, groupThreadMessages } = pkg;

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
    expect(c2.unread).toBe(false); // its inbound (none here), last msg outbound + read
  });
});

describe('groupConversations, per-thread split', () => {
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

// ── groupThreadMessages: split ONE conversation into its separate email threads ──
// Powers the collapsible thread cards + per-thread reply in the Inbox.
describe('normalizeSubject', () => {
  it('strips stacked reply/forward prefixes', () => {
    expect(normalizeSubject('Re: Fwd: RE: AHPRA docs')).toBe('ahpra docs');
    expect(normalizeSubject('AHPRA docs')).toBe('ahpra docs');
    expect(normalizeSubject('RE[2]: AHPRA docs')).toBe('ahpra docs');
  });
  it('is empty for a missing subject', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject(null)).toBe('');
  });
});

describe('groupThreadMessages', () => {
  const msgs = [
    // Two Resend notifications, no gmail thread, only a subject to group on.
    { id:'m1', gmail_thread_id:null, direction:'outbound', sender:'registration@mygplink.com.au', recipient:'mercy@example.com', subject:'Re-upload requested: Specialist Qualification', body_text:'Rejected.', created_at:'2026-07-13T00:02:00Z', read_at:null },
    { id:'m2', gmail_thread_id:null, direction:'outbound', sender:'registration@mygplink.com.au', recipient:'mercy@example.com', subject:'Primary Medical Degree verified', body_text:'Approved.', created_at:'2026-07-13T02:29:00Z', read_at:null },
    // The doctor replies to the first one, same subject with "Re:", still no gmail thread id.
    { id:'m3', gmail_thread_id:null, direction:'inbound', sender:'mercy@example.com', recipient:'registration@mygplink.com.au', subject:'Re: Re-upload requested: Specialist Qualification', body_text:'Re-uploaded now', created_at:'2026-07-13T03:00:00Z', read_at:null, rfc822_message_id:'<abc@mail.gmail.com>', task_id:'t-9' }
  ];
  const reupload = (out) => out.find(g => /Re-upload/.test(g.subject));
  const degree = (out) => out.find(g => /Primary Medical Degree/.test(g.subject));
  it('groups by subject when there is no gmail thread id', () => {
    const out = groupThreadMessages({ messages: msgs, fallbackTo:'mercy@example.com' });
    expect(out.length).toBe(2);
    expect(reupload(out).count).toBe(2);   // re-upload request + the doctor's reply
    expect(degree(out).count).toBe(1);
  });
  it('titles each thread with the FIRST subject, not the latest "Re:" one', () => {
    const out = groupThreadMessages({ messages: msgs, fallbackTo:'' });
    expect(reupload(out).subject).toBe('Re-upload requested: Specialist Qualification');
  });
  it('carries a per-thread reply target and In-Reply-To id', () => {
    const out = groupThreadMessages({ messages: msgs, fallbackTo:'' });
    expect(reupload(out).to).toBe('mercy@example.com');           // last inbound sender
    expect(reupload(out).inReplyTo).toBe('<abc@mail.gmail.com>'); // newest rfc822 id in THIS thread
    expect(reupload(out).latestTaskId).toBe('t-9');
    expect(degree(out).to).toBe('mercy@example.com');             // outbound-only → its recipient
    expect(degree(out).inReplyTo).toBe('');                       // nothing to thread against
  });
  it('falls back to the case reply address when a thread has no counterparty at all', () => {
    const orphan = [{ id:'m9', gmail_thread_id:null, direction:'outbound', sender:'registration@mygplink.com.au', recipient:null, subject:'Document verified', body_text:'ok', created_at:'2026-07-13T04:00:00Z' }];
    const out = groupThreadMessages({ messages: orphan, fallbackTo:'mercy@example.com' });
    expect(out[0].to).toBe('mercy@example.com');
  });
  it('gmail_thread_id wins over subject, two threads can share a subject', () => {
    const twoThreads = [
      { id:'a', gmail_thread_id:'t1', direction:'outbound', recipient:'a@x.com', subject:'Documents', created_at:'2026-07-01T09:00:00Z' },
      { id:'b', gmail_thread_id:'t2', direction:'outbound', recipient:'b@x.com', subject:'Documents', created_at:'2026-07-02T09:00:00Z' }
    ];
    const out = groupThreadMessages({ messages: twoThreads, fallbackTo:'' });
    expect(out.length).toBe(2);
    expect(out.map(g => g.threadId)).toEqual(['t1','t2']);
  });
  it('keeps blank-subject, no-thread messages separate instead of pooling them', () => {
    const blanks = [
      { id:'a', gmail_thread_id:null, direction:'inbound', sender:'a@x.com', subject:'', created_at:'2026-07-01T09:00:00Z' },
      { id:'b', gmail_thread_id:null, direction:'inbound', sender:'b@x.com', subject:null, created_at:'2026-07-02T09:00:00Z' }
    ];
    const out = groupThreadMessages({ messages: blanks, fallbackTo:'' });
    expect(out.length).toBe(2);
    expect(out[0].subject).toBe('(no subject)');
  });
  it('flags a thread unread when it holds an unread inbound message', () => {
    const out = groupThreadMessages({ messages: msgs, fallbackTo:'' });
    expect(reupload(out).unread).toBe(true);    // m3 inbound, read_at null
    expect(degree(out).unread).toBe(false);     // outbound only
  });
  it('orders threads by last activity so the newest sits by the composer', () => {
    const out = groupThreadMessages({ messages: msgs, fallbackTo:'' });
    expect(out.map(g => g.latestAt)).toEqual(['2026-07-13T02:29:00Z', '2026-07-13T03:00:00Z']);
  });
  it('merges a no-thread notification group into the Gmail thread that answers it', () => {
    const ms = [
      { id:'n1', gmail_thread_id:null, direction:'outbound', sender:'registration@mygplink.com.au', recipient:'mercy@example.com', subject:'Re-upload requested: Specialist Qualification', created_at:'2026-07-13T00:00:00Z' },
      { id:'r1', gmail_thread_id:'gt-9', direction:'inbound', sender:'mercy@example.com', recipient:'registration@mygplink.com.au', subject:'Re: Re-upload requested: Specialist Qualification', created_at:'2026-07-13T05:00:00Z', read_at:null, rfc822_message_id:'<x@g>' }
    ];
    const out = groupThreadMessages({ messages: ms, fallbackTo:'' });
    expect(out.length).toBe(1);
    expect(out[0].threadId).toBe('gt-9');
    expect(out[0].count).toBe(2);
    expect(out[0].subject).toBe('Re-upload requested: Specialist Qualification'); // earliest message titles the thread
    expect(out[0].to).toBe('mercy@example.com');
    expect(out[0].inReplyTo).toBe('<x@g>');
    expect(out[0].unread).toBe(true);
  });
});
