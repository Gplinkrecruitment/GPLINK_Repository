// Public-surface HTTP tests for GET /api/dpa/check (no session/auth required
// by design — the practice-intake page that calls this has no session at
// all). Boots the real server in LOCAL-JSON mode, same pattern as
// tests/practice-intake-endpoints.test.js. Mocks globalThis.fetch so no test
// ever reaches the real Department of Health service.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { _resetTokenCache } from '../lib/dpa-lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-dpa-check-${RUN_ID}.json`);
let server, port;
const originalFetch = globalThis.fetch;

function req(method, p, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {} }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end();
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const hwlResult = (dpaValue = 'Y', mmmValue = 2, catchment = 'Gosford') => ({
  results: {
    dpa_gps: { features: [{ properties: { value: dpaValue, class: 'DPA', catchment } }] },
    dpa_bmp: { features: [{ properties: { value: 'N' } }] },
    mmm2023: { features: [{ properties: { value: mmmValue } }] },
  },
});

function jsonRes(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

// A fetchImpl-equivalent mock of globalThis.fetch that answers the two HWL
// calls lookupDpa makes: guest-token, then getResult. `resultFn` controls
// the second call's outcome.
function mockFetchHappy(resultFn) {
  globalThis.fetch = (url) => {
    if (String(url).includes('/auth/guest-token')) {
      return jsonRes({ accessToken: 'guest-token-' + RUN_ID, expiresIn: 3600 });
    }
    if (String(url).includes('/theme/getResult/')) {
      return resultFn();
    }
    return Promise.reject(new Error('unexpected fetch call: ' + url));
  };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'dpa-check-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch {}
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  _resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetTokenCache();
});

describe('GET /api/dpa/check', () => {
  it('reachable without a session cookie: 400s (not a redirect/401) for missing params', async () => {
    const r = await req('GET', '/api/dpa/check');
    expect(r.status).toBe(400);
  });

  it('400s when lat/lon are missing', async () => {
    const r = await req('GET', '/api/dpa/check');
    expect(r.status).toBe(400);
    const body = parse(r.raw);
    expect(body.dpa).toBeUndefined();
  });

  it('400s when lat/lon are non-numeric', async () => {
    const r = await req('GET', '/api/dpa/check?lat=notanumber&lon=144.9');
    expect(r.status).toBe(400);
    const body = parse(r.raw);
    expect(body.dpa).toBeUndefined();
  });

  it('200s with a dpa boolean for a valid lat/lon', async () => {
    mockFetchHappy(() => jsonRes(hwlResult('Y')));
    const r = await req('GET', '/api/dpa/check?lat=-37.8&lon=144.9');
    expect(r.status).toBe(200);
    const body = parse(r.raw);
    expect(typeof body.dpa).toBe('boolean');
    expect(body.dpa).toBe(true);
    expect(body.source).toMatch(/Health Workforce Locator/i);
  });

  it('502s with no dpa field at all when the lookup throws (never defaults to false)', async () => {
    mockFetchHappy(() => jsonRes({ results: { dpa_gps: { features: [] } } }));
    const r = await req('GET', '/api/dpa/check?lat=-37.8&lon=144.9');
    expect(r.status).toBe(502);
    const body = parse(r.raw);
    expect(Object.prototype.hasOwnProperty.call(body, 'dpa')).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it('502s (never 200 with dpa:false) when the upstream HTTP call itself fails', async () => {
    globalThis.fetch = () => Promise.reject(new Error('network down'));
    const r = await req('GET', '/api/dpa/check?lat=-37.8&lon=144.9');
    expect(r.status).toBe(502);
    const body = parse(r.raw);
    expect(Object.prototype.hasOwnProperty.call(body, 'dpa')).toBe(false);
  });
});
