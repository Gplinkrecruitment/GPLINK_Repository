// Australian GP build, WP-06: the pure rules behind the staff tools
// (lib/au-staff-tools.js, candidatePathway.derivePathwayFromRegisterCheck) and
// the migration file.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const tools = require('../lib/au-staff-tools.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const { WP06_NEW_TASK_TYPES, WP06_NEW_COLUMN_NAMES, wp06NewNameViolation } = require('./helpers/au-fixtures.js');

// AGENT-RULES section 4: words a doctor on an Australian pathway must never be sent.
const BANNED = /MyIntealth|\bAMC\b|\bEPIC\b|\bvisa\b|relocat|your move|overseas|internationally trained|\bGMC\b|\bSPPA\b|Section G|supervisor CV|Not yet eligible|AHPRA/;

const NOW = '2026-11-20T00:00:00.000Z';
// FR-1 (R-05): a verified check now needs a deliberate 19AB answer and an
// expiry that has not passed on `today` (passed in: the lib reads no clock).
const VERIFIED_OK = {
  outcome: 'verified', ahpra_number: 'med 0001234567', registration_type: 'specialist', specialist_gp: true,
  has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30',
  moratorium_19ab_confirmed: 'unconfirmed'
};
const CHECK_TODAY = { today: '2026-11-20' };
const _validateAhpraCheckInput = tools.validateAhpraCheckInput;
const validateCheck = (body) => _validateAhpraCheckInput(body, CHECK_TODAY);

describe('validateCreateCandidateInput', () => {
  it('cleans a good Australian candidate', () => {
    const r = tools.validateCreateCandidateInput({
      first_name: '  Test ', last_name: 'Auvr', email: ' AU.VR.Test@gplink-test.local ', phone: '+61 400 000 111',
      pathway: 'AU_VR', ahpra_number: 'med-0001234567', state: 'nsw', notes: 'Met at a (FAKE) event', consultant: 'Consultant.Test@gplink-test.local'
    });
    expect(r.ok).toBe(true);
    expect(r.clean).toEqual({
      firstName: 'Test', lastName: 'Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61 400 000 111',
      pathway: 'au_vr', isAu: true, ahpraNumber: 'MED0001234567', state: 'NSW', notes: 'Met at a (FAKE) event',
      consultant: 'consultant.test@gplink-test.local'
    });
  });

  it('accepts an overseas candidate with only the basics', () => {
    const r = tools.validateCreateCandidateInput({ first_name: 'Test', last_name: 'Ukgp', email: 'uk@gplink-test.local', pathway: 'overseas_esp' });
    expect(r.ok).toBe(true);
    expect(r.clean).toMatchObject({ pathway: 'overseas_esp', isAu: false, ahpraNumber: '', state: '', phone: '', consultant: '' });
  });

  it('refuses each bad field, and never guesses a pathway', () => {
    const bad = (body) => tools.validateCreateCandidateInput(body);
    expect(bad(null).errors).toMatchObject({ first_name: expect.any(String), last_name: expect.any(String), email: expect.any(String), pathway: expect.any(String) });
    expect(bad({ first_name: 'A', last_name: 'B', email: 'not-an-email', pathway: 'au_vr' }).errors.email).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'australian' }).errors.pathway).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co' }).errors.pathway).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'au_vr', ahpra_number: '1234567' }).errors.ahpra_number).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'overseas_esp', ahpra_number: 'MED0001234567' }).errors.ahpra_number).toMatch(/Australian pathway/);
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'au_vr', state: 'Texas' }).errors.state).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'au_vr', phone: '12' }).errors.phone).toBeTruthy();
    expect(bad({ first_name: 'A', last_name: 'B', email: 'a@b.co', pathway: 'au_vr', consultant: 'nobody' }).errors.consultant).toBeTruthy();
    expect(bad({ first_name: '<b>', last_name: 'B', email: 'a@b.co', pathway: 'au_vr' }).clean.firstName).toBe('b');
  });
});

