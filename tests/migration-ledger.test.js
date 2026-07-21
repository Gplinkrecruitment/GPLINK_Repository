// Phase 6 Batch C4, migration ledger (audit 2026-07-07 platform):
//  1. The schema_migrations migration exists and creates the server-only table.
//  2. GET /api/admin/migration-status (super-admin) lists every repo migration
//     file and reports the unapplied set from the public.schema_migrations
//     ledger (empty ledger ⇒ everything unapplied).
//  3. Both endpoints are auth-gated.
//  4. POST /api/admin/migration-status/mark-all-applied records one row per
//     repo file (with checksum), is idempotent, and clears the unapplied set.
// Runs against an in-memory PostgREST emulator (pattern from
// tests/server-observability.test.js) so the real query strings are exercised.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-migration-ledger-${RUN_ID}.json`);
const SUPER_HOST = 'ceo-migrations.local';
const SUPER_EMAIL = 'super@gplink-test.local';

let server, port;
let sbServer, sbPort;

// ── Minimal PostgREST emulator (GET list + POST upsert on_conflict) ─────────
const db = { schema_migrations: [] };
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));

      if (req.method === 'GET') {
        let out = rows.slice();
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch {}
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const conflictCol = u.searchParams.get('on_conflict');
          incoming.forEach((r) => {
            if (conflictCol) {
              const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
              if (existing) { Object.assign(existing, r); return; }
            }
            rows.push({ ...r });
          });
          send(201, []);
        });
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

// ── Session cookie minting (pattern from sibling test files) ────────────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');

function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}
const ceoGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const ceoPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });

const repoMigrationFiles = () =>
  fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /\.sql$/i.test(f)).sort();

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'migration-ledger-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-migrations.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('schema_migrations migration', () => {
  it('exists and creates the server-only public.schema_migrations table', () => {
    const file = path.join(ROOT, 'supabase', 'migrations', '20260706180000_schema_migrations.sql');
    const sql = fs.readFileSync(file, 'utf8');
    expect(sql).toContain('create table if not exists public.schema_migrations');
    expect(sql).toContain('filename    text primary key');
    expect(sql).toContain('alter table public.schema_migrations enable row level security');
  });
});

describe('GET /api/admin/migration-status', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/admin/migration-status', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });

  it('lists every repo migration file; empty ledger means everything is unapplied', async () => {
    const files = repoMigrationFiles();
    const r = await ceoGet('/api/admin/migration-status');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.total_files).toBe(files.length);
    expect(r.body.files).toEqual(files);
    expect(r.body.recorded_count).toBe(0);
    expect(r.body.unapplied).toEqual(files);
    expect(r.body.ledger_table_missing).toBe(false);
  });
});

describe('POST /api/admin/migration-status/mark-all-applied', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('POST', '/api/admin/migration-status/mark-all-applied', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });

  it('records one ledger row per repo file (with checksum) and clears the unapplied set', async () => {
    const files = repoMigrationFiles();
    const r = await ceoPost('/api/admin/migration-status/mark-all-applied');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.recorded).toBe(files.length);

    // Ledger rows landed in schema_migrations, one per file, checksummed.
    expect(db.schema_migrations.length).toBe(files.length);
    const byName = {};
    db.schema_migrations.forEach((row) => { byName[row.filename] = row; });
    expect(Object.keys(byName).sort()).toEqual(files);
    for (const f of files) {
      expect(byName[f].applied_at).toBeTruthy();
      expect(byName[f].checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    // Status now reports everything applied.
    const after = await ceoGet('/api/admin/migration-status');
    expect(after.body.unapplied).toEqual([]);
    expect(after.body.recorded_count).toBe(files.length);
  });

  it('is idempotent, a second call records nothing new', async () => {
    const files = repoMigrationFiles();
    const r = await ceoPost('/api/admin/migration-status/mark-all-applied');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.recorded).toBe(0);
    expect(r.body.already_recorded).toBe(files.length);
    expect(db.schema_migrations.length).toBe(files.length);
  });
});
