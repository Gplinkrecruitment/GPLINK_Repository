// A task that exists to SEND a drafted email cannot be ticked off with that email unsent.
//
// The bug this pins (Dr Mercy Obanimoh, 2026-11-10). The owner asked for the practice to
// be introduced to its migration agent (Syed at Pace Migration). A task was created with
// the introduction drafted on it. That night it was closed from the generic "Mark
// Complete" button: the status flipped, the task left every list, and the email was
// never sent. Ten days later the owner asked where the task was.
//
// Guarded here:
//   1. completing such a task is refused, and the refusal names the unsent email;
//   2. it can still be closed deliberately ("sent another way"), and that is written to
//      the doctor's timeline so it can be found later;
//   3. a task whose email HAS gone, and ordinary tasks, complete exactly as before;
//   4. every "Mark Complete" button on the dashboard goes through the one function that
//      understands the refusal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-unsent-guard-${RUN_ID}.json`);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, port, sbServer, sbPort;

const DRAFT = {
  to: 'owner@practice-test.local', cc: 'agent@migration-test.local',
  subject: 'Dr Test Doctor Subclass 482 visa: introducing the migration agent',
  bodyHtml: '<p>Hi Dr Owner,</p><p>I would like to introduce the agent, who is copied on this email.</p>'
};
const db = {
  registration_cases: [{ id: 'case-1', user_id: 'u-1', status: 'active', migration_agent: 'Agent', migration_agent_contact: 'agent@migration-test.local' }],
  registration_tasks: [
    { id: 't-unsent', case_id: 'case-1', task_type: 'migration_agent', status: 'open', title: 'Introduce the practice to the agent',
      metadata: { registration_granted: true, outbound_email: { ...DRAFT } } },
    { id: 't-unsent-2', case_id: 'case-1', task_type: 'migration_agent', status: 'open', title: 'Introduce the practice to the agent (second)',
      metadata: { registration_granted: true, outbound_email: { ...DRAFT } } },
    { id: 't-sent', case_id: 'case-1', task_type: 'migration_agent', status: 'waiting_on_practice', title: 'Email the practice',
      metadata: { registration_granted: true, outbound_email: { ...DRAFT, sent_at: '2026-11-06T03:25:30.542Z', by: 'rso@gplink-test.local' } } },
    { id: 't-external', case_id: 'case-1', task_type: 'migration_agent', status: 'waiting_on_practice', title: 'Email the practice (answered outside the app)',
      metadata: { registration_granted: true, outbound_email: { ...DRAFT }, followups: [{ kind: 'external', sent_at: '2026-11-09T02:46:21Z', to: DRAFT.to }] } },
    { id: 't-plain', case_id: 'case-1', task_type: 'followup', status: 'open', title: 'Call the doctor', metadata: null }
  ],
  task_timeline: [], task_messages: [], task_documents: [], user_profiles: [], rso_team: []
};

