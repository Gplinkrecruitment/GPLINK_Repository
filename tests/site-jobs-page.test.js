import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for Task 8: the real public job board page (pages/site-jobs.html),
// served at GET /jobs. Mirrors the http-harness idiom used by
// tests/site-public-routes.test.js (boot a real server, no Supabase
// configured, no session).

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
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

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-site-jobs-page-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-jobs-page-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('GET /jobs (Task 8 job board page)', () => {
  it('is 200 text/html with no session', async () => {
    const res = await get('/jobs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('contains the results grid marker data-jobs-list', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('data-jobs-list');
  });

  it('contains the filter form id="jobSearch"', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('id="jobSearch"');
  });

  it('has no auth-guard.js', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
  });

  it('has zero dead href="#" links', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('links the shared site chrome css/js', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260729b');
  });

  it('has SEO head tags (title, canonical, description, OG)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('<title>GP Jobs in Australia: Browse 1,400+ Roles | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/jobs">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,220}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('the filter form has the same q/state/billing fields as the homepage search', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/<form class="jobs-filter-card" id="jobSearch">/);
    expect(res.raw).toContain('name="q"');
    expect(res.raw).toContain('name="state"');
    // Third filter is billing type (bulk / mixed / private), not position type.
    // ?type= has no control AND is no longer honoured by the API — see the
    // dead-param regression below.
    expect(res.raw).toContain('name="billing"');
    expect(res.raw).not.toContain('name="type"');
  });

  it('ignores the dead ?type= param instead of filtering the board by it', async () => {
    const res = await get('/jobs');
    // Regression (2026-07-29): `type` had no dropdown but still counted towards
    // hasFilters and was still sent to the API, where it matched none of the
    // masked roles. A stale /jobs?type=locum link therefore rendered an empty
    // board, an empty map and three dropdowns all reading "All".
    expect(res.raw).not.toMatch(/filters\.type/);
    expect(res.raw).toMatch(/hasFilters = !!\(filters\.q \|\| filters\.state \|\| filters\.billing\)/);
  });

  it('has a Clear button that is hidden until a filter is applied', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('id="clearFiltersBtn"');
    // Ships hidden; the script unhides it only when hasFilters is true.
    expect(res.raw).toMatch(/id="clearFiltersBtn"[^>]*hidden/);
    expect(res.raw).toMatch(/clearFiltersBtn\.hidden = !hasFilters/);
  });

  it('clearing navigates to the bare /jobs so the list AND the map both reload', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/clearFiltersBtn\.addEventListener\("click"/);
    expect(res.raw).toMatch(/window\.location\.href = "\/jobs"/);
  });

  it('the map fetch forwards the filter params (regression: pins ignored every filter)', async () => {
    const res = await get('/jobs');
    // Before this, the page fetched '/api/public/practice-map' bare, so the
    // pins never changed no matter what was selected.
    expect(res.raw).toMatch(/fetch\('\/api\/public\/practice-map'\+mapQs\)/);
    expect(res.raw).not.toMatch(/fetch\('\/api\/public\/practice-map'\)/);
    // The map takes the query string built by the results-list script rather
    // than re-deriving it from the URL with a second, hand-maintained key list
    // — keeping two such lists in sync is how the pins drifted from the board.
    expect(res.raw).toMatch(/function filterParams\(\)/);
    expect(res.raw).toMatch(/window\.GP_JOBS_FILTER_QS = /);
    expect(res.raw).toMatch(/var mapQs=\(typeof window\.GP_JOBS_FILTER_QS==='string'\)/);
  });

  it('escapes API-sourced job data via an escapeHtml helper, not innerHTML with raw strings', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function escapeHtml/);
    expect(res.raw).not.toMatch(/document\.write/);
  });
});

