// FR-7 (guide walk): "You are cleared to start" (and the start-date email) are
// only sent between 08:00 and 20:00 on the doctor's clock. When a staff action
// landed outside those hours the message was held and NOTHING on the screen
// said so. Now the reply to that action carries a plain line with the real
// time the message will go, and the staff screens show it.
//
// The time is real: a held message is sent by the next run of the job that
// sends it which falls inside the doctor's day. That is 08:00 for a doctor in
// Perth and 10:00 or 11:00 for a doctor in Sydney (the in-hours run waits for
// 08:00 to have arrived everywhere in Australia), so the line never promises
// "8am" to someone it will reach at 11.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);   // 00:37 Sunday 22 Nov 2026 in Sydney: outside every doctor's hours
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const quietHours = require('../lib/au-quiet-hours.js');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const dayAt = clock.dayAt;
let rig;
let t;
let seq = 0;
const tasksOf = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId) || rig.table('placements')[rig.table('placements').length - 1];
const startDate = (d, body, who) => rig.post('/api/admin/au/prestart/start-date', Object.assign({ case_id: d.caseId }, body), who || rig.superAdmin());
const n16 = (d) => rig.emails.filter((e) => /cleared to start/i.test(String(e.subject)) && JSON.stringify(e.to).indexOf(d.email) !== -1);

async function placedDoctor(state) {
  seq += 1;
  const d = buildAuDoctor('au_vr', { idSuffix: String(7500 + seq), profile: { phone: '+614006' + String(10000 + seq), phone_number: '4006' + String(10000 + seq), country_dial: '+61', current_state: state || 'NSW', timezone: (state === 'WA' ? 'Australia/Perth' : 'Australia/Sydney') } });
  rig.addDoctor(d);
  expect((await rig.place(d, 'ats_placement')).status).toBe(200);
  return d;
}
// Everything on the checklist except the start date: saving the date is then the action that clears the doctor.
function completeAllButStartDate(d) {
  rig.approvePrestartDocuments(d);
  tasksOf(d).filter((x) => ['indemnity_certificate', 'provider_number_new_location', 'credentialing_pack'].indexOf(x.task_type) !== -1)
    .forEach((x) => { x.status = 'completed'; x.completed_at = new Date(clock.T0).toISOString(); });
  if (!tasksOf(d).some((x) => x.task_type === 'credentialing_pack')) {
    rig.table('registration_tasks').push({ id: 'cred-' + d.userId.slice(-6), case_id: d.caseId, task_type: 'credentialing_pack', status: 'completed', title: 'Send the practice credentialing pack', related_stage: 'prestart',
      metadata: { au: true, placement_key: placementOf(d).application_id } });
  }
}

beforeAll(async () => {
  rig = await bootPlacementRig({ name: 'fr7-held', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' }, emulator: { defaults: { registration_tasks: { status: 'open' } } } });
  t = rig.testUtils;
  // This file tests the quiet hours themselves: the gate reads the (pinned) clock, not the rig's in-hours default.
  t.__setAuQuietHoursClockForTest(null);
}, 60000);
afterAll(async () => { clock.restore(); if (rig) await rig.close(); });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); clock.setNow(clock.T0); rig.resetRecorders(); });

