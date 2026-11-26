// Read-only Xero connection (CEO Overview "Pipeline & money" board, 26 Nov 2026).
//   unit  — lib/xero.js with a mocked fetch + an in-memory store
//   route — /api/ceo/xero/* and /api/cron/xero-sync against the REAL server and
//           an in-memory PostgREST emulator (harness from tests/ceo-overview.test.js,
//           extended with on_conflict upserts). No real Xero, no real database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import xero from '../lib/xero.js';

const CFG = { clientId: 'cid', clientSecret: 'csecret', scopes: xero.DEFAULT_SCOPES, redirectUri: '', configured: true };
const NOW_MS = Date.parse('2026-11-26T10:00:00.000Z');

function jsonRes(status, body, headers) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });
}
function dotNet(iso) { return '/Date(' + Date.parse(iso) + '+0000)/'; }
function inv(i, over) {
  return Object.assign({
    InvoiceID: 'inv-' + i, InvoiceNumber: 'INV-' + String(i).padStart(4, '0'), Type: 'ACCREC', Status: 'AUTHORISED',
    Contact: { ContactID: 'c-1', Name: 'Sunshine Medical' }, Reference: '',
    Date: dotNet('2026-11-01T00:00:00Z'), DateString: '2026-11-01T00:00:00',
    DueDate: dotNet('2026-11-15T00:00:00Z'), DueDateString: '2026-11-15T00:00:00',
    LineItems: [{ Description: 'Placement fee - first instalment', Quantity: 1, UnitAmount: 5000, LineAmount: 5000 }],
    Total: 5500, AmountDue: 5500, AmountPaid: 0, AmountCredited: 0, CurrencyCode: 'AUD',
    UpdatedDateUTC: dotNet('2026-11-20T03:04:05Z')
  }, over || {});
}

function memStore(seed) {
  const s = {
    conn: seed && seed.conn ? Object.assign({}, seed.conn) : null,
    sync: seed && seed.sync ? JSON.parse(JSON.stringify(seed.sync)) : null,
    invoices: {},
    log: [],
    saveOk: true
  };
  s.getConnection = async () => (s.conn ? Object.assign({}, s.conn) : null);
  s.saveConnection = async (patch) => {
    s.log.push({ op: 'saveConnection', refresh_token: patch.refresh_token, access_token: patch.access_token });
    if (!s.saveOk) return false;
    s.conn = Object.assign({}, s.conn || {}, patch); return true;
  };
  s.upsertInvoices = async (rows) => { s.log.push({ op: 'upsert', n: rows.length }); rows.forEach((r) => { s.invoices[r.invoice_id] = Object.assign({}, s.invoices[r.invoice_id] || {}, r); }); };
  s.getSyncState = async () => s.sync;
  s.saveSyncState = async (patch) => { s.sync = Object.assign({}, s.sync || {}, patch); };
  s.loadLinkTargets = async () => (seed && seed.links) || { people: [], profiles: [] };
  return s;
}

const CONNECTED = { id: 'default', tenant_id: 't-1', tenant_name: 'GP LINK PTY LTD', access_token: 'at-old', refresh_token: 'rt-old', expires_at: new Date(NOW_MS + 20 * 60000).toISOString() };

