// Australian GP build, WP-30: a practice's area (Distribution Priority Area for
// GPs, Modified Monash level) is looked up and pinned, through the real server
// and the in-memory database stub, with the `fixture` provider (no network).
//
// Every identity is fake. Nothing is sent; no test reaches the real locator.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const parity = require('./helpers/au-wp23-parity.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const locator = require('../lib/au-workforce-locator.js');

const NOW = new Date().toISOString();
const STAFF = 'staff.test@gplink-test.local';
const RESTRICTED_19AB = { moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW };
const CONSEQUENCE = 'Not confirmed: hidden from doctors restricted to priority areas';

const DUBBO = { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', nearest_city: 'Dubbo', latitude: null, longitude: null, google_place_id: '' };
const PARRA = { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', postcode: '2150', nearest_city: 'Sydney', latitude: null, longitude: null, google_place_id: '' };
const DUBBO_SUBURB_ONLY = { address: 'Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', nearest_city: 'Dubbo', latitude: null, longitude: null, google_place_id: '' };
const NOT_IN_FIXTURE = { address: '8 Elsewhere Avenue, Surry Hills NSW 2010', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', nearest_city: 'Sydney', latitude: null, longitude: null, google_place_id: '' };

const VR_ONLY = { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false };
const auAnswers = (over) => Object.assign({ gp_types: Object.assign({}, VR_ONLY), dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: [] }, over || {});

let h;
let seq = 0;
const rows = (table) => h.emu.table(table);
const practiceById = (id) => rows('practices').filter((p) => p.id === id)[0] || null;
const jobsFor = (practiceId) => rows('career_roles').filter((j) => j.practice_id === practiceId);
const publicId = (job) => 'internal_ats:' + job.provider_role_id;
const audit = (action) => rows('admin_audit_log').filter((r) => r.action === action);
const setProvider = (v) => { if (v == null) delete process.env.AU_WORKFORCE_LOCATOR_PROVIDER; else process.env.AU_WORKFORCE_LOCATOR_PROVIDER = v; };

function seedPractice(key, over) {
  seq += 1;
  const row = Object.assign({
    id: crypto.randomUUID(), name: 'WP30 ' + key + ' Practice (FAKE)', contact_name: 'Pat Testmanager',
    contact_email: 'wp30.' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.' + seq + '@gplink-test.local', contact_phone: '0400 000 0' + String(10 + seq),
    stage: 'prospective', agreement_status: 'unsigned', source: 'manual', intake_token: crypto.randomBytes(24).toString('hex'),
    location_country: 'Australia', is_active: true, org_type: 'practice', metadata: {}, created_at: NOW, updated_at: NOW
  }, over || {});
  rows('practices').push(row);
  return row;
}
/** The clinic a browser posts. `lie` is what a tampered browser claims about the area. */
function clinicFor(key, place, lie) {
  const base = parity.intakeClinic('dpa');
  return Object.assign(base, { practice_name: 'WP30 ' + key + ' Practice (FAKE)', visa_sponsorship: '', supervision_available: '' }, place,
    { dpa: 'no', dpa_suggested: null, mmm: '' }, lie || {}, { au_gp: auAnswers(lie && lie.au_gp) });
}
async function saveIntake(practice, clinic) {
  return h.post('/api/practice-intake', { token: practice.intake_token, practices: [clinic] });
}
async function sign(practice) {
  const res = await h.post('/api/practice-intake/sign', Object.assign(parity.signBody(practice.intake_token), { email: practice.contact_email }));
  await parity.settle(h);
  return res;
}
async function walk(key, place, opts) {
  const o = opts || {};
  const practice = seedPractice(key);
  const save = await saveIntake(practice, clinicFor(key, place, o.lie));
  const out = { practice: practiceById(practice.id), save };
  if (save.status !== 200 || o.stopAfterSave) return out;
  out.sign = await sign(practice);
  out.practice = practiceById(practice.id);
  out.job = jobsFor(practice.id)[0] || null;
  if (o.approve && out.job) {
    out.job.header_image_url = 'https://images.gplink-test.local/' + key + '.jpg';
    out.approve = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(out.job.id), { action: 'approve' }, h.superAdmin());
    await parity.settle(h);
    out.job = jobsFor(practice.id)[0];
  }
  return out;
}
function addDoctor(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'w30' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const seenBy = async (d, job) => ((await h.get('/api/career/roles', { cookie: d.cookie })).json.roles || []).filter((r) => r.id === publicId(job))[0] || null;
const practiceArea = (id, who) => h.post('/api/ats/practice/area', Object.assign({ id }, who.body), who.as || h.superAdmin());
const act = (id, body, as) => h.post('/api/ats/practice/area', Object.assign({ id }, body), as || h.superAdmin());
const jobAct = (id, body, as) => h.post('/api/ats/job/area', Object.assign({ id }, body), as || h.superAdmin());
const patchJob = (id, body) => h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(id), Object.assign({ body }, h.superAdmin()));
void practiceArea;

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp30', mode: 'supabase', tables: parity.parityTables(), emulator: parity.PARITY_EMULATOR, env: parity.PARITY_ENV });
});
afterAll(async () => { setProvider(null); delete process.env.AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE; if (h) await h.closeAll(); });
beforeEach(() => {
  h.setSwitch(true); h.reset(); h.emu.forbid(null); setProvider('fixture');
  delete process.env.AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE;
  locator._resetForTests();
});

