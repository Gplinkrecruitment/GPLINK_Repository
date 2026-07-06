// Phase 6 D1b — GET/POST /api/practice/respond (practice one-click response).
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-submit-practice.test.js. Outbound email (Resend) is captured by
// wrapping global fetch.
//
// Security model under test:
//  * a raw GET with a valid token renders a confirm page and does NOT change
//    state (email scanners auto-fetch GET links);
//  * POST accept records client_accepted + notifies ops — but must NOT reveal
//    identity (revealed stays falsy), NOT create an offer, NOT touch the
//    kanban stage;
//  * POST decline records client_rejected AND moves the kanban card to
//    not_proceeding (mirrors the existing sync);
//  * POST request_interview records client_interview_requested;
//  * idempotent: a second identical POST renders "already recorded" and does
//    not re-notify; invalid tokens get a friendly expired page; the POST is
//    rate-limited by IP (tested LAST — it exhausts the window).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-respond-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
let makeToken; // __testUtils.makePracticeActionToken (same process → same AUTH_SECRET)

const OPS_EMAIL = 'hub@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };
const NOW = new Date().toISOString();

const resendCalls = [];

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: {}, updated_at: NOW }
  ],
  registration_cases: [
    { id: 'case-1', user_id: GP.userId, status: 'active', stage: 'career', assigned_rso: 'rso-1', assigned_va: null }
  ],
  rso_team: [
    { user_id: 'rso-1', name: 'Rso One', email: 'rso1@gplink-test.local', phone: '', active: true, calendly_event_url: '' }
  ],
  task_timeline: [],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner — VR', masked_title: 'DPA - Fitzroy - Mixed Billing', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Melbourne', location_state: 'VIC', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    // accept target
    { id: 'app-a', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    // decline target
    { id: 'app-b', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    // request_interview target
    { id: 'app-c', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    // GET-must-not-mutate control
    { id: 'app-d', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW }
  ],
  ats_stage_events: [],
  ats_offers: [],
  scheduled_calls: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function httpReq(method, p, { body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8'), headers: res.headers }));
    });
    r.on('error', reject); r.end(data);
  });
}
// The real confirm page posts application/x-www-form-urlencoded.
const formPost = (token) => httpReq('POST', '/api/practice/respond', {
  body: 'token=' + encodeURIComponent(token),
  contentType: 'application/x-www-form-urlencoded'
});

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-respond-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.REGISTRATION_HUB_EMAIL = OPS_EMAIL;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const mod = await import('../server.js');
  makeToken = mod.__testUtils.makePracticeActionToken;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

const appRow = (id) => db.gp_applications.find((a) => a.id === id);

describe('GET /api/practice/respond (scanner-proof confirm page)', () => {
  it('renders a confirm page for a valid token and does NOT change any state', async () => {
    const token = makeToken({ applicationId: 'app-d', action: 'accept' });
    const before = JSON.stringify(appRow('app-d'));
    const beforeEmails = resendCalls.length;

    const r = await httpReq('GET', '/api/practice/respond?token=' + encodeURIComponent(token));
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/html');
    // Confirm interstitial: an explicit form that POSTs the token back.
    expect(r.raw).toContain('method="POST"');
    expect(r.raw).toContain('accept');
    expect(r.raw).toContain('Test'); // candidate first name (already known to the practice)
    expect(r.raw).toContain('DPA - Fitzroy - Mixed Billing'); // masked role label
    expect(r.raw).not.toContain('Doctor'); // no full-name dump beyond the first name
    expect(r.raw).toContain('mistake');

    // The critical invariant: a raw GET (scanner fetch) changed NOTHING.
    expect(JSON.stringify(appRow('app-d'))).toBe(before);
    expect(resendCalls.length).toBe(beforeEmails);
  });

  it('renders wording for each action', async () => {
    const rInt = await httpReq('GET', '/api/practice/respond?token='
      + encodeURIComponent(makeToken({ applicationId: 'app-d', action: 'request_interview' })));
    expect(rInt.status).toBe(200);
    expect(rInt.raw).toContain('request an interview with');
    const rDec = await httpReq('GET', '/api/practice/respond?token='
      + encodeURIComponent(makeToken({ applicationId: 'app-d', action: 'decline' })));
    expect(rDec.status).toBe(200);
    expect(rDec.raw).toContain('decline');
  });

  it('shows a friendly expired page for an invalid/tampered token', async () => {
    const token = makeToken({ applicationId: 'app-d', action: 'accept' });
    const r = await httpReq('GET', '/api/practice/respond?token=' + encodeURIComponent(token.slice(0, -2)));
    expect(r.status).toBe(410);
    expect(r.raw).toContain('expired');
    expect(r.raw).toContain('reply');
  });
});

