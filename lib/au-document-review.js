// Automatic review rules for an Australian GP's documents.
//
// Australian GP build, WP-07 (finding COM-17).
//
// The existing automatic review (verifyQualificationDocument in server.js) only
// knows the documents a doctor moving from the UK, Ireland or New Zealand
// uploads, and applies the "dated August 2007 or later" family of rules. Shown
// an Australian indemnity certificate it would call it the wrong document and
// reject it. So Australian documents get their OWN rules, in this file, and the
// two never cross:
//
//   - a row stored under country_code 'au_reg' with a key from this table is
//     judged by these rules and only these rules;
//   - every other row is judged by the existing rules, byte-for-byte unchanged;
//   - nothing in here mentions a qualification date cut-off, a certified copy,
//     or a country of training.
//
// What decides the outcome is still lib/doc-ai-review.js (approve only when
// positively verified; reject only an unreadable file or a clearly different
// document; everything else goes to a person). This file supplies what each
// Australian document should show, the prompt, and the checks the server makes
// itself rather than trusting the model: is the name the doctor's, is the
// period of cover or the registration still current, does the Ahpra number
// match the one on file.
//
// Pure: no I/O. The model call lives in server.js (verifyAuDocument).

'use strict';

// key -> rule.
//   documentType  what the model is told to expect
//   shows         what a genuine one shows (goes into the prompt)
//   fields        the extra JSON fields the model is asked for
//   expiryField   which field carries the date the document runs to
//   mustBeCurrent true: an expiry date in the past means "not verified"
//   nameRequired  true: the doctor's name must be on it
//   synonyms      words that mean "this is that kind of document" (so a
//                 differently worded but correct file is never auto-rejected
//                 as the wrong document)
const AU_REVIEW_RULES = {
  au_indemnity_certificate: {
    documentType: 'Medical indemnity certificate of currency',
    shows: [
      'the name of a medical indemnity insurer (for example Avant, MDA National, MIPS, MIGA, Tego)',
      'the name of the insured doctor',
      'the period of cover, with a start date and an end date',
      'the category or field of practice covered (general practice, or a category that includes it)'
    ],
    fields: ['insurer', 'insuredName', 'coverStart', 'coverEnd', 'category'],
    expiryField: 'coverEnd',
    mustBeCurrent: true,
    nameRequired: true,
    synonyms: ['indemnity', 'currency', 'insurance', 'insurer', 'insured', 'cover', 'policy', 'avant', 'mda', 'mips', 'miga', 'tego']
  },
  au_ahpra_certificate: {
    documentType: 'Ahpra certificate of registration or public register extract (medical practitioner)',
    shows: [
      'the practitioner\'s name',
      'an Ahpra registration number (MED followed by ten digits)',
      'the profession (medical practitioner) and the registration type (general, specialist, provisional, limited or non-practising)',
      'the registration expiry date',
      'any conditions, undertakings or notations on the registration'
    ],
    fields: ['registrationNumber', 'registrationType', 'expiryDate', 'hasConditions'],
    expiryField: 'expiryDate',
    mustBeCurrent: true,
    nameRequired: true,
    synonyms: ['ahpra', 'registration', 'register', 'registered', 'practitioner', 'medical board', 'board australia']
  },
  au_fellowship_certificate: {
    documentType: 'FRACGP or FACRRM fellowship certificate, or a college letter confirming fellowship',
    shows: [
      'the awarding college: the Royal Australian College of General Practitioners (FRACGP) or the Australian College of Rural and Remote Medicine (FACRRM)',
      'the doctor\'s name',
      'the year or date the fellowship was awarded'
    ],
    fields: ['fellowship', 'awardingBody', 'yearAwarded'],
    expiryField: '',
    mustBeCurrent: false,
    nameRequired: true,
    synonyms: ['fracgp', 'facrrm', 'fellowship', 'fellow', 'racgp', 'acrrm', 'royal australian college', 'college general practitioners', 'rural remote medicine']
  },
  au_wwcc: {
    documentType: 'Working with Children Check (card, clearance letter or application receipt)',
    shows: [
      'the issuing Australian state or territory (for example NSW, Victoria, a Queensland Blue Card, a Northern Territory Ochre Card)',
      'the holder\'s name',
      'the check or card number',
      'the expiry date'
    ],
    fields: ['state', 'checkNumber', 'expiryDate', 'isApplicationReceiptOnly'],
    expiryField: 'expiryDate',
    mustBeCurrent: true,
    nameRequired: true,
    synonyms: ['working children', 'wwcc', 'wwc', 'blue card', 'ochre card', 'children check', 'vulnerable people', 'clearance', 'child']
  },
  au_immunisation_record: {
    documentType: 'Immunisation record (immunisation history statement, vaccination record or serology results)',
    shows: [
      'the person\'s name',
      'a list of vaccinations or serology results with dates'
    ],
    fields: [],
    expiryField: '',
    mustBeCurrent: false,
    nameRequired: true,
    synonyms: ['immunisation', 'immunization', 'vaccination', 'vaccine', 'serology', 'history statement', 'air', 'immunity']
  },
  au_right_to_work: {
    documentType: 'Evidence of the right to work in Australia (passport photo page, citizenship certificate, permanent residency evidence or a VEVO check)',
    shows: [
      'the person\'s name',
      'for a passport: the issuing country and the expiry date',
      'for a VEVO check or grant letter: the work entitlement and any work conditions'
    ],
    fields: ['evidenceType', 'expiryDate', 'workConditions'],
    // A passport that has run out is still proof of citizenship, and a VEVO
    // check has no expiry of its own, so the date is recorded but not enforced.
    expiryField: '',
    mustBeCurrent: false,
    nameRequired: true,
    synonyms: ['passport', 'citizenship', 'citizen', 'vevo', 'permanent', 'resident', 'residency', 'entitlement', 'home affairs', 'grant', 'birth']
  },
  au_provider_number_letter: {
    documentType: 'Medicare provider number or prescriber number letter or screenshot (Services Australia / HPOS)',
    shows: [
      'the doctor\'s name',
      'a Medicare provider number and, where shown, the practice location it is for',
      'a prescriber number, where shown'
    ],
    fields: ['providerNumber', 'prescriberNumber'],
    expiryField: '',
    mustBeCurrent: false,
    nameRequired: true,
    synonyms: ['provider', 'prescriber', 'medicare', 'services australia', 'hpos', 'pbs']
  }
};

