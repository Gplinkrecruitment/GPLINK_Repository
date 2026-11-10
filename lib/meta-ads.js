'use strict';

// lib/meta-ads.js — the Meta Marketing API side of the CEO dashboard's Ads hub
// (Social tab). Reads the campaign (ad sets, ads, creatives, insights), joins
// the app's own booking funnel to each ad, flags ads against the owner's
// rotation rule, and creates new ads (image → creative → ad) when a draft is
// launched.
//
// Everything is pure except the functions that take a `fetchImpl`, which is
// injectable so the whole module is testable without a token. Creatives are
// immutable on Meta, so an ad's copy or image is never edited: a change is a
// new ad. The writes this module makes are "add a new ad to an existing ad
// set" (launchDraft) and, since 2026-11-06, status and daily-budget updates on
// an existing ad or ad set (setEntityStatus / setAdsetDailyBudget, used by
// lib/ads-actions.js for the review's ticked changes). Editing a lead-form ad
// set's other fields failed with error 1815089 in this account (see
// docs/superpowers/handovers/2026-09-29-meta-ads-restructure-and-booking-
// attribution-handover.md §8); explainMetaError() names that case.

const socialCampaign = require('./social-campaign.js');
const adsContext = require('./ads-context.js');

const GRAPH_BASE = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v21.0';

// The account as it stands on 2026-10-29. Every one of these is overridable
// from the environment; the defaults just mean nothing has to be configured
// before the page shows numbers.
const DEFAULTS = {
  accountId: '1668035273758338',   // GP Link ad account (AUD)
  pageId: '769864969547691',       // the Facebook Page the ads post as
  campaignId: '120248645727400648', // "GP Link UK | Cold · Warm · Hot | 14 Sep 2026"
  leadFormId: '2370693577080684',  // GP form whose ending opens app.mygplink.com.au/book (the fast slot picker, 2026-10-31); earlier forms sent people to calendly.com, which took 8-20 s or dead-ended inside Facebook
  adsetId: '120249238461470648',   // "Test | Pain points · before vs split – Copy" (the live ad set)
  timeZone: 'Australia/Melbourne',
  currency: 'AUD'
};

const WINDOWS = ['yesterday', 'last_7d', 'last_30d'];

// What Ads Manager calls "Book now" on a lead ad is BOOK_TRAVEL in the API —
// that is what every live ad in the account carries, so it is the default.
const CTA_OPTIONS = [
  { value: 'BOOK_TRAVEL', label: 'Book now' },
  { value: 'LEARN_MORE', label: 'Learn more' },
  { value: 'SIGN_UP', label: 'Sign up' },
  { value: 'APPLY_NOW', label: 'Apply now' },
  { value: 'GET_STARTED', label: 'Get started' },
  { value: 'CONTACT_US', label: 'Contact us' }
];

// The owner's Monday rotation rule (ADS-MANAGER-STEPS, 21 Oct 2026): pause an
// ad when its 7-day frequency is above 3, or its link-click-to-lead rate over
// 7 days is below 4%. The click floor stops a brand-new ad with 6 clicks and
// no lead yet being flagged as a failure.
const FLAG_FREQUENCY = 3;
const FLAG_CLICK_TO_LEAD_PCT = 4;
const FLAG_MIN_LINK_CLICKS = 25;
const FLAG_NO_LEAD_SPEND = 100;

// How many times the launcher tries one draft before parking it as 'failed'.
const MAX_LAUNCH_ATTEMPTS = 3;
// How long a 'launching' row counts as another runner's lock before the cron
// may take it over (a runner that died mid-way). Ten minutes is far longer
// than a launch takes (image, creative, ad: a few seconds).
const LAUNCH_LOCK_MS = 10 * 60 * 1000;

const URL_TAGS = 'utm_source=facebook&utm_medium=paid&utm_campaign={{ad.name}}';

// ── config ─────────────────────────────────────────────────────────────────
function digits(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s : '';
}

function adsConfig(env) {
  const e = env || process.env;
  const adsToken = String(e.META_ADS_ACCESS_TOKEN || '').trim();
  const capiToken = String(e.META_CAPI_ACCESS_TOKEN || '').trim();
  return {
    // A dedicated variable first; the CRM stage-feed token second, because it
    // is a System User token on the same Business and may already carry
    // ads_read. The page's health check says which one is in use and whether
    // it can actually read the account.
    token: adsToken || capiToken,
    tokenSource: adsToken ? 'META_ADS_ACCESS_TOKEN' : (capiToken ? 'META_CAPI_ACCESS_TOKEN' : null),
    accountId: digits(e.META_AD_ACCOUNT_ID) || DEFAULTS.accountId,
    pageId: digits(e.META_ADS_PAGE_ID) || digits(e.FB_PAGE_ID) || DEFAULTS.pageId,
    campaignId: digits(e.META_ADS_CAMPAIGN_ID) || DEFAULTS.campaignId,
    leadFormId: digits(e.META_LEAD_FORM_ID) || DEFAULTS.leadFormId,
    adsetId: digits(e.META_ADS_DEFAULT_ADSET_ID) || DEFAULTS.adsetId,
    // The creative's link. Meta refuses a lead-form ad whose link is a
    // Facebook Page ("Lead Generation ads should always link to external
    // content", 2026-11-04): it must be the advertiser's own site. The form is
    // what the button opens; the link is where Meta sends anyone who taps
    // elsewhere on the ad.
    leadLink: String(e.META_ADS_LEAD_LINK || '').trim() || ((String(e.PUBLIC_SITE_ORIGIN || '').trim() || 'https://www.mygplink.com.au').replace(/\/+$/, '') + '/'),
    graphBase: (String(e.META_ADS_GRAPH_URL || '').trim() || GRAPH_BASE).replace(/\/+$/, ''),
    graphVersion: String(e.META_ADS_API_VERSION || '').trim() || GRAPH_VERSION,
    timeZone: String(e.SOCIAL_TIMEZONE || '').trim() || DEFAULTS.timeZone,
    // Meta reports in the AD ACCOUNT's timezone (Sydney for this account), so
    // date ranges are computed there — the same "Dates are shown in Sydney
    // time" Ads Manager prints under its picker.
    accountTimeZone: String(e.META_ADS_ACCOUNT_TIMEZONE || '').trim() || 'Australia/Sydney',
    currency: DEFAULTS.currency,
    // Kill switch for the launcher: drafts still schedule, nothing is created.
    launchDisabled: String(e.ADS_LAUNCH_DISABLED || '').trim() === 'true'
  };
}

function configProblems(cfg) {
  const c = cfg || adsConfig();
  const out = [];
  if (!c.token) {
    out.push('META_ADS_ACCESS_TOKEN is not set (and META_CAPI_ACCESS_TOKEN is empty), so nothing can be read from the ad account.');
  }
  return out;
}

// ── numbers ────────────────────────────────────────────────────────────────
function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function round(n, dp) {
  const f = Math.pow(10, dp == null ? 2 : dp);
  return Math.round((Number(n) || 0) * f) / f;
}
// Budgets arrive in minor units ("10000" = AU$100.00).
function minorToMajor(v) { return round(num(v) / 100, 2); }

function actionCount(row, types) {
  const list = Array.isArray(row && row.actions) ? row.actions : [];
  for (let i = 0; i < types.length; i++) {
    const hit = list.find(function (a) { return a && a.action_type === types[i]; });
    if (hit) return num(hit.value);
  }
  return 0;
}

function emptyMetrics() {
  return {
    spend: 0, impressions: 0, reach: 0, frequency: 0, clicks: 0, link_clicks: 0,
    ctr: 0, link_ctr: 0, cpm: 0, leads: 0, cost_per_lead: null, click_to_lead_pct: null
  };
}

// One Insights row → the numbers the page shows. `lead` is Meta's own count
// of instant-form leads; the grouped on-site key is the fallback for older
// API versions that only report that one.
function normaliseInsightRow(row) {
  const r = row || {};
  const spend = round(num(r.spend), 2);
  const impressions = num(r.impressions);
  const reach = num(r.reach);
  const linkClicks = actionCount(r, ['link_click']);
  const leads = actionCount(r, ['lead', 'onsite_conversion.lead_grouped']);
  return {
    spend,
    impressions,
    reach,
    frequency: round(num(r.frequency) || (reach ? impressions / reach : 0), 2),
    clicks: num(r.clicks),
    link_clicks: linkClicks,
    ctr: round(num(r.ctr), 2),
    link_ctr: impressions ? round((linkClicks / impressions) * 100, 2) : 0,
    cpm: round(num(r.cpm), 2),
    leads,
    cost_per_lead: leads ? round(spend / leads, 2) : null,
    click_to_lead_pct: linkClicks ? round((leads / linkClicks) * 100, 1) : null
  };
}

function sumMetrics(list) {
  const t = emptyMetrics();
  (Array.isArray(list) ? list : []).forEach(function (m) {
    if (!m) return;
    t.spend += num(m.spend);
    t.impressions += num(m.impressions);
    t.reach += num(m.reach);
    t.clicks += num(m.clicks);
    t.link_clicks += num(m.link_clicks);
    t.leads += num(m.leads);
  });
  t.spend = round(t.spend, 2);
  t.frequency = t.reach ? round(t.impressions / t.reach, 2) : 0;
  t.ctr = t.impressions ? round((t.clicks / t.impressions) * 100, 2) : 0;
  t.link_ctr = t.impressions ? round((t.link_clicks / t.impressions) * 100, 2) : 0;
  t.cpm = t.impressions ? round((t.spend / t.impressions) * 1000, 2) : 0;
  t.cost_per_lead = t.leads ? round(t.spend / t.leads, 2) : null;
  t.click_to_lead_pct = t.link_clicks ? round((t.leads / t.link_clicks) * 100, 1) : null;
  return t;
}

// Percent change, or null when the base is zero (a jump from 0 is not a %).
function pctChange(now, before) {
  const a = num(now);
  const b = num(before);
  if (!b) return null;
  return round(((a - b) / b) * 100, 0);
}

