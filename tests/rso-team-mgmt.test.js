// Phase 6 G2a, RSO team management: mailbox (va_gmail) on RSO CRUD, on-leave flag,
// and bulk case reassignment.
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-offer-flow.test.js so rso_team / va_gmail_accounts / registration_cases
// writes are exercised end-to-end.
//
// CRITICAL invariant proven here: a mailbox saved through the Team UI's endpoint
// (va_gmail_accounts row) is what resolveCaseSenderEmail, the outbound
// sender-identity resolver, actually reads. See the "sender identity" block.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-rso-mgmt-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator
let serverModule;          // ../server.js exports (resolveCaseSenderEmail)

const SUPER_HOST = 'rso-mgmt.local';
const ADMIN_HOST = 'rso-mgmt-admin.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const STAFF_EMAIL = 'staff@gplink-test.local';

const RSO_A = '11111111-1111-4111-8111-111111111111'; // source of the bulk move
const RSO_B = '22222222-2222-4222-8222-222222222222'; // bulk target
const RSO_C = '33333333-3333-4333-8333-333333333333'; // on leave
const RSO_D = '44444444-4444-4444-8444-444444444444'; // toggle guinea pig
const NOW = new Date().toISOString();

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  rso_team: [
    // A's roster email is deliberately PERSONAL, the sender-identity test below proves
    // the registered mailbox (va_gmail_accounts) wins over the roster email.
    { user_id: RSO_A, name: 'Alice RSO', email: 'alice.personal@gmail.com', phone: '', active: true, on_leave: false, calendly_event_url: '' },
    // B's registered mailbox DIFFERS from the roster email, the mailbox must win.
    { user_id: RSO_B, name: 'Bob RSO', email: 'bob@mygplink.com.au', phone: '', active: true, on_leave: false, calendly_event_url: '' },
    { user_id: RSO_C, name: 'Carol RSO', email: 'carol@mygplink.com.au', phone: '', active: true, on_leave: true, calendly_event_url: '' },
    { user_id: RSO_D, name: 'Dave RSO', email: 'dave@mygplink.com.au', phone: '', active: true, on_leave: false, calendly_event_url: '' }
  ],
  va_gmail_accounts: [
    { id: 'mb-a', user_id: RSO_A, email_address: 'alice@mygplink.com.au', display_name: 'Alice RSO', watch_active: true },
    { id: 'mb-b', user_id: RSO_B, email_address: 'bob-mail@mygplink.com.au', display_name: 'Bob RSO', watch_active: true },
    { id: 'mb-c', user_id: RSO_C, email_address: 'carol@mygplink.com.au', display_name: 'Carol RSO', watch_active: true }
  ],
  registration_cases: [
    { id: 'case-a1', user_id: 'gp-1', status: 'active', assigned_va: RSO_A, assigned_rso: RSO_A, stage: 'ahpra' },
    { id: 'case-a2', user_id: 'gp-2', status: 'active', assigned_va: RSO_A, assigned_rso: RSO_A, stage: 'amc' },
    // Legacy shape: only assigned_rso carries the owner.
    { id: 'case-a3', user_id: 'gp-3', status: 'active', assigned_va: null, assigned_rso: RSO_A, stage: 'myintealth' },
    // Closed case must NOT move.
    { id: 'case-a4', user_id: 'gp-4', status: 'closed', assigned_va: RSO_A, assigned_rso: RSO_A, stage: 'commencement' },
    { id: 'case-b1', user_id: 'gp-5', status: 'active', assigned_va: RSO_B, assigned_rso: RSO_B, stage: 'visa' }
  ],
  user_profiles: [
    { user_id: 'gp-1', email: 'gp1@test.local', first_name: 'G', last_name: 'One' },
    { user_id: 'gp-2', email: 'gp2@test.local', first_name: 'G', last_name: 'Two' },
    { user_id: 'gp-3', email: 'gp3@test.local', first_name: 'G', last_name: 'Three' },
    { user_id: 'gp-4', email: 'gp4@test.local', first_name: 'G', last_name: 'Four' },
    { user_id: 'gp-5', email: 'gp5@test.local', first_name: 'G', last_name: 'Five' }
  ],
  task_timeline: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue; // unsupported → don't filter
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

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
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
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
const staffCookie = () => adminCookieFor(STAFF_EMAIL, 'admin');

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
const saGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const saPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
const saPatch = (p, body) => httpReq('PATCH', p, { host: SUPER_HOST, cookie: superCookie(), body });
const saPut = (p, body) => httpReq('PUT', p, { host: SUPER_HOST, cookie: superCookie(), body });

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'rso-mgmt-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
  process.env.GOOGLE_PUBSUB_TOPIC = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = STAFF_EMAIL;

  serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── Pure builder: va_gmail + on_leave ───────────────────────────────────────
