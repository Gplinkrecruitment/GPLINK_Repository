// Phase 6 H1 (audit B2) — weekly owner digest email:
//  1. GET /api/cron/owner-digest is cron-secret-gated (401 without Bearer);
//  2. an authorized run composes the operational KPIs + week-over-week movement
//     from the SAME trend series the dashboard uses and emails GP_OWNER_EMAIL
//     (hello@mygplink.com.au) via Resend (captured);
//  3. the send is TRANSACTIONAL — no List-Unsubscribe headers, never suppressed;
//  4. the cron heartbeat (runtime_kv cron_last_run_owner-digest) is recorded;
//  5. idempotent per week: a second cron run the same week skips (no 2nd email);
//  6. POST /api/ceo/owner-digest/send ("Send me the digest now") is super-admin
//     gated and force-sends even when the weekly slot is already consumed.
//
// Supabase is FAKED by wrapping global fetch: PostgREST reads serve fixture
// rows per table and runtime_kv round-trips through an in-memory map, so the
// digest's reuse of computeWeeklyTrendSeries/ceoMetrics is exercised end-to-end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-owner-digest-${RUN_ID}.json`;
const SUPER_HOST = 'owner-digest-test.local';
const CRON_SECRET = 'owner-digest-cron-secret-' + RUN_ID;
const FAKE_SUPABASE = 'http://supabase-fake-owner-digest.test';

let server, port;
const resendCalls = [];
const kvStore = {}; // runtime_kv key -> value (JSON)

const NOW = Date.now();
const DAY = 86400000;
const thisWeekIso = new Date(NOW).toISOString();
const lastWeekIso = new Date(NOW - 7 * DAY).toISOString();

// Fixture rows served for every read of the given table (PostgREST filters are
// NOT applied by the fake — the server buckets/filters in JS, which is what we
// are testing). registration_cases distinguishes the trends' completions query
// (stage=eq.complete) from the full-case reads via the querystring.
const FIXTURE = {
  registration_cases: [
    { id: 'c1', user_id: 'u1', stage: 'career', status: 'active', blocker_status: null, completed_at: null, last_gp_activity_at: thisWeekIso, updated_at: thisWeekIso, created_at: thisWeekIso },
    { id: 'c2', user_id: 'u2', stage: 'amc', status: 'active', blocker_status: null, completed_at: null, last_gp_activity_at: lastWeekIso, updated_at: lastWeekIso, created_at: lastWeekIso }
  ],
  registration_cases_complete: [],
  registration_tasks: [
    { id: 't1', case_id: 'c1', status: 'completed', due_date: null, created_at: lastWeekIso, completed_at: thisWeekIso },
    { id: 't2', case_id: 'c1', status: 'completed', due_date: null, created_at: lastWeekIso, completed_at: thisWeekIso },
    { id: 't3', case_id: 'c2', status: 'completed', due_date: null, created_at: lastWeekIso, completed_at: thisWeekIso },
    { id: 't4', case_id: 'c2', status: 'completed', due_date: null, created_at: lastWeekIso, completed_at: lastWeekIso },
    { id: 't5', case_id: 'c1', status: 'open', due_date: null, created_at: thisWeekIso, completed_at: null }
  ],
  support_tickets: [
    { created_at: thisWeekIso, resolved_at: null }
  ],
  gp_applications: [
    { user_id: 'u1', status: 'applied', applied_at: thisWeekIso, updated_at: thisWeekIso },
    { user_id: 'u2', status: 'applied', applied_at: thisWeekIso, updated_at: thisWeekIso },
    { user_id: 'u2', status: 'submitted', applied_at: lastWeekIso, updated_at: lastWeekIso },
    { user_id: 'u1', status: 'placed', applied_at: lastWeekIso, updated_at: thisWeekIso }
  ],
  task_timeline: [
    { created_at: thisWeekIso },
    { created_at: thisWeekIso },
    { created_at: lastWeekIso }
  ],
  career_interviews: [
    { created_at: thisWeekIso },
    { created_at: thisWeekIso },
    { created_at: lastWeekIso }
  ]
};

