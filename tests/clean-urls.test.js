import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const PORT = 0;
let server;
let baseUrl;

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers });
      });
    }).on('error', reject);
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'true';
  process.env.AUTH_SECRET = 'test-clean-urls-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-test-clean-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

describe('clean URL routing', () => {
  it('/pages/index.html redirects 302 to /pages/index', async () => {
    const res = await get('/pages/index.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/index');
  });

  it('/pages/signin.html redirects 302 to /pages/signin', async () => {
    const res = await get('/pages/signin.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/signin');
  });

  it('/pages/signin (clean URL) is resolved by server', async () => {
    const res = await get('/pages/signin');
    // With AUTH_DISABLED, signin redirects to index (already "authenticated")
    expect([200, 302]).toContain(res.status);
  });

  it('/ redirects to /pages/index (clean)', async () => {
    const res = await get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/index');
  });

  it('/pages/account.html?q=1 preserves query on redirect', async () => {
    const res = await get('/pages/account.html?q=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/account?q=1');
  });

  it('.html URLs with embed params are NOT redirected (iframe loads)', async () => {
    const res = await get('/pages/index.html?gp_shell=embedded&gp_shell_static=1');
    // Should serve the page directly, not redirect
    expect(res.status).not.toBe(301);
    expect(res.status).not.toBe(302);
  });

  it('.html URLs with gp_shell_static only are NOT redirected', async () => {
    const res = await get('/pages/index.html?gp_shell_static=1');
    expect(res.status).not.toBe(301);
    expect(res.status).not.toBe(302);
  });

  it('JS files still serve normally', async () => {
    const res = await get('/js/auth-guard.js');
    expect(res.status).toBe(200);
  });

  it('API routes unaffected', async () => {
    const res = await get('/api/auth/session');
    // 200 or 401 depending on auth state — the point is it's NOT a 301/404
    expect([200, 401]).toContain(res.status);
  });

  it('/logout redirects to /pages/signin (clean)', async () => {
    const res = await get('/logout');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/signin');
  });
});
