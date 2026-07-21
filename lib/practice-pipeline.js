'use strict';

// Pure, dependency-free helpers for the practice-client intake pipeline
// (Facebook lead intake -> masked GP-facing listing -> reveal-on-accept flow).
// No DB calls, no network. Callers pass plain objects; logic here is
// deterministic and unit-testable.

const crypto = require('crypto');

const AU_STATE_CODES = ['NSW', 'QLD', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'];
const BILLING_STYLES = ['mixed', 'bulk', 'private'];
const MMM_VALUES = ['', 'MM1', 'MM2', 'MM3', 'MM4', 'MM5', 'MM6', 'MM7'];
const URGENCY_VALUES = ['asap', '3_6m', '12m'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'either'];

const BILLING_LABELS = {
  mixed: 'Mixed Billing',
  bulk: 'Bulk Billing',
  private: 'Private Billing',
};

// Single source of truth for the practice intake form + payload validation.
const INTAKE_FIELDS = [
  { key: 'billing_style', label: 'Billing style', type: 'select', required: true, options: BILLING_STYLES.slice() },
  { key: 'dpa', label: 'DPA (District of Priority Area)', type: 'boolean', required: true },
  { key: 'mmm', label: 'Modified Monash Model (MMM)', type: 'select', required: false, options: MMM_VALUES.slice() },
  { key: 'visa_sponsorship', label: 'Visa sponsorship offered', type: 'boolean', required: false },
  { key: 'ownership', label: 'Ownership', type: 'text', required: false },
  { key: 'years_operating', label: 'Years operating', type: 'text', required: false },
  { key: 'nursing_on_site', label: 'Nursing on site', type: 'boolean', required: false },
  { key: 'gp_count', label: 'Number of GPs', type: 'text', required: false },
  { key: 'percentage_split', label: 'Percentage split', type: 'text', required: true },
  { key: 'incentives', label: 'Incentives', type: 'textarea', required: false },
  { key: 'earnings_text', label: 'Estimated earnings', type: 'text', required: false },
  { key: 'suburb', label: 'Suburb', type: 'text', required: true },
  { key: 'nearest_city', label: 'Nearest city', type: 'text', required: true },
  { key: 'state', label: 'State', type: 'select', required: true, options: AU_STATE_CODES.slice() },
  { key: 'address', label: 'Address', type: 'text', required: true },
  { key: 'general_location', label: 'General location', type: 'text', required: false },
  { key: 'urgency', label: 'When do you need a GP?', type: 'select', required: true, options: URGENCY_VALUES.slice() },
  { key: 'employment_type', label: 'Full-time or part-time?', type: 'select', required: true, options: EMPLOYMENT_TYPES.slice() },
  { key: 'gps_needed', label: 'How many GPs do you need?', type: 'text', required: true },
  { key: 'website', label: 'Your practice website', type: 'text', required: false },
  { key: 'supervision_available', label: 'Is supervision available?', type: 'boolean', required: false },
  { key: 'role_summary', label: 'Role summary', type: 'textarea', required: false },
  { key: 'intro_text', label: 'Introduction', type: 'textarea', required: false },
  { key: 'intro_video_url', label: 'Intro video URL', type: 'text', required: false },
];

// --- generic helpers -------------------------------------------------

function trimStr(value) {
  return String(value == null ? '' : value).trim();
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  const key = trimStr(value).toLowerCase();
  return key === 'true' || key === 'yes' || key === '1' || key === 'on';
}

function isBooleanish(value) {
  if (typeof value === 'boolean') return true;
  const key = trimStr(value).toLowerCase();
  return ['true', 'false', 'yes', 'no', '1', '0', 'on', 'off', ''].includes(key);
}

// --- token generation --------------------------------------------------

function generateIntakeToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// --- Facebook / Zapier lead normalization ------------------------------

function fbFieldMap(fieldData) {
  const map = {};
  (Array.isArray(fieldData) ? fieldData : []).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const name = trimStr(entry.name).toLowerCase();
    const values = Array.isArray(entry.values) ? entry.values : [];
    const value = values.length ? values[0] : undefined;
    if (name) map[name] = value;
  });
  return map;
}

function pickFirst(map, keys) {
  for (const key of keys) {
    if (map[key] !== undefined && map[key] !== null && map[key] !== '') return map[key];
  }
  return undefined;
}

