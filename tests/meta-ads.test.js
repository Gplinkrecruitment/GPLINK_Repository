// Coverage for lib/meta-ads.js — the Meta Marketing API side of the CEO
// dashboard's Ads hub. Same CJS interop as tests/meta-capi.test.js; every
// network function is exercised through an injected fetchImpl (no global
// fetch patching, no token). The Graph-shaped data comes from
// tests/fixtures/meta-ads-graph.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const meta = require('../lib/meta-ads.js');
const fx = require('./fixtures/meta-ads-graph.js');

const DAY = 86400000;
const NOW = fx.NOW; // 2026-10-29T02:00:00Z
const ACCOUNT = '1668035273758338';
const PAGE = '769864969547691';
const FORM = '2370693577080684';
const ADSET = '120249238461470648';
const CAMPAIGN = '120248645727400648';

const TOKEN_CFG = meta.adsConfig({ META_ADS_ACCESS_TOKEN: 'tok-ads' });

// A Graph fetch stand-in. Records every call with the path (version prefix
// stripped), the query params (GET) and the form body (POST), and answers
// with whatever the handler returns: { status?, json? }.
function graphStub(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    let body = null;
    if (init && init.body) {
      body = {};
      init.body.forEach((v, k) => { body[k] = v; });
    }
    const call = { method: (init && init.method) || 'GET', path: u.pathname.replace(/^\/v\d+\.\d+/, ''), params, body, url };
    calls.push(call);
    const out = (handler && handler(call, calls.length)) || {};
    const status = out.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (out.json === undefined ? { data: [] } : out.json) };
  };
  return { impl, calls };
}

// Answers the nine snapshot reads from the fixture; `overrides` gets first go.
function snapshotHandler(overrides) {
  return (call) => {
    if (overrides) {
      const o = overrides(call);
      if (o) return o;
    }
    if (call.path === '/' + CAMPAIGN + '/adsets') return { json: { data: fx.adsets } };
    if (call.path === '/' + CAMPAIGN + '/ads') return { json: { data: fx.ads } };
    if (call.path === '/' + CAMPAIGN + '/insights') {
      if (call.params.time_increment === '1') return { json: { data: fx.daily } };
      if (call.params.level === 'ad') return { json: { data: fx.insights[call.params.date_preset] || [] } };
      return { json: { data: [] } }; // campaign-level totals: none, so sums are used
    }
    return { status: 404, json: { error: { message: 'Unknown path ' + call.path, code: 803 } } };
  };
}

function graphError(message, code, extra) {
  return { status: 400, json: { error: Object.assign({ message, code, type: 'OAuthException', fbtrace_id: 'trace' }, extra || {}) } };
}

const DRAFT = {
  id: 'draft-0001',
  angle: '05-duty-day',
  headline: 'Your last winter of duty days?',
  primary_text: 'The duty list fills before you have sat down.\n\nMost Australian practices run differently.\n\nBook a free 30-minute call. Completely free for doctors.',
  description: 'UK-trained GPs. Free 30-minute call.',
  image_path: '/tmp/duty-day.jpg',
  image_width: 1080,
  image_height: 1350,
  cta: 'BOOK_TRAVEL',
  adset_id: ADSET
};

function launchHandler(overrides) {
  return (call) => {
    if (overrides) {
      const o = overrides(call);
      if (o) return o;
    }
    if (call.path === '/act_' + ACCOUNT + '/adimages') return { json: { images: { 'duty.jpg': { hash: 'HASH1', url: 'https://img.test/1.jpg' } } } };
    if (call.path === '/act_' + ACCOUNT + '/adcreatives') return { json: { id: 'CR1' } };
    if (call.path === '/act_' + ACCOUNT + '/ads') return { json: { id: 'AD1' } };
    return { status: 404, json: { error: { message: 'Unknown path ' + call.path, code: 803 } } };
  };
}

describe('adsConfig', () => {
  it('fills the account defaults when the env is empty', () => {
    const c = meta.adsConfig({});
    expect(c.token).toBe('');
    expect(c.tokenSource).toBeNull();
    expect(c.accountId).toBe(ACCOUNT);
    expect(c.pageId).toBe(PAGE);
    expect(c.campaignId).toBe(CAMPAIGN);
    expect(c.leadFormId).toBe(FORM);
    expect(c.adsetId).toBe(ADSET);
    [c.accountId, c.pageId, c.campaignId, c.leadFormId, c.adsetId].forEach((id) => expect(id).toMatch(/^\d+$/));
    expect(c.graphBase).toBe('https://graph.facebook.com');
    expect(c.graphVersion).toBe(meta.GRAPH_VERSION);
    expect(c.timeZone).toBe('Australia/Melbourne');
    expect(c.currency).toBe('AUD');
    expect(c.launchDisabled).toBe(false);
  });

  it('prefers META_ADS_ACCESS_TOKEN over META_CAPI_ACCESS_TOKEN and says which is in use', () => {
    const both = meta.adsConfig({ META_ADS_ACCESS_TOKEN: ' ads-tok ', META_CAPI_ACCESS_TOKEN: 'capi-tok' });
    expect(both.token).toBe('ads-tok');
    expect(both.tokenSource).toBe('META_ADS_ACCESS_TOKEN');
    const capiOnly = meta.adsConfig({ META_CAPI_ACCESS_TOKEN: 'capi-tok' });
    expect(capiOnly.token).toBe('capi-tok');
    expect(capiOnly.tokenSource).toBe('META_CAPI_ACCESS_TOKEN');
  });

  it('takes the page id from FB_PAGE_ID, with META_ADS_PAGE_ID winning, and ignores non-digit ids', () => {
    expect(meta.adsConfig({ FB_PAGE_ID: '123456' }).pageId).toBe('123456');
    expect(meta.adsConfig({ FB_PAGE_ID: '123456', META_ADS_PAGE_ID: '999' }).pageId).toBe('999');
    expect(meta.adsConfig({ FB_PAGE_ID: 'not-digits' }).pageId).toBe(PAGE);
    expect(meta.adsConfig({ META_AD_ACCOUNT_ID: 'act_123' }).accountId).toBe(ACCOUNT);
    expect(meta.adsConfig({ META_AD_ACCOUNT_ID: '42' }).accountId).toBe('42');
  });

  it('reads the launch kill switch and strips a trailing slash from the graph url', () => {
    expect(meta.adsConfig({ ADS_LAUNCH_DISABLED: 'true' }).launchDisabled).toBe(true);
    expect(meta.adsConfig({ ADS_LAUNCH_DISABLED: 'false' }).launchDisabled).toBe(false);
    expect(meta.adsConfig({ ADS_LAUNCH_DISABLED: '1' }).launchDisabled).toBe(false);
    expect(meta.adsConfig({ META_ADS_GRAPH_URL: 'http://127.0.0.1:9/' }).graphBase).toBe('http://127.0.0.1:9');
  });

  it('configProblems names META_ADS_ACCESS_TOKEN when there is no token at all', () => {
    const problems = meta.configProblems(meta.adsConfig({}));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('META_ADS_ACCESS_TOKEN');
    expect(meta.configProblems(TOKEN_CFG)).toEqual([]);
  });
});

describe('normaliseInsightRow', () => {
  it('parses the string numbers Meta sends and derives the rates', () => {
    const m = meta.normaliseInsightRow(fx.insights.last_7d[0]); // Locum drought
    expect(m.spend).toBe(208.6);
    expect(m.impressions).toBe(12128);
    expect(m.reach).toBe(5547);
    expect(m.clicks).toBe(382);
    expect(m.link_clicks).toBe(117);
    expect(m.leads).toBe(5);
    expect(m.cost_per_lead).toBe(41.72);
    expect(m.click_to_lead_pct).toBe(4.3);
    expect(m.link_ctr).toBe(0.96);
    expect(m.frequency).toBe(2.19);
  });

  it('takes leads from "lead" first and falls back to the grouped on-site key', () => {
    const both = meta.normaliseInsightRow({ actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '9' }, { action_type: 'lead', value: '5' }] });
    expect(both.leads).toBe(5);
    const grouped = meta.normaliseInsightRow({ actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '9' }] });
    expect(grouped.leads).toBe(9);
    const none = meta.normaliseInsightRow({ actions: [{ action_type: 'post_engagement', value: '3' }] });
    expect(none.leads).toBe(0);
  });

  it('reads link clicks from link_click only, not clicks', () => {
    const m = meta.normaliseInsightRow({ clicks: '40', actions: [{ action_type: 'link_click', value: '12' }] });
    expect(m.clicks).toBe(40);
    expect(m.link_clicks).toBe(12);
    expect(meta.normaliseInsightRow({ clicks: '40' }).link_clicks).toBe(0);
  });

  it('leaves cost per lead null with no leads and click-to-lead null with no link clicks', () => {
    const noLeads = meta.normaliseInsightRow({ spend: '50', actions: [{ action_type: 'link_click', value: '10' }] });
    expect(noLeads.cost_per_lead).toBeNull();
    expect(noLeads.click_to_lead_pct).toBe(0);
    const noClicks = meta.normaliseInsightRow({ spend: '50', actions: [{ action_type: 'lead', value: '2' }] });
    expect(noClicks.click_to_lead_pct).toBeNull();
    expect(noClicks.cost_per_lead).toBe(25);
  });

  it('derives frequency from impressions over reach when Meta omits it', () => {
    expect(meta.normaliseInsightRow({ impressions: '12128', reach: '5547' }).frequency).toBe(2.19);
    expect(meta.normaliseInsightRow({ impressions: '12128', reach: '5547', frequency: '2.5' }).frequency).toBe(2.5);
    expect(meta.normaliseInsightRow({ impressions: '100', reach: '0' }).frequency).toBe(0);
    expect(meta.normaliseInsightRow(null)).toEqual(meta.emptyMetrics());
  });
});

