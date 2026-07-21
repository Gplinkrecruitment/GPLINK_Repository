import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Launch-readiness security: the static file server must ONLY serve public
// asset roots (pages/ js/ css/ media/ documents/ assets/ + a few root files).
// It must NEVER serve backend source or config — before the allowlist,
// `GET /server.js` returned the entire 3.2MB backend (and Vercel bundles
// server.js + lib/** into the lambda, so the leak reached production).
// Mirrors the http-harness idiom used by tests/site-public-routes.test.js.

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

function get(path) {
  return new Promise((resolve, reject) => {
    // path is sent verbatim (no client-side normalization) so traversal
    // attempts are exercised exactly as an attacker would send them.
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks).length }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'true';
  process.env.AUTH_SECRET = 'test-static-allowlist-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-static-allowlist-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('static file allowlist — backend source is NOT downloadable', () => {
  const BLOCKED = [
    '/server.js',
    '/package.json',
    '/package-lock.json',
    '/lib/dpa-lookup.js',
    '/scripts/agents.js',
    '/data/app-db.json',
    '/CLAUDE.md',
    '/vercel.json',
    '/.env',
    '/supabase/migrations/20260705100000_practice_client_pipeline.sql',
  ];
  for (const p of BLOCKED) {
    it(`blocks ${p}`, async () => {
      const r = await get(p);
      expect(r.status).toBe(404);
    });
  }
});

describe('static file allowlist — public assets STILL serve', () => {
  const ALLOWED = [
    '/js/auth-guard.js',
    '/css/gp-tokens.css',
    '/sw.js',
    '/manifest.webmanifest',
    '/documents/fit2work-ichc-example.pdf',
    '/assets/legal/gp-link-practice-agreement-2026.pdf',
  ];
  for (const p of ALLOWED) {
    it(`serves ${p}`, async () => {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.bytes).toBeGreaterThan(0);
    });
  }
});
