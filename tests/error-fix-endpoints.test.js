// AI bug-fix approval pipeline, server wiring.
//
//   BUILD 1  friendly error page for GPs (page navigations only, /api/ untouched)
//   BUILD 3  the daily cron is registered for heartbeat tracking
//   BUILD 5  approval endpoints: token flow (email) + CEO flow (dashboard)
//
// The single most important assertion in this file is that an email link
// PREFETCHER cannot approve anything: GET /approve-fix must leave the proposal
// untouched, and only the POST may change it.
//
// Local-JSON mode with a hand-built DB file (idiom from tests/admin-leads.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-error-fix-${RUN_ID}.json`);
const SUPER_HOST = 'errorfix-test.local';
let server, port, ef;

// Tokens are minted here so the test knows the plaintext; only the hash is
// seeded into the database, exactly as the email flow does.
const TOK_A = crypto.randomBytes(32).toString('hex');
const TOK_EXPIRED = crypto.randomBytes(32).toString('hex');
const hash = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function req(method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Host: SUPER_HOST }, opts.headers || {});
    if (opts.cookie) headers.Cookie = opts.cookie;
    let payload = null;
    if (opts.json !== undefined) {
      payload = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    } else if (opts.form !== undefined) {
      payload = new URLSearchParams(opts.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let body = null; try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function seedDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    errorFixProposals: [
      {
        id: 'prop-a', error_hash: 'hash-a', status: 'proposed',
        error_message: 'jobList is not defined', page_url: '/pages/career.html',
        plain_explanation: 'The jobs list does not finish loading, so doctors see a blank space.',
        technical_diagnosis: 'jobList is not defined at js/career-list.js:212.',
        proposed_fix: 'Rename the reference on line 212.',
        risk_class: 'safe_auto', risk_reason: 'Small and self-contained.',
        occurrence_count: 12, affected_users: 4,
        approval_token_hash: hash(TOK_A),
        approval_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
        approval_token_used_at: null,
        created_at: '2026-07-20T00:00:00Z'
      },
      {
        id: 'prop-b', error_hash: 'hash-b', status: 'proposed',
        error_message: 'Cannot read properties of undefined', page_url: '/pages/index.html',
        plain_explanation: 'The home page sometimes fails to show the next step.',
        technical_diagnosis: 'Missing null check.', proposed_fix: 'Add a guard.',
        risk_class: 'needs_review', risk_reason: 'The AI asked for a person to check this one.',
        occurrence_count: 3, affected_users: 1,
        created_at: '2026-07-20T00:00:01Z'
      },
      {
        id: 'prop-exp', error_hash: 'hash-exp', status: 'proposed',
        error_message: 'boom', page_url: '/pages/amc.html',
        plain_explanation: 'Something on the AMC page fails.',
        technical_diagnosis: 'x is not defined.', proposed_fix: 'Declare x.',
        risk_class: 'needs_review', risk_reason: 'n/a',
        occurrence_count: 1, affected_users: 1,
        approval_token_hash: hash(TOK_EXPIRED),
        approval_token_expires_at: new Date(Date.now() - 60000).toISOString(),
        approval_token_used_at: null,
        created_at: '2026-07-20T00:00:02Z'
      },
      {
        id: 'prop-shipped', error_hash: 'hash-shipped', status: 'shipped',
        error_message: 'old', page_url: '/pages/visa.html',
        plain_explanation: 'Already fixed.', technical_diagnosis: 'x', proposed_fix: 'y',
        risk_class: 'safe_auto', risk_reason: 'n/a',
        occurrence_count: 1, affected_users: 1,
        created_at: '2026-07-19T00:00:00Z'
      }
    ]
  }));
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'error-fix-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.AUTH_DISABLED = 'true'; // BUILD 1: reach page routes without a sign-in bounce
  seedDb();

  const mod = await import('../server.js');
  ef = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── BUILD 1 ────────────────────────────────────────────────────────────────

