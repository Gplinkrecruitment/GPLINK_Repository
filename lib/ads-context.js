'use strict';

// lib/ads-context.js — what the rest of GP Link knows about each Meta lead,
// folded into the ads review so the model reasons about the WHOLE funnel and
// never advises something the app already does by itself.
//
// Pure: takes rows, returns facts. The server gathers the rows (site_enquiries,
// lead_calls, scheduled_calls, career_roles, social_posts) and both the daily
// snapshot and the date-range report use the same join, so "booked" means the
// same thing everywhere on the page.

const DAY = 86400000;

// What happens to a Meta lead without anyone lifting a finger. Written for the
// model, in the order it happens. Keep in step with lib/consult-lead.js,
// lib/lead-calls.js and the FB webhook: a wrong line here produces a wrong
// "you should…" in the morning review.
const AUTOMATION = [
  'On the form (t+0): the app screens the lead (country, registered GP) and, if qualified, emails a magic link to the Calendly booking page. The instant form\'s own thank-you screen already sends them to Calendly.',
  'Hazel, the AI phone agent (Retell), rings every qualified lead about 3 minutes after the form, in UK hours, up to 2 attempts 3 hours apart. She books the consultation on the call or sends the booking link by text, records the outcome (booked, link sent, callback requested, not interested, voicemail, no answer, wrong number, do not call) and notes objections and timeframe.',
  'WhatsApp/email chase in the owner\'s voice: t+5 min WhatsApp, t+1 h WhatsApp + email, t+24 h WhatsApp + email. It stops the moment they book or reply.',
  'If nothing is booked 20 minutes after the 1-hour note, the owner is paged with the lead\'s details and calls personally.',
  'After booking: Calendly confirmation and reminders, the consultation on Zoom (summary saved), a no-show sweep, and a 5-touch sign-up drip over 3 weeks after an attended call.',
  'After sign-up: onboarding nudges, the AHPRA registration pipeline, matching to practices, and placement. Leads are also fed back to Meta as CRM stages (lead → qualified_gp → call_booked → signed_up) so Meta optimises for bookings.'
];

function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
function str(v, n) { const s = String(v == null ? '' : v).trim(); return n ? s.slice(0, n) : s; }
function lower(v) { return str(v).toLowerCase(); }
function digits(v) { const s = str(v); return /^\d+$/.test(s) ? s : ''; }
function ms(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : NaN; }
function round(n, dp) { const f = Math.pow(10, dp == null ? 1 : dp); return Math.round((Number(n) || 0) * f) / f; }
function median(list) {
  const a = list.filter(function (n) { return Number.isFinite(n); }).sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function counter(items, max) {
  const c = {};
  items.forEach(function (k) { if (k) c[k] = (c[k] || 0) + 1; });
  return Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).slice(0, max || 8)
    .map(function (k) { return { value: k, count: c[k] }; });
}

// Hazel outcomes that mean a human actually spoke to her.
const SPOKE = ['booked', 'link_sent', 'callback_requested', 'not_interested', 'not_a_gp', 'do_not_call', 'already_booked', 'transferred', 'unclear'];
const NOISE = ['none', 'n/a', 'na', 'nil', 'no', 'unknown', '', '-'];
function meaningful(s) { return NOISE.indexOf(lower(s)) === -1; }

// ── reading every row ──────────────────────────────────────────────────────
// PostgREST answers at most 1,000 rows however large a `limit` the query asks
// for, and silently: no error, no hint. 2026-11-10: lead_calls held 1,564 rows
// (the past-leads campaign adds hundreds a day), the review read the first
// 1,000 in no particular order, and told the owner "Hazel rang only 6 of the
// 12 leads this week and 35 of 50 this month" when the truth was 11 of 12 and
// 40 of 50. So every read behind the review pages: `fetchPage(offset, limit)`
// returns one page (an array) or null/throws on failure, and this loops until
// a short page. A failed page ends the loop with what was read so far (the
// review still runs, on less) and sets `.truncated`, as does hitting the cap.
const PAGE_SIZE = 1000;
const MAX_PAGES = 25;
async function readAllPages(fetchPage, opts) {
  const o = opts || {};
  const size = Math.max(1, Number(o.pageSize) || PAGE_SIZE);
  const maxPages = Math.max(1, Number(o.maxPages) || MAX_PAGES);
  const out = [];
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    let rows = null;
    try { rows = await fetchPage(page * size, size); } catch (e) { rows = null; }
    if (!Array.isArray(rows)) { truncated = true; break; }
    for (let k = 0; k < rows.length; k++) out.push(rows[k]);
    if (rows.length < size) break;
    if (page === maxPages - 1) truncated = true;
  }
  Object.defineProperty(out, 'truncated', { value: truncated, enumerable: false });
  return out;
}

