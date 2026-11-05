import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// End-to-end over the real server for POST /api/ceo/ads/changes/apply: the
// review's ticked account changes (pause / resume an ad or ad set, change a
// daily budget, launch a draft) applied to a stub Graph API. The review row
// and the drafts are seeded into the in-memory store before the server boots;
// the stub records every write so the test can say exactly what Meta was told.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-ads-changes.local';
const CAMPAIGN = '120248645727400648';
let server;
let port;
let graph;
let graphPort;
const graphCalls = [];
const failPost = new Set();

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = base64UrlEncode(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: Object.assign({ Host: SUPER_HOST }, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, raw: buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const ceo = () => ({ Cookie: superCookie() });

// The account as the stub reports it (static: the server re-reads it before
// every apply, which is the point).
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const BRIEF = { angle: '05-duty-day', image_headline: 'Duty day. Every day.', image_sub: 'Australia is hiring UK-trained GPs.', headline: 'Duty day. Every day.', primary_text: 'The duty list fills before you sit down.\n\nMost Australian practices run fifteen-minute consults.\n\nBook a free 30-minute call. Completely free for doctors.', description: 'UK-trained GPs. Free 30-minute call.', image_prompt: 'Morning light in a consulting room, 4:5.', rationale: 'r', improvements_applied: [] };

const LIVE_ADSETS = [
  { id: '200', name: 'Live set', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '10000', optimization_goal: 'QUALITY_LEAD' },
  { id: '201', name: 'Old set', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '6000', optimization_goal: 'QUALITY_LEAD' }
];
const LIVE_ADS = [
  { id: '1', name: 'Ad one', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', created_time: '2026-10-22T00:40:28+1100', creative: { id: 'c1', title: 'One' } },
  { id: '2', name: 'Ad two', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '200', created_time: '2026-10-22T00:40:28+1100', creative: { id: 'c2', title: 'Two' } },
  { id: '3', name: 'Ad three', status: 'PAUSED', effective_status: 'PAUSED', adset_id: '200', created_time: '2026-10-22T00:40:28+1100', creative: { id: 'c3', title: 'Three' } },
  { id: '9', name: 'Old ad', status: 'ACTIVE', effective_status: 'ADSET_PAUSED', adset_id: '201', created_time: '2026-09-30T20:52:13+1000', creative: { id: 'c9', title: 'Old' } }
];

function change(over) {
  return Object.assign({ id: 'chg-1', action: 'pause_ad', target_id: '1', target_name: 'Ad one', daily_budget: 0, title: 'Pause ad one', why: 'Below the rule.', priority: 2, applied: null }, over || {});
}
function reviewRow(id, changes, extra) {
  const x = extra || {};
  const now = x.created_at || new Date().toISOString();
  return {
    id, review_date: now.slice(0, 10), kind: 'manual', model: 'test', error: null, created_by: 'seed', created_at: now,
    snapshot: {
      fetched_at: now, account: { currency: 'AUD', time_zone: 'Australia/Melbourne' },
      adsets: LIVE_ADSETS.map((a) => ({ id: a.id, name: a.name, status: a.status, effective_status: a.effective_status, daily_budget: Number(a.daily_budget) / 100, optimization_goal: a.optimization_goal })),
      ads: LIVE_ADS.map((a) => ({ id: a.id, name: a.name, status: a.status, effective_status: a.effective_status, adset_id: a.adset_id, adset_name: a.adset_id === '200' ? 'Live set' : 'Old set', creative: { headline: a.creative.title }, metrics: {}, funnel: {}, flags: [] })),
      totals: {}, funnel: { d7: {}, d30: {} }, funnel_unattributed: {}, daily: [], errors: [], live_ads: 2
    },
    review: { headline: 'h', summary: 's', actions_today: [], ad_verdicts: [], improvements: [], account_changes: changes, what_works: [], what_doesnt: [], new_ad_briefs: x.briefs || [], warnings: [] }
  };
}

beforeAll(async () => {
  // A Graph API stand-in: the campaign's ad sets and ads, and { success: true }
  // for every POST /{id} except the ids in failPost.
  graph = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const url = new URL(rq.url, 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      const params = rq.method === 'GET' ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(body));
      graphCalls.push({ method: rq.method, path: url.pathname, params });
      let status = 200;
      let out;
      if (rq.method === 'GET' && url.pathname === '/v21.0/' + CAMPAIGN + '/adsets') out = { data: LIVE_ADSETS };
      else if (rq.method === 'GET' && url.pathname === '/v21.0/' + CAMPAIGN + '/ads') out = { data: LIVE_ADS };
      else if (rq.method === 'GET') out = { data: [] };
      else if (failPost.has(url.pathname.replace('/v21.0/', ''))) { status = 400; out = { error: { message: 'Invalid parameter', code: 100, error_user_msg: 'This ad is in review.' } }; }
      else if (url.pathname === '/v21.0/act_1668035273758338/adimages') out = { images: { x: { hash: 'hash-1', url: '' } } };
      else if (url.pathname === '/v21.0/act_1668035273758338/adcreatives') out = { id: '555001' };
      else if (url.pathname === '/v21.0/act_1668035273758338/ads') out = { id: '120259999' };
      else out = { success: true };
      rs.writeHead(status, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => graph.listen(0, '127.0.0.1', () => { graphPort = graph.address().port; resolve(); }));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ads-changes-' + RUN_ID;
  process.env.CRON_SECRET = 'cron-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ads-changes-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.META_ADS_ACCESS_TOKEN = 'test-token-' + RUN_ID;
  process.env.META_ADS_GRAPH_URL = 'http://127.0.0.1:' + graphPort;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ADS_LAUNCH_DISABLED;

  // Seed: three reviews with changes, one bare draft (no creative yet).
  const now = new Date().toISOString();
  fs.writeFileSync(process.env.DB_FILE_PATH, JSON.stringify({
    adReviews: [
      reviewRow('rev-1', [
        change({ id: 'chg-1', action: 'pause_ad', target_id: '1', priority: 1 }),
        change({ id: 'chg-2', action: 'pause_ad', target_id: '3', target_name: 'Ad three', title: 'Pause ad three' }),
        change({ id: 'chg-3', action: 'set_adset_daily_budget', target_id: '200', target_name: 'Live set', daily_budget: 150, title: 'Raise the budget to 150' }),
        change({ id: 'chg-4', action: 'pause_ad', target_id: '2', target_name: 'Ad two', title: 'Pause ad two', priority: 2 }),
        change({ id: 'chg-5', action: 'launch_draft', target_id: 'd-bare', target_name: 'bare', title: 'Launch the bare draft' }),
        change({ id: 'chg-6', action: 'resume_adset', target_id: '201', target_name: 'Old set', title: 'Resume the old set' }),
        change({ id: 'chg-7', action: 'set_adset_daily_budget', target_id: '200', target_name: 'Live set', daily_budget: 900, title: 'Budget to 900' })
      ]),
      reviewRow('rev-2', [
        change({ id: 'chg-1', action: 'pause_ad', target_id: '2', target_name: 'Ad two', title: 'Pause ad two' }),
        change({ id: 'chg-2', action: 'set_adset_daily_budget', target_id: '200', target_name: 'Live set', daily_budget: 120, title: 'Budget to 120' })
      ]),
      reviewRow('rev-3', [change({ id: 'chg-1', action: 'pause_ad', target_id: '1' })]),
      // Older than the others on purpose: the page shows the newest review, and
      // the tests above read rev-1 there.
      reviewRow('rev-4', [change({ id: 'chg-1', action: 'create_ad', target_id: '05-duty-day', target_name: 'Duty day. Every day.', title: 'Create and launch the duty-day ad' })],
        { created_at: new Date(Date.now() - 3600000).toISOString(), briefs: [BRIEF] }),
      reviewRow('rev-5', [change({ id: 'chg-1', action: 'create_ad', target_id: '06-appraisal', target_name: 'Appraisal season again?', title: 'Create and launch the appraisal ad' })],
        { created_at: new Date(Date.now() - 7200000).toISOString(), briefs: [Object.assign({}, BRIEF, { angle: '06-appraisal', headline: 'Appraisal season again?', image_headline: 'Appraisal season again?' })] })
    ],
    adDrafts: [{ id: 'd-bare', status: 'draft', angle: 'bare', headline: 'Bare', primary_text: 'x', description: '', image_headline: '', image_sub: '', cta: 'BOOK_TRAVEL', adset_id: '200', layout: {}, improvements: [], history: [], launch_attempts: 0, created_at: now, updated_at: now }]
  }, null, 2));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (graph) await new Promise((resolve) => graph.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

const posts = () => graphCalls.filter((c) => c.method === 'POST').map((c) => [c.path.replace('/v21.0/', ''), c.params.status || c.params.daily_budget]);

describe('POST /api/ceo/ads/changes/apply', () => {
  it('needs a CEO session, a known review and at least one unapplied id', async () => {
    expect([401, 403]).toContain((await req('POST', '/api/ceo/ads/changes/apply', { body: {} })).status);
    const missing = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'nope', ids: ['chg-1'] } });
    expect(missing.status).toBe(404);
    const none = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-1', ids: [] } });
    expect(none.status).toBe(400);
    expect(none.json.message).toMatch(/Nothing to apply/);
    expect(graphCalls.filter((c) => c.method === 'POST').length).toBe(0);
  });

  it('the page lists the changes with a plain sentence each, before anything is applied', async () => {
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(page.status).toBe(200);
    expect(page.json.configured).toBe(true);
    const list = page.json.review.review.account_changes;
    expect(list.length).toBe(7);
    expect(list[0]).toMatchObject({ id: 'chg-1', label: 'Pause ad', effect: 'Pauses the ad "Ad one" (live now, in Live set).', applied: null });
    expect(list[2].effect).toBe('Changes the daily budget of "Live set" from A$100 to A$150 a day.');
    expect(list[5].effect).toMatch(/^Resumes the ad set "Old set" \(paused now, A\$60 a day\)/);
  });

  it('re-checks every ticked change against the live account, applies the safe ones in order, and records each outcome', async () => {
    graphCalls.length = 0;
    const r = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-1', ids: ['chg-1', 'chg-2', 'chg-3', 'chg-4', 'chg-5', 'chg-6', 'chg-7'] } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.stored).toBe(true);
    expect(r.json.counts).toEqual({ applied: 3, pending: 0, skipped: 1, failed: 3 });
    expect(r.json.summary).toBe('3 applied, 1 already done, 3 not applied.');
    // The account was read fresh first (ad sets, ads and the time rules, so a
    // set the clock has off is not mistaken for a hand pause), then exactly
    // three writes, resumes and budgets before pauses.
    expect(graphCalls.filter((c) => c.method === 'GET').map((c) => c.path).sort()).toEqual(['/v21.0/' + CAMPAIGN + '/ads', '/v21.0/' + CAMPAIGN + '/adsets', '/v21.0/act_1668035273758338/adrules_library']);
    expect(posts()).toEqual([['201', 'ACTIVE'], ['200', '15000'], ['1', 'PAUSED']]);
    const by = {}; r.json.results.forEach((x) => { by[x.id] = x; });
    expect(by['chg-1']).toMatchObject({ ok: true, message: 'Paused.' });
    expect(by['chg-2']).toMatchObject({ ok: false, skipped: true, message: 'Already paused.' });
    expect(by['chg-3']).toMatchObject({ ok: true, before: 100, after: 150 });
    expect(by['chg-4'].ok).toBe(false);
    expect(by['chg-4'].message).toMatch(/would leave 0 live ads/);
    expect(by['chg-5'].message).toMatch(/not ready/);
    expect(by['chg-6']).toMatchObject({ ok: true, message: 'Ad set live again.' });
    expect(by['chg-7'].message).toMatch(/ceiling/);

    // What happened is on the review row, so the page shows it after a reload.
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    const list = page.json.review.review.account_changes;
    const get = (id) => list.find((c) => c.id === id).applied;
    expect(get('chg-1')).toMatchObject({ ok: true, skipped: false, by: 'super@gplink-test.local', before: 'ACTIVE', after: 'PAUSED' });
    expect(get('chg-2')).toMatchObject({ ok: true, skipped: true });
    expect(get('chg-4')).toMatchObject({ ok: false });
    expect(get('chg-4').message).toMatch(/would leave/);
    expect(get('chg-7')).toMatchObject({ ok: false });
    expect(typeof get('chg-1').at).toBe('string');

    // Applied ones cannot be applied twice.
    const again = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-1', ids: ['chg-1', 'chg-2', 'chg-3'] } });
    expect(again.status).toBe(400);
    // A refused one can be ticked again, and is judged against the account as
    // it is NOW (the stub still reports ad one live, so ad two may pause).
    graphCalls.length = 0;
    const retry = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-1', ids: ['chg-4'] } });
    expect(retry.status).toBe(200);
    expect(retry.json.counts).toEqual({ applied: 1, pending: 0, skipped: 0, failed: 0 });
    expect(posts()).toEqual([['2', 'PAUSED']]);
  });

  it('a refusal from Meta on one change is reported on that line and does not stop the others', async () => {
    graphCalls.length = 0;
    failPost.add('2');
    const r = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-2', ids: ['chg-1', 'chg-2'] } });
    failPost.delete('2');
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ applied: 1, pending: 0, skipped: 0, failed: 1 });
    const by = {}; r.json.results.forEach((x) => { by[x.id] = x; });
    expect(by['chg-1'].ok).toBe(false);
    expect(by['chg-1'].message).toMatch(/Meta rejected a field.*This ad is in review/);
    expect(by['chg-2']).toMatchObject({ ok: true, after: 120 });
    expect(posts()).toEqual([['200', '12000'], ['2', 'PAUSED']]);
  });

  it('the kill switch and a missing token stop everything before any read or write', async () => {
    graphCalls.length = 0;
    process.env.ADS_LAUNCH_DISABLED = 'true';
    const held = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-3', ids: ['chg-1'] } });
    delete process.env.ADS_LAUNCH_DISABLED;
    expect(held.status).toBe(409);
    expect(held.json.message).toMatch(/ADS_LAUNCH_DISABLED/);
    const token = process.env.META_ADS_ACCESS_TOKEN;
    delete process.env.META_ADS_ACCESS_TOKEN;
    const noToken = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-3', ids: ['chg-1'] } });
    process.env.META_ADS_ACCESS_TOKEN = token;
    expect(noToken.status).toBe(400);
    expect(noToken.json.message).toMatch(/Meta is not connected/);
    expect(graphCalls.length).toBe(0);
    // Still unapplied afterwards.
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(page.json.review.review.account_changes.length).toBe(7);
  });
});

describe('create_ad through POST /api/ceo/ads/changes/apply', () => {
  const stored = () => JSON.parse(fs.readFileSync(process.env.DB_FILE_PATH, 'utf8'));
  it('writes the draft at once (pending), then the ad launches by itself when the page saves the creative', async () => {
    graphCalls.length = 0;
    const r = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-4', ids: ['chg-1'] } });
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ applied: 0, pending: 1, skipped: 0, failed: 0 });
    expect(r.json.summary).toBe('1 new ad started (launches when the photo lands).');
    expect(r.json.results[0]).toMatchObject({ ok: true, pending: true });
    // No Higgsfield key in this test, so the owner is told to add the photo.
    expect(r.json.results[0].message).toMatch(/green box.*Photos are off.*then approve it/);
    expect(posts()).toEqual([]);

    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    const draft = page.json.drafts.find((d) => d.angle === '05-duty-day');
    expect(draft).toBeTruthy();
    expect(draft.review_id).toBe('rev-4');
    expect(draft.status).toBe('draft');
    expect(draft.headline).toBe('Duty day. Every day.');
    expect(draft.layout.auto_launch).toMatchObject({ change_id: 'chg-1', review_id: 'rev-4', by: 'super@gplink-test.local', change_title: 'Create and launch the duty-day ad', approved_at: null });
    const pendingChange = stored().adReviews.find((x) => x.id === 'rev-4').review.account_changes[0];
    expect(pendingChange.applied).toMatchObject({ ok: true, pending: true, draft_id: draft.id });

    // Submit again while it is pending: nothing to do (ok + pending counts as applied).
    const again = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-4', ids: ['chg-1'] } });
    expect(again.status).toBe(400);

    // The page composes the creative and saves it: NOT published, the owner
    // has not approved it yet; the change says so.
    graphCalls.length = 0;
    const save = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id: draft.id, image_data_url: TINY_JPEG, image_width: 1080, image_height: 1350, status: 'ready' } });
    expect(save.status).toBe(200);
    expect(save.json.ok).toBe(true);
    expect(save.json.auto_launch).toMatchObject({ ok: true, awaiting_approval: true, meta_ad_id: null });
    expect(save.json.draft.status).toBe('ready');
    expect(save.json.draft.meta_ad_id).toBeFalsy();
    expect(posts()).toEqual([]);
    expect(stored().adReviews.find((x) => x.id === 'rev-4').review.account_changes[0].applied).toMatchObject({ ok: true, pending: true, awaiting_approval: true });
    expect(stored().adReviews.find((x) => x.id === 'rev-4').review.account_changes[0].applied.message).toMatch(/Approve the ad/);

    // Approval is only for drafts the review wrote.
    expect((await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: 'd-bare' } })).status).toBe(400);
    expect((await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: 'nope' } })).status).toBe(404);

    // The owner approves on the card: the creative is ready, so it publishes at once.
    const ok = await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: draft.id, approved: true } });
    expect(ok.status).toBe(200);
    expect(ok.json.approved).toBe(true);
    expect(ok.json.auto_launch).toMatchObject({ ok: true, held: false, meta_ad_id: '120259999', message: 'Launched as ad 120259999.' });
    expect(ok.json.draft.status).toBe('live');
    expect(ok.json.draft.layout.auto_launch.approved_by).toBe('super@gplink-test.local');
    expect(graphCalls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/v21.0/act_1668035273758338/adimages', '/v21.0/act_1668035273758338/adcreatives', '/v21.0/act_1668035273758338/ads'
    ]);
    const doneChange = stored().adReviews.find((x) => x.id === 'rev-4').review.account_changes[0];
    expect(doneChange.applied).toMatchObject({ ok: true, pending: false, meta_ad_id: '120259999', after: 'live', draft_id: draft.id });
    // Already live: approving again is refused.
    expect((await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: draft.id } })).status).toBe(409);

    // A plain save of some other draft never launches anything.
    const other = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id: 'd-bare', headline: 'Bare, edited' } });
    expect(other.json.auto_launch).toBeNull();
  });

  it('approving before the creative exists makes the ad publish itself the moment the creative is saved; withdrawing approval stops that', async () => {
    const r = await req('POST', '/api/ceo/ads/changes/apply', { headers: ceo(), body: { review_id: 'rev-5', ids: ['chg-1'] } });
    expect(r.json.counts.pending).toBe(1);
    const draft = (await req('GET', '/api/ceo/ads', { headers: ceo() })).json.drafts.find((d) => d.angle === '06-appraisal');
    expect(draft.layout.auto_launch.change_title).toBe('Create and launch the appraisal ad');
    // Approve while there is no creative: nothing to launch yet.
    const ok = await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: draft.id, approved: true } });
    expect(ok.status).toBe(200);
    expect(ok.json.auto_launch).toBeNull();
    expect(ok.json.draft.layout.auto_launch.approved_at).toBeTruthy();
    expect(stored().adReviews.find((x) => x.id === 'rev-5').review.account_changes[0].applied.message).toMatch(/^Approved\./);
    // Withdraw, then the creative lands: it stays unpublished.
    const no = await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: draft.id, approved: false } });
    expect(no.json.approved).toBe(false);
    expect(no.json.draft.layout.auto_launch.approved_at).toBeNull();
    graphCalls.length = 0;
    const save1 = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id: draft.id, image_data_url: TINY_JPEG, image_width: 1080, image_height: 1350, status: 'ready' } });
    expect(save1.json.auto_launch.awaiting_approval).toBe(true);
    expect(posts()).toEqual([]);
    // Approve again: the creative is there, so it publishes now.
    const yes = await req('POST', '/api/ceo/ads/draft/approve', { headers: ceo(), body: { id: draft.id, approved: true } });
    expect(yes.json.auto_launch).toMatchObject({ ok: true, meta_ad_id: '120259999' });
    expect(yes.json.draft.status).toBe('live');
    expect(stored().adReviews.find((x) => x.id === 'rev-5').review.account_changes[0].applied).toMatchObject({ ok: true, pending: false, after: 'live' });
  });
});
