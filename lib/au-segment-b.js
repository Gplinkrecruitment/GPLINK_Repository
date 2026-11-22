'use strict';
/**
 * WP-14 (Australian GP build): segment B (`au_restricted`): a doctor already
 * in Australia whose registration is supervised, whose right to work is tied
 * to a sponsoring employer, or who is under the 19AB moratorium.
 *
 * Pure, no I/O, no switch read. The reads and writes are in server.js (search
 * "WP-14"). Everything here is STAFF-FACING machinery plus safe gating:
 * segment B is built but NOT launched (owner decision 1), so nothing in this
 * file is ever sent to a doctor automatically.
 *
 * ── UNCONFIRMED REGULATORY ASSUMPTIONS (owner decision 2) ──────────────────
 * Nobody has confirmed these with a checked source. Each lives in exactly one
 * function, fails closed (unknown = do nothing automatic, ask a person), and
 * is listed for the owner in docs/au-gp/CONVENTIONS.md section 26:
 *
 *   R1  A doctor whose visa is tied to a sponsoring employer needs something
 *       done about that visa when they change employer (a "transfer of
 *       nomination").                                   -> visaStageFor
 *   R2  A citizen or permanent resident never has a visa step.
 *                                                       -> visaStageFor
 *   R3  A doctor on limited, provisional or supervised registration needs new
 *       supervision paperwork lodged for a new practice. -> lib/placement-hooks.js
 *                                                          (supervisionFacts),
 *                                                          read here through
 *                                                          supervisedSweepVerdict
 *   R4  The 19AB moratorium limits a doctor to Distribution Priority Area
 *       locations until staff confirm it does not apply.
 *                                                       -> lib/candidate-pathway.js
 *                                                          computeDpaRestricted
 * No rule here decides anything by itself: R1 raises a staff DECISION task,
 * and the transfer case exists only after a person confirms.
 */

const candidatePathway = require('./candidate-pathway.js');
const gpCredentialsLib = require('./gp-credentials.js');
const auLifecycle = require('./au-lifecycle.js');
const fees = require('./au-placement-fees.js');

// ── The visa stage (APP-29, ADM-22) ─────────────────────────────────────────

const VISA_MODE = Object.freeze({
  /** Not an Australian doctor (or the switch is off): today's visa module, unchanged. */
  OVERSEAS: 'overseas',
  /** No visa stage at all: no case, no task, no page, no bell item. */
  NONE: 'none',
  /** A sponsor-tied segment B doctor: a nomination transfer MAY be needed. A person decides. */
  TRANSFER: 'transfer',
  /** Segment B and the facts are not on file: a person decides; nothing is shown. */
  UNKNOWN: 'unknown',
  /** The pathway could not be read: nothing visa-related happens this time. */
  HOLD: 'hold'
});

const VISA_REASON = Object.freeze({
  CITIZEN_OR_PR: 'citizen_or_permanent_resident',
  SEGMENT_HAS_NO_VISA_STAGE: 'segment_has_no_visa_stage',
  NOT_SPONSOR_TIED: 'visa_not_tied_to_an_employer',
  SPONSOR_TIED: 'visa_tied_to_an_employer',
  NO_CREDENTIALS: 'no_credentials_on_file',
  WORK_RIGHTS_UNKNOWN: 'right_to_work_not_recorded',
  SPONSOR_TIE_UNKNOWN: 'sponsor_tie_not_recorded',
  PATHWAY_UNREADABLE: 'pathway_unreadable'
});

/**
 * THE ONE PLACE that decides whether a doctor has a visa stage (rules R1, R2).
 *
 * @param {object|null} pathwayResult  from resolveCandidatePathway
 * @param {object|null} credentials    the doctor's gp_credentials row, or null
 *        when there is none. (A row that could NOT BE READ is the caller's
 *        to turn into `hold`: pass `{ __unreadable: true }`.)
 * @returns {{ mode: string, reason: string|null }}
 */
