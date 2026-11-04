import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Automatic photos end to end over the real server, against a tiny stand-in
// for Higgsfield: a draft gets a job the moment it exists, the poll endpoint
// collects the finished picture into storage, and the launcher cron does the
// same when nobody is watching.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'ads-cron-' + RUN_ID;
const SUPER_HOST = 'ceo-ads-photo.local';
let server, port, hf, hfPort;
const hfState = { submits: 0, status: 'queued', polls: 0 };
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64');

function base64UrlEncode(input) { return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = base64UrlEncode(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, path, { body, headers, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: Object.assign({ Host: SUPER_HOST }, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {}) }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* */ } resolve({ status: res.statusCode, json, raw: raw ? buf : buf.toString('utf8'), headers: res.headers }); });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
const ceo = () => ({ Cookie: superCookie() });

beforeAll(async () => {
  // The stand-in Higgsfield: submit → queued; status → whatever hfState says; the image itself.
  hf = http.createServer((rq, rs) => {
    if (rq.method === 'POST' && /\/higgsfield-ai\/soul\/v2\/standard$/.test(rq.url)) {
      hfState.submits++;
      if (!/^Key a:b$/.test(rq.headers.authorization || '')) { rs.writeHead(401, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ detail: 'Invalid API key' })); return; }
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ status: 'queued', request_id: 'req-' + hfState.submits, status_url: 'http://127.0.0.1:' + hfPort + '/requests/req-' + hfState.submits + '/status' }));
      return;
    }
    if (/\/requests\/[^/]+\/status$/.test(rq.url)) {
      hfState.polls++;
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(hfState.status === 'completed' ? { status: 'completed', images: [{ url: 'http://127.0.0.1:' + hfPort + '/out.jpg' }], expires_at: '2026-11-11T00:00:00Z' } : { status: hfState.status }));
      return;
    }
    if (rq.url === '/out.jpg') { rs.writeHead(200, { 'Content-Type': 'image/jpeg' }); rs.end(JPEG); return; }
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => hf.listen(0, '127.0.0.1', () => { hfPort = hf.address().port; r(); }));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ads-photos-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ads-photos-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.HIGGSFIELD_API_KEY = 'a:b';
  process.env.HIGGSFIELD_API_BASE = 'http://127.0.0.1:' + hfPort;
  delete process.env.META_ADS_ACCESS_TOKEN; delete process.env.META_CAPI_ACCESS_TOKEN; delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (hf) await new Promise((r) => hf.close(r));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* */ }
});

describe('automatic photos', () => {
  let id;
  it('the page knows photos are on', async () => {
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    expect(page.json.higgsfield_configured).toBe(true);
  });
  it('generate-photo submits a job and returns at once with the job on the draft', async () => {
    const d = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle: 'photo-auto', image_prompt: 'A sunlit Australian consulting room, no people' } });
    id = d.json.draft.id;
    const r = await req('POST', '/api/ceo/ads/draft/generate-photo', { headers: ceo(), body: { id } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.queued).toBe(true);
    expect(r.json.draft.layout.photo_job).toMatchObject({ request_id: 'req-1', status: 'queued' });
    expect(r.json.draft.layout.photo_source).toBe('higgsfield');
    expect(hfState.submits).toBe(1);
  });
  it('polling while the job runs reports it pending and stores nothing', async () => {
    hfState.status = 'in_progress';
    const p = await req('POST', '/api/ceo/ads/photos/poll', { headers: ceo(), body: { ids: [id] } });
    expect(p.json.ok).toBe(true);
    expect(p.json.pending).toBe(1);
    expect(p.json.updated).toEqual([]);
    const page = await req('GET', '/api/ceo/ads', { headers: ceo() });
    const d = page.json.drafts.find((x) => x.id === id);
    expect(d.photo_path).toBeFalsy();
    expect(d.layout.photo_job.status).toBe('in_progress');
  });
  it('once finished, the poll downloads the picture into storage and the draft carries it', async () => {
    hfState.status = 'completed';
    const p = await req('POST', '/api/ceo/ads/photos/poll', { headers: ceo(), body: { ids: [id] } });
    expect(p.json.pending).toBe(0);
    expect(p.json.updated).toHaveLength(1);
    const d = p.json.updated[0];
    expect(d.photo_path).toMatch(/^ad-drafts\//);
    expect(d.layout.photo_job.status).toBe('done');
    expect(d.problems.join(' ')).toMatch(/No creative image yet/); // composing is the page's job
    const img = await req('GET', '/api/ceo/ads/image?id=' + id + '&kind=photo', { headers: ceo(), raw: true });
    expect(img.status).toBe(200);
    expect(img.raw.length).toBe(JPEG.length);
    const again = await req('POST', '/api/ceo/ads/photos/poll', { headers: ceo(), body: {} });
    expect(again.json.pending).toBe(0);
  });
  it('a bad key is reported on the draft, not swallowed', async () => {
    const good = process.env.HIGGSFIELD_API_KEY;
    process.env.HIGGSFIELD_API_KEY = 'wrong:key';
    const d = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle: 'photo-bad', image_prompt: 'x' } });
    const r = await req('POST', '/api/ceo/ads/draft/generate-photo', { headers: ceo(), body: { id: d.json.draft.id } });
    process.env.HIGGSFIELD_API_KEY = good;
    expect(r.json.ok).toBe(false);
    expect(r.json.message).toMatch(/rejected the key/);
    expect(r.json.draft.layout.photo_job.status).toBe('failed');
  });
  it('the launcher cron polls pending jobs as a backstop', async () => {
    hfState.status = 'completed';
    const d = await req('POST', '/api/ceo/ads/drafts/create', { headers: ceo(), body: { angle: 'photo-cron', image_prompt: 'y' } });
    await req('POST', '/api/ceo/ads/draft/generate-photo', { headers: ceo(), body: { id: d.json.draft.id } });
    const c = await req('GET', '/api/cron/ads-launch', { headers: { Authorization: 'Bearer ' + CRON_SECRET } });
    expect(c.status).toBe(200);
    expect(c.json.photos.updated.some((x) => x.id === d.json.draft.id && x.photo_path)).toBe(true);
  });
});
