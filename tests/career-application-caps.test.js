// Career application caps (owner rules, 2026-07-31):
//   * at most TWO LIVE applications at a time;
//   * at most THREE applications STARTED per calendar month;
//   * an UNANSWERED team match counts towards neither;
//   * withdrawing frees a live slot but never refunds the month's quota.
//
// Exercised against the REAL handlers (a Supabase-mode boot backed by the
// in-memory PostgREST emulator) with real GP sessions, the same harness
// tests/ai-matching-caps.test.js uses — the caps are only worth pinning where
// they actually run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-application-caps-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
let realFetch;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
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

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-caps.test.js) ──
const db = {
  user_profiles: [],
  user_state: [],
  user_documents: [],
  registration_cases: [],
  ats_stage_events: [],
  career_roles: [],
  gp_applications: [],
  career_interviews: [],
  scheduled_calls: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    let negate = false;
    let rest = raw;
    if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
    const dot = rest.indexOf('.');
    const op = dot > 0 ? rest.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = rest.slice(dot + 1);
    filters.push({ col: key, op, val, negate });
  }
  function coerce(cell, val) {
    if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cell) && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return [Date.parse(cell), Date.parse(val)];
    }
    const cellNum = Number(cell), valNum = Number(val);
    if (cell !== null && cell !== undefined && cell !== '' && !Number.isNaN(cellNum) && !Number.isNaN(valNum)) {
      return [cellNum, valNum];
    }
    return [String(cell), val];
  }
  return (row) => filters.every(({ col, op, val, negate }) => {
    const cell = row ? row[col] : undefined;
    let result;
    if (op === 'eq') result = String(cell) === val;
    else if (op === 'neq') result = String(cell) !== val;
    else if (op === 'is') result = val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    else if (op === 'in') {
      result = val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) { result = false; }
      else {
        const [a, b] = coerce(cell, val);
        if (op === 'gt') result = a > b;
        else if (op === 'gte') result = a >= b;
        else if (op === 'lt') result = a < b;
        else result = a <= b;
      }
    } else {
      result = true;
    }
    return negate ? !result : result;
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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
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
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          // Real Postgres defaults gp_applications.ats_stage to 'applied'
          // (migration 20260627100200) when an insert omits it, and
          // /api/career/apply's insert payload never sets it — the emulator has
          // to mirror that DEFAULT or the active cap would under-count every
          // genuinely self-applied row.
          if (m[1] === 'gp_applications' && !row.ats_stage) row.ats_stage = 'applied';
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

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'career-application-caps-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.CONSULTANT_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const uStr = String(url && url.url ? url.url : url);
    if (uStr.startsWith('https://api.resend.com/')) {
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-stub' }), { status: 200 }));
    }
    if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(uStr)) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// A GP who passes every apply gate: onboarding complete, career_cv uploaded,
// Australia-trained (sidesteps the DPA gate entirely).
function seedGp(userId, email) {
  const NOW = new Date().toISOString();
  db.user_profiles.push({ user_id: userId, email, first_name: 'Test', last_name: 'Doctor', registration_country: 'australia' });
  db.user_state.push({ user_id: userId, state: { gp_onboarding_complete: true }, updated_at: NOW });
  db.user_documents.push({ id: 'doc-cv-' + userId, user_id: userId, document_key: 'career_cv', status: 'uploaded', updated_at: NOW });
}
function seedRole(id, providerRoleId, extra) {
  db.career_roles.push(Object.assign({
    id, provider: 'internal_ats', provider_role_id: providerRoleId,
    title: 'General Practitioner — VR', practice_name: 'Test Practice ' + id,
    is_active: true, job_status: 'open', ats_created: true, updated_at: new Date().toISOString()
  }, extra || {}));
}
// A LIVE, unanswered team match: the row exists (so its applied_at DEFAULT has
// already fired) but the doctor has not accepted or declined it.
function seedPendingMatch(id, userId, careerRoleId, providerRoleId) {
  db.gp_applications.push({
    id, user_id: userId, career_role_id: careerRoleId, provider_role_id: providerRoleId,
    status: 'shortlisted', ats_stage: 'shortlisted', origin: 'ai_matched',
    job_title: 'General Practitioner — VR',
    applied_at: new Date().toISOString(),
    matched_at: new Date().toISOString(),
    match_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
  });
}
function apply(gp, providerRoleId) {
  return httpReq('POST', '/api/career/apply', { cookie: userCookie(gp.email, gp.userId), body: { roleId: 'internal_ats:' + providerRoleId } });
}
function withdraw(gp, applicationId) {
  return httpReq('POST', '/api/career/application/withdraw', { cookie: userCookie(gp.email, gp.userId), body: { applicationId } });
}
function usage(gp) {
  return httpReq('GET', '/api/career/application-usage', { cookie: userCookie(gp.email, gp.userId) });
}
function appRowFor(gp, careerRoleId) {
  return db.gp_applications.find((a) => a.user_id === gp.userId && a.career_role_id === careerRoleId);
}
function monthWindow() {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
  };
}

