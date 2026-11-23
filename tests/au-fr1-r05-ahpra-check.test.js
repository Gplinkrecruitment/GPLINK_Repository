// Fix bundle FR-1, defect R-05: the staff Ahpra check cannot confirm au_vr
// against what staff saw on the register.
//   - derivePathwayFromRegisterCheck over its whole input space
//   - validateAhpraCheckInput: what "Save as verified" requires
//   - the form: nothing is pre-filled from the doctor's own answers
//   - the route, end to end
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const cp = require('../lib/candidate-pathway.js');
const st = require('../lib/au-staff-tools.js');
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

const TODAY = '2026-11-23';
const derive = (credentials, currentPathway, today) => cp.derivePathwayFromRegisterCheck({ credentials, currentPathway, today: today === undefined ? TODAY : today });

const TYPES = ['general', 'specialist', 'general_and_specialist', 'provisional', 'limited', 'non_practising', '', null];
const SPECIALIST = [true, false, null, undefined];
const FELLOWSHIPS = ['fracgp', 'facrrm', 'both', 'other', 'none', '', null];
const LEVELS = ['', null, 'none', 'level_1', 'level_2', 'level_3', 'level_4'];
const EXPIRIES = ['2027-09-30', TODAY, '2026-11-22', '2020-01-01', '', null];
const FLAGSETS = [[false, false, false], [true, false, false], [false, true, false], [false, false, true], [null, false, false], [false, null, null]];
const RIGHTS = ['citizen', 'pr', 'visa', '', null];
const STAFF19 = ['yes', 'no', null];
const SELF19 = ['yes', 'no', 'unsure', null];
const CURRENT = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];

function cred(o) {
  const c = {
    ahpra_registration_type: o.type, specialist_gp: o.specialist, fellowship_type: o.fellowship, supervision_level: o.level,
    registration_expiry: o.expiry, has_conditions: o.flags[0], has_undertakings: o.flags[1], has_notations: o.flags[2],
    work_rights: o.rights, moratorium_19ab_status: o.self19
  };
  if (o.staff19) Object.assign(c, { moratorium_19ab_confirmed_status: o.staff19, moratorium_19ab_confirmed_by: 'ceo@gplink-test.local', moratorium_19ab_confirmed_at: '2026-11-20T00:00:00Z' });
  return c;
}
// The rule, written out independently of the implementation.
function mayBeVr(o, current) {
  return (o.type === 'specialist' || o.type === 'general_and_specialist')
    && o.specialist === true
    && ['fracgp', 'facrrm', 'both'].indexOf(o.fellowship) !== -1
    && (o.level === '' || o.level === null || o.level === 'none')
    && !!o.expiry && o.expiry >= TODAY
    && o.flags.every((f) => f === false)
    && (o.rights === 'citizen' || o.rights === 'pr')
    && (o.staff19 ? o.staff19 === 'no' : (o.self19 === 'no' || o.self19 === 'unsure'))
    && current !== 'au_registrar';
}

