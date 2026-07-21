// Task 2 (AI Matching): lib/ai-candidate-job-match.js + the three
// /api/ats/matching/* endpoints.
//
// Part A (below) is pure unit tests no server, no network for the
// synchronous eligibility gate, the fence-stripping JSON parser, and the
// batching/graceful-degradation behaviour of the two AI ranking calls (via
// an injected `opts.fetchImpl`, so no real network or global.fetch patching
// is needed for these).
//
// Part B boots the real server against an in-memory PostgREST-shaped
// Supabase emulator (same technique as tests/ats-placement-accept.test.js)
// because every table this feature reads (user_profiles, user_state,
// user_documents, registration_cases, gp_applications, career_interviews,
// career_roles, match_cache) only has a real code path when
// `isSupabaseDbConfigured()` is true, there is no local-JSON fallback for
// these newer ATS tables. Outbound Anthropic calls are captured/stubbed by
// wrapping global fetch, same as the Resend-call pattern in sibling tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

import {
  checkMatchEligibility,
  parseMatchRanking,
  aiRankCandidatesForJob,
  aiRankJobsForGp
} from '../lib/ai-candidate-job-match.js';

// ─────────────────────────────────────────────────────────────────────────
// Part A: pure unit tests
// ─────────────────────────────────────────────────────────────────────────

describe('checkMatchEligibility, eligibility matrix', () => {
  const baseGp = () => ({
    onboardingComplete: true,
    hasCv: true,
    placed: false,
    liveApplicationRoleIds: [],
    atInterviewStage: false,
    careerLocked: false,
    accountStatus: 'active',
    dpaEligible: true
  });
  const baseJob = () => ({ id: 'job-1', dpa: true });

  it('is eligible when every gate passes', () => {
    expect(checkMatchEligibility(baseGp(), baseJob())).toEqual({ eligible: true, blocks: [] });
  });

  it('blocks onboarding_incomplete', () => {
    const r = checkMatchEligibility({ ...baseGp(), onboardingComplete: false }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['onboarding_incomplete'] });
  });

  it('blocks no_cv', () => {
    const r = checkMatchEligibility({ ...baseGp(), hasCv: false }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['no_cv'] });
  });

  it('blocks placed', () => {
    const r = checkMatchEligibility({ ...baseGp(), placed: true }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['placed'] });
  });

  it('blocks existing_application when the job id is in liveApplicationRoleIds', () => {
    const r = checkMatchEligibility({ ...baseGp(), liveApplicationRoleIds: ['job-1'] }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['existing_application'] });
  });

  it('does NOT block existing_application for a DIFFERENT job id', () => {
    const r = checkMatchEligibility({ ...baseGp(), liveApplicationRoleIds: ['some-other-job'] }, baseJob());
    expect(r).toEqual({ eligible: true, blocks: [] });
  });

  it('blocks at_interview_stage', () => {
    const r = checkMatchEligibility({ ...baseGp(), atInterviewStage: true }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['at_interview_stage'] });
  });

  it('blocks career_locked', () => {
    const r = checkMatchEligibility({ ...baseGp(), careerLocked: true }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['career_locked'] });
  });

  it('blocks account_not_active for a suspended/other non-active status', () => {
    const r = checkMatchEligibility({ ...baseGp(), accountStatus: 'suspended' }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['account_not_active'] });
  });

  it('blocks account_gated for under_review', () => {
    const r = checkMatchEligibility({ ...baseGp(), accountStatus: 'under_review' }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['account_gated'] });
  });

  it('blocks account_gated for pep_waitlist', () => {
    const r = checkMatchEligibility({ ...baseGp(), accountStatus: 'pep_waitlist' }, baseJob());
    expect(r).toEqual({ eligible: false, blocks: ['account_gated'] });
  });

  it('blocks dpa_ineligible on a non-DPA job for a non-Australia-trained GP', () => {
    const r = checkMatchEligibility({ ...baseGp(), dpaEligible: false }, { id: 'job-1', dpa: false });
    expect(r).toEqual({ eligible: false, blocks: ['dpa_ineligible'] });
  });

  it('does NOT block dpa_ineligible on a DPA job even for a non-Australia-trained GP', () => {
    const r = checkMatchEligibility({ ...baseGp(), dpaEligible: false }, { id: 'job-1', dpa: true });
    expect(r).toEqual({ eligible: true, blocks: [] });
  });

  it('collects every applicable block at once (not just the first)', () => {
    const r = checkMatchEligibility({ ...baseGp(), onboardingComplete: false, hasCv: false, placed: true }, baseJob());
    expect(r.eligible).toBe(false);
    expect(r.blocks).toEqual(['onboarding_incomplete', 'no_cv', 'placed']);
  });
});

