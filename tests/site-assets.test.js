import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for the shared marketing-site chrome assets: css/site.css (design
// tokens + shared chrome) and js/site.js (shared behaviours: header scroll
// state, mobile menu, reveal-on-scroll, count-up, job search, enquiry form,
// FAQ accordion, toast). Every one of the 7 public marketing pages (Tasks
// 7-12) references these two files, so this just proves they are served
// correctly with the right content-type — mirrors the http-harness idiom
// used by tests/site-public-routes.test.js.

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
  process.env.AUTH_SECRET = 'test-site-assets-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-site-assets-${RUN_ID}.json`;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch { /* ignore */ }
});

describe('shared marketing-site chrome assets', () => {
  it('GET /css/site.css is 200 text/css and contains the ported design tokens', async () => {
    const res = await get('/css/site.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.raw).toContain('--teal: #116dff');
    expect(res.raw).toContain('.site-header');
    expect(res.raw).toContain('.site-footer');
  });

  it('GET /js/site.js is 200 application/javascript and exposes window.GPSite', async () => {
    const res = await get('/js/site.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600, must-revalidate');
    expect(res.raw).toContain('GPSite');
    expect(res.raw).toContain('initJobSearch');
    expect(res.raw).toContain('bindEnquiryForm');
  });

  // Regression (2026-07-29): initJobSearch used to copy a `type` param across
  // from the current URL because the position-type dropdown had been replaced
  // by Billing type and FormData cannot see an unrendered field. That made a
  // stale /jobs?type=locum sticky — it survived every subsequent Search while
  // matching no masked role, so the visitor was stuck on an empty board with
  // all three dropdowns reading "All" and no way to see what was filtering it.
  // The search URL must be built from the rendered controls and nothing else.
  it('the job search builds its URL from the rendered controls only (no carried-over params)', async () => {
    const res = await get('/js/site.js');
    expect(res.status).toBe(200);
    expect(res.raw).toMatch(/\["q", "state", "billing"\]\.forEach/);
    expect(res.raw).not.toContain('carriedType');
    expect(res.raw).not.toMatch(/params\.set\("type"/);
  });

  // Regression guard for the count-up "stale closure" bug: the rAF step()
  // function used to capture `target` once from the IntersectionObserver
  // callback and never re-read it, so a later live-stats update to the
  // data-count attribute (see pages/site-home.html applyCount()) was
  // silently stomped by the still-running animation's final frame. This is
  // a static source assertion, not a DOM/rAF simulation — it proves the fix
  // (re-reading the attribute inside step()) is present in the shipped
  // file, not that the animation renders correctly frame-by-frame.
  it('count-up step() re-reads data-count from the element on every frame (no stale target closure)', async () => {
    const res = await get('/js/site.js');
    expect(res.status).toBe(200);

    const stepMatch = res.raw.match(/function step\(ts\) \{[\s\S]*?\n\s*\}\n/);
    expect(stepMatch, 'expected to find the count-up step() function body in js/site.js').toBeTruthy();
    const stepBody = stepMatch[0];

    // The target must be read from the live attribute inside step(), not
    // from a variable declared outside/before step() (a stale closure).
    expect(stepBody).toContain('el.getAttribute("data-count")');

    // And it must NOT be declared once outside step() and reused - i.e.
    // there should be no `var target =` assignment between the count-up
    // IntersectionObserver callback and `function step`, which would mean
    // step() is closing over a stale value instead of re-reading it.
    const cioStart = res.raw.indexOf('var cio = new IntersectionObserver(function (entries) {');
    const stepStart = res.raw.indexOf('function step(ts)');
    expect(cioStart, 'expected to find the count-up IntersectionObserver callback in js/site.js').toBeGreaterThan(-1);
    expect(stepStart, 'expected to find function step(ts) after the count-up IntersectionObserver callback').toBeGreaterThan(cioStart);
    const beforeStep = res.raw.slice(cioStart, stepStart);
    expect(beforeStep).not.toMatch(/var target = /);
  });
});
