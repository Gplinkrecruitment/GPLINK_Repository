// Stall chasing emails the step the GP is REALLY on.
//
// Every GP gets a registration_cases row with stage 'myintealth' at signup,
// before the onboarding wizard is finished, and that column only advances when
// the state-sync hook next runs. On 2026-10-27 the daily weekly-sweep read it
// raw and told a doctor still on wizard slide 1 to "Continue MyIntealth".
//
// Proves, against the REAL server with an in-memory PostgREST emulator and a
// captured Resend transport, that GET /api/cron/weekly-sweep now:
//   A) sends an onboarding dropout the step-accurate wizard email (never the
//      "Need a hand?" stage reminder), ledgers it once in gp_nudge_log, and
//      opens a chase task that says "in onboarding (step 2 of 5: Plan your move)";
//   B) a GP whose MyIntealth is verified in user_state but whose case row still
//      says 'myintealth' is nudged about AMC, with the AMC page as the button;
//   C) a GP genuinely on MyIntealth still gets the MyIntealth reminder, now
//      deep-linked to the MyIntealth page;
//   D) a GP whose stored stage is AHEAD of what the state derives (admin
//      override / reset) keeps the stored stage;
//   E) a GP active in the last 14 days is left alone, and a rerun sends nothing
//      (7-day check-in dedup; the step email is once per step for ever).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-stalled-pos-${RUN_ID}.json`);
const CRON_SECRET = 'stalled-cron-secret-' + RUN_ID;
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const ONB = 'onboarding-dropout@gplink-test.local';
const LAG = 'case-lags-app@gplink-test.local';
const MI = 'really-on-myintealth@gplink-test.local';
const AHEAD = 'stored-ahead@gplink-test.local';
const FRESH = 'active-recently@gplink-test.local';

const EPIC_DONE = JSON.stringify({
  stage: 'verification_issued',
  completed: { create_account: true, upload_qualifications: true, waiting_verification: true, account_establishment: true, verification_issued: true }
});