describe('isHtmlPageNavigation', () => {
  const nav = (headers, p) => ef.isHtmlPageNavigation({ method: 'GET', headers }, p);

  it('is true for a browser navigation to a page', () => {
    expect(nav({ 'sec-fetch-dest': 'document' }, '/pages/nope.html')).toBe(true);
    expect(nav({ 'sec-fetch-dest': 'iframe' }, '/pages/nope.html')).toBe(true);
    expect(nav({ accept: 'text/html,application/xhtml+xml' }, '/pages/nope')).toBe(true);
  });

  it('is NEVER true for /api/, API 404s must stay JSON', () => {
    expect(nav({ 'sec-fetch-dest': 'document', accept: 'text/html' }, '/api/anything')).toBe(false);
    expect(nav({ accept: 'text/html' }, '/api/career/applications')).toBe(false);
  });

  it('is false for assets, so a <script src> never receives HTML', () => {
    expect(nav({ 'sec-fetch-dest': 'script' }, '/js/missing.js')).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'style' }, '/css/missing.css')).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'image' }, '/media/images/missing.png')).toBe(false);
    expect(nav({ 'sec-fetch-dest': 'font' }, '/assets/x.woff2')).toBe(false);
    // Extension check catches it even when the header is absent.
    expect(nav({ accept: 'text/html' }, '/js/missing.js')).toBe(false);
    expect(nav({ accept: 'text/html' }, '/media/images/x.png')).toBe(false);
  });

  it('is false for fetch/XHR (Accept: */*, dest empty)', () => {
    expect(nav({ 'sec-fetch-dest': 'empty', accept: '*/*' }, '/pages/x.html')).toBe(false);
    expect(nav({ accept: '*/*' }, '/pages/x.html')).toBe(false);
  });

  it('is false for non-GET', () => {
    expect(ef.isHtmlPageNavigation({ method: 'POST', headers: { 'sec-fetch-dest': 'document' } }, '/pages/x.html')).toBe(false);
    expect(ef.isHtmlPageNavigation({ method: 'HEAD', headers: { 'sec-fetch-dest': 'document' } }, '/pages/x.html')).toBe(false);
  });
});