// ── Unit ────────────────────────────────────────────────────────────────────
describe('lib/xero — config, auth URL, state', () => {
  it('default scopes are the granular read-only set, overridable by XERO_SCOPES', () => {
    expect(xero.xeroConfig({}).scopes).toBe('offline_access accounting.invoices.read accounting.payments.read accounting.contacts.read');
    expect(xero.xeroConfig({ XERO_SCOPES: '  offline_access   accounting.invoices.read ' }).scopes).toBe('offline_access accounting.invoices.read');
    expect(xero.xeroConfig({ XERO_CLIENT_ID: 'a' }).configured).toBe(false);
    expect(xero.xeroConfig({ XERO_CLIENT_ID: 'a', XERO_CLIENT_SECRET: 'b' }).configured).toBe(true);
  });

  it('builds the authorize URL', () => {
    const u = new URL(xero.buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://ceo.example/api/ceo/xero/callback', scopes: 'offline_access accounting.invoices.read', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('https://ceo.example/api/ceo/xero/callback');
    expect(u.searchParams.get('scope')).toBe('offline_access accounting.invoices.read');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('state: signs, verifies, binds to the nonce, expires after 10 min, rejects tampering', () => {
    const st = xero.signState({ email: 'CEO@x.com', nonce: 'n1', secret: 's', nowMs: NOW_MS });
    expect(xero.verifyState(st, { secret: 's', nonce: 'n1', nowMs: NOW_MS + 60000 })).toEqual({ ok: true, email: 'ceo@x.com', nonce: 'n1' });
    expect(xero.verifyState(st, { secret: 's', nonce: 'n2', nowMs: NOW_MS }).reason).toBe('nonce_mismatch');
    expect(xero.verifyState(st, { secret: 's', nonce: '', nowMs: NOW_MS }).reason).toBe('nonce_mismatch');
    expect(xero.verifyState(st, { secret: 's', nonce: 'n1', nowMs: NOW_MS + 10 * 60000 + 1 }).reason).toBe('expired');
    expect(xero.verifyState(st, { secret: 'other', nonce: 'n1', nowMs: NOW_MS }).reason).toBe('bad_signature');
    const [payload, sig] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ e: 'evil@x.com', n: 'n1', x: NOW_MS + 9e9 })).toString('base64url');
    expect(xero.verifyState(forged + '.' + sig, { secret: 's', nonce: 'n1', nowMs: NOW_MS }).reason).toBe('bad_signature');
    expect(xero.verifyState(payload, { secret: 's' }).reason).toBe('malformed');
    expect(xero.verifyState('', { secret: 's' }).ok).toBe(false);
  });
});

describe('lib/xero — code exchange + connection', () => {
  it('exchanges the code with Basic auth, lists orgs, picks GP LINK, saves one row', async () => {
    const calls = [];
    const fetch = async (u, o) => {
      calls.push({ u: String(u), o });
      if (String(u) === xero.XERO_TOKEN_URL) return jsonRes(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 1800, scope: 'offline_access accounting.invoices.read' });
      if (String(u) === xero.XERO_CONNECTIONS_URL) return jsonRes(200, [
        { tenantId: 't-other', tenantName: 'Demo Company (AU)', tenantType: 'ORGANISATION' },
        { tenantId: 't-gp', tenantName: 'GP LINK PTY LTD', tenantType: 'ORGANISATION' }
      ]);
      return jsonRes(404, {});
    };
    const store = memStore();
    const out = await xero.completeConnection({ fetch, config: CFG, store, code: 'the-code', redirectUri: 'http://localhost:3000/api/ceo/xero/callback', connectedBy: 'ceo@x.com', nowMs: NOW_MS });
    expect(out).toEqual({ tenant_id: 't-gp', tenant_name: 'GP LINK PTY LTD' });
    const tok = calls[0];
    expect(tok.o.method).toBe('POST');
    expect(tok.o.headers.Authorization).toBe('Basic ' + Buffer.from('cid:csecret').toString('base64'));
    const body = new URLSearchParams(tok.o.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('http://localhost:3000/api/ceo/xero/callback');
    expect(calls[1].o.headers.Authorization).toBe('Bearer at1');
    expect(store.conn).toMatchObject({ id: 'default', tenant_id: 't-gp', tenant_name: 'GP LINK PTY LTD', access_token: 'at1', refresh_token: 'rt1', connected_by: 'ceo@x.com', scopes: 'offline_access accounting.invoices.read' });
    expect(store.conn.expires_at).toBe(new Date(NOW_MS + 1800000).toISOString());
  });

  it('pickTenant falls back to the first org; none → null', () => {
    expect(xero.pickTenant([{ tenantId: 'a', tenantName: 'Acme' }, { tenantId: 'b', tenantName: 'Other' }])).toEqual({ tenant_id: 'a', tenant_name: 'Acme' });
    expect(xero.pickTenant([])).toBe(null);
  });

  it('a failed exchange throws without echoing the response body', async () => {
    const fetch = async () => jsonRes(400, { error: 'invalid_grant', refresh_token: 'should-not-leak' });
    await expect(xero.completeConnection({ fetch, config: CFG, store: memStore(), code: 'x', redirectUri: 'r' })).rejects.toThrow(/invalid_grant/);
    try { await xero.completeConnection({ fetch, config: CFG, store: memStore(), code: 'x', redirectUri: 'r' }); } catch (e) { expect(String(e.message)).not.toContain('should-not-leak'); }
  });
});

