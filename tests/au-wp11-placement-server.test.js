// WP-11 (Australian GP build): the placement branch, on the real server.
//
// Every test records a placement through a real entry point (the rig in
// tests/helpers/au-wp11-placement-rig.js) and reads back EVERYTHING it
// produced: tasks, timeline, documents, every email to the doctor and the
// practice, every WhatsApp, the bell, every Drive call.
//
//   - an au_vr doctor placed through EACH entry point gets no SPPA-00,
//     Section G, supervisor CV or position description task, no Section G
//     file and no AHPRA message; gets the pre-start tasks, an RSO, the case at
//     pre-start, N11 and N12 once; and nothing twice on a replay
//   - segments B and C follow their matrix columns
//   - an unreadable pathway holds, and the held steps run once it reads
//   - completion conditions, the credentialing-pack trigger, auPrestartComplete
//   - the overseas doctor's placement is covered byte for byte by
//     tests/au-wp11-overseas-parity.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, ENTRY_POINTS, PRACTICE_NAME, PRACTICE_EMAIL, START_DATE } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const careerIntro = require('../lib/career-intro.js');

const DOCTOR_BANNED = /MyIntealth|\bAMC\b|\bEPIC\b|\bvisas?\b|relocat|your move|overseas|internationally trained|\bGMC\b|\bSPPA\b|Section G|supervisor CV|Not yet eligible/i;
const OVERSEAS_PACK_KEYS = ['sppa_00', 'section_g', 'supervisor_cv', 'position_description'];
const PRESTART_FIRST = ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location'];
const N11_SUBJECT = 'Your placement is secured: your pre-start checklist';

let rig;
let t;
let seq = 0;

