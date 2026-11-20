'use strict';

/**
 * Boot the real server for an Australian GP build test, either against the
 * in-memory Supabase emulator (tests/helpers/au-supabase-emulator.js) or in
 * local JSON-file mode. One boot per test file (server.js reads its Supabase
 * settings once, when it is first loaded).
 *
 *   const { bootAuTestServer } = require('./helpers/au-server-harness.js');
 *   const h = await bootAuTestServer({ name: 'wp02', tables: buildAuFixtureDb(doctors) });
 *   h.setSwitch(true);                       // AU_PATHWAY_ENABLED, read at call time
 *   const res = await h.get('/api/auth/session', { cookie: h.gpCookie(email, userId) });
 *   await h.close();
 *
 * Nothing real can be reached: fetch to anything but 127.0.0.1 is answered
 * with an empty 200, and no sending keys are set.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { startAuSupabaseEmulator } = require('./au-supabase-emulator.js');

const SUPER_HOST = 'au-super.gplink-test.local';
const ADMIN_HOST = 'au-admin.gplink-test.local';
const SUPER_EMAIL = 'super.test@gplink-test.local';
const RSO_EMAIL = 'rso.test@gplink-test.local';
const OTHER_RSO_EMAIL = 'rso.other.test@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant.test@gplink-test.local';
const RSO_USER_ID = '00000000-0000-4000-8000-00000000e001';
const OTHER_RSO_USER_ID = '00000000-0000-4000-8000-00000000e002';

// rso_team rows so an RSO's email resolves to a roster user_id (GP scoping).
const RSO_TEAM_ROWS = [
  { user_id: RSO_USER_ID, name: 'Test Rso', email: RSO_EMAIL, phone: '', active: true, on_leave: false, calendly_event_url: null },
  { user_id: OTHER_RSO_USER_ID, name: 'Test Otherrso', email: OTHER_RSO_EMAIL, phone: '', active: true, on_leave: false, calendly_event_url: null }
];

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function signedCookie(name, userProfile) {
  const payload = b64url(JSON.stringify({ userProfile, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return name + '=' + encodeURIComponent(payload + '.' + sig);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.name]        short label for temp files
 * @param {'supabase'|'local'} [opts.mode='supabase']
 * @param {object} [opts.tables]      emulator tables (supabase mode); rso_team is added if absent
 * @param {object} [opts.emulator]    extra startAuSupabaseEmulator options
 * @param {object} [opts.localDb]     contents of the local JSON db file
 * @param {object} [opts.env]         extra environment variables
 */
async function bootAuTestServer(opts) {
  const o = opts || {};
  const mode = o.mode === 'local' ? 'local' : 'supabase';
  const runId = crypto.randomBytes(4).toString('hex');
  const dbFile = '/tmp/gplink-au-' + (o.name || 'test') + '-' + runId + '.json';
  fs.writeFileSync(dbFile, JSON.stringify(o.localDb || {}));

  let emu = null;
  if (mode === 'supabase') {
    const tables = Object.assign({ rso_team: RSO_TEAM_ROWS }, o.tables || {});
    emu = await startAuSupabaseEmulator(Object.assign({}, o.emulator || {}, { tables }));
  }

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'au-test-secret-' + runId;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = emu ? emu.url : '';
  process.env.SUPABASE_PUBLISHABLE_KEY = emu ? 'test-anon-key' : '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = emu ? 'test-service-role-key' : '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = dbFile;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = RSO_EMAIL + ',' + OTHER_RSO_EMAIL;
  process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
  ['RESEND_API_KEY', 'DOUBLETICK_API_KEY', 'RETELL_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'ZOHO_RECRUIT_CLIENT_ID', 'ZOHO_RECRUIT_CLIENT_SECRET', 'ZOHO_RECRUIT_REDIRECT_URI'].forEach(function (k) { process.env[k] = ''; });
  Object.keys(o.env || {}).forEach(function (k) { process.env[k] = o.env[k]; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('http://127.0.0.1') === 0) return realFetch(url, init);
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };

  const serverModule = require('../../server.js');
  const server = serverModule.createServer();
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  function request(method, path, ro) {
    const r = ro || {};
    return new Promise(function (resolve, reject) {
      const headers = Object.assign({}, r.headers || {});
      if (r.host) headers.Host = r.host;
      if (r.cookie) headers.Cookie = r.cookie;
      const payload = r.body === undefined ? null : Buffer.from(JSON.stringify(r.body), 'utf8');
      if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { json = null; }
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  const savedSwitch = process.env.AU_PATHWAY_ENABLED;
  return {
    mode,
    emu,
    server,
    port,
    dbFile,
    testUtils: serverModule.__testUtils,
    SUPER_HOST, ADMIN_HOST, SUPER_EMAIL, RSO_EMAIL, OTHER_RSO_EMAIL, CONSULTANT_EMAIL, RSO_USER_ID, OTHER_RSO_USER_ID,
    /** Flip AU_PATHWAY_ENABLED. The server reads it at call time. */
    setSwitch: function (on) { process.env.AU_PATHWAY_ENABLED = on ? 'true' : 'false'; },
    request,
    get: function (path, ro) { return request('GET', path, ro); },
    post: function (path, body, ro) { return request('POST', path, Object.assign({}, ro || {}, { body: body === undefined ? {} : body })); },
    put: function (path, body, ro) { return request('PUT', path, Object.assign({}, ro || {}, { body: body === undefined ? {} : body })); },
    /** A signed-in doctor. supabaseUserId is ignored in local mode. */
    gpCookie: function (email, supabaseUserId) {
      return signedCookie('gp_session', supabaseUserId ? { email, supabaseUserId } : { email });
    },
    /** Staff cookies + the host each role is served on. */
    superAdmin: function () { return { cookie: signedCookie('gp_admin_session', { email: SUPER_EMAIL, adminRole: 'super_admin' }), host: SUPER_HOST }; },
    consultant: function () { return { cookie: signedCookie('gp_admin_session', { email: CONSULTANT_EMAIL, adminRole: 'consultant' }), host: SUPER_HOST }; },
    rso: function (email) { return { cookie: signedCookie('gp_admin_session', { email: email || RSO_EMAIL, adminRole: 'admin' }), host: ADMIN_HOST }; },
    readLocalDb: function () { try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) { return {}; } },
    close: async function () {
      globalThis.fetch = realFetch;
      if (savedSwitch === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = savedSwitch;
      await new Promise(function (resolve) { server.close(function () { resolve(); }); });
      if (emu) await emu.close();
      try { fs.unlinkSync(dbFile); } catch (e) { /* already gone */ }
    }
  };
}

module.exports = {
  bootAuTestServer,
  SUPER_HOST, ADMIN_HOST, SUPER_EMAIL, RSO_EMAIL, OTHER_RSO_EMAIL, CONSULTANT_EMAIL, RSO_USER_ID, OTHER_RSO_USER_ID
};