describe('sumMetrics and pctChange', () => {
  it('adds the counts and recomputes every rate from the sums', () => {
    const t = meta.sumMetrics([
      { spend: 10, impressions: 1000, reach: 500, clicks: 50, link_clicks: 20, leads: 2 },
      { spend: 5, impressions: 500, reach: 250, clicks: 10, link_clicks: 5, leads: 0 },
      null
    ]);
    expect(t).toEqual({
      spend: 15, impressions: 1500, reach: 750, frequency: 2, clicks: 60, link_clicks: 25,
      ctr: 4, link_ctr: 1.67, cpm: 10, leads: 2, cost_per_lead: 7.5, click_to_lead_pct: 8
    });
    expect(meta.sumMetrics([])).toEqual(meta.emptyMetrics());
    expect(meta.sumMetrics(undefined).cost_per_lead).toBeNull();
  });

  it('pctChange is a whole-number percent and null when the base is zero', () => {
    expect(meta.pctChange(150, 100)).toBe(50);
    expect(meta.pctChange(50, 100)).toBe(-50);
    expect(meta.pctChange('589.65', '430.5')).toBe(37);
    expect(meta.pctChange(10, 0)).toBeNull();
    expect(meta.pctChange(0, 0)).toBeNull();
    expect(meta.pctChange(5, null)).toBeNull();
  });

  it('minorToMajor turns a budget in cents into dollars', () => {
    expect(meta.minorToMajor('10000')).toBe(100);
    expect(meta.minorToMajor(1234)).toBe(12.34);
    expect(meta.minorToMajor(undefined)).toBe(0);
  });
});

describe('funnelByAd', () => {
  function row(adId, daysAgo, consult, extra) {
    return Object.assign({
      id: 'r', kind: 'gp', status: 'new',
      created_at: new Date(NOW - daysAgo * DAY).toISOString(),
      metadata: Object.assign({ source: 'meta_lead_ad', consult: consult || {} }, adId ? { fb_ad_id: adId } : {})
    }, extra || {});
  }

  it('counts only meta_lead_ad rows, by ad id, in 7 and 30 day buckets', () => {
    const f = meta.funnelByAd(fx.leadRows, { now: NOW });
    expect(f.by_ad['120249238461490648']).toEqual({
      d7: { leads: 5, qualified: 5, booked: 2, signed_up: 0 },
      d30: { leads: 9, qualified: 9, booked: 4, signed_up: 0 }
    });
    // All nine of the old ad set's leads are 8+ days old: 30-day bucket only.
    expect(f.by_ad['120248907760920648']).toEqual({
      d7: { leads: 0, qualified: 0, booked: 0, signed_up: 0 },
      d30: { leads: 9, qualified: 9, booked: 4, signed_up: 0 }
    });
    expect(f.totals).toEqual({
      d7: { leads: 11, qualified: 11, booked: 4, signed_up: 0 },
      d30: { leads: 24, qualified: 24, booked: 10, signed_up: 0 }
    });
    // The site form row (x1) is not a Meta lead and must not appear anywhere.
    expect(Object.keys(f.by_ad).sort()).toEqual([
      '120248907760920648', '120249238461490648', '120249238461520648', '120249238461530648', '120249238461540648', 'unknown'
    ]);
  });

  it('puts Meta leads with no ad id under "unknown"', () => {
    const f = meta.funnelByAd(fx.leadRows, { now: NOW });
    expect(f.by_ad.unknown).toEqual({
      d7: { leads: 1, qualified: 1, booked: 1, signed_up: 0 },
      d30: { leads: 1, qualified: 1, booked: 1, signed_up: 0 }
    });
    const g = meta.funnelByAd([row('abc', 1, {}), row(null, 1, {})], { now: NOW });
    expect(Object.keys(g.by_ad)).toEqual(['unknown']);
    expect(g.by_ad.unknown.d7.leads).toBe(2);
  });

  it('ignores rows older than 30 days, rows from the future and rows with no usable date', () => {
    const f = meta.funnelByAd([
      row('1', 31, {}),
      row('1', -1, {}),
      row('1', 29, {}),
      Object.assign(row('1', 1, {}), { created_at: 'garbage' }),
      { metadata: { source: 'meta_lead_ad', fb_ad_id: '1' } }
    ], { now: NOW });
    expect(f.by_ad['1']).toEqual({ d7: { leads: 0, qualified: 0, booked: 0, signed_up: 0 }, d30: { leads: 1, qualified: 0, booked: 0, signed_up: 0 } });
    // The 7-day edge: 7 days exactly is in, a minute over is out.
    const edge = meta.funnelByAd([
      Object.assign(row('2', 7, {}), { created_at: new Date(NOW - 7 * DAY).toISOString() }),
      Object.assign(row('2', 7, {}), { created_at: new Date(NOW - 7 * DAY - 60000).toISOString() })
    ], { now: NOW });
    expect(edge.by_ad['2'].d7.leads).toBe(1);
    expect(edge.by_ad['2'].d30.leads).toBe(2);
  });

  it('detects qualified, booked and signed-up the way the consult funnel records them', () => {
    const f = meta.funnelByAd([
      row('9', 1, { qualified: true }),
      row('9', 1, { qualified: 'yes' }),                 // not strictly true
      row('9', 1, { call_booked: true }),
      row('9', 1, { call_booked_at: '2026-10-28T10:00:00Z' }),
      row('9', 1, { call_booked: false }),
      row('9', 1, { stopped: 'signed_up' }),
      row('9', 1, {}, { status: 'converted' }),
      row('9', 1, { stopped: 'not_gp' })
    ], { now: NOW });
    expect(f.by_ad['9'].d7).toEqual({ leads: 8, qualified: 1, booked: 2, signed_up: 2 });
    expect(meta.leadStages({ metadata: { consult: { qualified: true, call_booked_at: 'x', stopped: 'signed_up' } } }))
      .toEqual({ qualified: true, booked: true, signed_up: true });
    expect(meta.leadStages(null)).toEqual({ qualified: false, booked: false, signed_up: false });
  });

  it('copes with no rows at all', () => {
    expect(meta.funnelByAd(undefined, { now: NOW })).toEqual({ by_ad: {}, totals: { d7: { leads: 0, qualified: 0, booked: 0, signed_up: 0 }, d30: { leads: 0, qualified: 0, booked: 0, signed_up: 0 } } });
  });
});