describe('validateAhpraCheckInput', () => {
  it('verified: every register fact is required, and the patch uses the table columns', () => {
    const r = validateCheck(Object.assign({}, VERIFIED_OK, { moratorium_19ab_confirmed: 'no', fellowship_type: 'fracgp', work_rights: 'citizen', note: 'checked by hand' }));
    expect(r.ok).toBe(true);
    expect(r.number).toBe('MED0001234567');
    expect(r.moratoriumConfirmed).toBe('no');
    expect(r.credentialsPatch).toEqual({
      ahpra_registration_type: 'specialist', specialist_gp: true,
      has_conditions: false, conditions_text: null, has_undertakings: false, undertakings_text: null,
      has_notations: false, notations_text: null, registration_expiry: '2027-09-30',
      fellowship_type: 'fracgp', work_rights: 'citizen'
    });
    const missing = validateCheck({ outcome: 'verified' });
    expect(missing.ok).toBe(false);
    expect(Object.keys(missing.errors).sort()).toEqual(['has_conditions', 'has_notations', 'has_undertakings', 'moratorium_19ab_confirmed', 'registration_expiry', 'registration_type', 'specialist_gp']);
  });

  it('a flag answered yes needs its text; 19AB is only a confirmation when it is yes or no', () => {
    const noText = validateCheck(Object.assign({}, VERIFIED_OK, { has_conditions: true }));
    expect(noText.ok).toBe(false);
    expect(noText.errors.conditions_text).toBeTruthy();
    const withText = validateCheck(Object.assign({}, VERIFIED_OK, { has_notations: true, notations_text: ' Must practise in a group practice. ' }));
    expect(withText.ok).toBe(true);
    expect(withText.credentialsPatch).toMatchObject({ has_notations: true, notations_text: 'Must practise in a group practice.' });
    // 'unconfirmed' = the deliberate "not confirmed yet": no confirmation is stored.
    expect(validateCheck(VERIFIED_OK).moratoriumConfirmed).toBe(null);
    const blank19 = Object.assign({}, VERIFIED_OK); delete blank19.moratorium_19ab_confirmed;
    expect(validateCheck(blank19).errors.moratorium_19ab_confirmed).toBeTruthy();
    expect(validateCheck(Object.assign({}, VERIFIED_OK, { moratorium_19ab_confirmed: 'unsure' })).errors.moratorium_19ab_confirmed).toBeTruthy();
    // A bare null still clears a confirmation (on "Save progress"); on "verified" it is not an answer.
    expect(validateCheck(Object.assign({}, VERIFIED_OK, { outcome: 'pending', moratorium_19ab_confirmed: null })).moratoriumConfirmed).toBe(null);
    expect(validateCheck(Object.assign({}, VERIFIED_OK, { moratorium_19ab_confirmed: null })).ok).toBe(false);
  });

  it('not matched needs nothing else and records nothing about the registration; pending saves what there is', () => {
    const nm = validateCheck({ outcome: 'not_matched', registration_type: 'specialist', has_conditions: true });
    expect(nm).toMatchObject({ ok: true, outcome: 'not_matched', credentialsPatch: {} });
    const pending = validateCheck({ outcome: 'pending', registration_type: 'general' });
    expect(pending).toMatchObject({ ok: true, outcome: 'pending', credentialsPatch: { ahpra_registration_type: 'general' } });
    expect(validateCheck({ outcome: 'mismatch' }).ok).toBe(false);
    expect(validateCheck({ outcome: 'verified', registration_type: 'gp', registration_expiry: '2027-02-31' }).errors).toMatchObject({ registration_type: expect.any(String), registration_expiry: expect.any(String) });
    expect(validateCheck({ outcome: 'pending', ahpra_number: '7654321' }).errors.ahpra_number).toBeTruthy();
  });
});