describe('practice intake with the look-up on: the practice is not asked, and the browser cannot set the answer', () => {
  it('the page is told the area is looked up', async () => {
    const p = seedPractice('Load');
    const load = await h.get('/api/practice-intake?token=' + p.intake_token);
    expect(load.status).toBe(200);
    expect(load.json.practice.au_gp.locator).toEqual({ on: true });
  });

  it('an exact address in a DPA: recorded as yes with its Modified Monash level, whatever the browser claimed', async () => {
    const w = await walk('Exact Dpa', DUBBO, { lie: { dpa: 'no', dpa_suggested: false, mmm: 'MM1', au_gp: { dpa_answer: 'no' } } });
    expect(w.save.status).toBe(200);
    const p = w.practice;
    expect(p).toMatchObject({ dpa: true, dpa_suggested: true, dpa_mismatch: false });
    expect(p.metadata.intake).toMatchObject({ dpa: true, mmm: 'MM3' });
    expect(p.metadata.intake.au_gp.dpa_answer).toBe('yes');
    expect(p.metadata.au_area.lookup).toMatchObject({ dpa: 'yes', mmm: 3, confidence: 'exact', provider: 'fixture', method: 'geocoded_address', year: { dpa: 'fixture', mmm: 2023 }, catchment: 'Dubbo' });
    expect(p.metadata.au_area.lookup.point).toMatchObject({ lat: -32.2569, lng: 148.6011, source: 'geocoded_address' });
    expect(p.metadata.au_area.manual).toBe(null);
    // the role it becomes
    expect(w.sign.status).toBe(200);
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3', approval_status: 'pending' });
    expect(w.job.masked_title).toMatch(/^DPA - /);
    expect(w.job.source_payload.au_area).toMatchObject({ follows: true, site: 'practice', status: 'yes', mmm: 3, set_by: 'lookup' });
    expect(w.job.source_payload.au_intake.flags.map((f) => f.code)).not.toContain('dpa_unknown');
    // every classification is recorded
    const logged = audit('admin_au_practice_area_check').filter((r) => r.target_id === p.id);
    expect(logged.length).toBe(1);
    expect(logged[0].detail).toMatchObject({ before: { dpa: 'unknown' }, after: { dpa: 'yes', mmm: 3, set_by: 'lookup' }, method: 'geocoded_address', confidence: 'exact', provider: 'fixture', trigger: 'practice_intake' });
    expect(logged[0].actor_email).toBe('practice_intake');
  });

  it('an exact address outside a DPA: no, even when the browser says yes and sends a point somewhere else', async () => {
    const w = await walk('Exact Metro', PARRA, { lie: { dpa: 'yes', dpa_suggested: true, mmm: 'MM7', latitude: -32.2569, longitude: 148.6011, google_place_id: 'fake-place', au_gp: { dpa_answer: 'yes', gp_types: Object.assign({}, VR_ONLY, { overseas: true }) } } });
    expect(w.save.status).toBe(200);
    expect(w.practice).toMatchObject({ dpa: false, dpa_suggested: false, dpa_mismatch: false });
    expect(w.practice.metadata.intake).toMatchObject({ dpa: false, mmm: 'MM1' });
    expect(w.practice.metadata.intake.au_gp.dpa_answer).toBe('no');
    expect(w.practice.metadata.au_area.lookup).toMatchObject({ dpa: 'no', mmm: 1, confidence: 'exact', method: 'geocoded_address' });
    expect(w.practice.metadata.au_area.lookup.warnings).toContain('point_address_mismatch');
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(w.job.masked_title).toMatch(/^Non-DPA - /);
  });

  it('a suburb-only address: not confirmed (never a yes), flagged to staff, and the role is stored as unknown', async () => {
    const w = await walk('Suburb Only', DUBBO_SUBURB_ONLY, { lie: { dpa: 'yes', dpa_suggested: true, mmm: 'MM3', au_gp: { dpa_answer: 'yes' } } });
    expect(w.save.status).toBe(200);
    expect(w.practice).toMatchObject({ dpa: false, dpa_suggested: null });
    expect(w.practice.metadata.intake).toMatchObject({ dpa: false, mmm: '' });
    expect(w.practice.metadata.intake.au_gp.dpa_answer).toBe('unsure');
    expect(w.practice.metadata.au_area.lookup).toMatchObject({ dpa: 'unknown', indicative_dpa: 'yes', mmm: 3, mmm_approx: true, confidence: 'approximate', method: 'suburb_centroid' });
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'unknown', mmm: '' });
    const flags = w.job.source_payload.au_intake.flags;
    expect(flags[0].code).toBe('dpa_unknown');
    expect(flags[0].message).toMatch(/hidden from doctors restricted to priority areas/);
  });

  it('an address the look-up cannot find: not confirmed', async () => {
    const w = await walk('Not Found', NOT_IN_FIXTURE, { lie: { dpa: 'yes', dpa_suggested: true, au_gp: { dpa_answer: 'yes' } } });
    expect(w.save.status).toBe(200);
    expect(w.practice.dpa).toBe(false);
    expect(w.practice.metadata.au_area.lookup).toBe(null);
    expect(w.practice.metadata.au_area.last_attempt).toMatchObject({ ok: false, error: 'address_not_located' });
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'unknown' });
  });

  it('latitude 0 / longitude 0 from a hand-typed address is not used as a point', async () => {
    const w = await walk('Zero Point', DUBBO, { lie: { latitude: 0, longitude: 0 }, stopAfterSave: true });
    expect(w.practice.metadata.au_area.lookup).toMatchObject({ dpa: 'yes', method: 'geocoded_address' });
    expect(w.practice.metadata.au_area.lookup.point.lat).toBeCloseTo(-32.2569, 3);
  });

  it('a form listing an absurd number of clinics does not become that many look-ups: past twelve, a clinic is "not confirmed"', async () => {
    const p = seedPractice('Many Clinics');
    const clinics = [];
    for (let i = 0; i < 14; i++) clinics.push(clinicFor('Many Clinics ' + i, DUBBO, { dpa: 'yes', dpa_suggested: true, au_gp: { dpa_answer: 'yes' } }));
    const save = await h.post('/api/practice-intake', { token: p.intake_token, entity_name: 'WP30 Many Pty Ltd (FAKE)', abn: '51824753556', practices: clinics });
    expect(save.status).toBe(200);
    expect(save.json.practice_count).toBe(14);
    const saved = rows('practices').filter((r) => r.group_id === save.json.group_id);
    expect(saved.length).toBe(14);
    expect(saved.filter((r) => r.dpa === true).length).toBe(12);
    const beyond = saved.filter((r) => r.dpa !== true);
    expect(beyond.length).toBe(2);
    for (const r of beyond) {
      expect(r).toMatchObject({ dpa: false, dpa_suggested: null });
      expect(r.metadata.intake.au_gp.dpa_answer).toBe('unsure');
      expect(r.metadata.au_area.lookup).toBe(null);
    }
  });

  it('what the page is shown for an address (token-gated, read-only, stores nothing)', async () => {
    const p = seedPractice('Preview');
    const yes = await h.post('/api/practice-intake/area', Object.assign({ token: p.intake_token }, DUBBO));
    expect(yes.status).toBe(200);
    expect(yes.json).toEqual({ ok: true, finding: { state: 'yes', line: 'Your practice is in a Distribution Priority Area for GPs · Modified Monash 3' } });
    const no = await h.post('/api/practice-intake/area', Object.assign({ token: p.intake_token }, PARRA));
    expect(no.json.finding).toEqual({ state: 'no', line: 'Your practice is not in a Distribution Priority Area for GPs · Modified Monash 1' });
    const unsure = await h.post('/api/practice-intake/area', Object.assign({ token: p.intake_token }, DUBBO_SUBURB_ONLY));
    expect(unsure.json.finding).toEqual({ state: 'unknown', line: 'We\'ll confirm your area with you' });
    expect(practiceById(p.id).metadata).toEqual({});
    // no token, no answer: it cannot be used to look up arbitrary addresses
    expect((await h.post('/api/practice-intake/area', Object.assign({ token: 'x'.repeat(40) }, DUBBO))).status).toBe(404);
    expect((await h.post('/api/practice-intake/area', DUBBO)).status).toBe(404);
  });

  it('"This looks wrong" records a note for staff and changes no value', async () => {
    const w = await walk('Dispute', DUBBO, { stopAfterSave: true });
    const before = JSON.parse(JSON.stringify(w.practice));
    const res = await h.post('/api/practice-intake/area-note', { token: w.practice.intake_token, note: 'We are on the other side of the river', clinic: 'Main clinic' });
    expect(res.status).toBe(200);
    const after = practiceById(w.practice.id);
    expect(after.metadata.au_area.disputes.length).toBe(1);
    expect(after.metadata.au_area.disputes[0].note).toBe('[Main clinic] We are on the other side of the river');
    expect(after.dpa).toBe(before.dpa);
    expect(after.metadata.au_area.lookup).toEqual(before.metadata.au_area.lookup);
    expect((await h.post('/api/practice-intake/area-note', { token: w.practice.intake_token, note: '' })).status).toBe(400);
    expect((await h.post('/api/practice-intake/area-note', { token: 'y'.repeat(40), note: 'hello there' })).status).toBe(404);
    const view = (await h.get('/api/ats/practice?id=' + w.practice.id, h.superAdmin())).json.practice.au_area;
    expect(view.disputes.length).toBe(1);
  });

  it('saving the same address again does not move anything; a changed address is classified again and the roles follow', async () => {
    const w = await walk('Move', DUBBO, { approve: true });
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    // (the practice cannot resubmit after signing through the page, but staff can correct the address)
    const moved = await act(w.practice.id, { action: 'set_address', address: '1 Test Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' });
    expect(moved.status).toBe(200);
    expect(moved.json.outcome).toBe('changed');
    expect(moved.json.au_area).toMatchObject({ status: 'no', mmm: 1, address: '1 Test Street, Parramatta, NSW, 2150' });
    expect(practiceById(w.practice.id)).toMatchObject({ address: '1 Test Street', suburb: 'Parramatta', location_state: 'NSW', postcode: '2150', latitude: null, longitude: null });
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(job.masked_title).toMatch(/^Non-DPA - /);
    expect(audit('admin_au_role_area_applied').filter((r) => r.target_id === String(job.id)).length).toBe(1);
    // validation
    expect((await act(w.practice.id, { action: 'set_address', address: '', suburb: 'Dubbo', state: 'NSW' })).status).toBe(400);
    expect((await act(w.practice.id, { action: 'set_address', address: '2 Test Road', suburb: 'Dubbo', state: 'XX' })).status).toBe(400);
    expect((await act(w.practice.id, { action: 'set_address', address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '28' })).status).toBe(400);
  });
});

