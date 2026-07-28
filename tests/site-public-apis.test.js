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
//     (mapCareerRoleRowToPublicJob, sanitizePublicJob, classifyPublicJobBilling,
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
  it('is 200 with no session cookie and returns the static SITE_STATS + weekly jobsCount', async () => {
    const res = await get('/api/public/stats');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    // The non-jobs figures stay static owner-set constants.
    expect(res.json.locations).toBe(230);
    expect(res.json.avgPlacementDays).toBe(22);
    expect(res.json.gpsPlaced).toBe(150);
    expect(res.json.satisfaction).toBe(100);
    // jobsCount is now the weekly-deterministic marketing headline (241–260),
    // re-rolled each week — no longer the static 240.
    expect(Number.isInteger(res.json.jobsCount)).toBe(true);
    expect(res.json.jobsCount).toBeGreaterThanOrEqual(241);
    expect(res.json.jobsCount).toBeLessThanOrEqual(260);
  });

  it('jobsCount is always a number', async () => {
    const res = await get('/api/public/stats');
    expect(typeof res.json.jobsCount).toBe('number');
  });
});

describe('getWeeklyPublicJobsTotal — weekly-deterministic marketing headline', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('always returns an integer in 241–260', () => {
    for (let w = 0; w < 120; w++) {
      const n = testUtils.getWeeklyPublicJobsTotal(w * WEEK);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(241);
      expect(n).toBeLessThanOrEqual(260);
    }
  });

  it('is stable anywhere within one week', () => {
    const base = 2600 * WEEK; // arbitrary week
    const v = testUtils.getWeeklyPublicJobsTotal(base);
    expect(testUtils.getWeeklyPublicJobsTotal(base + 1)).toBe(v);
    expect(testUtils.getWeeklyPublicJobsTotal(base + WEEK - 1)).toBe(v);
  });

  it('re-rolls across weeks (not a constant)', () => {
    const base = 2600 * WEEK;
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(testUtils.getWeeklyPublicJobsTotal(base + i * WEEK));
    expect(seen.size).toBeGreaterThan(1);
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
  'visa', 'packageTerms', 'aiAbout', 'aiHighlights', 'aiPerks'
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

  it('builds display_label as the near-city line only (never from practice_name)', () => {
    // Owner rule (2026-07-28): billing and DPA are already the title and their
    // own chips, so the subtitle carries only the major city.
    const row = makeRawRow({ billing_model: 'bulk', dpa: true, nearest_city: 'Perth' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.display_label).toBe('near Perth');
  });

  // The reported bug: nearest_city was empty, so the mapper fell back to
  // location_city — which holds the suburb — and the card read "near Erina".
  it('never falls back to the suburb for the near-city line', () => {
    const row = makeRawRow({ suburb: 'Erina', nearest_city: '', location_city: 'Erina', dpa: true });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.display_label).toBe('');
  });

  it('carries header_image_url/suburb/nearest_city through when present', () => {
    const row = makeRawRow({ header_image_url: 'https://cdn.example.com/hero.jpg', suburb: 'Toowong', nearest_city: 'Brisbane' });
    const mapped = testUtils.mapCareerRoleRowToPublicJob(row);
    expect(mapped.header_image_url).toBe('https://cdn.example.com/hero.jpg');
    expect(mapped.suburb).toBe('Toowong');
    expect(mapped.nearest_city).toBe('Brisbane');
  });
});

// Regression (2026-07-29): ?type= is a DEAD param and must be ignored.
//
// It classified vr-gp / non-vr-gp / locum by looking for those words in
// title/summary/employment_type/tags — but the public mask rewrites all of
// them (live titles read "DPA - Mandurah - Private Billing"), so it matched
// 0 of 51 live roles. It also lost its dropdown when Billing type replaced it.
// The result: any stale /jobs?type=locum link — bookmark, browser history,
// indexed URL — returned an empty board AND an empty map, with all three
// dropdowns still reading "All" and nothing on screen to explain it.
//
// The classifier is gone. These tests pin the param as inert so nobody
// reinstates the filter without real stored data behind it.
describe('the dead ?type= param', () => {
  it('no longer ships a classifier', () => {
    expect(testUtils.classifyPublicJobType).toBeUndefined();
  });

  it('does not filter the jobs list — a stale ?type= link shows the full board', () => {
    const rows = [
      makeRawRow({ id: 'locum-role', title: 'Locum GP', employment_type: 'Locum' }),
      makeRawRow({ id: 'vr-role', title: 'General Practitioner (VR)', tags: ['VR-GP'] }),
      makeRawRow({ id: 'plain', title: 'DPA - Mandurah - Private Billing' })
    ];
    const unfiltered = testUtils.buildPublicJobsResponse(rows, new URLSearchParams());
    for (const type of ['locum', 'vr-gp', 'non-vr-gp']) {
      const out = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type }));
      expect(out.total).toBe(unfiltered.total);
      expect(out.jobs.length).toBe(unfiltered.jobs.length);
    }
  });

  it('still composes with the filters that DO work', () => {
    const rows = [
      makeRawRow({ provider_role_id: 'ZR-BULK', title: 'Locum GP', billing_model: 'Bulk Billing' }),
      makeRawRow({ provider_role_id: 'ZR-PRIV', title: 'Locum GP', billing_model: 'Private Billing' })
    ];
    // type is dropped, billing still bites — so exactly the bulk row survives.
    const out = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'locum', billing: 'bulk' }));
    expect(out.jobs.map((j) => j.id)).toEqual(['zoho_recruit:ZR-BULK']);
  });
});

