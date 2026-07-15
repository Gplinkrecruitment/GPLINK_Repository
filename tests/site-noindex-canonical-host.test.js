import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// The marketing pages are served byte-identically on EVERY host the app answers
// on (the real site, preview.mygplink.com.au, app.mygplink.com.au/jobs, Vercel
// preview URLs). Before this, robots.txt said "Allow: /" on all of them, so
// Google saw several competing indexable copies of the same site and picked the
// canonical itself — often the wrong one. Only the canonical marketing host may
// be indexed; every other host must send X-Robots-Tag: noindex.
//
// Mirrors the http-harness idiom used by tests/site-public-routes.test.js.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const ADMIN_TEST_HOST = 'admin-noindex-test-' + RUN_ID + '.local';
let server;
let addrPort;

function get(path, { host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
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

beforeAll(async () => {
  process.env.DB_FILE_PATH = `/tmp/gplink-site-noindex-${RUN_ID}.json`;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_TEST_HOST;
  delete process.env.MARKETING_CANONICAL_HOSTS;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

afterEach(() => {
  delete process.env.MARKETING_CANONICAL_HOSTS;
});

const CANONICAL_WWW = 'www.mygplink.com.au';
const CANONICAL_APEX = 'mygplink.com.au';
const NON_CANONICAL_HOSTS = [
  'preview.mygplink.com.au',
  'app.mygplink.com.au',
  'gplink-repository.vercel.app',
];

describe('marketing site is indexable only on the canonical host', () => {
  // Both apex and www are canonical by default, so the owner's final
  // apex-vs-www choice is a DNS/redirect decision, not a code change.
  for (const host of [CANONICAL_WWW, CANONICAL_APEX]) {
    it(`sends NO noindex header on the canonical host ${host}`, async () => {
      const res = await get('/', { host });
      expect(res.status).toBe(200);
      expect(res.headers['x-robots-tag']).toBeUndefined();
    });
  }

  it('robots.txt on the canonical host still allows indexing and advertises the sitemap', async () => {
    const res = await get('/robots.txt', { host: CANONICAL_WWW });
    expect(res.status).toBe(200);
    expect(res.raw).toMatch(/Allow: \//);
    expect(res.raw).toMatch(/Sitemap: https:\/\/www\.mygplink\.com\.au\/sitemap\.xml/);
  });

  for (const host of NON_CANONICAL_HOSTS) {
    it(`sends X-Robots-Tag: noindex on the non-canonical host ${host}`, async () => {
      const res = await get('/jobs', { host });
      expect(res.status).toBe(200);
      expect(String(res.headers['x-robots-tag'])).toMatch(/noindex/);
    });
  }

  it('noindexes the marketing sub-routes that still resolve on the app host', async () => {
    // /jobs, /about, /faq … still answer on app.mygplink.com.au. Those are the
    // duplicate copies most likely to outrank the real site.
    const res = await get('/about', { host: 'app.mygplink.com.au' });
    expect(res.status).toBe(200);
    expect(String(res.headers['x-robots-tag'])).toMatch(/noindex/);
  });

  it('does NOT Disallow the crawl on a non-canonical host', async () => {
    // A Disallow would stop Google fetching the page — so it would never SEE
    // the noindex header, and a disallowed URL can still be indexed if some
    // other site links to it. Allow-the-crawl + noindex-header is the reliable
    // combination. We just don't advertise a sitemap from a copy.
    const res = await get('/robots.txt', { host: 'preview.mygplink.com.au' });
    expect(res.status).toBe(200);
    expect(res.raw).not.toMatch(/Disallow: \//);
    expect(res.raw).not.toMatch(/Sitemap:/);
    expect(String(res.headers['x-robots-tag'])).toMatch(/noindex/);
  });

  it('MARKETING_CANONICAL_HOSTS flips which host is indexable without a code change', async () => {
    process.env.MARKETING_CANONICAL_HOSTS = 'preview.mygplink.com.au';

    const preview = await get('/', { host: 'preview.mygplink.com.au' });
    expect(preview.headers['x-robots-tag']).toBeUndefined();

    const www = await get('/', { host: CANONICAL_WWW });
    expect(String(www.headers['x-robots-tag'])).toMatch(/noindex/);
  });
});
