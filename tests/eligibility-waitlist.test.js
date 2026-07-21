// Phase 6 G3 — eligibility off-ramp / waitlist for out-of-scope-country GPs.
//
// Onboarding only supports GB/IE/NZ. Any other GP could sign up but was then
// trapped forever on onboarding step 1 (index.html kept bouncing them back).
// POST /api/eligibility-waitlist captures {country, name?} into
// candidate_leads (source='eligibility_waitlist') and flags the GP's
// user_state so returning visits show the "we'll be in touch" state.
// The posted email field is IGNORED — the lead is always keyed to the
// signed-in session email so a GP can't waitlist an arbitrary address.
//
// Boots the REAL server in LOCAL-JSON mode (SUPABASE_URL='') so the stored
// lead can be asserted straight out of the DB file. Also pins the static
// off-ramp markers in pages/onboarding.html + js/onboarding.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-eligibility-${RUN_ID}.json`);
const GP_EMAIL = 'offramp-gp@gplink-test.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function req(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
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

const readDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const waitlistLeads = () => (readDb().candidateLeads || []).filter((l) => l && l.source === 'eligibility_waitlist');

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'eligibility-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/eligibility-waitlist', () => {
  it('is auth-gated (session required)', async () => {
    const r = await req('POST', '/api/eligibility-waitlist', { body: { email: 'x@y.com', country: 'India' } });
    expect([401, 403]).toContain(r.status);
    expect(waitlistLeads().length).toBe(0);
  });

  it('requires a country', async () => {
    const r = await req('POST', '/api/eligibility-waitlist', { cookie: userCookie(GP_EMAIL), body: { email: GP_EMAIL } });
    expect(r.status).toBe(400);
  });

  it('stores the lead with source=eligibility_waitlist + country, and flags user_state', async () => {
    const r = await req('POST', '/api/eligibility-waitlist', {
      cookie: userCookie(GP_EMAIL),
      body: { email: 'dr.patel@example.test', country: 'India', name: 'Dr Asha Patel' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.waitlisted).toBe(true);

    const leads = waitlistLeads();
    expect(leads.length).toBe(1);
    // Posted email is ignored — the lead is keyed to the SESSION email.
    expect(leads[0].email).toBe(GP_EMAIL);
    expect(leads[0].country).toBe('India');
    expect(leads[0].name).toBe('Dr Asha Patel');
    expect(leads[0].unsubscribed).toBe(false);

    // Waitlisted state persisted on the GP's account (survives returning
    // visits — onboarding shows "we'll be in touch", not the trap).
    const st = readDb().userState[GP_EMAIL] || {};
    expect(String(st.gp_eligibility_waitlist || '')).toContain('India');
  });

  it('is idempotent per session email — a second post updates, never duplicates', async () => {
    const r = await req('POST', '/api/eligibility-waitlist', {
      cookie: userCookie(GP_EMAIL),
      body: { email: 'dr.patel@example.test', country: 'Pakistan' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);
    const leads = waitlistLeads();
    expect(leads.length).toBe(1);
    expect(leads[0].country).toBe('Pakistan'); // refreshed, not duplicated
  });

  it('always uses the session email — even a valid posted email is ignored', async () => {
    const r = await req('POST', '/api/eligibility-waitlist', {
      cookie: userCookie('fallback-gp@gplink-test.local'),
      body: { email: 'someone-else@example.test', country: 'Nigeria' }
    });
    expect(r.status).toBe(200);
    const lead = waitlistLeads().find((l) => l.email === 'fallback-gp@gplink-test.local');
    expect(lead).toBeTruthy();
    expect(lead.country).toBe('Nigeria');
    // No lead was created for the address typed into the form.
    expect(waitlistLeads().find((l) => l.email === 'someone-else@example.test')).toBeFalsy();
  });

  it('rate-limits repeated posts from the same session', async () => {
    const cookie = userCookie('hammer-gp@gplink-test.local');
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await req('POST', '/api/eligibility-waitlist', { cookie, body: { country: 'Canada ' + i } });
      statuses.push(r.status);
    }
    expect(statuses[0]).toBe(200);
    expect(statuses).toContain(429);
    // Still only one lead for that email despite the hammering.
    expect(waitlistLeads().filter((l) => l.email === 'hammer-gp@gplink-test.local').length).toBe(1);
  });
});

describe('onboarding off-ramp static markers', () => {
  const onboardingHtml = fs.readFileSync(path.join(ROOT, 'pages', 'onboarding.html'), 'utf8');
  const onboardingJs = fs.readFileSync(path.join(ROOT, 'js', 'onboarding.js'), 'utf8');

  it('onboarding.html carries the "Not yet eligible" screen + notify capture', () => {
    expect(onboardingHtml).toContain('Not yet eligible');
    expect(onboardingHtml).toContain('id="notEligibleScreen"');
    expect(onboardingHtml).toContain('id="waitlistCountry"');
    expect(onboardingHtml).toContain('id="waitlistEmail"');
    expect(onboardingHtml).toContain('id="waitlistName"');
    expect(onboardingHtml).toContain("we'll be in touch");
    // Cache buster bumped on the changed script.
    expect(onboardingHtml).not.toContain('onboarding.js?v=20260705b');
  });

  it('onboarding.js wires the off-ramp: "Somewhere else" entry + waitlist POST + returning state', () => {
    expect(onboardingJs).toContain('countryNotListed');
    expect(onboardingJs).toContain('/api/eligibility-waitlist');
    expect(onboardingJs).toContain('gp_eligibility_waitlist');
    // "Somewhere else" opens the search-all-countries mode; picking a concrete
    // unsupported country from it routes to the eligibility off-ramp.
    expect(onboardingJs).toContain('Somewhere else');
    expect(onboardingJs).toContain('Start typing to search all countries');
  });

  it('never says bare "RSO"', () => {
    expect(/\bRSO\b/.test(onboardingHtml)).toBe(false);
    expect(/\bRSO\b/.test(onboardingJs)).toBe(false);
  });

  it('supported-country flow untouched: GB/IE/NZ country list intact', () => {
    expect(onboardingJs).toContain('"United Kingdom"');
    expect(onboardingJs).toContain('"Ireland"');
    expect(onboardingJs).toContain('"New Zealand"');
  });
});