describe('derivePathwayFromRegisterCheck: onboarding answers and staff findings give ONE answer', () => {
  // FR-1 (R-05): segment A also needs what staff saw: on the specialist
  // register as a GP, and an expiry that has not passed.
  const clean = {
    ahpra_registration_type: 'specialist', specialist_gp: true, registration_expiry: '2027-09-30',
    fellowship_type: 'fracgp', work_rights: 'citizen',
    has_conditions: false, has_undertakings: false, has_notations: false, moratorium_19ab_status: 'no'
  };
  const _derive = candidatePathway.derivePathwayFromRegisterCheck;
  const deriveCheck = (input) => _derive(input && typeof input === 'object' ? Object.assign({ today: '2026-11-20' }, input) : input);
  it('segment A when everything is clear', () => {
    expect(deriveCheck({ credentials: clean, currentPathway: 'au_vr' }))
      .toEqual({ pathway: 'au_vr', segment: 'A', launched: true, reasons: ['specialist_gp_with_fellowship'], hasFlags: false });
  });
  it('is the same rule as onboarding, row by row', () => {
    const cases = [
      [Object.assign({}, clean, { has_notations: true }), 'au_vr', 'au_restricted'],
      [Object.assign({}, clean, { has_undertakings: true }), 'au_vr', 'au_restricted'],
      [Object.assign({}, clean, { ahpra_registration_type: 'limited' }), 'au_vr', 'au_restricted'],
      [Object.assign({}, clean, { work_rights: 'visa' }), 'au_vr', 'au_restricted'],
      [Object.assign({}, clean, { fellowship_type: 'none' }), 'au_vr', 'au_non_vr'],
      [Object.assign({}, clean, { ahpra_registration_type: 'general' }), 'au_vr', 'au_non_vr'],
      [Object.assign({}, clean, { fellowship_type: 'none' }), 'au_registrar', 'au_registrar']
    ];
    for (const [credentials, currentPathway, expected] of cases) {
      const viaCheck = deriveCheck({ credentials, currentPathway });
      expect(viaCheck.pathway).toBe(expected);
      const viaOnboarding = candidatePathway.derivePathwayFromOnboarding({
        registrationType: credentials.ahpra_registration_type,
        fellowship: currentPathway === 'au_registrar' ? 'registrar' : credentials.fellowship_type,
        hasConditions: credentials.has_conditions || credentials.has_undertakings || credentials.has_notations,
        moratorium19ab: credentials.moratorium_19ab_status, workRights: credentials.work_rights
      });
      expect(viaCheck.pathway).toBe(viaOnboarding.pathway);
    }
  });
  it('a staff-confirmed 19AB "applies" wins over the doctor\'s "no"; anything missing fails closed to B', () => {
    const staffYes = Object.assign({}, clean, { moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: 'staff@gplink-test.local', moratorium_19ab_confirmed_at: NOW });
    expect(deriveCheck({ credentials: staffYes }).pathway).toBe('au_restricted');
    // A staff value with no name against it is not a confirmation.
    expect(deriveCheck({ credentials: Object.assign({}, clean, { moratorium_19ab_confirmed_status: 'yes' }) }).pathway).toBe('au_vr');
    // Staff-added candidate, nothing known about fellowship or right to work.
    const unknown = deriveCheck({ credentials: { ahpra_registration_type: 'specialist', has_conditions: false, has_undertakings: false, has_notations: false } });
    expect(unknown.pathway).toBe('au_restricted');
    expect(unknown.reasons).toEqual(expect.arrayContaining(['fellowship_unclear', 'work_rights_unclear', 'moratorium_19ab_unanswered']));
    // Only one of the three flags answered: not clear.
    expect(deriveCheck({ credentials: Object.assign({}, clean, { has_undertakings: null }) }).reasons).toContain('conditions_unclear');
    expect(deriveCheck(null).pathway).toBe('au_restricted');
  });
});