// ── Graph transport ────────────────────────────────────────────────────────
function stringifyParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function graphRequest(method, path, params, opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const doFetch = o.fetchImpl || globalThis.fetch;
  const base = cfg.graphBase + '/' + cfg.graphVersion;
  const all = Object.assign({}, params || {}, { access_token: cfg.token });
  const body = new URLSearchParams();
  Object.keys(all).forEach(function (k) {
    const s = stringifyParam(all[k]);
    if (s !== null) body.append(k, s);
  });
  let url = base + path;
  const init = { method: method };
  if (method === 'GET') url += '?' + body.toString();
  else init.body = body;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, o.timeoutMs || 25000) : null;
  if (controller) init.signal = controller.signal;
  let r;
  try {
    r = await doFetch(url, init);
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, error: 'Could not reach Meta: ' + String((err && err.message) || err), network: true };
  }
  if (timer) clearTimeout(timer);
  let data = null;
  try { data = await r.json(); } catch (err) { data = null; }
  if (!r.ok || (data && data.error)) {
    const e = (data && data.error) || {};
    return {
      ok: false,
      status: r.status,
      error: e.message || ('HTTP ' + r.status),
      code: e.code,
      subcode: e.error_subcode,
      user_title: e.error_user_title,
      user_msg: e.error_user_msg,
      data: data
    };
  }
  return { ok: true, status: r.status, data: data || {} };
}

// GET with paging. Insights and edge lists page at `limit`; five pages is far
// more than this one-campaign account can produce, and bounds a runaway.
async function graphGetAll(path, params, opts, maxPages) {
  const pages = Math.max(1, maxPages || 5);
  const rows = [];
  let r = await graphRequest('GET', path, params, opts);
  if (!r.ok) return r;
  let page = 0;
  for (;;) {
    rows.push.apply(rows, Array.isArray(r.data && r.data.data) ? r.data.data : []);
    page++;
    const after = r.data && r.data.paging && r.data.paging.cursors && r.data.paging.cursors.after;
    const hasNext = !!(r.data && r.data.paging && r.data.paging.next);
    if (!hasNext || !after || page >= pages) break;
    r = await graphRequest('GET', path, Object.assign({}, params, { after: after }), opts);
    if (!r.ok) return r;
  }
  return { ok: true, data: rows };
}

// ── reads ──────────────────────────────────────────────────────────────────
const ADSET_FIELDS = 'id,name,status,effective_status,daily_budget,optimization_goal,learning_stage_info';
const AD_FIELDS = 'id,name,status,effective_status,adset_id,created_time,' +
  'creative{id,name,title,body,object_story_spec,image_url,thumbnail_url,image_hash,call_to_action_type}';
const INSIGHT_FIELDS = 'ad_id,ad_name,adset_id,adset_name,spend,impressions,reach,frequency,clicks,ctr,cpm,actions';
const DAILY_FIELDS = 'spend,impressions,reach,clicks,actions';

function fetchAdsets(opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/' + cfg.campaignId + '/adsets', { fields: ADSET_FIELDS, limit: 50 }, opts);
}
function fetchAds(opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/' + cfg.campaignId + '/ads', { fields: AD_FIELDS, limit: 100 }, opts);
}
function fetchAdInsights(preset, opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/' + cfg.campaignId + '/insights',
    { level: 'ad', fields: INSIGHT_FIELDS, date_preset: preset, limit: 200 }, opts);
}
// Campaign-level totals per window. Reach (and so frequency) is not additive
// across ads — the same person sees several — so the headline numbers come
// from Meta's own campaign row rather than a sum of the ad rows.
function fetchCampaignInsights(preset, opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/' + cfg.campaignId + '/insights',
    { fields: 'spend,impressions,reach,frequency,clicks,ctr,cpm,actions', date_preset: preset, limit: 5 }, opts);
}
function fetchDailySeries(opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/' + cfg.campaignId + '/insights',
    { fields: DAILY_FIELDS, time_increment: 1, date_preset: 'last_14d', limit: 100 }, opts);
}
// The account's automated rules (Ads Manager → Automated rules). Read so the
// snapshot can tell "switched off by the clock" from "paused by hand".
function fetchAdRules(opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/act_' + cfg.accountId + '/adrules_library', { fields: RULE_FIELDS, limit: 50 }, opts);
}
// The account's uploaded photographs, for the composer's "pick a photo" list.
function fetchImageLibrary(opts) {
  const cfg = (opts && opts.config) || adsConfig();
  return graphGetAll('/act_' + cfg.accountId + '/adimages',
    { fields: 'hash,name,url,width,height,created_time', limit: 60 }, opts, 2);
}

function creativeSummary(c) {
  const cr = c || {};
  const spec = cr.object_story_spec || {};
  const ld = spec.link_data || {};
  const cta = cr.call_to_action_type || (ld.call_to_action && ld.call_to_action.type) || '';
  const formId = digits(ld.call_to_action && ld.call_to_action.value && ld.call_to_action.value.lead_gen_form_id);
  return {
    // Which instant form this ad opens, so new ads can offer the same forms.
    lead_form_id: formId || '',
    link: String(ld.link || ''),
    id: String(cr.id || ''),
    name: String(cr.name || ''),
    headline: String(cr.title || ld.name || ''),
    primary_text: String(cr.body || ld.message || ''),
    description: String(cr.description || ld.description || ''),
    image_url: String(cr.image_url || ''),
    thumbnail_url: String(cr.thumbnail_url || ''),
    image_hash: String(cr.image_hash || ld.image_hash || ''),
    cta: String(cta),
    cta_label: ctaLabel(cta)
  };
}

function ctaLabel(type) {
  const hit = CTA_OPTIONS.find(function (o) { return o.value === type; });
  if (hit) return hit.label;
  return String(type || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, function (ch) { return ch.toUpperCase(); });
}

function learningSummary(info) {
  const i = info || {};
  return {
    status: i.status || null,
    exit_reason: i.exit_reason || null,
    last_edit_at: i.last_sig_edit_ts ? new Date(Number(i.last_sig_edit_ts) * 1000).toISOString() : null
  };
}

// ── the app's own funnel, joined by ad id ──────────────────────────────────
function funnelEmpty() { return { leads: 0, qualified: 0, booked: 0, signed_up: 0 }; }

function leadStages(row) {
  const meta = (row && row.metadata) || {};
  const c = meta.consult || {};
  return {
    qualified: c.qualified === true,
    booked: c.call_booked === true || !!c.call_booked_at,
    signed_up: !!(c.stopped === 'signed_up' || (row && row.status === 'converted'))
  };
}

function addToBucket(bucket, stages) {
  bucket.leads++;
  if (stages.qualified) bucket.qualified++;
  if (stages.booked) bucket.booked++;
  if (stages.signed_up) bucket.signed_up++;
}

// leadRows: site_enquiries rows (kind gp). Only Meta leads with an ad id count.
// Returns { by_ad: { adId: { d7, d30 } }, totals: { d7, d30 } }.
function funnelByAd(leadRows, opts) {
  const now = Number((opts && opts.now) || Date.now());
  const DAY = 86400000;
  const out = { by_ad: {}, totals: { d7: funnelEmpty(), d30: funnelEmpty() } };
  (Array.isArray(leadRows) ? leadRows : []).forEach(function (row) {
    const meta = (row && row.metadata) || {};
    if (meta.source !== 'meta_lead_ad') return;
    // Our own test fills are not ad results (same rule as adsContext.enrichLeads,
    // so "booked" on a card and in the deep funnel count the same leads).
    if (adsContext.isInternalLead(row)) return;
    const adId = digits(meta.fb_ad_id);
    const created = Date.parse(row.created_at || '');
    if (!Number.isFinite(created)) return;
    const age = now - created;
    if (age > 30 * DAY || age < 0) return;
    const stages = leadStages(row);
    const key = adId || 'unknown';
    if (!out.by_ad[key]) out.by_ad[key] = { d7: funnelEmpty(), d30: funnelEmpty() };
    addToBucket(out.by_ad[key].d30, stages);
    addToBucket(out.totals.d30, stages);
    if (age <= 7 * DAY) {
      addToBucket(out.by_ad[key].d7, stages);
      addToBucket(out.totals.d7, stages);
    }
  });
  return out;
}

function withCostPerBooking(funnel, metrics7, metrics30) {
  const f = funnel || { d7: funnelEmpty(), d30: funnelEmpty() };
  return {
    d7: Object.assign({}, f.d7, {
      // Null, not 0, when there was no spend in the window: a booking from an ad
      // that spent nothing this week is a lagging lead, not a free booking.
      cost_per_booking: (f.d7.booked && num(metrics7 && metrics7.spend)) ? round(num(metrics7.spend) / f.d7.booked, 2) : null
    }),
    d30: Object.assign({}, f.d30, {
      cost_per_booking: (f.d30.booked && num(metrics30 && metrics30.spend)) ? round(num(metrics30.spend) / f.d30.booked, 2) : null
    })
  };
}

// ── rotation flags ─────────────────────────────────────────────────────────
function daysSince(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Number(now || Date.now()) - t) / 86400000));
}

function rotationFlags(ad, now) {
  const m = (ad && ad.metrics && ad.metrics.last_7d) || emptyMetrics();
  const flags = [];
  if (!ad || !inRotation(ad)) return flags;
  const age = daysSince(ad.created_time, now);
  if (age !== null && age < 7) {
    flags.push({ code: 'new', level: 'info', label: 'Live ' + age + ' day' + (age === 1 ? '' : 's') + ', still settling' });
  }
  if (m.frequency > FLAG_FREQUENCY) {
    flags.push({ code: 'frequency', level: 'warn', label: 'Frequency ' + m.frequency + ' over 7 days (rule: pause above ' + FLAG_FREQUENCY + ')' });
  }
  if (m.link_clicks >= FLAG_MIN_LINK_CLICKS && m.click_to_lead_pct !== null && m.click_to_lead_pct < FLAG_CLICK_TO_LEAD_PCT) {
    flags.push({ code: 'click_to_lead', level: 'warn', label: 'Only ' + m.click_to_lead_pct + '% of link clicks became leads (rule: pause below ' + FLAG_CLICK_TO_LEAD_PCT + '%)' });
  }
  if (m.spend >= FLAG_NO_LEAD_SPEND && !m.leads) {
    flags.push({ code: 'no_leads', level: 'warn', label: 'AU$' + m.spend + ' spent in 7 days with no lead' });
  }
  return flags;
}

