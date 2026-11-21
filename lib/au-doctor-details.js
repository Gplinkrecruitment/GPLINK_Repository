'use strict';
/**
 * WP-12 (Australian GP build): what a doctor on an Australian pathway records
 * about themselves on the pre-start page and in Account that has no other
 * home. Pure, no I/O, no switch read. server.js reads and writes the
 * `au_gp_doctor_details` row (one per doctor) with what these cleaners let
 * through, and nothing else.
 *
 *   referees                    exactly two people the doctor has ASKED
 *   notice given                "I have given notice" and the date
 *   existing provider numbers   the Medicare provider numbers the doctor
 *                               already holds (other locations)
 *   prescriber number           the doctor's existing prescriber number
 *
 * None of this is a staff decision: staff read it, take the references, and
 * record the outcome on their own task. A doctor can never write a staff
 * field through here because there is none in this table.
 */

const { normaliseProviderNumber, cleanDay } = require('./au-prestart.js');

const TABLE = 'au_gp_doctor_details';
const REFEREE_COUNT = 2;
const MAX_EXISTING_PROVIDER_NUMBERS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function cleanLine(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

function cleanEmail(value) {
  const s = cleanLine(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : '';
}

// Digits with an optional leading +; 8 to 15 digits. Spaces, dashes and
// brackets are dropped. '' when it is not a phone number.
function cleanPhone(value) {
  const raw = cleanLine(value, 40);
  if (!raw) return '';
  const plus = raw.charAt(0) === '+';
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return (plus ? '+' : '') + digits;
}

/**
 * Two referees. Every one needs a name, their role, how the doctor knows
 * them, a phone number or an email, an explicit "they have agreed to be
 * contacted" tick, and an explicit yes / no to "are they at your current
 * practice?" (staff must never ring the current practice by accident).
 *
 * @returns {{ ok: boolean, errors: Object<string,string>, referees: Array<object> }}
 */
function sanitiseReferees(input) {
  const errors = {};
  const list = Array.isArray(input) ? input : (input && Array.isArray(input.referees) ? input.referees : null);
  if (!list || list.length !== REFEREE_COUNT) {
    return { ok: false, errors: { referees: 'Please give two referees.' }, referees: [] };
  }
  const referees = list.map(function (raw, i) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const n = i + 1;
    const out = {
      name: cleanLine(r.name, 120),
      role: cleanLine(r.role, 120),
      relationship: cleanLine(r.relationship, 160),
      phone: cleanPhone(r.phone),
      email: cleanEmail(r.email),
      agreed_to_contact: r.agreedToContact === true || r.agreed_to_contact === true,
      at_current_practice: null
    };
    const at = r.atCurrentPractice !== undefined ? r.atCurrentPractice : r.at_current_practice;
    if (at === true || at === 'yes') out.at_current_practice = true;
    else if (at === false || at === 'no') out.at_current_practice = false;
    if (out.name.length < 2) errors['referee' + n + '_name'] = 'Please give referee ' + n + '\'s name.';
    if (!out.role) errors['referee' + n + '_role'] = 'Please give referee ' + n + '\'s role (for example practice principal).';
    if (!out.relationship) errors['referee' + n + '_relationship'] = 'Please say how you know referee ' + n + '.';
    const typedPhone = cleanLine(r.phone, 40);
    const typedEmail = cleanLine(r.email, 254);
    if (typedPhone && !out.phone) errors['referee' + n + '_phone'] = 'That phone number for referee ' + n + ' does not look right.';
    if (typedEmail && !out.email) errors['referee' + n + '_email'] = 'That email address for referee ' + n + ' does not look right.';
    if (!out.phone && !out.email && !typedPhone && !typedEmail) errors['referee' + n + '_contact'] = 'Please give a phone number or an email address for referee ' + n + '.';
    if (!out.agreed_to_contact) errors['referee' + n + '_agreed'] = 'Please confirm referee ' + n + ' has agreed to be contacted.';
    if (out.at_current_practice === null) errors['referee' + n + '_current'] = 'Please tell us whether referee ' + n + ' is at your current practice.';
    return out;
  });
  if (!Object.keys(errors).length
      && referees[0].name.toLowerCase() === referees[1].name.toLowerCase()
      && (referees[0].email || referees[0].phone) === (referees[1].email || referees[1].phone)) {
    errors.referees = 'Please give two different referees.';
  }
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, referees: ok ? referees : [] };
}

/**
 * "I have given notice", and the date. The date may be today or earlier (up
 * to two years back); a date in the future is not "given".
 * @returns {{ ok: boolean, errors: Object<string,string>, notice: { given: boolean, date: string } | null }}
 */
