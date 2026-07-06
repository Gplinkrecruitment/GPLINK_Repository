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

function playbookForStage(stage) {
  var key = String(stage == null ? '' : stage).trim().toLowerCase();
  key = STAGE_ALIASES[key] || key;
  return STAGE_PLAYBOOK[key] || '';
}

module.exports = { STAGE_PLAYBOOK, playbookForStage };
