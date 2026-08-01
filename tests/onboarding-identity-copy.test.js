import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Task 2 (identity document storage feature): the onboarding "Confirm your
// identity" step must tell doctors their ID is STORED (not deleted). Mirrors
// the http-harness idiom used by tests/site-jobs-page.test.js, but the
// onboarding page sits behind the generic auth gate (server.js redirects any
// non-public *.html page with no session to /pages/signin unless
// AUTH_DISABLED is set), so this suite boots with AUTH_DISABLED=true so the
// real page HTML is served instead of a signin redirect.
//
// Note: GET /pages/onboarding.html (with the .html suffix) 302-redirects to
// the clean URL /pages/onboarding (server.js's clean-URL rule runs before
// the auth gate). So the route to fetch here is the extensionless
// /pages/onboarding, which server.js internally resolves back to
// pages/onboarding.html before serving it.

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
  process.env.AUTH_DISABLED = 'true';
  process.env.AUTH_SECRET = 'test-onboarding-identity-copy-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-onboarding-identity-copy-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('GET /pages/onboarding — identity document storage copy', () => {
  it('is 200 text/html (not a signin redirect) with AUTH_DISABLED', async () => {
    const res = await get('/pages/onboarding');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('tells the user their ID is stored securely, not deleted', async () => {
    const res = await get('/pages/onboarding');
    // Assert on the SERVED BYTES: the HTML source uses &rsquo; entities for
    // apostrophes, so match those entity forms / apostrophe-free substrings
    // rather than a literal curly quote.
    expect(res.raw).toContain('GP Link can confirm you');
    expect(res.raw).toContain('a real doctor and vouch for you to practices');
    expect(res.raw).toContain('delete it whenever you ask, or after 12 months of inactivity');
    expect(res.raw).not.toContain('nothing is stored');
    expect(res.raw).not.toContain('deleted immediately');
  });

  it('bumps the onboarding.js cache-buster', async () => {
    const res = await get('/pages/onboarding');
    expect(res.raw).toContain('onboarding.js?v=20260801c');
  });
});
