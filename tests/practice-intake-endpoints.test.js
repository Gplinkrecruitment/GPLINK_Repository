// Public-surface HTTP tests for the practice-client pipeline (no session/auth
// required by design — these are the endpoints a real practice contact or
// the Facebook Lead Ads webhook hits directly). Boots the real server in
// LOCAL-JSON mode (SUPABASE_URL=''), same pattern as tests/ats-endpoints.test.js
// — a hermetic temp DB file per run, no network calls (RESEND_API_KEY unset
// so sendEmail short-circuits before ever reaching the network).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-intake-${RUN_ID}.json`);
const FB_SECRET = 'fb-secret-' + RUN_ID;
const FB_VERIFY_TOKEN = 'fb-verify-' + RUN_ID;
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let server, port;
const createdPdfPracticeIds = [];

function req(method, p, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function findPracticeByEmail(email) {
  const db = readDb();
  return (db.atsPractices || []).find((p) => p.contact_email === email) || null;
}

function validIntakePayload(token) {
  return {
    token,
    billing_style: 'mixed',
    dpa: 'yes',
    percentage_split: '70/30',
    suburb: 'Fitzroy',
    nearest_city: 'Melbourne',
    state: 'VIC',
    address: '1 Smith St, Fitzroy VIC 3065'
  };
}

// Creates a fresh prospective practice the same way production does — via
// the Facebook lead webhook — then reads its intake_token straight out of
// the local JSON DB (the webhook response deliberately never returns the
// token, so a real practice's link can't be reconstructed from the API).
let leadCounter = 0;
async function createProspectivePractice(label) {
  leadCounter += 1;
  const email = `prac-${label}-${leadCounter}-${RUN_ID}@example.com`;
  const r = await req('POST', '/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), {
    body: {
      lead_id: `lead-${label}-${leadCounter}-${RUN_ID}`,
      practice_name: `Practice ${label} ${leadCounter}`,
      contact_name: 'Dr Test Contact',
      contact_email: email
    }
  });
  const body = parse(r.raw);
  const row = findPracticeByEmail(email);
  return { practiceId: body && body.practice_id, token: row && row.intake_token, email };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'practice-intake-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = '';
  delete process.env.FB_LEAD_WEBHOOK_SECRET;
  delete process.env.FB_LEAD_VERIFY_TOKEN;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch {}
  // The sign endpoint's local-mode fallback writes a real PDF to disk —
  // clean up anything this run created.
  createdPdfPracticeIds.forEach((id) => {
    try { fs.unlinkSync(path.join(ROOT, 'data', 'practice-agreements', id + '.pdf')); } catch {}
  });
});

describe('GET/POST /api/webhooks/facebook-lead', () => {
  it('503s when FB_LEAD_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.FB_LEAD_WEBHOOK_SECRET;
    const r = await req('POST', '/api/webhooks/facebook-lead?secret=whatever', {
      body: { practice_name: 'Test', contact_email: 'a@b.com' }
    });
    expect(r.status).toBe(503);
    expect(parse(r.raw).ok).toBe(false);
  });

  it('401s on the wrong secret', async () => {
    process.env.FB_LEAD_WEBHOOK_SECRET = FB_SECRET;
    const r = await req('POST', '/api/webhooks/facebook-lead?secret=totally-wrong-secret', {
      body: { practice_name: 'Test', contact_email: 'a@b.com' }
    });
    expect(r.status).toBe(401);
    expect(parse(r.raw).ok).toBe(false);
  });

  it('GET handshake 200s and echoes the challenge with the correct verify token', async () => {
    process.env.FB_LEAD_VERIFY_TOKEN = FB_VERIFY_TOKEN;
    const r = await req(
      'GET',
      '/api/webhooks/facebook-lead?hub.mode=subscribe&hub.verify_token=' +
        encodeURIComponent(FB_VERIFY_TOKEN) +
        '&hub.challenge=challenge-123'
    );
    expect(r.status).toBe(200);
    expect(r.raw).toBe('challenge-123');
  });

  it('GET handshake 403s with the wrong verify token', async () => {
    const r = await req('GET', '/api/webhooks/facebook-lead?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=challenge-123');
    expect(r.status).toBe(403);
  });

  it('GET handshake 403s with an empty verify token', async () => {
    const r = await req('GET', '/api/webhooks/facebook-lead?hub.mode=subscribe&hub.verify_token=&hub.challenge=challenge-123');
    expect(r.status).toBe(403);
  });

  it('200s and creates a prospective practice with an intake_token for a recognized lead payload', async () => {
    process.env.FB_LEAD_WEBHOOK_SECRET = FB_SECRET;
    const email = `lead-recognized-${RUN_ID}@example.com`;
    const r = await req('POST', '/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), {
      body: {
        lead_id: `lead-recognized-${RUN_ID}`,
        practice_name: 'Riverside Test Clinic',
        contact_name: 'Dr Test',
        contact_email: email,
        contact_phone: '0400000000',
        location: 'Melbourne'
      }
    });
    expect(r.status).toBe(200);
    const body = parse(r.raw);
    expect(body.ok).toBe(true);
    expect(body.practice_id).toBeTruthy();

    const row = findPracticeByEmail(email);
    expect(row).toBeTruthy();
    expect(row.stage).toBe('prospective');
    expect(typeof row.intake_token).toBe('string');
    expect(row.intake_token.length).toBeGreaterThan(15);
  });

  it('400s for an unrecognized payload', async () => {
    const r = await req('POST', '/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), { body: {} });
    expect(r.status).toBe(400);
    const body = parse(r.raw);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unrecognized_payload');
  });
});

