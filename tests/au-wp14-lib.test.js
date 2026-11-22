// WP-14 (Australian GP build): the pure rules, the wording, the overseas
// parity snapshot, the staff card and the pins.
//
//   - the visa-stage rule, the sweep predicate and the mail route, as tables
//   - the banned-word exception is exactly as narrow as specified
//   - N21, the supervised-practice reminder and the doctor's transfer page
//     pass the banned-word lists (with only that exception)
//   - OVERSEAS PARITY: the migration-agent drafts and prompts, the
//     registration-granted emails and the email routing decision are byte for
//     byte what they were at the commit WP-14 started from
//   - the migration-agent "transfer" variant, used only for a transfer case
//   - college mail is never filed under 'amc' for an Australian doctor
//   - the staff card, the page, the migration and the cache-busters
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const segB = require('../lib/au-segment-b.js');
const hooksLib = require('../lib/placement-hooks.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const careerIntro = require('../lib/career-intro.js');
const messages = require('../lib/au-placement-messages.js');
const agent = require('../lib/migration-agent-reply.js');
const emailTriage = require('../lib/email-triage.js');
const grantedEmails = require('../lib/registration-granted-emails.js');
const parity = require('./helpers/au-wp14-parity.js');
const banned = require('./helpers/au-banned-words.js');

const P = (pathway, extra) => Object.assign({ flagEnabled: true, isAu: /^au_/.test(pathway), pathway, launched: pathway === 'au_vr' }, extra || {});
const SPONSORED = { work_rights: 'visa', visa_sponsor_tied: true };

describe('visaStageFor: the one place that decides whether a doctor has a visa stage', () => {
  const rows = [
    ['switch off', { flagEnabled: false, isAu: false, pathway: 'overseas_esp' }, SPONSORED, 'overseas', null],
    ['migration not applied', P('au_restricted', { schemaMissing: true }), SPONSORED, 'overseas', null],
    ['nothing recorded', P('overseas_esp'), null, 'overseas', null],
    ['overseas_pep', P('overseas_pep'), SPONSORED, 'overseas', null],
    ['pathway unreadable', P('au_restricted', { readFailed: true }), SPONSORED, 'hold', 'pathway_unreadable'],
    ['no pathway result', null, SPONSORED, 'hold', 'pathway_unreadable'],
    ['credentials unreadable', P('au_restricted'), { __unreadable: true }, 'hold', 'pathway_unreadable'],
    ['A citizen', P('au_vr'), { work_rights: 'citizen' }, 'none', 'citizen_or_permanent_resident'],
    ['A permanent resident', P('au_vr'), { work_rights: 'pr' }, 'none', 'citizen_or_permanent_resident'],
    ['A with a sponsored visa on file', P('au_vr'), SPONSORED, 'none', 'segment_has_no_visa_stage'],
    ['A with nothing on file', P('au_vr'), null, 'none', 'segment_has_no_visa_stage'],
    ['C non-VR citizen', P('au_non_vr'), { work_rights: 'citizen' }, 'none', 'citizen_or_permanent_resident'],
    ['C registrar, sponsored', P('au_registrar'), SPONSORED, 'none', 'segment_has_no_visa_stage'],
    ['B citizen', P('au_restricted'), { work_rights: 'citizen', visa_sponsor_tied: true }, 'none', 'citizen_or_permanent_resident'],
    ['B permanent resident', P('au_restricted'), { work_rights: 'pr' }, 'none', 'citizen_or_permanent_resident'],
    ['B sponsor-tied visa', P('au_restricted'), SPONSORED, 'transfer', 'visa_tied_to_an_employer'],
    ['B visa, not tied', P('au_restricted'), { work_rights: 'visa', visa_sponsor_tied: false }, 'none', 'visa_not_tied_to_an_employer'],
    ['B visa, tie not recorded', P('au_restricted'), { work_rights: 'visa' }, 'unknown', 'sponsor_tie_not_recorded'],
    ['B right to work not recorded', P('au_restricted'), { visa_sponsor_tied: true }, 'unknown', 'right_to_work_not_recorded'],
    ['B no credentials row', P('au_restricted'), null, 'unknown', 'no_credentials_on_file']
  ];
  for (const [name, pathway, cred, mode, reason] of rows) {
    it(name + ' -> ' + mode, () => {
      expect(segB.visaStageFor(pathway, cred)).toEqual({ mode, reason });
    });
  }
  it('a case may be opened only for an overseas doctor or a sponsor-tied segment B doctor; the bell only once segment B is launched', () => {
    const verdicts = { overseas: true, transfer: true, none: false, unknown: false, hold: false };
    for (const mode of Object.keys(verdicts)) expect(segB.visaCaseAllowed({ mode }), mode).toBe(verdicts[mode]);
    expect(segB.visaBellAllowed({ mode: 'overseas' }, null)).toBe(true);
    expect(segB.visaBellAllowed({ mode: 'transfer' }, { launched: false })).toBe(false);
    expect(segB.visaBellAllowed({ mode: 'transfer' }, { launched: true })).toBe(true);
    for (const mode of ['none', 'unknown', 'hold']) expect(segB.visaBellAllowed({ mode }, { launched: true }), mode).toBe(false);
  });
});

describe('supervisedSweepVerdict and ahpraMailRouteFor', () => {
  it('asks the placement-hook matrix: A and C excluded, supervised B included, unknown held', () => {
    const hooks = (pathway, cred) => hooksLib.placementHooksFor(P(pathway), cred);
    const cases = [
      [hooksLib.placementHooksFor({ flagEnabled: false, isAu: false }, null), 'overseas'],
      [hooksLib.placementHooksFor(P('overseas_esp'), null), 'overseas'],
      [hooks('au_vr', null), 'exclude'],
      [hooks('au_non_vr', null), 'exclude'],
      [hooks('au_registrar', null), 'exclude'],
      [hooks('au_restricted', { ahpra_registration_type: 'limited' }), 'include'],
      [hooks('au_restricted', { ahpra_registration_type: 'provisional' }), 'include'],
      [hooks('au_restricted', { ahpra_registration_type: 'general', supervision_level: 'level_3' }), 'include'],
      [hooks('au_restricted', { ahpra_registration_type: 'general_and_specialist', supervision_level: 'none' }), 'exclude'],
      [hooks('au_restricted', { ahpra_registration_type: 'specialist' }), 'exclude'],
      [hooks('au_restricted', {}), 'hold'],
      [hooks('au_restricted', null), 'hold'],
      [hooksLib.placementHooksFor(P('au_restricted', { readFailed: true }), null), 'hold'],
      [null, 'hold']
    ];
    for (const row of Object.keys(segB.SWEEP_ROW)) {
      cases.forEach(([h, want], i) => expect(segB.supervisedSweepVerdict(h, segB.SWEEP_ROW[row]), row + ' #' + i).toBe(want));
    }
  });
  it('mail: overseas -> today\'s pipeline; segment B -> a staff card; A, C and anything unreadable -> a plain card', () => {
    expect(segB.ahpraMailRouteFor({ mode: 'overseas', pathway: null })).toBe('overseas');
    expect(segB.ahpraMailRouteFor({ mode: 'au', pathway: 'au_restricted' })).toBe('segment_b');
    for (const p of ['au_vr', 'au_non_vr', 'au_registrar']) expect(segB.ahpraMailRouteFor({ mode: 'au', pathway: p }), p).toBe('plain_triage');
    expect(segB.ahpraMailRouteFor({ mode: 'hold', pathway: null })).toBe('plain_triage');
    expect(segB.ahpraMailRouteFor(null)).toBe('plain_triage');
  });
});

describe('the banned-word exception is exactly as narrow as specified', () => {
  const who = (over) => Object.assign({ pathway: 'au_restricted', credentials: SPONSORED, context: 'n21' }, over || {});
  it('"visa" only, for a sponsor-tied au_restricted doctor only, in N21 and on the transfer page only', () => {
    expect(auDoctorText.SPONSOR_TIED_B_EXCEPTION).toEqual({ name: 'sponsor_tied_segment_b_visa', pathway: 'au_restricted', allowedWords: ['visa'], contexts: ['n21', 'visa_transfer_page'] });
    expect(auDoctorText.sponsorTiedVisaException(who())).toEqual(['visa']);
    expect(auDoctorText.sponsorTiedVisaException(who({ context: 'visa_transfer_page' }))).toEqual(['visa']);
    // every other pathway: nothing
    for (const pathway of ['au_vr', 'au_non_vr', 'au_registrar', 'overseas_esp', 'overseas_pep', '', null, undefined, 'AU_RESTRICTED']) {
      expect(auDoctorText.sponsorTiedVisaException(who({ pathway })), String(pathway)).toEqual([]);
    }
    // a segment B doctor who is a citizen or permanent resident, or whose sponsor tie is not a confirmed "yes": nothing
    for (const credentials of [{ work_rights: 'citizen', visa_sponsor_tied: true }, { work_rights: 'pr', visa_sponsor_tied: true }, { work_rights: 'visa', visa_sponsor_tied: false },
      { work_rights: 'visa' }, { work_rights: 'visa', visa_sponsor_tied: 'true' }, { work_rights: 'visa', visa_sponsor_tied: 1 }, { visa_sponsor_tied: true }, {}, null, undefined]) {
      expect(auDoctorText.sponsorTiedVisaException(who({ credentials })), JSON.stringify(credentials)).toEqual([]);
    }
    // every other place: nothing (N11, N13, the checklist, the bell, a document email, no context at all)
    for (const context of ['n11', 'n13', 'n18', 'bell', 'prestart', 'documents', 'N21', '', null, undefined]) {
      expect(auDoctorText.sponsorTiedVisaException(who({ context })), String(context)).toEqual([]);
    }
    expect(auDoctorText.sponsorTiedVisaException(null)).toEqual([]);
    expect(auDoctorText.sponsorTiedVisaException({ context: 'n21' })).toEqual([]);
  });
  it('every other banned word still applies inside the exception, to the doctor and to the practice', () => {
    for (const [name, re] of banned.BANNED_WORDS) {
      const sample = { MyIntealth: 'MyIntealth', AMC: 'the AMC', EPIC: 'EPIC', visa: 'your visa', 'relocate / relocation': 'relocation', 'your move': 'your move', overseas: 'overseas',
        'internationally trained': 'internationally trained', GMC: 'GMC', SPPA: 'the SPPA', 'Section G': 'Section G', 'supervisor CV': 'supervisor CV', 'Not yet eligible': 'Not yet eligible' }[name];
      expect(re.test(sample), name + ' sample').toBe(true);
      expect(auDoctorText.violations(sample), name).toEqual([name]);
      expect(auDoctorText.violationsFor(sample, who()), name + ' inside the exception').toEqual(name === 'visa' ? [] : [name]);
      expect(auDoctorText.violationsFor(sample, who({ context: 'n11' })), name + ' outside it').toEqual([name]);
    }
    expect(banned.BANNED_WORDS.length).toBe(13);
    const text = 'Your visa. SPPA. Section G. internationally trained. 5%';
    expect(careerIntro.auPracticeTextViolations(text).sort()).toEqual(['%', 'SPPA', 'Section G', 'internationally trained', 'visa']);
    expect(careerIntro.auPracticeTextViolations(text, who()).sort()).toEqual(['%', 'SPPA', 'Section G', 'internationally trained']);
    expect(careerIntro.auPracticeTextViolations(text, who({ pathway: 'au_vr' })).length).toBe(5);
    expect(careerIntro.auPracticeTextViolations(text, who({ context: 'n12' })).length).toBe(5);
  });
});

describe('N21 and the supervised-practice reminder', () => {
  const who = { pathway: 'au_restricted', credentials: SPONSORED, context: 'n21' };
  it('every combination of outcomes passes the banned-word lists; "visa" appears only when the exception applies', () => {
    let combos = 0;
    for (const visaWordsAllowed of [true, false]) for (const visa of Object.values(messages.N21_VISA)) for (const moratorium of Object.values(messages.N21_MORATORIUM)) for (const supervision of Object.values(messages.N21_SUPERVISION)) {
      const input = { appBaseUrl: 'https://app.gplink-test.local', practiceName: 'Test Regional Practice (FAKE)', gpName: 'Test Aub', placementKey: 'k', moratorium, supervision, visa, visaWordsAllowed };
      const gp = messages.buildSegmentBOutcomeGpMessage(input);
      const pr = messages.buildSegmentBOutcomePracticeMessage(input);
      const gpText = [gp.subject, gp.title, gp.body, gp.ctaText].join('\n');
      const prText = [pr.subject, pr.title, pr.text].join('\n');
      const label = JSON.stringify({ visaWordsAllowed, visa, moratorium, supervision });
      if (visaWordsAllowed) {
        expect(auDoctorText.violationsFor(gpText, who), label).toEqual([]);
        expect(careerIntro.auPracticeTextViolations(prText, who), label).toEqual([]);
      } else {
        // no exception: the visa part is left out whole, whatever status was passed
        expect(auDoctorText.violations(gpText), label).toEqual([]);
        expect(careerIntro.auPracticeTextViolations(prText), label).toEqual([]);
        expect(gpText + prText, label).not.toMatch(/nomination|migration agent/i);
      }
      expect(/\bvisas?\b/i.test(gpText), label).toBe(visaWordsAllowed && visa !== 'not_applicable');
      expect(gpText + prText, label).not.toMatch(/AHPRA|Subclass|passport|\$|%/);
      expect(gp.id).toBe('N21');
      expect(pr.id).toBe('N21');
      combos += 1;
    }
    expect(combos).toBe(24);
  });
  it('an unconfirmed part means there is no message at all', () => {
    const base = { placementKey: 'k', moratorium: 'dpa_only', supervision: 'needed', visa: 'no_action' };
    expect(messages.n21Ready(base)).toEqual({ ready: true, missing: [] });
    for (const key of ['moratorium', 'supervision', 'visa']) {
      for (const bad of [null, undefined, '', 'being_confirmed', 'unsure']) {
        const input = Object.assign({}, base, { [key]: bad });
        expect(messages.n21Ready(input), key).toEqual({ ready: false, missing: [key] });
        expect(messages.buildSegmentBOutcomeGpMessage(input), key).toBe(null);
        expect(messages.buildSegmentBOutcomePracticeMessage(input), key).toBe(null);
      }
    }
  });
  it('different outcomes get a different ledger key part only through sendKey; the reminder to a practice is clean', () => {
    const a = messages.buildSegmentBOutcomeGpMessage({ placementKey: 'k', sendKey: 'aaa', moratorium: 'dpa_only', supervision: 'needed', visa: 'not_applicable' });
    const b = messages.buildSegmentBOutcomeGpMessage({ placementKey: 'k', sendKey: 'bbb', moratorium: 'dpa_only', supervision: 'needed', visa: 'not_applicable' });
    expect(a.key).toBe('au_n21_segment_b_gp:k:aaa');
    expect(b.key).not.toBe(a.key);
    const r = messages.buildSupervisionPracticeReminder({ gpName: 'Test Aub' });
    expect(r.subject).toBe('Reminder: supervised practice paperwork for Dr Test Aub');
    expect(careerIntro.auPracticeTextViolations(r.subject + '\n' + r.bodyHtml.replace(/<[^>]+>/g, ' '))).toEqual([]);
    expect(r.bodyHtml).not.toMatch(/AHPRA|Ahpra/);   // what GP Link needs, not what the regulator's process is
    expect(messages.buildSupervisionPracticeReminder({}).subject).toBe('Reminder: supervised practice paperwork for the doctor joining your practice');
  });
});

describe('the doctor\'s transfer view', () => {
  const row = { case_type: 'nomination_transfer', stage: 'lodgement', current_sponsor_name: 'Test Old Practice (FAKE)', current_visa_expiry: '2028-01-31', current_visa_subclass: '482', sponsor_name: 'Test Metro Practice (FAKE)', grant_date: null,
    transfer_decided_by: 'staff.test@gplink-test.local', notes: [{ text: 'internal note', author: 'staff' }], reference_number: 'REF-1', sponsor_contact: 'someone' };
  it('only for a transfer case; carries nothing staff recorded; passes the banned list with only the named exception', () => {
    expect(segB.doctorTransferView(null)).toBe(null);
    expect(segB.doctorTransferView({ case_type: null, stage: 'nomination' })).toBe(null);
    expect(segB.doctorTransferView({ case_type: 'new_application', stage: 'nomination' })).toBe(null);
    for (const stage of ['nomination', 'lodgement', 'processing', 'granted', 'refused']) {
      const v = segB.doctorTransferView(Object.assign({}, row, { stage, grant_date: stage === 'granted' ? '2026-11-15T00:00:00.000Z' : null }), { practiceName: 'Test Metro Practice (FAKE)' });
      const all = JSON.stringify(v);
      expect(all, stage).not.toMatch(/internal note|staff\.test|REF-1|someone|decided/);
      expect(all, stage).not.toMatch(/passport|dependant|questionnaire|apply for a visa|Subclass 482 nomination/i);
      expect(auDoctorText.violationsFor(all, { pathway: 'au_restricted', credentials: SPONSORED, context: 'visa_transfer_page' }), stage).toEqual([]);
      expect(v.steps.map((s) => s.key)).toEqual(['nomination', 'lodgement', 'processing', 'granted']);
      expect(v.startNote === '', stage).toBe(stage === 'granted');
      expect(v.approvedOn, stage).toBe(stage === 'granted' ? '15 November 2026' : '');
    }
    expect(segB.doctorTransferView(row, {}).visaExpiry).toBe('31 January 2028');
  });
});

describe('the staff input validators', () => {
  it('the transfer decision: a confirm needs the current sponsor and a real, unexpired date; "not needed" needs a reason', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    expect(segB.validateTransferDecision({}).ok).toBe(false);
    expect(segB.validateTransferDecision({ decision: 'maybe' }).ok).toBe(false);
    expect(Object.keys(segB.validateTransferDecision({ decision: 'confirm' }, { now }).errors).sort()).toEqual(['current_sponsor', 'visa_expiry']);
    expect(segB.validateTransferDecision({ decision: 'confirm', current_sponsor: 'X', visa_expiry: '2026-02-30' }, { now }).errors.visa_expiry).toBeTruthy();
    expect(segB.validateTransferDecision({ decision: 'confirm', current_sponsor: 'X', visa_expiry: '2026-01-01' }, { now }).errors.visa_expiry).toMatch(/already expired/);
    expect(segB.validateTransferDecision({ decision: 'confirm', current_sponsor: 'X', visa_expiry: '2028-01-31', visa_subclass: '<script>' }, { now }).errors.visa_subclass).toBeTruthy();
    expect(segB.validateTransferDecision({ decision: 'confirm', current_sponsor: '  Test   Old  ', visa_expiry: '2028-01-31', visa_subclass: 'Subclass 482' }, { now }))
      .toEqual({ ok: true, errors: {}, decision: 'confirm', fields: { currentSponsor: 'Test Old', visaExpiry: '2028-01-31', visaSubclass: 'Subclass 482', note: '' } });
    expect(segB.validateTransferDecision({ decision: 'not_needed' }).errors.note).toBeTruthy();
    expect(segB.validateTransferDecision({ decision: 'not_needed', note: 'Agent confirmed.' }).ok).toBe(true);
  });
  it('the Ahpra outcome and the 19AB result', () => {
    expect(Object.keys(segB.validateAhpraOutcome({}).errors).sort()).toEqual(['outcome', 'visa_action']);
    expect(segB.validateAhpraOutcome({ outcome: 'not_approved', visa_action: 'no_visa_action' }).errors.note).toBeTruthy();
    expect(segB.validateAhpraOutcome({ outcome: 'approved', visa_action: 'no_visa_action', registration_type: 'wizard' }).errors.registration_type).toBeTruthy();
    expect(segB.validateAhpraOutcome({ outcome: 'approved', visa_action: 'transfer_of_nomination', registration_type: 'limited', supervision_level: 'level_1', registration_expiry: '2027-09-30', has_conditions: true, conditions_text: 'x' }))
      .toMatchObject({ ok: true, outcome: 'approved', visaAction: 'transfer_of_nomination', credentialsPatch: { ahpra_registration_type: 'limited', supervision_level: 'level_1', registration_expiry: '2027-09-30', has_conditions: true, conditions_text: 'x' } });
    expect(segB.validateAhpraOutcome({ outcome: 'approved', visa_action: 'no_visa_action' }).credentialsPatch).toEqual({});
    expect(Object.keys(segB.validate19abResult({}).errors).sort()).toEqual(['applies', 'note']);
    expect(segB.validate19abResult({ applies: 'no', note: 'Letter sighted.', end_date: 'soon' }).errors.end_date).toBeTruthy();
    expect(segB.validate19abResult({ applies: 'YES', note: 'Letter sighted.', end_date: '2031-03-01' })).toEqual({ ok: true, errors: {}, applies: 'yes', endDate: '2031-03-01', note: 'Letter sighted.' });
  });
  it('every task carries the keys the database\'s unique index is built on, and none uses a task type the commencement card reads', () => {
    const base = { placementKey: 'pk-1', name: 'Dr Test', practiceName: 'Test Metro Practice (FAKE)' };
    const built = [segB.buildVisaTransferDecisionTask(Object.assign({ mode: 'transfer' }, base)), segB.buildSupervisionTask(base)]
      .concat(segB.TRANSFER_TASK_MARKS.map((m) => segB.buildTransferTask(m, Object.assign({ visaCaseId: 'v1', currentSponsor: 'Old' }, base))));
    const keys = built.map((f) => [f.metadata.placement_key, f.metadata.lifecycle_kind, f.metadata.mark || ''].join('|'));
    expect(new Set(keys).size).toBe(6);
    for (const f of built) {
      expect(f.metadata.placement_key).toBe('pk-1');
      expect(f.metadata.lifecycle_kind).toBeTruthy();
      expect(['invoice_due', 'guarantee_checkin', 'manual', 'followup', 'segment_review']).not.toContain(f.task_type);
      expect(f.related_stage).toBe('prestart');   // never an overseas stage
      expect(f.description).toMatch(/Done when: /);
    }
    expect(segB.buildTransferTask('nope', base)).toBe(null);
    // the task types are all in the LIVE constraint (docs/au-gp/ENVIRONMENT.md), so no constraint change is needed
    const live = read('scripts/au-local/schema/prod-schema.sql').match(/registration_tasks_task_type_check" CHECK \(task_type = ANY \(ARRAY\[([^\]]+)\]/)[1];
    for (const f of built) expect(live, f.task_type).toContain("'" + f.task_type + "'::text");
    expect(live).toContain("'ahpra_correspondence'::text");
  });
});

describe('OVERSEAS PARITY: byte for byte what it was before WP-14', () => {
  const snapshot = JSON.parse(read('tests/fixtures/au-wp14-overseas-parity.snapshot.json'));
  it('the migration-agent drafts and prompts', () => {
    const now = parity.captureMigrationAgent(agent);
    expect(JSON.stringify(now)).toBe(JSON.stringify(snapshot.migrationAgent));
    // the snapshot is of the fresh-application wording
    expect(JSON.stringify(snapshot.migrationAgent.full.replyMessages)).toMatch(/Subclass 482 nomination/);
    expect(JSON.stringify(snapshot.migrationAgent)).not.toMatch(/transfer of nomination/i);
  });
  it('the registration-granted emails (practice, passports, reminder)', () => {
    expect(JSON.stringify(parity.captureRegistrationGrantedEmails(grantedEmails))).toBe(JSON.stringify(snapshot.registrationGrantedEmails));
  });
  it('the email routing decision, over 600 inputs', () => {
    const now = parity.captureEmailRouting(emailTriage);
    expect(now.length).toBe(600);
    expect(JSON.stringify(now)).toBe(JSON.stringify(snapshot.emailRouting));
    // and what the snapshot pins: college mail for an overseas doctor is still filed under 'amc'
    const racgp = snapshot.emailRouting.find((r) => /racgp/.test(r.input.sender) && r.input.matched);
    expect(racgp.result.related_stage).toBe('amc');
  });
});

describe('the migration-agent "transfer" variant', () => {
  const params = Object.assign({}, parity.AGENT_PARAMS, { caseType: 'nomination_transfer', currentSponsor: 'Test Old Practice (FAKE)', visaSubclass: '482', visaExpiry: '31 January 2028' });
  const target = { to: 'sam@agent-test.local', cc: ['contact@practice-test.local'], name: 'Sam Agent', greeting: 'Sam', waitingOn: 'followup', subject: '' };
  const all = () => ({
    reply: agent.buildMigrationAgentReplyMessages(params),
    intro: agent.buildAgentIntroDraft(params),
    fallback: agent.buildMigrationAgentFallback(params),
    fallbackNoCopy: agent.buildMigrationAgentFallback(Object.assign({}, params, { replyCc: '' })),
    nudgeFallback: agent.buildMigrationAgentNudgeFallback(Object.assign({}, params, { target })),
    nudgeFallbackContact: agent.buildMigrationAgentNudgeFallback(Object.assign({}, params, { target: Object.assign({}, target, { waitingOn: 'contact' }) })),
    nudge: agent.buildMigrationAgentNudgeMessages(Object.assign({}, params, { target, daysSinceLastContact: 4 })),
    request: agent.buildTransferPracticeRequestDraft(params)
  });
  it('is used only for caseType "nomination_transfer"', () => {
    expect(agent.isTransferCase(params)).toBe(true);
    for (const caseType of [undefined, null, '', 'new_application', 'NOMINATION_TRANSFER', 'transfer', true]) expect(agent.isTransferCase({ caseType }), String(caseType)).toBe(false);
    expect(agent.TRANSFER_CASE_TYPE).toBe(segB.CASE_TYPE.NOMINATION_TRANSFER);
  });
  it('says transfer, never a fresh 482 nomination, a new visa, relocation, a granted registration or passports', () => {
    const out = all();
    const text = JSON.stringify(out);
    expect(text).toMatch(/transfer of (the |an )?(existing )?nomination/i);
    expect(text).toMatch(/not a new visa application/);
    expect(text).not.toMatch(/Subclass 482 nomination|prepare the Subclass|lodge .{0,20}visa|registration and relocation|has just granted|AHPRA has granted|whose AHPRA registration|passports? and supporting|overseas GPs/i);
    expect(out.reply.system[0].text).toMatch(/NEVER describe what the law or the Department requires for a transfer/);
    expect(out.reply.userText).toMatch(/"current_sponsoring_employer": "Test Old Practice \(FAKE\)"/);
    expect(out.reply.userText).not.toMatch(/practice_covers_visa_costs|Temporary Skill Shortage/);
    expect(out.intro.suggested_subject).toBe('Dr Test Overseas: transfer of nomination to Test Regional Practice (FAKE)');
    expect(out.intro.suggested_reply).toMatch(/currently sponsored by Test Old Practice \(FAKE\), on a Subclass 482 visa that is valid until 31 January 2028/);
    const overseasFallback = agent.buildMigrationAgentFallback(parity.AGENT_PARAMS);
    expect(out.fallback.outcome).toBe(overseasFallback.outcome);   // the same reading of who replied; only the wording differs
    expect(out.fallbackNoCopy.outcome).toBe(agent.buildMigrationAgentFallback(Object.assign({}, parity.AGENT_PARAMS, { replyCc: '' })).outcome);
    expect(out.request.to).toBe('contact@practice-test.local');
    // the house style of this file: no dashes in anything a person is sent
    for (const body of [out.intro.suggested_reply, out.intro.suggested_subject, out.fallback.suggested_reply, out.fallbackNoCopy.suggested_reply,
      out.nudgeFallback.suggested_reply, out.nudgeFallbackContact.suggested_reply, out.request.suggested_reply, out.request.suggested_subject]) {
      expect(body).not.toMatch(/[-‐-―−]/);
    }
    // the same result shape as the overseas builders, so the card code is shared
    const overseas = { fallback: agent.buildMigrationAgentFallback(parity.AGENT_PARAMS), nudge: agent.buildMigrationAgentNudgeFallback(Object.assign({}, parity.AGENT_PARAMS, { target })) };
    expect(Object.keys(out.fallback).sort()).toEqual(Object.keys(overseas.fallback).sort());
    expect(Object.keys(out.nudgeFallback).sort()).toEqual(Object.keys(overseas.nudge).sort());
  });
  it('the segment B practice draft after an Ahpra outcome: two variants, neither a fresh application', () => {
    const ctx = { practiceName: 'Test Metro Practice (FAKE)', contactName: 'Test Manager', contactEmail: 'manager@practice-test.local', gpName: 'Test Aub', commencementDate: '2027-02-01', senderName: 'Test Rso', supervisionApproved: true };
    const transfer = grantedEmails.buildSegmentBPracticeOutcomeEmail(Object.assign({ visaAction: 'transfer_of_nomination', sponsorTied: true }, ctx));
    expect(transfer.variant).toBe('transfer_of_nomination');
    expect(transfer.bodyText).toMatch(/transfer of the existing nomination, not a new visa application/);
    const none = grantedEmails.buildSegmentBPracticeOutcomeEmail(Object.assign({ visaAction: 'no_visa_action', sponsorTied: true }, ctx));
    expect(none.variant).toBe('no_visa_action');
    // "transfer" asked for a doctor who is not sponsor-tied falls back to saying nothing about a visa
    const notTied = grantedEmails.buildSegmentBPracticeOutcomeEmail(Object.assign({ visaAction: 'transfer_of_nomination', sponsorTied: false }, ctx));
    expect(notTied.variant).toBe('no_visa_action');
    for (const d of [none, notTied]) {
      expect(d.subject + d.bodyText).not.toMatch(/\bvisas?\b|nomination|migration agent/i);
      expect(careerIntro.auPracticeTextViolations(d.subject + '\n' + d.bodyText)).toEqual([]);
    }
    for (const d of [transfer, none, notTied]) {
      expect(d.subject + d.bodyText).not.toMatch(/Subclass 482|passport|AHPRA|relocat|overseas|[-‐-―−]/);
      expect(d.to).toBe('manager@practice-test.local');
    }
    expect(careerIntro.auPracticeTextViolations(transfer.subject + '\n' + transfer.bodyText, { pathway: 'au_restricted', credentials: SPONSORED, context: 'n21' })).toEqual([]);
    expect(grantedEmails.SEGMENT_B_VISA_ACTIONS).toEqual(Object.values(segB.VISA_ACTION));
  });
});

describe('college mail (ADM-23)', () => {
  const route = (sender, extra) => emailTriage.resolveEmailRouting(Object.assign({ sender, subject: 'Your fellowship', bodySnippet: '', category: 'other', urgency: '', matched: true, gpStage: 'prestart', senderIsGp: false }, extra || {}));
  const au = { auPathway: { isAu: true, stage: 'prestart' } };
  it('RACGP and ACRRM mail for an Australian-pathway doctor is college correspondence under the case\'s own stage, never amc', () => {
    for (const sender of ['RACGP <exams@racgp.org.au>', 'training@acrrm.org.au', 'cpd@members.racgp.org.au']) {
      const r = route(sender, au);
      expect(r, sender).toEqual({ category: 'college', related_stage: 'prestart', priority: 'high', regulator: true, college: true });
    }
    // no overseas stage for any regulator or government sender, at any Australian stage
    for (const stage of ['placement', 'prestart', 'commenced', 'guarantee', 'complete']) {
      for (const sender of parity.ROUTING_SENDERS) {
        const r = route(sender, { auPathway: { isAu: true, stage }, gpStage: stage });
        expect(['amc', 'ahpra', 'visa', 'pbs', 'myintealth', 'career', 'commencement'], sender + ' @ ' + stage).not.toContain(r.related_stage);
        expect([stage, 'practice_contact'], sender + ' @ ' + stage).toContain(r.related_stage);
      }
    }
    expect(route('assess@amc.org.au', au)).toMatchObject({ category: 'regulator', related_stage: 'prestart', college: false });
  });
  it('an overseas doctor, an unmatched email and a missing flag are exactly as before', () => {
    expect(route('exams@racgp.org.au')).toEqual({ category: 'regulator', related_stage: 'amc', priority: 'high', regulator: true });
    expect(route('exams@racgp.org.au', { auPathway: null })).toEqual({ category: 'regulator', related_stage: 'amc', priority: 'high', regulator: true });
    expect(route('exams@racgp.org.au', { auPathway: { isAu: false, stage: 'prestart' } }).related_stage).toBe('amc');
    // unmatched mail never reaches the Australian branch (no doctor, so no pathway)
    expect(route('exams@racgp.org.au', Object.assign({ matched: false }, au))).toEqual({ category: 'regulator', related_stage: 'amc', priority: 'low', regulator: true });
    expect(emailTriage.COLLEGE_DOMAINS).toEqual(['racgp.org.au', 'acrrm.org.au']);
  });
});

describe('the staff "Segment B" card', () => {
  const sandbox = { window: {}, document: null };
  sandbox.globalThis = sandbox.window;
  vm.runInNewContext(read('js/au-segment-b.js'), sandbox);
  const card = sandbox.window.GPAuSegmentB;
  const moratorium = { doctor_answer: 'yes', staff_confirmed: null, dpa_restricted: true, check_tasks: [{ id: 't1', title: '19AB and DPA check: Dr Test', status: 'open', open: true }], exemption_letter: { has: false } };
  const bView = (over) => Object.assign({
    ok: true, applies: true, segment: 'B', launched: false, moratorium, placement: { key: 'pk', practice_name: 'Test Metro Practice (FAKE)' },
    visa: { mode: 'transfer', reason: 'visa_tied_to_an_employer', work_rights: 'visa', sponsor_tied: true, sponsor_name: 'Test Old Practice (FAKE)', visa_expiry: '2028-01-31', visa_subclass: '482',
      decision: { task_id: 'd1', open: true, status: null, what_to_do: 'Confirm with the doctor.' }, transfer_case: null, tasks: [], grant_notice: { has: false } },
    supervision: { supervised: true, registration_type: 'limited', supervision_level: 'level_2', registration_verified: true, task: { id: 's1', title: 'Supervision: lodge', status: 'open', open: true, approval_filed: false }, pack_tasks: [], approval_document: { has: false }, registration_types: ['general', 'limited'], supervision_levels: ['none', 'level_1'] },
    can: { complete_19ab: true, decide_visa: true, update_transfer: false, nomination_approved: false, record_ahpra_outcome: true, send_n21: true }
  }, over || {});
  it('shows nothing for a segment A doctor with no check task, and only the 19AB part for segment C', () => {
    expect(card._hasContent(null)).toBe(false);
    expect(card._hasContent({ ok: false })).toBe(false);
    expect(card._hasContent({ ok: true, applies: false, segment: 'A', moratorium: { check_tasks: [] }, can: { complete_19ab: false } })).toBe(false);
    expect(card._hasContent({ ok: true, applies: false, segment: 'C', moratorium, can: { complete_19ab: true } })).toBe(true);
    expect(card._hasContent(bView())).toBe(true);
    const c = card._viewHtml({ ok: true, applies: false, segment: 'C', moratorium, can: { complete_19ab: true } }, '');
    expect(c).toContain('19AB and DPA check');
    expect(c).not.toMatch(/Visa|Supervision<|Record Ahpra outcome/);
  });
  it('an undecided sponsor-tied doctor: "Decision needed" with Confirm and Not needed; the forms post the right action', () => {
    const html = card._viewHtml(bView(), '');
    expect(html).toContain('Decision needed.');
    expect(html).toContain('data-asb-open="visa-transfer/decision:confirm"');
    expect(html).toContain('data-asb-open="visa-transfer/decision:not_needed"');
    expect(html).toContain('This pathway is not launched');
    expect(html).toContain('data-asb-open="dpa-19ab"');
    expect(html).toContain('data-asb-open="ahpra-outcome"');
    const confirm = card._formHtml('visa-transfer/decision:confirm', bView());
    expect(confirm).toContain('data-asb-form="visa-transfer/decision:confirm"');
    expect(confirm).toContain('name="decision" value="confirm"');
    expect(confirm).toContain('name="current_sponsor" maxlength="200" value="Test Old Practice (FAKE)"');
    expect(confirm).toContain('name="visa_expiry" value="2028-01-31"');
    expect(confirm).toContain('Nothing is sent to the doctor or the practice.');
    expect(card._formHtml('visa-transfer/decision:not_needed', bView())).toContain('name="decision" value="not_needed"');
    expect(card._formHtml('ahpra-outcome', bView())).toContain('<option value="transfer_of_nomination">Transfer of nomination</option><option value="no_visa_action">No visa action</option>');
    expect(card._formHtml('dpa-19ab', bView())).toContain('name="applies"');
  });
  it('a confirmed transfer: the case, its tasks, "Nomination approved"; a citizen: "no visa step" and no decision buttons', () => {
    const open = bView({ visa: Object.assign({}, bView().visa, { decision: { status: 'confirm' }, transfer_case: { id: 'v1', stage: 'nomination', stage_label: 'Being prepared', current_sponsor_name: 'Test Old Practice (FAKE)', new_employer: 'Test Metro Practice (FAKE)', current_visa_expiry: '2028-01-31' }, tasks: [{ id: 't', title: 'Brief the migration agent', status: 'open', open: true }], drafts: { practice_request: { subject: 'S1', body: 'B1' }, agent_brief: { subject: 'S2', body: 'B2' } } }),
      can: Object.assign({}, bView().can, { decide_visa: false, update_transfer: true, nomination_approved: true }) });
    const html = card._viewHtml(open, '');
    expect(html).toContain('Nomination-transfer case open: Being prepared.');
    expect(html).toContain('data-asb-open="visa-transfer/nomination-approved"');
    expect(html).not.toContain('data-asb-open="visa-transfer/decision:confirm"');
    expect(html).toContain('Drafts for the transfer (not sent)');
    const citizen = bView({ visa: { mode: 'none', reason: 'citizen_or_permanent_resident', work_rights: 'citizen', decision: null, transfer_case: null, tasks: [] }, can: Object.assign({}, bView().can, { decide_visa: false }) });
    const ch = card._viewHtml(citizen, '');
    expect(ch).toContain('Citizen or permanent resident: there is no visa step. No visa case, task or page exists for this doctor.');
    expect(ch).not.toContain('visa-transfer/decision');
  });
  it('N21: no Send button until a preview says every outcome is confirmed; the send form needs the tick', () => {
    expect(card._viewHtml(bView(), '')).not.toContain('data-asb-open="n21-send"');
    const notReady = card._viewHtml(Object.assign(bView(), { __preview: { ready: false, missing: ['visa', 'supervision'] } }), '');
    expect(notReady).toContain('This update cannot be sent yet. Not confirmed: the visa decision; the supervision answer');
    expect(notReady).not.toContain('data-asb-open="n21-send"');
    const ready = Object.assign(bView(), { __preview: { ready: true, missing: [], practice_email_on_file: true, gp: { subject: 'GS', body: 'GB' }, practice: { subject: 'PS', text: 'PT' } } });
    expect(card._viewHtml(ready, '')).toContain('data-asb-open="n21-send"');
    const form = card._formHtml('n21-send', ready);
    expect(form).toContain('<pre>GS\n\nGB</pre>');
    expect(form).toContain('name="confirm"> I have checked each outcome');
    expect(form).not.toMatch(/name="confirm" checked/);
  });
  it('everything a person typed is escaped', () => {
    const evil = bView({ visa: Object.assign({}, bView().visa, { sponsor_name: '<img src=x onerror=1>' }) });
    expect(card._viewHtml(evil, 'visa-transfer/decision:confirm')).not.toContain('<img src=x');
  });
});

describe('where the card and the page are loaded, and the pins', () => {
  const candidates = read('js/ceo-ats-candidates.js');
  const admin = read('pages/admin.html');
  const ceo = read('pages/ceo-dashboard.html');
  it('the card script is fetched only for an Australian case, never by a script tag, from the same version on both pages', () => {
    const SRC = /AU_SEGMENT_B_SRC\s*=\s*['"]\/js\/au-segment-b\.js\?v=(\w+)['"]/;
    expect(ceo).not.toContain('au-segment-b.js');
    expect(admin).not.toMatch(/<script[^>]+au-segment-b\.js/);
    expect(SRC.exec(candidates)[1]).toBe(SRC.exec(admin)[1]);
    expect(SRC.exec(candidates)[1]).toBe('20261121a');
    const at = candidates.indexOf('function auMountSegmentB(c) {');
    expect(candidates.slice(at, candidates.indexOf('\n  }\n', at))).toContain("if (!auOn || !c || !c.au || !c.au.pathway || !c.au.pathway.isAu || !c.case_id) return;");
    const cards = candidates.slice(candidates.indexOf('function auCardsHtml(c) {'), candidates.indexOf('function auLoadSegmentBScript() {'));
    expect(cards.indexOf('ats-au-segment-b-card')).toBeGreaterThan(cards.indexOf('if (c.au.pathway && c.au.pathway.isAu) {'));
    const mountAt = admin.indexOf('function auMountSegmentBCard(c){');
    const mount = admin.slice(mountAt, admin.indexOf('\n  }\n', mountAt));
    expect(mount.indexOf('if(!auCaseLooksAustralian(c)||!c.id) return;')).toBeGreaterThan(-1);
    expect(mount.indexOf('if(!auCaseLooksAustralian(c)||!c.id) return;')).toBeLessThan(mount.indexOf('document.createElement("div")'));
    expect(admin).toContain('auMountSegmentBCard(c); // WP-14');
    expect(read('sw.js')).not.toContain('au-segment-b.js?v');   // not precached: it is only ever needed by staff on an Australian case
  });
  it('cache-busters moved: the Candidates script, the stylesheet with it, and the service worker', () => {
    const cand = ceo.match(/ceo-ats-candidates\.js\?v=(\w+)/)[1];
    const css = ceo.match(/ceo-ats\.css\?v=(\w+)/)[1];
    expect(cand).toBe('20261122a');
    expect(css >= cand).toBe(true);
    expect(read('sw.js')).toContain('var VERSION = "20261122d"');
  });
  it('every inline script on the pages this package touched still parses, and so do its scripts', () => {
    for (const page of ['pages/admin.html', 'pages/ceo-dashboard.html', 'pages/visa-transfer-au.html', 'pages/visa.html', 'pages/admin-visa.html']) {
      const html = read(page);
      const scripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]).filter((s) => s.trim());
      expect(scripts.length, page).toBeGreaterThan(0);
      scripts.forEach((src, i) => { expect(() => new vm.Script(src), page + ' inline script ' + i).not.toThrow(); });
    }
    for (const js of ['js/au-segment-b.js', 'js/ceo-ats-candidates.js', 'lib/au-segment-b.js', 'lib/migration-agent-reply.js']) expect(() => new vm.Script(read(js)), js).not.toThrow();
  });
  it('the transfer page: only "visa" of the banned words, no fresh-application flow, and it never loads the phrase guard that would blank it', () => {
    const html = read('pages/visa-transfer-au.html');
    const visible = banned.stripHtmlComments(html);
    expect(banned.bannedIn(visible).filter((w) => w !== 'visa')).toEqual([]);
    expect(visible).not.toMatch(/passport|dependant|questionnaire|Subclass 482|migration agent will lodge|upload/i);
    expect(html).not.toMatch(/<script[^>]+au-localise\.js/);
    expect(html).not.toContain('gp_au_pathway_hint');
    expect(visible).toContain('fetch("/api/gp/au-visa-transfer"');
    // the overseas visa page is untouched by this package
    expect(read('pages/visa.html')).not.toContain('auTransferRoot');
  });
  it('no raw control characters in the files this package wrote', () => {
    for (const f of ['lib/au-segment-b.js', 'js/au-segment-b.js', 'pages/visa-transfer-au.html', 'lib/migration-agent-reply.js', 'lib/au-doctor-text.js', 'tests/au-wp14-lib.test.js']) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(read(f)), f).toBe(false);
    }
  });
});