// ── automated rules (the "UK night off" / "UK morning on" clock) ───────────
// Meta's automated rules change the status of the object they target and
// nothing underneath it. The owner's two rules (account history 2026-11-05:
// "Ad set status updated … rule_info UK night off / UK morning on") switch
// ONE AD SET off at night and on in the morning, so between those times every
// ad under it reads ADSET_PAUSED and a plain effective_status === 'ACTIVE'
// count says 0. The nightly review (21:30 UTC) runs inside that window, so the
// stored snapshot the page opened with always said "0 live" — wrong for the
// owner, who wants to know how many ads are in rotation. An ad the owner
// pauses keeps its own status PAUSED; the rule never touches it, so it stays
// off when the ad set comes back on. Rotation, per ad:
//   live           delivering now (effective_status ACTIVE)
//   scheduled_off  its ad set is switched off by a time rule; comes back alone
//   review         pending Meta's review / still processing
//   issue          with issues / disapproved
//   parent_paused  ad set or campaign paused by hand (no rule will undo it)
//   paused         the ad itself is paused — a rule on the ad set never changes it
//   other          archived, deleted, anything else
// "In rotation" = live + scheduled_off: what the owner means by "running".
const RULE_FIELDS = 'id,name,status,evaluation_spec,execution_spec,schedule_spec,updated_time';
const STRUCTURAL_RULE_FIELDS = { entity_type: 1, id: 1, object_id: 1, 'campaign.id': 1, 'adset.id': 1, 'ad.id': 1, time_preset: 1, attribution_window: 1 };
const ROTATION_RANK = { live: 0, scheduled_off: 1, review: 2, issue: 3, parent_paused: 4, paused: 5, other: 6 };
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEK_MINUTES = 7 * 1440;

// One Graph rule row → what the snapshot keeps. A filter on anything but the
// object's identity (a metric, a status) makes the rule conditional: it checks
// something at that time rather than promising to switch.
function normaliseRule(r) {
  const row = r || {};
  const ev = row.evaluation_spec || {};
  const ex = row.execution_spec || {};
  const sc = row.schedule_spec || {};
  const out = {
    id: String(row.id || ''),
    name: String(row.name || ''),
    enabled: String(row.status || '').toUpperCase() === 'ENABLED',
    action: String(ex.execution_type || '').toUpperCase(),
    level: '',
    ids: [], adset_ids: [], campaign_ids: [],
    conditional: false,
    evaluation_type: String(ev.evaluation_type || '').toUpperCase(),
    schedule_type: String(sc.schedule_type || '').toUpperCase(),
    schedule: [],
    updated_time: row.updated_time || null
  };
  (Array.isArray(ev.filters) ? ev.filters : []).forEach(function (f) {
    const field = String((f && f.field) || '');
    const raw = f && f.value !== undefined && f.value !== null ? f.value : [];
    const vals = (Array.isArray(raw) ? raw : [raw]).map(function (v) { return String(v); });
    const idList = function () { return vals.map(digits).filter(Boolean); };
    if (field === 'entity_type') out.level = String(vals[0] || '').toUpperCase();
    else if (field === 'id' || field === 'object_id' || field === 'ad.id') out.ids = out.ids.concat(idList());
    else if (field === 'adset.id') out.adset_ids = out.adset_ids.concat(idList());
    else if (field === 'campaign.id') out.campaign_ids = out.campaign_ids.concat(idList());
    else if (!STRUCTURAL_RULE_FIELDS[field]) out.conditional = true;
  });
  (Array.isArray(sc.schedule) ? sc.schedule : []).forEach(function (s) {
    const start = Number(s && s.start_minute);
    if (!Number.isFinite(start)) return;
    const end = Number(s.end_minute);
    out.schedule.push({
      start_minute: start,
      end_minute: Number.isFinite(end) ? end : start,
      days: (Array.isArray(s.days) ? s.days : []).map(Number).filter(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; })
    });
  });
  return out;
}

// A time rule: enabled, switches on or off, has a clock, no metric condition.
function isSwitchRule(rule) {
  return !!(rule && rule.enabled && (rule.action === 'PAUSE' || rule.action === 'UNPAUSE') && rule.schedule.length && !rule.conditional);
}

// Does the rule apply to this object? entity = { kind: 'ADSET' | 'CAMPAIGN' | 'AD', id, campaign_id, adset_id }.
function ruleCovers(rule, entity) {
  const e = entity || {};
  const kind = String(e.kind || '').toUpperCase();
  if (rule.level && rule.level !== kind) return false;
  if (rule.ids.length) return rule.ids.indexOf(String(e.id)) !== -1;
  if (kind === 'ADSET' && rule.adset_ids.length) return rule.adset_ids.indexOf(String(e.id)) !== -1;
  if (kind === 'AD' && rule.adset_ids.length) return rule.adset_ids.indexOf(String(e.adset_id)) !== -1;
  if (kind === 'CAMPAIGN' && rule.campaign_ids.length) return rule.campaign_ids.indexOf(String(e.id)) !== -1;
  if (rule.campaign_ids.length) return rule.campaign_ids.indexOf(String(e.campaign_id)) !== -1;
  return !!rule.level; // every object of that kind on the account
}

