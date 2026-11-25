// Task 11 — server-side DPA gate + preferred-city ranking + blurred fillers.
//
// A GP who did NOT train in Australia can only be legally placed into a DPA
// (District of Priority Area) role. Non-DPA roles must never be applyable —
// and their identifying details (practice name, suburb, exact city) must
// never even reach the client — for a GP whose registration country isn't
// Australia (the "Australia-trained" flag is derived from that country, not
// a separate onboarding question).
//
// ── CHANGED BY WP-08 OF THE AUSTRALIAN GP BUILD (what and why) ───────────────
// The gate no longer asks "is the doctor's country Australia?" at each call
// site. Every site (roles list, role detail, apply) now asks ONE function,
// roleEligibility.roleEligibilityFor(pathwayResult, role), and the country
// answer is only an INPUT to the pathway resolver (`legacyDpaExempt`).
//
// What that means for the tests in this file:
//   * Every test that was here before is UNCHANGED and still passes. The
//     doctors in them have no pathway recorded, so they are overseas doctors,
//     and for an overseas doctor the country answer is still the whole rule:
//     "overseas-trained" sees DPA roles only, the doctor whose country reads
//     Australia sees everything. Those are today's expectations, preserved.
//   * NEW, at the bottom ("the gate follows the pathway flag, not the
//     country"): doctors whose country is ALSO Australia but who are on an
//     Australian pathway. For them the country unlocks nothing: only a
//     staff-confirmed "19AB does not apply" does, a segment that is not
//     launched is held, and with the switch off they read as the country says,
//     exactly as before the build.
//
// Boots the real server against a tiny in-memory PostgREST emulator (same
// pattern as tests/career-internal-apply.test.js), so the FULL Supabase-mode
// /api/career/roles + /api/career/apply pipelines run for real.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-dpa-${RUN_ID}.json`);
let server, port;
let testUtils;             // server.js __testUtils (fail-closed gate seam)
let sbServer, sbPort;