describe('the check task and the yearly re-check', () => {
  it('builds the task with the due-date rule', () => {
    const t = tools.buildAhpraCheckTask({ name: 'Dr Test Auvr', reason: 'staff_created', stage: 'placement', now: NOW, placingConsultant: 'c@gplink-test.local' });
    expect(t).toMatchObject({
      task_type: 'ahpra_register_check', priority: 'normal', due_date: '2026-11-22', related_stage: 'placement',
      source_trigger: 'au_ahpra_check_staff_created', metadata: { au: true, reason: 'staff_created', placing_consultant: 'c@gplink-test.local' }
    });
    expect(t.title).toBe('Check Ahpra registration on the public register: Dr Test Auvr');
    expect(tools.buildAhpraCheckTask({ reason: 'annual_recheck', now: NOW })).toMatchObject({ due_date: '2026-12-04', title: 'Re-check Ahpra registration: this doctor' });
    expect(tools.buildAhpraCheckTask({ reason: 'expiry_soon', now: NOW }).priority).toBe('high');
    expect(tools.ahpraCheckDueDate('onboarding_completed', NOW)).toBe('2026-11-22');
  });

  it('is due when last checked more than 12 months ago', () => {
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: '2025-11-10T00:00:00Z', registration_expiry: '2027-09-30' }, NOW)).toMatchObject({ due: true, reason: 'annual_recheck' });
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: '2026-01-10T00:00:00Z', registration_expiry: '2027-09-30' }, NOW)).toMatchObject({ due: false, reason: null });
  });

  it('is due when the registration expires within 60 days, once, and once more after it has passed', () => {
    const checkedLongAgo = '2026-03-01T00:00:00Z';
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: checkedLongAgo, registration_expiry: '2026-12-31' }, NOW)).toMatchObject({ due: true, reason: 'expiry_soon', daysToExpiry: 41 });
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: checkedLongAgo, registration_expiry: '2027-03-31' }, NOW).due).toBe(false);
    // Staff re-checked inside the window: not asked again the next day.
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: '2026-11-15T00:00:00Z', registration_expiry: '2026-12-31' }, NOW).due).toBe(false);
    // The date has now passed and the last check was before it: once more.
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: '2026-11-15T00:00:00Z', registration_expiry: '2026-12-31' }, '2027-01-05T00:00:00Z')).toMatchObject({ due: true, reason: 'expiry_soon' });
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: '2027-01-02T00:00:00Z', registration_expiry: '2026-12-31' }, '2027-01-05T00:00:00Z').due).toBe(false);
  });

  it('never fires for a doctor staff have not checked yet (their first task is already open)', () => {
    expect(tools.ahpraRecheckDue({ ahpra_last_checked_at: null, registration_expiry: '2026-11-25' }, NOW).due).toBe(false);
    expect(tools.ahpraRecheckDue(null, NOW).due).toBe(false);
  });

  it('N07: the segment review task says why, and is for staff only', () => {
    const t = tools.buildSegmentReviewTask({ name: 'Dr Test Aures', derivation: { pathway: 'au_restricted', segment: 'B', reasons: ['registration_conditions'], hasFlags: true }, now: NOW });
    expect(t).toMatchObject({ task_type: 'segment_review', priority: 'high', due_date: '2026-11-22', source_trigger: 'au_segment_review' });
    expect(t.title).toBe('Decide the segment for Dr Test Aures (Ahpra check: segment B)');
    expect(t.description).toMatch(/condition, undertaking or notation/);
    expect(t.metadata).toMatchObject({ pathway: 'au_restricted', segment: 'B', has_flags: true });
  });
});

