// Task 7 — public (token-authenticated, no session) practice decision +
// availability endpoints. A practice contact reaches these from the
// submit-to-practice introduction email's decision buttons (Task 6) /
// pages/practice-decision.html (Task 8) — no account, no cookie.
//
// Boots the real server against a tiny in-memory PostgREST emulator
// (career-profile-gate.test.js / practice-submission-email.test.js pattern)
// so every code path under test is the SAME isSupabaseDbConfigured()===true
// branch production runs, plus a Resend capture server so best-effort
// notification emails can be asserted directly instead of hitting the network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, port, sbServer, sbPort, resendServer, resendPort;

const NOW = new Date().toISOString();

// Availability windows must always fall inside validatePracticeAvailabilityWindows'
// today..+60-day horizon (server.js). A fixed calendar date drifts into the past
// as real time passes and the endpoint starts 400ing — compute relative to
// Date.now() instead so these fixtures never go stale.
function ymdOffset(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const AVAIL_DATE_1 = ymdOffset(1);
const AVAIL_DATE_2 = ymdOffset(2);

const db = {
  user_profiles: [
    { user_id: 'u-gate-1', email: 'gate.smith@example.com', first_name: 'Gate', last_name: 'Smith', registration_country: 'uk', phone: '+447700900123' },
    { user_id: 'u-ryan-2', email: 'declan.ryan@example.com', first_name: 'Declan', last_name: 'Ryan', registration_country: 'ie' },
    { user_id: 'u-notyet-3', email: 'notyet@example.com', first_name: 'Notyet', last_name: 'Approved', registration_country: 'uk' },
    { user_id: 'u-resil-4', email: 'resil@example.com', first_name: 'Resil', last_name: 'Ience', registration_country: 'uk' },
    { user_id: 'u-inject-6', email: 'inject@example.com', first_name: 'Inject', last_name: 'Test', registration_country: 'uk' },
    { user_id: 'u-e2e-7', email: 'e2e.booker@example.com', first_name: 'Endto', last_name: 'End', registration_country: 'uk' },
    { user_id: 'u-secured-8', email: 'secured.eight@example.com', first_name: 'Secured', last_name: 'Eight', registration_country: 'uk' },
    { user_id: 'u-forward-9', email: 'forward.nine@example.com', first_name: 'Forward', last_name: 'Nine', registration_country: 'uk' }
  ],
  user_state: [],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'r1', title: 'General Practitioner (VR)', practice_name: 'SOP Medical Centre', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-tok-1', user_id: 'u-gate-1', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-abc123', applied_at: NOW },
    { id: 'app-tok-2', user_id: 'u-ryan-2', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-def456', applied_at: NOW },
    { id: 'app-tok-3', user_id: 'u-notyet-3', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-ghi789', applied_at: NOW },
    { id: 'app-tok-4', user_id: 'u-resil-4', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-resil999', applied_at: NOW },
    { id: 'app-tok-6', user_id: 'u-inject-6', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-inject-6', applied_at: NOW },
    { id: 'app-tok-7', user_id: 'u-e2e-7', career_role_id: 'role-1', status: 'applied', practice_action_token: 'tok-test-e2e-7', applied_at: NOW },
    // Already secured via a different path (e.g. the GP accepted their offer
    // through /api/career/offer/accept) BEFORE this stale approve link is
    // ever clicked — regression fixture for the backward-drag bug.
    { id: 'app-tok-8', user_id: 'u-secured-8', career_role_id: 'role-1', status: 'placement_secured', ats_stage: 'hired', practice_action_token: 'tok-test-secured8', applied_at: NOW },
    // Already advanced to the 'offer' lane (offer sent, not yet decided)
    // through a different path (e.g. an admin/CEO action) BEFORE this stale
    // approve link is ever clicked — regression fixture for the forward-only
    // stage guard.
    { id: 'app-tok-9', user_id: 'u-forward-9', career_role_id: 'role-1', status: 'applied', ats_stage: 'offer', practice_action_token: 'tok-test-forward9', applied_at: NOW }
  ],
  registration_cases: [],
  practices: [],
  scheduled_calls: [],
  ats_offers: [
    { id: 'off-8', application_id: 'app-tok-8', status: 'accepted', created_at: NOW },
    { id: 'off-9', application_id: 'app-tok-9', status: 'sent', created_at: NOW }
  ],
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
      const rows = tableOf(decodeURIComponent(m[1]));
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
        const conflictCols = (u.searchParams.get('on_conflict') || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflictCols.length) {
            const existing = rows.find((row) => row && conflictCols.every((c) => String(row[c]) === String(r[c])));
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

const resendCaptured = [];
let resendMode = 'ok'; // 'ok' | 'error' — toggled by the email-resilience test below
function startResendCaptureServer() {
  return new Promise((resolve) => {
    resendServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        if (resendMode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated Resend outage' }));
          return;
        }
        resendCaptured.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'email-' + resendCaptured.length }));
      });
    });
    resendServer.listen(0, '127.0.0.1', () => { resendPort = resendServer.address().port; resolve(); });
  });
}

