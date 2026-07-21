// Phase 6 E1 (audit B4), lead / archive browser endpoints:
//   GET /api/admin/leads           (paginated + searchable candidate_leads)
//   GET /api/admin/archive-summary (zoho_archive counts, never raw payloads)
//
// Local-JSON mode with a hand-built DB file (idiom from
// tests/onboarding-incomplete-endpoint.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-admin-leads-${RUN_ID}.json`);
const SUPER_HOST = 'leads-test.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let body = null; try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'admin-leads-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';

  fs.writeFileSync(DB_FILE, JSON.stringify({
    candidateLeads: [
      { id: 'l1', name: 'Amara Okafor', email: 'amara@leads.local', phone: '+44 7700 900001', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-07-01T00:00:00Z' },
      { id: 'l2', name: 'Brendan Walsh', email: 'brendan@leads.local', phone: '', source: 'zoho_recruit', unsubscribed: true, created_at: '2026-07-02T00:00:00Z' },
      { id: 'l3', name: 'Ciara Byrne', email: 'ciara@leads.local', phone: '', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-07-03T00:00:00Z' },
      { id: 'l4', name: 'Dev Patel', email: 'dev@leads.local', phone: '', source: 'facebook', unsubscribed: false, created_at: '2026-07-04T00:00:00Z' },
      { id: 'l5', name: 'Eve Ncube', email: 'eve@somewhere.local', phone: '', source: 'facebook', unsubscribed: false, created_at: '2026-07-05T00:00:00Z' }
    ],
    zohoArchive: [
      { id: 'z1', entity_type: 'job_opening', zoho_id: 'j1', pulled_at: '2026-07-06T01:00:00Z' },
      { id: 'z2', entity_type: 'job_opening', zoho_id: 'j2', pulled_at: '2026-07-06T01:00:00Z' },
      { id: 'z3', entity_type: 'client', zoho_id: 'c1', pulled_at: '2026-07-06T02:00:00Z' },
      { id: 'z4', entity_type: 'candidate', zoho_id: 'x1', pulled_at: '2026-07-06T03:00:00Z' },
      { id: 'z5', entity_type: 'candidate', zoho_id: 'x2', pulled_at: '2026-07-06T03:30:00Z' },
      { id: 'z6', entity_type: 'candidate', zoho_id: 'x3', pulled_at: '2026-07-06T02:30:00Z' }
    ]
  }));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/admin/leads', () => {
  it('rejects without a session', async () => {
    const r = await req('GET', '/api/admin/leads');
    expect([401, 403, 302]).toContain(r.status);
  });

  it('lists all leads newest-first with total + unsubscribed flag', async () => {
    const r = await req('GET', '/api/admin/leads', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.total).toBe(5);
    expect(r.body.leads.length).toBe(5);
    expect(r.body.leads[0].email).toBe('eve@somewhere.local'); // newest first
    const brendan = r.body.leads.find((l) => l.email === 'brendan@leads.local');
    expect(brendan.unsubscribed).toBe(true);
    expect(r.body.leads.filter((l) => l.unsubscribed === false).length).toBe(4);
  });

  it('paginates with offset/limit and keeps the full total', async () => {
    const r = await req('GET', '/api/admin/leads?limit=2&offset=2', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.leads.length).toBe(2);
    expect(r.body.offset).toBe(2);
    expect(r.body.limit).toBe(2);
    // Newest-first ordering: page 2 of size 2 = 3rd and 4th newest.
    expect(r.body.leads.map((l) => l.id)).toEqual(['l3', 'l2']);
  });

  it('searches by name and by email', async () => {
    const byName = await req('GET', '/api/admin/leads?q=ciara', { cookie: superCookie() });
    expect(byName.body.total).toBe(1);
    expect(byName.body.leads[0].email).toBe('ciara@leads.local');
    const byEmail = await req('GET', '/api/admin/leads?q=somewhere.local', { cookie: superCookie() });
    expect(byEmail.body.total).toBe(1);
    expect(byEmail.body.leads[0].name).toBe('Eve Ncube');
  });

  it('filters by status=unsubscribed / status=subscribed', async () => {
    const un = await req('GET', '/api/admin/leads?status=unsubscribed', { cookie: superCookie() });
    expect(un.body.total).toBe(1);
    expect(un.body.leads[0].id).toBe('l2');
    const sub = await req('GET', '/api/admin/leads?status=subscribed', { cookie: superCookie() });
    expect(sub.body.total).toBe(4);
  });

  it('clamps limit at 200', async () => {
    const r = await req('GET', '/api/admin/leads?limit=9999', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(200);
  });
});

describe('GET /api/admin/archive-summary', () => {
  it('rejects without a session', async () => {
    const r = await req('GET', '/api/admin/archive-summary');
    expect([401, 403, 302]).toContain(r.status);
  });

  it('returns counts by module + last capture time + lead totals, never raw rows', async () => {
    const r = await req('GET', '/api/admin/archive-summary', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.archive.counts).toEqual({ job_opening: 2, client: 1, candidate: 3 });
    expect(r.body.archive.total).toBe(6);
    expect(r.body.archive.last_captured_at).toBe('2026-07-06T03:30:00Z');
    expect(r.body.leads_total).toBe(5);
    expect(r.body.leads_unsubscribed).toBe(1);
    // Read-only summary: no payload dump.
    expect(r.raw).not.toContain('"payload"');
  });
});
