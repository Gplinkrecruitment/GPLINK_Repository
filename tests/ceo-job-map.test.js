// CEO Jobs tab — the Australia map of JOB OPENINGS that leads the jobs list.
//
// One pin per opening (owner 2026-08-05: "it should show all job openings not
// practices... you can move this to the Jobs page"). The point of it, and the
// only thing that separates it from the two public maps, is that a pin can name
// the role AND its practice: /api/public/practice-map is masked and can never
// do that, /api/ats/job-map is behind requireAtsSession and so can. These tests
// pin that contract end to end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp', `gplink-jmap-${RUN_ID}.json`);
const SUPER_HOST = 'jmap-test.local';

const JOBS_JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
const PRACTICES_JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
const CEO_HTML = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

let server, port, testUtils;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end();
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

// TWO openings share one suburb (the case that stacks pins), one is awaiting
// approval, and one has no location at all (counted, never pinnable).
const SEED = {
  atsPractices: [
    { id: 'pr-erina', name: 'Erina Medical Centre', location_city: 'Erina', location_state: 'NSW', stage: 'active' },
    { id: 'pr-west', name: 'GP West Group', location_city: 'Wanneroo', location_state: 'Western Australia', stage: 'active' }
  ],
  atsJobs: [
    { id: 'j-erina-1', provider: 'internal_ats', title: 'VR GP — Erina', practice_id: 'pr-erina', practice_name: 'Erina Medical Centre', suburb: 'Erina', location_city: 'Erina', location_state: 'NSW', billing_model: 'Mixed Billing', employment_type: 'Permanent · Full-time', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true },
    { id: 'j-erina-2', provider: 'internal_ats', title: 'GP — Erina (part-time)', practice_id: 'pr-erina', practice_name: 'Erina Medical Centre', suburb: 'Erina', location_city: 'Erina', location_state: 'NSW', billing_model: 'Mixed Billing', is_active: true, job_status: 'filled', approval_status: 'approved', ats_created: true },
    // is_active:false + pending is how the practice-client pipeline files a new
    // job; it must still reach the map, since it is the one needing action.
    { id: 'j-west-pending', provider: 'internal_ats', title: 'GP — Wanneroo', practice_id: 'pr-west', practice_name: 'GP West Group', suburb: 'Wanneroo', location_city: 'Wanneroo', location_state: 'Western Australia', is_active: false, job_status: 'open', approval_status: 'pending', ats_created: true },
    { id: 'j-nowhere', provider: 'internal_ats', title: 'GP — location TBC', practice_id: 'pr-erina', practice_name: 'Erina Medical Centre', suburb: '', location_city: '', location_state: '', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true }
  ],
  atsApplications: [
    { id: 'a1', user_id: 'gp-1', career_role_id: 'j-erina-1', ats_stage: 'applied', status: 'applied' },
    // A rejected candidate must NOT be counted in the pin card's pipeline number.
    { id: 'a2', user_id: 'gp-2', career_role_id: 'j-erina-1', ats_stage: 'not_proceeding', status: 'rejected' }
  ]
};

// Stands in for career_suburb_geo_cache. Keys are `suburb|STATE` exactly as
// suburbGeoKey builds them — note 'Western Australia' normalises to 'WA'.
const FAKE_GEO = async () => ({
  'erina|NSW': { lat: -33.4333, lng: 151.3833 },
  'wanneroo|WA': { lat: -31.7500, lng: 115.8000 }
});

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'jmap-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  fs.writeFileSync(DB_FILE, JSON.stringify(SEED, null, 2));

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/ats/job-map', () => {
  it('is staff-only — an unauthenticated caller gets nothing', async () => {
    const r = await req('GET', '/api/ats/job-map', { host: SUPER_HOST });
    expect(r.status).toBe(401);
    expect(parse(r.raw) && parse(r.raw).ok).toBeFalsy();
    // The masked public map is what anonymous callers are allowed to have;
    // this route must never leak a practice name to them.
    expect(r.raw).not.toContain('Erina Medical Centre');
  });

  it('answers a signed-in CEO with the map payload', async () => {
    testUtils.__resetAtsJobMapCacheForTest();
    const r = await req('GET', '/api/ats/job-map', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(Array.isArray(b.jobs)).toBe(true);
    expect(typeof b.total).toBe('number');
    expect(b.pinned).toBe(b.jobs.length);
  });
});

