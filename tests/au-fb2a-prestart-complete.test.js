// Australian GP build, fix bundle FB-2a, W3-D21: ONE definition of "pre-start
// complete".
//
// Staff saw "only credentialing unfinished" while the doctor's page showed
// three documents still "To do": the staff side counted the four pre-start
// tasks, the doctor's page counted every card. And N16 ("cleared to start")
// and "Confirm commenced" followed the staff side, so a doctor could be told
// they were cleared with required documents missing.
//
// Now everyone asks lib/au-prestart.js prestartCompletion: the four pre-start
// tasks of the placement AND every required pre-start document the doctor
// provides, approved. Optional documents never count.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const auPrestart = require('../lib/au-prestart.js');
const gpApp = require('../lib/au-gp-app.js');
const documentRequirements = require('../lib/document-requirements.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const lc = require('../lib/au-lifecycle.js');

const FOUR = ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack'];
const done = (types) => types.map((task_type) => ({ task_type, status: 'completed' }));

describe('prestartCompletion (pure): the one definition', () => {
  it('the four tasks and the required documents; nothing else', () => {
    const f = auPrestart.prestartCompletion;
    expect(f({ tasks: [], requiredDocumentKeys: ['a'], approvedDocumentKeys: [] })).toMatchObject({ complete: false, missing: FOUR, open: [], documentsOutstanding: ['a'], counts: { done: 0, total: 5 } });
    expect(f({ tasks: done(FOUR), requiredDocumentKeys: ['a', 'b'], approvedDocumentKeys: ['a'] })).toMatchObject({ complete: false, missing: [], open: [], documentsOutstanding: ['b'], counts: { done: 5, total: 6 } });
    expect(f({ tasks: done(FOUR), requiredDocumentKeys: ['a', 'b'], approvedDocumentKeys: ['b', 'a', 'zzz'] })).toMatchObject({ complete: true, documentsOutstanding: [], counts: { done: 6, total: 6 } });
    // An open task, and a task type with a cancelled duplicate, both keep it open.
    expect(f({ tasks: done(FOUR.slice(0, 3)).concat([{ task_type: 'credentialing_pack', status: 'open' }]), requiredDocumentKeys: [], approvedDocumentKeys: [] }))
      .toMatchObject({ complete: false, open: ['credentialing_pack'], counts: { done: 3, total: 4 } });
  });

  it('the indemnity certificate is counted once (its task stands for it); repeats and blanks are ignored', () => {
    const out = auPrestart.prestartCompletion({ tasks: done(FOUR), requiredDocumentKeys: ['au_indemnity_certificate', 'a', 'a', '', null], approvedDocumentKeys: ['a'] });
    expect(out.required.documents).toEqual(['a']);
    expect(out).toMatchObject({ complete: true, counts: { done: 5, total: 5 } });
  });

  it('the required documents are read from the one document list; an optional one is never among them', () => {
    const p = candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: 'au_vr', pathway_confirmed_at: '2026-01-01' }, credentials: null, flagEnabled: true });
    const set = documentRequirements.auDocumentRequirements(p);
    const keys = auPrestart.requiredPrestartDocumentKeys(set);
    expect(keys).toEqual(['au_ahpra_certificate', 'au_fellowship_certificate', 'au_right_to_work', 'au_wwcc']);
    const optional = set.items.filter((i) => i.phase === 'prestart' && i.provider === 'you' && i.required !== true).map((i) => i.key);
    expect(optional.length).toBeGreaterThan(0);
    optional.forEach((k) => expect(keys).not.toContain(k));
    // The same list out of the doctor-facing item shape.
    expect(auPrestart.requiredPrestartDocumentKeys(set.items)).toEqual(keys);
  });

  it('the doctor\'s checklist is counted by the same function: an optional document changes nothing', () => {
    const docs = (extra) => [
      { key: 'au_ahpra_certificate', label: 'Ahpra registration certificate', status: 'approved', required: true, phase: 'prestart', provider: 'you' },
      { key: 'au_wwcc', label: 'Working with Children Check', status: 'pending', required: true, phase: 'prestart', provider: 'you' }
    ].concat(extra || []);
    const base = { placement: { key: 'k', practiceName: 'Test Metro Practice (FAKE)' }, tasks: done(FOUR).map((t) => Object.assign({ metadata: {} }, t)), details: {}, providerNumber: { recorded: true }, registerChecked: true, registerCheckOpen: false };
    const a = gpApp.buildPrestartChecklist(Object.assign({ documents: docs() }, base));
    const b = gpApp.buildPrestartChecklist(Object.assign({ documents: docs([{ key: 'au_immunisation_record', label: 'Immunisation record', status: 'pending', required: false, phase: 'prestart', provider: 'you' }]) }, base));
    expect(a.counts).toEqual({ done: 5, total: 6 });
    expect(b.counts).toEqual(a.counts);
    expect(a.complete).toBe(false);
    expect(a.outstanding).toEqual({ tasks: [], documents: ['au_wwcc'] });
    const c = gpApp.buildPrestartChecklist(Object.assign({ documents: docs().map((d) => Object.assign({}, d, { status: 'approved' })) }, base));
    expect(c).toMatchObject({ complete: true, counts: { done: 6, total: 6 } });
    // Each card says whether it is part of the count.
    expect(c.items.filter((i) => !i.required).map((i) => i.key)).toEqual(['register_check', 'notice', 'referees']);
  });
});

