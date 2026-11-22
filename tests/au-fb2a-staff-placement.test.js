// Australian GP build, fix bundle FB-2a: W3-D4 and W3-D16.
//
// W3-D4. Staff "Mark placement secured" on an application that was never
// submitted to the practice emailed the practice "Dr X has confirmed the
// placement", with no record that the doctor agreed to be named to it. For a
// doctor on an Australian pathway the placement is now recorded by staff only
// when the application was submitted to that practice with the doctor's
// agreement on file (WP-09), or with an explicit reason against the staff
// member's name; and the practice is told the truth about who recorded it.
//
// W3-D16. The "Offer / Contract" task of an Australian case: closed when the
// contract is signed in the app; recorded as not applicable (with the reason)
// for a staff-recorded placement that has no contract in the app; left open
// only when a contract is in the app and still to be signed.
//
// Overseas doctors, and everyone with the switch off: exactly as before.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_EMAIL } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const auMessages = require('../lib/au-placement-messages.js');
const { violations } = require('../lib/au-doctor-text.js');

let rig; let t; let seq = 0;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const CONSENT_KEYS = ['profile_share_consent_at', 'profile_share_consent_version', 'profile_share_consent_source', 'profile_share_consent_by', 'profile_share_consent_role_id'];
const REASON = 'Agreed by phone with the doctor and the practice manager on 20 Nov.';

function doctor(kind, opts) {
  seq += 1;
  const o = opts || {};
  const d = buildAuDoctor(kind || 'au_vr', { idSuffix: String(7400 + seq), profile: { phone: '+614008' + String(10000 + seq) } });
  rig.addDoctor(d);
  const app = rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d));
  if (o.notSubmitted) { app.submitted_to_practice_at = null; app.practice_submission_status = null; app.practice_decision = null; }
  if (o.noConsent) CONSENT_KEYS.forEach((k) => { delete app[k]; });
  if (o.noContract) {
    const contracts = rig.table('career_contracts');
    for (let i = contracts.length - 1; i >= 0; i--) if (contracts[i].application_id === app.id) contracts.splice(i, 1);
    const offer = rig.table('ats_offers').find((x) => x.application_id === app.id);
    if (offer) offer.contract_document_key = null;
  }
  return d;
}
const appOf = (d) => rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d));
const place = (d, body, who) => rig.post('/api/ats/placement', Object.assign({ applicationId: rig.appIdFor(d), commencementDate: '2027-02-01' }, body || {}), who || rig.consultant());
const settle = async () => { let last = -1; for (let i = 0; i < 200; i++) { const seen = rig.emu.requests.length + rig.emails.length; if (seen === last) return; last = seen; await new Promise((r) => setTimeout(r, 80)); } };
const practiceMail = (d) => rig.capture(d).emailsToPractice;
const contractTasks = (d) => rig.capture(d).tasks.filter((x) => x.task_type === 'practice_pack_child' && x.related_document_key === 'offer_contract');
const marker = (d) => rig.capture(d).timeline.filter((x) => String(x.title).indexOf('Placement recorded by staff') === 0);
const audit = (action) => rig.table('admin_audit_log').filter((a) => a.action === action);

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fb2a-d4', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } } }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); rig.resetRecorders(); });

