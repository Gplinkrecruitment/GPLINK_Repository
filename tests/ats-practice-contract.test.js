// Phase 3 Task 1, org_type through the ATS practice endpoints + manual
// signed-contract upload (/api/ats/practice/contract).
// Boots the real server in LOCAL-JSON mode against the dev seed (same pattern
// as tests/ats-endpoints.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-praccontract-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;
const createdManualPdfIds = []; // local-mode files to clean up

const PDF_DATA_URL = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\ntest\n%%EOF').toString('base64');
const PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('not-a-pdf').toString('base64');

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'praccontract-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // An e-signed practice: the manual upload must NEVER regress its status or
  // touch its e-signed pdf key.
  seeded.atsPractices = seeded.atsPractices || [];
  seeded.atsPractices.push({
    id: 'pes1', name: 'Esigned Clinic ' + RUN_ID, location_city: 'Cairns', location_state: 'QLD',
    location_country: 'Australia', source: 'internal_ats', is_active: true, stage: 'active',
    agreement_status: 'signed', agreement_signed_pdf_key: 'local:data/practice-agreements/pes1.pdf',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  // A job whose practice exists ONLY as a name (synthetic name-id practice).
  seeded.atsJobs = seeded.atsJobs || [];
  seeded.atsJobs.push({
    id: 'jco1', provider: 'internal_ats', title: 'GP, Contract Only', practice_name: 'Contract Only Clinic',
    location_city: 'Toowoomba', location_state: 'QLD', is_active: true, job_status: 'open',
    approval_status: 'approved', ats_created: true,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
  createdManualPdfIds.forEach((id) => {
    try { fs.unlinkSync(path.join(ROOT, 'data', 'practice-agreements', id + '-manual.pdf')); } catch {}
  });
});

describe('org_type', () => {
  it('creates a corporation and reads it back on detail + list card', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Corp Group ' + RUN_ID, city: 'Sydney', state: 'NSW', org_type: 'corporation' } });
    expect(c.status).toBe(200);
    const created = parse(c.raw).practice;
    expect(created.org_type).toBe('corporation');
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(created.id), { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.ok).toBe(true);
    expect(db.practice.org_type).toBe('corporation');
    const l = await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() });
    const card = parse(l.raw).practices.find((p) => p.id === created.id);
    expect(card.org_type).toBe('corporation');
    expect(card.has_contract).toBe(false);
  });
  it('defaults org_type to practice when omitted on create', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Plain Clinic ' + RUN_ID, city: 'Hobart', state: 'TAS' } });
    expect(parse(c.raw).practice.org_type).toBe('practice');
  });
  it('rejects an invalid org_type on create', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Bad Org ' + RUN_ID, org_type: 'franchise' } });
    expect(c.status).toBe(400);
  });
  it('PATCHes a practice to corporation and rejects invalid values', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=p1', { host: SUPER_HOST, cookie: superCookie(), body: { org_type: 'corporation' } });
    expect(e.status).toBe(200);
    expect(parse(e.raw).practice.org_type).toBe('corporation');
    const bad = await req('PATCH', '/api/ats/practice?id=p1', { host: SUPER_HOST, cookie: superCookie(), body: { org_type: 'conglomerate' } });
    expect(bad.status).toBe(400);
  });
  it('derived name-only practice defaults to org_type practice', async () => {
    const id = 'name:' + encodeURIComponent('Contract Only Clinic');
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(d.raw);
    expect(b.ok).toBe(true);
    expect(b.practice.org_type).toBe('practice');
    expect(b.practice.has_contract).toBe(false);
  });
});

describe('manual contract upload', () => {
  it('stores the PDF, sets manual fields + signed status, and surfaces it on detail + list', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Manual Contract Clinic ' + RUN_ID, city: 'Perth', state: 'WA' } });
    const created = parse(c.raw).practice;
    createdManualPdfIds.push(created.id);
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: created.id, file_data: PDF_DATA_URL, file_name: 'signed-agreement.pdf' } });
    expect(u.status).toBe(200);
    const ub = parse(u.raw);
    expect(ub.ok).toBe(true);
    expect(ub.practice.agreement_status).toBe('signed');
    expect(ub.practice.has_contract).toBe(true);
    expect(ub.practice.agreement_manual_uploaded_by).toBe('super@gplink-test.local');
    // Local-mode file actually written
    expect(fs.existsSync(path.join(ROOT, 'data', 'practice-agreements', created.id + '-manual.pdf'))).toBe(true);
    // Detail carries the manual fields (local: key → no signed URL)
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(created.id), { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.practice.agreement_status).toBe('signed');
    expect(db.practice.has_contract).toBe(true);
    expect(db.practice.agreement_manual_uploaded_at).toBeTruthy();
    expect(db.practice.agreement_manual_uploaded_by).toBe('super@gplink-test.local');
    expect(db.practice.agreement_manual_pdf_url).toBe(null);
    // List card flags the contract
    const l = await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() });
    const card = parse(l.raw).practices.find((p) => p.id === created.id);
    expect(card.has_contract).toBe(true);
    expect(card.agreement_status).toBe('signed');
    // Never touched the e-sign column
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const row = raw.atsPractices.find((p) => p.id === created.id);
    expect(row.agreement_signed_pdf_key || '').toBe('');
    expect(row.agreement_manual_pdf_key).toBe('local:data/practice-agreements/' + created.id + '-manual.pdf');
  });
  it('rejects a non-PDF payload', async () => {
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'p1', file_data: PNG_DATA_URL } });
    expect(u.status).toBe(400);
  });
  it('rejects a missing/garbage file_data', async () => {
    const u1 = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'p1' } });
    expect(u1.status).toBe(400);
    const u2 = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'p1', file_data: 'nonsense' } });
    expect(u2.status).toBe(400);
  });
  it('404s on an unknown practice id', async () => {
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'nope-' + RUN_ID, file_data: PDF_DATA_URL } });
    expect(u.status).toBe(404);
  });
  it('never regresses an e-signed practice or touches its e-signed key', async () => {
    createdManualPdfIds.push('pes1');
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'pes1', file_data: PDF_DATA_URL } });
    expect(u.status).toBe(200);
    expect(parse(u.raw).practice.agreement_status).toBe('signed');
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const row = raw.atsPractices.find((p) => p.id === 'pes1');
    expect(row.agreement_status).toBe('signed');
    expect(row.agreement_signed_pdf_key).toBe('local:data/practice-agreements/pes1.pdf'); // untouched
    expect(row.agreement_manual_pdf_key).toBe('local:data/practice-agreements/pes1-manual.pdf');
  });
  it('upserts a real row for a synthetic name-id practice', async () => {
    const id = 'name:' + encodeURIComponent('Contract Only Clinic');
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id, file_data: PDF_DATA_URL } });
    expect(u.status).toBe(200);
    const ub = parse(u.raw);
    expect(ub.ok).toBe(true);
    expect(String(ub.practice.id).startsWith('name:')).toBe(false);
    createdManualPdfIds.push(ub.practice.id);
    expect(ub.practice.agreement_status).toBe('signed');
    // The derived practice now resolves through the real row with the contract on it
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.ok).toBe(true);
    expect(db.practice.id).toBe(ub.practice.id);
    expect(db.practice.has_contract).toBe(true);
  });
  it('blocks without a session', async () => {
    const u = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, body: { id: 'p1', file_data: PDF_DATA_URL } });
    expect([302, 401, 403, 404]).toContain(u.status);
  });
});