// Day of week (0 = Sunday) and minute of the day of `ms` on the wall clock in `tz`.
function wallClock(ms, tz) {
  const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || 'UTC' }, opts)); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts)); }
  const p = {};
  fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { dow: DOW[p.weekday] || 0, minute: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

// Moves a candidate instant onto the target wall-clock minute when a clock
// change fell between now and then (it would be an hour out otherwise).
function settleMinute(ms, minute, tz) {
  let diff = minute - wallClock(ms, tz).minute;
  if (diff > 720) diff -= 1440; else if (diff < -720) diff += 1440;
  return (diff && Math.abs(diff) <= 180) ? ms + diff * 60000 : ms;
}

// The rule's next and previous firing around `now`, as epoch ms. Minutes are
// wall-clock minutes in the ad account's timezone (Ads Manager: "Sydney
// time"); days 0 = Sunday … 6 = Saturday, none = every day. Only the start
// minute matters for a switch rule ("at 07:30" has start = end).
function ruleFires(rule, nowMs, tz) {
  const now = wallClock(nowMs, tz);
  let next = null, prev = null;
  ((rule && rule.schedule) || []).forEach(function (s) {
    const days = s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    days.forEach(function (d) {
      const thisWeek = ((d - now.dow + 7) % 7) * 1440 + (s.start_minute - now.minute);
      const ahead = thisWeek > 0 ? thisWeek : thisWeek + WEEK_MINUTES;
      const behind = thisWeek <= 0 ? thisWeek : thisWeek - WEEK_MINUTES;
      if (next === null || ahead < next.delta) next = { delta: ahead, minute: s.start_minute };
      if (prev === null || behind > prev.delta) prev = { delta: behind, minute: s.start_minute };
    });
  });
  return {
    next_at: next ? settleMinute(nowMs + next.delta * 60000, next.minute, tz) : null,
    prev_at: prev ? settleMinute(nowMs + prev.delta * 60000, prev.minute, tz) : null
  };
}

// For one ad set (or campaign): the switch rules that cover it, when the next
// "on" and "off" fire, and what the clock says the status should be right now
// (null unless both halves of the cycle exist). A stored snapshot is re-read
// against the clock when the page opens, hours after the nightly run.
function scheduleFor(entity, rules, nowMs, tz) {
  const on = [], off = [];
  (Array.isArray(rules) ? rules : []).forEach(function (r) {
    if (!isSwitchRule(r) || !ruleCovers(r, entity)) return;
    const fires = ruleFires(r, nowMs, tz);
    (r.action === 'UNPAUSE' ? on : off).push({ id: r.id, name: r.name, at: fires.next_at, last_at: fires.prev_at });
  });
  if (!on.length && !off.length) return null;
  const iso = function (t) { return Number.isFinite(t) ? new Date(t).toISOString() : null; };
  const nextOf = function (list) { return list.filter(function (x) { return x.at !== null; }).sort(function (a, b) { return a.at - b.at; })[0] || null; };
  const lastOf = function (list) { return list.filter(function (x) { return x.last_at !== null; }).sort(function (a, b) { return b.last_at - a.last_at; })[0] || null; };
  const nextOn = nextOf(on), nextOff = nextOf(off), lastOn = lastOf(on), lastOff = lastOf(off);
  return {
    managed: true,
    on_rule: nextOn ? { id: nextOn.id, name: nextOn.name, at: iso(nextOn.at) } : null,
    off_rule: nextOff ? { id: nextOff.id, name: nextOff.name, at: iso(nextOff.at) } : null,
    last_on_at: iso(lastOn && lastOn.last_at),
    last_off_at: iso(lastOff && lastOff.last_at),
    expected_on: (lastOn && lastOff) ? lastOn.last_at > lastOff.last_at : null
  };
}

function adsetRotation(adset, schedule) {
  const a = adset || {};
  if (a.effective_status === 'ACTIVE') return 'live';
  if (a.effective_status === 'CAMPAIGN_PAUSED') return 'paused';
  if (a.effective_status === 'PAUSED' || a.status === 'PAUSED') {
    // Off while the clock says off (or only an "on" rule exists): the rule
    // brings it back. Off while the clock says on: somebody paused it by hand.
    if (schedule && schedule.on_rule && schedule.expected_on !== true) return 'scheduled_off';
    return 'paused';
  }
  return 'other';
}

function adRotation(ad, parentRotation) {
  const a = ad || {};
  const es = a.effective_status;
  if (es === 'ACTIVE') return 'live';
  if (a.status === 'PAUSED') return 'paused';
  if (es === 'ADSET_PAUSED' || es === 'CAMPAIGN_PAUSED') return parentRotation === 'scheduled_off' ? 'scheduled_off' : 'parent_paused';
  if (es === 'PENDING_REVIEW' || es === 'IN_PROCESS' || es === 'PREAPPROVED') return 'review';
  if (es === 'WITH_ISSUES' || es === 'DISAPPROVED') return 'issue';
  return 'other';
}

// Snapshots stored before rotation existed carry effective_status only.
function rotationOf(a) {
  if (a && a.rotation) return a.rotation;
  return a && a.effective_status === 'ACTIVE' ? 'live' : 'other';
}
function inRotation(a) {
  const r = rotationOf(a);
  return r === 'live' || r === 'scheduled_off';
}
function rotationRank(r) { return ROTATION_RANK[r] === undefined ? 6 : ROTATION_RANK[r]; }

function rotationCounts(ads) {
  const c = { live_ads: 0, scheduled_off_ads: 0, review_ads: 0, paused_ads: 0, rotation_ads: 0 };
  (Array.isArray(ads) ? ads : []).forEach(function (a) {
    const r = rotationOf(a);
    if (r === 'live') c.live_ads++;
    else if (r === 'scheduled_off') c.scheduled_off_ads++;
    else if (r === 'review') c.review_ads++;
    else c.paused_ads++;
  });
  c.rotation_ads = c.live_ads + c.scheduled_off_ads;
  return c;
}

// The one line the page and the Overview light print about the clock: the ad
// set that matters (off by the clock first, then live), its next on and off.
function scheduleSummary(adsets) {
  const managed = (Array.isArray(adsets) ? adsets : []).filter(function (a) { return a && a.schedule && a.schedule.managed; });
  if (!managed.length) return { managed: false };
  const lead = managed.find(function (a) { return a.rotation === 'scheduled_off'; }) ||
    managed.find(function (a) { return a.rotation === 'live'; }) || managed[0];
  const sc = lead.schedule;
  return {
    managed: true,
    state: lead.rotation === 'live' ? 'on' : lead.rotation === 'scheduled_off' ? 'off' : 'paused',
    adset_id: lead.id,
    adset_name: lead.name,
    on_rule: sc.on_rule,
    off_rule: sc.off_rule,
    expected_on: sc.expected_on,
    adsets: managed.map(function (a) {
      return { id: a.id, name: a.name, rotation: a.rotation, on_rule: a.schedule.on_rule, off_rule: a.schedule.off_rule };
    })
  };
}

function sortByRotation(ads) {
  ads.sort(function (a, b) {
    const r = rotationRank(rotationOf(a)) - rotationRank(rotationOf(b));
    if (r) return r;
    return num(b.metrics && b.metrics.last_7d && b.metrics.last_7d.spend) - num(a.metrics && a.metrics.last_7d && a.metrics.last_7d.spend);
  });
  return ads;
}

// A stored snapshot read hours later: the clock may have moved the managed ad
// set to the other side of its rules since the numbers were fetched. Returns a
// copy with the schedule, rotation and counts recomputed for `now`; metrics
// are untouched. Nothing changes without stored rules.
function rephaseSnapshot(snapshot, now) {
  const s = snapshot;
  if (!s || !Array.isArray(s.rules) || !s.rules.length || !Array.isArray(s.adsets)) return s;
  const nowMs = Number(now || Date.now());
  const tz = (s.account && s.account.account_time_zone) || 'Australia/Sydney';
  const campaignId = s.campaign && s.campaign.id;
  // "Hand pause or the clock?" is judged against the clock at the time the
  // statuses were read, not now: a set the rule switched off at 20:30 UK is
  // not a hand pause because it is 09:00 UK when the page opens.
  const fetchedMs = Date.parse(s.fetched_at || '');
  const readAt = Number.isFinite(fetchedMs) ? fetchedMs : nowMs;
  const rotById = {};      // rotation now
  const readRotById = {};  // rotation when the statuses were read
  const adsets = s.adsets.map(function (a) {
    const entity = { kind: 'ADSET', id: a.id, campaign_id: campaignId };
    const schedule = scheduleFor(entity, s.rules, nowMs, tz);
    const row = Object.assign({}, a, { schedule: schedule });
    const readRot = a.rotation || adsetRotation(a, scheduleFor(entity, s.rules, readAt, tz));
    let rot = readRot;
    // Both halves of the cycle known and the stored status was the clock's
    // doing (not a hand pause): follow the clock.
    if (schedule && schedule.on_rule && schedule.off_rule && schedule.expected_on !== null && (rot === 'live' || rot === 'scheduled_off')) {
      rot = schedule.expected_on ? 'live' : 'scheduled_off';
    }
    row.rotation = rot;
    rotById[row.id] = rot;
    readRotById[row.id] = readRot;
    return row;
  });
  const ads = (Array.isArray(s.ads) ? s.ads : []).map(function (a) {
    const key = String(a.adset_id || '');
    let rot = a.rotation || adRotation(a, readRotById[key]);
    const parent = rotById[key];
    if ((rot === 'live' || rot === 'scheduled_off') && (parent === 'live' || parent === 'scheduled_off')) rot = parent;
    return Object.assign({}, a, { rotation: rot });
  });
  sortByRotation(ads);
  return Object.assign({}, s, { adsets: adsets, ads: ads }, rotationCounts(ads), {
    schedule: scheduleSummary(adsets),
    rephased_at: new Date(nowMs).toISOString()
  });
}

// ── assembling the snapshot ────────────────────────────────────────────────
function indexInsights(rows) {
  const by = {};
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    if (r && r.ad_id) by[String(r.ad_id)] = normaliseInsightRow(r);
  });
  return by;
}

function dailyRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(function (r) {
    const m = normaliseInsightRow(r);
    return {
      date: String(r.date_start || ''),
      spend: m.spend, impressions: m.impressions, reach: m.reach,
      link_clicks: m.link_clicks, leads: m.leads,
      cost_per_lead: m.cost_per_lead
    };
  }).filter(function (d) { return d.date; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function assembleSnapshot(input) {
  const i = input || {};
  const cfg = i.config || adsConfig();
  const now = Number(i.now || Date.now());
  const ins = i.insights || {};
  const byWindow = {};
  WINDOWS.forEach(function (w) { byWindow[w] = indexInsights(ins[w]); });
  const funnel = funnelByAd(i.leadRows, { now: now });
  const rules = (Array.isArray(i.rules) ? i.rules : []).map(normaliseRule).filter(function (r) { return r.id; });
  const adsetById = {};
  const adsets = (Array.isArray(i.adsets) ? i.adsets : []).map(function (a) {
    const row = {
      id: String(a.id || ''),
      name: String(a.name || ''),
      status: a.status || '',
      effective_status: a.effective_status || '',
      daily_budget: minorToMajor(a.daily_budget),
      optimization_goal: a.optimization_goal || '',
      learning: learningSummary(a.learning_stage_info)
    };
    row.schedule = scheduleFor({ kind: 'ADSET', id: row.id, campaign_id: cfg.campaignId }, rules, now, cfg.accountTimeZone);
    row.rotation = adsetRotation(row, row.schedule);
    adsetById[row.id] = row;
    return row;
  });

  const ads = (Array.isArray(i.ads) ? i.ads : []).map(function (a) {
    const id = String(a.id || '');
    const metrics = {};
    WINDOWS.forEach(function (w) { metrics[w] = byWindow[w][id] || emptyMetrics(); });
    const ad = {
      id: id,
      name: String(a.name || ''),
      status: a.status || '',
      effective_status: a.effective_status || '',
      adset_id: String(a.adset_id || ''),
      adset_name: (adsetById[String(a.adset_id || '')] || {}).name || '',
      created_time: a.created_time || null,
      days_live: daysSince(a.created_time, now),
      creative: creativeSummary(a.creative),
      metrics: metrics,
      funnel: withCostPerBooking(funnel.by_ad[id], metrics.last_7d, metrics.last_30d)
    };
    // What happened AFTER the lead, per ad (Hazel, booked, attended, signed up),
    // when the server supplied the joined ecosystem.
    if (i.ecosystem) ad.deep = adsContext.deepFunnelForAd(i.ecosystem, id, metrics.last_7d, metrics.last_30d);
    ad.rotation = adRotation(ad, (adsetById[ad.adset_id] || {}).rotation);
    ad.flags = rotationFlags(ad, now);
    return ad;
  });
  sortByRotation(ads);

  const totals = {};
  const campaignRows = i.campaignInsights || {};
  WINDOWS.forEach(function (w) {
    const rows = Array.isArray(campaignRows[w]) ? campaignRows[w] : [];
    totals[w] = rows.length
      ? normaliseInsightRow(rows[0])
      : sumMetrics(Object.keys(byWindow[w]).map(function (k) { return byWindow[w][k]; }));
  });
  const daily = dailyRows(i.daily);
  // Previous week = the 7 days before the last 7, from the daily series, so the
  // page can say "leads are down 40% on last week" without a fourth call.
  const last7 = daily.slice(-7);
  const prior7 = daily.slice(-14, -7);
  const prior = sumMetrics(prior7);
  totals.prior_7d = prior;
  totals.week_on_week = {
    spend: pctChange(totals.last_7d.spend, prior.spend),
    leads: pctChange(totals.last_7d.leads, prior.leads),
    cost_per_lead: pctChange(totals.last_7d.cost_per_lead, prior.cost_per_lead),
    link_clicks: pctChange(totals.last_7d.link_clicks, prior.link_clicks)
  };
  // Yesterday against the trailing 7-day daily average: the "is today normal"
  // comparison the morning summary opens with.
  const avg7 = last7.length ? {
    spend: round(sumMetrics(last7).spend / last7.length, 2),
    leads: round(sumMetrics(last7).leads / last7.length, 1)
  } : { spend: 0, leads: 0 };
  totals.yesterday_vs_avg = {
    spend: pctChange(totals.yesterday.spend, avg7.spend),
    leads: pctChange(totals.yesterday.leads, avg7.leads),
    avg_spend: avg7.spend,
    avg_leads: avg7.leads
  };

  const funnelTotals = withCostPerBooking(funnel.totals, totals.last_7d, totals.last_30d);
  const unattributed = funnel.by_ad.unknown || null;
  const counts = rotationCounts(ads);

  return {
    fetched_at: new Date(now).toISOString(),
    account: { id: cfg.accountId, currency: cfg.currency, time_zone: cfg.timeZone, account_time_zone: cfg.accountTimeZone },
    ecosystem: i.ecosystem || null,
    lead_form_names: i.leadFormNames || {},
    campaign: { id: cfg.campaignId },
    adsets: adsets,
    ads: ads,
    // live_ads = delivering this minute; rotation_ads = live + switched off by
    // a time rule (the number the owner calls "running").
    live_ads: counts.live_ads,
    rotation_ads: counts.rotation_ads,
    scheduled_off_ads: counts.scheduled_off_ads,
    review_ads: counts.review_ads,
    paused_ads: counts.paused_ads,
    schedule: scheduleSummary(adsets),
    rules: rules,
    totals: totals,
    daily: daily,
    funnel: funnelTotals,
    funnel_unattributed: unattributed,
    errors: Array.isArray(i.errors) ? i.errors : []
  };
}

// Ten Graph calls (in parallel) → one snapshot. A failed insights window or
// rules read is reported in snapshot.errors and shows as zeros (or no
// schedule) rather than failing the whole page; a failed ads/adsets read is
// fatal because nothing can be drawn.
async function buildSnapshot(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const now = Number(o.now || Date.now());
  const problems = configProblems(cfg);
  if (problems.length) {
    return {
      ok: false,
      configured: false,
      problems: problems,
      snapshot: assembleSnapshot({ config: cfg, now: now, leadRows: o.leadRows, ecosystem: o.ecosystem || null, errors: problems })
    };
  }
  const callOpts = { config: cfg, fetchImpl: o.fetchImpl };
  const jobs = [
    fetchAdsets(callOpts),
    fetchAds(callOpts),
    fetchAdInsights('yesterday', callOpts),
    fetchAdInsights('last_7d', callOpts),
    fetchAdInsights('last_30d', callOpts),
    fetchDailySeries(callOpts),
    fetchCampaignInsights('yesterday', callOpts),
    fetchCampaignInsights('last_7d', callOpts),
    fetchCampaignInsights('last_30d', callOpts),
    fetchAdRules(callOpts)
  ];
  const settled = await Promise.all(jobs.map(function (p) {
    return p.then(function (r) { return r; }, function (err) {
      return { ok: false, error: String((err && err.message) || err) };
    });
  }));
  const [adsets, ads, y, d7, d30, daily, cy, c7, c30, rules] = settled;
  const errors = [];
  const failed = [];
  function take(r, label) {
    if (r && r.ok) return r.data;
    failed.push({ label: label, error: (r && r.error) || 'unknown error', code: r && r.code });
    return [];
  }
  const adsetRows = take(adsets, 'Ad sets');
  const adRows = take(ads, 'Ads');
  const ruleRows = take(rules, 'Automated rules');
  // Names of the instant forms the ads open, plus the configured default
  // (one batched read; a failure only costs the names, the ids still work).
  const formIds = {};
  if (cfg.leadFormId) formIds[cfg.leadFormId] = true;
  adRows.forEach(function (a) {
    const ld = a && a.creative && a.creative.object_story_spec && a.creative.object_story_spec.link_data;
    const id = digits(ld && ld.call_to_action && ld.call_to_action.value && ld.call_to_action.value.lead_gen_form_id);
    if (id) formIds[id] = true;
  });
  let leadFormNames = {};
  if (Object.keys(formIds).length) {
    const names = await fetchLeadFormNames(Object.keys(formIds), callOpts).catch(function () { return { ok: false }; });
    if (names && names.ok) leadFormNames = names.data;
  }
  const insights = {
    yesterday: take(y, 'Insights (yesterday)'),
    last_7d: take(d7, 'Insights (last 7 days)'),
    last_30d: take(d30, 'Insights (last 30 days)')
  };
  const dailyRowsRaw = take(daily, 'Daily series');
  const campaignInsights = {
    yesterday: take(cy, 'Campaign totals (yesterday)'),
    last_7d: take(c7, 'Campaign totals (last 7 days)'),
    last_30d: take(c30, 'Campaign totals (last 30 days)')
  };
  // Nine reads that fail for one reason (no ads_read on this token) used to
  // paint nine copies of Meta's paragraph. Group by message: one line per
  // distinct error, naming the reads it hit and the token that was used.
  const byMessage = {};
  failed.forEach(function (f) {
    const key = f.error + (f.code ? ' (code ' + f.code + ')' : '');
    if (!byMessage[key]) byMessage[key] = [];
    byMessage[key].push(f.label);
  });
  Object.keys(byMessage).forEach(function (key) {
    const labels = byMessage[key];
    errors.push((labels.length === jobs.length ? 'Every read' : labels.join(', ')) + ' failed: ' + key);
  });
  if (failed.length) errors.push('Token in use: ' + (cfg.tokenSource || 'none') + '.');
  const snapshot = assembleSnapshot({
    config: cfg, now: now, adsets: adsetRows, ads: adRows, rules: ruleRows, insights: insights,
    campaignInsights: campaignInsights, ecosystem: o.ecosystem || null,
    daily: dailyRowsRaw, leadRows: o.leadRows, errors: errors, leadFormNames: leadFormNames
  });
  const fatal = !(ads && ads.ok);
  return {
    ok: !fatal,
    configured: true,
    problems: errors,
    // A credential error on the FIRST read is the thing to tell the owner about.
    credential_error: !!(ads && !ads.ok && isCredentialError(ads)),
    permission_error: !!(ads && !ads.ok && isPermissionError(ads)),
    snapshot: snapshot
  };
}

function isCredentialError(r) {
  const m = String((r && r.error) || '').toLowerCase();
  return r && (r.code === 190 || m.indexOf('access token') !== -1 || m.indexOf('session has expired') !== -1);
}
// Meta's lead-ads terms error arrives as error_subcode 1815089 under a generic
// code 100 "Invalid parameter", with the real wording in error_user_title —
// so the subcode and the title are checked as well as the code and message.
function isTermsError(r) {
  const m = (String((r && r.error) || '') + ' ' + String((r && r.user_title) || '')).toLowerCase();
  return !!r && (Number(r.code) === 1815089 || Number(r.subcode) === 1815089 || m.indexOf('terms of service') !== -1);
}
function isPermissionError(r) {
  const m = String((r && r.error) || '').toLowerCase();
  return !!r && (r.code === 200 || r.code === 10 || r.code === 294 || isTermsError(r) ||
    m.indexOf('permission') !== -1 || m.indexOf('does not have') !== -1);
}

// ── date ranges (the Ads Manager picker) ───────────────────────────────────
// Presets mirror Meta's picker and are computed on the ACCOUNT's calendar
// (Sydney), because that is the day Meta's numbers are bucketed by.
const RANGE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'today_yesterday', label: 'Today and yesterday' },
  { key: 'last_7d', label: 'Last 7 days' },
  { key: 'last_14d', label: 'Last 14 days' },
  { key: 'last_28d', label: 'Last 28 days' },
  { key: 'last_30d', label: 'Last 30 days' },
  { key: 'this_week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' }
];
const INCREMENTS = ['1', '7', 'monthly'];

function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function ymdParts(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}
function isYmd(str) { return !!ymdParts(str) && Number.isFinite(Date.UTC(ymdParts(str).year, ymdParts(str).month - 1, ymdParts(str).day)); }
function shiftYmd(str, days) {
  const p = ymdParts(str);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function daysBetween(since, until) {
  const a = ymdParts(since); const b = ymdParts(until);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000) + 1;
}
function todayIn(tz, nowMs) {
  const p = socialCampaign.wallClockPartsInZone(new Date(nowMs || Date.now()), tz);
  return p ? ymd(p.year, p.month, p.day) : new Date(nowMs || Date.now()).toISOString().slice(0, 10);
}
// 0 = Monday … 6 = Sunday, for a Y-M-D string.
function weekday(str) { const p = ymdParts(str); return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7; }

function presetRange(key, nowMs, tz) {
  const t = todayIn(tz, nowMs);
  const p = ymdParts(t);
  const label = (RANGE_PRESETS.find(function (x) { return x.key === key; }) || {}).label || key;
  switch (key) {
    case 'today': return { since: t, until: t, label: label };
    case 'yesterday': return { since: shiftYmd(t, -1), until: shiftYmd(t, -1), label: label };
    case 'today_yesterday': return { since: shiftYmd(t, -1), until: t, label: label };
    case 'last_7d': return { since: shiftYmd(t, -7), until: shiftYmd(t, -1), label: label };
    case 'last_14d': return { since: shiftYmd(t, -14), until: shiftYmd(t, -1), label: label };
    case 'last_28d': return { since: shiftYmd(t, -28), until: shiftYmd(t, -1), label: label };
    case 'last_30d': return { since: shiftYmd(t, -30), until: shiftYmd(t, -1), label: label };
    case 'this_week': return { since: shiftYmd(t, -weekday(t)), until: t, label: label };
    case 'last_week': { const mon = shiftYmd(t, -weekday(t) - 7); return { since: mon, until: shiftYmd(mon, 6), label: label }; }
    case 'this_month': return { since: ymd(p.year, p.month, 1), until: t, label: label };
    case 'last_month': {
      const first = new Date(Date.UTC(p.year, p.month - 2, 1));
      const last = new Date(Date.UTC(p.year, p.month - 1, 0));
      return { since: ymd(first.getUTCFullYear(), first.getUTCMonth() + 1, 1), until: ymd(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()), label: label };
    }
    default: return null;
  }
}

// The period of the same length ending the day before `since`.
function comparePeriod(since, until) {
  const len = daysBetween(since, until);
  return { since: shiftYmd(since, -len), until: shiftYmd(since, -1) };
}

// Resolve what the picker sent into a clean range: a preset key, or since/until.
function resolveRange(input, nowMs, tz) {
  const i = input || {};
  if (i.preset) {
    const r = presetRange(String(i.preset), nowMs, tz);
    if (!r) return { ok: false, error: 'Unknown preset.' };
    return { ok: true, preset: String(i.preset), since: r.since, until: r.until, label: r.label, days: daysBetween(r.since, r.until) };
  }
  if (!isYmd(i.since) || !isYmd(i.until)) return { ok: false, error: 'since and until must be YYYY-MM-DD.' };
  if (i.since > i.until) return { ok: false, error: 'since is after until.' };
  const days = daysBetween(i.since, i.until);
  if (days > 370) return { ok: false, error: 'Pick at most a year.' };
  return { ok: true, preset: null, since: i.since, until: i.until, label: 'Custom', days: days };
}

