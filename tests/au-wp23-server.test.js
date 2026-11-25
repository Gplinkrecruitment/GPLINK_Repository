// Australian GP build, WP-23: a metro practice outside a Distribution Priority
// Area goes from the website lead form to a published role, through the real
// server and the in-memory database stub. Then: who can see that role.
//
// Every identity is fake. Emails go to a local recorder; nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const parity = require('./helpers/au-wp23-parity.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const careerIntro = require('../lib/career-intro.js');
const auMessages = require('../lib/au-messages.js');

const ROOT = path.join(__dirname, '..');
const NOW = new Date().toISOString();
const STAFF = 'staff.test@gplink-test.local';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const WP09_AGREED = { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION };
const UNCONFIRMED_19AB = { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null };
// WP-29 (deliberate): the doctor's own "no" (UNCONFIRMED_19AB) now opens their
// own view of roles outside a DPA. The doctor who must still fail closed is the
// one who is "not sure" and whom staff have not confirmed.
const UNSURE_19AB = { moratorium_19ab_status: 'unsure', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null };
const STAFF_NO_19AB = { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW };

const VR_ONLY = { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false };
const auAnswers = (over) => Object.assign({ gp_types: Object.assign({}, VR_ONLY), dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine', 'Mental health'] }, over || {});

let h;
let seq = 0;
const rows = (table) => h.emu.table(table);
const practiceByEmail = (email) => rows('practices').filter((p) => p.contact_email === email)[0] || null;
const jobFor = (practiceId) => rows('career_roles').filter((j) => j.practice_id === practiceId)[0] || null;
const publicId = (job) => 'internal_ats:' + job.provider_role_id;

function addDoctor(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'p' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const careerRoles = (d) => h.get('/api/career/roles', { cookie: d.cookie });
const careerRole = (d, id) => h.get('/api/career/role?id=' + encodeURIComponent(id), { cookie: d.cookie });
const apply = (d, roleId) => h.post('/api/career/apply', /^au_/.test(d.kind) ? { roleId, shareConsent: WP09_AGREED } : { roleId }, { cookie: d.cookie });

/** Lead form -> intake -> sign -> (optionally) approve. Returns the rows. */
async function walkPractice(key, opts) {
  const o = opts || {};
  const lead = Object.assign(parity.websiteLead('metro', o.leadDpa), {
    practice_name: 'Test ' + key + ' Practice (FAKE)',
    contact_email: 'practice.' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.test@gplink-test.local',
    contact_phone: '0400 111 ' + String(100 + seq + rows('practices').length).slice(-3)
  });
  if (o.leadDpa === undefined) delete lead.dpa;
  const leadRes = await h.post('/api/public/practice-lead', lead);
  await parity.settle(h);
  const afterLead = JSON.parse(JSON.stringify(practiceByEmail(lead.contact_email)));
  const token = afterLead.intake_token;
  const clinic = Object.assign(parity.intakeClinic(o.clinicKind || 'metro'), { practice_name: 'Test ' + key + ' Practice (FAKE)' }, o.clinic || {});
  if (o.au !== null) clinic.au_gp = o.au || auAnswers();
  const save = await h.post('/api/practice-intake', { token, practices: [clinic] });
  const out = { lead, leadRes, afterLead, token, save };
  if (save.status !== 200 || o.stopAfterSave) return out;
  out.sign = await h.post('/api/practice-intake/sign', Object.assign(parity.signBody(token), { email: lead.contact_email }));
  await parity.settle(h);
  out.practice = practiceByEmail(lead.contact_email);
  out.job = jobFor(out.practice.id);
  out.emails = h.emails.map((c) => c.body);   // beforeEach clears the recorder
  if (o.approve && out.job) {
    out.job.header_image_url = 'https://images.gplink-test.local/' + key + '.jpg';
    out.approve = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(out.job.id), { action: 'approve' }, h.superAdmin());
    await parity.settle(h);
    out.job = jobFor(out.practice.id);
  }
  return out;
}

beforeAll(async () => {
  const tables = parity.parityTables();
  h = await bootLeadCopyServer({ name: 'wp23', mode: 'supabase', tables, emulator: parity.PARITY_EMULATOR, env: parity.PARITY_ENV });
});
afterAll(async () => { if (h) await h.closeAll(); });
beforeEach(() => { h.setSwitch(true); h.reset(); h.emu.forbid(null); });

describe('the website lead form records the area look-up in three states', () => {
  it('not in a DPA: the practice is created, invited, and nothing tells it that it does not qualify', async () => {
    const res = await h.post('/api/public/practice-lead', Object.assign(parity.websiteLead('metro', false), { contact_email: 'lead.no.test@gplink-test.local', practice_name: 'Test Lead No Practice (FAKE)' }));
    await parity.settle(h);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, emailed: true });
    const p = practiceByEmail('lead.no.test@gplink-test.local');
    expect(p.dpa).toBe(false);
    expect(p.metadata.dpa_lookup).toBe('no');
    expect(p.stage).toBe('prospective');
    expect(p.intake_token.length).toBeGreaterThan(16);
    const invite = h.emailsTo('lead.no.test@gplink-test.local')[0];
    expect(invite.subject).toBe('Your GP is waiting: complete your placement application');
    expect(invite.html).toContain(auMessages.INTAKE_AU_LINE);
    expect(invite.html).toContain('your practice does not need to be in a Distribution Priority Area to apply');
    expect(invite.html).toContain('/pages/practice-intake?token=' + encodeURIComponent(p.intake_token));
  });

  it('look-up failed or never ran: stored as unknown, never as "not a DPA"', async () => {
    for (const [i, dpa] of [undefined, null, 'no', 'false', 0].entries()) {
      const body = Object.assign(parity.websiteLead('unknown', undefined), { contact_email: 'lead.unknown' + i + '.test@gplink-test.local', practice_name: 'Test Lead Unknown ' + i + ' Practice (FAKE)' });
      if (dpa !== undefined) body.dpa = dpa;
      const res = await h.post('/api/public/practice-lead', body);
      expect(res.status).toBe(200);
      const p = practiceByEmail(body.contact_email);
      expect(p.dpa).toBe(null);
      expect(p.metadata.dpa_lookup).toBe('unknown');
      expect(JSON.stringify(p.metadata.website_lead)).not.toMatch(/"dpa":/);
    }
  });

  it('in a DPA: yes', async () => {
    await h.post('/api/public/practice-lead', Object.assign(parity.websiteLead('dpa', true), { contact_email: 'lead.yes.test@gplink-test.local', practice_name: 'Test Lead Yes Practice (FAKE)' }));
    const p = practiceByEmail('lead.yes.test@gplink-test.local');
    expect(p.dpa).toBe(true);
    expect(p.metadata.dpa_lookup).toBe('yes');
  });

  it('the Meta practice lead webhook is unchanged: no look-up key, a GP form id is still routed away', async () => {
    const res = await h.post('/api/webhooks/facebook-lead?secret=' + encodeURIComponent(parity.FB_SECRET), {
      lead_id: 'wp23-on-lead-1', form_id: 'practice-form-wp23', practice_name: 'Test Meta On Practice (FAKE)', contact_name: 'Sam Testowner',
      contact_email: 'meta.on.test@gplink-test.local', contact_phone: '0400 000 009', location: 'Parramatta', dpa: 'no'
    });
    expect(res.status).toBe(200);
    const p = practiceByEmail('meta.on.test@gplink-test.local');
    expect(res.json).toEqual({ ok: true, practice_id: p.id });
    expect(p.source).toBe('facebook_lead');
    expect(p.dpa).toBe(null);
    expect(p.metadata.dpa_lookup).toBeUndefined();
    expect(Object.keys(p.metadata).sort()).toEqual(['fb_lead', 'fb_raw', 'intake_email_last_sent_at']);
    const gp = await h.post('/api/webhooks/facebook-lead?secret=' + encodeURIComponent(parity.FB_SECRET), {
      lead_id: 'wp23-on-lead-2', form_id: 'gp-form-wp23', full_name: 'Dr Test Lead', email: 'gp.meta.on.test@gplink-test.local', phone_number: '+447700900124'
    });
    expect(gp.status).toBe(200);
    expect(practiceByEmail('gp.meta.on.test@gplink-test.local')).toBe(null);
  });
});