describe('rotationFlags', () => {
  function ad(metrics7, extra) {
    return Object.assign({
      effective_status: 'ACTIVE',
      created_time: new Date(NOW - 20 * DAY).toISOString(),
      metrics: { last_7d: Object.assign(meta.emptyMetrics(), metrics7 || {}) }
    }, extra || {});
  }
  const codes = (a) => meta.rotationFlags(a, NOW).map((f) => f.code);

  it('never flags an ad that is not delivering', () => {
    expect(codes(ad({ frequency: 5, spend: 500, leads: 0, link_clicks: 100, click_to_lead_pct: 0 }, { effective_status: 'PAUSED' }))).toEqual([]);
    expect(codes(ad({ frequency: 5 }, { effective_status: 'ADSET_PAUSED' }))).toEqual([]);
    expect(meta.rotationFlags(null, NOW)).toEqual([]);
  });

  it('marks an ad under 7 days old as new, with the day count in the label', () => {
    const one = meta.rotationFlags(ad({}, { created_time: new Date(NOW - 1 * DAY - 3600000).toISOString() }), NOW);
    expect(one).toEqual([{ code: 'new', level: 'info', label: 'Live 1 day, still settling' }]);
    expect(codes(ad({}, { created_time: new Date(NOW - 6 * DAY - 3600000).toISOString() }))).toEqual(['new']);
    expect(codes(ad({}, { created_time: new Date(NOW - 7 * DAY).toISOString() }))).toEqual([]);
    expect(codes(ad({}, { created_time: null }))).toEqual([]);
    expect(codes(ad({}, { created_time: fx.ads[0].created_time }))).toEqual([]); // 7 days 12h before NOW
  });

  it('flags frequency only above 3', () => {
    expect(codes(ad({ frequency: 3.01 }))).toEqual(['frequency']);
    expect(codes(ad({ frequency: 3 }))).toEqual([]);
    expect(meta.rotationFlags(ad({ frequency: 3.5 }), NOW)[0].label).toContain('3.5');
  });

  it('flags click-to-lead only once there are 25 link clicks and the rate is under 4%', () => {
    expect(codes(ad({ link_clicks: 25, click_to_lead_pct: 3.9 }))).toEqual(['click_to_lead']);
    expect(codes(ad({ link_clicks: 24, click_to_lead_pct: 0 }))).toEqual([]);
    expect(codes(ad({ link_clicks: 25, click_to_lead_pct: 4 }))).toEqual([]);
    expect(codes(ad({ link_clicks: 25, click_to_lead_pct: null }))).toEqual([]);
    expect(meta.rotationFlags(ad({ link_clicks: 74, click_to_lead_pct: 2.7 }), NOW)[0].label).toBe('Only 2.7% of link clicks became leads (rule: pause below 4%)');
  });

  it('flags AU$100+ spent with no lead, and stacks flags', () => {
    expect(codes(ad({ spend: 100, leads: 0 }))).toEqual(['no_leads']);
    expect(codes(ad({ spend: 99.99, leads: 0 }))).toEqual([]);
    expect(codes(ad({ spend: 100, leads: 1 }))).toEqual([]);
    expect(meta.rotationFlags(ad({ spend: 120.5, leads: 0 }), NOW)[0].label).toBe('AU$120.5 spent in 7 days with no lead');
    expect(codes(ad({ frequency: 4, spend: 150, leads: 0, link_clicks: 30, click_to_lead_pct: 0 }, { created_time: new Date(NOW - DAY).toISOString() })))
      .toEqual(['new', 'frequency', 'click_to_lead', 'no_leads']);
  });
});

describe('assembleSnapshot', () => {
  const base = () => ({
    config: meta.adsConfig({}), now: NOW, adsets: fx.adsets, ads: fx.ads, insights: fx.insights,
    daily: fx.daily.slice().reverse(), leadRows: fx.leadRows
  });
  const snap = meta.assembleSnapshot(base());
  const byId = {};
  snap.ads.forEach((a) => { byId[a.id] = a; });

  it('carries every ad, counts the live ones and orders ACTIVE first then by 7-day spend', () => {
    expect(snap.ads).toHaveLength(9);
    expect(snap.live_ads).toBe(7);
    expect(snap.ads.slice(0, 7).map((a) => a.id)).toEqual([
      '120249238461530648', '120249238461490648', '120249238461520648', '120249238461540648',
      '120249238461560648', '120249238461500648', '120249238461480648'
    ]);
    expect(snap.ads.slice(7).map((a) => a.effective_status).sort()).toEqual(['ADSET_PAUSED', 'PAUSED']);
    expect(snap.fetched_at).toBe('2026-10-29T02:00:00.000Z');
    expect(snap.account).toEqual({ id: ACCOUNT, currency: 'AUD', time_zone: 'Australia/Melbourne' });
    expect(snap.campaign).toEqual({ id: CAMPAIGN });
    expect(snap.errors).toEqual([]);
  });

  it('summarises the creative and the ad set for each ad', () => {
    const a = byId['120249238461490648'];
    expect(a.name).toBe('Locum drought');
    expect(a.adset_name).toBe(fx.adsets[0].name);
    expect(a.days_live).toBe(7);
    expect(a.creative.headline).toBe('Australia is hiring UK-trained GPs.');
    expect(a.creative.primary_text).toBe(fx.ads[0].creative.body);
    expect(a.creative.description).toBe('UK-trained GPs. Free 30-minute call.');
    expect(a.creative.image_hash).toBe('h1');
    expect(a.creative.cta).toBe('BOOK_TRAVEL');
    expect(a.creative.cta_label).toBe('Book now');
    expect(snap.adsets[0]).toMatchObject({ id: ADSET, daily_budget: 100, optimization_goal: 'QUALITY_LEAD', learning: { status: 'LEARNING', exit_reason: null, last_edit_at: '2026-10-26T11:03:02.000Z' } });
  });

  it('gives every ad all three windows, zeros where Meta had no row', () => {
    snap.ads.forEach((a) => expect(Object.keys(a.metrics)).toEqual(['yesterday', 'last_7d', 'last_30d']));
    const locum = byId['120249238461490648'];
    expect(locum.metrics.last_7d.spend).toBe(208.6);
    expect(locum.metrics.last_30d.spend).toBe(239.89);
    expect(locum.metrics.yesterday.spend).toBe(29.8);
    const paused = byId['120249238461510648'];
    expect(paused.metrics.yesterday).toEqual(meta.emptyMetrics());
    expect(paused.metrics.last_7d).toEqual(meta.emptyMetrics());
    expect(paused.metrics.last_30d).toEqual(meta.emptyMetrics());
  });

  it('joins the app funnel per ad with cost per booking, null when nothing was spent', () => {
    expect(byId['120249238461490648'].funnel).toEqual({
      d7: { leads: 5, qualified: 5, booked: 2, signed_up: 0, cost_per_booking: 104.3 },
      d30: { leads: 9, qualified: 9, booked: 4, signed_up: 0, cost_per_booking: 59.97 }
    });
    // Four bookings but no spend in the window: a lagging lead, not a free booking.
    const old = byId['120248907760920648'];
    expect(old.funnel.d30.booked).toBe(4);
    expect(old.funnel.d30.cost_per_booking).toBeNull();
    expect(old.funnel.d7.cost_per_booking).toBeNull();
    // An ad with no leads at all still gets an empty funnel.
    expect(byId['120249238461510648'].funnel).toEqual({
      d7: { leads: 0, qualified: 0, booked: 0, signed_up: 0, cost_per_booking: null },
      d30: { leads: 0, qualified: 0, booked: 0, signed_up: 0, cost_per_booking: null }
    });
    expect(snap.funnel).toEqual({
      d7: { leads: 11, qualified: 11, booked: 4, signed_up: 0, cost_per_booking: 147.41 },
      d30: { leads: 24, qualified: 24, booked: 10, signed_up: 0, cost_per_booking: 67.81 }
    });
    expect(snap.funnel_unattributed).toEqual({ d7: { leads: 1, qualified: 1, booked: 1, signed_up: 0 }, d30: { leads: 1, qualified: 1, booked: 1, signed_up: 0 } });
  });

  it('applies the rotation flags to the assembled ads', () => {
    expect(byId['120249238461530648'].flags.map((f) => f.code)).toEqual(['click_to_lead']);
    expect(byId['120249238461490648'].flags).toEqual([]);
    expect(byId['120249238461510648'].flags).toEqual([]);
  });

  it('sums the ad rows into totals and compares with the previous week and the daily average', () => {
    expect(snap.totals.last_7d).toMatchObject({ spend: 589.65, impressions: 33543, reach: 17578, frequency: 1.91, link_clicks: 247, leads: 10, cost_per_lead: 58.97 });
    expect(snap.totals.prior_7d).toMatchObject({ spend: 430.5, leads: 2, link_clicks: 154 });
    expect(snap.totals.week_on_week).toEqual({ spend: 37, leads: 400, cost_per_lead: -73, link_clicks: 60 });
    expect(snap.totals.yesterday_vs_avg).toEqual({ spend: 0, leads: -29, avg_spend: 84.2, avg_leads: 1.4 });
  });

  it('sorts the daily series ascending by date, whatever order Meta sent it', () => {
    expect(snap.daily).toHaveLength(14);
    expect(snap.daily[0].date).toBe('2026-10-15');
    expect(snap.daily[13].date).toBe('2026-10-28');
    for (let i = 1; i < snap.daily.length; i++) expect(snap.daily[i].date > snap.daily[i - 1].date).toBe(true);
    expect(snap.daily[13]).toEqual({ date: '2026-10-28', spend: 84.2, impressions: 4800, reach: 2600, link_clicks: 35, leads: 1, cost_per_lead: 84.2 });
  });

  it('lets a campaign-level insight row override the summed totals (reach is not additive)', () => {
    const withCampaign = meta.assembleSnapshot(Object.assign(base(), {
      campaignInsights: {
        last_7d: [{ spend: '589.65', impressions: '33543', reach: '10100', clicks: '1018', ctr: '3.03', cpm: '17.58',
          actions: [{ action_type: 'link_click', value: '247' }, { action_type: 'lead', value: '10' }] }]
      }
    }));
    expect(withCampaign.totals.last_7d.reach).toBe(10100);
    expect(withCampaign.totals.last_7d.frequency).toBeCloseTo(3.32, 2);
    expect(withCampaign.totals.last_7d.leads).toBe(10);
    // Windows without a campaign row still fall back to the sum.
    expect(withCampaign.totals.last_30d).toEqual(snap.totals.last_30d);
    expect(withCampaign.totals.yesterday).toEqual(snap.totals.yesterday);
  });

  it('builds an empty snapshot from nothing', () => {
    const empty = meta.assembleSnapshot({ config: meta.adsConfig({}), now: NOW, errors: ['x'] });
    expect(empty.ads).toEqual([]);
    expect(empty.live_ads).toBe(0);
    expect(empty.daily).toEqual([]);
    expect(empty.totals.last_7d).toEqual(meta.emptyMetrics());
    expect(empty.totals.week_on_week).toEqual({ spend: null, leads: null, cost_per_lead: null, link_clicks: null });
    expect(empty.totals.yesterday_vs_avg).toEqual({ spend: null, leads: null, avg_spend: 0, avg_leads: 0 });
    expect(empty.funnel_unattributed).toBeNull();
    expect(empty.errors).toEqual(['x']);
  });
});