describe('what the doctor is sent (N06, the invite): Australian wording', () => {
  const verified = tools.buildAhpraVerifiedMessage({ appBaseUrl: 'https://app.example.test/' });
  const notMatched = tools.buildAhpraNotMatchedMessage({ number: 'med0001234567' });
  const invite = tools.buildCandidateInviteEmail({ pathway: 'au_vr', staffName: 'Casey', setupUrl: 'https://app.example.test/api/auth/welcome-setup?token=abc' });

  it('N06 verified has the jobs call to action and a once-ever key', () => {
    expect(verified).toMatchObject({ id: 'N06', key: 'au_n06_ahpra_verified', ctaText: 'See GP roles', ctaUrl: 'https://app.example.test/pages/career' });
    expect(verified.subject).toBe('Your Ahpra registration is confirmed');
    expect(verified.bell.title).toBe('Ahpra registration confirmed');
  });

  it('N06 not matched asks the doctor to check the number, once per number', () => {
    expect(notMatched.key).toBe('au_n06_ahpra_not_matched:MED0001234567');
    expect(tools.buildAhpraNotMatchedMessage({ number: 'MED0009999999' }).key).not.toBe(notMatched.key);
    expect(notMatched.body).toMatch(/could not match it to your name/);
    expect(notMatched.ctaUrl).toBe(tools.AHPRA_PUBLIC_REGISTER_URL);
  });

  it('the invite carries the set-password link and names the staff member', () => {
    expect(invite.ctaUrl).toBe('https://app.example.test/api/auth/welcome-setup?token=abc');
    expect(invite.body).toMatch(/^Casey from GP Link has set up an account for you/);
    expect(invite.footer).toMatch(/72 hours/);
    expect(tools.buildCandidateInviteEmail({ pathway: 'au_vr' }).body).toMatch(/^The GP Link team has set up/);
  });

  it('none of it uses a word an Australian doctor must never see', () => {
    for (const msg of [verified, notMatched, invite]) {
      const text = [msg.subject, msg.title, msg.body, msg.ctaText, msg.footer, msg.bell ? msg.bell.title + ' ' + msg.bell.body : ''].join(' \n ');
      expect(text).not.toMatch(BANNED);
      expect(text).toMatch(/Ahpra|GP Link/);
    }
    // The whole library, comments included, for the doctor-facing builders.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'au-staff-tools.js'), 'utf8');
    const from = src.indexOf('// ── What the doctor is told');
    const to = src.indexOf('// ── Candidate list: pathway chip and filter');
    const auOnly = src.slice(from, to).replace(/return \{\s*key: 'staff_invite'[\s\S]*?\n  \};/, '');
    expect(from).toBeGreaterThan(0);
    // (The constant AHPRA_PUBLIC_REGISTER_URL is an identifier, not copy: the
    // upper-case spelling is checked on the rendered text above.)
    expect(auOnly.replace(/AHPRA_PUBLIC_REGISTER_URL/g, '')).not.toMatch(BANNED);
  });

  it('an overseas candidate gets a neutral invite', () => {
    const o = tools.buildCandidateInviteEmail({ pathway: 'overseas_esp', setupUrl: 'https://x.test/s' });
    expect(o.key).toBe('staff_invite');
    expect(o.body).not.toMatch(/Ahpra|Australia/);
  });
});

