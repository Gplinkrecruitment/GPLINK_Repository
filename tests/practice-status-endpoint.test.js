// Phase 6 D1b, GET /api/practice/status (read-only, intake-token-authed).
//
// Boots the real server against the in-memory PostgREST emulator. The
// endpoint backs the D2 practice status page: practice display fields plus,
// per job, the masked role label, live/pending status, a candidate-submitted
// COUNT (never identities) and booked interview times. Candidate PII must
// never appear in the payload; an invalid/unknown token is a plain 404.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-status-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const INTAKE_TOKEN = 'intake-token-status-' + RUN_ID + '-0123456789abcdef';
const OTHER_TOKEN = 'intake-token-other-' + RUN_ID + '-0123456789abcdef';
const INTERVIEW_AT = '2026-07-20T04:30:00.000Z';
const NOW = new Date().toISOString();

// Seeded PII strings that must NEVER surface in the status payload.
const SECRET_NAME_FIRST = 'Verysecret';
const SECRET_NAME_LAST = 'Candidateson';
const SECRET_EMAIL = 'verysecret.candidateson@gplink-test.local';

const db = {
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', stage: 'active', agreement_status: 'signed', intake_token: INTAKE_TOKEN, is_active: true, created_at: NOW },
    // A second practice whose jobs must never leak through the first token.
    { id: 'p2', name: 'Riverside Medical', source: 'internal_ats', contact_name: 'Bob Manager', contact_email: 'bob@riverside-test.local', stage: 'active', agreement_status: 'signed', intake_token: OTHER_TOKEN, is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner, VR', masked_title: 'DPA - Fitzroy - Mixed Billing', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Melbourne', location_state: 'VIC', is_active: true, job_status: 'open', approval_status: 'approved', updated_at: NOW },
    { id: 'role-2', provider: 'internal_ats', provider_role_id: 'ats_r2', title: 'GP, After Hours', masked_title: 'Non-DPA - Cairns - Private Billing', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Cairns', location_state: 'QLD', is_active: false, job_status: 'open', approval_status: 'pending', updated_at: NOW },
    // Audit fix (practice journey, item 7): acceptance flips job_status to
    // 'filled' WITHOUT touching is_active, the status API must report
    // 'filled' (not a forever-"Live") for this row.
    { id: 'role-3', provider: 'internal_ats', provider_role_id: 'ats_r3', title: 'GP, Chronic Care', masked_title: 'DPA - Greenslopes - Mixed Billing', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'filled', approval_status: 'approved', updated_at: NOW },
    { id: 'role-x', provider: 'internal_ats', provider_role_id: 'ats_rx', title: 'Riverside GP', masked_title: 'DPA - Riverside - Mixed Billing', practice_name: 'Riverside Medical', practice_id: 'p2', location_city: 'Cairns', location_state: 'QLD', is_active: true, job_status: 'open', approval_status: 'approved', updated_at: NOW }
  ],
  user_profiles: [
    { user_id: 'u-1', email: SECRET_EMAIL, first_name: SECRET_NAME_FIRST, last_name: SECRET_NAME_LAST, registration_country: 'uk' },
    { user_id: 'u-2', email: 'second@gplink-test.local', first_name: 'Second', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: 'u-3', email: 'third@gplink-test.local', first_name: 'Third', last_name: 'Doctor', registration_country: 'nz' }
  ],
  gp_applications: [
    // role-1: two submitted candidates (one accepted), one NOT yet submitted.
    { id: 'app-1', user_id: 'u-1', career_role_id: 'role-1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    { id: 'app-2', user_id: 'u-2', career_role_id: 'role-1', status: 'review', ats_stage: 'interview', practice_submission_status: 'client_accepted', applied_at: NOW },
    { id: 'app-3', user_id: 'u-3', career_role_id: 'role-1', status: 'applied', ats_stage: 'applied', practice_submission_status: 'pending_va_submission', applied_at: NOW },
    // role-x (other practice): must not appear under p1's token.
    { id: 'app-x', user_id: 'u-2', career_role_id: 'role-x', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW }
  ],
  scheduled_calls: [
    { id: 'call-1', application_id: 'app-2', meeting_kind: 'interview', status: 'booked', scheduled_at: INTERVIEW_AT, created_at: NOW },
    // Cancelled interview must not surface.
    { id: 'call-2', application_id: 'app-1', meeting_kind: 'interview', status: 'cancelled', scheduled_at: INTERVIEW_AT, created_at: NOW },
    // Non-interview call must not surface.
    { id: 'call-3', application_id: 'app-2', meeting_kind: 'intro', status: 'booked', scheduled_at: INTERVIEW_AT, created_at: NOW }
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

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-status-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.RESEND_API_KEY = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/practice/status', () => {
  it('returns the practice, its jobs, candidate counts, and booked interview times', async () => {
    const r = await get('/api/practice/status?token=' + encodeURIComponent(INTAKE_TOKEN));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    expect(r.body.practice).toEqual({
      name: 'Greenslopes Family Medical',
      stage: 'active',
      agreement_status: 'signed'
    });

    expect(Array.isArray(r.body.jobs)).toBe(true);
    expect(r.body.jobs.length).toBe(3); // ONLY this practice's jobs
    const live = r.body.jobs.find((j) => j.id === 'role-1');
    const pending = r.body.jobs.find((j) => j.id === 'role-2');
    const filled = r.body.jobs.find((j) => j.id === 'role-3');
    expect(live).toBeTruthy();
    expect(pending).toBeTruthy();
    expect(filled).toBeTruthy();

    // Masked labels + live/pending/filled status.
    expect(live.role_label).toBe('DPA - Fitzroy - Mixed Billing');
    expect(live.status).toBe('live');
    expect(pending.role_label).toBe('Non-DPA - Cairns - Private Billing');
    expect(pending.status).toBe('pending');
    // job_status='filled' wins over is_active=true, a placed practice must
    // never read "Live" forever (audit item 7).
    expect(filled.status).toBe('filled');

    // Counts: submitted candidates only (pending_va_submission excluded).
    expect(live.candidates_submitted).toBe(2);
    expect(pending.candidates_submitted).toBe(0);

    // Booked interviews only (cancelled + non-interview calls excluded).
    expect(live.interviews.length).toBe(1);
    expect(live.interviews[0].scheduled_at).toBe(INTERVIEW_AT);
    expect(live.interviews[0].status).toBe('booked');
    expect(String(live.interviews[0].label)).toContain('2026'); // human-readable local label
    expect(pending.interviews.length).toBe(0);
  });

  it('never leaks candidate PII (names, emails, ids) in the payload', async () => {
    const r = await get('/api/practice/status?token=' + encodeURIComponent(INTAKE_TOKEN));
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain(SECRET_NAME_FIRST);
    expect(r.raw).not.toContain(SECRET_NAME_LAST);
    expect(r.raw).not.toContain(SECRET_EMAIL);
    expect(r.raw).not.toContain('u-1');
    expect(r.raw).not.toContain('app-1');
    // And nothing about the OTHER practice.
    expect(r.raw).not.toContain('Riverside');
    expect(r.raw).not.toContain(OTHER_TOKEN);
  });

  it('404s an unknown (well-formed) token without leaking anything', async () => {
    const r = await get('/api/practice/status?token=' + 'x'.repeat(32));
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
    expect(r.raw).not.toContain('Greenslopes');
  });

  it('404s a short/malformed token', async () => {
    const r = await get('/api/practice/status?token=short');
    expect(r.status).toBe(404);
  });
});