describe('the intake API validates the GP-types question', () => {
  let token;
  beforeAll(async () => {
    h.setSwitch(true);
    await h.post('/api/public/practice-lead', Object.assign(parity.websiteLead('metro', false), { contact_email: 'validate.test@gplink-test.local', practice_name: 'Test Validate Practice (FAKE)' }));
    token = practiceByEmail('validate.test@gplink-test.local').intake_token;
  });
  const post = (au, clinicOver) => h.post('/api/practice-intake', { token, practices: [Object.assign(parity.intakeClinic('metro'), { practice_name: 'Test Validate Practice (FAKE)' }, clinicOver || {}, { au_gp: au })] });

  it('the load response carries the look-up in three states, and only with the switch on', async () => {
    const on = await h.get('/api/practice-intake?token=' + encodeURIComponent(token));
    expect(on.json.practice.au_gp).toEqual({ dpa_lookup: 'no' });
    expect(on.json.practice.agreement_variant).toBe('standard');
    h.setSwitch(false);
    const off = await h.get('/api/practice-intake?token=' + encodeURIComponent(token));
    expect(off.json.practice.au_gp).toBeUndefined();
    const stripped = JSON.parse(JSON.stringify(on.json)); delete stripped.practice.au_gp;
    expect(off.json).toEqual(stripped);
  });

  const refused = [
    ['an unknown GP type', auAnswers({ gp_types: Object.assign({}, VR_ONLY, { locum: true }) })],
    ['a GP type that is not a boolean', auAnswers({ gp_types: Object.assign({}, VR_ONLY, { vr: 'yes' }) })],
    ['no GP type at all', auAnswers({ gp_types: { vr: false, non_vr: false, registrar: false, supervised: false, overseas: false } })],
    ['locum', auAnswers({ engagement_type: 'locum' })],
    ['sessions out of range', auAnswers({ sessions_max: 40 })],
    ['from more than to', auAnswers({ sessions_min: 10, sessions_max: 2 })],
    ['an interest that is not on the list', auAnswers({ special_interests: ['<script>'] })],
    ['a DPA answer that contradicts the yes / no', auAnswers({ dpa_answer: 'yes' })],
    ['an unknown key', Object.assign(auAnswers(), { fee: '0' })]
  ];
  for (const [name, au] of refused) {
    it('400 for ' + name + ', and nothing is stored', async () => {
      const res = await post(au);
      expect(res.status).toBe(400);
      expect(res.json.ok).toBe(false);
      expect(practiceByEmail('validate.test@gplink-test.local').metadata.intake).toBeUndefined();
    });
  }

  it('the two supervision answers cannot contradict each other', async () => {
    const a = await post(auAnswers(), { supervision_available: 'yes' });
    expect(a.status).toBe(400);
    expect(a.json.error).toMatch(/supervision disagree/);
    const b = await post(auAnswers({ gp_types: Object.assign({}, VR_ONLY, { supervised: true }) }), { supervision_available: '' });
    expect(b.status).toBe(400);
    const c = await post(auAnswers({ gp_types: Object.assign({}, VR_ONLY, { supervised: true }) }), { supervision_available: 'no' });
    expect(c.status).toBe(400);
    expect(practiceByEmail('validate.test@gplink-test.local').metadata.intake).toBeUndefined();
  });

  it('a valid answer is stored with the rest of the intake, in existing JSON', async () => {
    const res = await post(auAnswers());
    expect(res.status).toBe(200);
    const p = practiceByEmail('validate.test@gplink-test.local');
    expect(p.metadata.intake.au_gp).toEqual(auAnswers());
    expect(p.dpa).toBe(false);
    expect(p.dpa_suggested).toBe(false);
    expect(p.supervision_available).toBe(null);
  });
});

