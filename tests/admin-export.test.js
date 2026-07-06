// Phase 6 E1 (audit B3) — GET /api/admin/export?entity=…&format=csv
//
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') with a hand-built
// DB file (same idiom as tests/onboarding-incomplete-endpoint.test.js) and
// proves:
//  1. every entity (gps / practices / placements / enquiries / leads) returns
//     a real CSV: 200, text/csv, attachment disposition, correct header row;
//  2. RFC 4180 escaping — a field containing a comma, a double-quote AND a
//     newline round-trips as one quoted field with doubled interior quotes;
//  3. auth gating — no session → rejected; wrong entity/format → 400;
//  4. the row cap: limit=N truncates and sets X-Export-Truncated.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-admin-export-${RUN_ID}.json`);
const SUPER_HOST = 'export-test.local';
let server, port;

const TRICKY_MESSAGE = 'Hi, I have "quotes"\nand a second line';

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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'admin-export-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';

  const now = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify({
    atsCandidates: [
      { id: 'gp1', user_id: 'gp1', name: 'Ncube, Helen', email: 'helen@test.local', country: 'United Kingdom', regStage: 'myintealth', rso: 'Hazel', joined: now, apps: [] },
      { id: 'gp2', user_id: 'gp2', name: 'Isla Fraser', email: 'isla@test.local', country: 'Ireland', regStage: 'amc', rso: 'Grace', joined: now, apps: [] }
    ],
    atsJobs: [
      { id: 'job1', title: 'GP — DPA role', practice_name: 'Riverside Family Practice', location_city: 'Dubbo', location_state: 'NSW', provider: 'internal_ats', is_active: true }
    ],
    atsPlacements: [
      { id: 'pl1', application_id: 'app1', user_id: 'gp2', gp_name: 'Isla Fraser', practice_name: 'Riverside Family Practice', job_title: 'GP — DPA role', location: 'Dubbo, NSW', placed_at: now, start_date: '2026-09-01' }
    ],
    siteEnquiries: [
      { id: 'enq1', kind: 'practice', status: 'new', name: 'Dr Smith', email: 'smith@clinic.local', phone: '0400 000 000', practice_name: 'Clinic "A", Dubbo', state: 'NSW', message: TRICKY_MESSAGE, created_at: now },
      // Formula-injection payloads: leading = + - must be defused with an apostrophe.
      { id: 'enq2', kind: 'gp', status: 'new', name: '=HYPERLINK("http://evil","x")', email: 'evil@test.local', phone: '+1234', practice_name: '-5', state: 'NSW', message: 'hello', created_at: now },
      // Interior comma + apostrophe, NOT a leading formula char: quoted but not defused.
      { id: 'enq3', kind: 'gp', status: 'new', name: "O'Brien, John", email: 'obrien@test.local', phone: '0400 222 222', practice_name: '', state: 'NSW', message: 'hi', created_at: now }
    ],
    candidateLeads: [
      { id: 'l1', name: 'Lead One', email: 'one@leads.local', phone: '+61 400 111 111', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-07-01T00:00:00Z' },
      { id: 'l2', name: 'Lead Two', email: 'two@leads.local', phone: '', source: 'zoho_recruit', unsubscribed: true, created_at: '2026-07-02T00:00:00Z' },
      { id: 'l3', name: 'Lead Three', email: 'three@leads.local', phone: '', source: 'facebook', unsubscribed: false, created_at: '2026-07-03T00:00:00Z' }
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

describe('auth + validation', () => {
  it('rejects without a session', async () => {
    const r = await req('GET', '/api/admin/export?entity=gps&format=csv');
    expect([401, 403, 302]).toContain(r.status);
  });

  it('400s an unknown entity (with the allowed list)', async () => {
    const r = await req('GET', '/api/admin/export?entity=nope&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(400);
    expect(r.raw).toMatch(/gps/);
  });

  it('400s a non-csv format', async () => {
    const r = await req('GET', '/api/admin/export?entity=gps&format=xlsx', { cookie: superCookie() });
    expect(r.status).toBe(400);
  });
});

describe('CSV per entity', () => {
  it('gps: header row + RFC4180-quoted comma field', async () => {
    const r = await req('GET', '/api/admin/export?entity=gps&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="gplink-gps-/);
    const lines = r.raw.split('\r\n');
    expect(lines[0]).toBe('Name,Email,Country,Registration stage,Assigned RSO,Created');
    // "Ncube, Helen" contains a comma → must arrive quoted.
    expect(r.raw).toContain('"Ncube, Helen",helen@test.local');
    expect(r.raw).toContain('Isla Fraser,isla@test.local,Ireland,amc,Grace');
  });

  it('practices: derived from the seeded job', async () => {
    const r = await req('GET', '/api/admin/export?entity=practices&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    const lines = r.raw.split('\r\n');
    expect(lines[0]).toBe('Name,City,State,Type,Org type,Contact,Contact email,Contact phone,Stage,Agreement status,Jobs');
    expect(r.raw).toContain('Riverside Family Practice,Dubbo,NSW');
  });

  it('placements: includes the seeded placement row', async () => {
    const r = await req('GET', '/api/admin/export?entity=placements&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    const lines = r.raw.split('\r\n');
    expect(lines[0]).toBe('GP,Practice,Role,Location,Secured,Commencement');
    expect(r.raw).toContain('Riverside Family Practice');
    expect(r.raw).toContain('"Dubbo, NSW"');
    expect(r.raw).toContain('2026-09-01');
  });

  it('enquiries: a field with comma + quote + newline is ONE quoted field with doubled quotes', async () => {
    const r = await req('GET', '/api/admin/export?entity=enquiries&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    const lines = r.raw.split('\r\n');
    expect(lines[0]).toBe('Received,Kind,Status,Name,Email,Phone,Practice,State,Message');
    // Exact RFC 4180 encoding of the tricky message (interior \n preserved raw).
    expect(r.raw).toContain('"Hi, I have ""quotes""\nand a second line"');
    // Practice name with comma+quotes also quoted.
    expect(r.raw).toContain('"Clinic ""A"", Dubbo"');
  });

  it('enquiries: formula-injection payloads are apostrophe-defused (and still ONE field)', async () => {
    const r = await req('GET', '/api/admin/export?entity=enquiries&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    // =HYPERLINK(...) → leading apostrophe, then RFC4180-quoted (contains , and ")
    // so it still parses as a single field with doubled interior quotes.
    expect(r.raw).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
    // The raw formula must NEVER appear as an unquoted/undefused cell start.
    expect(r.raw).not.toMatch(/(^|,|\r\n)=HYPERLINK/);
    // Leading + and leading - are defused too; neither needs quoting.
    expect(r.raw).toContain(",'+1234,");
    expect(r.raw).toContain(",'-5,");
    expect(r.raw).not.toMatch(/(^|,|\r\n)\+1234(,|\r\n)/);
    expect(r.raw).not.toMatch(/(^|,|\r\n)-5(,|\r\n)/);
  });

  it("enquiries: O'Brien, John (interior comma/apostrophe) is quoted but NOT defused", async () => {
    const r = await req('GET', '/api/admin/export?entity=enquiries&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    // Comma forces RFC4180 quoting; no leading apostrophe is injected because
    // the first character is not a formula trigger.
    expect(r.raw).toContain('"O\'Brien, John",obrien@test.local');
    expect(r.raw).not.toContain("'O'Brien");
  });

  it('leads: includes the unsubscribed flag', async () => {
    const r = await req('GET', '/api/admin/export?entity=leads&format=csv', { cookie: superCookie() });
    expect(r.status).toBe(200);
    const lines = r.raw.split('\r\n');
    expect(lines[0]).toBe('Name,Email,Phone,Source,Unsubscribed,Created');
    expect(r.raw).toContain('Lead Two,two@leads.local,,zoho_recruit,yes');
    // Phone starts with '+' → defused with a leading apostrophe (formula-injection guard).
    expect(r.raw).toContain("Lead One,one@leads.local,'+61 400 111 111,zoho_recruit,no");
    // Newest-first: no truncation header when everything fits.
    expect(r.headers['x-export-truncated']).toBeUndefined();
  });
});

describe('row cap / truncation', () => {
  it('limit=2 truncates the 3 leads and flags X-Export-Truncated', async () => {
    const r = await req('GET', '/api/admin/export?entity=leads&format=csv&limit=2', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.headers['x-export-truncated']).toBe('true');
    // header + 2 data rows + trailing CRLF
    const dataLines = r.raw.split('\r\n').filter(Boolean);
    expect(dataLines.length).toBe(3);
  });

  it('a generous limit returns all rows without the truncation flag', async () => {
    const r = await req('GET', '/api/admin/export?entity=leads&format=csv&limit=100', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.headers['x-export-truncated']).toBeUndefined();
    const dataLines = r.raw.split('\r\n').filter(Boolean);
    expect(dataLines.length).toBe(4);
  });
});
