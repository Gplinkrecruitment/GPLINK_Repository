'use strict';

/**
 * WP-15 overseas parity (Australian GP build).
 *
 * Walks an overseas doctor through the whole lead funnel on the real server
 * (local-JSON mode) and records everything a person or a later job would see:
 *
 *   the /start form payload  →  the HTTP answer  →  the stored row  →  the
 *   screening result  →  the owner's "New gp enquiry" email  →  the
 *   recognition answer the page gets on a return visit  →  the Leads tab row
 *
 * for a UK, an Irish, a New Zealand and a "Somewhere else" doctor, plus a
 * UK-trained doctor on an Australian (+61) number.
 *
 * tests/fixtures/au-wp15-overseas-parity.snapshot.json was produced by this
 * file on the tree BEFORE WP-15 changed any code (it has its own commit, ahead
 * of the code). tests/au-wp15-overseas-parity.test.js recomputes it and
 * demands equality. Never regenerate the fixture to make that test pass.
 *
 * Every identity is fake. Nothing is sent: the harness answers every outside
 * request itself, and this file only records what WOULD have gone to Resend.
 */

// What pages/site-start.html posted on the tree before WP-15 (the WP-10 page
// sends the browser zone on every submit).
const PEOPLE = [
  { key: 'uk', name: 'Dr Test Ukgp', email: 'uk.parity.wp15@gplink-test.local', phone: '+447700900215', country: 'uk', tz: 'Europe/London', question: 'How long does it take?' },
  { key: 'ie', name: 'Dr Test Iegp', email: 'ie.parity.wp15@gplink-test.local', phone: '+353870000215', country: 'ie', tz: 'Europe/Dublin', question: '' },
  { key: 'nz', name: 'Dr Test Nzgp', email: 'nz.parity.wp15@gplink-test.local', phone: '+64210000215', country: 'nz', tz: 'Pacific/Auckland', question: '' },
  { key: 'other', name: 'Dr Test Elsewhere', email: 'other.parity.wp15@gplink-test.local', phone: '+919800000215', country: 'other', tz: 'Asia/Kolkata', question: '' },
  // A UK-trained doctor on an Australian number who is NOT registered here:
  // an overseas lead today, and still one after WP-15 (the phone decides nothing).
  { key: 'uk_on_au_phone', name: 'Dr Test Ukabroad', email: 'ukau.parity.wp15@gplink-test.local', phone: '+61400000215', country: 'uk', tz: 'Australia/Perth', question: '' }
];

function formPayload(person, extra) {
  return Object.assign({
    name: person.name,
    email: person.email,
    phone: person.phone,
    country: person.country,
    question: person.question,
    website: '',
    utm: { utm_source: 'parity', utm_campaign: 'wp15' },
    tz: person.tz
  }, extra || {});
}

function clone(v) { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }

// Replace the values that differ on every run (ids, clocks, random tokens)
// with a marker that still says "there was one".
function scrubRow(row) {
  const r = clone(row);
  if (!r) return r;
  if (r.id) r.id = '<id>';
  if (r.created_at) r.created_at = '<time>';
  if (r.metadata) {
    if (r.metadata.ip) r.metadata.ip = '<ip>';
    const c = r.metadata.consult;
    if (c) {
      if (c.token) c.token = '<token>';
      if (c.landed_at) c.landed_at = '<time>';
      if (c.consent && c.consent.shown_at) c.consent.shown_at = '<time>';
    }
  }
  return r;
}

function scrubLeadRow(p) {
  const r = clone(p);
  if (!r) return r;
  if (r.id) r.id = '<id>';
  if (r.created_at) r.created_at = '<time>';
  // "Will Hazel ring, and when" moves with the clock on the wall. What does
  // not move is whether she is blocked and why.
  if (r.hazel) {
    r.hazel = { reason: r.hazel.reason, attempts: r.hazel.attempts, spoke: r.hazel.spoke, booked: r.hazel.booked, last: r.hazel.last };
  }
  if (r.stage) r.stage = { key: r.stage.key, label: r.stage.label };
  return r;
}

function scrubText(s, token, id) {
  let out = String(s == null ? '' : s);
  if (token) out = out.split(token).join('<token>');
  if (id) out = out.split(id).join('<id>');
  return out;
}

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

/**
 * @param h         the booted harness (tests/helpers/au-server-harness.js, local mode,
 *                  RESEND_API_KEY set so the owner alert is attempted)
 * @param opts.on   the switch for this pass
 * @param opts.extra(person) → extra body keys the page adds (after WP-15, switch on:
 *                  the "No" answer). Left out: the payload is exactly the old page's.
 * @param opts.tag  keeps e-mail addresses apart between passes on one server
 */
async function computeLeadParity(h, opts) {
  const o = opts || {};
  const out = {};
  const sent = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('api.resend.com') !== -1) {
      let body = null;
      try { body = JSON.parse(String(init && init.body)); } catch (e) { body = null; }
      sent.push(body);
      return Promise.resolve(new Response(JSON.stringify({ id: 'stub-' + sent.length }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return prevFetch(url, init);
  };
  h.setSwitch(o.on === true);
  let n = 0;
  try {
    for (const base of PEOPLE) {
      n += 1;
      const person = Object.assign({}, base, { email: base.email.replace('@', '.' + (o.tag || 'x') + '@') });
      const payload = formPayload(person, o.extra ? o.extra(person) : null);
      const ip = '10.15.' + (o.on ? 1 : 2) + '.' + (n + (o.ipBase || 0));
      sent.length = 0;
      const res = await h.post('/api/public/consult-lead', payload, { headers: { 'x-forwarded-for': ip, 'x-real-ip': ip, 'user-agent': 'wp15-parity' } });
      const db = h.readLocalDb();
      const row = (db.siteEnquiries || []).find((r) => r.email === person.email) || null;
      const token = row && row.metadata && row.metadata.consult && row.metadata.consult.token;
      const id = row && row.id;
      const emailTag = '.' + (o.tag || 'x') + '@';
      const untag = (s) => String(s == null ? '' : s).split(emailTag).join('@');
      const alerts = sent.map((m) => ({
        to: m && m.to, subject: untag(m && m.subject),
        html: untag(scrubText(m && m.html, token, id)), text: untag(scrubText(m && m.text, token, id))
      }));
      const cookie = cookieFrom(res);
      const me = await h.get('/api/public/consult-lead/me', { cookie });
      const admin = h.superAdmin();
      const list = await h.get('/api/ceo/leads?q=' + encodeURIComponent(person.email), { cookie: admin.cookie, host: admin.host });
      const leadRow = list.json && Array.isArray(list.json.leads) ? list.json.leads.find((l) => l.email === person.email) : null;
      const answer = clone(res.json);
      if (answer && answer.token) answer.token = '<token>';
      const meJson = clone(me.json);
      if (meJson && meJson.token) meJson.token = '<token>';
      const stored = scrubRow(row);
      out[base.key] = JSON.parse(untag(JSON.stringify({
        status: res.status,
        answer,
        stored,
        screening: stored && stored.metadata && stored.metadata.consult ? {
          qualified: stored.metadata.consult.qualified === true,
          screened_out: stored.metadata.consult.screened_out === true,
          country_unknown: stored.metadata.consult.country_unknown === true
        } : null,
        ownerAlerts: alerts,
        recognition: meJson,
        leadsTabRow: scrubLeadRow(leadRow)
      })));
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
  return out;
}

module.exports = { PEOPLE, formPayload, computeLeadParity, scrubRow, scrubLeadRow, cookieFrom };