describe('creativeSummary', () => {
  it('falls back to object_story_spec.link_data when the flat fields are missing', () => {
    const c = meta.creativeSummary({
      id: 77,
      object_story_spec: {
        page_id: PAGE,
        link_data: { name: 'No QOF. No CQC.', message: 'Body text.', description: 'Desc.', image_hash: 'abc123', call_to_action: { type: 'LEARN_MORE' } }
      }
    });
    expect(c).toEqual({
      id: '77', name: '', headline: 'No QOF. No CQC.', primary_text: 'Body text.', description: 'Desc.',
      image_url: '', thumbnail_url: '', image_hash: 'abc123', cta: 'LEARN_MORE', cta_label: 'Learn more'
    });
  });

  it('prefers the flat fields and humanises an unknown CTA', () => {
    const c = meta.creativeSummary({ title: 'Flat', body: 'Flat body', image_hash: 'flat', call_to_action_type: 'SHOP_NOW',
      object_story_spec: { link_data: { name: 'Spec', message: 'Spec body', image_hash: 'spec', call_to_action: { type: 'LEARN_MORE' } } } });
    expect(c.headline).toBe('Flat');
    expect(c.primary_text).toBe('Flat body');
    expect(c.image_hash).toBe('flat');
    expect(c.cta).toBe('SHOP_NOW');
    expect(c.cta_label).toBe('Shop now');
    expect(meta.creativeSummary(undefined).cta_label).toBe('');
    expect(meta.ctaLabel('BOOK_TRAVEL')).toBe('Book now');
  });
});

describe('graphGetAll paging', () => {
  const rows = (n, from) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));

  it('follows paging.next using cursors.after and concatenates the pages', async () => {
    const stub = graphStub((call) => {
      if (!call.params.after) return { json: { data: rows(3, 1), paging: { cursors: { before: 'B', after: 'CUR1' }, next: 'https://graph.facebook.com/next' } } };
      if (call.params.after === 'CUR1') return { json: { data: rows(2, 4) } };
      return { status: 500, json: { error: { message: 'unexpected' } } };
    });
    const r = await meta.graphGetAll('/x/ads', { fields: 'id', limit: 3 }, { config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(r.ok).toBe(true);
    expect(r.data.map((x) => x.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1].params).toMatchObject({ fields: 'id', limit: '3', after: 'CUR1', access_token: 'tok-ads' });
    expect(stub.calls[0].params.after).toBeUndefined();
  });

  it('stops when paging.next is there but no cursor is, and at the page cap', async () => {
    const noCursor = graphStub(() => ({ json: { data: rows(1, 1), paging: { next: 'https://graph.facebook.com/next' } } }));
    const r1 = await meta.graphGetAll('/x/ads', {}, { config: TOKEN_CFG, fetchImpl: noCursor.impl });
    expect(r1.data).toHaveLength(1);
    expect(noCursor.calls).toHaveLength(1);

    const endless = graphStub(() => ({ json: { data: rows(1, 1), paging: { cursors: { after: 'C' }, next: 'https://graph.facebook.com/next' } } }));
    const r2 = await meta.graphGetAll('/x/ads', {}, { config: TOKEN_CFG, fetchImpl: endless.impl }, 2);
    expect(r2.data).toHaveLength(2);
    expect(endless.calls).toHaveLength(2);
  });

  it('returns the Graph error from any page', async () => {
    const stub = graphStub((call) => {
      if (!call.params.after) return { json: { data: rows(1, 1), paging: { cursors: { after: 'C' }, next: 'n' } } };
      return graphError('Page 2 broke', 1);
    });
    const r = await meta.graphGetAll('/x/ads', {}, { config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Page 2 broke', code: 1 });
  });

  it('graphRequest reports a thrown fetch as a network error', async () => {
    const r = await meta.graphRequest('GET', '/x', {}, { config: TOKEN_CFG, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    expect(r).toEqual({ ok: false, status: 0, error: 'Could not reach Meta: ECONNRESET', network: true });
  });
});

describe('buildSnapshot', () => {
  it('returns a funnel-only snapshot and no network calls when there is no token', async () => {
    const stub = graphStub(snapshotHandler());
    const r = await meta.buildSnapshot({ config: meta.adsConfig({}), fetchImpl: stub.impl, leadRows: fx.leadRows, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('META_ADS_ACCESS_TOKEN');
    expect(stub.calls).toHaveLength(0);
    expect(r.snapshot.ads).toEqual([]);
    expect(r.snapshot.funnel.d7).toMatchObject({ leads: 11, booked: 4 });
    expect(r.snapshot.errors).toEqual(r.problems);
  });

  it('makes the nine reads with the token and assembles the fixture into a snapshot', async () => {
    const stub = graphStub(snapshotHandler());
    const r = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: stub.impl, leadRows: fx.leadRows, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.configured).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.credential_error).toBe(false);
    expect(r.permission_error).toBe(false);
    expect(stub.calls).toHaveLength(9);
    stub.calls.forEach((c) => {
      expect(c.method).toBe('GET');
      expect(c.params.access_token).toBe('tok-ads');
      expect(c.url.startsWith('https://graph.facebook.com/' + meta.GRAPH_VERSION + '/')).toBe(true);
    });
    const paths = stub.calls.map((c) => c.path);
    expect(paths.filter((p) => p === '/' + CAMPAIGN + '/adsets')).toHaveLength(1);
    expect(paths.filter((p) => p === '/' + CAMPAIGN + '/ads')).toHaveLength(1);
    expect(paths.filter((p) => p === '/' + CAMPAIGN + '/insights')).toHaveLength(7);
    const adLevel = stub.calls.filter((c) => c.params.level === 'ad').map((c) => c.params.date_preset).sort();
    expect(adLevel).toEqual(['last_30d', 'last_7d', 'yesterday']);
    expect(stub.calls.find((c) => c.params.time_increment === '1').params.date_preset).toBe('last_14d');
    expect(r.snapshot.ads).toHaveLength(9);
    expect(r.snapshot.live_ads).toBe(7);
    expect(r.snapshot.adsets).toHaveLength(2);
    expect(r.snapshot.daily).toHaveLength(14);
    expect(r.snapshot.totals.last_7d.spend).toBe(589.65);
    expect(r.snapshot.funnel.d30.booked).toBe(10);
  });

  it('is fatal when the ads edge fails, and puts the Graph error text in problems', async () => {
    const stub = graphStub(snapshotHandler((call) => {
      if (call.path === '/' + CAMPAIGN + '/ads') return graphError('Unsupported get request. Object with ID \'' + CAMPAIGN + '\' does not exist', 100, { error_subcode: 33 });
      return null;
    }));
    const r = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: stub.impl, leadRows: fx.leadRows, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.configured).toBe(true);
    // Grouped: one line per distinct error naming the reads it hit, then the token in use.
    expect(r.problems[0]).toBe('Ads failed: Unsupported get request. Object with ID \'' + CAMPAIGN + '\' does not exist (code 100)');
    expect(r.problems[1]).toMatch(/^Token in use: META_ADS_ACCESS_TOKEN\.$/);
    expect(r.problems).toHaveLength(2);
    expect(r.credential_error).toBe(false);
    expect(r.permission_error).toBe(false);
    expect(r.snapshot.ads).toEqual([]);
    expect(r.snapshot.adsets).toHaveLength(2);
    expect(r.snapshot.errors).toEqual(r.problems);
  });

  it('collapses nine reads failing for one reason into one line plus the token in use', async () => {
    // The owner's first production load: the fallback CRM token has no ads_read,
    // so every read fails with the same paragraph. Nine copies on screen was the bug.
    const stub = graphStub(snapshotHandler(() => graphError('Unsupported get request. Object with ID \'' + CAMPAIGN + '\' does not exist, cannot be loaded due to missing permissions', 100)));
    const cfg = meta.adsConfig({ META_CAPI_ACCESS_TOKEN: 'capi-token' });
    const r = await meta.buildSnapshot({ config: cfg, fetchImpl: stub.impl, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/^Every read failed: Unsupported get request/);
    expect(r.problems[1]).toBe('Token in use: META_CAPI_ACCESS_TOKEN.');
    expect(r.permission_error).toBe(true);
  });

  it('names a credential or permission failure on the ads read', async () => {
    const expired = graphStub(snapshotHandler((call) => (call.path === '/' + CAMPAIGN + '/ads' ? graphError('Error validating access token: Session has expired', 190) : null)));
    const r1 = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: expired.impl, now: NOW });
    expect(r1.ok).toBe(false);
    expect(r1.credential_error).toBe(true);
    expect(r1.permission_error).toBe(false);
    const perm = graphStub(snapshotHandler((call) => (call.path === '/' + CAMPAIGN + '/ads' ? graphError('(#200) Requires ads_read permission', 200) : null)));
    const r2 = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: perm.impl, now: NOW });
    expect(r2.credential_error).toBe(false);
    expect(r2.permission_error).toBe(true);
  });

  it('survives one insights window failing: reported in errors, zeros for that window', async () => {
    const stub = graphStub(snapshotHandler((call) => {
      if (call.params.level === 'ad' && call.params.date_preset === 'last_7d') return graphError('Insights temporarily unavailable', 2);
      return null;
    }));
    const r = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: stub.impl, leadRows: fx.leadRows, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.problems[0]).toBe('Insights (last 7 days) failed: Insights temporarily unavailable (code 2)');
    expect(r.problems[1]).toMatch(/^Token in use: /);
    expect(r.snapshot.errors).toEqual(r.problems);
    expect(r.snapshot.ads).toHaveLength(9);
    r.snapshot.ads.forEach((a) => expect(a.metrics.last_7d).toEqual(meta.emptyMetrics()));
    expect(r.snapshot.totals.last_7d.spend).toBe(0);
    expect(r.snapshot.totals.last_30d.spend).toBe(678.1);
    expect(r.snapshot.totals.yesterday.spend).toBe(84.24);
  });

  it('follows a paged ads edge', async () => {
    const stub = graphStub(snapshotHandler((call) => {
      if (call.path !== '/' + CAMPAIGN + '/ads') return null;
      if (!call.params.after) return { json: { data: fx.ads.slice(0, 5), paging: { cursors: { before: 'B', after: 'PAGE2' }, next: 'https://graph.facebook.com/' + meta.GRAPH_VERSION + '/' + CAMPAIGN + '/ads?after=PAGE2' } } };
      if (call.params.after === 'PAGE2') return { json: { data: fx.ads.slice(5), paging: { cursors: { before: 'PAGE2', after: 'END' } } } };
      return graphError('bad cursor', 100);
    }));
    const r = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: stub.impl, leadRows: fx.leadRows, now: NOW });
    expect(r.ok).toBe(true);
    expect(stub.calls.filter((c) => c.path === '/' + CAMPAIGN + '/ads')).toHaveLength(2);
    expect(stub.calls).toHaveLength(10);
    expect(r.snapshot.ads).toHaveLength(9);
    expect(r.snapshot.live_ads).toBe(7);
  });

  it('turns a fetch that throws into a problem rather than a rejection', async () => {
    const stub = graphStub(snapshotHandler());
    const throwing = async (url, init) => {
      if (url.indexOf('/adsets') !== -1) throw new Error('socket hang up');
      return stub.impl(url, init);
    };
    const r = await meta.buildSnapshot({ config: TOKEN_CFG, fetchImpl: throwing, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.problems[0]).toBe('Ad sets failed: Could not reach Meta: socket hang up');
    expect(r.problems[1]).toMatch(/^Token in use: /);
    expect(r.snapshot.adsets).toEqual([]);
    expect(r.snapshot.ads[0].adset_name).toBe('');
  });
});

