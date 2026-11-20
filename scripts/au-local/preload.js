'use strict';
/*
 * GP Link local test stack: the outbound trap (app side).
 *
 * Loaded before server.js:  node -r scripts/au-local/preload.js server.js
 *
 * After this file has run, the app process cannot reach any outside address:
 *
 *   1. global fetch()                 every request to a non-local address is sent
 *   2. http.request / https.request   to the local gateway's /__trap__ instead, which
 *      (and .get)                     records it in the Outbox and answers with a
 *                                     realistic canned success.
 *   3. net.Socket.connect             the last line of defence: a raw connection to a
 *                                     non-local address is refused and logged, whatever
 *                                     library tried to open it.
 *   4. dns lookups                    for non-local names are refused (no DNS query leaves).
 *   5. child_process                  only Node itself may be started (with this same trap);
 *                                     any other program is refused.
 *
 * "Local" means this Mac (127.0.0.1 / ::1 / localhost) on the gateway port or the app's
 * own port. Nothing else.
 *
 * AI: api.anthropic.com is trapped like everything else unless the stack was started
 * with AU_LOCAL_ALLOW_AI=1, in which case that one host is let through (and each call
 * is still noted in the Outbox).
 *
 * It also refuses to start at all unless SUPABASE_URL is the local gateway.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const path = require('path');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');

const GATEWAY_PORT = Number(process.env.AU_LOCAL_GATEWAY_PORT || 54321);
const APP_PORT = Number(process.env.AU_LOCAL_APP_PORT || process.env.PORT || 3000);
const AU_HOME = process.env.AU_LOCAL_HOME || path.join(os.homedir(), 'gplink-tools', 'au-local');
const ALLOW_AI = process.env.AU_LOCAL_ALLOW_AI === '1';
const AI_HOSTS = new Set(['api.anthropic.com']);
const TRAP_URL = 'http://127.0.0.1:' + GATEWAY_PORT + '/__trap__';
const BLOCKED_LOG = path.join(AU_HOME, 'logs', 'blocked-outbound.log');
const TRAPPED_LOG = path.join(AU_HOME, 'logs', 'trapped-outbound.log');

function die(message) {
  process.stderr.write('\n==================================================================\n' +
    'LOCAL TEST STACK REFUSED TO START\n' + message + '\n' +
    '==================================================================\n\n');
  process.exit(78);
}
function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1' || h === '0.0.0.0' || h === '';
}
function isLocalTarget(hostname, port) {
  if (!isLoopback(hostname)) return false;
  const p = Number(port);
  return p === GATEWAY_PORT || p === APP_PORT;
}
function logLine(file, line) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n'); } catch (e) { /* logging must never break the app */ }
}

// ── 0. Start-up guard ─────────────────────────────────────────────────────────
function assertLocalConfig(stage) {
  let host = '';
  let port = 0;
  try { const u = new URL(String(process.env.SUPABASE_URL || '')); host = u.hostname; port = Number(u.port); } catch (e) { host = ''; }
  if (!isLoopback(host) || !host || port !== GATEWAY_PORT) {
    die('SUPABASE_URL does not point at the local gateway (' + stage + ').\n' +
      'The app would be talking to a real database. Start it with scripts/au-local/start.sh, which sets every value itself.');
  }
  if (process.env.AGENT_SKIP_DOTENV !== 'true') {
    die('AGENT_SKIP_DOTENV is not "true" (' + stage + '). A .env file in the project folder could redirect the app to production.');
  }
  if (String(process.env.NODE_ENV || '') === 'production') die('NODE_ENV is "production" (' + stage + '). The local stack only runs as a development server.');
}
if (process.env.AU_LOCAL_STACK !== '1') die('preload.js was loaded without the local stack settings. Use scripts/au-local/start.sh.');
assertLocalConfig('before start');
// Checked again once server.js and everything it requires has loaded, in case
// anything changed the settings on the way (for example a .env loader).
setImmediate(() => {
  assertLocalConfig('after start');
  // Say what the running app believes about the Australian pathway switch, using
  // the app's own function when this build has it (lib/au-pathway-flag.js).
  let verdict = '';
  try { verdict = require(path.join(process.cwd(), 'lib', 'au-pathway-flag.js')).isAuPathwayEnabled() ? 'ON' : 'OFF'; } catch (e) { verdict = '(lib/au-pathway-flag.js not present in this build)'; }
  process.stderr.write('[au-local] AU_PATHWAY_ENABLED=' + String(process.env.AU_PATHWAY_ENABLED) + ' ; isAuPathwayEnabled() says ' + verdict + '\n');
});

