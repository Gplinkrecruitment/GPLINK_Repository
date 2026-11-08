// lib/automation-actions.js — the levers the morning review may move on the
// app's own automation (Hazel, the chase, the no-show sweep) and the executor
// that applies the ticked ones. 2026-11-08, owner: "i should be able to click
// and the ai implements the automation".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const A = require('../lib/automation-actions.js');

describe('levers and values', () => {
  it('has fourteen levers in three groups, each with a default inside its range', () => {
    expect(A.LEVERS.length).toBe(14);
    expect(A.LEVER_KEYS).toContain('hazel.max_attempts');
    expect(A.LEVER_KEYS).toContain('chase.step2_min');
    expect(A.LEVER_KEYS).toContain('noshow.grace_min');
    A.LEVERS.forEach((l) => {
      expect(A.parseValue(l, l.def)).toBe(l.def);
      expect(['hazel', 'chase', 'noshow']).toContain(l.group);
    });
    expect(A.defaults()['hazel.weekday_end']).toBe(19 * 60 + 30);
  });

  it('parses minutes, counts, clocks and switches, and refuses what is out of range', () => {
    const attempts = A.lever('hazel.max_attempts');
    expect(A.parseValue(attempts, '3')).toBe(3);
    expect(A.parseValue(attempts, 2.4)).toBe(2);
    expect(A.parseValue(attempts, '5')).toBeNull();
    expect(A.parseValue(attempts, 'three')).toBeNull();
    const start = A.lever('hazel.weekday_start');
    expect(A.parseValue(start, '07:30')).toBe(450);
    expect(A.parseValue(start, '7.30')).toBe(450);
    expect(A.parseValue(start, '9')).toBe(540);
    expect(A.parseValue(start, 540)).toBe(540);
    expect(A.parseValue(start, '23:00')).toBeNull();
    const sw = A.lever('hazel.vary_retry_time');
    expect(A.parseValue(sw, 'true')).toBe(true);
    expect(A.parseValue(sw, 'off')).toBe(false);
    expect(A.parseValue(sw, 'maybe')).toBeNull();
    expect(A.formatValue(start, 450)).toBe('07:30');
    expect(A.formatValue(sw, true)).toBe('on');
    expect(A.fmtMinutes(180)).toBe('3 hours');
    expect(A.fmtMinutes(45)).toBe('45 minutes');
    expect(A.fmtMinutes(90)).toBe('1.5 hours');
  });

  it('stored settings keep only valid levers; the value in force is stored, else env, else default', () => {
    expect(A.normaliseSettings({ 'hazel.max_attempts': '3', 'hazel.weekday_start': '25:00', bogus: 1, 'chase.step1_min': 2 })).toEqual({ 'hazel.max_attempts': 3, 'chase.step1_min': 2 });
    const cur = A.currentSettings({ 'hazel.max_attempts': 3 }, { 'hazel.max_attempts': 4, 'hazel.retry_after_min': 60, 'noshow.grace_min': 9 });
    expect(cur['hazel.max_attempts']).toBe(3);
    expect(cur['hazel.retry_after_min']).toBe(60);
    expect(cur['noshow.grace_min']).toBe(180);
    expect(cur['chase.step1_min']).toBe(5);
    const lines = A.describeSettings(cur);
    expect(lines.length).toBe(14);
    expect(lines.find((l) => l.key === 'hazel.weekday_start')).toMatchObject({ group: 'Hazel', display: '09:00', range: '06:00 to 22:00' });
    expect(A.leversForPrompt(cur)[1]).toEqual({ lever: 'hazel.max_attempts', is: '3', allowed: '1 to 4', what: 'Hazel: call attempts per lead' });
  });
});

describe('changes the model writes', () => {
  it('keeps well-formed changes, drops an unknown lever or an out-of-range value, caps at six', () => {
    const list = A.normaliseChanges([
      { id: 'aut-1', lever: 'hazel.max_attempts', value: '3', title: 'Give Hazel a third attempt', why: '574 of 1,000 unanswered.', priority: 1 },
      { id: 'aut-2', lever: 'hazel.script', value: 'open with the headline', title: 'x', why: 'y', priority: 1 },
      { id: 'aut-3', lever: 'chase.step3_hours', value: '240', title: 'x', why: 'y', priority: 2 },
      { lever: 'hazel.text_after_missed_call', value: 'true', title: '', why: '', priority: 9 }
    ]);
    expect(list.map((c) => c.id)).toEqual(['aut-1', 'aut-4']);
    expect(list[0]).toMatchObject({ lever: 'hazel.max_attempts', value: 3, label: 'Hazel', priority: 1, applied: null });
    expect(list[1]).toMatchObject({ lever: 'hazel.text_after_missed_call', value: true, title: 'Hazel: booking link by WhatsApp after a missed call', priority: 3 });
    expect(A.normaliseChanges(new Array(9).fill({ lever: 'noshow.grace_min', value: '60', title: 't', why: 'w', priority: 2 })).length).toBe(6);
    expect(A.CHANGE_SCHEMA.properties.lever.enum).toEqual(A.LEVER_KEYS);
  });

  it('describes a change against the settings in force', () => {
    const cur = A.currentSettings({}, {});
    expect(A.describeChange({ lever: 'hazel.max_attempts', value: 3 }, cur)).toBe('Hazel tries each lead up to 3 times (was 2).');
    expect(A.describeChange({ lever: 'hazel.weekday_start', value: 450 }, cur)).toBe('Weekday calls start at 07:30 in the lead\'s local time (was 09:00).');
    expect(A.describeChanges([{ lever: 'noshow.grace_min', value: 120, title: 't' }], cur)[0]).toMatchObject({ label: 'No-show sweep', effect: 'A booking is judged attended or no-show 2 hours after its slot (was 3 hours).' });
  });
});

