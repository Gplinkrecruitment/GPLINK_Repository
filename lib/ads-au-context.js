'use strict';

/**
 * WP-24 (Australian GP build): the ads hub's brief for the AUSTRALIAN
 * campaign, and the check every piece of Australian ad copy passes before it
 * can be stored or shown. Pure, no I/O.
 *
 * STATUS: the text below is the DRAFT house context from
 * docs/au-gp/ads-au-house-context.md (written by WP-20). It is used ONLY when
 * the owner has approved it (ADS_AU_HOUSE_CONTEXT_APPROVED=true, owner action
 * 95); lib/ads-campaigns.js carries that flag and server.js refuses to call
 * the model for the Australian campaign without it.
 *
 * The overseas (UK) brief is NOT here and is not touched: it stays in
 * lib/ads-review.js (HOUSE_CONTEXT, REVIEW_SYSTEM, BRIEF_SYSTEM) byte for
 * byte. A campaign with no audience recorded uses the UK brief.
 *
 * A prompt is an instruction and a model can ignore an instruction, so the
 * rule that matters is `adCopyViolations`: a brief that trips it is dropped,
 * never rewritten (CONVENTIONS section 33, THE OUTPUT RULE).
 */

const auDoctorText = require('./au-doctor-text.js');

// "Free for doctors" may be said only once the owner confirms it for this
// audience (the draft flags it). The line is added to the brief only then,
// and the net refuses the word "free" until then.
const FREE_LINE = '- That the service is free for doctors.';

function houseContext(opts) {
  const freeOk = !!(opts && opts.freeForDoctorsApproved);
  return [
    'Advertiser: GP Link, an Australian GP recruitment agency.',
    '',
    'Audience for this campaign: GPs who are ALREADY registered with Ahpra and working in Australia, and who are thinking about changing practice. Most are vocationally registered (FRACGP or FACRRM). They are not moving country. They have a job now, and their employer does not know they are looking.',
    '',
    'What GP Link does for them: finds them a better-fitting practice, arranges the interviews, and handles the paperwork between accepting an offer and the first day (the start date, the provider number for the new location, indemnity, the practice\'s credentialing).',
    '',
    'Tone: one GP talking to another. Calm, specific, unhurried. No hype, no exclamation marks, no urgency. Australian spelling. "GP", never "physician". No em dashes.',
    '',
    'What an ad may say:',
    '- That a conversation is confidential and their current employer is not told.',
    '- That GP Link only puts them forward to a practice they have agreed to.',
    '- What kinds of things can be different at another practice: the billing model (bulk, mixed or private billing), the mix of sessions, the patient list, the team, the location, the commute. Name the kind of thing, never a number.'
  ].concat(freeOk ? [FREE_LINE] : []).concat([
    '- That the first step is a short call with a person.',
    '',
    'What an ad must never say:',
    '- Any pay figure: no dollar amount, no percentage, no billing split, no "earn more", no income comparison, no "up to".',
    '- Any guarantee: of a job, an offer, an interview, a start date, higher earnings, or a time frame.'
  ]).concat(freeOk ? [] : ['- That the service is free, or costs nothing: that claim is not approved for this audience yet.']).concat([
    '- Anything that frames the reader as coming from somewhere else: no "overseas", "international", "internationally trained", "relocate", "relocation", "your move", "moving to Australia", "visa", "sponsorship", "registration support", "MyIntealth", "AMC", "GMC", "NHS" or "UK".',
    '- Anything about 19AB, the moratorium, Distribution Priority Areas, conditions on registration, or supervision. Those are individual and are discussed on the call, never advertised.',
    '- The name of any practice, or anything that identifies one.',
    '- Anything negative about the reader\'s current employer or about a named practice group.',
    '- That GP Link is a regulator, a college or a government service, or that it can speed up anything Ahpra, a college or Services Australia does.',
    '- A call from an AI or automated caller: the first call is with a person.'
  ]).join('\n');
}

const PHOTO_DIRECTION = [
  'THE PHOTOGRAPH. One GP, in an Australian general practice or an Australian everyday setting, in an ordinary moment, and image_prompt is the brief for it. Plain clothes, no scrubs or white coat, no lanyard or name badge. Face seen from a three-quarter angle, eyes on the task, not looking at the camera. A medium shot with plain space above the head where the headline can sit. No text, no logos, no screens with legible words.',
  'Never an airport, a suitcase, a passport, a flag, a map, a plane, or anything that reads as arriving in the country. Never a landmark postcard. The reader already lives here.'
].join('\n');