function visaStageFor(pathwayResult, credentials) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p) return { mode: VISA_MODE.HOLD, reason: VISA_REASON.PATHWAY_UNREADABLE };
  if (p.flagEnabled === false || p.schemaMissing === true) return { mode: VISA_MODE.OVERSEAS, reason: null };
  if (p.readFailed === true) return { mode: VISA_MODE.HOLD, reason: VISA_REASON.PATHWAY_UNREADABLE };
  if (!p.isAu || !candidatePathway.isAuPathway(p.pathway)) return { mode: VISA_MODE.OVERSEAS, reason: null };
  if (credentials && credentials.__unreadable === true) return { mode: VISA_MODE.HOLD, reason: VISA_REASON.PATHWAY_UNREADABLE };
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  const rights = String((c && c.work_rights) || '').trim().toLowerCase();
  // R2 (APP-29): a citizen or permanent resident has no visa stage, on any
  // Australian pathway.
  if (rights === 'citizen' || rights === 'pr') return { mode: VISA_MODE.NONE, reason: VISA_REASON.CITIZEN_OR_PR };
  // Segments A and C get none of the segment B machinery. (A doctor placed in
  // A or C with a temporary right to work on file is a mismatch the Ahpra
  // register check and the segment review already flag to a person.)
  if (candidatePathway.segmentOf(p.pathway) !== 'B') return { mode: VISA_MODE.NONE, reason: VISA_REASON.SEGMENT_HAS_NO_VISA_STAGE };
  if (!c) return { mode: VISA_MODE.UNKNOWN, reason: VISA_REASON.NO_CREDENTIALS };
  if (rights !== 'visa') return { mode: VISA_MODE.UNKNOWN, reason: VISA_REASON.WORK_RIGHTS_UNKNOWN };
  // R1: tied to an employer -> a transfer MAY be needed (a person confirms).
  if (c.visa_sponsor_tied === true) return { mode: VISA_MODE.TRANSFER, reason: VISA_REASON.SPONSOR_TIED };
  if (c.visa_sponsor_tied === false) return { mode: VISA_MODE.NONE, reason: VISA_REASON.NOT_SPONSOR_TIED };
  return { mode: VISA_MODE.UNKNOWN, reason: VISA_REASON.SPONSOR_TIE_UNKNOWN };
}

/** Does this doctor have a visa stage that staff may open a case for? */
function visaCaseAllowed(verdict) {
  return !!verdict && (verdict.mode === VISA_MODE.OVERSEAS || verdict.mode === VISA_MODE.TRANSFER);
}

/**
 * May the doctor themselves be shown or sent anything about their visa (the
 * transfer page, a bell item)? Only a sponsor-tied segment B doctor, and for a
 * BELL ITEM only once segment B is launched (`pathwayResult.launched`): until
 * then nothing reaches the doctor without a person choosing to send it.
 */
function visaBellAllowed(verdict, pathwayResult) {
  if (!verdict) return false;
  if (verdict.mode === VISA_MODE.OVERSEAS) return true;
  return verdict.mode === VISA_MODE.TRANSFER && !!pathwayResult && pathwayResult.launched === true;
}

// ── Sweeps (replaces WP-04's "every Australian doctor is excluded") ─────────

const SWEEP_VERDICT = Object.freeze({ OVERSEAS: 'overseas', INCLUDE: 'include', EXCLUDE: 'exclude', HOLD: 'hold' });
/** The placement-hook row each supervised-practice job answers to. */
const SWEEP_ROW = Object.freeze({
  SPPA_PRACTICE_CHASE: 'sppa00Task',
  SPPA_BACKFILL_SCAN: 'sppa00Task',
  SECTION_G_DELIVERY: 'sectionGDelivery',
  DOCS_COMPLETE: 'sppa00Task'
});

/**
 * THE per-doctor predicate for the supervised-practice jobs (the SPPA-00
 * practice chase, the SPPA backfill scan, the Section G sweep, the
 * "documents complete" notifier). It asks the placement-hook matrix:
 *
 *   overseas column              -> 'overseas'  today's code, unchanged
 *   A and C                      -> 'exclude'   never has those tasks
 *   B, the row says 'fire'       -> 'include'   supervised: legitimately has them
 *   B, the row says 'skip'       -> 'exclude'
 *   B, the row says 'review'     -> 'hold'      not known: a person decides first
 *   pathway unreadable / no hooks-> 'hold'
 *
 * @param {object|null} hooks  from placementHooksFor
 * @param {string} row         one of SWEEP_ROW
 */