describe('GET/POST /api/practice-intake', () => {
  it('404s for a short/malformed token', async () => {
    const r = await req('GET', '/api/practice-intake?token=short');
    expect(r.status).toBe(404);
  });

  it('404s for a well-formed but unknown token', async () => {
    const r = await req('GET', '/api/practice-intake?token=' + 'x'.repeat(32));
    expect(r.status).toBe(404);
  });

  it('honeypot: a filled website_hp field returns a fake ok and stores nothing', async () => {
    const { token } = await createProspectivePractice('honeypot');
    expect(token).toBeTruthy();

    const r = await req('POST', '/api/practice-intake', {
      body: Object.assign(validIntakePayload(token), { website_hp: 'http://spam.example.com' })
    });
    expect(r.status).toBe(200);
    expect(parse(r.raw).ok).toBe(true);

    const check = await req('GET', '/api/practice-intake?token=' + encodeURIComponent(token));
    const checkBody = parse(check.raw);
    expect(checkBody.practice.submitted).toBe(false);
  });

  it('saves valid intake answers, then GET echoes submitted:true', async () => {
    const { token } = await createProspectivePractice('save');
    expect(token).toBeTruthy();

    const r = await req('POST', '/api/practice-intake', { body: validIntakePayload(token) });
    expect(r.status).toBe(200);
    expect(parse(r.raw).ok).toBe(true);

    const check = await req('GET', '/api/practice-intake?token=' + encodeURIComponent(token));
    expect(check.status).toBe(200);
    const checkBody = parse(check.raw);
    expect(checkBody.ok).toBe(true);
    expect(checkBody.practice.submitted).toBe(true);
    expect(checkBody.practice.intake.suburb).toBe('Fitzroy');
  });
});

describe('POST /api/practice-intake/sign', () => {
  it('400s invalid_signature_payload for a non-PNG signature data URL', async () => {
    const { token } = await createProspectivePractice('badsig');
    await req('POST', '/api/practice-intake', { body: validIntakePayload(token) });

    const r = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: 'data:image/jpeg;base64,notarealpng', signed_name: 'Dr Test', authorised: true }
    });
    expect(r.status).toBe(400);
    expect(parse(r.raw).error).toBe('invalid_signature_payload');
  });

  it('409s intake_incomplete when signing before the intake form is submitted', async () => {
    const { token } = await createProspectivePractice('nointake');

    const r = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Test', authorised: true }
    });
    expect(r.status).toBe(409);
    expect(parse(r.raw).error).toBe('intake_incomplete');
  });

  it('happy path: signs, promotes the practice to active, and creates a pending job', async () => {
    const { token, practiceId } = await createProspectivePractice('happysign');
    await req('POST', '/api/practice-intake', { body: validIntakePayload(token) });

    const r = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Jane Smith', authorised: true }
    });
    expect(r.status).toBe(200);
    const body = parse(r.raw);
    expect(body.ok).toBe(true);
    expect(body.practice_stage).toBe('active');
    expect(body.job_id).toBeTruthy();
    createdPdfPracticeIds.push(practiceId);

    const row = (readDb().atsPractices || []).find((p) => p.id === practiceId);
    expect(row.stage).toBe('active');
    expect(row.agreement_status).toBe('signed');
  });

  it('409s already_signed on a re-sign attempt', async () => {
    const { token, practiceId } = await createProspectivePractice('resign');
    await req('POST', '/api/practice-intake', { body: validIntakePayload(token) });

    const first = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Test', authorised: true }
    });
    expect(first.status).toBe(200);
    createdPdfPracticeIds.push(practiceId);

    const second = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Test', authorised: true }
    });
    expect(second.status).toBe(409);
    expect(parse(second.raw).error).toBe('already_signed');
  });
});