describe('lib/xero — token refresh (rotating refresh tokens)', () => {
  it('refreshes when <5 min left and persists the NEW refresh token BEFORE the API call uses the new access token', async () => {
    const order = [];
    const store = memStore({ conn: Object.assign({}, CONNECTED, { expires_at: new Date(NOW_MS + 4 * 60000).toISOString() }) });
    const origSave = store.saveConnection;
    store.saveConnection = async (p) => { order.push('save:' + p.refresh_token); return origSave(p); };
    const fetch = async (u, o) => {
      if (String(u) === xero.XERO_TOKEN_URL) {
        expect(new URLSearchParams(o.body).get('refresh_token')).toBe('rt-old');
        expect(new URLSearchParams(o.body).get('grant_type')).toBe('refresh_token');
        order.push('refresh');
        return jsonRes(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800 });
      }
      order.push('api:' + o.headers.Authorization);
      return jsonRes(200, { Invoices: [] });
    };
    const c = xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS, sleep: async () => {} });
    await c.apiGet('/Invoices', {});
    expect(order).toEqual(['refresh', 'save:rt-new', 'api:Bearer at-new']);
    expect(store.conn.refresh_token).toBe('rt-new');
  });

  it('does not refresh while the token has >5 min left', async () => {
    const store = memStore({ conn: CONNECTED });
    const seen = [];
    const fetch = async (u, o) => { seen.push(String(u)); return jsonRes(200, { Invoices: [] }); };
    await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).apiGet('/Invoices', {});
    expect(seen.some((u) => u === xero.XERO_TOKEN_URL)).toBe(false);
  });

  it('refuses to use a refreshed token it could not save', async () => {
    const store = memStore({ conn: Object.assign({}, CONNECTED, { expires_at: new Date(NOW_MS - 1000).toISOString() }) });
    store.saveOk = false;
    const apiCalls = [];
    const fetch = async (u) => {
      if (String(u) === xero.XERO_TOKEN_URL) return jsonRes(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800 });
      apiCalls.push(u); return jsonRes(200, { Invoices: [] });
    };
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).syncInvoices();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('token_save_failed');
    expect(apiCalls).toHaveLength(0);
    expect(store.sync.last_error).toMatch(/Could not save the refreshed Xero token/);
  });

  it('invalid_grant with no newer token on file → "reconnect" error', async () => {
    const store = memStore({ conn: Object.assign({}, CONNECTED, { expires_at: new Date(NOW_MS - 1000).toISOString() }) });
    const fetch = async () => jsonRes(400, { error: 'invalid_grant' });
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).syncInvoices();
    expect(r.code).toBe('reconnect_required');
    expect(store.sync.last_error).toMatch(/Reconnect Xero/);
  });
});