// Coverage for Task 17: the filtered-search "top match + locked teasers"
// conversion flow. This is client-side behavior that only activates when
// the visitor's URL has q/state/type params — an HTTP-only harness that
// requests /jobs with no query string can't exercise that branch (the
// server always returns the same static HTML/JS regardless of query
// params; filters are read from window.location.search in the browser).
// So this suite only asserts what's statically true of the shipped page
// source: the new DOM-building helpers, copy strings and CSS markers
// exist, the old unfiltered-mode code paths are untouched, and no numeric
// hidden-roles claim is printed anywhere on the page.
describe('GET /jobs — filtered-search conversion flow (Task 17, static source coverage)', () => {
  it('defines a locked teaser-card builder that is aria-hidden/presentation and not a link', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('skeleton-teaser');
    expect(res.raw).toMatch(/function buildTeaserCard/);
    expect(res.raw).toContain('d.setAttribute("aria-hidden", "true")');
    expect(res.raw).toContain('d.setAttribute("role", "presentation")');
    // the teaser card is a <div>, never an <a href>
    expect(res.raw).toMatch(/var d = document\.createElement\("div"\);\s*\n\s*d\.className = "job-card skeleton-teaser";/);
  });

  it('labels the single real match with a "Top match" badge', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function buildTopMatchCard/);
    expect(res.raw).toContain('badge.textContent = "Top match"');
  });

  it('renders the "unlock the rest" CTA panel with the exact required copy', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('Your other matches are waiting in the app');
    expect(res.raw).toContain(
      'Create a free account and we&rsquo;ll match you to the roles that fit your visa, skills and the life '
    );
    expect(res.raw).toContain('you want &mdash; most doctors see their personalised matches within minutes.');
    expect(res.raw).toContain('Free forever for doctors &middot; takes 2 minutes');
    expect(res.raw).toMatch(/filtered-cta-panel/);
  });

  it('the filtered results-count header replaces the numeric count with the unlock message', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('Top matches shown. Create a free account to unlock the rest');
  });

  it('shows the top FILTERED_TOP_MATCHES real cards (not just one) before the wall', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('var FILTERED_TOP_MATCHES = 5;');
    // fetches the top N (not 1) real matches from the API
    expect(res.raw).toContain('fetch(buildApiUrl(0, FILTERED_TOP_MATCHES))');
    expect(res.raw).toMatch(/function renderFilteredMatches\(list\)/);
    // first card is the badged top match; the rest render as normal job cards
    expect(res.raw).toMatch(
      /grid\.appendChild\(buildTopMatchCard\(list\[0\]\)\);\s*\n\s*for \(var i = 1; i < list\.length; i\+\+\) grid\.appendChild\(buildJobCard\(list\[i\]\)\);/
    );
  });

  it('never prints a specific numeric claim about hidden/matching roles', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toContain('100+');
  });

  it('the filtered "Load more" flow appends more teasers then swaps to a signup CTA after 2 uses (no extra API calls)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function renderFilteredLoadMore/);
    expect(res.raw).toContain('appendTeaserBatch(TEASER_BATCH);');
    expect(res.raw).toContain('filteredLoadMoreCount++;');
    expect(res.raw).toContain('filteredLoadMoreCount >= FILTERED_LOAD_MORE_MAX');
    expect(res.raw).toContain('cta.textContent = "Create my free account";');
    expect(res.raw).toContain('cta.href = "/pages/signin?signup=1";');
  });

  it('gates the whole flow on hasFilters, and unfiltered mode still calls the original loadPage(0)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/if \(hasFilters\) \{\s*\n\s*initFilteredResults\(\);\s*\n\s*\} else \{\s*\n\s*loadPage\(0\);\s*\n\s*\}/);
  });

  // Task 19: zero real matches on a FILTERED search no longer falls through
  // to the generic empty state — it now shows the honest "exclusive
  // placement" scarcity flow (2 locked teaser cards linking to the dedicated
  // /exclusive-placements page + an "unlock" CTA panel). Still no fabricated
  // top match (job stays null) and no numeric hidden-roles claim.
  it('zero real matches on a filtered search renders the exclusive-placement flow, not the generic empty state', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/var job = data\.jobs\[0\] \|\| null;\s*\n\s*if \(!job\) \{/);
    expect(res.raw).toMatch(/function renderExclusiveZeroMatch/);
    expect(res.raw).toContain('renderExclusiveZeroMatch();');
  });

  it('defines a real, focusable, accessibly-labelled link to /exclusive-placements for each locked card (not aria-hidden/decorative)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function buildExclusiveCard/);
    expect(res.raw).toContain('a.href = "/exclusive-placements?from=jobs"');
    expect(res.raw).toContain('Exclusive placement. Create a free account to view');
    // it must be an <a>, not a decorative aria-hidden div like the skeleton teasers
    expect(res.raw).toMatch(/var a = document\.createElement\("a"\);\s*\n\s*a\.className = "job-card exclusive-teaser";/);
  });

  it('the exclusive-zero-match card copy never fabricates a specific job (no practice name/suburb/salary presented as real)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('Exclusive placement');
    expect(res.raw).toContain('Members only');
    expect(res.raw).toContain('Unadvertised role &mdash; create a free account to unlock');
  });

  it('the exclusive-zero-match header uses the honest intro line (no numeric roles-found claim)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toContain('No public listings match your search, but many of our best roles are never advertised.');
  });

  it('the exclusive-zero-match CTA panel has the exact required copy', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function buildExclusiveCtaPanel/);
    expect(res.raw).toContain('Unlock exclusive opportunities');
    expect(res.raw).toContain(
      'Create a free account and your dedicated Registration Support Officer will match you to exclusive, '
    );
    expect(res.raw).toContain(
      'unadvertised roles that fit your profile &mdash; then you choose which to apply for.</p>'
    );
  });

  it('never fabricates a numeric count of exclusive/hidden roles anywhere on the page', async () => {
    const res = await get('/jobs');
    expect(res.raw).not.toContain('100+');
    expect(res.raw).not.toMatch(/\b\d+\s*(exclusive|unadvertised)\s*roles?\b/i);
    expect(res.raw).not.toMatch(/\d+\s*roles?\s*in\s*your\s*area/i);
  });

  it('respects prefers-reduced-motion for the teaser shimmer (static grey cards)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\.job-card\.skeleton,\.job-card\.skeleton-teaser\{animation:none;\}/);
  });

  it('unfiltered-mode markers (real pagination, interstitials, real count) are still present unchanged', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function renderPagination/);
    expect(res.raw).toMatch(/function buildSignupInterstitial/);
    expect(res.raw).toContain('label + " match your filters" : label + " available right now"');
  });

  // Review fix: when a filtered search's total is <= FILTERED_TOP_MATCHES,
  // every public match is already on screen — so no locked teaser cards, no
  // "unlock the rest" panel/header, just the real matches plus an honest,
  // modest signup panel about widening the search to future/unadvertised roles.
  it('renders a single-match panel with the exact required honest copy (no fake teasers)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function buildSingleMatchPanel/);
    expect(res.raw).toContain('single-match-panel');
    expect(res.raw).toContain('Want us to widen the search?');
    expect(res.raw).toContain(
      'Create a free account and we&rsquo;ll match you to roles as they open &mdash; including ones never '
    );
    expect(res.raw).toContain('advertised publicly.');
  });

  it('the all-shown header reports an honest count (1 vs N matching roles found)', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/function renderAllMatches/);
    expect(res.raw).toContain('"1 matching role found"');
    expect(res.raw).toContain('list.length + " matching roles found"');
  });

  it('branches on total>shown.length vs total<=shown.length instead of always rendering teasers', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(/if \(total > shown\.length\) \{\s*\n\s*renderFilteredMatches\(shown\);\s*\n\s*\} else \{\s*\n\s*renderAllMatches\(shown\);\s*\n\s*\}/);
  });

  it('the all-shown path renders no locked teaser cards and no teaser load-more pagination', async () => {
    const res = await get('/jobs');
    expect(res.raw).toMatch(
      /function renderAllMatches\(list\) \{[\s\S]*?grid\.appendChild\(buildSingleMatchPanel\(\)\);\s*\n\s*paginationEl\.innerHTML = "";\s*\n\s*\}/
    );
  });
});

