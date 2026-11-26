'use strict';

// Read-only Xero connection for the CEO Overview "Pipeline & money" board
// (26 Nov 2026). Mirrors Xero SALES invoices (Type ACCREC) into xero_invoices
// every hour so the board can show what is still unpaid.
//
// Everything that touches the network takes an injected `fetch`, and the
// database is reached only through an injected `store` (server.js builds it
// over supabaseDbRequest), so the whole flow is unit-testable offline.
//
// ─── SCOPE ASSUMPTION (read this before changing scopes) ────────────────────
// The GP Link Xero app was created in Nov 2026, i.e. AFTER 2 March 2026, so
// Xero only accepts its GRANULAR scopes: the old broad `accounting.transactions`
// is split into accounting.invoices / accounting.payments /
// accounting.banktransactions / accounting.manualjournals (each with a `.read`
// variant); contacts and settings are unchanged. `accounting.invoices.read` and
// `accounting.payments.read` appear verbatim in Xero's own MCP-server README;
// `accounting.contacts.read` is the long-standing read-only contacts scope. We
// could NOT open Xero's scopes page itself (it is rendered client-side), so the
// default below is an assumption — override it with env XERO_SCOPES (space
// separated) without a code change. If Xero refuses a scope at the API, it
// answers 401 with `WWW-Authenticate: ... insufficent_scope` (Xero's spelling)
// and the sync records a plain-English error in pipeline_sync_state('xero').
// ────────────────────────────────────────────────────────────────────────────
//
// Tokens: the access token lives ~30 minutes; the refresh token ROTATES — every
// refresh returns a new one and the old one stops working. So the new pair is
// saved to xero_connection BEFORE the new access token is used for anything,
// and a save failure stops the run (using a token we could not persist would
// lose the connection on the next run). Tokens are never logged or returned.

var crypto = require('crypto');

var XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
var XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
var XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
var XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
var DEFAULT_SCOPES = 'offline_access accounting.invoices.read accounting.payments.read accounting.contacts.read';

var STATE_TTL_MS = 10 * 60 * 1000;
var REFRESH_MARGIN_MS = 5 * 60 * 1000;
var PAGE_SIZE = 100;
var MAX_PAGES = 200; // 20k invoices — a runaway guard, not a real limit
var MAX_429_RETRIES = 3;
var MAX_RETRY_AFTER_S = 60;
var LINE_TEXT_MAX = 2000;
var SYNC_STATUSES = ['AUTHORISED', 'PAID', 'SUBMITTED', 'VOIDED', 'DELETED'];
var CONNECTION_ID = 'default';
var SYNC_SOURCE = 'xero';
var DAY_MS = 86400000;

var INSUFFICIENT_SCOPE_MESSAGE = 'Xero refused the request: the connection is missing a permission (insufficient scope). '
  + 'Check XERO_SCOPES matches the scopes enabled on the Xero app, then reconnect Xero from the CEO dashboard.';

function xeroConfig(env) {
  var e = env || {};
  var clientId = String(e.XERO_CLIENT_ID || '').trim();
  var clientSecret = String(e.XERO_CLIENT_SECRET || '').trim();
  var scopes = String(e.XERO_SCOPES || '').trim().split(/\s+/).filter(Boolean).join(' ') || DEFAULT_SCOPES;
  return {
    clientId: clientId,
    clientSecret: clientSecret,
    redirectUri: String(e.XERO_REDIRECT_URI || '').trim(),
    scopes: scopes,
    configured: !!(clientId && clientSecret)
  };
}

// ── OAuth `state`: HMAC-signed, 10-minute expiry, bound to the CEO user and
// to a per-browser nonce (the caller sets it as a cookie). ───────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(s) {
  var str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function stateSig(payload, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update('xero-oauth-state.' + payload).digest('hex');
}

function signState(opts) {
  var o = opts || {};
  if (!o.secret) throw new Error('signState needs a secret');
  var nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  var payload = b64url(JSON.stringify({
    e: String(o.email || '').trim().toLowerCase(),
    n: String(o.nonce || ''),
    x: nowMs + (Number.isFinite(o.ttlMs) ? o.ttlMs : STATE_TTL_MS)
  }));
  return payload + '.' + stateSig(payload, o.secret);
}

