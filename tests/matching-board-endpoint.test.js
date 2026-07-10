// Task 4 (2026-07-11 matching-board/nudges plan) — GET /api/ats/matching/board.
//
// The ONE aggregate read behind the Matching board UI: open jobs + days_open,
// each job's live pipeline, cached AI suggestions (any age — stale is fine),
// KPI counts, and recently-filled jobs, in a single call that must NEVER
// trigger an Anthropic call. Boots the real server against a tiny in-memory
// PostgREST emulator (same technique as tests/ai-matching-cron.test.js, whose
// buildMatcher supports gt/gte/lt/lte + "not." negation — this endpoint's
// filled-in-last-30-days / accepted-in-last-7-days windows need real date
// comparisons, not just eq/in). Admin session cookie pattern copied from
// tests/ai-candidate-job-match.test.js Part B.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'matching-board-test.local';
const SUPER_EMAIL = 'super@gplink-test.local';
let server, port;
let sbServer, sbPort;
let realFetch;
let anthropicCallCount = 0;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// `bufferHours` nudges the timestamp a little further into the past than the
// exact day boundary so Math.floor((now-then)/86400000) lands on the whole
// day we intend even after a few ms/seconds of real request latency.
const daysAgo = (n, bufferHours = 2) => iso(NOW - (n * 86400000 + bufferHours * 3600000));
const hoursAgo = (n) => iso(NOW - n * 3600000);

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-cron.test.js) ───
const db = {
  user_profiles: [
    { user_id: 'gp-a1', email: 'a1@test.local', first_name: 'Awaiting', last_name: 'Shortlist' },
    { user_id: 'gp-a2', email: 'a2@test.local', first_name: 'Interview', last_name: 'Stage' },
    { user_id: 'gp-a3', email: 'a3@test.local', first_name: 'Accepted', last_name: 'Recent' },
    { user_id: 'gp-a4', email: 'a4@test.local', first_name: 'Declined', last_name: 'Terminal' },
    { user_id: 'gp-a5', email: 'a5@test.local', first_name: 'Accepted', last_name: 'OldWindow' },
    { user_id: 'gp-fresh-1', email: 'fresh1@test.local', first_name: 'Fresh', last_name: 'Suggestion' },
    { user_id: 'gp-hired', email: 'hired@test.local', first_name: 'Hired', last_name: 'Doctor' },
    { user_id: 'gp-r1', email: 'r1@test.local', first_name: 'Redirected', last_name: 'One' },
    { user_id: 'gp-r2', email: 'r2@test.local', first_name: 'Redirected', last_name: 'Two' },
    // direction=gps candidates
    { user_id: 'gp-cand-live', email: 'candlive@test.local', first_name: 'Candlive', last_name: 'Pipeline' },
    { user_id: 'gp-cand-cached', email: 'candcached@test.local', first_name: 'Candcached', last_name: 'Suggestion' },
    { user_id: 'gp-cand-old', email: 'candold@test.local', first_name: 'Candold', last_name: 'NoSignal' },
    { user_id: 'gp-cand-new', email: 'candnew@test.local', first_name: 'Candnew', last_name: 'NoSignal' },
    { user_id: 'gp-cand-search', email: 'priya.wozniak@test.local', first_name: 'Priya', last_name: 'Wozniak' }
  ],
  user_state: [],
  user_documents: [],
  career_interviews: [],
  registration_cases: [],
  rso_team: [],
  practices: [
    { id: 'prac-open', name: 'Open Roles Practice' },
    { id: 'prac-filled', name: 'Filled Roles Practice' }
  ],
  career_roles: [
    {
      id: 'job-74d', title: 'GP — Long Open Role', practice_id: 'prac-open', practice_name: '',
      location_city: 'Bundaberg', location_state: 'QLD', suburb: 'Bargara', employment_type: 'Permanent',
      dpa: true, header_image_url: 'https://images.gplink-test.local/bargara.jpg',
      job_status: 'open', is_active: true,
      published_at: daysAgo(74), created_at: daysAgo(74)
    },
    {
      id: 'job-41d', title: 'GP — Newer Open Role', practice_id: 'prac-open', practice_name: '',
      location_city: 'Toowoomba', location_state: 'QLD', suburb: '', employment_type: 'Permanent',
      dpa: false, header_image_url: '',
      job_status: 'open', is_active: true,
      published_at: daysAgo(41), created_at: daysAgo(41)
    },
    {
      id: 'job-filled-5d', title: 'GP — Filled Role', practice_id: 'prac-filled', practice_name: '',
      location_city: 'Rockhampton', location_state: 'QLD', suburb: '', employment_type: 'Permanent',
      dpa: true, header_image_url: '',
      job_status: 'filled', is_active: false,
      published_at: daysAgo(90), created_at: daysAgo(90), updated_at: daysAgo(5)
    },
    {
      id: 'job-filled-40d', title: 'GP — Old Filled Role', practice_id: 'prac-filled', practice_name: '',
      location_city: 'Gladstone', location_state: 'QLD', suburb: '', employment_type: 'Permanent',
      dpa: false, header_image_url: '',
      job_status: 'filled', is_active: false,
      published_at: daysAgo(120), created_at: daysAgo(120), updated_at: daysAgo(40)
    }
  ],
  gp_applications: [
    // job-74d pipeline — deliberately spans multiple stages.
    {
      id: 'app-a1', user_id: 'gp-a1', career_role_id: 'job-74d',
      ats_stage: 'shortlisted', ats_stage_updated_at: hoursAgo(20),
      match_score: 82, matched_at: daysAgo(2), match_expires_at: iso(NOW + 3 * 86400000),
      match_seen_at: null, match_outcome: null,
      match_reminder_sent_at: daysAgo(1), match_final_reminder_sent_at: null, match_more_time_requested_at: hoursAgo(12)
    },
    {
      id: 'app-a2', user_id: 'gp-a2', career_role_id: 'job-74d',
      ats_stage: 'interview', ats_stage_updated_at: hoursAgo(5),
      match_score: null, matched_at: null, match_expires_at: null, match_seen_at: null, match_outcome: null,
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    // Accepted THIS week — counts toward kpis.accepted_week.
    {
      id: 'app-a3', user_id: 'gp-a3', career_role_id: 'job-74d',
      ats_stage: 'applied', ats_stage_updated_at: daysAgo(2),
      match_score: 75, matched_at: daysAgo(9), match_expires_at: daysAgo(2), match_seen_at: daysAgo(3),
      match_outcome: 'accepted', match_reminder_sent_at: daysAgo(3), match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    // Terminal (declined) — excluded from pipeline AND from suggestions.
    {
      id: 'app-a4', user_id: 'gp-a4', career_role_id: 'job-74d',
      ats_stage: 'not_proceeding', ats_stage_updated_at: daysAgo(6),
      match_score: 60, matched_at: daysAgo(10), match_expires_at: daysAgo(6), match_seen_at: daysAgo(7),
      match_outcome: 'declined', match_reminder_sent_at: daysAgo(7), match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    // Accepted OUTSIDE the 7-day window — must NOT count toward accepted_week.
    {
      id: 'app-a5', user_id: 'gp-a5', career_role_id: 'job-74d',
      ats_stage: 'applied', ats_stage_updated_at: daysAgo(10),
      match_score: 70, matched_at: daysAgo(20), match_expires_at: daysAgo(10), match_seen_at: daysAgo(11),
      match_outcome: 'accepted', match_reminder_sent_at: daysAgo(11), match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    // job-filled-5d: one hire + two redirected.
    {
      id: 'app-hired', user_id: 'gp-hired', career_role_id: 'job-filled-5d',
      ats_stage: 'hired', ats_stage_updated_at: daysAgo(5),
      match_score: null, matched_at: null, match_expires_at: null, match_seen_at: null, match_outcome: null,
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    {
      id: 'app-r1', user_id: 'gp-r1', career_role_id: 'job-filled-5d',
      ats_stage: 'not_proceeding', ats_stage_updated_at: daysAgo(5),
      match_score: null, matched_at: daysAgo(15), match_expires_at: daysAgo(5), match_seen_at: null,
      match_outcome: 'position_filled', match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null
    },
    {
      id: 'app-r2', user_id: 'gp-r2', career_role_id: 'job-filled-5d',
      ats_stage: 'not_proceeding', ats_stage_updated_at: daysAgo(5),
      match_score: null, matched_at: daysAgo(16), match_expires_at: daysAgo(5), match_seen_at: null,
      match_outcome: 'position_filled', match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null
    }
  ],
  // job-74d's stale (80h old) cached ranking: one candidate already in the
  // live pipeline (gp-a2, interview), one with a terminal-outcome match on
  // THIS job (gp-a4, declined), one genuinely fresh suggestion (gp-fresh-1).
  match_cache: [
    {
      id: 'cache-job-74d', subject_type: 'job', subject_id: 'job-74d',
      generated_at: hoursAgo(80),
      payload: {
        ranked: [
          { user_id: 'gp-a2', name: 'Interview Stage', score: 65, reasons: ['already interviewing'], chips: [] },
          { user_id: 'gp-a4', name: 'Declined Terminal', score: 55, reasons: ['declined earlier'], chips: [] },
          { user_id: 'gp-fresh-1', name: 'Fresh Suggestion', score: 90, reasons: ['great fit', 'DPA aligned', 'Preferred city'], chips: ['DPA eligible role'] }
        ],
        excluded_count: 4
      }
    }
  ],
  ats_stage_events: [],
  runtime_kv: []
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
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
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
        const saved = incoming.map((r) => {
          const row = { id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
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
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let body = null; try { body = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body, raw }); });
    });
    r.on('error', reject); r.end();
  });
}
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'matching-board-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_MATCH_MODEL = 'claude-test-match-model';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';

  // Any outbound call to Anthropic is a hard bug for this endpoint — the
  // board must ONLY ever read match_cache, never generate a fresh ranking.
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      anthropicCallCount++;
      return Promise.resolve(new Response(JSON.stringify({ content: [{ text: '{"ranked":[]}' }] }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('GET /api/ats/matching/board — auth', () => {
  it('rejects a request without a valid admin session', async () => {
    const r = await httpReq('GET', '/api/ats/matching/board', { host: SUPER_HOST });
    expect([302, 401, 403]).toContain(r.status);
  });
});

describe('GET /api/ats/matching/board — direction=positions (default)', () => {
  it('returns the {ok, kpis, rows, filled} envelope, never calling Anthropic', async () => {
    const before = anthropicCallCount;
    const r = await atsGet('/api/ats/matching/board');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.rows)).toBe(true);
    expect(Array.isArray(r.body.filled)).toBe(true);
    expect(typeof r.body.kpis).toBe('object');
    expect(anthropicCallCount).toBe(before);
  });

  it('sorts rows by days_open desc and computes whole-day math', async () => {
    const r = await atsGet('/api/ats/matching/board');
    expect(r.body.rows.length).toBe(2);
    expect(r.body.rows[0].job.id).toBe('job-74d');
    expect(r.body.rows[0].job.days_open).toBe(74);
    expect(r.body.rows[0].job.header_image_url).toBe('https://images.gplink-test.local/bargara.jpg');
    expect(r.body.rows[1].job.id).toBe('job-41d');
    expect(r.body.rows[1].job.days_open).toBe(41);
  });

  it('job-74d pipeline: spans multiple stages (offer-first ordering), excludes not_proceeding, and carries the full match{} node', async () => {
    const r = await atsGet('/api/ats/matching/board');
    const pipeline = r.body.rows[0].pipeline;
    // a1 shortlisted, a2 interview, a3+a5 applied — a4 (not_proceeding) excluded.
    expect(pipeline.length).toBe(4);
    expect(pipeline.map((p) => p.user_id)).not.toContain('gp-a4');
    // Board display order: closest-to-hire first (interview) ... shortlisted last.
    expect(pipeline[0].ats_stage).toBe('interview');
    expect(pipeline[pipeline.length - 1].ats_stage).toBe('shortlisted');

    const a1 = pipeline.find((p) => p.user_id === 'gp-a1');
    expect(a1.name).toBe('Awaiting Shortlist');
    expect(a1.match.score).toBe(82);
    expect(a1.match.outcome).toBeNull();
    expect(a1.match.expires_at).toBeTruthy();
    expect(a1.match.reminder_sent_at).toBeTruthy();
    expect(a1.match.final_reminder_sent_at).toBeNull();
    expect(a1.match.more_time_requested_at).toBeTruthy();

    // A plain (never-matched) applicant carries match:null.
    const a2 = pipeline.find((p) => p.user_id === 'gp-a2');
    expect(a2.match).toBeNull();
  });

  it('job-74d suggestions exclude the live-pipeline candidate AND the terminal-outcome (declined) candidate, keeping only the fresh one; ranking.age_hours is an integer >= 72', async () => {
    const r = await atsGet('/api/ats/matching/board');
    const row = r.body.rows[0];
    expect(row.suggestions.length).toBe(1);
    expect(row.suggestions[0].user_id).toBe('gp-fresh-1');
    expect(row.suggestions[0].score).toBe(90);
    expect(row.ranking).not.toBeNull();
    expect(Number.isInteger(row.ranking.age_hours)).toBe(true);
    expect(row.ranking.age_hours).toBeGreaterThanOrEqual(72);
    expect(row.ranking.excluded_count).toBe(4);
  });

  it('job-41d (no cache): ranking is null, suggestions is empty, pipeline is empty', async () => {
    const r = await atsGet('/api/ats/matching/board');
    const row = r.body.rows[1];
    expect(row.ranking).toBeNull();
    expect(row.suggestions).toEqual([]);
    expect(row.pipeline).toEqual([]);
  });

  it('kpis: open jobs, 60-day-unfilled, live-shortlisted-awaiting, and accepted-this-week', async () => {
    const r = await atsGet('/api/ats/matching/board');
    expect(r.body.kpis.open).toBe(2);
    expect(r.body.kpis.unfilled60).toBe(1); // only job-74d (74 >= 60)
    expect(r.body.kpis.awaiting).toBe(1); // app-a1, the only live 'shortlisted' row
    expect(r.body.kpis.accepted_week).toBe(1); // app-a3 (2d ago); app-a5 (10d ago) excluded
  });

  it('filled: last-30-day window, hired name, and redirected_count — a 40-day-old fill is absent', async () => {
    const r = await atsGet('/api/ats/matching/board');
    expect(r.body.filled.length).toBe(1);
    const row = r.body.filled[0];
    expect(row.job.id).toBe('job-filled-5d');
    expect(row.hired).toBeTruthy();
    expect(row.hired.name).toBe('Hired Doctor');
    expect(row.hired.at).toBeTruthy();
    expect(row.redirected_count).toBe(2);
    expect(r.body.filled.find((f) => f.job.id === 'job-filled-40d')).toBeUndefined();
  });
});

describe('GET /api/ats/matching/board?direction=gps', () => {
  const LIVE = 'gp-cand-live';
  const CACHED = 'gp-cand-cached';
  const OLD = 'gp-cand-old';
  const NEWC = 'gp-cand-new';
  const SEARCH = 'gp-cand-search';

  beforeAll(() => {
    // A dedicated open job for CAND_LIVE's live application, kept separate
    // from job-74d/job-41d so the positions-direction assertions above (run
    // first) stay untouched by this describe block's fixtures.
    db.career_roles.push({
      id: 'job-cand', title: 'GP — Candidate Job', practice_id: '', practice_name: 'Cand Practice',
      location_city: 'Cairns', location_state: 'QLD', employment_type: 'Permanent',
      dpa: true, header_image_url: '', job_status: 'open', is_active: true,
      published_at: daysAgo(10), created_at: daysAgo(10)
    });
    db.registration_cases.push(
      { id: 'case-cand-live', user_id: LIVE, created_at: daysAgo(3) },
      { id: 'case-cand-cached', user_id: CACHED, created_at: daysAgo(1) },
      { id: 'case-cand-old', user_id: OLD, created_at: daysAgo(20) },
      { id: 'case-cand-new', user_id: NEWC, created_at: daysAgo(2) },
      { id: 'case-cand-search', user_id: SEARCH, created_at: daysAgo(1) }
    );
    db.gp_applications.push({
      id: 'app-cand-live', user_id: LIVE, career_role_id: 'job-cand',
      ats_stage: 'interview', ats_stage_updated_at: hoursAgo(4),
      match_score: null, matched_at: null, match_expires_at: null, match_seen_at: null, match_outcome: null,
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null
    });
    db.match_cache.push({
      id: 'cache-gp-cand-cached', subject_type: 'gp', subject_id: CACHED,
      generated_at: hoursAgo(50),
      payload: {
        ranked: [
          { career_role_id: 'job-74d', title: 'GP — Long Open Role', practice_name: 'Open Roles Practice', score: 88, reasons: ['great fit', 'timeline', 'location'], chips: ['DPA eligible role'] }
        ],
        excluded_count: 2
      }
    });
  });

  it('mirrors the shape with gp-shaped rows (days_on_books, live entries, subject_type=gp suggestions), signal-first then oldest-first ordering, never calling Anthropic', async () => {
    const before = anthropicCallCount;
    const r = await atsGet('/api/ats/matching/board?direction=gps');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(anthropicCallCount).toBe(before);

    const byId = {};
    r.body.rows.forEach((row) => { byId[row.gp.user_id] = row; });
    expect(r.body.rows.length).toBe(5);

    expect(byId[LIVE]).toBeTruthy();
    expect(byId[LIVE].gp.days_on_books).toBeGreaterThanOrEqual(2);
    expect(byId[LIVE].live.length).toBe(1);
    expect(byId[LIVE].live[0].ats_stage).toBe('interview');
    expect(byId[LIVE].live[0].title).toBe('GP — Candidate Job');
    expect(byId[LIVE].live[0].match).toBeNull();

    expect(byId[CACHED].ranking).not.toBeNull();
    expect(Number.isInteger(byId[CACHED].ranking.age_hours)).toBe(true);
    expect(byId[CACHED].ranking.age_hours).toBeGreaterThanOrEqual(49);
    expect(byId[CACHED].suggestions.length).toBe(1);
    expect(byId[CACHED].suggestions[0].career_role_id).toBe('job-74d');
    expect(byId[CACHED].suggestions[0].score).toBe(88);

    expect(byId[OLD].live).toEqual([]);
    expect(byId[OLD].ranking).toBeNull();
    expect(byId[OLD].suggestions).toEqual([]);

    // Signal (live app or cached ranking) sorts before no-signal candidates;
    // among no-signal candidates, oldest registration_cases.created_at first.
    const idx = (uid) => r.body.rows.findIndex((row) => row.gp.user_id === uid);
    expect(idx(LIVE)).toBeLessThan(idx(OLD));
    expect(idx(CACHED)).toBeLessThan(idx(OLD));
    expect(idx(OLD)).toBeLessThan(idx(NEWC));
  });

  it('q= filters candidates by name/email server-side', async () => {
    const r = await atsGet('/api/ats/matching/board?direction=gps&q=wozniak');
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBe(1);
    expect(r.body.rows[0].gp.user_id).toBe(SEARCH);
    expect(r.body.rows[0].gp.name).toBe('Priya Wozniak');
  });
});