describe('buildAtsJobMapData', () => {
  const build = () => {
    testUtils.__resetAtsJobMapCacheForTest();
    return testUtils.buildAtsJobMapData({ geoFetcher: FAKE_GEO });
  };

  it('pins one per JOB OPENING, not one per practice', async () => {
    const data = await build();
    const erina = data.jobs.filter((j) => j.practice_name === 'Erina Medical Centre');
    // Two openings at the same practice = two pins. A per-practice map gave one.
    expect(erina.map((j) => j.id).sort()).toEqual(['j-erina-1', 'j-erina-2']);
  });

  it('names the role and the practice behind it', async () => {
    const data = await build();
    const j = data.jobs.find((x) => x.id === 'j-erina-1');
    expect(j.title).toBe('VR GP — Erina');
    expect(j.practice_name).toBe('Erina Medical Centre');
    expect(j.suburb).toBe('Erina');
    expect(j.state).toBe('NSW');
    expect(j.billing).toBe('Mixed Billing');
    expect(j.applicants).toBe(1); // a1 counts, rejected a2 does not
  });

  it('separates openings that share a suburb so neither pin is unclickable', async () => {
    const data = await build();
    const a = data.jobs.find((j) => j.id === 'j-erina-1');
    const b = data.jobs.find((j) => j.id === 'j-erina-2');
    expect(a.lat === b.lat && a.lng === b.lng).toBe(false);
    // …but only just — the offset must stay well inside the suburb.
    expect(Math.abs(a.lat - b.lat)).toBeLessThan(0.02);
    expect(Math.abs(a.lng - b.lng)).toBeLessThan(0.02);
    // The first one sits exactly on the suburb centroid.
    expect(a.lat).toBeCloseTo(-33.4333, 3);
  });

  it('is stable between builds — a pin must not wander on refresh', async () => {
    const first = await build();
    const second = await build();
    const pick = (d, id) => d.jobs.find((j) => j.id === id);
    expect(pick(second, 'j-erina-2').lat).toBe(pick(first, 'j-erina-2').lat);
    expect(pick(second, 'j-erina-2').lng).toBe(pick(first, 'j-erina-2').lng);
  });

  it('includes a job awaiting approval, flagged as such', async () => {
    const data = await build();
    const pending = data.jobs.find((j) => j.id === 'j-west-pending');
    expect(pending).toBeTruthy();
    expect(pending.approval_status).toBe('pending');
    // 'Western Australia' has to normalise to WA or this suburb never resolves.
    expect(pending.lat).toBeCloseTo(-31.75, 3);
  });

  it('carries job status through so a filled role can be told apart', async () => {
    const data = await build();
    expect(data.jobs.find((j) => j.id === 'j-erina-1').status).toBe('open');
    expect(data.jobs.find((j) => j.id === 'j-erina-2').status).toBe('filled');
  });

  it('counts a job with no location but never pins it', async () => {
    const data = await build();
    expect(data.jobs.some((j) => j.id === 'j-nowhere')).toBe(false);
    // Still a real opening, so the total must include it — otherwise the map's
    // caption would quietly under-report how many openings exist.
    expect(data.total).toBeGreaterThan(data.jobs.length);
  });

  it('caches, then rebuilds once the cache is reset', async () => {
    testUtils.__resetAtsJobMapCacheForTest();
    let calls = 0;
    const counting = async () => { calls++; return FAKE_GEO(); };
    await testUtils.buildAtsJobMapData({ geoFetcher: counting });
    await testUtils.buildAtsJobMapData({ geoFetcher: counting });
    expect(calls).toBe(1);
    testUtils.__resetAtsJobMapCacheForTest();
    await testUtils.buildAtsJobMapData({ geoFetcher: counting });
    expect(calls).toBe(2);
  });
});

