// Phase 6 E2: job SEO — server-rendered JobPosting JSON-LD on /jobs/view?id=…
// plus the enriched sitemap (per-job URLs + privacy/terms/blog).
//
// LEAK CONTRACT UNDER TEST: the JSON-LD, rewritten meta tags and sitemap are
// built ONLY from the sanitized public job shape — the real practice name
// (present on the raw career_roles row) must never appear anywhere in the
// served HTML or XML.
//
// Supabase is unconfigured; the live rows are seeded straight into the
// public-jobs rows cache via __setPublicJobsRowsCacheForTest (the exact same
// cache getPublicJobsRows serves /api/public/jobs, /jobs/view and the sitemap
// from), so the real route handlers run end-to-end over HTTP.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-job-seo-${RUN_ID}.json`;
const REAL_PRACTICE_NAME = 'Riverside Medical Centre';
let server, port, testUtils;

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractJsonLd(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

// Raw career_roles-shaped row — carries the REAL practice name (and a title
// that embeds it, so the masked-title fallback must kick in).
function makeRawRow(overrides) {
  return {
    id: 901,
    provider: 'zoho_recruit',
    provider_role_id: 'ZR-901',
    title: 'VR GP — ' + REAL_PRACTICE_NAME,
    practice_name: REAL_PRACTICE_NAME,
    masked_title: '',
    header_image_url: '',
    suburb: 'Sunnybank',
    nearest_city: 'Brisbane',
    location_city: 'Brisbane',
    location_state: 'QLD',
    location_country: 'Australia',
    location_label: 'Sunnybank, QLD',
    billing_model: 'Mixed Billing',
    dpa: true,
    mmm: 'MMM 2',
    earnings_text: '$300k package',
    summary: 'Role summary that must not surface raw for zoho rows.',
    employment_type: 'Full-time',
    tags: ['VR-GP', 'DPA'],
    is_active: true,
    source_payload: { secret: 'internal' },
    published_at: '2026-06-20T00:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...overrides
  };
}

const ROW_A = makeRawRow();
const ROW_B = makeRawRow({ id: 902, provider_role_id: 'ZR-902', suburb: 'Cairns North', location_state: 'QLD', employment_type: 'Locum' });
const JOB_A_ID = 'zoho_recruit:ZR-901';

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'job-seo-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;

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
  testUtils.__setPublicJobsRowsCacheForTest({ rows: [ROW_A, ROW_B], at: Date.now() });
});