describe('checkHealth', () => {
  const ALL = [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'granted' }, { permission: 'pages_manage_ads', status: 'granted' }];
  function healthHandler(perms) {
    return (call) => {
      if (call.path === '/act_' + ACCOUNT) return { json: { id: 'act_' + ACCOUNT, name: 'GP Link', currency: 'AUD', account_status: 1 } };
      if (call.path === '/act_' + ACCOUNT + '/insights') return { json: { data: [{ spend: '84.24', date_start: '2026-10-28', date_stop: '2026-10-28' }] } };
      if (call.path === '/me/permissions') return perms;
      if (call.path === '/' + PAGE) return { json: { id: PAGE, name: 'GP Link' } };
      return { status: 404, json: { error: { message: 'Unknown path ' + call.path, code: 803 } } };
    };
  }

  it('reports unconfigured without touching the network when there is no token', async () => {
    const stub = graphStub(healthHandler({ json: { data: ALL } }));
    const h = await meta.checkHealth({ config: meta.adsConfig({}), fetchImpl: stub.impl });
    expect(h.configured).toBe(false);
    expect(h.token_source).toBeNull();
    expect(h.can_read).toBe(false);
    expect(h.can_write).toBeNull();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0].key).toBe('token');
    expect(h.checks[0].ok).toBe(false);
    expect(h.checks[0].detail).toContain('META_ADS_ACCESS_TOKEN');
    expect(stub.calls).toHaveLength(0);
  });

  it('can read and write when the account, insights and all three permissions check out', async () => {
    const stub = graphStub(healthHandler({ json: { data: ALL } }));
    const h = await meta.checkHealth({ config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(h.configured).toBe(true);
    expect(h.token_source).toBe('META_ADS_ACCESS_TOKEN');
    expect(h.can_read).toBe(true);
    expect(h.can_write).toBe(true);
    expect(h.granted).toEqual(['ads_read', 'ads_management', 'pages_manage_ads']);
    expect(h.checks.map((c) => c.key)).toEqual(['account', 'insights', 'write', 'page']);
    expect(h.checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(h.checks[0].detail).toBe('Reads ad account GP Link (AUD)');
    expect(h.checks[3].detail).toBe('Sees the Page GP Link');
    expect(stub.calls.map((c) => c.path)).toEqual(['/act_' + ACCOUNT, '/act_' + ACCOUNT + '/insights', '/me/permissions', '/' + PAGE]);
  });

  it('cannot write when pages_manage_ads is missing, and says so', async () => {
    const stub = graphStub(healthHandler({ json: { data: [ALL[0], ALL[1], { permission: 'pages_manage_ads', status: 'declined' }] } }));
    const h = await meta.checkHealth({ config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(h.can_read).toBe(true);
    expect(h.can_write).toBe(false);
    expect(h.granted).toEqual(['ads_read', 'ads_management']);
    const write = h.checks.find((c) => c.key === 'write');
    expect(write.ok).toBe(false);
    expect(write.detail).toContain('pages_manage_ads');
    expect(write.detail).not.toContain('ads_management and');
    expect(write.detail).toContain('manual kit');
  });

  it('leaves can_write unknown when the permissions endpoint fails', async () => {
    const stub = graphStub(healthHandler(graphError('(#100) Tried accessing nonexisting field (permissions)', 100)));
    const h = await meta.checkHealth({ config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(h.can_read).toBe(true);
    expect(h.can_write).toBeNull();
    expect(h.granted).toEqual([]);
    const write = h.checks.find((c) => c.key === 'write');
    expect(write.ok).toBeNull();
    expect(write.detail).toContain('(#100) Tried accessing nonexisting field (permissions)');
  });

  it('cannot read when the account or insights call fails', async () => {
    const stub = graphStub((call) => (call.path === '/act_' + ACCOUNT + '/insights' ? graphError('(#200) Requires ads_read', 200) : healthHandler({ json: { data: ALL } })(call)));
    const h = await meta.checkHealth({ config: TOKEN_CFG, fetchImpl: stub.impl });
    expect(h.can_read).toBe(false);
    expect(h.checks[1]).toEqual({ key: 'insights', ok: false, detail: 'Cannot read performance: (#200) Requires ads_read (code 200)' });
  });
});

describe('draftProblems and draftWarnings', () => {
  it('passes a complete draft', () => {
    expect(meta.draftProblems(DRAFT)).toEqual([]);
    expect(meta.draftWarnings(DRAFT)).toEqual([]);
  });

  it('lists every hard stop on an empty draft', () => {
    const p = meta.draftProblems({});
    expect(p).toContain('Headline is empty.');
    expect(p).toContain('Primary text is empty.');
    expect(p).toContain('No creative image yet — compose one (photo + headline) first.');
    expect(p).toContain('Call to action is not one of the supported types.');
    expect(p).toContain('No ad set chosen.');
    expect(meta.draftProblems(undefined)).toEqual(p);
  });

  it('stops on the wrong image ratio, an unknown CTA, a missing ad set and overlong fields', () => {
    expect(meta.draftProblems(Object.assign({}, DRAFT, { image_width: 1080, image_height: 1080 }))).toEqual(['The creative is 1080x1080; the feed format is 1080x1350 (4:5).']);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { image_width: 864, image_height: 1080 }))).toEqual([]);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { image_width: 0, image_height: 0 }))).toEqual([]); // unknown dims are not a stop
    expect(meta.draftProblems(Object.assign({}, DRAFT, { cta: 'SHOP_NOW' }))).toEqual(['Call to action is not one of the supported types.']);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { adset_id: 'adset-1' }))).toEqual(['No ad set chosen.']);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { headline: 'x'.repeat(256) }))).toEqual(['Headline is over 255 characters.']);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { description: 'x'.repeat(256) }))).toEqual(['Description is over 255 characters.']);
    expect(meta.draftProblems(Object.assign({}, DRAFT, { headline: '   ' }))).toEqual(['Headline is empty.']);
  });

  it('warns about em dashes, long headlines, placeholders and a missing closer', () => {
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { headline: 'Duty day — every day' }))).toEqual(['Headline contains an em dash, which the brand rules exclude.']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { primary_text: 'Pain — gone. Completely free for doctors.' }))).toEqual(['Primary text contains an em dash, which the brand rules exclude.']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { image_headline: 'A — B' }))).toEqual(['Image headline contains an em dash, which the brand rules exclude.']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { headline: 'x'.repeat(41) }))).toEqual(['Headline is over 40 characters and may be cut short in the feed.']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { headline: 'x'.repeat(40) }))).toEqual([]);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { primary_text: 'Hello [practice name]. Completely free for doctors.' }))).toEqual(['Copy still contains a [placeholder].']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { primary_text: 'No closer here.' }))).toEqual(['Primary text does not end with the house closer "Completely free for doctors."']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { description: 'x'.repeat(41) }))).toEqual(['Description is over 40 characters; Facebook feed often hides it anyway.']);
    expect(meta.draftWarnings(Object.assign({}, DRAFT, { description: 'x'.repeat(40) }))).toEqual([]);
    const w = meta.draftWarnings({});
    expect(w).toEqual(['Primary text does not end with the house closer "Completely free for doctors."']);
  });
});