// Local-midnight bounds of a Y-M-D range in the account's timezone, as UTC ms,
// so the app's lead rows (UTC) fall into the same days Meta counts.
function rangeBoundsMs(since, until, tz) {
  const a = ymdParts(since); const b = ymdParts(until);
  const start = socialCampaign.zonedWallTimeToUtc(a.year, a.month, a.day, 0, 0, tz).getTime();
  const endExclusive = socialCampaign.zonedWallTimeToUtc(b.year, b.month, b.day + 1, 0, 0, tz).getTime();
  return { start: start, end: endExclusive };
}

const CAMPAIGN_FIELDS = 'spend,impressions,reach,frequency,clicks,ctr,cpm,actions';

function fetchRangeInsights(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const params = {
    fields: o.level === 'ad' ? INSIGHT_FIELDS : CAMPAIGN_FIELDS,
    time_range: { since: o.since, until: o.until },
    limit: 500
  };
  if (o.level === 'ad') params.level = 'ad';
  if (o.increment && INCREMENTS.indexOf(String(o.increment)) !== -1) params.time_increment = String(o.increment);
  return graphGetAll('/' + cfg.campaignId + '/insights', params, o, 10);
}

function rangeFunnel(leadFacts, since, until, tz, spend) {
  const b = rangeBoundsMs(since, until, tz);
  const f = adsContext.funnelFor(leadFacts || [], b.start, b.end);
  return {
    totals: Object.assign(adsContext.withRates(f.totals, spend), { median_hours_to_book: f.median_hours_to_book, booked_within_10min_pct: f.booked_within_10min_pct }),
    by_ad: f.by_ad
  };
}

// One picker selection → everything the Performance card shows: totals for
// the range, the series at the chosen increment, the per-ad table with the
// app's funnel for the same days, and (optionally) the previous period of the
// same length with percentage changes. Five Graph calls at most, in parallel.
async function buildRangeReport(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const tz = cfg.accountTimeZone;
  const range = resolveRange(o, o.now, tz);
  if (!range.ok) return { ok: false, error: range.error };
  // Default step from the length: a day for up to two weeks, a week up to two
  // months, a month beyond — the same feel as Ads Manager's charts.
  const increment = INCREMENTS.indexOf(String(o.increment)) !== -1 ? String(o.increment) : (range.days >= 60 ? 'monthly' : (range.days > 14 ? '7' : '1'));
  const problems = configProblems(cfg);
  const adsMeta = o.adsMeta || {};
  const facts = Array.isArray(o.leadFacts) ? o.leadFacts : [];
  const cmp = o.compare ? comparePeriod(range.since, range.until) : null;

  function adsTable(rows, since, until) {
    const spendBy = {};
    const list = (rows || []).map(function (r) {
      const m = normaliseInsightRow(r);
      spendBy[String(r.ad_id)] = m.spend;
      const meta = adsMeta[String(r.ad_id)] || {};
      return { id: String(r.ad_id || ''), name: String(r.ad_name || meta.name || ''), headline: meta.headline || '', image_url: meta.image_url || '', status: meta.effective_status || '', metrics: m };
    });
    const fn = rangeFunnel(facts, since, until, tz, null);
    list.forEach(function (a) { a.funnel = adsContext.withRates(fn.by_ad[a.id] || adsContext.emptyFunnel(), spendBy[a.id]); });
    // Ads that had leads in the app but no delivery rows (a paused ad whose
    // leads still booked) are listed too, so bookings never vanish.
    Object.keys(fn.by_ad).forEach(function (id) {
      if (id === 'unknown' || list.some(function (a) { return a.id === id; })) return;
      const meta = adsMeta[id] || {};
      list.push({ id: id, name: meta.name || ('Ad ' + id), headline: meta.headline || '', image_url: meta.image_url || '', status: meta.effective_status || '', metrics: emptyMetrics(), funnel: adsContext.withRates(fn.by_ad[id], 0) });
    });
    list.sort(function (a, b) { return num(b.metrics.spend) - num(a.metrics.spend) || (b.funnel.booked - a.funnel.booked); });
    return { ads: list, unattributed: fn.by_ad.unknown || null };
  }

  const base = {
    ok: true, configured: !!cfg.token, time_zone: tz, increment: increment,
    range: { since: range.since, until: range.until, days: range.days, label: range.label, preset: range.preset },
    totals: emptyMetrics(), series: [], ads: [], funnel: rangeFunnel(facts, range.since, range.until, tz, 0).totals, unattributed: null,
    compare: null, deltas: null, errors: []
  };
  if (problems.length) { base.configured = false; base.errors = problems; base.ok = false; return base; }

  const callOpts = { config: cfg, fetchImpl: o.fetchImpl };
  const jobs = [
    fetchRangeInsights(Object.assign({ level: 'campaign', since: range.since, until: range.until }, callOpts)),
    fetchRangeInsights(Object.assign({ level: 'campaign', since: range.since, until: range.until, increment: increment }, callOpts)),
    fetchRangeInsights(Object.assign({ level: 'ad', since: range.since, until: range.until }, callOpts))
  ];
  if (cmp) {
    jobs.push(fetchRangeInsights(Object.assign({ level: 'campaign', since: cmp.since, until: cmp.until }, callOpts)));
    jobs.push(fetchRangeInsights(Object.assign({ level: 'ad', since: cmp.since, until: cmp.until }, callOpts)));
  }
  const settled = await Promise.all(jobs.map(function (p) { return p.then(function (r) { return r; }, function (err) { return { ok: false, error: String((err && err.message) || err) }; }); }));
  function take(r, label) {
    if (r && r.ok) return r.data;
    base.errors.push(label + ' failed: ' + ((r && r.error) || 'unknown error') + (r && r.code ? ' (code ' + r.code + ')' : ''));
    return [];
  }
  const totRows = take(settled[0], 'Totals');
  const serRows = take(settled[1], 'Series');
  const adRows = take(settled[2], 'Ads');
  base.totals = totRows.length ? normaliseInsightRow(totRows[0]) : sumMetrics(adRows.map(normaliseInsightRow));
  base.series = serRows.map(function (r) {
    const since = String(r.date_start || ''); const until = String(r.date_stop || '');
    const row = Object.assign({ since: since, until: until }, normaliseInsightRow(r));
    // The app's bookings for the same bucket, so the chart shows what the
    // spend actually produced, not just what Meta counted.
    if (isYmd(since) && isYmd(until)) {
      const f = rangeFunnel(facts, since, until, tz, row.spend).totals;
      row.booked = f.booked; row.attended = f.attended; row.signed_up = f.signed_up; row.app_leads = f.leads;
    }
    return row;
  }).sort(function (a, b) { return a.since < b.since ? -1 : 1; });
  const table = adsTable(adRows, range.since, range.until);
  base.ads = table.ads;
  base.unattributed = table.unattributed;
  base.funnel = rangeFunnel(facts, range.since, range.until, tz, base.totals.spend).totals;
  if (cmp) {
    const cTot = take(settled[3], 'Compare totals');
    const cAds = take(settled[4], 'Compare ads');
    const cTotals = cTot.length ? normaliseInsightRow(cTot[0]) : sumMetrics(cAds.map(normaliseInsightRow));
    const cTable = adsTable(cAds, cmp.since, cmp.until);
    const byId = {};
    cTable.ads.forEach(function (a) { byId[a.id] = { metrics: a.metrics, funnel: a.funnel }; });
    base.compare = {
      range: { since: cmp.since, until: cmp.until, days: range.days },
      totals: cTotals,
      funnel: rangeFunnel(facts, cmp.since, cmp.until, tz, cTotals.spend).totals,
      ads_by_id: byId
    };
    base.deltas = {
      spend: pctChange(base.totals.spend, cTotals.spend),
      impressions: pctChange(base.totals.impressions, cTotals.impressions),
      reach: pctChange(base.totals.reach, cTotals.reach),
      link_clicks: pctChange(base.totals.link_clicks, cTotals.link_clicks),
      leads: pctChange(base.totals.leads, cTotals.leads),
      cost_per_lead: pctChange(base.totals.cost_per_lead, cTotals.cost_per_lead),
      frequency: pctChange(base.totals.frequency, cTotals.frequency),
      booked: pctChange(base.funnel.booked, base.compare.funnel.booked),
      attended: pctChange(base.funnel.attended, base.compare.funnel.attended),
      signed_up: pctChange(base.funnel.signed_up, base.compare.funnel.signed_up),
      cost_per_booking: pctChange(base.funnel.cost_per_booking, base.compare.funnel.cost_per_booking)
    };
  }
  base.ok = !!(settled[2] && settled[2].ok);
  return base;
}

// ── health check: what can this token actually do? ─────────────────────────
// Read before write, and say which one failed. The owner cannot see Vercel's
// env from the dashboard, so this is how they find out whether the token they
// pasted carries ads_read, ads_management and pages_manage_ads.
async function checkHealth(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const out = { configured: !!cfg.token, token_source: cfg.tokenSource, checks: [], can_read: false, can_write: null, granted: [] };
  if (!cfg.token) {
    out.checks.push({ key: 'token', ok: false, detail: configProblems(cfg)[0] });
    return out;
  }
  const callOpts = { config: cfg, fetchImpl: o.fetchImpl };
  const acct = await graphRequest('GET', '/act_' + cfg.accountId, { fields: 'id,name,currency,account_status' }, callOpts);
  out.checks.push({
    key: 'account',
    ok: !!acct.ok,
    detail: acct.ok
      ? ('Reads ad account ' + (acct.data.name || cfg.accountId) + ' (' + (acct.data.currency || '') + ')')
      : ('Cannot read the ad account: ' + acct.error + (acct.code ? ' (code ' + acct.code + ')' : ''))
  });
  const ins = await graphRequest('GET', '/act_' + cfg.accountId + '/insights', { fields: 'spend', date_preset: 'yesterday' }, callOpts);
  out.checks.push({
    key: 'insights',
    ok: !!ins.ok,
    detail: ins.ok ? 'Reads performance (ads_read)' : ('Cannot read performance: ' + ins.error + (ins.code ? ' (code ' + ins.code + ')' : ''))
  });
  out.can_read = !!(acct.ok && ins.ok);

  const perms = await graphRequest('GET', '/me/permissions', {}, callOpts);
  if (perms.ok && Array.isArray(perms.data.data)) {
    out.granted = perms.data.data.filter(function (p) { return p && p.status === 'granted'; }).map(function (p) { return p.permission; });
    const need = ['ads_management', 'pages_manage_ads'];
    const missing = need.filter(function (p) { return out.granted.indexOf(p) === -1; });
    out.can_write = missing.length === 0;
    out.checks.push({
      key: 'write',
      ok: out.can_write,
      detail: out.can_write
        ? 'Can create ads (ads_management + pages_manage_ads granted)'
        : ('Creating ads needs ' + missing.join(' and ') + ' on this token; launches will fall back to the manual kit until then')
    });
  } else {
    out.checks.push({
      key: 'write',
      ok: null,
      detail: 'Could not list the token\'s permissions (' + ((perms && perms.error) || 'unknown') + '); whether it can create ads will only be known at the first launch'
    });
  }
  const page = await graphRequest('GET', '/' + cfg.pageId, { fields: 'id,name' }, callOpts);
  out.checks.push({
    key: 'page',
    ok: !!page.ok,
    detail: page.ok ? ('Sees the Page ' + (page.data.name || cfg.pageId)) : ('Cannot see the Page ' + cfg.pageId + ': ' + page.error)
  });
  return out;
}