// ── our own rows ───────────────────────────────────────────────────────────
// The team tests the funnel with real form fills (hello+…@mygplink.com.au, the
// registration@ inbox, Meta's own test@meta.com lead, the owner's khaleedmahmoud*
// logins) and "Exclude from calling" stamps consult.excluded_at on a lead who
// turned out to be an existing app user or a placed doctor. None of them is an
// ad result: counted, they showed as 2 of the month's 10 "bookings" and 4 of
// its 50 leads (review of 2026-11-10).
const INTERNAL_EMAIL_DOMAINS = ['mygplink.com.au'];
const INTERNAL_EMAILS = ['test@meta.com'];
const INTERNAL_EMAIL_FRAGMENTS = ['khaleedmahmoud'];
function isInternalLead(row) {
  const r = obj(row);
  const email = lower(r.email);
  if (email) {
    if (INTERNAL_EMAILS.indexOf(email) !== -1) return true;
    const domain = email.split('@')[1] || '';
    if (INTERNAL_EMAIL_DOMAINS.indexOf(domain) !== -1) return true;
    if (INTERNAL_EMAIL_FRAGMENTS.some(function (f) { return email.indexOf(f) !== -1; })) return true;
  }
  return !!obj(obj(r.metadata).consult).excluded_at;
}

// ── did the consultation happen? ───────────────────────────────────────────
// One answer per lead: 'attended' | 'upcoming' | 'no_show' | 'unverified', or
// null when nothing was ever booked.
//
// The booking row alone cannot say. status 'completed' is written when the
// Zoom meeting ends, host-only meetings included, and no_show_at has never
// been set on any row in production: the no-show sweep's first strike puts the
// row back to 'invited' and blanks the slot instead. Read that way, the review
// of 2026-11-10 reported "5 attended, 0 no-show, 5 neither" for bookings that
// were really 2 attended, 5 no-show, 1 still to come and 2 of our own tests.
//
// So, in order:
//   1. the lead's own verdict, consult.call_attended (the Zoom participant
//      check, or a hand correction) — true is attended, false is a no-show;
//   2. a live booking whose slot is still ahead — upcoming (a doctor who
//      missed one call and re-booked is waiting on the new one);
//   3. the booking row: swept by the no-show sweep (failed_attempt_count on a
//      row that is back to 'invited', or closed as cancelled / no_show) — a
//      no-show; completed with Zoom notes — attended (rows older than the
//      participant check, where notes are the only proof a doctor spoke);
//   4. otherwise unverified: booked, slot passed, nothing yet says either way.
function sweptAsNoShow(c) {
  if (!c) return false;
  if (c.no_show_at || lower(c.status) === 'no_show') return true;
  const st = lower(c.status);
  return Number(c.failed_attempt_count) >= 1 && (st === 'invited' || st === 'cancelled');
}
function consultOutcome(consult, rows, now, booked) {
  const c = obj(consult);
  const list = Array.isArray(rows) ? rows : [];
  if (c.call_attended === true) return 'attended';
  const liveAhead = list.some(function (r) { return lower(r.status) === 'booked' && ms(r.scheduled_at) > now; })
    || (!list.length && c.call_booked === true && ms(c.call_at) > now);
  if (liveAhead) return 'upcoming';
  if (c.call_attended === false) return 'no_show';
  if (list.some(sweptAsNoShow)) return 'no_show';
  if (list.some(function (r) { return (lower(r.status) === 'completed' || r.completed_at) && str(r.meeting_summary); })) return 'attended';
  if (booked || list.some(function (r) { const st = lower(r.status); return st === 'booked' || st === 'completed'; })) return 'unverified';
  return null;
}

