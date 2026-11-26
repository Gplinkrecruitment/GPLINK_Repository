'use strict';
/**
 * WP-20 (Australian GP build): what an AI model is told about a doctor on an
 * Australian pathway, in ONE place, and the net every AI-written sentence
 * passes before it can reach that doctor or a practice.
 *
 * Why it exists. Every prompt in this product was written for a doctor moving
 * to Australia ("helps overseas GPs register"). A doctor who is already
 * registered with Ahpra and working here has no visa or registration journey
 * with GP Link, so a model given the old premise writes about one. Each prompt
 * family now has an Australian branch, and they all take their description of
 * the doctor from here, so the wording is corrected once.
 *
 * Pure: no I/O, no switch read. The caller passes the result of
 * resolveCandidatePathway (which already honours the switch); anything that is
 * not an Australian pathway gets `null` back and must send today's prompt,
 * byte for byte.
 *
 *   auPromptContext(pathwayResult, credentials, stageFacts) -> null | ctx
 *   auPromptBlock(ctx, audience)      the text to put in a prompt
 *   auIdentityLine(role)              the Australian opening line of a prompt
 *   auOutputNet(text, opts)           { ok, text, violations } for a model reply
 *   redactForPractice(text, secrets)  strip things a practice must not be sent
 *   practiceSecretsFrom(records)      the strings to strip for one doctor
 *
 * THE OUTPUT RULE (CONVENTIONS section 33). A prompt is an instruction, and a
 * model can ignore an instruction. So nothing a model wrote about an
 * Australian doctor goes to that doctor or to a practice on the strength of
 * the prompt alone: the caller runs auOutputNet on the reply and, when it
 * trips, uses its deterministic fallback (drop the blurb, use the fixed
 * sentence, or hand a person an empty draft with a note). Staff-only text
 * (the case summary) is not netted: staff may read true regulatory terms.
 */

const auDoctorText = require('./au-doctor-text.js');
const careerIntro = require('./career-intro.js');
const journeyLadders = require('./journey-ladders.js');

const AUDIENCE = Object.freeze({ STAFF: 'staff', DOCTOR: 'doctor', PRACTICE: 'practice' });

const SEGMENT_A = 'A';
const SEGMENT_B = 'B';
const SEGMENT_C = 'C';

const AU_PATHWAYS = Object.freeze(['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']);