describe('POST /api/practice/respond — accept', () => {
  it('records client_accepted, notifies ops + RSO, and does NOT reveal/offer/move the kanban', async () => {
    const beforeEmails = resendCalls.length;
    const token = makeToken({ applicationId: 'app-a', action: 'accept' });

    const r = await formPost(token);
    expect(r.status).toBe(200);
    expect(r.raw).toContain('Thanks');

    const app = appRow('app-a');
    expect(app.practice_submission_status).toBe('client_accepted');
    expect(app.practice_response_action).toBe('accept');
    expect(app.practice_responded_at).toBeTruthy();

    // The accept action must NOT do the formal accept:
    expect(app.revealed).not.toBe(true);          // identity NOT revealed
    expect(db.ats_offers.length).toBe(0);         // NO offer created
    expect(app.ats_stage).toBe('submitted');      // kanban untouched

    // One ops notification, to the hub + the assigned RSO, telling a human to act.
    const sends = resendCalls.slice(beforeEmails);
    expect(sends.length).toBe(1);
    const email = sends[0].body;
    expect(email.to).toContain(OPS_EMAIL);
    expect(email.to).toContain('rso1@gplink-test.local');
    expect(String(email.subject)).toContain('ACCEPTED');
    expect(String(email.subject)).toContain('reveal identity');
    expect(String(email.text)).toContain('Nothing has been revealed or offered automatically');

    // Case event logged for the audit trail.
    const ev = db.task_timeline.find((e) => e.case_id === 'case-1' && String(e.title || '').includes('accept'));
    expect(ev).toBeTruthy();
  });

  it('is idempotent: a second accept renders "already recorded" and does not re-notify', async () => {
    const beforeEmails = resendCalls.length;
    const token = makeToken({ applicationId: 'app-a', action: 'accept' });
    const r = await formPost(token);
    expect(r.status).toBe(200);
    expect(r.raw).toContain('Already recorded');
    expect(resendCalls.length).toBe(beforeEmails); // no double-notify
    expect(appRow('app-a').practice_submission_status).toBe('client_accepted');
  });
});

describe('POST /api/practice/respond — decline', () => {
  it('records client_rejected, moves the kanban card to not_proceeding, notifies ops', async () => {
    const beforeEmails = resendCalls.length;
    const token = makeToken({ applicationId: 'app-b', action: 'decline' });
    const r = await formPost(token);
    expect(r.status).toBe(200);

    const app = appRow('app-b');
    expect(app.practice_submission_status).toBe('client_rejected');
    expect(app.ats_stage).toBe('not_proceeding');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-b' && e.to_stage === 'not_proceeding');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('practice_respond');

    const sends = resendCalls.slice(beforeEmails);
    expect(sends.length).toBe(1);
    expect(String(sends[0].body.subject)).toContain('declined');
  });
});

describe('POST /api/practice/respond — request_interview', () => {
  it('records client_interview_requested and notifies ops to arrange a time', async () => {
    const beforeEmails = resendCalls.length;
    const token = makeToken({ applicationId: 'app-c', action: 'request_interview' });
    const r = await formPost(token);
    expect(r.status).toBe(200);

    const app = appRow('app-c');
    expect(app.practice_submission_status).toBe('client_interview_requested');
    expect(app.ats_stage).toBe('submitted'); // kanban untouched

    const sends = resendCalls.slice(beforeEmails);
    expect(sends.length).toBe(1);
    expect(String(sends[0].body.subject)).toContain('interview');
  });
});

describe('POST /api/practice/respond — invalid tokens', () => {
  it('shows the friendly expired page and changes nothing', async () => {
    const beforeEmails = resendCalls.length;
    const r = await formPost('garbage-token');
    expect(r.status).toBe(410);
    expect(r.raw).toContain('expired');
    expect(resendCalls.length).toBe(beforeEmails);
  });

  it('a token for a nonexistent application also gets the expired page', async () => {
    const token = makeToken({ applicationId: 'no-such-app', action: 'accept' });
    const r = await formPost(token);
    expect(r.status).toBe(410);
  });
});

// LAST on purpose — this exhausts the per-IP window for the whole test process.
describe('POST /api/practice/respond — rate limiting', () => {
  it('429s after too many POSTs from one IP', async () => {
    const token = makeToken({ applicationId: 'app-a', action: 'accept' });
    let got429 = false;
    for (let i = 0; i < 30 && !got429; i++) {
      const r = await formPost(token); // idempotent "already recorded" until limited
      if (r.status === 429) got429 = true;
      else expect(r.status).toBe(200);
    }
    expect(got429).toBe(true);
  });
});
