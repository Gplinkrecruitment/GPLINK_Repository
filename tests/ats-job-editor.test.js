// Phase 3 · Task 2 — admin job-detail editor endpoints with full intake-field
// parity (/api/ats/job GET+PATCH, /api/ats/jobs POST intake mode) plus the
// contract-upload %PDF- magic-byte sniff.
//
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against the dev
// seed, same pattern as tests/ats-endpoints.test.js.
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
const DB_FILE = path.join('/tmp', `gplink-ats-editor-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;

const OLD_VIDEO = 'https://videos.example.com/old-intro.mp4';
const NEW_VIDEO = 'https://videos.example.com/new-intro.mp4';

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function gpCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'editor-gp@gplink-test.local' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
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
const dbJob = (id) => JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).atsJobs.find((j) => String(j.id) === String(id));

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ats-editor-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.OPENAI_API_KEY = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsJobs = seeded.atsJobs || [];
  const NOW = new Date().toISOString();
  seeded.atsJobs.push(
    // je1 — approved live internal job used for the full-parity PATCH, the GET
    // round-trip, and the GP detail intro-video integration. Carries an OLD
    // intake-era video in source_payload so editor authority is proven.
    {
      id: 'je1', provider: 'internal_ats', provider_role_id: 'ats_je1',
      title: 'GP — Editor Row One', masked_title: 'DPA - Oldtown - Mixed Billing',
      practice_name: 'Editor Practice One', location_city: 'Brisbane', location_state: 'QLD',
      suburb: 'Oldtown', nearest_city: 'Brisbane', billing_model: 'mixed', dpa: true,
      summary: 'Original summary', is_active: true, job_status: 'open', approval_status: 'approved',
      header_image_url: 'https://cdn.gplink-test.local/suburbs/oldtown/1.png', ats_created: true,
      source_payload: { practice_intro: { video_url: OLD_VIDEO, text: 'Old intro text' } },
      details: { legacy_note: 'keep-me' },
      created_at: NOW, updated_at: NOW
    },
    // je2 — masked-title recompute + validation target.
    {
      id: 'je2', provider: 'internal_ats', provider_role_id: 'ats_je2',
      title: 'GP — Editor Row Two', masked_title: 'DPA - Westbrook - Bulk Billing',
      practice_name: 'Editor Practice Two', location_city: 'Toowoomba', location_state: 'QLD',
      suburb: 'Westbrook', nearest_city: 'Toowoomba', billing_model: 'bulk', dpa: true,
      summary: 'Row two summary', is_active: true, job_status: 'open', approval_status: 'approved',
      header_image_url: 'https://cdn.gplink-test.local/suburbs/westbrook/1.png', ats_created: true,
      created_at: NOW, updated_at: NOW
    }
  );
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('PATCH /api/ats/job — full intake-field parity', () => {
  it('persists every column-mapped + details-jsonb field and recomputes masked_title', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je1', {
      host: SUPER_HOST, cookie: superCookie(),
      body: {
        billing_style: 'bulk', dpa: true, suburb: 'Rangeville', nearest_city: 'Toowoomba',
        state: 'qld', address: '12 Main Street, Rangeville', mmm: 'MM5', earnings_text: '$400k+ estimated',
        ownership: 'Privately owned', visa_sponsorship: true, role_summary: 'Updated role summary',
        gp_count: '6', percentage_split: '70%', incentives: 'Relocation bonus', nursing_on_site: true,
        years_operating: '12', general_location: 'Darling Downs', intro_text: 'Fresh intro text',
        intro_video_url: NEW_VIDEO
      }
    });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);

    const row = dbJob('je1');
    // Column-mapped
    expect(row.billing_model).toBe('bulk');
    expect(row.mixed_billing).toBe(false);
    expect(row.private_billing).toBe(false);
    expect(row.dpa).toBe(true);
    expect(row.suburb).toBe('Rangeville');
    expect(row.nearest_city).toBe('Toowoomba');
    expect(row.location_state).toBe('QLD'); // uppercased by the shared validator
    expect(row.address).toBe('12 Main Street, Rangeville');
    expect(row.mmm).toBe('MM5');
    expect(row.earnings_text).toBe('$400k+ estimated');
    expect(row.practice_type).toBe('Privately owned');
    expect(row.visa_pathway_aligned).toBe(true);
    expect(row.summary).toBe('Updated role summary');
    // Details jsonb — merged, unknown keys kept
    expect(row.details.gp_count).toBe('6');
    expect(row.details.percentage_split).toBe('70%');
    expect(row.details.incentives).toBe('Relocation bonus');
    expect(row.details.nursing_on_site).toBe(true);
    expect(row.details.years_operating).toBe('12');
    expect(row.details.general_location).toBe('Darling Downs');
    expect(row.details.intro_text).toBe('Fresh intro text');
    expect(row.details.intro_video_url).toBe(NEW_VIDEO);
    expect(row.details.legacy_note).toBe('keep-me');
    // Editor authority: the intake-era source_payload video is overwritten too
    expect(row.source_payload.practice_intro.video_url).toBe(NEW_VIDEO);
    expect(row.source_payload.practice_intro.text).toBe('Fresh intro text');
    // Masked title recomputed from merged state
    expect(row.masked_title).toBe('DPA - Rangeville (Toowoomba) - Bulk Billing');
  });

  it('GET /api/ats/job editor payload round-trips everything the PATCH wrote', async () => {
    const r = await req('GET', '/api/ats/job?id=je1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const e = parse(r.raw).editor;
    expect(e.billing_style).toBe('bulk');
    expect(e.dpa).toBe(true);
    expect(e.suburb).toBe('Rangeville');
    expect(e.nearest_city).toBe('Toowoomba');
    expect(e.state).toBe('QLD');
    expect(e.address).toBe('12 Main Street, Rangeville');
    expect(e.mmm).toBe('MM5');
    expect(e.earnings_text).toBe('$400k+ estimated');
    expect(e.ownership).toBe('Privately owned');
    expect(e.visa_sponsorship).toBe(true);
    expect(e.role_summary).toBe('Updated role summary');
    expect(e.gp_count).toBe('6');
    expect(e.percentage_split).toBe('70%');
    expect(e.incentives).toBe('Relocation bonus');
    expect(e.nursing_on_site).toBe(true);
    expect(e.years_operating).toBe('12');
    expect(e.general_location).toBe('Darling Downs');
    expect(e.intro_text).toBe('Fresh intro text');
    expect(e.intro_video_url).toBe(NEW_VIDEO);
    expect(e.masked_title).toBe('DPA - Rangeville (Toowoomba) - Bulk Billing');
    expect(e.approval_status).toBe('approved');
    expect(e.header_image_url).toBe('https://cdn.gplink-test.local/suburbs/oldtown/1.png');
  });
});

describe('masked-title recompute rules', () => {
  it('a dpa flip moves the title between DPA and Non-DPA', async () => {
    let r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { dpa: false } });
    expect(r.status).toBe(200);
    expect(dbJob('je2').masked_title).toBe('Non-DPA - Westbrook (Toowoomba) - Bulk Billing');
    r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { dpa: true } });
    expect(r.status).toBe(200);
    expect(dbJob('je2').masked_title).toBe('DPA - Westbrook (Toowoomba) - Bulk Billing');
  });

  it('a suburb change recomputes the title', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { suburb: 'Highfields' } });
    expect(r.status).toBe(200);
    expect(dbJob('je2').masked_title).toBe('DPA - Highfields (Toowoomba) - Bulk Billing');
  });

  it('a billing change recomputes the title', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { billing_style: 'private' } });
    expect(r.status).toBe(200);
    expect(dbJob('je2').masked_title).toBe('DPA - Highfields (Toowoomba) - Private Billing');
  });

  it('an edit that touches no title ingredient leaves masked_title untouched', async () => {
    const before = dbJob('je2').masked_title;
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { summary: 'Just a copy tweak', gp_count: '9' } });
    expect(r.status).toBe(200);
    const row = dbJob('je2');
    expect(row.masked_title).toBe(before);
    expect(row.summary).toBe('Just a copy tweak');
    expect(row.details.gp_count).toBe('9');
  });
});

describe('partial validation — same rules as the intake form', () => {
  it('rejects a bad billing_style, naming the field', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { billing_style: 'gold-plated' } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('billing_style');
  });

  it('rejects a bad mmm, naming the field', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { mmm: 'MM9' } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('mmm');
  });

  it('rejects an oversized intro_text, naming the field', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { intro_text: 'x'.repeat(4001) } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('intro_text');
  });

  it('rejects a non-AU state, naming the field', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { state: 'Queensland' } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('state');
  });

  it('a 400 applies nothing (no half-writes)', async () => {
    const before = dbJob('je2');
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { suburb: 'ShouldNotStick', billing_style: 'nope' } });
    expect(r.status).toBe(400);
    const after = dbJob('je2');
    expect(after.suburb).toBe(before.suburb);
    expect(after.billing_model).toBe(before.billing_model);
  });

  it('accepts a valid partial subset', async () => {
    const r = await req('PATCH', '/api/ats/job?id=je2', { host: SUPER_HOST, cookie: superCookie(), body: { mmm: 'MM3' } });
    expect(r.status).toBe(200);
    expect(dbJob('je2').mmm).toBe('MM3');
  });
});

describe('POST /api/ats/jobs — full manual creation via intake', () => {
  const FULL_INTAKE = {
    billing_style: 'mixed', dpa: true, mmm: 'MM4', visa_sponsorship: true,
    ownership: 'Family owned', years_operating: '8', nursing_on_site: true, gp_count: '4',
    percentage_split: '65%', incentives: 'Sign-on bonus', earnings_text: '$350k+ estimated',
    suburb: 'Wilsonton', nearest_city: 'Toowoomba', state: 'QLD', address: '4 Clinic Road, Wilsonton',
    general_location: 'Darling Downs', role_title: '', role_summary: 'Join a friendly team.',
    intro_text: 'Welcome to our practice', intro_video_url: 'https://videos.example.com/wilsonton.mp4',
    urgency: 'asap', employment_type: 'either', gps_needed: '1'
  };
  let createdId = null;

  it('creates a pending job with masked_title + source_payload.intake', async () => {
    const r = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { practice_id: 'p1', intake: FULL_INTAKE } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.job.approval_status).toBe('pending');
    expect(b.job.masked_title).toBe('DPA - Wilsonton (Toowoomba) - Mixed Billing');
    createdId = b.job.id;
    const row = dbJob(createdId);
    expect(row.is_active).toBe(false);
    expect(row.approval_status).toBe('pending');
    expect(row.masked_title).toBe('DPA - Wilsonton (Toowoomba) - Mixed Billing');
    expect(row.source_payload.intake.suburb).toBe('Wilsonton');
    expect(row.source_payload.intake.percentage_split).toBe('65%');
    expect(row.practice_id).toBe('p1');
    // editor payload comes back for immediate prefill
    expect(b.editor.suburb).toBe('Wilsonton');
    expect(b.editor.billing_style).toBe('mixed');
    // Task 7 (Sub-task B): the practice's full-time/part-time answer must
    // reach career_roles.employment_type — atsJobEditorPayload reads that
    // COLUMN, not source_payload.intake, so createPendingJobFromIntake
    // must actually write it there or this box stays permanently blank.
    expect(row.employment_type).toBe('either');
    expect(b.editor.employment_type).toBe('either');
  });

  it('approval stays blocked without a suburb header photo', async () => {
    const r = await req('POST', '/api/ats/job/approve?id=' + createdId, { host: SUPER_HOST, cookie: superCookie(), body: { action: 'approve' } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('suburb header photo');
  });

  it('requires practice_id and a valid full intake', async () => {
    const noPractice = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { intake: FULL_INTAKE } });
    expect(noPractice.status).toBe(400);
    const badIntake = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { practice_id: 'p1', intake: { ...FULL_INTAKE, suburb: '' } } });
    expect(badIntake.status).toBe(400);
    expect(parse(badIntake.raw).message).toContain('suburb');
  });

  it('legacy minimal POST is unchanged', async () => {
    const r = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { title: 'GP — Legacy Minimal', practice_id: 'p1', city: 'Cairns', state: 'QLD', type: 'Locum', billing: 'Mixed billing' } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.job.title).toBe('GP — Legacy Minimal');
    expect(b.job.status).toBe('open');
    expect(b.job.approval_status).toBe('approved'); // card default — live immediately, as before
  });
});

describe('GP-facing integration — intro video surfaces, operational detail does not', () => {
  it('details.intro_video_url written by PATCH surfaces as introVideoUrl on the GP detail endpoint', async () => {
    const r = await req('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_je1'), { cookie: gpCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    // The editor's value wins over the stale intake-era source_payload video.
    expect(b.role.introVideoUrl).toBe(NEW_VIDEO);
    expect(r.raw).not.toContain(OLD_VIDEO);
  });

  it('/api/public/jobs never carries the intro video or editor-only detail', async () => {
    const r = await req('GET', '/api/public/jobs');
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain(NEW_VIDEO);
    expect(r.raw).not.toContain('introVideoUrl');
    expect(r.raw).not.toContain('percentage_split');
    expect(r.raw).not.toContain('12 Main Street');
  });
});

describe('contract upload — %PDF- magic-byte sniff', () => {
  it('rejects a data URL that claims application/pdf but is not a PDF', async () => {
    const fake = 'data:application/pdf;base64,' + Buffer.from('hello, definitely not a pdf').toString('base64');
    const r = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'p1', file_data: fake } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).message).toContain('PDF');
  });

  it('still accepts a real PDF header', async () => {
    const real = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\ntest\n%%EOF').toString('base64');
    const r = await req('POST', '/api/ats/practice/contract', { host: SUPER_HOST, cookie: superCookie(), body: { id: 'p1', file_data: real, file_name: 'signed.pdf' } });
    expect(r.status).toBe(200);
    expect(parse(r.raw).ok).toBe(true);
  });
});
