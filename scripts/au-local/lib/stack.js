#!/usr/bin/env node
'use strict';
/*
 * Process and database management for the local test stack.
 *   node stack.js setup-db      create the local database and load the snapshot
 *   node stack.js start-db      start Postgres + PostgREST + the gateway
 *   node stack.js start-app     start server.js behind the outbound trap
 *   node stack.js stop          stop everything
 *   node stack.js wipe          delete the local database, storage and outbox
 *   node stack.js status        say what is running
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cfg = require('./config.js');

const { PATHS, PORTS, DB_NAME } = cfg;
const PG_BIN = path.join(PATHS.pgNative, 'bin');
const PG_LIB = path.join(PATHS.pgNative, 'lib');

function say(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('\nSTOP: ' + msg + '\n'); process.exit(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pgClient(database) {
  const { Client } = require(path.join(cfg.AU_HOME, 'node_modules', 'pg'));
  return new Client({ host: '127.0.0.1', port: PORTS.postgres, user: 'postgres', database: database || DB_NAME });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}
async function waitForPort(port, label, ms) {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await sleep(250);
  }
  fail(label + ' did not start on port ' + port + '. See the logs in ' + PATHS.logs);
  return false;
}

function pidFile(name) { return path.join(PATHS.run, name + '.pid'); }
function readPid(name) {
  try {
    const pid = Number(fs.readFileSync(pidFile(name), 'utf8').trim());
    if (pid > 0) { process.kill(pid, 0); return pid; }
  } catch (e) { /* not running */ }
  return 0;
}
async function stopPid(name, label) {
  const pid = readPid(name);
  if (!pid) { try { fs.unlinkSync(pidFile(name)); } catch (e) { /* none */ } return false; }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { /* gone */ }
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch (e) { break; }
    await sleep(150);
    if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  }
  try { fs.unlinkSync(pidFile(name)); } catch (e) { /* none */ }
  say('  stopped ' + label);
  return true;
}
function startDetached(name, command, args, env, cwd) {
  const out = fs.openSync(path.join(PATHS.logs, name + '.log'), 'a');
  const child = spawn(command, args, { cwd: cwd || cfg.AU_HOME, env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(pidFile(name), String(child.pid));
  return child.pid;
}

// ── Postgres ──────────────────────────────────────────────────────────────────
function pgCtl(args, quiet) {
  const r = spawnSync(path.join(PG_BIN, 'pg_ctl'), args, { encoding: 'utf8', env: Object.assign({}, process.env, { DYLD_LIBRARY_PATH: PG_LIB }) });
  if (!quiet && r.status !== 0) say(String(r.stdout || '') + String(r.stderr || ''));
  return r.status === 0;
}
async function startPostgres() {
  if (!fs.existsSync(path.join(PATHS.pgData, 'PG_VERSION'))) fail('The local database has not been created. Run scripts/au-local/setup.sh first.');
  if (await portOpen(PORTS.postgres)) { say('  local Postgres is already running (port ' + PORTS.postgres + ')'); return; }
  const ok = pgCtl(['-D', PATHS.pgData, '-l', path.join(PATHS.logs, 'postgres.log'), '-w', '-t', '40', 'start',
    '-o', '-p ' + PORTS.postgres + ' -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c timezone=UTC -c log_min_messages=warning']);
  if (!ok) fail('Postgres did not start. See ' + path.join(PATHS.logs, 'postgres.log'));
  await waitForPort(PORTS.postgres, 'Postgres');
  say('  local Postgres started (port ' + PORTS.postgres + ')');
}
function stopPostgres() {
  if (!fs.existsSync(path.join(PATHS.pgData, 'PG_VERSION'))) return;
  if (pgCtl(['-D', PATHS.pgData, '-m', 'fast', '-w', 'stop'], true)) say('  stopped local Postgres');
}
function initDb() {
  if (fs.existsSync(path.join(PATHS.pgData, 'PG_VERSION'))) { say('  database folder already exists'); return; }
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) fail('Postgres binaries are missing. Run scripts/au-local/setup.sh.');
  const r = spawnSync(path.join(PG_BIN, 'initdb'),
    ['-D', PATHS.pgData, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale-provider=icu', '--icu-locale=en-US', '--locale=en_US.UTF-8'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { DYLD_LIBRARY_PATH: PG_LIB, TZ: 'UTC' }) });
  if (r.status !== 0) fail('Could not create the database folder:\n' + r.stdout + r.stderr);
  // Only this Mac may connect.
  fs.writeFileSync(path.join(PATHS.pgData, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n');
  say('  created a new empty Postgres 17 database folder');
}

// ── SQL loading ───────────────────────────────────────────────────────────────
function splitSections(sql) {
  const sections = [];
  let current = { name: 'preamble', startLine: 1, lines: [] };
  sql.split('\n').forEach((line, i) => {
    const m = /^-- @@section (\S+)/.exec(line);
    if (m) { sections.push(current); current = { name: m[1], startLine: i + 1, lines: [] }; }
    current.lines.push(line);
  });
  sections.push(current);
  return sections.filter((s) => s.lines.join('\n').replace(/--.*$/gm, '').trim());
}
async function runSqlFile(client, file, label) {
  const sql = fs.readFileSync(file, 'utf8');
  for (const s of splitSections(sql)) {
    const text = s.lines.join('\n');
    try {
      await client.query(text);
    } catch (err) {
      let where = '';
      if (err.position) where = ' (near line ' + (s.startLine + text.slice(0, Number(err.position)).split('\n').length - 1) + ' of ' + path.basename(file) + ')';
      throw new Error(label + ', section "' + s.name + '"' + where + ': ' + err.message);
    }
  }
}

const POST_SNAPSHOT_SQL = `
create unique index if not exists users_email_partial_key on auth.users (email) where is_sso_user = false;
grant all on all tables in schema auth, storage, aulocal to service_role;
grant select on all tables in schema storage to anon, authenticated;
-- Supabase reloads the API's picture of the schema after every structure change.
create or replace function extensions.pgrst_ddl_watch() returns event_trigger language plpgsql as $f$ begin notify pgrst, 'reload schema'; end $f$;
drop event trigger if exists pgrst_ddl_watch;
create event trigger pgrst_ddl_watch on ddl_command_end execute function extensions.pgrst_ddl_watch();
drop event trigger if exists pgrst_drop_watch;
create event trigger pgrst_drop_watch on sql_drop execute function extensions.pgrst_ddl_watch();
`;

async function assertLocalDatabase(client) {
  // Belt and braces: only ever operate on the throwaway database this stack made.
  const r = await client.query("select current_database() as db, inet_server_addr()::text as addr, (select value from aulocal.stack_info where key = 'marker') as marker");
  const row = r.rows[0] || {};
  if (row.db !== DB_NAME || !/^(127\.0\.0\.1|::1)/.test(String(row.addr || '')) || row.marker !== 'gplink-au-local-test-database') {
    throw new Error('The connected database is not the local test database. Refusing to continue.');
  }
}

async function setupDb() {
  cfg.ensureDirs();
  cfg.loadSecrets({ create: true });
  initDb();
  await startPostgres();
  const admin = pgClient('postgres');
  await admin.connect();
  const exists = await admin.query('select 1 from pg_database where datname = $1', [DB_NAME]);
  if (!exists.rowCount) {
    await admin.query('create database ' + DB_NAME);
    say('  created database "' + DB_NAME + '"');
  }
  await admin.end();

  const db = pgClient();
  await db.connect();
  try {
    await runSqlFile(db, PATHS.bootstrapSql, 'Local bootstrap');
    const has = await db.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
    if (has.rows[0].n > 0) {
      say('  the production-shaped schema is already loaded (' + has.rows[0].n + ' tables)');
    } else {
      say('  loading the production-shaped schema snapshot...');
      await runSqlFile(db, PATHS.schemaSql, 'Schema snapshot');
      await db.query(POST_SNAPSHOT_SQL);
      const n = await db.query(`select
          (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r')::int as tables,
          (select count(*) from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')::int as constraints,
          (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')::int as policies,
          (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')::int as functions`);
      const c = n.rows[0];
      say('  loaded: ' + c.tables + ' tables, ' + c.constraints + ' constraints, ' + c.policies + ' security policies, ' + c.functions + ' functions');
    }
    await assertLocalDatabase(db);
  } finally {
    await db.end();
  }
}

// ── PostgREST + gateway ───────────────────────────────────────────────────────
function writePostgrestConf() {
  const s = cfg.loadSecrets();
  fs.writeFileSync(PATHS.postgrestConf, [
    'db-uri = "postgres://authenticator@127.0.0.1:' + PORTS.postgres + '/' + DB_NAME + '"',
    'db-schemas = "public"',
    'db-anon-role = "anon"',
    'db-extra-search-path = "public, extensions"',
    'db-max-rows = 1000', // Supabase's default page cap
    'db-pool = 10',
    'jwt-secret = "' + s.jwtSecret + '"',
    'server-host = "127.0.0.1"',
    'server-port = ' + PORTS.postgrest,
    'log-level = "warn"',
    ''
  ].join('\n'), { mode: 0o600 });
}
async function startPostgrest() {
  if (!fs.existsSync(PATHS.postgrestBin)) fail('PostgREST is missing. Run scripts/au-local/setup.sh.');
  await stopPid('postgrest', 'PostgREST');
  writePostgrestConf();
  startDetached('postgrest', PATHS.postgrestBin, [PATHS.postgrestConf], { PATH: '/usr/bin:/bin', HOME: process.env.HOME, DYLD_LIBRARY_PATH: PG_LIB });
  await waitForPort(PORTS.postgrest, 'PostgREST');
  say('  PostgREST started (port ' + PORTS.postgrest + ', internal)');
}
async function startGateway() {
  await stopPid('gateway', 'gateway');
  if (await portOpen(PORTS.gateway)) fail('Port ' + PORTS.gateway + ' is already in use by another program.');
  startDetached('gateway', process.execPath, [path.join(__dirname, '..', 'gateway.js')],
    { PATH: process.env.PATH, HOME: process.env.HOME, AU_LOCAL_HOME: cfg.AU_HOME, AU_LOCAL_ALLOW_AI: process.env.AU_LOCAL_ALLOW_AI === '1' ? '1' : '0', TZ: 'UTC' });
  await waitForPort(PORTS.gateway, 'Gateway');
  say('  gateway started (' + cfg.GATEWAY_URL + ')');
}

function readRealAnthropicKey() {
  // Only reached when the person explicitly ran AU_LOCAL_ALLOW_AI=1.
  const file = process.env.AU_LOCAL_PROD_ENV_FILE || '/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env';
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* none */ }
  return '';
}

async function startApp() {
  await stopPid('app', 'the app server');
  if (await portOpen(PORTS.app)) fail('Port ' + PORTS.app + ' is already in use. Another copy of the app may be running; stop it first.');
  const allowAi = process.env.AU_LOCAL_ALLOW_AI === '1';
  const overrides = { AU_PATHWAY_ENABLED: process.env.AU_PATHWAY_ENABLED || 'true', AU_LOCAL_ALLOW_AI: allowAi ? '1' : '0', AHPRA_LOOKUP_PROVIDER: process.env.AHPRA_LOOKUP_PROVIDER || '' };
  // WP-30: `AU_WORKFORCE_LOCATOR_PROVIDER=none scripts/au-local/start.sh` turns the area look-up off. Only
  // `none` or `fixture` is accepted here: the real provider is never used on this Mac.
  if (process.env.AU_WORKFORCE_LOCATOR_PROVIDER === 'none' || process.env.AU_WORKFORCE_LOCATOR_PROVIDER === 'fixture') {
    overrides.AU_WORKFORCE_LOCATOR_PROVIDER = process.env.AU_WORKFORCE_LOCATOR_PROVIDER;
  }
  if (allowAi) {
    overrides.ANTHROPIC_API_KEY = readRealAnthropicKey();
    if (!overrides.ANTHROPIC_API_KEY) fail('AU_LOCAL_ALLOW_AI=1 was requested but no Anthropic key was found in the main folder .env.');
  }
  const env = cfg.buildServerEnv(overrides);
  // Final check before anything starts: the app may only ever see the local gateway.
  let host = '';
  try { host = new URL(env.SUPABASE_URL).hostname; } catch (e) { host = ''; }
  if (!cfg.isLoopbackHost(host) || Number(new URL(env.SUPABASE_URL).port) !== PORTS.gateway) {
    fail('SUPABASE_URL is not the local gateway. Refusing to start the app.');
  }
  const preload = path.join(__dirname, '..', 'preload.js');
  env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
  startDetached('app', process.execPath, ['--require', preload, 'server.js'], env, cfg.REPO_ROOT);
  await waitForPort(PORTS.app, 'The app server', 60000);
  // Ask the running server what it is connected to.
  let health = null;
  for (let i = 0; i < 20 && !health; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORTS.app + '/api/health');
      if (r.ok) health = await r.json();
    } catch (e) { /* not ready */ }
    if (!health) await sleep(500);
  }
  if (!health) fail('The app server started but /api/health did not answer. See ' + path.join(PATHS.logs, 'app.log'));
  say('  app server started (' + cfg.APP_URL + ')' + (allowAi ? '  [AI calls ALLOWED: test content is sent to Anthropic]' : ''));
  say('  Australian pathway switch: ' + (env.AU_PATHWAY_ENABLED === 'false' ? 'OFF' : 'ON'));
  say('  Ahpra register lookup: ' + (env.AHPRA_LOOKUP_PROVIDER === 'fixture' ? 'ON, made-up test numbers only (fixture)' : 'OFF'));
  say('  Area look-up (WP-30): ' + (env.AU_WORKFORCE_LOCATOR_PROVIDER === 'fixture' ? 'test data (no network)' : 'OFF'));
}

async function stopAll() {
  await stopPid('app', 'the app server');
  await stopPid('gateway', 'gateway');
  await stopPid('postgrest', 'PostgREST');
  stopPostgres();
}

async function wipe() {
  // Refuse unless the thing being wiped is unmistakably the local stack.
  const home = path.resolve(cfg.AU_HOME);
  if (!/gplink-tools\/au-local/.test(home)) fail('The data folder (' + home + ') does not look like the local test stack. Refusing to wipe.');
  if (fs.existsSync(path.join(PATHS.pgData, 'PG_VERSION'))) {
    await startPostgres();
    const db = pgClient();
    try {
      await db.connect();
      await assertLocalDatabase(db);
    } catch (err) {
      if (!/does not exist/.test(String(err.message))) fail(err.message);
    } finally {
      try { await db.end(); } catch (e) { /* closed */ }
    }
  }
  await stopAll();
  for (const p of [PATHS.pgData, PATHS.storage, PATHS.outboxFiles, PATHS.appData]) {
    if (path.resolve(p).startsWith(home + path.sep)) fs.rmSync(p, { recursive: true, force: true });
  }
  fs.rmSync(PATHS.outbox, { force: true });
  say('  wiped the local database, stored files and Outbox');
}

async function status() {
  const rows = [['Postgres', PORTS.postgres], ['PostgREST', PORTS.postgrest], ['Gateway', PORTS.gateway], ['App server', PORTS.app]];
  for (const [label, port] of rows) say('  ' + label.padEnd(11) + (await portOpen(port) ? 'running' : 'stopped') + '  (port ' + port + ')');
}

if (require.main === module) (async () => {
  const cmd = process.argv[2];
  cfg.ensureDirs();
  if (cmd === 'setup-db') await setupDb();
  else if (cmd === 'start-db') { await startPostgres(); await startPostgrest(); await startGateway(); }
  else if (cmd === 'start-app') await startApp();
  else if (cmd === 'stop') await stopAll();
  else if (cmd === 'wipe') await wipe();
  else if (cmd === 'status') await status();
  else fail('Unknown command: ' + cmd);
})().catch((err) => fail(err && err.message ? err.message : String(err)));

module.exports = { pgClient, runSqlFile, assertLocalDatabase, say, fail };
