// WP-11 (Australian GP build): the pure rules behind the placement branch.
//
//   lib/placement-hooks.js        the ONE decision: the placement-hook matrix
//                                 of docs/au-gp/review-report.md, column by
//                                 column, plus the D8 action rule
//   lib/au-prestart.js            the task set, owners, due-date rules,
//                                 completion conditions
//   lib/au-placement-messages.js  N11 to N14, and the bell items that survive
//                                 an open browser
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hooksLib = require('../lib/placement-hooks.js');
const prestart = require('../lib/au-prestart.js');
const messages = require('../lib/au-placement-messages.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const careerIntro = require('../lib/career-intro.js');
const auWhatsApp = require('../lib/au-whatsapp-templates.js');
const documentRequirements = require('../lib/document-requirements.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');

const { placementHooksFor } = hooksLib;

// AGENT-RULES section 4, plus the upper-case regulator spelling.
const DOCTOR_BANNED = /MyIntealth|\bAMC\b|\bEPIC\b|\bvisas?\b|relocat|your move|overseas|internationally trained|\bGMC\b|\bSPPA\b|Section G|supervisor CV|Not yet eligible/i;
const UPPER_REGULATOR = /AHPRA/; // new Australian copy writes "Ahpra"

function resolved(kind, overrides) {
  const d = buildAuDoctor(kind, overrides);
  const p = candidatePathway.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: true });
  return { d, p };
}
function hooksOf(kind, overrides) {
  const { d, p } = resolved(kind, overrides);
  return placementHooksFor(p, d.credentials);
}