describe('GET /jobs/view?id=… — server-rendered JobPosting JSON-LD', () => {
  it('serves HTML containing a valid JobPosting JSON-LD for the requested job', async () => {
    const res = await get('/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    const jsonLd = extractJsonLd(res.raw);
    expect(jsonLd).toBeTruthy();
    expect(jsonLd['@type']).toBe('JobPosting');
    expect(jsonLd.identifier.value).toBe(JOB_A_ID);
    expect(jsonLd.datePosted).toBe('2026-06-20T00:00:00.000Z');
    expect(jsonLd.employmentType).toBe('FULL_TIME');
    expect(jsonLd.url).toBe('https://www.mygplink.com.au/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
  });

  it('NEVER leaks the real practice name anywhere in the served HTML', async () => {
    const res = await get('/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
    expect(res.raw).not.toContain(REAL_PRACTICE_NAME);
    expect(res.raw).not.toContain('Riverside');
    const jsonLd = extractJsonLd(res.raw);
    expect(JSON.stringify(jsonLd)).not.toContain(REAL_PRACTICE_NAME);
    expect(jsonLd.hiringOrganization.name).toBe('GP Link');
  });

  it('jobLocation is suburb/region only (never a street address)', async () => {
    const res = await get('/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
    const jsonLd = extractJsonLd(res.raw);
    expect(jsonLd.jobLocation.address).toEqual({
      '@type': 'PostalAddress',
      addressCountry: 'AU',
      addressLocality: 'Sunnybank',
      addressRegion: 'QLD'
    });
  });

  it('rewrites canonical + og:url + og:title to the job-specific values', async () => {
    const res = await get('/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
    const jobUrl = 'https://www.mygplink.com.au/jobs/view?id=' + encodeURIComponent(JOB_A_ID);
    expect(res.raw).toContain('<link rel="canonical" href="' + jobUrl + '">');
    expect(res.raw).toContain('<meta property="og:url" content="' + jobUrl + '">');
    // The masked title (never the practice name) drives <title> and og:title.
    const titleMatch = res.raw.match(/<title>([^<]*)<\/title>/);
    expect(titleMatch[1]).toContain('| GP Link');
    expect(titleMatch[1]).not.toContain(REAL_PRACTICE_NAME);
  });

  it('serves the plain static page (no JSON-LD) when there is no id', async () => {
    const res = await get('/jobs/view');
    expect(res.status).toBe(200);
    expect(extractJsonLd(res.raw)).toBeNull();
  });

  it('serves the plain static page (no JSON-LD) for an unknown id', async () => {
    const res = await get('/jobs/view?id=' + encodeURIComponent('zoho_recruit:NOPE'));
    expect(res.status).toBe(200);
    expect(extractJsonLd(res.raw)).toBeNull();
  });
});

describe('GET /sitemap.xml — enrichment', () => {
  it('includes one URL per live public job plus privacy/terms/blog', async () => {
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/xml');
    expect(res.raw).toContain('/jobs/view?id=' + encodeURIComponent(JOB_A_ID));
    expect(res.raw).toContain('/jobs/view?id=' + encodeURIComponent('zoho_recruit:ZR-902'));
    expect(res.raw).toContain('https://www.mygplink.com.au/pages/privacy');
    expect(res.raw).toContain('https://www.mygplink.com.au/pages/terms');
    expect(res.raw).toContain('https://www.mygplink.com.au/blog');
    // Blog posts are enumerable from the static BLOG_POSTS list.
    expect(res.raw).toMatch(/https:\/\/www\.mygplink\.com\.au\/blog\/[a-z0-9-]+/);
    // Still the marketing routes it always carried.
    expect(res.raw).toContain('https://www.mygplink.com.au/jobs</loc>');
  });

  it('never leaks the real practice name into the sitemap', async () => {
    const res = await get('/sitemap.xml');
    expect(res.raw).not.toContain(REAL_PRACTICE_NAME);
    expect(res.raw).not.toContain('Riverside');
  });
});

describe('buildJobPostingJsonLd (pure)', () => {
  it('builds only from the sanitized public job shape', () => {
    const publicJob = testUtils.mapCareerRoleRowToPublicJob(ROW_A);
    const jsonLd = testUtils.buildJobPostingJsonLd(publicJob);
    const flat = JSON.stringify(jsonLd);
    expect(flat).not.toContain(REAL_PRACTICE_NAME);
    expect(flat).not.toContain('internal'); // source_payload never reaches it
    expect(jsonLd.title).toBe(publicJob.title);
    expect(jsonLd.directApply).toBe(false);
  });

  it('drops the raw row defensively even if a caller passes one', () => {
    // Belt-and-braces: passing the RAW row (with practice_name) still cannot
    // leak — buildJobPostingJsonLd re-runs sanitizePublicJob internally, so
    // only whitelisted fields survive. The raw title is a whitelisted field
    // (masking happens in the mapper), which is why callers must always map
    // first — this test just proves non-whitelisted columns are stripped.
    const jsonLd = testUtils.buildJobPostingJsonLd({ ...testUtils.mapCareerRoleRowToPublicJob(ROW_A), practice_name: REAL_PRACTICE_NAME, source_payload: { secret: 'x' } });
    expect(JSON.stringify(jsonLd)).not.toContain(REAL_PRACTICE_NAME);
  });

  it('maps employment types to schema.org enums', () => {
    expect(testUtils.mapEmploymentTypeToSchema('Full-time')).toBe('FULL_TIME');
    expect(testUtils.mapEmploymentTypeToSchema('Part time')).toBe('PART_TIME');
    expect(testUtils.mapEmploymentTypeToSchema('Locum')).toBe('CONTRACTOR');
    expect(testUtils.mapEmploymentTypeToSchema('Temporary cover')).toBe('TEMPORARY');
    expect(testUtils.mapEmploymentTypeToSchema('')).toBe('');
  });
});

describe('injectJobSeoIntoHtml (pure)', () => {
  it('does not interpret $ in job text as a regex replacement pattern', () => {
    const publicJob = { ...testUtils.mapCareerRoleRowToPublicJob(ROW_A), summary: 'Earn $300k+ with $& style text' };
    const html = '<head><title>x</title><meta property="og:description" content="old"></head>';
    const out = testUtils.injectJobSeoIntoHtml(html, publicJob);
    expect(out).toContain('Earn $300k+ with $&amp; style text');
  });

  it('inserts JSON-LD containing $&, $\' and $$ literally (no replacement-pattern corruption)', () => {
    // The </head> insertion must use a FUNCTION replacer: with a string 2nd
    // arg, `$&`/`$'`/`$$` inside the JSON-LD are replacement-pattern specials
    // ($' would splice in the page tail; $$ collapses to $), corrupting the
    // script or terminating it early.
    const publicJob = {
      ...testUtils.mapCareerRoleRowToPublicJob(ROW_A),
      title: 'GP role $& deluxe',
      summary: "Earn $$300k and $' more"
    };
    const html = '<head><title>x</title></head><body><p>page tail</p></body>';
    const out = testUtils.injectJobSeoIntoHtml(html, publicJob);
    const jsonLd = extractJsonLd(out); // null / JSON.parse throw if the script is malformed
    expect(jsonLd).toBeTruthy();
    expect(jsonLd['@type']).toBe('JobPosting');
    expect(jsonLd.title).toBe('GP role $& deluxe');
    expect(jsonLd.description).toContain("Earn $$300k and $' more");
    // Exactly one well-formed head/body — nothing duplicated or spliced in.
    expect(out.match(/<\/head>/g)).toHaveLength(1);
    expect(out.match(/<\/body>/g)).toHaveLength(1);
    expect(out.match(/<p>page tail<\/p>/g)).toHaveLength(1);
    expect(out.endsWith('</body>')).toBe(true);
  });

  it('escapes </script-breaking sequences inside the JSON-LD', () => {
    const publicJob = { ...testUtils.mapCareerRoleRowToPublicJob(ROW_A), summary: 'bad </script><script>alert(1)' };
    const out = testUtils.injectJobSeoIntoHtml('<head><title>x</title></head>', publicJob);
    const ldSegment = out.slice(out.indexOf('application/ld+json'));
    expect(ldSegment).not.toContain('</script><script>alert');
  });
});