describe('buildRsoWritePayload, mailbox + on-leave', () => {
  const { buildRsoWritePayload } = require('../server-test-helpers.js');

  it('accepts + normalizes an @mygplink.com.au mailbox (returned separately, not in the rso_team payload)', () => {
    const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com', userId: 'u1', va_gmail: '  Alice@MyGPLink.com.au ' }, { mode: 'create' });
    expect(out.valid).toBe(true);
    expect(out.vaGmail).toBe('alice@mygplink.com.au');
    expect('va_gmail' in out.payload).toBe(false);
  });

  it('rejects a non-mygplink mailbox', () => {
    const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com', userId: 'u1', va_gmail: 'alice@gmail.com' }, { mode: 'create' });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toContain('@mygplink.com.au');
  });

  it('rejects a malformed mailbox', () => {
    const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com', userId: 'u1', va_gmail: 'not-an-email' }, { mode: 'create' });
    expect(out.valid).toBe(false);
  });

  it('leaves vaGmail undefined when not supplied', () => {
    const out = buildRsoWritePayload({ name: 'A', email: 'a@b.com', userId: 'u1' }, { mode: 'create' });
    expect(out.vaGmail).toBe(undefined);
  });

  it('defaults on_leave to false on create and includes it on update when supplied', () => {
    const created = buildRsoWritePayload({ name: 'A', email: 'a@b.com', userId: 'u1' }, { mode: 'create' });
    expect(created.payload.on_leave).toBe(false);
    const updated = buildRsoWritePayload({ on_leave: true }, { mode: 'update' });
    expect(updated.valid).toBe(true);
    expect(updated.payload.on_leave).toBe(true);
    const untouched = buildRsoWritePayload({ name: 'B' }, { mode: 'update' });
    expect('on_leave' in untouched.payload).toBe(false);
  });
});

// ── Roster normalization + selection guard ──────────────────────────────────
describe('roster on-leave handling', () => {
  it('mergeRsoRoster carries on_leave through', async () => {
    const { mergeRsoRoster } = serverModule;
    const out = mergeRsoRoster([{ user_id: 'u1', name: 'A', email: 'a@x.com', on_leave: true }], []);
    expect(out[0].on_leave).toBe(true);
    const out2 = mergeRsoRoster([{ user_id: 'u1', name: 'A', email: 'a@x.com' }], []);
    expect(out2[0].on_leave).toBe(false);
  });

  it('resolveRsoReassignmentTarget refuses an on-leave RSO', async () => {
    const { resolveRsoReassignmentTarget } = await import('../lib/ceo-metrics.js');
    const roster = [{ user_id: 'u1', name: 'Away Person', email: 'away@mygplink.com.au', active: true, on_leave: true }];
    const mailboxes = [{ user_id: 'u1', email_address: 'away@mygplink.com.au' }];
    const r = resolveRsoReassignmentTarget(roster, mailboxes, 'u1', 'hello@mygplink.com.au');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('on leave');
  });
});