function token(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function day(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

const FELLOWSHIP_WORDS = Object.freeze({ fracgp: 'FRACGP', facrrm: 'FACRRM', both: 'FRACGP and FACRRM' });
const REGISTRATION_TYPE_WORDS = Object.freeze({
  general: 'general', specialist: 'specialist', general_and_specialist: 'general and specialist',
  provisional: 'provisional', limited: 'limited', non_practising: 'non-practising'
});

// ── the framings a model must not use ───────────────────────────────────────
// Kept as whole sentences: they are put into prompts verbatim.
const FORBIDDEN_ALL = Object.freeze([
  'Do not describe this doctor as an overseas, international or internationally trained doctor, or as someone moving, relocating or coming to Australia. They already live and work here.',
  'Do not mention MyIntealth, EPIC, the AMC, the GMC, the SPPA-00, Section G or a Supervisor CV. None of them is a step for this doctor.',
  'Do not say or imply that GP Link is registering this doctor, managing their registration, or waiting on an Ahpra application for them. They are already registered.'
]);
// A segment B doctor on limited or provisional registration, or with a
// supervision level on file, DOES have supervision paperwork for a new
// practice (WP-11 / WP-14, assumption R3). For them the second sentence above
// would be untrue, so it is replaced by this one.
const FORBIDDEN_STEPS_SUPERVISED = 'Do not mention MyIntealth, EPIC, the AMC or the GMC. None of them is a step for this doctor. Supervision paperwork for the new practice may be mentioned only where a task in the data shows it, and never as a registration application.';
const FORBIDDEN_NO_VISA = 'Do not mention a visa, sponsorship or a migration agent. Nothing on file says this doctor has a visa step.';
const FORBIDDEN_VISA_ONLY_AS_RECORDED = 'A visa may be mentioned only as the recorded fact above (their right to work is tied to a sponsoring employer). Do not describe a visa application, a visa pathway or a move to Australia.';
const FORBIDDEN_OUTWARD = Object.freeze([
  'Never write a dollar figure, a percentage, a billing split or a fee.',
  'Never repeat the text of a registration condition, undertaking or notation, a registration number, a provider number, or anything from an identity document.'
]);
const FORBIDDEN_PRACTICE = Object.freeze([
  'Do not tell the practice where the doctor works now, their suburb, or anything about their current employer.'
]);

// What GP Link actually needs from a practice for a doctor who is already
// registered here (the report's list). Said in every practice-facing prompt.
const WHAT_A_PRACTICE_IS_ASKED_FOR = 'WHAT GP LINK NEEDS FROM A PRACTICE for a doctor like this is only: interview times, an offer, the employment contract, the practice\'s own credentialing requirements, and the provider-number paperwork for the practice\'s location. Never say something is needed "for registration" or "to proceed with their registration": say what it is for (the interview, the offer, the contract, credentialing, or getting the doctor ready to start).';

/**
 * The description of one Australian-pathway doctor for a prompt.
 *
 * @param {object} pathwayResult  from resolveCandidatePathway / resolvePathwayFromRecords
 * @param {object} [credentials]  the doctor's gp_credentials row (may be null)
 * @param {object} [stageFacts]   what the app itself has recorded:
 *   { stage, ahpraChecked: { at, verified, by }, placement: { practiceName, startDate,
 *     commencedAt, guaranteeEndsAt }, prestart: { complete, items: [{ type, label, done }] } }
 * @returns {null | { isAu, pathway, segment, launched, confirmed, sponsorTied, supervised,
 *   paragraph, stateFacts: string[], forbidden: string[] }}
 *   `null` for anything that is not an Australian pathway: send today's prompt.
 */
function auPromptContext(pathwayResult, credentials, stageFacts) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p || p.isAu !== true || AU_PATHWAYS.indexOf(p.pathway) === -1) return null;
  const c = credentials && typeof credentials === 'object' ? credentials : {};
  const f = stageFacts && typeof stageFacts === 'object' ? stageFacts : {};
  const segment = String(p.segment || '');
  const confirmed = p.confirmed === true;

  const sentences = [];
  sentences.push('This doctor is already in Australia, registered with Ahpra and working as a GP. They are changing practice within Australia.');

  // Who they are, only as far as it has been recorded.
  if (p.pathway === 'au_vr') {
    // FR-9 S9-02: a fellowship is named only when a person recorded it on
    // their own register check or the register's own list shows it; and an
    // automatic check is not called "staff have confirmed".
    const sorted = p.sorting && typeof p.sorting === 'object' ? p.sorting : null;
    const evidence = sorted && sorted.fellowship && sorted.fellowship.source ? sorted.fellowship : null;
    const fellowship = sorted ? (evidence ? (FELLOWSHIP_WORDS[token(evidence.type)] || '') : '') : (FELLOWSHIP_WORDS[token(c.fellowship_type)] || '');
    const byLookup = !!(sorted && sorted.checkedBy === 'lookup');
    sentences.push(confirmed
      ? (byLookup
        ? 'An automatic check of the public Ahpra register shows specialist registration in general practice' + (fellowship ? ' (' + fellowship + ' is on the register)' : '') + '; no staff member has checked it by hand.'
        : 'GP Link staff have confirmed they are a vocationally registered GP' + (fellowship ? ' (' + fellowship + ')' : '') + '.')
      : 'They have told us they are a vocationally registered GP; GP Link staff have not confirmed this yet, so do not state it as fact.');
  } else if (p.pathway === 'au_restricted') {
    sentences.push('They are recorded as an Australian-registered GP with restrictions on where or how they can work'
      + (confirmed ? ' (confirmed by GP Link staff).' : ' (their own answer; GP Link staff have not confirmed it yet).'));
  } else if (p.pathway === 'au_non_vr') {
    sentences.push('They are recorded as not vocationally registered' + (confirmed ? ' (confirmed by GP Link staff).' : ' (their own answer; GP Link staff have not confirmed it yet).'));
  } else if (p.pathway === 'au_registrar') {
    sentences.push('They are recorded as a GP registrar' + (confirmed ? ' (confirmed by GP Link staff).' : ' (their own answer; GP Link staff have not confirmed it yet).'));
  }

  // Segment facts, only as far as staff have recorded them. Segment A has none
  // of these: nothing regulatory is said about a segment A doctor at all.
  const sponsorTied = p.pathway === 'au_restricted' && token(c.work_rights) === 'visa' && c.visa_sponsor_tied === true;
  if (segment === SEGMENT_B || segment === SEGMENT_C) {
    const staff19 = token(c.moratorium_19ab_confirmed_status);
    const staff19Ok = (staff19 === 'yes' || staff19 === 'no') && !!c.moratorium_19ab_confirmed_at && !!token(c.moratorium_19ab_confirmed_by);
    const self19 = token(c.moratorium_19ab_status);
    if (staff19Ok) {
      sentences.push('Section 19AB: staff have confirmed it ' + (staff19 === 'yes' ? 'applies (Distribution Priority Area locations only).' : 'does not apply.'));
    } else if (self19 === 'yes' || self19 === 'no') {
      sentences.push('Section 19AB: the doctor says it ' + (self19 === 'yes' ? 'applies' : 'does not apply') + '; staff have not confirmed this, so they are treated as limited to Distribution Priority Area locations for now.');
    } else {
      sentences.push('Section 19AB: not known yet; they are treated as limited to Distribution Priority Area locations until staff confirm.');
    }
    const regType = REGISTRATION_TYPE_WORDS[token(c.ahpra_registration_type)] || '';
    if (regType) sentences.push('Ahpra registration type on file: ' + regType + '.');
    const level = token(c.supervision_level);
    if (level && level !== 'none') sentences.push('A supervision level is on file (' + level.replace('_', ' ') + ').');
    const rights = token(c.work_rights);
    if (sponsorTied) sentences.push('Right to work on file: a visa tied to a sponsoring employer. A change of employer may need the nomination transferred; that is handled by staff with a migration agent.');
    else if (rights === 'visa') sentences.push('Right to work on file: a visa. Whether it is tied to a sponsoring employer is not recorded.');
    else if (rights === 'citizen' || rights === 'pr') sentences.push('Right to work on file: Australian citizen or permanent resident. There is no visa step.');
    else sentences.push('Right to work: not recorded.');
    sentences.push('GP Link has not launched its service for this group yet: staff handle this doctor by hand. Do not state any regulatory requirement that is not listed here.');
  } else {
    sentences.push('They have no visa step and no registration step with GP Link.');
  }

  // A registration flag is told as a flag, never as its text.
  if (c.has_conditions === true || c.has_undertakings === true || c.has_notations === true) {
    sentences.push('A registration condition, undertaking or notation is flagged on file' + (p.flagsReviewed === true ? ' and a person has reviewed it.' : ' and has not been reviewed by a person yet.') + ' Its wording is deliberately not given to you.');
  }

  const supervisedType = ['provisional', 'limited'].indexOf(token(c.ahpra_registration_type)) !== -1;
  const supervisionOnFile = !!token(c.supervision_level) && token(c.supervision_level) !== 'none';
  const supervised = segment === SEGMENT_B && (supervisedType || supervisionOnFile);
  const forbidden = FORBIDDEN_ALL.slice();
  if (supervised) forbidden[1] = FORBIDDEN_STEPS_SUPERVISED;
  forbidden.push(sponsorTied ? FORBIDDEN_VISA_ONLY_AS_RECORDED : FORBIDDEN_NO_VISA);

  return {
    isAu: true,
    pathway: p.pathway,
    segment,
    launched: p.launched === true,
    confirmed,
    sponsorTied,
    supervised,
    paragraph: sentences.join(' '),
    stateFacts: auStateFactLines(f),
    forbidden
  };
}