function sanitiseNotice(input, opts) {
  const i = input && typeof input === 'object' ? input : {};
  const nowMs = opts && opts.now ? new Date(opts.now).getTime() : Date.now();
  if (i.given !== true) return { ok: false, errors: { given: 'Please tick the box once you have given notice.' }, notice: null };
  const date = cleanDay(i.date);
  if (!date) return { ok: false, errors: { date: 'Please give the date you gave notice.' }, notice: null };
  const t = Date.parse(date + 'T00:00:00Z');
  // One day of slack: the doctor's "today" can be the server's tomorrow.
  if (t > nowMs + DAY_MS) return { ok: false, errors: { date: 'That date is in the future. Record it once you have given notice.' }, notice: null };
  if (t < nowMs - 730 * DAY_MS) return { ok: false, errors: { date: 'That date looks too long ago. Please check it.' }, notice: null };
  return { ok: true, errors: {}, notice: { given: true, date } };
}

// A prescriber number: digits only once spaces and dashes are dropped. The
// exact format is not confirmed, so the check is loose (5 to 10 digits).
function normalisePrescriberNumber(value) {
  const s = String(value == null ? '' : value).replace(/[\s-]+/g, '');
  return /^\d{5,10}$/.test(s) ? s : '';
}

/**
 * The numbers the doctor already holds. Each provider number may carry the
 * location it is for. An empty list and an empty prescriber number are both
 * allowed (they clear what was there).
 * @returns {{ ok: boolean, errors: Object<string,string>, existingProviderNumbers: Array<{number:string,location:string}>, prescriberNumber: string }}
 */
function sanitiseExistingNumbers(input) {
  const i = input && typeof input === 'object' ? input : {};
  const errors = {};
  const rawList = Array.isArray(i.existingProviderNumbers) ? i.existingProviderNumbers : [];
  const out = [];
  const seen = {};
  rawList.forEach(function (raw, idx) {
    const r = raw && typeof raw === 'object' ? raw : { number: raw };
    const typed = cleanLine(r.number, 40);
    if (!typed) return;
    const number = normaliseProviderNumber(typed);
    if (!number) { errors['provider_' + idx] = 'That does not look like a Medicare provider number. It is usually six digits followed by two characters, for example 123456AB.'; return; }
    if (seen[number]) return;
    seen[number] = true;
    out.push({ number, location: cleanLine(r.location, 160) });
  });
  if (out.length > MAX_EXISTING_PROVIDER_NUMBERS) errors.existingProviderNumbers = 'Please list up to ' + MAX_EXISTING_PROVIDER_NUMBERS + ' provider numbers.';
  const typedPrescriber = cleanLine(i.prescriberNumber, 40);
  const prescriberNumber = typedPrescriber ? normalisePrescriberNumber(typedPrescriber) : '';
  if (typedPrescriber && !prescriberNumber) errors.prescriberNumber = 'That does not look like a prescriber number. It is digits only.';
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, existingProviderNumbers: ok ? out : [], prescriberNumber: ok ? prescriberNumber : '' };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) { try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
  return [];
}

/**
 * What the doctor's own browser may be shown of their row (it is all theirs).
 * `placementKey`: the notice only counts for the placement it was recorded for.
 */
function doctorView(row, opts) {
  const r = row && typeof row === 'object' ? row : {};
  const placementKey = opts && opts.placementKey ? String(opts.placementKey) : '';
  const noticeForThis = r.notice_given === true
    && (!placementKey || !r.notice_placement_key || String(r.notice_placement_key) === placementKey);
  return {
    referees: asArray(r.referees).slice(0, REFEREE_COUNT).map(function (x) {
      const f = x && typeof x === 'object' ? x : {};
      return {
        name: cleanLine(f.name, 120), role: cleanLine(f.role, 120), relationship: cleanLine(f.relationship, 160),
        phone: cleanLine(f.phone, 40), email: cleanLine(f.email, 254),
        agreedToContact: f.agreed_to_contact === true,
        atCurrentPractice: f.at_current_practice === true ? true : (f.at_current_practice === false ? false : null)
      };
    }),
    refereesSubmittedAt: r.referees_submitted_at || null,
    noticeGiven: noticeForThis,
    noticeGivenDate: noticeForThis ? (cleanDay(r.notice_given_date) || null) : null,
    existingProviderNumbers: asArray(r.existing_provider_numbers).map(function (x) {
      const f = x && typeof x === 'object' ? x : {};
      return { number: cleanLine(f.number, 20), location: cleanLine(f.location, 160) };
    }).filter(function (x) { return !!x.number; }),
    prescriberNumber: cleanLine(r.prescriber_number, 20)
  };
}

/** The same row for staff: adds nothing the doctor did not write. */
function staffView(row) {
  const v = doctorView(row);
  const r = row && typeof row === 'object' ? row : {};
  v.noticeGiven = r.notice_given === true;
  v.noticeGivenDate = r.notice_given === true ? (cleanDay(r.notice_given_date) || null) : null;
  v.noticePlacementKey = r.notice_placement_key || null;
  v.noticeRecordedAt = r.notice_recorded_at || null;
  return v;
}

module.exports = {
  TABLE, REFEREE_COUNT, MAX_EXISTING_PROVIDER_NUMBERS,
  sanitiseReferees, sanitiseNotice, sanitiseExistingNumbers,
  normalisePrescriberNumber, cleanPhone, cleanEmail,
  doctorView, staffView
};
