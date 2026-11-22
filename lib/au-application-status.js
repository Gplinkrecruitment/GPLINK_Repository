'use strict';
/**
 * FB-2b (walk-findings W3-D5): ONE true status for an application, as a
 * doctor on an Australian pathway is shown it. Pure, no I/O.
 *
 * Why this exists. An application's state lives in several fields that are
 * each written by a different step: the stored `status`, the kanban
 * `ats_stage`, the practice's decision, the interview row, the contract's
 * stage, and the `ats_offers` row. The doctor-facing status used to be built
 * by reading them one at a time with no order of precedence, in the server
 * (`buildInternalCareerStatusPresentation`) and again in each page. Two
 * things followed, both seen on the third walk:
 *
 *   1. Booking an interview flips the practice's interview INVITATION (an
 *      `ats_offers` row) to `accepted`. The standard status consults that
 *      row once the application reaches the offer stage, reads "an accepted
 *      offer" as "the doctor accepted an employment offer", and answers
 *      "Offer accepted: finalising your placement" from the moment the
 *      contract is sent to the doctor, before any signature.
 *   2. The application page drew each field's own card, so one screen said
 *      "Offer accepted", "Interview complete: the practice is considering",
 *      and "You have an offer from this practice" at once.
 *
 * For an Australian doctor the server now works the status out HERE, once,
 * with the precedence written down, and every screen draws that one answer
 * (`auStatus` on each application of GET /api/career/applications and
 * /api/career/application). An overseas doctor's payload is not touched.
 *
 * The order (the first that is true wins):
 *
 *   placement_ended / placement_complete   (already decided by the caller)
 *   placement_secured     signed, and the placement is recorded
 *   withdrawn / not_proceeding / offer_declined
 *   contract_signed       signed; the placement is being recorded
 *   offer_received        the agreement is with the doctor: review and sign
 *   offer_changes         the doctor asked for a change; with us / the practice
 *   interview_missed      the interview was missed
 *   offer_preparing       interview done, the practice is preparing an offer
 *   interview_done        interview done, waiting to hear from the practice
 *   interview_booked      a time is booked
 *   interview_to_choose   the practice wants to meet: choose a time
 *   reviewing             the practice has opened the profile
 *   submitted             sent to the practice
 *   under_review          applied; GP Link is checking it
 *
 * `null` = this is not an application to describe here (an unanswered match):
 * the caller leaves the payload exactly as it was.
 *
 * Every string a doctor can read from this file is scanned for the
 * AGENT-RULES section 4 words (tests/au-fb2b-application-status.test.js).
 */

const KEY = Object.freeze({
  PLACEMENT_ENDED: 'placement_ended',
  PLACEMENT_COMPLETE: 'placement_complete',
  PLACEMENT_SECURED: 'placement_secured',
  WITHDRAWN: 'withdrawn',
  NOT_PROCEEDING: 'not_proceeding',
  OFFER_DECLINED: 'offer_declined',
  CONTRACT_SIGNED: 'contract_signed',
  OFFER_RECEIVED: 'offer_received',
  OFFER_CHANGES: 'offer_changes',
  INTERVIEW_MISSED: 'interview_missed',
  OFFER_PREPARING: 'offer_preparing',
  INTERVIEW_DONE: 'interview_done',
  INTERVIEW_BOOKED: 'interview_booked',
  INTERVIEW_TO_CHOOSE: 'interview_to_choose',
  REVIEWING: 'reviewing',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review'
});

