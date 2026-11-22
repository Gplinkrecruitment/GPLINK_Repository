'use strict';
/**
 * WP-24 (Australian GP build): the "one campaign = exactly today" capture.
 *
 * `captureSingleCampaign(vi, { switchOn })` boots the REAL server in
 * local-JSON mode with a stub Graph API (ads reads/writes and the Conversions
 * API) and a stub model, at a fixed clock, and walks one full cycle of the ads
 * hub and the conversion feed for the ONE campaign that exists today:
 *
 *   1. the prompts the library builds (review, brief, critique, iterate),
 *      the ads config and the action limits;
 *   2. a UK Meta lead arriving on the webhook  -> the Conversions API request;
 *   3. the hourly sweep for a booked UK lead     -> the Conversions API request;
 *   4. a manual review run                       -> the request sent to the
 *      model, the stored review, the page payload;
 *   5. ticking one account change                -> the Graph writes, the result;
 *   6. what `GET /api/public/features` says and which tracking the sign-in and
 *      onboarding pages carry.
 *
 * tests/fixtures/au-wp24/single-campaign.json was written from the commit
 * BEFORE WP-24 changed any code (WP24_WRITE_SNAPSHOT=1) and is never rewritten
 * by a normal run. Nothing real is reached: every outbound request is answered
 * by a stub in this file.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_FILE = path.join(ROOT, 'tests', 'fixtures', 'au-wp24', 'single-campaign.json');
const FIXED_NOW = Date.parse('2026-11-20T02:00:00.000Z');
const DAY = 86400000;
const CAMPAIGN = '120248645727400648';
const ACCOUNT = '1668035273758338';
const DATASET = '31126391376976338';
const SUPER_HOST = 'wp24-ceo.gplink-test.local';
const SUPER_EMAIL = 'super.wp24@gplink-test.local';
const UK_FORM = '2370693577080684';
const UK_LEAD_ID = '1432788012009668';
const UK_LEAD_ID_2 = '1432788012009669';

const LIVE_ADSETS = [
  { id: '200', name: 'Test | Pain points', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000', optimization_goal: 'QUALITY_LEAD' }
];
const LIVE_ADS = ['1', '2', '3', '4'].map(function (id) {
  return {
    id: id, name: 'Ad ' + id, status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', created_time: '2026-10-22T00:40:28+1100',
    creative: { id: 'c' + id, title: 'No QOF. No CQC. ' + id, body: 'Body ' + id, call_to_action_type: 'BOOK_TRAVEL',
      object_story_spec: { link_data: { call_to_action: { type: 'BOOK_TRAVEL', value: { lead_gen_form_id: UK_FORM } } } } }
  };
});
function insightRow(id) {
  return { ad_id: id, ad_name: 'Ad ' + id, adset_id: '200', adset_name: 'Test | Pain points', spend: String(40 + Number(id)), impressions: '4000', reach: '2500',
    frequency: '1.6', clicks: '90', ctr: '2.25', cpm: '10.5', actions: [{ action_type: 'lead', value: '3' }, { action_type: 'link_click', value: '60' }] };
}

/** The review the stub model answers with (one account change, one brief). */
const MODEL_REVIEW = {
  headline: 'Steady week.', summary: 'Four ads live. Ad 1 books.',
  actions_today: [], ad_verdicts: [{ ad_id: '1', verdict: 'keep', why: 'Books.' }],
  improvements: [{ id: 'imp-1', title: 'More after-led lines', change: 'Lead with the after.', evidence: 'Ad 1.', applies_to: 'headline', priority: 1 }],
  what_works: [{ pattern: 'After-led jargon', evidence: 'Ad 1' }], what_doesnt: [],
  account_changes: [{ id: 'chg-pause-4', action: 'pause_ad', target_id: '4', target_name: 'Ad 4', daily_budget: 0, title: 'Pause ad 4', why: 'No bookings.', priority: 2 }],
  automation_changes: [],
  new_ad_briefs: [{ angle: '06-appraisal', image_headline: 'No appraisal. No revalidation.', image_sub: 'Australia is hiring UK-trained GPs.', headline: 'No appraisal. No revalidation.',
    primary_text: 'The appraisal folder is due again.\n\nMost Australian practices have no appraisal meeting.\n\nBook a free 30-minute call. Completely free for doctors.',
    description: 'UK-trained GPs. Free call.', image_prompt: 'A UK GP at a kitchen table at night, 35mm.', rationale: 'r', improvements_applied: ['imp-1'], why_strong: ['Ad 1 booked.'] }],
  warnings: []
};

