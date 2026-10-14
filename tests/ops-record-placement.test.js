// POST /api/admin/ops/record-placement — record an OFF-PLATFORM placement end
// to end from a service-key call (owner 2026-10-14: "please do it from your
// side" for Dr Akkas at Halekulani, whose card had been dragged straight to
// Hired, which left no offer, no placement record and no practice pack, and
// hid every drawer button that could have fixed it).
//
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against the dev
// seed, same pattern as tests/ats-job-editor.test.js. The service-role key is
// set (the ops header must match SOMETHING) while the URL stays empty, so the
// server still runs its local branches.
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
const DB_FILE = path.join('/tmp', `gplink-ops-placement-${RUN_ID}.json`);
const OPS_KEY = 'ops-test-key-' + RUN_ID;
let server, port;

function req(method, p, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const db = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const dbJob = (id) => db().atsJobs.find((j) => String(j.id) === String(id));
const dbApp = (id) => db().atsApplications.find((a) => String(a.id) === String(id));
const dbOffer = (appId) => (db().atsOffers || []).find((o) => String(o.application_id) === String(appId));
const OPS = { 'x-gp-ops-key': OPS_KEY };

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ops-placement-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = OPS_KEY;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = 'ops-test.local';
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.OPENAI_API_KEY = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/admin/ops/record-placement — auth + validation', () => {
  it('refuses without the ops key or an admin session', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', { body: { application_id: 'c14' } });
    expect([401, 403]).toContain(r.status);
    expect(dbApp('c14').ats_stage).toBe('offer'); // untouched
  });

  it('refuses a wrong ops key', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', { headers: { 'x-gp-ops-key': 'nope' }, body: { application_id: 'c14' } });
    expect([401, 403]).toContain(r.status);
  });

  it('400 without application_id, 404 for an unknown application', async () => {
    const a = await req('POST', '/api/admin/ops/record-placement', { headers: OPS, body: {} });
    expect(a.status).toBe(400);
    const b = await req('POST', '/api/admin/ops/record-placement', { headers: OPS, body: { application_id: 'no-such-app' } });
    expect(b.status).toBe(404);
  });
});

describe('POST /api/admin/ops/record-placement — dry run', () => {
  it('reports what it would do and writes nothing', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', {
      headers: OPS,
      body: { application_id: 'c14', dry_run: true, job_title: 'General Practitioner || Perth Metro GP', commencement_date: '2027-07-01' }
    });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.dry_run).toBe(true);
    expect(b.application.ats_stage).toBe('offer');
    expect(b.job.id).toBe('j4');
    expect(b.job.job_status).toBe('open');
    expect(b.would.rename_job).toBe(true);
    expect(b.would.commencement_date).toBe('2027-07-01');
    expect(b.would.start_date).toBe('2027-07-01'); // falls back to the commencement date
    expect(b.existing_offer).toBeNull();
    // Nothing changed.
    expect(dbApp('c14').ats_stage).toBe('offer');
    expect(dbJob('j4').title).toBe('General Practitioner — Private');
    expect(dbOffer('c14')).toBeUndefined();
  });
});

describe('POST /api/admin/ops/record-placement — the real thing', () => {
  it('renames the job, records the offer + terms, hires, secures, fills the job', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', {
      headers: OPS,
      body: {
        application_id: 'c14',
        job_title: 'General Practitioner || Perth Metro GP',
        commencement_date: '2027-07-01',
        offer: {
          billing_split: '65%',
          relocation_package: '$10,000',
          notes: 'Signed service agreement on file.',
          sent_by: 'hello@gplink-test.local'
        }
      }
    });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.resume).toBe(false);
    expect(b.application.ats_stage).toBe('hired');
    expect(b.application.status).toBe('placement_secured');
    expect(b.offer.status).toBe('accepted');
    expect(b.offer.start_date).toBe('2027-07-01');
    expect(b.job.renamed).toBe(true);
    expect(b.job.title).toBe('General Practitioner || Perth Metro GP');
    // gps_needed defaults to 1 → the single hire fills the internal job.
    expect(b.job.job_status).toBe('filled');

    // Persisted, not just reported.
    const app = dbApp('c14');
    expect(app.ats_stage).toBe('hired');
    expect(app.status).toBe('placement_secured');
    const offer = dbOffer('c14');
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('accepted');
    expect(offer.billing_split).toBe('65%');
    expect(offer.relocation_package).toBe('$10,000');
    expect(offer.start_date).toBe('2027-07-01');
    expect(offer.job_title).toBe('General Practitioner || Perth Metro GP');
    expect(offer.sent_by).toBe('hello@gplink-test.local');
    expect(offer.contract_document_key).toBeNull(); // no contract sent in this call
    expect(dbJob('j4').job_status).toBe('filled');
    expect(dbJob('j4').title).toBe('General Practitioner || Perth Metro GP');
  });

  it('a second call is a 409 already_secured — never a double placement', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', { headers: OPS, body: { application_id: 'c14' } });
    expect(r.status).toBe(409);
    expect(parse(r.raw).code).toBe('already_secured');
  });

  it('an unreadable contract payload is a 400 and writes nothing', async () => {
    const r = await req('POST', '/api/admin/ops/record-placement', {
      headers: OPS,
      body: { application_id: 'c5', contract_data_url: 'not-a-data-url', contract_file_name: 'x.pdf' }
    });
    expect(r.status).toBe(400);
    expect(dbApp('c5').ats_stage).toBe('offer');
    expect(dbOffer('c5')).toBeUndefined();
  });
});

describe('staff-recorded placements never tell the doctor to book an interview', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('finalizeInAppPlacement honours opts.placementConfirmed', () => {
    const start = src.indexOf('async function finalizeInAppPlacement(');
    const body = src.slice(start, start + 12000);
    expect(body).toMatch(/var hasInterview = !!options\.placementConfirmed;/);
    expect(body).toMatch(/if \(!hasInterview && isSupabaseDbConfigured\(\)\)/);
  });

  it('both staff paths pass it; the GP self-accept does not', () => {
    const plc = src.indexOf("pathname === '/api/ats/placement' && req.method === 'POST'");
    expect(src.slice(plc, plc + 6000)).toMatch(/placementConfirmed: true/);
    const ops = src.indexOf("pathname === '/api/admin/ops/record-placement' && req.method === 'POST'");
    expect(src.slice(ops, ops + 12000)).toMatch(/placementConfirmed: true/);
    const accept = src.indexOf("pathname === '/api/career/offer/accept'");
    expect(accept).toBeGreaterThan(0);
    expect(src.slice(accept, accept + 8000)).not.toMatch(/placementConfirmed/);
  });

  it('the offer endpoint and the ops endpoint share one contract-delivery helper', () => {
    expect(src.match(/deliverOfferContractForApplication\(/g).length).toBeGreaterThanOrEqual(3); // def + 2 call sites
    const offerStart = src.indexOf("pathname === '/api/ats/offer' && req.method === 'POST'");
    expect(src.slice(offerStart, offerStart + 6000)).not.toMatch(/supabaseStorageUploadObject\(/);
  });
});