describe('a metro practice outside a DPA: lead form to published role', () => {
  let w;
  let job;
  beforeAll(async () => {
    h.setSwitch(true); h.reset();
    w = await walkPractice('Inner Metro', { leadDpa: false, approve: false });
    job = w.job;
  });

  it('every step answers 200 and the practice is active', () => {
    expect(w.leadRes.status).toBe(200);
    expect(w.afterLead.dpa).toBe(false);
    expect(w.afterLead.metadata.dpa_lookup).toBe('no');
    expect(w.save.status).toBe(200);
    expect(w.save.json).toMatchObject({ ok: true, practice_count: 1 });
    expect(w.sign.status).toBe(200);
    expect(w.sign.json).toMatchObject({ ok: true, practice_stage: 'active' });
    expect(w.practice).toMatchObject({ stage: 'active', agreement_status: 'signed', dpa: false });
    expect(w.practice.metadata.intake.au_gp).toEqual(auAnswers());
  });

  it('the agreement shown and signed is the existing standard 2026 agreement, even with the draft key on the row', async () => {
    const standard = fs.readFileSync(path.join(ROOT, 'assets/legal/gp-link-practice-agreement-2026.pdf'));
    const other = await walkPractice('Draft Key', { leadDpa: false, stopAfterSave: true });
    const row = practiceByEmail(other.lead.contact_email);
    row.metadata = Object.assign({}, row.metadata, { agreement_variant: 'au-2026-draft' });
    const load = await h.get('/api/practice-intake?token=' + encodeURIComponent(other.token));
    expect(load.json.practice.agreement_variant).toBe('standard');
    const pdf = await parity.rawGet(h, '/api/practice-intake/agreement?token=' + encodeURIComponent(other.token));
    expect(pdf.status).toBe(200);
    expect(sha(pdf.body)).toBe(sha(standard));
    // staff cannot mint a link for the draft either
    const link = await h.post('/api/ats/practice/sign-link', { id: row.id, variant: 'au-2026-draft' }, h.superAdmin());
    expect(link.status).toBe(400);
    expect(link.json.message).toBe('Unknown agreement variant.');
    expect(JSON.stringify(rows('practices'))).not.toContain('agreement-2026-au-draft');
  });

  it('the pending job already says who it is open to', () => {
    expect(job).toMatchObject({
      approval_status: 'pending', is_active: false, posted_by: 'practice_intake',
      title: 'Non-DPA - Surry Hills - Mixed Billing', dpa: false,
      vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false,
      engagement_type: 'permanent', sessions_min: 6, sessions_max: 10,
      special_interests: ['Skin cancer medicine', 'Mental health'], dpa_status: 'no'
    });
    expect(job.source_payload.intake.au_gp).toEqual(auAnswers());
    expect(job.source_payload.au_intake).toEqual({ dpa_lookup: 'no', dpa_status: 'no', dpa_reason: 'practice_and_lookup_agree', flags: [] });
    expect(w.sign.json.job_id).toBe(job.id);
  });

  it('what the practice is emailed after signing is right for a practice that will receive Australian-registered candidates', () => {
    const mine = w.emails.filter((b) => JSON.stringify(b.to).includes(w.lead.contact_email));
    const confirmation = mine.filter((b) => b.subject === 'Your signed GP Link agreement, welcome aboard')[0];
    expect(confirmation).toBeTruthy();
    expect(confirmation.attachments[0].filename).toBe('GP-Link-Recruitment-Services-Agreement-signed.pdf');
    for (const b of mine) {
      const text = String(b.html || '') + ' ' + String(b.text || '');
      // the invite keeps its paragraph about doctors moving country; everything after it is neutral
      if (b.subject !== 'Your GP is waiting: complete your placement application') {
        expect(text).not.toMatch(/visa|overseas|AHPRA registration|internationally trained|relocat/i);
      }
    }
  });

  it('staff see the GP types and the DPA status before they approve', async () => {
    const sa = h.superAdmin();
    const list = await h.get('/api/ats/practices', sa);
    const card = list.json.practices.filter((c) => c.id === w.practice.id)[0];
    expect(card.au_gp).toMatchObject({
      asked: true, accepted: ['Vocationally registered Australian GPs'],
      dpa: { status: 'no', label: 'Not in a DPA', practiceAnswer: 'no', lookup: 'no', disagreement: false },
      engagement: 'Permanent', sessions: '6 to 10 sessions a week', flags: []
    });
    const detail = await h.get('/api/ats/practice?id=' + encodeURIComponent(w.practice.id), sa);
    expect(detail.json.practice.au_gp.declined).toContain('Overseas-trained GPs moving to Australia');
    const editor = await h.get('/api/ats/job?id=' + encodeURIComponent(job.id), sa);
    expect(editor.json.editor.au_role_fields).toMatchObject({ vr_requirement: 'vr_required', dpa_status: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10 });
    expect(editor.json.editor.au_intake).toMatchObject({ accepted: ['Vocationally registered Australian GPs'], notes: [] });
    // a lead that has not filled the form yet still shows its DPA status
    const lead = list.json.practices.filter((c) => c.email === 'lead.unknown0.test@gplink-test.local')[0];
    expect(lead.au_gp).toMatchObject({ asked: false, dpa: { status: 'unknown', label: 'DPA: ask the practice' } });
  });

  it('approval needs the header photo (as today), then publishes and tells the practice', async () => {
    const sa = h.superAdmin();
    const refuse = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(job.id), { action: 'approve' }, sa);
    expect(refuse.status).toBe(400);
    job.header_image_url = 'https://images.gplink-test.local/surry-hills.jpg';
    const ok = await h.post('/api/ats/job/approve?id=' + encodeURIComponent(job.id), { action: 'approve' }, sa);
    await parity.settle(h);
    expect(ok.status).toBe(200);
    job = jobFor(w.practice.id);
    expect(job).toMatchObject({ approval_status: 'approved', is_active: true, vr_requirement: 'vr_required', dpa_status: 'no' });
    const live = h.emailsTo(w.lead.contact_email).filter((b) => /Your job is live/.test(b.subject))[0];
    expect(live).toBeTruthy();
    expect(live.html).toContain('now live to eligible doctors on GP Link');
    expect(String(live.html) + String(live.text)).not.toMatch(/visa|overseas|AHPRA|relocat/i);
    expect(careerIntro.auPracticeTextViolations(String(live.text || ''))).toEqual([]);
  });

  describe('who is offered the published role', () => {
    it('an au_vr doctor, staff-confirmed with 19AB cleared: listed, openable, with its facts, and can apply', async () => {
      const d = addDoctor('au_vr');
      const list = await careerRoles(d);
      const mine = list.json.roles.filter((r) => r.id === publicId(job))[0];
      expect(mine).toBeTruthy();
      expect(mine.qualifies).toBe(true);
      expect(mine.blurred).toBeFalsy();
      expect(mine.auFacts).toMatchObject({ vrRequirement: 'vr_required', vrRequirementStated: true, acceptsRegistrars: false, acceptsSupervised: false, engagementType: 'permanent', sessionsMin: 6, sessionsMax: 10, specialInterests: ['Skin cancer medicine', 'Mental health'], dpa: 'no', billingModel: 'mixed' });
      const one = await careerRole(d, publicId(job));
      expect(one.status).toBe(200);
      expect(one.json.role.qualifies).toBe(true);
      const applied = await apply(d, publicId(job));
      expect(applied.status).toBe(200);
      expect(rows('gp_applications').filter((a) => a.user_id === d.userId).map((a) => String(a.career_role_id))).toEqual([String(job.id)]);
    });

    // WP-29 (deliberate): "not yet staff-cleared" used to cover the doctor who
    // says "no". That doctor now sees the role on their own word (asserted at
    // the end); the one who is not sure still gets the stub and the refusal.
    it('an au_vr doctor who is not sure about 19AB and is not yet staff-cleared: a blurred stub, and apply is refused (fail closed)', async () => {
      const own = addDoctor('au_vr', { credentials: UNCONFIRMED_19AB });
      const ownList = await careerRoles(own);
      expect(ownList.json.roles.filter((r) => r.id === publicId(job))[0]).toMatchObject({ qualifies: true });
      expect(ownList.json.auAreaLimited).toBeUndefined();
      expect((await apply(own, publicId(job))).status).toBe(200);
      expect(await h.testUtils.resolveCandidatePathway(own.userId)).toMatchObject({ dpaRestricted: false, dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed' });

      const d = addDoctor('au_vr', { credentials: UNSURE_19AB });
      const list = await careerRoles(d);
      expect(list.json.auAreaLimited).toBe(true);
      const stub = list.json.roles.filter((r) => r.id === publicId(job))[0];
      expect(stub).toMatchObject({ blurred: true, qualifies: false, title: 'GP Opportunity', practiceName: 'Confidential practice', qualifyReason: 'dpa_restricted' });
      expect(list.raw).not.toContain('Surry Hills');
      const refused = await apply(d, publicId(job));
      expect(refused.status).toBe(403);
      expect(refused.json).toMatchObject({ error: 'not_qualified', code: 'dpa_restricted' });
    });

    it('an overseas doctor: today\'s blurred stub and today\'s exact refusal, switch on and off', async () => {
      const d = addDoctor('overseas_null');
      const on = await careerRoles(d);
      const stub = on.json.roles.filter((r) => r.id === publicId(job))[0];
      expect(stub).toMatchObject({ blurred: true, qualifies: false, title: 'GP Opportunity', practiceName: 'Confidential practice' });
      expect(on.raw).not.toMatch(/auFacts|Surry Hills/);
      const refused = await apply(d, publicId(job));
      expect(refused.status).toBe(403);
      expect(refused.raw).toBe(JSON.stringify({ ok: false, error: 'not_qualified', message: "You don't currently qualify for this role." }));
      h.setSwitch(false);
      const off = await careerRoles(d);
      expect(off.raw).toBe(on.raw);
    });

    it('an au_restricted doctor limited to DPA and an au_non_vr doctor: shown nothing, refused, and not eligible when staff look', async () => {
      const restricted = addDoctor('au_restricted');
      const nonVr = addDoctor('au_non_vr', { credentials: STAFF_NO_19AB });
      // WP-29 (deliberate): the standard segment B doctor is a vocationally
      // registered GP, so is no longer HELD. They are still shown nothing of
      // this role (it is outside a DPA: at most a blurred stub) and are still
      // refused. The held case is kept by a segment B doctor who is not VR.
      const restrictedNotVr = addDoctor('au_restricted', { credentials: { ahpra_registration_type: 'limited' } });
      {
        const list = await careerRoles(restricted);
        expect(list.json.auHold).toBeUndefined();
        expect(list.json.auAreaLimited).toBe(true);
        list.json.roles.filter((r) => r.id === publicId(job)).forEach((r) => expect(r).toMatchObject({ blurred: true, qualifies: false, practiceName: 'Confidential practice' }));
        expect(list.raw).not.toContain('Surry Hills');
        const refused = await apply(restricted, publicId(job));
        expect(refused.status).toBe(403);
        expect(refused.json.error).toBe('not_qualified');
        expect(rows('gp_applications').filter((a) => a.user_id === restricted.userId)).toEqual([]);
      }
      for (const d of [restrictedNotVr, nonVr]) {
        const list = await careerRoles(d);
        expect(list.json.roles).toEqual([]);
        expect(list.json.auHold).toEqual({ held: true, kind: 'review', title: 'Thanks, we have your details', message: 'Our team is confirming your details and will be in touch by email.' });
        const refused = await apply(d, publicId(job));
        expect(refused.status).toBe(403);
        expect(refused.json).toMatchObject({ error: 'pathway_on_hold', code: 'au_hold', auHoldKind: 'review' });
        expect(rows('gp_applications').filter((a) => a.user_id === d.userId)).toEqual([]);
      }
      const notVr = await h.get('/api/ats/candidate/role-eligibility?user_id=' + restrictedNotVr.userId + '&career_role_id=' + encodeURIComponent(job.id), h.superAdmin());
      expect(notVr.json).toMatchObject({ hold: true, hold_kind: 'review' });
      expect(notVr.json.roles[0].eligible).toBe(false);
      const sa = h.superAdmin();
      const b = await h.get('/api/ats/candidate/role-eligibility?user_id=' + restricted.userId + '&career_role_id=' + encodeURIComponent(job.id), sa);
      expect(b.json.roles[0].eligible).toBe(false);
      const c = await h.get('/api/ats/candidate/role-eligibility?user_id=' + nonVr.userId + '&career_role_id=' + encodeURIComponent(job.id), sa);
      expect(c.json.roles[0].eligible).toBe(false);
      expect(c.json.roles[0].reasons.map((r) => r.code)).toContain('vr_required');
    });
  });
});

describe('DPA "not sure" and a disagreement are "ask", flagged to staff, and closed to anyone limited to DPA roles', () => {
  it('not sure: the role is DPA unknown; a cleared au_vr sees it, a restricted au_vr and an overseas doctor do not', async () => {
    const w = await walkPractice('Unsure', { leadDpa: undefined, clinic: { dpa: 'no', dpa_suggested: null }, au: auAnswers({ dpa_answer: 'unsure' }), approve: true });
    expect(w.sign.status).toBe(200);
    expect(w.job).toMatchObject({ dpa: false, dpa_status: 'unknown', is_active: true });
    expect(w.job.source_payload.au_intake.flags.map((f) => f.code)).toEqual(['dpa_unknown']);
    const id = publicId(w.job);
    const cleared = addDoctor('au_vr');
    expect((await careerRoles(cleared)).json.roles.filter((r) => r.id === id)[0].qualifies).toBe(true);
    // WP-29 (deliberate): the restricted au_vr is the one who is "not sure" (see UNSURE_19AB).
    const restricted = addDoctor('au_vr', { credentials: UNSURE_19AB });
    const seen = (await careerRoles(restricted)).json.roles.filter((r) => r.id === id)[0];
    expect(seen.qualifies).toBe(false);
    // ...and so is a doctor staff have confirmed 19AB applies to, whatever the doctor says.
    const staffYes = addDoctor('au_vr', { credentials: { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: 'staff.test@gplink-test.local', moratorium_19ab_confirmed_at: new Date().toISOString() } });
    expect((await careerRoles(staffYes)).json.roles.filter((r) => r.id === id)[0].qualifies).toBe(false);
    expect((await apply(staffYes, id)).status).toBe(403);
    expect((await apply(restricted, id)).status).toBe(403);
    const overseas = addDoctor('overseas_null');
    expect((await careerRoles(overseas)).json.roles.filter((r) => r.id === id)[0].qualifies).toBe(false);
    const card = (await h.get('/api/ats/practices', h.superAdmin())).json.practices.filter((c) => c.id === w.practice.id)[0];
    expect(card.au_gp.dpa).toMatchObject({ status: 'unknown', label: 'DPA: ask the practice', practiceAnswer: 'unsure' });
    expect(card.au_gp.flags.length).toBe(1);
  });

  it('the practice says DPA, the look-up says not: stored as unknown and flagged; the overseas boolean is the practice\'s answer, as today', async () => {
    const w = await walkPractice('Disagree', {
      leadDpa: false,
      clinic: { dpa: 'yes', dpa_suggested: false },
      au: auAnswers({ dpa_answer: 'yes', gp_types: Object.assign({}, VR_ONLY, { overseas: true }) })
    });
    expect(w.sign.status).toBe(200);
    expect(w.practice).toMatchObject({ dpa: true, dpa_suggested: false, dpa_mismatch: true });
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'unknown', title: 'DPA - Surry Hills - Mixed Billing' });
    expect(w.job.source_payload.au_intake).toMatchObject({ dpa_lookup: 'no', dpa_status: 'unknown', dpa_reason: 'practice_and_lookup_disagree' });
    const editor = await h.get('/api/ats/job?id=' + encodeURIComponent(w.job.id), h.superAdmin());
    expect(editor.json.editor.au_intake.notes.length).toBe(1);
    expect(editor.json.editor.au_intake.notes[0]).toMatch(/official look-up says it is not in one/);
    // staff settle it in the job editor (WP-08)
    const patch = await h.request('PATCH', '/api/ats/job?id=' + encodeURIComponent(w.job.id), Object.assign({ body: { dpa_status: 'no' } }, h.superAdmin()));
    expect(patch.status).toBe(200);
    expect(jobFor(w.practice.id).dpa_status).toBe('no');
  });

  it('a DPA practice that accepts supervised doctors and non-VR GPs', async () => {
    const w = await walkPractice('Regional', {
      leadDpa: true, clinicKind: 'dpa',
      clinic: { supervision_available: 'yes' },
      au: auAnswers({ dpa_answer: 'yes', gp_types: { vr: true, non_vr: true, registrar: true, supervised: true, overseas: true }, engagement_type: 'contract', sessions_min: null, sessions_max: null, special_interests: [] })
    });
    expect(w.sign.status).toBe(200);
    expect(w.job).toMatchObject({ dpa: true, dpa_status: 'yes', vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true, engagement_type: 'contract', sessions_min: null, sessions_max: null, special_interests: [] });
    expect(w.practice.supervision_available).toBe(true);
  });

  it('an older copy of the page (no GP-types answer): saved as before, and the job gets exactly what WP-08 wrote', async () => {
    const w = await walkPractice('Old Page', { leadDpa: false, au: null });
    expect(w.save.status).toBe(200);
    expect(w.practice.metadata.intake.au_gp).toBeUndefined();
    expect(w.job.dpa_status).toBe('no');
    expect(w.job.vr_requirement).toBeUndefined();
    expect(w.job.source_payload.au_intake).toBeUndefined();
  });
});