function ukLead(over, consult) {
  return Object.assign({
    id: 'lead-uk-seed', created_at: new Date(FIXED_NOW - 2 * DAY).toISOString(), kind: 'gp', name: 'Test Ukdoctor',
    email: 'uk.seed.test@gplink-test.local', phone: '+447700900123', status: 'new',
    metadata: { source: 'meta_lead_ad', fb_lead_id: UK_LEAD_ID_2, fb_form_id: UK_FORM, fb_ad_id: '1',
      consult: Object.assign({ token: 'TOKSEED', qualified: true, is_gp: true, country: 'uk', call_booked: true,
        call_booked_at: new Date(FIXED_NOW - DAY).toISOString(), nudges: [] }, consult || {}) }
  }, over || {});
}

function ukWebhookBody() {
  return { entry: [{ changes: [{ value: {
    leadgen_id: UK_LEAD_ID, form_id: UK_FORM, ad_id: '2',
    field_data: [
      { name: 'full_name', values: ['Test Ukwebhook'] },
      { name: 'email', values: ['uk.webhook.test@gplink-test.local'] },
      { name: 'phone_number', values: ['+447700900456'] },
      { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
      { name: 'where_are_you_registered?', values: ['United Kingdom'] },
      { name: 'whats_your_main_question?', values: ['Timing'] }
    ] } }] }] };
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

/** Replace what legitimately differs between runs (ids, ports) with markers. */
function normalise(value, ports) {
  let s = JSON.stringify(value);
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  (ports || []).forEach(function (p) { s = s.split('127.0.0.1:' + p).join('127.0.0.1:<port>'); });
  return JSON.parse(s);
}

/**
 * Boot the server with the stubs. Returns a rig: { req, graph, ai, testUtils,
 * setSwitch, close, ports }. `env` is merged over the base environment.
 */
async function bootWp24Rig(vi, opts) {
  const o = opts || {};
  if (vi && o.fixedClock !== false) vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
  const runId = crypto.randomBytes(4).toString('hex');
  const dbFile = '/tmp/gplink-au-wp24-' + runId + '.json';
  const graph = { calls: [], adsets: {}, ads: {}, insights: {}, failPost: new Set() };
  graph.adsets[CAMPAIGN] = LIVE_ADSETS;
  graph.ads[CAMPAIGN] = LIVE_ADS;
  const graphServer = http.createServer(function (rq, rs) {
    const chunks = [];
    rq.on('data', function (c) { chunks.push(c); });
    rq.on('end', function () {
      const url = new URL(rq.url, 'http://x');
      const raw = Buffer.concat(chunks).toString('utf8');
      const isEvents = /\/events$/.test(url.pathname);
      let params;
      if (rq.method === 'GET') params = Object.fromEntries(url.searchParams);
      else if (isEvents) { try { params = JSON.parse(raw); } catch (e) { params = null; } }
      else params = Object.fromEntries(new URLSearchParams(raw));
      graph.calls.push({ method: rq.method, path: url.pathname, params: params, raw: isEvents ? raw : undefined });
      let out;
      const m = url.pathname.match(/^\/v[\d.]+\/(\d+)\/(adsets|ads|insights)$/);
      if (isEvents) out = { events_received: params && Array.isArray(params.data) ? params.data.length : 0, fbtrace_id: 'trace' };
      else if (rq.method === 'GET' && m && m[2] === 'adsets') out = { data: graph.adsets[m[1]] || [] };
      else if (rq.method === 'GET' && m && m[2] === 'ads') out = { data: graph.ads[m[1]] || [] };
      else if (rq.method === 'GET' && m && m[2] === 'insights') {
        const rows = (graph.ads[m[1]] || []).map(function (a) { return insightRow(a.id); });
        if (params.level === 'ad') out = { data: rows };
        else if (params.time_increment) out = { data: [{ date_start: '2026-11-19', date_stop: '2026-11-19', spend: '20', impressions: '2000', reach: '1500', clicks: '40', actions: [{ action_type: 'lead', value: '2' }] }] };
        else out = { data: rows.length ? [{ spend: '170', impressions: '16000', reach: '9000', frequency: '1.78', clicks: '360', ctr: '2.25', cpm: '10.6', actions: [{ action_type: 'lead', value: '12' }] }] : [] };
      } else if (rq.method === 'GET') out = { data: [] };
      else if (graph.failPost.has(url.pathname.replace(/^\/v[\d.]+\//, ''))) { rs.writeHead(400, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } })); return; }
      else out = { success: true };
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(out));
    });
  });
  await new Promise(function (resolve) { graphServer.listen(0, '127.0.0.1', resolve); });
  const graphPort = graphServer.address().port;

  fs.writeFileSync(dbFile, JSON.stringify({}));
  const env = Object.assign({
    AGENT_SKIP_DOTENV: 'true', NODE_ENV: 'test', AUTH_DISABLED: 'false', AUTH_SECRET: 'wp24-secret-' + runId,
    CRON_SECRET: 'test-cron-secret', REQUIRE_SUPABASE_DB: 'false', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '', ENFORCE_SAME_ORIGIN: 'false', DB_FILE_PATH: dbFile,
    SUPER_ADMIN_ALLOWED_HOSTS: SUPER_HOST, SUPER_ADMIN_EMAILS: SUPER_EMAIL, ADMIN_EMAILS: '',
    FB_LEAD_WEBHOOK_SECRET: 'test-fb-secret', FB_GP_LEAD_FORM_IDS: UK_FORM,
    META_CAPI_DATASET_ID: DATASET, META_CAPI_ACCESS_TOKEN: 'test-capi-token', META_CAPI_GRAPH_URL: 'http://127.0.0.1:' + graphPort,
    META_ADS_ACCESS_TOKEN: 'test-ads-token', META_ADS_GRAPH_URL: 'http://127.0.0.1:' + graphPort,
    ANTHROPIC_API_KEY: 'test-key-not-real',
    RESEND_API_KEY: '', DOUBLETICK_API_KEY: '', RETELL_API_KEY: '', OPENAI_API_KEY: '', SITE_ENQUIRY_NOTIFY_EMAIL: ''
  }, o.env || {});
  const savedEnv = {};
  ['AU_PATHWAY_ENABLED', 'VERCEL_ENV', 'META_CAPI_TEST_EVENT_CODE', 'META_CAPI_API_VERSION', 'FB_GRAPH_VERSION', 'FB_AU_GP_LEAD_FORM_IDS',
    'META_AU_CAPI_DATASET_ID', 'META_AU_CAPI_ACCESS_TOKEN', 'META_ADS_AU_CAMPAIGN_ID', 'META_ADS_AU_DEFAULT_ADSET_ID', 'META_AU_LEAD_FORM_ID',
    'GOOGLE_ADS_AU_CONVERSION_SEND_TO', 'META_AU_PIXEL_ID', 'ADS_AU_MIN_LIVE_ADS', 'ADS_AU_MAX_DAILY_BUDGET', 'ADS_AU_HOUSE_CONTEXT_APPROVED']
    .concat(Object.keys(env)).forEach(function (k) { savedEnv[k] = process.env[k]; });
  ['VERCEL_ENV', 'META_CAPI_TEST_EVENT_CODE', 'META_CAPI_API_VERSION', 'FB_GRAPH_VERSION', 'FB_AU_GP_LEAD_FORM_IDS', 'META_AU_CAPI_DATASET_ID',
    'META_AU_CAPI_ACCESS_TOKEN', 'META_ADS_AU_CAMPAIGN_ID', 'META_ADS_AU_DEFAULT_ADSET_ID', 'META_AU_LEAD_FORM_ID', 'GOOGLE_ADS_AU_CONVERSION_SEND_TO',
    'META_AU_PIXEL_ID', 'ADS_AU_MIN_LIVE_ADS', 'ADS_AU_MAX_DAILY_BUDGET', 'ADS_AU_HOUSE_CONTEXT_APPROVED'].forEach(function (k) { delete process.env[k]; });
  Object.keys(env).forEach(function (k) { process.env[k] = env[k]; });
  process.env.AU_PATHWAY_ENABLED = o.switchOn ? 'true' : 'false';

  const ai = { calls: [], reply: JSON.stringify(MODEL_REVIEW) };
  const realFetch = globalThis.fetch;
  const blocked = [];
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('http://127.0.0.1') === 0) return realFetch(url, init);
    if (u.indexOf('https://api.anthropic.com/') === 0) {
      let body = null;
      try { body = JSON.parse(String((init && init.body) || '')); } catch (e) { body = null; }
      ai.calls.push({ url: u, body: body });
      const text = typeof ai.reply === 'function' ? ai.reply(body) : ai.reply;
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: String(text) }], stop_reason: 'end_turn', model: body && body.model, usage: { input_tokens: 10, output_tokens: 20 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    // Anything else would be a real outbound request: record it and answer empty.
    blocked.push(u);
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };

  const serverModule = require('../../server.js');
  const server = serverModule.createServer();
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  function req(method, p, ro) {
    const r = ro || {};
    return new Promise(function (resolve, reject) {
      const headers = Object.assign({ Host: r.host || SUPER_HOST }, r.headers || {});
      if (r.cookie) headers.Cookie = r.cookie;
      const payload = r.body === undefined ? null : Buffer.from(JSON.stringify(r.body), 'utf8');
      if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      const q = http.request({ host: '127.0.0.1', port: port, path: p, method: method, headers: headers }, function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { json = null; }
          resolve({ status: res.statusCode, json: json, raw: raw, headers: res.headers });
        });
      });
      q.on('error', reject);
      q.end(payload);
    });
  }

  return {
    port: port, graphPort: graphPort, ports: [port, graphPort], graph: graph, ai: ai, blocked: blocked, dbFile: dbFile,
    testUtils: serverModule.__testUtils,
    req: req,
    ceo: function () { return { cookie: superCookie() }; },
    setSwitch: function (on) { process.env.AU_PATHWAY_ENABLED = on ? 'true' : 'false'; },
    readDb: function () { try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) { return {}; } },
    close: async function () {
      globalThis.fetch = realFetch;
      Object.keys(savedEnv).forEach(function (k) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
      await new Promise(function (resolve) { server.close(function () { resolve(); }); });
      await new Promise(function (resolve) { graphServer.close(function () { resolve(); }); });
      try { fs.unlinkSync(dbFile); } catch (e) { /* gone */ }
      if (vi && o.fixedClock !== false) vi.useRealTimers();
    }
  };
}

