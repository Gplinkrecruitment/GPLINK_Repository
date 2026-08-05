import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for the "recognise the GP before they type anything" layer added so
// a qualified Facebook lead can go straight from the instant form's thank-you
// screen to the calendar:
//   GET  /api/public/consult-lead/by-fb?fbl=  — identity from Meta's lead id
//   GET  /api/public/consult-lead/me          — identity from the signed cookie
//   POST /api/public/consult-lead             — sets that cookie; a recognised
//                                               re-submit PATCHES rather than
//                                               duplicating (changed email)
//   POST /api/public/consult-lead/match       — now reports `qualified` so an
//                                               unqualified lead is routed to
//                                               the turndown, not a form
// Same local JSON-db boot as tests/consult-lead-endpoints.test.js.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-recog-${RUN_ID}.json`;
const COOKIE = 'gpl_consult';
let server;
let addrPort;
let testUtils;

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const post = (p, b, c) => request('POST', p, b, c);
const get = (p, c) => request('GET', p, null, c);

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

// Pulls the gpl_consult cookie out of a Set-Cookie header, as a browser would.
function consultCookie(res) {
  const raw = res.headers['set-cookie'] || [];
  const hit = [].concat(raw).find((c) => c.startsWith(COOKIE + '='));
  return hit ? hit.split(';')[0] : null;
}

const goodLead = () => ({
  name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '+447700900123',
  isGp: true, country: 'uk', question: 'Visa timing?'
});

// A lead as the FB webhook would have stored it — the only shape that carries
// metadata.fb_lead_id, which is what /by-fb looks up.
function seedWebhookLead({ fbLeadId, qualified, email }) {
  const rows = readDb().siteEnquiries || [];
  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    kind: 'gp',
    name: 'Sarah Whitfield',
    email: email || 's.whitfield@nhs.net',
    phone: '+447700900312',
    state: qualified ? 'uk' : 'other',
    message: null,
    status: 'new',
    metadata: {
      source: 'meta_lead_ad',
      fb_lead_id: fbLeadId,
      consult: qualified
        ? { qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [], token: crypto.randomBytes(24).toString('base64url') }
        : { qualified: false, is_gp: true, country: 'other', call_booked: false, nudges: [], screened_out: true }
    }
  };
  testUtils.__seedSiteEnquiriesForTest([...rows, row]);
  return row;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-consult-recog-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiryRateLimitForTest();
  testUtils.__resetSiteEnquiriesForTest();
});

describe('consult identity cookie', () => {
  it('a form submission sets a signed, HttpOnly gpl_consult cookie', async () => {
    const res = await post('/api/public/consult-lead', goodLead());
    expect(res.status).toBe(200);
    const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith(COOKIE + '='));
    expect(raw).toBeTruthy();
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
  });

  it('GET /me recognises the browser with no URL parameter and no typing', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const me = await get('/api/public/consult-lead/me', consultCookie(created));
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      ok: true, found: true, qualified: true,
      displayName: 'Dr Khan', email: 'aisha@example.co.uk', booked: false
    });
    expect(typeof me.json.token).toBe('string');
  });

  it('GET /me without a cookie reports not-found rather than erroring', async () => {
    const me = await get('/api/public/consult-lead/me');
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ ok: true, found: false });
  });

  it('a tampered cookie signature is rejected', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const good = consultCookie(created);
    // Flip the last character of the HMAC — same row id, invalid signature.
    const tampered = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    const me = await get('/api/public/consult-lead/me', tampered);
    expect(me.json).toEqual({ ok: true, found: false });
  });

  it('a cookie naming a row that does not exist reports not-found', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const cookie = consultCookie(created);
    testUtils.__resetSiteEnquiriesForTest();
    const me = await get('/api/public/consult-lead/me', cookie);
    expect(me.json).toEqual({ ok: true, found: false });
  });
});