function supervisedSweepVerdict(hooks, row) {
  const h = hooks && typeof hooks === 'object' ? hooks : null;
  if (!h) return SWEEP_VERDICT.HOLD;
  if (h.column === 'overseas') return SWEEP_VERDICT.OVERSEAS;
  if (h.hold) return SWEEP_VERDICT.HOLD;
  if (h.column !== 'B') return SWEEP_VERDICT.EXCLUDE;
  const answer = h[row];
  if (answer === 'fire') return SWEEP_VERDICT.INCLUDE;
  if (answer === 'review') return SWEEP_VERDICT.HOLD;
  return SWEEP_VERDICT.EXCLUDE;
}

// ── AHPRA mail (ADM-14) ─────────────────────────────────────────────────────

const MAIL_ROUTE = Object.freeze({
  /** Today's pipeline: the six-mode card, the request tray, the grant flow. */
  OVERSEAS: 'overseas',
  /** One staff card on the doctor's case. Nothing is auto-acted. */
  SEGMENT_B: 'segment_b',
  /** An ordinary email card for a person. Nothing is auto-acted. */
  PLAIN_TRIAGE: 'plain_triage'
});

/**
 * Where a regulator email goes once it has been matched to a doctor.
 * @param {{ mode: 'overseas'|'au'|'hold', pathway?: string|null }} stageMode  from _auStageModeFor
 */
function ahpraMailRouteFor(stageMode) {
  const m = stageMode && typeof stageMode === 'object' ? stageMode : null;
  if (!m || m.mode === 'hold') return MAIL_ROUTE.PLAIN_TRIAGE;
  if (m.mode === 'overseas') return MAIL_ROUTE.OVERSEAS;
  return candidatePathway.segmentOf(m.pathway) === 'B' ? MAIL_ROUTE.SEGMENT_B : MAIL_ROUTE.PLAIN_TRIAGE;
}

// ── Tasks ───────────────────────────────────────────────────────────────────
// Every task below carries `metadata.lifecycle_kind` + `placement_key` (+
// `mark`), so the database's partial unique index `uniq_au_lifecycle_task`
// (WP-13 migration) makes it one per case, placement, kind and mark: two
// requests at once can never create two (CONVENTIONS section 25, "The
// idempotency rule"). None of them uses a task type the WP-13 commencement
// card reads (invoice_due, guarantee_checkin, manual), so they never appear
// in the commercial view.

const KIND = Object.freeze({
  VISA_TRANSFER_DECISION: 'visa_transfer_decision',
  VISA_TRANSFER_TASK: 'visa_transfer_task',
  SUPERVISION_RELODGEMENT: 'supervision_relodgement',
  AHPRA_LETTER: 'segment_b_ahpra_letter'
});

const SOURCE = Object.freeze({
  VISA_TRANSFER_DECISION: 'au_visa_transfer_decision',
  VISA_TRANSFER: 'au_visa_transfer',
  SUPERVISION: 'au_supervision_relodgement',
  AHPRA_MAIL: 'au_segment_b_ahpra_mail'
});

/** The four tasks a confirmed transfer raises, by `mark`, reusing the visa task types. */
const TRANSFER_TASK_MARKS = Object.freeze(['sponsor', 'agent', 'grant_notice', 'tracking']);

const OWNER_RSO = 'rso';
const OWNER_CONSULTANT = 'consultant';

