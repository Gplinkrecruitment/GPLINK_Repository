// WP-11 (Australian GP build): what staff can and cannot do around a placement.
//
//   D8      every overseas practice action is refused server-side for a case
//           whose placement hooks say it does not apply (segment B with
//           supervised registration keeps what the matrix allows)
//   ADM-11  a card cannot be moved to Hired for a doctor on an Australian
//           pathway; a placement cannot be saved without a start date
//   ADM-10  the Australian task types in manual task creation
//   rows 2-4 the before-placement tasks at ATS stage changes
//   bell    N11 / N13 bell items survive the doctor's open browser
//   switch off: none of it exists, and nothing new is asked of the database
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, START_DATE, ROLE_ID, PRACTICE_ID } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor, wp11NewNameViolation, wp06NewNameViolation, wp03NewStageViolation, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES } = require('./helpers/au-fixtures.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const messages = require('../lib/au-placement-messages.js');

let rig;
let t;
let seq = 0;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const tasksOf = (d) => rig.capture(d).tasks;

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(9000 + seq) }, o, {
    profile: Object.assign({ phone: '+614008' + String(10000 + seq) }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
function addTask(d, fields) {
  seq += 1;
  const row = Object.assign({ id: 'task-' + seq + '-' + d.userId.slice(-6), case_id: d.caseId, status: 'open', title: 'Test task', related_stage: 'prestart' }, fields);
  rig.table('registration_tasks').push(row);
  return row;
}
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 fake').toString('base64');

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp11-staff',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
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
describe('D8: overseas practice actions on an Australian case are refused by the server', () => {
  // Every endpoint behind a practice-facing overseas button, called for one
  // case. `make` builds the request from the doctor and the tasks on file.
  function actions(d, tasks) {
    const su = rig.superAdmin();
    return [
      ['Email the practice requesting the Supervisor CV (from the doctor\'s own document review task)',
        () => rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Supervisor CV request for ' + d.name, bodyText: 'Could you please send us the Supervisor CV?', taskId: tasks.review.id }, su)],
      ['Email the practice from a supervisor CV pack task',
        () => rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Document request', bodyText: 'Please send the document.', taskId: tasks.supervisorCv.id }, su)],
      ['An email on the case that asks for the SPPA-00',
        () => rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Paperwork', bodyHtml: '<p>Please sign the attached <b>SPPA-00</b>.</p>', caseId: d.caseId }, su)],
      ['SPPA-00: send to the candidate', () => rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-send-to-candidate', {}, su)],
      ['SPPA-00: send to the practice', () => rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-send-to-practice', {}, su)],
      ['SPPA-00: request corrections from the practice (the chase)', () => rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-request-corrections', {}, su)],
      ['SPPA-00: submit', () => rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-submit', {}, su)],
      ['Alternate supervisor CV: submit', () => rig.post('/api/admin/va/task/' + tasks.altCv.id + '/alt-cv-submit', {}, su)],
      ['Section G: re-deliver', () => rig.post('/api/admin/redeliver-section-g', { case_id: d.caseId }, su)],
      ['Position description: generate', () => rig.post('/api/admin/va/task/generate-position-description', { task_id: tasks.positionDescription.id }, su)],
      ['File a supervisor CV as a practice-pack document', () => rig.post('/api/admin/practice-doc/upload', { case_id: d.caseId, document_key: 'supervisor_cv', file_data: PDF, file_name: 'cv.pdf' }, su)],
      ['Raise a practice-pack task by hand (SPPA-00)', () => rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'SPPA-00', task_type: 'practice_pack_child', related_document_key: 'sppa_00' }, su)]
    ];
  }
  // The actions the matrix refuses for EVERY Australian segment.
  function ahpraActions(d, tasks) {
    const su = rig.superAdmin();
    return [
      ['Log AHPRA letter', () => rig.post('/api/admin/ahpra/ingest-manual', { gp_email: d.email, body: 'Notice to provide further information' }, su)],
      ['Registration granted', () => rig.post('/api/admin/ahpra/registration-granted', { caseId: d.caseId }, su)],
      ['AHPRA item: ask the practice', () => rig.post('/api/admin/ahpra/item/practice-request', { task_id: tasks.ahpraItem.id, to: 'manager@metro-practice.gplink-test.local', subject: 'Request', bodyHtml: '<p>Please provide.</p>' }, su)],
      ['AHPRA item: reply to the officer', () => rig.post('/api/admin/ahpra/item/officer-reply', { task_id: tasks.ahpraItem.id, to: 'officer@example.invalid', bodyHtml: '<p>Attached.</p>' }, su)],
      ['AHPRA bundle: release', () => rig.post('/api/admin/ahpra/release', { bundle_id: 'b1', case_id: d.caseId }, su)],
      ['AHPRA letter: deliver to the doctor', () => rig.post('/api/admin/va/task/' + tasks.ahpraItem.id + '/ahpra-deliver-to-gp', {}, su)]
    ];
  }
  function seedTasks(d) {
    return {
      review: addTask(d, { task_type: 'doc_review', related_document_key: 'au_indemnity_certificate', title: 'Review: indemnity' }),
      supervisorCv: addTask(d, { task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', title: 'Supervisor CV', related_stage: 'career' }),
      sppa: addTask(d, { task_type: 'practice_pack_child', related_document_key: 'sppa_00', title: 'SPPA-00', status: 'deferred', related_stage: 'career' }),
      positionDescription: addTask(d, { task_type: 'practice_pack_child', related_document_key: 'position_description', title: 'Position Description', related_stage: 'career' }),
      altCv: addTask(d, { task_type: 'alt_supervisor_cv_request', related_document_key: 'sppa_00', title: 'Alternate supervisor CV' }),
      ahpraItem: addTask(d, { task_type: 'ahpra_action_item', title: 'AHPRA item', metadata: { s80: true } })
    };
  }

  it('segment A: every one of them answers 409 with a plain message, sends nothing and writes an audit row', async () => {
    const d = doctor('au_vr');
    const tasks = seedTasks(d);
    const before = rig.table('registration_tasks').length;
    const auditBefore = rig.table('admin_audit_log').length;
    const all = actions(d, tasks).concat(ahpraActions(d, tasks));
    for (const [label, call] of all) {
      const res = await call();
      expect(res.status, label).toBe(409);
      expect(res.json.code, label).toBe('au_pathway');
      expect(res.json.message, label).toMatch(/Australian pathway/);
      expect(res.json.message, label).not.toMatch(/undefined|\[object/);
    }
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
    expect(rig.table('registration_tasks').length).toBe(before);
    expect(rig.table('user_documents').filter((x) => x.user_id === d.userId)).toEqual([]);
    const audits = rig.table('admin_audit_log').slice(auditBefore).filter((a) => a.action === 'admin_overseas_action_refused_au_pathway');
    expect(audits.length).toBe(all.length);
  });

  it('the contract is not an overseas action: an email from the contract task, filing the contract and raising its task are not refused', async () => {
    const d = doctor('au_vr');
    const contract = addTask(d, { task_type: 'practice_pack_child', related_document_key: 'offer_contract', title: 'Offer / Contract' });
    const su = rig.superAdmin();
    for (const call of [
      () => rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Contract for ' + d.name, bodyText: 'Could you send the signed contract?', taskId: contract.id }, su),
      () => rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Start date', bodyText: 'Confirming the start date.', caseId: d.caseId }, su)
    ]) {
      const res = await call();
      expect(res.status).not.toBe(409);
    }
    const d2 = doctor('au_vr');
    const made = await rig.post('/api/admin/tasks', { case_id: d2.caseId, title: 'Offer / Contract', task_type: 'practice_pack_child', related_document_key: 'offer_contract' }, su);
    expect(made.status).toBe(201);
  });

  it('segment B with supervised registration keeps what the matrix allows (and is still refused the AHPRA-letter actions)', async () => {
    const d = doctor('au_restricted', { credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_2' } });
    const tasks = seedTasks(d);
    for (const [label, call] of actions(d, tasks)) {
      // (the first action is an email from the doctor's own document review
      // task that asks for a supervisor CV: allowed for this segment)
      const res = await call();
      expect(res.status, label).not.toBe(409);
    }
    for (const [label, call] of ahpraActions(d, tasks)) {
      const res = await call();
      expect(res.status, label).toBe(409);
      expect(res.json.code, label).toBe('au_pathway');
    }
  });

  it('segment B with nothing on file, and segment C: refused until a person decides', async () => {
    const b = doctor('au_restricted', { credentials: { ahpra_registration_type: null, supervision_level: null, work_rights: null, visa_sponsor_tied: null } });
    const tb = seedTasks(b);
    const res = await rig.post('/api/admin/va/task/' + tb.sppa.id + '/sppa-send-to-practice', {}, rig.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('needs_staff_decision');
    const c = doctor('au_non_vr');
    const tc = seedTasks(c);
    const pd = await rig.post('/api/admin/va/task/generate-position-description', { task_id: tc.positionDescription.id }, rig.superAdmin());
    expect(pd.status).toBe(409);
    expect(pd.json.code).toBe('needs_staff_decision');
    const cv = await rig.post('/api/admin/email/send', { to: 'x@metro-practice.gplink-test.local', subject: 'Request', bodyText: 'Please send the supervisor CV', caseId: c.caseId }, rig.superAdmin());
    expect(cv.status).toBe(409);
    expect(cv.json.code).toBe('au_pathway');
  });

  it('an overseas doctor: none of them is refused (nothing recorded, and a pathway staff recorded as overseas)', async () => {
    for (const kind of ['overseas_null', 'overseas_explicit']) {
      const d = buildAuDoctor(kind, { idSuffix: String(9500 + (seq += 1)) });
      rig.addDoctor(d);
      const tasks = seedTasks(d);
      for (const [label, call] of actions(d, tasks).concat(ahpraActions(d, tasks))) {
        const res = await call();
        expect(res.status, kind + ': ' + label).not.toBe(409);
      }
    }
  });

  it('pathway unreadable: refused with "try again", never sent', async () => {
    const d = doctor('au_vr');
    const tasks = seedTasks(d);
    rig.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'GET' && (r.select || []).indexOf('candidate_pathway') !== -1 ? 'forced' : ''));
    const res = await rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-send-to-practice', {}, rig.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('pathway_unreadable');
    expect(res.json.message).toMatch(/try again/i);
    expect(rig.emails).toEqual([]);
  });

  it('switch off: nothing is refused and the pathway is never read', async () => {
    const d = doctor('au_vr', { caseRow: { stage: 'career' } });
    const tasks = seedTasks(d);
    rig.setSwitch(false);
    rig.emu.reset();
    for (const [label, call] of actions(d, tasks).concat(ahpraActions(d, tasks))) {
      const res = await call();
      expect(res.status, label).not.toBe(409);
    }
    expect(rig.emu.requests.filter((r) => (r.select || []).indexOf('candidate_pathway') !== -1 || r.table === 'gp_credentials')).toEqual([]);
  });

  it('an unauthenticated caller learns nothing: 401 before any pathway is read', async () => {
    const d = doctor('au_vr');
    const tasks = seedTasks(d);
    const res = await rig.post('/api/admin/va/task/' + tasks.sppa.id + '/sppa-send-to-practice', {}, {});
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ADM-11: no "hired" Australian doctor without a placement', () => {
  const stageOf = (d) => rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d)).ats_stage;

  it('moving the card to Hired is refused for an Australian doctor, with what the dashboard needs to open the placement form', async () => {
    const d = doctor('au_vr');
    const res = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { stage: 'hired', redirect_others: true } }, rig.consultant()));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_placement_required', application_id: rig.appIdFor(d), case_id: d.caseId, offer_status: 'sent', placement_form: true });
    expect(res.json.message).toMatch(/Record the placement with a start date instead of moving the card to Hired/);
    // nothing moved, nobody was told, nothing was redirected
    expect(stageOf(d)).toBe('offer');
    expect(rig.table('ats_stage_events').filter((e) => e.application_id === rig.appIdFor(d) && e.to_stage === 'hired')).toEqual([]);
    expect(rig.emails).toEqual([]);
    expect(rig.capture(d).placements).toEqual([]);
    expect(rig.capture(d).caseStage).toBe('placement');
  });

  it('with no offer on the table the message says to send the offer first', async () => {
    const d = doctor('au_vr');
    const offers = rig.table('ats_offers');
    offers.splice(offers.findIndex((x) => x.application_id === rig.appIdFor(d)), 1);
    const res = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { stage: 'hired' } }, rig.consultant()));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'au_placement_required', placement_form: false, offer_status: 'not_started' });
    expect(res.json.message).toMatch(/Send the offer first/);
  });

  it('every other stage move still works for an Australian doctor; notes can be saved; a recorded placement can catch its card up', async () => {
    const d = doctor('au_vr');
    for (const stage of ['interview', 'offer']) {
      const res = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { stage } }, rig.consultant()));
      expect(res.status, stage).toBe(200);
    }
    expect((await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { notes: 'a note' } }, rig.consultant()))).status).toBe(200);
    // placed properly; then someone drags the card back and forward again
    await rig.place(d, 'ats_placement');
    rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d)).ats_stage = 'offer';
    const res = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { stage: 'hired' } }, rig.consultant()));
    expect(res.status).toBe(200);
  });

  it('an overseas doctor\'s card moves to Hired exactly as before, and so does everyone\'s with the switch off', async () => {
    const os = buildAuDoctor('overseas_null', { idSuffix: String(9500 + (seq += 1)) });
    rig.addDoctor(os);
    const res = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(os), Object.assign({ body: { stage: 'hired' } }, rig.consultant()));
    expect(res.status).toBe(200);
    expect(stageOf(os)).toBe('hired');
    rig.setSwitch(false);
    const au = doctor('au_vr', { caseRow: { stage: 'career' } });
    rig.emu.reset();
    const off = await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(au), Object.assign({ body: { stage: 'hired' } }, rig.consultant()));
    expect(off.status).toBe(200);
    expect(stageOf(au)).toBe('hired');
    expect(rig.emu.requests.filter((r) => (r.select || []).indexOf('candidate_pathway') !== -1)).toEqual([]);
  });

  it('the placement form: an Australian placement cannot be saved without a start date (staff form and the ops route); an overseas one still can', async () => {
    const d = doctor('au_vr', { extra: { offer: { start_date: null } } });
    const none = await rig.post('/api/ats/placement', { applicationId: rig.appIdFor(d) }, rig.consultant());
    expect(none.status).toBe(400);
    expect(none.json).toMatchObject({ ok: false, code: 'start_date_required' });
    expect(none.json.message).toMatch(/Enter the start date/);
    expect(rig.capture(d).placements).toEqual([]);
    expect(rig.capture(d).application.status).toBe('offer');
    const bad = await rig.post('/api/ats/placement', { applicationId: rig.appIdFor(d), commencementDate: 'next month' }, rig.consultant());
    expect(bad.status).toBe(400);
    const ok = await rig.post('/api/ats/placement', { applicationId: rig.appIdFor(d), commencementDate: START_DATE }, rig.consultant());
    expect(ok.status).toBe(200);
    expect(rig.capture(d).placements[0].start_date).toBe(START_DATE);

    const d2 = doctor('au_vr', { extra: { offer: { start_date: null } } });
    const ops = await rig.post('/api/admin/ops/record-placement', { application_id: rig.appIdFor(d2) }, rig.superAdmin());
    expect(ops.status).toBe(400);
    expect(ops.json.code).toBe('start_date_required');
    expect(rig.capture(d2).placements).toEqual([]);

    const os = buildAuDoctor('overseas_null', { idSuffix: String(9500 + (seq += 1)), caseRow: { stage: 'career' }, state: { gp_career_state: { career_secured: false } } });
    rig.addDoctor(os, { offer: { start_date: null } });
    expect((await rig.post('/api/ats/placement', { applicationId: rig.appIdFor(os) }, rig.consultant())).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ADM-10: the Australian task types in manual task creation', () => {
  it('the list the form shows: seven types, each with a label, an owner, a default due and a "what to do" line', async () => {
    for (const who of [rig.superAdmin(), rig.rso(), rig.consultant()]) {
      const res = await rig.get('/api/admin/au/task-types', who);
      expect(res.status).toBe(200);
      expect(res.json.task_types.map((x) => x.task_type)).toEqual(['dpa_19ab_check', 'reference_check', 'restraint_check', 'start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack']);
      expect(res.json.stages.map((s) => s.key)).toEqual(['placement', 'prestart', 'commenced', 'guarantee', 'complete']);
    }
    expect((await rig.get('/api/admin/au/task-types', {})).status).toBe(401);
  });

  it('creating one by hand: defaults for the due date, the description and the card line; tied to the placement; one per placement', async () => {
    const d = doctor('au_vr');
    const res = await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'Check the restraint clause', task_type: 'restraint_check' }, rig.superAdmin());
    expect(res.status).toBe(201);
    expect(res.json.task).toMatchObject({ task_type: 'restraint_check', title: 'Check the restraint clause', related_stage: 'placement', source_trigger: 'va_manual', priority: 'normal' });
    expect(res.json.task.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(metaOf(res.json.task)).toMatchObject({ au: true, created_by_hand: true, owner: 'consultant' });
    expect(metaOf(res.json.task).what_to_do).toMatch(/restraint clause/);
    // a due date the person chose is kept
    const dated = await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'References', task_type: 'reference_check', due_date: '2027-01-15', priority: 'high' }, rig.superAdmin());
    expect(dated.json.task).toMatchObject({ due_date: '2027-01-15', priority: 'high' });

    // a pre-start type: the placement already has one
    await rig.place(d, 'ats_placement');
    const dup = await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'Provider number', task_type: 'provider_number_new_location' }, rig.superAdmin());
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('task_exists');
    expect(tasksOf(d).filter((x) => x.task_type === 'provider_number_new_location').length).toBe(1);
  });

  it('an overseas doctor cannot be given one; an unknown case is 404', async () => {
    const os = buildAuDoctor('overseas_null', { idSuffix: String(9500 + (seq += 1)) });
    rig.addDoctor(os);
    const res = await rig.post('/api/admin/tasks', { case_id: os.caseId, title: 'x', task_type: 'credentialing_pack' }, rig.superAdmin());
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('not_au_pathway');
    expect(tasksOf(os)).toEqual([]);
    expect((await rig.post('/api/admin/tasks', { case_id: 'no-such-case', title: 'x', task_type: 'credentialing_pack' }, rig.superAdmin())).status).toBe(404);
    // today's types are untouched for everyone
    const manual = await rig.post('/api/admin/tasks', { case_id: os.caseId, title: 'An ordinary task' }, rig.superAdmin());
    expect(manual.status).toBe(201);
    expect(manual.json.task.task_type).toBe('manual');
  });

  it('a task finished by a fact cannot be ticked off: provider number, start date, indemnity', async () => {
    const d = doctor('au_vr', { extra: { offer: { start_date: null } } });
    await rig.place(d, 'finalize_signed');
    for (const type of ['provider_number_new_location', 'start_date_tracking', 'indemnity_certificate']) {
      const task = tasksOf(d).find((x) => x.task_type === type);
      const res = await rig.put('/api/admin/task?id=' + encodeURIComponent(task.id), { status: 'completed' }, rig.superAdmin());
      expect(res.status, type).toBe(409);
      expect(res.json.code, type).toBe('au_task_needs_its_action');
      expect(tasksOf(d).find((x) => x.task_type === type).status, type).toBe('open');
    }
    // other edits to those tasks still work
    const task = tasksOf(d).find((x) => x.task_type === 'provider_number_new_location');
    expect((await rig.put('/api/admin/task?id=' + encodeURIComponent(task.id), { priority: 'high' }, rig.superAdmin())).status).toBe(200);
  });

  // FR-1 (final review M-06): the restraint check completed with no outcome recorded.
  it('a restraint check cannot be ticked off without its outcome; with the outcome on the task it can', async () => {
    const d = doctor('au_vr');
    rig.table('registration_tasks').push({ id: 'fr1-restraint-' + d.userId.slice(-6), case_id: d.caseId, task_type: 'restraint_check', status: 'open', title: 'Restraint check (FAKE)', related_stage: 'placement', metadata: { au: true } });
    const task = () => tasksOf(d).find((x) => x.task_type === 'restraint_check');
    const res = await rig.put('/api/admin/task?id=' + encodeURIComponent(task().id), { status: 'completed' }, rig.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('au_task_needs_its_action');
    expect(res.json.message).toMatch(/recording what the restraint check found/);
    expect(task().status).toBe('open');
    // once the outcome is on the task (the "Mark done" form records it), a completion is accepted
    task().metadata = { au: true, restraint_outcome: 'no_restraint' };
    expect((await rig.put('/api/admin/task?id=' + encodeURIComponent(task().id), { status: 'completed' }, rig.superAdmin())).status).toBe(200);
  });

  it('switch off: the list does not exist, an Australian type is refused as the database refuses it today, and nothing is written', async () => {
    const d = doctor('au_vr', { caseRow: { stage: 'career' } });
    rig.setSwitch(false);
    expect((await rig.get('/api/admin/au/task-types', rig.superAdmin())).status).toBe(404);
    rig.emu.reset();
    const res = await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'x', task_type: 'restraint_check' }, rig.superAdmin());
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ ok: false, message: 'Failed to create task.' });
    expect(rig.emu.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    const manual = await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'An ordinary task', task_type: 'verify' }, rig.superAdmin());
    expect(manual.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('checklist rows 2 to 4: staff tasks raised at ATS stage changes', () => {
  const ofType = (d, type) => tasksOf(d).filter((x) => x.task_type === type);
  const move = (d, stage) => rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(d), Object.assign({ body: { stage } }, rig.consultant()));

  it('offer stage: the restraint check, once, for every Australian segment', async () => {
    for (const kind of ['au_vr', 'au_restricted', 'au_non_vr']) {
      const d = doctor(kind, { extra: { application: { ats_stage: 'interview', status: 'interview' } } });
      expect((await move(d, 'offer')).status).toBe(200);
      expect(ofType(d, 'restraint_check').length, kind).toBe(1);
      const task = ofType(d, 'restraint_check')[0];
      expect(task).toMatchObject({ related_stage: 'placement', source_trigger: 'au_ats_stage', status: 'open' });
      expect(task.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(metaOf(task)).toMatchObject({ au: true, owner: 'consultant', application_id: rig.appIdFor(d), trigger_stage: 'offer' });
      // back and forward again: still one
      await move(d, 'interview');
      await move(d, 'offer');
      expect(ofType(d, 'restraint_check').length, kind).toBe(1);
    }
  });

  it('submitted to practice: reference checks, once per doctor; filing the completed checks closes the task', async () => {
    const d = doctor('au_vr', { extra: { application: { ats_stage: 'applied', status: 'applied' } } });
    await move(d, 'submitted');
    expect(ofType(d, 'reference_check').length).toBe(1);
    expect(ofType(d, 'reference_check')[0].description).toMatch(/The doctor gives two referees on their pre-start page/); // WP-12 collects them
    // a second application submitted: still one task for the doctor
    const second = { id: 'app-second-' + d.userId.slice(-6), user_id: d.userId, career_role_id: ROLE_ID, practice_id: PRACTICE_ID, status: 'applied', ats_stage: 'applied' };
    rig.table('gp_applications').push(second);
    await t.auOnApplicationStage(d.userId, second, 'submitted');
    expect(ofType(d, 'reference_check').length).toBe(1);
    // staff file the completed checks in the References slot
    rig.table('user_documents').push({ id: 'doc-ref-' + d.userId.slice(-6), user_id: d.userId, document_key: 'au_references', country_code: 'au_reg', status: 'approved', file_name: 'references.pdf' });
    await t.auOnAuDocumentApproved(d.userId, 'au_references');
    expect(ofType(d, 'reference_check')[0].status).toBe('completed');
  });

  it('shortlisted or applied: the 19AB / DPA check for segments B and C only, once per application', async () => {
    for (const [kind, want] of [['au_restricted', 1], ['au_non_vr', 1], ['au_registrar', 1], ['au_vr', 0]]) {
      const d = doctor(kind, { extra: { application: { ats_stage: 'shortlisted', status: 'shortlisted' } } });
      const app = rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d));
      await t.auOnApplicationStage(d.userId, app, 'shortlisted');
      await t.auOnApplicationStage(d.userId, app, 'applied');
      expect(ofType(d, 'dpa_19ab_check').length, kind).toBe(want);
      if (want) {
        expect(ofType(d, 'dpa_19ab_check')[0].title, kind).toMatch(/19AB and DPA check: .*Test Metro Practice \(FAKE\) \(Parramatta, NSW\)/);
        // another role: another check
        await t.auOnApplicationStage(d.userId, { id: 'app-other-' + d.userId.slice(-6), user_id: d.userId, career_role_id: ROLE_ID }, 'applied');
        expect(ofType(d, 'dpa_19ab_check').length, kind).toBe(2);
      }
    }
  });

  it('an overseas doctor: no task at any stage. Switch off: nothing is even read', async () => {
    const os = buildAuDoctor('overseas_null', { idSuffix: String(9500 + (seq += 1)) });
    rig.addDoctor(os, { application: { ats_stage: 'applied', status: 'applied' } });
    for (const stage of ['submitted', 'interview', 'offer']) expect((await move(os, stage)).status, stage).toBe(200);
    expect(tasksOf(os)).toEqual([]);
    rig.setSwitch(false);
    const au = doctor('au_vr', { caseRow: { stage: 'career' }, extra: { application: { ats_stage: 'interview', status: 'interview' } } });
    rig.emu.reset();
    await move(au, 'offer');
    expect(tasksOf(au)).toEqual([]);
    expect(await t.auOnApplicationStage(au.userId, { id: 'x' }, 'offer')).toBe(null);
    expect(rig.emu.requests.filter((r) => (r.select || []).indexOf('candidate_pathway') !== -1)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bell items survive the doctor\'s open browser', () => {
  const bellOf = (d) => {
    let v = rig.stateOf(d).gp_link_updates;
    if (typeof v === 'string') v = JSON.parse(v);
    return Array.isArray(v) ? v : [];
  };
  // what js/updates-sync.js keeps of each entry when it writes the list back
  const asBrowser = (list) => JSON.stringify(list.map((e) => ({ type: e.type, title: e.title, detail: e.detail || '', ts: e.ts, target: e.target, category: e.category })));
  const sync = (d, state) => rig.put('/api/state', { state, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });

  it('N11: a page that was open before the placement saves its own (stale) bell list, and the item is still there', async () => {
    const d = doctor('au_vr', { state: { gp_link_updates: JSON.stringify([{ type: 'info', title: 'An older item', detail: '', ts: '2026-11-01T00:00:00.000Z' }]) } });
    const staleList = rig.stateOf(d).gp_link_updates;
    await rig.place(d, 'ats_placement');
    expect(bellOf(d).map((b) => b.title)).toEqual(['Your placement is secured', 'An older item']);
    expect(rig.stateOf(d)[messages.PENDING_BELL_KEY].length).toBe(1);

    // the open page syncs: its list has never heard of the new item
    expect((await sync(d, { gp_link_updates: staleList, gp_career_intro_seen: true })).status).toBe(200);
    expect(bellOf(d).map((b) => b.title)).toEqual(['Your placement is secured', 'An older item']);
    // and again, and with the list cleared, and with the key deleted
    await sync(d, { gp_link_updates: staleList });
    await sync(d, { gp_link_updates: '[]' });
    expect(bellOf(d).map((b) => b.title)).toEqual(['Your placement is secured']);
    await sync(d, { gp_link_updates: null });
    expect(bellOf(d).map((b) => b.title)).toEqual(['Your placement is secured']);
    // the entry has what the bell panel reads
    expect(bellOf(d)[0]).toMatchObject({ type: 'success', category: 'career', target: '/pages/prestart' }); // WP-12: the pre-start page
    expect(bellOf(d)[0].detail).toMatch(/pre-start checklist/);
  });

  it('once the browser has the item (it sends it back) the browser owns it: the doctor can clear it and it stays cleared', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    // the page loads the state...
    const got = await rig.get('/api/state', { cookie: rig.gpCookie(d.email, d.userId) });
    expect(got.status).toBe(200);
    const served = typeof got.json.state.gp_link_updates === 'string' ? JSON.parse(got.json.state.gp_link_updates) : got.json.state.gp_link_updates;
    expect(served.map((b) => b.title)).toEqual(['Your placement is secured']);
    // ...and is never shown the server's own bookkeeping
    expect(got.json.state[messages.PENDING_BELL_KEY]).toBeUndefined();
    expect(got.json.state[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
    // ...and syncs it back in the shape the browser keeps
    await sync(d, { gp_link_updates: asBrowser(served) });
    expect(rig.stateOf(d)[messages.PENDING_BELL_KEY]).toBeUndefined();
    expect(bellOf(d).length).toBe(1);
    // the doctor clears their notifications
    await sync(d, { gp_link_updates: '[]' });
    expect(bellOf(d)).toEqual([]);
  });

  it('a browser cannot write the pending list or the placement hold', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    const pending = JSON.stringify(rig.stateOf(d)[messages.PENDING_BELL_KEY]);
    const body = { gp_career_intro_seen: true };
    body[messages.PENDING_BELL_KEY] = [];
    body[t.AU_PLACEMENT_HOLD_KEY] = { at: 'now' };
    await sync(d, body);
    expect(JSON.stringify(rig.stateOf(d)[messages.PENDING_BELL_KEY])).toBe(pending);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
  });

  it('N13 is durable too, newest first', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    await rig.post('/api/admin/au/prestart/request-item', { case_id: d.caseId, items: ['notice_period'] }, rig.rso());
    await sync(d, { gp_link_updates: '[]' });
    expect(bellOf(d).map((b) => b.title)).toEqual(['Needed before you start', 'Your placement is secured']);
  });

  it('the GENERAL weakness is unchanged for an overseas doctor: a server-pushed item is overwritten by a stale browser list (reported to the lead, not changed here)', async () => {
    const os = buildAuDoctor('overseas_null', {
      idSuffix: String(9500 + (seq += 1)), caseRow: { stage: 'career' },
      state: { gp_career_state: { career_secured: false }, gp_link_updates: JSON.stringify([{ type: 'info', title: 'An older item', detail: '', ts: '2026-11-01T00:00:00.000Z' }]) }
    });
    rig.addDoctor(os);
    const staleList = rig.stateOf(os).gp_link_updates;
    await rig.place(os, 'ats_placement');
    expect(bellOf(os).map((b) => b.title)).toEqual(['Your placement is secured 🎉', 'An older item']);
    expect(rig.stateOf(os)[messages.PENDING_BELL_KEY]).toBeUndefined();
    await sync(os, { gp_link_updates: staleList });
    expect(bellOf(os).map((b) => b.title)).toEqual(['An older item']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('switch off: the whole placement path asks nothing new of the database', () => {
  it('place a doctor whose stored pathway is au_vr, sync their state, run the staff actions: no new name reaches the database', async () => {
    const rule = (r) => wp02NewNameViolation(r, { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES }) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp11NewNameViolation(r);
    // the rule can catch a leak
    expect(wp11NewNameViolation({ query: '', body: { state: { gp_au_bell_pending: [] } } })).toBe('mentions gp_au_bell_pending');
    expect(wp11NewNameViolation({ query: '', body: [{ nudge_key: 'au_n11_placement_secured:x' }] })).toBe('mentions au_n11_');
    expect(wp11NewNameViolation({ query: '?source_trigger=eq.au_placement_pathway_hold', body: null })).toBe('mentions au_placement');
    expect(wp11NewNameViolation({ query: '?select=id', body: [{ task_type: 'practice_pack_child', source_trigger: 'career_secured' }] })).toBe('');

    rig.setSwitch(false);
    const d = doctor('au_vr', { caseRow: { stage: 'career', pathway: null }, state: { gp_career_state: { career_secured: false } } });
    const viaSign = doctor('au_vr', { caseRow: { stage: 'career', pathway: null }, state: { gp_career_state: { career_secured: false } } });
    const kanban = doctor('au_vr', { caseRow: { stage: 'career', pathway: null }, extra: { application: { ats_stage: 'interview', status: 'interview' } } });
    rig.emu.reset();
    rig.emu.forbid(rule);

    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    expect((await rig.place(viaSign, 'finalize_signed')).status).toBe(200);
    await rig.put('/api/state', { state: { gp_link_updates: '[]', gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });
    await rig.post('/api/admin/ops/replay-career-secured', { user_id: d.userId }, rig.superAdmin());
    await rig.post('/api/admin/cases/sync', {}, rig.superAdmin());
    for (const stage of ['offer', 'hired']) {
      expect((await rig.request('PATCH', '/api/ats/application?id=' + rig.appIdFor(kanban), Object.assign({ body: { stage } }, rig.consultant()))).status, stage).toBe(200);
    }
    await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'x', task_type: 'restraint_check' }, rig.superAdmin());
    await rig.post('/api/admin/tasks', { case_id: d.caseId, title: 'SPPA-00 again', task_type: 'practice_pack_child', related_document_key: 'sppa_00' }, rig.superAdmin());
    await rig.post('/api/admin/redeliver-section-g', { case_id: d.caseId }, rig.superAdmin());
    await rig.post('/api/admin/email/send', { to: 'manager@metro-practice.gplink-test.local', subject: 'Supervisor CV', bodyText: 'Please send the supervisor CV', caseId: d.caseId }, rig.superAdmin());
    for (const path of ['/api/admin/au/task-types', '/api/admin/au/prestart?case_id=' + d.caseId]) expect((await rig.get(path, rig.superAdmin())).status).toBe(404);
    expect((await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: '123456AB' }, rig.superAdmin())).status).toBe(404);
    // every WP-11 function refuses and asks nothing
    const before = rig.emu.requests.length;
    await t.auRunPlacementHooks(d.userId, { force: true });
    await t.auSyncPrestartTasks(d.userId);
    await t.auPrestartComplete(d.caseId);
    await t.auOnApplicationStage(d.userId, { id: rig.appIdFor(d) }, 'offer');
    await t.auOnAuDocumentApproved(d.userId, 'au_indemnity_certificate');
    await t.auSendPrestartItemRequest(d.userId, { items: [{ label: 'x' }], requestKey: 'k' });
    await t.auSendPracticeFormNeeded(d.userId, { itemKeys: ['credentialing_forms'], requestKey: 'k' });
    await t.auPushDurableBell(d.userId, 'k', { title: 'x' });
    await t.auRecordPlacementHold(d.userId, null, {});
    await t.auReleasePlacementHold(d.userId, { at: 'x' });
    await t.auOverseasPracticeActionRefusal({ caseId: d.caseId }, 'sppa');
    await t.auRecordProviderNumber(d.caseId, { providerNumber: '123456AB' }, 'x');
    await t.auConfirmStartDate(d.caseId, { startDate: START_DATE }, 'x');
    await t.runAuPrestartSweep({});
    expect((await t.auPlacementHooksForUser(d.userId)).hooks.column).toBe('overseas');
    expect(rig.emu.requests.length).toBe(before);

    await rig.settle(400);
    expect(rig.emu.violations).toEqual([]);
    // and the doctor got today's cascade
    const cap = rig.capture(d);
    expect(cap.tasks.filter((x) => x.task_type === 'practice_pack_child' && x.source_trigger === 'career_secured').map((x) => x.related_document_key).sort())
      .toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    // (the SPPA-00 task raised by hand above was accepted: nothing is refused with the switch off)
    expect(cap.tasks.filter((x) => x.source_trigger === 'va_manual' && x.related_document_key === 'sppa_00').length).toBe(1);
    expect(cap.emailsToPractice.map((e) => e.subject)).toContain('Placement confirmed, ' + d.name);
    expect(rig.stateOf(d)[messages.PENDING_BELL_KEY]).toBeUndefined();
  });
});