// ── the join ───────────────────────────────────────────────────────────────
// One record per Meta lead with everything the rest of the app recorded.
// Our own test rows are left out (isInternalLead).
function enrichLeads(input) {
  const i = input || {};
  const now = Number(i.now || Date.now());
  const callsBy = {};
  (Array.isArray(i.calls) ? i.calls : []).forEach(function (c) {
    const k = str(c && c.enquiry_id);
    if (!k) return;
    (callsBy[k] = callsBy[k] || []).push(c);
  });
  const consultsBy = {};
  (Array.isArray(i.consults) ? i.consults : []).forEach(function (c) {
    const k = lower(c && c.invitee_email);
    if (!k) return;
    (consultsBy[k] = consultsBy[k] || []).push(c);
  });
  const out = [];
  (Array.isArray(i.leads) ? i.leads : []).forEach(function (row) {
    const meta = obj(row && row.metadata);
    if (meta.source !== 'meta_lead_ad') return;
    if (isInternalLead(row)) return;
    const created = ms(row.created_at);
    if (!Number.isFinite(created)) return;
    const consult = obj(meta.consult);
    const calls = (callsBy[str(row.id)] || []).slice().sort(function (a, b) { return ms(a.started_at) - ms(b.started_at); });
    const outcomes = calls.map(function (c) { return lower(c.outcome); });
    const last = calls[calls.length - 1];
    const custom = obj(obj(last && last.analysis).custom_analysis_data);
    // Only consults booked after the form count for this lead; an older row
    // under the same email is a previous enquiry.
    const consults = (consultsBy[lower(row.email)] || []).filter(function (c) { return ms(c.created_at) >= created - DAY; });
    const bookedAt = ms(consult.call_booked_at);
    const booked = consult.call_booked === true || Number.isFinite(bookedAt);
    const outcome = consultOutcome(consult, consults, now, booked);
    const nudges = Array.isArray(consult.nudges) ? consult.nudges : [];
    const wa = obj(consult.wa);
    out.push({
      id: str(row.id),
      ad_id: digits(meta.fb_ad_id) || null,
      form_id: digits(meta.fb_form_id) || null,
      created_at: new Date(created).toISOString(),
      age_days: round((now - created) / DAY, 1),
      country: lower(consult.country) || null,
      qualified: consult.qualified === true,
      screened_out: consult.screened_out === true,
      booked: booked,
      hours_to_book: Number.isFinite(bookedAt) ? round((bookedAt - created) / 3600000, 1) : null,
      // Exactly one of these four is true for a lead with a booking.
      consult_outcome: outcome,
      attended: outcome === 'attended',
      no_show: outcome === 'no_show',
      upcoming: outcome === 'upcoming',
      unverified: outcome === 'unverified',
      cancelled: consults.some(function (c) { return c.status === 'cancelled' || c.cancelled_at; }),
      signed_up: row.status === 'converted' || consult.stopped === 'signed_up',
      replied: !!consult.replied_at,
      stopped: str(consult.stopped) || null,
      emails_sent: nudges.filter(function (n) { return n && (n.email == null || n.email === 'sent'); }).length,
      whatsapps_sent: Object.keys(wa).filter(function (k) { return wa[k] && wa[k].sent_at; }).length,
      owner_paged: !!consult.owner_alert,
      hazel: {
        attempts: calls.length,
        outcomes: outcomes,
        spoke: outcomes.some(function (o) { return SPOKE.indexOf(o) !== -1; }),
        final: outcomes.length ? outcomes[outcomes.length - 1] : null,
        booked_on_call: outcomes.indexOf('booked') !== -1,
        objections: meaningful(custom.objections) ? str(custom.objections, 200) : null,
        lost_reason: meaningful(custom.lost_booking_reason) ? str(custom.lost_booking_reason, 200) : null,
        timeframe: meaningful(custom.timeframe) ? str(custom.timeframe, 80) : null,
        gp_status: meaningful(custom.gp_status) ? str(custom.gp_status, 40) : null,
        questions: meaningful(custom.unanswered_questions) ? str(custom.unanswered_questions, 200) : null,
        sentiment: str(last && last.sentiment, 20) || null
      }
    });
  });
  return out;
}

function emptyFunnel() {
  // upcoming = booked and the slot is still ahead; unverified = the slot has
  // passed and nothing yet says whether the doctor joined. Neither is a gap.
  return { leads: 0, qualified: 0, hazel_called: 0, hazel_spoke: 0, booked: 0, attended: 0, no_show: 0, upcoming: 0, unverified: 0, signed_up: 0 };
}
function addToFunnel(f, l) {
  f.leads++;
  if (l.qualified) f.qualified++;
  if (l.hazel.attempts) f.hazel_called++;
  if (l.hazel.spoke) f.hazel_spoke++;
  if (l.booked) f.booked++;
  if (l.attended) f.attended++;
  if (l.no_show) f.no_show++;
  if (l.upcoming) f.upcoming++;
  if (l.unverified) f.unverified++;
  if (l.signed_up) f.signed_up++;
}
function withRates(f, spend) {
  const o = Object.assign({}, f);
  o.booking_rate_pct = f.leads ? round((f.booked / f.leads) * 100, 0) : null;
  // Of the calls whose outcome is known. A booking still to come, or one not
  // yet checked, is neither a show nor a no-show, so it is not in the divisor
  // (dividing by every booking made a week of future calls read as no-shows).
  const known = (f.attended || 0) + (f.no_show || 0);
  o.attend_rate_pct = known ? round((f.attended / known) * 100, 0) : null;
  o.cost_per_booking = (f.booked && Number(spend)) ? round(Number(spend) / f.booked, 2) : null;
  o.cost_per_attended = (f.attended && Number(spend)) ? round(Number(spend) / f.attended, 2) : null;
  o.cost_per_signup = (f.signed_up && Number(spend)) ? round(Number(spend) / f.signed_up, 2) : null;
  return o;
}