function normalizeFacebookLeadPayload(body) {
  const src = body && typeof body === 'object' ? body : {};

  let leadId;
  let practice_name;
  let contact_name;
  let contact_email;
  let contact_phone;
  let location;
  let website;
  let dpa;
  let contact_role;
  let urgency;
  let postcode;

  const nativeValue =
    (src.entry &&
      Array.isArray(src.entry) &&
      src.entry[0] &&
      Array.isArray(src.entry[0].changes) &&
      src.entry[0].changes[0] &&
      src.entry[0].changes[0].value) ||
    // Some routes (or simplified test/fixture payloads) hand over the
    // field_data array directly, without the full webhook envelope.
    (Array.isArray(src.field_data) ? src : null);

  if (nativeValue && typeof nativeValue === 'object') {
    const map = fbFieldMap(nativeValue.field_data);
    leadId = nativeValue.leadgen_id;
    practice_name = pickFirst(map, ['practice_name', 'company_name', 'full_name']);
    contact_name = pickFirst(map, ['full_name']);
    contact_email = pickFirst(map, ['email']);
    contact_phone = pickFirst(map, ['phone_number', 'phone']);
    location = pickFirst(map, ['city', 'location']);
    website = pickFirst(map, ['website']);
    dpa = pickFirst(map, ['dpa']);
    contact_role = pickFirst(map, ['contact_role']);
    urgency = pickFirst(map, ['gp_needed_by']);
    postcode = pickFirst(map, ['postcode']);
  } else {
    leadId = src.lead_id !== undefined ? src.lead_id : src.id;
    practice_name = src.practice_name;
    contact_name = src.contact_name;
    contact_email = src.contact_email;
    contact_phone = src.contact_phone;
    location = src.location;
    website = src.website;
    dpa = src.dpa;
    contact_role = src.contact_role;
    urgency = src.gp_needed_by;
    postcode = src.postcode;
  }

  const hasPracticeName = practice_name !== undefined && practice_name !== null && trimStr(practice_name) !== '';
  const hasContactEmail = contact_email !== undefined && contact_email !== null && trimStr(contact_email) !== '';
  if (!hasPracticeName && !hasContactEmail) return null;

  if (leadId === undefined || leadId === null || trimStr(leadId) === '') {
    leadId = 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  }

  return {
    leadId,
    practice_name: practice_name !== undefined ? practice_name : undefined,
    contact_name: contact_name !== undefined ? contact_name : undefined,
    contact_email: contact_email !== undefined ? contact_email : undefined,
    contact_phone: contact_phone !== undefined ? contact_phone : undefined,
    location: location !== undefined ? location : undefined,
    website: website !== undefined ? website : undefined,
    dpa: dpa !== undefined ? dpa : undefined,
    contact_role: contact_role !== undefined ? contact_role : undefined,
    urgency: urgency !== undefined ? urgency : undefined,
    postcode: postcode !== undefined ? postcode : undefined,
  };
}

// --- website practice lead (the site's own front door) ------------------

// Rough continental bounding box. A geocoder that returns the wrong side of
// the planet (or a caller passing garbage) must not have its coordinates
// stored against an Australian practice.
const AU_LAT_MIN = -44;
const AU_LAT_MAX = -9;
const AU_LON_MIN = 112;
const AU_LON_MAX = 154;

function isAustralianLatLon(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= AU_LAT_MIN && lat <= AU_LAT_MAX && lon >= AU_LON_MIN && lon <= AU_LON_MAX;
}

// Deliberately permissive, but a dotted domain is required: 'a@b' resolves
// nowhere, and every accepted lead costs us a real intake email.
function plausibleEmail(value) {
  const str = trimStr(value).toLowerCase();
  if (!str || str.length > 200) return '';
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(str) ? str : '';
}

/**
 * Normalizes a submission from the marketing site's practice flow.
 *
 * Stricter than `normalizeFacebookLeadPayload` on purpose. Meta owns and
 * qualifies its lead form; this endpoint is open to the whole internet, so
 * both a practice name (needed to deduplicate) and a deliverable email
 * (needed to send the intake link) are mandatory.
 *
 * Returns null when the submission cannot be used. Unrecognised vocabulary
 * values are DROPPED rather than passed through — they would otherwise reach
 * a constrained column and fail the INSERT, losing the lead entirely.
 */