// Regression (2026-07-29): the State dropdown missed 9 of 51 live public roles.
// location_state is written by three different sources, so the SAME state
// arrives as both 'WA' and 'WESTERN AUSTRALIA'. The mapper only uppercased it
// while the filter compares against the dropdown's 2-letter code, so the long
// spellings were unreachable — picking WA returned 10 of 18, VIC 6 of 7.
describe('location_state is normalised to a 2-letter code, not just uppercased', () => {
  const stateOf = (location_state) =>
    testUtils.mapCareerRoleRowToPublicJob(makeRawRow({ location_state })).location_state;

  it('maps every long-form state name to its code', () => {
    expect(stateOf('Western Australia')).toBe('WA');
    expect(stateOf('WESTERN AUSTRALIA')).toBe('WA');
    expect(stateOf('Victoria')).toBe('VIC');
    expect(stateOf('New South Wales')).toBe('NSW');
    expect(stateOf('Queensland')).toBe('QLD');
    expect(stateOf('South Australia')).toBe('SA');
    expect(stateOf('Tasmania')).toBe('TAS');
    expect(stateOf('Australian Capital Territory')).toBe('ACT');
    expect(stateOf('Northern Territory')).toBe('NT');
  });

  it('leaves codes and blanks alone', () => {
    expect(stateOf('wa')).toBe('WA');
    expect(stateOf('QLD')).toBe('QLD');
    expect(stateOf('')).toBe('');
    expect(stateOf(null)).toBe('');
  });

  it('?state=WA now finds rows stored as "Western Australia"', () => {
    const rows = [
      makeRawRow({ provider_role_id: 'ZR-LONG', location_state: 'Western Australia' }),
      makeRawRow({ provider_role_id: 'ZR-CODE', location_state: 'WA' }),
      makeRawRow({ provider_role_id: 'ZR-QLD', location_state: 'QLD' })
    ];
    const wa = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ state: 'WA' }));
    expect(wa.total).toBe(2);
    expect(wa.jobs.map((j) => j.id).sort())
      .toEqual(['zoho_recruit:ZR-CODE', 'zoho_recruit:ZR-LONG']);
  });

  it('the map pins agree with the list — both end up on the code', () => {
    // The map already normalised; the list did not. That mismatch is what let
    // the pins look right while the board below them came up short.
    const job = testUtils.sanitizePublicJob(
      testUtils.mapCareerRoleRowToPublicJob(makeRawRow({ location_state: 'Western Australia' }))
    );
    expect(job.location_state).toBe('WA');
    expect(testUtils.shapeMapPractice(job, 'WA', { lat: -32, lng: 115.8 }).state).toBe('WA');
  });
});