// GP session cookie — built exactly the way tests/career-profile-gate.test.js
// builds userCookie (b64url(JSON payload) + HMAC-SHA512 over AUTH_SECRET).
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, userId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId: userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
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

beforeAll(async () => {
  await startSupabaseEmulator();
  await startResendCaptureServer();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-decision-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.RESEND_API_URL = `http://127.0.0.1:${resendPort}/emails`;
  process.env.RESEND_API_KEY = 'test-resend';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.DOUBLETICK_API_KEY = '';
  process.env.SUPER_ADMIN_EMAILS = '';
  process.env.ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  if (resendServer) await new Promise((r) => resendServer.close(r));
});

describe('GET /api/practice/application/decision-context', () => {
  it('returns candidate summary and never mutates', async () => {
    const res = await httpReq('GET', '/api/practice/application/decision-context?token=tok-test-abc123');
    expect(res.status).toBe(200);
    expect(res.body.gpName).toMatch(/Gate|Smith/);
    expect(res.body.roleTitle).toBe('General Practitioner (VR)');
    expect(res.body.practiceName).toBe('SOP Medical Centre');
    expect(res.body.decision).toBeNull();
    expect(res.body.availabilitySubmitted).toBe(false);
    expect(res.body.interviewBooked).toBe(false);
    const row = db.gp_applications.find((a) => a.id === 'app-tok-1');
    expect(row.practice_decision).toBeUndefined();
    expect(db.scheduled_calls.length).toBe(0);
  });

  it('404s on a bad token', async () => {
    const res = await httpReq('GET', '/api/practice/application/decision-context?token=nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, code: 'not_found' });
  });

  it('404s uniformly on a well-formed but unknown token (same shape as a short one)', async () => {
    const res = await httpReq('GET', '/api/practice/application/decision-context?token=tok-does-not-exist-at-all');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('POST /api/practice/application/decision — approve', () => {
  it('404s on a bad token', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'nope', action: 'approve' } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, code: 'not_found' });
  });

  it('marks the application and creates the interview row (status stays requested, not defaulted)', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-abc123', action: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'approved' });

    const row = db.gp_applications.find((a) => a.id === 'app-tok-1');
    expect(row.practice_decision).toBe('approved');
    expect(row.status).toBe('interview');
    expect(row.ats_stage).toBe('interview');
    expect(typeof row.practice_decision_at).toBe('string');

    const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview' && String(r.application_id) === String(row.id));
    expect(interview).toBeTruthy();
    expect(interview.practice_availability_status).toBe('requested');
    expect(typeof interview.correlation_token).toBe('string');
    expect(interview.correlation_token.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second approve on the same token does not duplicate the interview row or re-decide', async () => {
    const before = db.scheduled_calls.filter((r) => r.meeting_kind === 'interview').length;
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-abc123', action: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'approved', already: true });
    expect(db.scheduled_calls.filter((r) => r.meeting_kind === 'interview').length).toBe(before);
  });

  it('sent a GP "approved" email and an ops notify email (best-effort notifications actually fired)', async () => {
    const gpEmail = resendCaptured.find((m) => m && m.to && [].concat(m.to).includes('gate.smith@example.com'));
    expect(gpEmail).toBeTruthy();
    expect(gpEmail.subject).toContain('interview');
    const opsEmail = resendCaptured.find((m) => m && m.to && [].concat(m.to).some((t) => String(t).includes('hello@mygplink.com.au')));
    expect(opsEmail).toBeTruthy();
    expect(opsEmail.subject).toContain('Practice approved');
  });
});

// Final-review fix: a stale approve link (still sitting unread in a
// practice's inbox) must never drag an already-progressed application
// backward — whether it fully reached placement_secured/hired through a
// DIFFERENT path (the GP accepted their offer, or the team manually secured
// the placement) or merely advanced past 'interview' (offer sent, not yet
// decided).
describe('POST /api/practice/application/decision — approve on a stale link (application already progressed)', () => {
  it('no-ops when the application already reached placement_secured/hired via a different path', async () => {
    const interviewsBefore = db.scheduled_calls.filter((r) => r.meeting_kind === 'interview').length;
    const capturedBefore = resendCaptured.length;

    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-secured8', action: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'approved', already: true });

    const row = db.gp_applications.find((a) => a.id === 'app-tok-8');
    expect(row.status).toBe('placement_secured');
    expect(row.ats_stage).toBe('hired');
    expect(db.scheduled_calls.filter((r) => r.meeting_kind === 'interview').length).toBe(interviewsBefore);
    // No emails at all fired off the back of this stale click — in particular
    // never the "would like to interview you!" copy to an already-placed GP.
    expect(resendCaptured.length).toBe(capturedBefore);
  });

  it('does not drag ats_stage backward when the card already advanced to the offer lane', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-forward9', action: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'approved' });

    const row = db.gp_applications.find((a) => a.id === 'app-tok-9');
    expect(row.practice_decision).toBe('approved');
    // The offer lane outranks 'interview' — the forward-only guard must keep it.
    expect(row.ats_stage).toBe('offer');
  });
});

