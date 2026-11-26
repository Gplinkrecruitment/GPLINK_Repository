// lib/whatsapp-export-import.js — plans what a WhatsApp Business Web export
// changes on the CEO Pipeline board. Pure; the route test is in ceo-pipeline.test.js.
import { describe, it, expect } from 'vitest';
import wa from '../lib/whatsapp-export-import.js';

const HEADER = 'Mon Nov 23 2026 21:46:44 GMT+0800 (Central Indonesia Time)';
const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const chat = (o) => Object.assign({ isGroup: false, messageCount: (o.messages || []).length }, o);
const msg = (time, from, text, extra) => Object.assign({ time, from, type: 'chat', text: text || '' }, extra || {});

describe('time parsing', () => {
  it('reads the offset from the export header', () => {
    expect(wa.parseOffsetMinutes(HEADER)).toBe(480);
    expect(wa.parseOffsetMinutes('Tue Nov 24 2026 09:00:00 GMT-0530 (x)')).toBe(-330);
    expect(wa.parseOffsetMinutes('GMT+05:45')).toBe(345);
    expect(wa.parseOffsetMinutes('no zone here')).toBeNull();
  });
  it('turns the header and local message times into UTC', () => {
    expect(wa.parseExportedAt(HEADER)).toBe('2026-11-23T13:46:44.000Z');
    expect(new Date(wa.parseLocalTime('2026-11-23 21:30', 480)).toISOString()).toBe('2026-11-23T13:30:00.000Z');
    expect(new Date(wa.parseLocalTime('2026-11-24 01:00', 480)).toISOString()).toBe('2026-11-23T17:00:00.000Z');
    expect(Number.isNaN(wa.parseLocalTime('yesterday', 480))).toBe(true);
  });
});

describe('which chats count', () => {
  it('keeps Dr chats and 1:1 doctor chats with a reply; skips groups, system, spam and empty chats', () => {
    expect(wa.skipReason(chat({ chat: 'Dr Jason Jones', id: '1@lid', messages: [msg('2026-11-20 10:00', 'Me', 'Hi')] }))).toBe('');
    expect(wa.skipReason(chat({ chat: 'Mount Hutton + Dr M', id: '120@g.us', messages: [msg('2026-11-20 10:00', 'X', 'Hi')] }))).toBe('group');
    expect(wa.skipReason(chat({ chat: 'Some group', id: '9@lid', isGroup: true, messages: [msg('2026-11-20 10:00', 'X', 'Hi')] }))).toBe('group');
    expect(wa.skipReason(chat({ chat: 'WhatsApp Business', id: '0@c.us', messages: [msg('2026-11-20 10:00', 'WhatsApp Business', 'Tips')] }))).toBe('system');
    expect(wa.skipReason(chat({ chat: 'WhatsApp Support', id: '5@c.us', messages: [msg('2026-11-20 10:00', 'WhatsApp Support', 'Hi')] }))).toBe('system');
    expect(wa.skipReason(chat({ chat: '+62 822-8888-7062', id: '2@lid', messages: [] }))).toBe('empty');
    expect(wa.skipReason(chat({ chat: '+44 7538 373168', id: '3@lid', messages: [msg('2026-11-20 10:00', 'Me', 'Hello doctor')] }))).toBe('no_reply');
    expect(wa.skipReason(chat({ chat: 'Unknown user', id: '4@lid', messages: [msg('2026-11-20 10:00', 'Unknown user', 'Win a prize!')] }))).toBe('not_doctor');
    expect(wa.skipReason(chat({ chat: '+44 7502 422424', id: '6@lid', messages: [msg('2026-11-20 10:00', 'Me', 'Thanks for your interest in GP roles in Australia'), msg('2026-11-20 11:00', '+44 7502 422424', 'Yes please')] }))).toBe('');
  });
});