const AU_REVIEWABLE_KEYS = Object.keys(AU_REVIEW_RULES);

function isAuReviewableKey(key) {
  return Object.prototype.hasOwnProperty.call(AU_REVIEW_RULES, String(key || ''));
}
function auReviewRule(key) {
  return isAuReviewableKey(key) ? AU_REVIEW_RULES[String(key)] : null;
}

// Which rule book a stored document row is judged by. The single routing rule.
//   'au'        an Australian document: these rules
//   'overseas'  the existing qualification rules
//   'none'      not something the automatic review decides
// `isQualificationKey` is server.js's isQualificationDocKey, passed in so this
// file stays free of the overseas key lists.
function reviewRulesFor(row, isQualificationKey) {
  const key = String((row && row.document_key) || '');
  const cc = String((row && row.country_code) || '');
  if (cc === 'au_reg') return isAuReviewableKey(key) ? 'au' : 'none';
  if (isAuReviewableKey(key)) return 'none'; // an au_* key filed under another code: never guess
  if (typeof isQualificationKey === 'function' && isQualificationKey(key)) return 'overseas';
  return 'none';
}

const JSON_FIELD_HINTS = {
  insurer: '"insurer":"insurer name or null"',
  insuredName: '"insuredName":"name of the insured or null"',
  coverStart: '"coverStart":"YYYY-MM-DD or null"',
  coverEnd: '"coverEnd":"YYYY-MM-DD or null"',
  category: '"category":"category of practice covered or null"',
  registrationNumber: '"registrationNumber":"MED0000000000 or null"',
  registrationType: '"registrationType":"general|specialist|general and specialist|provisional|limited|non-practising or null"',
  expiryDate: '"expiryDate":"YYYY-MM-DD or null"',
  hasConditions: '"hasConditions":true/false/null',
  fellowship: '"fellowship":"FRACGP|FACRRM|other or null"',
  awardingBody: '"awardingBody":"college name or null"',
  yearAwarded: '"yearAwarded":"YYYY or null"',
  state: '"state":"NSW|VIC|QLD|WA|SA|TAS|ACT|NT or null"',
  checkNumber: '"checkNumber":"check or card number or null"',
  isApplicationReceiptOnly: '"isApplicationReceiptOnly":true/false',
  evidenceType: '"evidenceType":"passport|citizenship certificate|permanent residency|vevo|other"',
  workConditions: '"workConditions":"work conditions shown, or null"',
  providerNumber: '"providerNumber":"provider number or null"',
  prescriberNumber: '"prescriberNumber":"prescriber number or null"'
};