describe('R-05: derivePathwayFromRegisterCheck, the whole input space', () => {
  it('au_vr comes out ONLY when every condition of the rule holds; everything else is an unlaunched segment', () => {
    let total = 0; let vr = 0;
    for (const type of TYPES) for (const specialist of SPECIALIST) for (const fellowship of FELLOWSHIPS) for (const level of LEVELS)
      for (const expiry of EXPIRIES) for (const flags of FLAGSETS) for (const rights of RIGHTS) for (const staff19 of STAFF19) for (const self19 of SELF19) {
        const o = { type, specialist, fellowship, level, expiry, flags, rights, staff19, self19 };
        for (const current of CURRENT) {
          total += 1;
          const out = derive(cred(o), current);
          const expectVr = mayBeVr(o, current);
          if ((out.pathway === 'au_vr') !== expectVr) {
            throw new Error('wrong for ' + JSON.stringify({ o, current, got: out }));
          }
          if (out.pathway === 'au_vr') vr += 1;
          // internal consistency, always
          if (cp.AU_PATHWAYS.indexOf(out.pathway) === -1) throw new Error('not an Australian pathway: ' + out.pathway);
          if (out.launched !== (out.pathway === 'au_vr')) throw new Error('launched flag wrong');
          if (out.segment !== cp.segmentOf(out.pathway)) throw new Error('segment wrong');
          if (!Array.isArray(out.reasons) || !out.reasons.length) throw new Error('no reasons given');
        }
      }
    expect(total).toBeGreaterThan(1000000);
    expect(vr).toBeGreaterThan(0);
  }, 120000);

  const A = { type: 'specialist', specialist: true, fellowship: 'fracgp', level: 'none', expiry: '2027-09-30', flags: [false, false, false], rights: 'citizen', staff19: 'no', self19: 'no' };
  it('the clean case is segment A', () => {
    expect(derive(cred(A), 'au_vr')).toMatchObject({ pathway: 'au_vr', segment: 'A', launched: true, hasFlags: false });
  });
  it.each([
    ['the reviewer\'s case: type specialist, staff answered specialist-GP NO, doctor\'s own FRACGP', { specialist: false }, 'au_non_vr', 'not_on_specialist_register'],
    ['specialist-GP not answered', { specialist: null }, 'au_restricted', 'specialist_register_unanswered'],
    ['specialist-GP missing entirely', { specialist: undefined }, 'au_restricted', 'specialist_register_unanswered'],
    ['supervision level 1', { level: 'level_1' }, 'au_restricted', 'supervised_registration'],
    ['supervision level 4', { level: 'level_4' }, 'au_restricted', 'supervised_registration'],
    ['expired yesterday', { expiry: '2026-11-22' }, 'au_restricted', 'registration_expired'],
    ['expired years ago', { expiry: '2019-09-30' }, 'au_restricted', 'registration_expired'],
    ['no expiry on file', { expiry: null }, 'au_restricted', 'registration_expiry_missing'],
    ['limited registration', { type: 'limited' }, 'au_restricted', 'supervised_registration'],
    ['general registration only', { type: 'general' }, 'au_non_vr', 'not_on_specialist_register'],
    ['no fellowship', { fellowship: 'none' }, 'au_non_vr', 'no_gp_fellowship'],
    ['a condition', { flags: [true, false, false] }, 'au_restricted', 'registration_conditions'],
    ['a notation', { flags: [false, false, true] }, 'au_restricted', 'registration_conditions'],
    ['flags not all answered', { flags: [false, null, false] }, 'au_restricted', 'conditions_unclear'],
    ['temporary right to work', { rights: 'visa' }, 'au_restricted', 'temporary_work_rights'],
    ['staff: 19AB applies', { staff19: 'yes' }, 'au_restricted', 'moratorium_19ab_applies']
  ])('%s -> %s', (_label, over, pathway, reason) => {
    const out = derive(cred(Object.assign({}, A, over)), 'au_vr');
    expect(out.pathway).toBe(pathway);
    expect(out.launched).toBe(false);
    expect(out.reasons).toContain(reason);
  });
  it('expiry on today\'s date is still current; without a "today" the expiry cannot be judged and nothing is confirmed', () => {
    expect(derive(cred(Object.assign({}, A, { expiry: TODAY })), 'au_vr').pathway).toBe('au_vr');
    const noToday = cp.derivePathwayFromRegisterCheck({ credentials: cred(A), currentPathway: 'au_vr' });
    expect(noToday.pathway).toBe('au_restricted');
    expect(noToday.reasons).toContain('registration_expiry_not_judged');
  });
  it('contradictions between the doctor\'s answers and the staff check: the doctor\'s word never lifts what staff saw', () => {
    // Doctor: VR, specialist, FRACGP, citizen, no conditions. Staff: not on the specialist register, supervised.
    const doctorSaysA = Object.assign(cred(A), { vr_status: 'vr' });
    expect(derive(Object.assign({}, doctorSaysA, { specialist_gp: false }), 'au_vr').pathway).toBe('au_non_vr');
    expect(derive(Object.assign({}, doctorSaysA, { supervision_level: 'level_2' }), 'au_vr').pathway).toBe('au_restricted');
    // Doctor says 19AB does not apply; staff confirmed that it does.
    expect(derive(cred(Object.assign({}, A, { self19: 'no', staff19: 'yes' })), 'au_vr').pathway).toBe('au_restricted');
    // Doctor says it applies; staff confirmed it does not: the staff answer wins.
    expect(derive(cred(Object.assign({}, A, { self19: 'yes', staff19: 'no' })), 'au_vr').pathway).toBe('au_vr');
    // A self-declared registrar stays a registrar whatever the register shows (staff use the pathway control to change it).
    expect(derive(cred(A), 'au_registrar').pathway).toBe('au_registrar');
    // The doctor's restrictive answer stands when staff left it blank.
    expect(derive(cred(Object.assign({}, A, { rights: 'visa' })), 'au_vr').pathway).toBe('au_restricted');
  });
  it('never throws on junk', () => {
    for (const junk of [null, undefined, 7, 'x', [], { credentials: 'x' }, { credentials: { registration_expiry: 20270101, supervision_level: {}, specialist_gp: 'yes' }, today: TODAY }]) {
      const out = cp.derivePathwayFromRegisterCheck(junk);
      expect(out.pathway).toBe('au_restricted');
    }
  });
});