/**
 * STATE facts: what the app itself has recorded about where this doctor is.
 * Staff-audience lines; they outrank emails, notes and earlier summaries in
 * the case-summary prompt (the same rule the SPPA STATE facts follow).
 */
function auStateFactLines(stageFacts) {
  const f = stageFacts && typeof stageFacts === 'object' ? stageFacts : {};
  const lines = [];
  const stage = token(f.stage);
  if (stage) lines.push('Stage: ' + journeyLadders.stageLabel(stage, 'au_vr', stage) + ' (Australian ladder: Placement, Pre-start, Commenced, Guarantee period, Complete).');
  const chk = f.ahpraChecked && typeof f.ahpraChecked === 'object' ? f.ahpraChecked : null;
  if (chk) {
    // FR-9 (S9-02 / S9-08): the automatic register lookup is never "staff".
    const byLookup = /^automatic register lookup/i.test(String(chk.by || '').trim());
    if (chk.verified === true && byLookup) lines.push('Ahpra register check: completed automatically by the register lookup' + (day(chk.at) ? ' on ' + day(chk.at) : '') + '; no staff member has checked it. Fellowship, right to work and 19AB were not checked by the lookup.');
    else if (chk.verified === true) lines.push('Ahpra register check: done by staff' + (day(chk.at) ? ' on ' + day(chk.at) : '') + ', registration confirmed on the public register.');
    else if (chk.at && byLookup) lines.push('Ahpra register check: not done by a person yet (the automatic register lookup ran on ' + day(chk.at) + ' and a person needs to check).');
    else if (chk.at) lines.push('Ahpra register check: looked at by staff on ' + day(chk.at) + ', not yet marked verified.');
    else lines.push('Ahpra register check: not done yet.');
  }
  const pl = f.placement && typeof f.placement === 'object' ? f.placement : null;
  if (pl) {
    lines.push('Placement: recorded' + (pl.practiceName ? ' at ' + pl.practiceName : '') + '.');
    if (day(pl.commencedAt)) lines.push('Commenced: staff confirmed the doctor started on ' + day(pl.commencedAt) + '.');
    else if (day(pl.startDate)) lines.push('Planned start date: ' + day(pl.startDate) + ' (not yet confirmed as started).');
    else lines.push('Start date: not agreed yet.');
    if (day(pl.guaranteeEndsAt)) lines.push('Guarantee period ends: ' + day(pl.guaranteeEndsAt) + '.');
  } else if (f.placement === null) {
    lines.push('Placement: none recorded yet.');
  }
  const pre = f.prestart && typeof f.prestart === 'object' ? f.prestart : null;
  if (pre) {
    const items = prestartItems(pre);
    const open = items.filter(function (i) { return !i.done; }).map(function (i) { return i.label; });
    const done = items.filter(function (i) { return i.done; }).map(function (i) { return i.label; });
    if (pre.complete === true) lines.push('Pre-start: every item is complete' + (done.length ? ' (' + done.join('; ') + ')' : '') + '.');
    else {
      if (open.length) lines.push('Pre-start items still open: ' + open.join('; ') + '.');
      if (done.length) lines.push('Pre-start items complete: ' + done.join('; ') + '.');
      if (!open.length && !done.length) lines.push('Pre-start items: none raised yet.');
    }
  }
  return lines;
}

