'use strict';

// Curated, per-stage guidance for the AI "Suggest a reply" feature.
// OWNER: review/refine this text — it is the standard guidance an RSO gives at
// each registration stage. Keep each entry tight (token-light).
var STAGE_PLAYBOOK = {
  myintealth:
    'MyIntealth: the doctor sets up their MyIntealth account so AMC/AHPRA steps can begin. ' +
    'They typically need to verify their email and upload a clear copy of their photo ID. ' +
    'Common questions: "what do I upload?" → ID + verify email only at this stage; everything else comes later. ' +
    'Reassure them it is quick and you will guide each next step.',
  amc:
    'AMC: the doctor builds their AMC portfolio / sits the AMC CAT exam. ' +
    'They usually need their passport bio page and a recent passport-style photo to book the exam. ' +
    'Common questions: photo size → standard passport size (35x45mm) from any chemist/post office. ' +
    'Do not promise exam dates or results — defer specifics to the RSO if not in the facts.',
  career:
    'Secured Placement / practice pack: the doctor has (or is securing) a GP placement, and we collect the ' +
    'practice documents: SPPA-00 (Supervised Practice Plan), Section G, Position Description, signed Offer/Contract, ' +
    'and the Supervisor CV. Emails here are often WITH the practice. ' +
    'Common questions: what we still need from the practice → only list documents the facts mark as outstanding. ' +
    'Signing requirements (mention only if relevant): the Supervisor CV must be dated and signed by the supervisor; the Position Description signed by the practice owner; the Offer/Contract signed by both the practice and the doctor.',
  ahpra:
    'AHPRA registration: the doctor lodges their AHPRA application. Typical requirements: certified copies of their ' +
    'medical degree, a signed and dated CV, an English language pathway (a test like IELTS/OET/PLAB/NZREX, or an ' +
    'evidence-based exemption), an international criminal history check (Fit2Work ICHC), and the SPPA-00 supervised ' +
    'practice plan. "Certified copy" = a JP/pharmacist/doctor writes "true copy of the original", signs and dates it. ' +
    'Only say a document is received/approved if the facts say so.',
  visa:
    'Visa: the doctor\'s Australian work visa is being arranged with the sponsoring practice as the employer — ' +
    'typically an employer-sponsored subclass 482 application, with subclass 407 (training) used for some placements. ' +
    'Typical requirements: a signed employment contract, a valid passport, and health and character checks ' +
    '(visa medicals and police clearances). ' +
    'Common questions: how long it takes / grant dates → do not promise dates; processing sits with the Department of Home Affairs. ' +
    'Do not give medical-registration guidance here (that belongs to the AHPRA stage) and do not give migration advice ' +
    'beyond what appears in the facts — defer specifics to the RSO or the registered migration agent.',
  pbs:
    'PBS & Medicare: after AHPRA registration, the doctor gets their Medicare provider number and PBS prescriber access. ' +
    'This step depends on AHPRA being granted first. Keep replies high-level and defer exact timing to the RSO.',
  commencement:
    'Commencement: the start date is being confirmed and the first-day pack prepared. ' +
    'Tone is congratulatory and practical. Do not state a confirmed start date unless it appears in the facts.',
};

// Some case stages are aliases of a playbook section.
var STAGE_ALIASES = { placement: 'career' };