function normalizeWebsitePracticeLead(body) {
  const src = body && typeof body === 'object' ? body : {};

  const practice_name = trimStr(src.practice_name);
  const contact_email = plausibleEmail(src.contact_email);
  if (!practice_name || !contact_email) return null;

  const lead = { practice_name, contact_email };

  const optionalText = {
    contact_name: trimStr(src.contact_name),
    contact_phone: trimStr(src.contact_phone),
    contact_role: trimStr(src.contact_role),
    website: trimStr(src.website),
    suburb: trimStr(src.suburb),
    postcode: trimStr(src.postcode),
    gps_needed: trimStr(src.gps_needed),
  };
  Object.keys(optionalText).forEach((key) => {
    if (optionalText[key]) lead[key] = optionalText[key];
  });

  const state = trimStr(src.state).toUpperCase();
  if (state) lead.state = state;
  // location_city is derived from this by buildPracticeProspectRow, keeping
  // the Facebook and website rows shaped identically.
  if (lead.suburb) lead.location = lead.suburb;

  const urgency = trimStr(src.urgency);
  if (URGENCY_VALUES.includes(urgency)) lead.urgency = urgency;

  const employment_type = trimStr(src.employment_type);
  if (EMPLOYMENT_TYPES.includes(employment_type)) lead.employment_type = employment_type;

  // Tri-state on purpose: true, false, or genuinely unknown. A failed or
  // skipped DPA lookup must never be recorded as "not a DPA".
  if (typeof src.dpa === 'boolean') lead.dpa = src.dpa;

  const lat = typeof src.latitude === 'number' ? src.latitude : Number(src.latitude);
  const lon = typeof src.longitude === 'number' ? src.longitude : Number(src.longitude);
  if (isAustralianLatLon(lat, lon)) {
    lead.latitude = lat;
    lead.longitude = lon;
  }

  return lead;
}

/**
 * Builds the `practices` row for a new prospect, shared by BOTH front doors
 * (the Facebook Lead Ads webhook and the marketing site's practice flow) so
 * there is one pipeline rather than two that drift apart.
 *
 * opts: { source, createdBy, intakeToken, metadata }
 *
 * Optional columns are omitted entirely when absent rather than written as
 * blanks, and vocabulary columns are only written when the value is one the
 * intake form itself would accept.
 */
function buildPracticeProspectRow(lead, opts) {
  const l = lead && typeof lead === 'object' ? lead : {};
  const o = opts || {};

  const contactName = trimStr(l.contact_name);
  const practiceName = trimStr(l.practice_name);

  const row = {
    name: practiceName || (contactName ? contactName + "'s practice" : 'New practice lead'),
    location_city: trimStr(l.location || l.suburb),
    location_state: trimStr(l.state).toUpperCase(),
    location_country: 'Australia',
    practice_type: '',
    contact_name: contactName,
    contact_email: trimStr(l.contact_email),
    contact_phone: trimStr(l.contact_phone),
    ahpra_number: '',
    source: o.source || 'website_lead',
    is_active: true,
    created_by: o.createdBy || '',
    stage: 'prospective',
    website: trimStr(l.website),
    dpa: typeof l.dpa === 'boolean' ? l.dpa : null,
    intake_token: o.intakeToken || '',
    agreement_status: 'unsigned',
    metadata: o.metadata || {},
  };

  const urgency = trimStr(l.urgency);
  if (URGENCY_VALUES.includes(urgency)) row.urgency = urgency;

  const employmentType = trimStr(l.employment_type);
  if (EMPLOYMENT_TYPES.includes(employmentType)) row.employment_type = employmentType;

  const gpsNeeded = trimStr(l.gps_needed);
  if (gpsNeeded) row.gps_needed = gpsNeeded;

  const suburb = trimStr(l.suburb);
  if (suburb) row.suburb = suburb;

  const postcode = trimStr(l.postcode);
  if (postcode) row.postcode = postcode;

  if (isAustralianLatLon(l.latitude, l.longitude)) {
    row.latitude = l.latitude;
    row.longitude = l.longitude;
  }

  return row;
}

// --- intake payload validation ------------------------------------------