const ACTIVE_MSG_APPLY = 'You already have 2 live applications. To apply for this position, withdraw one of your current applications first.';
const ACTIVE_MSG_MATCH = 'You already have 2 live applications. To accept this match, withdraw one of your current applications first.';

describe('Active cap: 2 live applications', () => {
  it('blocks a 3rd NEW application with 409 active_cap once 2 are live, and inserts nothing', async () => {
    const GP = { userId: 'u-ac-1', email: 'ac1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-ac1-a', 'ac1_a'); seedRole('role-ac1-b', 'ac1_b'); seedRole('role-ac1-c', 'ac1_c');

    expect((await apply(GP, 'ac1_a')).status).toBe(200);
    expect((await apply(GP, 'ac1_b')).status).toBe(200);

    const blocked = await apply(GP, 'ac1_c');
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error).toBe('active_cap');
    expect(blocked.body.activeUsed).toBe(2);
    expect(blocked.body.activeLimit).toBe(2);
    expect(blocked.body.message).toBe(ACTIVE_MSG_APPLY);
    // The blocked attempt left no row behind.
    expect(db.gp_applications.filter((a) => a.user_id === GP.userId).length).toBe(2);
    expect(appRowFor(GP, 'role-ac1-c')).toBeUndefined();
  });

  it('two PENDING (shortlisted, unanswered) matches do NOT consume live slots — a new application still goes through', async () => {
    const GP = { userId: 'u-ac-2', email: 'ac2@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-ac2-m1', 'ac2_m1'); seedRole('role-ac2-m2', 'ac2_m2'); seedRole('role-ac2-new', 'ac2_new');
    seedPendingMatch('app-ac2-m1', GP.userId, 'role-ac2-m1', 'ac2_m1');
    seedPendingMatch('app-ac2-m2', GP.userId, 'role-ac2-m2', 'ac2_m2');

    // Neither cap sees them: not live (outside ACTIVE_APPLICATION_STAGES), and
    // not started this month (their applied_at is only the row-creation stamp).
    const before = await usage(GP);
    expect(before.status).toBe(200);
    expect(before.body.active.used).toBe(0);
    expect(before.body.monthly.used).toBe(0);
    expect(before.body.canApply).toBe(true);

    const res = await apply(GP, 'ac2_new');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await usage(GP);
    expect(after.body.active.used).toBe(1);
    expect(after.body.monthly.used).toBe(1);
    // The matches are still sitting there, untouched and answerable.
    expect(db.gp_applications.find((a) => a.id === 'app-ac2-m1').ats_stage).toBe('shortlisted');
    expect(db.gp_applications.find((a) => a.id === 'app-ac2-m2').ats_stage).toBe('shortlisted');
  });
});

