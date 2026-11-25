// Australian GP build, FR-9 (review round 12): the practice area check through
// the real server and the in-memory database stub, with the `fixture` provider
// (no network). Each test is the reviewer's reproduction of one finding and
// fails on the code before the fix.
//
// Every identity is fake. Nothing is sent; no test reaches the real locator.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const parity = require('./helpers/au-wp23-parity.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const locator = require('../lib/au-workforce-locator.js');
const areaLib = require('../lib/au-practice-area.js');

const NOW = new Date().toISOString();
const STAFF = 'staff.test@gplink-test.local';
const RESTRICTED_19AB = { moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW };

const DUBBO = { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', nearest_city: 'Dubbo', latitude: null, longitude: null, google_place_id: '' };
const NOWHERE = { address: '99 Nowhere Lane', suburb: 'Surry Hills', state: 'NSW', postcode: '2010' };   // the test map does not know it at all
const PARRA_SET = { address: '1 Test Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' };    // exact, NOT in a DPA
const DUBBO_SUBURB_SET = { address: '77 Other Street', suburb: 'Dubbo', state: 'NSW', postcode: '2830' }; // the suburb is found, the building is not

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
    id: crypto.randomUUID(), name: 'FR9 ' + key + ' Practice (FAKE)', contact_name: 'Pat Testmanager',
    contact_email: 'fr9.' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.' + seq + '@gplink-test.local', contact_phone: '0400 000 1' + String(10 + seq),
    stage: 'prospective', agreement_status: 'unsigned', source: 'manual', intake_token: crypto.randomBytes(24).toString('hex'),
    location_country: 'Australia', is_active: true, org_type: 'practice', metadata: {}, created_at: NOW, updated_at: NOW
  }, over || {});
  rows('practices').push(row);
  return row;
}
function clinicFor(key, place, lie) {
  const base = parity.intakeClinic('dpa');
  return Object.assign(base, { practice_name: 'FR9 ' + key + ' Practice (FAKE)', visa_sponsorship: '', supervision_available: '' }, place,
    { dpa: 'no', dpa_suggested: null, mmm: '' }, lie || {}, { au_gp: auAnswers(lie && lie.au_gp) });
}
const saveIntake = (practice, clinic) => h.post('/api/practice-intake', { token: practice.intake_token, practices: [clinic] });
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
  if (save.status !== 200) return out;
  out.sign = await sign(practice);
  out.practice = practiceById(practice.id);
  out.job = jobsFor(practice.id)[0] || null;
  if (o.approve !== false && out.job) {
    out.job.header_image_url = 'https://images.gplink-test.local/' + key.replace(/\s+/g, '-') + '.jpg';
    out.approve = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(out.job.id), { action: 'approve' }, h.superAdmin());
    await parity.settle(h);
    out.job = jobsFor(practice.id)[0];
  }
  return out;
}
function addDoctor(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'fr9' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const seenBy = async (d, job) => ((await h.get('/api/career/roles', { cookie: d.cookie })).json.roles || []).filter((r) => r.id === publicId(job))[0] || null;
const act = (id, body, as) => h.post('/api/ats/practice/area', Object.assign({ id }, body), as || h.superAdmin());
const patchJob = (id, body) => h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(id), Object.assign({ body }, h.superAdmin()));
const listCard = async (id) => ((await h.get('/api/ats/practices', h.superAdmin())).json.practices || []).filter((p) => p.id === id)[0] || null;
const detail = async (id) => (await h.get('/api/ats/practice?id=' + encodeURIComponent(id), h.superAdmin())).json.practice;

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'fr9area', mode: 'supabase', tables: parity.parityTables(), emulator: parity.PARITY_EMULATOR, env: parity.PARITY_ENV });
});
afterAll(async () => { setProvider(null); if (h) await h.closeAll(); });
beforeEach(() => {
  h.setSwitch(true); h.reset(); h.emu.forbid(null); setProvider('fixture');
  locator._resetForTests();
});