function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
    const mm = /^(eq|neq)\.(.*)$/s.exec(v);
    if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
  }
  return (row) => filters.every((f) => {
    const eq = String(row ? row[f.col] : undefined) === String(f.val);
    return f.op === 'eq' ? eq : !eq;
  });
}
function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const readBody = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { sendJson(404, { message: 'not found' }); return; }
      const name = decodeURIComponent(m[1]);
      if (!db[name]) db[name] = [];
      const rows = db[name];
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        sendJson(200, out); return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()).toString('utf8') || 'null');
        const saved = (Array.isArray(body) ? body : (body ? [body] : [])).map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
        sendJson(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse((await readBody()).toString('utf8') || 'null');
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        sendJson(200, matched); return;
      }
      sendJson(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function adminCookie() {
  const payload = Buffer.from(JSON.stringify({ userProfile: { email: 'admin@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function put(p, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'PUT', headers: { Cookie: adminCookie(), 'Content-Type': 'application/json', 'Content-Length': payload.length } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}
const task = (id) => db.registration_tasks.find((t) => t.id === id);

beforeAll(async () => {
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'unsent-guard-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('completing a task whose drafted email has not been sent', () => {
  it('is refused, names the email, and leaves the task open', async () => {
    const r = await put('/api/admin/task?id=t-unsent', { status: 'completed' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('email_not_sent');
    expect(r.body.to).toBe(DRAFT.to);
    expect(r.body.cc).toBe(DRAFT.cc);
    expect(r.body.subject).toBe(DRAFT.subject);
    expect(r.body.message).toContain(DRAFT.to);
    expect(r.body.message).toContain('has not been sent');
    expect(task('t-unsent').status).toBe('open');
    expect(task('t-unsent').completed_at).toBeUndefined();
    expect(db.task_timeline.length).toBe(0);
  });

  it('other edits to the same task are not blocked', async () => {
    const r = await put('/api/admin/task?id=t-unsent', { priority: 'urgent' });
    expect(r.status).toBe(200);
    expect(task('t-unsent').priority).toBe('urgent');
    expect(task('t-unsent').status).toBe('open');
  });

  it('closes on an explicit confirmation, and says so on the timeline', async () => {
    const r = await put('/api/admin/task?id=t-unsent-2', { status: 'completed', confirm_email_unsent: true });
    expect(r.status).toBe(200);
    expect(task('t-unsent-2').status).toBe('completed');
    const note = db.task_timeline.find((e) => e.task_id === 't-unsent-2' && /WITHOUT sending/.test(e.title || ''));
    expect(note).toBeTruthy();
    expect(note.detail).toContain(DRAFT.to);
    expect(note.detail).toContain(DRAFT.subject);
    expect(note.actor).toBe('admin@gplink-test.local');
  });

  it('a truthy-looking string is not a confirmation', async () => {
    const r = await put('/api/admin/task?id=t-unsent', { status: 'completed', confirm_email_unsent: 'true' });
    expect(r.status).toBe(409);
    expect(task('t-unsent').status).toBe('open');
  });
});

describe('tasks the guard must leave alone', () => {
  it('a task whose email was sent completes normally', async () => {
    const r = await put('/api/admin/task?id=t-sent', { status: 'completed' });
    expect(r.status).toBe(200);
    expect(task('t-sent').status).toBe('completed');
  });

  it('a task answered by an email sent outside the app completes normally', async () => {
    const r = await put('/api/admin/task?id=t-external', { status: 'completed' });
    expect(r.status).toBe(200);
    expect(task('t-external').status).toBe('completed');
  });

  it('an ordinary task with no drafted email completes normally', async () => {
    const r = await put('/api/admin/task?id=t-plain', { status: 'completed' });
    expect(r.status).toBe(200);
    expect(task('t-plain').status).toBe('completed');
  });
});

describe('the dashboard page', () => {
  const page = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('asks before closing, and only sends the confirmation after an OK', () => {
    const start = page.indexOf('async function putTaskCompleted(');
    expect(start).toBeGreaterThan(-1);
    const fn = page.slice(start, start + 1500);
    expect(fn).toContain("d.code==='email_not_sent'");
    expect(fn).toContain('window.confirm(');
    expect(fn).toContain('NOT been sent');
    expect(fn.indexOf('window.confirm(')).toBeLessThan(fn.indexOf('confirm_email_unsent:true'));
    expect(fn).toContain('if(!ok)return {ok:false,cancelled:true};');
  });

  it('routes the Mark Complete buttons through that one function', () => {
    const uses = page.split('putTaskCompleted(').length - 1;
    expect(uses).toBeGreaterThanOrEqual(4); // the definition + task menu + ops queue + the card's own button
    for (const marker of ['async function completeTask(taskId){', 'e.target.closest("[data-ops-complete-task]")', "e.target.closest('[data-rg-complete]')"]) {
      const at = page.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      expect(page.slice(at, at + 900)).toContain('putTaskCompleted(');
    }
  });

  it('shows an introduction that went in the first email as waiting on the practice', () => {
    expect(page).toContain('var introWithPractice=!!(intro&&intro.in_first_email);');
  });
});