/**
 * The prompt for one Australian document. Returns null for a key with no rule.
 * No personal detail goes into the system prompt (it is cached); the doctor's
 * name is NOT sent at all: the model reads the name, the server compares it.
 */
function buildAuReviewPrompt(key, ctx) {
  const rule = auReviewRule(key);
  if (!rule) return null;
  const today = String((ctx && ctx.today) || new Date().toISOString().slice(0, 10));
  const extra = rule.fields.map(function (f) { return JSON_FIELD_HINTS[f]; }).filter(Boolean);
  const system = [
    'You are an automated document reader for a licensed GP recruitment platform in Australia. The doctor already holds registration with Ahpra and works in Australia. They have given full consent to upload their documents. This is a routine, authorised check.',
    '',
    'You are told which document is expected. Decide whether the file is that document and read the details listed.',
    '',
    'RULES:',
    '1. Is this the expected kind of document? Judge by what it is, not by its exact title.',
    '2. Read the full name of the person it is about.',
    '3. Read the dates asked for, exactly as shown. Do not guess a date that is not on the page.',
    '4. Is it legible?',
    '',
    'IMPORTANT:',
    '- Do NOT apply any rule about when or where a qualification was obtained. There is no minimum date.',
    '- Do NOT require a certified copy, a signature or a stamp. A download, a screenshot or a phone photo is acceptable.',
    '- Do NOT mention security, privacy or the risks of sharing documents.',
    '- If verified is false, "issues" MUST hold a short, plain reason the doctor can act on.',
    '',
    'Return ONLY valid JSON with no markdown:',
    '{"verified":true/false,"documentType":"what you identified","nameFound":"full name on the document or null","legible":true/false'
      + (extra.length ? ',' + extra.join(',') : '') + ',"issues":["short reasons, if any"]}'
  ].join('\n');
  const user = [
    'Expected document: ' + rule.documentType,
    'A genuine one shows:',
    rule.shows.map(function (s) { return '- ' + s; }).join('\n'),
    'Today is ' + today + '.',
    '',
    'Check this document.'
  ].join('\n');
  return { system, user };
}