// Funnel for the leads created inside [sinceMs, untilMs), grouped by ad.
function funnelFor(leadFacts, sinceMs, untilMs) {
  const totals = emptyFunnel();
  const byAd = {};
  const hours = [];
  let fast = 0;
  (leadFacts || []).forEach(function (l) {
    const t = ms(l.created_at);
    if (!(t >= sinceMs && t < untilMs)) return;
    addToFunnel(totals, l);
    const k = l.ad_id || 'unknown';
    if (!byAd[k]) byAd[k] = emptyFunnel();
    addToFunnel(byAd[k], l);
    if (l.hours_to_book !== null) { hours.push(l.hours_to_book); if (l.hours_to_book <= 0.2) fast++; }
  });
  return {
    totals: totals,
    by_ad: byAd,
    median_hours_to_book: median(hours),
    booked_within_10min_pct: hours.length ? round((fast / hours.length) * 100, 0) : null
  };
}

// Names and contact details out, substance in. Consult summaries are Zoom's
// own notes and name the doctor on every line.
function anonymise(text, email, names) {
  // Name tokens from the invitee's own address ("jane.smith84@…" → jane, smith)
  // catch the first-name-only mentions a "Dr X" rule cannot; `names` adds the
  // participants Zoom's own notes name (see participantNames).
  const tokens = String(email || '').split('@')[0].split(/[._\-+\d]+/).filter(function (t) { return t.length >= 3; })
    .concat((Array.isArray(names) ? names : []).map(function (n) { return String(n || '').trim(); }).filter(function (n) { return n.length >= 3; }));
  let out = String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[number]')
    // Titles first, while the capitalised name still follows them.
    .replace(/\bDr\.?\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?/g, 'the doctor')
    .replace(/\bDoctor\s+[A-Z][\w'-]+/g, 'the doctor');
  tokens.forEach(function (t) { out = out.replace(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), 'the doctor'); });
  return out
    .replace(/\bDr\.?\s+the doctor/g, 'the doctor')
    .replace(/\bthe doctor(?:\s+the doctor)+/g, 'the doctor');
}

// The "Quick recap" of the newest consults, trimmed. Enough for themes
// (why they want to move, what they ask about, what holds them back), not a
// transcript dump.
function consultThemes(consults, now, max) {
  return (Array.isArray(consults) ? consults : [])
    .filter(function (c) { return c && c.meeting_summary; })
    .sort(function (a, b) { return ms(b.completed_at || b.scheduled_at) - ms(a.completed_at || a.scheduled_at); })
    .slice(0, max || 6)
    .map(function (c) {
      const text = String(c.meeting_summary);
      const m = /##\s*Quick recap\s*([\s\S]*?)(?:\n##\s|$)/i.exec(text);
      const body = (m ? m[1] : text).replace(/\s+/g, ' ').trim();
      return {
        when: (c.completed_at || c.scheduled_at || '').slice(0, 10),
        days_ago: round((Number(now || Date.now()) - ms(c.completed_at || c.scheduled_at)) / DAY, 0),
        recap: anonymise(body, c.invitee_email).slice(0, 700)
      };
    });
}

// ── what GPs ask about, across every past consultation ─────────────────────
// Zoom's notes name the owner "GP" ("GP clarified that…") and the doctor by
// name. The ad writer and the review need the substance: which themes come
// up, how often, and the questions in the doctor's words. One pass over the
// "## Summary" section of every consultation with notes (the whole history,
// not the newest six), counted by theme, with anonymised examples.
const GP_THEMES = [
  { key: 'visa', label: 'Visa and permanent residency', re: /\bvisas?\b|subclass|\b48[12]\b|\b18[69]\b|\b19[01]\b|permanent residen|\bPR\b|sponsor(ed|ing|ship)?\b|entry stream|citizenship|immigration/i },
  { key: 'registration', label: 'AHPRA registration and the pathway', re: /ahpra|afra|registration|\bregister(ed|ing)?\b|competent authority|specialist pathway|standard pathway|\bPET\b|limited registration|general registration|provisional|medical board/i },
  { key: 'eligibility', label: 'Eligibility: CCT, MRCGP, recognition', re: /\bcct\b|mrcgp|\bgmc\b|eligib|recogni[sz]|\bqualifications?\b|fracgp|racgp|fellowship|equivalen|certif/i },
  { key: 'location', label: 'Where: DPA areas, regions, cities', re: /\bdpa\b|distribution priority|\bregional\b|\brural\b|\bmetro\b|\blocations?\b|\bcit(y|ies)\b|gold coast|brisbane|perth|sydney|melbourne|adelaide|canberra|hobart|darwin|queensland|victoria|\bnsw\b|tasmania|western australia|south australia|\bweather\b|\bclimate\b/i },
  { key: 'income', label: 'Income, billings and the service fee', re: /\bincome\b|\bearn(ings?|s|ed)?\b|\bbillings?\b|\bsalary\b|\bmoney\b|service fee|\b\d{2}\s?%|medicare|bulk.?bill|mixed.?bill|private.?bill|\btax\b|superannuation|take.?home|per (hour|consult|patient|session)|\$\s?\d/i },
  { key: 'practice', label: 'How practice works: contractor, consults, hours, supervision', re: /\bcontractor\b|independent (contractor|practice|practitioner)|consult(ation)? (length|time)s?|\b(10|15|20|30)[- ]minute|\bworkload\b|patients (per|a|an) (day|hour|session)|\bsupervis(ion|or|ed)\b|teaching practice|\blocum\b|\bhours\b|\broster|on[- ]call|after[- ]hours|home visits|practice (model|owner|ownership)|own practice|\bduty\b/i },
  { key: 'timeline', label: 'Timeline: how long, when to move', re: /\btimeline\b|how long|time ?frames?|how (soon|quickly)|\b(\d+|two|three|four|six|nine|twelve) (to \d+ )?(months|weeks)\b|start date|\bmove (in|by|next|early|late|before|after)\b|by (early|mid|late|the end of) 20\d\d|\b20(26|27|28)\b/i },
  { key: 'family', label: 'Family: partner, children, schools', re: /\b(his|her|their|my) (wife|husband|partner|family|children|kids|son|daughter)\b|\bfamily\b|\bschool(s|ing)?\b|\bspouse\b|\bdependants?\b|\bdependents?\b|\bchildren\b|\bkids\b/i },
  { key: 'process', label: 'Documents, CV, the app and sign-up steps', re: /\bdocuments?\b|paperwork|\bcv\b|portfolio|\breferences?\b|police check|onboarding|\bsign(ed|ing)? up\b|the app\b|\bprofile\b/i },
  { key: 'english', label: 'English test (IELTS, OET)', re: /ielts|\boet\b|english (test|language|requirement)/i },
  { key: 'exams', label: 'Exams and assessments', re: /pesci|\bexams?\b|clinical assessment|workplace.?based assessment|\bwba\b|\bassessments?\b/i },
  { key: 'alternatives', label: 'Alternatives: New Zealand, hospital roles, elsewhere', re: /new zealand|\bnz\b|\bcanada\b|\bireland\b|\buae\b|\bdubai\b|hospital (employment|role|job|work)|emergency department/i },
  { key: 'career_stage', label: 'Age and career stage', re: /\bage\b|\baged \d|\bretir|senior doctor|years as a gp|newly qualified|\btrainee\b|\bst3\b|\bgraduated\b/i },
  { key: 'special_interest', label: 'Special interests', re: /dermatolog|skin cancer|aged care|palliative|sports medicine|special interests?|women'?s health|paediatric|occupational|cosmetic|obstetric|anaesthe|emergency medicine/i }
];
const QUESTION_RE = /\b(asked|inquired|enquired|wanted to know|questions? (about|on|regarding)|clarified whether|unsure|uncertain|concern(s|ed)?|worried|wondered|whether)\b/i;
const SPEECH_RE = /\bGP (clarified|explained|confirmed|mentioned|said|advised|recommended|suggested|asked|requested|offered|noted|outlined|emphasi[sz]ed|discussed|described|told|encouraged|reassured|agreed|promised|provided|stated|responded|answered|shared|highlighted|informed|assured)\b/g;
// Capitalised words in the notes that are never a person.
const NOT_A_NAME = /^(GP|Link|Dr|Doctor|The|This|That|They|He|She|It|We|You|Australia|Australian|Australians|UK|NHS|AHPRA|AFRA|DPA|PET|CCT|MRCGP|GMC|RACGP|FRACGP|Medicare|Zoom|Perth|Sydney|Melbourne|Brisbane|Adelaide|Canberra|Hobart|Darwin|Queensland|Victoria|NSW|Tasmania|Gold|Coast|New|Zealand|England|Scotland|Wales|Ireland|India|Nepal|Pakistan|Nigeria|Egypt|Canada|Dubai|UAE|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Summary|Quick|Next|Steps|Recap)$/i;

// The people Zoom's notes name: the "### Name" next-step owners, "between GP
// and Name" in the recap, and the possessive in a heading ("Hamza's … Plans").
function participantNames(text) {
  const t = String(text || '');
  const out = {};
  const add = function (n) {
    String(n || '').split(/\s+/).forEach(function (w) {
      const clean = w.replace(/[^A-Za-z'-]/g, '').replace(/'s$/, '');
      if (clean.length >= 3 && /^[A-Z]/.test(clean) && !NOT_A_NAME.test(clean)) out[clean.toLowerCase()] = true;
    });
  };
  const steps = /##\s*Next steps\s*([\s\S]*?)(?:\n##\s|$)/i.exec(t);
  if (steps) { const re = /^###\s*(.+)$/gm; let m; while ((m = re.exec(steps[1]))) add(m[1]); }
  const between = /\bbetween GP(?: Link)? and ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)/g; let b;
  while ((b = between.exec(t))) add(b[1]);
  const poss = /^###\s*([A-Z][\w-]+)'s\b/gm; let pm;
  while ((pm = poss.exec(t))) add(pm[1]);
  return Object.keys(out);
}

function summarySection(text) {
  const t = String(text || '');
  const m = /##\s*Summary\s*([\s\S]*)$/i.exec(t);
  return (m ? m[1] : t).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}
function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.?!])\s+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 12; });
}
// "GP clarified that…" is the owner speaking; the doctor is "the doctor".
function speakers(text) { return String(text || '').replace(SPEECH_RE, 'GP Link $1'); }

