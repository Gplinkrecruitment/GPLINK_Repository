import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Friendly 404 (2026-07-20 full-app user-POV audit, Task 13): a typo'd URL
// used to answer with a raw plain-text "Not found". Browser page navigations
// now get the branded pages/error.html served in place via respondNotFound
// (still status 404); asset-extension paths (.js/.css/...) and non-HTML
// callers keep the terse plain-text body so a <script src> can never receive
// HTML, and /api/* 404s stay JSON. pages/not-found.html remains a publicly
// servable standalone page so a signed-out visitor is not bounced to signin.
// Mirrors the http-harness idiom used by tests/site-public-routes.test.js
// (auth ENABLED).

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

function get(path, { accept, cookie, extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extraHeaders || {});
    if (accept) headers.Accept = accept;
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Valid signed gp_session cookie, built the same way server.js does
// (createSignedSessionToken: base64url(JSON) + '.' + HMAC-SHA512 with AUTH_SECRET).
function gpSessionCookie() {
  const payload = base64UrlEncode(JSON.stringify({
    userProfile: { email: 'gp-notfound-test@example.com' },
    expiresAt: Date.now() + 3600000,
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_session=${encodeURIComponent(payload + '.' + sig)}`;
}

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false'; // auth ENABLED — the 404 page must not bounce to signin
  process.env.AUTH_SECRET = 'test-not-found-page-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-not-found-page-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('friendly 404 — browser navigations get the branded page', () => {
  it('GET /totally-bogus-url with a browser Accept header → 404 branded HTML', async () => {
    const res = await get('/totally-bogus-url', { accept: BROWSER_ACCEPT });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('We couldn');
    expect(res.raw).toContain('GP Link');
  });

  it('signed-in GET of a bogus /pages/ URL → 404 branded HTML (static stat-miss path)', async () => {
    const res = await get('/pages/definitely-not-a-real-page', {
      accept: BROWSER_ACCEPT,
      cookie: gpSessionCookie(),
    });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('We couldn');
  });

  it('service-worker pass-through navigation (Sec-Fetch-Dest: empty + browser Accept) → branded HTML', async () => {
    // The sw's fetch(event.request) of a page navigation loses the 'document'
    // destination (Chrome sends Sec-Fetch-Dest: empty) but keeps the original
    // Accept: text/html. Live-repro'd 2026-07-21: every sw-installed browser
    // got the bare plain-text 404. The Accept sniff must win when dest is empty.
    const res = await get('/totally-bogus-url', {
      accept: BROWSER_ACCEPT,
      extraHeaders: { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' },
    });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).not.toBe('Not found');
  });

  it('subresource destinations (Sec-Fetch-Dest: script) stay terse plain text even with a browser Accept', async () => {
    const res = await get('/totally-bogus-url', {
      accept: BROWSER_ACCEPT,
      extraHeaders: { 'Sec-Fetch-Dest': 'script' },
    });
    expect(res.status).toBe(404);
    expect(res.raw).toBe('Not found');
  });

  it('blocked backend paths (allowlist gate) stay terse plain text — assets never get HTML', async () => {
    const res = await get('/server.js', { accept: BROWSER_ACCEPT });
    expect(res.status).toBe(404);
    expect(res.raw).toBe('Not found');
    // Never leak source even a little.
    expect(res.raw).not.toContain('handleApi');
  });
});

describe('friendly 404 — non-browser callers are unchanged', () => {
  it('GET /totally-bogus-url with no Accept header → 404 plain text "Not found"', async () => {
    const res = await get('/totally-bogus-url');
    expect(res.status).toBe(404);
    expect(res.raw).toBe('Not found');
  });

  it('GET /api/definitely-bogus-endpoint stays a JSON 404 even with a browser Accept', async () => {
    const res = await get('/api/definitely-bogus-endpoint', { accept: BROWSER_ACCEPT });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.raw);
    expect(body.ok).toBe(false);
  });
});

describe('the 404 page itself is publicly servable', () => {
  it('GET /pages/not-found signed out → 200 branded page, no signin bounce', async () => {
    const res = await get('/pages/not-found', { accept: BROWSER_ACCEPT });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain("This page doesn't exist");
  });

  it('pages/not-found.html stays self-contained (no scripts, absolute links only)', () => {
    const html = fs.readFileSync('pages/not-found.html', 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="\.\.?\//); // no relative asset paths — served at arbitrary URLs
    expect(html).not.toMatch(/href="\.\.?\//);
  });
});
