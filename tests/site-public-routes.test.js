import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for the new public marketing-site routing foundation: 7 anonymous
// marketing routes (/, /jobs, /jobs/view, /employers, /about, /faq, /the-app)
// served without any auth check, while the existing app-shell auth wall stays
// intact for every currently-protected page. Mirrors the http-harness idiom
// used by tests/signin-deep-link.test.js and tests/ceo-preview-host.test.js.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const ADMIN_TEST_HOST = 'admin-site-test-' + RUN_ID + '.local';
let server;
let addrPort;

function get(path, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Builds a valid signed gp_session cookie the same way server.js does
// (createSignedSessionToken: base64url(JSON) + '.' + HMAC-SHA512 with AUTH_SECRET).
function gpSessionCookie() {
  const payload = base64UrlEncode(JSON.stringify({
    userProfile: { email: 'gp-site-test@example.com' },
    expiresAt: Date.now() + 3600000,
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_session=${encodeURIComponent(payload + '.' + sig)}`;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false'; // auth ENABLED so the protected-page gate + public routes are both exercised
  process.env.AUTH_SECRET = 'test-site-public-routes-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-public-routes-${RUN_ID}.json`;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_TEST_HOST;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

const PUBLIC_ROUTES = ['/', '/jobs', '/jobs/view', '/employers', '/about', '/faq', '/the-app'];

describe('marketing site public routes', () => {
  for (const route of PUBLIC_ROUTES) {
    it(`GET ${route} is 200 text/html with no session and has no auth-guard.js`, async () => {
      const res = await get(route);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.raw).not.toMatch(/auth-guard\.js/);
    });
  }

  it('/ with a valid gp session still 302s to /pages/index (existing behaviour preserved)', async () => {
    const res = await get('/', { cookie: gpSessionCookie() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/index');
  });

  it('/ on an admin host still 302s to /pages/admin, session or not (existing behaviour preserved)', async () => {
    const res = await get('/', { host: ADMIN_TEST_HOST });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/admin');
  });

  it('/ on an admin host with a gp session still 302s to /pages/admin (host wins)', async () => {
    const res = await get('/', { host: ADMIN_TEST_HOST, cookie: gpSessionCookie() });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/admin');
  });

  it('/pages/site-home.html 302s to the clean marketing URL /', async () => {
    const res = await get('/pages/site-home.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('/pages/site-jobs.html 302s to /jobs', async () => {
    const res = await get('/pages/site-jobs.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/jobs');
  });

  it('/pages/site-job.html 302s to /jobs/view (nested clean URL)', async () => {
    const res = await get('/pages/site-job.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/jobs/view');
  });

  it('/pages/index.html (no session) still 302s to the clean URL (unchanged hop 1 of 2)', async () => {
    const res = await get('/pages/index.html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/index');
  });

  it('/pages/index (no session) still 302s to signin — the auth wall stays intact', async () => {
    const res = await get('/pages/index');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/signin');
  });

  it('/pages/account (no session) still redirects to signin — protected pages stay protected', async () => {
    const res = await get('/pages/account');
    expect(res.status).toBe(302);
    expect(String(res.headers.location)).toMatch(/^\/pages\/signin/);
  });

  it('/robots.txt is 200 text/plain and points at the sitemap (on the canonical host)', async () => {
    // Only the canonical marketing host advertises the sitemap; every other
    // host serves a noindex copy. See tests/site-noindex-canonical-host.test.js.
    const res = await get('/robots.txt', { host: 'www.mygplink.com.au' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.raw).toMatch(/Sitemap: https:\/\/www\.mygplink\.com\.au\/sitemap\.xml/);
  });

  it('/sitemap.xml is 200 application/xml and lists all 9 canonical URLs', async () => {
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    const expectedPaths = ['/', '/jobs', '/jobs/view', '/employers', '/about', '/faq', '/the-app', '/gp-jobs', '/exclusive-placements'];
    for (const p of expectedPaths) {
      expect(res.raw).toContain(`<loc>https://www.mygplink.com.au${p}</loc>`);
    }
  });
});

// Task 7: real homepage (pages/site-home.html), served at GET /. Ported from
// the approved prototype docs/mockups/marketing-homepage-prototype.html with
// production wiring: real job-search navigation, live stats, real CTAs, no
// dead `href="#"` links, and none of the logged-in app's chrome.
describe('marketing site homepage (Task 7)', () => {
  it('GET / serves the ported homepage with the job search form and hero video', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('id="jobSearch"');
    expect(res.raw).toContain('/media/videos/site-hero-beach.mp4');
    expect(res.raw).toContain('data-count');
  });

  it('GET / has no auth-guard.js and no dead href="#" links', async () => {
    const res = await get('/');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET / has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('GET / links the shared site chrome css/js', async () => {
    const res = await get('/');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260714a');
  });

  it('GET / has SEO head tags (title, canonical, description, OG)', async () => {
    const res = await get('/');
    expect(res.raw).toContain('<title>GP Jobs in Australia for Overseas Doctors | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('GET / CTAs point at real destinations, not in-page-only placeholders', async () => {
    const res = await get('/');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
    expect(res.raw).toContain('href="/start#book"');
  });

  it('GET / calls out the free Registration Support Officer and has the partner-logo marquee carousel', async () => {
    const res = await get('/');
    expect(res.raw).toContain('Registration Support Officer');
    expect(res.raw).toContain('logo-marquee');
  });
});

// Task 11: About (pages/site-about.html) and FAQ (pages/site-faq.html) pages,
// served at GET /about and GET /faq. Same standalone marketing chrome as the
// rest of the site — no auth-guard.js, no dead href="#" links.
describe('marketing site about + FAQ pages (Task 11)', () => {
  it('GET /about is 200, marked data-page="about", no auth-guard.js, no dead href="#" links', async () => {
    const res = await get('/about');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-page="about"');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET /about has the numbers strip (data-count) and the shared site chrome', async () => {
    const res = await get('/about');
    expect(res.raw).toContain('data-count');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260714a');
  });

  it('GET /about has SEO head tags and marks About current in both navs', async () => {
    const res = await get('/about');
    expect(res.raw).toContain('<title>About GP Link: GP Recruitment & Registration for Australia | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/about">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
    const currentMatches = res.raw.match(/href="\/about" aria-current="page"/g) || [];
    expect(currentMatches.length).toBe(2);
  });

  it('GET /about has Talk to us CTAs (mailto, /start#book booking, ACN, signup)', async () => {
    const res = await get('/about');
    expect(res.raw).toContain('href="mailto:hello@mygplink.com.au"');
    expect(res.raw).toContain('href="/start#book"');
    expect(res.raw).toContain('ACN 693 259 737');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
  });

  it('GET /faq is 200, marked data-page="faq", no auth-guard.js, no dead href="#" links', async () => {
    const res = await get('/faq');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-page="faq"');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET /faq has faq-item accordion markup for both doctor and practice groups', async () => {
    const res = await get('/faq');
    // redesign added scroll-animation modifiers, so the class is now "faq-item reveal"
    const itemMatches = res.raw.match(/class="faq-item(?:\s[^"]*)?"/g) || [];
    expect(itemMatches.length).toBe(10); // 6 doctor + 4 practice questions
    expect(res.raw).toContain('class="faq-q"');
    expect(res.raw).toContain('class="faq-a"');
  });

  it('GET /faq has SEO head tags and marks FAQ current in both navs', async () => {
    const res = await get('/faq');
    expect(res.raw).toContain('<title>FAQ: Moving to Australia as a GP | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/faq">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
    const currentMatches = res.raw.match(/href="\/faq" aria-current="page"/g) || [];
    expect(currentMatches.length).toBe(2);
  });

  it('GET /faq final CTA band links to signup and employers', async () => {
    const res = await get('/faq');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
    expect(res.raw).toContain('href="/employers"');
  });
});

// Task 12: dedicated app marketing page (pages/site-app.html), served at
// GET /the-app. Expanded version of the homepage's app-push section — phone
// mockup, feature grid, the 6 real product stages, 4-step flow, trust note
// and a big "create free account" push. No auth-guard.js, no dead href="#".
describe('marketing site app page (Task 12)', () => {
  it('GET /the-app is 200, marked data-page="the-app", no auth-guard.js, no dead href="#" links', async () => {
    const res = await get('/the-app');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-page="the-app"');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET /the-app lists all 6 real product stages by name', async () => {
    const res = await get('/the-app');
    const stageNames = ['Secure Placement', 'MyIntealth', 'AMC', 'AHPRA', 'PBS', 'Commencement'];
    for (const name of stageNames) {
      expect(res.raw).toContain(name);
    }
  });

  it('GET /the-app has the ported phone mockup and 4-step flow markup', async () => {
    const res = await get('/the-app');
    expect(res.raw).toContain('class="phone"');
    expect(res.raw).toContain('class="screen"');
    expect(res.raw).toContain('class="pbar"');
    expect(res.raw).toContain('class="flow');
  });

  it('GET /the-app has the shared site chrome and SEO head tags', async () => {
    const res = await get('/the-app');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260714a');
    expect(res.raw).toContain('<title>The GP Link App: Track Your Move to Australia | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/the-app">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('GET /the-app marks "The app" current in both navs', async () => {
    const res = await get('/the-app');
    const currentMatches = res.raw.match(/href="\/the-app" aria-current="page"/g) || [];
    expect(currentMatches.length).toBe(2);
  });

  it('GET /the-app CTAs point at real destinations (signup, jobs, /start#book booking)', async () => {
    const res = await get('/the-app');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
    expect(res.raw).toContain('href="/jobs"');
    expect(res.raw).toContain('href="/start#book"');
  });

  it('GET /the-app has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/the-app');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('GET /the-app calls out the free Registration Support Officer with visual emphasis', async () => {
    const res = await get('/the-app');
    expect(res.raw).toContain('Registration Support Officer');
    expect(res.raw).toContain('Included free');
    expect(res.raw).toContain('is-highlight');
  });
});

// Task 15: "For GPs" doctor-journey pitch page (pages/site-gp-jobs.html),
// served at GET /gp-jobs — matches the owner's old Wix page URL so existing
// inbound links keep working after the DNS cutover. Same standalone
// marketing chrome as the rest of the site, plus the owner-requested RSO
// (Registration Support Officer) highlight band.
describe('marketing site "For GPs" page (Task 15)', () => {
  it('GET /gp-jobs is 200, marked data-page="gp-jobs", no auth-guard.js, no dead href="#" links', async () => {
    const res = await get('/gp-jobs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('data-page="gp-jobs"');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET /gp-jobs mentions the Registration Support Officer highlight band', async () => {
    const res = await get('/gp-jobs');
    expect(res.raw).toContain('Registration Support Officer');
  });

  it('GET /gp-jobs has the shared site chrome and SEO head tags', async () => {
    const res = await get('/gp-jobs');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260714a');
    expect(res.raw).toContain('<title>GP Jobs &amp; Careers in Australia for Overseas Doctors | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/gp-jobs">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
  });

  it('GET /gp-jobs CTAs point at real destinations (signup, jobs, /start#book booking)', async () => {
    const res = await get('/gp-jobs');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
    expect(res.raw).toContain('href="/jobs"');
    expect(res.raw).toContain('href="/start#book"');
  });

  it('GET /gp-jobs has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/gp-jobs');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('GET / (homepage) nav links to /gp-jobs', async () => {
    const res = await get('/');
    expect(res.raw).toContain('href="/gp-jobs">For GPs</a>');
  });
});

// Task 19: "Exclusive placement" scarcity/teaser page (pages/site-exclusive.html),
// served at GET /exclusive-placements — the honest landing page linked from the
// job board's zero-real-match locked teaser cards. It is NOT a nav item (no
// header/footer link points at it), so none of the shared chrome nav links are
// marked aria-current for it.
describe('marketing site "Exclusive placement" page (Task 19)', () => {
  it('GET /exclusive-placements is 200, marked data-page="exclusive", no auth-guard.js, no dead href="#" links', async () => {
    const res = await get('/exclusive-placements');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('data-page="exclusive"');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('GET /exclusive-placements makes the honest "never advertised" scarcity claim', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).toMatch(/never advertised/i);
  });

  it('GET /exclusive-placements mentions the free Registration Support Officer', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).toContain('Registration Support Officer');
  });

  it('GET /exclusive-placements has the shared site chrome and SEO head tags', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260714a');
    expect(res.raw).toContain('<title>Exclusive GP Placement Opportunities | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/exclusive-placements">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,160}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/sydney-opera.jpg"');
  });

  it('GET /exclusive-placements CTAs point at real destinations (signup, /start#book booking) and has no app-shell chrome', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).toContain('href="/pages/signin?signup=1"');
    expect(res.raw).toContain('/start#book');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('GET /exclusive-placements is not marked as a current nav item anywhere (it is not a nav link)', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).not.toMatch(/href="\/exclusive-placements"[^>]*aria-current="page"/);
    expect((res.raw.match(/aria-current="page"/g) || []).length).toBe(0);
  });

  // Honesty guard: the whole point of this page is that it must never invent
  // a fake job. No specific practice/suburb/salary presented as a real
  // current vacancy, and no numeric claim about how many exclusive roles exist.
  it('GET /exclusive-placements makes no numeric claim about exclusive-role counts', async () => {
    const res = await get('/exclusive-placements');
    expect(res.raw).not.toMatch(/\b\d+\+?\s*(exclusive|unadvertised|roles?|vacanc(y|ies)|opportunit(y|ies))\b/i);
    expect(res.raw).not.toMatch(/\d+\s*roles?\s*in\s*your\s*area/i);
  });
});

// Task 16, Change 2: the old "no documents needed to start" copy was flagged
// by the owner as false — GP Link does ask candidates to upload documents.
// Regression guard: loop every public marketing route (including /gp-jobs,
// which isn't in PUBLIC_ROUTES) and assert the claim never comes back.
describe('marketing site never claims "no documents" (Task 16, Change 2 regression guard)', () => {
  const ALL_PUBLIC_ROUTES = [...PUBLIC_ROUTES, '/gp-jobs', '/exclusive-placements'];
  for (const route of ALL_PUBLIC_ROUTES) {
    it(`GET ${route} does not contain the false "no documents" claim`, async () => {
      const res = await get(route);
      expect(res.raw).not.toMatch(/no documents/i);
    });
  }
});
