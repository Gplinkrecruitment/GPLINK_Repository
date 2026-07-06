import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Task 14: full verification sweep + automated link audit across the
// public marketing pages (Task 15 added /gp-jobs to the set). Mirrors the
// http-harness idiom used by tests/site-public-routes.test.js (boot a real
// server, no Supabase configured, no session) but instead of asserting
// individual known-good links, this crawls every href/src/action attribute
// actually rendered on each page and classifies it:
//   (a) an internal path that 200s directly, OR an auth-guarded path that
//       302s to /pages/signin (which itself must then 200) — /pages/signin*
//       links are asserted to 200 directly, since they ARE the sign-in page;
//   (b) an in-page anchor (#id resolves against the same page, /#id or
//       /path#id resolves against the target page's rendered id="...");
//   (c) an allowlisted external URL (calendly.com/hello-mygplink,
//       facebook.com, mailto:hello@mygplink.com.au);
//   (d) a versioned asset under /css/, /js/, or /media/ that 200s with a
//       content-type matching its extension.
// It also asserts zero dead href="#" links, exactly one <title>/meta
// description/canonical per page, no auth-guard.js/nav-shell-bridge.js on
// any of the public pages, and that /sitemap.xml lists exactly the public
// routes below (no more, no less).

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let addrPort;

const PUBLIC_ROUTES = ['/', '/jobs', '/jobs/view', '/employers', '/about', '/faq', '/the-app', '/gp-jobs', '/exclusive-placements'];
const PUBLIC_BASE_URL = 'https://www.mygplink.com.au';

const ALLOWED_EXTERNAL = [
  /^https:\/\/calendly\.com\/hello-mygplink(\/|$)/,
  /^https:\/\/(www\.)?facebook\.com(\/|$)/,
];
const ALLOWED_MAILTO = new Set(['mailto:hello@mygplink.com.au']);

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

// Memoized GET so repeated links (e.g. the shared header/footer nav that
// appears on all 7 pages) are only fetched once.
const fetchCache = new Map();
function cachedGet(path) {
  if (!fetchCache.has(path)) fetchCache.set(path, get(path));
  return fetchCache.get(path);
}

// Strips <script>...</script> and <style>...</style> blocks before
// extracting attributes, so JS string literals that happen to contain
// `href="..."` (e.g. innerHTML template strings in site-jobs.html's
// empty-state message) are never mistaken for real markup attributes.
function stripScriptsAndStyles(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
}

function extractLinks(html) {
  const stripped = stripScriptsAndStyles(html);
  const links = [];
  const re = /\s(href|src|action)="([^"]*)"/g;
  let m;
  while ((m = re.exec(stripped))) {
    links.push({ attr: m[1], value: m[2] });
  }
  return links;
}