describe('M9-01: a role does not stay "In a DPA" after its address is changed to one the check cannot answer for', () => {
  it('THE REVIEWER\'S CASE: In a DPA (Dubbo) -> staff correct the address to one the map does not know -> not confirmed, and the doctors who may only work in a DPA are no longer offered it', async () => {
    const w = await walk('Move Unknown', DUBBO);
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(w.job.source_payload.au_area.address_key).toBeTruthy();
    const restricted = addDoctor('au_vr', { credentials: RESTRICTED_19AB });
    const overseas = addDoctor('overseas_null');
    expect((await seenBy(restricted, w.job)).qualifies).not.toBe(false);
    const overseasBefore = await seenBy(overseas, w.job);

    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, NOWHERE));
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('failed');
    const job = jobsFor(w.practice.id)[0];
    // the label that was about Dubbo is gone: not confirmed, no Modified Monash level, and the masked title no longer says DPA
    expect(job).toMatchObject({ dpa: false, dpa_status: 'unknown', mmm: '', suburb: 'Surry Hills' });   // '' not null: the real column is NOT NULL
    expect(job.masked_title).toMatch(/^Non-DPA - /);
    expect(job.source_payload.au_area).toMatchObject({ follows: true, status: 'unknown', set_by: 'none' });
    expect(res.json.roles).toMatchObject({ applied: 1 });
    // audited as an address change
    const logged = audit('admin_au_role_area_applied').filter((r) => r.target_id === String(job.id)).pop();
    expect(logged.detail).toMatchObject({ before: { dpa: 'yes' }, after: { dpa: 'unknown' }, address_changed: true, trigger: 'staff_address_changed' });
    // who is offered it now (the rule that decides is unchanged: it reads the role's own values)
    await parity.settle(h);
    const restrictedAfter = await seenBy(restricted, job);
    expect(restrictedAfter == null || restrictedAfter.qualifies === false).toBe(true);
    const overseasAfter = await seenBy(overseas, job);
    if (overseasBefore && overseasBefore.qualifies !== false) expect(overseasAfter == null || overseasAfter.qualifies === false).toBe(true);
    // and it is on the practice's to-do list, in words
    expect(res.json.au_area.needsPerson.map((n) => n.code)).toEqual(['not_confirmed']);
    // the practice reads "not confirmed" with what that hides (not "never checked"), and its own stored
    // answer, which was about the Dubbo address, no longer says yes
    expect(res.json.au_area).toMatchObject({ checked: false, movedUnanswered: true, status: 'unknown', label: 'DPA not confirmed', consequence: areaLib.UNKNOWN_CONSEQUENCE });
    expect(practiceById(w.practice.id)).toMatchObject({ dpa: false, dpa_suggested: null });
    expect(practiceById(w.practice.id).metadata.intake.au_gp.dpa_answer).toBe('unsure');
    expect((await listCard(w.practice.id)).au_area.needsPerson[0].message).toMatch(/its role is hidden from every doctor who may only work in a priority area/);
    // putting the right address back answers it again
    const back = await act(w.practice.id, { action: 'set_address', address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
    expect(back.status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(back.json.au_area.needsPerson).toEqual([]);
    expect(back.json.au_area.movedUnanswered).toBe(false);
    expect(practiceById(w.practice.id)).toMatchObject({ dpa: true, dpa_suggested: true });
  });

  it('the new address is only found to the suburb (approximate): not confirmed, never the old yes', async () => {
    const w = await walk('Move Approx', DUBBO);
    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, DUBBO_SUBURB_SET));
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('not_confident');
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(jobsFor(w.practice.id)[0].mmm).toBe('');
  });

  it('a "yes" set by hand on the PRACTICE does not survive an address change silently', async () => {
    const w = await walk('Hand Practice', DUBBO);
    expect((await act(w.practice.id, { action: 'manual', dpa: 'yes', mmm: 3, reason: 'Confirmed with the Department' })).status).toBe(200);
    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, NOWHERE));
    expect(res.status).toBe(200);
    expect(practiceById(w.practice.id).metadata.au_area.manual).toBe(null);
    expect(practiceById(w.practice.id).metadata.au_area.stale_manual).toMatchObject({ dpa: 'yes', by: h.SUPER_EMAIL });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(res.json.au_area.warnings.join(' ')).toMatch(/The address changed after .* set this by hand \(In a DPA, MM 3\)\. That value was for the old address, so it is no longer used\./);
    expect(res.json.au_area.needsPerson.map((n) => n.code).sort()).toEqual(['hand_value_put_aside', 'not_confirmed']);
    // a person sets it again FOR the new address: kept from then on, and off the list
    const again = await act(w.practice.id, { action: 'manual', dpa: 'yes', mmm: 3, reason: 'Checked the new address on the Locator' });
    expect(again.status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect(again.json.au_area.needsPerson).toEqual([]);
    const re = await act(w.practice.id, { action: 'recheck' });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect(re.json.au_area.manual).toMatchObject({ dpa: 'yes' });
  });

  it('a "yes" set by hand on the ROLE does not survive it either: the role becomes not confirmed and staff are shown a disagreement', async () => {
    const w = await walk('Hand Role', { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', postcode: '2150', nearest_city: 'Sydney', latitude: null, longitude: null, google_place_id: '' });
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'no' });
    expect((await patchJob(w.job.id, { dpa_status: 'yes', au_area_reason: 'The practice sent its DPA letter' })).status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect(jobsFor(w.practice.id)[0].source_payload.au_area.manual.address_key).toBeTruthy();
    // same address, checked again: kept (the rule that was already there)
    await act(w.practice.id, { action: 'recheck' });
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    // the address changes
    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, NOWHERE));
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(job.source_payload.au_area.manual).toBe(null);
    expect(job.source_payload.au_area.disagreement).toMatchObject({ kind: 'address_changed', recorded: { dpa: 'yes', by: h.SUPER_EMAIL } });
    expect(res.json.au_area_roles[String(job.id)].disagreement.message).toMatch(/The address changed after .* set this role by hand to in a DPA(, MM \d)?\. That value was for the old address, so it was not kept: the role is now not confirmed for the new address\./);
    const logged = audit('admin_au_role_area_applied').filter((r) => r.target_id === String(job.id)).pop();
    expect(logged.detail).toMatchObject({ address_changed: true, hand_value_put_aside: true });
  });

  it('a role whose label was typed before the check existed (the practice answered "yes" itself): the address is corrected to one nobody can answer for -> not confirmed', async () => {
    setProvider(null);                                   // the check is off: the practice is asked, as before WP-30
    const w = await walk('Legacy', DUBBO, { lie: { dpa: 'yes', dpa_suggested: true, au_gp: { dpa_answer: 'yes' } } });
    expect(w.job.dpa).toBe(true);
    expect(w.job.source_payload.au_area).toBeUndefined();
    setProvider('fixture');
    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, NOWHERE));
    expect(res.status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    // ...whereas a plain re-check of an UNCHANGED address that the check cannot answer never degrades a recorded value
    setProvider(null);
    const kept = await walk('Legacy Kept', Object.assign({}, DUBBO, { address: '77 Other Street, Dubbo NSW 2830' }), { lie: { dpa: 'yes', dpa_suggested: true, au_gp: { dpa_answer: 'yes' } } });
    setProvider('fixture');
    await act(kept.practice.id, { action: 'recheck' });
    expect(jobsFor(kept.practice.id)[0].dpa).toBe(true);
  });

  it('the practice re-submits its form with a different address the check cannot answer for: its role follows to not confirmed', async () => {
    const w = await walk('Repost', DUBBO);
    const again = await saveIntake(practiceById(w.practice.id), clinicFor('Repost', { address: '99 Nowhere Lane, Surry Hills NSW 2010', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', nearest_city: 'Sydney', latitude: null, longitude: null, google_place_id: '' }));
    expect(again.status).toBe(200);
    const job = jobsFor(w.practice.id)[0];
    // the role keeps its own (old) address, so it is at a different address from its practice now and is
    // checked on that: still Dubbo, still yes. What must NOT happen is a yes at an address nobody answered for.
    if (areaLib.roleSite(job, practiceById(w.practice.id)) === 'practice') expect(job).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    else expect(job).toMatchObject({ dpa: true, suburb: 'Dubbo' });
  });
});

describe('M9-02: a doctor opening a role page does not erase the role\'s area record', () => {
  it('THE REVIEWER\'S CASE: one role-page view, then an address correction: the role still follows it', async () => {
    const w = await walk('View Keeps', DUBBO);
    const doctor = addDoctor('au_vr');
    const before = jobsFor(w.practice.id)[0];
    expect(before.source_payload.au_area).toMatchObject({ follows: true, site: 'practice' });
    expect(before.source_payload.au_intake).toBeTruthy();
    const areaBefore = JSON.stringify(before.source_payload.au_area);
    const intakeBefore = JSON.stringify(before.source_payload.au_intake);

    h.emu.reset();
    const view = await h.get('/api/career/role?id=' + encodeURIComponent(publicId(before)), { cookie: doctor.cookie });
    expect(view.status).toBe(200);
    await parity.settle(h);
    // the page view DID write to the role (the enrichment that also runs on main): otherwise this test proves nothing
    const writes = h.emu.requests.filter((r) => r.table === 'career_roles' && r.method === 'PATCH' && r.body && r.body.source_payload);
    expect(writes.length).toBeGreaterThan(0);
    const after = jobsFor(w.practice.id)[0];
    expect(Object.keys(after.source_payload)).toContain('zoho');             // the rebuild happened
    expect(JSON.stringify(after.source_payload.au_area)).toBe(areaBefore);   // ...and the record is intact, byte for byte
    expect(JSON.stringify(after.source_payload.au_intake)).toBe(intakeBefore);
    expect(after.source_payload.zoho.au_area).toBeUndefined();               // no second, soon-stale copy
    // the consequence the reviewer showed: the role must still follow an address correction
    const res = await act(w.practice.id, Object.assign({ action: 'set_address' }, PARRA_SET));
    expect(res.status).toBe(200);
    const moved = jobsFor(w.practice.id)[0];
    expect(moved).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(moved.masked_title).toMatch(/^Non-DPA - /);
    expect(res.json.au_area_roles[String(moved.id)].disagreement).toBe(null);
    // and staff can still read what the practice told us on its form
    const editor = (await h.get('/api/ats/job?id=' + encodeURIComponent(moved.id), h.superAdmin())).json.editor;
    expect(editor.au_intake).toBeTruthy();
    expect(editor.au_area.role).toMatchObject({ follows: true, basis: 'Follows the practice' });
  });

  it('a hand-set marker and an unsettled disagreement survive a role-page view too', async () => {
    const w = await walk('View Hand', DUBBO);
    await patchJob(w.job.id, { dpa_status: 'no', au_area_reason: 'This role is at the branch surgery' });
    await act(w.practice.id, { action: 'recheck' });
    const before = jobsFor(w.practice.id)[0].source_payload.au_area;
    expect(before.manual).toMatchObject({ dpa: 'no' });
    expect(before.disagreement).toMatchObject({ kind: 'manual' });
    const doctor = addDoctor('au_vr');
    await h.get('/api/career/role?id=' + encodeURIComponent(publicId(jobsFor(w.practice.id)[0])), { cookie: doctor.cookie });
    await parity.settle(h);
    expect(jobsFor(w.practice.id)[0].source_payload.au_area).toEqual(before);
  });

  it('a role with neither record is written exactly as before (what main writes): { zoho, gpLink } and nothing else', async () => {
    const t = h.testUtils;
    const row = { provider: 'internal_ats', provider_role_id: 'ats_fr9_plain', source_payload: { intake: { a: 1 }, gpLink: { x: 1 } } };
    const bundle = { zoho: { intake: { a: 1 }, gpLink: { x: 1 } }, gpLink: { x: 1, y: 2 } };
    expect(t.keepAuOwnedSourcePayloadKeys(row, bundle)).toBe(bundle);     // the very same object: untouched
    const withArea = Object.assign({}, row, { source_payload: Object.assign({}, row.source_payload, { au_area: { follows: true } }) });
    const out = t.keepAuOwnedSourcePayloadKeys(withArea, { zoho: Object.assign({}, withArea.source_payload), gpLink: {} });
    expect(Object.keys(out).sort()).toEqual(['au_area', 'gpLink', 'zoho']);
    expect(out.au_area).toEqual({ follows: true });
    expect(out.zoho.au_area).toBeUndefined();
    expect(out.zoho.intake).toEqual({ a: 1 });
  });
});

describe('M9-05: a hand-crafted intake save cannot get a practice recorded "In a DPA" with a made-up map point', () => {
  it('T5: an unknown street in Dubbo + a browser point in Dubbo + a made-up place id -> not confirmed (it used to be recorded In a DPA, exact)', async () => {
    const p = seedPractice('Tamper Five');
    const save = await saveIntake(p, clinicFor('Tamper Five', { address: '99 Nowhere Lane, Dubbo, NSW, 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', nearest_city: 'Dubbo', latitude: -32.25, longitude: 148.6, google_place_id: 'made-up-by-the-browser' }));
    expect(save.status).toBe(200);
    const row = practiceById(p.id);
    expect(row.dpa).toBe(false);
    expect(row.dpa_suggested).toBe(null);
    expect(row.metadata.intake.au_gp.dpa_answer).toBe('unsure');
    expect(row.metadata.au_area.lookup).toMatchObject({ dpa: 'unknown', confidence: 'approximate', method: 'suburb_centroid' });
    expect(row.metadata.au_area.lookup.warnings).toContain('point_not_corroborated');
  });
  it('T10: an address nobody can find + a point in Dubbo + a place id -> not located, nothing recorded as yes', async () => {
    const p = seedPractice('Tamper Ten');
    const save = await saveIntake(p, clinicFor('Tamper Ten', { address: '1 Unknown Street, Surry Hills, NSW, 2010', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', nearest_city: 'Sydney', latitude: -32.2491, longitude: 148.6052, google_place_id: 'made-up' }));
    expect(save.status).toBe(200);
    const row = practiceById(p.id);
    expect(row.dpa).toBe(false);
    expect(row.metadata.au_area.lookup).toBe(null);
    expect(row.metadata.au_area.last_attempt).toMatchObject({ ok: false, error: 'address_not_located' });
  });
  it('an honest selected address (the server finds the same building) is still exact', async () => {
    const p = seedPractice('Honest Point');
    const save = await saveIntake(p, clinicFor('Honest Point', Object.assign({}, DUBBO, { latitude: -32.2569, longitude: 148.6011, google_place_id: 'place-1' })));
    expect(save.status).toBe(200);
    expect(practiceById(p.id).metadata.au_area.lookup).toMatchObject({ dpa: 'yes', confidence: 'exact', method: 'selected_address' });
  });
});

describe('M9-07: the job editor', () => {
  it('a hand-set value needs a reason: without one nothing is saved', async () => {
    const w = await walk('Editor Reason', DUBBO);
    for (const body of [{ dpa_status: 'no' }, { dpa_status: 'no', au_area_reason: 'ok' }, { mmm: 'MM5' }]) {
      const res = await patchJob(w.job.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toMatchObject({ ok: false, code: 'au_area_reason_required' });
      expect(res.json.message).toMatch(/Please say why you are setting this by hand/);
    }
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(audit('admin_au_role_area_manual').filter((r) => r.target_id === String(w.job.id))).toEqual([]);
    // an edit that does not touch the area needs no reason
    expect((await patchJob(w.job.id, { summary: 'An updated summary (FAKE).' })).status).toBe(200);
    // with the check OFF the editor is exactly what it was: no reason is asked for
    setProvider(null);
    expect((await patchJob(w.job.id, { dpa_status: 'no' })).status).toBe(200);
  });
  it('"Not recorded" hands the role back to the check: the check\'s answer is applied again and the role follows', async () => {
    const w = await walk('Editor Back', DUBBO);
    expect((await patchJob(w.job.id, { dpa_status: 'no', au_area_reason: 'This role is at the branch surgery' })).status).toBe(200);
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: false, dpa_status: 'no' });
    const res = await patchJob(w.job.id, { dpa_status: null });       // "Not recorded": no reason needed
    expect(res.status).toBe(200);
    const job = jobsFor(w.practice.id)[0];
    expect(job).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect(job.source_payload.au_area).toMatchObject({ follows: true, manual: null, disagreement: null, status: 'yes' });
    expect(res.json.editor.au_area.role).toMatchObject({ follows: true, basis: 'Follows the practice', manual: null });
  });
});

describe('M9-06 and M9-08: nothing waiting for a person is left sitting', () => {
  it('"This looks wrong" from the practice is an open item on the Practices list and the card until a named person marks it looked at', async () => {
    const w = await walk('Query', DUBBO);
    expect((await listCard(w.practice.id)).au_area.needsPerson).toEqual([]);
    const note = await h.post('/api/practice-intake/area-note', { token: w.practice.intake_token, note: 'We are on the other side of the river', clinic: 'Main clinic' });
    expect(note.status).toBe(200);
    const card = (await listCard(w.practice.id)).au_area;
    expect(card.disputes).toBe(1);
    expect(card.needsPerson).toEqual([{ code: 'practice_query', message: 'The practice told us its area looks wrong: "[Main clinic] We are on the other side of the river" Check it, then press "Mark as looked at".' }]);
    expect((await detail(w.practice.id)).au_area.needsPerson.map((n) => n.code)).toEqual(['practice_query']);
    // nothing about the area changed
    expect(jobsFor(w.practice.id)[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    // a consultant can settle it; it is recorded with their name
    const done = await act(w.practice.id, { action: 'dispute_done' });
    expect(done.status).toBe(200);
    expect(done.json.outcome).toBe('dispute_done');
    expect(practiceById(w.practice.id).metadata.au_area.disputes[0]).toMatchObject({ note: '[Main clinic] We are on the other side of the river', resolved_by: h.SUPER_EMAIL });
    expect((await listCard(w.practice.id)).au_area).toMatchObject({ disputes: 0, needsPerson: [] });
    expect(audit('admin_au_practice_area_dispute_looked_at').filter((r) => r.target_id === w.practice.id).length).toBe(1);
    expect((await act(w.practice.id, { action: 'dispute_done' })).status).toBe(409);
  });
  it('the practice is told what "not confirmed" means for its role (and never "this does not hold anything up")', async () => {
    const p = seedPractice('Told');
    const unsure = await h.post('/api/practice-intake/area', { token: p.intake_token, address: '77 Other Street', suburb: 'Dubbo', state: 'NSW' });
    expect(unsure.json.finding.note).toBe(areaLib.PRACTICE_UNKNOWN_NOTE);
    expect(unsure.json.finding.note).toMatch(/Until they have, your role is not shown to doctors who may only work in a priority area/);
    const yes = await h.post('/api/practice-intake/area', { token: p.intake_token, address: '2 Test Road', suburb: 'Dubbo', state: 'NSW' });
    expect(Object.keys(yes.json.finding).sort()).toEqual(['line', 'state']);
  });
  it('who is hidden did NOT change: a not-confirmed role is still shown to a doctor who may work anywhere and still closed to one who may not', async () => {
    const w = await walk('Still Hidden', Object.assign({}, DUBBO, { address: 'Dubbo NSW 2830' }));
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    const cleared = addDoctor('au_vr');
    const restricted = addDoctor('au_vr', { credentials: RESTRICTED_19AB });
    expect((await seenBy(cleared, w.job)).qualifies).not.toBe(false);
    const r = await seenBy(restricted, w.job);
    expect(r == null || r.qualifies === false).toBe(true);
    expect((await listCard(w.practice.id)).au_area.needsPerson.map((n) => n.code)).toEqual(['not_confirmed']);
  });
});

describe('M9-09: after the check is switched off; and a staff correction keeps the practice\'s own answers in step', () => {
  it('staff do not read "Practice answered: Not sure" about a practice that was never asked', async () => {
    const w = await walk('Off Unknown', Object.assign({}, DUBBO, { address: 'Dubbo NSW 2830' }));
    expect(w.practice.metadata.intake.au_gp.dpa_answer).toBe('unsure');     // the server's own derived value, not an answer
    setProvider(null);
    const card = await listCard(w.practice.id);
    expect(card.au_area).toBeUndefined();
    expect(card.au_gp.dpa).toMatchObject({ status: 'unknown', label: 'DPA not confirmed', practiceAnswer: '' });
    expect(card.au_gp.dpa.autoChecked.note).toMatch(/^Checked automatically on \d{4}-\d{2}-\d{2}; the check is now off$/);
    expect(card.au_gp.flags.map((f) => f.code)).not.toContain('dpa_unknown');
    const d = await detail(w.practice.id);
    expect(d.au_gp.dpa.practiceAnswer).toBe('');
    expect(d.au_gp.dpa.autoChecked.note).toMatch(/the check is now off/);
    const editor = (await h.get('/api/ats/job?id=' + encodeURIComponent(w.job.id), h.superAdmin())).json.editor;
    expect(editor.au_intake.dpa).toMatchObject({ status: 'unknown', practiceAnswer: '' });
    expect(editor.au_intake.dpa.autoChecked.note).toBe('Checked automatically; the check is now off');
    expect(editor.au_intake.notes.join(' ')).not.toMatch(/The practice was not sure/);
  });
  it('a practice that really WAS asked (the check was off when it answered) still reads as it always did', async () => {
    setProvider(null);
    const w = await walk('Off Asked', DUBBO, { lie: { dpa: 'no', dpa_suggested: null, au_gp: { dpa_answer: 'unsure' } } });
    const card = await listCard(w.practice.id);
    expect(card.au_gp.dpa.practiceAnswer).toBe('unsure');
    expect(card.au_gp.dpa.autoChecked).toBeUndefined();
  });
  it('the staff screens draw it', () => {
    const fs = require('fs'); const path = require('path');
    const practicesJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-practices.js'), 'latin1');
    expect(practicesJs).toContain("ATS.esc(a.dpa.autoChecked.note || 'Checked automatically; the check is now off')");
    expect(fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-jobs.js'), 'utf8')).toContain("if (a.dpa && a.dpa.autoChecked) lines.push(");
  });
  it('THE REVIEWER\'S CASE: the practice\'s own columns follow a staff correction (they used to keep the earlier not-confirmed answer)', async () => {
    const w = await walk('Columns', Object.assign({}, DUBBO, { address: '77 Other Street, Dubbo NSW 2830' }));
    expect(practiceById(w.practice.id)).toMatchObject({ dpa: false, dpa_suggested: null });
    const fixed = await act(w.practice.id, { action: 'set_address', address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
    expect(fixed.status).toBe(200);
    let p = practiceById(w.practice.id);
    expect(p).toMatchObject({ dpa: true, dpa_suggested: true, dpa_mismatch: false });
    expect(p.metadata.intake).toMatchObject({ dpa: true, mmm: 'MM3' });
    expect(p.metadata.intake.au_gp.dpa_answer).toBe('yes');
    expect(p.metadata.intake.practice_name).toBe('FR9 Columns Practice (FAKE)');   // nothing else in the answers moved
    // set by hand, and removed again
    await act(w.practice.id, { action: 'manual', dpa: 'no', reason: 'Boundary changed this year' });
    p = practiceById(w.practice.id);
    expect(p).toMatchObject({ dpa: false, dpa_suggested: false });
    expect(p.metadata.intake.au_gp.dpa_answer).toBe('no');
    await act(w.practice.id, { action: 'clear_manual' });
    expect(practiceById(w.practice.id)).toMatchObject({ dpa: true, dpa_suggested: true });
    // so with the check switched off afterwards, a new job takes the corrected answer
    setProvider(null);
    expect((await listCard(w.practice.id)).au_gp.dpa).toMatchObject({ status: 'yes', label: 'In a DPA' });
  });
  it('a failed check about which nothing is known does not touch what the practice had recorded', async () => {
    setProvider(null);
    const w = await walk('Columns Legacy', Object.assign({}, DUBBO, { address: '5 Mystery Close, Surry Hills NSW 2010', suburb: 'Surry Hills', postcode: '2010' }), { lie: { dpa: 'yes', dpa_suggested: true, au_gp: { dpa_answer: 'yes' } } });
    expect(practiceById(w.practice.id).dpa).toBe(true);
    setProvider('fixture');
    const re = await act(w.practice.id, { action: 'recheck' });
    expect(re.json.outcome).toBe('failed');
    expect(practiceById(w.practice.id).dpa).toBe(true);
    expect(practiceById(w.practice.id).metadata.intake.au_gp.dpa_answer).toBe('yes');
  });
});

describe('switch off, and the check off: nothing here exists', () => {
  it('the new staff action and the reason rule are not reachable', async () => {
    const w = await walk('Off', DUBBO);
    setProvider(null);
    expect((await act(w.practice.id, { action: 'dispute_done' })).status).not.toBe(200);
    h.setSwitch(false);
    expect((await act(w.practice.id, { action: 'dispute_done' })).status).not.toBe(200);
    const card = await listCard(w.practice.id);
    expect(card.au_gp).toBeUndefined();
    expect(card.au_area).toBeUndefined();
    expect((await patchJob(w.job.id, { dpa: false })).status).toBe(200);
  });
});