// What happens after an Australian lead, for the model. Keep in step with
// docs/au-gp/au-lead-copy.md (WP-16) and CONVENTIONS section 28.
const AUTOMATION = [
  'On the form: the doctor says whether they are registered with Ahpra and a few facts about their registration. The app records their own answers and never infers them.',
  'The AI phone agent never rings a lead from this campaign. Every call is with a person.',
  'Messages: a booking link, then short notes about 5 minutes, 1 hour and 24 hours after the form if no call is booked, by email (WhatsApp only where an approved template exists). Notes sent because time has passed are held outside 08:00 to 20:00 on the doctor\'s own clock.',
  'After a booked call: a confirmation, a reminder the day before and an hour before, a note after a missed call, and a short follow-up sequence after an attended call.',
  'Conversion events for these leads go to the Australian dataset only, never to the overseas campaign\'s.'
];

function reviewSystem(opts) {
  return [
    'You are the head of marketing for GP Link, reviewing ONE Meta campaign every morning for the owner, who is not an ads specialist: the campaign aimed at GPs already registered and working in Australia. Write in plain English, short sentences, no jargon that is not explained, no em dashes. Be direct: say what is working, what is not, and what to do today. Never invent a number; every claim must trace to the data you are given. When the data is thin (few leads), say so and avoid strong verdicts. Never compare this campaign\'s costs with another campaign\'s: only its own numbers are in front of you.',
    '',
    'HOW TO READ THE BOOKED NUMBERS. In every funnel a booked call is exactly one of four things: attended (the doctor was seen in the call), no_show (the doctor did not join), upcoming (the call is booked for a time still ahead) or unverified (the time has passed and the attendance check has not answered yet). attend_rate_pct is attended out of attended plus no_show only. Never describe upcoming or unverified calls as missing outcomes.',
    '',
    'How to judge: cost per BOOKING outranks cost per lead; cost per lead outranks CTR. Treat an ad under 7 days old as settling unless it is already clearly wasting money. Never tell the owner to ring or message leads by hand, and never suggest an automated or AI caller for these leads.',
    '',
    'WHAT WORKS AND WHY. Fill what_works with the patterns behind the ads that book, each with the ads and numbers that prove it, and what_doesnt with the patterns that spend without booking.',
    '',
    'New ad briefs must follow every rule under ACCOUNT CONTEXT exactly; a brief that breaks one is discarded by the app before the owner sees it. primary_text is three short paragraphs separated by a blank line: what the reader may want to be different; that a confidential conversation is the first step; the invitation to a short call with a person. image_headline is under 45 characters with no exclamation marks.',
    '',
    PHOTO_DIRECTION,
    '',
    'CHANGES YOU CAN MAKE DIRECTLY. account_changes is the list of changes to this campaign in the Meta account. The owner ticks the ones to make and the app applies them through the API, so every entry must be exact: the action, the exact id from the data, and for a budget the new daily figure. For THIS campaign only five actions exist: pause_ad, resume_ad, pause_adset, resume_adset and set_adset_daily_budget; never propose launch_draft or create_ad (new ads for this campaign are not launched from this page). Never more than double a budget in one step. If nothing should change today, return an empty list. Anything the API cannot do goes in actions_today with where: ads_manager.',
    '',
    'automation_changes must be an empty list for this campaign.',
    '',
    'ACCOUNT CONTEXT',
    houseContext(opts)
  ].join('\n');
}

function briefSystem(opts) {
  return [
    'You write Meta lead ads for GP Link, for GPs already registered and working in Australia. Every ad must follow the rules under ACCOUNT CONTEXT exactly; an ad that breaks one is discarded by the app. Plain English, short sentences, Australian spelling, no em dashes.',
    '',
    'Structure of primary_text: three short paragraphs separated by a blank line. Paragraph 1: what the reader may want to be different about where they work, named as a kind of thing, never a number. Paragraph 2: that a conversation is confidential and their current employer is not told, and that they are only put forward where they agree. Paragraph 3: the invitation to a short call with a person.',
    '',
    'image_headline: under 45 characters, no exclamation marks. image_sub: one calm line under 90 characters. headline: same as image_headline. description: under 40 characters. why_strong: each reason cites the figure or pattern it rests on; when the data is thin, say so.',
    '',
    PHOTO_DIRECTION,
    '',
    'ACCOUNT CONTEXT',
    houseContext(opts)
  ].join('\n');
}