describe('launchName, slugify, objectStorySpec, manualKit', () => {
  it('slugifies to lowercase hyphenated ascii capped at 40 characters', () => {
    expect(meta.slugify('No QOF. No CQC. No 8am scramble.')).toBe('no-qof-no-cqc-no-8am-scramble');
    expect(meta.slugify('  --Duty Day--  ')).toBe('duty-day');
    expect(meta.slugify('a'.repeat(50))).toHaveLength(40);
    expect(meta.slugify(null)).toBe('');
  });

  it('names the ad from the angle, then the headline, then the draft id', () => {
    expect(meta.launchName({ angle: '05 Duty Day', headline: 'Other', id: 'abcdef123456' })).toBe('05-duty-day');
    expect(meta.launchName({ headline: 'Your last winter of duty days?', id: 'abcdef123456' })).toBe('your-last-winter-of-duty-days');
    expect(meta.launchName({ id: 'abcdef123456' })).toBe('ad-abcdef12');
    expect(meta.launchName(undefined)).toBe('ad-');
  });

  it('builds the object story spec with the page, the page link, the form id and the CTA', () => {
    const cfg = meta.adsConfig({});
    const spec = meta.objectStorySpec(DRAFT, cfg, 'HASH1');
    expect(spec).toEqual({
      page_id: PAGE,
      link_data: {
        image_hash: 'HASH1',
        link: 'https://www.facebook.com/' + PAGE + '/',
        message: DRAFT.primary_text,
        name: DRAFT.headline,
        description: DRAFT.description,
        call_to_action: { type: 'BOOK_TRAVEL', value: { lead_gen_form_id: FORM } }
      }
    });
    expect(meta.objectStorySpec({ cta: 'LEARN_MORE' }, cfg, 'h').link_data.call_to_action.type).toBe('LEARN_MORE');
    expect(meta.objectStorySpec({}, cfg, 'h').link_data.call_to_action.type).toBe('BOOK_TRAVEL');
    const custom = meta.adsConfig({ FB_PAGE_ID: '555', META_LEAD_FORM_ID: '666' });
    const s2 = meta.objectStorySpec(DRAFT, custom, 'h');
    expect(s2.page_id).toBe('555');
    expect(s2.link_data.link).toBe('https://www.facebook.com/555/');
    expect(s2.link_data.call_to_action.value.lead_gen_form_id).toBe('666');
  });

  it('manualKit carries the copy, the form id, the CTA label and the URL tags', () => {
    const kit = meta.manualKit(DRAFT, meta.adsConfig({}));
    expect(kit).toContain('Ad set: ' + ADSET);
    expect(kit).toContain('Ad name: 05-duty-day');
    expect(kit).toContain(DRAFT.primary_text);
    expect(kit).toContain('Headline: ' + DRAFT.headline);
    expect(kit).toContain('Description: ' + DRAFT.description);
    expect(kit).toContain('Call to action: Book now');
    expect(kit).toContain('instant form ' + FORM);
    expect(kit).toContain('URL parameters: ' + meta.URL_TAGS);
    expect(kit).toContain('1080x1350');
    expect(meta.manualKit(Object.assign({}, DRAFT, { adset_name: 'Live set', cta: 'LEARN_MORE' }), meta.adsConfig({}))).toContain('Ad set: Live set');
    expect(meta.manualKit(Object.assign({}, DRAFT, { cta: 'LEARN_MORE' }), meta.adsConfig({}))).toContain('Call to action: Learn more');
    expect(meta.manualKit({}, meta.adsConfig({}))).toContain('Ad set: ' + ADSET);
  });
});