// options.partial: validate ONLY the fields present in `body` (admin job
// editor PATCH). Absent fields are skipped entirely — no required-field
// errors, no defaults, and they never appear in the returned `value`.
// Present fields get the exact same rules as full mode, and a required
// field that IS present may not be blanked.
function validatePracticeIntakePayload(body, options) {
  const src = body && typeof body === 'object' ? body : {};
  const partial = !!(options && options.partial);
  const value = {};

  for (const field of INTAKE_FIELDS) {
    if (partial && !Object.prototype.hasOwnProperty.call(src, field.key)) continue;
    const raw = src[field.key];

    if (field.type === 'boolean') {
      if (field.required && (raw === undefined || raw === null || raw === '')) {
        return { ok: false, error: `${field.key} is required` };
      }
      if (raw !== undefined && raw !== null && raw !== '' && !isBooleanish(raw)) {
        return { ok: false, error: `${field.key} must be a boolean` };
      }
      if (raw === undefined || raw === null || raw === '') {
        // Optional booleans (visa_sponsorship, nursing_on_site) mean "unknown"
        // when left blank — null, not false, so a blank answer never reads as
        // a confirmed "no" downstream. Required booleans (dpa) never reach
        // here blank — the required check above already returned an error.
        value[field.key] = field.required ? false : null;
      } else {
        value[field.key] = coerceBoolean(raw);
      }
      continue;
    }

    const str = trimStr(raw);

    if (field.required && !str) {
      return { ok: false, error: `${field.key} is required` };
    }

    if (field.key === 'billing_style' && str && !BILLING_STYLES.includes(str)) {
      return { ok: false, error: 'billing_style must be one of mixed, bulk, private' };
    }

    if (field.key === 'mmm' && str && !MMM_VALUES.includes(str)) {
      return { ok: false, error: 'mmm must be a valid Modified Monash Model value' };
    }

    if (field.key === 'state' && str && !AU_STATE_CODES.includes(str.toUpperCase())) {
      return { ok: false, error: 'state must be a valid Australian state code' };
    }

    if (field.key === 'incentives' && str.length > 2000) {
      return { ok: false, error: 'incentives must be 2000 characters or fewer' };
    }

    if (field.key === 'earnings_text' && str.length > 300) {
      return { ok: false, error: 'earnings_text must be 300 characters or fewer' };
    }

    if (field.key === 'suburb' && str.length > 120) {
      return { ok: false, error: 'suburb must be 120 characters or fewer' };
    }

    if (field.key === 'nearest_city' && str.length > 120) {
      return { ok: false, error: 'nearest_city must be 120 characters or fewer' };
    }

    if (field.key === 'address' && str.length > 300) {
      return { ok: false, error: 'address must be 300 characters or fewer' };
    }

    if (field.key === 'urgency' && str && !URGENCY_VALUES.includes(str)) {
      return { ok: false, error: 'urgency must be one of asap, 3_6m, 12m' };
    }

    if (field.key === 'employment_type' && str && !EMPLOYMENT_TYPES.includes(str)) {
      return { ok: false, error: 'employment_type must be one of full_time, part_time, either' };
    }

    if (field.key === 'role_summary' && str.length > 4000) {
      return { ok: false, error: 'role_summary must be 4000 characters or fewer' };
    }

    if (field.key === 'intro_text' && str.length > 4000) {
      return { ok: false, error: 'intro_text must be 4000 characters or fewer' };
    }

    if (field.key === 'intro_video_url' && str && !str.startsWith('https://')) {
      return { ok: false, error: 'intro_video_url must start with https://' };
    }

    value[field.key] = field.key === 'state' ? str.toUpperCase() : str;
  }

  return { ok: true, value };
}

// --- masked title / display label --------------------------------------