const db = {
  user_profiles: [
    // A) signed up 30 days ago, never finished the wizard (slide 1 = Plan your move)
    { user_id: 'u-onb', email: ONB, first_name: 'Onb', last_name: 'Dropout', onboarding_completed_at: null },
    // B) onboarded; MyIntealth verified in the app, case row never advanced
    { user_id: 'u-lag', email: LAG, first_name: 'Lag', last_name: 'Case', onboarding_completed_at: iso(-40) },
    // C) onboarded, genuinely on MyIntealth
    { user_id: 'u-mi', email: MI, first_name: 'Mia', last_name: 'Intealth', onboarding_completed_at: iso(-40) },
    // D) onboarded; case says amc (admin moved it), state derives myintealth
    { user_id: 'u-ahead', email: AHEAD, first_name: 'Ada', last_name: 'Ahead', onboarding_completed_at: iso(-40) },
    // E) onboarded, active 2 days ago
    { user_id: 'u-fresh', email: FRESH, first_name: 'Fay', last_name: 'Fresh', onboarding_completed_at: iso(-40) }
  ],
  user_state: [
    { user_id: 'u-onb', state: { gp_onboarding: { _version: 2, currentStep: 1, completedAt: null } }, updated_at: iso(-29) },
    { user_id: 'u-lag', state: { gp_epic_progress: EPIC_DONE }, updated_at: iso(-20) },
    { user_id: 'u-mi', state: { gp_epic_progress: JSON.stringify({ stage: 'upload_qualifications', completed: { create_account: true } }) }, updated_at: iso(-15) },
    { user_id: 'u-ahead', state: {}, updated_at: iso(-16) },
    { user_id: 'u-fresh', state: {}, updated_at: iso(-2) }
  ],
  registration_cases: [
    { id: 'c-onb', user_id: 'u-onb', stage: 'myintealth', substage: null, status: 'active', created_at: iso(-30), updated_at: iso(-30), last_gp_activity_at: null },
    { id: 'c-lag', user_id: 'u-lag', stage: 'myintealth', substage: 'create_account', status: 'active', created_at: iso(-30), updated_at: iso(-20), last_gp_activity_at: iso(-20) },
    { id: 'c-mi', user_id: 'u-mi', stage: 'myintealth', substage: 'upload_qualifications', status: 'active', created_at: iso(-30), updated_at: iso(-15), last_gp_activity_at: iso(-15) },
    { id: 'c-ahead', user_id: 'u-ahead', stage: 'amc', substage: 'create_portfolio', status: 'active', created_at: iso(-30), updated_at: iso(-16), last_gp_activity_at: iso(-16) },
    { id: 'c-fresh', user_id: 'u-fresh', stage: 'myintealth', substage: null, status: 'active', created_at: iso(-30), updated_at: iso(-2), last_gp_activity_at: iso(-2) }
  ],
  registration_tasks: [],
  onboarding_reminders: [],
  gp_nudge_log: [],
  notification_preferences: [],
  email_suppression: [],
  user_documents: [],
  user_nudges: [],
  task_timeline: [],
  case_timeline: [],
  runtime_kv: [],
  user_roles: []
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
    if (op === 'gt') return cell != null && String(cell) > val;
    if (op === 'gte') return cell != null && String(cell) >= val;
    if (op === 'lt') return cell != null && String(cell) < val;
    if (op === 'lte') return cell != null && String(cell) <= val;
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
        const order = u.searchParams.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          out = out.slice().sort((a, b) => {
            const av = String(a[col] == null ? '' : a[col]);
            const bv = String(b[col] == null ? '' : b[col]);
            return dir === 'desc' ? (av < bv ? 1 : av > bv ? -1 : 0) : (av < bv ? -1 : av > bv ? 1 : 0);
          });
        }
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
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
        db[table] = rows.filter((r) => !matches(r));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function httpReq(method, p, { bearer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// Captured outbound email (Resend) calls: [{ to:[..], subject, html }]
const sentEmails = [];
function emailsTo(addr) { return sentEmails.filter((e) => (e.to || []).includes(addr)); }
function taskFor(caseId) { return db.registration_tasks.find((t) => t.case_id === caseId && t.task_type === 'chase' && t.source_trigger === 'weekly_checkin'); }

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'stalled-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CRON_SECRET = CRON_SECRET;

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith('https://api.resend.com/emails')) {
      try {
        const body = JSON.parse((opts && opts.body) || '{}');
        sentEmails.push({ to: Array.isArray(body.to) ? body.to : [body.to], subject: body.subject || '', html: String(body.html || '') });
      } catch {}
      return new Response('{"id":"test"}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
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

describe('GET /api/cron/weekly-sweep chases the step the GP is really on', () => {
  it('is cron-secret-gated', async () => {
    const r = await httpReq('GET', '/api/cron/weekly-sweep');
    expect(r.status).toBe(401);
    expect(sentEmails.length).toBe(0);
  });

  it('run 1: each stalled GP gets the email for their real position', async () => {
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // A) Onboarding dropout: the step-accurate wizard email, NOT "Continue MyIntealth".
    const onbMails = emailsTo(ONB);
    expect(onbMails.length).toBe(1);
    expect(onbMails[0].subject).toBe('Where in Australia, Dr Onb?');
    expect(onbMails[0].html).toContain('/pages/onboarding.html?step=1');
    expect(onbMails[0].html).not.toContain('MyIntealth');
    expect(sentEmails.some((e) => (e.to || []).includes(ONB) && /need a hand/i.test(e.subject))).toBe(false);
    // Ledgered once per step, so no cron can ever repeat it.
    expect(db.gp_nudge_log.filter((n) => n.user_id === 'u-onb' && n.nudge_key === 'onboarding_step_move' && n.channel === 'email').length).toBe(1);
    // The VA's chase task tells the truth about where the doctor is.
    const onbTask = taskFor('c-onb');
    expect(onbTask).toBeTruthy();
    expect(onbTask.title).toContain('in onboarding (step 2 of 5: Plan your move)');
    expect(onbTask.title).not.toContain('myintealth');
    expect(onbTask.related_stage).toBe('onboarding');
    expect(onbTask.related_substage).toBe('onboarding_step_move');

    // B) Case row lags the app: MyIntealth is verified in user_state, so the
    //    reminder is about AMC and the button opens the AMC page.
    const lagMails = emailsTo(LAG);
    expect(lagMails.length).toBe(1);
    expect(lagMails[0].subject).toBe('Need a hand? | GP Link');
    expect(lagMails[0].html).toContain('Continue AMC');
    expect(lagMails[0].html).toContain('/pages/amc.html');
    expect(lagMails[0].html).not.toContain('progress on MyIntealth');
    const lagTask = taskFor('c-lag');
    expect(lagTask.title).toContain('on amc');
    expect(lagTask.related_stage).toBe('amc');
    expect(lagTask.related_substage).toBe('create_portfolio');

    // C) Genuinely on MyIntealth: unchanged message, now deep-linked to the page.
    const miMails = emailsTo(MI);
    expect(miMails.length).toBe(1);
    expect(miMails[0].html).toContain('Continue MyIntealth');
    expect(miMails[0].html).toContain('/pages/myinthealth.html');
    const miTask = taskFor('c-mi');
    expect(miTask.related_stage).toBe('myintealth');
    expect(miTask.related_substage).toBe('upload_qualifications');

    // D) Stored stage ahead of the state (admin override): the stored stage wins.
    const aheadMails = emailsTo(AHEAD);
    expect(aheadMails.length).toBe(1);
    expect(aheadMails[0].html).toContain('Continue AMC');
    expect(taskFor('c-ahead').related_stage).toBe('amc');

    // E) Active 2 days ago: left alone.
    expect(emailsTo(FRESH).length).toBe(0);
    expect(taskFor('c-fresh')).toBeUndefined();

    expect(sentEmails.length).toBe(4);
  });

  it('run 2: nothing is re-sent inside the 7-day check-in window', async () => {
    const before = sentEmails.length;
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(sentEmails.length).toBe(before);
    expect(db.registration_tasks.filter((t) => t.task_type === 'chase' && t.source_trigger === 'weekly_checkin').length).toBe(4);
  });

  it('an onboarding dropout who unsubscribed from the reminders gets the task but no email', async () => {
    db.user_profiles.push({ user_id: 'u-unsub', email: 'unsub@gplink-test.local', first_name: 'Una', last_name: 'Sub', onboarding_completed_at: null });
    db.user_state.push({ user_id: 'u-unsub', state: { gp_onboarding: { currentStep: 3 } }, updated_at: iso(-20) });
    db.registration_cases.push({ id: 'c-unsub', user_id: 'u-unsub', stage: 'myintealth', substage: null, status: 'active', created_at: iso(-20), updated_at: iso(-20), last_gp_activity_at: null });
    db.onboarding_reminders.push({ id: 'r-unsub', user_id: 'u-unsub', email: 'unsub@gplink-test.local', unsubscribed: true, stopped: false });
    const before = sentEmails.length;
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(sentEmails.length).toBe(before);
    const t = taskFor('c-unsub');
    expect(t).toBeTruthy();
    expect(t.title).toContain('in onboarding (step 4 of 5: Review)');
    expect(db.gp_nudge_log.some((n) => n.user_id === 'u-unsub')).toBe(false);
  });
});