describe('the Jobs list and the Jobs map share one definition of "every job"', () => {
  it('both are built from atsListJobRowsWithPending', async () => {
    const rows = await testUtils.atsListJobRowsWithPending();
    const ids = rows.map((r) => r.id).sort();
    // Includes the is_active:false pending row, which atsListJobRows alone drops.
    expect(ids).toContain('j-west-pending');
    expect(ids.length).toBe(SEED.atsJobs.length);
  });

  it('the jobs list endpoint returns the same openings the map draws from', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const listed = parse(r.raw).jobs.map((j) => j.id).sort();
    expect(listed).toContain('j-west-pending');
    expect(listed.length).toBe(SEED.atsJobs.length);
  });
});

describe('Jobs tab map (client)', () => {
  it('renders above the jobs list, inside the Jobs tab', () => {
    expect(JOBS_JS).toContain('jobMapSectionHtml');
    expect(JOBS_JS).toContain('id="atsJobMapWrap"');
    expect(JOBS_JS).toContain('id="atsJmap"');
    expect(JOBS_JS).toContain('id="atsJmapDetail"');
    // Order matters: the map leads, the job cards follow it.
    expect(JOBS_JS.indexOf('jobMapSectionHtml() +')).toBeLessThan(JOBS_JS.indexOf('ats-job-list" id="atsJobList"'));
  });

  it('is gone from the Practices tab — it was MOVED, not copied', () => {
    expect(PRACTICES_JS).not.toContain('practice-map');
    expect(PRACTICES_JS).not.toContain('pmapBoot');
    expect(PRACTICES_JS).not.toContain('leaflet');
  });

  it('reads the internal job endpoint, not the masked public one', () => {
    expect(JOBS_JS).toContain("A.api('/api/ats/job-map')");
    expect(JOBS_JS).not.toContain('/api/public/practice-map');
    expect(JOBS_JS).not.toContain('/api/ats/practice-map');
  });

  it('is keyless — Leaflet + CARTO, never the Google Maps key', () => {
    expect(JOBS_JS).toContain('cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/');
    expect(JOBS_JS).toContain('cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/');
    expect(JOBS_JS).toContain('basemaps.cartocdn.com');
    expect(JOBS_JS).not.toContain('maps.googleapis.com');
    expect(JOBS_JS).not.toContain('google.maps');
  });

  it('clicking a pin shows the role, its practice, and a way in', () => {
    expect(JOBS_JS).toContain('jmapDetailHtml');
    expect(JOBS_JS).toContain('ats-jmap-name');
    expect(JOBS_JS).toContain('ats-jmap-prac');
    expect(JOBS_JS).toContain('j.practice_name');
    // Routes exactly like the job's card in the list: pending → review screen.
    expect(JOBS_JS).toMatch(/approval_status === 'pending'\) openJobReview\(j\.id\);\s*\n\s*else atsOpenJobBoard\(j\.id\)/);
  });

  it('pinch-to-zoom works without hijacking ordinary page scroll', () => {
    // Trackpad pinch arrives as a ctrl-modified wheel event; Leaflet only reads
    // it when scrollWheelZoom is on, and that would trap the page's scrolling.
    expect(JOBS_JS).toContain('function jmapBindPinchZoom');
    expect(JOBS_JS).toContain('if (!e.ctrlKey) return;');
    expect(JOBS_JS).toContain('{ passive: false }');
    expect(JOBS_JS).toContain('setZoomAround');
    expect(JOBS_JS).toContain('scrollWheelZoom: false');
    // Real touchscreens use Leaflet's own pinch handler.
    expect(JOBS_JS).toContain('touchZoom: true');
    // Fractional zoom, or a pinch jumps a whole level at a time.
    expect(JOBS_JS).toContain('zoomSnap: 0');
  });

  it('pins narrow with the same filters the list uses', () => {
    expect(JOBS_JS).toContain('jmapMatchesFilters');
    expect(JOBS_JS).toContain('currentJobFilters()');
    expect(JOBS_JS).toContain('jmapRenderPins()');
  });

  it('re-measures more than once, or the map paints short of its right edge', () => {
    expect(JOBS_JS).toContain('[0, 120, 350, 800].forEach');
    expect(JOBS_JS).toContain('invalidateSize');
  });

  it('hides the whole section rather than showing an empty grey box', () => {
    expect(JOBS_JS).toContain('function jmapFail');
    expect(JOBS_JS).toContain("wrap.style.display = 'none'");
  });
});