// → { ok:true, email, nonce } | { ok:false, reason:'malformed'|'bad_signature'|'expired'|'nonce_mismatch' }
function verifyState(token, opts) {
  var o = opts || {};
  var raw = String(token || '');
  var dot = raw.lastIndexOf('.');
  if (dot <= 0 || !o.secret) return { ok: false, reason: 'malformed' };
  var payload = raw.slice(0, dot);
  var sig = raw.slice(dot + 1);
  var expected = stateSig(payload, o.secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  var claims;
  try { claims = JSON.parse(b64urlDecode(payload)); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!claims || typeof claims !== 'object' || typeof claims.x !== 'number' || !claims.e) return { ok: false, reason: 'malformed' };
  var nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  if (claims.x <= nowMs) return { ok: false, reason: 'expired' };
  if (o.nonce !== undefined) {
    var want = String(claims.n || '');
    var got = String(o.nonce || '');
    if (!want || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want, 'utf8'), Buffer.from(got, 'utf8'))) {
      return { ok: false, reason: 'nonce_mismatch' };
    }
  }
  return { ok: true, email: claims.e, nonce: claims.n };
}

function buildAuthorizeUrl(opts) {
  var o = opts || {};
  var u = new URL(XERO_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('scope', o.scopes || DEFAULT_SCOPES);
  u.searchParams.set('state', o.state);
  return u.toString();
}

// ── Token endpoint ──────────────────────────────────────────────────────────
function XeroError(message, code, extra) {
  var err = new Error(message);
  err.code = code || 'xero_error';
  if (extra) Object.keys(extra).forEach(function (k) { err[k] = extra[k]; });
  return err;
}

async function readJson(res) {
  var text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 300) }; }
}

async function tokenRequest(fetchImpl, cfg, params) {
  var body = new URLSearchParams(params).toString();
  var res = await fetchImpl(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret, 'utf8').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body
  });
  var data = await readJson(res);
  if (!res.ok || !data || !data.access_token) {
    // Only the OAuth error code leaves here — never the body (it may echo a token).
    var code = data && data.error ? String(data.error).slice(0, 60) : ('http_' + res.status);
    throw XeroError('Xero token request failed (' + code + ').', code === 'invalid_grant' ? 'invalid_grant' : 'token_failed', { status: res.status });
  }
  return data;
}

function exchangeCode(opts) {
  return tokenRequest(opts.fetch, opts.config, {
    grant_type: 'authorization_code',
    code: String(opts.code || ''),
    redirect_uri: opts.redirectUri
  });
}

function refreshTokens(opts) {
  return tokenRequest(opts.fetch, opts.config, {
    grant_type: 'refresh_token',
    refresh_token: String(opts.refreshToken || '')
  });
}

// Token response → the xero_connection columns it fills.
function tokenRowFromResponse(tok, nowMs) {
  var t = Number.isFinite(nowMs) ? nowMs : Date.now();
  var secs = Number(tok && tok.expires_in);
  if (!Number.isFinite(secs) || secs <= 0) secs = 1800;
  var row = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(t + secs * 1000).toISOString()
  };
  if (tok.scope) row.scopes = String(tok.scope);
  return row;
}

async function fetchConnections(opts) {
  var res = await opts.fetch(XERO_CONNECTIONS_URL, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + opts.accessToken, Accept: 'application/json' }
  });
  var data = await readJson(res);
  if (!res.ok || !Array.isArray(data)) throw XeroError('Could not list Xero organisations (http ' + res.status + ').', 'connections_failed', { status: res.status });
  return data;
}

// Several orgs → the one whose name contains "GP LINK"; else the first.
function pickTenant(connections) {
  var orgs = (Array.isArray(connections) ? connections : []).filter(function (c) {
    return c && c.tenantId && (!c.tenantType || String(c.tenantType).toUpperCase() === 'ORGANISATION');
  });
  if (!orgs.length) return null;
  var gp = orgs.find(function (c) { return /gp\s*link/i.test(String(c.tenantName || '')); });
  var pick = gp || orgs[0];
  return { tenant_id: String(pick.tenantId), tenant_name: String(pick.tenantName || '') };
}

