// Zoho re-engagement over WhatsApp. The 815 candidate_leads imported from Zoho
// Recruit never came through the website or a Meta form, so Hayley must not cold
// call them (no consent to an automated call). Instead one approved WhatsApp
// template asks whether they are still interested; a "Yes, call me" tap turns
// the candidate into an ordinary qualified consult lead that the dialler rings
// within minutes. Pure helpers here; storage and HTTP live in server.js.
'use strict';

const { firstNameOf } = require('./lead-calls');

const TEMPLATE_NAME = 'gp_link_reengage_hayley';
// webhook_events provider for the "already messaged" marker (event_id = candidate id).
const SENT_PROVIDER = 'zoho_reengage';
const LEAD_SOURCE = 'zoho_reengagement';

// UK mobiles only (+44 7xxx xxxxxx): the message is about UK GPs and WhatsApp
// needs a mobile. Accepts 07…, 447…, +447…, 0044 7…, and a glued "+44 07…".
function ukMobileE164(phone) {
  let d = String(phone == null ? '' : phone).replace(/[^\d+]/g, '');
  const lastPlus = d.lastIndexOf('+');
  if (lastPlus > 0) d = d.slice(lastPlus);
  d = d.replace(/^\+/, '');
  if (/^0044/.test(d)) d = d.slice(2);
  if (/^07\d{9}$/.test(d)) d = '44' + d.slice(1);
  if (/^4407\d{9}$/.test(d)) d = '44' + d.slice(3);
  return /^447\d{9}$/.test(d) ? '+' + d : '';
}

// Last ten digits: the same number however it was stored.
function phoneKey(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '').slice(-10);
}

// Who gets the next message. Newest registrations first (most likely still
// looking); one message per number, ever; never anyone unsubscribed.
function pickReengageBatch(rows, opts) {
  const o = opts || {};
  const limit = Math.max(0, Number(o.limit) || 0);
  const sentIds = o.sentIds instanceof Set ? o.sentIds : new Set(o.sentIds || []);
  const sentPhones = new Set((o.sentPhones || []).map(phoneKey).filter(Boolean));
  const counts = { scanned: 0, unsubscribed: 0, no_phone: 0, not_uk_mobile: 0, already_sent: 0, duplicate_phone: 0, eligible: 0 };
  const seen = new Set();
  const eligible = [];
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  for (const r of list) {
    counts.scanned++;
    if (r.unsubscribed) { counts.unsubscribed++; continue; }
    if (!String(r.phone || '').trim()) { counts.no_phone++; continue; }
    const e164 = ukMobileE164(r.phone);
    if (!e164) { counts.not_uk_mobile++; continue; }
    const key = phoneKey(e164);
    if (sentIds.has(String(r.id)) || sentPhones.has(key)) { counts.already_sent++; continue; }
    if (seen.has(key)) { counts.duplicate_phone++; continue; }
    seen.add(key);
    counts.eligible++;
    eligible.push({
      id: String(r.id),
      name: String(r.name || '').trim(),
      first_name: firstNameOf(r.name) || 'Doctor',
      email: String(r.email || '').trim().toLowerCase(),
      phone: e164,
      created_at: String(r.created_at || '')
    });
  }
  return { counts, eligible_total: eligible.length, batch: limit ? eligible.slice(0, limit) : eligible };
}