describe('staff, doctor, "Confirm commenced" and N16 give one answer', () => {
  let rig; let t; let seq = 0;
  const today = () => lc.localDay(Date.now(), 'Australia/Sydney');
  const settle = async () => { let last = -1; for (let i = 0; i < 200; i++) { const seen = rig.emu.requests.length + rig.emails.length; if (seen === last) return; last = seen; await new Promise((r) => setTimeout(r, 80)); } };
  const staffView = (d) => rig.get('/api/admin/au/prestart?case_id=' + encodeURIComponent(d.caseId), rig.superAdmin());
  const doctorView = (d) => rig.get('/api/gp/au-prestart', { cookie: rig.gpCookie(d.email, d.userId) });
  const n16 = (d) => rig.capture(d).emailsToDoctor.filter((e) => /cleared to start/i.test(e.subject));

  beforeAll(async () => {
    rig = await bootPlacementRig({ name: 'fb2a-d21', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' }, emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } } } });
    t = rig.testUtils;
  }, 60000);
  afterAll(async () => { if (rig) await rig.close(); });
  beforeEach(() => { rig.setSwitch(true); rig.resetRecorders(); });

  // About 3 seconds alone: a placement, its tasks, and two attempts to commence.
  it('THE REPORTED CASE: every task done, three required documents still to come', { timeout: 60000 }, async () => {
    seq += 1;
    const d = buildAuDoctor('au_vr', { idSuffix: String(7600 + seq), profile: { phone: '+614010' + String(10000 + seq) }, credentials: { staff_verified_at: '2026-11-01T00:00:00.000Z' } });
    rig.addDoctor(d);
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    // The four tasks are finished the real way (the indemnity certificate
    // approved, the provider number and the start date recorded, the
    // credentialing pack sent); of the other required documents only the Ahpra
    // certificate is approved.
    rig.table('user_documents').push({ id: 'doc-ind-' + d.userId.slice(-6), user_id: d.userId, document_key: 'au_indemnity_certificate', country_code: 'au_reg',
      status: 'approved', file_name: 'indemnity.pdf', storage_path: 'users/x/prepared-documents/au_reg/au_indemnity_certificate/current', updated_at: new Date().toISOString() });
    await t.auOnAuDocumentApproved(d.userId, 'au_indemnity_certificate');
    expect((await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: '1234567X' }, rig.rso())).status).toBe(200);
    expect((await rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: '2027-02-01' }, rig.rso())).status).toBe(200);
    const pack = rig.capture(d).tasks.find((x) => x.task_type === 'credentialing_pack');
    expect(pack, 'the credentialing pack task was raised').toBeTruthy();
    expect((await rig.put('/api/admin/task?id=' + encodeURIComponent(pack.id), { status: 'completed' }, rig.rso())).status).toBe(200);
    rig.approvePrestartDocuments(d, { keys: ['au_ahpra_certificate'] });
    await settle();
    rig.resetRecorders();

    const staff = await staffView(d);
    const doc = await doctorView(d);
    // One answer, one count.
    expect(staff.json.prestart_complete).toBe(false);
    expect(doc.json.complete).toBe(false);
    expect(staff.json.documents_outstanding).toEqual(['au_fellowship_certificate', 'au_right_to_work', 'au_wwcc']);
    expect(staff.json.prestart_counts).toEqual({ done: 5, total: 8 });
    expect(doc.json.counts).toEqual(staff.json.prestart_counts);
    expect(doc.json.items.filter((i) => i.required && i.status !== 'done').map((i) => i.key)).toEqual(['doc_au_fellowship_certificate', 'doc_au_right_to_work', 'doc_au_wwcc']);
    // The doctor is not told they are cleared to start.
    expect(await t.__wp17.auMaybeSendClearedToStart(d.userId, { quietNowMs: new Date().setUTCHours(2, 0, 0, 0) })).toBeNull();
    await rig.testUtils.__wp17.runAuMessagePass(new Date().setUTCHours(2, 0, 0, 0));
    await settle();
    expect(n16(d)).toEqual([]);
    // "Confirm commenced" is refused without a reason, and names the documents.
    const refused = await rig.post('/api/admin/au/commencement/confirm', { case_id: d.caseId, commenced_at: today(), sessions_per_week: 8 }, rig.superAdmin());
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'prestart_incomplete', prestart_missing: [], prestart_open: [], prestart_documents_outstanding: ['au_fellowship_certificate', 'au_right_to_work', 'au_wwcc'] });
    const card = await rig.get('/api/admin/au/commencement?case_id=' + encodeURIComponent(d.caseId), rig.superAdmin());
    expect(card.json.prestart.complete).toBe(false);
    expect(card.json.prestart.open.join(' | ')).toMatch(/Document not yet approved: .*Working with Children/i);

    // The documents arrive and are approved: everyone agrees it is complete.
    rig.approvePrestartDocuments(d);
    const staff2 = await staffView(d);
    const doc2 = await doctorView(d);
    expect(staff2.json).toMatchObject({ prestart_complete: true, documents_outstanding: [], prestart_counts: { done: 8, total: 8 } });
    expect(doc2.json).toMatchObject({ complete: true, counts: { done: 8, total: 8 } });
    await rig.testUtils.__wp17.runAuMessagePass(new Date().setUTCHours(2, 0, 0, 0));
    await settle();
    expect(n16(d)).toHaveLength(1);
    const ok = await rig.post('/api/admin/au/commencement/confirm', { case_id: d.caseId, commenced_at: today(), sessions_per_week: 8 }, rig.superAdmin());
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it('every caller goes through the one function (source pin)', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(server).toMatch(/out\.prestart = Object\.assign\(\{ placementKey: placement\.key \}, auPrestart\.prestartCompletion\(\{/);
    expect(server).not.toMatch(/auPrestart\.prestartCompleteFromTasks\(/);
    const app = fs.readFileSync(path.join(__dirname, '..', 'lib/au-gp-app.js'), 'utf8');
    expect(app).toMatch(/const completion = auPrestart\.prestartCompletion\(\{/);
    expect(app).toMatch(/complete: completion\.complete,\s*counts: completion\.counts,/);
    // N16's sender and "Confirm commenced" both ask auPrestartComplete, which is that function.
    expect(server).toMatch(/const done = await auPrestartComplete\(facts\.caseRow\.id\);/);
    expect(fs.readFileSync(path.join(__dirname, '..', 'lib/au-commencement.js'), 'utf8')).toMatch(/prestartComplete: pre\.ok === true && pre\.complete === true/);
  });
});