// ── Xero dates: "/Date(1234567890000+0000)/" (ms since epoch, UTC) or ISO ───
function parseXeroDate(v) {
  if (v == null || v === '') return null;
  var s = String(v).trim();
  var m = s.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/);
  var t = m ? Number(m[1]) : Date.parse(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? s + 'Z' : s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}
function parseXeroDay(dateString, dotNetDate) {
  var ds = String(dateString || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(ds)) return ds.slice(0, 10);
  var iso = parseXeroDate(dotNetDate);
  return iso ? iso.slice(0, 10) : null;
}

// ── Doctor name from the invoice wording ────────────────────────────────────
// "GP successfully sourced (50% Advance) \n\nDr Sana Ahsan" → "Sana Ahsan"
// "advance sourcing fee regarding Dr Krishnaveni Sivakumar" → "Krishnaveni Sivakumar"
// "Placement fee - first instalment" → null
var NAME_STOP = new Set(['fee', 'fees', 'advance', 'placement', 'invoice', 'regarding', 're', 'sourcing', 'sourced',
  'gp', 'first', 'second', 'final', 'instalment', 'installment', 'balance', 'deposit', 'for', 'and', 'the', 'at', 'from', 'to']);
function extractDoctorName(text) {
  var s = String(text || '');
  var re = /\bDr\.?[ \t]+([A-Z][A-Za-zÀ-ɏ'’-]+(?:[ \t]+[A-Z][A-Za-zÀ-ɏ'’-]+){0,3})/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    var parts = m[1].split(/[ \t]+/);
    while (parts.length && NAME_STOP.has(parts[parts.length - 1].toLowerCase())) parts.pop();
    if (parts.length >= 1 && !NAME_STOP.has(parts[0].toLowerCase())) return parts.join(' ');
  }
  return null;
}

function normaliseName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/['-]/g, '')
    .split(/\s+/).filter(function (w) { return w && w !== 'dr'; })
    .join(' ');
}

// Link a doctor name to a pipeline_people row and/or a user_profiles row.
// Exact normalised full name first; then first+last word. A link is made only
// when exactly ONE candidate matches, so a common name never links wrongly.
function matchDoctor(name, people, profiles) {
  var out = { pipeline_person_id: null, user_id: null };
  var target = normaliseName(name);
  if (!target) return out;
  var tw = target.split(' ');
  var firstLast = tw.length >= 2 ? tw[0] + ' ' + tw[tw.length - 1] : null;
  function pick(rows, nameOf) {
    var exact = [], loose = [];
    (rows || []).forEach(function (r) {
      var n = normaliseName(nameOf(r));
      if (!n) return;
      if (n === target) { exact.push(r); return; }
      var w = n.split(' ');
      if (firstLast && w.length >= 2 && (w[0] + ' ' + w[w.length - 1]) === firstLast) loose.push(r);
    });
    if (exact.length === 1) return exact[0];
    if (!exact.length && loose.length === 1) return loose[0];
    return null;
  }
  var person = pick((people || []).filter(function (p) { return p && !p.archived_at; }), function (p) { return p.name; });
  if (person) {
    out.pipeline_person_id = person.id || null;
    if (person.user_id) out.user_id = person.user_id;
  }
  if (!out.user_id) {
    var prof = pick(profiles, function (p) { return [p.first_name, p.last_name].filter(Boolean).join(' '); });
    if (prof) out.user_id = prof.user_id || null;
  }
  return out;
}

