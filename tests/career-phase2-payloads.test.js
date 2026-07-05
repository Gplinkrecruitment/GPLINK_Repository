// Phase 2 · Task 1 — server-side masking fixes + payload prep for the Atlas
// career pages.
//
// Covers:
//  - roleType (card) + title/summary (public) never leak a real practice name
//    for a Zoho-sourced row that has no masked_title.
//  - internal-ATS rows keep their real admin-written job title in roleType.
//  - applicantBand: fixed 15–23 deterministic band, absent from public jobs.
//  - detail endpoint exposes introVideoUrl; public jobs never carry a video.
//  - /api/career/my-offer includes the client roleId.
//  - public jobs search on the real practice name returns 0 for a masked row.
//
// Unit tests hit the mappers directly via __testUtils; the intro-video + offer
// assertions boot the real server against an in-memory PostgREST emulator (same
// pattern as tests/career-dpa-gate.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-p2-${RUN_ID}.json`);
let server, port, tu;
let sbServer, sbPort;

const GP = { userId: 'u-p2-gp-1', email: 'p2-gp@gplink-test.local' };
const NOW = new Date().toISOString();

// A Zoho legacy row whose raw `title` (and `summary`) literally IS the real
// practice name — and NO masked_title. The masking helpers must scrub it.
const ZOHO_LEAK = {
  id: 'role-zoho-leak', provider: 'zoho_recruit', provider_role_id: 'z_leak1',
  title: 'Bramble & Voss Family Doctors',
  practice_name: 'Bramble & Voss Family Doctors',
  summary: 'Come and join Bramble & Voss Family Doctors, a warm team in Brisbane.',
  is_active: true, dpa: true, location_state: 'QLD', location_city: 'Brisbane',
  suburb: 'Sunnybank Hills', nearest_city: 'Brisbane', billing_model: 'bulk', updated_at: NOW
};

// An internal-ATS row: the admin-written job title is doctor-facing copy and
// must be kept as roleType.
const INTERNAL_ROW = {
  id: 'role-internal', provider: 'internal_ats', provider_role_id: 'ats_int1',
  title: 'Senior GP — VR, Full Time', masked_title: 'DPA - Geelong - Bulk Billing',
  practice_name: 'ULTRA SECRET Geelong Clinic',
  is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
  dpa: true, location_state: 'VIC', nearest_city: 'Geelong', billing_model: 'bulk', updated_at: NOW
};

// Internal-ATS role with an intro video stashed on the career_roles row
// (source_payload.practice_intro.video_url — where createPendingJobFromIntake
// puts it).
const VIDEO_URL = 'https://videos.example.com/torquay-intro.mp4';
const VIDEO_ROW = {
  id: 'role-video', provider: 'internal_ats', provider_role_id: 'ats_vid1',
  title: 'GP — Coastal practice', masked_title: 'DPA - Torquay',
  practice_name: 'Secret Torquay Practice',
  source_payload: { practice_intro: { video_url: VIDEO_URL } },
  is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
  dpa: true, location_state: 'VIC', nearest_city: 'Torquay', updated_at: NOW
};

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Phase', last_name: 'Two', registration_country: 'australia' }
  ],
  user_state: [ { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW } ],
  user_documents: [ { id: 'doc-cv', user_id: GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' } ],
  user_roles: [],
  career_roles: [ ZOHO_LEAK, INTERNAL_ROW, VIDEO_ROW ],
  gp_applications: [
    { id: 'app-offer-1', user_id: GP.userId, career_role_id: 'role-video', provider_role_id: 'ats_vid1',
      status: 'offered', ats_stage: 'offer', origin: 'gp_applied', applied_at: NOW },
    // Task 4: offer on the leaky Zoho row (NO masked_title, raw title IS the
    // practice name) — the my-offer masked branch must still mask roleTitle.
    { id: 'app-offer-zoho', user_id: GP.userId, career_role_id: 'role-zoho-leak', provider_role_id: 'z_leak1',
      status: 'offered', ats_stage: 'offer', origin: 'gp_applied', applied_at: NOW }
  ],
  ats_offers: [
    { id: 'offer-1', application_id: 'app-offer-1', status: 'sent',
      job_title: 'GP — Coastal practice', practice_name: 'Secret Torquay Practice', sent_at: NOW },
    { id: 'offer-zoho', application_id: 'app-offer-zoho', status: 'sent',
      job_title: 'Bramble & Voss Family Doctors', practice_name: 'Bramble & Voss Family Doctors', sent_at: NOW }
  ],
  scheduled_calls: [],
  registration_cases: []
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
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
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
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
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
          rows.push(row); return row;
        });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0; keep.forEach((row) => rows.push(row));
        send(200, []); return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}
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
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw }); });
    });
    r.on('error', reject); r.end(data);
  });
}

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'career-p2-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_EMAILS = '';

  const mod = await import('../server.js');
  tu = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('masked-title fallback — card roleType + public title never leak a real practice name', () => {
  it('a Zoho row with no masked_title: card roleType carries no real practice name', () => {
    const card = tu.mapCareerRoleRowToClient(ZOHO_LEAK);
    expect(card.roleType).not.toBe('Bramble & Voss Family Doctors');
    expect(card.roleType).not.toContain('Bramble');
    expect(card.roleType).not.toContain('Voss');
    expect(card.roleType).not.toContain('Family Doctors');
    expect(String(card.roleType).trim()).toBeTruthy();
  });

  it('a Zoho row: public title + summary carry no real practice name', () => {
    const pub = tu.mapCareerRoleRowToPublicJob(ZOHO_LEAK);
    for (const field of ['title', 'summary']) {
      expect(pub[field]).not.toContain('Bramble');
      expect(pub[field]).not.toContain('Voss');
      expect(pub[field]).not.toContain('Family Doctors');
    }
    expect(String(pub.title).trim()).toBeTruthy();
  });

  it('an internal-ATS row keeps its real admin-written job title in roleType', () => {
    const card = tu.mapCareerRoleRowToClient(INTERNAL_ROW);
    expect(card.roleType).toBe('Senior GP — VR, Full Time');
  });
});