// ── the net ────────────────────────────────────────────────────────────────
// Money and promises (docs/au-gp/ads-au-house-context.md, "The check to run on
// generated copy"). The money half mirrors lib/ai-candidate-job-match.js
// AU_REASON_MONEY_PATTERN, widened for ad copy.
const MONEY = /\$|£|€|%|\bper\s?cent\b|\bpercent(age)?s?\b|\d\s?k\b|\b\d{2}\s?\/\s?\d{2}\b|\baud\b|\bdollars?\b|\bsalar(y|ies|ied)\b|\bincome\b|\bcommission\b|\bearn(s|ed|ing|ings)?\b|\bwages?\b|\bremuneration\b|\bbilling split\b|\bpay\s?rise\b|\bbetter pay\b|\bmore money\b|\bup to\s+\d/i;
const GUARANTEE = /\bguarantee(s|d)?\b|\bpromise(s|d)?\b|\bassured\b/i;
const FREE = /\bfree\b|\bno cost\b|\bat no charge\b|\bcosts? (you )?nothing\b/i;
const ELSEWHERE = /\bUK\b|\bU\.K\.|\bNHS\b|\bBritish\b|\binternational(ly)?\b|\bsponsor(ship|ed)?\b|\bmoving to australia\b|\bregistration support\b/i;
const REGULATORY = /\b19\s?AB\b|\bmoratorium\b|\bDPA\b|\bdistribution priority\b|\bsupervis(ion|ed|or)\b|\bconditions on\b/i;
const AI_CALLER = /\bhazel\b|\bAI (call|caller|agent|phone)\b|\bautomated call\b/i;

const COPY_FIELDS = ['image_headline', 'image_sub', 'headline', 'primary_text', 'description', 'image_prompt'];

/**
 * Why a piece of Australian ad copy may not be used: a list of reasons, []
 * when it is clean. opts.freeForDoctorsApproved lifts the "free" rule only.
 */
function adCopyViolations(text, opts) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const out = auDoctorText.violations(s).map(function (w) { return 'banned word: ' + w; });
  if (MONEY.test(s)) out.push('a pay figure, percentage or earnings claim');
  if (GUARANTEE.test(s)) out.push('a guarantee');
  if (!(opts && opts.freeForDoctorsApproved) && FREE.test(s)) out.push('"free for doctors" (not approved for this audience yet)');
  if (ELSEWHERE.test(s)) out.push('wording for a doctor from somewhere else');
  if (REGULATORY.test(s)) out.push('a regulatory topic that is never advertised');
  if (AI_CALLER.test(s)) out.push('an automated caller');
  return out;
}

/** Every reason across a brief's copy fields ("headline: a guarantee"). */
function briefViolations(brief, opts) {
  const b = brief || {};
  const out = [];
  COPY_FIELDS.forEach(function (f) {
    adCopyViolations(b[f], opts).forEach(function (why) { out.push(f + ': ' + why); });
  });
  return out;
}

/**
 * The net for a list of briefs. Returns { kept, dropped: [{ angle, reasons }] }.
 * A brief that trips is DROPPED, never edited.
 */
function netBriefs(briefs, opts) {
  const kept = [];
  const dropped = [];
  (Array.isArray(briefs) ? briefs : []).forEach(function (b) {
    const reasons = briefViolations(b, opts);
    if (reasons.length) dropped.push({ angle: String((b && b.angle) || ''), reasons: reasons });
    else kept.push(b);
  });
  return { kept: kept, dropped: dropped };
}

// The actions an Australian review may propose. Nothing new: a SUBSET of
// lib/ads-actions.js ACTIONS. New ads for this campaign are not written,
// photographed or launched from the page (that pipeline is the UK brief's).
const AU_ALLOWED_ACTIONS = Object.freeze(['pause_ad', 'resume_ad', 'pause_adset', 'resume_adset', 'set_adset_daily_budget']);

/**
 * A normalised review for the Australian campaign, passed through the net.
 * Returns { review, dropped } where dropped lists what was removed and why.
 */
function netReview(review, opts) {
  const r = Object.assign({}, review || {});
  const dropped = [];
  const briefs = netBriefs(r.new_ad_briefs, opts);
  briefs.dropped.forEach(function (d) { dropped.push({ kind: 'brief', id: d.angle, reasons: d.reasons }); });
  r.new_ad_briefs = briefs.kept;
  r.account_changes = (Array.isArray(r.account_changes) ? r.account_changes : []).filter(function (c) {
    if (AU_ALLOWED_ACTIONS.indexOf(c && c.action) !== -1) return true;
    dropped.push({ kind: 'account_change', id: String((c && c.id) || ''), reasons: ['"' + String(c && c.action) + '" is not available for the Australian campaign'] });
    return false;
  });
  if (Array.isArray(r.automation_changes) && r.automation_changes.length) {
    dropped.push({ kind: 'automation_changes', id: '', reasons: ['automation levers belong to the overseas funnel'] });
  }
  r.automation_changes = [];
  r.warnings = [];
  return { review: r, dropped: dropped };
}

module.exports = {
  houseContext,
  PHOTO_DIRECTION,
  AUTOMATION,
  reviewSystem,
  briefSystem,
  adCopyViolations,
  briefViolations,
  netBriefs,
  netReview,
  AU_ALLOWED_ACTIONS,
  COPY_FIELDS
};
