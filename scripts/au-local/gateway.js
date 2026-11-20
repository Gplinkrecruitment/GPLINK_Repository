#!/usr/bin/env node
'use strict';
/*
 * GP Link local test stack: the gateway.
 *
 * One address (http://localhost:54321) that looks like a Supabase project to
 * server.js and to the browser:
 *
 *   /rest/v1/*      -> the real PostgREST program, serving the local database
 *   /auth/v1/*      -> lib/auth-emulator.js
 *   /storage/v1/*   -> lib/storage-emulator.js
 *   /functions/v1/* -> not available (answers 404, noted in the Outbox)
 *   /__trap__       -> lib/trap.js: where preload.js sends every outside request
 *   /outbox         -> the human-readable Outbox page
 *
 * Plain Node http, no framework. Listens on this Mac only.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const cfg = require('./lib/config.js');
const { createOutbox } = require('./lib/outbox.js');
const { createAuthEmulator } = require('./lib/auth-emulator.js');
const { createStorageEmulator } = require('./lib/storage-emulator.js');
const { createTrap } = require('./lib/trap.js');

const secrets = cfg.loadSecrets();
const outbox = createOutbox();
const { Pool } = require(path.join(cfg.AU_HOME, 'node_modules', 'pg'));
const db = new Pool({ host: '127.0.0.1', port: cfg.PORTS.postgres, user: 'postgres', database: cfg.DB_NAME, max: 8 });
db.on('error', (e) => console.error('[gateway] database connection error:', e.message));

const auth = createAuthEmulator({ db, secrets, outbox });
const storage = createStorageEmulator({ db, secrets, outbox });
const trap = createTrap({ outbox, allowAi: process.env.AU_LOCAL_ALLOW_AI === '1' });

const MAX_BODY = 80 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization,apikey,content-type,x-client-info,x-upsert,prefer,range,accept-profile,content-profile,x-supabase-api-version',
    'Access-Control-Expose-Headers': 'Content-Range,Content-Length,Content-Type,X-Total-Count,Location',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin'
  };
}

function send(req, res, result, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {}, result.headers || {});
  if (result.rawBuffer !== undefined) {
    if (!result.keepLength) headers['Content-Length'] = String(result.rawBuffer.length);
    res.writeHead(result.status, headers);
    res.end(result.rawBuffer);
    return;
  }
  if (result.raw !== undefined) { res.writeHead(result.status, headers); res.end(result.raw); return; }
  if (result.body === null || result.body === undefined) { res.writeHead(result.status, headers); res.end(); return; }
  const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(result.status, headers);
  res.end(text);
}

// The key check Supabase's own gateway performs before anything reaches the services.
function apiKeyProblem(req, query) {
  const key = String(req.headers.apikey || query.apikey || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const candidate = key || bearer;
  if (!candidate) return { status: 401, body: { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' } };
  const claims = cfg.verifyJwt(candidate, secrets.jwtSecret);
  if (!claims || !['anon', 'service_role', 'authenticated'].includes(claims.role)) return { status: 401, body: { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' } };
  return null;
}

function proxyToPostgrest(req, res, restPath, cors) {
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  if (!headers.authorization && headers.apikey) headers.authorization = 'Bearer ' + headers.apikey;
  const upstream = http.request({ host: '127.0.0.1', port: cfg.PORTS.postgrest, method: req.method, path: restPath, headers }, (up) => {
    const out = Object.assign({}, up.headers, cors);
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });
  upstream.on('error', (e) => {
    send(req, res, { status: 503, body: { code: 'PGRST000', message: 'The local PostgREST is not reachable: ' + e.message } }, cors);
  });
  req.pipe(upstream);
}

function pageShell(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head>' + inner + '</html>';
}

const OUTBOX_HTML = fs.readFileSync(path.join(__dirname, 'lib', 'outbox-page.html'), 'utf8');

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const cors = corsHeaders(req);

  // ── the outbound trap ──
  if (pathname === '/__trap__') {
    const body = await readBody(req);
    let target;
    try { target = new URL(String(req.headers['x-aulocal-target'] || '')); } catch (e) {
      return send(req, res, { status: 400, body: { error: 'missing x-aulocal-target' } });
    }
    const headers = Object.assign({}, req.headers);
    ['x-aulocal-target', 'host', 'connection', 'authorization', 'x-api-key', 'apikey', 'cookie'].forEach((h) => delete headers[h]);
    const ctype = String(req.headers['content-type'] || '');
    const isText = /json|text|xml|x-www-form-urlencoded|javascript/i.test(ctype) || body.length < 2048;
    const result = trap.respond({
      method: req.method.toUpperCase(), url: target.toString().replace(/([?&](?:key|token|access_token|api_key|apikey)=)[^&]+/gi, '$1[hidden]'),
      host: target.hostname.toLowerCase(), path: target.pathname, search: target.searchParams, headers: req.headers, body,
      bodyText: isText ? body.toString('utf8') : '(binary, ' + body.length + ' bytes, ' + ctype + ')'
    });
    res.writeHead(result.status, Object.assign({ 'x-aulocal-trapped': '1' }, result.headers || {}));
    res.end(result.body || '');
    return;
  }

  // ── Outbox page and its small API ──
  if (pathname === '/' && req.method === 'GET') {
    return send(req, res, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, raw: pageShell('GP Link local test stack',
      '<body style="font:16px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#16202a"><h1>GP Link local test stack</h1>' +
      '<p>This is the private stand-in for Supabase and for every outside service. Nothing here touches the live business.</p><ul>' +
      '<li><a href="/outbox">Outbox</a>: every email, WhatsApp, call and invitation the app tried to send</li>' +
      '<li><a href="' + cfg.APP_URL + '/pages/signin">Doctor app sign-in</a></li>' +
      '<li><a href="' + cfg.APP_URL + '/pages/ceo-dashboard">CEO dashboard</a> (sign in at <a href="' + cfg.APP_URL + '/pages/admin-signin">admin sign-in</a>)</li>' +
      '<li><a href="http://127.0.0.1:' + cfg.PORTS.app + '/pages/admin">Staff (RSO) admin dashboard</a></li></ul></body>') });
  }
  if (pathname === '/outbox' && req.method === 'GET') {
    return send(req, res, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, raw: OUTBOX_HTML });
  }
  if (pathname === '/outbox/api/list' && req.method === 'GET') {
    const all = outbox.readAll().reverse(); // newest first
    return send(req, res, { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { ok: true, total: all.length, items: all.slice(0, 2000) } });
  }
  if (pathname === '/outbox/api/clear' && req.method === 'POST') {
    outbox.clear();
    return send(req, res, { status: 200, body: { ok: true } });
  }
  if (pathname.startsWith('/outbox/file/') && req.method === 'GET') {
    const rel = decodeURIComponent(pathname.slice('/outbox/file/'.length));
    const file = path.resolve(cfg.PATHS.outboxFiles, rel);
    if (!file.startsWith(path.resolve(cfg.PATHS.outboxFiles) + path.sep) || !fs.existsSync(file)) return send(req, res, { status: 404, body: { message: 'not found' } });
    const ext = path.extname(file).toLowerCase();
    const type = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.ics': 'text/calendar', '.csv': 'text/csv' }[ext] || 'application/octet-stream';
    return send(req, res, { status: 200, headers: { 'Content-Type': type, 'Content-Disposition': (type === 'application/octet-stream' ? 'attachment' : 'inline') + '; filename="' + path.basename(file).replace(/"/g, '') + '"', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" }, rawBuffer: fs.readFileSync(file) });
  }

  // ── Supabase-shaped surface ──
  const isSupabasePath = /^\/(rest|auth|storage|functions)\/v1(\/|$)/.test(pathname);
  if (!isSupabasePath) return send(req, res, { status: 404, body: { message: 'Not found on the local gateway: ' + pathname } });
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (pathname.startsWith('/rest/v1')) {
    const bad = apiKeyProblem(req, query);
    if (bad) return send(req, res, bad, cors);
    url.searchParams.delete('apikey');
    const rest = pathname.slice('/rest/v1'.length) || '/';
    const qs = url.searchParams.toString();
    // Forward the query string untouched (PostgREST syntax is sensitive to re-encoding).
    const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    return proxyToPostgrest(req, res, rest + (rawQuery && query.apikey === undefined ? '?' + rawQuery : (qs ? '?' + qs : '')), cors);
  }

  if (pathname.startsWith('/auth/v1')) {
    const sub = pathname.slice('/auth/v1'.length) || '/';
    const open = req.method === 'GET' && /^\/(verify|authorize|health|settings|callback)\/?$/.test(sub);
    if (!open) {
      const bad = apiKeyProblem(req, query);
      if (bad) return send(req, res, bad, cors);
    }
    const raw = await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch (e) { body = {}; } }
    const result = await auth.handle(req, res, sub, query, body && typeof body === 'object' ? body : {});
    return send(req, res, result, cors);
  }

  if (pathname.startsWith('/storage/v1')) {
    const sub = pathname.slice('/storage/v1'.length) || '/';
    const raw = await readBody(req);
    const result = await storage.handle(req, res, sub, query, raw);
    return send(req, res, result, cors);
  }

  // Edge functions do not exist locally.
  outbox.note('functions', 'Supabase Edge Function called but not available locally: ' + req.method + ' ' + pathname);
  return send(req, res, { status: 404, body: { code: 'NOT_FOUND', message: 'Requested function was not found (local test stack has no Edge Functions)' } }, cors);
}

function listener(req, res) {
  handle(req, res).catch((err) => {
    console.error('[gateway] error on', req.method, req.url, '-', err && err.stack ? err.stack : err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'Local gateway error: ' + (err && err.message ? err.message : String(err)) }));
  });
}

// "localhost" can mean 127.0.0.1 or ::1 depending on who asks, so listen on both.
http.createServer(listener).listen(cfg.PORTS.gateway, '127.0.0.1', () => console.log('[gateway] listening on 127.0.0.1:' + cfg.PORTS.gateway));
const v6 = http.createServer(listener);
v6.on('error', (e) => console.warn('[gateway] IPv6 loopback not available:', e.message));
v6.listen(cfg.PORTS.gateway, '::1');