describe('provider `none` (the default) with the switch on: intake is exactly as it was', () => {
  beforeEach(() => { setProvider(null); });
  it('the page is not told anything new, the practice\'s own answer is stored, and nothing is pinned', async () => {
    const p = seedPractice('None');
    const load = await h.get('/api/practice-intake?token=' + p.intake_token);
    expect(load.json.practice.au_gp).toEqual({ dpa_lookup: 'unknown' });
    const save = await saveIntake(p, clinicFor('None', PARRA, { dpa: 'yes', dpa_suggested: true, mmm: 'MM2', au_gp: { dpa_answer: 'yes' } }));
    expect(save.status).toBe(200);
    const stored = practiceById(p.id);
    expect(stored).toMatchObject({ dpa: true, dpa_suggested: true });
    expect(stored.metadata.intake).toMatchObject({ dpa: true, mmm: 'MM2' });
    expect(stored.metadata.au_area).toBeUndefined();
    await sign(p);
    const job = jobsFor(p.id)[0];
    expect(job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM2' });
    expect(job.source_payload.au_area).toBeUndefined();
    expect(audit('admin_au_practice_area_check').filter((r) => r.target_id === p.id)).toEqual([]);
  });
  it('the new routes do not exist', async () => {
    const p = seedPractice('None Routes');
    const unknownPost = await h.post('/api/practice-intake/there-is-no-such-route', { token: p.intake_token });
    for (const path of ['/api/practice-intake/area', '/api/practice-intake/area-note']) {
      const res = await h.post(path, Object.assign({ token: p.intake_token, note: 'hello there' }, DUBBO));
      expect([res.status, res.raw]).toEqual([unknownPost.status, unknownPost.raw]);
    }
    const unknownStaff = await h.post('/api/ats/practice/there-is-no-such-route', { id: p.id }, h.superAdmin());
    for (const path of ['/api/ats/practice/area', '/api/ats/job/area', '/api/ats/practices/area/check-all']) {
      const res = await h.post(path, { id: p.id, action: 'recheck' }, h.superAdmin());
      expect([res.status, res.raw]).toEqual([unknownStaff.status, unknownStaff.raw]);
    }
    const view = await h.get('/api/ats/practice?id=' + p.id, h.superAdmin());
    expect(view.json.practice.au_area).toBeUndefined();
    expect(view.json.practice.au_area_roles).toBeUndefined();
    expect((await h.get('/api/ats/practices', h.superAdmin())).json.practices.every((c) => c.au_area === undefined)).toBe(true);
  });
});

describe('the employers lead form and the lead it creates', () => {
  it('the area check goes through the same module: what the suburb suggests, marked approximate', async () => {
    const yes = await h.get('/api/public/practice-dpa?suburb=Dubbo&state=NSW');
    expect(yes.status).toBe(200);
    expect(yes.json).toEqual({ ok: true, dpa: true, mmm: 'MM3', latitude: -32.2569, longitude: 148.6011, confidence: 'approximate' });
    const no = await h.get('/api/public/practice-dpa?suburb=Parramatta&state=NSW');
    expect(no.json).toMatchObject({ ok: true, dpa: false, mmm: 'MM1', confidence: 'approximate' });
    const nowhere = await h.get('/api/public/practice-dpa?suburb=Atlantis&state=WA');
    expect(nowhere.json).toEqual({ ok: true, dpa: null, reason: 'not_located' });
    expect((await h.get('/api/public/practice-dpa?state=NSW')).status).toBe(400);
  });
  it('a lead is recorded as not confirmed whatever its browser claims; what the suburb suggests is kept for staff', async () => {
    const body = Object.assign(parity.websiteLead('dpa', true), { contact_email: 'wp30.lead.dubbo@gplink-test.local', practice_name: 'WP30 Lead Dubbo Practice (FAKE)' });
    const res = await h.post('/api/public/practice-lead', body);
    await parity.settle(h);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, emailed: true });
    const p = rows('practices').filter((r) => r.contact_email === body.contact_email)[0];
    expect(p.dpa).toBe(null);
    expect(p.metadata.dpa_lookup).toBe('unknown');
    expect(p.metadata.au_area.lookup).toMatchObject({ dpa: 'unknown', indicative_dpa: 'yes', confidence: 'approximate', mmm: 3 });
    const card = (await h.get('/api/ats/practices', h.superAdmin())).json.practices.filter((c) => c.id === p.id)[0];
    expect(card.au_area).toMatchObject({ checked: true, status: 'unknown', label: 'DPA not confirmed', consequence: CONSEQUENCE });
    // a practice nobody has checked is told apart from one that was checked and is not confirmed
    const never = seedPractice('Lead Never', { dpa: true });
    const neverCard = (await h.get('/api/ats/practices', h.superAdmin())).json.practices.filter((c) => c.id === never.id)[0];
    expect(neverCard.au_area).toMatchObject({ checked: false, label: 'Area not checked yet', consequence: '' });
  });
  it('a browser that claims "in a DPA" for a metro suburb is not believed', async () => {
    const body = Object.assign(parity.websiteLead('metro', true), { suburb: 'Parramatta', postcode: '2150', contact_email: 'wp30.lead.parra@gplink-test.local', practice_name: 'WP30 Lead Parra Practice (FAKE)' });
    await h.post('/api/public/practice-lead', body);
    const p = rows('practices').filter((r) => r.contact_email === body.contact_email)[0];
    expect(p.dpa).toBe(null);
    expect(p.metadata.au_area.lookup).toMatchObject({ dpa: 'unknown', indicative_dpa: 'no' });
  });
});