// ── WP-20 (Australian GP build): the Australian ladder ──────────────────────
// A doctor who is already registered with Ahpra and working in Australia is on
// a different ladder (lib/journey-ladders.js AU_LADDER): placement, prestart,
// commenced, guarantee, complete. None of the entries above applies to them.
//
// Every entry is grounded in what the app actually does at that stage
// (lib/au-prestart.js TASK_INFO, lib/au-lifecycle.js). Nothing here states a
// regulator's rule as fact: where the build relies on an unconfirmed
// assumption the entry says "(assumption)" and tells the model not to assert
// it. OWNER: review/refine, as for the overseas entries.
var AU_STAGE_PLAYBOOK = {
  placement:
    'Placement (finding the new practice): the doctor is looking at roles, interviewing, or weighing an offer. ' +
    'What staff usually need to say. To the doctor: which practices have their profile (only practices they agreed to), ' +
    'interview times on offer, and what an offer or contract contains. To a practice: interview availability, the offer, the contract. ' +
    'The doctor\'s current employer does not know they are looking: never suggest contacting that employer, and never tell a practice ' +
    'where the doctor works now. Reference checks and a check of any restraint clause in the doctor\'s current contract are GP Link\'s ' +
    'own work at this stage: mention one only when the facts show it is open and the person you are writing to has to do something for it. ' +
    'Do not promise an offer, a start date or any term that is not in the facts.',
  prestart:
    'Pre-start (a placement is recorded and the doctor has not started yet). GP Link works through four items, and the facts say which are still open. ' +
    '1. Notice and start date: the doctor gives notice where they work now and a start date is agreed with the new practice; staff record the confirmed date. ' +
    '2. Indemnity: the doctor uploads their current medical indemnity certificate of currency in the app (assumption: it should cover the new practice and the start date; ask the doctor to check with their insurer, do not state it as a rule). ' +
    '3. Provider number: the doctor applies for a Medicare provider number for the new practice location and tells us the number once it is issued (assumption: a number is needed for each practice location; do not quote how long it takes). ' +
    '4. Credentialing: GP Link sends the practice a credentialing pack once the Ahpra register check and the indemnity certificate are done ' +
    '(Ahpra registration, indemnity certificate, CV, right to work, Working with Children Check). ' +
    'Ask only for an item the facts mark as open, and only ask the person who has to do it. ' +
    'Do not state a start date unless it is in the facts, and do not say the doctor is clear to start unless the facts say every item is complete.',
  commenced:
    'Commenced (staff have confirmed the doctor has started at the new practice). Tone is warm and practical. ' +
    'What staff usually need to say: check the first days went smoothly, and ask whether anything is still outstanding ' +
    '(system access, the provider number in use, sessions and rooms as agreed). ' +
    'If the doctor or the practice raises a problem about the contract, pay or sessions, do not try to settle it in the reply: ' +
    'acknowledge it and say the placing consultant will be in touch. ' +
    'Never mention GP Link\'s fee or invoice to the doctor.',
  guarantee:
    'Settling in (the first weeks after the start; internally this is the guarantee period). GP Link checks in with the doctor and with the practice at set points. ' +
    'What staff usually need to say: a short, friendly check-in asking how things are going, and an invitation to tell us early if something is not working. ' +
    'If either side says the doctor is leaving, or thinking of leaving, do not negotiate or reassure in the reply: acknowledge it and say a named person at GP Link will call. ' +
    'To the doctor never use the word "guarantee" and never mention fees, invoices or credits: those are terms between GP Link and the practice. ' +
    'To a practice, say nothing about the amount or timing of a fee or a credit unless the exact wording is in the facts.',
  complete:
    'Complete (the placement has settled). Replies are courteous and brief. ' +
    'If the doctor says they are thinking about a new role, say their consultant will be in touch; do not start a new search in the reply.'
};

/**
 * The guidance for a case stage.
 *
 * @param {string} stage
 * @param {{ au?: boolean }} [opts]  `au: true` only for a doctor on an
 *   Australian pathway (the caller decides, from resolveCandidatePathway).
 *   Without it the answer is exactly what it has always been, including the
 *   overseas 'placement' alias.
 */
function playbookForStage(stage, opts) {
  var key = String(stage == null ? '' : stage).trim().toLowerCase();
  if (opts && opts.au === true) return AU_STAGE_PLAYBOOK[key] || '';
  key = STAGE_ALIASES[key] || key;
  return STAGE_PLAYBOOK[key] || '';
}

module.exports = { STAGE_PLAYBOOK, AU_STAGE_PLAYBOOK, playbookForStage };
