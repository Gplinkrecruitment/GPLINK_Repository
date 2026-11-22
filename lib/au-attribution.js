'use strict';

/**
 * WP-24 (Australian GP build): where a visitor came from. Pure, no I/O.
 * Read docs/au-gp/CONVENTIONS.md section 38 before changing it.
 *
 * The hops:
 *   1. js/site-attribution.js (public site pages, switch on only) writes a
 *      first-party cookie `gp_attr` holding a FIRST touch and a LAST touch:
 *      the campaign tags and click ids the visitor's own address carried, the
 *      page they landed on (path only) and the site they came from (host only).
 *   2. The server reads that cookie when a lead is stored and when an account
 *      is created, and NEVER trusts it: `recordFromCookie` re-validates every
 *      field, drops what is not a plain token and caps every length.
 *   3. `attributionForLead` turns a lead into "which campaign", from the Meta
 *      form id, the stored touches or nothing. No evidence = direct / unknown.
 *      A lead is never guessed into a campaign.
 *
 * Nothing here looks at the switch; callers do.
 */

const COOKIE_NAME = 'gp_attr';
const MAX_AGE_DAYS = 90;
const MAX_AGE_SEC = MAX_AGE_DAYS * 24 * 60 * 60;
const MAX_COOKIE_CHARS = 3600;

// Cookie key -> stored key, with the cap for each value.
const FIELDS = Object.freeze([
  ['s', 'utm_source', 80, 'text'],
  ['m', 'utm_medium', 80, 'text'],
  ['c', 'utm_campaign', 80, 'text'],
  ['n', 'utm_content', 80, 'text'],
  ['k', 'utm_term', 80, 'text'],
  ['fb', 'fbclid', 200, 'id'],
  ['g', 'gclid', 200, 'id'],
  ['p', 'landing_page', 120, 'path'],
  ['r', 'referrer', 80, 'host']
]);

/**
 * One value, cleaned. `text`: letters, digits, space and a few joiners (what a
 * campaign tag is made of). An "@" is never kept, so an email address pasted
 * into a tag cannot be stored as one. `id`: a click id. `path`: a site path
 * with no query string. `host`: a bare host name.
 */
