'use strict';
/**
 * WP-13 (Australian GP build): the commercial terms of an Australian-based
 * placement, read from the practice agreement. Pure, no I/O, no switch read.
 *
 * EVERY NUMBER IN THIS FILE IS COPIED FROM THE AGREEMENT SOURCE, with the file
 * and line beside it. Nothing here is a business decision of this package:
 * owner decision 3 (use the fee tiers already in the agreement, no separate
 * price for segment B) and decision 4 (the Australian fee is invoiced on
 * commencement, unchanged). tests/au-wp13-fees-lib.test.js re-reads the two
 * HTML sources and fails if a figure here no longer appears there.
 *
 * Sources:
 *   standard         assets/legal/src/agreement-2026.html
 *   discounted-2026  assets/legal/src/agreement-2026-discounted.html
 *   which one a practice signed: practices.metadata.agreement_variant
 *   (lib/agreement-variants.js resolveAgreementVariant; the sign-link endpoint
 *   writes it, and refuses to change it once the practice has signed).
 *
 * Fail closed: when the sessions a week or the signed variant is not known,
 * `known` is false and NO amount is returned. A fee is never guessed.
 *
 * Overseas-based fees (two payments, on acceptance and on commencement) are
 * NOT computed here and nothing about them is changed by this package.
 */

const agreementVariants = require('./agreement-variants.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// ── THE CALENDAR-DATE RULE (docs/au-gp/CONVENTIONS.md section 25) ────────────
// Every date in this file is a CALENDAR DATE: a 'YYYY-MM-DD' string with no
// time and no zone (the commencement day, the last working day, the invoice
// date, the guarantee end, a check-in day). The helpers below only ever turn
// such a string into "midnight UTC of that date" to count whole days between
// two dates or to step a date forward, and straight back into a string. That
// is exact: no local zone, no daylight saving, no time of day can enter.
// What "today" is (a calendar date at the PRACTICE) is the caller's business
// and is always passed in. Never `new Date('YYYY-MM-DD')`, never
// `Date.now()`, never a difference of two instants divided by 24 hours.

const FEE_TIER = Object.freeze({ FULL_TIME: 'full_time', PART_TIME: 'part_time' });
const BASIS = Object.freeze({ AUSTRALIA: 'australia', OVERSEAS: 'overseas' });

// "A full-time placement is an engagement averaging eight (8) or more sessions
// (approximately 35 or more hours) per week."      agreement-2026.html:182
// "A part-time placement is an engagement averaging fewer than eight (8)
// sessions ..."                                     agreement-2026.html:215
// Definitions clause: agreement-2026.html:407-408. The discounted variant
// carries the same definition (agreement-2026-discounted.html:196, :229, :422).
const FULL_TIME_MIN_SESSIONS = 8;

// The most sessions a week a person can enter (two a day, seven days).
const MAX_SESSIONS = 14;

// Placement fee, GP candidates based in Australia, exclusive of GST
// ("All fees are exclusive of GST", agreement-2026.html:185).
//   standard         full-time $21,000   agreement-2026.html:204, :210, :333
//                    part-time $18,000   agreement-2026.html:237, :243, :343
//   discounted-2026  full-time $19,000   agreement-2026-discounted.html:218, :224, :348
//                    part-time $17,000   agreement-2026-discounted.html:251, :257, :358
const AU_BASED_FEES_EX_GST = Object.freeze({
  standard: Object.freeze({ full_time: 21000, part_time: 18000 }),
  'discounted-2026': Object.freeze({ full_time: 19000, part_time: 17000 })
});

// "For Australian-based GPs, the full fee is invoiced when the placed doctor
// commences work."                                  agreement-2026.html:184-185
const INVOICE_TIMING = 'on_commencement';

// "You must pay our fees and charges ... within seven (7) days of the date of
// invoice."                               agreement-2026.html:548 (clause 6.5)
const INVOICE_PAYMENT_DAYS = 7;

// "Guarantee period means the period of twelve (12) weeks from the date the
// candidate commences the placement"                agreement-2026.html:409
const GUARANTEE_WEEKS = 12;
const GUARANTEE_DAYS = GUARANTEE_WEEKS * 7;

// The check-ins the review report asks for (checklist row 14). These are GP
// Link's own practice, not a term of the agreement.
const CHECKIN_WEEKS = Object.freeze([4, 8, 12]);

// Clause 7.1, the credit schedule                   agreement-2026.html:593-595
//   "Up to 4 weeks: 80% of the placement fee is credited ..."
//   "Between 4-8 weeks: 50% ..."
//   "Between 8-12 weeks: 35% ..."
// "All calculations are made on the candidate's last working day with you, not
// on the day they give notice"                      agreement-2026.html:596
const CREDIT_BANDS = Object.freeze([
  Object.freeze({ key: 'up_to_4_weeks', fromDay: 0, toDay: 28, pct: 80 }),
  Object.freeze({ key: 'weeks_4_to_8', fromDay: 28, toDay: 56, pct: 50 }),
  Object.freeze({ key: 'weeks_8_to_12', fromDay: 56, toDay: 84, pct: 35 })
]);

// Clause 6.12: "If a part-time placement increases to an average of eight (8)
// or more sessions ... within twelve (12) months of commencement, the
// difference between the part-time fee paid and the applicable full-time fee
// becomes payable"                                  agreement-2026.html:582-584
// The reminders at months 6 and 12 are GP Link's own practice (review report,
// commercial issue 6). A reminder states no amount.
const UPLIFT_WINDOW_MONTHS = 12;
const UPLIFT_REMINDER_MONTHS = Object.freeze([6, 12]);

// The 2026 agreement went live on 2026-07-16 (docs/handover-practice-agreement-2026.md,
// "Status as of 2026-07-16"; rebuilt in commit 8ddd684 on 2026-07-15). A
// practice whose signature is dated before that signed an earlier document
// whose terms this file does not hold (review report, commercial issue 8), so
// its variant is "not known".
const AGREEMENT_2026_LIVE_FROM = '2026-07-16';

const UNKNOWN_REASON = Object.freeze({
  SESSIONS: 'sessions_unknown',
  VARIANT: 'agreement_variant_unknown',
  NOT_AUSTRALIAN_BASIS: 'not_australian_basis'
});

function dayMs(value) {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : NaN;
}
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
/** A YYYY-MM-DD date, or '' when the value is not a real calendar day. */
function cleanDay(value) {
  const t = dayMs(value);
  return Number.isFinite(t) ? isoDay(t) : '';
}
function addDays(day, n) {
  const t = dayMs(day);
  return Number.isFinite(t) ? isoDay(t + n * DAY_MS) : '';
}
// Calendar months: 31 August + 6 months is the last day of February.
function addMonths(day, n) {
  const t = dayMs(day);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return isoDay(target.getTime());
}
function daysBetween(fromDay, toDay) {
  const a = dayMs(fromDay);
  const b = dayMs(toDay);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY_MS) : NaN;
}