describe('lib/xero — sync', () => {
  it('pages ACCREC invoices (100 per page), maps and upserts them, records sync state', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => inv(i + 1));
    page1[0] = inv(1, {
      Status: 'PAID', AmountDue: 0, AmountPaid: 5500, FullyPaidOnDate: dotNet('2026-11-10T00:00:00Z'),
      LineItems: [{ Description: 'GP successfully sourced (50% Advance) \n\nDr Sana Ahsan', Quantity: 1, UnitAmount: 5000, LineAmount: 5000 }]
    });
    const page2 = [inv(101, { Reference: 'advance sourcing fee regarding Dr Krishnaveni Sivakumar', Status: 'VOIDED' })];
    const reqs = [];
    const fetch = async (u, o) => {
      const url = new URL(String(u));
      reqs.push({ url, headers: o.headers });
      const p = Number(url.searchParams.get('page'));
      return jsonRes(200, { Invoices: p === 1 ? page1 : (p === 2 ? page2 : []) });
    };
    const store = memStore({ conn: CONNECTED, links: {
      people: [{ id: 'pp-1', name: 'Dr. Sana  Ahsan', user_id: null }],
      profiles: [{ user_id: 'u-k', first_name: 'Krishnaveni', last_name: 'Sivakumar' }, { user_id: 'u-s', first_name: 'Sana', last_name: 'Ahsan' }]
    } });
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).syncInvoices();
    expect(r).toMatchObject({ ok: true, invoices_seen: 101, upserted: 101, pages: 2, incremental: false, tenant_name: 'GP LINK PTY LTD' });
    expect(reqs).toHaveLength(2);
    const q = reqs[0].url;
    expect(q.origin + q.pathname).toBe('https://api.xero.com/api.xro/2.0/Invoices');
    expect(q.searchParams.get('where')).toBe('Type=="ACCREC"');
    expect(q.searchParams.get('Statuses')).toBe('AUTHORISED,PAID,SUBMITTED,VOIDED,DELETED');
    expect(q.searchParams.get('pageSize')).toBe('100');
    expect(reqs[0].headers['xero-tenant-id']).toBe('t-1');
    expect(reqs[0].headers.Authorization).toBe('Bearer at-old');
    expect(reqs[0].headers['If-Modified-Since']).toBeUndefined(); // first full sync

    const paid = store.invoices['inv-1'];
    expect(paid).toMatchObject({
      invoice_number: 'INV-0001', type: 'ACCREC', status: 'PAID', contact_id: 'c-1', contact_name: 'Sunshine Medical',
      invoice_date: '2026-11-01', due_date: '2026-11-15', total: 5500, amount_due: 0, amount_paid: 5500, amount_credited: 0,
      currency: 'AUD', fully_paid_on: '2026-11-10', xero_updated_at: '2026-11-20T03:04:05.000Z',
      doctor_name: 'Sana Ahsan', pipeline_person_id: 'pp-1', user_id: 'u-s'
    });
    expect(paid.line_text).toContain('Dr Sana Ahsan');
    expect(paid.raw.InvoiceID).toBe('inv-1');
    const voided = store.invoices['inv-101'];
    expect(voided).toMatchObject({ status: 'VOIDED', doctor_name: 'Krishnaveni Sivakumar', user_id: 'u-k' });
    expect(voided.pipeline_person_id).toBeUndefined();
    expect(store.invoices['inv-2'].doctor_name).toBe(null);

    expect(store.sync.last_error).toBe(null);
    expect(store.sync.last_ok_at).toBe(new Date(NOW_MS).toISOString());
    expect(store.sync.detail).toMatchObject({ invoices_seen: 101, upserted: 101, tenant_name: 'GP LINK PTY LTD', full_sync_at: new Date(NOW_MS).toISOString() });
  });

  it('after the first full sync, sends If-Modified-Since = last ok sync minus 1 day; 304 is fine', async () => {
    const lastOk = '2026-11-26T09:07:00.000Z';
    const store = memStore({ conn: CONNECTED, sync: { source: 'xero', last_ok_at: lastOk, detail: { full_sync_at: '2026-11-25T00:00:00.000Z' } } });
    let hdr = null;
    const fetch = async (u, o) => { hdr = o.headers['If-Modified-Since']; return new Response(null, { status: 304 }); };
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).syncInvoices();
    expect(r.ok).toBe(true);
    expect(r.incremental).toBe(true);
    expect(hdr).toBe(new Date(Date.parse(lastOk) - 86400000).toUTCString());
    expect(store.sync.detail.full_sync_at).toBe('2026-11-25T00:00:00.000Z');
  });

  it('honours 429 Retry-After and retries', async () => {
    const waits = [];
    let n = 0;
    const fetch = async () => { n++; return n === 1 ? jsonRes(429, {}, { 'Retry-After': '7' }) : jsonRes(200, { Invoices: [inv(1)] }); };
    const store = memStore({ conn: CONNECTED });
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS, sleep: async (ms) => { waits.push(ms); } }).syncInvoices();
    expect(r.ok).toBe(true);
    expect(waits).toEqual([7000]);
    expect(n).toBe(2);
  });

  it('gives up after repeated 429s and records the error', async () => {
    const fetch = async () => jsonRes(429, {}, { 'Retry-After': '1' });
    const store = memStore({ conn: CONNECTED });
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS, sleep: async () => {} }).syncInvoices();
    expect(r.ok).toBe(false);
    expect(store.sync.last_error).toMatch(/http 429/);
  });

  it('401 insufficent_scope (Xero spelling) → a clear error in pipeline_sync_state', async () => {
    const fetch = async () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="insufficent_scope"' } });
    const store = memStore({ conn: CONNECTED });
    const r = await xero.createXeroClient({ fetch, store, config: CFG, now: () => NOW_MS }).syncInvoices();
    expect(r.code).toBe('insufficient_scope');
    expect(store.sync.last_error).toBe(xero.INSUFFICIENT_SCOPE_MESSAGE);
    expect(store.sync.last_error).toMatch(/XERO_SCOPES/);
    expect(store.sync.last_ok_at).toBeUndefined();
  });

  it('not connected → recorded, no network', async () => {
    let called = false;
    const store = memStore();
    const r = await xero.createXeroClient({ fetch: async () => { called = true; }, store, config: CFG }).syncInvoices();
    expect(r.code).toBe('not_connected');
    expect(called).toBe(false);
    expect(store.sync.last_error).toMatch(/not connected/);
  });
});