// ── 1. fetch ──────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async function auLocalFetch(input, init) {
  let request;
  try { request = new Request(input, init); } catch (e) { return realFetch(input, init); }
  let url;
  try { url = new URL(request.url); } catch (e) { return realFetch(input, init); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return realFetch(input, init); // data:, blob:
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  if (isLocalTarget(url.hostname, port)) return realFetch(input, init);
  if (ALLOW_AI && AI_HOSTS.has(url.hostname.toLowerCase())) {
    logLine(TRAPPED_LOG, 'ALLOWED-AI ' + request.method + ' ' + url.origin + url.pathname);
    realFetch(TRAP_URL.replace('/__trap__', '/__ai_note__'), { method: 'POST', headers: { 'x-aulocal-target': url.origin + url.pathname } }).catch(() => {});
    return realFetch(input, init);
  }
  logLine(TRAPPED_LOG, 'TRAPPED fetch ' + request.method + ' ' + url.origin + url.pathname);
  const headers = new Headers(request.headers);
  headers.set('x-aulocal-target', url.toString());
  headers.delete('content-length');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
  return realFetch(TRAP_URL, { method: request.method, headers, body, signal: request.signal, redirect: 'manual' });
};

// ── 2. http / https ───────────────────────────────────────────────────────────
function describeRequestArgs(args, defaultProtocol) {
  let url = null;
  let options = {};
  let i = 0;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    try { url = new URL(String(args[0])); } catch (e) { url = null; }
    i = 1;
  }
  if (args[i] && typeof args[i] === 'object' && typeof args[i] !== 'function') { options = args[i]; i++; }
  const callback = typeof args[i] === 'function' ? args[i] : undefined;
  const protocol = (url && url.protocol) || options.protocol || defaultProtocol;
  const hostname = (url && url.hostname) || options.hostname || (options.host ? String(options.host).replace(/:\d+$/, '') : '') || 'localhost';
  const port = (url && url.port) || options.port || (options.host && /:(\d+)$/.test(String(options.host)) ? RegExp.$1 : '') || (protocol === 'https:' ? 443 : 80);
  const pathAndQuery = url ? (url.pathname + url.search) : (options.path || '/');
  return { protocol, hostname, port: Number(port), pathAndQuery, options, callback, url };
}
function wrapRequest(mod, name, defaultProtocol) {
  const original = mod[name];
  mod[name] = function auLocalRequest(...args) {
    const d = describeRequestArgs(args, defaultProtocol);
    if (isLocalTarget(d.hostname, d.port)) return original.apply(mod, args);
    const lower = String(d.hostname).toLowerCase();
    if (ALLOW_AI && AI_HOSTS.has(lower)) { logLine(TRAPPED_LOG, 'ALLOWED-AI ' + name + ' ' + lower); return original.apply(mod, args); }
    const target = d.protocol + '//' + d.hostname + ((d.port === 443 && d.protocol === 'https:') || (d.port === 80 && d.protocol === 'http:') ? '' : ':' + d.port) + d.pathAndQuery;
    logLine(TRAPPED_LOG, 'TRAPPED ' + (defaultProtocol === 'https:' ? 'https' : 'http') + '.' + name + ' ' + String(d.options.method || 'GET').toUpperCase() + ' ' + target.split('?')[0]);
    const headers = Object.assign({}, d.options.headers || {});
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'host') delete headers[k];
    headers['x-aulocal-target'] = target;
    const trapOptions = {
      protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/__trap__',
      method: d.options.method || 'GET', headers, timeout: d.options.timeout, signal: d.options.signal
    };
    const realHttpFn = name === 'get' ? realHttpGet : realHttpRequest;
    return realHttpFn.call(http, trapOptions, d.callback);
  };
}
const realHttpRequest = http.request;
const realHttpGet = http.get;
wrapRequest(http, 'request', 'http:');
wrapRequest(http, 'get', 'http:');
wrapRequest(https, 'request', 'https:');
wrapRequest(https, 'get', 'https:');

// ── 3. raw sockets: nothing leaves this Mac ───────────────────────────────────
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function auLocalConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0]; // internal normalised form
  let host = '';
  let port = 0;
  let isPipe = false;
  if (opts && typeof opts === 'object') { host = opts.host || 'localhost'; port = opts.port; isPipe = !!opts.path; }
  else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) { port = Number(opts); host = typeof args[1] === 'string' ? args[1] : 'localhost'; }
  else if (typeof opts === 'string') { isPipe = true; }
  if (isPipe || isLoopback(host)) return realConnect.apply(this, args);
  if (ALLOW_AI && AI_HOSTS.has(String(host).toLowerCase()) && Number(port) === 443) return realConnect.apply(this, args);
  const line = 'BLOCKED connection to ' + host + ':' + port;
  logLine(BLOCKED_LOG, line);
  process.stderr.write('[au-local trap] ' + line + ' (nothing was sent)\n');
  const err = new Error('AU-LOCAL: outbound connection to ' + host + ':' + port + ' blocked by the local test stack');
  err.code = 'ECONNREFUSED';
  process.nextTick(() => this.destroy(err));
  return this;
};