// What each status says. `status` is the machine key the existing pages and
// the careers step strip already understand; `cta` is where the one button on
// the card leads ('timeline' | 'interview' | 'offer' | 'placement' | 'roles').
const VIEW = Object.freeze({
  placement_ended: { status: 'placement_ended', label: 'Placement ended', ribbon: 'PLACEMENT ENDED', tone: 'review', step: 0, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'Your time at this practice has finished. You can look at roles again whenever you are ready.' },
  placement_complete: { status: 'placement_complete', label: 'Placement complete', ribbon: 'PLACEMENT COMPLETE', tone: 'review', step: 0, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'You are settled at this practice. Nothing more to do on this application.' },
  placement_secured: { status: 'placement_secured', label: 'Signed: placement secured', ribbon: 'SECURED', tone: 'secured', step: 4, cta: 'placement', ctaLabel: 'Open my placement',
    blurb: 'You have signed and your placement is secured. Your pre-start checklist is next.' },
  withdrawn: { status: 'withdrawn', label: 'Application withdrawn', ribbon: 'WITHDRAWN', tone: 'review', step: 0, cta: 'timeline', ctaLabel: 'Open the timeline', blurb: '' },
  not_proceeding: { status: 'not_proceeding', label: 'Not proceeding this time', ribbon: 'NOT PROCEEDING', tone: 'review', step: 0, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'This one did not work out. Your GP Link consultant can help you find the next fit.' },
  offer_declined: { status: 'offer_declined', label: 'You declined this offer', ribbon: 'OFFER DECLINED', tone: 'review', step: 0, cta: 'timeline', ctaLabel: 'Open the timeline', blurb: 'You declined this offer.' },
  contract_signed: { status: 'offer', label: 'Signed: confirming your placement', ribbon: 'SIGNED', tone: 'secured', step: 3, cta: 'offer', ctaLabel: 'View status',
    blurb: 'You have signed. We are recording your placement now.' },
  offer_received: { status: 'offer', label: 'Offer received: review and sign', ribbon: 'OFFER RECEIVED', tone: 'offer', step: 3, cta: 'offer', ctaLabel: 'Review and sign',
    blurb: 'The practice has sent your agreement. Read it, then sign it in the app or ask for a change.' },
  offer_changes: { status: 'offer', label: 'You asked for a change', ribbon: 'CHANGE REQUESTED', tone: 'offer', step: 3, cta: 'offer', ctaLabel: 'View status',
    blurb: 'You asked for a change to the agreement. We are taking it up with the practice and will let you know.' },
  interview_missed: { status: 'interview', label: 'Interview missed', ribbon: 'INTERVIEW MISSED', tone: 'interview', step: 2, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'The interview did not go ahead. Message us and we will set up another time.' },
  offer_preparing: { status: 'offer', label: 'Interview done: the practice is preparing an offer', ribbon: 'OFFER ON ITS WAY', tone: 'offer', step: 3, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'The practice would like to make you an offer. We will tell you as soon as the agreement is ready to read.' },
  interview_done: { status: 'interview_completed', label: 'Interview done: waiting to hear from the practice', ribbon: 'INTERVIEW DONE', tone: 'review', step: 2, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'Your interview is done. The practice is deciding, and we will let you know as soon as they do.' },
  interview_booked: { status: 'interview', label: 'Interview booked', ribbon: 'INTERVIEW BOOKED', tone: 'interview', step: 2, cta: 'timeline', ctaLabel: 'See my interview',
    blurb: 'Your interview time is booked. We will send the video link before it starts.' },
  interview_to_choose: { status: 'interview', label: 'Choose your interview time', ribbon: 'CHOOSE A TIME', tone: 'interview', step: 2, cta: 'interview', ctaLabel: 'Choose a time',
    blurb: 'The practice would like to meet you. Choose the interview time that suits you.' },
  reviewing: { status: 'reviewing', label: 'The practice is reviewing your profile', ribbon: 'WITH THE PRACTICE', tone: 'review', step: 1, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'The practice has your profile and is reading it. There is nothing you need to do right now.' },
  submitted: { status: 'submitted', label: 'Sent to the practice', ribbon: 'SENT TO THE PRACTICE', tone: 'review', step: 1, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'We have put you forward to the practice. There is nothing you need to do right now.' },
  under_review: { status: 'applied', label: 'Under review', ribbon: 'UNDER REVIEW', tone: 'review', step: 1, cta: 'timeline', ctaLabel: 'Open the timeline',
    blurb: 'Your GP Link consultant checks every request before the practice sees it. There is nothing you need to do right now.' }
});