const text = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const types = (cap) => cap.tasks.map((x) => x.task_type);
const count = (cap, type) => cap.tasks.filter((x) => x.task_type === type).length;
const packKeys = (cap) => cap.tasks.filter((x) => x.task_type === 'practice_pack_child').map((x) => x.related_document_key).sort();
const subjects = (list) => list.map((e) => e.subject);
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(8000 + seq) }, o, {
    profile: Object.assign({ phone: '+614009' + String(10000 + seq), phone_number: '4009' + String(10000 + seq), country_dial: '+61' }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}

function assertNoOverseasCascade(cap, label) {
  // no SPPA-00, Section G, supervisor CV or position description task
  const pack = cap.tasks.filter((x) => OVERSEAS_PACK_KEYS.indexOf(x.related_document_key) !== -1);
  expect(pack.map((x) => x.related_document_key), label + ': overseas pack tasks').toEqual([]);
  // no Section G file, in the doctor's documents or in Drive
  expect(cap.documents.filter((x) => x.document_key === 'section_g'), label + ': Section G document').toEqual([]);
  expect(cap.drive.filter((c) => /section g/i.test(JSON.stringify(c.args && c.args.requestBody || {}))), label + ': Section G in Drive').toEqual([]);
  // no link-public Drive copy at all
  expect(cap.drive.filter((c) => c.api === 'permissions.create' && c.args && c.args.requestBody && c.args.requestBody.type === 'anyone'), label + ': link-public copy').toEqual([]);
  // no AHPRA message: no overseas WhatsApp, no overseas email
  expect(cap.whatsapps, label + ': WhatsApp').toEqual([]);
  const all = cap.emailsToDoctor.concat(cap.emailsToPractice);
  for (const e of all) {
    expect(e.subject, label).not.toMatch(/AHPRA|Documents Needed|Section G|Registration Unlocked/);
    expect(text(e.html) + ' ' + (e.text || ''), label + ': ' + e.subject).not.toMatch(/AHPRA|supervision and placement forms/);
  }
  expect(cap.timeline.map((x) => x.title).join('|'), label).not.toMatch(/AHPRA stage|Practice pack email|Section G/);
  expect(cap.visaCases, label).toEqual([]);
}

function assertBannedWordFree(cap, label) {
  for (const e of cap.emailsToDoctor) {
    const body = [e.subject, text(e.html), e.text || ''].join('\n');
    expect(body.match(DOCTOR_BANNED), label + ' doctor email "' + e.subject + '"').toBe(null);
    expect(body, label).not.toMatch(/AHPRA/);
  }
  for (const b of cap.bell) {
    const body = [b.title, b.body, b.detail].join('\n');
    expect(body.match(DOCTOR_BANNED), label + ' bell').toBe(null);
    expect(body, label).not.toMatch(/AHPRA/);
  }
  for (const e of cap.emailsToPractice) {
    for (const part of [e.subject, text(e.html), e.text || '']) {
      expect(careerIntro.auPracticeTextViolations(part), label + ' practice email "' + e.subject + '"').toEqual([]);
      expect(part, label).not.toMatch(/AHPRA|internationally trained|Expedited Specialist/);
    }
  }
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp11-server',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    // the database default: a task inserted with no status is 'open'
    emulator: { defaults: { registration_tasks: { status: 'open' } } }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => {
  rig.setSwitch(true);
  rig.emu.forbid(null);
  rig.emu.failTables = {};
  rig.resetRecorders();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an au_vr doctor placed through each entry point', () => {
  for (const entry of ENTRY_POINTS) {
    it(entry + ': no overseas pack, no Section G, no AHPRA message; the pre-start tasks, an RSO, pre-start, N11 and N12 once', async () => {
      const d = doctor('au_vr');
      const res = await rig.place(d, entry);
      if (res) expect(res.status, entry).toBe(200);
      const cap = rig.capture(d);

      assertNoOverseasCascade(cap, entry);

      // the placement itself: every neutral row fired
      expect(cap.application).toEqual({ status: 'placement_secured', ats_stage: 'hired' });
      expect(cap.placements.length).toBe(1);
      expect(cap.placements[0].status).toBe('active');

      // the case moved to pre-start, once, with an RSO
      expect(cap.caseStage).toBe('prestart');
      expect(cap.timeline.filter((x) => x.event_type === 'stage_change').length).toBe(1);
      expect(cap.assignedRso).toBe(rig.RSO_USER_ID);
      expect(cap.timeline.filter((x) => x.title === 'RSO assigned for pre-start').length).toBe(1);

      // exactly one of each pre-start task, and the contract task
      for (const type of PRESTART_FIRST) expect(count(cap, type), entry + ' ' + type).toBe(1);
      expect(packKeys(cap)).toEqual(['offer_contract']);
      for (const task of cap.tasks.filter((x) => PRESTART_FIRST.indexOf(x.task_type) !== -1)) {
        const m = metaOf(task);
        expect(task.related_stage).toBe('prestart');
        expect(task.due_date, task.task_type).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(m).toMatchObject({ au: true, placement_key: rig.appIdFor(d) });
        expect(m.what_to_do.length).toBeGreaterThan(20);
        // a timeline entry for each
        expect(cap.timeline.filter((x) => x.task_id === task.id && x.event_type === 'created').length).toBe(1);
      }
      // the credentialing pack waits for its trigger
      expect(count(cap, 'credentialing_pack')).toBe(0);

      // N11 to the doctor (email + bell), N12 to the practice, each once
      expect(subjects(cap.emailsToDoctor)).toEqual([N11_SUBJECT]);
      const n11 = cap.emailsToDoctor[0];
      expect(text(n11.html)).toMatch(/Your placement at Test Metro Practice \(FAKE\) is secured/);
      expect(text(n11.html)).toMatch(/1 February 2027/);
      for (const word of ['Notice period and start date', 'Medicare provider number', 'Indemnity', 'Credentialing']) expect(text(n11.html)).toContain(word);
      expect(n11.html).toContain('/pages/prestart'); // WP-12: N11 opens the pre-start page
      expect(cap.bell.filter((b) => b.title === 'Your placement is secured').length).toBe(1);

      const practiceMail = cap.emailsToPractice.filter((e) => /^Placement confirmed/.test(e.subject));
      expect(practiceMail.length).toBe(1);
      expect(practiceMail[0].subject).toBe('Placement confirmed: ' + d.name);
      expect(practiceMail[0].text).toContain('Start date: the expected start date is 1 February 2027');
      expect(practiceMail[0].text).toContain('Provider number: ' + d.name + ' applies for a Medicare provider number for your practice location');
      expect(practiceMail[0].text).toContain('Guarantee period: a 12-week guarantee period applies to permanent placements');
      // the overseas "placement secured" congratulation never went
      expect(subjects(cap.emailsToDoctor).join('|')).not.toMatch(/🎉/);

      assertBannedWordFree(cap, entry);

      // the WhatsApp was skipped for a reason that is on the record
      const done = cap.timeline.filter((x) => String(x.title).indexOf(t.AU_PLACEMENT_HOOKS_DONE_MARKER) === 0);
      expect(done.length).toBe(1);
      expect(done[0].detail).toMatch(/WhatsApp skipped \(au_template_not_approved\)/);
      expect(done[0].detail).toMatch(/Practice told \(N12\): sent/);
    });
  }

  it('the same placement again, every way it can be repeated, creates nothing twice', async () => {
    for (const entry of ENTRY_POINTS) {
      const d = doctor('au_vr');
      await rig.place(d, entry);
      const first = rig.capture(d);
      rig.resetRecorders();

      // the same call again (a double submit)
      const again = await rig.place(d, entry === 'finalize' ? 'ops_replay' : entry, { repeat: true });
      if (again && ['ats_placement', 'ops_record', 'finalize_signed'].indexOf(entry) !== -1) expect(again.status, entry).toBe(409);
      // the state-change path after the placement (the doctor's browser syncing "secured")
      await rig.put('/api/state', { state: { gp_career_state: { career_secured: true, applications: [{ id: rig.appIdFor(d), isPlacementSecured: true }] } }, updatedAt: new Date().toISOString() },
        { cookie: rig.gpCookie(d.email, d.userId) });
      // the ops replay, the bulk sync, the runner called directly, and the daily pass
      await rig.post('/api/admin/ops/replay-career-secured', { user_id: d.userId }, rig.superAdmin());
      await rig.post('/api/admin/cases/sync', {}, rig.superAdmin());
      await t.auRunPlacementHooks(d.userId, { source: 'test', force: true });
      // (one day after the placement: before the first N13 reminder is due)
      await t.runAuPrestartSweep({ now: Date.parse(first.placements[0].placed_at) + 86400000 });
      await rig.settle(300);

      const after = rig.capture(d);
      expect(types(after).sort(), entry).toEqual(types(first).sort());
      expect(after.tasks.length, entry).toBe(first.tasks.length);
      expect(after.emailsToDoctor, entry + ' doctor emails').toEqual([]);
      expect(after.emailsToPractice, entry + ' practice emails').toEqual([]);
      expect(after.whatsapps, entry).toEqual([]);
      expect(after.bell.filter((b) => b.title === 'Your placement is secured').length, entry).toBe(1);
      expect(after.placements.length).toBe(1);
      expect(after.caseStage).toBe('prestart');
      expect(after.timeline.filter((x) => x.event_type === 'stage_change').length).toBe(1);
      expect(after.timeline.filter((x) => x.title === 'RSO assigned for pre-start').length).toBe(1);
      assertNoOverseasCascade(after, entry + ' (repeat)');
    }
  }, 120000);

  it('two placement calls racing produce one of each task and one N11 / N12', async () => {
    const d = doctor('au_vr');
    rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d)).status = 'placement_secured';
    rig.table('placements').push({ id: 'pl-race-' + seq, user_id: d.userId, application_id: rig.appIdFor(d), status: 'active', start_date: START_DATE, practice_name: PRACTICE_NAME, placed_at: '2026-11-01T00:00:00.000Z' });
    await Promise.all([t.auRunPlacementHooks(d.userId, { source: 'a' }), t.auRunPlacementHooks(d.userId, { source: 'b' }), t.auRunPlacementHooks(d.userId, { source: 'c', force: true })]);
    const cap = rig.capture(d);
    for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
    expect(packKeys(cap)).toEqual(['offer_contract']);
    expect(subjects(cap.emailsToDoctor)).toEqual([N11_SUBJECT]);
    expect(cap.emailsToPractice.length).toBe(1);
  });

  it('the browser saying "secured" with no placement on record does nothing: no tasks, no messages, the case stays at placement', async () => {
    const d = doctor('au_vr');
    const res = await rig.put('/api/state', { state: { gp_career_state: { career_secured: true, secured: true, applications: [{ id: 'fake', isPlacementSecured: true }] } }, updatedAt: new Date().toISOString() },
      { cookie: rig.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    await rig.settle(300);
    const cap = rig.capture(d);
    expect(cap.caseStage).toBe('placement');
    expect(cap.tasks).toEqual([]);
    expect(cap.emailsToDoctor).toEqual([]);
    expect(cap.emailsToPractice).toEqual([]);
    expect(cap.bell).toEqual([]);
    expect(cap.assignedRso).toBe(null);
    expect(await t.auRunPlacementHooks(d.userId, {})).toMatchObject({ ok: true, ran: false, reason: 'no_placement' });
  });

  it('a contract signed in the app closes the contract task; a staff-recorded placement leaves it open', async () => {
    const signed = doctor('au_vr');
    await rig.place(signed, 'finalize_signed');
    const a = rig.capture(signed).tasks.find((x) => x.related_document_key === 'offer_contract');
    expect(a.status).toBe('completed');
    const verbal = doctor('au_vr');
    await rig.place(verbal, 'ats_placement');
    const b = rig.capture(verbal).tasks.find((x) => x.related_document_key === 'offer_contract');
    expect(b.status).not.toBe('completed');
  });

  it('an RSO a person already assigned is kept; the placing consultant is still on the case', async () => {
    const d = doctor('au_vr', { caseRow: { assigned_rso: rig.OTHER_RSO_USER_ID, assigned_va: rig.OTHER_RSO_USER_ID, placing_consultant: 'consultant.test@gplink-test.local' } });
    await rig.place(d, 'ats_placement');
    const cap = rig.capture(d);
    expect(cap.assignedRso).toBe(rig.OTHER_RSO_USER_ID);
    expect(rig.caseOf(d).placing_consultant).toBe('consultant.test@gplink-test.local');
    expect(metaOf(cap.tasks.find((x) => x.task_type === 'start_date_tracking')).placing_consultant).toBe('consultant.test@gplink-test.local');
    // N12 names the consultant as the contact
    expect(cap.emailsToPractice.find((e) => /^Placement confirmed/.test(e.subject)).text).toContain('Your contact at GP Link is consultant.test@gplink-test.local');
    // the consultant can still read the case's tasks (WP-06 route)
    const list = await rig.get('/api/ats/candidate/tasks?case_id=' + encodeURIComponent(d.caseId), rig.consultant());
    expect(list.status).toBe(200);
    expect(list.json.tasks.map((x) => x.task_type)).toEqual(expect.arrayContaining(PRESTART_FIRST));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('segments B and C (built, not launched): their matrix columns', () => {
  it('au_restricted with supervised registration: the supervision pack fires (with SPPA-00 goes Section G), no AHPRA message, the pre-start tasks too', async () => {
    const d = doctor('au_restricted', { credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_2' } });
    await rig.place(d, 'ats_placement');
    const cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(cap.tasks.find((x) => x.related_document_key === 'sppa_00').status).toBe('deferred');
    // Section G delivered (only with SPPA-00), silently: no "added to your documents" email
    expect(cap.documents.map((x) => x.document_key)).toContain('section_g');
    expect(cap.tasks.find((x) => x.related_document_key === 'section_g').status).toBe('completed');
    expect(subjects(cap.emailsToDoctor)).toEqual([N11_SUBJECT]);
    // no AHPRA message, no overseas congratulation, no practice-pack email
    expect(cap.whatsapps).toEqual([]);
    expect(cap.timeline.map((x) => x.title).join('|')).not.toMatch(/AHPRA stage|Practice pack email/);
    expect(cap.caseStage).toBe('prestart');
    for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
    // N11 and N12 carry the segment's one extra line
    expect(text(cap.emailsToDoctor[0].html)).toContain('Registration: our team will be in touch');
    const n12 = cap.emailsToPractice.find((e) => /^Placement confirmed/.test(e.subject));
    expect(n12.text).toContain('Supervision: this placement needs supervision paperwork from your practice.');
    expect(n12.text).not.toMatch(/AHPRA/);
    // no staff decision needed: everything is on file
    expect(cap.tasks.filter((x) => x.source_trigger === 'au_placement_review')).toEqual([]);
    assertBannedWordFree({ emailsToDoctor: cap.emailsToDoctor, emailsToPractice: [], bell: cap.bell }, 'B supervised (doctor)');
  });

  it('au_restricted with general registration and no sponsor tie: no supervision tasks, no position description, no Section G', async () => {
    const d = doctor('au_restricted', { credentials: { ahpra_registration_type: 'general', supervision_level: 'none', work_rights: 'pr', visa_sponsor_tied: null } });
    await rig.place(d, 'ats_placement');
    const cap = rig.capture(d);
    assertNoOverseasCascade(cap, 'B general');
    expect(packKeys(cap)).toEqual(['offer_contract']);
    for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
    expect(cap.tasks.filter((x) => x.source_trigger === 'au_placement_review')).toEqual([]);
    assertBannedWordFree(cap, 'B general');
  });

  it('au_restricted, general registration but the right to work is tied to a sponsor: only the position description fires', async () => {
    const d = doctor('au_restricted'); // fixture: general_and_specialist, sponsor-tied
    await rig.place(d, 'ats_placement');
    const cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description']);
    expect(cap.documents.filter((x) => x.document_key === 'section_g')).toEqual([]);
  });

  it('au_restricted with nothing on file about registration: fails closed. No supervision paperwork either way; a staff decision task; resolved when the register check is recorded', async () => {
    const d = doctor('au_restricted', { credentials: { ahpra_registration_type: null, supervision_level: null, work_rights: null, visa_sponsor_tied: null } });
    await rig.place(d, 'ats_placement');
    let cap = rig.capture(d);
    assertNoOverseasCascade(cap, 'B unknown');
    expect(packKeys(cap)).toEqual(['offer_contract']);
    const review = cap.tasks.filter((x) => x.source_trigger === 'au_placement_review');
    expect(review.length).toBe(1);
    expect(review[0]).toMatchObject({ task_type: 'segment_review', priority: 'high', status: 'open' });
    expect(review[0].description).toMatch(/no Ahpra registration type is on file/);
    expect(review[0].description).toMatch(/Nothing has been requested from the practice/);
    for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
    // the practice is told only that we may be in touch
    expect(cap.emailsToPractice.find((e) => /^Placement confirmed/.test(e.subject)).text).toContain('Anything else: our team will be in touch if anything further is needed from your practice.');

    // staff record what the register shows: limited registration under supervision
    const row = rig.table('gp_credentials').find((c) => c.user_id === d.userId);
    Object.assign(row, { ahpra_registration_type: 'limited', supervision_level: 'level_1', work_rights: 'pr' });
    await t.auRunPlacementHooks(d.userId, { source: 'test', force: true });
    cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(cap.tasks.find((x) => x.source_trigger === 'au_placement_review').status).toBe('completed');
    // and nothing was sent twice
    expect(cap.emailsToDoctor.length).toBe(1);
    expect(cap.emailsToPractice.filter((e) => /^Placement confirmed/.test(e.subject)).length).toBe(1);
  });

  for (const kind of ['au_non_vr', 'au_registrar']) {
    it(kind + ' (segment C): no supervision tasks, no Section G, no AHPRA message; pre-start tasks; the position description is a staff decision', async () => {
      const d = doctor(kind);
      await rig.place(d, 'ats_placement');
      const cap = rig.capture(d);
      assertNoOverseasCascade(cap, kind);
      expect(packKeys(cap)).toEqual(['offer_contract']);
      expect(cap.caseStage).toBe('prestart');
      for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
      const review = cap.tasks.filter((x) => x.source_trigger === 'au_placement_review');
      expect(review.length).toBe(1);
      expect(review[0].title).toMatch(/segment C/);
      expect(subjects(cap.emailsToDoctor)).toEqual([N11_SUBJECT]);
      expect(cap.emailsToPractice.filter((e) => /^Placement confirmed/.test(e.subject)).length).toBe(1);
      assertBannedWordFree(cap, kind);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an unreadable pathway at placement time holds', () => {
  // Fail only the pathway read (the request that selects candidate_pathway).
  const failPathwayRead = () => rig.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'GET' && (r.select || []).indexOf('candidate_pathway') !== -1 ? 'pathway read forced to fail' : ''));

  it('an OVERSEAS doctor: the placement is saved and the neutral steps run; the pack and every message wait; staff are asked to confirm the pathway; it all runs once the pathway reads', async () => {
    const d = buildAuDoctor('overseas_null', {
      idSuffix: String(8900 + (seq += 1)), profile: { phone: '+447700911' + String(100 + seq) }, caseRow: { stage: 'career' },
      state: { gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true } }, gp_amc_progress: { completed: { qualifications_verified: true } }, gp_career_state: { career_secured: false, applications: [] } }
    });
    rig.addDoctor(d);
    failPathwayRead();
    const res = await rig.place(d, 'ats_placement');
    expect(res.status).toBe(200);
    let cap = rig.capture(d);
    // the placement itself is saved
    expect(cap.application).toEqual({ status: 'placement_secured', ats_stage: 'hired' });
    expect(cap.placements.length).toBe(1);
    // neutral: the contract task. Held: the rest of the pack, Section G, every doctor / practice message
    expect(packKeys(cap)).toEqual(['offer_contract']);
    expect(cap.documents).toEqual([]);
    expect(cap.emailsToDoctor).toEqual([]);
    expect(cap.emailsToPractice).toEqual([]);
    expect(cap.whatsapps).toEqual([]);
    expect(cap.bell).toEqual([]);
    // never the Australian branch either
    expect(cap.tasks.filter((x) => PRESTART_FIRST.indexOf(x.task_type) !== -1)).toEqual([]);
    expect(cap.assignedRso).toBe(null);
    // the staff task and the hold
    const hold = cap.tasks.filter((x) => x.source_trigger === 'au_placement_pathway_hold');
    expect(hold.length).toBe(1);
    expect(hold[0]).toMatchObject({ task_type: 'manual', priority: 'high' });
    expect(hold[0].title).toMatch(/^Confirm pathway before pre-start \/ registration pack/);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toMatchObject({ application_id: rig.appIdFor(d), notices_pending: true, placement_confirmed: true });
    // staff (the offer sender) were still told
    expect(cap.emailsOther.length).toBe(1);

    // a second attempt while still unreadable: still held, nothing new
    await rig.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });
    await rig.settle(300);
    cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract']);
    expect(cap.emailsToDoctor).toEqual([]);

    // the pathway reads again: the next state sync releases the hold
    rig.emu.forbid(null);
    await rig.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });
    await rig.settle(500);
    cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(cap.documents.map((x) => x.document_key)).toContain('section_g');
    expect(subjects(cap.emailsToDoctor).sort()).toEqual(['AHPRA Registration Unlocked, GP Link', 'Documents Needed, GP Link',
      'Section G (Supervised Practice Goals) added to your documents, GP Link', 'Your placement is secured 🎉, GP Link'].sort());
    expect(subjects(cap.emailsToPractice)).toEqual(['Placement confirmed, ' + d.name]);
    expect(cap.whatsapps.length).toBe(1);
    expect(cap.emailsOther.length).toBe(1); // staff were not told a second time
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
    expect(cap.tasks.filter((x) => PRESTART_FIRST.indexOf(x.task_type) !== -1)).toEqual([]);

    // and it does not run a second time
    rig.resetRecorders();
    await rig.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });
    await rig.post('/api/admin/ops/replay-career-secured', { user_id: d.userId }, rig.superAdmin());
    await rig.settle(300);
    const after = rig.capture(d);
    expect(after.emailsToDoctor).toEqual([]);
    expect(after.emailsToPractice).toEqual([]);
    expect(after.tasks.length).toBe(cap.tasks.length);
  });

  it('an AUSTRALIAN doctor: never the overseas pack while unreadable; the Australian work runs once the pathway reads (here: the daily pass)', async () => {
    const d = doctor('au_vr');
    failPathwayRead();
    await rig.place(d, 'finalize_signed');
    let cap = rig.capture(d);
    assertNoOverseasCascade(cap, 'AU held');
    expect(cap.emailsToDoctor).toEqual([]);
    expect(cap.emailsToPractice.filter((e) => /^Placement confirmed/.test(e.subject))).toEqual([]);
    expect(cap.tasks.filter((x) => PRESTART_FIRST.indexOf(x.task_type) !== -1)).toEqual([]);
    expect(cap.tasks.filter((x) => x.source_trigger === 'au_placement_pathway_hold').length).toBe(1);
    expect(cap.caseStage).toBe('placement');

    rig.emu.forbid(null);
    const sweep = await t.runAuPrestartSweep({});
    expect(sweep.released).toBeGreaterThanOrEqual(1);
    cap = rig.capture(d);
    assertNoOverseasCascade(cap, 'AU released');
    expect(cap.caseStage).toBe('prestart');
    for (const type of PRESTART_FIRST) expect(count(cap, type), type).toBe(1);
    expect(subjects(cap.emailsToDoctor)).toEqual([N11_SUBJECT]);
    expect(cap.emailsToPractice.filter((e) => /^Placement confirmed/.test(e.subject)).length).toBe(1);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
  });

  it('the migration not being applied is NOT "unknown": everyone is an overseas doctor and the cascade runs', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: String(8900 + (seq += 1)), caseRow: { stage: 'career' }, state: { gp_career_state: { career_secured: false } } });
    rig.addDoctor(d);
    rig.emu.missingColumns = { user_profiles: ['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at', 'pathway_confirmed_at', 'pathway_confirmed_by'] };
    try {
      await rig.place(d, 'ats_placement');
    } finally { rig.emu.missingColumns = {}; }
    const cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(cap.tasks.filter((x) => x.source_trigger === 'au_placement_pathway_hold')).toEqual([]);
    expect(subjects(cap.emailsToPractice)).toEqual(['Placement confirmed, ' + d.name]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('pre-start task completion conditions', () => {
  const taskOf = (d, type) => rig.capture(d).tasks.find((x) => x.task_type === type);
  const fileIndemnity = (d, status) => rig.table('user_documents').push({
    id: 'doc-ind-' + d.userId.slice(-6), user_id: d.userId, document_key: 'au_indemnity_certificate', country_code: 'au_reg',
    status, file_name: 'indemnity.pdf', storage_path: 'users/x/prepared-documents/au_reg/au_indemnity_certificate/current', updated_at: new Date().toISOString()
  });

  it('indemnity: an uploaded certificate does not close the task; an approved one does', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    fileIndemnity(d, 'uploaded');
    await t.auOnAuDocumentApproved(d.userId, 'au_indemnity_certificate');
    expect(taskOf(d, 'indemnity_certificate').status).toBe('open');
    rig.table('user_documents').find((x) => x.user_id === d.userId && x.document_key === 'au_indemnity_certificate').status = 'approved';
    const sync = await t.auOnAuDocumentApproved(d.userId, 'au_indemnity_certificate');
    expect(sync.completed).toEqual(['indemnity_certificate']);
    expect(taskOf(d, 'indemnity_certificate')).toMatchObject({ status: 'completed' });
    expect(rig.capture(d).timeline.map((x) => x.title)).toContain('Indemnity certificate approved: task closed');
    // an unrelated document does nothing
    expect(await t.auOnAuDocumentApproved(d.userId, 'au_wwcc')).toBe(null);
  });

  it('indemnity through the real review flow: staff approve the uploaded certificate and the task closes', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    fileIndemnity(d, 'uploaded');
    const review = { id: 'task-review-' + d.userId.slice(-6), case_id: d.caseId, task_type: 'doc_review', status: 'open', title: 'Review: indemnity', related_stage: 'prestart', related_document_key: 'au_indemnity_certificate' };
    rig.table('registration_tasks').push(review);
    const res = await rig.post('/api/admin/va/task/review-flagged-doc', { task_id: review.id, decision: 'approve' }, rig.superAdmin());
    expect(res.status).toBe(200);
    expect(taskOf(d, 'indemnity_certificate').status).toBe('completed');
  });

  it('indemnity already approved before the placement: the task is created and closed in the same pass', async () => {
    const d = doctor('au_vr');
    fileIndemnity(d, 'approved');
    await rig.place(d, 'ats_placement');
    expect(taskOf(d, 'indemnity_certificate').status).toBe('completed');
  });

  // WP-12 (ADM-21) changed where the number lives: its home is now the
  // doctor's medicare_provider row in pbs_applications, with the location in
  // the au_location_* columns. The task keeps a copy and says where the home
  // copy went. (Before WP-12 this test pinned `stored_in: 'task_metadata'`
  // and "nothing written to the PBS structure".)
  it('provider number: recording it closes the task and stores the number with its location in pbs_applications (ADM-21)', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    const bad = await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: 'hello' }, rig.superAdmin());
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_provider_number');
    expect(taskOf(d, 'provider_number_new_location').status).toBe('open');

    const ok = await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: '123456 ab' }, rig.superAdmin());
    expect(ok.status).toBe(200);
    const task = taskOf(d, 'provider_number_new_location');
    expect(task.status).toBe('completed');
    expect(metaOf(task)).toMatchObject({ provider_number: '123456AB', location_name: PRACTICE_NAME, stored_in: 'pbs_applications', recorded_by: 'super.test@gplink-test.local' });
    expect(ok.json.tasks.find((x) => x.task_type === 'provider_number_new_location')).toMatchObject({ status: 'completed', provider_number: '123456AB' });
    expect(rig.capture(d).timeline.map((x) => x.title)).toContain('Medicare provider number recorded for the new location');
    // the home copy: one row for this doctor, with the location, and nothing
    // else in the PBS structure (no documents, updates or timeline rows)
    const pbsRows = (rig.emu.db.pbs_applications || []).filter((r) => r.user_id === d.userId);
    expect(pbsRows).toHaveLength(1);
    expect(pbsRows[0]).toMatchObject({
      application_type: 'medicare_provider', provider_number: '123456AB', status: 'complete',
      au_location_name: PRACTICE_NAME, au_location_recorded_by: 'super.test@gplink-test.local'
    });
    expect(pbsRows[0].au_location_placement_key).toBe(String(metaOf(task).placement_key));
    expect(ok.json.provider_number).toMatchObject({ number: '123456AB', location_name: PRACTICE_NAME, stored_in: 'pbs_applications' });
    expect(rig.emu.requests.filter((r) => /^pbs_/.test(r.table) && r.table !== 'pbs_applications' && r.method !== 'GET')).toEqual([]);
  });

  it('start date: saving the confirmed date closes the task, updates the placement and re-anchors the other due dates', async () => {
    const d = doctor('au_vr', { extra: { offer: { start_date: null } } });
    // no start date anywhere: the staff form refuses, so use the signed-contract path (the doctor cannot be asked for one)
    await rig.place(d, 'finalize_signed');
    const before = rig.capture(d);
    const startTask = before.tasks.find((x) => x.task_type === 'start_date_tracking');
    expect(startTask.priority).toBe('high');
    expect(metaOf(before.tasks.find((x) => x.task_type === 'indemnity_certificate')).due_anchor).toBe('placement');
    expect(text(before.emailsToDoctor[0].html)).not.toMatch(/expected start date/);
    expect(before.emailsToPractice.find((e) => /^Placement confirmed/.test(e.subject)).text).toMatch(/agree the start date with you/);

    const bad = await rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: 'soon' }, rig.consultant());
    expect(bad.status).toBe(400);
    const ok = await rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: '2027-03-01', notice_period_weeks: 4 }, rig.consultant());
    expect(ok.status).toBe(200);
    expect(ok.json.reanchored.sort()).toEqual(['indemnity_certificate', 'provider_number_new_location']);
    const after = rig.capture(d);
    expect(after.tasks.find((x) => x.task_type === 'start_date_tracking')).toMatchObject({ status: 'completed' });
    expect(metaOf(after.tasks.find((x) => x.task_type === 'start_date_tracking'))).toMatchObject({ confirmed_start_date: '2027-03-01', notice_period_weeks: 4, confirmed_by: 'consultant.test@gplink-test.local' });
    expect(after.placements[0].start_date).toBe('2027-03-01');
    expect(after.tasks.find((x) => x.task_type === 'indemnity_certificate').due_date).toBe('2027-02-15');
    expect(after.tasks.find((x) => x.task_type === 'provider_number_new_location').due_date).toBe('2027-02-08');
  });

  it('credentialing pack: appears only once the Ahpra register check and the indemnity certificate are both done; then auPrestartComplete', async () => {
    const d = doctor('au_vr'); // staff have NOT verified this doctor on the register yet
    await rig.place(d, 'ats_placement');
    expect(count(rig.capture(d), 'credentialing_pack')).toBe(0);
    expect(await t.auPrestartComplete(d.caseId)).toMatchObject({ ok: true, complete: false, missing: ['credentialing_pack'] });

    // indemnity done, register check not: still waiting
    fileIndemnity(d, 'approved');
    let sync = await t.auSyncPrestartTasks(d.userId);
    expect(sync.completed).toEqual(['indemnity_certificate']);
    expect(sync.credentialing_waiting_on).toEqual(['ahpra_register_check']);
    expect(count(rig.capture(d), 'credentialing_pack')).toBe(0);

    // the register check is saved as verified
    rig.table('gp_credentials').find((c) => c.user_id === d.userId).staff_verified_at = new Date().toISOString();
    sync = await t.auSyncPrestartTasks(d.userId);
    expect(sync.created).toEqual(['credentialing_pack']);
    const pack = rig.capture(d).tasks.find((x) => x.task_type === 'credentialing_pack');
    expect(pack).toMatchObject({ status: 'open', related_stage: 'prestart' });
    expect(metaOf(pack)).toMatchObject({ owner: 'rso', checklist_row: 9, placement_key: rig.appIdFor(d) });
    // again: not a second one
    await t.auSyncPrestartTasks(d.userId);
    expect(count(rig.capture(d), 'credentialing_pack')).toBe(1);

    // an open register-check task blocks the trigger even with the stamp present
    const d2 = doctor('au_vr', { credentials: { staff_verified_at: '2026-11-01T00:00:00.000Z' } });
    rig.table('registration_tasks').push({ id: 'task-check-' + d2.userId.slice(-6), case_id: d2.caseId, task_type: 'ahpra_register_check', status: 'open', title: 'Re-check' });
    fileIndemnity(d2, 'approved');
    await rig.place(d2, 'ats_placement');
    expect(count(rig.capture(d2), 'credentialing_pack')).toBe(0);

    // finish everything for the first doctor
    expect((await t.auPrestartComplete(d.caseId)).complete).toBe(false);
    await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: '1234567X' }, rig.rso());
    await rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: START_DATE }, rig.rso());
    expect(await t.auPrestartComplete(d.caseId)).toMatchObject({ ok: true, complete: false, open: ['credentialing_pack'] });
    const packTask = rig.capture(d).tasks.find((x) => x.task_type === 'credentialing_pack');
    const done = await rig.put('/api/admin/task?id=' + encodeURIComponent(packTask.id), { status: 'completed' }, rig.rso());
    expect(done.status).toBe(200);
    expect(await t.auPrestartComplete(d.caseId)).toMatchObject({ ok: true, complete: true, missing: [], open: [], placementKey: rig.appIdFor(d) });
    // nothing was sent for it here: N16 is WP-17's
    expect(subjects(rig.capture(d).emailsToDoctor)).toEqual([N11_SUBJECT]);
    const view = await rig.get('/api/admin/au/prestart?case_id=' + encodeURIComponent(d.caseId), rig.rso());
    expect(view.json).toMatchObject({ ok: true, prestart_complete: true, stage: 'prestart' });
  });

  it('auPrestartComplete: an overseas case, a case with no placement, the switch off', async () => {
    const os = buildAuDoctor('overseas_null', { idSuffix: String(8900 + (seq += 1)) });
    rig.addDoctor(os);
    expect(await t.auPrestartComplete(os.caseId)).toMatchObject({ ok: true, complete: false, reason: 'not_au_pathway' });
    const none = doctor('au_vr');
    expect(await t.auPrestartComplete(none.caseId)).toMatchObject({ ok: true, complete: false });
    rig.setSwitch(false);
    expect(await t.auPrestartComplete(none.caseId)).toEqual({ ok: false, complete: false, reason: 'feature_off' });
  });

  it('the pre-start staff routes: the assigned RSO, consultants and the CEO only; an overseas case is refused; switch off they do not exist', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    expect((await rig.get('/api/admin/au/prestart?case_id=' + d.caseId, rig.rso())).status).toBe(200);
    expect((await rig.get('/api/admin/au/prestart?case_id=' + d.caseId, rig.rso(rig.OTHER_RSO_EMAIL))).status).toBe(403);
    expect((await rig.get('/api/admin/au/prestart?case_id=' + d.caseId, rig.consultant())).status).toBe(200);
    expect((await rig.get('/api/admin/au/prestart?case_id=' + d.caseId, {})).status).toBe(401);
    const os = buildAuDoctor('overseas_null', { idSuffix: String(8900 + (seq += 1)) });
    rig.addDoctor(os);
    expect((await rig.post('/api/admin/au/prestart/provider-number', { case_id: os.caseId, provider_number: '123456AB' }, rig.superAdmin())).status).toBe(409);
    rig.setSwitch(false);
    expect((await rig.get('/api/admin/au/prestart?case_id=' + d.caseId, rig.superAdmin())).status).toBe(404);
    expect((await rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: START_DATE }, rig.superAdmin())).status).toBe(404);
    expect((await rig.get('/api/admin/au/task-types', rig.superAdmin())).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('N13 and N14', () => {
  it('N13 from staff: the doctor is asked for named items once; an unknown item is ignored; an overseas doctor is never sent one', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    rig.resetRecorders();
    const res = await rig.post('/api/admin/au/prestart/request-item', { case_id: d.caseId, items: ['provider_number', 'au_indemnity_certificate', 'sppa_00'] }, rig.rso());
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual(['provider_number', 'au_indemnity_certificate']);
    let cap = rig.capture(d);
    expect(subjects(cap.emailsToDoctor)).toEqual(['A few things we need before you start']);
    expect(text(cap.emailsToDoctor[0].html)).toContain('Your Medicare provider number for the new location');
    expect(text(cap.emailsToDoctor[0].html)).toContain('Indemnity certificate of currency');
    expect(cap.bell[0]).toMatchObject({ type: 'action', title: 'A few things needed before you start' });
    assertBannedWordFree(cap, 'N13');
    // the same request again today: not sent twice
    rig.resetRecorders();
    await rig.post('/api/admin/au/prestart/request-item', { case_id: d.caseId, items: ['au_indemnity_certificate', 'provider_number'] }, rig.rso());
    expect(rig.capture(d).emailsToDoctor).toEqual([]);
    expect((await rig.post('/api/admin/au/prestart/request-item', { case_id: d.caseId, items: ['nope'] }, rig.rso())).status).toBe(400);
    const os = buildAuDoctor('overseas_null', { idSuffix: String(8900 + (seq += 1)) });
    rig.addDoctor(os);
    expect(await t.auSendPrestartItemRequest(os.userId, { items: [{ label: 'x' }], requestKey: 'k' })).toBe(null);
  });

  it('N13 from the daily pass: required pre-start documents still missing are asked for once at 3 days and once at 7', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    const placedAt = Date.parse(rig.capture(d).placements[0].placed_at);
    rig.resetRecorders();
    // CHANGED in WP-16 (quiet hours, COM-22). This test ran the pass at
    // "placement + N days" whatever hour that was. N13 is an elapsed-time
    // reminder, so it is now only sent between 08:00 and 20:00 on the doctor's
    // own clock (this doctor's device zone is Melbourne). The runs that expect
    // an email are therefore moved to the next hour inside the hours, and the
    // deferral is pinned first.
    const auQuietHours = require('../lib/au-quiet-hours.js');
    const HOUR = 3600000;
    const inHours = (ms) => { let c = ms; while (!auQuietHours.everyAustralianZoneInsideHours(c)) c += HOUR; return c; };
    const atNight = (ms) => { let c = ms; while (auQuietHours.zoneInsideHours('Australia/Melbourne', c)) c += HOUR; return c; };
    await t.runAuPrestartSweep({ now: inHours(placedAt + 1 * 86400000) });
    expect(rig.capture(d).emailsToDoctor).toEqual([]);
    // Day 3, during the doctor's night: held. Nothing is sent and nothing is
    // claimed, however many times the pass runs.
    const night = atNight(placedAt + 3 * 86400000 + HOUR);
    for (let i = 0; i < 2; i++) {
      const held = await t.runAuPrestartSweep({ now: night });
      // (Other doctors in this file sit in other zones and may be awake: the
      // assertions are about THIS doctor's email, below.)
      expect(rig.capture(d).emailsToDoctor).toEqual([]);
      expect(held.deferred_quiet_hours).toBeGreaterThanOrEqual(1);   // this doctor (and any other still owed one)
    }
    expect(rig.capture(d).emailsToDoctor).toEqual([]);
    expect(rig.capture(d).timeline.filter((x) => /Pre-start documents requested from the doctor \(N13/.test(x.title))).toEqual([]);
    // The next run inside the hours sends it.
    const sentRun = await t.runAuPrestartSweep({ now: inHours(night) });
    expect(sentRun.reminded).toBeGreaterThanOrEqual(1);
    expect(sentRun.deferred_quiet_hours).toBeUndefined();
    let cap = rig.capture(d);
    expect(cap.emailsToDoctor.length).toBe(1);
    const body = text(cap.emailsToDoctor[0].html);
    expect(body).toContain('A quick reminder.');
    for (const label of ['Indemnity certificate of currency', 'Working with Children Check', 'Right to work']) expect(body).toContain(label);
    assertBannedWordFree(cap, 'N13 d3');
    await t.runAuPrestartSweep({ now: inHours(placedAt + 5 * 86400000) });
    expect(rig.capture(d).emailsToDoctor.length).toBe(1);
    await t.runAuPrestartSweep({ now: inHours(placedAt + 8 * 86400000) });
    await t.runAuPrestartSweep({ now: inHours(placedAt + 9 * 86400000) });
    cap = rig.capture(d);
    expect(cap.emailsToDoctor.length).toBe(2);
    expect(cap.timeline.filter((x) => /Pre-start documents requested from the doctor \(N13/.test(x.title)).length).toBe(2);
  });

  it('N14 from staff: the practice is asked in fixed wording; a banned note is refused; nothing goes twice in a day', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    rig.resetRecorders();
    const bad = await rig.post('/api/admin/au/prestart/practice-request', { case_id: d.caseId, items: ['credentialing_forms'], note: 'Please send the Supervisor CV and SPPA' }, rig.rso());
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('note_not_allowed');
    expect(rig.capture(d).emailsToPractice).toEqual([]);
    const ok = await rig.post('/api/admin/au/prestart/practice-request', { case_id: d.caseId, items: ['credentialing_forms', 'provider_number_location_details', 'made_up'], note: 'Thank you.' }, rig.rso());
    expect(ok.status).toBe(200);
    expect(ok.json.items).toEqual(['credentialing_forms', 'provider_number_location_details']);
    const cap = rig.capture(d);
    expect(cap.emailsToPractice.length).toBe(1);
    expect(cap.emailsToPractice[0].to).toEqual(expect.arrayContaining([PRACTICE_EMAIL]));
    expect(cap.emailsToPractice[0].subject).toBe(d.name + ': what we need from your practice before the start date');
    assertBannedWordFree({ emailsToDoctor: [], bell: [], emailsToPractice: cap.emailsToPractice }, 'N14');
    const again = await rig.post('/api/admin/au/prestart/practice-request', { case_id: d.caseId, items: ['provider_number_location_details', 'credentialing_forms'] }, rig.rso());
    expect(again.status).toBe(409);
    expect((await rig.post('/api/admin/au/prestart/practice-request', { case_id: d.caseId, items: [] }, rig.rso())).status).toBe(400);
    expect(rig.capture(d).emailsToPractice.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('switch off: an Australian doctor is an overseas doctor, exactly as on main', () => {
  it('a doctor whose stored pathway is au_vr gets the overseas cascade and none of the Australian work', async () => {
    rig.setSwitch(false);
    const d = doctor('au_vr', { caseRow: { stage: 'career' }, state: { gp_career_state: { career_secured: false } } });
    await rig.place(d, 'ats_placement');
    const cap = rig.capture(d);
    expect(packKeys(cap)).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(subjects(cap.emailsToPractice)).toEqual(['Placement confirmed, ' + d.name]);
    expect(cap.tasks.filter((x) => PRESTART_FIRST.indexOf(x.task_type) !== -1)).toEqual([]);
    expect(cap.assignedRso).toBe(null);
    expect(cap.nudges).toEqual([]);
    expect(await t.auRunPlacementHooks(d.userId, {})).toEqual({ ok: false, ran: false, reason: 'feature_off' });
    expect(await t.auSyncPrestartTasks(d.userId)).toMatchObject({ ok: false, reason: 'feature_off' });
    expect((await t.auPlacementHooksForUser(d.userId)).hooks.column).toBe('overseas');
    expect(await t.runAuPrestartSweep({})).toMatchObject({ ok: false, cases: 0 });
  });
});