describe('planWhatsappImport', () => {
  const EXPORT = {
    exportedAt: HEADER, source: 'WhatsApp Business Web', chatCount: 6, messageCount: 9,
    chats: [
      chat({ chat: 'Dr Hatice Akkas', id: 'h@lid', messages: [msg('2026-11-23 17:37', 'Dr Hatice Akkas', 'Is AHPRA granted?'), msg('2026-11-23 09:00', 'Me', 'Morning')] }),
      chat({ chat: 'Dr Tan Ke Ying', id: 't@lid', messages: [msg('2026-11-21 10:00', 'Dr Tan Ke Ying', 'Passed!'), msg('2026-11-23 21:27', 'Me', '', { type: 'call_log', media: 'call_log' })] }),
      chat({ chat: '+44 7538 373168', id: 'p@lid', messages: [msg('2026-11-21 18:00', 'Me', 'Are you a GP?'), msg('2026-11-21 18:50', '+44 7538 373168', 'Yes, MRCGP')] }),
      chat({ chat: 'Dr Cold Lead', id: 'c@lid', messages: [msg('2026-08-01 10:00', 'Dr Cold Lead', 'Maybe later')] }),
      chat({ chat: 'Dr Never Replied', id: 'n@lid', messages: [msg('2026-11-20 10:00', 'Me', 'Hi doctor')] }),
      chat({ chat: 'GP Link + Dr Chikore', id: 'g@g.us', messages: [msg('2026-09-11 20:48', 'Dr Chikore', 'Hi')] })
    ]
  };
  const EXISTING = [
    { id: 'row-h', source_ref: 'h@lid', last_message_at: '2026-11-20T00:00:00.000Z', last_message_from: 'me', last_message_snippet: 'old', phone: null, next_step: 'owner field', stage: 'signed' },
    { id: 'row-n', source_ref: 'n@lid', last_message_at: '2026-11-01T00:00:00.000Z', last_message_from: 'me', last_message_snippet: 'older', phone: null }
  ];
  const plan = wa.planWhatsappImport(EXPORT, EXISTING, NOW);

  it('reports the export time and offset', () => {
    expect(plan.exportedAtIso).toBe('2026-11-23T13:46:44.000Z');
    expect(plan.offsetMinutes).toBe(480);
  });

  it('updates an existing row with ONLY the message fields, using the latest message (not the array order)', () => {
    const u = plan.updates.find((x) => x.id === 'row-h');
    expect(u.patch).toEqual({ last_message_at: '2026-11-23T09:37:00.000Z', last_message_from: 'them', last_message_snippet: 'Is AHPRA granted?' });
    expect(Object.keys(u.patch)).not.toContain('stage');
    expect(Object.keys(u.patch)).not.toContain('next_step');
    expect(Object.keys(u.patch)).not.toContain('name');
  });

  it('updates an existing row even when the doctor never replied (only new rows need a reply)', () => {
    expect(plan.updates.find((x) => x.id === 'row-n').patch).toMatchObject({ last_message_from: 'me', last_message_snippet: 'Hi doctor' });
  });

  it('creates warm rows only for doctors who replied within 60 days; a phone-titled chat keeps its number', () => {
    expect(plan.creates.map((c) => c.source_ref).sort()).toEqual(['p@lid', 't@lid']);
    const tan = plan.creates.find((c) => c.source_ref === 't@lid');
    expect(tan).toEqual({ name: 'Dr Tan Ke Ying', phone: null, stage: 'warm', source: 'whatsapp_personal', source_ref: 't@lid', last_message_at: '2026-11-23T13:27:00.000Z', last_message_from: 'me', last_message_snippet: '[call]' });
    const ph = plan.creates.find((c) => c.source_ref === 'p@lid');
    expect(ph.phone).toBe('+447538373168');
    expect(ph.last_message_from).toBe('them');
  });

  it('skips cold, group and duplicate chats and counts why', () => {
    expect(plan.skipped).toBe(2);
    expect(plan.skippedBy).toEqual({ cold: 1, group: 1 });
    const dup = wa.planWhatsappImport({ exportedAt: HEADER, chats: [EXPORT.chats[1], EXPORT.chats[1]] }, [], NOW);
    expect(dup.creates).toHaveLength(1);
    expect(dup.skippedBy.duplicate).toBe(1);
  });

  it('never moves a row backwards with an older export, and reports an identical one as unchanged', () => {
    const newer = [{ id: 'row-h', source_ref: 'h@lid', last_message_at: '2026-11-25T00:00:00.000Z', last_message_from: 'me', last_message_snippet: 'newer' }];
    const p1 = wa.planWhatsappImport({ exportedAt: HEADER, chats: [EXPORT.chats[0]] }, newer, NOW);
    expect(p1.updates).toEqual([]);
    expect(p1.unchanged).toBe(1);
    const same = [{ id: 'row-h', source_ref: 'h@lid', last_message_at: '2026-11-23T09:37:00.000Z', last_message_from: 'them', last_message_snippet: 'Is AHPRA granted?' }];
    expect(wa.planWhatsappImport({ exportedAt: HEADER, chats: [EXPORT.chats[0]] }, same, NOW).unchanged).toBe(1);
  });

  it('adds a phone to an existing number-titled row that had none, and clips snippets to 160 chars', () => {
    const long = 'x'.repeat(400);
    const p = wa.planWhatsappImport({ exportedAt: HEADER, chats: [chat({ chat: '+44 7538 373168', id: 'p@lid', messages: [msg('2026-11-21 18:50', '+44 7538 373168', 'GP here ' + long)] })] },
      [{ id: 'row-p', source_ref: 'p@lid', last_message_at: null, phone: null }], NOW);
    expect(p.updates[0].patch.phone).toBe('+447538373168');
    expect(p.updates[0].patch.last_message_snippet.length).toBe(160);
  });

  it('reads times as UTC when the header has no zone, and survives junk', () => {
    const p = wa.planWhatsappImport({ exportedAt: 'whenever', chats: [EXPORT.chats[1]] }, [], NOW);
    expect(p.offsetMinutes).toBeNull();
    expect(p.creates[0].last_message_at).toBe('2026-11-23T21:27:00.000Z');
    expect(wa.planWhatsappImport(null, null, NOW)).toMatchObject({ creates: [], updates: [], skipped: 0 });
  });
});