function cleanLine(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

function isoDay(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return '';
  return s;
}

// FB-2a (R13): a due date is a calendar date on the practice's own clock:
// today there (Sydney when no zone is given), plus whole days. It was the UTC
// date plus multiples of 24 hours.
function localToday(now, zone) {
  return auLifecycle.localDay(Number.isFinite(now) ? now : Date.now(), zone || auLifecycle.FALLBACK_ZONE);
}
function dueInDays(days, now, zone) {
  return fees.addDays(localToday(now, zone), days);
}

function baseMeta(kind, i, extra) {
  return Object.assign({
    au: true, segment: 'B', lifecycle_kind: kind,
    placement_key: i.placementKey == null ? null : String(i.placementKey)
  }, extra || {});
}

/**
 * The staff decision raised when a segment B doctor is placed and their right
 * to work is, or may be, tied to an employer. NEVER creates a case by itself.
 * @param {{ name?, practiceName?, placementKey, stage?, mode, reason?, now? }} input
 */
function buildVisaTransferDecisionTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160);
  const unknown = i.mode === VISA_MODE.UNKNOWN;
  const whatToDo = unknown
    ? 'It is not on file whether this doctor\'s right to work is tied to an employer. Ask the doctor (and check their visa grant notice), then choose "Confirm: transfer needed" with the current sponsor and visa expiry, or "Not needed". Nothing happens until you choose.'
    : 'This doctor\'s visa is tied to their current employer. Confirm with the doctor and the new practice whether a transfer of nomination to ' + (practice || 'the new employer') + ' is needed, then choose "Confirm: transfer needed" (with the current sponsor and visa expiry) or "Not needed". Nothing happens until you choose.';
  return {
    task_type: 'visa_stage',
    status: 'open',
    title: (unknown
      ? 'Visa: confirm this doctor\'s right to work and whether a nomination transfer is needed'
      : 'Visa: confirm whether a nomination transfer is needed for the new employer') + ' (' + name + ')',
    description: whatToDo + ' Done when: a staff member records the decision.',
    priority: 'high',
    due_date: dueInDays(3, i.now, i.zone),
    source_trigger: SOURCE.VISA_TRANSFER_DECISION,
    related_stage: i.stage || 'prestart',
    metadata: baseMeta(KIND.VISA_TRANSFER_DECISION, i, {
      owner: OWNER_RSO, owner_then: null, checklist_row: 10, decision: null,
      visa_mode: unknown ? VISA_MODE.UNKNOWN : VISA_MODE.TRANSFER, visa_reason: i.reason || null,
      what_to_do: whatToDo, done_when: 'A staff member records "transfer needed" or "not needed".',
      needs_its_action: true
    })
  };
}

/**
 * One of the four tasks a CONFIRMED transfer raises (checklist row 10).
 * @param {string} mark  one of TRANSFER_TASK_MARKS
 * @param {{ name?, practiceName?, currentSponsor?, visaCaseId?, placementKey, stage?, now? }} input
 */
function buildTransferTask(mark, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (TRANSFER_TASK_MARKS.indexOf(mark) === -1) return null;
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160) || 'the new employer';
  const current = cleanLine(i.currentSponsor, 160);
  const rows = {
    sponsor: {
      task_type: 'sponsor', domain: 'sponsor', due: 5,
      title: 'Confirm ' + practice + ' will sponsor the nomination transfer (' + name + ')',
      what: 'Confirm with ' + practice + ' that they will take over as the sponsoring employer, and record their sponsorship contact on the transfer case.',
      done: 'The new employer has confirmed and their contact is on the transfer case. Mark complete.'
    },
    agent: {
      task_type: 'migration_agent', domain: 'visa', due: 5,
      title: 'Brief the migration agent: transfer of nomination to ' + practice + ' (' + name + ')',
      what: 'Ask ' + practice + ' who their registered migration agent is, then brief the agent: this is a TRANSFER of an existing nomination' + (current ? ' from ' + current : '') + ', not a new visa application. Record the agent on the case.',
      done: 'The migration agent is recorded and has been briefed. Mark complete.'
    },
    grant_notice: {
      task_type: 'visa_doc', domain: 'visa', due: 5,
      title: 'File the current visa grant notice (' + name + ')',
      what: 'Get the doctor\'s current visa grant notice and file it in their "Visa grant notice" document slot. It shows the subclass, the expiry and the conditions the transfer depends on.',
      done: 'The grant notice is filed in the doctor\'s document slot. This task then closes by itself.'
    },
    tracking: {
      task_type: 'visa_stage', domain: 'visa', due: 14,
      title: 'Track the nomination transfer until the new nomination is approved (' + name + ')',
      what: 'Follow the transfer with the migration agent and the new employer. When the new nomination is approved, record the approval date with "Nomination approved". The doctor must not start at ' + practice + ' before then unless the migration agent confirms in writing that they may.',
      done: 'The approval date is recorded with "Nomination approved". This task then closes by itself.'
    }
  };
  const row = rows[mark];
  const fields = {
    task_type: row.task_type,
    status: 'open',
    title: row.title,
    description: row.what + ' Done when: ' + row.done,
    priority: mark === 'tracking' ? 'normal' : 'high',
    due_date: dueInDays(row.due, i.now, i.zone),
    source_trigger: SOURCE.VISA_TRANSFER,
    related_stage: i.stage || 'prestart',
    metadata: baseMeta(KIND.VISA_TRANSFER_TASK, i, {
      mark, owner: OWNER_RSO, owner_then: null, checklist_row: 10,
      visa_case_type: CASE_TYPE.NOMINATION_TRANSFER,
      what_to_do: row.what, done_when: row.done,
      needs_its_action: mark === 'tracking' || mark === 'grant_notice'
    })
  };
  // `domain` and `visa_case_id` are columns the visa module added in
  // production on 5 Nov 2026; they are only set when there is a case to
  // point at.
  if (i.visaCaseId) { fields.domain = row.domain; fields.visa_case_id = i.visaCaseId; }
  return fields;
}

