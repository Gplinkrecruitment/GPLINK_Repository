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

// ── the join ───────────────────────────────────────────────────────────────
// One record per Meta lead with everything the rest of the app recorded.
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
    const attended = consults.some(function (c) { return c.status === 'completed' || c.completed_at; });
    const noShow = consults.some(function (c) { return !!c.no_show_at; });
    const bookedAt = ms(consult.call_booked_at);
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
      booked: consult.call_booked === true || Number.isFinite(bookedAt),
      hours_to_book: Number.isFinite(bookedAt) ? round((bookedAt - created) / 3600000, 1) : null,
      attended: attended,
      no_show: noShow,
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
  return { leads: 0, qualified: 0, hazel_called: 0, hazel_spoke: 0, booked: 0, attended: 0, no_show: 0, signed_up: 0 };
}
function addToFunnel(f, l) {
  f.leads++;
  if (l.qualified) f.qualified++;
  if (l.hazel.attempts) f.hazel_called++;
  if (l.hazel.spoke) f.hazel_spoke++;
  if (l.booked) f.booked++;
  if (l.attended) f.attended++;
  if (l.no_show) f.no_show++;
  if (l.signed_up) f.signed_up++;
}
function withRates(f, spend) {
  const o = Object.assign({}, f);
  o.booking_rate_pct = f.leads ? round((f.booked / f.leads) * 100, 0) : null;
  o.attend_rate_pct = f.booked ? round((f.attended / f.booked) * 100, 0) : null;
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
function anonymise(text, email) {
  // Name tokens from the invitee's own address ("jane.smith84@…" → jane, smith)
  // catch the first-name-only mentions a "Dr X" rule cannot.
  const tokens = String(email || '').split('@')[0].split(/[._\-+\d]+/).filter(function (t) { return t.length >= 3; });
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

function demandSummary(roles) {
  const list = (Array.isArray(roles) ? roles : []).filter(function (r) {
    return r && (r.is_active === true || lower(r.job_status) === 'open') && lower(r.approval_status) !== 'rejected';
  });
  const states = counter(list.map(function (r) { return str(r.location_state).toUpperCase(); }), 8);
  return {
    open_roles: list.length,
    by_state: states,
    regional_pct: list.length ? round((list.filter(function (r) { return r.regional === true || r.metro === false; }).length / list.length) * 100, 0) : null,
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
  enrichLeads,
  funnelFor,
  emptyFunnel,
  withRates,
  anonymise,
  consultThemes,
  demandSummary,
  summariseEcosystem,
  deepFunnelForAd,
  median,
  counter
};