const OVERSEAS_GP = { userId: 'u-overseas-1', email: 'overseas-gp@gplink-test.local' };
const AU_TRAINED_GP = { userId: 'u-au-trained-1', email: 'au-trained-gp@gplink-test.local' };
// No careers CV on file → stays on the MASKED tier (owner 2026-09-04: the
// practice name + website are only shown once the CV gate is passed).
const NO_CV_GP = { userId: 'u-no-cv-1', email: 'no-cv-gp@gplink-test.local' };
// WP-08: doctors on an Australian pathway. Country = Australia for all three.
const AU_VR_UNCONFIRMED_GP = { userId: 'u-au-vr-unconfirmed-1', email: 'au-vr-unconfirmed@gplink-test.local' };
const AU_VR_CLEARED_GP = { userId: 'u-au-vr-cleared-1', email: 'au-vr-cleared@gplink-test.local' };
const AU_RESTRICTED_GP = { userId: 'u-au-restricted-1', email: 'au-restricted@gplink-test.local' };
// WP-29 (deliberate): a fourth doctor. Says "19AB does not apply"; staff have
// not confirmed it. Their own answer now opens their own view.
const AU_VR_OWN_NO_GP = { userId: 'u-au-vr-own-no-1', email: 'au-vr-own-no@gplink-test.local' };
const AU_PATHWAY_GPS = [AU_VR_UNCONFIRMED_GP, AU_VR_CLEARED_GP, AU_RESTRICTED_GP, AU_VR_OWN_NO_GP];
const STAFF = 'staff.test@gplink-test.local';
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    {
      user_id: OVERSEAS_GP.userId, email: OVERSEAS_GP.email,
      first_name: 'Overseas', last_name: 'Doctor', zoho_candidate_id: null,
      registration_country: 'uk', preferred_city: 'Melbourne'
    },
    {
      user_id: AU_TRAINED_GP.userId, email: AU_TRAINED_GP.email,
      first_name: 'AuTrained', last_name: 'Doctor', zoho_candidate_id: null,
      registration_country: 'australia', preferred_city: ''
    },
    {
      user_id: NO_CV_GP.userId, email: NO_CV_GP.email,
      first_name: 'NoCv', last_name: 'Doctor', zoho_candidate_id: null,
      registration_country: 'australia', preferred_city: ''
    },
    {
      user_id: AU_VR_UNCONFIRMED_GP.userId, email: AU_VR_UNCONFIRMED_GP.email,
      first_name: 'Test', last_name: 'Auvrpending', zoho_candidate_id: null,
      registration_country: 'Australia', preferred_city: '',
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF
    },
    {
      user_id: AU_VR_CLEARED_GP.userId, email: AU_VR_CLEARED_GP.email,
      first_name: 'Test', last_name: 'Auvrcleared', zoho_candidate_id: null,
      registration_country: 'Australia', preferred_city: '',
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF
    },
    {
      user_id: AU_RESTRICTED_GP.userId, email: AU_RESTRICTED_GP.email,
      first_name: 'Test', last_name: 'Aurestricted', zoho_candidate_id: null,
      registration_country: 'Australia', preferred_city: '',
      candidate_pathway: 'au_restricted', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF
    },
    {
      user_id: AU_VR_OWN_NO_GP.userId, email: AU_VR_OWN_NO_GP.email,
      first_name: 'Test', last_name: 'Auvrownno', zoho_candidate_id: null,
      registration_country: 'Australia', preferred_city: '',
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF
    }
  ],
  gp_credentials: [
    // WP-29 (deliberate): this doctor used to SAY 19AB does not apply. That
    // answer now opens the doctor's own view (AU_VR_OWN_NO_GP below), so the
    // doctor who must stay on DPA roles is the one who is NOT SURE; staff have
    // not confirmed either way.
    { user_id: AU_VR_UNCONFIRMED_GP.userId, ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', moratorium_19ab_status: 'unsure' },
    // The doctor SAYS 19AB does not apply; staff have not confirmed it.
    { user_id: AU_VR_OWN_NO_GP.userId, ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', moratorium_19ab_status: 'no' },
    // Staff confirmed 19AB does not apply.
    { user_id: AU_VR_CLEARED_GP.userId, ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
    { user_id: AU_RESTRICTED_GP.userId, ahpra_registration_type: 'general', vr_status: 'vr', moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }
  ],
  user_state: [
    { user_id: OVERSEAS_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: AU_TRAINED_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: NO_CV_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ].concat(AU_PATHWAY_GPS.map((d) => ({ user_id: d.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }))),
  user_documents: [
    // Task 4: /api/career/apply's CV gate now requires the verified careers
    // CV (document_key 'career_cv'), not a registration-file document.
    { id: 'doc-cv-overseas', user_id: OVERSEAS_GP.userId, document_key: 'career_cv', status: 'uploaded' },
    { id: 'doc-cv-au', user_id: AU_TRAINED_GP.userId, document_key: 'career_cv', status: 'uploaded' },
    ...AU_PATHWAY_GPS.map((d) => ({ id: 'doc-cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded' })),
    // Legacy onboarding certificate rows — applying stopped requiring them
    // on 2026-09-26 (owner: GMC number + identity are the UK check).
    { id: 'doc-cert-overseas', user_id: OVERSEAS_GP.userId, document_key: 'onboarding_specialist_qualification', status: 'pending', storage_path: 'onboarding/uk/overseas/mrcgp.pdf', country_code: 'uk' },
    { id: 'doc-cert-au', user_id: AU_TRAINED_GP.userId, document_key: 'onboarding_specialist_qualification', status: 'pending', storage_path: 'onboarding/uk/au/mrcgp.pdf', country_code: 'uk' }
  ],
  user_roles: [],
  career_roles: [
    // DPA role — qualifies regardless of training country. `masked_title` is
    // what mapCareerRoleRowToClient actually serves as practiceName (Task 10
    // privacy layer masks identity independently of the DPA gate); the real
    // `practice_name` must NEVER reach the client either way.
    {
      id: 'role-dpa-1', provider: 'internal_ats', provider_role_id: 'ats_dpa1',
      title: 'GP — DPA role', practice_name: 'ULTRA SECRET Toowoomba Bush Medical',
      masked_title: 'DPA - Toowoomba',
      is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
      dpa: true, location_state: 'QLD', nearest_city: 'Toowoomba', updated_at: NOW
    },
    // Non-DPA role — only qualifies for an Australia-trained GP.
    {
      id: 'role-nondpa-1', provider: 'internal_ats', provider_role_id: 'ats_nondpa1',
      title: 'GP — Non-DPA role', practice_name: 'ULTRA SECRET Melbourne Family Clinic',
      masked_title: 'Non-DPA - Melbourne',
      is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
      dpa: false, location_state: 'VIC', nearest_city: 'Melbourne', updated_at: NOW
    }
  ],
  gp_applications: []
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

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'career-dpa-secret-' + RUN_ID;
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
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/career/roles — DPA gate for an overseas-trained GP', () => {
  it('shows the DPA role crisp and blurs the non-DPA role with no identifying fields', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_dpa1');
    expect(dpaEntry).toBeTruthy();
    expect(dpaEntry.blurred).toBeFalsy();
    expect(dpaEntry.qualifies).toBe(true);
    // Crisp = the (Task 10) masked headline stays as practiceName (the client
    // derives suburb labels + search from it)…
    expect(dpaEntry.practiceName).toBe('DPA - Toowoomba');
    // …and, because this doctor has a verified careers CV on file, the NAMED
    // tier (owner 2026-09-04) adds the real name alongside it. Name + website
    // only: no address, no identity reveal.
    expect(dpaEntry.nameRevealed).toBe(true);
    expect(dpaEntry.realPracticeName).toBe('ULTRA SECRET Toowoomba Bush Medical');
    expect(dpaEntry.revealed).toBeUndefined();
    expect(dpaEntry.practiceAddress).toBeUndefined();

    const nonDpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_nondpa1');
    expect(nonDpaEntry).toBeTruthy();
    expect(nonDpaEntry.blurred).toBe(true);
    expect(nonDpaEntry.qualifies).toBe(false);
    expect(nonDpaEntry.practiceName).toBe('Confidential practice');
    expect(nonDpaEntry.dpa).toBeUndefined();
    expect(nonDpaEntry.nearest_city).toBeUndefined();
    expect(nonDpaEntry.nameRevealed).toBeUndefined();
    expect(nonDpaEntry.realPracticeName).toBeUndefined();

    // A BLURRED role's real name and suburb must never appear anywhere in the raw response.
    expect(res.raw).not.toContain('Melbourne Family Clinic');
    expect(JSON.stringify(nonDpaEntry)).not.toContain('ULTRA SECRET');

    // Qualifying roles come first, blurred fillers appended after.
    const ids = res.body.roles.map((r) => r.id || null);
    expect(ids.indexOf('internal_ats:ats_dpa1')).toBeLessThan(
      res.body.roles.findIndex((r) => r.blurred)
    );
  });
});

describe('GET /api/career/roles — an Australia-trained GP sees everything crisp', () => {
  it('both roles qualify (not blurred); the non-DPA role is no longer gated', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(AU_TRAINED_GP.email, AU_TRAINED_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.roles.some((r) => r.blurred)).toBe(false);

    const nonDpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_nondpa1');
    expect(nonDpaEntry).toBeTruthy();
    expect(nonDpaEntry.qualifies).toBe(true);
    // Still masked (Task 10's identity reveal gate is independent of the DPA
    // gate) — the real practice name never leaks regardless of qualification.
    expect(nonDpaEntry.practiceName).toBe('Non-DPA - Melbourne');
    // Named tier (verified CV on file): both qualifying roles carry the real
    // name + website fields, never the identity reveal.
    expect(res.body.roles.map((r) => r.realPracticeName)).toEqual(['ULTRA SECRET Toowoomba Bush Medical', 'ULTRA SECRET Melbourne Family Clinic']);
    expect(res.body.roles.every((r) => r.nameRevealed === true && r.revealed === undefined && r.practiceAddress === undefined)).toBe(true);
  });
});