describe('W3-D4: staff may record an Australian placement only when the practice knows the doctor with their agreement', () => {
  it('THE REPORTED CASE: never submitted, no consent -> 409, nothing recorded, nobody emailed', async () => {
    const d = doctor('au_vr', { notSubmitted: true, noConsent: true });
    const res = await place(d);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_placement_not_submitted', can_override: true, missing: ['not_submitted_to_practice', 'no_share_consent'] });
    expect(res.json.override_prompt).toMatch(/recorded against your name/);
    await settle();
    expect(appOf(d).status).toBe('offer');
    const cap = rig.capture(d);
    expect(cap.placements).toEqual([]);
    expect(cap.emailsToPractice).toEqual([]);
    expect(cap.emailsToDoctor).toEqual([]);
    expect(cap.caseStage).toBe('placement');
    expect(marker(d)).toEqual([]);
    expect(audit('ats_placement_refused').pop()).toMatchObject({ success: false });
  });

  it('submitted but no consent on file, and consent but never submitted: each refused, each named', async () => {
    const a = doctor('au_vr', { noConsent: true });
    expect((await place(a)).json).toMatchObject({ code: 'au_placement_not_submitted', missing: ['no_share_consent'] });
    const b = doctor('au_vr', { notSubmitted: true });
    expect((await place(b)).json).toMatchObject({ code: 'au_placement_not_submitted', missing: ['not_submitted_to_practice'] });
  });

  it('an override needs a real reason; with one the placement is recorded, audited, and the practice is told the truth', async () => {
    const d = doctor('au_vr', { notSubmitted: true, noConsent: true, noContract: true });
    expect((await place(d, { submission_override: true })).status).toBe(409);
    expect((await place(d, { submission_override: true, submission_override_reason: 'ok' })).status).toBe(409);
    expect((await place(d, { submission_override_reason: REASON })).status).toBe(409); // a reason without the explicit flag
    const res = await place(d, { submission_override: true, submission_override_reason: REASON });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await settle();
    const cap = rig.capture(d);
    expect(cap.caseStage).toBe('prestart');
    expect(cap.placements).toHaveLength(1);
    // The timeline says who, on what basis, and why.
    const line = marker(d);
    expect(line).toHaveLength(1);
    expect(line[0].actor).toBe(rig.CONSULTANT_EMAIL);
    expect(line[0].detail).toContain(REASON);
    expect(metaOf(line[0])).toMatchObject({ recorded_by_staff: true, basis: 'staff_override', override_reason: REASON });
    // So does the audit log.
    expect(audit('ats_placement_recorded').pop().detail).toMatchObject({ au_basis: 'staff_override', au_override_reason: REASON });
    // The practice is not told the doctor "confirmed" anything.
    const mails = practiceMail(d);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^Placement confirmed: Dr /);
    expect(mails[0].text).toMatch(/placement for .* at your practice is now recorded with GP Link\./);
    expect(mails[0].text + mails[0].html).not.toMatch(/has confirmed the placement/);
    // W3-D16: no contract in the app -> the contract task is not applicable, with the reason.
    const ct = contractTasks(d);
    expect(ct).toHaveLength(1);
    expect(ct[0].status).toBe('cancelled');
    expect(ct[0].title).toBe('Offer / Contract (not applicable: placement recorded by staff)');
    expect(metaOf(ct[0])).toMatchObject({ not_applicable: 'placement_recorded_by_staff', placement_key: rig.appIdFor(d) });
    expect(rig.capture(d).timeline.map((x) => x.title)).toContain('Contract task not applicable: placement recorded by staff');
  });

  it('the ordinary route (submitted, consent on file): no override is asked for; the wording is still truthful', async () => {
    const d = doctor('au_vr');
    const res = await place(d);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await settle();
    expect(metaOf(marker(d)[0])).toMatchObject({ basis: 'submitted_with_consent', override_reason: null });
    expect(practiceMail(d)[0].text).toMatch(/is now recorded with GP Link\./);
    // A contract is in the app, out for signature: its task stays open for the signed file.
    expect(contractTasks(d).map((x) => x.status)).toEqual(['open']);
  });

  it('the doctor signs in the app: the practice is told the doctor confirmed, and the contract task closes (W3-D16)', async () => {
    const d = doctor('au_vr');
    const res = await rig.place(d, 'finalize_signed');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await settle();
    expect(marker(d)).toEqual([]);
    expect(practiceMail(d).filter((m) => /^Placement confirmed/.test(m.subject))[0].text).toMatch(/has confirmed the placement/);
    expect(contractTasks(d).map((x) => x.status)).toEqual(['completed']);
  });

  it('the ops route applies the same rule', async () => {
    const d = doctor('au_vr', { notSubmitted: true, noConsent: true });
    const body = { application_id: rig.appIdFor(d), start_date: '2027-02-01', commencement_date: '2027-02-01' };
    expect((await rig.post('/api/admin/ops/record-placement', body, rig.superAdmin())).json).toMatchObject({ code: 'au_placement_not_submitted' });
    const ok = await rig.post('/api/admin/ops/record-placement', Object.assign({ submission_override: true, submission_override_reason: REASON }, body), rig.superAdmin());
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await settle();
    expect(metaOf(marker(d)[0])).toMatchObject({ basis: 'staff_override' });
  });

  it('the pathway cannot be read: a case that looks Australian is refused for now, nothing recorded', async () => {
    const d = doctor('au_vr', { notSubmitted: true, noConsent: true });
    rig.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'GET' && (r.select || []).indexOf('candidate_pathway') !== -1 ? 'pathway read forced to fail' : ''));
    const res = await place(d, { submission_override: true, submission_override_reason: REASON });
    rig.emu.forbid(null);
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('pathway_unreadable');
    expect(rig.capture(d).placements).toEqual([]);
  });
});

describe('OVERSEAS PARITY and the switch', () => {
  it('an overseas doctor, never submitted, no consent: recorded exactly as today, with today\'s practice email and no Australian line', async () => {
    const d = doctor('overseas_null', { notSubmitted: true, noConsent: true });
    const res = await place(d);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await settle();
    expect(marker(d)).toEqual([]);
    const mails = practiceMail(d);
    expect(mails.map((m) => m.subject)).toContain('Placement confirmed, Dr ' + d.name.replace(/^Dr\s+/, ''));
    expect(mails.map((m) => m.text).join('\n')).toMatch(/has confirmed the placement/);
    expect(audit('ats_placement_recorded').pop().detail).toEqual({ commencement_date: '2027-02-01', resume: false });
    expect(contractTasks(d).every((x) => !/not applicable/.test(x.title))).toBe(true);
  });

  it('switch OFF: a doctor stored as au_vr is an overseas doctor: no gate, nothing new asked', async () => {
    const d = doctor('au_vr', { notSubmitted: true, noConsent: true });
    rig.setSwitch(false);
    const res = await place(d);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await settle();
    expect(marker(d)).toEqual([]);
  });
});

describe('N12 wording', () => {
  it('both versions pass the practice-text and banned-word checks, and differ only in the opening sentence', () => {
    const base = { gpName: 'Test Auvr', roleTitle: 'General Practitioner', contactName: 'Test Manager', placementKey: 'k', startDate: '2027-02-01' };
    const signed = auMessages.buildPlacementConfirmedPracticeMessage(base);
    const staff = auMessages.buildPlacementConfirmedPracticeMessage(Object.assign({ recordedByStaff: true }, base));
    expect(signed.key).toBe(staff.key);            // the same once-per-placement key
    expect(signed.subject).toBe(staff.subject);
    expect(signed.text).toContain('Dr Test Auvr has confirmed the placement for General Practitioner at your practice.');
    expect(staff.text).toContain('Dr Test Auvr\'s placement for General Practitioner at your practice is now recorded with GP Link.');
    expect(staff.text.split('\n').slice(3)).toEqual(signed.text.split('\n').slice(3));
    for (const m of [signed, staff]) expect(violations(m.text + ' ' + m.bodyHtml.replace(/<[^>]+>/g, ' '))).toEqual([]);
  });
});