// 'YYYY-MM-DD' (or an ISO timestamp, or a plain 'DD/MM/YYYY') -> ISO string, or ''.
function parseAuDate(value) {
  let raw = String(value == null ? '' : value).trim();
  if (!raw || /^null$/i.test(raw)) return '';
  const dmy = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (dmy) raw = dmy[3] + '-' + ('0' + dmy[2]).slice(-2) + '-' + ('0' + dmy[1]).slice(-2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T00:00:00.000Z';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  if (y < 2000 || y > new Date().getUTCFullYear() + 30) return '';
  return d.toISOString();
}

function normaliseAhpraNumber(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pushIssue(list, text) {
  if (text && list.indexOf(text) === -1) list.push(text);
}

/**
 * Turn the model's reading into the scan object lib/doc-ai-review.js decides
 * on, applying the checks the server makes itself.
 *
 * @param key           the Australian document key
 * @param verification  the model's JSON, AFTER the server's name-match policy
 *                      has set verification.nameMatch ('match' | 'mismatch' | ...)
 * @param ctx.now               Date / ms / ISO (defaults to now)
 * @param ctx.expectedLabel     the label shown to the doctor
 * @param ctx.ahpraNumberOnFile the number in gp_credentials, if any
 * @returns { scan, expiresAt, issues, extracted }
 *   expiresAt  ISO date to store on the row for an expiry-tracked document
 */
function interpretAuReview(key, verification, ctx) {
  const rule = auReviewRule(key);
  const c = ctx || {};
  const label = String(c.expectedLabel || (rule && rule.documentType) || 'document');
  if (!rule || !verification || typeof verification !== 'object') {
    return { scan: { technicalError: true, expectedLabel: label }, expiresAt: '', issues: [], extracted: {} };
  }
  const now = c.now != null ? new Date(c.now) : new Date();
  const issues = Array.isArray(verification.issues) ? verification.issues.filter(Boolean).map(String) : [];
  let verified = verification.verified === true;
  const legible = verification.legible !== false;

  const extracted = {};
  rule.fields.forEach(function (f) {
    if (verification[f] != null && verification[f] !== '') extracted[f] = verification[f];
  });

  // 1. The name. The server's name matcher (the same one that guards every
  //    other upload against a document filed under the wrong doctor) has
  //    already run. A mismatch is never approved by the machine; and a
  //    document that should carry a name but shows none is not verified.
  const nm = verification.nameMatch;
  if (rule.nameRequired && verified && !String(verification.nameFound || '').trim()) {
    verified = false;
    pushIssue(issues, 'We could not read a name on this document.');
  }

  // 2. Still current?
  let expiresAt = '';
  if (rule.expiryField) {
    expiresAt = parseAuDate(verification[rule.expiryField]);
    if (rule.mustBeCurrent) {
      if (expiresAt && new Date(expiresAt).getTime() < now.getTime()) {
        verified = false;
        pushIssue(issues, 'This ' + label + ' looks out of date (it ran to ' + expiresAt.slice(0, 10) + '). Please upload the current one.');
      } else if (!expiresAt && verified) {
        // No readable end date on a document that must be current: a person decides.
        verified = false;
        pushIssue(issues, 'We could not read the end date on this ' + label + '.');
      }
    }
  }

  // 3. An application receipt is not the check itself.
  if (key === 'au_wwcc' && verification.isApplicationReceiptOnly === true && verified) {
    verified = false;
    pushIssue(issues, 'This looks like an application receipt, not the check itself. We will follow up with you.');
  }

  // 4. The Ahpra number must be the one on file (when we hold one).
  if (key === 'au_ahpra_certificate') {
    const onFile = normaliseAhpraNumber(c.ahpraNumberOnFile);
    const found = normaliseAhpraNumber(verification.registrationNumber);
    if (onFile && found && onFile !== found) {
      verified = false;
      pushIssue(issues, 'The registration number on this document does not match the one on your profile.');
    } else if (onFile && !found && verified) {
      verified = false;
      pushIssue(issues, 'We could not read a registration number on this document.');
    }
  }

  return {
    scan: {
      verified: verified,
      legible: legible,
      nameMatch: nm,
      nameChange: false,
      requiresCertification: false,
      certified: null,
      documentType: String(verification.documentType || ''),
      expectedLabel: label,
      expectedSynonyms: rule.synonyms.slice(),
      technicalError: false
    },
    expiresAt: expiresAt,
    issues: issues,
    extracted: extracted
  };
}

module.exports = {
  AU_REVIEW_RULES,
  AU_REVIEWABLE_KEYS,
  isAuReviewableKey,
  auReviewRule,
  reviewRulesFor,
  buildAuReviewPrompt,
  interpretAuReview,
  parseAuDate,
  normaliseAhpraNumber
};