describe('classifyPublicJobBilling', () => {
  const classify = (billing_model) =>
    testUtils.classifyPublicJobBilling(testUtils.mapCareerRoleRowToPublicJob(makeRawRow({ billing_model })));

  it('normalises separators and case across the spellings live data actually contains', () => {
    // Every one of these was present in production on 2026-07-29.
    expect(classify('Bulk Billing')).toBe('bulk');
    expect(classify('Mixed Billing')).toBe('mixed');
    expect(classify('Mixed-Billing')).toBe('mixed');
    expect(classify('mixed')).toBe('mixed');
    expect(classify('Private Billing')).toBe('private');
  });

  it('handles other plausible separator and case variants', () => {
    expect(classify('bulk_billing')).toBe('bulk');
    expect(classify('MIXED/BILLING')).toBe('mixed');
    expect(classify('  private   billing  ')).toBe('private');
    expect(classify('Bulk-billing')).toBe('bulk');
  });

  it('returns empty for missing or unrecognised billing, so it is never bucketed wrongly', () => {
    expect(classify('')).toBe('');
    expect(classify(null)).toBe('');
    expect(classify('Concession Rates')).toBe('');
    expect(testUtils.classifyPublicJobBilling(null)).toBe('');
    expect(testUtils.classifyPublicJobBilling({})).toBe('');
  });

  it('reads billing_model only — it does not infer billing from free text elsewhere', () => {
    // A summary mentioning bulk billing must not make a Private Billing role
    // answer a billing=bulk filter.
    const mapped = testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      billing_model: 'Private Billing', summary: 'Nearby clinics are bulk billing practices.'
    }));
    expect(testUtils.classifyPublicJobBilling(mapped)).toBe('private');
  });
});

// ── The map pins must answer the same question as the list below them ────────
//
// Regression suite for the 2026-07-29 bug: /api/public/practice-map took no
// filter params at all and the page fetched it bare, so selecting "Private
// billing" (1 role) still drew all ~51 pins. Every filter the results list
// honours must now narrow the pins too.
describe('filterPracticeMapPractices — the /jobs filter bar applied to map pins', () => {
  const P = (over) => ({
    id: 'p1', suburb: 'Bondi', state: 'NSW', lat: -33.89, lng: 151.27,
    title: 'GP role', display: 'near Sydney', billing: 'Bulk Billing',
    income: '', benefits: [], img: '', type: '', ...over
  });
  const ids = (arr) => arr.map((p) => p.id);

  const practices = [
    P({ id: 'nsw-bulk', state: 'NSW', suburb: 'Bondi', billing: 'Bulk Billing' }),
    P({ id: 'qld-mixed', state: 'QLD', suburb: 'Cairns', billing: 'Mixed Billing' }),
    P({ id: 'qld-mixed-hyphen', state: 'QLD', suburb: 'Townsville', billing: 'Mixed-Billing' }),
    P({ id: 'vic-mixed-lower', state: 'VIC', suburb: 'Geelong', billing: 'mixed' }),
    P({ id: 'wa-private', state: 'WA', suburb: 'Fremantle', billing: 'Private Billing' }),
    P({ id: 'nt-none', state: 'NT', suburb: 'Darwin', billing: '' })
  ];

  it('no filters returns every practice untouched', () => {
    expect(ids(testUtils.filterPracticeMapPractices(practices, new URLSearchParams()))).toEqual(ids(practices));
  });

  it('state narrows the pins', () => {
    const qld = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ state: 'QLD' }));
    expect(ids(qld).sort()).toEqual(['qld-mixed', 'qld-mixed-hyphen']);
  });

  it('billing narrows the pins and normalises the same spellings the API does', () => {
    // This is the exact case from the bug report: Private billing = 1 pin, not 51.
    const priv = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: 'private' }));
    expect(ids(priv)).toEqual(['wa-private']);

    const mixed = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: 'mixed' }));
    expect(ids(mixed).sort()).toEqual(['qld-mixed', 'qld-mixed-hyphen', 'vic-mixed-lower']);

    const bulk = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: 'bulk' }));
    expect(ids(bulk)).toEqual(['nsw-bulk']);
  });

  it('a practice with no billing value is never pinned by a billing filter', () => {
    for (const v of ['bulk', 'mixed', 'private']) {
      expect(ids(testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: v })))).not.toContain('nt-none');
    }
  });

  it('q matches the suburb (the "except for Keyword" half of the report)', () => {
    expect(ids(testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ q: 'fremantle' })))).toEqual(['wa-private']);
    expect(ids(testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ q: 'CAIRNS' })))).toEqual(['qld-mixed']);
  });

  it('filters compose — state AND billing together', () => {
    const out = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ state: 'QLD', billing: 'mixed' }));
    expect(ids(out).sort()).toEqual(['qld-mixed', 'qld-mixed-hyphen']);
  });

  it('ignores the dead ?type= param — the pins must not empty on a stale link', () => {
    // The list ignores it too; if only one of the two did, the pins and the
    // board below them would contradict each other.
    const out = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ type: 'locum' }));
    expect(out.length).toBe(practices.length);
  });

  it('an unrecognised filter value is ignored rather than blanking the map', () => {
    const out = testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: 'concession' }));
    expect(out.length).toBe(practices.length);
  });

  it('does not mutate the cached array it is given', () => {
    // It filters the shared 10-minute cache, so mutating it would corrupt the
    // next request's data.
    const before = ids(practices);
    testUtils.filterPracticeMapPractices(practices, new URLSearchParams({ billing: 'private' }));
    expect(ids(practices)).toEqual(before);
  });

  it('is defensive about bad input', () => {
    expect(testUtils.filterPracticeMapPractices(null, new URLSearchParams())).toEqual([]);
    expect(testUtils.filterPracticeMapPractices(practices, null).length).toBe(practices.length);
  });
});