describe('staff: the practice screen', () => {
  it('shows the labels, the confidence, the source, the years and the date, and each role', async () => {
    const w = await walk('Screen', DUBBO);
    const view = (await h.get('/api/ats/practice?id=' + w.practice.id, h.consultant())).json.practice;
    expect(view.au_area).toMatchObject({
      checked: true, status: 'yes', label: 'In a DPA', mmmLabel: 'Large rural town (MM 3)', setBy: 'lookup', setByLabel: 'Automatic check',
      confidence: 'exact', confidenceLabel: 'Exact (street address)', source: 'Test data (not the real locator)', year: { dpa: 'fixture', mmm: 2023 }, catchment: 'Dubbo'
    });
    expect(view.au_area.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // found on the real-browser walk: the view is built from the practice ROW (its address and postcode),
    // not from the directory's summary of it, so a freshly checked practice is not told its address changed
    expect(view.au_area.warnings).toEqual([]);
    expect(view.au_area.address).toBe('2 Test Road, Dubbo NSW 2830');
    expect(view.au_area.method).toBe('the street address, found to the building');
    expect(view.au_area_roles[String(w.job.id)]).toMatchObject({ status: 'yes', label: 'In a DPA', mmmLabel: 'Large rural town (MM 3)', basis: 'Follows the practice', follows: true });
    const editor = (await h.get('/api/ats/job?id=' + w.job.id, h.superAdmin())).json.editor;
    expect(editor.au_area.role).toMatchObject({ status: 'yes', basis: 'Follows the practice', source: 'Test data (not the real locator)' });
    expect(editor.au_area.practice).toMatchObject({ id: w.practice.id, status: 'yes', label: 'In a DPA' });
    expect(editor.au_intake.dpa).toBe(null);
  });

  it('an unknown practice says what that means, on the practice and on the role', async () => {
    const w = await walk('Unknown Screen', DUBBO_SUBURB_ONLY);
    const view = (await h.get('/api/ats/practice?id=' + w.practice.id, h.superAdmin())).json.practice;
    expect(view.au_area).toMatchObject({ status: 'unknown', label: 'DPA not confirmed', consequence: CONSEQUENCE, mmmLabel: 'approximately Large rural town (MM 3)', indicativeDpa: 'yes' });
    expect(view.au_area_roles[String(w.job.id)]).toMatchObject({ status: 'unknown', consequence: CONSEQUENCE });
    // found on the real-browser walk: the older note "the practice was not sure" is not shown for a practice
    // that was never asked (the area panel says what is known), on the record and on the list card
    expect(view.au_gp.flags.map((f) => f.code)).not.toContain('dpa_unknown');
    const listCard = (await h.get('/api/ats/practices', h.superAdmin())).json.practices.filter((c) => c.id === w.practice.id)[0];
    expect(listCard.au_gp.flags.map((f) => f.code)).not.toContain('dpa_unknown');
    const editor = (await h.get('/api/ats/job?id=' + w.job.id, h.superAdmin())).json.editor;
    expect(editor.au_area.role.consequence).toBe(CONSEQUENCE);
    expect(editor.au_intake.notes.join(' ')).toMatch(/hidden from doctors restricted to priority areas/);
  });

  it('Re-check: same answer, nothing written to the role', async () => {
    const w = await walk('Recheck', DUBBO);
    const before = JSON.parse(JSON.stringify(jobsFor(w.practice.id)[0]));
    h.emu.reset();
    const res = await act(w.practice.id, { action: 'recheck' }, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('unchanged');
    expect(res.json.roles).toMatchObject({ roles: 1, applied: 0, in_step: 1, disagreements: 0, failed: 0 });
    expect(h.emu.requestsTo('career_roles').filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(jobsFor(w.practice.id)[0]).toEqual(before);
    const logged = audit('admin_au_practice_area_check').filter((r) => r.target_id === w.practice.id);
    expect(logged[logged.length - 1]).toMatchObject({ actor_role: 'consultant' });
    expect(logged[logged.length - 1].detail).toMatchObject({ trigger: 'staff_recheck', outcome: 'unchanged' });
  });

  it('a FAILED re-check leaves the earlier answer, and every role, untouched', async () => {
    const w = await walk('Recheck Fails', DUBBO, { approve: true });
    const jobBefore = JSON.parse(JSON.stringify(jobsFor(w.practice.id)[0]));
    locator._resetForTests();
    process.env.AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE = '1';
    await h.get('/api/public/practice-dpa?suburb=Parramatta&state=NSW'); // uses the one slot
    const res = await act(w.practice.id, { action: 'recheck' });
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('failed');
    expect(res.json.au_area).toMatchObject({ status: 'yes', mmm: 3 });
    expect(res.json.au_area.warnings.join(' ')).toMatch(/Last check failed.*earlier answer was kept/);
    expect(practiceById(w.practice.id).metadata.au_area.last_attempt).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(jobsFor(w.practice.id)[0]).toEqual(jobBefore);
    const overseas = addDoctor('overseas_null');
    expect((await seenBy(overseas, jobBefore)).qualifies).toBe(true);
  });

  it('set by hand: needs a reason, is attributed, moves the roles; a disagreeing look-up is shown, not applied; removing it restores the look-up', async () => {
    const w = await walk('Manual', DUBBO, { approve: true });
    const id = w.practice.id;
    expect((await act(id, { action: 'manual', dpa: 'no' })).status).toBe(400);
    expect((await act(id, { action: 'manual', dpa: 'perhaps', reason: 'A good reason' })).status).toBe(400);
    expect((await act(id, { action: 'clear_manual' })).status).toBe(409);

    const set = await act(id, { action: 'manual', dpa: 'no', mmm: 2, reason: 'Confirmed with the Department by phone' }, h.consultant());
    expect(set.status).toBe(200);
    expect(set.json.outcome).toBe('set_by_hand');
    expect(set.json.au_area).toMatchObject({ status: 'no', mmm: 2, setBy: 'staff', setByLabel: 'Set by hand by ' + h.CONSULTANT_EMAIL });
    expect(set.json.au_area.manual).toMatchObject({ dpa: 'no', mmm: 2, reason: 'Confirmed with the Department by phone', by: h.CONSULTANT_EMAIL });
    // the disagreement banner: both values and both dates
    expect(set.json.au_area.disagreement).toMatchObject({ lookup: { dpa: 'yes', mmm: 3 }, manual: { dpa: 'no', mmm: 2, by: h.CONSULTANT_EMAIL } });
    expect(set.json.au_area.disagreement.message).toMatch(/automatic check says in a DPA; the value set by hand says not in a DPA/);
    expect(set.json.au_area.disagreement.lookup.at).toBeTruthy();
    expect(set.json.au_area.disagreement.manual.at).toBeTruthy();
    expect(jobsFor(id)[0]).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM2' });
    expect(audit('admin_au_practice_area_manual').filter((r) => r.target_id === id)[0].detail).toMatchObject({ before: { dpa: 'yes' }, after: { dpa: 'no', set_by: 'staff' }, reason: 'Confirmed with the Department by phone' });

    // a re-check does not overwrite it
    const re = await act(id, { action: 'recheck' });
    expect(re.json.outcome).toBe('disagreed');
    expect(re.json.au_area).toMatchObject({ status: 'no', setBy: 'staff' });
    expect(practiceById(id).metadata.au_area.manual.dpa).toBe('no');
    expect(jobsFor(id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });

    const cleared = await act(id, { action: 'clear_manual' });
    expect(cleared.json.outcome).toBe('hand_value_removed');
    expect(cleared.json.au_area).toMatchObject({ status: 'yes', mmm: 3, setBy: 'lookup', disagreement: null });
    expect(jobsFor(id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
  });

  it('who may use it: the CEO and consultants; not an RSO, not a signed-out visitor', async () => {
    const w = await walk('Access', DUBBO, { stopAfterSave: true });
    expect((await act(w.practice.id, { action: 'recheck' }, h.rso())).status).not.toBe(200);
    expect((await act(w.practice.id, { action: 'recheck' }, {})).status).not.toBe(200);
    expect((await jobAct('nope', { action: 'recheck' }, h.rso())).status).not.toBe(200);
    expect((await h.post('/api/ats/practices/area/check-all', {}, h.consultant())).status).not.toBe(200);
    expect((await h.post('/api/ats/practices/area/check-all', {}, h.rso())).status).not.toBe(200);
    expect((await act('name:Somewhere', { action: 'recheck' })).status).toBe(400);
    expect((await act(crypto.randomUUID(), { action: 'recheck' })).status).toBe(404);
    expect((await act(w.practice.id, { action: 'explode' })).status).toBe(400);
  });
});

describe('staff: the job screen', () => {
  it('a value changed in the job editor is a value set by hand on that role: attributed, kept, and only disagreed with afterwards', async () => {
    const w = await walk('Job Manual', DUBBO, { approve: true });
    const jobId = w.job.id;
    const res = await patchJob(jobId, { dpa_status: 'no', au_area_reason: 'This role is at the branch surgery' });
    expect(res.status).toBe(200);
    expect(res.json.editor.au_area.role).toMatchObject({ status: 'no', follows: false, basis: 'Set by hand on this role by ' + h.SUPER_EMAIL });
    expect(res.json.editor.au_area.role.manual).toMatchObject({ dpa: 'no', reason: 'This role is at the branch surgery', by: h.SUPER_EMAIL });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });
    expect(audit('admin_au_role_area_manual').filter((r) => r.target_id === String(jobId)).length).toBe(1);

    const re = await act(w.practice.id, { action: 'recheck' });
    expect(re.json.roles).toMatchObject({ manual_kept: 1, applied: 0 });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });
    expect(re.json.au_area_roles[String(jobId)].disagreement.message).toMatch(/automatic check says in a DPA; the value set by hand on this role says not in a DPA/);

    // "Use the check's answer" lifts the hand-set value
    const use = await jobAct(jobId, { action: 'use_lookup' });
    expect(use.status).toBe(200);
    expect(use.json.editor.au_area.role).toMatchObject({ status: 'yes', follows: true, manual: null, disagreement: null });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    // nothing to settle now
    expect((await jobAct(jobId, { action: 'use_lookup' })).status).toBe(409);
  });

  it('saving a job without touching the area fields does not mark it as set by hand', async () => {
    const w = await walk('Job Untouched', DUBBO);
    const res = await patchJob(w.job.id, { summary: 'An updated summary (FAKE).' });
    expect(res.status).toBe(200);
    expect(res.json.editor.au_area.role).toMatchObject({ follows: true, manual: null });
    expect(audit('admin_au_role_area_manual').filter((r) => r.target_id === String(w.job.id))).toEqual([]);
  });

  it('a role moved to a different address is classified on ITS address, not the practice\'s', async () => {
    const w = await walk('Job Moved', DUBBO, { approve: true });
    const res = await patchJob(w.job.id, { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta' });
    expect(res.status).toBe(200);
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(job.source_payload.au_area).toMatchObject({ follows: true, site: 'own' });
    expect(job.source_payload.au_area.own.lookup).toMatchObject({ dpa: 'no', confidence: 'exact' });
    expect(res.json.editor.au_area.role).toMatchObject({ site: 'own', basis: 'Checked on this role\'s own address' });
    // the practice itself is untouched, and a practice re-check does not pull the role back
    expect(practiceById(w.practice.id).metadata.au_area.lookup.dpa).toBe('yes');
    await act(w.practice.id, { action: 'recheck' });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });
  });

  it('a role recorded before the check that DIFFERS is flagged, not changed; staff keep it (with a reason) or take the check\'s answer', async () => {
    const w = await walk('Legacy', DUBBO, { stopAfterSave: true });
    const legacy = (key) => {
      const row = { id: crypto.randomUUID(), provider: 'internal_ats', provider_role_id: 'ats_wp30legacy' + key + seq, title: 'WP30 legacy role ' + key + ' (FAKE)', masked_title: 'Non-DPA - Dubbo - Bulk Billing',
        practice_name: w.practice.name, practice_id: w.practice.id, location_city: 'Dubbo', location_state: 'NSW', suburb: 'Dubbo', address: '',
        billing_model: 'bulk', dpa: false, mmm: 'MM3', is_active: true, job_status: 'open', approval_status: 'approved', source_payload: {}, created_at: NOW, updated_at: NOW };
      rows('career_roles').push(row);
      return row;
    };
    const a = legacy('A'); const b = legacy('B');
    const re = await act(w.practice.id, { action: 'recheck' });
    expect(re.json.roles).toMatchObject({ roles: 2, disagreements: 2, applied: 0 });
    for (const r of [a, b]) {
      const row = rows('career_roles').filter((x) => x.id === r.id)[0];
      expect(row).toMatchObject({ dpa: false, mmm: 'MM3' });
      expect(row.dpa_status == null).toBe(true);
      expect(row.source_payload.au_area.disagreement).toMatchObject({ kind: 'recorded_before', lookup: { dpa: 'yes' }, recorded: { dpa: 'no' } });
    }
    expect(audit('admin_au_role_area_disagreement').length).toBeGreaterThanOrEqual(2);

    expect((await jobAct(a.id, { action: 'keep', reason: 'no' })).status).toBe(400);
    const kept = await jobAct(a.id, { action: 'keep', reason: 'The practice confirmed in writing' }, h.consultant());
    expect(kept.status).toBe(200);
    expect(kept.json.editor.au_area.role.manual).toMatchObject({ dpa: 'no', by: h.CONSULTANT_EMAIL, reason: 'The practice confirmed in writing' });
    expect(rows('career_roles').filter((x) => x.id === a.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });

    const used = await jobAct(b.id, { action: 'use_lookup' });
    expect(used.status).toBe(200);
    const bRow = rows('career_roles').filter((x) => x.id === b.id)[0];
    expect(bRow).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(bRow.masked_title).toMatch(/^DPA - /);
    expect(bRow.source_payload.au_area).toMatchObject({ follows: true, disagreement: null });
  });

  it('a job staff add for another address of the same practice is checked on that address', async () => {
    const w = await walk('Second Site', DUBBO, { stopAfterSave: true });
    const intake = Object.assign(parity.intakeClinic('metro'), { practice_name: w.practice.name }, PARRA, { dpa: 'no', mmm: '' });
    delete intake.latitude; delete intake.longitude; delete intake.google_place_id; delete intake.dpa_suggested; delete intake.postcode;
    const res = await h.post('/api/ats/jobs', { practice_id: w.practice.id, intake }, h.superAdmin());
    expect(res.status).toBe(200);
    const job = jobsFor(w.practice.id).filter((j) => j.suburb === 'Parramatta')[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(job.source_payload.au_area).toMatchObject({ site: 'own', follows: true });
  });
});

describe('a job added through the short staff form', () => {
  it('has no DPA field of its own, so it follows its practice from the start; with no provider it is created exactly as before', async () => {
    const w = await walk('Short Form', DUBBO, { stopAfterSave: true });
    const res = await h.post('/api/ats/jobs', { title: 'WP30 short-form role (FAKE)', practice_id: w.practice.id, city: 'Dubbo', state: 'NSW', billing: 'bulk', type: 'full_time' }, h.superAdmin());
    expect(res.status).toBe(200);
    const job = jobsFor(w.practice.id).filter((j) => j.title === 'WP30 short-form role (FAKE)')[0];
    expect(job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(job.source_payload.au_area).toMatchObject({ follows: true, site: 'practice', status: 'yes' });
    expect(job.masked_title).toMatch(/^DPA - /);
    // a practice nobody has checked: the job is created, labelled nothing, and will follow once the practice is checked
    const never = seedPractice('Short Form Never', { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', location_state: 'NSW', postcode: '2830' });
    await h.post('/api/ats/jobs', { title: 'WP30 short-form role 2 (FAKE)', practice_id: never.id, city: 'Dubbo', state: 'NSW', billing: 'bulk' }, h.superAdmin());
    let job2 = jobsFor(never.id)[0];
    expect(job2.dpa).not.toBe(true);
    expect(job2.source_payload.au_area).toMatchObject({ follows: true });
    await act(never.id, { action: 'recheck' });
    job2 = jobsFor(never.id)[0];
    expect(job2).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    // provider off
    setProvider(null);
    await h.post('/api/ats/jobs', { title: 'WP30 short-form role 3 (FAKE)', practice_id: w.practice.id, city: 'Dubbo', state: 'NSW', billing: 'bulk' }, h.superAdmin());
    const job3 = jobsFor(w.practice.id).filter((j) => j.title === 'WP30 short-form role 3 (FAKE)')[0];
    expect(job3.dpa).not.toBe(true);
    expect(job3.dpa_status == null).toBe(true);
    expect(job3.source_payload == null || job3.source_payload.au_area === undefined).toBe(true);
  });
});

describe('Check all practices', () => {
  it('walks every practice, returns a summary, never overwrites a value set by hand, and a second run writes nothing to any role', async () => {
    rows('practices').length = 0; rows('career_roles').length = 0;
    const exact = await walk('All Exact', DUBBO, { approve: true });
    const metro = await walk('All Metro', PARRA, { approve: true });
    const vague = await walk('All Vague', DUBBO_SUBURB_ONLY);
    const hand = await walk('All Hand', DUBBO, { approve: true });
    await act(hand.practice.id, { action: 'manual', dpa: 'no', reason: 'Confirmed by the practice in writing' });
    const never = seedPractice('All Never', { address: '5 Sample Road', suburb: 'Tennant Creek', location_state: 'NT', postcode: '0860' });
    const empty = seedPractice('All Empty');
    const loose = { id: crypto.randomUUID(), provider: 'internal_ats', provider_role_id: 'ats_wp30loose' + seq, title: 'WP30 loose role (FAKE)', practice_name: 'WP30 No Record Practice (FAKE)', practice_id: null,
      location_city: 'Dubbo', location_state: 'NSW', suburb: 'Dubbo', address: '2 Test Road, Dubbo NSW 2830', dpa: false, dpa_status: 'unknown', mmm: '', is_active: true, job_status: 'open', approval_status: 'approved', source_payload: {}, created_at: NOW, updated_at: NOW };
    rows('career_roles').push(loose);

    async function runAll() {
      const items = []; let cursor = ''; let calls = 0;
      for (;;) {
        const res = await h.post('/api/ats/practices/area/check-all', { cursor, limit: 2 }, h.superAdmin());
        expect(res.status).toBe(200);
        calls += 1;
        items.push(...res.json.items);
        if (res.json.done) break;
        cursor = res.json.next_cursor;
        expect(calls).toBeLessThan(30);
      }
      return items;
    }
    const first = await runAll();
    const by = (id) => first.filter((it) => String(it.id) === String(id))[0];
    expect(first.filter((it) => it.kind === 'practice').length).toBe(6);
    expect(by(exact.practice.id)).toMatchObject({ outcome: 'unchanged', status: 'yes' });
    expect(by(metro.practice.id)).toMatchObject({ outcome: 'unchanged', status: 'no' });
    expect(by(vague.practice.id)).toMatchObject({ outcome: 'not_confident', status: 'unknown' });
    expect(by(hand.practice.id)).toMatchObject({ outcome: 'disagreed', status: 'no' });
    expect(by(never.id)).toMatchObject({ outcome: 'changed', status: 'yes', mmmLabel: 'Very remote community (MM 7)' });
    expect(by(empty.id)).toMatchObject({ outcome: 'failed', status: 'unknown' });
    expect(by(loose.id)).toMatchObject({ kind: 'role', outcome: 'applied' });
    // the hand-set practice and its role are exactly as staff left them
    expect(practiceById(hand.practice.id).metadata.au_area.manual).toMatchObject({ dpa: 'no', reason: 'Confirmed by the practice in writing' });
    expect(jobsFor(hand.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });
    expect(rows('career_roles').filter((r) => r.id === loose.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(audit('admin_au_practice_area_check_all').length).toBeGreaterThan(0);

    const rolesBefore = JSON.parse(JSON.stringify(rows('career_roles')));
    h.emu.reset();
    const second = await runAll();
    expect(second.filter((it) => it.kind === 'practice').map((it) => it.outcome).sort()).toEqual(['disagreed', 'failed', 'not_confident', 'unchanged', 'unchanged', 'unchanged']);
    expect(h.emu.requestsTo('career_roles').filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(JSON.parse(JSON.stringify(rows('career_roles')))).toEqual(rolesBefore);
  }, 30000);
});

describe('doctors: what they are shown follows the pinned status, through the existing role fields only', () => {
  it('a doctor restricted to priority areas sees the role only while its practice is known to be in one', async () => {
    const w = await walk('Visibility', DUBBO, { approve: true });
    const restricted = addDoctor('au_vr', { credentials: RESTRICTED_19AB });
    const overseas = addDoctor('overseas_null');
    const cleared = addDoctor('au_vr');
    const job = () => jobsFor(w.practice.id)[0];

    expect((await seenBy(restricted, job())).qualifies).toBe(true);
    expect((await seenBy(overseas, job())).qualifies).toBe(true);
    const facts = (await seenBy(cleared, job())).auFacts;
    expect(facts).toMatchObject({ mmm: 3, area: 'regional', dpa: 'yes' });

    await act(w.practice.id, { action: 'manual', dpa: 'unknown', reason: 'The boundary is being re-drawn' });
    expect(job()).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(await seenBy(restricted, job())).toMatchObject({ blurred: true, qualifies: false });
    expect(await seenBy(overseas, job())).toMatchObject({ blurred: true, qualifies: false });
    expect((await seenBy(cleared, job())).qualifies).toBe(true);

    await act(w.practice.id, { action: 'manual', dpa: 'no', reason: 'Confirmed not in a priority area' });
    expect(await seenBy(restricted, job())).toMatchObject({ blurred: true, qualifies: false, qualifyReason: 'dpa_restricted' });
    expect((await seenBy(cleared, job())).qualifies).toBe(true);

    await act(w.practice.id, { action: 'clear_manual' });
    expect(job()).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect((await seenBy(restricted, job())).qualifies).toBe(true);
    expect((await seenBy(overseas, job())).qualifies).toBe(true);
  });

  it('an overseas doctor\'s role payload gains no key', async () => {
    const w = await walk('Payload', DUBBO, { approve: true });
    const overseas = addDoctor('overseas_null');
    const on = await seenBy(overseas, w.job);
    setProvider(null);
    const none = await seenBy(overseas, w.job);
    expect(Object.keys(on).sort()).toEqual(Object.keys(none).sort());
    expect(on.auFacts).toBeUndefined();
    expect(JSON.stringify(on)).not.toMatch(/au_area|Modified Monash/);
  });
});
