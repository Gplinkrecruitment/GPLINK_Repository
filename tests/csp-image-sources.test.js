import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// Regression cover for a silent, production-only breakage: 24 of 64 job
// listings rendered a broken hero image because their career_roles
// header_image_url points at the Supabase PROJECT host
// (<ref>.supabase.co) while production runs
// SUPABASE_URL=https://login.mygplink.com.au (a Supabase custom domain).
// CSP_SUPABASE_ORIGIN therefore whitelisted only the custom domain, so the
// browser blocked every project-host image. Nothing in the page HTML or the
// API payload looked wrong — the URLs were intact and returned 200 to curl —
// which is exactly why it went unnoticed. Only the CSP header showed it.
//
// These tests pin the header itself, since that is the only place the bug
// was ever visible.

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function imgSrc(headers) {
  const csp = String(headers['content-security-policy'] || '');
  const directive = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('img-src'));
  return directive || '';
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-csp-image-sources-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  // Mirrors production: SUPABASE_URL is the CUSTOM domain, not the project host.
  process.env.SUPABASE_URL = 'https://login.mygplink.com.au';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-csp-image-sources-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('CSP img-src covers Supabase storage on BOTH hosts', () => {
  it('allows the Supabase project host, so <ref>.supabase.co hero images render', async () => {
    const res = await get('/jobs');
    expect(imgSrc(res.headers)).toContain('https://*.supabase.co');
  });

  it('still allows the configured Supabase origin (the custom domain)', async () => {
    const res = await get('/jobs');
    expect(imgSrc(res.headers)).toContain('https://login.mygplink.com.au');
  });

  it('still allows the wikimedia host the other 38 listings use', async () => {
    const res = await get('/jobs');
    expect(imgSrc(res.headers)).toContain('https://upload.wikimedia.org');
  });

  it('grants Supabase storage NO script or connect privilege beyond the configured origin', async () => {
    const res = await get('/jobs');
    const csp = String(res.headers['content-security-policy'] || '');
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) || '';
    const connectSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src')) || '';
    expect(scriptSrc).not.toContain('*.supabase.co');
    expect(connectSrc).not.toContain('*.supabase.co');
  });
});
