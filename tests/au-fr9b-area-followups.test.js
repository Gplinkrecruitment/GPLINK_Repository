// Australian GP build, FR-9b: the area check's follow-ups (an auditor's
// residual findings on FR-9). Through the real server and the in-memory
// database stub, with the `fixture` provider (no network). Each test that is
// marked "fails before" fails on the code before this change.
//
// Every identity is fake. Nothing is sent; no test reaches the real locator.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const parity = require('./helpers/au-wp23-parity.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const locator = require('../lib/au-workforce-locator.js');
const areaLib = require('../lib/au-practice-area.js');

const NOW = new Date().toISOString();
const DUBBO = { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', nearest_city: 'Dubbo', latitude: null, longitude: null, google_place_id: '' };
const VR_ONLY = { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false };
const auAnswers = (over) => Object.assign({ gp_types: Object.assign({}, VR_ONLY), dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: [] }, over || {});

let h;
let seq = 0;
const rows = (table) => h.emu.table(table);
const practiceById = (id) => rows('practices').filter((p) => p.id === id)[0] || null;
const jobsFor = (practiceId) => rows('career_roles').filter((j) => j.practice_id === practiceId);
const audit = (action) => rows('admin_audit_log').filter((r) => r.action === action);
const setProvider = (v) => { if (v == null) delete process.env.AU_WORKFORCE_LOCATOR_PROVIDER; else process.env.AU_WORKFORCE_LOCATOR_PROVIDER = v; };
const copy = (v) => JSON.parse(JSON.stringify(v));

function seedPractice(key, over) {
  seq += 1;
  const row = Object.assign({
    id: crypto.randomUUID(), name: 'FR9b ' + key + ' Practice (FAKE)', contact_name: 'Pat Testmanager',
    contact_email: 'fr9b.' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.' + seq + '@gplink-test.local', contact_phone: '0400 000 2' + String(10 + seq),
    stage: 'prospective', agreement_status: 'unsigned', source: 'manual', intake_token: crypto.randomBytes(24).toString('hex'),
    location_country: 'Australia', is_active: true, org_type: 'practice', metadata: {}, created_at: NOW, updated_at: NOW
  }, over || {});
  rows('practices').push(row);
  return row;
}
function clinicFor(key, place, lie) {
  const base = parity.intakeClinic('dpa');
  return Object.assign(base, { practice_name: 'FR9b ' + key + ' Practice (FAKE)', visa_sponsorship: '', supervision_available: '' }, place,
    { dpa: 'no', dpa_suggested: null, mmm: '' }, lie || {}, { au_gp: auAnswers(lie && lie.au_gp) });
}
const saveIntake = (practice, clinic) => h.post('/api/practice-intake', { token: practice.intake_token, practices: [clinic] });
async function walk(key, place, opts) {
  const o = opts || {};
  const practice = seedPractice(key);
  const save = await saveIntake(practice, clinicFor(key, place, o.lie));
  expect(save.status).toBe(200);
  await h.post('/api/practice-intake/sign', Object.assign(parity.signBody(practice.intake_token), { email: practice.contact_email }));
  await parity.settle(h);
  return { practice: practiceById(practice.id), job: jobsFor(practice.id)[0] || null };
}
function addDoctor(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'fr9b' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  return d;
}
const patchPractice = (id, body) => h.request('PATCH', '/api/ats/practice?id=' + encodeURIComponent(id), Object.assign({ body }, h.superAdmin()));
const patchJob = (id, body) => h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(id), Object.assign({ body }, h.superAdmin()));
const listCard = async (id) => ((await h.get('/api/ats/practices', h.superAdmin())).json.practices || []).filter((p) => p.id === id)[0] || null;
const detail = async (id) => (await h.get('/api/ats/practice?id=' + encodeURIComponent(id), h.superAdmin())).json.practice;
const editorOf = async (jobId) => (await h.get('/api/ats/job?id=' + encodeURIComponent(jobId), h.superAdmin())).json.editor;
async function checkAll() {
  let cursor = '';
  for (let i = 0; i < 200; i++) {
    const r = await h.post('/api/ats/practices/area/check-all', { cursor, limit: 5 }, h.superAdmin());
    expect(r.status).toBe(200);
    if (r.json.done) return;
    cursor = r.json.next_cursor;
  }
  throw new Error('check-all did not finish');
}

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'fr9barea', mode: 'supabase', tables: parity.parityTables(), emulator: parity.PARITY_EMULATOR, env: parity.PARITY_ENV });
});
afterAll(async () => { setProvider(null); if (h) { h.testUtils.__setJobWriteupForTest(null); await h.closeAll(); } });
beforeEach(() => {
  h.setSwitch(true); h.reset(); h.emu.forbid(null); setProvider('fixture');
  locator._resetForTests();
  if (h.testUtils.__setJobWriteupForTest) h.testUtils.__setJobWriteupForTest(null);
});