// ── Endpoint: list + create + edit ──────────────────────────────────────────
describe('RSO CRUD with mailbox + on-leave', () => {
  it('GET /api/admin/rsos returns mailbox (va_gmail) and on_leave for each RSO', async () => {
    const r = await saGet('/api/admin/rsos?include_inactive=1');
    expect(r.status).toBe(200);
    const a = r.body.rsos.find((x) => x.user_id === RSO_A);
    const b = r.body.rsos.find((x) => x.user_id === RSO_B);
    const c = r.body.rsos.find((x) => x.user_id === RSO_C);
    expect(a.va_gmail).toBe('alice@mygplink.com.au');
    expect(b.va_gmail).toBe('bob-mail@mygplink.com.au');
    expect(c.on_leave).toBe(true);
    expect(a.on_leave).toBe(false);
  });

  it('POST /api/admin/rsos with a mailbox persists BOTH the rso_team row and the va_gmail_accounts link', async () => {
    const r = await saPost('/api/admin/rsos', {
      name: 'Dana RSO', email: 'dana.personal@example.org', va_gmail: 'dana@mygplink.com.au'
    });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.mailboxLinked).toBe(true);
    expect(r.body.rso.va_gmail).toBe('dana@mygplink.com.au');
    const teamRow = db.rso_team.find((x) => x.email === 'dana.personal@example.org');
    expect(teamRow).toBeTruthy();
    const mbRow = db.va_gmail_accounts.find((x) => x.user_id === teamRow.user_id);
    expect(mbRow.email_address).toBe('dana@mygplink.com.au');
  });

  it('POST rejects a non-mygplink mailbox with a clear 400', async () => {
    const r = await saPost('/api/admin/rsos', { name: 'Evil', email: 'evil@example.org', va_gmail: 'evil@gmail.com' });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('@mygplink.com.au');
  });

  it('POST rejects a duplicate email with 409', async () => {
    const r = await saPost('/api/admin/rsos', { name: 'Alice Again', email: 'alice.personal@gmail.com' });
    expect(r.status).toBe(409);
  });

  it('PATCH updates the mailbox in place (same user_id keeps the link the pipeline reads)', async () => {
    const r = await saPatch('/api/admin/rsos/' + RSO_D, { va_gmail: 'dave-inbox@mygplink.com.au' });
    expect(r.status).toBe(200);
    expect(r.body.mailboxLinked).toBe(true);
    expect(r.body.rso.va_gmail).toBe('dave-inbox@mygplink.com.au');
    const mbRow = db.va_gmail_accounts.find((x) => x.user_id === RSO_D);
    expect(mbRow.email_address).toBe('dave-inbox@mygplink.com.au');
  });

  it('PATCH refuses stealing a mailbox already linked to someone else', async () => {
    const r = await saPatch('/api/admin/rsos/' + RSO_D, { va_gmail: 'alice@mygplink.com.au' });
    expect(r.status).toBe(200); // rso_team row saved; mailbox link refused + reported
    expect(r.body.mailboxLinked).toBe(false);
    expect(r.body.mailboxError).toContain('already linked');
    const mbRow = db.va_gmail_accounts.find((x) => x.user_id === RSO_D);
    expect(mbRow.email_address).toBe('dave-inbox@mygplink.com.au'); // unchanged
  });

  it('deactivate + reactivate round-trips', async () => {
    const off = await saPatch('/api/admin/rsos/' + RSO_D, { active: false });
    expect(off.status).toBe(200);
    expect(db.rso_team.find((x) => x.user_id === RSO_D).active).toBe(false);
    const on = await saPatch('/api/admin/rsos/' + RSO_D, { active: true });
    expect(on.status).toBe(200);
    expect(db.rso_team.find((x) => x.user_id === RSO_D).active).toBe(true);
  });

  it('on-leave toggle persists and is returned by GET', async () => {
    const r = await saPatch('/api/admin/rsos/' + RSO_D, { on_leave: true });
    expect(r.status).toBe(200);
    expect(db.rso_team.find((x) => x.user_id === RSO_D).on_leave).toBe(true);
    const list = await saGet('/api/admin/rsos?include_inactive=1');
    expect(list.body.rsos.find((x) => x.user_id === RSO_D).on_leave).toBe(true);
    await saPatch('/api/admin/rsos/' + RSO_D, { on_leave: false });
    expect(db.rso_team.find((x) => x.user_id === RSO_D).on_leave).toBe(false);
  });
});

