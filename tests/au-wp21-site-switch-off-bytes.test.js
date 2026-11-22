import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

// WP-21, the hard requirement: with the Australian switch OFF the public
// website is the live website, byte for byte.
//
//   1. Every existing site page, resolved for the switch-off state, is
//      IDENTICAL to the file on origin/main (whitespace included).
//   2. The real server, switch off, sends those same bytes at every route.
//   3. The new Australian addresses answer exactly as an unknown address.
//   4. The sitemap lists exactly what it lists today.
//
// "origin/main" is read with `git show`. Where git or that ref is not
// available (an exported tarball), the comparison falls back to the hashes in
// tests/fixtures/au-wp21-site-main-hashes.json, recorded from origin/main
// when this package was built. If main changes a site page, merge main and
// re-mark the page: this test is the tripwire for that.

const require = createRequire(import.meta.url);
const site = require('../lib/site-au-pages.js');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'au-wp21-site-main-hashes.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// The pages that exist on main. (New Australian-only pages are not on main.)
const EXISTING = Object.keys(fixture.pages).sort();

function mainBytes(rel) {
  try {
    return execFileSync('git', ['show', 'origin/main:' + rel], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    return null;
  }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('switch off: every existing site page is byte-identical to origin/main', () => {
  it('covers every site page that is not Australian-only', () => {
    const onDisk = fs.readdirSync(path.join(ROOT, 'pages'))
      .filter((f) => /^(site-[a-z0-9-]+|blog)\.html$/.test(f))
      .filter((f) => !site.isAuOnlyPagePath('/pages/' + f))
      .map((f) => 'pages/' + f)
      .sort();
    expect(onDisk).toEqual(EXISTING);
    expect(EXISTING).toContain('pages/blog.html');
    expect(EXISTING).toContain('pages/site-start.html');
    expect(EXISTING.length).toBe(12);
  });

  for (const rel of EXISTING) {
    it(`${rel}`, () => {
      const page = site.renderPageFile('/' + rel, { on: false });
      expect(page.ok).toBe(true);
      const fromGit = mainBytes(rel);
      if (fromGit) {
        // Byte for byte. Compared as hex of a hash first so a failure prints
        // something readable, then exactly.
        expect(sha(page.body)).toBe(sha(fromGit));
        expect(page.body.equals(fromGit)).toBe(true);
      } else {
        expect(sha(page.body)).toBe(fixture.pages[rel]);
      }
    });
  }
});

// ── The real server ───────────────────────────────────────────────────────

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let port;
const savedSwitch = process.env.AU_PATHWAY_ENABLED;

function get(urlPath, { cookie, accept, encoding } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (accept) headers.Accept = accept;
    if (encoding) headers['Accept-Encoding'] = encoding;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function gpSessionCookie() {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const payload = b64(JSON.stringify({ userProfile: { email: 'dr.test.wp21@gplink-test.local' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_session=${encodeURIComponent(payload + '.' + sig)}`;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-wp21-bytes-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-wp21-bytes-${RUN_ID}.json`;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (savedSwitch === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = savedSwitch;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

const ROUTES = {
  '/': 'pages/site-home.html',
  '/jobs': 'pages/site-jobs.html',
  '/jobs/view': 'pages/site-job.html',
  '/employers': 'pages/site-employers.html',
  '/about': 'pages/site-about.html',
  '/faq': 'pages/site-faq.html',
  '/the-app': 'pages/site-app.html',
  '/gp-jobs': 'pages/site-gp-jobs.html',
  '/visa': 'pages/site-visa.html',
  '/exclusive-placements': 'pages/site-exclusive.html',
  '/start': 'pages/site-start.html',
  '/start?src=fb': 'pages/site-start.html',
  '/blog': 'pages/blog.html',
  '/blog/some-post': 'pages/blog.html',
  '/pages/blog': 'pages/blog.html',
};

describe('switch off: the server sends the live site', () => {
  for (const [route, rel] of Object.entries(ROUTES)) {
    it(`GET ${route} is the origin/main bytes of ${rel}`, async () => {
      process.env.AU_PATHWAY_ENABLED = 'false';
      const res = await get(route);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const want = mainBytes(rel);
      if (want) expect(res.body.equals(want)).toBe(true);
      else expect(sha(res.body)).toBe(fixture.pages[rel]);
      expect(Number(res.headers['content-length'])).toBe(res.body.length);
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.body.toString('utf8')).not.toMatch(/<!--\/?au:/);
    });
  }

  it('a compressed response decodes to the same bytes', async () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    const zlib = require('zlib');
    const res = await get('/', { encoding: 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    const plain = await get('/');
    expect(zlib.gunzipSync(res.body).equals(plain.body)).toBe(true);
  });

  it('the page tag differs between the two switch states, so a kept copy is never called "not modified"', async () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    const off = await get('/');
    process.env.AU_PATHWAY_ENABLED = 'true';
    const on = await get('/');
    expect(off.headers.etag).toBeTruthy();
    expect(on.headers.etag).toBeTruthy();
    expect(on.headers.etag).not.toBe(off.headers.etag);
    expect(on.body.equals(off.body)).toBe(false);
  });

  // An unknown address, asked the way a browser asks for a page and the way a
  // script does. Whatever today's answer is, the new addresses must give the
  // same one: same status, same body, same redirect target.
  const NEW_ROUTES = Object.keys(site.AU_ONLY_SITE_ROUTES);
  const NEW_FILES = Object.values(site.AU_ONLY_SITE_ROUTES).map((f) => '/' + f.replace(/\.html$/, ''));

  function comparable(res, asked, stoodFor) {
    // The friendly not-found page carries the address that was asked for.
    const norm = (t) => String(t).split(encodeURIComponent(asked)).join(encodeURIComponent(stoodFor)).split(asked).join(stoodFor);
    return { status: res.status, location: norm(res.headers.location || ''), type: res.headers['content-type'] || '', text: norm(res.body.toString('utf8')) };
  }

  for (const accept of ['text/html', '']) {
    for (const who of ['anonymous', 'signed in']) {
      it(`new routes answer as an unknown address (${who}, ${accept ? 'page navigation' : 'plain request'})`, async () => {
        process.env.AU_PATHWAY_ENABLED = 'false';
        const cookie = who === 'signed in' ? gpSessionCookie() : undefined;
        for (const route of NEW_ROUTES) {
          const unknown = route.replace('/australian-gps', '/zz-unknown-wp21');
          const a = await get(route, { accept, cookie });
          const b = await get(unknown, { accept, cookie });
          expect(a.status, route).toBe(404);
          expect(comparable(a, route, unknown), route).toEqual(comparable(b, unknown, unknown));
        }
      });

      it(`new page files answer as a file that is not there (${who}, ${accept ? 'page navigation' : 'plain request'})`, async () => {
        process.env.AU_PATHWAY_ENABLED = 'false';
        const cookie = who === 'signed in' ? gpSessionCookie() : undefined;
        for (const file of NEW_FILES) {
          const unknown = '/pages/site-zz-unknown-wp21';
          for (const suffix of ['', '.html']) {
            const a = await get(file + suffix, { accept, cookie });
            const b = await get(unknown + suffix, { accept, cookie });
            expect(comparable(a, file, unknown), file + suffix).toEqual(comparable(b, unknown, unknown));
            // Nothing of the page itself leaks (the not-found page only echoes the address asked for).
            expect(a.body.toString('utf8'), file + suffix).not.toMatch(/Ahpra|notice period|confidential/i);
          }
        }
      });
    }
  }

  it('the sitemap is what it is today: the eleven site routes, privacy, terms, the blog; no new address', async () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    const res = await get('/sitemap.xml');
    expect(res.status).toBe(200);
    const locs = [...res.body.toString('utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const base = 'https://www.mygplink.com.au';
    const head = ['/', '/jobs', '/jobs/view', '/employers', '/about', '/faq', '/the-app', '/gp-jobs', '/visa', '/exclusive-placements', '/start', '/pages/privacy', '/pages/terms', '/blog'];
    expect(locs.slice(0, head.length)).toEqual(head.map((p) => base + p));
    // Everything after that is a blog post (no job rows in this harness).
    for (const loc of locs.slice(head.length)) expect(loc.startsWith(base + '/blog/')).toBe(true);
    expect(res.body.toString('utf8')).not.toMatch(/australian-gps/);
  });

  it('no existing page links to a new address, in the switch-off site', async () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    for (const route of Object.keys(ROUTES)) {
      const res = await get(route);
      expect(res.body.toString('utf8'), route).not.toMatch(/australian-gps/);
    }
  });

  it('/start?src=fb still opens on the booking step with the switch off: the page is main\'s page', async () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    const html = (await get('/start?src=fb')).body.toString('utf8');
    expect(html).toContain('id="book"');
    expect(html).toContain("if (params.get('src') === 'fb') {");
    expect(html).toContain("show('bookEmailMatch');");
    // None of the Australian first-question code is in the page at all.
    expect(html).not.toContain('site-au-lead.js');
    expect(html).not.toContain('AU_FRAMING');
    expect(html).not.toContain('/api/public/features');
  });
});