// ── 4. DNS ────────────────────────────────────────────────────────────────────
function dnsAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return isLoopback(h) || net.isIP(h) !== 0 || (ALLOW_AI && AI_HOSTS.has(h));
}
const realLookup = dns.lookup;
dns.lookup = function auLocalLookup(hostname, options, callback) {
  if (dnsAllowed(hostname)) return realLookup.apply(dns, arguments);
  const cb = typeof options === 'function' ? options : callback;
  logLine(BLOCKED_LOG, 'BLOCKED dns lookup for ' + hostname);
  const err = new Error('AU-LOCAL: DNS lookup for ' + hostname + ' blocked by the local test stack');
  err.code = 'ENOTFOUND';
  if (typeof cb === 'function') process.nextTick(() => cb(err));
  return {};
};
if (dns.promises && dns.promises.lookup) {
  const realPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = function auLocalPromiseLookup(hostname) {
    if (dnsAllowed(hostname)) return realPromiseLookup.apply(dns.promises, arguments);
    logLine(BLOCKED_LOG, 'BLOCKED dns lookup for ' + hostname);
    const err = new Error('AU-LOCAL: DNS lookup for ' + hostname + ' blocked by the local test stack');
    err.code = 'ENOTFOUND';
    return Promise.reject(err);
  };
}
for (const fn of ['resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveCname', 'resolveSrv', 'resolveNs', 'resolveAny', 'reverse']) {
  if (typeof dns[fn] !== 'function') continue;
  dns[fn] = function auLocalResolve(hostname) {
    logLine(BLOCKED_LOG, 'BLOCKED dns.' + fn + ' for ' + hostname);
    const cb = arguments[arguments.length - 1];
    const err = new Error('AU-LOCAL: DNS query blocked by the local test stack');
    err.code = 'ENOTFOUND';
    if (typeof cb === 'function') process.nextTick(() => cb(err));
  };
  if (dns.promises && typeof dns.promises[fn] === 'function') {
    dns.promises[fn] = function () { const err = new Error('AU-LOCAL: DNS query blocked by the local test stack'); err.code = 'ENOTFOUND'; return Promise.reject(err); };
  }
}

// ── 5. other programs ─────────────────────────────────────────────────────────
function isNodeBinary(command) {
  const c = String(command || '');
  return c === process.execPath || path.basename(c) === 'node';
}
function refuseProgram(what) {
  logLine(BLOCKED_LOG, 'BLOCKED program start: ' + what);
  const err = new Error('AU-LOCAL: starting "' + what + '" is blocked by the local test stack (it could reach outside services)');
  err.code = 'EACCES';
  throw err;
}
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[fn];
  childProcess[fn] = function auLocalSpawn(command, ...rest) {
    if (!isNodeBinary(command)) refuseProgram(command);
    // A Node child must carry the same trap.
    const optIndex = rest.findIndex((a) => a && typeof a === 'object' && !Array.isArray(a));
    const opts = optIndex === -1 ? {} : Object.assign({}, rest[optIndex]);
    opts.env = Object.assign({}, opts.env || process.env, { NODE_OPTIONS: '--require ' + JSON.stringify(__filename) });
    for (const k of ['AU_LOCAL_STACK', 'AU_LOCAL_HOME', 'AU_LOCAL_GATEWAY_PORT', 'AU_LOCAL_APP_PORT', 'AU_LOCAL_ALLOW_AI', 'AGENT_SKIP_DOTENV', 'SUPABASE_URL', 'NODE_ENV']) {
      if (opts.env[k] === undefined && process.env[k] !== undefined) opts.env[k] = process.env[k];
    }
    if (optIndex === -1) rest.push(opts); else rest[optIndex] = opts;
    return original.call(childProcess, command, ...rest);
  };
}
for (const fn of ['exec', 'execSync']) {
  childProcess[fn] = function auLocalExec(command) { return refuseProgram(String(command).slice(0, 80)); };
}

process.stderr.write('[au-local trap] active: outside requests are captured to the Outbox (http://localhost:' + GATEWAY_PORT + '/outbox)' +
  (ALLOW_AI ? '; AI calls to Anthropic are ALLOWED' : '; AI calls are blocked') + '\n');