/**
 * Sessions a week as a number, or null. Accepts a number or a plain numeric
 * string ("8", "7.5"). Anything else ("6-8", "full time", "") is null: the
 * free-text column is never interpreted (DAT-16).
 */
function cleanSessions(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^\d{1,2}(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= MAX_SESSIONS ? n : null;
}

/** 'full_time' | 'part_time' | null, by the agreement's definition. */
function feeTierForSessions(value) {
  const n = cleanSessions(value);
  if (n === null) return null;
  return n >= FULL_TIME_MIN_SESSIONS ? FEE_TIER.FULL_TIME : FEE_TIER.PART_TIME;
}

/**
 * Which agreement variant did this practice sign?
 *
 * Known only when the practice e-signed the 2026 agreement in the app:
 *   - agreement_status is 'signed' (or the metadata stash the sign endpoint
 *     writes on a database without those columns), AND
 *   - there is an e-signature date (agreement_signed_at), on or after the day
 *     the 2026 agreement went live, AND
 *   - metadata.agreement_variant is absent (the standard agreement is what the
 *     sign endpoint stamps then) or names a real variant.
 * Anything else is "not known": a paper agreement uploaded by hand (its terms
 * are not in the app), an earlier agreement, an unrecognised or draft key.
 *
 * @param {object|null} practice  a `practices` row
 * @returns {{ known: boolean, variant: string|null, reason: string, signedAt: string|null }}
 */
function signedAgreementVariantFor(practice) {
  const out = { known: false, variant: null, reason: '', signedAt: null };
  if (!practice || typeof practice !== 'object') { out.reason = 'practice_not_on_file'; return out; }
  const meta = practice.metadata && typeof practice.metadata === 'object' ? practice.metadata : {};
  const stash = meta.pipeline_agreement && typeof meta.pipeline_agreement === 'object' ? meta.pipeline_agreement : {};
  const signed = practice.agreement_status === 'signed' || stash.agreement_status === 'signed';
  if (!signed) { out.reason = 'agreement_not_signed'; return out; }
  const signedAt = String(practice.agreement_signed_at || stash.agreement_signed_at || '');
  const signedDay = cleanDay(signedAt);
  if (!signedDay) { out.reason = 'no_esignature_on_file'; return out; }
  out.signedAt = signedAt;
  if (signedDay < AGREEMENT_2026_LIVE_FROM) { out.reason = 'signed_before_2026_agreement'; return out; }
  const raw = meta.agreement_variant;
  const key = raw === undefined || raw === null || String(raw).trim() === '' ? agreementVariants.DEFAULT_VARIANT : String(raw).trim();
  if (!agreementVariants.isAgreementVariant(key) || !AU_BASED_FEES_EX_GST[key]) { out.reason = 'agreement_variant_unrecognised'; return out; }
  out.known = true;
  out.variant = key;
  return out;
}

/**
 * THE fee for a placement of an Australian-based GP.
 *
 * @param {{ basis: string, sessionsPerWeek: number|string|null,
 *           variant: string|null, variantKnown?: boolean, variantReason?: string }} input
 *   basis            candidatePathway.feeBasisFor(pathwayResult)
 *   sessionsPerWeek  numeric sessions a week (never the free-text column)
 *   variant          the signed variant's key (signedAgreementVariantFor)
 * @returns {{ tier: string|null, amountExGst: number|null, variant: string|null,
 *             basis: string, source: 'agreement', known: boolean, reason: string,
 *             invoiceTiming: string|null, sessionsPerWeek: number|null }}
 */
function placementFeeFor(input) {
  const i = input && typeof input === 'object' ? input : {};
  const basis = i.basis === BASIS.AUSTRALIA ? BASIS.AUSTRALIA : BASIS.OVERSEAS;
  const sessions = cleanSessions(i.sessionsPerWeek);
  const tier = feeTierForSessions(sessions);
  const variantKey = typeof i.variant === 'string' ? i.variant.trim() : '';
  const variantOk = i.variantKnown !== false && !!variantKey && agreementVariants.isAgreementVariant(variantKey) && !!AU_BASED_FEES_EX_GST[variantKey];
  const out = {
    tier: null, amountExGst: null, variant: variantOk ? variantKey : null, basis,
    source: 'agreement', known: false, reason: '', invoiceTiming: null, sessionsPerWeek: sessions
  };
  if (basis !== BASIS.AUSTRALIA) { out.reason = UNKNOWN_REASON.NOT_AUSTRALIAN_BASIS; return out; }
  out.invoiceTiming = INVOICE_TIMING;
  out.tier = tier;
  if (!tier) { out.reason = UNKNOWN_REASON.SESSIONS; return out; }
  if (!variantOk) { out.reason = i.variantReason ? String(i.variantReason) : UNKNOWN_REASON.VARIANT; return out; }
  out.amountExGst = AU_BASED_FEES_EX_GST[variantKey][tier];
  out.known = true;
  return out;
}

/** The last day of the guarantee period: commencement + 12 weeks. */
function guaranteeEndsOn(commencedDay) { return addDays(commencedDay, GUARANTEE_DAYS); }

/** [{ week, date }] for the check-ins at weeks 4, 8 and 12. */
function guaranteeCheckinDays(commencedDay) {
  if (!cleanDay(commencedDay)) return [];
  return CHECKIN_WEEKS.map(function (week) { return { week, date: addDays(commencedDay, week * 7) }; });
}

/** The day an invoice sent on `sentDay` must be paid by (clause 6.5). */
function invoicePaymentDueOn(sentDay) { return addDays(sentDay, INVOICE_PAYMENT_DAYS); }

/** [{ month, date }] for the part-time uplift reminders (months 6 and 12). */
function upliftReminderDays(commencedDay) {
  if (!cleanDay(commencedDay)) return [];
  return UPLIFT_REMINDER_MONTHS.map(function (month) { return { month, date: addMonths(commencedDay, month) }; });
}

const EXIT_REASON = Object.freeze({
  // clause 7.1(b): the candidate "terminates the contract"
  DOCTOR_RESIGNED: 'doctor_resigned',
  // clause 7.1(a): "performs unsatisfactorily ... and the placement is
  // terminated for that reason"
  PERFORMANCE_TERMINATED: 'performance_terminated',
  // clause 7.2(i) (redundancy, the practice's operational requirements, a
  // breach by the practice ...) and clause 7.3 (a reason "clearly outside the
  // control of the candidate": "any credit in those circumstances is provided
  // at our discretion"). No credit follows from the schedule: a person decides.
  PRACTICE_SIDE: 'practice_side',
  OTHER: 'other'
});
const EXIT_REASONS = Object.freeze(Object.keys(EXIT_REASON).map(function (k) { return EXIT_REASON[k]; }));
const EXIT_REASON_LABEL = Object.freeze({
  doctor_resigned: 'The doctor ended the contract',
  performance_terminated: 'The practice ended it because of the doctor\'s performance',
  practice_side: 'A reason on the practice\'s side (redundancy, operations, conditions not provided, not enough patients)',
  other: 'Something else / not sure'
});

/**
 * THE credit a practice is due when the placed doctor leaves, per clause 7 of
 * the agreement (agreement-2026.html:589-640) and clause 6.5 (:548-551).
 *
 * What can be worked out from what is on file:
 *   - the band, from the commencement day and the LAST WORKING DAY (:596);
 *   - forfeiture for THIS placement's invoice: "the guarantee is forfeited
 *     where any invoice is or has been overdue" (:614-615, clause 7.2(c));
 *     an invoice is overdue 7 days after its date (:548).
 * What cannot, and is therefore a person's answer (`conditionsConfirmed`):
 *   - the rest of clause 7.2 (the practice notified us promptly and in
 *     writing, inducted the doctor, met its other obligations, paid every
 *     OTHER invoice on time, the fee was not paid with an earlier credit ...).
 *
 * `creditPct` is a number only when every one of those is known. Otherwise it
 * is null and `reason` says what a person must decide: never a guessed figure.
 *
 * @param {{ commencedAt: string, lastWorkingDay: string, reason: string,
 *           invoiceSentAt?: string|null, invoicePaidAt?: string|null,
 *           conditionsConfirmed?: 'yes'|'no'|'unknown'|null, asOf?: string }} input
 * @returns {{ creditPct: number|null, known: boolean, reason: string,
 *             daysWorked: number|null, band: string|null, scheduleBandPct: number|null,
 *             forfeited: boolean, withinGuarantee: boolean|null, needsDecision: string[] }}
 */
function guaranteeCreditFor(input) {
  const i = input && typeof input === 'object' ? input : {};
  const out = {
    creditPct: null, known: false, reason: '', daysWorked: null, band: null, scheduleBandPct: null,
    forfeited: false, withinGuarantee: null, needsDecision: []
  };
  const commenced = cleanDay(i.commencedAt);
  const last = cleanDay(i.lastWorkingDay);
  if (!commenced || !last) { out.reason = 'dates_unknown'; out.needsDecision.push('dates_unknown'); return out; }
  const days = daysBetween(commenced, last);
  if (!(days >= 0)) { out.reason = 'last_day_before_commencement'; out.needsDecision.push('dates_unknown'); return out; }
  out.daysWorked = days;

  // Past the twelve weeks: clause 7.1 does not apply. Nothing to credit.
  if (days > GUARANTEE_DAYS) {
    out.withinGuarantee = false;
    out.creditPct = 0;
    out.known = true;
    out.reason = 'outside_guarantee_period';
    return out;
  }
  out.withinGuarantee = true;

  // The band. The schedule's edges overlap as written ("Up to 4 weeks",
  // "Between 4-8 weeks", "Between 8-12 weeks"): a last working day exactly 4
  // or 8 weeks after commencement could be read as either band, and exactly
  // 12 weeks as either the last band or the end of the period. Those three
  // days are a person's call, never this function's.
  const onEdge = days === 28 || days === 56 || days === GUARANTEE_DAYS;
  let band = null;
  for (let n = 0; n < CREDIT_BANDS.length; n++) {
    const b = CREDIT_BANDS[n];
    if (days >= b.fromDay && days < b.toDay) { band = b; break; }
  }
  if (!onEdge && band) { out.band = band.key; out.scheduleBandPct = band.pct; }

  // Forfeiture, from this placement's own invoice (definitive when it applies).
  const sent = cleanDay(i.invoiceSentAt);
  const paid = cleanDay(i.invoicePaidAt);
  // `asOf` is TODAY AS A CALENDAR DATE AT THE PRACTICE (the caller works it
  // out: lib/au-lifecycle.js localDay). It is never taken from the server's
  // own clock here: a UTC "today" is yesterday for an Australian practice
  // until mid-morning. Without it an unpaid invoice cannot be judged overdue
  // or not, so that case is "not known" (a person decides).
  const asOf = cleanDay(i.asOf);
  let invoiceState = 'unknown';
  if (sent) {
    const dueBy = invoicePaymentDueOn(sent);
    if (paid) invoiceState = paid > dueBy ? 'overdue' : 'paid_on_time';
    else if (!asOf) invoiceState = 'unknown';
    else invoiceState = asOf > dueBy ? 'overdue' : 'not_yet_due';
  } else if (paid) {
    invoiceState = 'unknown';
  } else {
    invoiceState = 'not_sent';
  }
  if (invoiceState === 'overdue') {
    out.forfeited = true;
    out.creditPct = 0;
    out.known = true;
    out.reason = 'forfeited_invoice_overdue';
    return out;
  }
  // The practice did not meet the other conditions: clause 7.2 says our
  // obligations arise "if and only if" they are met.
  if (i.conditionsConfirmed === 'no') {
    out.creditPct = 0;
    out.known = true;
    out.reason = 'conditions_not_met';
    return out;
  }

  if (onEdge) out.needsDecision.push('band_edge_day');
  if (invoiceState === 'not_sent') out.needsDecision.push('invoice_not_sent');
  else if (invoiceState === 'not_yet_due') out.needsDecision.push('invoice_not_yet_paid');
  else if (invoiceState === 'unknown') out.needsDecision.push('invoice_dates_unknown');
  const reason = String(i.reason || '');
  if (reason === EXIT_REASON.PRACTICE_SIDE) out.needsDecision.push('discretionary_or_excluded_reason');
  else if (reason !== EXIT_REASON.DOCTOR_RESIGNED && reason !== EXIT_REASON.PERFORMANCE_TERMINATED) out.needsDecision.push('reason_unknown');
  if (i.conditionsConfirmed !== 'yes') out.needsDecision.push('conditions_not_confirmed');

  if (out.needsDecision.length) { out.reason = out.needsDecision[0]; return out; }
  out.creditPct = band.pct;
  out.known = true;
  out.reason = 'schedule';
  return out;
}

// Plain words for each "a person must decide" code (staff task text).
const CREDIT_DECISION_TEXT = Object.freeze({
  dates_unknown: 'the commencement day or the last working day is not on file',
  band_edge_day: 'the last working day falls exactly on the edge between two bands of the schedule (4, 8 or 12 weeks after commencement), which the schedule\'s wording does not settle',
  invoice_not_sent: 'no invoice is recorded as sent for this placement, so "paid by the due date" cannot be checked',
  invoice_not_yet_paid: 'the invoice is not recorded as paid yet and its due date has not passed',
  invoice_dates_unknown: 'the invoice dates on file are incomplete',
  discretionary_or_excluded_reason: 'the reason given is on the practice\'s side: clause 7.2(i) excludes some of those and clause 7.3 leaves any credit to our discretion',
  reason_unknown: 'the reason the doctor left is not recorded as one of the two clause 7.1 covers',
  conditions_not_confirmed: 'nobody has confirmed the other conditions of clause 7.2 (the practice told us promptly and in writing, inducted the doctor, met its other obligations, and has paid every other invoice on time)'
});

module.exports = {
  FEE_TIER, BASIS, FULL_TIME_MIN_SESSIONS, MAX_SESSIONS, AU_BASED_FEES_EX_GST, INVOICE_TIMING,
  INVOICE_PAYMENT_DAYS, GUARANTEE_WEEKS, GUARANTEE_DAYS, CHECKIN_WEEKS, CREDIT_BANDS,
  UPLIFT_WINDOW_MONTHS, UPLIFT_REMINDER_MONTHS, AGREEMENT_2026_LIVE_FROM, UNKNOWN_REASON,
  EXIT_REASON, EXIT_REASONS, EXIT_REASON_LABEL, CREDIT_DECISION_TEXT,
  cleanDay, addDays, addMonths, daysBetween, cleanSessions,
  feeTierForSessions, signedAgreementVariantFor, placementFeeFor,
  guaranteeEndsOn, guaranteeCheckinDays, invoicePaymentDueOn, upliftReminderDays,
  guaranteeCreditFor
};