// ── creating an ad from a draft ────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function launchName(draft) {
  const d = draft || {};
  return slugify(d.angle) || slugify(d.headline) || ('ad-' + String(d.id || '').slice(0, 8));
}

// Hard stops before any Meta call. Lengths are Meta's own ceilings; the
// recommended lengths (headline ≤ 40, primary text ≤ 125 before the fold) are
// warnings on the page, not blockers.
function draftProblems(draft) {
  const d = draft || {};
  const out = [];
  if (!String(d.headline || '').trim()) out.push('Headline is empty.');
  if (!String(d.primary_text || '').trim()) out.push('Primary text is empty.');
  if (String(d.headline || '').length > 255) out.push('Headline is over 255 characters.');
  if (String(d.description || '').length > 255) out.push('Description is over 255 characters.');
  if (!d.image_path) out.push('No creative image yet — compose one (photo + headline) first.');
  const w = num(d.image_width);
  const h = num(d.image_height);
  if (w && h && Math.round((w / h) * 100) / 100 !== 0.8) {
    out.push('The creative is ' + w + 'x' + h + '; the feed format is 1080x1350 (4:5).');
  }
  if (!CTA_OPTIONS.some(function (o) { return o.value === d.cta; })) out.push('Call to action is not one of the supported types.');
  if (!digits(d.adset_id)) out.push('No ad set chosen.');
  return out;
}

function draftWarnings(draft) {
  const d = draft || {};
  const out = [];
  const fields = ['headline', 'primary_text', 'description', 'image_headline', 'image_sub'];
  fields.forEach(function (f) {
    if (String(d[f] || '').indexOf('—') !== -1) out.push(capitalise(f.replace('_', ' ')) + ' contains an em dash, which the brand rules exclude.');
  });
  if (String(d.headline || '').length > 40) out.push('Headline is over 40 characters and may be cut short in the feed.');
  // 40, not Meta's "30 recommended": the house description "UK-trained GPs.
  // Free 30-minute call." is 36 characters and runs on every live ad.
  if (String(d.description || '').length > 40) out.push('Description is over 40 characters; Facebook feed often hides it anyway.');
  if (/\[[^\]]+\]/.test(String(d.primary_text || '') + String(d.headline || ''))) out.push('Copy still contains a [placeholder].');
  if (!/completely free for doctors/i.test(String(d.primary_text || ''))) out.push('Primary text does not end with the house closer "Completely free for doctors."');
  return out;
}
function capitalise(s) { return String(s || '').replace(/^\w/, function (c) { return c.toUpperCase(); }); }

async function uploadImage(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const bytes = o.bytes;
  if (!bytes || !bytes.length) return { ok: false, error: 'No image bytes to upload.' };
  const r = await graphRequest('POST', '/act_' + cfg.accountId + '/adimages', {
    bytes: Buffer.from(bytes).toString('base64'),
    name: o.name || 'gp-link-creative.jpg'
  }, { config: cfg, fetchImpl: o.fetchImpl, timeoutMs: 60000 });
  if (!r.ok) return r;
  const images = (r.data && r.data.images) || {};
  const first = images[Object.keys(images)[0]] || {};
  if (!first.hash) return { ok: false, error: 'Meta accepted the image but returned no hash.' };
  return { ok: true, hash: String(first.hash), url: String(first.url || '') };
}

function objectStorySpec(draft, cfg, imageHash) {
  return {
    page_id: cfg.pageId,
    link_data: {
      image_hash: imageHash,
      link: cfg.leadLink,
      message: String(draft.primary_text || ''),
      name: String(draft.headline || ''),
      description: String(draft.description || ''),
      call_to_action: {
        type: String(draft.cta || 'BOOK_TRAVEL'),
        // The form chosen on the card, else the configured default (the fast
        // slot-picker form; see DEFAULTS.leadFormId).
        value: { lead_gen_form_id: digits(draft.layout && draft.layout.lead_form_id) || cfg.leadFormId }
      }
    }
  };
}

async function createCreative(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const r = await graphRequest('POST', '/act_' + cfg.accountId + '/adcreatives', {
    name: launchName(o.draft) + ' ' + new Date(o.now || Date.now()).toISOString().slice(0, 10),
    object_story_spec: objectStorySpec(o.draft || {}, cfg, o.imageHash)
  }, { config: cfg, fetchImpl: o.fetchImpl });
  if (!r.ok) return r;
  if (!r.data || !r.data.id) return { ok: false, error: 'Meta accepted the creative but returned no id.' };
  return { ok: true, id: String(r.data.id) };
}

async function createAd(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const d = o.draft || {};
  const r = await graphRequest('POST', '/act_' + cfg.accountId + '/ads', {
    name: launchName(d),
    adset_id: digits(d.adset_id) || cfg.adsetId,
    creative: { creative_id: String(o.creativeId) },
    status: o.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    url_tags: URL_TAGS
  }, { config: cfg, fetchImpl: o.fetchImpl });
  if (!r.ok) return r;
  if (!r.data || !r.data.id) return { ok: false, error: 'Meta accepted the ad but returned no id.' };
  return { ok: true, id: String(r.data.id) };
}

// Whether a failed Meta call is worth retrying unchanged: network trouble,
// a 5xx, or one of Meta's own "try again" codes. A rejected field is not.
const TRANSIENT_CODES = [1, 2, 4, 17, 32, 613, 80004];
function isTransientError(r) {
  const e = r || {};
  if (e.network) return true;
  if (Number(e.status) >= 500) return true;
  return TRANSIENT_CODES.indexOf(Number(e.code)) !== -1;
}

// The instant forms the campaign's ads open, most used by live ads first:
// [{ id, name, live_ads, ads }]. Names come from snapshot.lead_form_names.
function liveLeadForms(snapshot) {
  const by = {};
  ((snapshot && snapshot.ads) || []).forEach(function (a) {
    const id = a && a.creative && digits(a.creative.lead_form_id);
    if (!id) return;
    if (!by[id]) by[id] = { id: id, live_ads: 0, ads: 0, name: '' };
    by[id].ads++;
    if (inRotation(a)) by[id].live_ads++;
  });
  const names = (snapshot && snapshot.lead_form_names) || {};
  return Object.keys(by).map(function (id) { return Object.assign(by[id], { name: String(names[id] || '') }); })
    .sort(function (a, b) { return b.live_ads - a.live_ads || b.ads - a.ads; });
}

// Form names, one read per form in parallel (the batched `?ids=` read is
// deprecated from Graph v26). A form that cannot be read keeps its id only.
async function fetchLeadFormNames(ids, opts) {
  const list = (Array.isArray(ids) ? ids : []).map(digits).filter(Boolean).slice(0, 12);
  if (!list.length) return { ok: true, data: {} };
  const reads = await Promise.all(list.map(function (id) {
    return graphRequest('GET', '/' + id, { fields: 'name,status' }, opts).catch(function () { return { ok: false }; });
  }));
  const out = {};
  reads.forEach(function (r, i) { if (r && r.ok && r.data && r.data.name) out[list[i]] = String(r.data.name); });
  return { ok: true, data: out };
}

// Plain-English version of a Meta error, with the one thing to do about it.
function explainMetaError(r) {
  const e = r || {};
  const code = Number(e.code);
  const msg = String(e.error || '');
  if (isTermsError(e)) {
    return 'Meta\'s lead-ads terms check refused this token (error 1815089). The Page has accepted the terms, but the token cannot see that: it needs pages_manage_ads on the Page, granted to the System User in Business Settings. Until then, add the ad by hand in Ads Manager with the manual kit below.';
  }
  if (code === 190 || /access token/i.test(msg)) {
    return 'The Meta token was rejected (' + msg + '). Re-mint META_ADS_ACCESS_TOKEN as a System User token with ads_read, ads_management and pages_manage_ads, then try again.';
  }
  if (code === 200 || code === 10 || code === 294 || /permission/i.test(msg)) {
    return 'The token lacks a permission (' + msg + '). It needs ads_management on the ad account and pages_manage_ads on the Page.';
  }
  if (code === 100) {
    return 'Meta rejected a field (' + msg + (e.user_msg ? ' — ' + e.user_msg : '') + '). Check the copy lengths, the image, and that the ad set still exists.';
  }
  if (e.network) return msg + ' The launcher will retry on its next run.';
  return msg + (e.user_msg ? ' — ' + e.user_msg : '');
}

// ── writes on existing entities ────────────────────────────────────────────
// POST /{id} with the field to change; Meta answers { success: true }. Used
// for the review's ticked changes (lib/ads-actions.js), never for creatives.
async function setEntityStatus(id, status, opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const target = digits(id);
  if (!target) return { ok: false, error: 'No Meta id to update.' };
  const want = status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
  const r = await graphRequest('POST', '/' + target, { status: want }, { config: cfg, fetchImpl: o.fetchImpl });
  if (!r.ok) return r;
  if (!r.data || r.data.success !== true) return { ok: false, error: 'Meta did not confirm the status change.', data: r.data };
  return { ok: true, id: target, status: want };
}