function cleanValue(value, kind, cap) {
  let v = String(value == null ? '' : value);
  if (v.length > 2000) v = v.slice(0, 2000);
  if (kind === 'id') v = v.replace(/[^A-Za-z0-9_.-]/g, '');
  else if (kind === 'path') {
    v = v.split('?')[0].split('#')[0].replace(/[^A-Za-z0-9/_.-]/g, '');
    if (v.charAt(0) !== '/') v = '';
  } else if (kind === 'host') {
    v = v.toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split(':')[0].replace(/[^a-z0-9.-]/g, '');
  } else {
    // An address in a tag is never kept.
    if (v.indexOf('@') !== -1 || /%40/i.test(v)) return '';
    v = v.replace(/[^A-Za-z0-9 _.|:+~-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return v.slice(0, cap);
}

/** A touch as stored ({ utm_source, …, landing_page, referrer, at }), or null when empty. */
function sanitiseTouch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  FIELDS.forEach(function (f) {
    const v = raw[f[0]] !== undefined ? raw[f[0]] : raw[f[1]];
    const clean = cleanValue(v, f[3], f[2]);
    if (clean) out[f[1]] = clean;
  });
  if (!Object.keys(out).length) return null;
  const t = Number(raw.t !== undefined ? raw.t : (raw.at ? Date.parse(raw.at) / 1000 : NaN));
  // A time is kept only when it is a plausible one (2020 to 2100).
  if (Number.isFinite(t) && t > 1577836800 && t < 4102444800) out.at = new Date(Math.floor(t) * 1000).toISOString();
  return out;
}

function fromBase64Url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}
function toBase64Url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** The cookie's value -> { first, last } (either may be null), or null. Never throws. */
function decodeCookie(value) {
  const raw = String(value == null ? '' : value);
  if (!raw || raw.length > MAX_COOKIE_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed = null;
  try { parsed = JSON.parse(fromBase64Url(raw)); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const first = sanitiseTouch(parsed.f);
  const last = sanitiseTouch(parsed.l);
  if (!first && !last) return null;
  return { first: first, last: last };
}

/** For tests and tools: the cookie value the browser script would write. */
function encodeCookie(rec) {
  const short = function (touch) {
    if (!touch) return undefined;
    const o = {};
    FIELDS.forEach(function (f) { if (touch[f[1]]) o[f[0]] = touch[f[1]]; });
    if (touch.at) o.t = Math.floor(Date.parse(touch.at) / 1000);
    return o;
  };
  return toBase64Url(JSON.stringify({ v: 1, f: short(rec && rec.first), l: short(rec && rec.last) }));
}

/** What is stored on a lead or an account: { v, first, last, attached_at }, or null. */
function recordFromCookie(cookieValue, nowIso) {
  const got = decodeCookie(cookieValue);
  if (!got) return null;
  const rec = { v: 1 };
  if (got.first) rec.first = got.first;
  if (got.last) rec.last = got.last;
  rec.attached_at = nowIso || new Date().toISOString();
  return rec;
}

/** A stored record read back safely (a row may hold anything). */
function readRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const first = sanitiseTouch(value.first);
  const last = sanitiseTouch(value.last);
  if (!first && !last) return null;
  const rec = { v: 1 };
  if (first) rec.first = first;
  if (last) rec.last = last;
  if (value.attached_at && Number.isFinite(Date.parse(value.attached_at))) rec.attached_at = new Date(Date.parse(value.attached_at)).toISOString();
  return rec;
}

/** Keep the first touch already on file; take the newer last touch. */
function mergeRecords(existing, incoming) {
  const a = readRecord(existing);
  const b = readRecord(incoming);
  if (!a) return b;
  if (!b) return a;
  const rec = { v: 1 };
  const first = a.first || b.first;
  const last = b.last || a.last;
  if (first) rec.first = first;
  if (last) rec.last = last;
  rec.attached_at = a.attached_at || b.attached_at;
  return rec;
}

const PAID_MEDIUMS = ['paid', 'cpc', 'ppc', 'paid_social', 'paidsocial', 'paid-social', 'display', 'cpm', 'ads'];

/** Did this touch come from an ad? A click id, or a paid medium tag. */
function isPaidTouch(touch) {
  if (!touch) return false;
  if (touch.fbclid || touch.gclid) return true;
  return PAID_MEDIUMS.indexOf(String(touch.utm_medium || '').toLowerCase()) !== -1;
}

function platformOf(touch) {
  if (!touch) return '';
  const src = String(touch.utm_source || '').toLowerCase();
  if (touch.gclid || /google|adwords/.test(src)) return 'google';
  if (touch.fbclid || /facebook|instagram|meta|^fb$|^ig$/.test(src)) return 'meta';
  return src ? 'other' : '';
}

function pathMatches(pathname, prefix) {
  const p = String(pathname || '');
  const want = String(prefix || '');
  return !!want && (p === want || p.indexOf(want + '/') === 0);
}

/**
 * Which campaign a paid touch belongs to: a campaign whose tag list names the
 * touch's utm_campaign, else the campaign whose landing page it landed on.
 * Null when neither says: never a guess.
 */
function campaignForTouch(touch, campaigns) {
  if (!touch || !isPaidTouch(touch)) return null;
  const list = Array.isArray(campaigns) ? campaigns : [];
  const tag = String(touch.utm_campaign || '').toLowerCase();
  if (tag) {
    const byTag = list.find(function (c) {
      return (c.utmCampaigns || []).some(function (t) { return t && tag.indexOf(String(t).toLowerCase()) === 0; });
    });
    if (byTag) return byTag.key;
  }
  const byPage = list.find(function (c) { return pathMatches(touch.landing_page, c.landingPath); });
  return byPage ? byPage.key : null;
}

/**
 * Where a lead came from, for the hub and the Leads tab.
 * Returns { campaign: key | null, channel, platform, label }.
 *   channel: 'meta_lead_form' | 'paid' | 'referral' | 'direct'
 * `campaigns` is lib/ads-campaigns.js `adsCampaigns(...)`. The label is for
 * staff only.
 */
function attributionForLead(row, campaigns) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const meta = (row && row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  const labelOf = function (key) { const c = list.find(function (x) { return x.key === key; }); return c ? c.label : ''; };
  if (meta.source === 'meta_lead_ad') {
    // A lead from a Meta instant form: the form says which campaign. A form
    // no campaign lists is the existing campaign's (every Meta lead was,
    // before there were two).
    const formId = String(meta.fb_form_id || '').trim();
    const byForm = formId ? list.find(function (c) { return c.key !== 'overseas_uk' && (c.leadFormIds || []).indexOf(formId) !== -1; }) : null;
    const key = byForm ? byForm.key : 'overseas_uk';
    return { campaign: key, channel: 'meta_lead_form', platform: 'meta', label: (labelOf(key) || 'Meta campaign') + ' (Meta lead form)' };
  }
  const rec = readRecord(meta.attribution);
  // Rows stored before WP-24 (and with the switch off) carry only `utm`.
  const legacy = (!rec && meta.utm && typeof meta.utm === 'object') ? sanitiseTouch(meta.utm) : null;
  const touches = rec ? [rec.last, rec.first] : [legacy];
  for (let i = 0; i < touches.length; i++) {
    const t = touches[i];
    if (!t || !isPaidTouch(t)) continue;
    const key = campaignForTouch(t, list);
    const platform = platformOf(t) || 'other';
    const where = platform === 'google' ? 'Google ad' : (platform === 'meta' ? 'Meta ad' : 'paid ad');
    if (key) return { campaign: key, channel: 'paid', platform: platform, label: labelOf(key) + ' (' + where + ')' };
    return { campaign: null, channel: 'paid', platform: platform, label: 'Paid, campaign not known (' + where + (t.utm_campaign ? ': ' + t.utm_campaign : '') + ')' };
  }
  const any = touches.find(function (t) { return t && (t.utm_source || (t.referrer && !/mygplink\.com\.au$/.test(t.referrer))); });
  if (any) {
    return { campaign: null, channel: 'referral', platform: platformOf(any) || 'other', label: 'Not from an ad (' + (any.utm_source || any.referrer) + ')' };
  }
  return { campaign: null, channel: 'direct', platform: '', label: 'Direct / unknown' };
}

/**
 * The only thing a tracking event may say about a new account: 'australian'
 * or 'overseas'. From the lead's own segment when a lead is known, else from
 * the page the visitor first landed on. Unknown is 'overseas' (the default
 * for every doctor with nothing recorded).
 */
function trackingSegment(opts) {
  const o = opts || {};
  if (o.leadIsAu === true) return 'australian';
  if (o.leadIsAu === false) return 'overseas';
  const rec = readRecord(o.record);
  const touch = rec && (rec.first || rec.last);
  if (touch && pathMatches(touch.landing_page, '/australian-gps')) return 'australian';
  return 'overseas';
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_DAYS,
  MAX_AGE_SEC,
  MAX_COOKIE_CHARS,
  FIELDS,
  PAID_MEDIUMS,
  cleanValue,
  sanitiseTouch,
  decodeCookie,
  encodeCookie,
  recordFromCookie,
  readRecord,
  mergeRecords,
  isPaidTouch,
  platformOf,
  campaignForTouch,
  attributionForLead,
  trackingSegment
};
