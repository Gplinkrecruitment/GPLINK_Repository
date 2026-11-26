'use strict';
// Builds the plain-language candidate introduction used in the
// submit-to-practice email. Pure module — no I/O — so it is unit-testable.

var COUNTRY_META = {
  uk: { name: 'the United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  gb: { name: 'the United Kingdom', flag: '\u{1F1EC}\u{1F1E7}', trained: 'Trained in the UK' },
  ie: { name: 'Ireland', flag: '\u{1F1EE}\u{1F1EA}', trained: 'Trained in Ireland' },
  nz: { name: 'New Zealand', flag: '\u{1F1F3}\u{1F1FF}', trained: 'Trained in New Zealand' }
};
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function countryMeta(code) {
  var k = String(code || '').trim().toLowerCase();
  if (k === 'united kingdom' || k === 'great britain') k = 'uk';
  if (k === 'ireland') k = 'ie';
  if (k === 'new zealand') k = 'nz';
  return COUNTRY_META[k] || null;
}

function formatTargetDate(value) {
  var s = String(value || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return '';
  var monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  return MONTHS[monthIdx] + ' ' + m[1];
}

function pathwayLabelFor(accountStatus) {
  if (String(accountStatus || '').trim().toLowerCase() === 'pep_waitlist') {
    return 'Practice Experience Program (PEP) pathway';
  }
  return 'Expedited Specialist Pathway';
}

function buildCandidateIntro(opts) {
  var o = opts || {};
  var gpName = String(o.gpName || '').trim();
  var hasName = gpName.length > 0;
  var meta = countryMeta(o.countryCode);
  var pathway = pathwayLabelFor(o.accountStatus);
  var startLabel = formatTargetDate(o.targetDate);
  var specialty = String(o.specialty || '').trim();

  var bits = [];

  // First sentence — use "This candidate" with no "Dr" when name is empty
  var displayName;
  if (!hasName) {
    displayName = 'This candidate';
  } else if (/^dr\b/i.test(gpName)) {
    displayName = gpName;
  } else {
    displayName = 'Dr ' + gpName;
  }

  var lead = displayName + ' is a';
  if (meta) lead += 'n internationally trained GP from ' + meta.name;
  else lead += 'n internationally trained GP';

  // Guard specialty clause: only append if cleaned value is non-empty
  if (specialty) {
    var cleanedSpecialty = specialty.replace(/\s*—.*$/, '').trim();
    if (cleanedSpecialty) lead += ' holding the ' + cleanedSpecialty;
  }
  lead += ', coming to Australia via the ' + pathway + '.';
  bits.push(lead);

  // Second sentence
  if (startLabel) {
    if (hasName) {
      var surname = gpName.split(' ').pop();
      bits.push('Dr ' + surname + ' is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
    } else {
      bits.push('This candidate is hoping to commence work by ' + startLabel + ', with GP Link managing the registration process end-to-end.');
    }
  } else {
    bits.push('GP Link is managing the registration process end-to-end.');
  }

  var facts = [];
  if (meta) facts.push({ icon: meta.flag, label: meta.trained });
  facts.push({ icon: '\u{1FA7A}', label: pathway + (specialty ? ' (' + specialty.split(' ')[0] + ')' : '') });
  if (startLabel) {
    var shortMonth = startLabel.slice(0, 3) + ' ' + startLabel.split(' ')[1];
    facts.push({ icon: '\u{1F4C5}', label: 'Available from ' + shortMonth });
  }
  // Only ever set by the caller when staff have CONFIRMED the doctor on the
  // public register (register_status === 'verified') — never a claim we have
  // not checked. E.g. "GMC registration verified".
  var registerVerifiedLabel = String(o.registerVerifiedLabel || '').trim();
  if (registerVerifiedLabel) facts.push({ icon: '✅', label: registerVerifiedLabel });

  return { paragraph: bits.join(' '), facts: facts, pathwayLabel: pathway, startDateLabel: startLabel };
}

// ════════════════════════════════════════════════════════════════════════════
// WP-09: the introduction for a doctor on an AUSTRALIAN pathway.
//
// Everything above this line is the overseas builder and is unchanged: a
// doctor with no pathway recorded, and every doctor while the AU switch is
// off, still gets exactly that wording (tests/au-wp09-overseas-intro-parity).
//
// The Australian introduction says only what is on file:
//   - "vocationally registered" only for pathway au_vr, and only stated as a
//     fact once staff have confirmed the pathway;
//   - "Ahpra registration verified" only when staff recorded the register
//     check as verified; a number merely on file reads "verification in
//     progress"; nothing on file says nothing;
//   - where the doctor is based: the STATE only. Never a suburb, never the
//     current practice;
//   - never the registration number, never the text of a condition, never a
//     dollar figure or a percentage;
//   - never the overseas wording ("internationally trained", the pathway
//     label, "managing the registration process").
// The two functions are pure. auIntroFactsFromRecords is the ONLY place that
// touches the stored rows, and it copies out booleans and short codes only, so
// a number or a free-text field cannot leak into a sentence by accident.
// ════════════════════════════════════════════════════════════════════════════

var AU_PATHWAYS = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];
var AU_STATE_NAMES = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia',
  SA: 'South Australia', TAS: 'Tasmania', ACT: 'the Australian Capital Territory', NT: 'the Northern Territory'
};
var AU_FELLOWSHIP_LABELS = { fracgp: 'FRACGP', facrrm: 'FACRRM', both: 'FRACGP and FACRRM' };
var AU_SUPERVISED_TYPES = ['provisional', 'limited'];

// What a practice must never be told about a doctor on an Australian pathway
// (AGENT-RULES section 4, plus the three phrases WP-09 exists to remove, plus
// money). Used by the tests and by auSafeRecommendation below.
var AU_PRACTICE_BANNED = [
  /internationally[\s-]+trained/i, /overseas[\s-]+trained/i, /expedited specialist/i,
  /managing the registration process/i, /registration process/i, /coming to australia/i,
  /\bmyintealth\b/i, /\bamc\b/i, /\bepic\b/i, /\bvisas?\b/i, /\brelocat\w*/i, /\byour move\b/i,
  /\boverseas\b/i, /\bgmc\b/i, /\bsppa\b/i, /\bsection g\b/i, /\bsupervisor cv\b/i, /not yet eligible/i,
  /\bpep\b/i, /practice experience program/i,
  /\$/, /%/, /\bper ?cent\b/i
];

/** The banned phrases found in a practice-facing string for an Australian doctor ([] = clean). */
// WP-14: `who` ({ pathway, credentials, context }) is the one named exception
// (lib/au-doctor-text.js sponsorTiedVisaException): for a sponsor-tied segment
// B doctor, message N21 to the practice may say "visa". Nothing else changes,
// and without `who` the full list applies exactly as before.
function auPracticeTextViolations(text, who) {
  var s = String(text == null ? '' : text);
  var hits = [];
  var allowVisa = !!who && require('./au-doctor-text.js').sponsorTiedVisaException(who).indexOf('visa') !== -1;
  AU_PRACTICE_BANNED.forEach(function (re) {
    if (allowVisa && re.source === '\\bvisas?\\b') return;
    var m = s.match(re);
    if (m) hits.push(m[0]);
  });
  return hits;
}

/**
 * The AI-written "why we recommend" blurb is free text from the CV. For an
 * Australian doctor it is dropped whole if it carries a banned phrase (the
 * email and the page then simply have no recommendation block). WP-20 owns
 * the prompt; this is only the net under it.
 */
function auSafeRecommendation(text) {
  var s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return auPracticeTextViolations(s).length ? '' : s;
}

function auToken(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function auFormatDayDate(iso, short) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return '';
  var month = short ? MONTHS[monthIdx].slice(0, 3) : MONTHS[monthIdx];
  return Number(m[3]) + ' ' + month + ' ' + m[1];
}

/**
 * The facts the Australian introduction may use, copied out of the stored
 * rows. Returns null for anything that is not an Australian pathway.
 *
 * @param {object} input
 * @param {object} input.pathwayResult  resolvePathwayFromRecords(...) for the doctor
 * @param {object|null} input.credentials  the gp_credentials row
 * @param {object|null} input.profile   the user_profiles row (state, availability, register_status)
 * @param {Date|string|number} [input.now]
 */
function auIntroFactsFromRecords(input) {
  var i = input && typeof input === 'object' ? input : {};
  var p = i.pathwayResult && typeof i.pathwayResult === 'object' ? i.pathwayResult : null;
  if (!p || p.isAu !== true || AU_PATHWAYS.indexOf(p.pathway) === -1) return null;
  var c = i.credentials && typeof i.credentials === 'object' ? i.credentials : {};
  var prof = i.profile && typeof i.profile === 'object' ? i.profile : {};
  var fit = p.roleFit && typeof p.roleFit === 'object' ? p.roleFit : {};

  var registerStatus = auToken(prof.register_status);
  var staffVerified = !!c.staff_verified_at && registerStatus === 'verified' && !!c.ahpra_number;
  var hasFlags = c.has_conditions === true || c.has_undertakings === true || c.has_notations === true;
  var flagsReviewed = !!(c.flags_reviewed_at && auToken(c.flags_reviewed_by));
  var conditions = hasFlags ? (flagsReviewed ? 'reviewed' : 'unreviewed') : 'none';

  // A flag nobody has looked at yet: the check is not finished, so it is not
  // called verified.
  var ahpra = 'none';
  if (staffVerified && conditions !== 'unreviewed') ahpra = 'verified';
  else if (c.ahpra_number && registerStatus !== 'mismatch') ahpra = 'in_progress';

  var fellowshipRaw = auToken(c.fellowship_type);
  var fellowship = AU_FELLOWSHIP_LABELS[fellowshipRaw] ? fellowshipRaw : '';
  // FR-9 S9-02. A fellowship is stated to a practice as fact from ONE of two
  // sources only: a PERSON saved the register check as verified (the stamp is
  // theirs, not the automatic lookup's), or the register's own qualification
  // list shows it (lib/au-work-sorting.js `fellowship`, name matched). The
  // automatic check completing is NOT one: it never looks at the fellowship.
  var sortedEarly = p.sorting && typeof p.sorting === 'object' ? p.sorting : null;
  var fellowshipEvidence = sortedEarly && sortedEarly.fellowship && typeof sortedEarly.fellowship === 'object' ? sortedEarly.fellowship : {};
  var verifiedByPerson = !!c.staff_verified_at && !require('./au-work-sorting.js').isAutomaticActor(c.staff_verified_by);
  var fellowshipOnRegister = fellowshipEvidence.source === 'register' && !!AU_FELLOWSHIP_LABELS[fellowshipEvidence.type];
  // What the register itself shows is what a practice is told, even when the
  // doctor's own answer named a different one.
  if (!verifiedByPerson && fellowshipOnRegister) fellowship = fellowshipEvidence.type;

  var stateCode = String(prof.current_state == null ? '' : prof.current_state).trim().toUpperCase();
  if (!AU_STATE_NAMES[stateCode]) stateCode = '';

  // Availability. A notice period is quoted as a length, never turned into a
  // date (that date would move every day); a stated future date is quoted as
  // a date unless the notice period runs past it.
  var nowDate = i.now == null ? new Date() : new Date(i.now);
  if (isNaN(nowDate.getTime())) nowDate = new Date();
  var todayIso = nowDate.toISOString().slice(0, 10);
  var from = String(prof.available_from == null ? '' : prof.available_from).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || isNaN(Date.parse(from + 'T00:00:00Z'))) from = '';
  var weeksRaw = prof.notice_period_weeks;
  var weeks = (weeksRaw === null || weeksRaw === undefined || weeksRaw === '') ? NaN : Number(weeksRaw);
  var hasNotice = isFinite(weeks) && weeks >= 0 && weeks <= 104;
  var availability = { kind: 'none' };
  if (from && from > todayIso) {
    var afterNotice = hasNotice
      ? new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()) + Math.round(weeks * 7) * 86400000).toISOString().slice(0, 10)
      : '';
    if (afterNotice && afterNotice > from) availability = { kind: 'notice', weeks: Math.round(weeks) };
    else availability = { kind: 'date', iso: from };
  } else if (hasNotice) {
    availability = weeks < 1 ? { kind: 'now' } : { kind: 'notice', weeks: Math.round(weeks) };
  } else if (from) {
    availability = { kind: 'now' };
  }

  // 19AB, as a PRACTICE is told it. Only a STAFF confirmation is "does not
  // apply". WP-29: `dpaRestricted === false` can no longer be read as that,
  // because it is now also false on the doctor's own answer (which opens the
  // doctor's own view only and is never presented to a practice as checked).
  // It applies when staff or the doctor said so, or when the register lookup
  // shows the doctor trained outside Australia and New Zealand and is still
  // inside the ten years; it is "being confirmed" in every other case.
  var staffHas19 = !!(c.moratorium_19ab_confirmed_at && auToken(c.moratorium_19ab_confirmed_by));
  var staff19 = staffHas19 ? auToken(c.moratorium_19ab_confirmed_status) : '';
  var sorted = p.sorting && typeof p.sorting === 'object' ? p.sorting : null;
  var registerSaysRestricted = !!(sorted && sorted.basis === 'register' && sorted.dpaOnly === true && sorted.register && sorted.register.trainedAbroad === true);
  var dpaOnly = 'unconfirmed';
  if (staff19 === 'no' && p.dpaRestricted === false) dpaOnly = 'no';
  else if (staff19 === 'yes' || auToken(c.moratorium_19ab_status) === 'yes' || registerSaysRestricted) dpaOnly = 'yes';

  var regType = auToken(c.ahpra_registration_type);
  var level = auToken(c.supervision_level);
  var supervisedType = AU_SUPERVISED_TYPES.indexOf(regType) !== -1 ? regType : '';
  // FR-9 S9-12: a supervision requirement the register lookup read counts too.
  // The practice is told in plain words ("works under supervision"), never
  // the register's own text.
  var supervised = fit.supervised === true || !!supervisedType || (level !== '' && level !== 'none')
    || !!(sorted && sorted.supervision && sorted.supervision.required === true);

  return {
    pathway: p.pathway,
    pathwayConfirmed: p.confirmed === true,
    fellowship: fellowship,
    // A fellowship is stated as fact only from a STAFF-VERIFIED record (FR-1,
    // R-04): staff saved the register check as verified, after which the
    // doctor can no longer change it (gp-credentials STAFF_VERIFIED_LOCKED_FIELDS).
    // A confirmed pathway alone is not enough: without the verified stamp the
    // fellowship on file may still be the doctor's own, editable, answer.
    fellowshipConfirmed: !!fellowship && ((verifiedByPerson && (p.confirmed === true || staffVerified)) || (!verifiedByPerson && fellowshipOnRegister)),
    fellowshipSource: !fellowship ? null : (verifiedByPerson && (p.confirmed === true || staffVerified) ? 'staff' : (!verifiedByPerson && fellowshipOnRegister ? 'register' : 'doctor')),
    ahpra: ahpra,
    state: stateCode,
    availability: availability,
    dpaOnly: dpaOnly,
    registrar: p.pathway === 'au_registrar' || fit.registrar === true,
    supervised: supervised,
    supervisedType: supervisedType,
    conditions: conditions,
    employerTiedWorkRights: c.visa_sponsor_tied === true
  };
}

