// Phase 6 G1 (R2), automatic chasing of non-responders.
//
// Proves, against the REAL server with an in-memory PostgREST emulator and a
// captured Resend transport (Gmail is unconfigured here so the chase falls
// back to the transactional Resend path):
//   A) a practice sitting on an SPPA-00 past the return window gets ONE
//      reminder email + an RSO chase task/note, and is NOT re-sent on the
//      next run (metadata.practice_chase_last_at dedup);
//   B) an AHPRA officer whose last thread message is our outbound and older
//      than the window gets a follow-up; an officer who replied last is
//      never chased;
//   C) a GP stalled ≥14 days in an extended stage (career/ahpra/visa/pbs)
//      is chased (email + stall_chase task), myintealth/amc stay with the
//      weekly sweep; the chase is TRANSACTIONAL (sent even with notification
//      prefs off and the address on the suppression list);
//   D) nothing inside its window is chased, the per-run cap bounds each
//      category, and the cron is secret-gated + heartbeat-recorded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-chase-${RUN_ID}.json`);
const CRON_SECRET = 'chase-cron-secret-' + RUN_ID;
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const PRACTICE_A = 'practice-overdue-a@test.local';
const PRACTICE_B = 'practice-overdue-b@test.local';
const PRACTICE_FRESH = 'practice-fresh@test.local';
const OFFICER = 'officer@ahpra.gov.au';
const GP_STALLED = 'stalled-gp@gplink-test.local';
const GP_MYINTEALTH = 'myintealth-gp@gplink-test.local';

