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

describe('GET /jobs/view (Task 9 job detail page)', () => {
  it('is 200 text/html containing the data-job-detail marker', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('data-job-detail');
  });

  it('is 200 even with no ?id= param (client-side renders the not-found panel)', async () => {
    const res = await get('/jobs/view');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-job-detail');
  });

  it('has no auth-guard.js', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
  });

  it('has zero dead href="#" links', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('links the shared site chrome css/js', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('/css/site.css?v=20260703');
    expect(res.raw).toContain('/js/site.js?v=20260703');
  });

  it('marks Jobs as the current nav section', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toMatch(/<a href="\/jobs" aria-current="page">Jobs<\/a>/);
  });

  it('has a breadcrumb link back to /jobs', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('id="breadcrumbBack" href="/jobs"');
  });

  it('has the static apply deep link in the sidebar (signup=1&next=/pages/career)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('signup=1&next=/pages/career');
  });

  it('has the Calendly "ask us" secondary CTA opening in a new tab', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('https://calendly.com/hello-mygplink/30min');
    expect(res.raw).toMatch(/target="_blank" rel="noopener">Ask us about this role/);
  });

  it('has a not-found panel with a link back to /jobs', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('This role is no longer available');
    expect(res.raw).toMatch(/<a class="btn primary" href="\/jobs">Browse all jobs<\/a>/);
  });

  it('has SEO head tags (static title, canonical without id, description, OG)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('<title>GP Job Details | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/jobs/view">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,220}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('escapes API-sourced job data via an escapeHtml helper, not innerHTML with raw strings', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toMatch(/function escapeHtml/);
    expect(res.raw).not.toMatch(/document\.write/);
  });

  it('client-side resolves the job via the server-side /api/public/jobs?id= exact-match lookup', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('/api/public/jobs?');
    expect(res.raw).toMatch(/params\.set\("id",\s*targetId\)/);
  });
});
