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
    expect(res.raw).toContain('GPSite');
    expect(res.raw).toContain('initJobSearch');
    expect(res.raw).toContain('bindEnquiryForm');
  });
});