const SECURED = ['hired', 'secured', 'placed', 'placement_secured', 'contract_signed'];
const norm = function (v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_'); };

/**
 * @param {object} input
 *   storedStatus     gp_applications.status
 *   atsStage         gp_applications.ats_stage
 *   practiceDecision gp_applications.practice_decision
 *   interviewCompletedAt  gp_applications.interview_completed_at
 *   payloadStatus    the status the standard code worked out (only its
 *                    terminal answers are trusted: placement_ended,
 *                    placement_complete, withdrawn, not_proceeding,
 *                    offer_declined, and the secured set)
 *   secured          the standard code's `isPlacementSecured`
 *   contractStage    the live contract's stage, or ''
 *   interview        { status, scheduledAt } | null
 *   pendingMatch     true for a match the doctor has not answered
 * @returns {null | { key, status, statusLabel, statusTone, ribbon, blurb, cta, ctaLabel, step, offerPending, interviewBookable }}
 */
function auApplicationStatus(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.pendingMatch === true) return null;
  const stored = norm(i.storedStatus);
  const stage = norm(i.atsStage);
  const payload = norm(i.payloadStatus);
  if (stored === 'matched' || stored === 'shortlisted' || payload === 'matched' || payload === 'shortlisted') return null;
  const contract = norm(i.contractStage);
  const iv = i.interview && typeof i.interview === 'object' ? i.interview : null;
  const ivStatus = iv ? norm(iv.status) : '';
  const ivWhen = iv ? String(iv.scheduledAt || iv.scheduled_at || '') : '';
  const interviewDone = ivStatus === 'completed' || stored === 'interview_completed' || !!i.interviewCompletedAt;
  const approved = norm(i.practiceDecision) === 'approved' || stage === 'interview' || stored === 'interview';

  let key;
  if (payload === KEY.PLACEMENT_ENDED) key = KEY.PLACEMENT_ENDED;
  else if (payload === KEY.PLACEMENT_COMPLETE) key = KEY.PLACEMENT_COMPLETE;
  else if (i.secured === true || SECURED.indexOf(stored) !== -1) key = KEY.PLACEMENT_SECURED;
  else if (stored === 'withdrawn' || payload === 'withdrawn') key = KEY.WITHDRAWN;
  else if (stored === 'rejected' || stage === 'not_proceeding' || payload === 'not_proceeding') key = KEY.NOT_PROCEEDING;
  else if (payload === 'offer_declined') key = KEY.OFFER_DECLINED;
  else if (contract === 'signed') key = KEY.CONTRACT_SIGNED;
  else if (contract === 'sent_to_gp') key = KEY.OFFER_RECEIVED;
  else if (contract === 'changes_requested' || contract === 'practice_review') key = KEY.OFFER_CHANGES;
  else if (ivStatus === 'no_show' || ivStatus === 'missed') key = KEY.INTERVIEW_MISSED;
  // An accepted `ats_offers` row is NOT read here at all: since booking became
  // the acceptance of the practice's invitation it says nothing about an
  // employment offer. Only the pipeline stage and the contract do.
  else if (interviewDone && (stage === 'offer' || stage === 'hired' || stored === 'offer')) key = KEY.OFFER_PREPARING;
  else if (interviewDone) key = KEY.INTERVIEW_DONE;
  else if (ivWhen && ivStatus !== 'cancelled') key = KEY.INTERVIEW_BOOKED;
  else if (stage === 'offer' || stored === 'offer') key = KEY.OFFER_PREPARING;
  else if (approved) key = KEY.INTERVIEW_TO_CHOOSE;
  else if (stage === 'reviewing') key = KEY.REVIEWING;
  else if (stage === 'submitted') key = KEY.SUBMITTED;
  else key = KEY.UNDER_REVIEW;

  const v = VIEW[key];
  return {
    key,
    status: v.status,
    statusLabel: v.label,
    statusTone: v.tone,
    ribbon: v.ribbon,
    blurb: v.blurb,
    cta: v.cta,
    ctaLabel: v.ctaLabel,
    step: v.step,
    // The "Review offer" button of the older in-app offer flow is never the
    // right one here: the agreement is reached through the contract stage.
    offerPending: false,
    // The time picker is offered in exactly one status.
    interviewBookable: key === KEY.INTERVIEW_TO_CHOOSE
  };
}

module.exports = { KEY, VIEW, auApplicationStatus };