describe('placementHooksFor: the placement-hook matrix, column by column', () => {
  const overseas = hooksOf('overseas_null');
  const a = hooksOf('au_vr');
  const bSupervised = hooksOf('au_restricted', { credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_2' } });
  const bGeneral = hooksOf('au_restricted', { credentials: { ahpra_registration_type: 'general', work_rights: 'pr', visa_sponsor_tied: null, supervision_level: 'none' } });
  const cNonVr = hooksOf('au_non_vr');
  const cRegistrar = hooksOf('au_registrar');

  it('names the column', () => {
    expect(overseas.column).toBe('overseas');
    expect(a.column).toBe('A');
    expect(bSupervised.column).toBe('B');
    expect(bGeneral.column).toBe('B');
    expect(cNonVr.column).toBe('C');
    expect(cRegistrar.column).toBe('C');
  });

  it('row 1, offer accepted / hired / placement row / job filled: fire for all', () => {
    for (const h of [overseas, a, bSupervised, bGeneral, cNonVr, cRegistrar]) {
      expect([h.offerAccepted, h.hired, h.placementRow, h.jobFilled]).toEqual(['fire', 'fire', 'fire', 'fire']);
    }
  });

  it('row 2, practice "Placement confirmed" email: overseas fire; A, B, C variant (N12)', () => {
    expect(overseas.practiceConfirmedEmail).toBe('fire');
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect(h.practiceConfirmedEmail).toBe('variant');
  });

  it('row 3, contract task: fire for all', () => {
    for (const h of [overseas, a, bSupervised, bGeneral, cNonVr, cRegistrar]) {
      expect(h.contractTask).toBe('fire');
      expect(h.practicePackKeys).toContain('offer_contract');
    }
  });

  it('row 4, position description task: overseas fire; A skip; B only if an Ahpra or visa change needs it; C a staff decision (variant not confirmed)', () => {
    expect(overseas.positionDescriptionTask).toBe('fire');
    expect(a.positionDescriptionTask).toBe('skip');
    expect(bSupervised.positionDescriptionTask).toBe('fire');
    expect(bGeneral.positionDescriptionTask).toBe('skip');
    // general registration but the right to work is tied to a sponsor: a visa change needs it
    expect(hooksOf('au_restricted').positionDescriptionTask).toBe('fire');
    expect(cNonVr.positionDescriptionTask).toBe('review');
    expect(cRegistrar.positionDescriptionTask).toBe('review');
    expect(cNonVr.practicePackKeys).not.toContain('position_description');
  });

  it('row 5, supervisor CV and SPPA-00 tasks: overseas fire; A skip; B only when registration is limited, provisional or supervised; C skip', () => {
    expect([overseas.supervisorCvTask, overseas.sppa00Task]).toEqual(['fire', 'fire']);
    expect([a.supervisorCvTask, a.sppa00Task]).toEqual(['skip', 'skip']);
    expect([bSupervised.supervisorCvTask, bSupervised.sppa00Task]).toEqual(['fire', 'fire']);
    expect([bGeneral.supervisorCvTask, bGeneral.sppa00Task]).toEqual(['skip', 'skip']);
    expect([cNonVr.supervisorCvTask, cNonVr.sppa00Task]).toEqual(['skip', 'skip']);
    expect([cRegistrar.supervisorCvTask, cRegistrar.sppa00Task]).toEqual(['skip', 'skip']);
    for (const type of ['provisional', 'limited']) {
      const h = hooksOf('au_restricted', { credentials: { ahpra_registration_type: type, supervision_level: 'none' } });
      expect(h.supervisorCvTask, type).toBe('fire');
    }
    // general registration with a supervision level on file is supervised
    expect(hooksOf('au_restricted', { credentials: { ahpra_registration_type: 'general', supervision_level: 'level_1' } }).sppa00Task).toBe('fire');
  });

  it('row 6, Section G task and auto-delivered PDF: overseas fire; A skip; B only with SPPA-00; C skip', () => {
    expect([overseas.sectionGTask, overseas.sectionGDelivery]).toEqual(['fire', 'fire']);
    expect([a.sectionGTask, a.sectionGDelivery]).toEqual(['skip', 'skip']);
    expect([bSupervised.sectionGTask, bSupervised.sectionGDelivery]).toEqual(['fire', 'fire']);
    expect([bGeneral.sectionGTask, bGeneral.sectionGDelivery]).toEqual(['skip', 'skip']);
    expect([cNonVr.sectionGTask, cNonVr.sectionGDelivery]).toEqual(['skip', 'skip']);
    for (const h of [overseas, a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect(h.sectionGTask).toBe(h.sppa00Task);
  });

  it('row 7, practice-pack email to the GP: overseas fire; A skip and send the pre-start checklist; B, C the checklist variant', () => {
    expect(overseas.practicePackEmail).toBe('fire');
    expect(overseas.gpPlacementMessage).toBe('fire');
    expect(overseas.gpPrestartChecklist).toBe('skip');
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) {
      expect(h.practicePackEmail).toBe('skip');
      expect(h.gpPlacementMessage).toBe('variant');
      expect(h.gpPrestartChecklist).toBe('fire');
    }
  });

  it('row 8, Drive folder and document copy: fire for all; no link-public copy for an Australian doctor', () => {
    for (const h of [overseas, a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect(h.driveFolder).toBe('fire');
    expect(overseas.driveDocumentCopy).toBe('fire');
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect(h.driveDocumentCopy).toBe('variant');
  });

  it('row 9, "AHPRA stage" WhatsApp and AHPRA-unlocked email: overseas fire; A, B, C skip', () => {
    expect([overseas.ahpraStageWhatsApp, overseas.ahpraUnlockedEmail]).toEqual(['fire', 'fire']);
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect([h.ahpraStageWhatsApp, h.ahpraUnlockedEmail]).toEqual(['skip', 'skip']);
  });

  it('row 10, case stage: overseas ahpra; A, B, C prestart', () => {
    expect(overseas.caseStage).toBe('ahpra');
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect(h.caseStage).toBe('prestart');
  });

  it('row 11, AHPRA-granted handler and visa case: overseas fire; Australian skip (the B visa-transfer exception is exposed, not acted on)', () => {
    expect([overseas.ahpraGrantedHandler, overseas.visaCase]).toEqual(['fire', 'fire']);
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect([h.ahpraGrantedHandler, h.visaCase]).toEqual(['skip', 'skip']);
    expect(hooksOf('au_restricted').visaTransferMayApply).toBe(true);
    expect(bGeneral.visaTransferMayApply).toBe(false);
    expect(a.visaTransferMayApply).toBe(false);
  });

  it('rows 12 to 14 (WP-12 / WP-13 build them): the results are exposed', () => {
    expect([overseas.medicarePbsModule, overseas.medicarePbsVariant]).toEqual(['fire', 'overseas']);
    expect(a.medicarePbsVariant).toBe('provider_number_new_location');
    expect(bGeneral.medicarePbsVariant).toBe('provider_number_plus_19ab_check');
    expect(cNonVr.medicarePbsVariant).toBe('provider_number_plus_program_approval');
    expect([overseas.commencementChecklist, a.commencementChecklist, bGeneral.commencementChecklist, cNonVr.commencementChecklist]).toEqual(['fire', 'variant', 'fire', 'fire']);
    expect(a.commencementVariant).toBe('no_travel_items');
    expect(overseas.invoicePrompt).toBe('skip');
    for (const h of [a, bGeneral, cNonVr]) expect([h.invoicePrompt, h.invoiceVariant]).toEqual(['variant', 'on_commencement']);
  });

  it('the pre-start work and the RSO are Australian only', () => {
    expect([overseas.prestartTasks, overseas.assignRsoForPrestart]).toEqual(['skip', 'skip']);
    for (const h of [a, bSupervised, bGeneral, cNonVr, cRegistrar]) expect([h.prestartTasks, h.assignRsoForPrestart]).toEqual(['fire', 'fire']);
  });

  it('the practice pack to create now, in the cascade\'s own order', () => {
    expect(overseas.practicePackKeys).toEqual(['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']);
    expect(a.practicePackKeys).toEqual(['offer_contract']);
    expect(bSupervised.practicePackKeys).toEqual(['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']);
    expect(bGeneral.practicePackKeys).toEqual(['offer_contract']);
    expect(cNonVr.practicePackKeys).toEqual(['offer_contract']);
    expect(overseas.overseasCascade).toBe(true);
    for (const h of [a, bSupervised, bGeneral, cNonVr]) expect(h.overseasCascade).toBe(false);
  });
});

describe('placementHooksFor: what is not known fails closed', () => {
  it('segment B with nothing on file about registration: no supervision paperwork either way, a staff decision', () => {
    const none = hooksOf('au_restricted', { credentials: { ahpra_registration_type: null, supervision_level: null, work_rights: null, visa_sponsor_tied: null } });
    expect([none.supervisorCvTask, none.sppa00Task, none.sectionGTask, none.sectionGDelivery, none.positionDescriptionTask])
      .toEqual(['review', 'review', 'review', 'review', 'review']);
    expect(none.practicePackKeys).toEqual(['offer_contract']);
    expect(none.staffReview.reasons).toEqual(['supervision_unknown', 'visa_change_unknown']);
    expect(none.supervised).toBe(null);
    // no credentials row at all
    const { p } = resolved('au_restricted');
    const noRow = placementHooksFor(p, null);
    expect(noRow.supervisorCvTask).toBe('review');
    expect(noRow.staffReview).toBeTruthy();
  });

  it('segment B: registration known to be unsupervised, but the right to work is not recorded: only the position description is undecided', () => {
    const h = hooksOf('au_restricted', { credentials: { ahpra_registration_type: 'general', supervision_level: 'none', work_rights: 'visa', visa_sponsor_tied: null } });
    expect(h.supervisorCvTask).toBe('skip');
    expect(h.positionDescriptionTask).toBe('review');
    expect(h.staffReview.reasons).toEqual(['visa_change_unknown']);
  });

  it('segment C always raises a staff decision (its position-description variant is not confirmed)', () => {
    expect(hooksOf('au_non_vr').staffReview.reasons).toEqual(['segment_c_practice_paperwork']);
    expect(hooksOf('au_registrar').staffReview.reasons).toEqual(['segment_c_practice_paperwork']);
    expect(hooksOf('au_vr').staffReview).toBe(null);
    expect(hooksOf('overseas_null').staffReview).toBe(null);
  });

  it('an unreadable pathway holds every pathway-dependent row; the neutral rows still fire', () => {
    for (const p of [{ flagEnabled: true, readFailed: true }, { flagEnabled: true, readFailed: true, isAu: false, pathway: 'overseas_esp' }, null, undefined]) {
      const h = placementHooksFor(p, null);
      expect(h.column).toBe('hold');
      expect(h.hold).toBe(true);
      expect([h.offerAccepted, h.hired, h.placementRow, h.jobFilled, h.contractTask, h.driveFolder]).toEqual(['fire', 'fire', 'fire', 'fire', 'fire', 'fire']);
      for (const row of ['practiceConfirmedEmail', 'positionDescriptionTask', 'supervisorCvTask', 'sppa00Task', 'sectionGTask', 'sectionGDelivery',
        'practicePackEmail', 'gpPlacementMessage', 'gpPrestartChecklist', 'driveDocumentCopy', 'ahpraStageWhatsApp', 'ahpraUnlockedEmail',
        'ahpraGrantedHandler', 'visaCase', 'prestartTasks', 'assignRsoForPrestart', 'invoicePrompt']) {
        expect(h[row], row).toBe('hold');
      }
      expect(h.caseStage).toBe(null);
      expect(h.practicePackKeys).toEqual(['offer_contract']);
      expect(h.overseasCascade).toBe(false);
      expect(h.isAu).toBe(false);
    }
  });

  it('switch off, migration not applied, nothing recorded, an overseas value: the overseas column, whatever else the result says', () => {
    const cases = [
      { flagEnabled: false, isAu: false, pathway: 'overseas_esp' },
      { flagEnabled: false, isAu: true, pathway: 'au_vr' },           // switch off wins
      { flagEnabled: true, schemaMissing: true, isAu: false },
      { flagEnabled: true, schemaMissing: true, readFailed: true },    // schema missing is not "unknown"
      { flagEnabled: true, isAu: false, pathway: 'overseas_pep' },
      candidatePathway.overseasDefault({ flagEnabled: true }),
      candidatePathway.overseasDefault({ flagEnabled: false })
    ];
    const want = placementHooksFor({ flagEnabled: true, isAu: false, pathway: 'overseas_esp' }, null);
    for (const p of cases) {
      const h = placementHooksFor(p, null);
      expect(h.column).toBe('overseas');
      expect(h.overseasCascade).toBe(true);
      expect(h.practicePackKeys).toEqual(want.practicePackKeys);
      expect(h.caseStage).toBe('ahpra');
    }
  });

  it('credentials are never read for an overseas doctor (a stray row changes nothing)', () => {
    const h = placementHooksFor({ flagEnabled: true, isAu: false, pathway: 'overseas_esp' }, { ahpra_registration_type: 'limited', work_rights: 'visa' });
    expect(h).toEqual(placementHooksFor({ flagEnabled: true, isAu: false, pathway: 'overseas_esp' }, null));
  });

  it('supervisionFacts: null means not known, never a guess', () => {
    expect(hooksLib.supervisionFacts(null)).toEqual({ supervised: null, visaChange: null });
    expect(hooksLib.supervisionFacts({})).toEqual({ supervised: null, visaChange: null });
    expect(hooksLib.supervisionFacts({ ahpra_registration_type: 'non_practising' }).supervised).toBe(null);
    expect(hooksLib.supervisionFacts({ ahpra_registration_type: 'general', work_rights: 'citizen' })).toEqual({ supervised: false, visaChange: false });
    expect(hooksLib.supervisionFacts({ ahpra_registration_type: 'provisional', work_rights: 'visa', visa_sponsor_tied: true })).toEqual({ supervised: true, visaChange: true });
    expect(hooksLib.supervisionFacts({ ahpra_registration_type: 'general', work_rights: 'visa', visa_sponsor_tied: false })).toEqual({ supervised: false, visaChange: false });
  });
});

describe('D8: overseas actions on an Australian case', () => {
  const A = hooksOf('au_vr');
  const bSupervised = hooksOf('au_restricted', { credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_2' } });
  const bUnknown = hooksOf('au_restricted', { credentials: { ahpra_registration_type: null, supervision_level: null } });
  const C = hooksOf('au_non_vr');
  const overseas = hooksOf('overseas_null');
  const OA = hooksLib.OVERSEAS_ACTION;

  it('an overseas doctor: everything is allowed, exactly as today', () => {
    for (const action of Object.values(OA)) expect(hooksLib.overseasActionVerdict(overseas, action)).toEqual({ allowed: true });
  });

  it('segment A: every overseas action is refused except the contract', () => {
    for (const action of Object.values(OA)) {
      const v = hooksLib.overseasActionVerdict(A, action);
      if (action === OA.OFFER_CONTRACT) expect(v.allowed).toBe(true);
      else {
        expect(v.allowed, action).toBe(false);
        expect(v.code).toBe('au_pathway');
        expect(v.message).toMatch(/Australian pathway/);
      }
    }
  });

  it('segment B with supervised registration keeps what the matrix allows', () => {
    for (const action of [OA.SUPERVISOR_CV, OA.ALT_SUPERVISOR_CV, OA.SPPA, OA.SECTION_G, OA.POSITION_DESCRIPTION, OA.AHPRA_CONFLICT_LETTER, OA.OFFER_CONTRACT]) {
      expect(hooksLib.overseasActionVerdict(bSupervised, action).allowed, action).toBe(true);
    }
    for (const action of [OA.AHPRA_LETTER, OA.REGISTRATION_GRANTED, OA.PRACTICE_PACK_TASK]) {
      expect(hooksLib.overseasActionVerdict(bSupervised, action).allowed, action).toBe(false);
    }
  });

  it('segment B not yet decided, and segment C\'s position description: refused until a person decides', () => {
    expect(hooksLib.overseasActionVerdict(bUnknown, OA.SUPERVISOR_CV)).toMatchObject({ allowed: false, code: 'needs_staff_decision' });
    expect(hooksLib.overseasActionVerdict(C, OA.POSITION_DESCRIPTION)).toMatchObject({ allowed: false, code: 'needs_staff_decision' });
    expect(hooksLib.overseasActionVerdict(C, OA.SUPERVISOR_CV)).toMatchObject({ allowed: false, code: 'au_pathway' });
  });

  it('pathway unreadable: refused, with a "try again" message', () => {
    const hold = placementHooksFor({ flagEnabled: true, readFailed: true }, null);
    expect(hooksLib.overseasActionVerdict(hold, OA.SUPERVISOR_CV)).toMatchObject({ allowed: false, code: 'pathway_unreadable' });
    expect(hooksLib.overseasActionVerdict(null, OA.SPPA)).toMatchObject({ allowed: false, code: 'pathway_unreadable' });
  });

  it('a task maps to its action by type, then by document key', () => {
    expect(hooksLib.overseasActionForTask({ task_type: 'practice_pack_child', related_document_key: 'supervisor_cv' })).toBe(OA.SUPERVISOR_CV);
    expect(hooksLib.overseasActionForTask({ task_type: 'practice_pack_child', related_document_key: 'sppa_00' })).toBe(OA.SPPA);
    expect(hooksLib.overseasActionForTask({ task_type: 'practice_pack_child', related_document_key: 'offer_contract' })).toBe(OA.OFFER_CONTRACT);
    expect(hooksLib.overseasActionForTask({ task_type: 'practice_pack_child' })).toBe(OA.PRACTICE_PACK_TASK);
    expect(hooksLib.overseasActionForTask({ task_type: 'alt_supervisor_cv_request', related_document_key: 'sppa_00' })).toBe(OA.ALT_SUPERVISOR_CV);
    expect(hooksLib.overseasActionForTask({ task_type: 'ahpra_conflict_letter' })).toBe(OA.AHPRA_CONFLICT_LETTER);
    expect(hooksLib.overseasActionForTask({ task_type: 'ahpra_action_item' })).toBe(OA.AHPRA_LETTER);
    // a review task about the doctor's own Australian document is not an overseas action
    expect(hooksLib.overseasActionForTask({ task_type: 'doc_review', related_document_key: 'au_indemnity_certificate' })).toBe('');
    expect(hooksLib.overseasActionForTask({ task_type: 'manual' })).toBe('');
    expect(hooksLib.overseasActionForTask(null)).toBe('');
  });

  it('staff-written text that asks a practice for an overseas document is caught for an Australian case, never for an overseas one', () => {
    const asks = [
      'Could you please send us the Supervisor CV for Dr Test?',
      'Please send the supervisor\'s CV',
      'Attached is the SPPA-00 for signing',
      'Please complete Section G',
      'We need the supervised practice plan'
    ];
    for (const text of asks) {
      expect(hooksLib.overseasRequestBlockedInText(A, text), text).toBeTruthy();
      expect(hooksLib.overseasRequestBlockedInText(overseas, text), text).toBe(null);
      expect(hooksLib.overseasRequestBlockedInText(bSupervised, text), text).toBe(null);
    }
    expect(hooksLib.overseasRequestBlockedInText(A, 'Please send the position description').action).toBe(OA.POSITION_DESCRIPTION);
    expect(hooksLib.overseasRequestBlockedInText(A, 'Dr Test starts on 1 February. Could you confirm the roster?')).toBe(null);
  });
});

describe('the pre-start task set (lib/au-prestart.js)', () => {
  const NOW = '2026-11-21T00:00:00.000Z';

  it('the task types are the ones the WP-06 migration already allows', () => {
    const allowed = require('../lib/au-staff-tools.js').AU_NEW_TASK_TYPES;
    for (const type of prestart.PRESTART_TASK_TYPES.concat(prestart.EARLY_TASK_TYPES)) expect(allowed, type).toContain(type);
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase/migrations/20261120120000_au_gp_wp06_task_types.sql'), 'utf8');
    for (const type of prestart.PRESTART_TASK_TYPES.concat(prestart.EARLY_TASK_TYPES)) expect(sql, type).toContain("'" + type + "'");
  });

  it('owners follow the checklist: start date consultant then RSO; the other three RSO', () => {
    expect(prestart.TASK_INFO.start_date_tracking).toMatchObject({ owner: 'consultant', ownerThen: 'rso', checklistRow: 6 });
    expect(prestart.TASK_INFO.indemnity_certificate).toMatchObject({ owner: 'rso', checklistRow: 7 });
    expect(prestart.TASK_INFO.provider_number_new_location).toMatchObject({ owner: 'rso', checklistRow: 8 });
    expect(prestart.TASK_INFO.credentialing_pack).toMatchObject({ owner: 'rso', checklistRow: 9 });
    expect(prestart.TASK_INFO.dpa_19ab_check).toMatchObject({ owner: 'consultant', checklistRow: 2 });
    expect(prestart.TASK_INFO.reference_check).toMatchObject({ owner: 'consultant', checklistRow: 3 });
    expect(prestart.TASK_INFO.restraint_check).toMatchObject({ owner: 'consultant', checklistRow: 4 });
  });

  it('due dates are anchored on the start date when known, else on the placement date', () => {
    const placedAt = '2026-11-21T00:00:00.000Z';
    // no start date: days after the placement
    expect(prestart.dueDateFor('start_date_tracking', { placedAt, now: NOW })).toMatchObject({ date: '2026-11-24', anchor: 'placement' });
    expect(prestart.dueDateFor('indemnity_certificate', { placedAt, now: NOW })).toMatchObject({ date: '2026-12-05', anchor: 'placement' });
    expect(prestart.dueDateFor('provider_number_new_location', { placedAt, now: NOW })).toMatchObject({ date: '2026-11-28', anchor: 'placement' });
    // start date known: days before it
    expect(prestart.dueDateFor('indemnity_certificate', { startDate: '2027-02-01', placedAt, now: NOW })).toMatchObject({ date: '2027-01-18', anchor: 'start_date' });
    expect(prestart.dueDateFor('provider_number_new_location', { startDate: '2027-02-01', placedAt, now: NOW })).toMatchObject({ date: '2027-01-11', anchor: 'start_date' });
    expect(prestart.dueDateFor('credentialing_pack', { startDate: '2027-02-01', now: NOW })).toMatchObject({ date: '2027-01-25', anchor: 'start_date' });
    // the start-date task itself is always anchored on the placement
    expect(prestart.dueDateFor('start_date_tracking', { startDate: '2027-02-01', placedAt, now: NOW })).toMatchObject({ date: '2026-11-24', anchor: 'placement' });
    // a start date next week never produces a task that is already overdue
    expect(prestart.dueDateFor('provider_number_new_location', { startDate: '2026-11-28', placedAt, now: NOW }).date).toBe('2026-11-23');
    // raised by something else
    expect(prestart.dueDateFor('dpa_19ab_check', { now: NOW })).toMatchObject({ date: '2026-11-23', anchor: 'raised' });
    expect(prestart.dueDateFor('reference_check', { now: NOW }).date).toBe('2026-11-26');
    expect(prestart.dueDateFor('restraint_check', { now: NOW }).date).toBe('2026-11-24');
    expect(prestart.dueDateFor('credentialing_pack', { now: NOW }).date).toBe('2026-11-28');
    // every type has a rule
    for (const type of prestart.PRESTART_TASK_TYPES.concat(prestart.EARLY_TASK_TYPES)) expect(prestart.DUE_RULES[type], type).toBeTruthy();
  });

  it('a pre-start task carries its owner, due rule, the plain "what to do" line and the placement it belongs to', () => {
    const t = prestart.buildPrestartTask('provider_number_new_location', {
      name: 'Dr Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', applicationId: 'app-1',
      startDate: '2027-02-01', placedAt: NOW, placingConsultant: 'consultant.test@gplink-test.local', now: NOW
    });
    expect(t).toMatchObject({
      task_type: 'provider_number_new_location', status: 'open', related_stage: 'prestart', source_trigger: 'au_placement', due_date: '2027-01-11',
      title: 'Medicare provider number for the new location: Dr Test Auvr at Test Metro Practice (FAKE)'
    });
    expect(t.metadata).toMatchObject({ au: true, owner: 'rso', checklist_row: 8, placement_key: 'app-1', due_auto: true, due_anchor: 'start_date', provider_number: null, location_name: 'Test Metro Practice (FAKE)' });
    expect(t.metadata.what_to_do).toMatch(/provider number/i);
    expect(t.description).toMatch(/Done when:/);
    const s = prestart.buildPrestartTask('start_date_tracking', { name: 'Dr Test', placementKey: 'app-1', now: NOW });
    expect(s.priority).toBe('high'); // no start date on the placement
    expect(s.metadata).toMatchObject({ owner: 'consultant', owner_then: 'rso', expected_start_date: null, confirmed_start_date: null });
    expect(prestart.buildPrestartTask('start_date_tracking', { name: 'Dr Test', placementKey: 'app-1', startDate: '2027-02-01', now: NOW }).priority).toBe('normal');
    expect(prestart.buildPrestartTask('indemnity_certificate', { placementKey: 'x', now: NOW }).metadata.document_key).toBe('au_indemnity_certificate');
    expect(prestart.buildPrestartTask('dpa_19ab_check', {})).toBe(null);
  });

  it('the indemnity task waits for the document WP-07 defines', () => {
    expect(documentRequirements.isAuRegDocumentKey(prestart.INDEMNITY_DOCUMENT_KEY)).toBe(true);
    const req = documentRequirements.auDocumentRequirements(resolved('au_vr').p, { phase: 'prestart' });
    expect(req.requiredKeys).toContain(prestart.INDEMNITY_DOCUMENT_KEY);
  });

  it('the credentialing pack waits for the Ahpra register check (task 1) and the indemnity certificate (task 7)', () => {
    expect(prestart.credentialingPackTrigger({ ahpraVerified: true, ahpraCheckOpen: false, indemnityDone: true })).toEqual({ met: true, waitingOn: [] });
    expect(prestart.credentialingPackTrigger({ ahpraVerified: false, ahpraCheckOpen: false, indemnityDone: true })).toEqual({ met: false, waitingOn: ['ahpra_register_check'] });
    expect(prestart.credentialingPackTrigger({ ahpraVerified: true, ahpraCheckOpen: true, indemnityDone: true }).met).toBe(false);
    expect(prestart.credentialingPackTrigger({ ahpraVerified: true, ahpraCheckOpen: false, indemnityDone: false })).toEqual({ met: false, waitingOn: ['indemnity_certificate'] });
    expect(prestart.credentialingPackTrigger({}).waitingOn).toEqual(['ahpra_register_check', 'indemnity_certificate']);
  });

  it('pre-start is complete only when all four tasks exist and are completed', () => {
    const done = (type) => ({ task_type: type, status: 'completed' });
    expect(prestart.prestartCompleteFromTasks(prestart.PRESTART_TASK_TYPES.map(done))).toEqual({ complete: true, missing: [], open: [] });
    expect(prestart.prestartCompleteFromTasks(prestart.PRESTART_TASK_TYPES.slice(0, 3).map(done))).toMatchObject({ complete: false, missing: ['credentialing_pack'] });
    const oneOpen = prestart.PRESTART_TASK_TYPES.map(done);
    oneOpen[1].status = 'open';
    expect(prestart.prestartCompleteFromTasks(oneOpen)).toMatchObject({ complete: false, open: ['indemnity_certificate'] });
    expect(prestart.prestartCompleteFromTasks([]).complete).toBe(false);
  });

  it('before-placement tasks: which stage raises which, for whom', () => {
    expect(prestart.earlyTasksForStage('shortlisted', 'A')).toEqual([]);
    expect(prestart.earlyTasksForStage('applied', 'A')).toEqual([]);
    expect(prestart.earlyTasksForStage('shortlisted', 'B')).toEqual(['dpa_19ab_check']);
    expect(prestart.earlyTasksForStage('applied', 'C')).toEqual(['dpa_19ab_check']);
    for (const seg of ['A', 'B', 'C']) {
      expect(prestart.earlyTasksForStage('submitted', seg)).toEqual(['reference_check']);
      expect(prestart.earlyTasksForStage('offer', seg)).toEqual(['restraint_check']);
      expect(prestart.earlyTasksForStage('interview', seg)).toEqual([]);
      expect(prestart.earlyTasksForStage('hired', seg)).toEqual([]);
    }
    expect(prestart.earlyTasksForStage('offer', 'overseas')).toEqual([]);
    expect(prestart.earlyTasksForStage('submitted', null)).toEqual([]);
    expect(prestart.earlyTaskScope('reference_check')).toBe('case');
    expect(prestart.earlyTaskScope('dpa_19ab_check')).toBe('application');
    const t = prestart.buildEarlyTask('reference_check', { name: 'Dr Test', applicationId: 'app-9', triggerStage: 'submitted', now: NOW });
    expect(t).toMatchObject({ task_type: 'reference_check', related_stage: 'placement', source_trigger: 'au_ats_stage', due_date: '2026-11-26' });
    expect(t.description).toMatch(/The doctor gives two referees on their pre-start page/); // WP-12 collects them; the line used to say the app did not
  });

  it('the manual task form: one option per Australian type, each with a label, an owner, a default due and a "what to do" line', () => {
    const opts = prestart.manualTaskOptions();
    expect(opts.map((o) => o.task_type)).toEqual(['dpa_19ab_check', 'reference_check', 'restraint_check', 'start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack']);
    for (const o of opts) {
      expect(o.label.length, o.task_type).toBeGreaterThan(5);
      expect(['consultant', 'rso']).toContain(o.owner);
      expect(o.what_to_do.length).toBeGreaterThan(20);
      expect(o.default_due_days).toBeGreaterThan(0);
      expect(['placement', 'prestart']).toContain(o.default_stage);
    }
    const made = prestart.buildManualAuTask('restraint_check', { title: 'Check restraint', now: NOW });
    expect(made).toMatchObject({ task_type: 'restraint_check', title: 'Check restraint', due_date: '2026-11-24', related_stage: 'placement', priority: 'normal' });
    expect(made.metadata).toMatchObject({ au: true, created_by_hand: true, due_auto: true });
    expect(prestart.buildManualAuTask('restraint_check', { title: 'x', dueDate: '2026-12-25', now: NOW })).toMatchObject({ due_date: '2026-12-25' });
    expect(prestart.buildManualAuTask('practice_pack_child', { title: 'x' })).toBe(null);
    expect(prestart.isAuTaskType('manual')).toBe(false);
  });

  it('a provider number is cleaned, and nonsense is refused', () => {
    expect(prestart.normaliseProviderNumber('123456ab')).toBe('123456AB');
    expect(prestart.normaliseProviderNumber(' 123456 7X ')).toBe('1234567X');
    expect(prestart.normaliseProviderNumber('hello')).toBe('');
    expect(prestart.normaliseProviderNumber('')).toBe('');
    expect(prestart.normaliseProviderNumber('12AB')).toBe('');
  });

  it('the hold task is an ordinary manual task (a type every database allows) and says what was held', () => {
    const t = prestart.buildPathwayHoldTask({ name: 'Dr Test', applicationId: 'app-1', now: NOW });
    expect(t.task_type).toBe('manual');
    expect(t.title).toBe('Confirm pathway before pre-start / registration pack: Dr Test');
    expect(t.priority).toBe('high');
    expect(t.source_trigger).toBe('au_placement_pathway_hold');
    expect(t.description).toMatch(/held/);
  });
});

describe('N11 to N14 (lib/au-placement-messages.js)', () => {
  const n11 = messages.buildPlacementSecuredMessage({ appBaseUrl: 'https://app.gplink-test.local/', practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-02-01', placementKey: 'app-1' });
  const n12 = messages.buildPlacementConfirmedPracticeMessage({ gpName: 'Test Auvr', contactName: 'Test Manager', roleTitle: 'General Practitioner', startDate: '2027-02-01', placementKey: 'app-1' });
  const n13 = messages.buildPrestartItemRequestMessage({
    appBaseUrl: 'https://app.gplink-test.local', requestKey: 'docs:app-1:d3', startDate: '2027-02-01', reminder: true,
    items: [{ label: 'Indemnity certificate of currency', help: 'The certificate from your insurer.' }, messages.GP_REQUEST_ITEMS.provider_number]
  });
  const n14 = messages.buildPracticeFormNeededMessage({
    gpName: 'Test Auvr', contactName: 'Test Manager', startDate: '2027-02-01', requestKey: 'staff:app-1:x',
    itemKeys: ['provider_number_location_details', 'credentialing_forms', 'not_a_real_item', 'credentialing_forms'], note: 'Thanks for your help.'
  });

  it('N11: placement secured, the pre-start checklist, a link to the app', () => {
    expect(n11).toMatchObject({ id: 'N11', key: 'au_n11_placement_secured:app-1', subject: 'Your placement is secured: your pre-start checklist', ctaUrl: 'https://app.gplink-test.local/pages/prestart' }); // WP-12: the button opens the pre-start page it built
    expect(n11.body).toMatch(/Your placement at Test Metro Practice \(FAKE\) is secured\. Your expected start date is 1 February 2027\./);
    for (const word of ['Notice period and start date', 'Medicare provider number', 'Indemnity', 'Credentialing']) expect(n11.body).toContain(word);
    expect(n11.body).toContain('We never contact your current practice without asking you first.');
    expect(n11.bell).toMatchObject({ type: 'success', title: 'Your placement is secured' });
    expect(n11.whatsapp.templateKey).toBe('placement_secured');
    // segments B and C: one extra neutral line
    const b = messages.buildPlacementSecuredMessage({ appBaseUrl: 'x', placementKey: 'app-1', variant: 'B' });
    expect(b.body).toContain('Registration: our team will be in touch');
    expect(n11.body).not.toContain('Registration: our team');
    // no start date, no practice name
    expect(messages.buildPlacementSecuredMessage({ appBaseUrl: 'x', placementKey: 'k' }).body).toMatch(/^Your placement is secured\.\n/);
  });

  it('N12: start date, provider number for the practice\'s location, credentialing, the guarantee, who to contact', () => {
    expect(n12).toMatchObject({ id: 'N12', key: 'au_n12_placement_confirmed:app-1', subject: 'Placement confirmed: Dr Test Auvr' });
    for (const part of ['Start date: the expected start date is 1 February 2027', 'Provider number: Dr Test Auvr applies for a Medicare provider number for your practice location',
      'Credentialing: we send you Dr Test Auvr\'s credentialing pack', 'Guarantee period: a 12-week guarantee period applies to permanent placements, starting on the day Dr Test Auvr commences',
      'reply to this email']) {
      expect(n12.text).toContain(part);
    }
    expect(n12.bodyHtml).toContain('<strong>Guarantee period</strong>');
    expect(n12.text).not.toMatch(/supervision/i);
    expect(messages.buildPlacementConfirmedPracticeMessage({ gpName: 'Test', placementKey: 'k', supervisionPaperwork: true }).text).toContain('Supervision: this placement needs supervision paperwork from your practice.');
    expect(messages.buildPlacementConfirmedPracticeMessage({ gpName: 'Test', placementKey: 'k' }).text).toContain('we confirm Dr Test\'s notice period and agree the start date with you');
  });

  it('N12 says about the guarantee only what the 2026 agreement says', () => {
    const agreement = require('fs').readFileSync(require('path').join(__dirname, '..', 'assets/legal/src/agreement-2026.html'), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(agreement).toContain('A 12-week guarantee period applies to permanent placements.');
    expect(agreement).toMatch(/Guarantee period means the period of twelve \(12\) weeks from the date the candidate commences the placement/);
    expect(agreement).toMatch(/7\. GUARANTEE PERIOD/);
    // no credit figure, no fee, no "weeks 4, 8 and 12" promise the agreement does not make
    expect(n12.text).not.toMatch(/\$|%|per cent|credit|refund|week 4|week 8/i);
  });

  it('N13: what is asked for, in the doctor\'s words, with a link to the app', () => {
    expect(n13).toMatchObject({ id: 'N13', key: 'au_n13_prestart_item:docsapp-1d3', subject: 'A few things we need before you start' });
    expect(n13.body).toContain('A quick reminder.');
    expect(n13.body).toContain('• Indemnity certificate of currency: The certificate from your insurer.');
    expect(n13.body).toContain('• Your Medicare provider number for the new location');
    expect(n13.bell.type).toBe('action');
    const one = messages.buildPrestartItemRequestMessage({ appBaseUrl: 'x', requestKey: 'k', items: [{ label: 'Working with Children Check' }] });
    expect(one.subject).toBe('Needed before you start: Working with Children Check');
    expect(messages.buildPrestartItemRequestMessage({ appBaseUrl: 'x', requestKey: 'k', items: [] })).toBe(null);
  });

  it('N14: fixed wording per item; unknown items and duplicates are dropped', () => {
    expect(n14).toMatchObject({ id: 'N14', subject: 'Dr Test Auvr: what we need from your practice before the start date' });
    expect(n14.itemKeys).toEqual(['provider_number_location_details', 'credentialing_forms']);
    expect(n14.text).toContain('To have everything ready for Dr Test Auvr\'s start on 1 February 2027');
    expect(n14.text).toContain('Thanks for your help.');
    expect(messages.buildPracticeFormNeededMessage({ gpName: 'x', itemKeys: ['nope'], requestKey: 'k' })).toBe(null);
  });

  it('nothing sent to an Australian doctor carries a word from AGENT-RULES section 4', () => {
    const variants = [n11, messages.buildPlacementSecuredMessage({ appBaseUrl: 'x', placementKey: 'k', variant: 'B' }),
      messages.buildPlacementSecuredMessage({ appBaseUrl: 'x', placementKey: 'k', variant: 'C' }), n13];
    Object.keys(messages.GP_REQUEST_ITEMS).forEach((k) => variants.push(messages.buildPrestartItemRequestMessage({ appBaseUrl: 'x', requestKey: k, items: [messages.GP_REQUEST_ITEMS[k]] })));
    // every pre-start document's doctor-facing words
    for (const kind of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']) {
      const items = documentRequirements.auDocumentRequirements(resolved(kind).p, { phase: 'prestart' }).items.filter((i) => i.provider === 'you');
      variants.push(messages.buildPrestartItemRequestMessage({ appBaseUrl: 'x', requestKey: kind, items: items.map((i) => ({ label: i.label, help: i.short })) }));
    }
    for (const m of variants) {
      const all = [m.subject, m.title, m.body, m.ctaText, m.footer, m.bell.title, m.bell.body].join('\n');
      expect(all.match(DOCTOR_BANNED), all.slice(0, 80)).toBe(null);
      expect(all.match(UPPER_REGULATOR), all.slice(0, 80)).toBe(null);
    }
  });

  it('nothing sent to a practice about an Australian doctor carries a banned phrase, a dollar figure or a percentage', () => {
    const variants = [n12, n14,
      messages.buildPlacementConfirmedPracticeMessage({ gpName: 'Test', placementKey: 'k', supervisionPaperwork: true, contactLine: 'Your contact at GP Link is consultant.test@gplink-test.local. You can also reply to this email.' }),
      messages.buildPlacementConfirmedPracticeMessage({ gpName: 'Test', placementKey: 'k', staffDecisionPending: true }),
      messages.buildPracticeFormNeededMessage({ gpName: 'Test', itemKeys: messages.PRACTICE_REQUEST_ITEM_KEYS, requestKey: 'k' })];
    for (const m of variants) {
      const html = m.bodyHtml.replace(/<[^>]+>/g, ' ');
      for (const text of [m.subject, m.title, m.text, html, m.footer]) {
        expect(careerIntro.auPracticeTextViolations(text), text.slice(0, 80)).toEqual([]);
        expect(text).not.toMatch(/AHPRA|internationally trained/);
      }
    }
  });

  it('the WhatsApp for N11 has its own Australian template, not approved, so it is skipped', () => {
    expect(auWhatsApp.AU_WHATSAPP_TEMPLATES.placement_secured).toMatchObject({ templateName: 'gp_link_au_placement_secured', approved: false });
    expect(auWhatsApp.auDoctorWhatsAppPlan('placement_secured', {})).toMatchObject({ send: false, reason: 'au_template_not_approved' });
    expect(auWhatsApp.auDoctorWhatsAppPlan('placement_secured', { AU_WHATSAPP_APPROVED_TEMPLATES: 'placement_secured' })).toMatchObject({ send: true, templateName: 'gp_link_au_placement_secured' });
    expect(auWhatsApp.auDoctorWhatsAppPlan('not_a_template', {})).toMatchObject({ send: false });
    // never one of the existing (overseas) template names
    expect(auWhatsApp.AU_WHATSAPP_TEMPLATES.placement_secured.templateName).toMatch(/^gp_link_au_/);
    const doc = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs/au-gp/whatsapp-templates.md'), 'utf8');
    expect(doc).toContain('gp_link_au_placement_secured');
  });
});

describe('bell items that survive an open browser', () => {
  const entry = messages.buildDurableBellEntry('au_n11_placement_secured:app-1', { type: 'success', title: 'Your placement is secured', body: 'Your pre-start checklist is ready.' }, '2026-11-21T01:00:00.000Z');
  // what js/updates-sync.js keeps of an entry
  const asBrowserStores = (e) => ({ type: e.type, title: e.title, detail: e.detail, ts: e.ts, target: e.target, category: e.category });

  it('the entry has the fields the bell panel reads (title, detail, ts, a /pages/ target)', () => {
    expect(entry).toMatchObject({ type: 'success', title: 'Your placement is secured', detail: 'Your pre-start checklist is ready.', body: 'Your pre-start checklist is ready.', category: 'career', target: '/pages/my-documents' });
    expect(messages.bellIdentity(entry)).toBe('2026-11-21T01:00:00.000Z|Your placement is secured');
    expect(messages.bellIdentity(asBrowserStores(entry))).toBe(messages.bellIdentity(entry));
  });

  it('a browser saving a list WITHOUT the item gets it put back, and the item stays pending', () => {
    const pending = messages.addPendingBell(undefined, entry);
    const staleList = JSON.stringify([{ type: 'info', title: 'Older item', detail: '', ts: '2026-11-01T00:00:00.000Z' }]);
    const r = messages.reconcilePendingBell({ pending, incomingHasList: true, incomingList: staleList, nextList: staleList, nowMs: Date.parse('2026-11-21T02:00:00.000Z') });
    expect(r.changed).toBe(true);
    expect(r.restored).toEqual([messages.bellIdentity(entry)]);
    expect(typeof r.nextList).toBe('string'); // the browser's representation is kept
    const list = JSON.parse(r.nextList);
    expect(list.map((e) => e.title)).toEqual(['Your placement is secured', 'Older item']);
    expect(r.pending.length).toBe(1);
    // the same save again: still there, not doubled
    const r2 = messages.reconcilePendingBell({ pending: r.pending, incomingHasList: true, incomingList: staleList, nextList: staleList, nowMs: Date.parse('2026-11-21T02:00:00.000Z') });
    expect(JSON.parse(r2.nextList).filter((e) => e.title === 'Your placement is secured').length).toBe(1);
  });

  it('once a browser sends the item back, it is delivered: after that the browser owns it (and may remove it)', () => {
    const pending = messages.addPendingBell(undefined, entry);
    const withItem = JSON.stringify([asBrowserStores(entry)]);
    const r = messages.reconcilePendingBell({ pending, incomingHasList: true, incomingList: withItem, nextList: withItem });
    expect(r.delivered).toEqual([messages.bellIdentity(entry)]);
    expect(r.pending).toEqual([]);
    expect(r.restored).toEqual([]);
    expect(r.nextList).toBe(withItem);
    // later the doctor clears their notifications: nothing is put back
    const cleared = messages.reconcilePendingBell({ pending: r.pending, incomingHasList: true, incomingList: '[]', nextList: '[]' });
    expect(cleared.changed).toBe(false);
    expect(cleared.nextList).toBe('[]');
  });

  it('a save that does not touch the bell list changes nothing; an array list stays an array; old pending items expire', () => {
    const pending = messages.addPendingBell(undefined, entry);
    expect(messages.reconcilePendingBell({ pending, incomingHasList: false, nextList: [entry] }).changed).toBe(false);
    const r = messages.reconcilePendingBell({ pending, incomingHasList: true, incomingList: [], nextList: [] });
    expect(Array.isArray(r.nextList)).toBe(true);
    expect(r.nextList.length).toBe(1);
    const old = messages.reconcilePendingBell({ pending, incomingHasList: true, incomingList: [], nextList: [], nowMs: Date.parse('2027-02-01T00:00:00.000Z') });
    expect(old.pending).toEqual([]);
    expect(old.restored).toEqual([]);
    expect(messages.reconcilePendingBell({ pending: 'not json', incomingHasList: true, incomingList: '[]', nextList: '[]' }).changed).toBe(false);
  });

  it('nothing pending (every overseas doctor): nothing changes', () => {
    const list = JSON.stringify([{ type: 'info', title: 'x', ts: '2026-11-01T00:00:00.000Z' }]);
    for (const pending of [undefined, null, [], '[]']) {
      const r = messages.reconcilePendingBell({ pending, incomingHasList: true, incomingList: list, nextList: list });
      expect(r.changed).toBe(false);
      expect(r.nextList).toBe(list);
    }
  });
});