describe('the migration', () => {
  const sql = read('supabase/migrations/20261121120000_au_gp_wp14_visa_transfer.sql');
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  it('is additive and re-runnable: nullable columns, a CHECK on a new column only, one partial unique index', () => {
    expect(code).not.toMatch(/\bdrop\b|\brename\b|\bupdate\b|\bdelete\b|\btruncate\b|\bbegin\s*;|\bcommit\b|not null|default/i);
    const cols = Array.from(code.matchAll(/add column if not exists (\w+) (\w+)/g)).map((m) => m[1]);
    expect(cols).toEqual(require('./helpers/au-fixtures.js').WP14_NEW_COLUMN_NAMES.visa_applications);
    expect(code).toMatch(/check \(case_type is null or case_type in \('new_application', 'nomination_transfer'\)\)\s+not valid/);
    expect(code).toContain('alter table public.visa_applications validate constraint visa_applications_case_type_check;');
    expect(code).toMatch(/create unique index if not exists uniq_visa_nomination_transfer\s+on public\.visa_applications \(user_id, transfer_placement_key\)\s+where case_type = 'nomination_transfer';/);
    expect(code).not.toMatch(/alter table (?!public\.)/);
  });
  it('touches only visa_applications, whose LIVE table has no constraint on anything it reuses but the stage list', () => {
    expect(Array.from(code.matchAll(/(?:alter table|on) public\.(\w+)/g)).map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i)).toEqual(['visa_applications']);
    const prod = read('scripts/au-local/schema/prod-schema.sql');
    const checks = prod.split('\n').filter((l) => /alter table public\."visa_applications" add constraint/.test(l) && / CHECK /.test(l));
    expect(checks.length).toBe(1);
    expect(checks[0]).toContain("ARRAY['nomination'::text, 'lodgement'::text, 'processing'::text, 'granted'::text, 'refused'::text]");
    // every stage the transfer copy knows is in that live list
    for (const stage of Object.keys(segB.TRANSFER_STAGE_COPY)) expect(checks[0], stage).toContain("'" + stage + "'::text");
    for (const col of ['case_type', 'current_sponsor_name', 'current_visa_expiry', 'transfer_placement_key']) expect(prod, col).not.toMatch(new RegExp('"' + col + '"'));
  });
});