describe('careerRoleTitleLeaksPracticeName hardening — partial phrases, punctuation, missing practice', () => {
  // Suburb/nearest_city deliberately do NOT contain any word under test — the
  // masked fallback legitimately surfaces the suburb, so the assertions below
  // isolate practice-name leakage only.
  const zooRow = (over) => ({
    id: 'role-hard', provider: 'zoho_recruit', provider_role_id: 'z_hard1',
    is_active: true, dpa: true, location_state: 'QLD', suburb: 'Acacia Ridge',
    nearest_city: 'Brisbane', billing_model: 'bulk', updated_at: NOW, ...over
  });

  it('partial-phrase leak: a title containing the distinctive practice token is masked', () => {
    const row = zooRow({
      title: 'GP wanted at Sunnybank Family Medical',
      practice_name: 'Sunnybank Family Medical Centre'
    });
    const card = tu.mapCareerRoleRowToClient(row);
    const pub = tu.mapCareerRoleRowToPublicJob(row);
    expect(card.roleType).not.toContain('Sunnybank');
    expect(pub.title).not.toContain('Sunnybank');
    expect(String(card.roleType).trim()).toBeTruthy();
    expect(String(pub.title).trim()).toBeTruthy();
  });

  it('punctuation variant: "Smith & Jones Medical" vs "Smith and Jones Medical Pty Ltd" is masked', () => {
    const row = zooRow({
      title: 'Smith & Jones Medical',
      practice_name: 'Smith and Jones Medical Pty Ltd'
    });
    const card = tu.mapCareerRoleRowToClient(row);
    const pub = tu.mapCareerRoleRowToPublicJob(row);
    expect(card.roleType).not.toContain('Smith');
    expect(card.roleType).not.toContain('Jones');
    expect(pub.title).not.toContain('Smith');
    expect(pub.title).not.toContain('Jones');
  });

  it('null practice_name + practice-looking title on a Zoho row is masked (cannot prove safe)', () => {
    const row = zooRow({ title: 'Bramble & Voss Family Doctors', practice_name: null });
    const card = tu.mapCareerRoleRowToClient(row);
    const pub = tu.mapCareerRoleRowToPublicJob(row);
    expect(card.roleType).not.toContain('Bramble');
    expect(card.roleType).not.toContain('Voss');
    expect(pub.title).not.toContain('Bramble');
    expect(pub.title).not.toContain('Voss');
    expect(String(card.roleType).trim()).toBeTruthy();
  });

  it('a genuine role title that shares no distinctive practice token is kept', () => {
    const row = zooRow({
      title: 'Locum GP — VR',
      practice_name: 'Sunnybank Family Medical Centre'
    });
    const card = tu.mapCareerRoleRowToClient(row);
    const pub = tu.mapCareerRoleRowToPublicJob(row);
    expect(card.roleType).toBe('Locum GP — VR');
    expect(pub.title).toBe('Locum GP — VR');
  });
});

