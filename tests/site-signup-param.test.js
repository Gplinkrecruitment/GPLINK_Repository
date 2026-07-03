import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for Task 5: /pages/signin?signup=1 must serve the sign-in page
// with the boot-script marker that auto-opens the create-account panel, so
// marketing "Create free account" buttons land directly on sign-up. Mirrors
// the http-harness idiom used by tests/site-public-routes.test.js.

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
  process.env.AUTH_SECRET = 'test-site-signup-param-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-signup-param-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('signin ?signup=1 deep link', () => {
  it('GET /pages/signin?signup=1 (no session) is 200 and ships the signup-param marker', async () => {
    const res = await get('/pages/signin?signup=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('data-signup-param');
  });

  it('GET /pages/signin (no params) still serves the same marker (feature is additive, no regression)', async () => {
    const res = await get('/pages/signin');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-signup-param');
  });

  it('GET /pages/signin?signup=1&next=/pages/account keeps both params usable (next handling untouched)', async () => {
    const res = await get('/pages/signin?signup=1&next=%2Fpages%2Faccount');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-signup-param');
    expect(res.raw).toContain('GP_SIGNIN_NEXT');
  });
});
