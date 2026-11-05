'use strict';

/*
 * AHPRA "registration granted" detection and parsing.
 *
 * When AHPRA approves a doctor's specialist registration the officer emails the
 * doctor (RSO cc'd) with the subject "Ahpra – Final Notice of Registration – <app
 * no>", a PDF "Final notice - Specialist registration with conditions - ...", a DOCX
 * "Schedule of conditions - ..." and a generic appeals fact sheet. About a week
 * earlier a "Notice to propose approval of registration with conditions" arrives
 * (a proposal only, not the grant).
 *
 * Everything in here is pure (no I/O, no clock reads unless `now` is passed) so
 * server.js can wire it into the inbound Gmail pipeline and the tests can pin
 * the exact behaviour. The model-backed PDF read lives in server.js
 * (parseAhpraFinalNotice); parseRegistrationFromText is its regex fallback.
 */

var MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function isoFromParts(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + pad2(m) + '-' + pad2(d);
}

// "2 November 2026", "2nd November 2026", "November 2, 2026", "02/11/2026" (AU day first),
// "2026-11-02" and an ISO timestamp all become "2026-11-02". Anything else -> null.
function parseDateToIso(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoFromParts(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoFromParts(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return isoFromParts(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (m) return isoFromParts(m[3], m[2], m[1]);
  return null;
}

// "2026-11-02" -> "2 November 2026" (anything unparseable is returned as given).
function formatDateLong(iso) {
  var d = parseDateToIso(iso);
  if (!d) return String(iso || '');
  var p = d.split('-');
  return parseInt(p[2], 10) + ' ' + MONTH_NAMES[parseInt(p[1], 10) - 1] + ' ' + p[0];
}

function addDays(iso, days) {
  var d = parseDateToIso(iso);
  if (!d) return null;
  var p = d.split('-');
  var dt = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

// Calendar months; a day that does not exist in the target month clamps to its last day.
function addMonths(iso, months) {
  var d = parseDateToIso(iso);
  if (!d) return null;
  var p = d.split('-');
  var y = Number(p[0]), m = Number(p[1]) - 1 + Number(months || 0), day = Number(p[2]);
  var target = new Date(Date.UTC(y, m, 1));
  var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// The grant is decided on the SUBJECT or an ATTACHMENT NAME. Body wording alone is not
// enough: ordinary officer mail quotes it ("once approved you will receive a final notice of
// registration", a Compliance Team letter citing "your registration number is …", a reply that
// quotes the earlier final notice), and the stage move is irreversible. The body counts only
// together with a letter attached AND the doctor's MED number in the text.
var GRANT_SUBJECT_RE = /final notice of registration|notice of approval (for|of) registration|registration (has been |is )?(approved|granted)/i;
var GRANT_BODY_RE = /final notice of registration|notice of approval (for|of) registration|registration is made effective from|your registration number is/i;
var GRANT_FILE_RE = /final notice.*registration|notice of approval.*registration|registration.*(approved|granted)/i;
var DOC_FILE_RE = /\.(pdf|docx?)$/i;
var PROPOSAL_RE = /propos(e|al|ed) (to )?(approv|grant|registration)/i;
var APP_NUMBER_RE = /APP[-–—]?\s*(\d{10,13})/i;

function extractApplicationNumber(subject, body) {
  var m = String(subject || '').match(APP_NUMBER_RE) || String(body || '').match(APP_NUMBER_RE);
  if (m) return 'APP-' + m[1];
  // Ahpra's own subjects end with the bare application number
  // ("Ahpra – Final Notice of Registration – 14805868").
  var bare = String(subject || '').match(/\bAhpra\b.*[-–—:]\s*(\d{7,9})\s*$/i);
  return bare ? bare[1] : null;
}

// emailMeta: { subject, bodyText|body, attachments:[{filename}] }
// -> { kind: 'granted' | 'proposal' | null, applicationNumber }
//
// A proposal subject ("Notice to propose approval of registration with conditions")
// wins over grant wording in the BODY (the proposal letter says a final notice will
// follow), unless the subject or an attachment itself carries the final notice.
function detectAhpraRegistrationOutcome(emailMeta) {
  var meta = emailMeta || {};
  var subject = String(meta.subject || '');
  var body = String(meta.bodyText || meta.body || '');
  var files = (Array.isArray(meta.attachments) ? meta.attachments : [])
    .map(function (a) { return String((a && (a.filename || a.name)) || ''); });
  var subjectGranted = GRANT_SUBJECT_RE.test(subject);
  var fileGranted = files.some(function (f) { return GRANT_FILE_RE.test(f); });
  var hasDocAttachment = files.some(function (f) { return DOC_FILE_RE.test(f); });
  var bodyGranted = GRANT_BODY_RE.test(body) && hasDocAttachment && /\bMED\s?\d{10}\b/i.test(body);
  var subjectProposal = PROPOSAL_RE.test(subject);
  var applicationNumber = extractApplicationNumber(subject, body);
  var kind = null;
  if (subjectProposal && !subjectGranted && !fileGranted) kind = 'proposal';
  else if (subjectGranted || fileGranted || bodyGranted) kind = 'granted';
  else if (PROPOSAL_RE.test(body)) kind = 'proposal';
  return { kind: kind, applicationNumber: applicationNumber };
}

var DATE_TOKEN = '(\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[\\/.]\\d{1,2}[\\/.]\\d{2,4})';

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\s,;:.]+$/, '').trim();
}

// Field value that runs until the next known label, a line break, or the end.
function fieldAfter(text, label, stopLabels) {
  var stops = (stopLabels || []).concat(['\\n', '\\r']).join('|');
  var re = new RegExp(label + ':?\\s*([^\\n\\r]+?)(?=\\s+(?:' + (stopLabels || []).join('|') + ')\\b|[\\n\\r]|$)', 'i');
  var m = String(text || '').match(re);
  if (!m) return '';
  var v = clean(m[1]);
  // The PDF text can run labels into one line; cut at any other stop label just in case.
  if (stops) {
    var cut = v.search(new RegExp('\\s(?:' + (stopLabels || []).join('|') + ')\\b', 'i'));
    if (cut > 0) v = clean(v.slice(0, cut));
  }
  return v;
}

var SP_LABELS = ['Position', 'Employer', 'Level of supervision', 'Primary Supervisor', 'Commencement', 'Review period', 'Location'];

// Regex fallback over the email body (+ any PDF text the caller could extract).
// Returns the same shape the model path produces, with `source: 'regex'`.
function parseRegistrationFromText(text) {
  var t = String(text || '');
  // The doctor's own number follows "Your registration number is"; any other MED number in the
  // letter belongs to the supervisor ("Primary Supervisor: Dr X MED0001234567"), so a bare match
  // is only accepted when it is not sitting right after a supervisor label.
  var num = t.match(/registration number\s*(?:is|:)?\s*(MED\s?\d{10})\b/i);
  if (!num) {
    var bareRe = /\b(MED\s?\d{10})\b/ig;
    var bm;
    while ((bm = bareRe.exec(t)) !== null) {
      var before = t.slice(Math.max(0, bm.index - 80), bm.index);
      if (!/supervisor/i.test(before)) { num = bm; break; }
    }
  }
  // The "Approved supervised practice arrangement" block is one line of labelled fields in
  // AHPRA's letters; read it as a unit first (last occurrence wins: the final notice repeats it
  // after the reasons) so the loose per-label reader below never grabs prose that happens to
  // mention a supervisor or a position.
  var blockRe = /Position:\s*(.+?)\s+Employer:\s*(.+?)\s+Workplaces?\s*\/?\s*locations?\s*\(?s?\)?\s*:\s*(.+?)\s+Level of supervision:\s*(.+?)\s+Primary Supervisor:\s*(.+?)\s+Commencement:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/ig;
  var block = null, bmatch;
  while ((bmatch = blockRe.exec(t)) !== null) block = bmatch;
  var eff = t.match(new RegExp('(?:made\\s+)?effective\\s+(?:from|on)\\s+' + DATE_TOKEN, 'i'));
  var exp = t.match(new RegExp('(?:remains?|remain)\\s+current\\s+until\\s+' + DATE_TOKEN, 'i'))
    || t.match(new RegExp('(?:expires?|expiry(?: date)?)\\s*(?:on|:)?\\s*' + DATE_TOKEN, 'i'));
  var comm = t.match(new RegExp('Commencement(?: date)?:?\\s*' + DATE_TOKEN, 'i'));
  var review = t.match(/review period of\s+(\d{1,2})\s+months?/i);
  var appeal = t.match(/within\s+(\d{1,3})\s+days?\s+(?:of|after)\s+(?:receiving|receipt of|the date of)\s+(?:this|the)\s+(?:notice|decision|letter)/i);
  var type = t.match(/\b(specialist|general|limited|provisional|non-practising)\s+registration\b/i);
  var stopFor = function (own) { return SP_LABELS.filter(function (l) { return l !== own; }); };
  var supervisor = clean(block ? block[5] : fieldAfter(t, 'Primary Supervisor', stopFor('Primary Supervisor'))).replace(/\s*MED\s?\d{10}\s*$/i, '');
  var level = block ? clean(block[4]) : fieldAfter(t, 'Level of supervision', stopFor('Level of supervision'));
  var employer = block ? clean(block[2]) : fieldAfter(t, 'Employer', stopFor('Employer'));
  var position = block ? clean(block[1]) : fieldAfter(t, 'Position', stopFor('Position'));
  if (block && !comm) comm = [null, block[6]];
  var location = '';
  // "Employer: The Doctors Werribee, Werribee VIC" -> keep the place after the last comma as location.
  if (employer && /,\s*[^,]+\b(VIC|NSW|QLD|WA|SA|TAS|NT|ACT)\b/i.test(employer)) {
    var parts = employer.split(',');
    location = clean(parts.pop());
    employer = clean(parts.join(','));
  }
  var hasConditions = /with\s+conditions|schedule of conditions|conditions? (?:imposed|apply|attached)/i.test(t);
  return {
    registration_number: num ? num[1].replace(/\s+/g, '').toUpperCase() : null,
    registration_type: type ? (type[1].charAt(0).toUpperCase() + type[1].slice(1).toLowerCase() + ' registration') : null,
    effective_date: eff ? parseDateToIso(eff[1]) : null,
    expiry_date: exp ? parseDateToIso(exp[1]) : null,
    has_conditions: hasConditions,
    review_period_months: review ? parseInt(review[1], 10) : null,
    conditions_summary: '',
    condition_items: [],
    supervised_practice: {
      position: position || null,
      employer: employer || null,
      location: location || null,
      level: level || null,
      supervisor: supervisor || null,
      commencement_date: comm ? parseDateToIso(comm[1]) : null
    },
    appeal_deadline_days: appeal ? parseInt(appeal[1], 10) : null,
    source: 'regex'
  };
}

// Validate whatever a parser (model or regex) produced into the shape the flow stores.
// A number that is not MED + 10 digits becomes null; dates must parse; strings are trimmed.
function normalizeRegistration(parsed) {
  var p = parsed && typeof parsed === 'object' ? parsed : {};
  var sp = p.supervised_practice && typeof p.supervised_practice === 'object' ? p.supervised_practice : {};
  var num = String(p.registration_number || '').replace(/\s+/g, '').toUpperCase();
  var items = Array.isArray(p.condition_items) ? p.condition_items.map(function (x) { return clean(typeof x === 'string' ? x : (x && (x.text || x.title || x.label)) || ''); }).filter(Boolean) : [];
  var months = p.review_period_months == null ? null : parseInt(p.review_period_months, 10);
  var appeal = p.appeal_deadline_days == null ? null : parseInt(p.appeal_deadline_days, 10);
  return {
    registration_number: /^MED\d{10}$/.test(num) ? num : null,
    registration_type: clean(p.registration_type) || null,
    effective_date: parseDateToIso(p.effective_date),
    expiry_date: parseDateToIso(p.expiry_date),
    has_conditions: p.has_conditions === true || p.has_conditions === 'true' ? true : (p.has_conditions === false || p.has_conditions === 'false' ? false : (items.length > 0 ? true : null)),
    review_period_months: Number.isFinite(months) ? months : null,
    conditions_summary: clean(p.conditions_summary) || '',
    condition_items: items,
    supervised_practice: {
      position: clean(sp.position) || null,
      employer: clean(sp.employer) || null,
      location: clean(sp.location) || null,
      level: clean(sp.level) || null,
      supervisor: clean(sp.supervisor) || null,
      commencement_date: parseDateToIso(sp.commencement_date)
    },
    appeal_deadline_days: Number.isFinite(appeal) ? appeal : null,
    source: p.source || 'model'
  };
}

// The follow-up work AHPRA's conditions create, as due dates. Only items whose
// anchor date is known are returned. `now` (ISO date) anchors the two early items
// when the effective date is unknown.
function buildConditionsTrackerDueDates(opts) {
  var o = opts || {};
  var effective = parseDateToIso(o.effectiveDate);
  var expiry = parseDateToIso(o.expiryDate);
  var commencement = parseDateToIso(o.commencementDate);
  var base = effective || parseDateToIso(o.now) || null;
  var out = [];
  if (base) {
    out.push({ key: 'acknowledge_conditions', title: 'GP to acknowledge AHPRA conditions to the Compliance Team', due: addDays(base, 30), status: 'waiting', priority: 'normal' });
    out.push({ key: 'compliance_letter', title: 'Watch for the AHPRA Compliance Team letter and file it', due: addDays(base, 14), status: 'open', priority: 'normal' });
  }
  if (commencement) {
    out.push({ key: 'practice_location_form', title: 'Practice location form to Ahpra within 14 days of starting', due: addDays(commencement, 14), status: 'waiting', priority: 'normal' });
    out.push({ key: 'supervision_report_3m', title: '3-month supervision report', due: addMonths(commencement, 3), status: 'waiting', priority: 'normal' });
    out.push({ key: 'msf_5m', title: 'Multi-source feedback (CFEP) within 5 months', due: addMonths(commencement, 5), status: 'waiting', priority: 'normal' });
    out.push({ key: 'workplace_assessment_6m', title: 'Workplace assessment (Mini-CEX, DOPS or CBD) within 6 months', due: addMonths(commencement, 6), status: 'waiting', priority: 'normal' });
    out.push({ key: 'orientation_6m', title: 'Orientation and cultural safety education within 6 months', due: addMonths(commencement, 6), status: 'waiting', priority: 'normal' });
    out.push({ key: 'supervision_report_6m', title: 'Final 6-month supervision report', due: addMonths(commencement, 6), status: 'waiting', priority: 'normal' });
  }
  if (expiry) {
    out.push({ key: 'renewal', title: 'AHPRA registration renewal before expiry', due: addDays(expiry, -30), status: 'waiting', priority: 'normal' });
  }
  return out;
}

// Which My Documents slot an AHPRA attachment files into. Generic fact sheets are skipped (null).
var AHPRA_DELIVERED_DOCS = {
  ahpra_registration_notice: 'AHPRA final notice of registration',
  ahpra_conditions_schedule: 'AHPRA schedule of conditions',
  ahpra_registration_certificate: 'AHPRA registration certificate',
  ahpra_proposal_notice: 'AHPRA notice proposing registration'
};
var AHPRA_DOC_KEYS = Object.keys(AHPRA_DELIVERED_DOCS);
var AHPRA_DRIVE_FOLDER = 'AHPRA registration';

function docKeyForAhpraAttachment(filename) {
  var f = String(filename || '');
  if (!f) return null;
  if (/fact.?sheet|appeals?\b/i.test(f)) return null;
  if (/final notice|notice of (approval|registration)/i.test(f)) return 'ahpra_registration_notice';
  if (/schedule of conditions/i.test(f)) return 'ahpra_conditions_schedule';
  if (/certificate/i.test(f)) return 'ahpra_registration_certificate';
  if (/propos/i.test(f)) return 'ahpra_proposal_notice';
  return null;
}

// Who is moving (onboarding option values) -> dependants to create.
//   just_me / me -> none; me_partner -> spouse; me_children -> children; me_partner_children -> both.
function dependantsFromHousehold(whoMoving, childrenCount) {
  var key = String(whoMoving || '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  var partner = key === 'me_partner' || key === 'me_partner_children' || key === 'family' || /partner|spouse|wife|husband/.test(key);
  var children = key === 'me_children' || key === 'me_partner_children' || key === 'family' || /child|kid/.test(key);
  var n = parseInt(childrenCount, 10);
  if (!Number.isFinite(n) || n < 0) n = children ? 1 : 0;
  if (!children) n = 0;
  if (children && n === 0) n = 1;
  var out = [];
  if (partner) out.push({ relationship: 'spouse', full_name: 'Partner (name to be confirmed)', label: "Partner's passport" });
  for (var i = 1; i <= Math.min(n, 10); i++) out.push({ relationship: 'child', full_name: 'Child ' + i, label: 'Child ' + i + ' passport' });
  return out;
}


// ── Basic PDF text extraction (no dependency) ──────────────────────────────
// AHPRA's letters are Word-generated PDFs whose page text sits in FlateDecode
// content streams as (literal) or <hex> strings inside Tj / TJ operators. This
// inflates every stream and pulls those strings out in order, which is enough
// for the regex reader to find "MED0001234567", "effective from …", "remain
// current until …" and "Commencement: …" when the model read is unavailable.
// It is NOT a general PDF parser: fonts with custom encodings come out garbled,
// which is why the model read stays primary. Never throws; returns '' on any
// failure.
function extractPdfTextBasic(buffer) {
  try {
    var zlib = require('zlib');
    if (!buffer || !buffer.length) return '';
    var latin = buffer.toString('latin1');
    var out = [];
    var re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    var m;
    while ((m = re.exec(latin)) !== null) {
      var raw = Buffer.from(m[1], 'latin1');
      var dec = null;
      try { dec = zlib.inflateSync(raw); } catch (e) {
        try { dec = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e2) { dec = null; }
      }
      if (!dec) continue;
      var txt = dec.toString('latin1');
      if (txt.indexOf('Tj') < 0 && txt.indexOf('TJ') < 0) continue;
      var parts = [];
      var opRe = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;
      var t;
      while ((t = opRe.exec(txt)) !== null) {
        if (t[1] != null) {
          var seg = '';
          var inner = t[1];
          var sRe = /\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+\.?\d*)/g;
          var u;
          while ((u = sRe.exec(inner)) !== null) {
            if (u[1] != null) seg += unescapePdfString(u[1]);
            else if (u[2] != null) seg += hexPdfString(u[2]);
            else if (u[3] != null && parseFloat(u[3]) < -200) seg += ' ';
          }
          parts.push(seg);
        } else if (t[2] != null) {
          parts.push(unescapePdfString(t[2]));
        } else if (t[3] != null) {
          parts.push(hexPdfString(t[3]));
        }
      }
      if (parts.length) out.push(parts.join(' '));
    }
    return out.join('\n').replace(/[ \t]+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}
function unescapePdfString(s) {
  return String(s || '')
    .replace(/\\([nrtbf()\\])/g, function (_, c) { return c === 'n' ? '\n' : c === 'r' ? '' : c === 't' ? ' ' : (c === 'b' || c === 'f') ? '' : c; })
    .replace(/\\(\d{3})/g, function (_, oct) { var code = parseInt(oct, 8); return code === 0x92 ? "'" : code === 0x96 ? '-' : String.fromCharCode(code); });
}
function hexPdfString(h) {
  var hex = String(h || '').replace(/\s+/g, '');
  var s = '';
  // Two-byte (UTF-16BE / CID) strings are common in Word PDFs; detect by even length and
  // leading 00 bytes, else read single bytes.
  var twoByte = hex.length % 4 === 0 && /^(00[0-9A-Fa-f]{2})+$/.test(hex);
  for (var i = 0; i < hex.length; i += (twoByte ? 4 : 2)) {
    var code = parseInt(hex.substr(i, twoByte ? 4 : 2), 16);
    if (!isNaN(code) && code >= 32) s += String.fromCharCode(code);
  }
  return s;
}

module.exports = {
  extractPdfTextBasic: extractPdfTextBasic,
  detectAhpraRegistrationOutcome: detectAhpraRegistrationOutcome,
  extractApplicationNumber: extractApplicationNumber,
  parseRegistrationFromText: parseRegistrationFromText,
  normalizeRegistration: normalizeRegistration,
  buildConditionsTrackerDueDates: buildConditionsTrackerDueDates,
  parseDateToIso: parseDateToIso,
  formatDateLong: formatDateLong,
  addDays: addDays,
  addMonths: addMonths,
  docKeyForAhpraAttachment: docKeyForAhpraAttachment,
  dependantsFromHousehold: dependantsFromHousehold,
  AHPRA_DELIVERED_DOCS: AHPRA_DELIVERED_DOCS,
  AHPRA_DOC_KEYS: AHPRA_DOC_KEYS,
  AHPRA_DRIVE_FOLDER: AHPRA_DRIVE_FOLDER
};