describe('the real next send time (lib/au-quiet-hours.js)', () => {
  const at = Date.parse('2026-11-25T10:20:00Z');   // 9:20pm in Sydney, 6:20pm in Perth

  it('the runs it counts are the ones in vercel.json: the daily job at 20:30 UTC and the hourly job on the hour', () => {
    const crons = JSON.parse(read('vercel.json')).crons;
    const of = (p) => crons.filter((c) => c.path === p)[0].schedule;
    expect(of('/api/cron/sla-sweep')).toBe('30 20 * * *');
    expect(of('/api/cron/onboarding-nudge')).toBe('0 * * * *');
    expect(quietHours.DAILY_RUN_UTC).toEqual({ hour: 20, minute: 30 });
    // the server's in-hours pass uses the same two-hour window
    expect(read('server.js')).toContain('auQuietHours.allAustraliaWindowOpenedWithin(at, 2 * 60 * 60 * 1000)');
    expect(quietHours.IN_HOURS_PASS_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('a Sydney doctor in summer: 11:00am the next morning, not 8am; a Perth doctor: 8:00am', () => {
    const syd = quietHours.nextLifecycleSendMs('Australia/Sydney', true, at);
    expect(new Date(syd).toISOString()).toBe('2026-11-26T00:00:00.000Z');          // 11:00 AEDT
    expect(quietHours.nextLifecycleSendMs('Australia/Perth', true, at)).toBe(syd);  // 08:00 AWST, the same run
    // winter: 10:00am in Sydney
    const winter = quietHours.nextLifecycleSendMs('Australia/Sydney', true, Date.parse('2026-07-01T11:00:00Z'));
    expect(new Date(winter).toISOString()).toBe('2026-07-02T00:00:00.000Z');
    // zone not known for certain: the same run (inside hours everywhere)
    expect(quietHours.nextLifecycleSendMs('Australia/Sydney', false, at)).toBe(syd);
  });

  it('whatever it answers, the doctor\'s gate is open at that instant and a job really runs then', () => {
    for (let h = 0; h < 72; h += 1) {
      const now = at + h * 3600000 + 7 * 60000;
      for (const zone of ['Australia/Sydney', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Darwin']) {
        const next = quietHours.nextLifecycleSendMs(zone, true, now);
        expect(Number.isFinite(next), zone + ' ' + h).toBe(true);
        expect(next).toBeGreaterThan(now);
        expect(quietHours.isLifecycleRunInstant(next)).toBe(true);
        expect(quietHours.auQuietHoursAllowInZone ? quietHours.zoneInsideHours(zone, next) : true).toBe(true);
      }
    }
  });
});

describe('the staff action that held a message says so', () => {
  it('saving the start date at night clears the doctor, both emails are held, and the reply carries one plain line each with the real send time', async () => {
    const d = await placedDoctor('NSW');
    completeAllButStartDate(d);
    rig.resetRecorders();
    const res = await startDate(d, { start_date: dayAt(30) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await rig.settle(300);
    expect(n16(d)).toEqual([]);                                              // held, as the rule says
    const held = res.json.held_messages;
    expect(Array.isArray(held), JSON.stringify({ m: res.json.messages, pc: res.json.prestart_complete, missing: res.json.missing, open: res.json.open, docs: res.json.documents_outstanding })).toBe(true);
    expect(held.map((m) => m.id).sort()).toEqual(['N15', 'N16']);
    const cleared = held.filter((m) => m.id === 'N16')[0];
    expect(cleared.zone_label).toBe('Sydney time');
    expect(cleared.send_at).toBe('2026-11-22T00:00:00.000Z');                 // 11:00am Sunday 22 Nov in Sydney: the in-hours run
    expect(cleared.text).toContain('Not sent yet: the "You are cleared to start" email to the doctor.');
    expect(cleared.text).toContain('Messages to a doctor only go between 8am and 8pm on their own clock (it is 00:37 there now)');
    expect(cleared.text).toContain('It will be sent at about 11:00am on Sunday 22 November (Sydney time).');
    expect(cleared.text).not.toMatch(/8am their time/);

    // and it really goes then: the same job, run at that instant, sends it once
    clock.setNow(Date.parse(cleared.send_at) + 20000);
    await t.runAuLifecycleSweep(Date.parse(cleared.send_at) + 20000);
    await rig.settle(400);
    expect(n16(d).length).toBe(1);
  });

  it('a Perth doctor: the line says 8:00am, Perth time', async () => {
    const d = await placedDoctor('WA');
    completeAllButStartDate(d);
    const res = await startDate(d, { start_date: dayAt(30) });
    const cleared = (res.json.held_messages || []).filter((m) => m.id === 'N16')[0];
    expect(cleared, JSON.stringify(res.json.held_messages)).toBeTruthy();
    expect(cleared.zone_label).toBe('Perth time');
    expect(cleared.text).toContain('It will be sent at about 8:00am on Sunday 22 November (Perth time).');
  });

  it('inside the doctor\'s hours nothing is held: the email goes at once and the reply has no such key', async () => {
    clock.setNow(Date.parse('2026-11-22T02:00:00Z'));                         // 1pm in Sydney
    const d = await placedDoctor('NSW');
    completeAllButStartDate(d);
    rig.resetRecorders();
    const res = await startDate(d, { start_date: dayAt(30) });
    expect(res.status).toBe(200);
    await rig.settle(400);
    expect(res.json.held_messages).toBeUndefined();
    expect(n16(d).length).toBe(1);
  });

  it('a general task screen that completes the last pre-start task at night is told too', async () => {
    const e = await placedDoctor('NSW');
    rig.approvePrestartDocuments(e);
    tasksOf(e).filter((x) => ['indemnity_certificate', 'provider_number_new_location'].indexOf(x.task_type) !== -1).forEach((x) => { x.status = 'completed'; });
    tasksOf(e).filter((x) => x.task_type === 'credentialing_pack').forEach((x) => { x.status = 'cancelled'; });
    const packId = 'fr7-pack-' + e.userId.slice(-6);
    rig.table('registration_tasks').push({ id: packId, case_id: e.caseId, task_type: 'credentialing_pack', status: 'open', title: 'Send the practice credentialing pack', related_stage: 'prestart',
      metadata: { au: true, what_to_do: 'x', placement_key: placementOf(e).application_id } });
    clock.setNow(Date.parse('2026-11-22T02:00:00Z'));                         // 1pm in Sydney: the start date goes out in hours
    expect((await startDate(e, { start_date: dayAt(30) })).status).toBe(200);
    await rig.settle(300);
    expect(n16(e)).toEqual([]);                                               // not cleared yet: the pack is still open
    clock.setNow(Date.parse('2026-11-22T12:00:00Z'));                         // 11pm in Sydney
    rig.resetRecorders();
    const done = await rig.put('/api/admin/task?id=' + encodeURIComponent(packId), { status: 'completed' }, rig.superAdmin());
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    await rig.settle(300);
    expect(n16(e)).toEqual([]);
    expect((done.json.held_messages || []).map((m) => m.id)).toEqual(['N16']);
    expect(done.json.held_messages[0].text).toContain('It will be sent at about 11:00am on Monday 23 November (Sydney time).');
  });

  it('an overseas doctor\'s staff actions never carry the key, and with the switch off no reply does', async () => {
    const uk = buildAuDoctor('overseas_null', { idSuffix: String(7590 + (seq += 1)), profile: { phone: '+447700944' + String(100 + seq) }, caseRow: { stage: 'career' } });
    rig.addDoctor(uk);
    rig.table('registration_tasks').push({ id: 'fr7-h-' + uk.userId.slice(-6), case_id: uk.caseId, task_type: 'manual', status: 'open', title: 'An overseas task (FAKE)', related_stage: 'career', metadata: {} });
    const done = await rig.put('/api/admin/task?id=fr7-h-' + uk.userId.slice(-6), { status: 'completed' }, rig.superAdmin());
    expect(done.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(done.json, 'held_messages')).toBe(false);
    rig.setSwitch(false);
    const list = await rig.get('/api/admin/cases', rig.superAdmin());
    expect(Object.prototype.hasOwnProperty.call(list.json, 'held_messages')).toBe(false);
  });
});

describe('the screens show the line', () => {
  it('admin: after "Save start date" / "Record number", after any Mark Complete, and after approving a document', () => {
    const admin = read('pages/admin.html');
    expect(admin).toContain('function auShowHeldMessages(d){');
    expect(admin).toContain('(cfg.after?showOpsToast:toast)(cfg.doneMessage,"green");\n        auShowHeldMessages(d);');
    expect(admin).toContain('if(d&&d.ok)auShowHeldMessages(d);\n    return d;');
    expect(admin).toContain("showOpsToast(d.message||'Done','green');\n      auShowHeldMessages(d);");
    // the words are set as text, never as markup
    const fn = admin.slice(admin.indexOf('function auShowHeldMessages(d){'), admin.indexOf('function auTodayIso(){'));
    expect(fn).toContain('p.textContent=String((m&&m.text)||\'\')');
    expect(fn).not.toContain('innerHTML');
  });

  it('CEO dashboard: after saving a task form, completing a task, and correcting the start date', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('if (res && res.ok) { auShowHeld(res); auRefreshAfterTask(c, done); return; }');
    expect(js).toContain("if (res && res.ok) { auShowHeld(res); auRefreshAfterTask(c, 'Task completed.'); return; }");
    expect(js).toContain("auRefreshAfterTask(c, auShowHeld(res) ? 'Start date corrected.' : 'Start date corrected. The doctor and the practice have been told once.')");
    const fn = js.slice(js.indexOf('function auShowHeld(res) {'), js.indexOf('function auStartDateCorrectionBody('));
    expect(fn).toContain('p.textContent = String((m && m.text) || \'\')');
    expect(fn).not.toContain('innerHTML');
  });
});