describe('pathway chip and filter (ADM-19)', () => {
  it('labels every pathway, and nothing recorded reads as Overseas', () => {
    expect(candidatePathway.ALL_PATHWAYS.map(tools.pathwayChipLabel)).toEqual(['Overseas', 'Overseas (PEP)', 'Australian VR', 'Australian restricted', 'Non-VR', 'Registrar']);
    expect(tools.pathwayChipLabel(null)).toBe('Overseas');
    expect(tools.pathwayChipLabel('nonsense')).toBe('Overseas');
  });
  it('filters', () => {
    expect(tools.PATHWAY_FILTERS.map((f) => f.label)).toEqual(['All pathways', 'Overseas', 'Australian VR', 'Australian restricted', 'Non-VR', 'Registrar', 'Needs review']);
    const rows = [
      { id: 1, pathway: null }, { id: 2, pathway: 'overseas_pep' }, { id: 3, pathway: 'au_vr', pathway_needs_review: false },
      { id: 4, pathway: 'au_restricted', pathway_needs_review: true }, { id: 5, pathway: 'au_non_vr', pathway_needs_review: true },
      { id: 6, pathway: 'au_registrar', pathway_needs_review: true }, { id: 7, pathway: 'au_vr', pathway_needs_review: true }
    ];
    const ids = (f) => rows.filter((r) => tools.pathwayFilterMatches(f, r)).map((r) => r.id);
    expect(ids('')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ids('overseas')).toEqual([1, 2]);
    expect(ids('au_vr')).toEqual([3, 7]);
    expect(ids('au_restricted')).toEqual([4]);
    expect(ids('au_non_vr')).toEqual([5]);
    expect(ids('au_registrar')).toEqual([6]);
    expect(ids('needs_review')).toEqual([4, 5, 6, 7]);
    expect(ids('bogus')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('the migration file', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261120120000_au_gp_wp06_task_types.sql'), 'utf8');
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  // The LIVE list, from docs/au-gp/ENVIRONMENT.md section 9.
  const LIVE = ['kickoff', 'verify', 'review', 'followup', 'blocker', 'escalation', 'practice_pack', 'practice_pack_child', 'manual', 'system',
    'visa_stage', 'visa_doc', 'questionnaire', 'sponsor', 'migration_agent', 'sla_overdue', 'chase', 'document_ops', 'whatsapp_help',
    'email_triage', 'ahpra_action_item', 'ahpra_correspondence', 'flagged_doc', 'doc_review', 'zoom_call', 'alt_supervisor_cv_review',
    'alt_supervisor_cv_request', 'account_deleted_active_placement', 'model_update_available', 'ahpra_conflict_letter'];

  it('widens the task-type CHECK to a superset of the live 30 values plus the eleven new ones', () => {
    const list = code.slice(code.indexOf('check (task_type in ('), code.indexOf(')) not valid'));
    const values = (list.match(/'([a-z_0-9]+)'/g) || []).map((s) => s.replace(/'/g, ''));
    expect(LIVE.length).toBe(30);
    expect(values.slice().sort()).toEqual(LIVE.concat(WP06_NEW_TASK_TYPES).sort());
    expect(new Set(values).size).toBe(values.length);
    expect(tools.AU_NEW_TASK_TYPES.slice().sort()).toEqual(WP06_NEW_TASK_TYPES.slice().sort());
  });

  it('is additive, idempotent and written for exec_sql', () => {
    expect(code).not.toMatch(/\b(begin|commit)\s*;/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index)\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    expect(code).toMatch(/pg_catalog\.pg_constraint/);
    expect(code).toMatch(/like '%ahpra_register_check%'/);
    expect(code).toMatch(/create unique index if not exists uniq_open_ahpra_register_check_task\s+on public\.registration_tasks \(case_id\)/);
    expect(code).toMatch(/add column if not exists placing_consultant text;/);
    expect(code).toMatch(/alter table public\.registration_tasks validate constraint registration_tasks_task_type_check;/);
    // Every table is schema-qualified.
    expect(code.match(/\b(alter table|on) (?!public\.)[a-z_]+/g) || []).toEqual([]);
    expect(WP06_NEW_COLUMN_NAMES).toEqual(['placing_consultant']);
  });

  it('the switch-off guard recognises every new name', () => {
    expect(wp06NewNameViolation({ table: 'registration_cases', query: '?select=id,placing_consultant', body: null })).toMatch(/placing_consultant/);
    expect(wp06NewNameViolation({ table: 'registration_tasks', query: '', body: [{ task_type: 'segment_review' }] })).toMatch(/segment_review/);
    expect(wp06NewNameViolation({ table: 'registration_tasks', query: '?task_type=eq.ahpra_register_check', body: null })).toMatch(/ahpra_register_check/);
    expect(wp06NewNameViolation({ table: 'registration_tasks', query: '?task_type=eq.doc_review', body: [{ task_type: 'chase' }] })).toBe('');
    expect(wp06NewNameViolation({ table: 'user_profiles', query: '?select=user_id', body: null })).toBe('');
  });
});