describe('M9-01 residual: the ordinary Practices editor (PATCH /api/ats/practice)', () => {
  it('fails before: changing the state of an "In a DPA" practice re-checks it, and its role reads not confirmed', async () => {
    const w = await walk('Editor State', DUBBO);
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    const res = await patchPractice(w.practice.id, { state: 'VIC' });
    expect(res.status).toBe(200);
    expect(practiceById(w.practice.id).location_state).toBe('VIC');
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'unknown', mmm: '' });
    expect(job.masked_title).toMatch(/^Non-DPA - /);
    expect(job.source_payload.au_area).toMatchObject({ follows: true, status: 'unknown' });
    const logged = audit('admin_au_role_area_applied').filter((r) => r.target_id === String(job.id)).pop();
    expect(logged.detail).toMatchObject({ before: { dpa: 'yes' }, after: { dpa: 'unknown' }, address_changed: true, trigger: 'staff_address_changed' });
    // the reply carries the practice as it now is (re-checked)
    expect(res.json.practice.metadata.au_area.moved_unanswered).toBe(true);
    // and putting the right state back answers it again
    expect((await patchPractice(w.practice.id, { state: 'NSW' })).status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
  });

  it('guard: an edit that does not touch the address (name, contact, or the city label the check does not read) checks nothing', async () => {
    const w = await walk('Editor Name', DUBBO);
    const before = audit('admin_au_practice_area_check').length;
    expect((await patchPractice(w.practice.id, { name: 'FR9b Editor Name Renamed (FAKE)', contact: 'Sam Test' })).status).toBe(200);
    expect((await patchPractice(w.practice.id, { city: 'Dubbo' })).status).toBe(200);
    expect((await patchPractice(w.practice.id, { state: 'NSW' })).status).toBe(200);   // the same state: not a change
    expect(audit('admin_au_practice_area_check').length).toBe(before);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
  });

  it('guard: with the check off (no provider) or the switch off, the editor does what main does: no check, the role is not touched', async () => {
    const w = await walk('Editor Off', DUBBO);
    const before = audit('admin_au_practice_area_check').length;
    setProvider(null);
    expect((await patchPractice(w.practice.id, { state: 'VIC' })).status).toBe(200);
    h.setSwitch(false);
    expect((await patchPractice(w.practice.id, { state: 'QLD' })).status).toBe(200);
    expect(audit('admin_au_practice_area_check').length).toBe(before);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
  });
});

