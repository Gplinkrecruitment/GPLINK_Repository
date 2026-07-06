// Phase 6 G2b — structured call-outcome logging.
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. PATCH /api/admin/calls/:id {action:'complete'} requires a disposition
//      from the fixed list AND a non-empty outcome note (400 otherwise).
//   2. Completing persists status=completed, call_disposition, outcome_note,
//      completed_at, and marks the linked registration task completed.
//   3. disposition needs_followup/escalate raises a follow-up task on the case
//      (chase, source_trigger=call_disposition; escalate → priority urgent);
//      resolved does NOT.
//   4. The Zoom-summary flow is intact: a never-requested summary flips to
//      'pending' (same as the auto-complete cron); an already-'saved' summary
//      is left alone. Logging an outcome on an already-completed call keeps
//      its original completed_at.
//   5. Invalid source status (invited) → 409. Auth-gated.
//   6. Static: admin.html ships the outcome modal + disposition rendering.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-call-dispo-${RUN_ID}.json`);
const SUPER_HOST = 'call-dispo-test.local';
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const CALL_FU = crypto.randomUUID();     // booked → needs_followup
const CALL_ESC = crypto.randomUUID();    // booked → escalate
const CALL_RES = crypto.randomUUID();    // booked → resolved (no follow-up task)
const CALL_BAD = crypto.randomUUID();    // booked → validation failures
const CALL_DONE = crypto.randomUUID();   // already completed by the cron, summary saved
const CALL_INV = crypto.randomUUID();    // invited → 409
const TASK_FU = crypto.randomUUID();     // linked registration task of CALL_FU
const DONE_COMPLETED_AT = iso(-1);