describe('uploadImage, createCreative, createAd', () => {
  it('uploadImage posts the bytes base64 to adimages and returns the hash', async () => {
    const stub = graphStub(launchHandler());
    const r = await meta.uploadImage({ config: TOKEN_CFG, fetchImpl: stub.impl, bytes: Buffer.from('hello'), name: 'duty.jpg' });
    expect(r).toEqual({ ok: true, hash: 'HASH1', url: 'https://img.test/1.jpg' });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe('POST');
    expect(stub.calls[0].path).toBe('/act_' + ACCOUNT + '/adimages');
    expect(stub.calls[0].url).toBe('https://graph.facebook.com/' + meta.GRAPH_VERSION + '/act_' + ACCOUNT + '/adimages');
    expect(stub.calls[0].body).toEqual({ bytes: 'aGVsbG8=', name: 'duty.jpg', access_token: 'tok-ads' });
  });

  it('uploadImage refuses empty bytes, passes Meta errors through and spots a missing hash', async () => {
    const none = await meta.uploadImage({ config: TOKEN_CFG, fetchImpl: async () => { throw new Error('must not be called'); } });
    expect(none).toEqual({ ok: false, error: 'No image bytes to upload.' });
    const err = graphStub(() => graphError('Invalid image', 100, { error_subcode: 1487246, error_user_msg: 'Image too small' }));
    const r = await meta.uploadImage({ config: TOKEN_CFG, fetchImpl: err.impl, bytes: Buffer.from('x') });
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Invalid image', code: 100, subcode: 1487246, user_msg: 'Image too small' });
    const noHash = graphStub(() => ({ json: { images: { 'x.jpg': { url: 'u' } } } }));
    expect(await meta.uploadImage({ config: TOKEN_CFG, fetchImpl: noHash.impl, bytes: Buffer.from('x') })).toEqual({ ok: false, error: 'Meta accepted the image but returned no hash.' });
    expect(noHash.calls[0].body.name).toBe('gp-link-creative.jpg');
  });

  it('createCreative posts the object story spec as a JSON string with a dated name', async () => {
    const stub = graphStub(launchHandler());
    const r = await meta.createCreative({ config: TOKEN_CFG, fetchImpl: stub.impl, draft: DRAFT, imageHash: 'HASH1', now: NOW });
    expect(r).toEqual({ ok: true, id: 'CR1' });
    const call = stub.calls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/act_' + ACCOUNT + '/adcreatives');
    expect(call.body.name).toBe('05-duty-day 2026-10-29');
    expect(call.body.access_token).toBe('tok-ads');
    expect(typeof call.body.object_story_spec).toBe('string');
    expect(JSON.parse(call.body.object_story_spec)).toEqual(meta.objectStorySpec(DRAFT, TOKEN_CFG, 'HASH1'));
  });

  it('createCreative passes errors through and spots a missing id', async () => {
    const err = graphStub(() => graphError('Invalid parameter', 100, { error_user_title: 'Headline too long' }));
    expect(await meta.createCreative({ config: TOKEN_CFG, fetchImpl: err.impl, draft: DRAFT, imageHash: 'h' })).toMatchObject({ ok: false, error: 'Invalid parameter', code: 100, user_title: 'Headline too long' });
    const noId = graphStub(() => ({ json: { success: true } }));
    expect(await meta.createCreative({ config: TOKEN_CFG, fetchImpl: noId.impl, draft: DRAFT, imageHash: 'h' })).toEqual({ ok: false, error: 'Meta accepted the creative but returned no id.' });
  });

  it('createAd posts the creative id, status and url tags to the draft\'s ad set', async () => {
    const stub = graphStub(launchHandler());
    const r = await meta.createAd({ config: TOKEN_CFG, fetchImpl: stub.impl, draft: DRAFT, creativeId: 'CR1' });
    expect(r).toEqual({ ok: true, id: 'AD1' });
    const call = stub.calls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/act_' + ACCOUNT + '/ads');
    expect(call.body).toEqual({
      name: '05-duty-day', adset_id: ADSET, creative: JSON.stringify({ creative_id: 'CR1' }), status: 'ACTIVE', url_tags: meta.URL_TAGS, access_token: 'tok-ads'
    });
    expect(JSON.parse(call.body.creative)).toEqual({ creative_id: 'CR1' });
  });

  it('createAd can launch paused, falls back to the configured ad set, and passes errors through', async () => {
    const stub = graphStub(launchHandler());
    await meta.createAd({ config: TOKEN_CFG, fetchImpl: stub.impl, draft: Object.assign({}, DRAFT, { adset_id: '' }), creativeId: 7, status: 'PAUSED' });
    expect(stub.calls[0].body.status).toBe('PAUSED');
    expect(stub.calls[0].body.adset_id).toBe(ADSET);
    expect(stub.calls[0].body.creative).toBe('{"creative_id":"7"}');
    await meta.createAd({ config: TOKEN_CFG, fetchImpl: stub.impl, draft: DRAFT, creativeId: 'CR1', status: 'anything-else' });
    expect(stub.calls[1].body.status).toBe('ACTIVE');
    const err = graphStub(() => graphError('Ad set is not editable', 1815089));
    expect(await meta.createAd({ config: TOKEN_CFG, fetchImpl: err.impl, draft: DRAFT, creativeId: 'CR1' })).toMatchObject({ ok: false, code: 1815089 });
    const noId = graphStub(() => ({ json: {} }));
    expect(await meta.createAd({ config: TOKEN_CFG, fetchImpl: noId.impl, draft: DRAFT, creativeId: 'CR1' })).toEqual({ ok: false, error: 'Meta accepted the ad but returned no id.' });
  });
});