function normalizeBillingLabel(billingStyle) {
  const raw = String(billingStyle || '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[\s_-]*billing$/i, '').replace(/[\s_-]/g, '');
  if (BILLING_LABELS[key]) return BILLING_LABELS[key];
  if (/^bulk/.test(key)) return 'Bulk Billing';
  if (/^mixed/.test(key)) return 'Mixed Billing';
  if (/^private/.test(key)) return 'Private Billing';
  return raw; // already a human label we don't recognize — pass through
}

// Owner-locked GP-facing name: "DPA - Suburb (City) - Billing".
// Legacy rows with only a town render "DPA - Town - Billing" (no parens).
// visaSponsorship/earningsText are accepted for call-site compatibility but
// no longer rendered in the title (they still appear in display_label/details).
function buildMaskedTitle({ suburb, nearestCity, billingStyle, dpa, visaSponsorship, earningsText, state } = {}) {
  const sub = String(suburb || '').trim();
  const city = String(nearestCity || '').trim();
  const loc = sub && city && sub.toLowerCase() !== city.toLowerCase()
    ? sub + ' (' + city + ')'
    : (sub || city);
  if (!loc) return 'GP Opportunity near ' + (String(state || '').trim() || 'you');
  const dpaPart = dpa === true ? 'DPA' : 'Non-DPA';
  const billingLabel = normalizeBillingLabel(billingStyle);
  return [dpaPart, loc, billingLabel].filter(Boolean).join(' - ');
}

function buildMaskedDisplayLabel({ billingStyle, dpa, nearestCity } = {}) {
  const billingLabel = BILLING_LABELS[billingStyle] || '';
  const dpaLabel = dpa === true ? 'DPA' : 'Non-DPA';
  const cityLabel = nearestCity ? 'near ' + nearestCity : '';
  return [billingLabel, dpaLabel, cityLabel].filter(Boolean).join(' · ');
}

// --- reveal / qualification gates ---------------------------------------

function canRevealPracticeIdentityCore({ application, offer } = {}) {
  if (!application) return false;
  if (application.origin === 'admin_applied') return true;
  if (application.revealed === true) return true;
  if (offer && offer.status === 'accepted') return true;
  return false;
}

function gpQualifiesForRole(role, gp) {
  const r = role || {};
  const g = gp || {};
  if (r.dpa === true) return { qualifies: true };
  if (g.australiaTrained === true) return { qualifies: true };
  return { qualifies: false, reason: 'dpa_restricted' };
}

// --- ranking --------------------------------------------------------------

function fieldMatchesCity(row, preferredCityLower) {
  const candidates = [row.nearest_city, row.location_city, row.majorCity, row.location, row.location_label];
  return candidates.some((c) => typeof c === 'string' && c.trim().toLowerCase() === preferredCityLower);
}

function rowState(row) {
  return row.location_state || row.state || '';
}

function rowSortTimestamp(row) {
  return row.published_at || row.created_at || '';
}

function rankRolesForGp(rows, { preferredCity } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const preferredCityLower = trimStr(preferredCity).toLowerCase();

  let matchedStates = [];
  if (preferredCityLower) {
    matchedStates = list
      .filter((row) => fieldMatchesCity(row, preferredCityLower))
      .map((row) => rowState(row))
      .filter(Boolean);
  }

  const scored = list.map((row, index) => {
    let score = 2;
    if (preferredCityLower && fieldMatchesCity(row, preferredCityLower)) {
      score = 0;
    } else if (preferredCityLower && matchedStates.includes(rowState(row))) {
      score = 1;
    }
    return { row, score, index };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const ta = rowSortTimestamp(a.row);
    const tb = rowSortTimestamp(b.row);
    if (ta !== tb) return ta < tb ? 1 : -1; // desc
    return a.index - b.index; // stable
  });

  return scored.map((s) => s.row);
}

// --- redacted stub ----------------------------------------------------------

function buildRedactedRoleStub(clientRole) {
  const role = clientRole || {};
  return {
    id: role.id,
    title: 'GP Opportunity',
    practiceName: 'Confidential practice',
    location: role.state || 'Australia',
    billing: '',
    summary: "You don't currently qualify for this role.",
    qualifies: false,
    blurred: true,
    qualifyReason: role.qualifyReason || 'dpa_restricted',
  };
}

// --- email copy -------------------------------------------------------------

function buildIntakeEmailCopy({ practiceName, contactName, intakeUrl, logoUrl } = {}) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const firstName = trimStr(contactName).split(/\s+/)[0];
  const greetingName = firstName ? esc(firstName) : 'Practice Manager';
  const logo = logoUrl || 'https://app.mygplink.com.au/media/images/gp-link-logo.png';

  // Shared paragraph style — generous line-height + bottom margin so the letter
  // reads as spaced paragraphs, not one clumped block.
  const p = 'margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155';
  const lead = 'color:#0f172a';

  const bodyHtml =
    `<p style="${p}">Dear ${greetingName},</p>` +
    `<p style="${p}">I hope you're well. At GP Link, we understand that when your centre needs a skilled doctor, every moment counts.</p>` +
    `<p style="${p}">We are currently leveraging the government's expedited Specialist pathway to place qualified doctors from the UK, Ireland, and New Zealand into Australian practices faster than ever before. To maintain this speed and secure your place in our current recruitment cycle, we have streamlined our onboarding process.</p>` +
    `<p style="margin:26px 0 12px;font-size:16px;font-weight:700;color:#0f172a">How to secure your GP placement:</p>` +
    `<p style="${p}"><strong style="${lead}">Complete the Placement Application:</strong> Kindly complete our formal Placement Application Form. This allows us to build your clinic's profile, list the vacancy on our website, and begin active sourcing.</p>` +
    `<p style="${p}"><strong style="${lead}">Complete our agreement:</strong> Once you complete the placement application form we will send you the agreement between GP Link and your party. Once this is completed we can officially secure you a new GP.</p>` +
    `<p style="${p}"><strong style="${lead}">14-Day Sourcing Window:</strong> Once the application is live, our team moves into an intensive sourcing phase. We aim to identify and present your first qualified candidates within 14 days.</p>` +
    `<p style="${p}"><strong style="${lead}">1/3 RULE:</strong> Our precision matching ensures a high success rate: we run the interview process with you, and historically, at least 1 in every 3 interviews results in a confirmed General Practitioner placement.</p>` +
    `<p style="${p}">We currently have a limited number of qualified General Practitioners available for placement per region. To ensure your medical centre is prioritised for our upcoming intake, please return the signed agreement at your earliest convenience.</p>`;

  const signatureHtml =
    `<div style="margin-top:28px">` +
      `<p style="margin:0 0 2px;font-size:15px;color:#334155">Warm Regards</p>` +
      `<p style="margin:0;font-size:15px;font-weight:700;color:#0f172a">Khaleed Mahmoud Ibañez</p>` +
      `<p style="margin:0 0 12px;font-size:14px;color:#64748b">CEO</p>` +
      `<img src="${logo}" alt="GP Link" width="130" style="display:block;height:auto;border:0;margin:0 0 10px" />` +
      `<p style="margin:0;font-size:13px;font-weight:700;color:#0f172a">GP LINK RECRUITMENT AUSTRALIA PTY LTD</p>` +
      `<p style="margin:2px 0 0;font-size:13px"><a href="https://mygplink.com.au" style="color:#2563eb;text-decoration:none">mygplink.com.au</a></p>` +
    `</div>`;

  return {
    subject: 'Your GP is waiting: complete your placement application',
    title: '',
    bodyHtml,
    signatureHtml,
    ctaText: 'Complete the Placement Application',
    ctaUrl: intakeUrl,
    footer: 'You are receiving this because you enquired about GP recruitment with GP Link.',
  };
}

function buildCongratsEmailCopy({ gpName, practiceName, secureUrl } = {}) {
  const name = gpName ? gpName : 'there';
  const practice = practiceName ? practiceName : 'A practice';
  return {
    subject: 'Congratulations — a practice wants to meet you 🎉',
    title: 'Congratulations!',
    body:
      `Hi ${name},\n\n` +
      `Great news — ${practice} wants to move forward with your application and is ready to meet you.\n\n` +
      `Secure your interview now before the slot is offered to another candidate.`,
    ctaText: 'Secure My Interview',
    ctaUrl: secureUrl,
    footer: 'You are receiving this because you have an active application with GP Link.',
  };
}

module.exports = {
  generateIntakeToken,
  normalizeFacebookLeadPayload,
  normalizeWebsitePracticeLead,
  buildPracticeProspectRow,
  validatePracticeIntakePayload,
  buildMaskedTitle,
  buildMaskedDisplayLabel,
  canRevealPracticeIdentityCore,
  gpQualifiesForRole,
  rankRolesForGp,
  buildRedactedRoleStub,
  buildIntakeEmailCopy,
  buildCongratsEmailCopy,
  INTAKE_FIELDS,
};
