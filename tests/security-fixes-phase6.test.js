// Phase 6 Batch A security fixes (audit 2026-07-07):
//  C1 — weekly backup no longer dumps process.env secrets (isBackupSafeEnvKey, default deny)
//  C2 — Gmail Pub/Sub webhook requires GMAIL_WEBHOOK_SECRET when set (?token= or Bearer),
//       stays open (back-compat) when unset
//  C3 — BK_TABLES covers the newer tables (placements, practices, ats_offers, ...)
//  C7 — privacy/terms/blog resolve publicly for anonymous visitors
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const WEBHOOK_SECRET = 'gmail-webhook-test-secret-' + RUN_ID;
let server;
let port;
let testUtils;

function request(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'security-phase6-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-security-phase6-${RUN_ID}.json`;
  delete process.env.GMAIL_WEBHOOK_SECRET; // start UNSET — the secret is read live per request

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  delete process.env.GMAIL_WEBHOOK_SECRET;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('C2 — Gmail webhook auth', () => {
  it('with secret UNSET, an unauthenticated POST is still accepted (back-compat)', async () => {
    delete process.env.GMAIL_WEBHOOK_SECRET;
    const res = await request('POST', '/api/webhooks/gmail', { body: {} });
    expect(res.status).toBe(200);
  });

  it('with secret SET, a POST with no token is rejected 403 and not processed', async () => {
    process.env.GMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const res = await request('POST', '/api/webhooks/gmail', { body: {} });
    expect(res.status).toBe(403);
  });

  it('with secret SET, a wrong ?token= is rejected 403', async () => {
    process.env.GMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const res = await request('POST', '/api/webhooks/gmail?token=wrong-' + RUN_ID, { body: {} });
    expect(res.status).toBe(403);
  });

  it('with secret SET, the correct ?token= is accepted', async () => {
    process.env.GMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const res = await request('POST', '/api/webhooks/gmail?token=' + encodeURIComponent(WEBHOOK_SECRET), { body: {} });
    expect(res.status).toBe(200);
  });

  it('with secret SET, a correct Authorization: Bearer header is accepted', async () => {
    process.env.GMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const res = await request('POST', '/api/webhooks/gmail', { headers: { Authorization: 'Bearer ' + WEBHOOK_SECRET }, body: {} });
    expect(res.status).toBe(200);
  });

  it('GET (Pub/Sub verification ping) stays open either way', async () => {
    process.env.GMAIL_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const res = await request('GET', '/api/webhooks/gmail');
    expect(res.status).toBe(200);
  });
});

describe('C1 — isBackupSafeEnvKey (default deny)', () => {
  const SECRET_KEYS = [
    'SUPABASE_SERVICE_ROLE_KEY', 'AUTH_SECRET', 'ZOOM_CLIENT_SECRET',
    'GMAIL_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'CRON_SECRET', 'RESEND_API_KEY',
    'DOUBLETICK_WEBHOOK_SECRET', 'ZOHO_REFRESH_TOKEN', 'DATABASE_CONNECTION_STRING',
    'SESSION_SALT', 'SENTRY_DSN', 'SOME_PASSWORD',
  ];
  for (const k of SECRET_KEYS) {
    it(`denies ${k}`, () => {
      expect(testUtils.isBackupSafeEnvKey(k)).toBe(false);
    });
  }

  it('denies a secret-looking key even with a public prefix (PUBLIC_API_KEY)', () => {
    expect(testUtils.isBackupSafeEnvKey('PUBLIC_API_KEY')).toBe(false);
  });

  it('denies unknown/unclassified keys by default (default deny)', () => {
    expect(testUtils.isBackupSafeEnvKey('SOME_RANDOM_INTERNAL_SETTING')).toBe(false);
    expect(testUtils.isBackupSafeEnvKey('')).toBe(false);
    expect(testUtils.isBackupSafeEnvKey(null)).toBe(false);
  });

  for (const k of ['NODE_ENV', 'VERCEL_ENV', 'PUBLIC_BASE_URL', 'VERCEL_GIT_COMMIT_SHA']) {
    it(`allows ${k}`, () => {
      expect(testUtils.isBackupSafeEnvKey(k)).toBe(true);
    });
  }
});

describe('C3 — backup table coverage', () => {
  it('BACKUP_TABLES includes the newer tables from the audit', () => {
    const tables = testUtils.BACKUP_TABLES;
    expect(Array.isArray(tables)).toBe(true);
    for (const t of [
      'placements', 'practices', 'ats_offers', 'ats_stage_events',
      'scheduled_calls', 'rso_team', 'va_gmail_accounts', 'site_enquiries',
      'pep_waitlist', 'onboarding_reminders', 'candidate_leads',
      'zoho_archive', 'admin_audit_log',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('BACKUP_TABLES has no duplicates', () => {
    const tables = testUtils.BACKUP_TABLES;
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('BACKUP_TABLES no longer includes the dead pending_hires table (C4)', () => {
    expect(testUtils.BACKUP_TABLES).not.toContain('pending_hires');
  });
});

describe('C7 — legal/blog pages public when logged out', () => {
  // The marketing footers link to /pages/privacy, /pages/terms and /pages/blog
  // (extensionless clean URLs); the server normalizes those to the .html file
  // internally, so a 200 here proves the anonymous gate lets them through.
  for (const route of ['/pages/privacy', '/pages/terms', '/pages/blog']) {
    it(`GET ${route} without a session serves the page (200, no signin redirect)`, async () => {
      const res = await request('GET', route);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });
  }

  it('/blog (marketing clean URL) is also public', async () => {
    const res = await request('GET', '/blog');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('a protected page still bounces anonymous visitors to signin', async () => {
    const res = await request('GET', '/pages/my-documents');
    expect(res.status).toBe(302);
    expect(String(res.headers.location || '')).toMatch(/\/pages\/signin/);
  });
});
