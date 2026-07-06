// Phase 6 E2 (audit B5): owner-editable public site stats.
//   GET  /api/public/stats        — per-stat precedence override > live > default,
//                                   with the gpsPlaced SEED FLOOR: the live
//                                   placements count only shows publicly once
//                                   it exceeds the hardcoded seed (150)
//   GET  /api/admin/site-stats    — CEO-gated editor view (value + source)
//   POST /api/admin/site-stats    — CEO-gated override save (replace semantics)
//
// Boots the real server in LOCAL-JSON mode (Supabase unconfigured, same
// convention as tests/site-admin-enquiries.test.js) so the overrides exercise
// the dbState.siteStatsOverrides fallback and the gpsPlaced live derivation
// exercises the dbState.atsPlacements local placements store.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-site-stats-${RUN_ID}.json`;
const SUPER_HOST = 'site-stats-test.local';
let server, port, testUtils;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
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
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const asCeo = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const noAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });
const publicStats = () => httpReq('GET', '/api/public/stats', {});

function placementRow(i) {
  return {
    id: 'pl-' + i,
    application_id: 'app-' + i,
    user_id: 'u-' + i,
    practice_name: 'Practice ' + i,
    job_title: 'GP',
    placed_at: '2026-06-0' + ((i % 9) + 1) + 'T00:00:00.000Z',
    status: 'active'
  };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'site-stats-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = '';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteStatsOverridesForTest();
  testUtils.__seedAtsPlacementsForTest([]);
});

describe('auth gating', () => {
  it('GET /api/admin/site-stats 401s with no admin session', async () => {
    const res = await noAuth('GET', '/api/admin/site-stats');
    expect(res.status).toBe(401);
  });

  it('POST /api/admin/site-stats 401s with no admin session', async () => {
    const res = await noAuth('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: 999 } });
    expect(res.status).toBe(401);
  });

  it('GET /api/public/stats needs no session at all', async () => {
    const res = await publicStats();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/public/stats — precedence', () => {
  it('with no overrides and no placements, serves the hardcoded defaults', async () => {
    const res = await publicStats();
    expect(res.body).toEqual({
      ok: true,
      jobsCount: 1470, // SITE_STATS.jobsFallback — no Supabase in this boot
      locations: 830,
      avgPlacementDays: 22,
      gpsPlaced: 150,
      satisfaction: 100
    });
  });

  it('with 0 real placements and no override, gpsPlaced is the seed default — never 0', async () => {
    testUtils.__seedAtsPlacementsForTest([]);
    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(150);
  });

  it('a small real placements count never drags gpsPlaced below the seed default', async () => {
    testUtils.__seedAtsPlacementsForTest([placementRow(1), placementRow(2), placementRow(3)]);
    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(150); // seed floor: 3 real < 150 seed
    // Other stats untouched by the placements seed.
    expect(res.body.locations).toBe(830);
  });

  it('gpsPlaced surfaces the real placements count once it exceeds the seed', async () => {
    const rows = [];
    for (let i = 1; i <= 151; i++) rows.push(placementRow(i));
    testUtils.__seedAtsPlacementsForTest(rows);
    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(151); // 151 real > 150 seed → live wins
  });

  it('owner overrides win over both live and default values', async () => {
    testUtils.__seedAtsPlacementsForTest([placementRow(1), placementRow(2)]);
    const save = await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: 500, locations: 900 } });
    expect(save.status).toBe(200);
    expect(save.body.ok).toBe(true);

    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(500);     // override beats live (2) and seed (150)
    expect(res.body.locations).toBe(900);     // override beats default (830)
    expect(res.body.avgPlacementDays).toBe(22); // untouched → default
    expect(res.body.satisfaction).toBe(100);    // untouched → default
  });

  it('an explicit owner override wins even when LOWER than the seed default', async () => {
    await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: 42 } });
    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(42); // owner said 42 → 42, floor does not apply to overrides
  });

  it('posting {} clears every override (reset to computed)', async () => {
    testUtils.__seedAtsPlacementsForTest([placementRow(1), placementRow(2)]);
    await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: 500, locations: 900 } });
    const reset = await asCeo('POST', '/api/admin/site-stats', { overrides: {} });
    expect(reset.status).toBe(200);

    const res = await publicStats();
    expect(res.body.gpsPlaced).toBe(150); // back to computed: 2 real < 150 seed → seed
    expect(res.body.locations).toBe(830); // back to default
  });
});