/** Which tracking a page file carries (never its whole text). */
function trackingFacts(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return {
    has_meta_pixel: /connect\.facebook\.net|fbq\(/.test(html),
    has_google_tag: /googletagmanager\.com|gtag\(/.test(html),
    has_data_layer: /dataLayer/.test(html)
  };
}

/** The library half: no server. */
function captureLib() {
  const adsReview = require('../../lib/ads-review.js');
  const metaAds = require('../../lib/meta-ads.js');
  const adsActions = require('../../lib/ads-actions.js');
  const adsContext = require('../../lib/ads-context.js');
  const metaCapi = require('../../lib/meta-capi.js');
  const snapshot = {
    fetched_at: new Date(FIXED_NOW).toISOString(), account: { currency: 'AUD', time_zone: 'Australia/Melbourne' },
    adsets: [{ id: '200', name: 'Test | Pain points', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: 100, rotation: 'live' }],
    ads: [{ id: '1', name: 'Ad 1', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', rotation: 'live',
      creative: { headline: 'No QOF. No CQC.', body: 'Body', image_url: '' },
      metrics: { last_7d: { spend: 41, leads: 3, cost_per_lead: 13.67, frequency: 1.6 }, last_30d: { spend: 160, leads: 9 } },
      funnel: { d7: { leads: 3, qualified: 2, booked: 1, signed_up: 0 }, d30: { leads: 9, qualified: 7, booked: 3, signed_up: 1 } }, flags: [] }],
    totals: { last_7d: { spend: 41 }, last_30d: { spend: 160 } }, funnel: { d7: {}, d30: {} }, daily: [], errors: [], live_ads: 1,
    ecosystem: { automation: adsContext.AUTOMATION || null, voice_of_lead: { objections: [] }, consult_themes: [], demand: { settings: {} }, funnel_30d: {} }
  };
  const review = { summary: 'Steady.', what_works: [{ pattern: 'After-led', evidence: 'Ad 1' }], what_doesnt: [], improvements: MODEL_REVIEW.improvements };
  const draft = Object.assign({ layout: { placement: 'bottom', focus: 0.5 } }, MODEL_REVIEW.new_ad_briefs[0]);
  const row = ukLead();
  const cfg = metaCapi.metaCapiConfigFromEnv({ META_CAPI_DATASET_ID: DATASET, META_CAPI_ACCESS_TOKEN: 'test-capi-token' });
  const events = metaCapi.buildMetaLeadStageEvents(row, metaCapi.deriveMetaLeadStages(row, { now: FIXED_NOW }), cfg, { now: FIXED_NOW });
  return {
    review_messages: adsReview.buildReviewMessages({ snapshot: snapshot, previousReview: review, today: '2026-11-20', drafts: [], imageSettings: {}, automation: null }),
    brief_messages: adsReview.buildBriefMessages({ snapshot: snapshot, review: review, improvements: review.improvements, count: 2, existingDrafts: [] }),
    critique_messages: adsReview.buildCritiqueMessages({ snapshot: snapshot, review: review, draft: draft }),
    iterate_messages: adsReview.buildIterateMessages({ draft: draft, instruction: 'Shorter headline.' }),
    house_context: adsReview.HOUSE_CONTEXT,
    ads_config: metaAds.adsConfig({}),
    action_limits: adsActions.limits({}),
    actions: adsActions.ACTIONS.slice(),
    capi_config: cfg,
    capi_events: events,
    capi_body: metaCapi.serializeMetaCapiBody(events, cfg)
  };
}

/** The whole capture. See the top of this file. */
async function captureSingleCampaign(vi, opts) {
  const o = opts || {};
  const out = { lib: captureLib() };
  const rig = await bootWp24Rig(vi, { switchOn: !!o.switchOn });
  try {
    rig.testUtils.__resetSiteEnquiriesForTest();
    rig.testUtils.__seedSiteEnquiriesForTest([ukLead()]);

    // 2. A UK lead on the webhook.
    const wh = await rig.req('POST', '/api/webhooks/facebook-lead?secret=test-fb-secret', { body: ukWebhookBody(), host: 'localhost' });
    const whEvents = rig.graph.calls.filter(function (c) { return /\/events$/.test(c.path); });
    out.webhook = { status: wh.status, capi: whEvents.map(function (c) { return { path: c.path, raw: c.raw }; }) };
    rig.graph.calls.length = 0;

    // 3. The hourly sweep (the seeded booked lead; the webhook lead has nothing new).
    const cron = await rig.req('GET', '/api/cron/meta-lead-stages', { headers: { Authorization: 'Bearer test-cron-secret' }, host: 'localhost' });
    out.cron = { status: cron.status, json: cron.json, capi: rig.graph.calls.filter(function (c) { return /\/events$/.test(c.path); }).map(function (c) { return { path: c.path, raw: c.raw }; }) };
    rig.graph.calls.length = 0;

    // 4. A review run, then the page.
    const rev = await rig.req('POST', '/api/ceo/ads/review', Object.assign({ body: {} }, rig.ceo()));
    out.review = {
      status: rev.status, response: rev.json,
      graph_reads: rig.graph.calls.map(function (c) { return { method: c.method, path: c.path, params: Object.assign({}, c.params, { access_token: undefined }) }; }),
      model_requests: rig.ai.calls.map(function (c) { return c.body; })
    };
    rig.graph.calls.length = 0;
    const page = await rig.req('GET', '/api/ceo/ads', rig.ceo());
    const pageJson = page.json || {};
    // WP-24 adds `campaigns` BESIDE today's payload with the switch on; the
    // comparison is of everything that existed before.
    out.page_extra_keys = Object.keys(pageJson).filter(function (k) { return k === 'campaigns'; });
    delete pageJson.campaigns;
    out.page = { status: page.status, json: pageJson };
    rig.graph.calls.length = 0;

    // 5. Tick the change.
    const reviewId = rev.json && rev.json.review && rev.json.review.id;
    const stored = (rev.json && rev.json.review && rev.json.review.review && rev.json.review.review.account_changes) || [];
    const ap = await rig.req('POST', '/api/ceo/ads/changes/apply', Object.assign({ body: { review_id: reviewId, ids: stored.map(function (c) { return c.id; }) } }, rig.ceo()));
    out.apply = {
      status: ap.status, json: ap.json,
      graph_writes: rig.graph.calls.filter(function (c) { return c.method !== 'GET'; }).map(function (c) { return { method: c.method, path: c.path, params: Object.assign({}, c.params, { access_token: undefined }) }; })
    };

    // 6. Features and page tracking.
    const feat = await rig.req('GET', '/api/public/features', { host: 'localhost' });
    out.features_keys = Object.keys(feat.json || {}).sort();
    out.pages = { signin: trackingFacts('pages/signin.html'), onboarding: trackingFacts('pages/onboarding.html') };
    out.blocked_outbound = rig.blocked.slice();
    return normalise(out, rig.ports);
  } finally {
    await rig.close();
  }
}

function readSnapshot() { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
function writeSnapshot(value) {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(value, null, 1) + '\n');
}

module.exports = {
  SNAPSHOT_FILE, FIXED_NOW, DAY, CAMPAIGN, ACCOUNT, DATASET, SUPER_HOST, SUPER_EMAIL, UK_FORM, UK_LEAD_ID, UK_LEAD_ID_2,
  LIVE_ADSETS, LIVE_ADS, MODEL_REVIEW,
  ukLead, ukWebhookBody, bootWp24Rig, captureLib, captureSingleCampaign, normalise, readSnapshot, writeSnapshot, trackingFacts
};
