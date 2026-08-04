// CEO Practices tab — the Australia practice map that leads the directory.
//
// The point of this map (and the only thing that makes it different from the
// two public ones) is that clicking a pin NAMES the practice. The public
// /api/public/practice-map is masked and can never do that; /api/ats/practice-map
// is behind requireAtsSession and therefore can. These tests pin that contract
// end to end: the endpoint is authenticated, it returns real names, and the
// client renders that name into the pin card.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp', `gplink-pmap-${RUN_ID}.json`);
const SUPER_HOST = 'pmap-test.local';

const JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');
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

// Two practices in DIFFERENT suburbs plus one with no location at all — the
// last one must be counted but never pinned (there is nothing to geocode).
const SEED = {
  atsPractices: [
    { id: 'pr-erina', name: 'Erina Medical Centre', location_city: 'Erina', location_state: 'NSW', practice_type: 'GP owned', stage: 'active', agreement_status: 'signed', org_type: 'practice' },
    { id: 'pr-west', name: 'GP West Group', location_city: 'Wanneroo', location_state: 'Western Australia', practice_type: 'Mixed Billing', stage: 'prospective', agreement_status: 'sent', org_type: 'corporation' },
    { id: 'pr-nowhere', name: 'Practice Without A Location', location_city: '', location_state: '', practice_type: '', stage: 'active', agreement_status: 'unsigned', org_type: 'practice' }
  ],
  atsJobs: [
    { id: 'j-erina-1', provider: 'internal_ats', title: 'GP — Erina', practice_name: 'Erina Medical Centre', location_city: 'Erina', location_state: 'NSW', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true },
    { id: 'j-erina-2', provider: 'internal_ats', title: 'GP — Erina (PT)', practice_name: 'Erina Medical Centre', location_city: 'Erina', location_state: 'NSW', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true }
  ],
  atsApplications: [
    { id: 'a1', user_id: 'gp-1', career_role_id: 'j-erina-1', practice_name: 'Erina Medical Centre', ats_stage: 'applied', status: 'applied' },
    // Rejected applications must NOT be counted in the pin card's pipeline number.
    { id: 'a2', user_id: 'gp-2', career_role_id: 'j-erina-1', practice_name: 'Erina Medical Centre', ats_stage: 'not_proceeding', status: 'rejected' }
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
  process.env.AUTH_SECRET = 'pmap-test-secret-' + RUN_ID;
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

describe('GET /api/ats/practice-map', () => {
  it('is staff-only — an unauthenticated caller gets nothing', async () => {
    const r = await req('GET', '/api/ats/practice-map', { host: SUPER_HOST });
    expect(r.status).toBe(401);
    const b = parse(r.raw);
    expect(b && b.ok).toBeFalsy();
    // The masked public map is the one anonymous callers are allowed to have;
    // this route must never leak a practice name to them.
    expect(r.raw).not.toContain('Erina Medical Centre');
  });

  it('answers a signed-in CEO with the map payload', async () => {
    testUtils.__resetAtsPracticeMapCacheForTest();
    const r = await req('GET', '/api/ats/practice-map', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(Array.isArray(b.practices)).toBe(true);
    expect(typeof b.total).toBe('number');
    expect(b.pinned).toBe(b.practices.length);
  });
});

describe('buildAtsPracticeMapData', () => {
  it('pins each practice at its suburb and keeps the REAL name', async () => {
    testUtils.__resetAtsPracticeMapCacheForTest();
    const data = await testUtils.buildAtsPracticeMapData({ geoFetcher: FAKE_GEO });
    const byName = {};
    data.practices.forEach((p) => { byName[p.name] = p; });

    expect(byName['Erina Medical Centre']).toBeTruthy();
    expect(byName['Erina Medical Centre'].lat).toBeCloseTo(-33.4333, 3);
    expect(byName['Erina Medical Centre'].lng).toBeCloseTo(151.3833, 3);
    // 'Western Australia' has to normalise to WA or this suburb never resolves.
    expect(byName['GP West Group']).toBeTruthy();
    expect(byName['GP West Group'].lat).toBeCloseTo(-31.75, 3);
  });

  it('counts a practice with no location but never pins it', async () => {
    testUtils.__resetAtsPracticeMapCacheForTest();
    const data = await testUtils.buildAtsPracticeMapData({ geoFetcher: FAKE_GEO });
    expect(data.practices.some((p) => p.name === 'Practice Without A Location')).toBe(false);
    // Still part of the directory, so the total must include it — otherwise the
    // map's caption would quietly under-report how many practices exist.
    expect(data.total).toBeGreaterThan(data.practices.length);
  });

  it('carries the same card facts the directory shows, ignoring rejected applicants', async () => {
    testUtils.__resetAtsPracticeMapCacheForTest();
    const data = await testUtils.buildAtsPracticeMapData({ geoFetcher: FAKE_GEO });
    const erina = data.practices.find((p) => p.name === 'Erina Medical Centre');
    expect(erina.job_count).toBe(2);
    expect(erina.candidate_count).toBe(1); // a1 counts, rejected a2 does not
    expect(erina.stage).toBe('active');
    expect(erina.type).toBe('GP owned');

    const west = data.practices.find((p) => p.name === 'GP West Group');
    expect(west.stage).toBe('prospective');
    expect(west.org_type).toBe('corporation');
    expect(west.agreement_status).toBe('sent');
  });

  it('caches, then rebuilds once the cache is reset', async () => {
    testUtils.__resetAtsPracticeMapCacheForTest();
    let calls = 0;
    const counting = async () => { calls++; return (await FAKE_GEO()); };
    await testUtils.buildAtsPracticeMapData({ geoFetcher: counting });
    await testUtils.buildAtsPracticeMapData({ geoFetcher: counting });
    expect(calls).toBe(1);
    testUtils.__resetAtsPracticeMapCacheForTest();
    await testUtils.buildAtsPracticeMapData({ geoFetcher: counting });
    expect(calls).toBe(2);
  });
});

describe('Practices tab map (client)', () => {
  it('renders the map section above the practice list', () => {
    expect(JS).toContain('practiceMapSectionHtml');
    expect(JS).toContain('id="atsPracticeMapWrap"');
    expect(JS).toContain('id="atsPmap"');
    expect(JS).toContain('id="atsPmapDetail"');
    // Order matters: the map leads the directory, the cards follow it.
    expect(JS.indexOf('practiceMapSectionHtml() +')).toBeLessThan(JS.indexOf("'<div id=\"atsPracticeList\">'"));
  });

  it('is keyless — Leaflet + CARTO, never the Google Maps key', () => {
    expect(JS).toContain('cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/');
    expect(JS).toContain('cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/');
    expect(JS).toContain('basemaps.cartocdn.com');
    expect(JS).not.toContain('maps.googleapis.com');
    expect(JS).not.toContain('google.maps');
    expect(JS).not.toContain('new maps.Geocoder');
  });

  it('clicking a pin shows the practice NAME and a way into its record', () => {
    expect(JS).toContain('pmapDetailHtml');
    expect(JS).toContain('ats-pmap-name');
    expect(JS).toContain('ATS.esc(name)');
    // The card's CTA reuses the directory's own delegation rather than a
    // second routing path into the practice detail.
    expect(JS).toContain("data-ats=\"open-practice\" data-id=");
    expect(JS).toContain("action === 'pmap-close'");
  });

  it('reads the internal map endpoint, not the masked public one', () => {
    expect(JS).toContain("ATS.api('/api/ats/practice-map')");
    expect(JS).not.toContain('/api/public/practice-map');
  });

  it('keeps the pins and the practice list answering the same question', () => {
    // The search box filters both, on the same name-or-city rule the server uses.
    expect(JS).toContain('pmapMatchesQuery');
    expect(JS).toContain('pmapRenderPins()');
  });

  it('hides the whole section rather than showing an empty grey box', () => {
    expect(JS).toContain('function pmapFail');
    expect(JS).toContain("wrap.style.display = 'none'");
  });
});

describe('Practices map styling', () => {
  it('ships the map styles', () => {
    expect(CSS).toContain('.ats-pmap-wrap');
    expect(CSS).toContain('.ats-pmap-shell');
    expect(CSS).toContain('.ats-pmap-detail');
    expect(CSS).toContain('.ats-pmap-cluster');
  });

  // Regression guard: `overflow-x:clip; overflow-y:visible` is resolved as
  // overflow-y:auto by iOS Safari, which silently clips the open pin card away
  // — the exact bug that made both public maps look like "tapping a pin does
  // nothing" on an iPhone. Never reintroduce that pair on this map.
  it('never uses the overflow-x:clip / overflow-y:visible WebKit trap', () => {
    // Comments stripped first — the rule above is spelled out in a warning
    // comment in the stylesheet, and that must not read as a violation.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/overflow-x:\s*clip;\s*overflow-y:\s*visible/);
  });

  it('drops the pin card in-flow on mobile so no ancestor can clip it', () => {
    const mobile = CSS.slice(CSS.indexOf('@media (max-width:760px)'));
    expect(mobile).toContain('.ats-pmap-detail { position:static');
  });
});

describe('cache busting', () => {
  it('bumps the assets the map changed, or browsers keep the old ones for an hour', () => {
    expect(CEO_HTML).toContain('/js/ceo-ats-practices.js?v=20260805c');
    expect(CEO_HTML).not.toContain('/js/ceo-ats-practices.js?v=20260805b');
    expect(CEO_HTML).toContain('/css/ceo-ats.css?v=20260805e');
    expect(CEO_HTML).not.toContain('/css/ceo-ats.css?v=20260805d');
  });
});