// Daily budget in the account currency (major units); Meta takes minor units.
async function setAdsetDailyBudget(id, amount, opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const target = digits(id);
  if (!target) return { ok: false, error: 'No ad set id to update.' };
  const cents = Math.round(num(amount) * 100);
  if (!(cents > 0)) return { ok: false, error: 'The daily budget must be above zero.' };
  const r = await graphRequest('POST', '/' + target, { daily_budget: cents }, { config: cfg, fetchImpl: o.fetchImpl });
  if (!r.ok) return r;
  if (!r.data || r.data.success !== true) return { ok: false, error: 'Meta did not confirm the budget change.', data: r.data };
  return { ok: true, id: target, daily_budget: cents / 100 };
}

// The campaign as it stands right now, for the executor's checks: ad sets and
// ads with their statuses (budgets in major units), nothing else.
async function fetchLiveState(opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  if (!cfg.token) return { ok: false, error: configProblems(cfg)[0] };
  const call = { config: cfg, fetchImpl: o.fetchImpl };
  const now = Number(o.now || Date.now());
  // The clock rules ride along so a check can tell "off for the night" from
  // "paused by hand"; losing that read only loses the distinction.
  const got = await Promise.all([fetchAdsets(call), fetchAds(call),
    fetchAdRules(call).then(function (r) { return r; }, function () { return { ok: false }; })]);
  if (!got[0].ok) return { ok: false, error: explainMetaError(got[0]), raw: got[0] };
  if (!got[1].ok) return { ok: false, error: explainMetaError(got[1]), raw: got[1] };
  const rules = got[2] && got[2].ok ? (Array.isArray(got[2].data) ? got[2].data : []).map(normaliseRule).filter(function (r) { return r.id; }) : [];
  const adsets = got[0].data.map(function (a) {
    const row = { id: String(a.id || ''), name: String(a.name || ''), status: a.status || '', effective_status: a.effective_status || '', daily_budget: minorToMajor(a.daily_budget) };
    row.schedule = scheduleFor({ kind: 'ADSET', id: row.id, campaign_id: cfg.campaignId }, rules, now, cfg.accountTimeZone);
    row.rotation = adsetRotation(row, row.schedule);
    return row;
  });
  const byId = {};
  adsets.forEach(function (s) { byId[s.id] = s; });
  const ads = got[1].data.map(function (a) {
    const adsetId = String(a.adset_id || '');
    const row = { id: String(a.id || ''), name: String(a.name || ''), status: a.status || '', effective_status: a.effective_status || '', adset_id: adsetId, adset_name: (byId[adsetId] || {}).name || '', headline: (a.creative && (a.creative.title || a.creative.name)) || '' };
    row.rotation = adRotation(row, (byId[adsetId] || {}).rotation);
    return row;
  });
  return { ok: true, adsets: adsets, ads: ads, rules: rules, schedule: scheduleSummary(adsets), fetched_at: new Date(now).toISOString() };
}

// Resume-able launch: whichever ids the draft already carries are reused, so
// a retry after a failure on step 3 never uploads the image or creates the
// creative a second time. Returns the patch to write on the draft either way.
async function launchDraft(draft, opts) {
  const o = opts || {};
  const cfg = o.config || adsConfig();
  const d = draft || {};
  const now = o.now || Date.now();
  const patch = {
    launch_attempts: (num(d.launch_attempts) || 0) + 1,
    last_launch_attempt_at: new Date(now).toISOString()
  };
  const problems = draftProblems(d);
  if (problems.length) {
    return { ok: false, step: 'validate', error: problems.join(' '), patch: Object.assign(patch, { launch_error: problems.join(' ') }) };
  }
  if (!cfg.token) {
    const err = configProblems(cfg)[0];
    return { ok: false, step: 'config', error: err, patch: Object.assign(patch, { launch_error: err }) };
  }
  if (cfg.launchDisabled) {
    const err = 'ADS_LAUNCH_DISABLED is true, so nothing is created on Meta.';
    return { ok: false, step: 'config', held: true, error: err, patch: Object.assign(patch, { launch_error: err }) };
  }
  const callOpts = { config: cfg, fetchImpl: o.fetchImpl, now: now };

  let imageHash = String(d.meta_image_hash || '');
  if (!imageHash) {
    const up = await uploadImage(Object.assign({}, callOpts, { bytes: o.imageBytes, name: launchName(d) + '.jpg' }));
    if (!up.ok) {
      const msg = explainMetaError(up);
      return { ok: false, step: 'image', error: msg, raw: up, transient: isTransientError(up), patch: Object.assign(patch, { launch_error: 'Image upload: ' + msg }) };
    }
    imageHash = up.hash;
    patch.meta_image_hash = imageHash;
  }

  let creativeId = String(d.meta_creative_id || '');
  if (!creativeId) {
    const cr = await createCreative(Object.assign({}, callOpts, { draft: d, imageHash: imageHash }));
    if (!cr.ok) {
      const msg = explainMetaError(cr);
      return { ok: false, step: 'creative', error: msg, raw: cr, transient: isTransientError(cr), patch: Object.assign(patch, { launch_error: 'Creative: ' + msg }) };
    }
    creativeId = cr.id;
    patch.meta_creative_id = creativeId;
  }

  let adId = String(d.meta_ad_id || '');
  if (!adId) {
    const ad = await createAd(Object.assign({}, callOpts, { draft: d, creativeId: creativeId, status: o.status }));
    if (!ad.ok) {
      const msg = explainMetaError(ad);
      return { ok: false, step: 'ad', error: msg, raw: ad, transient: isTransientError(ad), patch: Object.assign(patch, { launch_error: 'Ad: ' + msg }) };
    }
    adId = ad.id;
    patch.meta_ad_id = adId;
  }
  patch.status = 'live';
  patch.launch_error = null;
  patch.launched_at = new Date(now).toISOString();
  return { ok: true, step: 'done', patch: patch, adId: adId, creativeId: creativeId, imageHash: imageHash };
}

// What the launcher picks up: scheduled, due, and not out of retries. A draft
// with no launch_at is unschedulable by construction, mirroring the social
// publisher's rule.
function selectDueDrafts(drafts, nowIso, limit) {
  const now = new Date(nowIso || Date.now()).getTime();
  const cap = Math.max(1, Number(limit) || 3);
  return (Array.isArray(drafts) ? drafts : [])
    .filter(function (d) {
      if (!d || (d.status !== 'scheduled' && d.status !== 'launching')) return false;
      // A 'launching' row is another runner's lock; it is picked up again only
      // once that runner is long gone (double launch, 8 Nov 2026).
      if (d.status === 'launching' && now - new Date(d.updated_at || d.last_launch_attempt_at || 0).getTime() < LAUNCH_LOCK_MS) return false;
      if (!d.launch_at) return false;
      if ((num(d.launch_attempts) || 0) >= MAX_LAUNCH_ATTEMPTS) return false;
      return new Date(d.launch_at).getTime() <= now;
    })
    .sort(function (a, b) { return new Date(a.launch_at) - new Date(b.launch_at); })
    .slice(0, cap);
}

// Everything the owner needs to add the ad by hand in Ads Manager when the
// token cannot. Plain text so it can be copied in one click.
function manualKit(draft, cfg) {
  const c = cfg || adsConfig();
  const d = draft || {};
  const lines = [
    'Ad set: ' + (d.adset_name || digits(d.adset_id) || c.adsetId),
    'Ad name: ' + launchName(d),
    '',
    'Primary text:',
    String(d.primary_text || ''),
    '',
    'Headline: ' + String(d.headline || ''),
    'Description: ' + String(d.description || ''),
    'Call to action: ' + ctaLabel(d.cta || 'BOOK_TRAVEL'),
    'Destination: instant form ' + (digits(d.layout && d.layout.lead_form_id) || c.leadFormId) + (digits(d.layout && d.layout.lead_form_id) ? ' (the one chosen on the card)' : ' (the default: the fast slot-picker form)'),
    'URL parameters: ' + URL_TAGS,
    '',
    'Image: download the composed 1080x1350 creative from the card and upload it via Change selections.'
  ];
  return lines.join('\n');
}

module.exports = {
  GRAPH_VERSION,
  DEFAULTS,
  WINDOWS,
  CTA_OPTIONS,
  URL_TAGS,
  MAX_LAUNCH_ATTEMPTS,
  LAUNCH_LOCK_MS,
  FLAG_FREQUENCY,
  FLAG_CLICK_TO_LEAD_PCT,
  FLAG_MIN_LINK_CLICKS,
  FLAG_NO_LEAD_SPEND,
  adsConfig,
  configProblems,
  num,
  round,
  minorToMajor,
  actionCount,
  emptyMetrics,
  normaliseInsightRow,
  sumMetrics,
  pctChange,
  graphRequest,
  graphGetAll,
  fetchAdsets,
  fetchAds,
  fetchAdInsights,
  fetchCampaignInsights,
  fetchDailySeries,
  fetchImageLibrary,
  RANGE_PRESETS,
  INCREMENTS,
  presetRange,
  comparePeriod,
  resolveRange,
  rangeBoundsMs,
  fetchRangeInsights,
  buildRangeReport,
  todayIn,
  shiftYmd,
  daysBetween,
  creativeSummary,
  ctaLabel,
  funnelByAd,
  leadStages,
  rotationFlags,
  fetchAdRules,
  normaliseRule,
  isSwitchRule,
  ruleCovers,
  ruleFires,
  scheduleFor,
  adsetRotation,
  adRotation,
  rotationOf,
  inRotation,
  rotationCounts,
  scheduleSummary,
  rephaseSnapshot,
  assembleSnapshot,
  buildSnapshot,
  isCredentialError,
  isTermsError,
  isPermissionError,
  checkHealth,
  slugify,
  launchName,
  draftProblems,
  draftWarnings,
  uploadImage,
  objectStorySpec,
  liveLeadForms,
  fetchLeadFormNames,
  createCreative,
  createAd,
  explainMetaError,
  isTransientError,
  launchDraft,
  selectDueDrafts,
  manualKit,
  setEntityStatus,
  setAdsetDailyBudget,
  fetchLiveState
};