describe('lib/xero — parsing and doctor names', () => {
  it('parses /Date()/ and ISO', () => {
    expect(xero.parseXeroDate('/Date(1234567890000+0000)/')).toBe('2009-02-13T23:31:30.000Z');
    expect(xero.parseXeroDate('/Date(1234567890000)/')).toBe('2009-02-13T23:31:30.000Z');
    expect(xero.parseXeroDate('2026-11-01T00:00:00')).toBe('2026-11-01T00:00:00.000Z');
    expect(xero.parseXeroDate('junk')).toBe(null);
    expect(xero.parseXeroDate(null)).toBe(null);
    expect(xero.parseXeroDay('2026-11-15T00:00:00', null)).toBe('2026-11-15');
    expect(xero.parseXeroDay(null, '/Date(1763164800000+0000)/')).toBe('2025-11-15');
  });

  it('extracts the doctor from the real invoice wordings', () => {
    expect(xero.extractDoctorName('GP successfully sourced (50% Advance) \n\nDr Sana Ahsan')).toBe('Sana Ahsan');
    expect(xero.extractDoctorName('Placement fee - first instalment')).toBe(null);
    expect(xero.extractDoctorName('advance sourcing fee regarding Dr Krishnaveni Sivakumar')).toBe('Krishnaveni Sivakumar');
    expect(xero.extractDoctorName('Dr. John Smith Placement fee')).toBe('John Smith');
    expect(xero.extractDoctorName('Dr Sana Ahsan\nPlacement fee')).toBe('Sana Ahsan');
    expect(xero.extractDoctorName('')).toBe(null);
  });

  it('matches names only when exactly one candidate fits', () => {
    const profiles = [{ user_id: 'u1', first_name: 'Sana', last_name: 'Ahsan' }, { user_id: 'u2', first_name: 'John', last_name: 'Smith' }, { user_id: 'u3', first_name: 'John', last_name: 'Smith' }];
    expect(xero.matchDoctor('Sana Ahsan', [], profiles).user_id).toBe('u1');
    expect(xero.matchDoctor('SANA AHSAN', [], profiles).user_id).toBe('u1');
    expect(xero.matchDoctor('John Smith', [], profiles).user_id).toBe(null);
    expect(xero.matchDoctor('Sana Fatima Ahsan', [], profiles).user_id).toBe('u1');
    expect(xero.matchDoctor('Sana Ahsan', [{ id: 'p1', name: 'Sana Ahsan', user_id: 'u9' }], profiles)).toEqual({ pipeline_person_id: 'p1', user_id: 'u9' });
    expect(xero.matchDoctor('Sana Ahsan', [{ id: 'p1', name: 'Sana Ahsan', archived_at: '2026-01-01' }], []).pipeline_person_id).toBe(null);
  });

  it('caps line_text at 2000 chars', () => {
    const row = xero.mapInvoice(inv(1, { LineItems: [{ Description: 'x'.repeat(3000) }] }), null);
    expect(row.line_text.length).toBe(2000);
  });
});