// ── CRITICAL: the saved mailbox drives the outbound sender identity ─────────
describe('sender identity reads the saved mailbox', () => {
  it('resolveCaseSenderEmail returns the va_gmail_accounts mailbox, not the roster email', async () => {
    // Alice's roster email is a PERSONAL gmail (would fall back to hazel@ pre-G2a);
    // her registered mailbox must be the sender.
    const fromA = await serverModule.resolveCaseSenderEmail('case-a1');
    expect(fromA).toBe('alice@mygplink.com.au');
    // Bob's roster email is bob@mygplink.com.au but his REGISTERED mailbox is
    // bob-mail@, the mailbox wins, proving the Team UI value is what's read.
    const fromB = await serverModule.resolveCaseSenderEmail('case-b1');
    expect(fromB).toBe('bob-mail@mygplink.com.au');
  });

  it('falls back to the roster email (then hazel@) when no mailbox is registered', async () => {
    // Temporarily remove Bob's mailbox row: roster email bob@mygplink.com.au should win.
    const idx = db.va_gmail_accounts.findIndex((x) => x.user_id === RSO_B);
    const [row] = db.va_gmail_accounts.splice(idx, 1);
    const fromB = await serverModule.resolveCaseSenderEmail('case-b1');
    expect(fromB).toBe('bob@mygplink.com.au');
    db.va_gmail_accounts.push(row);
  });
});

// ── Single-case reassign respects the on-leave flag ─────────────────────────
describe('single-case reassign', () => {
  it('refuses reassigning a case to an on-leave RSO', async () => {
    const r = await saPut('/api/admin/case?id=case-b1', { assigned_rso: RSO_C });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('on leave');
    // Case untouched.
    expect(db.registration_cases.find((c) => c.id === 'case-b1').assigned_rso).toBe(RSO_B);
  });

  it('also refuses the direct assigned_va write path (admin dashboard) for an on-leave RSO', async () => {
    const r = await saPut('/api/admin/case?id=case-b1', { assigned_va: RSO_C });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('on leave');
    expect(db.registration_cases.find((c) => c.id === 'case-b1').assigned_va).toBe(RSO_B);
  });
});

// ── Bulk reassignment ───────────────────────────────────────────────────────
describe('bulk reassignment', () => {
  it('is super-admin only (plain admin on the employee host gets 403)', async () => {
    const r = await httpReq('POST', '/api/admin/rso/bulk-reassign', {
      host: ADMIN_HOST, cookie: staffCookie(), body: { fromRsoId: RSO_A, toRsoId: RSO_B }
    });
    expect(r.status).toBe(403);
  });

  it('rejects unauthenticated callers', async () => {
    const r = await httpReq('POST', '/api/admin/rso/bulk-reassign', {
      host: SUPER_HOST, body: { fromRsoId: RSO_A, toRsoId: RSO_B }
    });
    expect([301, 302, 401, 403]).toContain(r.status);
  });

  it('dry run reports the count of active cases without moving anything', async () => {
    const r = await saPost('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3); // a1, a2, a3 (a4 is closed)
    expect(db.registration_cases.find((c) => c.id === 'case-a1').assigned_va).toBe(RSO_A);
  });

  it('refuses an on-leave target', async () => {
    const r = await saPost('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A, toRsoId: RSO_C });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('on leave');
  });

  it('refuses moving cases onto the same RSO', async () => {
    const r = await saPost('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A, toRsoId: RSO_A });
    expect(r.status).toBe(400);
  });

  it('moves ALL of A\'s active cases to B with per-case side-effects, leaving other cases alone', async () => {
    const r = await saPost('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A, toRsoId: RSO_B });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.moved).toBe(3);
    expect(r.body.total).toBe(3);
    for (const id of ['case-a1', 'case-a2', 'case-a3']) {
      const c = db.registration_cases.find((x) => x.id === id);
      expect(c.assigned_va).toBe(RSO_B);
      expect(c.assigned_rso).toBe(RSO_B);
    }
    // Closed case and B's own case untouched.
    expect(db.registration_cases.find((x) => x.id === 'case-a4').assigned_va).toBe(RSO_A);
    expect(db.registration_cases.find((x) => x.id === 'case-b1').assigned_va).toBe(RSO_B);
    // Per-case timeline audit entries (same side-effect family as the single-case path).
    const auditRows = db.task_timeline.filter((t) => String(t.title || '').indexOf('Case reassigned (bulk)') === 0);
    expect(auditRows.length).toBe(3);
    expect(auditRows.map((t) => t.case_id).sort()).toEqual(['case-a1', 'case-a2', 'case-a3']);
  });

  it('is idempotent-ish: re-running moves 0 cases and still succeeds', async () => {
    const r = await saPost('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A, toRsoId: RSO_B });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(0);
    expect(r.body.total).toBe(0);
  });
});
