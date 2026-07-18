// Endpoint tests for the AI job write-up feature (Task 2 of the
// AI-job-writeup design): POST /api/ats/job/ai-writeup?id=<jobId>. Boots the
// real server in LOCAL-JSON mode against the dev seed (mirrors
// tests/ats-endpoints.test.js) and mocks globalThis.fetch so both the
// Anthropic call and the practice-website fetch are hermetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-writeup-${RUN_ID}.json`);
const SUPER_HOST = 'ai-writeup-test.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const WEBSITE_HOST = 'pipeline-practice-one.example.test';
// Exact fixture text from the task brief (parsed by lib/job-writeup.js's
// parseWriteupResponse, which extracts the first {...} block from the raw
// model reply).
const ANTHROPIC_WRITEUP_TEXT = '{"about":"An established GP-owned practice on the NSW Central Coast.","highlights":["DPA location","On-site nursing"],"sources":["form","website","area"]}';

let realFetch;
let websiteShouldFail = false;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-writeup-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  delete process.env.ANTHROPIC_API_KEY;

  // Seed the local-JSON DB before the server loads it.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });

  // Inject a single pending job (same shape as the jp1 fixture in
  // tests/ats-endpoints.test.js) with a website + intro text so the write-up
  // has real inputs (form details + website) to draw on.
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsJobs = seeded.atsJobs || [];
  seeded.atsJobs.push({
    id: 'jp1', provider: 'internal_ats', title: 'GP — Rangeville',
    practice_name: 'Pipeline Practice One', practice_id: 'p1',
    address: '12 Example Street, Rangeville QLD 4350',
    location_city: 'Toowoomba', location_state: 'QLD',
    suburb: 'Rangeville', nearest_city: 'Toowoomba',
    is_active: false, job_status: 'open', approval_status: 'pending',
    ats_created: true,
    details: { website: 'https://' + WEBSITE_HOST + '/', intro_text: 'We are a friendly, well-established GP-owned clinic.' },
    source_payload: {},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: ANTHROPIC_WRITEUP_TEXT }],
        usage: { input_tokens: 10, output_tokens: 20 }
      }), { status: 200 }));
    }
    if (u.indexOf(WEBSITE_HOST) !== -1) {
      if (websiteShouldFail) return Promise.reject(new Error('website unreachable (mocked)'));
      return Promise.resolve(new Response(
        '<html><head><script>evil()</script><style>.x{color:red}</style></head><body><h1>Welcome</h1><p>We are a friendly GP clinic on the Central Coast.</p></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      ));
    }
    return realFetch(url, opts);
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/ats/job/ai-writeup', () => {
  it('blocks without a session', async () => {
    const r = await req('POST', '/api/ats/job/ai-writeup?id=jp1', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });

  it('no ANTHROPIC_API_KEY → { ok:false, reason:"ai_unavailable" }, HTTP 200, never throws', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await req('POST', '/api/ats/job/ai-writeup?id=jp1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('ai_unavailable');
  });

  it('happy path: generates + stores a masked write-up, sources includes website', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    websiteShouldFail = false;
    const r = await req('POST', '/api/ats/job/ai-writeup?id=jp1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(typeof b.writeup.about).toBe('string');
    expect(b.writeup.about.length).toBeGreaterThan(0);
    // Identity masking: the practice name never appears in the write-up.
    expect(b.writeup.about).not.toContain('Pipeline Practice One');
    expect(b.writeup.sources).toContain('form');
    expect(b.writeup.sources).toContain('website');
    expect(typeof b.writeup.generatedAt).toBe('string');
    expect(b.writeup.generatedAt.length).toBeGreaterThan(0);

    // Persisted onto the job row.
    const got = await req('GET', '/api/ats/job?id=jp1', { host: SUPER_HOST, cookie: superCookie() });
    const gb = parse(got.raw);
    const stored = gb.raw.source_payload.gpLink.aiWriteup;
    expect(stored).toBeTruthy();
    expect(stored.about).toBe(b.writeup.about);
    expect(stored.about).not.toContain('Pipeline Practice One');
    expect(stored.sources).toContain('website');
  });

  it('website fetch throws → still ok:true, sources has no "website"', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    websiteShouldFail = true;
    const r = await req('POST', '/api/ats/job/ai-writeup?id=jp1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.writeup.sources).not.toContain('website');
    expect(b.writeup.sources).toContain('form');
    websiteShouldFail = false;
  });

  it('missing job id → 400', async () => {
    const r = await req('POST', '/api/ats/job/ai-writeup', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(400);
  });

  it('unknown job id → 404', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const r = await req('POST', '/api/ats/job/ai-writeup?id=does-not-exist', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(404);
  });
});