describe('the public board (signed out): the role is listed with its facts and nothing names the practice', () => {
  it('lists the metro role, masked', async () => {
    const board = await h.get('/api/public/jobs?limit=100');
    expect(board.status).toBe(200);
    // Merged with WP-22: with the switch on the public board no longer shows the
    // internal role title ("Non-DPA - Surry Hills - Mixed Billing"); it shows a
    // doctor-facing one built from the role's facts. Find the role by its facts.
    const mine = board.json.jobs.filter((j) => j.suburb === 'Surry Hills' && j.location_state === 'NSW');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].title).not.toMatch(/Non-DPA/);
    expect(board.raw).not.toContain('Non-DPA - Surry Hills - Mixed Billing');
    expect(mine[0]).toMatchObject({ dpa: false, billing_model: 'mixed', suburb: 'Surry Hills', location_state: 'NSW', display_label: 'near Sydney', mmm: 'MM1' });
    expect(board.raw).not.toMatch(/Fake Street|practice_name|practice_id|contact_email|Pat Testmanager|Testmanager|au_gp|au_intake|source_payload|"address"/);
    for (const p of rows('practices')) {
      expect(board.raw, p.name).not.toContain(p.name);
      expect(board.raw).not.toContain(p.contact_email);
    }
    // the masked detail a signed-out visitor can open says no more
    const one = await h.get('/api/public/jobs?id=' + encodeURIComponent(mine[0].id));
    expect(one.raw).not.toMatch(/Fake Street|Testmanager|Test Inner Metro Practice/);
  });
});