describe('launchDraft', () => {
  const bytes = Buffer.from('jpeg-bytes');

  it('uploads, creates the creative, creates the ad, and returns the live patch', async () => {
    const stub = graphStub(launchHandler());
    const r = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.step).toBe('done');
    expect(r).toMatchObject({ adId: 'AD1', creativeId: 'CR1', imageHash: 'HASH1' });
    expect(r.patch).toEqual({
      launch_attempts: 1,
      last_launch_attempt_at: '2026-10-29T02:00:00.000Z',
      meta_image_hash: 'HASH1',
      meta_creative_id: 'CR1',
      meta_ad_id: 'AD1',
      status: 'live',
      launch_error: null,
      launched_at: '2026-10-29T02:00:00.000Z'
    });
    expect(stub.calls.map((c) => c.path)).toEqual(['/act_' + ACCOUNT + '/adimages', '/act_' + ACCOUNT + '/adcreatives', '/act_' + ACCOUNT + '/ads']);
    expect(stub.calls[0].body.bytes).toBe(bytes.toString('base64'));
    expect(stub.calls[0].body.name).toBe('05-duty-day.jpg');
    expect(JSON.parse(stub.calls[1].body.object_story_spec).link_data.image_hash).toBe('HASH1');
    expect(stub.calls[2].body.creative).toBe('{"creative_id":"CR1"}');
  });

  it('resumes from the ids the draft already carries', async () => {
    const withHash = graphStub(launchHandler());
    const r1 = await meta.launchDraft(Object.assign({}, DRAFT, { meta_image_hash: 'OLDHASH', launch_attempts: 1 }), { config: TOKEN_CFG, fetchImpl: withHash.impl, now: NOW });
    expect(r1.ok).toBe(true);
    expect(withHash.calls.map((c) => c.path)).toEqual(['/act_' + ACCOUNT + '/adcreatives', '/act_' + ACCOUNT + '/ads']);
    expect(JSON.parse(withHash.calls[0].body.object_story_spec).link_data.image_hash).toBe('OLDHASH');
    expect(r1.imageHash).toBe('OLDHASH');
    expect(r1.patch.meta_image_hash).toBeUndefined();
    expect(r1.patch.launch_attempts).toBe(2);

    const withCreative = graphStub(launchHandler());
    const r2 = await meta.launchDraft(Object.assign({}, DRAFT, { meta_image_hash: 'OLDHASH', meta_creative_id: 'OLDCR' }), { config: TOKEN_CFG, fetchImpl: withCreative.impl, now: NOW });
    expect(r2.ok).toBe(true);
    expect(withCreative.calls.map((c) => c.path)).toEqual(['/act_' + ACCOUNT + '/ads']);
    expect(withCreative.calls[0].body.creative).toBe('{"creative_id":"OLDCR"}');
    expect(r2.patch.meta_creative_id).toBeUndefined();
    expect(r2.patch.meta_ad_id).toBe('AD1');

    const withAd = graphStub(launchHandler());
    const r3 = await meta.launchDraft(Object.assign({}, DRAFT, { meta_image_hash: 'H', meta_creative_id: 'C', meta_ad_id: 'A' }), { config: TOKEN_CFG, fetchImpl: withAd.impl, now: NOW });
    expect(r3.ok).toBe(true);
    expect(withAd.calls).toHaveLength(0);
    expect(r3.patch).toMatchObject({ status: 'live', launch_error: null });
  });

  it('writes the ids it has won so far into the patch when a later step fails', async () => {
    const stub = graphStub(launchHandler((call) => (call.path === '/act_' + ACCOUNT + '/ads' ? graphError('Invalid parameter', 100, { error_user_msg: 'The ad set no longer exists.' }) : null)));
    const r = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('ad');
    expect(r.raw.code).toBe(100);
    expect(r.patch.meta_image_hash).toBe('HASH1');
    expect(r.patch.meta_creative_id).toBe('CR1');
    expect(r.patch.meta_ad_id).toBeUndefined();
    expect(r.patch.status).toBeUndefined();
    expect(r.patch.launched_at).toBeUndefined();
    expect(r.patch.launch_error).toBe('Ad: Meta rejected a field (Invalid parameter — The ad set no longer exists.). Check the copy lengths, the image, and that the ad set still exists.');

    const creativeFails = graphStub(launchHandler((call) => (call.path === '/act_' + ACCOUNT + '/adcreatives' ? graphError('Boom', 1) : null)));
    const r2 = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: creativeFails.impl, imageBytes: bytes, now: NOW });
    expect(r2.step).toBe('creative');
    expect(r2.patch.meta_image_hash).toBe('HASH1');
    expect(r2.patch.meta_creative_id).toBeUndefined();
    expect(r2.patch.launch_error).toBe('Creative: Boom');

    const imageFails = graphStub(launchHandler((call) => (call.path === '/act_' + ACCOUNT + '/adimages' ? graphError('Invalid image', 100) : null)));
    const r3 = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: imageFails.impl, imageBytes: bytes, now: NOW });
    expect(r3.step).toBe('image');
    expect(r3.patch.meta_image_hash).toBeUndefined();
    expect(r3.patch.launch_error.startsWith('Image upload: Meta rejected a field (Invalid image)')).toBe(true);
    expect(imageFails.calls).toHaveLength(1);
  });

  it('stops at validation with no network call when the draft is incomplete', async () => {
    const stub = graphStub(launchHandler());
    const r = await meta.launchDraft(Object.assign({}, DRAFT, { headline: '', image_path: null }), { config: TOKEN_CFG, fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('validate');
    expect(r.error).toBe('Headline is empty. No creative image yet — compose one (photo + headline) first.');
    expect(r.patch).toEqual({ launch_attempts: 1, last_launch_attempt_at: '2026-10-29T02:00:00.000Z', launch_error: r.error });
    expect(stub.calls).toHaveLength(0);
  });

  it('stops at config without a token, and holds when the kill switch is on', async () => {
    const stub = graphStub(launchHandler());
    const noToken = await meta.launchDraft(DRAFT, { config: meta.adsConfig({}), fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(noToken.ok).toBe(false);
    expect(noToken.step).toBe('config');
    expect(noToken.held).toBeUndefined();
    expect(noToken.error).toContain('META_ADS_ACCESS_TOKEN');
    expect(noToken.patch.launch_error).toBe(noToken.error);

    const disabled = await meta.launchDraft(DRAFT, { config: meta.adsConfig({ META_ADS_ACCESS_TOKEN: 't', ADS_LAUNCH_DISABLED: 'true' }), fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(disabled.ok).toBe(false);
    expect(disabled.step).toBe('config');
    expect(disabled.held).toBe(true);
    expect(disabled.error).toBe('ADS_LAUNCH_DISABLED is true, so nothing is created on Meta.');
    expect(disabled.patch.launch_attempts).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  it('explains Meta 1815089 on the ad step in terms of pages_manage_ads and the manual kit', async () => {
    const stub = graphStub(launchHandler((call) => (call.path === '/act_' + ACCOUNT + '/ads'
      ? graphError('Invalid parameter', 1815089, { error_user_title: 'Terms of Service Not Accepted', error_user_msg: 'Accept the lead ads terms of service for this Page' })
      : null)));
    const r = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('ad');
    expect(r.raw.code).toBe(1815089);
    expect(r.error).toContain('1815089');
    expect(r.error).toContain('pages_manage_ads');
    expect(r.error).toContain('manual kit');
    expect(r.patch.launch_error).toBe('Ad: ' + r.error);
    expect(r.patch.meta_image_hash).toBe('HASH1');
    expect(r.patch.meta_creative_id).toBe('CR1');
    expect(r.patch.meta_ad_id).toBeUndefined();
    expect(r.patch.status).toBeUndefined();
  });

  // Meta sends its seven-digit lead-ads numbers as error_subcode under code 100
  // ("Invalid parameter", error_user_title "Terms of Service Not Accepted").
  // explainMetaError() only reads e.code and the message, so in that shape the
  // owner is told to check copy lengths instead of pages_manage_ads. Expected
  // behaviour pinned here; flip to it() once the library reads subcode/user_title.
  it('recognises 1815089 when it arrives as error_subcode under code 100', async () => {
    const stub = graphStub(launchHandler((call) => (call.path === '/act_' + ACCOUNT + '/ads'
      ? graphError('Invalid parameter', 100, { error_subcode: 1815089, error_user_title: 'Terms of Service Not Accepted', error_user_msg: 'Accept the lead ads terms of service for this Page' })
      : null)));
    const r = await meta.launchDraft(DRAFT, { config: TOKEN_CFG, fetchImpl: stub.impl, imageBytes: bytes, now: NOW });
    expect(r.step).toBe('ad');
    expect(r.raw.subcode).toBe(1815089);
    expect(r.error).toContain('pages_manage_ads');
    expect(r.error).toContain('manual kit');
  });
});

describe('selectDueDrafts', () => {
  const now = '2026-10-29T02:00:00Z';
  const drafts = [
    { id: 'a', status: 'scheduled', launch_at: '2026-10-29T01:00:00Z' },
    { id: 'b', status: 'scheduled', launch_at: '2026-10-29T03:00:00Z' },
    { id: 'c', status: 'launching', launch_at: '2026-10-28T23:00:00Z', launch_attempts: 2 },
    { id: 'd', status: 'draft', launch_at: '2026-10-28T00:00:00Z' },
    { id: 'e', status: 'scheduled' },
    { id: 'f', status: 'scheduled', launch_at: '2026-10-28T00:00:00Z', launch_attempts: meta.MAX_LAUNCH_ATTEMPTS },
    { id: 'g', status: 'scheduled', launch_at: '2026-10-27T00:00:00Z' },
    { id: 'h', status: 'live', launch_at: '2026-10-27T00:00:00Z' },
    { id: 'i', status: 'scheduled', launch_at: now },
    null
  ];

  it('keeps only scheduled or launching drafts that are due and not out of retries, earliest first', () => {
    expect(meta.selectDueDrafts(drafts, now, 10).map((d) => d.id)).toEqual(['g', 'c', 'a', 'i']);
  });

  it('caps the batch, defaulting to three', () => {
    expect(meta.selectDueDrafts(drafts, now, 2).map((d) => d.id)).toEqual(['g', 'c']);
    expect(meta.selectDueDrafts(drafts, now).map((d) => d.id)).toEqual(['g', 'c', 'a']);
    expect(meta.selectDueDrafts(drafts, now, 0).map((d) => d.id)).toEqual(['g', 'c', 'a']); // 0 is "unset", so the default applies
    expect(meta.selectDueDrafts(undefined, now)).toEqual([]);
    expect(meta.MAX_LAUNCH_ATTEMPTS).toBe(3);
  });
});

describe('explainMetaError', () => {
  it('explains the lead-ads terms refusal by code or by message', () => {
    const byCode = meta.explainMetaError({ code: 1815089, error: 'Invalid parameter' });
    expect(byCode).toContain('1815089');
    expect(byCode).toContain('pages_manage_ads');
    expect(byCode).toContain('manual kit');
    expect(meta.explainMetaError({ code: 100, error: 'You must accept the Terms of Service' })).toBe(byCode);
  });

  // See the launchDraft note: the library checks e.code only, so a 1815089
  // error_subcode under code 100 is explained as a bad field. Pinned as it.fails.
  it('recognises the lead-ads terms refusal by error_subcode and user title', () => {
    const r = { code: 100, subcode: 1815089, error: 'Invalid parameter', user_title: 'Terms of Service Not Accepted' };
    expect(meta.explainMetaError(r)).toContain('pages_manage_ads');
    expect(meta.isPermissionError(r)).toBe(true);
  });

  it('explains a bad token (190)', () => {
    const s = meta.explainMetaError({ code: 190, error: 'Session has expired' });
    expect(s).toContain('rejected (Session has expired)');
    expect(s).toContain('META_ADS_ACCESS_TOKEN');
    expect(meta.explainMetaError({ code: 463, error: 'Error validating access token' })).toContain('Re-mint META_ADS_ACCESS_TOKEN');
  });

  it('explains a missing permission (200, 10, 294 or the word)', () => {
    [200, 10, 294].forEach((code) => {
      expect(meta.explainMetaError({ code, error: 'Requires ads_management' })).toBe('The token lacks a permission (Requires ads_management). It needs ads_management on the ad account and pages_manage_ads on the Page.');
    });
    expect(meta.explainMetaError({ code: 3, error: 'Permission denied' })).toContain('lacks a permission');
  });

  it('explains a rejected field (100) with the user message when there is one', () => {
    expect(meta.explainMetaError({ code: 100, error: 'Invalid parameter', user_msg: 'Headline too long' })).toBe('Meta rejected a field (Invalid parameter — Headline too long). Check the copy lengths, the image, and that the ad set still exists.');
    expect(meta.explainMetaError({ code: 100, error: 'Invalid parameter' })).toBe('Meta rejected a field (Invalid parameter). Check the copy lengths, the image, and that the ad set still exists.');
  });

  it('says a network failure will be retried, and passes anything else through', () => {
    expect(meta.explainMetaError({ network: true, error: 'Could not reach Meta: ETIMEDOUT' })).toBe('Could not reach Meta: ETIMEDOUT The launcher will retry on its next run.');
    expect(meta.explainMetaError({ code: 1, error: 'An unknown error occurred', user_msg: 'Try again later' })).toBe('An unknown error occurred — Try again later');
    expect(meta.explainMetaError({ code: 1, error: 'An unknown error occurred' })).toBe('An unknown error occurred');
    expect(meta.explainMetaError(undefined)).toBe('');
  });
});