// ── Route: real server + PostgREST emulator ─────────────────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-xero-${RUN_ID}.json`;
const SUPER_HOST = 'ceo-test.local';
const ROOT = path.resolve(__dirname, '..');
let server, port, sbServer, sbPort, realFetch;
const db = {
  user_profiles: [{ user_id: 'u-sana', first_name: 'Sana', last_name: 'Ahsan', email: 'sana@example.com' }],
  pipeline_people: [],
  xero_connection: [],
  xero_invoices: [],
  pipeline_sync_state: [],
  runtime_kv: []
};
const xeroCalls = [];
let xeroInvoices = [];
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
function buildMatcher(sp) {
  const filters = [];
  for (const [key, raw] of sp.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    const dot = raw.indexOf('.');
    if (dot > 0 && raw.slice(0, dot) === 'eq') filters.push({ col: key, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, val }) => String(row[col]) === val);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(payload === undefined ? '' : JSON.stringify(payload)); };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(200, {}); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflict = u.searchParams.get('on_conflict');
        const merge = /merge-duplicates/.test(String(req.headers.prefer || ''));
        incoming.forEach((r) => {
          const existing = conflict ? rows.find((x) => String(x[conflict]) === String(r[conflict])) : null;
          if (existing && merge) Object.assign(existing, r); else rows.push(Object.assign({}, r));
        });
        send(201, []); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        rows.filter(matches).forEach((row) => Object.assign(row, patch || {}));
        send(200, []); return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, extra || {});
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}
const ceo = (method, p) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie() });
const cron = (bearer) => httpReq('GET', '/api/cron/xero-sync', { host: SUPER_HOST, headers: bearer ? { Authorization: 'Bearer ' + bearer } : {} });

async function startConnect() {
  const r = await ceo('GET', '/api/ceo/xero/connect');
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.location);
  const setCookie = [].concat(r.headers['set-cookie'] || []).join('\n');
  const nonce = (setCookie.match(/gp_xero_oauth=([^;]+)/) || [])[1];
  return { loc, setCookie, nonce, state: loc.searchParams.get('state') };
}