describe('applying', () => {
  const cur = A.currentSettings({}, {});

  it('applies in priority order, skips what is already so, and refuses windows or chase steps that would run out of order', () => {
    const r = A.applyChanges({ settings: cur, changes: [
      { id: 'aut-1', lever: 'hazel.weekday_end', value: 420, priority: 2 },          // 07:00 end, before the 09:00 start → refused
      { id: 'aut-2', lever: 'hazel.max_attempts', value: 3, priority: 1 },
      { id: 'aut-3', lever: 'chase.step1_min', value: 5, priority: 2 },              // already 5
      { id: 'aut-4', lever: 'chase.step2_min', value: 4, priority: 2 },              // out of range (30 to 360)
      { id: 'aut-5', lever: 'hazel.vary_retry_time', value: true, priority: 3 }
    ] });
    expect(r.results.map((x) => x.id)).toEqual(['aut-2', 'aut-1', 'aut-3', 'aut-4', 'aut-5']);
    expect(r.results[0]).toEqual({ id: 'aut-2', lever: 'hazel.max_attempts', ok: true, skipped: false, message: 'Hazel tries each lead up to 3 times (was 2).', before: 2, after: 3 });
    expect(r.results[1].ok).toBe(false);
    expect(r.results[1].message).toMatch(/^Refused: weekday calls would start \(09:00\) after they stop \(07:00\)/);
    expect(r.results[2]).toMatchObject({ ok: false, skipped: true, message: 'Already 5 min.' });
    expect(r.results[3]).toMatchObject({ ok: false, skipped: false });
    expect(r.results[3].message).toMatch(/outside the allowed range \(30 to 360 minutes\)/);
    expect(r.results[4]).toMatchObject({ ok: true, before: false, after: true });
    expect(r.settings['hazel.max_attempts']).toBe(3);
    expect(r.settings['hazel.weekday_end']).toBe(19 * 60 + 30);
    expect(r.settings['hazel.vary_retry_time']).toBe(true);
    expect(r.counts).toEqual({ applied: 2, skipped: 1, failed: 2 });
    expect(r.ok).toBe(false);
    expect(A.summarise(r.counts)).toBe('2 settings changed, 1 already so, 2 refused.');
    expect(A.summarise({})).toBe('Nothing was changed.');
  });

  it('a batch is checked against itself: moving the start past the end in two changes is caught', () => {
    const r = A.applyChanges({ settings: cur, changes: [
      { id: 'aut-1', lever: 'hazel.weekend_start', value: 17 * 60, priority: 1 },
      { id: 'aut-2', lever: 'hazel.weekend_end', value: 16 * 60, priority: 2 }
    ] });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1].ok).toBe(false);
    expect(r.results[1].message).toMatch(/weekend calls would start \(17:00\) after they stop \(16:00\)/);
    const chase = A.applyChanges({ settings: cur, changes: [{ id: 'aut-1', lever: 'chase.step2_min', value: 360, priority: 1 }, { id: 'aut-2', lever: 'chase.step3_hours', value: 12, priority: 1 }] });
    expect(chase.results[0].ok).toBe(true);
    // 6 hours for the second note, then a 12-hour day-after note: still in order.
    expect(chase.results[1].ok).toBe(true);
    const bad = A.applyChanges({ settings: Object.assign({}, cur, { 'chase.step3_hours': 12 }), changes: [{ id: 'aut-1', lever: 'chase.step2_min', value: 360, priority: 1 }] });
    expect(bad.results[0].ok).toBe(true);
    const worse = A.applyChanges({ settings: Object.assign({}, cur, { 'chase.step2_min': 360 }), changes: [{ id: 'aut-1', lever: 'chase.step3_hours', value: 12, priority: 1 }] });
    expect(worse.results[0].ok).toBe(true);
  });
});

describe('what the consumers read', () => {
  it('only levers the owner has set are handed to Hazel, the chase and the sweep', () => {
    expect(A.leadCallOverrides({})).toEqual({});
    expect(A.leadCallOverrides({ 'hazel.max_attempts': 3, 'hazel.retry_after_min': 60, 'hazel.first_call_delay_min': 10, 'hazel.vary_retry_time': true, 'hazel.text_after_missed_call': false }))
      .toEqual({ maxAttempts: 3, retryAfterMs: 3600000, minLeadAgeMs: 600000, varyRetryTime: true, textAfterMissedCall: false });
    // One window edge set → the whole window object, the rest at defaults.
    expect(A.leadCallOverrides({ 'hazel.weekday_start': 450 }).callWindows).toEqual({ weekday: [450, 1170], saturday: [600, 1080], sunday: [600, 1080] });
    expect(A.consultOverrides({ 'chase.step1_min': 2, 'chase.owner_page_after_min': 10 })).toEqual({ step1Ms: 120000, ownerAlertAfterMs: 600000 });
    expect(A.consultOverrides({ 'chase.step3_hours': 36 })).toEqual({ step3Ms: 36 * 3600000 });
    expect(A.noshowGraceMin({}, 180)).toBe(180);
    expect(A.noshowGraceMin({ 'noshow.grace_min': 60 }, 180)).toBe(60);
  });
});
