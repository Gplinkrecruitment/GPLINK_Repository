import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// Coverage for the two new public (no-session) marketing-site APIs:
//   GET /api/public/jobs  — sanitized, filtered, paginated read of career_roles
//   GET /api/public/stats — the static SITE_STATS constants, served verbatim
//
// Two test strategies, matching how the production code is structured:
//  1. HTTP round-trip tests against a real booted server (Supabase left
//     UNCONFIGURED, same pattern as tests/site-public-routes.test.js) — these
//     prove the routes exist, require no session, and degrade gracefully
//     (empty jobs list) when there is no database.
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

  it('?id= round-trips through the real route (empty-safe with no database configured)', async () => {
    const res = await get('/api/public/jobs?id=' + encodeURIComponent('zoho_recruit:ZR-001'));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, total: 0, offset: 0, jobs: [] });
  });
});

describe('GET /api/public/stats (HTTP)', () => {
  it('is 200 with no session cookie and returns the exact static SITE_STATS constants', async () => {
    const res = await get('/api/public/stats');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      jobsCount: 240, // static owner-set figure (no live computation any more)
      locations: 230,
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

// practice_name is intentionally ABSENT — the marketing site (no session, no
// reveal gate) must only ever see the masked title/display_label. See
// canRevealPracticeIdentity() in server.js for the session-gated in-app
// equivalent that IS allowed to surface the real name once earned.
const PUBLIC_JOB_FIELDS = [
  'id', 'title', 'location_label', 'location_state',
  'billing_model', 'dpa', 'mmm', 'earnings_text', 'summary',
  'employment_type', 'tags', 'published_at',
  'display_label', 'header_image_url', 'suburb', 'nearest_city',
  'visa', 'packageTerms'
];

function makeRawRow(overrides) {
  return {
    id: 1,
    provider: 'zoho_recruit',
    provider_role_id: 'ZR-000',
    title: 'General Practitioner',
    // The raw DB row DOES carry the real practice name (and, once the
    // practice-client pipeline migration lands, masked_title/suburb/etc.) —
    // that's exactly why the mapper/sanitizer whitelist below is load-bearing.
    practice_name: 'Sample Medical Centre',
    masked_title: '',
    header_image_url: '',
    suburb: '',
    nearest_city: '',
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
  it('the sanitized job object contains ONLY the whitelisted keys, and source_payload/practice_name are absent', () => {
    const row = makeRawRow({});
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    const sanitized = testUtils.sanitizePublicJob(mapped);
    expect(Object.keys(sanitized).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
    expect(sanitized.source_payload).toBeUndefined();
    expect(sanitized.practice_name).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toMatch(/internal-zoho-payload|sk-should-not-leak|synced_at/);
  });

  it('the real practice name never appears anywhere in the sanitized job — even inside another field', () => {
    const row = makeRawRow({ practice_name: 'Riverside Medical Centre' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    const sanitized = testUtils.sanitizePublicJob(mapped);
    expect(JSON.stringify(sanitized)).not.toMatch(/Riverside Medical Centre/);
  });

  it('sanitizing a raw row directly (bypassing the mapper) still strips source_payload AND practice_name', () => {
    // Defensive whitelist test: even a raw DB row (which DOES carry
    // source_payload and practice_name) must come out clean if it were ever
    // passed straight into the sanitizer, bypassing the mapper entirely.
    const row = makeRawRow({});
    const sanitized = testUtils.sanitizePublicJob(row);
    expect(sanitized.source_payload).toBeUndefined();
    expect(sanitized.practice_name).toBeUndefined();
    expect(Object.keys(sanitized).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
  });

  it('maps dpa to a real boolean and tags to a clean string array', () => {
    const row = makeRawRow({ dpa: true, tags: ['VR-GP', 'DPA', 42, null, '  '] });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.dpa).toBe(true);
    expect(mapped.tags).toEqual(['VR-GP', 'DPA']);
  });

  it('title prefers masked_title over the raw title when present', () => {
    const row = makeRawRow({ title: 'Dr Smith GP role at Riverside', masked_title: 'DPA - Brisbane - Mixed Billing' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.title).toBe('DPA - Brisbane - Mixed Billing');
  });

  it('falls back to the raw title when masked_title is absent (legacy/pre-migration rows)', () => {
    const row = makeRawRow({ title: 'General Practitioner', masked_title: '' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.title).toBe('General Practitioner');
  });

  it('builds display_label from billing_model/dpa/nearest_city (never from practice_name)', () => {
    // billing_model on a practice-client-pipeline row (task 6) is the raw
    // style key ('mixed'/'bulk'/'private'), not a human label — that's the
    // key buildMaskedDisplayLabel's BILLING_LABELS map expects.
    const row = makeRawRow({ billing_model: 'bulk', dpa: true, nearest_city: 'Perth' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.display_label).toBe('Bulk Billing · DPA · near Perth');
  });

  it('carries header_image_url/suburb/nearest_city through when present', () => {
    const row = makeRawRow({ header_image_url: 'https://cdn.example.com/hero.jpg', suburb: 'Toowong', nearest_city: 'Brisbane' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.header_image_url).toBe('https://cdn.example.com/hero.jpg');
    expect(mapped.suburb).toBe('Toowong');
    expect(mapped.nearest_city).toBe('Brisbane');
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
  // Each row still carries a real (sensitive) practice_name — exactly like a
  // live career_roles row would — so these tests double as a masking
  // regression suite: the practice_name text must never surface anywhere in
  // a response, even via search/filter/pagination paths.
  const rows = [
    makeRawRow({ id: 1, provider_role_id: 'ZR-001', title: 'General Practitioner (VR)', practice_name: 'Riverside Medical Centre', location_city: 'Brisbane', location_state: 'QLD', location_label: 'Riverside, QLD', tags: ['VR-GP', 'DPA'], summary: 'VR GP required for a busy riverside clinic.' }),
    makeRawRow({ id: 2, provider_role_id: 'ZR-002', title: 'Outback Rural Locum GP', practice_name: 'Outback Family Practice', location_city: 'Toowoomba', location_state: 'QLD', location_label: 'Toowoomba, QLD', tags: ['Locum'], employment_type: 'Locum', summary: 'Locum GP needed for rural placement.' }),
    makeRawRow({ id: 3, provider_role_id: 'ZR-003', title: 'Non-VR GP', practice_name: 'Melbourne Central Clinic', location_city: 'Melbourne', location_state: 'VIC', location_label: 'Melbourne, VIC', tags: ['Non-VR', 'Supervised'], summary: 'Non-VR GP welcome, supervision provided.' }),
    makeRawRow({ id: 4, provider_role_id: 'ZR-004', title: 'General Practitioner (VR)', practice_name: 'Harbourside Practice', location_city: 'Sydney', location_state: 'NSW', location_label: 'Sydney, NSW', tags: ['VR-GP'], summary: 'VR GP opportunity in Sydney.' }),
    makeRawRow({ id: 5, provider_role_id: 'ZR-005', title: 'Locum GP', practice_name: 'Southbank Clinic', location_city: 'Melbourne', location_state: 'VIC', location_label: 'Southbank, VIC', tags: ['Locum'], employment_type: 'Locum', summary: 'Short-term locum cover in Melbourne.' })
  ];
  const ALL_PRACTICE_NAMES = ['Riverside Medical Centre', 'Outback Family Practice', 'Melbourne Central Clinic', 'Harbourside Practice', 'Southbank Clinic'];

  function expectNoPracticeNameLeak(result) {
    const json = JSON.stringify(result);
    for (const name of ALL_PRACTICE_NAMES) {
      expect(json).not.toMatch(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }

  it('with no filters, returns all rows sanitized to the whitelist, with no practice_name leak', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams());
    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.jobs.length).toBe(5);
    for (const job of result.jobs) {
      expect(Object.keys(job).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
      expect(job.practice_name).toBeUndefined();
    }
    expectNoPracticeNameLeak(result);
  });

  it('state=QLD returns only QLD roles (case-insensitive)', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ state: 'qld' }));
    expect(result.total).toBe(2);
    expect(result.jobs.every((j) => j.location_state === 'QLD')).toBe(true);
  });

  it('q substring-matches title/display_label/location_label/tags (never practice_name), case-insensitively', () => {
    const byTitle = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'outback' }));
    expect(byTitle.total).toBe(1);
    expect(byTitle.jobs[0].title).toBe('Outback Rural Locum GP');

    const byLocation = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'SYDNEY' }));
    expect(byLocation.total).toBe(1);
    expect(byLocation.jobs[0].location_label).toBe('Sydney, NSW');

    const byTag = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'vr-gp' }));
    expect(byTag.total).toBe(2);

    // The real practice names are searchable text on the raw rows, but since
    // the mapper never carries practice_name into the public shape, searching
    // for them must return nothing.
    const byRealName = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ q: 'riverside medical centre' }));
    expect(byRealName.total).toBe(0);
  });

  it('type=locum / vr-gp / non-vr-gp each filter to the right subset (by title, never practice_name)', () => {
    const locum = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'locum' }));
    expect(locum.total).toBe(2);
    expect(locum.jobs.map((j) => j.title).sort()).toEqual(['Locum GP', 'Outback Rural Locum GP']);
    expectNoPracticeNameLeak(locum);

    const vr = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'vr-gp' }));
    expect(vr.total).toBe(2);
    expect(vr.jobs.map((j) => j.location_label).sort()).toEqual(['Riverside, QLD', 'Sydney, NSW']);
    expectNoPracticeNameLeak(vr);

    const nonVr = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'non-vr-gp' }));
    expect(nonVr.total).toBe(1);
    expect(nonVr.jobs[0].location_label).toBe('Melbourne, VIC');
    expectNoPracticeNameLeak(nonVr);
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

  it('id returns exactly the matching job, sanitized to the whitelist, with no practice_name leak', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ id: 'zoho_recruit:ZR-003' }));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0].id).toBe('zoho_recruit:ZR-003');
    expect(result.jobs[0].location_label).toBe('Melbourne, VIC');
    expect(Object.keys(result.jobs[0]).sort()).toEqual([...PUBLIC_JOB_FIELDS].sort());
    expectNoPracticeNameLeak(result);
  });

  it('an unknown id returns jobs:[] and total:0 (not an error)', () => {
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ id: 'zoho_recruit:DOES-NOT-EXIST' }));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
    expect(result.jobs).toEqual([]);
  });

  it('id short-circuits every other filter/pagination param (id wins, the rest are ignored)', () => {
    // state=NSW and type=locum would each individually exclude ZR-003 (a VIC,
    // Non-VR role), q is nonsense, and limit/offset would otherwise page past
    // it. Combined with id, the id match still wins outright.
    const result = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({
      id: 'zoho_recruit:ZR-003',
      state: 'NSW',
      type: 'locum',
      q: 'nonsense-that-matches-nothing',
      limit: '1',
      offset: '4'
    }));
    expect(result.total).toBe(1);
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0].id).toBe('zoho_recruit:ZR-003');
    expect(result.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPublicJobsRows() — in-memory 5-min-TTL rows cache (anonymous-abuse fix).
// Supabase is never configured in this test boot (SUPABASE_URL=''), so the
// real live fetch (getActivePublicJobRowsLive) always returns null here — the
// caching/TTL/stale-good-fallback logic in getPublicJobsRows() is exercised
// instead by injecting a fake `fetcher` (its documented test seam) and by
// seeding/inspecting the module-level cache via the __*ForTest helpers.
// ---------------------------------------------------------------------------
describe('getPublicJobsRows — in-memory cache (no live Supabase needed)', () => {
  const ROWS_A = [makeRawRow({ id: 101, provider_role_id: 'CACHE-A' })];
  const ROWS_B = [makeRawRow({ id: 102, provider_role_id: 'CACHE-B' })];

  beforeEach(() => {
    testUtils.__setPublicJobsRowsCacheForTest(null);
  });

  afterAll(() => {
    testUtils.__setPublicJobsRowsCacheForTest(null);
  });

  it('within the TTL, two consecutive calls return the cached rows and the fetcher is only invoked once', async () => {
    const fetcher = vi.fn(async () => ROWS_A);

    const first = await testUtils.getPublicJobsRows(fetcher);
    expect(first).toBe(ROWS_A);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const second = await testUtils.getPublicJobsRows(fetcher);
    expect(second).toBe(first); // same cached reference — no refetch
    expect(fetcher).toHaveBeenCalledTimes(1); // still only called once
  });

  it('an expired TTL entry triggers a live refetch and replaces the cache', async () => {
    const staleFetcher = vi.fn(async () => ROWS_A);
    await testUtils.getPublicJobsRows(staleFetcher);
    expect(staleFetcher).toHaveBeenCalledTimes(1);

    // Force the cached entry to look expired.
    const cached = testUtils.__getPublicJobsRowsCacheForTest();
    testUtils.__setPublicJobsRowsCacheForTest({
      rows: cached.rows,
      at: Date.now() - testUtils.PUBLIC_JOBS_COUNT_CACHE_TTL_MS - 1000
    });

    const freshFetcher = vi.fn(async () => ROWS_B);
    const refetched = await testUtils.getPublicJobsRows(freshFetcher);
    expect(freshFetcher).toHaveBeenCalledTimes(1); // expiry forced a real refetch
    expect(refetched).toBe(ROWS_B);

    // Cache now holds the fresh result, so an immediate follow-up call
    // returns it without calling the fetcher again.
    const anotherFetcher = vi.fn(async () => ROWS_A);
    const third = await testUtils.getPublicJobsRows(anotherFetcher);
    expect(third).toBe(ROWS_B);
    expect(anotherFetcher).not.toHaveBeenCalled();
  });

  it('a failed/unconfigured fetch (fetcher returns null) falls back to the stale-good cache instead of caching empty', async () => {
    const goodFetcher = vi.fn(async () => ROWS_A);
    await testUtils.getPublicJobsRows(goodFetcher);

    // Expire it, then simulate a fetch failure (null, matching
    // getActivePublicJobRowsLive()'s failure/unconfigured contract).
    const cached = testUtils.__getPublicJobsRowsCacheForTest();
    testUtils.__setPublicJobsRowsCacheForTest({
      rows: cached.rows,
      at: Date.now() - testUtils.PUBLIC_JOBS_COUNT_CACHE_TTL_MS - 1000
    });
    const failingFetcher = vi.fn(async () => null);
    const result = await testUtils.getPublicJobsRows(failingFetcher);

    expect(failingFetcher).toHaveBeenCalledTimes(1);
    expect(result).toBe(ROWS_A); // stale-good, not []
  });

  it('with no prior cache at all, a failed fetch returns [] (not null/undefined)', async () => {
    const failingFetcher = vi.fn(async () => null);
    const result = await testUtils.getPublicJobsRows(failingFetcher);
    expect(result).toEqual([]);
  });
});
