'use strict';

// lib/meta-ads.js — the Meta Marketing API side of the CEO dashboard's Ads hub
// (Social tab). Reads the campaign (ad sets, ads, creatives, insights), joins
// the app's own booking funnel to each ad, flags ads against the owner's
// rotation rule, and creates new ads (image → creative → ad) when a draft is
// launched.
//
// Everything is pure except the functions that take a `fetchImpl`, which is
// injectable so the whole module is testable without a token. Nothing here
// edits an existing ad: creatives are immutable on Meta and every edit to a
// lead-form ad set over the API has failed with error 1815089 in this account
// (see docs/superpowers/handovers/2026-09-29-meta-ads-restructure-and-booking-
// attribution-handover.md §8), so the only write this module makes is
// "add a new ad to an existing ad set".

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
  return {
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
  if (!ad || ad.effective_status !== 'ACTIVE') return flags;
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

function statusRank(s) {
  if (s === 'ACTIVE') return 0;
  if (s === 'PENDING_REVIEW' || s === 'IN_PROCESS' || s === 'PREAPPROVED') return 1;
  if (s === 'WITH_ISSUES' || s === 'DISAPPROVED') return 2;
  return 3;
}

function assembleSnapshot(input) {
  const i = input || {};
  const cfg = i.config || adsConfig();
  const now = Number(i.now || Date.now());
  const ins = i.insights || {};
  const byWindow = {};
  WINDOWS.forEach(function (w) { byWindow[w] = indexInsights(ins[w]); });
  const funnel = funnelByAd(i.leadRows, { now: now });
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
    ad.flags = rotationFlags(ad, now);
    return ad;
  });
  ads.sort(function (a, b) {
    const r = statusRank(a.effective_status) - statusRank(b.effective_status);
    if (r) return r;
    return num(b.metrics.last_7d.spend) - num(a.metrics.last_7d.spend);
  });

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

  return {
    fetched_at: new Date(now).toISOString(),
    account: { id: cfg.accountId, currency: cfg.currency, time_zone: cfg.timeZone, account_time_zone: cfg.accountTimeZone },
    ecosystem: i.ecosystem || null,
    campaign: { id: cfg.campaignId },
    adsets: adsets,
    ads: ads,
    live_ads: ads.filter(function (a) { return a.effective_status === 'ACTIVE'; }).length,
    totals: totals,
    daily: daily,
    funnel: funnelTotals,
    funnel_unattributed: unattributed,
    errors: Array.isArray(i.errors) ? i.errors : []
  };
}

// Nine Graph calls (in parallel) → one snapshot. A failed insights window is reported in
// snapshot.errors and shows as zeros for that window rather than failing the
// whole page; a failed ads/adsets read is fatal because nothing can be drawn.
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
    fetchCampaignInsights('last_30d', callOpts)
  ];
  const settled = await Promise.all(jobs.map(function (p) {
    return p.then(function (r) { return r; }, function (err) {
      return { ok: false, error: String((err && err.message) || err) };
    });
  }));
  const [adsets, ads, y, d7, d30, daily, cy, c7, c30] = settled;
  const errors = [];
  const failed = [];
  function take(r, label) {
    if (r && r.ok) return r.data;
    failed.push({ label: label, error: (r && r.error) || 'unknown error', code: r && r.code });
    return [];
  }
  const adsetRows = take(adsets, 'Ad sets');
  const adRows = take(ads, 'Ads');
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
    errors.push((labels.length === 9 ? 'Every read' : labels.join(', ')) + ' failed: ' + key);
  });
  if (failed.length) errors.push('Token in use: ' + (cfg.tokenSource || 'none') + '.');
  const snapshot = assembleSnapshot({
    config: cfg, now: now, adsets: adsetRows, ads: adRows, insights: insights,
    campaignInsights: campaignInsights, ecosystem: o.ecosystem || null,
    daily: dailyRowsRaw, leadRows: o.leadRows, errors: errors
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
      // Lead ads need a link; Meta's convention for an instant-form ad is the
      // Page itself, the form is what the button opens.
      link: 'https://www.facebook.com/' + cfg.pageId + '/',
      message: String(draft.primary_text || ''),
      name: String(draft.headline || ''),
      description: String(draft.description || ''),
      call_to_action: {
        type: String(draft.cta || 'BOOK_TRAVEL'),
        value: { lead_gen_form_id: cfg.leadFormId }
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
      return { ok: false, step: 'image', error: msg, raw: up, patch: Object.assign(patch, { launch_error: 'Image upload: ' + msg }) };
    }
    imageHash = up.hash;
    patch.meta_image_hash = imageHash;
  }

  let creativeId = String(d.meta_creative_id || '');
  if (!creativeId) {
    const cr = await createCreative(Object.assign({}, callOpts, { draft: d, imageHash: imageHash }));
    if (!cr.ok) {
      const msg = explainMetaError(cr);
      return { ok: false, step: 'creative', error: msg, raw: cr, patch: Object.assign(patch, { launch_error: 'Creative: ' + msg }) };
    }
    creativeId = cr.id;
    patch.meta_creative_id = creativeId;
  }

  let adId = String(d.meta_ad_id || '');
  if (!adId) {
    const ad = await createAd(Object.assign({}, callOpts, { draft: d, creativeId: creativeId, status: o.status }));
    if (!ad.ok) {
      const msg = explainMetaError(ad);
      return { ok: false, step: 'ad', error: msg, raw: ad, patch: Object.assign(patch, { launch_error: 'Ad: ' + msg }) };
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
    'Destination: instant form ' + c.leadFormId + ' (the "Book time" Calendly form)',
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
  createCreative,
  createAd,
  explainMetaError,
  launchDraft,
  selectDueDrafts,
  manualKit
};
