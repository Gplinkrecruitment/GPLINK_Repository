// Australian GP build, WP-09, end to end against the real server and the
// in-memory database stub: what a practice receives about a doctor on an
// Australian pathway (email, WhatsApp, decision page), the WhatsApp fallback
// rule, and the per-practice consent gate. Both states of the switch.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor, wp08NewNameViolation, wp09NewNameViolation } = require('./helpers/au-fixtures.js');
const rigLib = require('./helpers/au-wp09-intro-rig.js');
const ci = require('../lib/career-intro.js');
const consent = require('../lib/profile-share-consent.js');

const NOW = '2026-11-01T00:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
const ROLE_PUBLIC_ID = 'internal_ats:ats_wp09_role';
const VERIFIED_C = { staff_verified_at: NOW, staff_verified_by: STAFF };
const VERIFIED_P = { register_status: 'verified', register_body: 'ahpra', register_number: 'MED0001000001' };
// Things that must never reach a practice, planted on every Australian doctor.
const SECRETS = { suburb: 'SECRET-SUBURB', employer: 'CURRENT-PRACTICE-SENTINEL', condition: 'CONDITION-TEXT-SENTINEL' };
const secretProfile = { current_suburb: SECRETS.suburb };
const secretCred = { visa_sponsor_name: SECRETS.employer };