function consultQuestions(consults, now, opts) {
  const o = opts || {};
  const t = Number(now || Date.now());
  const windowDays = Number(o.windowDays) || 365;
  const stamp = function (c) { return ms(c.completed_at || c.scheduled_at || c.created_at); };
  const rows = (Array.isArray(consults) ? consults : [])
    .filter(function (c) { return c && c.meeting_summary && (stamp(c) >= t - windowDays * DAY || !Number.isFinite(stamp(c))); })
    .sort(function (a, b) { return stamp(b) - stamp(a); });
  const perTheme = {};
  GP_THEMES.forEach(function (th) { perTheme[th.key] = { key: th.key, label: th.label, consults: 0, mentions: 0, headings: [], examples: [] }; });
  const questions = [];
  const seenQ = {};
  let since = '';
  rows.forEach(function (c) {
    const when = String(c.completed_at || c.scheduled_at || c.created_at || '').slice(0, 10);
    if (when && (!since || when < since)) since = when;
    const names = participantNames(c.meeting_summary);
    const body = speakers(anonymise(summarySection(c.meeting_summary), c.invitee_email, names));
    const hit = {};
    body.split(/\n(?=###\s)/).forEach(function (chunk) {
      const h = /^###\s*(.+)/.exec(chunk.trim());
      const heading = h ? h[1].trim() : '';
      const ss = sentences(h ? chunk.replace(/^###\s*.+\n?/, '') : chunk);
      GP_THEMES.forEach(function (th) {
        // A theme counts when a sentence (or the heading) is about it; the
        // example is a sentence on that theme, a question-shaped one first.
        const on = ss.filter(function (x) { return th.re.test(x); });
        if (!on.length && !th.re.test(heading)) return;
        const slot = perTheme[th.key];
        if (!hit[th.key]) { hit[th.key] = true; slot.consults++; }
        slot.mentions += on.length || 1;
        if (heading && slot.headings.length < 4 && slot.headings.indexOf(str(heading, 80)) === -1) slot.headings.push(str(heading, 80));
        const ex = on.find(function (x) { return QUESTION_RE.test(x); }) || on[0];
        if (ex && slot.examples.length < 3 && slot.examples.indexOf(str(ex, 200)) === -1) slot.examples.push(str(ex, 200));
      });
      ss.forEach(function (x) {
        if (!QUESTION_RE.test(x) || questions.length >= 30) return;
        const key = lower(x).slice(0, 60);
        if (seenQ[key]) return;
        seenQ[key] = true;
        questions.push({ when: when, said: str(x, 220) });
      });
    });
  });
  const themes = Object.keys(perTheme).map(function (k) { return perTheme[k]; })
    .filter(function (x) { return x.consults > 0; })
    .sort(function (a, b) { return b.consults - a.consults || b.mentions - a.mentions; })
    .map(function (x) { return Object.assign(x, { share_pct: rows.length ? Math.round(100 * x.consults / rows.length) : 0 }); });
  return {
    consults: rows.length,
    since: since || null,
    window_days: windowDays,
    note: 'Every consultation with Zoom notes, by theme: consults = how many consultations raised it, mentions = sentences on it. "GP Link" is the consultant speaking; "the doctor" is the GP on the call.',
    themes: themes,
    questions: questions
  };
}

// Where a role is, for the ad's photograph. DPA (Distribution Priority Area)
// is a Medicare shortage classification, not a synonym for rural: most of
// this account's roles are outer-suburban practices of the capital cities
// (Joondalup, Werribee, Springfield, Elizabeth, Belconnen) with regional
// cities and towns alongside (Dubbo, Rockhampton, Karratha). The metro /
// regional booleans on career_roles default to false and are not maintained
// (2026-11-06: all 60 open roles read false/false, and the old
// `metro === false` test told the model "100% regional"), so they are trusted
// only when true; otherwise the Modified Monash code, the nearest city and the
// location label decide.
const CAPITALS = ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin'];
const REGIONAL_CITIES = ['gold coast', 'newcastle', 'wollongong', 'sunshine coast', 'geelong', 'cairns', 'townsville', 'toowoomba', 'ballarat', 'bendigo', 'launceston', 'central coast', 'albury', 'wagga wagga', 'mackay', 'rockhampton', 'bunbury'];
function roleSetting(r) {
  const x = r || {};
  if (x.metro === true) return 'outer_metro';
  if (x.regional === true) return 'regional_town';
  const mm = /MM\s*(\d)/i.exec(str(x.mmm));
  if (mm) { const n = Number(mm[1]); return n === 1 ? 'outer_metro' : (n === 2 ? 'regional_city' : 'regional_town'); }
  const label = lower(x.location_label) + ' ' + lower(x.address);
  const near = lower(x.nearest_city);
  const town = lower(x.location_city) || lower(x.suburb);
  if (CAPITALS.indexOf(town) !== -1) return 'outer_metro';
  if (REGIONAL_CITIES.indexOf(town) !== -1) return 'regional_city';
  // A label that names the capital or its growth belt is the capital's suburbs.
  if (/metropolitan|growth corridor|\bcorridor\b|greater (brisbane|melbourne|sydney|perth|adelaide)|peel region boundary|bayside|redland|logan|moreton bay|ipswich/.test(label)) return 'outer_metro';
  if (CAPITALS.some(function (c) { return label.indexOf(c) !== -1; })) return 'outer_metro';
  if (CAPITALS.indexOf(near) !== -1) return /\bregion\b|coast|valley|highlands|downs/.test(label) ? 'regional_city' : 'outer_metro';
  if (REGIONAL_CITIES.indexOf(near) !== -1) return 'regional_city';
  if (near || label.trim()) return 'regional_town';
  return 'unknown';
}

function placeLabel(r, withCity) {
  const x = r || {};
  const town = str(x.location_city) || str(x.suburb);
  if (!town) return '';
  if (withCity && str(x.nearest_city) && lower(x.nearest_city) !== lower(town)) return town + ' (' + str(x.nearest_city) + ')';
  const st = str(x.location_state).toUpperCase();
  return st && st.length <= 3 ? town + ', ' + st : town;
}

function demandSummary(roles) {
  const list = (Array.isArray(roles) ? roles : []).filter(function (r) {
    return r && (r.is_active === true || lower(r.job_status) === 'open') && lower(r.approval_status) !== 'rejected';
  });
  const states = counter(list.map(function (r) { return str(r.location_state).toUpperCase(); }), 8);
  const settings = { outer_metro: 0, regional_city: 0, regional_town: 0, unknown: 0 };
  const examples = { outer_metro: [], regional_city: [], regional_town: [] };
  list.forEach(function (r) {
    const k = roleSetting(r);
    settings[k] = (settings[k] || 0) + 1;
    const label = placeLabel(r, k === 'outer_metro');
    if (examples[k] && label && examples[k].indexOf(label) === -1 && examples[k].length < 8) examples[k].push(label);
  });
  const classified = settings.outer_metro + settings.regional_city + settings.regional_town;
  return {
    open_roles: list.length,
    by_state: states,
    // Share of the classifiable roles that are outside the capitals' suburbs.
    regional_pct: classified ? round(((settings.regional_city + settings.regional_town) / classified) * 100, 0) : null,
    settings: settings,
    where_examples: examples,
    note: 'DPA (Distribution Priority Area) is a Medicare shortage classification, not rural: outer_metro = suburbs of the capital cities, regional_city = Newcastle, Gold Coast, Toowoomba and the like, regional_town = country towns and remote. Choose each ad\'s photograph setting from this mix and from what has booked, and only say "regional" in copy when the roles are.',
    mixed_or_private_billing: list.filter(function (r) { return r.mixed_billing === true || r.private_billing === true || /mixed|private/i.test(str(r.billing_model)); }).length,
    visa_pathway_aligned: list.filter(function (r) { return r.visa_pathway_aligned === true; }).length
  };
}

// Everything the model should know about the funnel behind the ads.
function summariseEcosystem(input) {
  const i = input || {};
  const now = Number(i.now || Date.now());
  const facts = Array.isArray(i.leadFacts) ? i.leadFacts : enrichLeads(i);
  const calls = Array.isArray(i.calls) ? i.calls : [];
  const d30 = funnelFor(facts, now - 30 * DAY, now + DAY);
  const d7 = funnelFor(facts, now - 7 * DAY, now + DAY);

  const calls30 = calls.filter(function (c) { return ms(c.started_at || c.created_at) >= now - 30 * DAY; });
  const outcomes30 = calls30.map(function (c) { return lower(c.outcome); });
  const hazel = {
    calls_30d: calls30.length,
    spoke_30d: outcomes30.filter(function (o) { return SPOKE.indexOf(o) !== -1; }).length,
    voicemail_30d: outcomes30.filter(function (o) { return o === 'voicemail'; }).length,
    no_answer_30d: outcomes30.filter(function (o) { return o === 'no_answer' || o === 'failed'; }).length,
    booked_on_call_30d: outcomes30.filter(function (o) { return o === 'booked'; }).length,
    link_sent_30d: outcomes30.filter(function (o) { return o === 'link_sent'; }).length,
    callbacks_30d: outcomes30.filter(function (o) { return o === 'callback_requested'; }).length,
    not_interested_30d: outcomes30.filter(function (o) { return o === 'not_interested' || o === 'do_not_call'; }).length,
    median_duration_s: median(calls30.map(function (c) { return Number(c.duration_s); }).filter(function (n) { return n > 0; }))
  };
  const recent = facts.filter(function (l) { return ms(l.created_at) >= now - 30 * DAY; });
  const nudges = {
    leads_30d: recent.length,
    with_whatsapp: recent.filter(function (l) { return l.whatsapps_sent > 0; }).length,
    with_email: recent.filter(function (l) { return l.emails_sent > 0; }).length,
    replied: recent.filter(function (l) { return l.replied; }).length,
    owner_paged: recent.filter(function (l) { return l.owner_paged; }).length,
    stopped: counter(recent.map(function (l) { return l.stopped; }), 6)
  };
  const voices = recent.map(function (l) { return l.hazel; });
  const objections = {
    objections: counter(voices.map(function (h) { return h.objections; }), 8),
    lost_booking_reasons: counter(voices.map(function (h) { return h.lost_reason; }), 6),
    timeframes: counter(voices.map(function (h) { return h.timeframe; }), 6),
    gp_status: counter(voices.map(function (h) { return h.gp_status; }), 5),
    unanswered_questions: counter(voices.map(function (h) { return h.questions; }), 6),
    sentiment: counter(voices.map(function (h) { return h.sentiment; }), 4)
  };
  const posts = Array.isArray(i.posts) ? i.posts : [];
  const organic = {
    posted_last_7d: posts.filter(function (p) { return p.status === 'posted' && ms(p.publish_at) >= now - 7 * DAY; }).length,
    scheduled_next_7d: posts.filter(function (p) { return p.status === 'approved' && p.publish_at && ms(p.publish_at) >= now && ms(p.publish_at) <= now + 7 * DAY; }).length
  };
  return {
    automation: AUTOMATION,
    hazel: hazel,
    nudges: nudges,
    funnel_30d: Object.assign(withRates(d30.totals, i.spend30), { median_hours_to_book: d30.median_hours_to_book, booked_within_10min_pct: d30.booked_within_10min_pct, unattributed: d30.by_ad.unknown || null }),
    funnel_7d: Object.assign(withRates(d7.totals, i.spend7), { median_hours_to_book: d7.median_hours_to_book }),
    by_ad_30d: d30.by_ad,
    by_ad_7d: d7.by_ad,
    countries_30d: counter(recent.map(function (l) { return l.country; }), 5),
    voice_of_lead: objections,
    consult_themes: consultThemes(i.consults, now, 6),
    gp_questions: consultQuestions(i.consults, now),
    demand: demandSummary(i.roles),
    organic: organic
  };
}

// The per-ad block the page and the prompt show next to the Meta numbers.
function deepFunnelForAd(ecosystem, adId, metrics7, metrics30) {
  const e = ecosystem || {};
  const f7 = (e.by_ad_7d || {})[adId] || emptyFunnel();
  const f30 = (e.by_ad_30d || {})[adId] || emptyFunnel();
  return {
    d7: withRates(f7, metrics7 && metrics7.spend),
    d30: withRates(f30, metrics30 && metrics30.spend)
  };
}

module.exports = {
  AUTOMATION,
  SPOKE,
  PAGE_SIZE,
  readAllPages,
  isInternalLead,
  consultOutcome,
  enrichLeads,
  funnelFor,
  emptyFunnel,
  withRates,
  anonymise,
  consultThemes,
  consultQuestions,
  participantNames,
  GP_THEMES,
  demandSummary,
  roleSetting,
  summariseEcosystem,
  deepFunnelForAd,
  median,
  counter
};