// What a reply to the template means. The two quick replies are "Yes, call me"
// and "Not right now"; people also type. STOP wins over everything, a decline
// over a yes ("no, don't call me" is a no), and anything else is a question
// for a human.
// STOP is honoured wherever it appears ("please unsubscribe me"); yes/no only at the start.
const STOP_RE = /(^|\W)(stop|unsubscribe|opt\s*out|remove me|delete me|do not (contact|message|call)|don'?t (contact|message|call) me)\b/i;
const NO_RE = /^\W*(no\b|nope|nah|not (right )?now|not interested|not at the moment|no longer|maybe later|no thanks|no thank you|not (any ?more|anymore)|already (sorted|moved|in australia))/i;
const YES_RE = /^\W*(yes|yeah|yep|yup|sure|ok(ay)?|please do|call me|go ahead|absolutely|definitely|still interested|interested|i am|i'm interested)\b/i;
function classifyReengageReply(text) {
  const t = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  if (!t) return 'other';
  if (STOP_RE.test(t)) return 'stop';
  if (NO_RE.test(t)) return 'no';
  if (YES_RE.test(t)) return 'yes';
  return 'other';
}

// A quick-reply tap on a template button is not a TEXT message. DoubleTick's
// docs stop at TEXT/IMAGE/AUDIO/VIDEO, so every shape Meta's Cloud API and its
// resellers use for a button reply is read here; the first non-empty wins.
function buttonReplyText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const candidates = [
    msg.button && (msg.button.text || msg.button.payload),
    msg.buttonText, msg.button_text, msg.payload, msg.title,
    msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title,
    msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title,
    msg.reply && (msg.reply.text || msg.reply.title)
  ];
  const hit = candidates.find((v) => typeof v === 'string' && v.trim());
  return hit ? hit.trim() : null;
}

// The consult lead a "yes" becomes: a UK number we recognise, GP question not
// asked (null, never false — see buildConsultLeadRow), source so the dialler's
// variables say "our WhatsApp message" and the Leads tab can tell them apart.
function leadInput(candidate, replyText) {
  const c = candidate || {};
  const reply = String(replyText || '').trim().slice(0, 120);
  return {
    name: String(c.name || '').trim() || String(c.email || '').trim() || 'Doctor',
    email: String(c.email || '').trim().toLowerCase(),
    phone: ukMobileE164(c.phone) || String(c.phone || ''),
    isGp: null,
    country: 'uk',
    countryRecognised: true,
    countrySource: 'zoho_reengagement',
    question: 'Replied "' + reply + '" to our WhatsApp asking whether they are still interested in GP work in Australia (registered with us earlier via Zoho).',
    source: LEAD_SOURCE,
    userAgent: 'doubletick-webhook'
  };
}

// The lead an imported Zoho candidate becomes when Hayley is to ring them
// directly (owner 2026-10-31: consent already held, no opt-in message needed).
function importInput(candidate) {
  const c = candidate || {};
  return {
    name: String(c.name || '').trim() || String(c.email || '').trim() || 'Doctor',
    email: String(c.email || '').trim().toLowerCase(),
    phone: ukMobileE164(c.phone) || String(c.phone || ''),
    isGp: null,
    country: 'uk',
    countryRecognised: true,
    countrySource: 'zoho_import',
    question: '',
    source: 'zoho_import',
    userAgent: 'zoho-import'
  };
}

function replyText(kind, opts) {
  const o = opts || {};
  const first = String(o.first || '').trim() || 'there';
  if (kind === 'yes') {
    return 'Great, ' + first + '. Hayley from GP Link will ring you' + (o.fromNumber ? ' from ' + o.fromNumber : '')
      + ', usually within the hour during UK working hours (Mon to Fri 9am to 7:30pm, Sat 10am to 4pm).'
      + (o.bookUrl ? ' If you\'d rather pick a time yourself: ' + o.bookUrl : '');
  }
  if (kind === 'no') {
    return 'No problem at all, ' + first + '. We\'ll leave you be. If anything changes, just message here.';
  }
  return '';
}

// The drip lands on UK weekday daytime so a "yes" gets Hayley's call the same day.
// spec: { from, to, weekends } hours in the zone; defaults to weekdays 9-17.
function isSendWindow(nowMs, tz, spec) {
  const s = Object.assign({ from: 9, to: 17, weekends: false }, spec || {});
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'short', hour: 'numeric', hour12: false });
  const parts = {};
  fmt.formatToParts(new Date(nowMs || Date.now())).forEach((p) => { parts[p.type] = p.value; });
  const hour = Number(parts.hour) % 24;
  const weekend = /^(Sat|Sun)/.test(parts.weekday || '');
  return (s.weekends || !weekend) && hour >= s.from && hour < s.to;
}

module.exports = {
  TEMPLATE_NAME,
  SENT_PROVIDER,
  LEAD_SOURCE,
  ukMobileE164,
  phoneKey,
  pickReengageBatch,
  classifyReengageReply,
  buttonReplyText,
  leadInput,
  importInput,
  replyText,
  isSendWindow,
  firstNameOf
};