// ── Invoice → xero_invoices row ─────────────────────────────────────────────
function num(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function lineTextOf(inv) {
  var t = (Array.isArray(inv.LineItems) ? inv.LineItems : [])
    .map(function (li) { return String((li && li.Description) || '').trim(); })
    .filter(Boolean).join('\n');
  return t.length > LINE_TEXT_MAX ? t.slice(0, LINE_TEXT_MAX) : t;
}
function trimRaw(inv) {
  return {
    InvoiceID: inv.InvoiceID, InvoiceNumber: inv.InvoiceNumber, Type: inv.Type, Status: inv.Status,
    Reference: inv.Reference || null,
    Contact: inv.Contact ? { ContactID: inv.Contact.ContactID, Name: inv.Contact.Name } : null,
    DateString: inv.DateString || null, DueDateString: inv.DueDateString || null,
    FullyPaidOnDate: inv.FullyPaidOnDate || null, UpdatedDateUTC: inv.UpdatedDateUTC || null,
    SubTotal: num(inv.SubTotal), TotalTax: num(inv.TotalTax), Total: num(inv.Total),
    AmountDue: num(inv.AmountDue), AmountPaid: num(inv.AmountPaid), AmountCredited: num(inv.AmountCredited),
    CurrencyCode: inv.CurrencyCode || null, SentToContact: inv.SentToContact === true,
    LineItems: (Array.isArray(inv.LineItems) ? inv.LineItems : []).slice(0, 20).map(function (li) {
      return { Description: String((li && li.Description) || '').slice(0, 500), Quantity: num(li && li.Quantity), UnitAmount: num(li && li.UnitAmount), LineAmount: num(li && li.LineAmount) };
    }),
    Payments: (Array.isArray(inv.Payments) ? inv.Payments : []).slice(0, 20).map(function (p) {
      return { PaymentID: p && p.PaymentID, Date: p && p.Date, Amount: num(p && p.Amount) };
    })
  };
}

function mapInvoice(inv, links) {
  var lineText = lineTextOf(inv);
  var doctor = extractDoctorName(lineText) || extractDoctorName(inv.Reference);
  var row = {
    invoice_id: String(inv.InvoiceID),
    invoice_number: inv.InvoiceNumber || null,
    type: inv.Type || null,
    status: inv.Status || null,
    contact_id: (inv.Contact && inv.Contact.ContactID) || null,
    contact_name: (inv.Contact && inv.Contact.Name) || null,
    reference: inv.Reference || null,
    line_text: lineText || null,
    invoice_date: parseXeroDay(inv.DateString, inv.Date),
    due_date: parseXeroDay(inv.DueDateString, inv.DueDate),
    total: num(inv.Total),
    amount_due: num(inv.AmountDue),
    amount_paid: num(inv.AmountPaid),
    amount_credited: num(inv.AmountCredited),
    currency: inv.CurrencyCode || null,
    fully_paid_on: parseXeroDay(null, inv.FullyPaidOnDate),
    doctor_name: doctor,
    xero_updated_at: parseXeroDate(inv.UpdatedDateUTC),
    raw: trimRaw(inv)
  };
  if (doctor && links) {
    var m = matchDoctor(doctor, links.people, links.profiles);
    // Link columns are only SENT when a match exists, so an upsert never
    // wipes a link someone made by hand (see the store's split upsert).
    if (m.pipeline_person_id) row.pipeline_person_id = m.pipeline_person_id;
    if (m.user_id) row.user_id = m.user_id;
  }
  return row;
}

function isInsufficientScope(res) {
  var h = '';
  try { h = String((res.headers && res.headers.get && res.headers.get('www-authenticate')) || ''); } catch (e) { h = ''; }
  return /insuff?icc?ient_scope|insufficent_scope/i.test(h);
}

// ── The client: token upkeep + paged, rate-limited GETs + the sync ──────────
// store = {
//   getConnection()        → xero_connection row | null
//   saveConnection(patch)  → must resolve truthy only when persisted (row id 'default')
//   upsertInvoices(rows)   → resolve on success, throw on failure
//   getSyncState()         → pipeline_sync_state('xero') row | null
//   saveSyncState(patch)   → upsert pipeline_sync_state('xero')
//   loadLinkTargets()      → { people:[{id,name,user_id,archived_at}], profiles:[{user_id,first_name,last_name}] }
// }
function createXeroClient(opts) {
  var o = opts || {};
  var fetchImpl = o.fetch;
  var store = o.store;
  var cfg = o.config;
  var nowFn = o.now || Date.now;
  var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var conn = null;

  async function loadConnection() {
    conn = await store.getConnection();
    return conn;
  }

  async function persistTokens(tok) {
    var patch = tokenRowFromResponse(tok, nowFn());
    var saved = await store.saveConnection(patch);
    if (!saved) throw XeroError('Could not save the refreshed Xero token, so it was not used. Try Sync now; if it keeps failing, reconnect Xero.', 'token_save_failed');
    conn = Object.assign({}, conn, patch);
    return conn;
  }

  async function doRefresh() {
    var used = conn.refresh_token;
    try {
      var tok = await refreshTokens({ fetch: fetchImpl, config: cfg, refreshToken: used });
      return await persistTokens(tok);
    } catch (err) {
      if (err && err.code === 'invalid_grant') {
        // Another run (cron vs Sync now) may have rotated it a moment ago.
        var fresh = await store.getConnection();
        if (fresh && fresh.refresh_token && fresh.refresh_token !== used) {
          conn = fresh;
          if (Date.parse(fresh.expires_at) - nowFn() > REFRESH_MARGIN_MS) return conn;
          var tok2 = await refreshTokens({ fetch: fetchImpl, config: cfg, refreshToken: fresh.refresh_token });
          return await persistTokens(tok2);
        }
        throw XeroError('Xero no longer accepts the saved connection (it was disconnected or expired). Reconnect Xero from the CEO dashboard.', 'reconnect_required');
      }
      throw err;
    }
  }

  async function ensureAccessToken(force) {
    if (!conn) await loadConnection();
    if (!conn || !conn.refresh_token) throw XeroError('Xero is not connected.', 'not_connected');
    var exp = Date.parse(conn.expires_at || '');
    if (force || !conn.access_token || !Number.isFinite(exp) || exp - nowFn() < REFRESH_MARGIN_MS) await doRefresh();
    return conn.access_token;
  }

  async function apiGet(path, params, extraHeaders) {
    var u = new URL(XERO_API_BASE + path);
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null) u.searchParams.set(k, String(params[k])); });
    var retried401 = false;
    for (var attempt = 0; ; attempt++) {
      var token = await ensureAccessToken(false);
      var headers = Object.assign({
        Authorization: 'Bearer ' + token,
        'xero-tenant-id': conn.tenant_id,
        Accept: 'application/json'
      }, extraHeaders || {});
      var res = await fetchImpl(u.toString(), { method: 'GET', headers: headers });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        var ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        var waitS = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, MAX_RETRY_AFTER_S) : 5;
        await sleep(waitS * 1000);
        continue;
      }
      if (res.status === 304) return { notModified: true, data: null };
      if (res.status === 401) {
        if (isInsufficientScope(res)) throw XeroError(INSUFFICIENT_SCOPE_MESSAGE, 'insufficient_scope', { status: 401 });
        if (!retried401) { retried401 = true; await ensureAccessToken(true); continue; }
      }
      var data = await readJson(res);
      if (!res.ok) {
        var detail = data && (data.Detail || data.Message || data.Title) ? ': ' + String(data.Detail || data.Message || data.Title).slice(0, 200) : '';
        throw XeroError('Xero API ' + path + ' failed (http ' + res.status + ')' + detail, res.status === 429 ? 'rate_limited' : 'api_failed', { status: res.status });
      }
      return { notModified: false, data: data };
    }
  }

  async function syncInvoices() {
    var startedIso = new Date(nowFn()).toISOString();
    var prev = null;
    try { prev = await store.getSyncState(); } catch (e) { prev = null; }
    var prevDetail = (prev && prev.detail && typeof prev.detail === 'object') ? prev.detail : {};
    var seen = 0, upserted = 0, pages = 0;
    try {
      await loadConnection();
      if (!conn || !conn.refresh_token) throw XeroError('Xero is not connected.', 'not_connected');
      if (!conn.tenant_id) throw XeroError('Xero is connected but no organisation was chosen. Reconnect Xero.', 'no_tenant');
      var since = null;
      if (prevDetail.full_sync_at && prev && prev.last_ok_at && Number.isFinite(Date.parse(prev.last_ok_at))) {
        since = new Date(Date.parse(prev.last_ok_at) - DAY_MS);
      }
      var links = await store.loadLinkTargets();
      for (var page = 1; page <= MAX_PAGES; page++) {
        var r = await apiGet('/Invoices', {
          where: 'Type=="ACCREC"',
          Statuses: SYNC_STATUSES.join(','),
          page: page,
          pageSize: PAGE_SIZE,
          order: 'UpdatedDateUTC ASC'
        }, since ? { 'If-Modified-Since': since.toUTCString() } : null);
        pages++;
        if (r.notModified) break;
        var list = (r.data && Array.isArray(r.data.Invoices)) ? r.data.Invoices : [];
        seen += list.length;
        var rows = list.filter(function (inv) { return inv && inv.InvoiceID && String(inv.Type || 'ACCREC').toUpperCase() === 'ACCREC'; })
          .map(function (inv) { return mapInvoice(inv, links); });
        if (rows.length) { await store.upsertInvoices(rows); upserted += rows.length; }
        if (list.length < PAGE_SIZE) break;
      }
      var detail = {
        invoices_seen: seen, upserted: upserted, pages: pages, tenant_name: conn.tenant_name || null,
        incremental: !!since, full_sync_at: prevDetail.full_sync_at || (since ? null : startedIso)
      };
      await store.saveSyncState({ last_run_at: startedIso, last_ok_at: startedIso, last_error: null, detail: detail });
      return { ok: true, invoices_seen: seen, upserted: upserted, pages: pages, incremental: !!since, tenant_name: conn.tenant_name || null };
    } catch (err) {
      var msg = String((err && err.message) || err).slice(0, 500);
      var failDetail = Object.assign({}, prevDetail, { invoices_seen: seen, upserted: upserted, tenant_name: (conn && conn.tenant_name) || prevDetail.tenant_name || null, error_code: (err && err.code) || 'error' });
      try { await store.saveSyncState({ last_run_at: startedIso, last_error: msg, detail: failDetail }); } catch (e) { /* the run already failed */ }
      return { ok: false, code: (err && err.code) || 'error', error: msg, invoices_seen: seen, upserted: upserted };
    }
  }

  return { ensureAccessToken: ensureAccessToken, apiGet: apiGet, syncInvoices: syncInvoices };
}