function req(method, p, { cookie, bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, body: parsed });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function mintAdminCookie(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'owner-digest-secret-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = 'rso@gplink-test.local';
  process.env.RESEND_API_KEY = 'test-resend-key';

  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, opts) => {
    const target = String(u && u.url ? u.url : u);
    if (target.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push({ url: target, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (target.startsWith(FAKE_SUPABASE)) {
      const parsedUrl = new URL(target);
      const table = parsedUrl.pathname.replace(/^\/rest\/v1\//, '').split('/')[0];
      const method = (opts && opts.method) || 'GET';
      if (table === 'runtime_kv') {
        if (method === 'POST') {
          let rows = []; try { rows = JSON.parse((opts && opts.body) || '[]'); } catch {}
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            if (row && row.key) kvStore[row.key] = row.value;
          }
          return Promise.resolve(new Response('[]', { status: 201 }));
        }
        const keyMatch = /key=eq\.([^&]+)/.exec(parsedUrl.search);
        const key = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
        const rows = key && Object.prototype.hasOwnProperty.call(kvStore, key) ? [{ key, value: kvStore[key] }] : [];
        return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
      }
      if (method !== 'GET') return Promise.resolve(new Response('[]', { status: 200 }));
      let rows = FIXTURE[table] || [];
      if (table === 'registration_cases' && parsedUrl.search.includes('stage=eq.complete')) {
        rows = FIXTURE.registration_cases_complete;
      }
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
    }
    return realFetch(u, opts);
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('weekly owner digest cron', () => {
  it('GET /api/cron/owner-digest without the cron secret -> 401, no email', async () => {
    const r = await req('GET', '/api/cron/owner-digest');
    expect(r.status).toBe(401);
    expect(resendCalls.length).toBe(0);
  });

  it('authorized run composes KPIs + week-over-week and emails the owner', async () => {
    const r = await req('GET', '/api/cron/owner-digest', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body && r.body.ok).toBe(true);
    expect(r.body.sent).toBe(true);
    expect(r.body.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(resendCalls.length).toBe(1);
    const payload = resendCalls[0].body;
    expect(payload.to).toContain('hello@mygplink.com.au');
    expect(payload.subject).toMatch(/weekly digest/i);

    const html = payload.html || '';
    // Row values come straight from the shared trend series (fixture: 2 apps,
    // 2 interviews, 1 placement, 3 tasks completed this week) + WoW movement.
    expect(html).toMatch(/New applications<\/td><td[^>]*>2</);
    expect(html).toMatch(/Interviews booked<\/td><td[^>]*>2</);
    expect(html).toMatch(/Placements secured<\/td><td[^>]*>1</);
    expect(html).toMatch(/Tasks completed<\/td><td[^>]*>3</);
    expect(html).toContain('vs last week');
    expect(html).toContain('Biggest movers');
    expect(html).toContain('Where things stand');
    expect(html).toContain('View full dashboard');
    expect(html).toContain('/pages/ceo-dashboard');
    // Operational only — no money figures (Xero owns revenue).
    expect(html).not.toMatch(/revenue|\$\d/i);
  });

  it('the send is transactional — no List-Unsubscribe headers', () => {
    const payload = resendCalls[0].body;
    expect(JSON.stringify(payload)).not.toContain('List-Unsubscribe');
  });

  it('records the cron heartbeat (runtime_kv cron_last_run_owner-digest)', () => {
    const hb = kvStore['cron_last_run_owner-digest'];
    expect(hb).toBeTruthy();
    expect(hb.status).toBe('ok');
    expect(hb.detail).toMatch(/sent for week/);
  });

  it('is idempotent per week: a second cron run skips (no second email)', async () => {
    const r = await req('GET', '/api/cron/owner-digest', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.skipped).toBe(true);
    expect(resendCalls.length).toBe(1);
    expect(kvStore['owner_digest_last_sent']).toBeTruthy();
    expect(kvStore['owner_digest_last_sent'].week_start).toBe(r.body.week_start);
  });
});

describe('manual "Send me the digest now" endpoint', () => {
  it('rejects anonymous callers', async () => {
    const r = await req('POST', '/api/ceo/owner-digest/send', { body: {} });
    expect([401, 403]).toContain(r.status);
  });

  it('rejects non-super-admin roles', async () => {
    const r = await req('POST', '/api/ceo/owner-digest/send', {
      cookie: mintAdminCookie('rso@gplink-test.local', 'admin'),
      body: {}
    });
    expect([401, 403]).toContain(r.status);
  });

  it('super-admin force-send works even after the weekly slot is consumed', async () => {
    const before = resendCalls.length;
    const r = await req('POST', '/api/ceo/owner-digest/send', {
      cookie: mintAdminCookie('super@gplink-test.local', 'super_admin'),
      body: {}
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sent).toBe(true);
    expect(r.body.forced).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    expect(resendCalls[resendCalls.length - 1].body.to).toContain('hello@mygplink.com.au');
  });
});