beforeAll(async () => {
  await startSupabaseEmulator();
  Object.assign(process.env, {
    AGENT_SKIP_DOTENV: 'true', NODE_ENV: 'test', AUTH_DISABLED: 'false', AUTH_SECRET: 'xero-test-' + RUN_ID,
    REQUIRE_SUPABASE_DB: 'false', SUPABASE_URL: `http://127.0.0.1:${sbPort}`, SUPABASE_PUBLISHABLE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key', ENFORCE_SAME_ORIGIN: 'false', DB_FILE_PATH: DB_FILE,
    SUPER_ADMIN_ALLOWED_HOSTS: SUPER_HOST, SUPER_ADMIN_EMAILS: 'super@gplink-test.local', ADMIN_EMAILS: '',
    CRON_SECRET: 'cron-xero-' + RUN_ID, XERO_CLIENT_ID: 'test-client', XERO_CLIENT_SECRET: 'test-secret'
  });
  delete process.env.XERO_REDIRECT_URI;
  delete process.env.XERO_SCOPES;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u === xero.XERO_TOKEN_URL) {
      xeroCalls.push({ kind: 'token', body: String(opts.body) });
      return jsonRes(200, { access_token: 'route-at', refresh_token: 'route-rt', expires_in: 1800, scope: 'offline_access accounting.invoices.read' });
    }
    if (u === xero.XERO_CONNECTIONS_URL) return jsonRes(200, [{ tenantId: 'tenant-gp', tenantName: 'GP LINK PTY LTD', tenantType: 'ORGANISATION' }]);
    if (u.startsWith(xero.XERO_API_BASE + '/Invoices')) {
      xeroCalls.push({ kind: 'invoices', url: u, tenant: opts.headers['xero-tenant-id'] });
      return jsonRes(200, { Invoices: new URL(u).searchParams.get('page') === '1' ? xeroInvoices : [] });
    }
    return jsonRes(200, {});
  };
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('Xero routes', () => {
  it('connect/status/sync are CEO-only', async () => {
    for (const [m, p] of [['GET', '/api/ceo/xero/connect'], ['GET', '/api/ceo/xero/status'], ['POST', '/api/ceo/xero/sync']]) {
      const r = await httpReq(m, p, { host: SUPER_HOST });
      expect([401, 403]).toContain(r.status);
    }
  });

  it('cron: 401 without the secret; skipped when not connected', async () => {
    expect((await cron()).status).toBe(401);
    expect((await cron('wrong')).status).toBe(401);
    const r = await cron(process.env.CRON_SECRET);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, skipped: 'not_connected' });
  });

  it('connect without XERO_CLIENT_ID/SECRET → 503 with a clear message', async () => {
    const saved = process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_CLIENT_SECRET;
    try {
      const r = await ceo('GET', '/api/ceo/xero/connect');
      expect(r.status).toBe(503);
      expect(r.body.message).toMatch(/XERO_CLIENT_ID and XERO_CLIENT_SECRET/);
    } finally { process.env.XERO_CLIENT_SECRET = saved; }
  });

  it('connect → 302 to Xero with client_id, redirect_uri from the request origin, scopes, signed state + Lax nonce cookie', async () => {
    const { loc, setCookie, nonce, state } = await startConnect();
    expect(loc.origin + loc.pathname).toBe('https://login.xero.com/identity/connect/authorize');
    expect(loc.searchParams.get('client_id')).toBe('test-client');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://' + SUPER_HOST + '/api/ceo/xero/callback');
    expect(loc.searchParams.get('scope')).toBe(xero.DEFAULT_SCOPES);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(xero.verifyState(state, { secret: process.env.AUTH_SECRET, nonce }).email).toBe('super@gplink-test.local');
  });

  it('XERO_REDIRECT_URI overrides the request origin', async () => {
    process.env.XERO_REDIRECT_URI = 'https://ceo.admin.mygplink.com.au/api/ceo/xero/callback';
    try {
      const { loc } = await startConnect();
      expect(loc.searchParams.get('redirect_uri')).toBe('https://ceo.admin.mygplink.com.au/api/ceo/xero/callback');
    } finally { delete process.env.XERO_REDIRECT_URI; }
  });

  it('callback rejects a tampered state or a missing nonce cookie', async () => {
    const { nonce, state } = await startConnect();
    const tampered = state.slice(0, -2) + (state.endsWith('a') ? 'bb' : 'aa');
    const r1 = await httpReq('GET', '/api/ceo/xero/callback?code=c&state=' + encodeURIComponent(tampered), { host: SUPER_HOST, cookie: 'gp_xero_oauth=' + nonce });
    expect(r1.status).toBe(200);
    expect(r1.raw).toContain('/pages/ceo-dashboard?xero=error&amp;reason=bad_state');
    const r2 = await httpReq('GET', '/api/ceo/xero/callback?code=c&state=' + encodeURIComponent(state), { host: SUPER_HOST });
    expect(r2.raw).toContain('reason=bad_state');
    const r3 = await httpReq('GET', '/api/ceo/xero/callback?error=access_denied&state=x', { host: SUPER_HOST });
    expect(r3.raw).toContain('reason=denied');
    expect(db.xero_connection).toHaveLength(0);
    expect(xeroCalls.filter((c) => c.kind === 'token')).toHaveLength(0);
  });

  it('callback on a non-CEO host is 404', async () => {
    const r = await httpReq('GET', '/api/ceo/xero/callback?code=c&state=x', { host: 'app.example.com' });
    expect(r.status).toBe(404);
  });

  it('callback (no admin cookie — SameSite=Strict) saves the connection, syncs once, bounces to the dashboard', async () => {
    xeroInvoices = [inv(1, { LineItems: [{ Description: 'GP successfully sourced (50% Advance) \n\nDr Sana Ahsan' }] }), inv(2, { Status: 'PAID', AmountDue: 0 })];
    const { nonce, state } = await startConnect();
    const r = await httpReq('GET', '/api/ceo/xero/callback?code=good-code&state=' + encodeURIComponent(state), { host: SUPER_HOST, cookie: 'gp_xero_oauth=' + nonce });
    expect(r.status).toBe(200);
    expect(r.raw).toContain('url=/pages/ceo-dashboard?xero=connected');
    expect([].concat(r.headers['set-cookie']).join('')).toMatch(/gp_xero_oauth=;.*Max-Age=0/);
    const tokenCall = xeroCalls.find((c) => c.kind === 'token');
    const body = new URLSearchParams(tokenCall.body);
    expect(body.get('code')).toBe('good-code');
    expect(body.get('redirect_uri')).toBe('http://' + SUPER_HOST + '/api/ceo/xero/callback');
    expect(db.xero_connection).toHaveLength(1);
    expect(db.xero_connection[0]).toMatchObject({ id: 'default', tenant_id: 'tenant-gp', tenant_name: 'GP LINK PTY LTD', refresh_token: 'route-rt', connected_by: 'super@gplink-test.local' });
    expect(xeroCalls.find((c) => c.kind === 'invoices').tenant).toBe('tenant-gp');
    expect(db.xero_invoices.map((x) => x.invoice_id).sort()).toEqual(['inv-1', 'inv-2']);
    expect(db.xero_invoices.find((x) => x.invoice_id === 'inv-1')).toMatchObject({ doctor_name: 'Sana Ahsan', user_id: 'u-sana', status: 'AUTHORISED' });
    expect(db.pipeline_sync_state[0]).toMatchObject({ source: 'xero', last_error: null });
  });

  it('status never returns tokens', async () => {
    const r = await ceo('GET', '/api/ceo/xero/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, configured: true, connected: true, tenant_name: 'GP LINK PTY LTD', last_error: null });
    expect(r.body.last_ok_at).toBeTruthy();
    expect(r.raw).not.toContain('route-rt');
    expect(r.raw).not.toContain('route-at');
  });

  it('sync now and the cron both run an incremental sync and update rows in place', async () => {
    xeroInvoices = [inv(1, { Status: 'PAID', AmountDue: 0, AmountPaid: 5500 })];
    const before = xeroCalls.length;
    const r = await ceo('POST', '/api/ceo/xero/sync');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, upserted: 1, incremental: true });
    expect(db.xero_invoices).toHaveLength(2);
    const row = db.xero_invoices.find((x) => x.invoice_id === 'inv-1');
    expect(row).toMatchObject({ status: 'PAID', amount_due: 0 });
    // the earlier doctor link is kept even though this payload had no doctor in it
    expect(row.user_id).toBe('u-sana');
    const c = await cron(process.env.CRON_SECRET);
    expect(c.status).toBe(200);
    expect(c.body.ok).toBe(true);
    expect(xeroCalls.length).toBeGreaterThan(before);
  });

  it("a sync never sends or overwrites the owner's override (owner_status / owner_note)", async () => {
    const row = db.xero_invoices.find((x) => x.invoice_id === 'inv-1');
    Object.assign(row, { owner_status: 'paid_outside_xero', owner_note: 'Bank: $5,500 received', owner_set_at: '2026-11-26T01:00:00.000Z', owner_set_by: 'ceo' });
    xeroInvoices = [inv(1, { Status: 'AUTHORISED', AmountDue: 5500, AmountPaid: 0 })];
    const r = await ceo('POST', '/api/ceo/xero/sync');
    expect(r.status).toBe(200);
    expect(r.body.upserted).toBe(1);
    const after = db.xero_invoices.find((x) => x.invoice_id === 'inv-1');
    expect(after).toMatchObject({ status: 'AUTHORISED', amount_due: 5500, owner_status: 'paid_outside_xero', owner_note: 'Bank: $5,500 received', owner_set_at: '2026-11-26T01:00:00.000Z', owner_set_by: 'ceo' });
    // and the mapped row never carries those columns at all
    const mapped = xero.mapInvoice(inv(1), { people: [], profiles: [] });
    expect(Object.keys(mapped).filter((k) => /^owner_/.test(k))).toEqual([]);
  });

  it('vercel.json runs the cron hourly at :07', () => {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    expect(v.crons.find((c) => c.path === '/api/cron/xero-sync')).toEqual({ path: '/api/cron/xero-sync', schedule: '7 * * * *' });
  });
});