/**
 * The umbrella task for checklist row 11 ("Ahpra change of circumstances or
 * new supervision"): done when the Ahpra approval is filed. Raised only when
 * the placement hooks say the doctor's registration is supervised.
 */
function buildSupervisionTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160) || 'the new practice';
  const whatToDo = 'This doctor\'s registration is supervised (limited, provisional or with a supervision level), so the supervised practice arrangement has to be lodged again for ' + practice
    + '. Collect the supervision paperwork from the practice and the doctor (the pack tasks on this case), lodge it with Ahpra, and when Ahpra\'s approval arrives file it in the doctor\'s "Supervision plan" document slot or record it with "Record Ahpra outcome". '
    + 'What Ahpra requires for a change of practice has not been confirmed: check the current Ahpra guidance before lodging.';
  return {
    task_type: 'practice_pack',
    status: 'open',
    title: 'Supervision: lodge the new supervised practice arrangement and file the Ahpra approval (' + name + ')',
    description: whatToDo + ' Done when: the Ahpra approval is filed.',
    priority: 'high',
    due_date: dueInDays(14, i.now, i.zone),
    source_trigger: SOURCE.SUPERVISION,
    related_stage: i.stage || 'prestart',
    metadata: baseMeta(KIND.SUPERVISION_RELODGEMENT, i, {
      owner: OWNER_RSO, owner_then: null, checklist_row: 11,
      what_to_do: whatToDo,
      done_when: 'The Ahpra approval is filed in the doctor\'s "Supervision plan" slot by staff, or recorded with "Record Ahpra outcome".',
      needs_its_action: true
    })
  };
}

/** The card for a regulator email matched to a segment B doctor (ADM-14). */
function buildSegmentBAhpraLetterTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const decision = i.outcomeKind === 'granted' || i.outcomeKind === 'proposal';
  const subject = cleanLine(i.subject, 200) || 'No subject';
  const whatToDo = decision
    ? 'Ahpra has written about this doctor\'s registration and the letter reads like a decision. Read it. If it approves the change, record it with "Record Ahpra outcome" (this saves the registration details and closes the supervision task) and file the letter in the doctor\'s "Supervision plan" slot. Nothing has been sent to the doctor or the practice, and no visa case was opened.'
    : 'Ahpra has written about this doctor. Read the email and reply or act by hand. Nothing was sent, changed or opened automatically.';
  return {
    task_type: 'ahpra_correspondence',
    status: 'open',
    title: (decision ? 'Ahpra letter (segment B): confirm the outcome' : 'Ahpra email (segment B): read and action') + ' — ' + subject,
    description: whatToDo,
    priority: decision ? 'high' : 'normal',
    due_date: dueInDays(decision ? 2 : 3, i.now, i.zone),
    source_trigger: SOURCE.AHPRA_MAIL,
    related_stage: i.stage || 'prestart',
    source_gmail_message_id: i.gmailMessageId || null,
    gmail_thread_id: i.threadId || null,
    email_sender: cleanLine(i.sender, 200) || null,
    metadata: {
      au: true, segment: 'B', au_segment_b: true, owner: OWNER_RSO,
      registration_decision: decision, outcome_kind: i.outcomeKind || null,
      email_subject: subject, email_date: i.date || null,
      matched_via: i.matchedVia || null,
      what_to_do: whatToDo,
      done_when: decision ? 'A staff member records the outcome.' : 'A staff member has dealt with the email and marks this complete.'
    }
  };
}