describe('R-05: validateAhpraCheckInput, what "Save as verified" requires', () => {
  const full = {
    outcome: 'verified', ahpra_number: 'MED0001234567', registration_type: 'specialist', specialist_gp: true,
    has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30', moratorium_19ab_confirmed: 'no'
  };
  const v = (body, today) => st.validateAhpraCheckInput(body, { today: today === undefined ? TODAY : today });
  it('a complete check is accepted', () => {
    const out = v(full);
    expect(out.ok).toBe(true);
    expect(out.moratoriumConfirmed).toBe('no');
  });
  it.each([
    ['registration_type'], ['specialist_gp'], ['has_conditions'], ['has_undertakings'], ['has_notations'], ['registration_expiry'], ['moratorium_19ab_confirmed']
  ])('missing %s is refused (omitted, null and empty)', (key) => {
    for (const blank of ['omit', null, '']) {
      const body = Object.assign({}, full);
      if (blank === 'omit') delete body[key]; else body[key] = blank;
      const out = v(body);
      expect(out.ok, key + ' ' + String(blank)).toBe(false);
      expect(Object.keys(out.errors)).toContain(key);
    }
  });
  it('19AB "not confirmed yet" is a deliberate answer: accepted, stored as no confirmation (the doctor stays DPA-only)', () => {
    const out = v(Object.assign({}, full, { moratorium_19ab_confirmed: 'unconfirmed' }));
    expect(out.ok).toBe(true);
    expect(out.moratoriumConfirmed).toBeNull();
    expect(v(Object.assign({}, full, { moratorium_19ab_confirmed: 'maybe' })).ok).toBe(false);
  });
  it('a past expiry is refused for "verified", and staff are told why', () => {
    const out = v(Object.assign({}, full, { registration_expiry: '2026-11-22' }));
    expect(out.ok).toBe(false);
    expect(out.errors.registration_expiry).toMatch(/has passed/);
    expect(out.errors.registration_expiry).toMatch(/cannot be saved as verified/);
    expect(v(Object.assign({}, full, { registration_expiry: TODAY })).ok).toBe(true);
  });
  it('no "today" available: verified is refused rather than judged against nothing', () => {
    expect(st.validateAhpraCheckInput(full).ok).toBe(false);
    expect(st.validateAhpraCheckInput(full, {}).errors.registration_expiry).toMatch(/could not be checked/);
  });
  it('"Save progress" still takes a partial form, a past expiry and an unconfirmed 19AB', () => {
    expect(v({ outcome: 'pending' }).ok).toBe(true);
    expect(v({ outcome: 'pending', registration_expiry: '2020-01-01', moratorium_19ab_confirmed: null }).ok).toBe(true);
    expect(v({ outcome: 'not_matched', ahpra_number: 'MED0001234567' }).ok).toBe(true);
  });
});