describe('Monthly cap: 3 applications per calendar month', () => {
  it('blocks a 4th application in the same month with 409 monthly_cap even with ZERO live applications', async () => {
    const GP = { userId: 'u-mc-1', email: 'mc1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    ['a', 'b', 'c', 'd'].forEach((k) => seedRole('role-mc1-' + k, 'mc1_' + k));

    // Three applications this month, staying inside the 2-live cap by
    // withdrawing as we go.
    expect((await apply(GP, 'mc1_a')).status).toBe(200);
    expect((await apply(GP, 'mc1_b')).status).toBe(200);
    expect((await withdraw(GP, appRowFor(GP, 'role-mc1-a').id)).status).toBe(200);
    expect((await apply(GP, 'mc1_c')).status).toBe(200);

    // Now withdraw the remaining two: zero live applications, but the month's
    // quota is spent.
    expect((await withdraw(GP, appRowFor(GP, 'role-mc1-b').id)).status).toBe(200);
    expect((await withdraw(GP, appRowFor(GP, 'role-mc1-c').id)).status).toBe(200);
    const meter = await usage(GP);
    expect(meter.body.active.used).toBe(0);
    expect(meter.body.monthly.used).toBe(3);
    expect(meter.body.canApply).toBe(false);

    const blocked = await apply(GP, 'mc1_d');
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error).toBe('monthly_cap');
    expect(blocked.body.monthlyUsed).toBe(3);
    expect(blocked.body.monthlyLimit).toBe(3);
    expect(blocked.body.resetsAt).toBe(monthWindow().end.toISOString());
    const expectedLabel = monthWindow().end.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    expect(blocked.body.message).toBe(
      'You have applied for 3 positions this month, which is the monthly limit. Your limit resets on ' + expectedLabel + '.'
    );
    // Nothing inserted for the blocked attempt.
    expect(appRowFor(GP, 'role-mc1-d')).toBeUndefined();
  });

  it('withdrawing frees an ACTIVE slot but does NOT refund the monthly quota', async () => {
    const GP = { userId: 'u-mc-2', email: 'mc2@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-mc2-a', 'mc2_a'); seedRole('role-mc2-b', 'mc2_b');

    expect((await apply(GP, 'mc2_a')).status).toBe(200);
    expect((await apply(GP, 'mc2_b')).status).toBe(200);
    const atCap = await usage(GP);
    expect(atCap.body.active.used).toBe(2);
    expect(atCap.body.monthly.used).toBe(2);
    expect(atCap.body.canApply).toBe(false);

    expect((await withdraw(GP, appRowFor(GP, 'role-mc2-a').id)).status).toBe(200);

    const afterWithdraw = await usage(GP);
    expect(afterWithdraw.body.active.used).toBe(1); // slot freed
    expect(afterWithdraw.body.monthly.used).toBe(2); // quota NOT refunded
    expect(afterWithdraw.body.canApply).toBe(true);
    // The withdrawn application is gone from the live list, by id.
    expect(afterWithdraw.body.active.applications.map((a) => a.roleId)).toEqual(['role-mc2-b']);
  });

  it('an unanswered match never spends the month\'s quota — accepting it is what does', async () => {
    const GP = { userId: 'u-mc-3', email: 'mc3@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-mc3-m', 'mc3_m');
    seedPendingMatch('app-mc3-m', GP.userId, 'role-mc3-m', 'mc3_m');

    expect((await usage(GP)).body.monthly.used).toBe(0);

    const accept = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(GP.email, GP.userId), body: { applicationId: 'app-mc3-m', action: 'accept' }
    });
    expect(accept.status).toBe(200);
    expect(accept.body.action).toBe('accept');

    const after = await usage(GP);
    expect(after.body.monthly.used).toBe(1);
    expect(after.body.active.used).toBe(1);
  });
});

describe('POST /api/career/match/respond — accept is capped, decline is not', () => {
  it('accept 409s with the MATCH wording at 2 live, leaves the match answerable, and decline still works', async () => {
    const GP = { userId: 'u-mr-1', email: 'mr1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-mr1-a', 'mr1_a'); seedRole('role-mr1-b', 'mr1_b'); seedRole('role-mr1-m', 'mr1_m');
    expect((await apply(GP, 'mr1_a')).status).toBe(200);
    expect((await apply(GP, 'mr1_b')).status).toBe(200);
    seedPendingMatch('app-mr1-m', GP.userId, 'role-mr1-m', 'mr1_m');

    const blocked = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(GP.email, GP.userId), body: { applicationId: 'app-mr1-m', action: 'accept' }
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('active_cap');
    // Accept wording, not apply wording — the doctor is answering a match here.
    expect(blocked.body.message).toBe(ACTIVE_MSG_MATCH);
    const untouched = db.gp_applications.find((a) => a.id === 'app-mr1-m');
    expect(untouched.ats_stage).toBe('shortlisted');
    expect(untouched.match_outcome == null).toBe(true);

    // DECLINE is deliberately uncapped — it reduces the doctor's commitments,
    // so a cap must never stand between them and saying no.
    const declined = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(GP.email, GP.userId), body: { applicationId: 'app-mr1-m', action: 'decline', reason: 'Too far from home' }
    });
    expect(declined.status).toBe(200);
    expect(declined.body.ok).toBe(true);
    expect(declined.body.action).toBe('decline');
    const declinedRow = db.gp_applications.find((a) => a.id === 'app-mr1-m');
    expect(declinedRow.ats_stage).toBe('not_proceeding');
    expect(declinedRow.match_outcome).toBe('declined');
  });
});