function prestartItems(pre) {
  return (Array.isArray(pre && pre.items) ? pre.items : [])
    .filter(function (i) { return i && i.label; })
    .map(function (i) { return { type: String(i.type || ''), label: String(i.label), done: i.done === true }; });
}

// The pre-start items a PRACTICE has a hand in (the start date, the provider
// number for their location, their own credentialing). The doctor's indemnity
// certificate is the doctor's business and is not told to a practice.
const PRACTICE_VISIBLE_PRESTART = Object.freeze(['start_date_tracking', 'provider_number_new_location', 'credentialing_pack']);

/**
 * The STATE facts a practice-facing prompt may carry: the placement at THEIR
 * practice, its dates, and the open pre-start items they have a hand in.
 * Nothing about the doctor's registration, flags, segment or other documents.
 */
function auPracticeStateFactLines(stageFacts) {
  const f = stageFacts && typeof stageFacts === 'object' ? stageFacts : {};
  const lines = [];
  const pl = f.placement && typeof f.placement === 'object' ? f.placement : null;
  if (pl) {
    if (day(pl.commencedAt)) lines.push('The doctor started at the practice on ' + day(pl.commencedAt) + '.');
    else if (day(pl.startDate)) lines.push('Planned start date at the practice: ' + day(pl.startDate) + '.');
    else lines.push('A start date has not been agreed yet.');
  }
  const open = prestartItems(f.prestart)
    .filter(function (i) { return !i.done && PRACTICE_VISIBLE_PRESTART.indexOf(i.type) !== -1; })
    .map(function (i) { return i.label; });
  if (open.length) lines.push('Still open before the start, where the practice has a part: ' + open.join('; ') + '.');
  return lines;
}