describe('unknown page requests serve pages/error.html', () => {
  it('serves the friendly page with a 404 status (not 200)', async () => {
    const r = await req('GET', '/pages/definitely-not-a-page', { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
    expect(r.status).toBe(404); // monitoring must still see a 404
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.raw).toMatch(/We couldn.?t load this page|refreshBtn/);
  });

  it('preserves the attempted path as ?from= for the Refresh button', async () => {
    const r = await req('GET', '/pages/gone?x=1', { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(r.raw).toContain('history.replaceState');
    expect(r.raw).toContain(encodeURIComponent('/pages/gone?x=1'));
  });

  it('does NOT serve HTML for a missing asset', async () => {
    const r = await req('GET', '/js/not-a-real-script.js', { headers: { 'Sec-Fetch-Dest': 'script', Accept: '*/*' } });
    expect(r.status).toBe(404);
    expect(r.raw).toBe('Not found');
  });

  it('does NOT serve HTML for an unknown /api/ route, JSON 404 is preserved', async () => {
    const r = await req('GET', '/api/definitely-not-a-route', { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.raw).not.toMatch(/<html/i);
  });

  it('an /api/ 404 for a missing record is untouched JSON', async () => {
    const r = await req('GET', '/api/error-fix/nope', { headers: { Accept: 'text/html' } });
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });

  it('a real page still serves normally', async () => {
    const r = await req('GET', '/pages/error', { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
    expect(r.status).toBe(200);
  });
});

// ── BUILD 3 ────────────────────────────────────────────────────────────────

describe('cron registration', () => {
  it('error-fix-analysis is heartbeat-tracked', () => {
    expect(ef.CRON_SCHEDULES['error-fix-analysis']).toEqual({ schedule: '10 21 * * *', cadenceMinutes: 1440 });
  });

  it('CRON_SCHEDULES and vercel.json agree on every job', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
    const fromVercel = {};
    vercel.crons.forEach((c) => { fromVercel[c.path.replace('/api/cron/', '')] = c.schedule; });
    expect(fromVercel['error-fix-analysis']).toBe('10 21 * * *');
    Object.keys(ef.CRON_SCHEDULES).forEach((name) => {
      expect(fromVercel[name], name + ' missing from vercel.json').toBe(ef.CRON_SCHEDULES[name].schedule);
    });
  });

  it('runs 30 minutes BEFORE the health digest', () => {
    const min = (s) => Number(s.split(' ')[0]);
    expect(min(ef.CRON_SCHEDULES['error-digest'].schedule) - min(ef.CRON_SCHEDULES['error-fix-analysis'].schedule)).toBe(30);
  });

  it('the cron endpoint refuses without the cron secret', async () => {
    const r = await req('GET', '/api/cron/error-fix-analysis');
    expect(r.status).toBe(401);
  });

  it('the per-run cap is set and small', () => {
    expect(ef.ERROR_FIX_MAX_PER_RUN).toBe(3);
  });

  it('uses Opus 4.8', () => {
    expect(ef.ERROR_FIX_MODEL).toBe('claude-opus-4-8');
  });
});

// ── BUILD 4/5: the email one-click flow ────────────────────────────────────

describe('GET /approve-fix, a link prefetcher CANNOT approve', () => {
  it('renders a confirm page and changes NOTHING', async () => {
    const before = await ef.getErrorFixProposalById('prop-a');
    expect(before.status).toBe('proposed');

    // Fetch it the way a mail scanner would: repeatedly, with a GET.
    for (let i = 0; i < 3; i++) {
      const r = await req('GET', '/approve-fix?token=' + TOK_A, { headers: { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } });
      expect(r.status).toBe(200);
      expect(r.raw).toMatch(/Approve this fix\?/);
      // The page must contain a FORM that posts, not a link that acts.
      expect(r.raw).toMatch(/<form[^>]+method="POST"[^>]+action="\/api\/error-fix\/approve"/);
      expect(r.headers['cache-control']).toMatch(/no-store/);
      expect(r.headers['x-robots-tag']).toMatch(/noindex/);
    }

    const after = await ef.getErrorFixProposalById('prop-a');
    expect(after.status).toBe('proposed');          // still not approved
    expect(after.approval_token_used_at).toBeFalsy(); // token still unused
    expect(after.approved_at).toBeFalsy();
  });

  it('the GET does not leak the plain-English detail of an invalid token', async () => {
    const r = await req('GET', '/approve-fix?token=' + crypto.randomBytes(32).toString('hex'), { headers: { Accept: 'text/html' } });
    expect(r.status).toBe(410);
    expect(r.raw).toMatch(/not valid/i);
    expect(r.raw).not.toMatch(/<form/);
  });

  it('an expired token shows an explanation and no form', async () => {
    const r = await req('GET', '/approve-fix?token=' + TOK_EXPIRED, { headers: { Accept: 'text/html' } });
    expect(r.status).toBe(410);
    expect(r.raw).toMatch(/expired/i);
    expect(r.raw).not.toMatch(/<form/);
  });

  it('rejects a non-GET on the confirm page itself', async () => {
    const r = await req('POST', '/approve-fix?token=' + TOK_A, { json: {} });
    expect(r.status).toBe(405);
  });
});

describe('POST /api/error-fix/approve, the token is SINGLE USE', () => {
  it('approves on the first POST', async () => {
    const r = await req('POST', '/api/error-fix/approve', { json: { token: TOK_A } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.approved).toBe(true);

    const row = await ef.getErrorFixProposalById('prop-a');
    expect(row.status).toBe('approved');
    expect(row.approval_token_used_at).toBeTruthy();
    expect(row.decision_source).toBe('email');
    expect(row.approved_by).toBeTruthy();
  });

  it('a SECOND POST with the same token is an idempotent no-op', async () => {
    const before = await ef.getErrorFixProposalById('prop-a');
    const r = await req('POST', '/api/error-fix/approve', { json: { token: TOK_A } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.approved).toBe(false);
    expect(r.body.already).toBe(true);

    const after = await ef.getErrorFixProposalById('prop-a');
    expect(after.status).toBe('approved');
    expect(after.approved_at).toBe(before.approved_at); // not re-stamped
  });

  it('refuses an unknown token', async () => {
    const r = await req('POST', '/api/error-fix/approve', { json: { token: crypto.randomBytes(32).toString('hex') } });
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it('refuses an expired token and says so', async () => {
    const r = await req('POST', '/api/error-fix/approve', { json: { token: TOK_EXPIRED } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('expired');
    expect((await ef.getErrorFixProposalById('prop-exp')).status).toBe('proposed');
  });

  it('refuses an empty body', async () => {
    const r = await req('POST', '/api/error-fix/approve', { json: {} });
    expect(r.status).toBe(400);
  });

  it('accepts a plain form POST too (works with JavaScript disabled)', async () => {
    // prop-exp is expired; mint a fresh token on prop-b instead.
    const tok = crypto.randomBytes(32).toString('hex');
    await ef.updateErrorFixProposal('prop-b', {
      approval_token_hash: hash(tok),
      approval_token_expires_at: new Date(Date.now() + 3600000).toISOString(),
      approval_token_used_at: null
    });
    const r = await req('POST', '/api/error-fix/approve', { form: { token: tok } });
    expect(r.status).toBe(200);
    expect(r.body.approved).toBe(true);
    expect((await ef.getErrorFixProposalById('prop-b')).status).toBe('approved');
  });
});

// ── BUILD 5: dashboard endpoints ───────────────────────────────────────────

describe('CEO endpoints are guarded', () => {
  for (const [method, p] of [
    ['GET', '/api/ceo/error-fix-proposals'],
    ['POST', '/api/ceo/error-fix-proposals/approve'],
    ['POST', '/api/ceo/error-fix-proposals/reject'],
    ['POST', '/api/ceo/error-fix-proposals/run']
  ]) {
    it(method + ' ' + p + ' rejects without a super-admin session', async () => {
      const r = await req(method, p, { json: {} });
      expect([401, 403, 302, 404]).toContain(r.status);
    });
  }
});

describe('GET /api/ceo/error-fix-proposals', () => {
  it('lists proposals with their full detail', async () => {
    const r = await req('GET', '/api/ceo/error-fix-proposals', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const byId = Object.fromEntries(r.body.proposals.map((p) => [p.id, p]));
    expect(byId['prop-a'].plain_explanation).toMatch(/blank space/);
    expect(byId['prop-a'].technical_diagnosis).toBeTruthy();
    expect(byId['prop-a'].proposed_fix).toBeTruthy();
    expect(byId['prop-a'].risk_class).toBe('safe_auto');
    expect(r.body.statuses).toContain('shipped');
    expect(r.body.risk_classes).toEqual(['safe_auto', 'needs_review']);
  });

  it('NEVER returns the approval token hash', async () => {
    const r = await req('GET', '/api/ceo/error-fix-proposals', { cookie: superCookie() });
    expect(r.raw).not.toContain('approval_token_hash');
    r.body.proposals.forEach((p) => expect(p.approval_token_hash).toBeUndefined());
  });

  it('filters by status', async () => {
    const r = await req('GET', '/api/ceo/error-fix-proposals?status=shipped', { cookie: superCookie() });
    expect(r.body.proposals.map((p) => p.id)).toEqual(['prop-shipped']);
  });

  it('ignores an unknown status rather than erroring', async () => {
    const r = await req('GET', '/api/ceo/error-fix-proposals?status=nonsense', { cookie: superCookie() });
    expect(r.status).toBe(200);
  });
});

describe('dashboard approve / reject', () => {
  it('rejects a proposal with a reason and records who', async () => {
    const r = await req('POST', '/api/ceo/error-fix-proposals/reject', {
      cookie: superCookie(), json: { id: 'prop-exp', reason: 'Not worth it' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = await ef.getErrorFixProposalById('prop-exp');
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('Not worth it');
    expect(row.rejected_by).toBe('super@gplink-test.local');
  });

  it('a token for a proposal already rejected on the dashboard is a no-op', async () => {
    const r = await req('POST', '/api/error-fix/approve', { json: { token: TOK_EXPIRED } });
    // expired takes precedence, but either way it must NOT flip a rejected row
    expect((await ef.getErrorFixProposalById('prop-exp')).status).toBe('rejected');
    expect(r.body.ok).toBe(false);
  });

  it('approving is idempotent from the dashboard too', async () => {
    await ef.insertErrorFixProposal({
      id: 'prop-d', error_hash: 'hash-d', status: 'proposed',
      plain_explanation: 'x', technical_diagnosis: 'y', proposed_fix: 'z',
      risk_class: 'needs_review', risk_reason: 'n/a'
    });
    const first = await req('POST', '/api/ceo/error-fix-proposals/approve', { cookie: superCookie(), json: { id: 'prop-d' } });
    expect(first.body.approved).toBe(1);
    const second = await req('POST', '/api/ceo/error-fix-proposals/approve', { cookie: superCookie(), json: { id: 'prop-d' } });
    expect(second.body.approved).toBe(0);
    expect(second.body.already).toBe(1);
    const row = await ef.getErrorFixProposalById('prop-d');
    expect(row.status).toBe('approved');
    expect(row.decision_source).toBe('dashboard');
  });

  it('reject requires an id', async () => {
    const r = await req('POST', '/api/ceo/error-fix-proposals/reject', { cookie: superCookie(), json: {} });
    expect(r.status).toBe(400);
  });
});

describe('idempotency: one open proposal per error_hash', () => {
  it('refuses a second open proposal for the same error', async () => {
    const first = await ef.insertErrorFixProposal({
      error_hash: 'dup-hash', status: 'proposed',
      plain_explanation: 'a', technical_diagnosis: 'b', proposed_fix: 'c',
      risk_class: 'needs_review', risk_reason: 'n/a'
    });
    expect(first.ok).toBe(true);
    const second = await ef.insertErrorFixProposal({
      error_hash: 'dup-hash', status: 'proposed',
      plain_explanation: 'a', technical_diagnosis: 'b', proposed_fix: 'c',
      risk_class: 'needs_review', risk_reason: 'n/a'
    });
    expect(second.ok).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('allows a new proposal once the previous one is closed', async () => {
    const closed = await ef.insertErrorFixProposal({
      error_hash: 'closed-hash', status: 'shipped',
      plain_explanation: 'a', technical_diagnosis: 'b', proposed_fix: 'c',
      risk_class: 'safe_auto', risk_reason: 'n/a'
    });
    expect(closed.ok).toBe(true);
    const again = await ef.insertErrorFixProposal({
      error_hash: 'closed-hash', status: 'proposed',
      plain_explanation: 'a', technical_diagnosis: 'b', proposed_fix: 'c',
      risk_class: 'needs_review', risk_reason: 'n/a'
    });
    expect(again.ok).toBe(true);
  });
});

describe('the fix executor is wired to approval, but does not run inside it', () => {
  // The executor is implemented (see tests/error-fix-executor*.test.js). What
  // matters HERE is that approving does not drag GitHub or Anthropic into the
  // owner's button press.
  it('approval only QUEUES, it never does the work inline', async () => {
    const out = await ef.dispatchApprovedFixProposal({ id: 'prop-a', risk_class: 'safe_auto' }, { queueOnly: true });
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe('queued');
  });

  it('approval never fills in branch/PR, that is the executor cron’s job', async () => {
    const row = await ef.getErrorFixProposalById('prop-a');
    expect(row.branch_name).toBeFalsy();
    expect(row.pr_url).toBeFalsy();
  });

  it('a proposal that is not `approved` cannot be claimed for execution', async () => {
    // prop-shipped is a closed status; a missing id is not claimable at all.
    expect(await ef.claimFixProposalForExecution('prop-shipped')).toBe(null);
    expect(await ef.claimFixProposalForExecution('does-not-exist')).toBe(null);
    expect(await ef.claimFixProposalForExecution('')).toBe(null);
  });

  it('a row can only be claimed ONCE, the second attempt gets nothing', async () => {
    const row = await ef.getErrorFixProposalById('prop-b');
    if (row.status !== 'approved') {
      await ef.updateErrorFixProposal('prop-b', { status: 'approved' });
    }
    expect(await ef.claimFixProposalForExecution('prop-b')).toBeTruthy();
    // Now in_progress, a second cron must not pick it up as well.
    expect(await ef.claimFixProposalForExecution('prop-b')).toBe(null);
    expect((await ef.getErrorFixProposalById('prop-b')).status).toBe('in_progress');
  });

  it('the executor cron refuses without the cron secret', async () => {
    const r = await req('GET', '/api/cron/error-fix-execute');
    expect(r.status).toBe(401);
  });

  it('error-fix-execute is heartbeat-tracked and hourly', () => {
    expect(ef.CRON_SCHEDULES['error-fix-execute']).toEqual({ schedule: '25 * * * *', cadenceMinutes: 60 });
  });
});

describe('the migration exists and matches what the code reads', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260720120000_error_fix_proposals.sql'), 'utf8');

  it('creates the table with the partial unique index that gives idempotency', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.error_fix_proposals/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS error_fix_proposals_one_open_per_hash/);
    expect(sql).toMatch(/WHERE status IN \('proposed', 'approved', 'in_progress'\)/);
  });

  it('constrains status and risk_class to the values the code uses', () => {
    ef.CRON_SCHEDULES && null;
    const efLib = require('../lib/error-fix-proposals.js');
    efLib.PROPOSAL_STATUSES.forEach((s) => expect(sql).toContain("'" + s + "'"));
    efLib.RISK_CLASSES.forEach((r) => expect(sql).toContain("'" + r + "'"));
  });

  it('has the columns the executor agent will fill in', () => {
    ['branch_name', 'pr_url', 'execution_started_at', 'execution_finished_at', 'execution_error'].forEach((c) => {
      expect(sql).toContain(c);
    });
  });

  it('stores only the token HASH, never the token', () => {
    expect(sql).toContain('approval_token_hash');
    expect(sql).not.toMatch(/approval_token\s+TEXT/);
  });
});