describe('Jobs map styling', () => {
  it('ships the map styles under the jobs namespace', () => {
    expect(CSS).toContain('.ats-jmap-wrap');
    expect(CSS).toContain('.ats-jmap-shell');
    expect(CSS).toContain('.ats-jmap-detail');
    expect(CSS).toContain('.ats-jmap-cluster');
    // No trailing hyphen: renaming `ats-pmap-*` left the BARE `.ats-pmap`
    // (the rule that stretches the map to fill its shell) behind, so the map
    // measured 1390x0 and painted nothing while every other rule looked fine.
    expect(CSS).not.toContain('ats-pmap');
  });

  it('gives the map element itself a box to fill', () => {
    // The map is absolutely positioned inside a fixed-height shell; without
    // this rule Leaflet initialises at zero height and draws nothing at all.
    expect(CSS).toMatch(/\.ats-jmap\s*\{[^}]*position:absolute[^}]*inset:0/);
    expect(CSS).toMatch(/\.ats-jmap-shell\s*\{[^}]*height:/);
    // Every class the markup uses must exist in the stylesheet.
    const used = (JOBS_JS.match(/class="(ats-jmap[\w-]*)"/g) || [])
      .map((m) => m.replace(/class="|"/g, ''));
    expect(used.length).toBeGreaterThan(3);
    used.forEach((cls) => expect(CSS).toContain('.' + cls));
  });

  it('colours a pin by the job state it represents', () => {
    expect(CSS).toContain('.ats-jmap-pin.pending');
    expect(CSS).toContain('.ats-jmap-pin.inactive');
  });

  // Regression guard: `overflow-x:clip; overflow-y:visible` is resolved as
  // overflow-y:auto by iOS Safari, which silently clips the open pin card away
  // — the exact bug that made both public maps look like "tapping a pin does
  // nothing" on an iPhone. Never reintroduce that pair on this map.
  it('never uses the overflow-x:clip / overflow-y:visible WebKit trap', () => {
    // Comments stripped first — the rule is spelled out in a warning comment
    // in the stylesheet, and that must not read as a violation.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/overflow-x:\s*clip;\s*overflow-y:\s*visible/);
  });

  it('drops the pin card in-flow on mobile so no ancestor can clip it', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width:760px)'));
    expect(mobile).toContain('.ats-jmap-detail { position:static');
  });

  it('keeps the map credit dark — Leaflet\u2019s own CSS loads later and wins ties', () => {
    expect(CSS).toContain('.ats-scope .ats-jmap-shell .leaflet-control-attribution');
  });
});

describe('cache busting', () => {
  it('bumps every asset that changed, or browsers keep the old ones for an hour', () => {
    expect(CEO_HTML).toContain('/js/ceo-ats-jobs.js?v=20260805c');   // map added here
    expect(CEO_HTML).not.toContain('/js/ceo-ats-jobs.js?v=20260729a');
    expect(CEO_HTML).toContain('/js/ceo-ats-practices.js?v=20260810b'); // map removed here
    expect(CEO_HTML).not.toContain('/js/ceo-ats-practices.js?v=20260809a');
    expect(CEO_HTML).toContain('/css/ceo-ats.css?v=20260810a');
    expect(CEO_HTML).not.toContain('/css/ceo-ats.css?v=20260805e');
  });
});