describe('GET /api/career/roles — no careers CV on file stays on the masked tier', () => {
  it('never carries a real practice name, website or nameRevealed flag', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(NO_CV_GP.email, NO_CV_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.roles.length).toBeGreaterThan(0);
    expect(res.body.roles.some((r) => r.blurred)).toBe(false); // Australia-trained: qualifies for both
    expect(res.body.roles.every((r) => r.nameRevealed === undefined && r.realPracticeName === undefined && r.website === undefined)).toBe(true);
    expect(res.raw).not.toContain('ULTRA SECRET');
    expect(res.raw).not.toContain('Bush Medical');
    expect(res.raw).not.toContain('Melbourne Family Clinic');
  });
});

describe('GET /api/career/role — detail endpoint DPA gate (defense in depth)', () => {
  it('an overseas-trained GP fetching the non-DPA role detail directly (e.g. a shared/guessed link) gets a blurred stub, not the real detail', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_nondpa1'), {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.blurred).toBe(true);
    expect(res.body.role.practiceName).toBe('Confidential practice');
    expect(res.body.role.detailCards).toBeUndefined();
    expect(res.raw).not.toContain('ULTRA SECRET');
    expect(res.raw).not.toContain('Melbourne Family Clinic');
  });

  it('the same overseas-trained GP still gets the full detail payload for the DPA role', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_dpa1'), {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.blurred).toBeFalsy();
    expect(Array.isArray(res.body.role.detailCards)).toBe(true);
  });
});