describe('GET /api/public/consult-lead/by-fb', () => {
  it('recognises a qualified webhook lead by Meta lead id and sets the cookie', async () => {
    const row = seedWebhookLead({ fbLeadId: '1234567890123456', qualified: true });
    const res = await get('/api/public/consult-lead/by-fb?fbl=1234567890123456');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true, found: true, qualified: true,
      displayName: 'Dr Whitfield', email: row.email
    });
    expect(res.json.token).toBe(row.metadata.consult.token);
    expect(consultCookie(res)).toBeTruthy();
  });

  it('recognises an UNQUALIFIED lead too — so the page can show the turndown', async () => {
    seedWebhookLead({ fbLeadId: '2222222222222222', qualified: false });
    const res = await get('/api/public/consult-lead/by-fb?fbl=2222222222222222');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, found: true, qualified: false });
    expect(res.json.token).toBe(null);
  });

  it('an unsubstituted {{lead_id}} macro is rejected, never treated as an id', async () => {
    seedWebhookLead({ fbLeadId: '3333333333333333', qualified: true });
    const res = await get('/api/public/consult-lead/by-fb?fbl=' + encodeURIComponent('{{lead_id}}'));
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ ok: false, found: false });
  });

  it('an unknown lead id is a clean 404', async () => {
    const res = await get('/api/public/consult-lead/by-fb?fbl=9999999999999999');
    expect(res.status).toBe(404);
  });

  it('stamps landed_at so we can tell the thank-you redirect is working', async () => {
    seedWebhookLead({ fbLeadId: '4444444444444444', qualified: true });
    await get('/api/public/consult-lead/by-fb?fbl=4444444444444444');
    const row = readDb().siteEnquiries.find((r) => r.metadata.fb_lead_id === '4444444444444444');
    expect(typeof row.metadata.consult.landed_at).toBe('string');
  });
});

describe('POST /api/public/consult-lead/match', () => {
  it('reports qualified:false for a screened-out lead instead of swallowing it', async () => {
    seedWebhookLead({ fbLeadId: '5555555555555555', qualified: false, email: 'nope@example.com' });
    const res = await post('/api/public/consult-lead/match', { email: 'nope@example.com' });
    expect(res.json).toMatchObject({ ok: true, found: true, qualified: false });
    expect(consultCookie(res)).toBeTruthy();
  });

  it('still returns the token for a qualified lead', async () => {
    const row = seedWebhookLead({ fbLeadId: '6666666666666666', qualified: true, email: 'yes@example.com' });
    const res = await post('/api/public/consult-lead/match', { email: 'yes@example.com' });
    expect(res.json.qualified).toBe(true);
    expect(res.json.token).toBe(row.metadata.consult.token);
  });
});

describe('recognised re-submission (the changed-email case)', () => {
  it('patches the existing row instead of creating a second lead', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const cookie = consultCookie(created);
    const res = await post('/api/public/consult-lead',
      { ...goodLead(), email: 'aisha.personal@gmail.com' }, cookie);
    expect(res.status).toBe(200);
    expect(res.json.recognised).toBe(true);
    const rows = readDb().siteEnquiries;
    expect(rows.length).toBe(1);
    expect(rows[0].email).toBe('aisha.personal@gmail.com');
    // Same row means the same token, so any magic link already emailed still works.
    expect(rows[0].metadata.consult.token).toBe(created.json.token);
  });

  it('promotes a screened-out lead to qualified when they correct their country', async () => {
    const created = await post('/api/public/consult-lead', { ...goodLead(), country: 'other' });
    expect(created.json.qualified).toBe(false);
    const cookie = consultCookie(created);
    const res = await post('/api/public/consult-lead', { ...goodLead(), country: 'ie' }, cookie);
    expect(res.json.qualified).toBe(true);
    expect(typeof res.json.token).toBe('string');
    const rows = readDb().siteEnquiries;
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.consult.screened_out).toBeUndefined();
  });

  it('will NOT rewrite a lead that has already booked — a shared device stays safe', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const cookie = consultCookie(created);
    await post('/api/public/consult-lead/booked', { token: created.json.token });
    const res = await post('/api/public/consult-lead',
      { ...goodLead(), name: 'Someone Else', email: 'someone.else@example.com' }, cookie);
    expect(res.json.recognised).toBeUndefined();
    const rows = readDb().siteEnquiries;
    expect(rows.length).toBe(2);
    expect(rows[0].email).toBe('aisha@example.co.uk');
  });
});