// FR-10 (S13-03): the job editor moves a role to an address the check cannot answer for. The role is
// hidden from priority-area-only doctors (right) and its doctor-facing name follows the label, exactly
// as the Practices editor path already does it (one helper, auAreaTitlePatch).
describe('S13-03: a role moved in the JOB editor drops its old "DPA - ..." name', () => {
  it('fails before: moved to Bourke (the test map cannot answer) -> not confirmed, and both its title and masked title say Non-DPA', async () => {
    const w = await walk('Job Move', DUBBO);
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect(w.job.title).toBe(w.job.masked_title);
    expect(w.job.title).toMatch(/^DPA - Dubbo/);
    const res = await patchJob(w.job.id, { address: '7 Unknown Lane, Bourke, NSW, 2840', suburb: 'Bourke', state: 'NSW' });
    expect(res.status).toBe(200);
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(job.masked_title).toMatch(/^Non-DPA - /);
    expect(job.title).toBe(job.masked_title);
    expect(job.title).not.toMatch(/Dubbo/);
  });
  it('guard: a role whose title staff wrote themselves keeps it; with the check off the editor does what main does', async () => {
    const w = await walk('Job Own Title', DUBBO);
    rows('career_roles').filter((r) => r.id === w.job.id)[0].title = 'Senior GP, Saturdays (FAKE)';
    expect((await patchJob(w.job.id, { address: '7 Unknown Lane, Bourke, NSW, 2840', suburb: 'Bourke', state: 'NSW' })).status).toBe(200);
    expect(jobsFor(w.practice.id)[0].title).toBe('Senior GP, Saturdays (FAKE)');
    const v = await walk('Job Off', DUBBO);
    setProvider(null);
    expect((await patchJob(v.job.id, { suburb: 'Bourke', state: 'NSW' })).status).toBe(200);
    const off = jobsFor(v.practice.id)[0];
    expect(off.title).toBe(v.job.title);                 // main never moves the title here
    expect(off.masked_title).toMatch(/^DPA - Bourke/);   // main's own masked-title recompute, unchanged
  });
});

describe('M9-02 race: a write that read the role before a slow step does not undo a staff change made meanwhile', () => {
  it('fails before: the role-page enrichment (updateCareerRoleRow) keeps a hand-set value made during its wait', async () => {
    const w = await walk('Race Page', DUBBO);
    const stale = copy(w.job);                                         // read before the slow website fetch / AI call
    expect(stale.source_payload.au_area.manual == null).toBe(true);
    // ...meanwhile staff set the role by hand
    expect((await patchJob(w.job.id, { dpa_status: 'no', au_area_reason: 'This role is at the branch surgery' })).status).toBe(200);
    const handSet = copy(jobsFor(w.practice.id)[0].source_payload.au_area);
    expect(handSet.manual).toMatchObject({ dpa: 'no', by: h.SUPER_EMAIL });
    // ...then the enrichment finishes and writes
    await h.testUtils.updateCareerRoleRow(stale, { aiStatus: 'fallback', aiError: 'test' });
    const after = jobsFor(w.practice.id)[0];
    expect(after.source_payload.gpLink.aiStatus).toBe('fallback');      // the enrichment's own write landed
    expect(after.source_payload.au_area).toEqual(handSet);               // ...and the hand-set value is still there
    expect(after.source_payload.zoho.au_area).toBeUndefined();
    expect(after).toMatchObject({ dpa: false, dpa_status: 'no' });
  });

  it('fails before: an address correction made during the wait is not undone either', async () => {
    const w = await walk('Race Move', DUBBO);
    const stale = copy(w.job);
    expect((await h.post('/api/ats/practice/area', { id: w.practice.id, action: 'set_address', address: '1 Test Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' }, h.superAdmin())).status).toBe(200);
    const moved = copy(jobsFor(w.practice.id)[0].source_payload.au_area);
    expect(moved).toMatchObject({ status: 'no' });
    await h.testUtils.updateCareerRoleRow(stale, { aiStatus: 'fallback' });
    expect(jobsFor(w.practice.id)[0].source_payload.au_area).toEqual(moved);
  });

  it('fails before: the staff AI write-up keeps a hand-set value made while the model was answering', async () => {
    const w = await walk('Race Writeup', DUBBO);
    h.testUtils.__setJobWriteupForTest(async (job) => {
      expect((await patchJob(job.id, { dpa_status: 'no', au_area_reason: 'This role is at the branch surgery' })).status).toBe(200);
      return { ok: true, writeup: { about: 'A test write-up.', highlights: [], sources: ['form'], generatedAt: NOW } };
    });
    const res = await h.post('/api/ats/job/ai-writeup?id=' + encodeURIComponent(w.job.id), {}, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const after = jobsFor(w.practice.id)[0];
    expect(after.source_payload.gpLink.aiWriteup.about).toBe('A test write-up.');
    expect(after.source_payload.au_area.manual).toMatchObject({ dpa: 'no', by: h.SUPER_EMAIL });
  });

  it('guard: with the switch off, or the check off and no AU key on the row, the write makes no extra read', async () => {
    const plain = { id: 'fr9b-plain-' + (++seq), provider: 'internal_ats', provider_role_id: 'ats_fr9b_plain_' + seq, title: 'Plain role', summary: '', support_summary: '', source_payload: { gpLink: { x: 1 } } };
    rows('career_roles').push(copy(plain));
    for (const mode of ['switch_off', 'check_off']) {
      if (mode === 'switch_off') h.setSwitch(false); else { h.setSwitch(true); setProvider(null); }
      h.emu.reset();
      await h.testUtils.updateCareerRoleRow(copy(plain), { aiStatus: 'fallback' });
      const reqs = h.emu.requestsTo('career_roles');
      expect(reqs.map((r) => r.method), mode).toEqual(['PATCH']);
      expect(Object.keys(reqs[0].body.source_payload).sort(), mode).toEqual(['gpLink', 'zoho']);
    }
  });
});

describe('M9-06: no "that does not hold anything up" left for a practice to read', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('fails before: the intake page\'s "not sure" answer (the check off) and the employers form\'s failed look-up say what not confirmed holds up', () => {
    const intake = read('pages/practice-intake.html');
    const lead = read('js/site-practice-lead-au.js');
    expect(intake).not.toContain('That does not hold anything up');
    expect(lead).not.toContain('That doesn\\\'t hold anything up');
    expect(lead).not.toMatch(/doesn.t hold anything up/);
    // the replacement is the same plain wording the server already uses (PRACTICE_UNKNOWN_NOTE)
    const truth = 'is not shown to doctors who may only work in a priority area (that includes doctors moving to Australia from overseas). Other doctors can still see it.';
    expect(areaLib.PRACTICE_UNKNOWN_NOTE).toContain(truth);
    expect(intake.split('You told us you are <b>not sure</b>. Our team will check it and confirm with you. Until they have, your role ' + truth).length - 1).toBe(2);
    expect(lead).toContain('Until they have, a role you list with us ' + truth);
  });
});

