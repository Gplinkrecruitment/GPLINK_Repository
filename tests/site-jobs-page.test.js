import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for Task 8: the real public job board page (pages/site-jobs.html),
// served at GET /jobs. Mirrors the http-harness idiom used by
// tests/site-public-routes.test.js (boot a real server, no Supabase
// configured, no session).

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
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

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-site-jobs-page-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-jobs-page-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('GET /jobs (Task 8 job board page)', () => {
  it('is 200 text/html with no session', async () => {
    const res = await get('/jobs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('contains the results grid marker data-jobs-list', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('data-jobs-list');
  });

  it('contains the filter form id="jobSearch"', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('id="jobSearch"');
  });

  it('has no auth-guard.js', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
  });

  it('has zero dead href="#" links', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('links the shared site chrome css/js', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('/css/site.css?v=20260703');
    expect(res.raw).toContain('/js/site.js?v=20260703');
  });

  it('has SEO head tags (title, canonical, description, OG)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('<title>GP Jobs in Australia — Browse 1,400+ Roles | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/jobs">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,220}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('the filter form has the same q/state/type fields as the homepage search', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/<form class="jobs-filter-card" id="jobSearch">/);
    expect(res.raw).toContain('name="q"');
    expect(res.raw).toContain('name="state"');
    expect(res.raw).toContain('name="type"');
  });

  it('escapes API-sourced job data via an escapeHtml helper, not innerHTML with raw strings', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function escapeHtml/);
    expect(res.raw).not.toMatch(/document\.write/);
  });
});