describe('POST /api/career/apply — server-side DPA enforcement', () => {
  it('rejects an overseas-trained GP applying to a non-DPA role with 403 not_qualified', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1' }
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_qualified');
    expect(db.gp_applications.find((a) => a.user_id === OVERSEAS_GP.userId)).toBeFalsy();
  });

  it('still allows the same overseas-trained GP to apply to the DPA role, and stamps origin gp_applied', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId),
      body: { roleId: 'internal_ats:ats_dpa1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = db.gp_applications.find((a) => a.user_id === OVERSEAS_GP.userId && a.career_role_id === 'role-dpa-1');
    expect(saved).toBeTruthy();
    expect(saved.origin).toBe('gp_applied');
  });

  it('allows the Australia-trained GP to apply to the non-DPA role', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(AU_TRAINED_GP.email, AU_TRAINED_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = db.gp_applications.find((a) => a.user_id === AU_TRAINED_GP.userId && a.career_role_id === 'role-nondpa-1');
    expect(saved).toBeTruthy();
    expect(saved.origin).toBe('gp_applied');
  });
});

// Unit tests against the gate helper itself (exported via __testUtils) —
// covers behavior that is hard to reach through the HTTP endpoint: the
// fail-closed error path and the no-mutation guarantee for cached role objects.
describe('_applyGpRoleVisibilityGate — fail-closed + no cache mutation (unit)', () => {
  it('FAILS CLOSED: an unexpected throw mid-gate returns every role as a redacted stub, never the raw list', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poisoned = [
        { id: 'r-ok', practiceName: 'SECRET Practice A', state: 'QLD', dpa: true },
        // Reading .dpa on this role throws — simulates any unexpected runtime
        // fault inside the gate's main path.
        Object.defineProperty({ id: 'r-boom', practiceName: 'SECRET Practice B', state: 'VIC' }, 'dpa', {
          get() { throw new Error('simulated gate fault'); },
          enumerable: true
        })
      ];
      const out = await testUtils._applyGpRoleVisibilityGate(poisoned, OVERSEAS_GP.userId, OVERSEAS_GP.email);
      expect(out).toHaveLength(2);
      // EVERY role comes back blurred/redacted — including the DPA one that
      // would have qualified had the gate not faulted.
      out.forEach((r) => {
        expect(r.blurred).toBe(true);
        expect(r.qualifies).toBe(false);
        expect(r.practiceName).toBe('Confidential practice');
      });
      expect(JSON.stringify(out)).not.toContain('SECRET');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dpa-gate] visibility gate failed — failing closed'),
        expect.any(Error)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('never mutates the input role objects (shared _zohoRolesCache safety) and writes qualifyReason, not reason', async () => {
    const cachedRole = { id: 'r-cached', practiceName: 'Masked Cached Role', state: 'VIC', nearest_city: 'Melbourne', dpa: false, qualifies: true };
    const frozenSnapshot = JSON.stringify(cachedRole);

    const out = await testUtils._applyGpRoleVisibilityGate([cachedRole], OVERSEAS_GP.userId, OVERSEAS_GP.email);

    // The cached object is byte-for-byte untouched: no qualifies flip, no
    // reason/qualifyReason keys stamped onto it.
    expect(JSON.stringify(cachedRole)).toBe(frozenSnapshot);

    // The returned stub carries the aligned qualifyReason key (what
    // buildRedactedRoleStub reads), and no stray `reason` key anywhere.
    expect(out).toHaveLength(1);
    expect(out[0].blurred).toBe(true);
    expect(out[0].qualifyReason).toBe('dpa_restricted');
    expect(out[0].reason).toBeUndefined();
  });

  it('qualifying roles come back as copies too, with qualifies true and empty qualifyReason', async () => {
    const cachedRole = { id: 'r-cached-dpa', practiceName: 'Masked DPA Role', state: 'QLD', nearest_city: 'Toowoomba', dpa: true, qualifies: true };
    const out = await testUtils._applyGpRoleVisibilityGate([cachedRole], OVERSEAS_GP.userId, OVERSEAS_GP.email);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(cachedRole); // copy, not the cached object itself
    expect(out[0].qualifies).toBe(true);
    expect(out[0].qualifyReason).toBe('');
    expect(out[0].practiceName).toBe('Masked DPA Role');
    expect(cachedRole.qualifyReason).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// WP-08 (Australian GP build): the gate follows the pathway flag, not the country
// ═════════════════════════════════════════════════════════════════════════════
describe('the gate follows the pathway flag (dpaRestricted), not the country', () => {
  const rolesFor = (d) => httpReq('GET', '/api/career/roles', { cookie: userCookie(d.email, d.userId) });
  const withSwitch = async (value, fn) => {
    const before = process.env.AU_PATHWAY_ENABLED;
    process.env.AU_PATHWAY_ENABLED = value;
    try { return await fn(); } finally {
      if (before === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = before;
    }
  };

  // WP-29 (deliberate): the doctor's own answer here is now "not sure" (it was
  // "no", which now opens their own view: next test). The property is the
  // same: staff have not confirmed, the country reads Australia, and that
  // unlocks nothing.
  it('an au_vr doctor who is not sure about 19AB and whom staff have NOT confirmed: country Australia unlocks nothing (DPA roles only)', async () => {
    const res = await rolesFor(AU_VR_UNCONFIRMED_GP);
    expect(res.status).toBe(200);
    expect(res.body.auAreaLimited).toBe(true);
    const crisp = res.body.roles.filter((r) => r.qualifies);
    const blurred = res.body.roles.filter((r) => !r.qualifies);
    expect(crisp.map((r) => r.practiceName)).toEqual(['DPA - Toowoomba']);
    expect(blurred.length).toBe(1);
    expect(blurred[0].blurred).toBe(true);
    expect(blurred[0].qualifyReason).toBe('dpa_restricted');
    expect(res.raw).not.toContain('Non-DPA - Melbourne');
    // (The DPA role they DO qualify for is named, as for any doctor with a
    // verified CV. Nothing about the role outside a DPA leaves the server.)
    expect(res.raw).not.toContain('ULTRA SECRET Melbourne');

    const detail = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_nondpa1'), { cookie: userCookie(AU_VR_UNCONFIRMED_GP.email, AU_VR_UNCONFIRMED_GP.userId) });
    expect(detail.body.role.blurred).toBe(true);
    expect(detail.raw).not.toContain('Non-DPA - Melbourne');

    const apply = await httpReq('POST', '/api/career/apply', { cookie: userCookie(AU_VR_UNCONFIRMED_GP.email, AU_VR_UNCONFIRMED_GP.userId), body: { roleId: 'internal_ats:ats_nondpa1' } });
    expect(apply.status).toBe(403);
    expect(apply.body.error).toBe('not_qualified');
    expect(apply.body.code).toBe('dpa_restricted');
    expect(db.gp_applications.find((a) => a.user_id === AU_VR_UNCONFIRMED_GP.userId)).toBeFalsy();
  });

  // WP-29 (deliberate): the new rule. It is the doctor's ANSWER, not their
  // country, that opens their view: AU_VR_UNCONFIRMED_GP above has the same
  // country and pathway and stays on DPA roles. Staff still have to confirm
  // before anything goes to a practice.
  it('an au_vr doctor who says 19AB does not apply (staff have not confirmed): sees and may apply for every role, on their own word only', async () => {
    const res = await rolesFor(AU_VR_OWN_NO_GP);
    expect(res.status).toBe(200);
    expect(res.body.auHold).toBeUndefined();
    expect(res.body.auAreaLimited).toBeUndefined();
    expect(res.body.roles.length).toBe(2);
    expect(res.body.roles.every((r) => r.qualifies === true && !r.blurred)).toBe(true);
    const p = await testUtils.resolveCandidatePathway(AU_VR_OWN_NO_GP.userId);
    expect(p).toMatchObject({ dpaRestricted: false, dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed', checkComplete: false });
    const apply = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(AU_VR_OWN_NO_GP.email, AU_VR_OWN_NO_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1', shareConsent: { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION } }
    });
    expect(apply.status).toBe(200);
    // ...and the practice introduction for that role would be refused.
    const rule = require('../lib/role-eligibility.js');
    expect(rule.auIntroductionBlock(p, { dpa: false }, { registerVerified: p.checkComplete })).toMatchObject({ code: 'ahpra_check_not_verified' });
    expect(rule.auIntroductionBlock(p, { dpa: false }, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });
  });

  it('an au_vr doctor with a staff-confirmed "19AB does not apply" sees and may apply for every role', async () => {
    const res = await rolesFor(AU_VR_CLEARED_GP);
    expect(res.body.roles.length).toBe(2);
    expect(res.body.roles.every((r) => r.qualifies === true && !r.blurred)).toBe(true);
    // APP-19 data: the plain facts ride along for an Australian doctor only.
    expect(res.body.roles[0].auFacts).toBeTruthy();
    expect(res.body.roles[0].auFacts.vrRequirement).toBe('vr_required');
    // WP-09: an Australian doctor's apply carries their agreement to be put
    // forward to this practice (the tick on the apply sheet). Without it the
    // answer is 400 consent_required; this case is about the DPA gate.
    const withoutTick = await httpReq('POST', '/api/career/apply', { cookie: userCookie(AU_VR_CLEARED_GP.email, AU_VR_CLEARED_GP.userId), body: { roleId: 'internal_ats:ats_nondpa1' } });
    expect(withoutTick.status).toBe(400);
    expect(withoutTick.body.code).toBe('consent_required');
    const apply = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(AU_VR_CLEARED_GP.email, AU_VR_CLEARED_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1', shareConsent: { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION } }
    });
    expect(apply.status).toBe(200);
    expect(db.gp_applications.find((a) => a.user_id === AU_VR_CLEARED_GP.userId && a.career_role_id === 'role-nondpa-1')).toBeTruthy();
  });

  // WP-29 (deliberate): segment B is no longer held just for being segment B.
  // THIS doctor still is: general registration only, so not a vocationally
  // registered GP (a self-set vr_status does not make one). The hold payloads
  // now also carry the kind and the card title.
  it('an au_restricted doctor who is not a vocationally registered GP (segment B, not launched) is HELD: no roles, an honest message, and apply is refused server-side', async () => {
    expect(await testUtils.resolveCandidatePathway(AU_RESTRICTED_GP.userId)).toMatchObject({ launched: false, selfServiceHeld: true, holdKind: 'review', holdWhy: 'non_vr' });
    const res = await rolesFor(AU_RESTRICTED_GP);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
    expect(res.body.auHold).toEqual({ held: true, kind: 'review', title: 'Thanks, we have your details', message: 'Our team is confirming your details and will be in touch by email.' });
    expect(res.raw).not.toContain('Toowoomba');
    const apply = await httpReq('POST', '/api/career/apply', { cookie: userCookie(AU_RESTRICTED_GP.email, AU_RESTRICTED_GP.userId), body: { roleId: 'internal_ats:ats_dpa1' } });
    expect(apply.status).toBe(403);
    expect(apply.body.error).toBe('pathway_on_hold');
    expect(apply.body).toMatchObject({ code: 'au_hold', auHold: true, auHoldKind: 'review', title: 'Thanks, we have your details' });
    expect(apply.body.message).toBe('Our team is confirming your details and will be in touch by email.');
    expect(db.gp_applications.find((a) => a.user_id === AU_RESTRICTED_GP.userId)).toBeFalsy();
  });

  it('an overseas doctor has no hold, no auFacts and no new keys: the list is what it was', async () => {
    const res = await rolesFor(OVERSEAS_GP);
    expect(res.body.auHold).toBeUndefined();
    res.body.roles.forEach((r) => { expect(r.auFacts).toBeUndefined(); expect(r.distanceKm).toBeUndefined(); });
    const offRaw = (await withSwitch('false', () => rolesFor(OVERSEAS_GP))).raw;
    expect(res.raw).toBe(offRaw);
    const auTrainedOn = await rolesFor(AU_TRAINED_GP);
    const auTrainedOff = await withSwitch('false', () => rolesFor(AU_TRAINED_GP));
    expect(auTrainedOn.raw).toBe(auTrainedOff.raw);
  });

  it('SWITCH OFF: a stored Australian pathway is invisible, so those doctors read as their country says (today)', async () => {
    await withSwitch('false', async () => {
      for (const d of [AU_VR_UNCONFIRMED_GP, AU_RESTRICTED_GP]) {
        const res = await rolesFor(d);
        expect(res.body.auHold, d.email).toBeUndefined();
        expect(res.body.roles.length, d.email).toBe(2);
        expect(res.body.roles.every((r) => r.qualifies === true), d.email).toBe(true);
        res.body.roles.forEach((r) => expect(r.auFacts).toBeUndefined());
      }
    });
  });

  it('every former country-test call site now goes through the one function', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // The old test is gone from the server: nothing calls gpQualifiesForRole,
    // and nothing hands a bare country boolean to a role check.
    expect(src).not.toMatch(/gpQualifiesForRole\(/);
    expect(src).not.toMatch(/australiaTrained: [a-zA-Z]+\.australiaTrained \}\)/);
    expect(src).not.toMatch(/dpa === true \|\| ro[A-Za-z]*DpaEligible/);
    // The list, the role page and apply each ask the one rule.
    const count = (re) => (src.match(re) || []).length;
    expect(count(/roleEligibility\.roleEligibilityFor\(/g)).toBeGreaterThanOrEqual(5);
    for (const marker of ['gateCtx.pathway', 'roleDetailCtx.pathway', 'applyCtx.pathway', 'roPathway']) {
      expect(src, marker).toContain('roleEligibility.roleEligibilityFor(' + marker);
    }
    // AI matching's dpaEligible is derived from the pathway result, not the country.
    expect(src).toContain('dpaEligible: !gpPathwayUnreadable && gpPathway.dpaRestricted === false');
    expect(src).not.toContain('dpaEligible: _isAustraliaTrainedCountry(rawCountry)');
    // The country helper survives only as the resolver's legacy input.
    const uses = src.split('\n').filter((l) => /_isAustraliaTrainedCountry\(/.test(l) && !/^function /.test(l.trim()));
    // (The third use is the admin "seed onboarding" validator, which only
    // checks that a test doctor seeded as Australian is given a pathway.)
    expect(uses.length).toBe(3);
    expect(uses.join('\n')).toContain('out.australiaTrained = _isAustraliaTrainedCountry(rawCountry)');
    expect(uses.join('\n')).toContain('var gpLegacyExempt = _isAustraliaTrainedCountry(rawCountry)');
    expect(uses.join('\n')).toContain('if (_isAustraliaTrainedCountry(country)) {');
    // WP-05's interim guard inside _resolveGpJobsProfile is gone.
    expect(src).not.toContain('out.australiaTrained = jobsPathway.dpaRestricted === false');
    // The library the server used to call answers through the same rule.
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib/practice-pipeline.js'), 'utf8');
    expect(lib).toContain("require('./role-eligibility.js').roleEligibilityFor(");
    const match = fs.readFileSync(path.join(__dirname, '..', 'lib/ai-candidate-job-match.js'), 'utf8');
    expect(match).toContain('roleEligibility.roleEligibilityFor(pathway, j)');
    expect(match).not.toContain("if (j.dpa !== true && g.dpaEligible !== true) blocks.push('dpa_ineligible')");
  });
});