describe('M9-09 gap: what staff read once the check is switched off', () => {
  it('fails before: a practice that WAS asked (the check off), then checked by Check all, then the check off: "Practice answered: ..." with its own answer', async () => {
    setProvider(null);
    const w = await walk('Asked Then Checked', DUBBO, { lie: { dpa: 'no', dpa_suggested: null, au_gp: { dpa_answer: 'unsure' } } });
    expect(w.practice.metadata.intake.dpa_from_lookup).toBeUndefined();
    setProvider('fixture');
    await checkAll();
    const checked = practiceById(w.practice.id);
    expect(checked.metadata.au_area.lookup).toMatchObject({ dpa: 'yes', confidence: 'exact' });
    expect(jobsFor(w.practice.id)[0].source_payload.au_area).toMatchObject({ follows: true, set_by: 'lookup', status: 'yes' });
    setProvider(null);
    const card = await listCard(w.practice.id);
    expect(card.au_gp.dpa.autoChecked).toBeUndefined();
    expect(card.au_gp.dpa.practiceAnswer).toBe('unsure');
    const d = await detail(w.practice.id);
    expect(d.au_gp.dpa.autoChecked).toBeUndefined();
    expect(d.au_gp.dpa.practiceAnswer).toBe('unsure');
    const editor = await editorOf(w.job.id);
    expect(editor.au_intake.dpa.autoChecked).toBeUndefined();
    expect(editor.au_intake.dpa.practiceAnswer).toBe('unsure');
    // how: the practice's stored answer was brought into step by the check (FR-9), and what it said itself is kept
    expect(checked.metadata.intake.au_gp.dpa_answer).toBe('yes');
    expect(checked.metadata.intake.practice_dpa_answer).toBe('unsure');
  });

  it('fails before: a role whose area record only says it follows (never answered) is not annotated "Checked automatically"', async () => {
    setProvider(null);
    const w = await walk('Follows Only', DUBBO, { lie: { dpa: 'no', dpa_suggested: null, au_gp: { dpa_answer: 'unsure' } } });
    const row = jobsFor(w.practice.id)[0];
    row.source_payload = Object.assign({}, row.source_payload, { au_area: { follows: true } });
    const editor = await editorOf(row.id);
    expect(editor.au_intake.dpa.autoChecked).toBeUndefined();
    expect(editor.au_intake.dpa.practiceAnswer).toBe('unsure');
  });

  it('guard: a practice that was NOT asked (its form was saved with the check on) is still annotated, and so is its role', async () => {
    const w = await walk('Never Asked', DUBBO);
    expect(w.practice.metadata.intake.dpa_from_lookup).toBe(true);
    setProvider(null);
    const card = await listCard(w.practice.id);
    expect(card.au_gp.dpa).toMatchObject({ status: 'yes', practiceAnswer: '' });
    expect(card.au_gp.dpa.autoChecked.note).toMatch(/^Checked automatically on \d{4}-\d{2}-\d{2}; the check is now off$/);
    const editor = await editorOf(w.job.id);
    expect(editor.au_intake.dpa.autoChecked.note).toBe('Checked automatically; the check is now off');
  });

  it('guard: a browser cannot mark its own answer as "from the look-up"', async () => {
    setProvider(null);
    const p = seedPractice('Forged Marker');
    const clinic = Object.assign(clinicFor('Forged Marker', DUBBO, { dpa: 'no', au_gp: { dpa_answer: 'unsure' } }), { dpa_from_lookup: true, practice_dpa_answer: 'yes' });
    expect((await saveIntake(p, clinic)).status).toBe(200);
    expect(practiceById(p.id).metadata.intake.dpa_from_lookup).toBeUndefined();
    expect(practiceById(p.id).metadata.intake.practice_dpa_answer).toBeUndefined();
  });
});