const DOCTORS = {
  vr: buildAuDoctor('au_vr', { credentials: Object.assign({}, VERIFIED_C, secretCred), profile: Object.assign({}, VERIFIED_P, secretProfile, { current_state: 'NSW', available_from: '2027-02-01', notice_period_weeks: null }) }),
  vr_unverified: buildAuDoctor('au_vr', { idSuffix: '2', credentials: secretCred, profile: secretProfile }),
  vr_conditions: buildAuDoctor('au_vr', { idSuffix: '3', credentials: Object.assign({}, VERIFIED_C, secretCred, { has_conditions: true, conditions_text: SECRETS.condition, flags_reviewed_at: NOW, flags_reviewed_by: STAFF }), profile: Object.assign({}, VERIFIED_P, secretProfile) }),
  restricted: buildAuDoctor('au_restricted', { credentials: Object.assign({}, VERIFIED_C), profile: Object.assign({}, VERIFIED_P, secretProfile) }),
  restricted_supervised: buildAuDoctor('au_restricted', { idSuffix: '2', credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_1', visa_sponsor_name: SECRETS.employer }, profile: secretProfile }),
  non_vr: buildAuDoctor('au_non_vr', { credentials: secretCred, profile: secretProfile }),
  registrar: buildAuDoctor('au_registrar', { credentials: secretCred, profile: secretProfile }),
  // gate / apply doctors (no consent seeded)
  vr_gate: buildAuDoctor('au_vr', { idSuffix: '7', credentials: VERIFIED_C, profile: VERIFIED_P }),
  vr_apply: buildAuDoctor('au_vr', { idSuffix: '8', credentials: VERIFIED_C, profile: VERIFIED_P }),
  vr_match: buildAuDoctor('au_vr', { idSuffix: '9', credentials: VERIFIED_C, profile: VERIFIED_P }),
  uk: buildAuDoctor('overseas_null', { state: { gp_onboarding: { country: 'GB', completedAt: NOW, step: 5, targetDate: '2027-03', qualDocs: { mrcgp_cert: true } } } }),
  uk_apply: buildAuDoctor('overseas_null', { idSuffix: '8' })
};
const AU_INTRO_KEYS = ['vr', 'vr_unverified', 'vr_conditions', 'restricted', 'restricted_supervised', 'non_vr', 'registrar'];

let rig;
const rows = (t) => rig.emu.table(t);
const appRow = (d) => rows('gp_applications').filter((r) => r.id === rig.appIdFor(d))[0];
const audit = (action) => rows('admin_audit_log').filter((r) => r.action === action);
const consentFor = (d, source) => consent.buildConsentPatch({ source: source || 'doctor', application: { career_role_id: rigLib.ROLE_ID }, by: STAFF, now: NOW });
const withConsent = (d) => rig.resetApplication(d, consentFor(d));
const cookie = (d) => rig.gpCookie(d.email, d.userId);

/** Every string a practice could read from one introduction. */
function practiceFacing(out) {
  const e = out.email || {};
  return [e.subject, e.html, e.text, JSON.stringify(out.whatsapp || ''), JSON.stringify(out.decision || '')].join('\n');
}

beforeAll(async () => {
  const list = Object.keys(DOCTORS).map((k) => DOCTORS[k]);
  rig = await rigLib.bootIntroRig({
    name: 'wp09-server',
    doctors: list,
    tables: {
      user_documents: list.map((d) => ({
        id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf',
        country_code: 'AU', created_at: NOW, updated_at: NOW
      })),
      placements: [], candidate_leads: [], runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [],
      career_suburb_geo_cache: [], match_cache: [], career_contracts: []
    }
  });
  rig.setSwitch(true);
}, 60000);

afterAll(async () => { if (rig) await rig.close(); });

beforeEach(() => {
  delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;   // (WP-18) the owner's off switch never leaks between tests
  rig.setSwitch(true);
  delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
  rig.emu.missingColumns = {};
  rig.emu.forbid(null);
});

describe('WP-09: what the practice receives about a doctor on an Australian pathway', () => {
  it('au_vr, staff-verified: the Australian introduction in the email (html and text), and on the decision page', async () => {
    withConsent(DOCTORS.vr);
    const out = await rig.introduce(DOCTORS.vr);
    expect(out.status).toBe(200);
    expect(out.emails).toHaveLength(1);
    const para = 'Dr Test Auvr is a vocationally registered GP (FRACGP) based in New South Wales. '
      + 'GP Link has verified Dr Auvr’s Ahpra registration on the public register, so there is no registration wait. '
      + 'Dr Auvr is available from 1 February 2027.';
    expect(out.email.to).toEqual([rigLib.PRACTICE_EMAIL]);
    expect(out.email.subject).toBe('Candidate introduction: Dr Test Auvr — ' + rigLib.ROLE_TITLE);
    expect(out.email.text).toContain(para);
    expect(out.email.html).toContain(para.replace(/’/g, '’'));
    ['Vocationally registered GP (FRACGP)', 'Based in NSW', 'Ahpra registration verified', 'Available from 1 Feb 2027'].forEach((chip) => {
      expect(out.email.html).toContain(chip);
    });
    // the confidentiality line (consent draft D3), in both parts of the email
    expect(out.email.text).toContain('Dr Test Auvr has agreed to be introduced to your practice for this role only.');
    expect(out.email.html).toContain('do not contact their current practice');
    // decision page payload
    expect(out.decisionStatus).toBe(200);
    expect(out.decision.candidate.paragraph).toBe(para);
    expect(out.decision.candidate.facts.map((f) => f.label)).toEqual(['Vocationally registered GP (FRACGP)', 'Based in NSW', 'Ahpra registration verified', 'Available from 1 Feb 2027']);
    expect(out.decision.candidate.audience).toBe('au');
    expect(out.decision.candidate.nextSteps).toEqual([
      'Approve and choose a few interview times that suit your practice.',
      'Dr Auvr confirms one and you both receive a calendar invitation.',
      'After the interview we ask whether you would like to make an offer.',
      'If you both go ahead, the start date is agreed between you.'
    ]);
    expect(out.decision.candidate.confidentialityNote).toContain('If you do not proceed, please delete their CV.');
    // the row was stamped exactly as for any doctor
    expect(appRow(DOCTORS.vr)).toMatchObject({ practice_submission_status: 'submitted_to_practice', practice_contact_email: rigLib.PRACTICE_EMAIL });
  });

  AU_INTRO_KEYS.forEach((k) => {
    it(k + ': nothing banned, unverified, or private in the email, the WhatsApp slot or the decision payload', async () => {
      const d = DOCTORS[k];
      withConsent(d);
      const out = await rig.introduce(d);
      expect(out.status, JSON.stringify(out.json)).toBe(200);
      expect(out.emails).toHaveLength(1);
      const all = practiceFacing(out);
      expect(ci.auPracticeTextViolations(all.replace(/&mdash;|&rsquo;|&amp;|&ldquo;|&rdquo;/g, ' ').replace(/style="[^"]*"/g, ''))).toEqual([]);
      expect(all).not.toMatch(/internationally trained|Expedited Specialist|registration process|coming to Australia/i);
      expect(all).not.toContain(d.credentials.ahpra_number);
      expect(all).not.toMatch(/MED\d{10}/);
      expect(all).not.toContain(SECRETS.suburb);
      expect(all).not.toContain(SECRETS.employer);
      expect(all).not.toContain(SECRETS.condition);
      expect(all).not.toMatch(/AHPRA/);
      // the decision page carries the same paragraph the email does
      expect(out.email.text).toContain(out.decision.candidate.paragraph);
      // only a staff-verified doctor is ever called verified
      const verified = !!d.credentials.staff_verified_at && d.profile.register_status === 'verified';
      if (!verified) expect(all).not.toMatch(/registration verified|has verified/);
      if (d.profile.candidate_pathway !== 'au_vr') expect(all).not.toMatch(/vocationally registered GP \(|is a vocationally registered|no registration wait/);
    });
  });

  it('per-pathway facts on the decision page: restrictions are always shown for B and C', async () => {
    const chips = async (k) => { withConsent(DOCTORS[k]); return (await rig.introduce(DOCTORS[k])).decision.candidate.facts.map((f) => f.label); };
    // FR-1 (R-04): no "(FRACGP)" until staff have verified the registration.
    expect(await chips('vr_unverified')).toEqual(['Vocationally registered GP', 'Based in VIC', 'Ahpra verification in progress', 'About 4 weeks’ notice']);
    expect(await chips('vr_conditions')).toContain('Registration conditions: details on request');
    expect(await chips('restricted')).toEqual(['GP (FRACGP)', 'Based in WA', 'Ahpra registration verified', '19AB applies: DPA locations only', 'Right to work tied to an employer: details on request']);
    expect(await chips('restricted_supervised')).toEqual(expect.arrayContaining(['19AB applies: DPA locations only', 'Works under supervision']));
    expect(await chips('non_vr')).toEqual(['Non-VR GP', 'Based in QLD', 'Ahpra verification in progress', '19AB status being confirmed']);
    expect(await chips('registrar')).toEqual(['GP registrar', 'Based in SA', 'Ahpra verification in progress', '19AB status being confirmed', 'Works under supervision']);
  });

  it('a stored recommendation with banned wording is not shown on an Australian decision page', async () => {
    withConsent(DOCTORS.vr);
    await rig.introduce(DOCTORS.vr, { decision: false });
    appRow(DOCTORS.vr).ai_recommendation = 'Dr Auvr is relocating from overseas and needs a visa.';
    const res = await rig.get('/api/practice/application/decision-context?token=' + rig.tokenFor(DOCTORS.vr), { headers: { 'x-real-ip': '10.77.0.1' } });
    expect(res.json.candidate.recommendation).toBe('');
    appRow(DOCTORS.vr).ai_recommendation = 'Dr Auvr has a strong chronic disease interest.';
    const res2 = await rig.get('/api/practice/application/decision-context?token=' + rig.tokenFor(DOCTORS.vr), { headers: { 'x-real-ip': '10.77.0.2' } });
    expect(res2.json.candidate.recommendation).toBe('Dr Auvr has a strong chronic disease interest.');
  });

  it('the pathway cannot be read: nothing is sent (never the overseas wording as a guess)', async () => {
    withConsent(DOCTORS.vr);
    rig.emu.failTables.gp_credentials = 500;
    rig.emu.failTables.user_profiles = 0;
    try {
      // the profile pathway read works (Australian), the credentials read fails
      const out = await rig.introduce(DOCTORS.vr, { decision: false });
      expect(out.status).toBe(503);
      expect(out.json.code).toBe('pathway_unreadable');
      expect(out.emails).toHaveLength(0);
      expect(out.whatsapps).toHaveLength(0);
      expect(appRow(DOCTORS.vr).practice_submission_status).toBe('pending_va_submission');
      const dc = await rig.get('/api/practice/application/decision-context?token=' + rig.tokenFor(DOCTORS.vr), { headers: { 'x-real-ip': '10.77.0.3' } });
      expect(dc.status).toBe(200);
      expect(dc.json.candidate.paragraph).toBe('');
      expect(dc.json.candidate.facts).toEqual([]);
      expect(dc.raw).not.toMatch(/internationally trained|Expedited Specialist/);
    } finally {
      delete rig.emu.failTables.gp_credentials;
      delete rig.emu.failTables.user_profiles;
    }
  });
});

describe('WP-09: WhatsApp for an Australian doctor (P02)', () => {
  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4). This used to be the
  // DEFAULT ("no approved Australian template: email only"). The existing
  // practice templates have been read and are neutral, so by default the
  // WhatsApp now goes (next test). Email-only is what happens when the owner
  // switches the rows off, and the reason is still recorded.
  it('the practice rows switched off by config: email only, and the reason is recorded', async () => {
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'practice_intro,practice_intro_cv';
    withConsent(DOCTORS.vr);
    const out = await rig.introduce(DOCTORS.vr, { decision: false });
    expect(out.status).toBe(200);
    expect(out.emails).toHaveLength(1);
    expect(out.whatsapps).toHaveLength(0); // never through the overseas template
    expect(out.json.au_introduction).toEqual({ whatsapp: { sent: false, reason: 'au_template_not_approved' } });
    const ev = rows('task_timeline').filter((e) => /Candidate submitted to practice/.test(e.title || '')).pop();
    expect(ev.detail).toContain('No WhatsApp was sent: there is no approved Australian WhatsApp template yet');
  });

  // CHANGED DELIBERATELY BY WP-18: it used to need the setting and went through
  // a gp_link_au_* name. It now goes by default through the existing template,
  // confirmed neutral, with the same Australian values.
  it('the default: sent through the existing neutral template, carrying the Australian sentence', async () => {
    delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
    withConsent(DOCTORS.vr);
    const out = await rig.introduce(DOCTORS.vr, { decision: false });
    expect(out.status).toBe(200);
    expect(out.whatsapps).toHaveLength(1);
    expect(out.whatsapp.templateName).toMatch(/^gp_link_practice_candidate_intro(_cv)?$/);
    const ph = out.whatsapp.templateData.body.placeholders;
    expect(ph[0]).toBe('Test Manager');
    expect(ph[1]).toBe(rigLib.PRACTICE_NAME);
    expect(ph[2]).toContain('Dr Test Auvr is a vocationally registered GP (FRACGP) based in New South Wales.');
    expect(ci.auPracticeTextViolations(ph.join(' '))).toEqual([]);
    expect(out.whatsapp.templateData.buttons).toEqual([{ type: 'URL', parameter: rig.tokenFor(DOCTORS.vr) }]);
    expect(out.json.au_introduction.whatsapp).toEqual({ sent: true, template: out.whatsapp.templateName });
  });

  it('an overseas doctor still goes through today’s template, with today’s response', async () => {
    rig.resetApplication(DOCTORS.uk);
    const out = await rig.introduce(DOCTORS.uk, { decision: false });
    expect(out.status).toBe(200);
    expect(out.whatsapps).toHaveLength(1);
    expect(out.whatsapp.templateName).toBe('gp_link_practice_candidate_intro');
    expect(out.whatsapp.templateData.body.placeholders[2]).toContain('internationally trained GP from the United Kingdom');
    expect(Object.keys(out.json).sort()).toEqual(['application', 'ok', 'submission_mode']);
  });
});

describe('WP-09: consent before a profile goes to a practice (WEB-19)', () => {
  it('staff submit for an Australian doctor with no consent on file: 409, plain message, nothing sent, audited', async () => {
    rig.resetApplication(DOCTORS.vr_gate);
    const before = audit('admin_submit_to_practice_refused_no_consent').length;
    const out = await rig.introduce(DOCTORS.vr_gate, { decision: false });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ ok: false, code: 'profile_share_consent_required', can_record_verbal_consent: true });
    expect(out.json.message).toBe('This doctor has not agreed to be put forward to this practice yet, so nothing was sent. Ask them to apply from the role page, or record their verbal consent.');
    expect(out.emails).toHaveLength(0);
    expect(out.whatsapps).toHaveLength(0);
    expect(appRow(DOCTORS.vr_gate)).toMatchObject({ practice_submission_status: 'pending_va_submission', submitted_to_practice_at: null });
    const logged = audit('admin_submit_to_practice_refused_no_consent');
    expect(logged.length).toBe(before + 1);
    expect(logged[logged.length - 1]).toMatchObject({ success: false, target_id: rig.appIdFor(DOCTORS.vr_gate), actor_email: rig.SUPER_EMAIL });
  });

  it('a consent for a different role does not count', async () => {
    rig.resetApplication(DOCTORS.vr_gate, Object.assign({}, consentFor(DOCTORS.vr_gate), { profile_share_consent_role_id: '12345' }));
    const out = await rig.introduce(DOCTORS.vr_gate, { decision: false });
    expect(out.status).toBe(409);
    expect(out.emails).toHaveLength(0);
  });

  it('staff record a verbal consent (note required, audit-logged), then the submit goes through', async () => {
    rig.resetApplication(DOCTORS.vr_gate);
    const id = rig.appIdFor(DOCTORS.vr_gate);
    const staff = rig.consultant();
    const noNote = await rig.post('/api/admin/career/application/share-consent', { applicationId: id, note: ' ' }, staff);
    expect(noNote.status).toBe(400);
    expect(noNote.json.code).toBe('note_required');
    expect(appRow(DOCTORS.vr_gate).profile_share_consent_at).toBeUndefined();

    const before = audit('admin_record_profile_share_consent').length;
    const ok = await rig.post('/api/admin/career/application/share-consent', { applicationId: id, note: 'By phone, 20 Nov' }, staff);
    expect(ok.status).toBe(200);
    expect(ok.json.consent).toMatchObject({ source: 'staff_verbal', by: rig.CONSULTANT_EMAIL, version: consent.CONSENT_VERSION });
    expect(appRow(DOCTORS.vr_gate)).toMatchObject({
      profile_share_consent_source: 'staff_verbal', profile_share_consent_by: rig.CONSULTANT_EMAIL,
      profile_share_consent_version: consent.CONSENT_VERSION, profile_share_consent_role_id: String(rigLib.ROLE_ID)
    });
    expect(appRow(DOCTORS.vr_gate).profile_share_consent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const logged = audit('admin_record_profile_share_consent');
    expect(logged.length).toBe(before + 1);
    const entry = logged[logged.length - 1];
    expect(entry).toMatchObject({ success: true, actor_email: rig.CONSULTANT_EMAIL, target_type: 'application', target_id: id });
    const detail = typeof entry.detail === 'string' ? JSON.parse(entry.detail) : entry.detail;
    expect(detail).toMatchObject({ source: 'staff_verbal', note: 'By phone, 20 Nov', wording_version: consent.CONSENT_VERSION });
    expect(rows('task_timeline').some((e) => e.title === 'Verbal consent recorded' && /By phone, 20 Nov/.test(e.detail || ''))).toBe(true);

    const out = await rig.introduce(DOCTORS.vr_gate, { decision: false, staff });
    expect(out.status).toBe(200);
    expect(out.emails).toHaveLength(1);
  });

  it('the verbal-consent route: staff only, Australian doctors only, and gone with the switch off', async () => {
    const id = rig.appIdFor(DOCTORS.vr_gate);
    const anon = await rig.post('/api/admin/career/application/share-consent', { applicationId: id, note: 'By phone, 20 Nov' });
    expect([401, 403]).toContain(anon.status);
    const asDoctor = await rig.post('/api/admin/career/application/share-consent', { applicationId: id, note: 'By phone, 20 Nov' }, { cookie: cookie(DOCTORS.vr_gate) });
    expect([401, 403]).toContain(asDoctor.status);
    rig.resetApplication(DOCTORS.uk);
    const overseas = await rig.post('/api/admin/career/application/share-consent', { applicationId: rig.appIdFor(DOCTORS.uk), note: 'By phone, 20 Nov' }, rig.superAdmin());
    expect(overseas.status).toBe(409);
    expect(overseas.json.code).toBe('not_au_pathway');
    expect(appRow(DOCTORS.uk).profile_share_consent_at).toBeUndefined();
    const missing = await rig.post('/api/admin/career/application/share-consent', { applicationId: 'nope', note: 'By phone, 20 Nov' }, rig.superAdmin());
    expect(missing.status).toBe(404);
    rig.setSwitch(false);
    const off = await rig.post('/api/admin/career/application/share-consent', { applicationId: id, note: 'By phone, 20 Nov' }, rig.superAdmin());
    expect(off.status).toBe(404);
  });

  it('an overseas doctor is submitted with no consent on file, exactly as before', async () => {
    rig.resetApplication(DOCTORS.uk);
    const out = await rig.introduce(DOCTORS.uk, { decision: false });
    expect(out.status).toBe(200);
    expect(out.emails).toHaveLength(1);
    expect(appRow(DOCTORS.uk).profile_share_consent_at).toBeUndefined();
  });

  it('the database does not have the consent columns yet: an Australian doctor is refused, and a verbal consent says why it could not be saved', async () => {
    rig.resetApplication(DOCTORS.vr_gate);
    rig.emu.missingColumns = { gp_applications: consent.CONSENT_COLUMNS.slice() };
    const out = await rig.introduce(DOCTORS.vr_gate, { decision: false });
    expect(out.status).toBe(409);
    expect(out.emails).toHaveLength(0);
    const verbal = await rig.post('/api/admin/career/application/share-consent', { applicationId: rig.appIdFor(DOCTORS.vr_gate), note: 'By phone, 20 Nov' }, rig.superAdmin());
    expect(verbal.status).toBe(503);
    expect(verbal.json.code).toBe('schema_missing');
    // and an overseas doctor is unaffected by the missing columns
    rig.resetApplication(DOCTORS.uk);
    const uk = await rig.introduce(DOCTORS.uk, { decision: false });
    expect(uk.status).toBe(200);
  });
});

describe('WP-09: the doctor gives the consent when they apply', () => {
  const dropApp = (d) => { const t = rows('gp_applications'); for (let i = t.length - 1; i >= 0; i--) if (t[i].user_id === d.userId) t.splice(i, 1); };
  const myApp = (d) => rows('gp_applications').filter((r) => r.user_id === d.userId)[0];
  const agreed = { shareConsent: { agreed: true, version: consent.CONSENT_VERSION } };

  it('the role page payload carries the sheet, naming the practice and what is sent (Australian doctor only)', async () => {
    dropApp(DOCTORS.vr_apply);
    const res = await rig.get('/api/career/role?id=' + encodeURIComponent(ROLE_PUBLIC_ID), { cookie: cookie(DOCTORS.vr_apply) });
    expect(res.status).toBe(200);
    expect(res.json.role.auShareConsent).toEqual(consent.doctorConsentSheet({ practiceName: rigLib.PRACTICE_NAME }));
    expect(res.json.role.auShareConsent.body).toBe('We’ll send ' + rigLib.PRACTICE_NAME + ' your name, your CV and a short professional summary. Nothing else, and nobody else.');
  });

  it('an Australian doctor applying without the tick: 400 consent_required with the sheet, and no application', async () => {
    dropApp(DOCTORS.vr_apply);
    for (const body of [{}, { shareConsent: { agreed: false, version: consent.CONSENT_VERSION } }, { shareConsent: { agreed: true, version: 'old-wording' } }]) {
      const res = await rig.post('/api/career/apply', Object.assign({ roleId: ROLE_PUBLIC_ID }, body), { cookie: cookie(DOCTORS.vr_apply) });
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      expect(res.json).toMatchObject({ ok: false, code: 'consent_required', message: 'Please tick the box to agree to your details being sent to this practice.' });
      expect(res.json.shareConsent.title).toBe('Put me forward to ' + rigLib.PRACTICE_NAME + '?');
      expect(myApp(DOCTORS.vr_apply)).toBeUndefined();
    }
  });

  it('with the tick: the application is created and the consent is stored on it (when, which wording, which role)', async () => {
    dropApp(DOCTORS.vr_apply);
    const res = await rig.post('/api/career/apply', Object.assign({ roleId: ROLE_PUBLIC_ID }, agreed), { cookie: cookie(DOCTORS.vr_apply) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const saved = myApp(DOCTORS.vr_apply);
    expect(saved).toMatchObject({
      profile_share_consent_source: 'doctor', profile_share_consent_by: 'self',
      profile_share_consent_version: consent.CONSENT_VERSION, profile_share_consent_role_id: String(rigLib.ROLE_ID)
    });
    expect(saved.profile_share_consent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(consent.consentOnFile(saved).ok).toBe(true);
    // the insert itself never named a consent column: the consent is its own write
    const insert = rig.emu.requests.filter((r) => r.table === 'gp_applications' && r.method === 'POST').pop();
    consent.CONSENT_COLUMNS.forEach((c) => expect(insert.bodyKeys || []).not.toContain(c));
    // and staff can now submit that application with no further step
    const sub = await rig.post('/api/admin/career/application/submit-to-practice', { applicationId: saved.id }, rig.superAdmin());
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
  });

  it('accepting a team match from the popup endpoint needs the same agreement; refused leaves the match untouched', async () => {
    dropApp(DOCTORS.vr_match);
    rows('gp_applications').push(rigLib.freshApplication(DOCTORS.vr_match, {
      id: 'match-wp09', ats_stage: 'shortlisted', origin: 'ai_matched', revealed: true, practice_action_token: null,
      matched_at: NOW, match_expires_at: '2099-01-01T00:00:00.000Z'
    }));
    const refused = await rig.post('/api/career/match/respond', { applicationId: 'match-wp09', action: 'accept' }, { cookie: cookie(DOCTORS.vr_match) });
    expect(refused.status, JSON.stringify(refused.json)).toBe(400);
    expect(refused.json.code).toBe('consent_required');
    expect(refused.json.message).toContain('tick the box agreeing to your details being sent to the practice');
    expect(myApp(DOCTORS.vr_match).ats_stage).toBe('shortlisted');
    const ok = await rig.post('/api/career/match/respond', Object.assign({ applicationId: 'match-wp09', action: 'accept' }, agreed), { cookie: cookie(DOCTORS.vr_match) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(myApp(DOCTORS.vr_match)).toMatchObject({ ats_stage: 'applied', profile_share_consent_source: 'doctor', profile_share_consent_role_id: String(rigLib.ROLE_ID) });
    // declining never needed it
    dropApp(DOCTORS.vr_match);
  });

  it('an overseas doctor applies exactly as before: no sheet, no consent asked for, none stored', async () => {
    dropApp(DOCTORS.uk_apply);
    // the seeded role is not in a DPA, which an overseas doctor cannot have: make it one for this case
    const role = rows('career_roles')[0];
    role.dpa = true;
    try {
      const detail = await rig.get('/api/career/role?id=' + encodeURIComponent(ROLE_PUBLIC_ID), { cookie: cookie(DOCTORS.uk_apply) });
      expect(detail.json.role.auShareConsent).toBeUndefined();
      const res = await rig.post('/api/career/apply', { roleId: ROLE_PUBLIC_ID }, { cookie: cookie(DOCTORS.uk_apply) });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const saved = myApp(DOCTORS.uk_apply);
      consent.CONSENT_COLUMNS.forEach((c) => expect(saved[c]).toBeUndefined());
    } finally { role.dpa = false; }
  });
});

describe('WP-09: switch off', () => {
  it('a doctor with an Australian pathway stored is introduced as before, and no new column or table is named', async () => {
    rig.setSwitch(false);
    rig.resetApplication(DOCTORS.vr_gate);
    // The consent columns, the credentials table and the WP-08 columns must
    // not be named (the full cross-package rule runs in
    // tests/au-wp02-switch-off-no-new-queries.test.js, "WP-09 flows").
    rig.emu.forbid((request) => wp09NewNameViolation(request) || wp08NewNameViolation(request)
      || (request.table === 'gp_credentials' ? 'table gp_credentials' : ''));
    const out = await rig.introduce(DOCTORS.vr_gate);
    expect(rig.emu.violations).toEqual([]);
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(out.emails).toHaveLength(1);
    // today's wording and today's template: with the switch off everybody is an overseas doctor
    expect(out.email.text).toContain('internationally trained GP');
    expect(out.whatsapp.templateName).toBe('gp_link_practice_candidate_intro');
    expect(Object.keys(out.json).sort()).toEqual(['application', 'ok', 'submission_mode']);
    expect(Object.keys(out.decision.candidate).sort()).toEqual(['facts', 'hasCv', 'paragraph', 'recommendation']);
    // applying asks for no consent and stores none
    const t = rows('gp_applications');
    for (let i = t.length - 1; i >= 0; i--) if (t[i].user_id === DOCTORS.vr_apply.userId) t.splice(i, 1);
    const role = rows('career_roles')[0];
    role.dpa = true;
    try {
      const res = await rig.post('/api/career/apply', { roleId: ROLE_PUBLIC_ID }, { cookie: cookie(DOCTORS.vr_apply) });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(rig.emu.violations).toEqual([]);
    } finally { role.dpa = false; }
  });
});

describe('WP-09: the pages', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('the decision page draws "What happens next" only from the server’s Australian keys, with textContent', () => {
    const html = read('pages/practice-decision.html');
    expect(html).toContain('id="pdNext"');
    expect(html).toContain('<div id="pdNext" class="pd-next" hidden>');
    expect(html).toContain("c.audience === 'au' && Array.isArray(c.nextSteps)");
    expect(html).toContain('renderNextSteps(ctx.candidate);');
    const fn = html.slice(html.indexOf('function renderNextSteps'), html.indexOf('function loadContext'));
    expect(fn).not.toContain('innerHTML');
    // nothing on the page itself talks about visas or registration timelines
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    expect(ci.auPracticeTextViolations(visible)).toEqual([]);
  });

  it('the apply sheet: consent block hidden by default, button disabled until ticked, agreement sent with every apply', () => {
    const html = read('pages/job.html');
    expect(html).toContain('<div class="at-share-consent" id="applyShareConsent" hidden>');
    expect(html).toContain('applyConfirmBtnEl.disabled = true; // until the box is ticked');
    expect(html).toContain('if (shareConsentGiven) body.shareConsent = shareConsentGiven;');
    // CHANGED by FB-2b (W3-D23): a fourth request goes through the same body
    // builder (the "what is still needed?" question an Australian doctor's
    // page asks before it opens the one sheet). Still no apply built by hand.
    expect((html.match(/body: applyRequestBody\(\)/g) || []).length).toBe(4);
    expect(html).not.toContain('body: JSON.stringify({ roleId: currentRole.id })');
    expect(html).toContain('data.code === "consent_required"');
    // the wording comes from the server, never typed into the page
    expect(html).not.toContain('short professional summary');
  });

  it('staff screens offer "record verbal consent" on the refusal, on all three submit buttons', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain("res.code === 'profile_share_consent_required' && res.can_record_verbal_consent");
    expect(js).toContain("'/api/admin/career/application/share-consent'");
    expect((js.match(/submitToPracticeRequest\(appId, function \(res\)/g) || []).length).toBe(2);
    expect((js.match(/\/api\/admin\/career\/application\/submit-to-practice/g) || []).length).toBe(2); // the comment + the one request
    const admin = read('pages/admin.html');
    expect(admin).toContain('d.code==="profile_share_consent_required"&&d.can_record_verbal_consent');
    expect(admin).toContain('"/api/admin/career/application/share-consent"');
  });

  it('cache-busters moved with the changed script and page', () => {
    const dash = read('pages/ceo-dashboard.html');
    expect(dash).toContain('/js/ceo-ats-candidates.js?v=20261124c');
    expect(dash).toContain('/css/ceo-ats.css?v=20261124c');
    expect(read('sw.js')).toContain('var VERSION = "20261124d"');
  });
});
