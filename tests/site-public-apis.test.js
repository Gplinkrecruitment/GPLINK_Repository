import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// Coverage for the two new public (no-session) marketing-site APIs:
//   GET /api/public/jobs  — sanitized, filtered, paginated read of career_roles
//   GET /api/public/stats — SITE_STATS constants + a live (cached) jobsCount
//
// Two test strategies, matching how the production code is structured:
//  1. HTTP round-trip tests against a real booted server (Supabase left
//     UNCONFIGURED, same pattern as tests/site-public-routes.test.js) — these
//     prove the routes exist, require no session, and degrade gracefully
//     (empty jobs list / SITE_STATS.jobsFallback) when there is no database.
//  2. Direct unit tests against the exported __testUtils pure functions
//     (mapCareerRoleRowToPublicJob, sanitizePublicJob, classifyPublicJobType,
//     buildPublicJobsResponse) — these are the EXACT functions the live route
//     handler calls, so exercising them directly with seeded career_roles-shaped
//     fixture rows covers the filter/whitelist/pagination semantics without
//     needing to fake a Supabase REST backend.

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;
let testUtils;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-site-public-apis-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-public-apis-${RUN_ID}.json`;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// HTTP round-trip: no session required + graceful no-DB behaviour
// ---------------------------------------------------------------------------

describe('GET /api/public/jobs (HTTP)', () => {
  it('is 200 with no session cookie at all', async () => {
    const res = await get('/api/public/jobs');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it('returns the { total, limit, offset, jobs } shape, empty-safe with no database configured', async () => {
    const res = await get('/api/public/jobs');
    expect(res.json).toMatchObject({ ok: true, total: 0, limit: 24, offset: 0, jobs: [] });
  });

  it('defaults limit to 24 and caps it at 100', async () => {
    const uncapped = await get('/api/public/jobs?limit=9999');
    expect(uncapped.json.limit).toBe(100);
    const zero = await get('/api/public/jobs?limit=0');
    expect(zero.json.limit).toBe(24);
    const negative = await get('/api/public/jobs?limit=-5');
    expect(negative.json.limit).toBe(24);
  });
});

describe('GET /api/public/stats (HTTP)', () => {
  it('is 200 with no session cookie and returns the exact SITE_STATS constants', async () => {
    const res = await get('/api/public/stats');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      jobsCount: 1470, // SITE_STATS.jobsFallback — no Supabase configured in this boot
      locations: 830,
      avgPlacementDays: 22,
      gpsPlaced: 150,
      satisfaction: 100
    });
  });

  it('jobsCount is always a number', async () => {
    const res = await get('/api/public/stats');
    expect(typeof res.json.jobsCount).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests against the exact functions the route handler calls
// ---------------------------------------------------------------------------

const PUBLIC_JOB_FIELDS = [
  'id', 'title', 'practice_name', 'location_label', 'location_state',
  'billing_model', 'dpa', 'mmm', 'earnings_text', 'summary',
  'employment_type', 'tags', 'published_at'
];

function makeRawRow(overrides) {
  return {
    id: 1,
    provider: 'zoho_recruit',
    provider_role_id: 'ZR-000',
    title: 'General Practitioner',
    practice_name: 'Sample Medical Centre',
    location_city: 'Brisbane',
    location_state: 'QLD',
    location_country: 'Australia',
    location_label: '',
    billing_model: 'Mixed Billing',
    dpa: false,
    mmm: 'MMM 1',
    earnings_text: '$300k package',
    summary: 'A sample role.',
    employment_type: 'Full-time',
    practice_type: 'Medical Centre',
    support_summary: '',
    tags: [],
    visa_pathway_aligned: false,
    family_friendly: false,
    private_billing: false,
    mixed_billing: true,
    metro: true,
    regional: false,
    is_active: true,
    // These must NEVER reach the public API response:
    source_payload: { secret: 'internal-zoho-payload', apiKeyLike: 'sk-should-not-leak' },
    synced_at: '2026-06-01T00:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    published_at: '2026-06-01T00:00:00.000Z',
    ...overrides
  };
}

describe('mapCareerRoleRowToPublicJob + sanitizePublicJob (whitelist)', () => {
  it('the sanitized job object contains ONLY the whitelisted keys, and source_payload is absent', () => {
    const row = makeRawRow({});
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    const sanitized = testUtils.sanitizePublicJob(mapped);
    expect(Object.keys(sanitized).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
    expect(sanitized.source_payload).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toMatch(/internal-zoho-payload|sk-should-not-leak|synced_at/);
  });

  it('sanitizing a raw row directly (bypassing the mapper) still strips source_payload', () => {
    // Defensive whitelist test: even a raw DB row (which DOES carry source_payload)
    // must come out clean if it were ever passed straight into the sanitizer.
    const row = makeRawRow({});
    const sanitized = testUtils.sanitizePublicJob(row);
    expect(sanitized.source_payload).toBeUndefined();
    expect(Object.keys(sanitized).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
  });

  it('maps dpa to a real boolean and tags to a clean string array', () => {
    const row = makeRawRow({ dpa: true, tags: ['VR-GP', 'DPA', 42, null, '  '] });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.dpa).toBe(true);
    expect(mapped.tags).toEqual(['VR-GP', 'DPA']);
  });
});

describe('classifyPublicJobType', () => {
  it('classifies a VR-tagged role as vr-gp', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      title: 'General Practitioner (VR)', tags: ['VR-GP'], summary: 'VR GP required.'
    }));
    expect(testUtils.classifyPublicJobType(mapped)).toBe('vr-gp');
  });

  it('classifies a Non-VR-tagged role as non-vr-gp (not vr-gp)', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      title: 'Non-VR GP', tags: ['Non-VR', 'Supervised'], summary: 'Non-VR GP welcome, supervision provided.'
    }));
    expect(testUtils.classifyPublicJobType(mapped)).toBe('non-vr-gp');
  });

  it('classifies a locum role as locum', () => {
    const mapped = testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      title: 'Locum GP', tags: ['Locum'], employment_type: 'Locum', summary: 'Locum GP needed for 3-month placement.'
    }));
    expect(testUtils.classifyPublicJobType(mapped)).toBe('locum');
  });
});

describe('buildPublicJobsResponse — filters, whitelist, pagination (the exact function the route calls)', () => {
  const rows = [
    makeRawRow({ id: 1, provider_role_id: 'ZR-001', title: 'General Practitioner (VR)', practice_name: 'Riverside Medical Centre', location_city: 'Brisbane', location_state: 'QLD', location_label: 'Riverside, QLD', tags: ['VR-GP', 'DPA'], summary: 'VR GP required for a busy riverside clinic.' }),
    makeRawRow({ id: 2, provider_role_id: 'ZR-002', title: 'Locum GP', practice_name: 'Outback Family Practice', location_city: 'Toowoomba', location_state: 'QLD', location_label: 'Toowoomba, QLD', tags: ['Locum'], employment_type: 'Locum', summary: 'Locum GP needed for rural placement.' }),
    makeRawRow({ id: 3, provider_role_id: 'ZR-003', title: 'Non-VR GP', practice_name: 'Melbourne Central Clinic', location_city: 'Melbourne', location_state: 'VIC', location_label: 'Melbourne, VIC', tags: ['Non-VR', 'Supervised'], summary: 'Non-VR GP welcome, supervision provided.' }),
    makeRawRow({ id: 4, provider_role_id: 'ZR-004', title: 'General Practitioner (VR)', practice_name: 'Harbourside Practice', location_city: 'Sydney', location_state: 'NSW', location_label: 'Sydney, NSW', tags: ['VR-GP'], summary: 'VR GP opportunity in Sydney.' }),
    makeRawRow({ id: 5, provider_role_id: 'ZR-005', title: 'Locum GP', practice_name: 'Southbank Clinic', location_city: 'Melbourne', location_state: 'VIC', location_label: 'Southbank, VIC', tags: ['Locum'], employment_type: 'Locum', summary: 'Short-term locum cover in Melbourne.' })
  ];

  it('with no filters, returns all rows sanitized to the whitelist', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams());
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.jobs.length).toBe(5);
    for (const job of result.jobs) {
      expect(Object.keys(job).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
    }
  });

  it('state=QLD returns only QLD roles (case-insensitive)', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ state: 'qld' }));
    expect(result.total).toBe(2);
    expect(result.jobs.every((j) => j.location_state === 'QLD')).toBe(true);
  });

  it('q substring-matches title/practice_name/location_label/tags, case-insensitively', () => {
    const byPractice = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'outback' }));
    expect(byPractice.total).toBe(1);
    expect(byPractice.jobs[0].practice_name).toBe('Outback Family Practice');

    const byLocation = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'SYDNEY' }));
    expect(byLocation.total).toBe(1);
    expect(byLocation.jobs[0].location_label).toBe('Sydney, NSW');

    const byTag = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'vr-gp' }));
    expect(byTag.total).toBe(2);
  });

  it('type=locum / vr-gp / non-vr-gp each filter to the right subset', () => {
    const locum = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'locum' }));
    expect(locum.total).toBe(2);
    expect(locum.jobs.map((j) => j.practice_name).sort()).toEqual(['Outback Family Practice', 'Southbank Clinic']);

    const vr = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'vr-gp' }));
    expect(vr.total).toBe(2);
    expect(vr.jobs.map((j) => j.practice_name).sort()).toEqual(['Harbourside Practice', 'Riverside Medical Centre']);

    const nonVr = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'non-vr-gp' }));
    expect(nonVr.total).toBe(1);
    expect(nonVr.jobs[0].practice_name).toBe('Melbourne Central Clinic');
  });

  it('limit caps the returned jobs while total still reflects the pre-limit filtered count', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ limit: '2' }));
    expect(result.limit).toBe(2);
    expect(result.jobs.length).toBe(2);
    expect(result.total).toBe(5);
  });

  it('offset paginates past the first page', () => {
    const page1 = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ limit: '2', offset: '0' }));
    const page2 = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ limit: '2', offset: '2' }));
    expect(page1.jobs.map((j) => j.id)).not.toEqual(page2.jobs.map((j) => j.id));
    expect(page2.offset).toBe(2);
  });
});
