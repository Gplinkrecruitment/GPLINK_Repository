// Task 1 (2026-07-20 full-app user-POV audit) — local/dev-mode regressions:
//
// Defect A: a `var now = Date.now()` inside handleApi (the /api/ceo/dashboard
//   handler) is FUNCTION-scoped, so it hoists and shadows the module-global
//   `now()` helper for the whole of handleApi. Before that line ever runs the
//   binding is `undefined`, so local-mode /api/auth/send-code,
//   /api/auth/verify-code and /api/auth/reset-password crash with
//   "TypeError: now is not a function" → 500.
//
// Defect B: the local-DB branches of POST /api/onboarding/save and
//   /api/onboarding/complete did `const dbState = loadDbState()` (a fresh
//   disk copy shadowing the module-global `dbState`) and mutated THAT — but
//   `saveDbState()` serializes the module-global, so the write vanished and
//   stale global state was re-persisted. GET /api/state (which reads the
//   module-global) then never saw the saved onboarding blob.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let port;

const AUTH_EMAIL = `local-auth-${RUN_ID}@example.com`;
const ONBOARDING_EMAIL = `local-onboarding-${RUN_ID}@example.com`;
const COMPLETE_EMAIL = `local-complete-${RUN_ID}@example.com`;

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Mint a signed gp_session cookie the same way the server does (same pattern
// as tests/alert-sync.test.js) so we can hit session-guarded routes directly.
function userCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function request(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'local-auth-dev-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-local-auth-dev-${RUN_ID}.json`;
  process.env.AUTH_RATE_MAX_ATTEMPTS = '500';
  process.env.AUTH_RATE_WINDOW_MS = '60000';

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('local-mode OTP auth (defect A: hoisted `var now` shadowed module-global now())', () => {
  it('POST /api/auth/send-code returns 200 (not a 500 TypeError) and logs an OTP', async () => {
    // Capture the dev-mode OTP console line so the verify step can use it.
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); origLog.apply(console, args); };
    let res;
    try {
      res = await request('POST', '/api/auth/send-code', {
        body: {
          firstName: 'Local',
          lastName: 'Tester',
          email: AUTH_EMAIL,
          countryDial: '+44',
          phoneNumber: '7911123456',
          registrationCountry: 'UK',
          codeMethod: 'email'
        }
      });
    } finally {
      console.log = origLog;
    }

    expect(res.status).toBe(200);
    expect(res.body && res.body.ok).toBe(true);
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);

    const otpLine = logged.find((l) => l.includes('[AUTH] OTP (email) for email:' + AUTH_EMAIL));
    expect(otpLine).toBeTruthy();
    const code = (otpLine.match(/:\s*(\d{8})\s*$/) || [])[1];
    expect(code).toMatch(/^\d{8}$/);
    // Stash for the verify test below.
    globalThis.__localAuthOtpCode = code;
  });

  it('POST /api/auth/verify-code accepts the logged code and issues a gp_session', async () => {
    const code = globalThis.__localAuthOtpCode;
    expect(code).toMatch(/^\d{8}$/);
    const res = await request('POST', '/api/auth/verify-code', {
      body: {
        email: AUTH_EMAIL,
        countryDial: '+44',
        phoneNumber: '7911123456',
        codeMethod: 'email',
        code
      }
    });
    expect(res.status).toBe(200);
    expect(res.body && res.body.ok).toBe(true);
    const setCookies = res.headers['set-cookie'] || [];
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    expect(list.some((c) => c.startsWith('gp_session='))).toBe(true);
  });
});

describe('local-mode onboarding persistence (defect B: loadDbState() shadow discarded writes)', () => {
  it('POST /api/onboarding/save then GET /api/state returns the saved blob', async () => {
    const cookie = userCookie(ONBOARDING_EMAIL);
    const save = await request('POST', '/api/onboarding/save', {
      cookie,
      body: { currentStep: 2, country: 'GB' }
    });
    expect(save.status).toBe(200);
    expect(save.body && save.body.ok).toBe(true);

    const state = await request('GET', '/api/state', { cookie });
    expect(state.status).toBe(200);
    let blob = state.body && state.body.state ? state.body.state.gp_onboarding : null;
    if (typeof blob === 'string') { try { blob = JSON.parse(blob); } catch {} }
    expect(blob).toBeTruthy();
    expect(blob.country).toBe('GB');
    expect(blob.currentStep).toBe(2);
  });

  it('POST /api/onboarding/complete persists gp_onboarding_complete', async () => {
    const cookie = userCookie(COMPLETE_EMAIL);
    const complete = await request('POST', '/api/onboarding/complete', {
      cookie,
      body: { currentStep: 5, country: 'GB', preferredCity: 'Melbourne' }
    });
    expect(complete.status).toBe(200);
    expect(complete.body && complete.body.ok).toBe(true);

    const state = await request('GET', '/api/state', { cookie });
    expect(state.status).toBe(200);
    const s = state.body && state.body.state ? state.body.state : {};
    expect(s.gp_onboarding_complete).toBeTruthy();
    let blob = s.gp_onboarding;
    if (typeof blob === 'string') { try { blob = JSON.parse(blob); } catch {} }
    expect(blob && blob.country).toBe('GB');
  });
});