describe('GET /api/career/application-usage', () => {
  it('requires a session', async () => {
    const res = await httpReq('GET', '/api/career/application-usage');
    expect(res.status).toBe(401);
  });

  it('reports used/limit, lists the live applications newest-first, and MASKS the practice name until revealed', async () => {
    const GP = { userId: 'u-um-1', email: 'um1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-um1-a', 'um1_a', { practice_name: 'Erina Family Practice', suburb: 'Erina', location_state: 'NSW' });
    seedRole('role-um1-b', 'um1_b', { practice_name: 'Gosford Medical Centre', suburb: 'Gosford', location_state: 'NSW' });

    expect((await apply(GP, 'um1_a')).status).toBe(200);
    // Nudge the first row's applied_at back an hour so the newest-first order
    // is unambiguous (both applies land in the same millisecond otherwise).
    appRowFor(GP, 'role-um1-a').applied_at = new Date(Date.now() - 3600000).toISOString();
    expect((await apply(GP, 'um1_b')).status).toBe(200);

    const res = await usage(GP);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.active.limit).toBe(2);
    expect(res.body.active.used).toBe(2);
    expect(res.body.monthly).toEqual({ used: 2, limit: 3, resetsAt: monthWindow().end.toISOString() });
    expect(res.body.canApply).toBe(false);

    expect(res.body.active.applications.map((a) => a.roleId)).toEqual(['role-um1-b', 'role-um1-a']);
    const first = res.body.active.applications[0];
    expect(first.id).toBe(appRowFor(GP, 'role-um1-b').id);
    // Masked by default: the doctor has not earned the practice identity yet.
    expect(first.practiceName).toBe('Confidential practice');
    expect(first.revealed).toBe(false);
    // …but the role is still identifiable enough to choose between.
    expect(first.location).toBe('Gosford, NSW');
    expect(first.stage).toBe('applied');
    expect(first.stageLabel).toBe('Applied');
    expect(first.appliedAt).toBeTruthy();

    // Once THIS application earns the reveal, its real practice name appears —
    // and only its own; the other stays masked.
    appRowFor(GP, 'role-um1-b').revealed = true;
    const revealedRes = await usage(GP);
    const revealedFirst = revealedRes.body.active.applications.find((a) => a.roleId === 'role-um1-b');
    const stillMasked = revealedRes.body.active.applications.find((a) => a.roleId === 'role-um1-a');
    expect(revealedFirst.practiceName).toBe('Gosford Medical Centre');
    expect(revealedFirst.revealed).toBe(true);
    expect(stillMasked.practiceName).toBe('Confidential practice');
    expect(stillMasked.revealed).toBe(false);
  });

  it('degrades to the masked placeholder (never a 500) when the role row has gone missing', async () => {
    const GP = { userId: 'u-um-2', email: 'um2@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-um2-a', 'um2_a', { practice_name: 'Vanishing Practice', suburb: 'Woy Woy', location_state: 'NSW' });
    expect((await apply(GP, 'um2_a')).status).toBe(200);

    // The role row disappears (deleted/archived) after the application exists.
    db.career_roles.splice(db.career_roles.findIndex((r) => r.id === 'role-um2-a'), 1);

    const res = await usage(GP);
    expect(res.status).toBe(200);
    expect(res.body.active.used).toBe(1);
    const only = res.body.active.applications[0];
    expect(only.practiceName).toBe('Confidential practice');
    expect(only.revealed).toBe(false);
    expect(only.location).toBe('');
  });
});