describe('POST /api/practice/application/decision — turn_down', () => {
  it('records decision + reason on a second application without touching status/ats_stage', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-def456', action: 'turn_down', reason: 'Position filled' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'turned_down' });

    const row = db.gp_applications.find((a) => a.practice_action_token === 'tok-test-def456');
    expect(row.practice_decision).toBe('turned_down');
    expect(row.practice_decision_reason).toBe('Position filled');
    // No 'rejected'/'not_proceeding' stage exists in ATS_STAGES — status and
    // ats_stage must be left exactly as they were (still 'applied').
    expect(row.status).toBe('applied');
    expect(row.ats_stage).toBeUndefined();

    // No interview row should ever be created for a turn-down.
    const interview = db.scheduled_calls.find((r) => String(r.application_id) === String(row.id));
    expect(interview).toBeUndefined();
  });

  it('rejects an unknown action', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-def456', action: 'maybe' } });
    expect(res.status).toBe(400);
  });
});

describe('email transport resilience — a Resend outage must never fail the request', () => {
  it('approve still returns 200 + the application is still patched when the GP/ops emails fail to send', async () => {
    // sendEmail is fired-and-forgotten (never awaited by the handler), so the
    // HTTP response can land before the notify fetches even reach the capture
    // server. Don't flip resendMode back until we've positively observed the
    // in-flight sends fail — otherwise this test would race and could pass
    // for the wrong reason (mode reset before the delayed send actually fires).
    const capturedBefore = resendCaptured.length;
    resendMode = 'error';
    const res = await httpReq('POST', '/api/practice/application/decision', { body: { token: 'tok-test-resil999', action: 'approve' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'approved' });
    const row = db.gp_applications.find((a) => a.id === 'app-tok-4');
    expect(row.practice_decision).toBe('approved');
    expect(row.status).toBe('interview');
    const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview' && String(r.application_id) === 'app-tok-4');
    expect(interview).toBeTruthy();

    // Give the fire-and-forget sendEmail() fetches time to actually reach the
    // (currently 500-ing) capture server, then verify neither notification
    // for THIS approve was captured — i.e. they genuinely failed, and that
    // failure never touched the response above.
    await new Promise((r) => setTimeout(r, 150));
    expect(resendCaptured.length).toBe(capturedBefore);
    resendMode = 'ok';
  });
});

// Availability windows must be in the FUTURE — the endpoint rejects past
// dates. These were hardcoded as '2026-07-20'/'2026-07-21' and started
// failing the moment that date passed. Derive them instead so the suite
// cannot expire again.
const DAY_MS = 24 * 60 * 60 * 1000;
const futureDate = (daysAhead) => new Date(Date.now() + daysAhead * DAY_MS).toISOString().slice(0, 10);
const SOON = futureDate(7);
const SOON_PLUS_1 = futureDate(8);

describe('POST /api/practice/application/availability', () => {
  it('409s when the application has not been approved yet', async () => {
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-ghi789', windows: [{ date: SOON, fromMin: 540, toMin: 1020 }] }
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, code: 'not_approved' });
  });

  it('404s on a bad token', async () => {
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'nope', windows: [{ date: SOON, fromMin: 540, toMin: 1020 }] }
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, code: 'not_found' });
  });

  it('rejects malformed windows: bad date format', async () => {
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-abc123', windows: [{ date: 'not-a-date', fromMin: 900, toMin: 540 }] }
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects fromMin === toMin (zero-length window)', async () => {
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-abc123', windows: [{ date: SOON, fromMin: 600, toMin: 600 }] }
    });
    expect(res.status).toBe(400);
  });

  it('rejects a date more than 60 days out', async () => {
    const farDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-abc123', windows: [{ date: farDate, fromMin: 540, toMin: 600 }] }
    });
    expect(res.status).toBe(400);
  });

  it('rejects more than 10 windows', async () => {
    const windows = Array.from({ length: 11 }, (_, i) => ({ date: SOON, fromMin: i * 10, toMin: i * 10 + 5 }));
    const res = await httpReq('POST', '/api/practice/application/availability', { body: { token: 'tok-test-abc123', windows } });
    expect(res.status).toBe(400);
  });

  it('stores windows and flips status to received', async () => {
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-abc123', windows: [{ date: SOON, fromMin: 540, toMin: 1020 }, { date: SOON_PLUS_1, fromMin: 600, toMin: 900 }] }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, windowsSaved: 2 });

    const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview' && r.application_id === 'app-tok-1');
    expect(interview.practice_availability_status).toBe('received');
    expect(interview.practice_availability_windows).toHaveLength(2);
    expect(typeof interview.practice_availability_received_at).toBe('string');
  });

  it('decision-context now reflects availabilitySubmitted:true', async () => {
    const res = await httpReq('GET', '/api/practice/application/decision-context?token=tok-test-abc123');
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('approved');
    expect(res.body.availabilitySubmitted).toBe(true);
    expect(res.body.interviewBooked).toBe(false);
  });
});