describe('practiceMapHasFilters', () => {
  it('is true for any honoured filter and false for none', () => {
    expect(testUtils.practiceMapHasFilters(new URLSearchParams())).toBe(false);
    expect(testUtils.practiceMapHasFilters(new URLSearchParams({ limit: '10' }))).toBe(false);
    for (const k of ['q', 'state', 'billing']) {
      expect(testUtils.practiceMapHasFilters(new URLSearchParams({ [k]: 'x' }))).toBe(true);
    }
  });

  it('is false for the dead ?type= param, so the caption stays the global one', () => {
    // Counting an ignored param as a filter would drop the member-exclusive
    // split and caption an unfiltered map as "matching your filters".
    expect(testUtils.practiceMapHasFilters(new URLSearchParams({ type: 'locum' }))).toBe(false);
  });

  it('treats a blank value as no filter', () => {
    expect(testUtils.practiceMapHasFilters(new URLSearchParams({ state: '   ' }))).toBe(false);
  });
});

describe('shapeMapPractice', () => {
  it('carries the fields the map filters and the sidebar renders — and no dead type', () => {
    const job = testUtils.sanitizePublicJob(testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      title: 'Locum GP', employment_type: 'Locum', tags: ['Locum'], summary: 'Locum cover needed.',
      billing_model: 'Mixed Billing'
    })));
    const pin = testUtils.shapeMapPractice(job, 'NSW', { lat: -33.8, lng: 151.2 });
    expect(pin.state).toBe('NSW');
    expect(pin.billing).toBe('Mixed Billing');
    // The position-type classification was dropped on 2026-07-29 along with the
    // filter it fed — nothing reads it, so shipping it on every pin is dead weight.
    expect(pin.type).toBeUndefined();
  });

  it('never carries the practice name onto a pin', () => {
    const job = testUtils.sanitizePublicJob(testUtils.mapCareerRoleRowToPublicJob(makeRawRow({
      practice_name: 'Riverside Medical Centre'
    })));
    const pin = testUtils.shapeMapPractice(job, 'QLD', { lat: -27.5, lng: 153.0 });
    expect(JSON.stringify(pin)).not.toMatch(/Riverside Medical Centre/);
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

  it('type=locum / vr-gp / non-vr-gp are all inert — the board is never narrowed by them', () => {
    // These fixture rows DO carry "Locum"/"VR" in their titles, unlike real
    // masked rows — so if the filter were still wired up this test would show
    // subsets. Full totals prove the param is genuinely ignored, not merely
    // unmatched by the fixtures.
    const all = testUtils.buildPublicJobsResponse(rows, new URLSearchParams()).total;
    for (const type of ['locum', 'vr-gp', 'non-vr-gp']) {
      const out = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type }));
      expect(out.total).toBe(all);
      expectNoPracticeNameLeak(out);
    }
  });

  // ── Billing type filter ───────────────────────────────────────────────────
  //
  // billing_model is written by three different sources (practice intake form,
  // ATS job editor, legacy/Zoho sync), so the SAME arrangement really does
  // arrive spelled three ways. These values are taken from live production
  // data on 2026-07-29: 'Bulk Billing' ×40, 'Mixed Billing' ×7, 'Mixed-Billing'
  // ×1, 'mixed' ×1, 'Private Billing' ×1, '' ×1. A filter that compares the
  // raw string would silently hide roles, so normalisation is the whole point.
  const billingRows = [
    makeRawRow({ id: 11, provider_role_id: 'ZR-011', title: 'GP A', practice_name: 'Riverside Medical Centre', billing_model: 'Bulk Billing' }),
    makeRawRow({ id: 12, provider_role_id: 'ZR-012', title: 'GP B', practice_name: 'Outback Family Practice', billing_model: 'Mixed Billing' }),
    makeRawRow({ id: 13, provider_role_id: 'ZR-013', title: 'GP C', practice_name: 'Melbourne Central Clinic', billing_model: 'Mixed-Billing' }),
    makeRawRow({ id: 14, provider_role_id: 'ZR-014', title: 'GP D', practice_name: 'Harbourside Practice', billing_model: 'mixed' }),
    makeRawRow({ id: 15, provider_role_id: 'ZR-015', title: 'GP E', practice_name: 'Southbank Clinic', billing_model: 'Private Billing' }),
    makeRawRow({ id: 16, provider_role_id: 'ZR-016', title: 'GP F', practice_name: 'Riverside Medical Centre', billing_model: '' })
  ];

  it('billing=mixed matches every real-world spelling of mixed billing', () => {
    const mixed = testUtils.buildPublicJobsResponse(billingRows, new URLSearchParams({ billing: 'mixed' }));
    // 'Mixed Billing', 'Mixed-Billing' and 'mixed' must ALL be caught.
    expect(mixed.total).toBe(3);
    expect(mixed.jobs.map((j) => j.title).sort()).toEqual(['GP B', 'GP C', 'GP D']);
    expectNoPracticeNameLeak(mixed);
  });

  it('billing=bulk / private filter to the right subset', () => {
    const bulk = testUtils.buildPublicJobsResponse(billingRows, new URLSearchParams({ billing: 'bulk' }));
    expect(bulk.total).toBe(1);
    expect(bulk.jobs[0].title).toBe('GP A');

    const priv = testUtils.buildPublicJobsResponse(billingRows, new URLSearchParams({ billing: 'private' }));
    expect(priv.total).toBe(1);
    expect(priv.jobs[0].title).toBe('GP E');
    expectNoPracticeNameLeak(priv);
  });

  it('a role with no billing_model is never returned by any billing filter', () => {
    for (const value of ['bulk', 'mixed', 'private']) {
      const result = testUtils.buildPublicJobsResponse(billingRows, new URLSearchParams({ billing: value }));
      expect(result.jobs.map((j) => j.title)).not.toContain('GP F');
    }
  });

  it('an unrecognised billing value is ignored rather than returning nothing', () => {
    // Same contract as `type`: a junk param must not silently empty the board.
    const result = testUtils.buildPublicJobsResponse(billingRows, new URLSearchParams({ billing: 'concession' }));
    expect(result.total).toBe(billingRows.length);
  });

  it('billing combines with state and q rather than replacing them', () => {
    const rowsMixedStates = [
      makeRawRow({ id: 21, provider_role_id: 'ZR-021', title: 'GP QLD Bulk', practice_name: 'Riverside Medical Centre', location_state: 'QLD', billing_model: 'Bulk Billing' }),
      makeRawRow({ id: 22, provider_role_id: 'ZR-022', title: 'GP VIC Bulk', practice_name: 'Southbank Clinic', location_state: 'VIC', billing_model: 'Bulk Billing' })
    ];
    const result = testUtils.buildPublicJobsResponse(rowsMixedStates, new URLSearchParams({ billing: 'bulk', state: 'QLD' }));
    expect(result.total).toBe(1);
    expect(result.jobs[0].title).toBe('GP QLD Bulk');
  });

  it('a bookmarked /jobs?type=locum shows the full board, not an empty one', () => {
    // The position-type control is gone (billing replaced it) and the param is
    // now inert. Honouring it was strictly worse than ignoring it: against real
    // masked rows it matched nothing, so the bookmark returned zero roles with
    // no visible filter to explain the blank page.
    const locum = testUtils.buildPublicJobsResponse(rows, new URLSearchParams({ type: 'locum' }));
    expect(locum.total).toBe(testUtils.buildPublicJobsResponse(rows, new URLSearchParams()).total);
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
    // state=NSW individually excludes ZR-003 (a VIC, Non-VR role), q is
    // nonsense, and limit/offset would otherwise page past it. (type=locum is
    // inert now but is left here to prove it stays harmless.) Combined with id,
    // the id match still wins outright.
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