describe('parseMatchRanking', () => {
  it('parses clean JSON', () => {
    const raw = '{"ranked":[{"id":"a","score":80,"reasons":["x","y","z"]}]}';
    expect(parseMatchRanking(raw)).toEqual({ ranked: [{ id: 'a', score: 80, reasons: ['x', 'y', 'z'] }] });
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n{"ranked":[{"id":"a","score":50,"reasons":["ok"]}]}\n```';
    expect(parseMatchRanking(raw)).toEqual({ ranked: [{ id: 'a', score: 50, reasons: ['ok'] }] });
  });

  it('extracts JSON wrapped in surrounding prose/junk', () => {
    const raw = 'Sure, here you go:\n{"ranked":[{"id":"a","score":70,"reasons":["fine"]}]}\nHope that helps!';
    expect(parseMatchRanking(raw)).toEqual({ ranked: [{ id: 'a', score: 70, reasons: ['fine'] }] });
  });

  it('returns null for unparseable garbage', () => {
    expect(parseMatchRanking('this is not json at all')).toBeNull();
  });

  it('returns null when "ranked" is missing or not an array', () => {
    expect(parseMatchRanking('{"foo":"bar"}')).toBeNull();
    expect(parseMatchRanking('{"ranked":"not-an-array"}')).toBeNull();
  });

  it('returns null for empty/falsy input', () => {
    expect(parseMatchRanking('')).toBeNull();
    expect(parseMatchRanking(null)).toBeNull();
    expect(parseMatchRanking(undefined)).toBeNull();
  });

  it('drops ranked entries missing an id', () => {
    const raw = '{"ranked":[{"score":50,"reasons":["x"]},{"id":"b","score":60,"reasons":["y"]}]}';
    expect(parseMatchRanking(raw)).toEqual({ ranked: [{ id: 'b', score: 60, reasons: ['y'] }] });
  });

  it('clamps score into 0-100 and rounds, nulls out non-numeric scores', () => {
    const raw = '{"ranked":[{"id":"a","score":150,"reasons":[]},{"id":"b","score":-20,"reasons":[]},{"id":"c","score":"nope","reasons":[]},{"id":"d","score":72.6,"reasons":[]}]}';
    expect(parseMatchRanking(raw)).toEqual({
      ranked: [
        { id: 'a', score: 100, reasons: [] },
        { id: 'b', score: 0, reasons: [] },
        { id: 'c', score: null, reasons: [] },
        { id: 'd', score: 73, reasons: [] }
      ]
    });
  });

  it('defense-in-depth: strips any reason that mentions money/billing even if the model slips', () => {
    const raw = JSON.stringify({
      ranked: [{
        id: 'a', score: 90,
        reasons: [
          'Close to their preferred city',
          'Offers a $150k+ package',
          '65% billing split available',
          'Good school district for their kids',
          'Strong visa pathway alignment'
        ]
      }]
    });
    const parsed = parseMatchRanking(raw);
    expect(parsed.ranked[0].reasons).toEqual([
      'Close to their preferred city',
      'Good school district for their kids',
      'Strong visa pathway alignment'
    ]);
  });
});

describe('aiRankCandidatesForJob', () => {
  it('short-circuits with an empty ranked list when there are no candidates (no fetch call)', async () => {
    const fetchImpl = () => { throw new Error('should not be called'); };
    const result = await aiRankCandidatesForJob({ id: 'job-1' }, [], { apiKey: 'k', fetchImpl });
    expect(result).toEqual({ ranked: [] });
  });

  it('gracefully degrades with no API key, never throws, never calls fetch', async () => {
    const fetchImpl = () => { throw new Error('should not be called'); };
    const result = await aiRankCandidatesForJob({ id: 'job-1' }, [{ id: 'gp-1' }, { id: 'gp-2' }], { apiKey: '', fetchImpl });
    expect(result.error).toBe('no_api_key');
    expect(result.ranked).toEqual([
      { id: 'gp-1', score: null, reasons: [] },
      { id: 'gp-2', score: null, reasons: [] }
    ]);
  });

  it('batches candidates at maxBatch (default 25) and merges + sorts the results', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ id: 'gp-' + i }));
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      const body = JSON.parse(opts.body);
      const idsInPrompt = [...body.messages[0].content.matchAll(/"id":\s*"(gp-\d+)"/g)].map((m) => m[1]);
      const ranked = idsInPrompt.map((id, i) => ({ id, score: 10 + i, reasons: ['fits well'] }));
      return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ ranked }) }], usage: { input_tokens: 5, output_tokens: 5 } }) };
    };
    const result = await aiRankCandidatesForJob({ id: 'job-1', title: 'GP role' }, candidates, { apiKey: 'k', fetchImpl });
    expect(calls.length).toBe(2); // 25 + 5
    const firstBatchCandidateCount = (calls[0].messages[0].content.match(/"id":\s*"gp-\d+"/g) || []).length;
    expect(firstBatchCandidateCount).toBe(25);
    expect(result.ranked.length).toBe(30);
    // Sorted descending by score.
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
  });

  it('sends the model + cache_control on the system block (matches the standard AI-endpoint recipe)', async () => {
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(body.model).toBe('claude-test-match-model');
      expect(Array.isArray(body.system)).toBe(true);
      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
      return { ok: true, status: 200, json: async () => ({ content: [{ text: '{"ranked":[{"id":"gp-1","score":80,"reasons":["a","b","c"]}]}' }] }) };
    };
    const result = await aiRankCandidatesForJob({ id: 'job-1' }, [{ id: 'gp-1' }], { apiKey: 'k', model: 'claude-test-match-model', fetchImpl });
    expect(result.ranked).toEqual([{ id: 'gp-1', score: 80, reasons: ['a', 'b', 'c'] }]);
  });

  it('degrades a failed batch to null-score placeholders instead of dropping those candidates', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await aiRankCandidatesForJob({ id: 'job-1' }, [{ id: 'gp-1' }, { id: 'gp-2' }], { apiKey: 'k', fetchImpl });
    expect(result.error).toBe('api_error_500');
    expect(result.ranked).toEqual([
      { id: 'gp-1', score: null, reasons: [] },
      { id: 'gp-2', score: null, reasons: [] }
    ]);
  });
});

describe('aiRankJobsForGp', () => {
  it('short-circuits with an empty ranked list when there are no jobs', async () => {
    const result = await aiRankJobsForGp({ id: 'gp-1' }, [], { apiKey: 'k', fetchImpl: () => { throw new Error('no'); } });
    expect(result).toEqual({ ranked: [] });
  });

  it('ranks + sorts jobs for one GP', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ text: '{"ranked":[{"id":"job-2","score":40,"reasons":["a","b","c"]},{"id":"job-1","score":90,"reasons":["a","b","c"]}]}' }] })
    });
    const result = await aiRankJobsForGp({ id: 'gp-1' }, [{ id: 'job-1' }, { id: 'job-2' }], { apiKey: 'k', fetchImpl });
    expect(result.ranked.map((r) => r.id)).toEqual(['job-1', 'job-2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Part B: endpoint tests against a real server + in-memory Supabase emulator
// ─────────────────────────────────────────────────────────────────────────

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'matching-test.local';
const SUPER_EMAIL = 'super@gplink-test.local';
let server, port;
let sbServer, sbPort;
let realFetch;
let anthropicCallCount = 0;
let anthropicResponder = null; // (body) => rankedArray, set per-test

const db = {
  user_profiles: [
    { user_id: 'gp-1', email: 'gp1@test.local', first_name: 'Eligible', last_name: 'One', registration_country: 'uk', preferred_city: 'Brisbane', qualification_country: 'uk' },
    { user_id: 'gp-2', email: 'gp2@test.local', first_name: 'Incomplete', last_name: 'Onboarding', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: 'gp-1', state: { gp_onboarding_complete: true, account_status: 'active' } },
    { user_id: 'gp-2', state: { gp_onboarding_complete: false, account_status: 'active' } }
  ],
  user_documents: [
    { id: 'doc-1', user_id: 'gp-1', document_key: 'cv_signed_dated', status: 'uploaded' }
  ],
  registration_cases: [
    { id: 'case-1', user_id: 'gp-1', ai_handover_summary: { overview: 'Keen to relocate with family.' }, intent_score: 80, intent_band: 'hot' },
    { id: 'case-2', user_id: 'gp-2', ai_handover_summary: null, intent_score: 20, intent_band: 'cold' }
  ],
  career_roles: [
    { id: 'role-1', title: 'GP, Brisbane', practice_name: 'Test Practice', practice_type: 'Corporate', location_city: 'Brisbane', location_state: 'QLD', employment_type: 'Permanent', dpa: true, visa_pathway_aligned: true, regional: false, metro: true, family_friendly: true, tags: ['family-friendly'], summary: 'A great role.', job_status: 'open', is_active: true, provider: 'internal_ats', provider_role_id: 'ats_role1' },
    // Dedicated to the shortlist tests below so they never share a match_cache
    // row (subject_type='job', subject_id) with the ranking-endpoint tests.
    // is_active:false keeps it OUT of the /matching/jobs open+active jobs
    // pool (atsGetJobRow itself has no such filter, so the shortlist
    // insert/reopen/skip paths, which look the job up directly by id, are
    // unaffected).
    { id: 'role-2', title: 'GP, Toowoomba', practice_name: 'Shortlist Test Practice', practice_type: 'Corporate', location_city: 'Toowoomba', location_state: 'QLD', employment_type: 'Permanent', dpa: true, job_status: 'open', is_active: false, provider: 'internal_ats', provider_role_id: 'ats_role2' }
  ],
  practices: [
    { id: 'p1', name: 'Test Practice' }
  ],
  gp_applications: [],
  career_interviews: [],
  match_cache: [],
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
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
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
        const conflictCols = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
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
function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let body2 = null; try { body2 = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: body2, raw }); });
    });
    r.on('error', reject); r.end(data);
  });
}
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });

// Wrapped in its own describe so this beforeAll/afterAll (which sets
// ANTHROPIC_API_KEY + boots a real server) never runs before Part A's plain
// unit tests above, vitest hoists a FILE-level beforeAll ahead of every
// test in the file regardless of source order, which would otherwise leak
// a real-looking API key into the "no API key" unit test.
describe('AI Matching endpoints (Supabase emulator)', () => {
beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-test-secret-' + RUN_ID;
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

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      anthropicCallCount++;
      const body = JSON.parse(opts.body);
      // Only pull ids from the "rank ALL of them" LIST section, the single
      // job/gp summary block above it also has its own "id" field, which must
      // not be mistaken for a list entry to rank.
      const content = body.messages[0].content;
      const listMarker = content.indexOf('(rank ALL of them):');
      const listSection = listMarker === -1 ? content : content.slice(listMarker);
      const idsInPrompt = [...listSection.matchAll(/"id":\s*"([^"]+)"/g)].map((mm) => mm[1]);
      const ranked = anthropicResponder ? anthropicResponder(idsInPrompt, body) : idsInPrompt.map((id) => ({ id, score: 50, reasons: ['generic fit'] }));
      return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ ranked }) }], usage: { input_tokens: 5, output_tokens: 5 } }), { status: 200 });
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

describe('GET /api/ats/matching/candidates', () => {
  it('ranks the eligible GP, excludes the ineligible one, and caches the result', async () => {
    anthropicResponder = (ids) => ids.map((id) => ({ id, score: 91, reasons: ['Close to their preferred city', 'Good fit for their family plans', 'Matches their training background'] }));
    const before = anthropicCallCount;

    const r1 = await atsGet('/api/ats/matching/candidates?job_id=role-1');
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.job.id).toBe('role-1');
    expect(r1.body.excluded_count).toBe(1); // gp-2: onboarding incomplete
    expect(r1.body.ranked.length).toBe(1);
    expect(r1.body.ranked[0].user_id).toBe('gp-1');
    expect(r1.body.ranked[0].score).toBe(91);
    expect(r1.body.ranked[0].reasons.length).toBeGreaterThanOrEqual(3);
    expect(anthropicCallCount).toBe(before + 1);

    // Second call without force reuses the 24h cache, no new Anthropic call.
    const r2 = await atsGet('/api/ats/matching/candidates?job_id=role-1');
    expect(r2.status).toBe(200);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.ranked[0].user_id).toBe('gp-1');
    expect(anthropicCallCount).toBe(before + 1);

    // force=1 bypasses the cache and recomputes.
    const r3 = await atsGet('/api/ats/matching/candidates?job_id=role-1&force=1');
    expect(r3.status).toBe(200);
    expect(r3.body.cached).toBeUndefined();
    expect(anthropicCallCount).toBe(before + 2);
  });

  it('404s for an unknown job_id', async () => {
    const r = await atsGet('/api/ats/matching/candidates?job_id=does-not-exist');
    expect(r.status).toBe(404);
  });

  it('400s when job_id is missing', async () => {
    const r = await atsGet('/api/ats/matching/candidates');
    expect(r.status).toBe(400);
  });

  it('rejects a request without a valid admin session', async () => {
    const r = await httpReq('GET', '/api/ats/matching/candidates?job_id=role-1', { host: SUPER_HOST });
    expect([302, 401, 403]).toContain(r.status);
  });
});

describe('GET /api/ats/matching/jobs', () => {
  it('ranks the open/active job for an eligible GP', async () => {
    anthropicResponder = (ids) => ids.map((id) => ({ id, score: 77, reasons: ['Metro location matches their preference', 'Family-friendly practice', 'Visa pathway aligned'] }));
    const r = await atsGet('/api/ats/matching/jobs?user_id=gp-1&force=1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.gp.user_id).toBe('gp-1');
    expect(r.body.ranked.length).toBe(1);
    expect(r.body.ranked[0].career_role_id).toBe('role-1');
    expect(r.body.ranked[0].score).toBe(77);
  });

  it('returns an empty ranked list + excluded_count for an ineligible GP (no Anthropic call)', async () => {
    const before = anthropicCallCount;
    const r = await atsGet('/api/ats/matching/jobs?user_id=gp-2&force=1');
    expect(r.status).toBe(200);
    expect(r.body.ranked).toEqual([]);
    expect(r.body.excluded_count).toBe(1);
    expect(anthropicCallCount).toBe(before); // no eligible jobs -> no AI call at all
  });

  it('404s for an unknown user_id', async () => {
    const r = await atsGet('/api/ats/matching/jobs?user_id=does-not-exist');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/ats/matching/shortlist', () => {
  // Uses role-2 exclusively (never role-1, which the ranking-endpoint tests
  // above already wrote a match_cache row for) so these tests never depend
  // on suite ordering.
  //
  // The endpoint now re-checks eligibility server-side before ANY write, so
  // the shortlisted GPs need REAL pool fixtures (profile + state + CV + case).
  // Seeded in a describe-scoped beforeAll, i.e. AFTER the ranking endpoint
  // tests above have already run, so those tests' exact candidate-universe
  // counts (ranked.length / excluded_count) are not disturbed.
  beforeAll(() => {
    db.user_profiles.push(
      { user_id: 'gp-insert', email: 'gpinsert@test.local', first_name: 'Insert', last_name: 'Able', registration_country: 'uk', qualification_country: 'uk' },
      { user_id: 'gp-reopen', email: 'gpreopen@test.local', first_name: 'Reopen', last_name: 'Able', registration_country: 'uk', qualification_country: 'uk' },
      { user_id: 'gp-dpa', email: 'gpdpa@test.local', first_name: 'Overseas', last_name: 'Trained', registration_country: 'uk', qualification_country: 'uk' },
      { user_id: 'gp-gated', email: 'gpgated@test.local', first_name: 'Under', last_name: 'Review', registration_country: 'uk', qualification_country: 'uk' }
    );
    db.user_state.push(
      { user_id: 'gp-insert', state: { gp_onboarding_complete: true, account_status: 'active' } },
      { user_id: 'gp-reopen', state: { gp_onboarding_complete: true, account_status: 'active' } },
      { user_id: 'gp-dpa', state: { gp_onboarding_complete: true, account_status: 'active' } },
      { user_id: 'gp-gated', state: { gp_onboarding_complete: true, account_status: 'under_review' } }
    );
    db.user_documents.push(
      { id: 'doc-ins', user_id: 'gp-insert', document_key: 'cv_signed_dated', status: 'uploaded' },
      { id: 'doc-reo', user_id: 'gp-reopen', document_key: 'cv_signed_dated', status: 'uploaded' },
      { id: 'doc-dpa', user_id: 'gp-dpa', document_key: 'cv_signed_dated', status: 'uploaded' },
      { id: 'doc-gat', user_id: 'gp-gated', document_key: 'cv_signed_dated', status: 'uploaded' }
    );
    db.registration_cases.push(
      { id: 'case-ins', user_id: 'gp-insert' },
      { id: 'case-reo', user_id: 'gp-reopen' },
      { id: 'case-dpa', user_id: 'gp-dpa' },
      { id: 'case-gat', user_id: 'gp-gated' }
    );
    // Non-DPA role for the dpa_ineligible case. is_active:false keeps it out
    // of the /matching/jobs open-pool query (belt-and-braces, those tests
    // already ran); the shortlist path looks jobs up directly by id, unaffected.
    db.career_roles.push(
      { id: 'role-3', title: 'GP, Sydney (non-DPA)', practice_name: 'Metro Practice', location_city: 'Sydney', location_state: 'NSW', dpa: false, job_status: 'open', is_active: false, provider: 'internal_ats', provider_role_id: 'ats_role3' }
    );
  });

  it('inserts a fresh shortlisted row, pulling score/reasons from the job-side match_cache', async () => {
    db.match_cache.push({
      id: 'mc-1', subject_type: 'job', subject_id: 'role-2',
      payload: { ranked: [{ user_id: 'gp-insert', score: 88, reasons: ['Great fit for the area'] }], excluded_count: 0 },
      generated_at: new Date().toISOString()
    });

    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-insert', career_role_id: 'role-2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ user_id: 'gp-insert', career_role_id: 'role-2', ok: true }]);

    const created = db.gp_applications.find((a) => a.user_id === 'gp-insert' && String(a.career_role_id) === 'role-2');
    expect(created).toBeTruthy();
    expect(created.ats_stage).toBe('shortlisted');
    expect(created.origin).toBe('ai_matched');
    expect(created.revealed).toBe(true);
    expect(created.match_score).toBe(88);
    expect(created.match_reasons.reasons).toEqual(['Great fit for the area']);
    expect(created.matched_by).toBe(SUPER_EMAIL);
    expect(new Date(created.match_expires_at).getTime()).toBeGreaterThan(Date.now() + 4 * 24 * 60 * 60 * 1000);
  });

  it('skips a GP who already has a LIVE application on that job', async () => {
    db.gp_applications.push({ id: 'app-live', user_id: 'gp-live', career_role_id: 'role-2', ats_stage: 'interview', status: 'applied' });

    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-live', career_role_id: 'role-2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ user_id: 'gp-live', career_role_id: 'role-2', ok: false, skipped: 'live_application' }]);

    const row = db.gp_applications.find((a) => a.id === 'app-live');
    expect(row.ats_stage).toBe('interview'); // untouched
  });

  it('reopens a prior declined/not_proceeding row on the SAME id, preserving history', async () => {
    db.gp_applications.push({
      id: 'app-reopen', user_id: 'gp-reopen', career_role_id: 'role-2',
      ats_stage: 'not_proceeding', match_outcome: 'declined', decline_reason: 'Too far from family',
      match_reasons: { reasons: ['old reason'], _history: [] }
    });

    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-reopen', career_role_id: 'role-2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ user_id: 'gp-reopen', career_role_id: 'role-2', ok: true, reopened: true }]);

    const row = db.gp_applications.find((a) => a.id === 'app-reopen');
    expect(row.ats_stage).toBe('shortlisted');
    expect(row.match_outcome).toBeNull();
    expect(row.decline_reason).toBeNull();
    expect(row.match_reasons._history).toEqual([{ outcome: 'declined', decline_reason: 'Too far from family', at: expect.any(String) }]);
  });

  it('re-checks eligibility server-side: DPA-ineligible pairing is blocked and writes nothing', async () => {
    // gp-dpa is uk-trained (dpaEligible=false); role-3 is dpa:false → hard block.
    const countBefore = db.gp_applications.length;
    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-dpa', career_role_id: 'role-3' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { user_id: 'gp-dpa', career_role_id: 'role-3', ok: false, skipped: 'ineligible', blocks: ['dpa_ineligible'] }
    ]);
    expect(db.gp_applications.length).toBe(countBefore); // nothing written
    expect(db.gp_applications.find((a) => a.user_id === 'gp-dpa')).toBeUndefined();
  });

  it('re-checks eligibility server-side: gated account (under_review) is blocked and writes nothing', async () => {
    // gp-gated targets role-2 (dpa:true so no DPA block), only account_gated fires.
    const countBefore = db.gp_applications.length;
    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-gated', career_role_id: 'role-2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { user_id: 'gp-gated', career_role_id: 'role-2', ok: false, skipped: 'ineligible', blocks: ['account_gated'] }
    ]);
    expect(db.gp_applications.length).toBe(countBefore); // nothing written
    expect(db.gp_applications.find((a) => a.user_id === 'gp-gated')).toBeUndefined();
  });

  it('fails closed for a completely unknown user (no profile, no case)', async () => {
    const countBefore = db.gp_applications.length;
    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: 'gp-nobody', career_role_id: 'role-2' }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { user_id: 'gp-nobody', career_role_id: 'role-2', ok: false, error: 'candidate_not_found' }
    ]);
    expect(db.gp_applications.length).toBe(countBefore);
  });

  it('reports missing_fields / job_not_found without touching the DB', async () => {
    const r = await atsPost('/api/ats/matching/shortlist', {
      items: [
        { user_id: '', career_role_id: 'role-2' },
        { user_id: 'gp-ghost', career_role_id: 'role-does-not-exist' }
      ]
    });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([
      { user_id: '', career_role_id: 'role-2', ok: false, error: 'missing_fields' },
      { user_id: 'gp-ghost', career_role_id: 'role-does-not-exist', ok: false, error: 'job_not_found' }
    ]);
  });

  it('400s when items is missing/empty', async () => {
    const r = await atsPost('/api/ats/matching/shortlist', { items: [] });
    expect(r.status).toBe(400);
  });
});
}); // end describe('AI Matching endpoints (Supabase emulator)')
