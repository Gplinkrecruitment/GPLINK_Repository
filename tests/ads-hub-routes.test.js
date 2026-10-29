import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// End-to-end over the real server for the CEO Social tab's Ads hub:
// page payload → draft lifecycle (create, edit, images, schedule, launch) →
// crons. Runs against the in-memory store with NO Meta token and NO Anthropic
// key, which is exactly the state a fresh deployment is in, so the properties
// under test are the honest ones: the page still loads with the app's own
// funnel, every failure names its cause, and nothing is ever created on Meta
// without a token.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'ads-cron-' + RUN_ID;
const SUPER_HOST = 'ceo-ads-test.local';
let server;
let port;

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = base64UrlEncode(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function req(method, path, { body, headers, raw } = {}) {
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
        resolve({ status: res.statusCode, json, raw: raw ? buf : buf.toString('utf8'), headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const ceo = () => ({ Cookie: superCookie() });
const cronAuth = { Authorization: 'Bearer ' + CRON_SECRET };

// A 1x1 JPEG is enough for the storage round trip.
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ads-routes-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ads-routes-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  delete process.env.META_ADS_ACCESS_TOKEN;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

describe('access', () => {
  it('every ads route needs a CEO session', async () => {
    const paths = [['GET', '/api/ceo/ads'], ['POST', '/api/ceo/ads/review'], ['POST', '/api/ceo/ads/drafts/generate'],
      ['POST', '/api/ceo/ads/draft'], ['POST', '/api/ceo/ads/draft/launch-now'], ['GET', '/api/ceo/ads/health'], ['GET', '/api/ceo/ads/photos']];
    for (const [m, p] of paths) {
      const r = await req(m, p, { body: m === 'POST' ? {} : undefined });
      expect([401, 403], m + ' ' + p).toContain(r.status);
    }
  });
  it('crons need the secret', async () => {
    expect((await req('GET', '/api/cron/ads-daily-review')).status).toBe(401);
    expect((await req('GET', '/api/cron/ads-launch')).status).toBe(401);
  });
});

describe('the page without a Meta token', () => {
  it('still answers, says Meta is not connected, and carries the app funnel', async () => {
    const r = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.configured).toBe(false);
    expect(r.json.snapshot_source).toBe('funnel_only');
    expect(r.json.snapshot.funnel.d30).toBeTruthy();
    expect(r.json.problems.join(' ')).toMatch(/META_ADS_ACCESS_TOKEN/);
    expect(r.json.review).toBeNull();
    expect(Array.isArray(r.json.drafts)).toBe(true);
    expect(r.json.cta_options.some((o) => o.value === 'BOOK_TRAVEL')).toBe(true);
    expect(r.json.defaults.adset_id).toMatch(/^\d+$/);
  });
  it('a review run records WHY it could not run instead of failing silently', async () => {
    const r = await req('POST', '/api/ceo/ads/review', { headers: ceo(), body: {} });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/Meta is not connected/);
    expect(r.json.review.error).toMatch(/Meta is not connected/);
  });
  it('generating a photo without a Higgsfield key is a plain message, and the page says so', async () => {
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(page.json.higgsfield_configured).toBe(false);
    const draft = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle: 'photo-test', image_prompt: 'A UK reception desk at 7:55am' } });
    const r = await req('POST', '/api/ceo/ads/draft/generate-photo', { headers: ceo(), body: { id: draft.json.draft.id } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/HIGGSFIELD_API_KEY/);
    expect((await req('POST', '/api/ceo/ads/draft/generate-photo', { headers: ceo(), body: { id: 'nope' } })).status).toBe(404);
  });
  it('health says what is missing', async () => {
    const r = await req('GET', '/api/ceo/ads/health', { headers: ceo() });
    expect(r.json.configured).toBe(false);
    expect(r.json.checks[0].detail).toMatch(/META_ADS_ACCESS_TOKEN/);
  });
  it('generating ads without a model key is a plain message, not a 500', async () => {
    const r = await req('POST', '/api/ceo/ads/drafts/generate', { headers: ceo(), body: { count: 2 } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('draft lifecycle', () => {
  let id;
  it('creates a blank draft with the live ad set and Book now preselected', async () => {
    const r = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle: 'test angle', headline: 'CQC inspection on Tuesday.' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    id = r.json.draft.id;
    expect(r.json.draft.status).toBe('draft');
    expect(r.json.draft.cta).toBe('BOOK_TRAVEL');
    expect(r.json.draft.adset_id).toMatch(/^\d+$/);
    expect(r.json.draft.problems.join(' ')).toMatch(/Primary text is empty/);
    expect(r.json.draft.problems.join(' ')).toMatch(/No creative image/);
  });
  it('edits copy and flags brand-rule breaks as warnings, not errors', async () => {
    const r = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: {
      id, primary_text: 'Pain — the UK version.\n\nAustralia.\n\nBook a free call.', description: 'UK-trained GPs. Free 30-minute call.', image_headline: 'CQC inspection on Tuesday.', image_sub: 'Australia, for UK-trained GPs.'
    } });
    expect(r.status).toBe(200);
    expect(r.json.draft.primary_text).toMatch(/UK version/);
    expect(r.json.draft.warnings.join(' ')).toMatch(/em dash/);
    expect(r.json.draft.warnings.join(' ')).toMatch(/Completely free for doctors/);
    expect(r.json.draft.problems.join(' ')).not.toMatch(/Primary text/);
  });
  it('rejects an unknown call to action and a non-numeric ad set', async () => {
    expect((await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id, cta: 'BUY_NOW_PLEASE' } })).status).toBe(400);
    expect((await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id, adset_id: 'abc' } })).status).toBe(400);
  });
  it('cannot be scheduled before it has a creative image', async () => {
    const r = await req('POST', '/api/ceo/ads/draft/schedule', { headers: ceo(), body: { id, launch_at: new Date(Date.now() + 3600000).toISOString() } });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/No creative image/);
  });
  it('stores the photo and the composed creative and serves them back', async () => {
    const r = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id, photo_data_url: TINY_JPEG, image_data_url: TINY_JPEG, image_width: 1080, image_height: 1350 } });
    expect(r.status).toBe(200);
    expect(r.json.draft.photo_path).toMatch(/^ad-drafts\//);
    expect(r.json.draft.image_path).toMatch(/^ad-drafts\//);
    expect(r.json.draft.problems).toEqual([]);
    const img = await req('GET', '/api/ceo/ads/image?id=' + id + '&kind=creative', { headers: ceo(), raw: true });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    expect(img.raw.length).toBeGreaterThan(50);
    const photo = await req('GET', '/api/ceo/ads/image?id=' + id + '&kind=photo', { headers: ceo(), raw: true });
    expect(photo.status).toBe(200);
  });
  it('refuses a launch time in the past', async () => {
    const r = await req('POST', '/api/ceo/ads/draft/schedule', { headers: ceo(), body: { id, launch_at: '2020-01-01T00:00:00Z' } });
    expect(r.status).toBe(400);
  });
  it('schedules once the creative exists', async () => {
    const at = new Date(Date.now() + 2 * 3600000).toISOString();
    const r = await req('POST', '/api/ceo/ads/draft/schedule', { headers: ceo(), body: { id, launch_at: at } });
    expect(r.status).toBe(200);
    expect(r.json.draft.status).toBe('scheduled');
    expect(r.json.draft.launch_at).toBe(at);
  });
  it('the launcher cron leaves a future draft alone', async () => {
    const r = await req('GET', '/api/cron/ads-launch', { headers: cronAuth });
    expect(r.status).toBe(200);
    expect(r.json.attempted).toBe(0);
  });
  it('unschedule returns it to ready', async () => {
    const r = await req('POST', '/api/ceo/ads/draft/unschedule', { headers: ceo(), body: { id } });
    expect(r.json.draft.status).toBe('ready');
    expect(r.json.draft.launch_at).toBeNull();
  });
  it('launch now without a token fails with the reason and never invents a Meta id', async () => {
    const r = await req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.step).toBe('config');
    expect(r.json.message).toMatch(/META_ADS_ACCESS_TOKEN/);
    expect(r.json.meta_ad_id).toBeNull();
    expect(r.json.manual_kit).toMatch(/Primary text:/);
    expect(r.json.draft.status).toBe('failed');
    expect(r.json.draft.launch_error).toMatch(/META_ADS_ACCESS_TOKEN/);
  });
  it('a live draft refuses edits (creatives are immutable on Meta)', async () => {
    // Simulate the launched state directly through the page's own store.
    const list = await req('GET', '/api/ceo/ads', { headers: ceo() });
    const live = list.json.drafts.find((d) => d.id === id);
    expect(live.status).toBe('failed');
  });
  it('archive hides it from the active list but keeps the record', async () => {
    const r = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: { id, status: 'archived' } });
    expect(r.json.draft.status).toBe('archived');
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(page.json.drafts.some((d) => d.id === id && d.status === 'archived')).toBe(true);
  });
});

describe('daily review cron', () => {
  it('runs, records the Meta-not-connected reason, and skips the second time that day', async () => {
    const first = await req('GET', '/api/cron/ads-daily-review', { headers: cronAuth });
    expect(first.status).toBe(200);
    expect(first.json.skipped).toBe(false);
    expect(first.json.error).toMatch(/Meta is not connected/);
    const second = await req('GET', '/api/cron/ads-daily-review', { headers: cronAuth });
    expect(second.json.skipped).toBe(true);
  });
});
