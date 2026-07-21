// Phase 6 Batch K1 — cross-device alert read-state sync.
//
// The bell panel (js/updates-sync.js) is local-first (localStorage), and
// GET/POST /api/gp/alerts/read-state is the server merge layer that makes an
// alert read on one device show as read on the GP's other devices. Read ids
// are stored in the GP's OWN user_state row under the server-managed key
// 'gp_alerts_read_sync' (not in USER_STATE_KEYS, so client /api/state syncs
// can neither read nor clobber it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
let server;
let port;

const GP_A = `alert-sync-a-${RUN_ID}@example.com`;
const GP_B = `alert-sync-b-${RUN_ID}@example.com`;
const ID1 = 'update:2026-07-07T00:00:00.000Z:Test alert one';
const ID2 = 'support:case-1:2026-07-07T01:00:00.000Z';

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
// Each call mints a FRESH signed session token — two calls for the same email
// model the same GP signed in on two different devices.
function userCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function request(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'alert-sync-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-alert-sync-${RUN_ID}.json`;

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(process.env.DB_FILE_PATH); } catch {}
});

describe('/api/gp/alerts/read-state — auth + own-data only', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await request('GET', '/api/gp/alerts/read-state');
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated POST with 401', async () => {
    const res = await request('POST', '/api/gp/alerts/read-state', { body: { ids: [ID1] } });
    expect(res.status).toBe(401);
  });

  it('starts empty for a GP with no stored read-state', async () => {
    const res = await request('GET', '/api/gp/alerts/read-state', { cookie: userCookie(GP_A) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.read).toEqual({});
  });
});

describe('/api/gp/alerts/read-state — persistence + cross-device reconcile', () => {
  it('persists a read id server-side (device A marks read)', async () => {
    const res = await request('POST', '/api/gp/alerts/read-state', {
      cookie: userCookie(GP_A),
      body: { ids: [ID1] }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.read)).toContain(ID1);
  });

  it('a SECOND session for the same GP (device B) sees the alert as read', async () => {
    // Fresh cookie = fresh signed token = a different device with empty localStorage.
    const deviceB = userCookie(GP_A);
    const res = await request('GET', '/api/gp/alerts/read-state', { cookie: deviceB });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.read)).toContain(ID1);
  });

  it('POST is a union merge — a second id is added without dropping the first', async () => {
    const post = await request('POST', '/api/gp/alerts/read-state', {
      cookie: userCookie(GP_A),
      body: { ids: [ID2] }
    });
    expect(post.status).toBe(200);
    expect(Object.keys(post.body.read)).toEqual(expect.arrayContaining([ID1, ID2]));

    const get = await request('GET', '/api/gp/alerts/read-state', { cookie: userCookie(GP_A) });
    expect(Object.keys(get.body.read)).toEqual(expect.arrayContaining([ID1, ID2]));
  });

  it('own-data only: a DIFFERENT GP never sees another GP\'s read ids', async () => {
    const res = await request('GET', '/api/gp/alerts/read-state', { cookie: userCookie(GP_B) });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.read)).not.toContain(ID1);
    expect(Object.keys(res.body.read)).not.toContain(ID2);
  });

  it('rejects a POST whose ids is not an array', async () => {
    const res = await request('POST', '/api/gp/alerts/read-state', {
      cookie: userCookie(GP_A),
      body: { ids: 'not-an-array' }
    });
    expect(res.status).toBe(400);
  });

  it('ignores non-string and blank ids instead of storing junk', async () => {
    const res = await request('POST', '/api/gp/alerts/read-state', {
      cookie: userCookie(GP_A),
      body: { ids: [123, '', '   ', null, { evil: true }] }
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.read).sort()).toEqual([ID1, ID2].sort());
  });

  it('the server-managed key never leaks through GET /api/state (not client-writable either)', async () => {
    const res = await request('GET', '/api/state', { cookie: userCookie(GP_A) });
    expect(res.status).toBe(200);
    expect(res.body.state.gp_alerts_read_sync).toBeUndefined();
  });
});

describe('js/updates-sync.js — local-first client wiring (static)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'updates-sync.js'), 'utf8');

  it('talks to the read-state sync endpoint', () => {
    expect(src).toContain('/api/gp/alerts/read-state');
    expect(src).toMatch(/function\s+syncReadStateWithServer/);
    expect(src).toMatch(/function\s+pushReadIdsToServer/);
  });

  it('markRead stays LOCAL-FIRST: localStorage write happens before the best-effort server push', () => {
    const markReadBody = src.match(/function markRead\(alertId\) \{[\s\S]*?\n  \}/);
    expect(markReadBody).toBeTruthy();
    const body = markReadBody[0];
    const saveIdx = body.indexOf('saveReadState(readState)');
    const pushIdx = body.indexOf('pushReadIdsToServer([alertId])');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(saveIdx);
  });

  it('read-state still renders from localStorage (offline keeps working)', () => {
    expect(src).toMatch(/function parseReadState\(\) \{\s*\n\s*const raw = safeGetItem\(READ_KEY\)/);
    // The reconcile merge is union-only — server ids are added, never used to un-read.
    expect(src).toContain('if (local[id] !== true)');
    expect(src).not.toMatch(/delete\s+local\[/);
  });

  it('bell panel cap is raised from 3 with the rest behind "See all"', () => {
    expect(src).toMatch(/MAX_BELL_ITEMS = 1[0-5]\b/);
    expect(src).toContain('out.slice(0, MAX_BELL_ITEMS)');
    expect(src).not.toContain('out.slice(0, 3)');
    expect(src).toContain('class="see-all"');
  });
});