describe('notification-email HTML injection is escaped (public turn-down reason)', () => {
  it('escapes a malicious reason so it can never inject markup into the ops email', async () => {
    const res = await httpReq('POST', '/api/practice/application/decision', {
      body: { token: 'tok-test-inject-6', action: 'turn_down', reason: '<img src=x onerror=alert(1)>' }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'turned_down' });

    // The ops email is fire-and-forget — give the send time to land in capture.
    await new Promise((r) => setTimeout(r, 250));
    const opsEmail = resendCaptured.find((m) => m && m.subject
      && String(m.subject).includes('turned down') && String(m.subject).includes('Inject'));
    expect(opsEmail).toBeTruthy();
    // The raw <img> payload must never appear verbatim; only the escaped form.
    expect(String(opsEmail.html)).not.toContain('<img');
    expect(String(opsEmail.html)).toContain('&lt;img');
  });
});

describe('availability stores ONLY the canonical window shape (extra keys stripped)', () => {
  it('drops any extra keys that rode in on the public request body', async () => {
    // app-tok-4 was approved by the email-resilience test above, so availability is allowed.
    const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-resil999', windows: [{ date: soon, fromMin: 540, toMin: 600, evil: '<script>', sneaky: 1 }] }
    });
    expect(res.status).toBe(200);
    const interview = db.scheduled_calls.find((r) => r.meeting_kind === 'interview' && r.application_id === 'app-tok-4');
    expect(interview.practice_availability_windows).toHaveLength(1);
    expect(interview.practice_availability_windows[0]).toEqual({ date: soon, fromMin: 540, toMin: 600 });
    expect(interview.practice_availability_windows[0]).not.toHaveProperty('evil');
    expect(interview.practice_availability_windows[0]).not.toHaveProperty('sneaky');
  });
});

