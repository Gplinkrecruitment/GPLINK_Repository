// Guard for the C5 class of bug (audit 2026-07-07): Vercel invokes cron jobs
// with GET, but two cron routes were registered POST-only, so every scheduled
// invocation 404'd and the crons were silently dead. This test parses
// vercel.json's crons array AT TEST TIME and asserts every declared cron path
// responds to a GET with a non-404 (and non-405) status — 200/401/403/503 are
// all fine (auth or missing config may reject), the point is that the route
// exists and accepts GET. New crons added to vercel.json are covered
// automatically.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const CRON_SECRET = 'cron-get-test-secret-' + RUN_ID;
let server;
let port;

function get(p, { bearer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const cronPaths = (vercelConfig.crons || []).map((c) => c.path);

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'cron-get-test-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-cron-get-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('every vercel.json cron path accepts GET', () => {
  it('vercel.json declares at least one cron', () => {
    expect(cronPaths.length).toBeGreaterThan(0);
  });

  it('sanity: an unknown cron path DOES 404 (so non-404 below is meaningful)', async () => {
    const res = await get('/api/cron/definitely-not-a-real-cron-' + RUN_ID);
    expect(res.status).toBe(404);
  });

  for (const cronPath of cronPaths) {
    it(`GET ${cronPath} is routed (non-404/405)`, async () => {
      const res = await get(cronPath);
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(405);
    });
  }

  // The two crons that WERE dead (POST-only) now pass auth on GET and reach
  // their handler (503 = "Database not configured" in this local-JSON harness,
  // which proves both the method gate and the cron-secret auth accepted the
  // request; 200 would mean a handler that tolerates local mode).
  for (const fixedPath of ['/api/cron/call-reminders', '/api/cron/call-summary-retry']) {
    it(`GET ${fixedPath} with the cron secret gets past auth (C5 fix)`, async () => {
      const res = await get(fixedPath, { bearer: CRON_SECRET });
      expect([200, 503]).toContain(res.status);
    });
  }
});