// ── The transfer case ───────────────────────────────────────────────────────

const CASE_TYPE = Object.freeze({ NEW_APPLICATION: 'new_application', NOMINATION_TRANSFER: 'nomination_transfer' });
const DECISION = Object.freeze({ CONFIRM: 'confirm', NOT_NEEDED: 'not_needed' });

/** What staff may type as a visa subclass ("482", "Subclass 494", "TSS 482"). */
function cleanSubclass(value) {
  const s = cleanLine(value, 40);
  return /^[A-Za-z0-9 ()/-]{1,40}$/.test(s) ? s : '';
}

/**
 * Validate the staff decision on the transfer task. Nothing is written until
 * this passes.
 * @returns {{ ok: boolean, errors: object, decision?: string, fields?: object }}
 */
function validateTransferDecision(body, opts) {
  const b = body && typeof body === 'object' ? body : {};
  const o = opts || {};
  const errors = {};
  const decision = String(b.decision || '').trim().toLowerCase();
  if (decision !== DECISION.CONFIRM && decision !== DECISION.NOT_NEEDED) {
    return { ok: false, errors: { decision: 'Choose "transfer needed" or "not needed".' } };
  }
  const note = cleanLine(b.note, 500);
  if (decision === DECISION.NOT_NEEDED) {
    if (note.length < 5) errors.note = 'Say briefly why no transfer is needed (who confirmed it).';
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, errors: {}, decision, fields: { note } };
  }
  const currentSponsor = cleanLine(b.current_sponsor, 200);
  if (!currentSponsor) errors.current_sponsor = 'Enter the doctor\'s current sponsoring employer.';
  const expiry = isoDay(b.visa_expiry);
  if (!expiry) errors.visa_expiry = 'Enter the visa expiry date (YYYY-MM-DD).';
  else {
    // FB-2a (R13): "already expired" is judged against today's calendar date
    // on the practice's clock (`o.today`, or today in `o.zone`), not the UTC date.
    const today = isoDay(o.today) || localToday(o.now, o.zone);
    if (expiry < today) errors.visa_expiry = 'That visa has already expired. Check the date; if it is right, the doctor needs migration advice before anything else.';
  }
  const rawSubclass = cleanLine(b.visa_subclass, 60);
  const subclass = cleanSubclass(rawSubclass);
  if (rawSubclass && !subclass) errors.visa_subclass = 'Enter the visa subclass as letters and numbers, for example 482.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, errors: {}, decision, fields: { currentSponsor, visaExpiry: expiry, visaSubclass: subclass, note } };
}

/** The fields staff may correct on a transfer case afterwards. */
function validateTransferUpdate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const patch = {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(b, k); };
  if (has('current_sponsor')) {
    const v = cleanLine(b.current_sponsor, 200);
    if (!v) errors.current_sponsor = 'The current sponsor cannot be blank.'; else patch.current_sponsor_name = v;
  }
  if (has('visa_expiry')) {
    const v = isoDay(b.visa_expiry);
    if (!v) errors.visa_expiry = 'Enter the visa expiry date (YYYY-MM-DD).'; else patch.current_visa_expiry = v;
  }
  if (has('visa_subclass')) {
    const raw = cleanLine(b.visa_subclass, 60);
    const v = cleanSubclass(raw);
    if (raw && !v) errors.visa_subclass = 'Enter the visa subclass as letters and numbers, for example 482.'; else patch.current_visa_subclass = v || null;
  }
  if (has('new_sponsor_contact')) patch.sponsor_contact = cleanLine(b.new_sponsor_contact, 200) || null;
  if (has('reference_number')) patch.reference_number = cleanLine(b.reference_number, 100) || null;
  if (Object.keys(errors).length) return { ok: false, errors };
  if (!Object.keys(patch).length) return { ok: false, errors: { _: 'Nothing to change.' } };
  return { ok: true, errors: {}, patch };
}

