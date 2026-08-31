// A doctor's registration stage is DERIVED from user_state on every PUT /api/state
// (_deriveStageFromState), and the derived stage is written straight onto the case.
// Two ways that let a client silently roll a doctor BACKWARDS:
//
// 1. Staff "View as GP" ran the GP pages inside the ADMIN's browser. That browser's
//    localStorage knows nothing about the doctor, so the pages synced their own
//    defaults back over her real progress. Dr Sana Ahsan went ahpra -> myintealth
//    on 2026-08-31, four seconds after a blank gp_epic_progress was written, one
//    minute after staff clicked "View as GP".
//
// 2. Even for the doctor's own device, the stale-client guard only compares
//    `updatedAt` — and a freshly-stamped BLANK progress object always wins that
//    comparison. Her case history shows the resulting flapping: myintealth<->amc
//    (2026-07-31), ahpra<->career (2026-08-14), ahpra->myintealth (2026-08-31).
//
// Previewing must never write, and no client sync may reduce the derived stage.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, port;
const GP = `stage-guard-${RUN_ID}@example.com`;

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function cookieFor(profile) {
  const payload = b64url(JSON.stringify({ userProfile: profile, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
const gpCookie = () => cookieFor({ email: GP });
// What /api/admin/impersonate mints: the GP profile stamped with _impersonatedBy.
const previewCookie = () => cookieFor({ email: GP, _impersonatedBy: 'rso@mygplink.com.au' });

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
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// A doctor who has finished MyIntealth + AMC and secured a practice => stage 'ahpra'.
const ADVANCED = {
  gp_epic_progress: {
    stage: 'verification_issued',
    completed: { create_account: true, upload_qualifications: true, waiting_verification: true, account_establishment: true, verification_issued: true },
    updatedAt: '2026-08-14T00:00:00.000Z'
  },
  gp_amc_progress: {
    stage: 'qualifications_verified',
    completed: { create_portfolio: true, upload_credentials: true, qualifications_verified: true },
    updatedAt: '2026-08-14T00:00:00.000Z'
  },
  gp_career_state: { career_secured: true, updatedAt: '2026-08-14T00:00:00.000Z' },
  gp_ahpra_progress: { stage: 'create_account', completed: { create_account: false }, updatedAt: '2026-08-14T00:00:00.000Z' }
};
// Exactly what an admin's browser (or any device with no history) sends: defaults,
// stamped NOW so it beats any timestamp comparison.
const blankEpic = () => ({
  gp_epic_progress: {
    stage: 'create_account',
    completed: { create_account: false, upload_qualifications: false, waiting_verification: false, account_establishment: false, verification_issued: false },
    updatedAt: new Date().toISOString()
  }
});

const readState = async () => (await request('GET', '/api/state', { cookie: gpCookie() })).body;
function epicVerified(state) {
  let v = state && state.state && state.state.gp_epic_progress;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return !!(v && v.completed && v.completed.verification_issued === true);
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'stage-guard-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-stage-guard-${RUN_ID}.json`;
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  const seed = await request('PUT', '/api/state', { cookie: gpCookie(), body: { state: ADVANCED } });
  expect(seed.status).toBe(200);
});

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('PUT /api/state — staff preview must not mutate the doctor', () => {
  it('seeds a doctor who has completed MyIntealth', async () => {
    expect(epicVerified(await readState())).toBe(true);
  });

  it('accepts the preview write but stores nothing', async () => {
    const res = await request('PUT', '/api/state', { cookie: previewCookie(), body: { state: blankEpic() } });
    // The preview still gets a normal-looking 200 so the GP pages render.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.impersonated).toBe(true);
    // …and the doctor's real progress is untouched.
    expect(epicVerified(await readState())).toBe(true);
  });
});

describe('PUT /api/state — a client sync may never reduce the derived stage', () => {
  it('ignores freshly-stamped blank progress from the doctor’s own session', async () => {
    const res = await request('PUT', '/api/state', { cookie: gpCookie(), body: { state: blankEpic() } });
    expect(res.status).toBe(200);
    // Before the guard this wrote through — the blank object's updatedAt is newer
    // than anything stored, which is precisely what the old check rewarded.
    expect(epicVerified(await readState())).toBe(true);
  });

  it('still lets the doctor move FORWARD', async () => {
    const res = await request('PUT', '/api/state', {
      cookie: gpCookie(),
      body: {
        state: {
          gp_ahpra_progress: {
            stage: 'verification_issued',
            completed: { create_account: true, account_establishment: true, awaiting_outcome: true, verification_issued: true },
            updatedAt: new Date().toISOString()
          }
        }
      }
    });
    expect(res.status).toBe(200);
    const st = await readState();
    let ahpra = st.state.gp_ahpra_progress;
    if (typeof ahpra === 'string') ahpra = JSON.parse(ahpra);
    expect(ahpra.completed.verification_issued).toBe(true);
    // Advancing must not disturb the earlier stages either.
    expect(epicVerified(st)).toBe(true);
  });
});