/**
 * The block a prompt carries for an Australian doctor.
 *
 *   staff     the truth paragraph, the STATE facts, the forbidden framings.
 *   doctor    the truth paragraph and the framings, plus "this goes to the
 *             doctor" rules. No STATE facts unless the caller adds them.
 *   practice  NOTHING from the doctor's records except what the caller passes
 *             as `practiceIntro` (the sentence GP Link already sends a
 *             practice, built by lib/career-intro.js from facts a practice may
 *             see). No segment facts, no flags, no state facts.
 *
 * @param {object} ctx       from auPromptContext
 * @param {string} audience  AUDIENCE.*
 * @param {{ practiceIntro?: string, practiceStateFacts?: string[] }} [opts]
 * @returns {string} '' when ctx is null
 */
function auPromptBlock(ctx, audience, opts) {
  if (!ctx || ctx.isAu !== true) return '';
  const o = opts || {};
  const lines = [];
  if (audience === AUDIENCE.PRACTICE) {
    lines.push('ABOUT THIS DOCTOR (the only facts about them you may use):');
    lines.push('The doctor is already registered with Ahpra and working as a GP in Australia, and is changing practice. '
      + (o.practiceIntro ? String(o.practiceIntro).trim() : 'Nothing else about them has been cleared for this practice.'));
    const practiceFacts = Array.isArray(o.practiceStateFacts) ? o.practiceStateFacts.filter(Boolean) : [];
    if (practiceFacts.length) { lines.push(''); lines.push('WHERE THINGS STAND (from the app\'s own records):'); practiceFacts.forEach(function (x) { lines.push('- ' + x); }); }
    lines.push('');
    lines.push(WHAT_A_PRACTICE_IS_ASKED_FOR);
    lines.push('');
    lines.push('NEVER, for this doctor:');
    FORBIDDEN_ALL.concat([FORBIDDEN_NO_VISA]).concat(FORBIDDEN_OUTWARD).concat(FORBIDDEN_PRACTICE).forEach(function (s) { lines.push('- ' + s); });
    return lines.join('\n');
  }
  lines.push('ABOUT THIS DOCTOR (authoritative; it outranks anything in emails, notes or an earlier summary):');
  lines.push(ctx.paragraph);
  if (audience === AUDIENCE.STAFF && ctx.stateFacts.length) {
    lines.push('');
    lines.push('STATE FACTS (read from the app\'s own records; authoritative):');
    ctx.stateFacts.forEach(function (s) { lines.push('- ' + s); });
  }
  lines.push('');
  lines.push('NEVER, for this doctor:');
  ctx.forbidden.forEach(function (s) { lines.push('- ' + s); });
  if (audience === AUDIENCE.DOCTOR) FORBIDDEN_OUTWARD.forEach(function (s) { lines.push('- ' + s); });
  return lines.join('\n');
}

// ── opening lines ───────────────────────────────────────────────────────────
// The Australian replacement for "…which helps overseas GPs register to work
// in Australia". One sentence per kind of prompt, so the description of what
// GP Link does for these doctors is written once.
const AU_SERVICE = 'GP Link is a medical recruitment company. For this doctor, who is already registered with Ahpra and working as a GP in Australia, GP Link is arranging a move to a new practice and the paperwork needed before they start there';
const IDENTITY = Object.freeze({
  staff_reply: 'You are a member of the GP Link team. ' + AU_SERVICE + '.',
  practice_chase: 'You are a member of the GP Link team writing to a medical practice. ' + AU_SERVICE + '.',
  case_summary: 'You are a case support assistant for GP Link. ' + AU_SERVICE + '. Your audience is the GP Link staff member who manages this doctor day to day. Write in a practical, operational tone.',
  zoom_reason: 'You write the "reason for the meeting" line for a Zoom call that a GP will see. The GP is already registered with Ahpra and working in Australia, and GP Link is helping them move to a new practice.',
  recommendation: 'You are writing on behalf of GP Link, a medical recruitment agency, to a practice manager, about a GP who is already registered with Ahpra and working in Australia.'
});
function auIdentityLine(kind) { return IDENTITY[kind] || ''; }

// ── the net under every reply ───────────────────────────────────────────────

/**
 * Check something a model wrote before it reaches an Australian doctor or a
 * practice. Never rewrites: a reply either passes untouched or is refused.
 *
 * @param {string} text
 * @param {{ audience: 'doctor'|'practice', who?: object }} opts
 *   `who` ({ pathway, credentials, context }) is passed straight to the WP-14
 *   exception check; without a named context the full list applies.
 * @returns {{ ok: boolean, text: string, violations: string[] }}
 *   ok:false -> use the caller's fallback. `violations` names what was found
 *   (never the text itself), for the log line.
 */