const db = {
  user_profiles: [
    { user_id: 'u-gp', email: 'callgp@gplink-test.local', first_name: 'Cara', last_name: 'Caller' }
  ],
  registration_cases: [
    { id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'active', assigned_va: null, created_at: iso(-30), updated_at: iso(-1) }
  ],
  registration_tasks: [
    { id: TASK_FU, case_id: 'c-call', status: 'waiting', task_type: 'zoom_call', title: 'Zoom call', priority: 'normal', created_at: iso(-2) }
  ],
  scheduled_calls: [
    { id: CALL_FU, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'booked', registration_task_id: TASK_FU, summary_status: null, scheduled_at: iso(0), created_at: iso(-2) },
    { id: CALL_ESC, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'booked', registration_task_id: null, summary_status: 'not_requested', scheduled_at: iso(0), created_at: iso(-2) },
    { id: CALL_RES, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'booked', registration_task_id: null, summary_status: null, scheduled_at: iso(0), created_at: iso(-2) },
    { id: CALL_BAD, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'booked', registration_task_id: null, summary_status: null, scheduled_at: iso(0), created_at: iso(-2) },
    { id: CALL_DONE, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'completed', registration_task_id: null, summary_status: 'saved', meeting_summary: 'Zoom said things.', completed_at: DONE_COMPLETED_AT, created_at: iso(-3) },
    { id: CALL_INV, case_id: 'c-call', user_id: 'u-gp', stage: 'amc', status: 'invited', registration_task_id: null, summary_status: null, created_at: iso(-1) }
  ],
  task_timeline: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
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
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
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
        const saved = incoming.map((r) => {
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
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const callRow = (id) => db.scheduled_calls.find((c) => c.id === id);
const followUps = () => db.registration_tasks.filter((t) => t.source_trigger === 'call_disposition');

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'call-dispo-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('PATCH /api/admin/calls/:id action=complete', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_FU, { body: { action: 'complete', disposition: 'resolved', outcome_note: 'x' } });
    expect([401, 403]).toContain(r.status);
  });

  it('rejects a missing/unknown disposition and a missing outcome note', async () => {
    const noDispo = await httpReq('PATCH', '/api/admin/calls/' + CALL_BAD, { cookie: adminCookie(), body: { action: 'complete', outcome_note: 'talked' } });
    expect(noDispo.status).toBe(400);

    const badDispo = await httpReq('PATCH', '/api/admin/calls/' + CALL_BAD, { cookie: adminCookie(), body: { action: 'complete', disposition: 'sorted-i-guess', outcome_note: 'talked' } });
    expect(badDispo.status).toBe(400);

    const noNote = await httpReq('PATCH', '/api/admin/calls/' + CALL_BAD, { cookie: adminCookie(), body: { action: 'complete', disposition: 'resolved', outcome_note: '   ' } });
    expect(noNote.status).toBe(400);

    // untouched by the failed attempts
    expect(callRow(CALL_BAD).status).toBe('booked');
    expect(callRow(CALL_BAD).call_disposition).toBeUndefined();
  });

  it('cannot complete a call that was never booked', async () => {
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_INV, { cookie: adminCookie(), body: { action: 'complete', disposition: 'resolved', outcome_note: 'x' } });
    expect(r.status).toBe(409);
  });

  it('persists disposition + outcome note, completes the linked task, and raises a follow-up on needs_followup', async () => {
    const before = followUps().length;
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_FU, {
      cookie: adminCookie(),
      body: { action: 'complete', disposition: 'needs_followup', outcome_note: 'GP still needs the AMC portfolio walkthrough.' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.call.call_disposition).toBe('needs_followup');

    const row = callRow(CALL_FU);
    expect(row.status).toBe('completed');
    expect(row.call_disposition).toBe('needs_followup');
    expect(row.outcome_note).toBe('GP still needs the AMC portfolio walkthrough.');
    expect(row.completed_at).toBeTruthy();
    // never-requested summary flips to pending — same as the auto-complete cron
    expect(row.summary_status).toBe('pending');

    // linked registration task completed via the existing status map
    const task = db.registration_tasks.find((t) => t.id === TASK_FU);
    expect(task.status).toBe('completed');

    // follow-up task raised on the case
    const created = followUps();
    expect(created.length).toBe(before + 1);
    const fu = created[created.length - 1];
    expect(fu.case_id).toBe('c-call');
    expect(fu.task_type).toBe('chase');
    expect(fu.priority).toBe('high');
    expect(fu.status).toBe('open');
    expect(fu.title).toContain('Cara Caller');
    expect(fu.description).toContain('needs_followup');
  });

  it('escalate raises an urgent follow-up task', async () => {
    const before = followUps().length;
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_ESC, {
      cookie: adminCookie(),
      body: { action: 'complete', disposition: 'escalate', outcome_note: 'Practice conflict — needs the CEO.' }
    });
    expect(r.status).toBe(200);
    const created = followUps();
    expect(created.length).toBe(before + 1);
    const fu = created[created.length - 1];
    expect(fu.priority).toBe('urgent');
    expect(fu.title).toContain('Escalated');
  });

  it('resolved does NOT raise a follow-up task', async () => {
    const before = followUps().length;
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_RES, {
      cookie: adminCookie(),
      body: { action: 'complete', disposition: 'resolved', outcome_note: 'All sorted on the call.' }
    });
    expect(r.status).toBe(200);
    expect(followUps().length).toBe(before);
    expect(callRow(CALL_RES).call_disposition).toBe('resolved');
  });

  it('logging an outcome on a cron-completed call keeps completed_at + the saved Zoom summary', async () => {
    const r = await httpReq('PATCH', '/api/admin/calls/' + CALL_DONE, {
      cookie: adminCookie(),
      body: { action: 'complete', disposition: 'no_answer', outcome_note: 'GP never joined the Zoom.' }
    });
    expect(r.status).toBe(200);
    const row = callRow(CALL_DONE);
    expect(row.status).toBe('completed');
    expect(row.call_disposition).toBe('no_answer');
    expect(row.completed_at).toBe(DONE_COMPLETED_AT); // original timestamp kept
    expect(row.summary_status).toBe('saved');          // Zoom-summary flow untouched
    expect(row.meeting_summary).toBe('Zoom said things.');
  });

  it('GET /api/admin/calls surfaces the logged disposition', async () => {
    const r = await httpReq('GET', '/api/admin/calls/' + CALL_FU, { cookie: adminCookie() });
    expect(r.status).toBe(200);
    expect(r.body.call.call_disposition).toBe('needs_followup');
    expect(r.body.call.outcome_note).toBeTruthy();
  });
});

describe('admin.html — call outcome UI (static)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('ships the outcome modal with the disposition list + required note', () => {
    expect(html).toContain('openCallOutcomeModal');
    expect(html).toContain('callOutcomeDisposition');
    expect(html).toContain('callOutcomeNote');
    for (const d of ['resolved', 'needs_followup', 'escalate', 'no_answer', 'rescheduled']) {
      expect(html.includes(d)).toBe(true);
    }
    expect(html).toContain("action: 'complete'");
  });

  it('surfaces the disposition on call cards', () => {
    expect(html).toContain('renderCallDispositionBlock');
    expect(html).toContain('call_disposition');
    expect(html).toContain('outcome_note');
  });
});
