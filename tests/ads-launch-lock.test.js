import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// 8 Nov 2026, 19:14 UTC: the owner's "Launch now" reached the server twice,
// seven seconds apart (a reload or a second tab), while the first launch was
// still talking to Meta. The only guard was "is it live yet?" — it was not —
// so the whole chain ran again. Meta de-duplicates the image and the creative
// (same ids both times) but not the ad: two ads, and the app stored the id
// of the second one. These tests run the real server against a slow fake
// Meta and prove the lock: one launch per draft at a time, the cron leaves a
// fresh lock alone, and the lock is released when the launch finishes.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'ads-lock-cron-' + RUN_ID;
const SUPER_HOST = 'ceo-ads-lock.local';
let server, port, meta, metaPort;
const metaCalls = [];

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
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const ceo = () => ({ Cookie: superCookie() });
const cronAuth = { Authorization: 'Bearer ' + CRON_SECRET };
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8AVN//2Q==';

// A Meta that takes 400 ms to answer, so a launch holds the lock long enough
// for a second request to collide with it. 'down' = a transient 500 at the
// first step; 'ok' = the three creates succeed with fixed ids.
let metaMode = 'down';
function fakeMeta() {
  return http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      const path = rq.url.split('?')[0];
      metaCalls.push({ method: rq.method, path, at: Date.now() });
      setTimeout(() => {
        rs.writeHead(metaMode === 'ok' ? 200 : 500, { 'Content-Type': 'application/json' });
        if (metaMode !== 'ok') return rs.end(JSON.stringify({ error: { message: 'fake Meta is down', code: 1 } }));
        if (/\/adimages$/.test(path)) return rs.end(JSON.stringify({ images: { 'x.jpg': { hash: 'fakehash1', url: 'http://x/y.jpg' } } }));
        if (/\/adcreatives$/.test(path)) return rs.end(JSON.stringify({ id: '9001' }));
        if (/\/ads$/.test(path)) return rs.end(JSON.stringify({ id: '120249000000000001' }));
        rs.end(JSON.stringify({ success: true }));
      }, 400);
    });
  });
}

async function launchableDraft(angle) {
  const c = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle, headline: 'CQC inspection on Tuesday.' } });
  expect(c.status).toBe(200);
  const id = c.json.draft.id;
  const e = await req('POST', '/api/ceo/ads/draft', { headers: ceo(), body: {
    id, primary_text: 'Pain, the UK version.\n\nAustralia.\n\nBook a free call. Completely free for doctors.', description: 'UK-trained GPs. Free 30-minute call.',
    image_headline: 'CQC inspection on Tuesday.', image_sub: 'Australia is hiring UK-trained GPs.',
    photo_data_url: TINY_JPEG, image_data_url: TINY_JPEG, image_width: 1080, image_height: 1350
  } });
  expect(e.status).toBe(200);
  expect(e.json.draft.problems).toEqual([]);
  return id;
}
const uploads = (id) => metaCalls.filter((c) => /\/adimages$/.test(c.path)).length;

beforeAll(async () => {
  meta = fakeMeta();
  await new Promise((resolve) => meta.listen(0, '127.0.0.1', () => { metaPort = meta.address().port; resolve(); }));
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ads-lock-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ads-lock-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.META_ADS_ACCESS_TOKEN = 'fake-token-' + RUN_ID;
  process.env.META_ADS_GRAPH_URL = 'http://127.0.0.1:' + metaPort;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ADS_LAUNCH_DISABLED;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (meta) await new Promise((resolve) => meta.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

describe('one launch per draft at a time', () => {
  it('two Launch now requests at once: one runs, the other is told a launch is in progress, Meta is called once', async () => {
    const id = await launchableDraft('lock-race');
    const before = uploads();
    const [a, b] = await Promise.all([
      req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } }),
      req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } })
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    const ran = a.status === 409 ? b : a;
    expect(refused.json.ok).toBe(false);
    expect(refused.json.already).toBe(true);
    expect(refused.json.message).toMatch(/already in progress/);
    // The one that ran reached Meta, which was down, so it failed honestly.
    expect(ran.json.ok).toBe(false);
    expect(ran.json.step).toBe('image');
    expect(ran.json.message).toMatch(/fake Meta is down/);
    expect(ran.json.draft.status).toBe('failed');
    expect(uploads() - before).toBe(1);
  });

  it('the lock is released when the launch ends, so a later retry is allowed', async () => {
    const id = await launchableDraft('lock-retry');
    const first = await req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } });
    expect(first.status).toBe(200);
    expect(first.json.draft.status).toBe('failed');
    const before = uploads();
    const second = await req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } });
    expect(second.status).toBe(200);
    expect(second.json.draft.status).toBe('failed');
    expect(uploads() - before).toBe(1);
  });

  it('the launcher cron leaves a draft another request is launching alone', async () => {
    const id = await launchableDraft('lock-cron');
    const before = uploads();
    const launching = req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } });
    await new Promise((r) => setTimeout(r, 60)); // the launch is now holding the lock and waiting on Meta
    const cron = await req('GET', '/api/cron/ads-launch', { headers: cronAuth });
    expect(cron.status).toBe(200);
    const mine = (cron.json.details || []).filter((d) => d.id === id);
    expect(mine.length).toBe(0); // not even considered: a fresh 'launching' row is not due
    const done = await launching;
    expect(done.status).toBe(200);
    expect(uploads() - before).toBe(1);
  });

  it('a launch that succeeds stores the ids once, and any later Launch now is refused as already live without touching Meta', async () => {
    const id = await launchableDraft('lock-live');
    metaMode = 'ok';
    try {
      const before = metaCalls.length;
      const [a, b] = await Promise.all([
        req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } }),
        req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } })
      ]);
      const ran = a.status === 200 ? a : b;
      const refused = a.status === 200 ? b : a;
      expect(ran.json.ok).toBe(true);
      expect(ran.json.meta_ad_id).toBe('120249000000000001');
      expect(ran.json.draft.status).toBe('live');
      expect(ran.json.draft.meta_creative_id).toBe('9001');
      expect(refused.status).toBe(409);
      expect(refused.json.already).toBe(true);
      // Exactly one image upload, one creative, one ad: the collision never reached Meta.
      expect(metaCalls.slice(before).map((c) => c.path.split('/').pop()).sort()).toEqual(['adcreatives', 'adimages', 'ads']);
      const again = await req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id } });
      expect(again.status).toBe(409);
      expect(again.json.already).toBe(true);
      expect(again.json.message).toMatch(/already live/);
      expect(metaCalls.length - before).toBe(3);
    } finally {
      metaMode = 'down';
    }
  });

  it('an unknown draft is a 404, not a launch', async () => {
    const r = await req('POST', '/api/ceo/ads/draft/launch-now', { headers: ceo(), body: { id: 'does-not-exist' } });
    expect(r.status).toBe(404);
  });
});