function validateNominationApproved(body, opts) {
  const b = body && typeof body === 'object' ? body : {};
  const day = isoDay(b.approved_on);
  if (!day) return { ok: false, errors: { approved_on: 'Enter the date the new nomination was approved (YYYY-MM-DD).' } };
  // FB-2a (R13): today's calendar date on the practice's clock (it was the UTC
  // date pushed 14 hours ahead as a stand-in for "somewhere in Australia").
  const today = isoDay(opts && opts.today) || localToday(opts && opts.now, opts && opts.zone);
  if (day > today) return { ok: false, errors: { approved_on: 'That date is in the future.' } };
  return { ok: true, errors: {}, approvedOn: day };
}

// ── The Ahpra outcome (COM-10) ──────────────────────────────────────────────

const AHPRA_OUTCOME = Object.freeze({ APPROVED: 'approved', NOT_APPROVED: 'not_approved' });
const VISA_ACTION = Object.freeze({ TRANSFER_OF_NOMINATION: 'transfer_of_nomination', NO_VISA_ACTION: 'no_visa_action' });

/**
 * Validate what a staff member records after reading an Ahpra letter about a
 * segment B doctor. The registration fields are checked by the credentials
 * cleaner as well; this only shapes them.
 * @returns {{ ok, errors, outcome?, visaAction?, credentialsPatch?, note? }}
 */
function validateAhpraOutcome(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const outcome = String(b.outcome || '').trim().toLowerCase();
  if (outcome !== AHPRA_OUTCOME.APPROVED && outcome !== AHPRA_OUTCOME.NOT_APPROVED) errors.outcome = 'Choose "approved" or "not approved".';
  const visaAction = String(b.visa_action || '').trim().toLowerCase();
  if (visaAction !== VISA_ACTION.TRANSFER_OF_NOMINATION && visaAction !== VISA_ACTION.NO_VISA_ACTION) {
    errors.visa_action = 'Say whether a transfer of nomination is in progress, or no visa action is needed.';
  }
  const note = cleanLine(b.note, 500);
  if (outcome === AHPRA_OUTCOME.NOT_APPROVED && note.length < 5) errors.note = 'Say briefly what Ahpra decided.';
  const patch = {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(b, k) && b[k] !== '' && b[k] !== null && b[k] !== undefined; };
  if (has('registration_type')) {
    const t = String(b.registration_type).trim().toLowerCase();
    if (gpCredentialsLib.AHPRA_REGISTRATION_TYPES.indexOf(t) === -1) errors.registration_type = 'Choose a registration type from the list.';
    else patch.ahpra_registration_type = t;
  }
  if (has('supervision_level')) {
    const l = String(b.supervision_level).trim().toLowerCase();
    if (gpCredentialsLib.SUPERVISION_LEVELS.indexOf(l) === -1) errors.supervision_level = 'Choose a supervision level from the list.';
    else patch.supervision_level = l;
  }
  if (has('registration_expiry')) {
    const d = isoDay(b.registration_expiry);
    if (!d) errors.registration_expiry = 'Enter the registration expiry date (YYYY-MM-DD).'; else patch.registration_expiry = d;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'has_conditions') && typeof b.has_conditions === 'boolean') {
    patch.has_conditions = b.has_conditions;
    patch.conditions_text = b.has_conditions ? cleanLine(b.conditions_text, 1000) : '';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, errors: {}, outcome, visaAction, credentialsPatch: patch, note };
}

// ── The 19AB + DPA check (rule R4 lives in computeDpaRestricted) ────────────

/** Validate the result a staff member records to finish the 19AB check task. */
function validate19abResult(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const applies = String(b.applies || '').trim().toLowerCase();
  if (applies !== 'yes' && applies !== 'no') errors.applies = 'Choose whether section 19AB applies to this doctor: yes or no.';
  let endDate = null;
  if (b.end_date !== undefined && b.end_date !== null && b.end_date !== '') {
    endDate = isoDay(b.end_date);
    if (!endDate) errors.end_date = 'Enter the end date as YYYY-MM-DD, or leave it blank.';
  }
  const note = cleanLine(b.note, 500);
  if (note.length < 5) errors.note = 'Say briefly how you checked (for example the exemption letter, or the Services Australia tool).';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, errors: {}, applies, endDate, note };
}