describe('R-05: the form never pre-fills staff answers from the doctor\'s own', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
  function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('missing ' + name);
    let depth = 0; let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  }
  const code = [
    'var ATS = { esc: function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }, escAttr: function (s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); } };',
    'function shortDate(v) { return String(v || "").slice(0, 10); }',
    'var AU_REGISTRATION_TYPES = [["general","General"],["specialist","Specialist"],["limited","Limited"]];',
    'var AU_FELLOWSHIPS = [["","Not recorded"],["fracgp","FRACGP"]];',
    'var AU_WORK_RIGHTS = [["","Not recorded"],["citizen","Citizen"]];',
    extractFn(SRC, 'auOptions'), extractFn(SRC, 'auYesNo'), extractFn(SRC, 'auCheckCardInner'), extractFn(SRC, 'auCollectCheck'), extractFn(SRC, 'auCheckMissing'),
    'return { card: auCheckCardInner, collect: auCollectCheck, missing: auCheckMissing };'
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const ui = new Function(code)();
  const selfDeclared = { user_id: 'u1', onboarding: { registerBody: 'ahpra', registerNumber: 'MED0001234567', registerStatus: 'pending_verification' },
    au: { credentials: { ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', work_rights: 'citizen', registration_expiry: '2027-09-30', has_conditions: false, moratorium_19ab_status: 'no' } } };

  it('a doctor nobody has checked yet: type, expiry, fellowship, right to work and the specialist answer all start EMPTY', () => {
    const html = ui.card(selfDeclared);
    expect(html).not.toMatch(/<option value="specialist" selected/);
    expect(html).not.toMatch(/<option value="fracgp" selected/);
    expect(html).not.toMatch(/<option value="citizen" selected/);
    expect(html).toMatch(/id="ats-au-check-expiry" value=""/);
    expect(html).not.toMatch(/name="ats-au-check-specialist" value="(yes|no)" checked/);
    expect(html).toMatch(/The doctor told us \(not checked\): registration type specialist; fellowship fracgp; right to work citizen; section 19AB applies no/);
  });
  it('after a staff check the form shows what STAFF recorded', () => {
    const checked = JSON.parse(JSON.stringify(selfDeclared));
    Object.assign(checked.au.credentials, { staff_verified_at: '2026-11-20T00:00:00Z', ahpra_last_checked_at: '2026-11-20T00:00:00Z', has_undertakings: false, has_notations: false });
    const html = ui.card(checked);
    expect(html).toMatch(/<option value="specialist" selected/);
    expect(html).toMatch(/id="ats-au-check-expiry" value="2027-09-30"/);
    expect(html).toMatch(/name="ats-au-check-specialist" value="yes" checked/);
    expect(html).not.toMatch(/The doctor told us \(not checked\)/);
  });
  it('the form names every gap before sending "verified"; other outcomes are not held up', () => {
    expect(ui.missing({ outcome: 'verified' }, 'verified')).toEqual(['registration type', 'on the specialist register as a GP', 'conditions', 'undertakings', 'notations', 'registration expiry', 'section 19AB']);
    expect(ui.missing({ registration_type: 'specialist', specialist_gp: false, has_conditions: false, has_undertakings: false, has_notations: true, registration_expiry: '2027-01-01', moratorium_19ab_confirmed: 'yes' }, 'verified')).toEqual([]);
    expect(ui.missing({}, 'pending')).toEqual([]);
    expect(ui.missing({}, 'not_matched')).toEqual([]);
  });
});

describe('R-05: the route', () => {
  let h;
  const EMPTY = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents', 'admin_audit_log', 'gp_nudge_log', 'runtime_kv', 'rate_limits', 'au_gp_doctor_details'];
  function load(doctors) {
    const db = buildAuFixtureDb(doctors);
    EMPTY.forEach((n) => { if (!db[n]) db[n] = []; });
    Object.keys(h.emu.db).forEach((n) => { if (n !== 'rso_team') h.emu.db[n].length = 0; });
    Object.keys(db).forEach((n) => { const t = h.emu.table(n); db[n].forEach((r) => t.push(JSON.parse(JSON.stringify(r)))); });
    h.emu.reset();
  }
  const row = (table, userId) => h.emu.table(table).filter((r) => r.user_id === userId)[0] || null;
  const check = (d, body) => {
    const ceo = h.superAdmin();
    return h.post('/api/ats/candidate/register-verification', Object.assign({ action: 'ahpra_check', userId: d.userId, caseId: d.caseId }, body), { cookie: ceo.cookie, host: ceo.host });
  };
  // FR-2 (S2-05), deliberate: fellowship, right to work and supervision are now part of a check that confirms a VR GP.
  const FULL = { fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none', outcome: 'verified', ahpra_number: 'MED0001234567', registration_type: 'specialist', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2099-09-30', moratorium_19ab_confirmed: 'no' };
  const selfVr = (suffix) => buildAuDoctor('au_vr', { idSuffix: suffix, selfDeclared: true, credentials: { staff_verified_at: null, staff_verified_by: null, specialist_gp: true, fellowship_type: 'fracgp', work_rights: 'citizen' } });

  beforeAll(async () => { h = await bootAuTestServer({ name: 'fr1-r05' }); }, 60000);
  afterAll(async () => { if (h) await h.close(); });

  it('a complete, clean check confirms segment A', async () => {
    const d = selfVr('k1');
    load([d]);
    const res = await check(d, FULL);
    expect(res.status).toBe(200);
    expect(res.json.derived).toMatchObject({ pathway: 'au_vr', launched: true });
    expect(row('user_profiles', d.userId).pathway_confirmed_at).toBeTruthy();
  });
  it('the reviewer\'s case: staff answer "not on the specialist register as a GP" -> NOT au_vr, a segment review is raised, the doctor is told nothing', async () => {
    const d = selfVr('k2');
    load([d]);
    const res = await check(d, Object.assign({}, FULL, { specialist_gp: false }));
    expect(res.status).toBe(200);
    expect(res.json.derived).toMatchObject({ pathway: 'au_non_vr', launched: false });
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_non_vr');
    expect(res.json.segment_review_task_id).toBeTruthy();
    expect(res.json.n06).toBeNull();
  });
  it.each([
    ['registration type', 'registration_type'], ['the specialist answer', 'specialist_gp'], ['the 19AB answer', 'moratorium_19ab_confirmed'], ['the expiry', 'registration_expiry']
  ])('"verified" without %s is refused and nothing is written', async (_l, key) => {
    const d = selfVr('k3' + key.length);
    load([d]);
    const body = Object.assign({}, FULL); delete body[key];
    const before = JSON.stringify([row('user_profiles', d.userId), row('gp_credentials', d.userId)]);
    const res = await check(d, body);
    expect(res.status).toBe(400);
    expect(Object.keys(res.json.errors)).toContain(key);
    expect(JSON.stringify([row('user_profiles', d.userId), row('gp_credentials', d.userId)])).toBe(before);
  });
  it('a past expiry is refused as "verified" with the reason; nothing is written', async () => {
    const d = selfVr('k4');
    load([d]);
    const res = await check(d, Object.assign({}, FULL, { registration_expiry: '2020-09-30' }));
    expect(res.status).toBe(400);
    expect(res.json.errors.registration_expiry).toMatch(/has passed/);
    expect(row('gp_credentials', d.userId).staff_verified_at).toBeNull();
    expect(row('user_profiles', d.userId).pathway_confirmed_at).toBeNull();
  });
  it('a supervision level already on file keeps a clean-looking check out of segment A', async () => {
    const d = buildAuDoctor('au_vr', { idSuffix: 'k5', selfDeclared: true, credentials: { staff_verified_at: null, staff_verified_by: null, specialist_gp: true, fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'level_2' } });
    load([d]);
    // FR-2 (S2-05), deliberate: supervision is now an answer staff give in
    // the check itself, so the check carries what the register shows.
    const res = await check(d, Object.assign({}, FULL, { supervision_level: 'level_2' }));
    expect(res.status).toBe(200);
    expect(res.json.derived.pathway).toBe('au_restricted');
    expect(res.json.derived.reasons).toContain('supervised_registration');
    expect(res.json.segment_review_task_id).toBeTruthy();
  });
});
