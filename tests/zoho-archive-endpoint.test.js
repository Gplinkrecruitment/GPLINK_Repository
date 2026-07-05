// Task 6 — admin/cron-protected capture endpoint:
// POST|GET /api/integrations/zoho-recruit/archive-capture
//
// Boots the real server the same lightweight way tests/clean-urls.test.js
// does (no Supabase/PostgREST emulator needed — Zoho is left unconfigured
// so captureZohoArchive() short-circuits to { ok:false, error:'zoho_not_connected' }
// without ever touching the database).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'test-archive-capture-secret-' + RUN_ID;
let server;
let baseUrl;

function request(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const r = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body, raw });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-archive-capture-auth-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-test-archive-capture-${RUN_ID}.json`;
  process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET = CRON_SECRET;
  // Zoho intentionally left unconfigured (no CLIENT_ID/SECRET) so
  // captureZohoArchive() returns { ok:false, error:'zoho_not_connected' }
  // instead of attempting a real network call.
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

describe('POST /api/integrations/zoho-recruit/archive-capture', () => {
  it('rejects unauthorized capture calls with 401', async () => {
    const r = await request('POST', '/api/integrations/zoho-recruit/archive-capture');
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
  });

  it('with the cron secret but Zoho unconfigured, runs the handler and reports not_connected', async () => {
    const r = await request('POST', '/api/integrations/zoho-recruit/archive-capture', {
      Authorization: 'Bearer ' + CRON_SECRET
    });
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('zoho_not_connected');
  });

  it('an invalid bearer token is rejected the same as no auth', async () => {
    const r = await request('POST', '/api/integrations/zoho-recruit/archive-capture', {
      Authorization: 'Bearer not-the-right-secret'
    });
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
  });

  it('also accepts GET, mirroring the other zoho-recruit routes', async () => {
    const r = await request('GET', '/api/integrations/zoho-recruit/archive-capture', {
      Authorization: 'Bearer ' + CRON_SECRET
    });
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('zoho_not_connected');
  });
});