// ── What the doctor's transfer page says (APP-29) ───────────────────────────
// Served only to a sponsor-tied segment B doctor with a confirmed transfer
// case. The words "visa" and "nomination" are allowed here by the named
// exception in lib/au-doctor-text.js; every other banned word still applies.

const TRANSFER_STAGE_COPY = Object.freeze({
  nomination: { label: 'Being prepared', detail: 'Your new employer and their migration agent are preparing the transfer of your nomination.' },
  lodgement: { label: 'Lodged', detail: 'The transfer of your nomination has been lodged.' },
  processing: { label: 'Being assessed', detail: 'The transfer of your nomination is being assessed.' },
  granted: { label: 'Approved', detail: 'The nomination with your new employer has been approved.' },
  refused: { label: 'Not approved', detail: 'The transfer was not approved. Your GP Link team will contact you about what happens next.' }
});

function formatDay(value) {
  const day = isoDay(String(value || '').slice(0, 10));
  if (!day) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p = day.split('-');
  return Number(p[2]) + ' ' + months[Number(p[1]) - 1] + ' ' + p[0];
}

/**
 * The doctor-facing view of a transfer case. Carries nothing staff recorded
 * beyond the facts the doctor already knows (their own sponsor and expiry).
 */
function doctorTransferView(transferCase, ctx) {
  const c = transferCase && typeof transferCase === 'object' ? transferCase : null;
  if (!c || c.case_type !== CASE_TYPE.NOMINATION_TRANSFER) return null;
  const x = ctx || {};
  const stage = TRANSFER_STAGE_COPY[c.stage] ? c.stage : 'nomination';
  const order = ['nomination', 'lodgement', 'processing', 'granted'];
  const at = order.indexOf(stage);
  return {
    title: 'Your visa: transfer of nomination',
    intro: 'Your visa is tied to your employer, so your nomination is being transferred to ' + (cleanLine(x.practiceName, 160) || 'your new practice')
      + '. You do not need to apply for a new visa. Your new employer and their migration agent do the transfer; your GP Link team keeps you posted here.',
    stage,
    stageLabel: TRANSFER_STAGE_COPY[stage].label,
    stageDetail: TRANSFER_STAGE_COPY[stage].detail,
    steps: order.map(function (key, idx) {
      return { key, label: TRANSFER_STAGE_COPY[key].label, state: stage === 'refused' ? 'upcoming' : (idx < at ? 'done' : (idx === at ? 'current' : 'upcoming')) };
    }),
    currentSponsor: cleanLine(c.current_sponsor_name, 200),
    newEmployer: cleanLine(x.practiceName || c.sponsor_name, 200),
    visaExpiry: formatDay(c.current_visa_expiry),
    visaSubclass: cleanLine(c.current_visa_subclass, 40),
    approvedOn: stage === 'granted' ? formatDay(c.grant_date) : '',
    startNote: stage === 'granted' ? ''
      : 'Please do not start at your new practice until we confirm the transfer is approved, unless the migration agent has told you in writing that you may.',
    contactLine: 'Questions? Message your GP Link team from the Support tab.'
  };
}

module.exports = {
  VISA_MODE, VISA_REASON, visaStageFor, visaCaseAllowed, visaBellAllowed,
  SWEEP_VERDICT, SWEEP_ROW, supervisedSweepVerdict,
  MAIL_ROUTE, ahpraMailRouteFor,
  KIND, SOURCE, TRANSFER_TASK_MARKS, CASE_TYPE, DECISION, AHPRA_OUTCOME, VISA_ACTION,
  buildVisaTransferDecisionTask, buildTransferTask, buildSupervisionTask, buildSegmentBAhpraLetterTask,
  validateTransferDecision, validateTransferUpdate, validateNominationApproved, validateAhpraOutcome, validate19abResult,
  TRANSFER_STAGE_COPY, doctorTransferView, formatDay, isoDay, cleanSubclass
};