describe('applicantBand — fixed 15–23 deterministic band, never the real count, never on public', () => {
  it('is an integer within [15,23]', () => {
    const card = tu.mapCareerRoleRowToClient(INTERNAL_ROW);
    expect(Number.isInteger(card.applicantBand)).toBe(true);
    expect(card.applicantBand).toBeGreaterThanOrEqual(15);
    expect(card.applicantBand).toBeLessThanOrEqual(23);
  });

  it('is deterministic — the same role id yields the same band twice', () => {
    const a = tu.mapCareerRoleRowToClient(INTERNAL_ROW).applicantBand;
    const b = tu.mapCareerRoleRowToClient(INTERNAL_ROW).applicantBand;
    expect(a).toBe(b);
  });

  it('differs across at least two of three different role ids', () => {
    const ids = ['ats_alpha', 'ats_bravo', 'ats_charlie'];
    const bands = ids.map((rid) =>
      tu.mapCareerRoleRowToClient({ ...INTERNAL_ROW, provider_role_id: rid }).applicantBand);
    expect(new Set(bands).size).toBeGreaterThanOrEqual(2);
  });

  it('is absent from the public jobs payload', () => {
    const pub = tu.mapCareerRoleRowToPublicJob(INTERNAL_ROW);
    expect(pub.applicantBand).toBeUndefined();
    const resp = tu.buildPublicJobsResponse([INTERNAL_ROW], new URLSearchParams());
    expect(resp.jobs.every((j) => j.applicantBand === undefined)).toBe(true);
  });

  it('the detail payload also carries applicantBand', () => {
    const detail = tu.mapCareerRoleDetailToClient(INTERNAL_ROW);
    expect(Number.isInteger(detail.applicantBand)).toBe(true);
    expect(detail.applicantBand).toBeGreaterThanOrEqual(15);
    expect(detail.applicantBand).toBeLessThanOrEqual(23);
  });
});

describe('two-tier intro video — detail only, never public', () => {
  it('the detail endpoint exposes introVideoUrl for an authenticated GP', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_vid1'), {
      cookie: userCookie(GP.email, GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.introVideoUrl).toBe(VIDEO_URL);
  });

  it('the public jobs response carries no intro/video fields at all', async () => {
    const res = await httpReq('GET', '/api/public/jobs');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(VIDEO_URL);
    expect(res.raw).not.toContain('videos.example.com');
    expect(res.raw.toLowerCase()).not.toContain('introvideo');
    // Real practice names never ride out on the public board either.
    expect(res.raw).not.toContain('Bramble');
    expect(res.raw).not.toContain('Secret Torquay Practice');
    expect(res.raw).not.toContain('ULTRA SECRET');
  });

  it('the card list mapper never carries introVideoUrl', () => {
    const card = tu.mapCareerRoleRowToClient(VIDEO_ROW);
    expect(card.introVideoUrl).toBeUndefined();
  });
});

describe('/api/career/my-offer — includes the client roleId', () => {
  it('returns roleId matching the offered role', async () => {
    const res = await httpReq('GET', '/api/career/my-offer?applicationId=app-offer-1', {
      cookie: userCookie(GP.email, GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.roleId).toBe('internal_ats:ats_vid1');
    // Pre-reveal: the real practice name must not leak.
    expect(res.raw).not.toContain('Secret Torquay Practice');
  });
});

describe('/api/career/my-offer — masked branch roleTitle never leaks the practice name (Task 4)', () => {
  it('empty masked_title + leaky raw/job title → roleTitle comes back masked', async () => {
    const res = await httpReq('GET', '/api/career/my-offer?applicationId=app-offer-zoho', {
      cookie: userCookie(GP.email, GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revealed).toBe(false);
    // A usable (non-empty) title still comes back…
    expect(String(res.body.roleTitle || '').trim()).toBeTruthy();
    // …but nothing in the whole payload carries the real practice name.
    expect(res.raw).not.toContain('Bramble');
    expect(res.raw).not.toContain('Voss');
    expect(res.raw).not.toContain('Family Doctors');
  });
});

describe('public jobs search — the real practice name returns 0 for a masked Zoho row', () => {
  it('searching the full practice name matches nothing', () => {
    const resp = tu.buildPublicJobsResponse([ZOHO_LEAK], new URLSearchParams({ q: 'Bramble & Voss Family Doctors' }));
    expect(resp.total).toBe(0);
    expect(resp.jobs).toHaveLength(0);
  });
});
