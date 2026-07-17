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
    address: '1 Smith St, Fitzroy VIC 3065',
    urgency: 'asap',
    employment_type: 'either',
    gps_needed: '1'
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

// One clinic's full set of required intake answers, no `token` (a group
// submission's `practices[]` items never carry their own token — the token
// lives once at the top of the POST body). `overrides` merges on top, same
// convention as validIntakePayload.
function validClinicPayload(overrides) {
  return Object.assign(
    {
      billing_style: 'mixed',
      dpa: 'yes',
      percentage_split: '70/30',
      suburb: 'Fitzroy',
      nearest_city: 'Melbourne',
      state: 'VIC',
      address: '1 Smith St, Fitzroy VIC 3065',
      urgency: 'asap',
      employment_type: 'either',
      gps_needed: '1'
    },
    overrides || {}
  );
}

// Submits a fresh intake (creating its own prospective practice + token
// first) and reads the persisted result straight out of the local JSON DB —
// same house style as findPracticeByEmail above — rather than trusting a
// response shape the brief never specifies. Returns the raw saved practice
// row(s) for the group this submission's token resolves to, plus the top
// two DPA fields promoted for the single-clinic test cases.
//
// `overrides.practices`, when an array, is sent verbatim as body.practices
// (a group submission). Otherwise `overrides` is merged over a single valid
// clinic payload and sent at the top level (today's/legacy shape — no
// `practices` key at all).
let submitCounter = 0;
async function submitIntake(overrides = {}) {
  submitCounter += 1;
  const { token } = await createProspectivePractice('grp' + submitCounter);
  const body = { token };
  if (overrides.entity_name !== undefined) body.entity_name = overrides.entity_name;
  if (overrides.abn !== undefined) body.abn = overrides.abn;
  if (Array.isArray(overrides.practices)) {
    body.practices = overrides.practices;
  } else {
    Object.assign(body, validClinicPayload(overrides));
  }

  const r = await req('POST', '/api/practice-intake', { body });

  const db = readDb();
  const group = (db.practiceGroups || []).find((g) => g.intake_token === token);
  const practices = group
    ? (db.atsPractices || []).filter((p) => p.group_id === group.id)
    : (db.atsPractices || []).filter((p) => p.intake_token === token);

  return {
    status: r.status,
    body: parse(r.raw),
    token,
    group,
    practices,
    dpa: practices[0] ? practices[0].dpa : undefined,
    dpa_mismatch: practices[0] ? practices[0].dpa_mismatch : undefined
  };
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

describe('POST /api/practice-intake — Task 7: derived columns + DPA mismatch + groups', () => {
  it('persists urgency, postcode, employment_type, gps_needed and supervision_available to columns', async () => {
    const saved = await submitIntake({
      urgency: '3_6m',
      employment_type: 'part_time',
      gps_needed: '2',
      supervision_available: true,
      postcode: '3065'
    });
    const row = saved.practices[0];
    expect(row.urgency).toBe('3_6m');
    expect(row.employment_type).toBe('part_time');
    expect(row.gps_needed).toBe('2');
    expect(row.supervision_available).toBe(true);
    expect(row.postcode).toBe('3065');
  });

  it('computes nearest_city and general_location server-side from lat/lon, never trusting the browser', async () => {
    // The browser claims Melbourne/Fitzroy, but the coordinates it also sent
    // are actually Bondi, Sydney -- the server must trust the coordinates,
    // not the free-text fields, because this lands on a live job ad.
    const saved = await submitIntake({
      nearest_city: 'Melbourne',
      suburb: 'Bondi',
      latitude: -33.8908,
      longitude: 151.2743,
      google_place_id: 'ChIJexampleplace'
    });
    const row = saved.practices[0];
    expect(row.latitude).toBeCloseTo(-33.8908, 3);
    expect(row.longitude).toBeCloseTo(151.2743, 3);
    expect(row.google_place_id).toBe('ChIJexampleplace');
    expect(row.suburb).toBe('Bondi');
    expect(row.nearest_city).toBe('Sydney');
    // general_location has no `practices` column (Task 3's migration never
    // added one) -- it lives in metadata.intake, from where it carries onto
    // the job listing at sign time (buildIntakeJobDetails).
    expect(row.metadata.intake.general_location).toContain('Sydney');
  });

  it('falls back to the client-submitted nearest_city when no coordinates are sent (legacy payload)', async () => {
    const saved = await submitIntake({ nearest_city: 'Melbourne', suburb: 'Fitzroy' });
    const row = saved.practices[0];
    expect(row.latitude == null).toBe(true);
    expect(row.longitude == null).toBe(true);
    expect(row.nearest_city).toBe('Melbourne');
  });

  it('flags a mismatch when the practice contradicts the official DPA answer', async () => {
    // The practice's answer always wins -- we flag it for a human, we never overrule them.
    const saved = await submitIntake({ dpa: true, dpa_suggested: false });
    expect(saved.dpa).toBe(true);
    expect(saved.dpa_mismatch).toBe(true);
  });

  it('does not flag a mismatch when they agree', async () => {
    const saved = await submitIntake({ dpa: true, dpa_suggested: true });
    expect(saved.dpa_mismatch).toBe(false);
  });

  it('does not flag a mismatch when we had no suggestion to compare against', async () => {
    const saved = await submitIntake({ dpa: true, dpa_suggested: null });
    expect(saved.dpa_mismatch).toBe(false);
  });

  it('creates one practice row per clinic in the group', async () => {
    const saved = await submitIntake({
      practices: [
        validClinicPayload({ suburb: 'Clinic A' }),
        validClinicPayload({ suburb: 'Clinic B' }),
        validClinicPayload({ suburb: 'Clinic C' })
      ]
    });
    expect(saved.practices).toHaveLength(3);
    expect(new Set(saved.practices.map((p) => p.group_id)).size).toBe(1); // one group
  });

  it('inherits the group entity and ABN when a clinic does not override', async () => {
    const saved = await submitIntake({
      entity_name: 'Head Co',
      abn: '51824753556',
      practices: [validClinicPayload({ suburb: 'Clinic A' })]
    });
    // Null on the practice means "inherit". Resolution happens on read, so a later
    // change to the group entity does not leave stale copies on each clinic.
    expect(saved.practices[0].entity_name).toBeNull();
    expect(saved.practices[0].abn).toBeNull();
    expect(saved.group.entity_name).toBe('Head Co');
    expect(saved.group.abn).toBe('51824753556');
  });

  it('records the override when a clinic trades under a different company', async () => {
    const saved = await submitIntake({
      entity_name: 'Head Co',
      abn: '51824753556',
      practices: [validClinicPayload({ suburb: 'Clinic B', entity_name: 'Branch Pty Ltd', abn: '004085616' })]
    });
    expect(saved.practices[0].entity_name).toBe('Branch Pty Ltd');
    expect(saved.practices[0].abn).toBe('004085616');
  });

  it('keeps a single-practice submission working exactly as before', async () => {
    const saved = await submitIntake({ practices: [validClinicPayload({ suburb: 'Solo Clinic' })] });
    expect(saved.practices).toHaveLength(1);
    expect(saved.practices[0].group_id).toBeTruthy(); // a group of one
  });

  it('still accepts a legacy single-practice payload with no practices array', async () => {
    // In-flight intake links predate this change and must not break.
    const saved = await submitIntake({ address: '99 Legacy Rd, Fitzroy VIC 3065', billing_style: 'mixed', dpa: true });
    expect(saved.practices).toHaveLength(1);
    expect(saved.practices[0].group_id).toBeTruthy();
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
      body: {
        token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Jane Smith', authorised: true,
        legal_entity_name: 'Test Medical Pty Ltd', abn_acn: '51824753556', signer_job_title: 'Practice Manager'
      }
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
      body: {
        token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Test', authorised: true,
        legal_entity_name: 'Test Medical Pty Ltd', abn_acn: '51824753556', signer_job_title: 'Practice Manager'
      }
    });
    expect(first.status).toBe(200);
    createdPdfPracticeIds.push(practiceId);

    const second = await req('POST', '/api/practice-intake/sign', {
      body: {
        token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Test', authorised: true,
        legal_entity_name: 'Test Medical Pty Ltd', abn_acn: '51824753556', signer_job_title: 'Practice Manager'
      }
    });
    expect(second.status).toBe(409);
    expect(parse(second.raw).error).toBe('already_signed');
  });
});