describe('GET /jobs/view (Task 9 job detail page)', () => {
  it('is 200 text/html containing the data-job-detail marker', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.raw).toContain('data-job-detail');
  });

  it('is 200 even with no ?id= param (client-side renders the not-found panel)', async () => {
    const res = await get('/jobs/view');
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data-job-detail');
  });

  it('has no auth-guard.js', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
  });

  it('has zero dead href="#" links', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('has no app-shell/nav-shell-bridge chrome (marketing pages are standalone)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
  });

  it('links the shared site chrome css/js', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260729b');
  });

  it('marks Jobs as the current nav section', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toMatch(/<a href="\/jobs" aria-current="page">Jobs<\/a>/);
  });

  it('has a breadcrumb link back to /jobs', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('id="breadcrumbBack" href="/jobs"');
  });

  it('has the static apply deep link in the sidebar (signup=1&next=/pages/career)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('signup=1&next=/pages/career');
  });

  it('has the "ask us" secondary CTA pointing at the /start#book funnel', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toMatch(/href="\/start#book">Ask us about this role/);
  });

  it('has a not-found panel with a link back to /jobs', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('This role is no longer available');
    expect(res.raw).toMatch(/<a class="btn primary" href="\/jobs">Browse all jobs<\/a>/);
  });

  it('has SEO head tags (static title, canonical without id, description, OG)', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('<title>GP Job Details | GP Link</title>');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/jobs/view">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,220}">/);
    expect(res.raw).toContain('property="og:image" content="https://www.mygplink.com.au/media/images/site/beach-poster.jpg"');
  });

  it('escapes API-sourced job data via an escapeHtml helper, not innerHTML with raw strings', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toMatch(/function escapeHtml/);
    expect(res.raw).not.toMatch(/document\.write/);
  });

  it('client-side resolves the job via the server-side /api/public/jobs?id= exact-match lookup', async () => {
    const res = await get('/jobs/view?id=anything');
    expect(res.raw).toContain('/api/public/jobs?');
    expect(res.raw).toMatch(/params\.set\("id",\s*targetId\)/);
  });
});