describe('CRITICAL — GP can book after practice approval (full end-to-end)', () => {
  it('approve → availability → GP session sees revealed offer + interview slots (no dead-end)', async () => {
    // 1) Practice approves. Previously this ONLY set practice_decision/status and
    //    NEVER revealed the practice or created an offer, so the GP booking
    //    endpoints (gated on canRevealPracticeIdentity) 403'd forever.
    const approve = await httpReq('POST', '/api/practice/application/decision', {
      body: { token: 'tok-test-e2e-7', action: 'approve' } });
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({ ok: true, decision: 'approved' });
    // The reveal + in-app offer must now exist.
    const app7 = db.gp_applications.find((a) => a.id === 'app-tok-7');
    expect(app7.revealed).toBe(true);
    expect(app7.practice_submission_status).toBe('client_approved');
    expect(db.ats_offers.some((o) => o.application_id === 'app-tok-7' && o.status === 'sent')).toBe(true);

    // 2) Practice submits availability (full-day windows on near-future days so
    //    the 14-day / 48h-lead scheduler reliably yields bookable slots).
    const days = [3, 4, 5, 6, 7, 8, 9].map((n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    const avail = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-test-e2e-7', windows: days.map((date) => ({ date, fromMin: 0, toMin: 1440 })) }
    });
    expect(avail.status).toBe(200);

    // 3) GP (session-authed) can now fetch interview slots derived from those
    //    windows — a 200 here (was 403 before the fix) is the headline result.
    const gpCookie = userCookie('e2e.booker@example.com', 'u-e2e-7');
    const slots = await httpReq('GET', '/api/career/interview/slots?applicationId=app-tok-7', { cookie: gpCookie });
    expect(slots.status).toBe(200);
    expect(Array.isArray(slots.body.slots)).toBe(true);
    expect(slots.body.slots.length).toBeGreaterThan(0);

    // 4) The GP's offer page unmasks the practice identity + shows the offer.
    const offer = await httpReq('GET', '/api/career/my-offer?applicationId=app-tok-7', { cookie: gpCookie });
    expect(offer.status).toBe(200);
    expect(offer.body.ok).toBe(true);
    expect(offer.body.revealed).toBe(true);
    expect(offer.body.practiceName).toBe('SOP Medical Centre');
    expect(offer.body.offer).toBeTruthy();
  });
});

describe('rate limiting (shared practice-decision-ip budget across all three endpoints)', () => {
  it('429s once the shared per-IP budget (30/hour) is exhausted', async () => {
    let sawRateLimited = false;
    for (let i = 0; i < 40; i++) {
      const res = await httpReq('GET', '/api/practice/application/decision-context?token=nope');
      if (res.status === 429) { sawRateLimited = true; break; }
    }
    expect(sawRateLimited).toBe(true);
  });
});