describe('M9-05 residual: a browser point the server corroborates', () => {
  // Two made-up places 0.67 km apart: the building the server finds is in the
  // first (a DPA), the browser's point sits just over the line in the second.
  const EDGE = {
    edition: 'fixture', mmmYear: 2023,
    places: [
      { id: 'edge-in', suburb: 'Edgetown', state: 'NSW', postcode: '2999', lat: -30.0, lng: 150.0, radiusKm: 0.4, dpaGp: 'yes', mmm: 4, catchment: 'Edge In', addresses: [{ street: '1 Edge Street', lat: -30.0, lng: 150.0 }] },
      { id: 'edge-out', suburb: 'Overline', state: 'NSW', postcode: '2998', lat: -30.006, lng: 150.0, radiusKm: 0.4, dpaGp: 'no', mmm: 2, catchment: 'Edge Out', addresses: [] }
    ]
  };
  it('fails before: within a kilometre of the building the server found, the SERVER\'s point is classified', async () => {
    const r = await locator.classifyLocation(
      { address: '1 Edge Street', suburb: 'Edgetown', state: 'NSW', postcode: '2999', latitude: -30.006, longitude: 150.0, placeId: 'p-edge' },
      { env: { AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture' }, fixture: EDGE });
    expect(r).toMatchObject({ ok: true, dpaGp: 'yes', mmm: 4, confidence: 'exact', method: 'selected_address', catchment: 'Edge In' });
    expect(r.pointUsed).toMatchObject({ lat: -30.0, lng: 150.0 });
    expect(r.warnings).toEqual([]);
  });
});

describe('R9-01: hold_kind only for a held Australian doctor', () => {
  it('fails before 57a4ba8a: not held -> no hold_kind key at all; held -> hold_kind is there', async () => {
    const free = addDoctor('au_vr');
    const a = await h.get('/api/ats/candidate/role-eligibility?user_id=' + free.userId, h.superAdmin());
    expect(a.status).toBe(200);
    expect(a.json.pathway.is_au).toBe(true);
    expect(a.json.hold).toBe(false);
    expect('hold_kind' in a.json).toBe(false);
    const held = addDoctor('au_registrar');
    const b = await h.get('/api/ats/candidate/role-eligibility?user_id=' + held.userId, h.superAdmin());
    expect(b.status).toBe(200);
    expect(b.json.hold).toBe(true);
    expect(typeof b.json.hold_kind).toBe('string');
  });
});