describe('GET /api/admin/site-stats — editor view', () => {
  it('reports source=default when nothing is overridden or live', async () => {
    const res = await asCeo('GET', '/api/admin/site-stats');
    expect(res.status).toBe(200);
    expect(res.body.stats.gpsPlaced).toMatchObject({ value: 150, source: 'default', override: null });
    expect(res.body.stats.locations.source).toBe('default');
    expect(res.body.stats.jobsCount.source).toBe('live');
  });

  it('still exposes the REAL placements count (live) while the seed floor holds the value', async () => {
    testUtils.__seedAtsPlacementsForTest([placementRow(1)]);
    const res = await asCeo('GET', '/api/admin/site-stats');
    // 1 real placement < 150 seed → public value stays at the seed, but the
    // editor sees the honest live count ("Actual recorded placements: 1").
    expect(res.body.stats.gpsPlaced).toMatchObject({ value: 150, source: 'default', live: 1, computed: 150, default: 150 });
  });

  it('reports source=live once the real count exceeds the seed', async () => {
    const rows = [];
    for (let i = 1; i <= 155; i++) rows.push(placementRow(i));
    testUtils.__seedAtsPlacementsForTest(rows);
    const res = await asCeo('GET', '/api/admin/site-stats');
    expect(res.body.stats.gpsPlaced).toMatchObject({ value: 155, source: 'live', live: 155, computed: 155, default: 150 });
  });

  it('reports source=override with the override value after a save', async () => {
    const save = await asCeo('POST', '/api/admin/site-stats', { overrides: { satisfaction: 98 } });
    expect(save.body.stats.satisfaction).toMatchObject({ value: 98, source: 'override', override: 98 });
    const res = await asCeo('GET', '/api/admin/site-stats');
    expect(res.body.stats.satisfaction.source).toBe('override');
  });
});

describe('POST /api/admin/site-stats — validation', () => {
  it('rejects negative numbers', async () => {
    const res = await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: -5 } });
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric values', async () => {
    const res = await asCeo('POST', '/api/admin/site-stats', { overrides: { locations: 'lots' } });
    expect(res.status).toBe(400);
  });

  it('rejects satisfaction above 100', async () => {
    const res = await asCeo('POST', '/api/admin/site-stats', { overrides: { satisfaction: 150 } });
    expect(res.status).toBe(400);
  });

  it('null / empty-string fields clear the override instead of erroring', async () => {
    await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: 400 } });
    const res = await asCeo('POST', '/api/admin/site-stats', { overrides: { gpsPlaced: null, locations: '' } });
    expect(res.status).toBe(200);
    expect(res.body.stats.gpsPlaced.source).toBe('default');
  });
});

describe('validateSiteStatsOverridesPayload (pure)', () => {
  it('ignores unknown keys and keeps whitelisted ones', () => {
    const out = testUtils.validateSiteStatsOverridesPayload({ overrides: { gpsPlaced: 12, jobsCount: 9999, evil: 'x' } });
    expect(out.ok).toBe(true);
    expect(out.overrides).toEqual({ gpsPlaced: 12 }); // jobsCount has NO override by design
  });

  it('rounds fractional values to integers', () => {
    const out = testUtils.validateSiteStatsOverridesPayload({ overrides: { locations: 830.7 } });
    expect(out.overrides.locations).toBe(831);
  });

  it('accepts a flat body without the overrides wrapper', () => {
    const out = testUtils.validateSiteStatsOverridesPayload({ satisfaction: 97 });
    expect(out.ok).toBe(true);
    expect(out.overrides).toEqual({ satisfaction: 97 });
  });
});