describe('SWITCH OFF: the GP-types answer is ignored end to end', () => {
  it('a page that sends au_gp anyway: not validated, not stored, no role field written, no staff key', async () => {
    h.setSwitch(false);
    h.emu.reset();
    const w = await walkPractice('Switch Off', { leadDpa: false, au: { gp_types: { nonsense: 'x' }, dpa_answer: 'maybe' } });
    expect(w.afterLead.metadata.dpa_lookup).toBeUndefined();
    expect(w.save.status).toBe(200);
    expect(w.sign.status).toBe(200);
    expect(w.practice.metadata.intake.au_gp).toBeUndefined();
    expect(JSON.stringify(w.practice)).not.toMatch(/au_gp|dpa_lookup/);
    expect(w.job.source_payload.au_intake).toBeUndefined();
    expect(w.job.source_payload.intake.au_gp).toBeUndefined();
    for (const col of ['vr_requirement', 'accepts_registrars', 'accepts_supervised', 'engagement_type', 'sessions_min', 'sessions_max', 'special_interests', 'dpa_status']) {
      expect(Object.prototype.hasOwnProperty.call(w.job, col), col).toBe(false);
    }
    const named = h.emu.requests.filter((r) => /vr_requirement|dpa_status|accepts_registrars|sessions_min/.test(JSON.stringify(r)));
    expect(named).toEqual([]);
    const sa = h.superAdmin();
    const list = await h.get('/api/ats/practices', sa);
    expect(list.raw).not.toContain('au_gp');
    const detail = await h.get('/api/ats/practice?id=' + encodeURIComponent(w.practice.id), sa);
    expect(detail.raw).not.toContain('au_gp');
    const editor = await h.get('/api/ats/job?id=' + encodeURIComponent(w.job.id), sa);
    expect(editor.json.editor.au_role_fields).toBeUndefined();
    expect(editor.json.editor.au_intake).toBeUndefined();
    const invite = h.emailsTo(w.lead.contact_email).filter((b) => /Your GP is waiting/.test(b.subject))[0];
    expect(invite.html).not.toContain('already registered and working in Australia');
  });
});