function contentTypeMatchesExt(ext, contentType) {
  const ct = String(contentType || '').toLowerCase();
  switch (ext) {
    case '.css': return ct.includes('text/css');
    case '.js': return ct.includes('javascript');
    case '.png': return ct.includes('image/png');
    case '.jpg':
    case '.jpeg': return ct.includes('image/jpeg');
    case '.svg': return ct.includes('image/svg');
    case '.webp': return ct.includes('image/webp');
    case '.mp4': return ct.includes('video/mp4');
    case '.ico': return ct.includes('image');
    default: return ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('text/') || ct.includes('javascript');
  }
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-site-link-audit-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-link-audit-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

// Populate the page-HTML cache for all 7 routes up front so anchor-target
// lookups (e.g. `/employers#enquire` referenced from every page's footer)
// can resolve against another public route without a second network round
// trip mid-assertion.
const pageHtml = {};

describe('marketing site link audit (Task 14)', () => {
  it('fetches all 7 public pages as 200 text/html', async () => {
    for (const route of PUBLIC_ROUTES) {
      const res = await cachedGet(route);
      pageHtml[route] = res.raw;
      expect(res.status, `GET ${route}`).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    }
  });

  for (const route of PUBLIC_ROUTES) {
    it(`GET ${route} — every href/src/action resolves`, async () => {
      const html = pageHtml[route];
      expect(html, `expected ${route} to already be fetched`).toBeTruthy();

      const links = extractLinks(html);
      const failures = [];

      for (const { attr, value } of links) {
        try {
          if (value === '') continue; // e.g. an empty action="" is not a navigable link
          if (value === '#') {
            failures.push(`${attr}="#" dead link`);
            continue;
          }

          if (value.startsWith('mailto:')) {
            if (!ALLOWED_MAILTO.has(value)) failures.push(`disallowed mailto: ${value}`);
            continue;
          }

          // Self-referencing absolute URLs (e.g. the canonical <link>'s
          // href="https://www.mygplink.com.au/faq") are treated as internal
          // paths, not external links — fall through to the same-origin
          // resolution logic below instead of the external allowlist.
          let effectiveValue = value;
          if (value.startsWith(PUBLIC_BASE_URL + '/') || value === PUBLIC_BASE_URL) {
            effectiveValue = value.slice(PUBLIC_BASE_URL.length) || '/';
          } else if (/^https?:\/\//.test(value)) {
            if (!ALLOWED_EXTERNAL.some((re) => re.test(value))) failures.push(`disallowed external URL: ${value}`);
            continue;
          }

          if (effectiveValue.startsWith('tel:') || effectiveValue.startsWith('javascript:')) {
            failures.push(`unexpected scheme: ${value}`);
            continue;
          }

          // Split off any fragment (#id) from the path/query portion.
          const hashIdx = effectiveValue.indexOf('#');
          const basePart = hashIdx === -1 ? effectiveValue : effectiveValue.slice(0, hashIdx);
          const fragment = hashIdx === -1 ? null : effectiveValue.slice(hashIdx + 1);

          if (basePart === '') {
            // Bare "#id" — anchor must exist on the SAME page.
            if (!fragment) {
              failures.push(`${attr}="#" dead link`);
              continue;
            }
            const idRe = new RegExp(`id="${fragment}"`);
            if (!idRe.test(html)) failures.push(`#${fragment} has no matching id="${fragment}" on ${route}`);
            continue;
          }

          if (!basePart.startsWith('/')) {
            failures.push(`unrecognized relative link: ${value}`);
            continue;
          }

          const pathOnly = basePart.split('?')[0];
          const ext = (pathOnly.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
          const isVersionedAsset = /^\/(css|js|media)\//.test(pathOnly);

          if (isVersionedAsset) {
            const res = await cachedGet(basePart);
            if (res.status !== 200) {
              failures.push(`asset ${basePart} returned ${res.status}, expected 200`);
            } else if (!contentTypeMatchesExt(ext, res.headers['content-type'])) {
              failures.push(`asset ${basePart} has unexpected content-type ${res.headers['content-type']}`);
            }
          } else if (pathOnly.startsWith('/pages/signin')) {
            const res = await cachedGet(basePart);
            if (res.status !== 200) {
              failures.push(`signin link ${basePart} returned ${res.status}, expected 200`);
            }
          } else {
            const res = await cachedGet(basePart);
            if (res.status === 200) {
              if (pathOnly in pageHtml || PUBLIC_ROUTES.includes(pathOnly)) {
                // Cache the body for potential fragment lookups below.
                if (!(pathOnly in pageHtml)) pageHtml[pathOnly] = res.raw;
              } else if (!(pathOnly in pageHtml)) {
                pageHtml[pathOnly] = res.raw;
              }
            } else if (res.status === 302) {
              const loc = String(res.headers.location || '');
              if (!loc.startsWith('/pages/signin')) {
                failures.push(`internal link ${basePart} redirected to unexpected location ${loc}`);
              } else {
                const signinRes = await cachedGet(loc);
                if (signinRes.status !== 200) {
                  failures.push(`internal link ${basePart} 302'd to ${loc}, which did not 200 (got ${signinRes.status})`);
                }
              }
            } else {
              failures.push(`internal link ${basePart} returned ${res.status}, expected 200 or a 302 to /pages/signin`);
            }
          }

          if (fragment) {
            const targetHtml = pageHtml[pathOnly] || (await cachedGet(basePart)).raw;
            const idRe = new RegExp(`id="${fragment}"`);
            if (!idRe.test(targetHtml)) {
              failures.push(`${value} has no matching id="${fragment}" on ${pathOnly}`);
            }
          }
        } catch (err) {
          failures.push(`error resolving ${attr}="${value}": ${err.message}`);
        }
      }

      expect(failures, `broken links on ${route}:\n${failures.join('\n')}`).toEqual([]);
    });

    it(`GET ${route} — no dead href="#", exactly one title/description/canonical, no app-shell chrome`, () => {
      const html = pageHtml[route];

      expect(html).not.toMatch(/href="#"/);

      const titleCount = (html.match(/<title>/g) || []).length;
      const descCount = (html.match(/<meta\s+name="description"/g) || []).length;
      const canonicalCount = (html.match(/<link\s+rel="canonical"/g) || []).length;
      expect(titleCount, `${route} <title> count`).toBe(1);
      expect(descCount, `${route} meta description count`).toBe(1);
      expect(canonicalCount, `${route} canonical link count`).toBe(1);

      expect(html).not.toMatch(/auth-guard\.js/);
      expect(html).not.toMatch(/nav-shell-bridge\.js/);
    });
  }

  it('/robots.txt is 200 text/plain and points at the sitemap', async () => {
    const res = await cachedGet('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.raw).toMatch(/Sitemap: https:\/\/www\.mygplink\.com\.au\/sitemap\.xml/);
  });

  it('/sitemap.xml lists all public routes plus privacy/terms/blog (Phase 6 E2 enrichment)', async () => {
    const res = await cachedGet('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);

    const locs = [...res.raw.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const paths = locs.map((loc) => loc.replace(PUBLIC_BASE_URL, '') || '/');

    // Every marketing route must still be present…
    for (const route of PUBLIC_ROUTES) expect(paths).toContain(route);
    // …plus the Phase 6 E2 additions (privacy/terms/blog; blog posts and
    // per-job URLs are covered in tests/job-seo.test.js).
    expect(paths).toContain('/pages/privacy');
    expect(paths).toContain('/pages/terms');
    expect(paths).toContain('/blog');
    // Everything else in the sitemap is only ever a blog post or a public
    // masked job URL — nothing internal.
    const known = new Set([...PUBLIC_ROUTES, '/pages/privacy', '/pages/terms', '/blog']);
    for (const p of paths) {
      if (known.has(p)) continue;
      expect(p, `unexpected sitemap path ${p}`).toMatch(/^(\/blog\/[a-z0-9-]+|\/jobs\/view\?id=)/);
    }
  });
});