/**
 * The practice-facing introduction for a doctor on an Australian pathway.
 * Same return shape as buildCandidateIntro ({ paragraph, facts, pathwayLabel,
 * startDateLabel }) plus the Australian extras the email and the decision page
 * use (audience, nextSteps, confidentialityNote). Returns null without facts.
 *
 * @param {object} opts
 * @param {string} opts.gpName
 * @param {object} opts.facts   from auIntroFactsFromRecords (required)
 */
function buildAuCandidateIntro(opts) {
  var o = opts || {};
  var f = o.facts && typeof o.facts === 'object' ? o.facts : null;
  if (!f || AU_PATHWAYS.indexOf(f.pathway) === -1) return null;
  // FR-1 (R-07): a name is data. One line, nothing that can look like a tag
  // (this Australian builder only; buildCandidateIntro above is unchanged).
  var gpName = require('./au-safe-text.js').safeText(o.gpName, 160);
  var hasName = gpName.length > 0;
  var displayName = !hasName ? 'This candidate' : (/^dr\b/i.test(gpName) ? gpName : 'Dr ' + gpName);
  var shortName = hasName ? 'Dr ' + gpName.split(' ').pop() : 'This candidate';
  var shortNameMid = hasName ? shortName : 'this candidate';
  var possessive = shortName + '’s';
  var possessiveMid = shortNameMid + '’s';

  var fellowshipLabel = f.fellowship ? AU_FELLOWSHIP_LABELS[f.fellowship] : '';
  var statedFellowship = (fellowshipLabel && f.fellowshipConfirmed) ? ' (' + fellowshipLabel + ')' : '';
  var where = f.state ? AU_STATE_NAMES[f.state] : 'Australia';

  var bits = [];
  var facts = [];
  var pathwayLabel;

  if (f.pathway === 'au_vr' && f.pathwayConfirmed) {
    pathwayLabel = 'Vocationally registered GP';
    bits.push(displayName + ' is a vocationally registered GP' + statedFellowship + ' based in ' + where + '.');
    facts.push({ icon: '\u{1FA7A}', label: 'Vocationally registered GP' + statedFellowship });
  } else if (f.pathway === 'au_vr') {
    pathwayLabel = 'GP';
    bits.push(displayName + ' is a GP based in ' + where + '.');
    bits.push(shortName + ' has told us they are vocationally registered' + (fellowshipLabel ? ' (' + fellowshipLabel + ')' : '') + '; we are confirming this.');
    facts.push({ icon: '\u{1FA7A}', label: 'GP: vocational registration being confirmed' });
  } else if (f.pathway === 'au_non_vr') {
    pathwayLabel = 'Non-VR GP';
    bits.push(displayName + ' is a non-vocationally registered GP based in ' + where + '.');
    facts.push({ icon: '\u{1FA7A}', label: 'Non-VR GP' });
  } else if (f.pathway === 'au_registrar') {
    pathwayLabel = 'GP registrar';
    bits.push(displayName + ' is a GP registrar based in ' + where + '.');
    facts.push({ icon: '\u{1FA7A}', label: 'GP registrar' });
  } else {
    pathwayLabel = 'GP';
    bits.push(displayName + ' is a GP' + statedFellowship + ' based in ' + where + '.');
    facts.push({ icon: '\u{1FA7A}', label: 'GP' + statedFellowship });
  }
  if (f.state) facts.push({ icon: '\u{1F4CD}', label: 'Based in ' + require('./au-safe-text.js').safeText(f.state, 40) });

  // Ahpra: only what staff have actually recorded.
  var noWait = f.ahpra === 'verified' && f.pathway === 'au_vr' && f.pathwayConfirmed
    && f.conditions === 'none' && !f.supervised && !f.registrar;
  if (f.ahpra === 'verified') {
    bits.push('GP Link has verified ' + possessiveMid + ' Ahpra registration on the public register' + (noWait ? ', so there is no registration wait.' : '.'));
    facts.push({ icon: '✅', label: 'Ahpra registration verified' });
  } else if (f.ahpra === 'in_progress') {
    bits.push(possessive + ' Ahpra registration number is on file and verification is in progress.');
    facts.push({ icon: 'ℹ️', label: 'Ahpra verification in progress' });
  }

  // Restrictions. Never softened, never the detail.
  if (f.dpaOnly === 'yes') {
    bits.push('Section 19AB applies to ' + shortNameMid + ' (Distribution Priority Area locations only).');
    facts.push({ icon: 'ℹ️', label: '19AB applies: DPA locations only' });
  } else if (f.dpaOnly === 'unconfirmed') {
    bits.push('We are confirming whether section 19AB (Distribution Priority Area locations only) applies to ' + shortNameMid + '.');
    facts.push({ icon: 'ℹ️', label: '19AB status being confirmed' });
  }
  if (f.registrar) {
    bits.push('As a registrar, ' + shortNameMid + ' works under supervision.');
    facts.push({ icon: 'ℹ️', label: 'Works under supervision' });
  } else if (f.supervised) {
    bits.push(f.supervisedType
      ? shortName + ' holds ' + f.supervisedType + ' registration and works under supervision.'
      : shortName + ' works under supervision.');
    facts.push({ icon: 'ℹ️', label: 'Works under supervision' });
  }
  if (f.conditions === 'reviewed') {
    bits.push(possessive + ' registration has conditions recorded; details are available on request.');
    facts.push({ icon: 'ℹ️', label: 'Registration conditions: details on request' });
  } else if (f.conditions === 'unreviewed') {
    facts.push({ icon: 'ℹ️', label: 'Registration details being confirmed' });
  }
  if (f.employerTiedWorkRights) {
    facts.push({ icon: 'ℹ️', label: 'Right to work tied to an employer: details on request' });
  }

  // Availability, from the doctor's own answers only.
  var a = f.availability || { kind: 'none' };
  var startDateLabel = '';
  if (a.kind === 'date') {
    startDateLabel = auFormatDayDate(a.iso, false);
    if (startDateLabel) {
      bits.push(shortName + ' is available from ' + startDateLabel + '.');
      facts.push({ icon: '\u{1F4C5}', label: 'Available from ' + auFormatDayDate(a.iso, true) });
    }
  } else if (a.kind === 'notice') {
    var wk = a.weeks === 1 ? '1 week’s' : a.weeks + ' weeks’';
    startDateLabel = 'about ' + wk + ' notice';
    bits.push(shortName + ' has about ' + wk + ' notice to give.');
    facts.push({ icon: '\u{1F4C5}', label: 'About ' + wk + ' notice' });
  } else if (a.kind === 'now') {
    startDateLabel = 'available now';
    bits.push(shortName + ' is available to start straight away.');
    facts.push({ icon: '\u{1F4C5}', label: 'Available now' });
  }

  var startLine = a.kind === 'notice'
    ? 'If you both go ahead, the start date is agreed with you around ' + possessiveMid + ' notice period.'
    : 'If you both go ahead, the start date is agreed between you.';

  return {
    audience: 'au',
    paragraph: bits.join(' '),
    facts: facts,
    pathwayLabel: pathwayLabel,
    startDateLabel: startDateLabel,
    // Decision page, "What happens next" (accurate for a GP already here:
    // interview, offer, start after notice).
    nextSteps: [
      'Approve and choose a few interview times that suit your practice.',
      shortName + ' confirms one and you both receive a calendar invitation.',
      'After the interview we ask whether you would like to make an offer.',
      startLine
    ],
    // DRAFT wording, for legal review (the WP-25 consent proposal, line D3;
    // see docs/au-gp/CONVENTIONS.md section 20 for where it is kept).
    // True only because an Australian doctor cannot be submitted without a
    // recorded consent for this role (lib/profile-share-consent.js).
    confidentialityNote: displayName + ' has agreed to be introduced to your practice for this role only. '
      + 'Please keep this confidential: do not contact their current practice or pass on their details. '
      + 'If you do not proceed, please delete their CV.'
  };
}

/**
 * WP-09: the fellowship as a qualification label for staff screens
 * ("FRACGP — General Practice"), same form as the overseas MRCGP / MICGP /
 * FRNZCGP labels. '' when none of the Australian fellowships is on file.
 */
function auFellowshipSpecialtyLabel(fellowshipType) {
  var label = AU_FELLOWSHIP_LABELS[auToken(fellowshipType)];
  return label ? label + ' — General Practice' : '';
}

module.exports = {
  buildCandidateIntro, formatTargetDate, pathwayLabelFor,
  // WP-09 (Australian pathways)
  buildAuCandidateIntro, auIntroFactsFromRecords, auPracticeTextViolations, auSafeRecommendation,
  auFellowshipSpecialtyLabel, AU_PRACTICE_BANNED, AU_STATE_NAMES, AU_FELLOWSHIP_LABELS
};