// Callback helper: code → tokens → orgs → one saved row. Throws XeroError.
async function completeConnection(opts) {
  var o = opts || {};
  var nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  var tok = await exchangeCode({ fetch: o.fetch, config: o.config, code: o.code, redirectUri: o.redirectUri });
  if (!tok.refresh_token) throw XeroError('Xero did not return a refresh token (is offline_access in the scopes?).', 'no_refresh_token');
  var conns = await fetchConnections({ fetch: o.fetch, accessToken: tok.access_token });
  var tenant = pickTenant(conns);
  if (!tenant) throw XeroError('No Xero organisation was shared with GP Link.', 'no_tenant');
  var row = Object.assign({ id: CONNECTION_ID }, tokenRowFromResponse(tok, nowMs), tenant, {
    scopes: tok.scope ? String(tok.scope) : o.config.scopes,
    connected_at: new Date(nowMs).toISOString(),
    connected_by: o.connectedBy || null
  });
  var saved = await o.store.saveConnection(row);
  if (!saved) throw XeroError('Could not save the Xero connection.', 'save_failed');
  return { tenant_id: tenant.tenant_id, tenant_name: tenant.tenant_name };
}

module.exports = {
  XERO_AUTHORIZE_URL: XERO_AUTHORIZE_URL,
  XERO_TOKEN_URL: XERO_TOKEN_URL,
  XERO_CONNECTIONS_URL: XERO_CONNECTIONS_URL,
  XERO_API_BASE: XERO_API_BASE,
  DEFAULT_SCOPES: DEFAULT_SCOPES,
  SYNC_STATUSES: SYNC_STATUSES,
  STATE_TTL_MS: STATE_TTL_MS,
  CONNECTION_ID: CONNECTION_ID,
  SYNC_SOURCE: SYNC_SOURCE,
  INSUFFICIENT_SCOPE_MESSAGE: INSUFFICIENT_SCOPE_MESSAGE,
  xeroConfig: xeroConfig,
  signState: signState,
  verifyState: verifyState,
  buildAuthorizeUrl: buildAuthorizeUrl,
  exchangeCode: exchangeCode,
  refreshTokens: refreshTokens,
  tokenRowFromResponse: tokenRowFromResponse,
  fetchConnections: fetchConnections,
  pickTenant: pickTenant,
  parseXeroDate: parseXeroDate,
  parseXeroDay: parseXeroDay,
  extractDoctorName: extractDoctorName,
  normaliseName: normaliseName,
  matchDoctor: matchDoctor,
  mapInvoice: mapInvoice,
  isInsufficientScope: isInsufficientScope,
  createXeroClient: createXeroClient,
  completeConnection: completeConnection
};
