'use strict';

/**
 * WP-16 (Australian lead and consult copy): the real server with a recording
 * Resend stub and a recording DoubleTick stub in front of it. Nothing real is
 * sent. One boot per test file.
 *
 *   const h = await bootLeadCopyServer({ name: 'wp16-x' });           // local JSON db
 *   const h = await bootLeadCopyServer({ name: 'wp16-y', mode: 'supabase', tables });
 *   h.reset(); h.emailsTo(addr); h.waTo(phone); h.cron('/api/cron/consult-nudge')
 */

const http = require('http');
const { bootAuTestServer } = require('./au-server-harness.js');

const FIXED_AUTH_SECRET = 'au-wp16-fixed-secret-for-stable-unsubscribe-links';
const OWNER_PHONE = '+61499000999';

function stub(store, reply) {
  return new Promise(function (resolve) {
    const s = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch (e) { parsed = null; }
        store.push({ path: req.url, method: req.method, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply(req, parsed)));
      });
    });
    s.listen(0, '127.0.0.1', function () { resolve(s); });
  });
}

const digits = function (v) { return String(v || '').replace(/\D/g, ''); };

async function bootLeadCopyServer(opts) {
  const o = opts || {};
  const emails = [];
  const dt = [];
  const resendServer = await stub(emails, function () { return { id: 'stub' }; });
  const dtServer = await stub(dt, function () { return { messages: [{ id: 'wa-stub', status: 'SENT' }] }; });
  const env = Object.assign({
    AUTH_SECRET: FIXED_AUTH_SECRET,
    RESEND_API_KEY: 'test-key',
    RESEND_API_URL: 'http://127.0.0.1:' + resendServer.address().port + '/emails',
    DOUBLETICK_API_KEY: 'test-dt-key',
    DOUBLETICK_BASE_URL: 'http://127.0.0.1:' + dtServer.address().port,
    CONSULT_OWNER_ALERT_PHONE: OWNER_PHONE,
    CONSULT_NOSHOW_RESCUE_SINCE: '2020-01-01T00:00:00Z',
    SITE_PUBLIC_BASE_URL: 'https://app.gplink-test.local',
    LEAD_CALLS_ENABLED: 'false'
  }, o.env || {});
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;
  delete process.env.NOTIFY_TEST_RECIPIENTS;
  delete process.env.VERCEL_ENV;
  const h = await bootAuTestServer({
    name: o.name || 'wp16', mode: o.mode === 'supabase' ? 'supabase' : 'local',
    localDb: o.localDb || {}, tables: o.tables, emulator: o.emulator, env: env
  });
  const AUTH = { Authorization: 'Bearer test-cron-secret' };
  return Object.assign(h, {
    emails, dt, OWNER_PHONE,
    reset: function () { emails.length = 0; dt.length = 0; },
    cron: function (p) { return h.get(p, { headers: AUTH }); },
    /** Bodies of the emails sent to one address. */
    emailsTo: function (addr) {
      return emails.filter(function (c) {
        return c.body && JSON.stringify(c.body.to || '').toLowerCase().indexOf(String(addr).toLowerCase()) !== -1;
      }).map(function (c) { return c.body; });
    },
    /** WhatsApp template contents sent to one number. */
    waTo: function (phone) {
      return dt.filter(function (c) {
        return c.path === '/whatsapp/message/template' && c.body && c.body.messages && digits(c.body.messages[0].to) === digits(phone);
      }).map(function (c) { return c.body.messages[0].content; });
    },
    seed: function (rows) { h.testUtils.__seedSiteEnquiriesForTest(rows); },
    dbRow: function (id) { return (h.readLocalDb().siteEnquiries || []).find(function (r) { return r.id === id; }); },
    closeAll: async function () {
      await h.close();
      await new Promise(function (resolve) { resendServer.close(resolve); });
      await new Promise(function (resolve) { dtServer.close(resolve); });
    }
  });
}

module.exports = { bootLeadCopyServer, FIXED_AUTH_SECRET, OWNER_PHONE };
