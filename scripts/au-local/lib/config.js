'use strict';
/*
 * Shared settings for the GP Link local test stack.
 * Everything that runs or stores data lives OUTSIDE the repo, in AU_HOME.
 * Nothing in this file talks to production.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AU_HOME = process.env.AU_LOCAL_HOME || path.join(os.homedir(), 'gplink-tools', 'au-local');

const PORTS = {
  app: Number(process.env.AU_LOCAL_APP_PORT || 3000),
  gateway: Number(process.env.AU_LOCAL_GATEWAY_PORT || 54321),
  postgres: Number(process.env.AU_LOCAL_PG_PORT || 54329),
  postgrest: Number(process.env.AU_LOCAL_POSTGREST_PORT || 54330)
};

const PATHS = {
  home: AU_HOME,
  pgNative: path.join(AU_HOME, 'node_modules', '@embedded-postgres', 'darwin-arm64', 'native'),
  pgData: path.join(AU_HOME, 'pgdata'),
  postgrestBin: path.join(AU_HOME, 'postgrest', 'postgrest'),
  postgrestConf: path.join(AU_HOME, 'postgrest.conf'),
  storage: path.join(AU_HOME, 'storage'),
  outbox: path.join(AU_HOME, 'outbox.jsonl'),
  outboxFiles: path.join(AU_HOME, 'outbox-files'),
  logs: path.join(AU_HOME, 'logs'),
  run: path.join(AU_HOME, 'run'),
  secrets: path.join(AU_HOME, 'local-secrets.json'),
  appData: path.join(AU_HOME, 'app-data'),
  blockedLog: path.join(AU_HOME, 'logs', 'blocked-outbound.log'),
  schemaSql: path.join(__dirname, '..', 'schema', 'prod-schema.sql'),
  bootstrapSql: path.join(__dirname, 'bootstrap.sql'),
  migrationsDir: path.join(REPO_ROOT, 'supabase', 'migrations')
};

const DB_NAME = 'gplink_local';
const GATEWAY_URL = 'http://localhost:' + PORTS.gateway;
const APP_URL = 'http://localhost:' + PORTS.app;
const TEST_PASSWORD = 'GpLink-Test-2026!';
const TEST_EMAIL_DOMAIN = 'gplink-test.local';

// Seeded staff. Roles are decided by server.js from (1) public.user_roles,
// then (2) the SUPER_ADMIN_EMAILS / ADMIN_EMAILS / CONSULTANT_EMAILS lists.
// The seed writes both so either route gives the same answer.
const STAFF = {
  ceo: { email: 'ceo@' + TEST_EMAIL_DOMAIN, firstName: 'Test', lastName: 'Ceo (FAKE)', role: 'super_admin', id: '00000000-0000-4000-a000-0000000000c1' },
  rso: { email: 'rso@' + TEST_EMAIL_DOMAIN, firstName: 'Test', lastName: 'Rso (FAKE)', role: 'admin', id: '00000000-0000-4000-a000-0000000000c2' },
  consultant: { email: 'consultant@' + TEST_EMAIL_DOMAIN, firstName: 'Test', lastName: 'Consultant (FAKE)', role: 'consultant', id: '00000000-0000-4000-a000-0000000000c3' },
  // server.js hard-codes this user id as the "GP Link Admin" pool (RSO_TEAM,
  // server.js:647-656) and falls back to it as a task assignee. The id is a
  // constant in the source code; the account seeded under it here is fake.
  adminPool: { email: 'adminpool@' + TEST_EMAIL_DOMAIN, firstName: 'Test', lastName: 'Admin Pool (FAKE)', role: 'admin', id: '9c35e6f6-f7a2-4d33-afd7-06c59d9d4ae7' }
};

function ensureDirs() {
  for (const p of [PATHS.home, PATHS.storage, PATHS.outboxFiles, PATHS.logs, PATHS.run, PATHS.appData]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return head + '.' + body + '.' + sig;
}
function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (payload && payload.exp && Date.now() / 1000 > Number(payload.exp)) return null;
  return payload;
}

// Local-only secrets. Generated once on this Mac, never committed, never the
// same as anything in production.
function loadSecrets(opts) {
  const create = !!(opts && opts.create);
  let secrets = null;
  try { secrets = JSON.parse(fs.readFileSync(PATHS.secrets, 'utf8')); } catch (e) { secrets = null; }
  if (!secrets) {
    if (!create) throw new Error('The local stack has not been set up yet. Run scripts/au-local/setup.sh first.');
    ensureDirs();
    const rsa = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const ec = crypto.createECDH('prime256v1');
    ec.generateKeys();
    secrets = {
      note: 'LOCAL TEST VALUES ONLY. Generated on this machine. Not used anywhere else.',
      jwtSecret: crypto.randomBytes(40).toString('hex'),
      authSecret: crypto.randomBytes(40).toString('hex'),
      cronSecret: 'aulocal-cron-' + crypto.randomBytes(16).toString('hex'),
      googlePrivateKey: rsa.privateKey,
      vapidPublicKey: b64url(ec.getPublicKey()),
      vapidPrivateKey: b64url(Buffer.concat([Buffer.alloc(32), ec.getPrivateKey()]).subarray(-32))
    };
    fs.writeFileSync(PATHS.secrets, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  }
  // Stable API keys (same shape as Supabase's anon / service_role JWTs).
  secrets.anonKey = signJwt({ iss: 'aulocal', ref: 'aulocal', role: 'anon', iat: 1700000000, exp: 2000000000 }, secrets.jwtSecret);
  secrets.serviceRoleKey = signJwt({ iss: 'aulocal', ref: 'aulocal', role: 'service_role', iat: 1700000000, exp: 2000000000 }, secrets.jwtSecret);
  return secrets;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::ffff:127.0.0.1';
}

/*
 * The COMPLETE environment server.js is started with. start.sh launches the
 * server with `env -i` and exactly these variables, so nothing from the shell
 * or from any .env file can point the app at production.
 *
 * Sending keys are deliberately non-empty dummies: where server.js skips a
 * message when a key is blank, a dummy makes it build and "send" the message,
 * which the outbound trap then captures into the Outbox. None of these values
 * is accepted by any real service.
 */