function auOutputNet(text, opts) {
  const o = opts || {};
  const s = String(text == null ? '' : text);
  let found = [];
  if (o.audience === AUDIENCE.PRACTICE) {
    found = careerIntro.auPracticeTextViolations(s, o.who).map(function (m) { return String(m).toLowerCase(); });
  } else {
    found = auDoctorText.violationsFor(s, o.who || {});
  }
  // A number that must never travel in AI-written text, whatever the audience.
  if (AHPRA_NUMBER.test(s)) found.push('ahpra number');
  if (PROVIDER_NUMBER.test(s)) found.push('provider number');
  const unique = found.filter(function (v, i) { return found.indexOf(v) === i; });
  return { ok: unique.length === 0, text: unique.length === 0 ? s : '', violations: unique };
}

/** One log line when the net trips. Names only: never the model's text. */
function auNetLog(where, violations, extra) {
  try {
    console.warn('[au-ai-net] ' + where + ': the AI text was not used (' + (violations || []).join(', ') + ')' + (extra ? ' ' + extra : ''));
  } catch (e) { /* logging must never break a request */ }
}

// ── what a practice-facing prompt must not contain ──────────────────────────
// An Ahpra registration number (three letters and ten digits, e.g. MED0001234567)
// and a Medicare provider number (six digits, a location character, a check
// letter, e.g. 123456AB).
const AHPRA_NUMBER = /\b[A-Z]{3}\d{10}\b/;
const PROVIDER_NUMBER = /\b\d{6}[0-9A-Z][A-Z]\b/;
const WITHHELD = '[withheld]';

/**
 * The strings on one doctor's records that a practice must not be sent: the
 * text of a condition, undertaking or notation, their Ahpra number, any
 * provider or prescriber number, their current employer and suburb.
 * @param {{ credentials?: object, profile?: object, providerNumbers?: string[], extra?: string[] }} records
 */
function practiceSecretsFrom(records) {
  const r = records && typeof records === 'object' ? records : {};
  const c = r.credentials && typeof r.credentials === 'object' ? r.credentials : {};
  const prof = r.profile && typeof r.profile === 'object' ? r.profile : {};
  const out = [];
  [c.conditions_text, c.undertakings_text, c.notations_text, c.ahpra_number, c.visa_sponsor_name, c.visa_subclass,
    prof.register_number, prof.current_suburb, prof.current_postcode]
    .concat(Array.isArray(r.providerNumbers) ? r.providerNumbers : [])
    .concat(Array.isArray(r.extra) ? r.extra : [])
    .forEach(function (v) {
      const s = String(v == null ? '' : v).trim();
      if (s.length >= 3 && out.indexOf(s) === -1) out.push(s);
    });
  // Longest first, so a number inside a longer string is not left half-cut.
  return out.sort(function (a, b) { return b.length - a.length; });
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Take out of a prompt, before it is sent, anything a practice must not be
 * sent about this doctor. Used on every string of a practice-facing prompt for
 * an Australian doctor (the thread, the facts, the request text).
 */
function redactForPractice(text, secrets) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  (Array.isArray(secrets) ? secrets : []).forEach(function (secret) {
    if (!secret) return;
    s = s.replace(new RegExp(escapeRegExp(secret), 'gi'), WITHHELD);
  });
  return s.replace(new RegExp(AHPRA_NUMBER.source, 'g'), WITHHELD).replace(new RegExp(PROVIDER_NUMBER.source, 'g'), WITHHELD);
}

module.exports = {
  AUDIENCE, AU_PATHWAYS,
  auPromptContext, auPromptBlock, auStateFactLines, auPracticeStateFactLines, auIdentityLine,
  PRACTICE_VISIBLE_PRESTART, WHAT_A_PRACTICE_IS_ASKED_FOR,
  auOutputNet, auNetLog,
  redactForPractice, practiceSecretsFrom, WITHHELD,
  FORBIDDEN_ALL, FORBIDDEN_STEPS_SUPERVISED, FORBIDDEN_NO_VISA, FORBIDDEN_VISA_ONLY_AS_RECORDED, FORBIDDEN_OUTWARD, FORBIDDEN_PRACTICE
};