const db = {
  user_profiles: [
    { user_id: 'u-pr1', email: 'pr1@gplink-test.local', first_name: 'Pia', last_name: 'One' },
    { user_id: 'u-pr2', email: 'pr2@gplink-test.local', first_name: 'Pat', last_name: 'Two' },
    { user_id: 'u-pr3', email: 'pr3@gplink-test.local', first_name: 'Pam', last_name: 'Three' },
    { user_id: 'u-of1', email: 'of1@gplink-test.local', first_name: 'Otis', last_name: 'Case' },
    { user_id: 'u-of2', email: 'of2@gplink-test.local', first_name: 'Odin', last_name: 'Case' },
    { user_id: 'u-gp1', email: GP_STALLED, first_name: 'Stella', last_name: 'Stalled' },
    { user_id: 'u-gp2', email: 'fresh-gp@gplink-test.local', first_name: 'Frank', last_name: 'Fresh' },
    { user_id: 'u-gp3', email: GP_MYINTEALTH, first_name: 'Mila', last_name: 'Myintealth' }
  ],
  registration_cases: [
    // Practice-chase cases (GPs recently active so pass C ignores them)
    { id: 'c-pr1', user_id: 'u-pr1', stage: 'placement', status: 'active', created_at: iso(-30), updated_at: iso(-1), last_gp_activity_at: iso(-1) },
    { id: 'c-pr2', user_id: 'u-pr2', stage: 'placement', status: 'active', created_at: iso(-30), updated_at: iso(-1), last_gp_activity_at: iso(-1) },
    { id: 'c-pr3', user_id: 'u-pr3', stage: 'placement', status: 'active', created_at: iso(-30), updated_at: iso(-1), last_gp_activity_at: iso(-1) },
    // Officer-chase cases
    { id: 'c-of1', user_id: 'u-of1', stage: 'ahpra', status: 'active', created_at: iso(-30), updated_at: iso(-1), last_gp_activity_at: iso(-1), ahpra_officer_email: OFFICER, ahpra_officer_name: 'Olive Officer' },
    { id: 'c-of2', user_id: 'u-of2', stage: 'ahpra', status: 'active', created_at: iso(-30), updated_at: iso(-1), last_gp_activity_at: iso(-1), ahpra_officer_email: OFFICER, ahpra_officer_name: 'Olive Officer' },
    // GP-stall cases
    { id: 'c-gp1', user_id: 'u-gp1', stage: 'ahpra', substage: '', status: 'active', created_at: iso(-40), updated_at: iso(-20), last_gp_activity_at: iso(-20) },
    { id: 'c-gp2', user_id: 'u-gp2', stage: 'pbs', status: 'active', created_at: iso(-40), updated_at: iso(-5), last_gp_activity_at: iso(-5) },
    // myintealth stall, weekly-sweep territory, must NOT be chased here
    { id: 'c-gp3', user_id: 'u-gp3', stage: 'myintealth', status: 'active', created_at: iso(-40), updated_at: iso(-20), last_gp_activity_at: iso(-20) }
  ],
  registration_tasks: [
    // A) SPPA sent to practice 6 days ago (window 4d) → chase
    { id: 't-sppa1', case_id: 'c-pr1', task_type: 'document', related_document_key: 'sppa_00', status: 'waiting_on_practice', title: 'SPPA-00', gmail_thread_id: null, updated_at: iso(-6), created_at: iso(-10), metadata: { sppa_state: 'sent_to_practice', sent_to_practice_at: iso(-6), sent_to_practice_email: PRACTICE_A } },
    // A) second overdue practice, used to prove the per-run cap
    { id: 't-sppa2', case_id: 'c-pr2', task_type: 'document', related_document_key: 'sppa_00', status: 'waiting_on_practice', title: 'SPPA-00', gmail_thread_id: null, updated_at: iso(-8), created_at: iso(-12), metadata: { sppa_state: 'sent_to_practice', sent_to_practice_at: iso(-8), sent_to_practice_email: PRACTICE_B } },
    // A) inside the window (sent yesterday) → NOT chased
    { id: 't-sppa3', case_id: 'c-pr3', task_type: 'document', related_document_key: 'sppa_00', status: 'waiting_on_practice', title: 'SPPA-00', gmail_thread_id: null, updated_at: iso(-1), created_at: iso(-2), metadata: { sppa_state: 'sent_to_practice', sent_to_practice_at: iso(-1), sent_to_practice_email: PRACTICE_FRESH } },
    // B) officer silent, our outbound is the latest message, 10 days old (window 6d) → chase
    { id: 't-ah1', case_id: 'c-of1', task_type: 'ahpra_correspondence', status: 'waiting_on_external', title: 's80 notice', gmail_thread_id: 'th-of1', updated_at: iso(-10), created_at: iso(-20), metadata: {} },
    // B) officer replied last → never chased
    { id: 't-ah2', case_id: 'c-of2', task_type: 'ahpra_correspondence', status: 'waiting_on_external', title: 's80 notice', gmail_thread_id: 'th-of2', updated_at: iso(-10), created_at: iso(-20), metadata: {} }
  ],
  task_messages: [
    { id: 'm-1', task_id: 't-ah1', case_id: 'c-of1', direction: 'inbound', subject: 'Notice under s80', created_at: iso(-20), rfc822_message_id: '<in-1@ahpra>', gmail_thread_id: 'th-of1' },
    { id: 'm-2', task_id: 't-ah1', case_id: 'c-of1', direction: 'outbound', subject: 'Re: Notice under s80', created_at: iso(-10), rfc822_message_id: '<out-1@gplink>', rfc822_references: '<in-1@ahpra>', gmail_thread_id: 'th-of1' },
    { id: 'm-3', task_id: 't-ah2', case_id: 'c-of2', direction: 'outbound', subject: 'Re: Notice', created_at: iso(-12), rfc822_message_id: '<out-2@gplink>', gmail_thread_id: 'th-of2' },
    { id: 'm-4', task_id: 't-ah2', case_id: 'c-of2', direction: 'inbound', subject: 'Re: Notice', created_at: iso(-9), rfc822_message_id: '<in-2@ahpra>', gmail_thread_id: 'th-of2' }
  ],
  // C) transactional proof: prefs off + suppressed, chase must still send
  notification_preferences: [
    { email: GP_STALLED, email_nudges: false, whatsapp: false, push: false }
  ],
  email_suppression: [
    { email: GP_STALLED, reason: 'hard_bounce', source: 'test' }
  ],
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

// Captured outbound email (Resend) calls: [{to:[..], subject}]
const sentEmails = [];
function emailsTo(addr) { return sentEmails.filter((e) => (e.to || []).includes(addr)); }

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'chase-test-secret-' + RUN_ID;
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
  // Category windows (defaults), set explicitly so the test is self-describing
  process.env.CHASE_PRACTICE_SPPA_DAYS = '4';
  process.env.CHASE_AHPRA_OFFICER_DAYS = '6';
  process.env.CHASE_GP_STALL_DAYS = '14';
  process.env.CHASE_MAX_PER_RUN = '1'; // run 1 proves the per-run cap

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith('https://api.resend.com/emails')) {
      try {
        const body = JSON.parse((opts && opts.body) || '{}');
        sentEmails.push({ to: Array.isArray(body.to) ? body.to : [body.to], subject: body.subject || '' });
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

describe('GET /api/cron/chase-nonresponders', () => {
  it('is cron-secret-gated', async () => {
    const r = await httpReq('GET', '/api/cron/chase-nonresponders');
    expect(r.status).toBe(401);
    expect(sentEmails.length).toBe(0);
  });

  it('run 1 (cap=1): chases ONE practice, the silent officer, and the stalled GP, nothing inside its window', async () => {
    const r = await httpReq('GET', '/api/cron/chase-nonresponders', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Per-run cap: two practices are overdue but only ONE is chased
    expect(r.body.practice).toBe(1);
    expect(emailsTo(PRACTICE_A).length + emailsTo(PRACTICE_B).length).toBe(1);
    // Fresh practice (sent yesterday, window 4d) untouched
    expect(emailsTo(PRACTICE_FRESH).length).toBe(0);

    // Officer chased once (our outbound was last, 10d > 6d window)
    expect(r.body.officer).toBe(1);
    const officerMails = emailsTo(OFFICER);
    expect(officerMails.length).toBe(1);
    expect(officerMails[0].subject).toMatch(/^Re: /);

    // GP stalled 20d on ahpra chased, TRANSACTIONAL: prefs off + suppressed,
    // still sent (suppression only ever gates category:'marketing').
    expect(r.body.gp).toBe(1);
    expect(emailsTo(GP_STALLED).length).toBe(1);
    // pbs GP only 5d silent → not chased; myintealth stall belongs to the
    // weekly sweep → not chased here
    expect(emailsTo('fresh-gp@gplink-test.local').length).toBe(0);
    expect(emailsTo(GP_MYINTEALTH).length).toBe(0);
    expect(db.registration_tasks.some((t) => t.case_id === 'c-gp3' && t.source_trigger === 'stall_chase')).toBe(false);

    // Dedup flags + RSO visibility artifacts
    const chasedSppa = db.registration_tasks.find((t) => ['t-sppa1', 't-sppa2'].includes(t.id) && t.metadata && t.metadata.practice_chase_last_at);
    expect(chasedSppa).toBeTruthy();
    expect(chasedSppa.metadata.practice_chase_count).toBe(1);
    expect(db.registration_tasks.some((t) => t.task_type === 'chase' && t.source_trigger === 'practice_sppa_chase' && t.case_id === chasedSppa.case_id)).toBe(true);
    const ah1 = db.registration_tasks.find((t) => t.id === 't-ah1');
    expect(ah1.metadata.officer_chase_last_at).toBeTruthy();
    expect(db.registration_tasks.some((t) => t.task_type === 'chase' && t.source_trigger === 'ahpra_officer_chase' && t.case_id === 'c-of1')).toBe(true);
    expect(db.registration_tasks.some((t) => t.task_type === 'chase' && t.source_trigger === 'stall_chase' && t.case_id === 'c-gp1')).toBe(true);

    // Officer who replied last (t-ah2) untouched
    const ah2 = db.registration_tasks.find((t) => t.id === 't-ah2');
    expect(ah2.metadata.officer_chase_last_at).toBeUndefined();

    // Heartbeat recorded by the dispatcher, written just AFTER the response
    // is sent, so poll briefly.
    let hb = null;
    for (let i = 0; i < 20 && !hb; i++) {
      hb = db.runtime_kv.find((k) => k.key === 'cron_last_run_chase-nonresponders');
      if (!hb) await new Promise((r) => setTimeout(r, 50));
    }
    expect(hb).toBeTruthy();
    expect(hb.value.status).toBe('ok');
  });

  it('run 2 (cap lifted): the capped-out practice is chased now; everything already chased stays quiet (dedup)', async () => {
    process.env.CHASE_MAX_PER_RUN = '15';
    const before = sentEmails.length;
    const r = await httpReq('GET', '/api/cron/chase-nonresponders', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);

    // Exactly one new email: the second overdue practice
    expect(r.body.practice).toBe(1);
    expect(r.body.officer).toBe(0);
    expect(r.body.gp).toBe(0);
    expect(sentEmails.length).toBe(before + 1);
    expect(emailsTo(PRACTICE_A).length).toBe(1);
    expect(emailsTo(PRACTICE_B).length).toBe(1);
    expect(emailsTo(OFFICER).length).toBe(1);
    expect(emailsTo(GP_STALLED).length).toBe(1);
  });

  it('run 3: everything is inside its window, nothing is sent (once-per-window dedup)', async () => {
    const before = sentEmails.length;
    const r = await httpReq('GET', '/api/cron/chase-nonresponders', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.practice).toBe(0);
    expect(r.body.officer).toBe(0);
    expect(r.body.gp).toBe(0);
    expect(sentEmails.length).toBe(before);
    // Still exactly one open RSO chase task per case/category (no pile-up)
    const sppaChases = db.registration_tasks.filter((t) => t.task_type === 'chase' && t.source_trigger === 'practice_sppa_chase');
    expect(sppaChases.length).toBe(2); // one per chased practice case
  });
});