function buildServerEnv(overrides) {
  const s = loadSecrets();
  const o = overrides || {};
  const allowAi = String(o.AU_LOCAL_ALLOW_AI || '') === '1';
  const env = {
    PATH: path.join(os.homedir(), 'gplink-tools', 'node-v22', 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    TZ: 'UTC', // Vercel functions run in UTC
    LANG: 'en_AU.UTF-8',

    // ── never read a .env file (scripts/agents.js loads <folder>/.env otherwise)
    AGENT_SKIP_DOTENV: 'true',

    // ── local stack markers, read by preload.js
    AU_LOCAL_STACK: '1',
    AU_LOCAL_HOME: AU_HOME,
    AU_LOCAL_GATEWAY_PORT: String(PORTS.gateway),
    AU_LOCAL_APP_PORT: String(PORTS.app),
    AU_LOCAL_ALLOW_AI: allowAi ? '1' : '0',

    // ── app basics
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(PORTS.app),
    APP_BASE_URL: APP_URL,
    PUBLIC_BASE_URL: APP_URL,
    AUTH_DISABLED: 'false',
    AUTH_SECRET: s.authSecret,
    COOKIE_SECURE: 'false',
    ENFORCE_SAME_ORIGIN: 'true',
    REQUIRE_SUPABASE_DB: 'true',
    // A tester signs in and out far more often than a real person. The live
    // limit (12 attempts per 10 minutes per address) would lock a walk-through
    // out, so it is raised here. Everything else about rate limiting is unchanged.
    AUTH_RATE_MAX_ATTEMPTS: '300',
    DB_FILE_PATH: path.join(PATHS.appData, 'app-db.json'),
    CRON_SECRET: s.cronSecret,
    AU_PATHWAY_ENABLED: String(o.AU_PATHWAY_ENABLED || 'true'),
    // WP-29: the Ahpra register lookup. ON with made-up test numbers (fixture)
    // unless the stack is started with AHPRA_LOOKUP_PROVIDER=none (FR-9: the
    // same as the area check, so the testing guide works as the stack starts).
    // The fixture answers a handful of made-up numbers from made-up pages
    // (docs/au-gp/TESTING.md). The real register can NOT be switched on from
    // the local stack: any value other than "none" means "fixture".
    AHPRA_LOOKUP_PROVIDER: String(o.AHPRA_LOOKUP_PROVIDER || '') === 'none' ? 'none' : 'fixture',

    // ── "Supabase" = the local gateway
    SUPABASE_URL: GATEWAY_URL,
    SUPABASE_PUBLISHABLE_KEY: s.anonKey,
    SUPABASE_ANON_KEY: s.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: s.serviceRoleKey,

    // ── who is staff, and on which address
    //    http://localhost:3000   = the CEO / super-admin address (like ceo.admin.mygplink.com.au)
    //    http://127.0.0.1:3000   = the employee admin address   (like admin.mygplink.com.au)
    // FR-7 (guide walk): the FIRST entry is also what staff email links to the
    // CEO dashboard are built from (server.js getSuperAdminBaseUrl: a bare
    // host gets "https://" and no port, which on this Mac gave links to
    // https://localhost/... that open nothing). An entry that is already a
    // full address is used as it is, so the local address goes first; the
    // bare host that follows is the one requests are matched against. On
    // Vercel the entry is the real CEO host and nothing here applies.
    SUPER_ADMIN_ALLOWED_HOSTS: APP_URL + ',localhost',
    ADMIN_ALLOWED_HOSTS: '127.0.0.1',
    SUPER_ADMIN_EMAILS: STAFF.ceo.email,
    ADMIN_EMAILS: [STAFF.rso.email, STAFF.adminPool.email].join(','),
    CONSULTANT_EMAILS: STAFF.consultant.email,
    CEO_EMAIL: STAFF.ceo.email,
    AUDIT_ALERT_EMAIL: STAFF.ceo.email,
    SITE_ENQUIRY_NOTIFY_EMAIL: STAFF.ceo.email,
    MASTER_ARCHIVE_EMAIL: 'archive@' + TEST_EMAIL_DOMAIN,
    // New cases go to the admin pool, as they do in production.
    LAUNCH_DEFAULT_RSO_EMAIL: STAFF.adminPool.email,
    REGISTRATION_HUB_EMAIL: 'registration@' + TEST_EMAIL_DOMAIN,
    MONITORED_VA_EMAILS: 'hazel@' + TEST_EMAIL_DOMAIN,
    VA_GMAIL_ADDRESS: 'hazel@' + TEST_EMAIL_DOMAIN,

    // ── email (Resend): dummy key so emails are generated; the trap captures them
    RESEND_API_KEY: 're_aulocal_dummy_not_a_real_key',
    RESEND_FROM_EMAIL: 'hello@' + TEST_EMAIL_DOMAIN,
    RESEND_FROM_NAME: 'GP Link (LOCAL TEST)',
    RESEND_WEBHOOK_SECRET: 'whsec_aulocal_dummy',

    // ── WhatsApp (DoubleTick)
    DOUBLETICK_API_KEY: 'aulocal_dummy_doubletick_key',
    DOUBLETICK_WEBHOOK_SECRET: 'aulocal_dummy_doubletick_webhook',
    HAZEL_WHATSAPP_NUMBER: '+61491570006', // numbers from the range reserved for fiction
    CONSULT_OWNER_ALERT_PHONE: '+61491570110',

    // ── Google (Gmail / Calendar / Drive): throwaway key generated on this Mac
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'aulocal@aulocal-test.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: s.googlePrivateKey,
    GOOGLE_SERVICE_ACCOUNT_DELEGATED_EMAIL: 'hazel@' + TEST_EMAIL_DOMAIN,
    GOOGLE_DRIVE_ROOT_FOLDER_ID: 'aulocal-drive-root',
    GOOGLE_CALENDAR_ID: 'primary',
    GOOGLE_CALENDAR_IMPERSONATE_EMAIL: 'calendar@' + TEST_EMAIL_DOMAIN,
    GOOGLE_DRIVE_IMPERSONATE_EMAIL: 'drive@' + TEST_EMAIL_DOMAIN,

    // ── Zoom / Calendly
    ZOOM_ACCOUNT_ID: 'aulocal-zoom-account',
    ZOOM_CLIENT_ID: 'aulocal-zoom-client',
    ZOOM_CLIENT_SECRET: 'aulocal-zoom-secret',
    ZOOM_WEBHOOK_SECRET: 'aulocal-zoom-webhook',
    CALENDLY_API_TOKEN: 'aulocal-calendly-token',
    CALENDLY_WEBHOOK_SECRET: 'aulocal-calendly-webhook',
    CALENDLY_EVENT_URL: 'https://calendly.com/aulocal-fake/gp-link-call',
    CALENDLY_EVENT_TYPE_URI: 'https://api.calendly.com/event_types/AULOCALFAKE',
    CONSULT_CALENDLY_EVENT_TYPE_URI: 'https://api.calendly.com/event_types/AULOCALFAKECONSULT',
    CONSULT_CALENDLY_URL: 'https://calendly.com/aulocal-fake/30min',

    // ── Hazel (Retell). The dialler itself stays OFF (LEAD_CALLS_ENABLED unset).
    RETELL_API_KEY: 'aulocal-retell-key',
    RETELL_AGENT_ID: 'aulocal-retell-agent',

    // ── Twilio / Meta / web push
    TWILIO_AUTH_TOKEN: 'aulocal-twilio-token',
    TWILIO_SMS_FORWARD_TO: 'sms@' + TEST_EMAIL_DOMAIN,
    META_CAPI_ACCESS_TOKEN: 'aulocal-meta-capi-token',
    META_CAPI_DATASET_ID: '000000000000000',
    FB_LEAD_VERIFY_TOKEN: 'aulocal-fb-verify',
    FB_LEAD_WEBHOOK_SECRET: 'aulocal-fb-webhook-secret',
    // WP-24: two made-up Meta lead-form ids, so a fake lead can be posted at the
    // local webhook and the conversion requests it WOULD cause can be read in the
    // Outbox ("background service calls"). They exist nowhere but here.
    FB_GP_LEAD_FORM_IDS: 'AULOCAL-UK-FORM',
    FB_AU_GP_LEAD_FORM_IDS: 'AULOCAL-AU-FORM',
    VAPID_PUBLIC_KEY: s.vapidPublicKey,
    VAPID_PRIVATE_KEY: s.vapidPrivateKey,
    VAPID_SUBJECT: 'mailto:hello@' + TEST_EMAIL_DOMAIN,

    // ── WP-30: the area look-up (Distribution Priority Area, Modified Monash)
    //    answers from the small test map in lib/au-workforce-locator-fixture.json.
    //    No network: the real Health Workforce Locator is never contacted from
    //    this Mac. Start with AU_WORKFORCE_LOCATOR_PROVIDER=none to see the
    //    product with the look-up off (the practice is asked, as before).
    AU_WORKFORCE_LOCATOR_PROVIDER: String(o.AU_WORKFORCE_LOCATOR_PROVIDER || 'fixture'),

    // ── AI. Blocked unless AU_LOCAL_ALLOW_AI=1 (start.sh then supplies the real key).
    ANTHROPIC_API_KEY: allowAi && o.ANTHROPIC_API_KEY ? o.ANTHROPIC_API_KEY : 'sk-ant-aulocal-dummy-not-a-real-key'
  };
  return env;
}

module.exports = {
  REPO_ROOT, AU_HOME, PORTS, PATHS, DB_NAME, GATEWAY_URL, APP_URL, TEST_PASSWORD, TEST_EMAIL_DOMAIN, STAFF,
  ensureDirs, loadSecrets, signJwt, verifyJwt, b64url, isLoopbackHost, buildServerEnv
};
