#!/usr/bin/env node

/**
 * GP Link — Restore Backup Script
 *
 * Reads a .json.gz backup (produced by /api/cron/weekly-backup) and restores
 * all tables to Supabase via the REST/PostgREST API.
 *
 * Usage:
 *   node scripts/restore-backup.js ./gp-link-backup-2026-05-29.json.gz
 *
 * Flags:
 *   --supabase-url <url>    Supabase project URL  (or env / .env.local)
 *   --supabase-key <key>    Service-role key       (or env / .env.local)
 *   --dry-run               Show what would happen without modifying data
 *   --table <name>          Restore only this table (repeatable)
 *   --show-env              Print backed-up env vars and exit
 *   --help                  Show this help text
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

// ── Helpers ──────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
GP Link — Restore Backup
=========================

Usage:
  node scripts/restore-backup.js <backup.json.gz> [options]

Options:
  --supabase-url <url>   Supabase project URL
  --supabase-key <key>   Supabase service-role key
  --dry-run              Preview restore without modifying anything
  --table <name>         Restore only specific table(s) (repeatable)
  --show-env             Print backed-up env vars and exit
  --help                 Show this help text

If --supabase-url / --supabase-key are not provided the script reads
SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local or .env in
the project root.
`.trim());
}

function parseArgs(argv) {
  const args = {
    file: null,
    supabaseUrl: null,
    supabaseKey: null,
    dryRun: false,
    tables: [],
    showEnv: false,
    help: false
  };

  let i = 2; // skip node + script path
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--show-env') { args.showEnv = true; }
    else if (a === '--supabase-url' && argv[i + 1]) { args.supabaseUrl = argv[++i]; }
    else if (a === '--supabase-key' && argv[i + 1]) { args.supabaseKey = argv[++i]; }
    else if (a === '--table' && argv[i + 1]) { args.tables.push(argv[++i]); }
    else if (!a.startsWith('-') && !args.file) { args.file = a; }
    else {
      console.error('Unknown option or missing argument: ' + a);
      process.exit(1);
    }
    i++;
  }

  return args;
}

/** Read key=value pairs from a dotenv-style file (no interpolation). */
function loadDotenv(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

function resolveSupabaseCreds(args) {
  let url = args.supabaseUrl || process.env.SUPABASE_URL;
  let key = args.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const projectRoot = path.resolve(__dirname, '..');
    const envLocal = loadDotenv(path.join(projectRoot, '.env.local'));
    const envFile = loadDotenv(path.join(projectRoot, '.env'));
    url = url || envLocal.SUPABASE_URL || envFile.SUPABASE_URL;
    key = key || envLocal.SUPABASE_SERVICE_ROLE_KEY || envFile.SUPABASE_SERVICE_ROLE_KEY;
  }

  return { url, key };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(function (resolve) {
    rl.question(question, function (answer) {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Supabase REST helpers ────────────────────────────────────────────────────

async function supabaseRequest(baseUrl, serviceKey, tableName, query, options) {
  const queryPart = query ? '?' + query : '';
  const url = baseUrl.replace(/\/+$/, '') + '/rest/v1/' + tableName + queryPart;
  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey
  };
  if (options && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options && options.extraHeaders) {
    Object.assign(headers, options.extraHeaders);
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 30000);
  try {
    const resp = await fetch(url, {
      method: (options && options.method) || 'GET',
      signal: controller.signal,
      headers: headers,
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const text = await resp.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = text; }
    }
    return { ok: resp.ok, status: resp.status, data: data };
  } catch (err) {
    return { ok: false, status: 0, data: { message: err.message } };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Table ordering ───────────────────────────────────────────────────────────

// Child-first order — delete in this order, insert in reverse.
const DELETE_ORDER = [
  'task_documents', 'task_messages', 'task_timeline',
  'ahpra_case_documents', 'ahpra_events', 'ahpra_notifications', 'ahpra_required_documents',
  'visa_documents', 'visa_questionnaires', 'visa_updates', 'visa_timeline_events', 'visa_dependants',
  'pbs_documents', 'pbs_updates', 'pbs_timeline_events',
  'nudge_chat_messages', 'user_nudges',
  'practice_doc_ops', 'commencement_items',
  'career_hero_city_images', 'career_suburb_geo_cache',
  'gp_applications', 'career_interviews', 'pending_hires',
  'registration_tasks',
  'user_documents', 'support_tickets',
  'registration_cases', 'ahpra_cases',
  'visa_applications', 'pbs_applications',
  'career_roles', 'career_hero_cities',
  'doubletick_messages',
  'gmail_watch_state', 'processed_gmail_messages',
  'zoho_sign_envelopes', 'processed_zoho_sign_events',
  'incoming_email_todos',
  'document_templates', 'integration_connections',
  'system_bugs', 'client_errors',
  'guide_items', 'guide_folders',
  'runtime_kv',
  'user_state', 'user_roles', 'user_profiles'
];

const INSERT_ORDER = DELETE_ORDER.slice().reverse();

// Map of known primary key columns for tables that don't use `id`.
const PK_OVERRIDES = {
  runtime_kv: 'key',
  user_state: 'user_id',
  user_roles: 'user_id',
  gmail_watch_state: 'key'
};

// ── Delete phase ─────────────────────────────────────────────────────────────

async function deleteTable(baseUrl, serviceKey, table, dryRun) {
  if (dryRun) {
    console.log('  [dry-run] Would delete all rows from: ' + table);
    return { ok: true };
  }

  // Build a list of tautology filters to try.
  // The Supabase REST API requires a filter on DELETE requests.
  const pk = PK_OVERRIDES[table];
  var filters;
  if (pk === 'key') {
    filters = [
      'key=neq.___none___',
      'id=neq.00000000-0000-0000-0000-000000000000'
    ];
  } else if (pk === 'user_id') {
    filters = [
      'user_id=neq.00000000-0000-0000-0000-000000000000',
      'id=neq.00000000-0000-0000-0000-000000000000'
    ];
  } else {
    filters = [
      'id=neq.00000000-0000-0000-0000-000000000000',
      'key=neq.___none___',
      'user_id=neq.00000000-0000-0000-0000-000000000000'
    ];
  }

  for (var filter of filters) {
    var res = await supabaseRequest(baseUrl, serviceKey, table, filter, { method: 'DELETE' });
    if (res.ok) {
      return { ok: true };
    }
    // 404 typically means the column doesn't exist — try next filter
    if (res.status === 404 || res.status === 400) {
      continue;
    }
    // Other errors: log but don't hard-fail
    console.warn('  [warn] DELETE ' + table + ' (' + filter + '): HTTP ' + res.status);
  }

  // If all filters failed, log but treat as non-fatal (table may not exist or be empty)
  console.warn('  [warn] Could not delete rows from ' + table + ' (tried all filters). Continuing.');
  return { ok: true, warning: 'delete filters exhausted' };
}

// ── Insert phase ─────────────────────────────────────────────────────────────

async function insertTable(baseUrl, serviceKey, table, rows, dryRun) {
  if (!rows || rows.length === 0) {
    if (dryRun) {
      console.log('  [dry-run] ' + table + ': 0 rows (skip)');
    }
    return { ok: true, inserted: 0 };
  }

  if (dryRun) {
    console.log('  [dry-run] Would insert ' + rows.length + ' row(s) into: ' + table);
    return { ok: true, inserted: rows.length };
  }

  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);

    // Try with merge-duplicates first (handles potential PK conflicts)
    let res = await supabaseRequest(baseUrl, serviceKey, table, '', {
      method: 'POST',
      body: batch,
      extraHeaders: { Prefer: 'return=minimal,resolution=merge-duplicates' }
    });

    if (!res.ok) {
      // Retry without resolution=merge-duplicates
      res = await supabaseRequest(baseUrl, serviceKey, table, '', {
        method: 'POST',
        body: batch,
        extraHeaders: { Prefer: 'return=minimal' }
      });
    }

    if (!res.ok) {
      const errMsg = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      return { ok: false, inserted: inserted, error: 'HTTP ' + res.status + ' at batch offset ' + offset + ': ' + errMsg };
    }

    inserted += batch.length;
  }

  return { ok: true, inserted: inserted };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.file) {
    console.error('Error: No backup file specified.\n');
    printHelp();
    process.exit(1);
  }

  // ── Read & decompress ───────────────────────────────────────────────────

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error('Error: File not found: ' + filePath);
    process.exit(1);
  }

  console.log('Reading backup: ' + filePath);
  const compressed = fs.readFileSync(filePath);
  let json;
  try {
    const decompressed = zlib.gunzipSync(compressed);
    json = JSON.parse(decompressed.toString('utf8'));
  } catch (err) {
    console.error('Error: Could not decompress/parse backup file.');
    console.error('  ' + err.message);
    process.exit(1);
  }

  const manifest = json.manifest || {};
  const envVars = json.env_vars || {};
  const tables = json.tables || {};

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('');
  console.log('=== Backup Summary ===');
  console.log('  Date:        ' + (manifest.timestamp || 'unknown'));
  console.log('  Git commit:  ' + (manifest.git_commit || 'unknown'));
  console.log('  Git branch:  ' + (manifest.git_branch || 'unknown'));
  console.log('  Environment: ' + (manifest.vercel_env || 'unknown'));
  console.log('  Node:        ' + (manifest.node_version || 'unknown'));
  console.log('  Version:     ' + (manifest.version || 'unknown'));
  console.log('  Total rows:  ' + (manifest.total_rows || 0));
  console.log('  Tables:      ' + (manifest.tables_backed_up || Object.keys(tables).length));
  if (manifest.errors && manifest.errors.length > 0) {
    console.log('  Errors:      ' + manifest.errors.length);
    for (const e of manifest.errors) {
      console.log('    - ' + e.table + ': ' + e.error);
    }
  }
  console.log('');

  // ── Table row counts ────────────────────────────────────────────────────

  const tableCounts = manifest.table_counts || {};
  console.log('Table row counts:');
  const sortedTables = Object.keys(tableCounts).sort();
  let maxNameLen = 0;
  for (const t of sortedTables) {
    if (t.length > maxNameLen) maxNameLen = t.length;
  }
  for (const t of sortedTables) {
    const count = tableCounts[t];
    console.log('  ' + t.padEnd(maxNameLen + 2) + count);
  }
  console.log('');

  // ── --show-env ──────────────────────────────────────────────────────────

  if (args.showEnv) {
    console.log('=== Backed-up Environment Variables ===');
    const envKeys = Object.keys(envVars).sort();
    if (envKeys.length === 0) {
      console.log('  (none)');
    } else {
      for (const k of envKeys) {
        // Mask sensitive values
        const val = envVars[k];
        const masked = val && val.length > 8 ? val.slice(0, 4) + '...' + val.slice(-4) : '****';
        console.log('  ' + k + '=' + masked);
      }
    }
    console.log('');
    console.log('Total: ' + envKeys.length + ' env vars');
    process.exit(0);
  }

  // ── Resolve Supabase credentials ────────────────────────────────────────

  const creds = resolveSupabaseCreds(args);

  if (!creds.url || !creds.key) {
    console.error('Error: Supabase credentials not found.');
    console.error('Provide --supabase-url and --supabase-key, or set SUPABASE_URL and');
    console.error('SUPABASE_SERVICE_ROLE_KEY in your environment or .env.local / .env file.');
    process.exit(1);
  }

  console.log('Supabase URL: ' + creds.url);
  console.log('');

  // ── Determine which tables to restore ───────────────────────────────────

  let tablesToRestore;
  if (args.tables.length > 0) {
    // Validate requested tables exist in backup
    const missing = args.tables.filter(function (t) { return !tables[t]; });
    if (missing.length > 0) {
      console.error('Error: These tables are not in the backup: ' + missing.join(', '));
      console.error('Available tables: ' + Object.keys(tables).sort().join(', '));
      process.exit(1);
    }
    tablesToRestore = args.tables;
    console.log('Restoring ' + tablesToRestore.length + ' selected table(s): ' + tablesToRestore.join(', '));
  } else {
    tablesToRestore = Object.keys(tables);
    console.log('Restoring all ' + tablesToRestore.length + ' tables from backup.');
  }
  console.log('');

  // ── Dry run ─────────────────────────────────────────────────────────────

  if (args.dryRun) {
    console.log('=== DRY RUN — no changes will be made ===');
    console.log('');

    console.log('Phase 1: DELETE (child-first order)');
    const deleteList = DELETE_ORDER.filter(function (t) { return tablesToRestore.includes(t); });
    // Also handle any tables in backup but not in our known order
    const extraTables = tablesToRestore.filter(function (t) { return !DELETE_ORDER.includes(t); });
    const fullDeleteList = deleteList.concat(extraTables);
    for (const t of fullDeleteList) {
      console.log('  [dry-run] Would delete all rows from: ' + t);
    }
    console.log('');

    console.log('Phase 2: INSERT (parent-first order)');
    const insertList = INSERT_ORDER.filter(function (t) { return tablesToRestore.includes(t); });
    const fullInsertList = extraTables.concat(insertList);
    for (const t of fullInsertList) {
      const rows = tables[t] || [];
      console.log('  [dry-run] Would insert ' + rows.length + ' row(s) into: ' + t);
    }
    console.log('');
    console.log('Dry run complete. No data was modified.');
    process.exit(0);
  }

  // ── Confirmation prompt ─────────────────────────────────────────────────

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  WARNING: This will DELETE all existing data in the target  ║');
  console.log('║  tables and replace it with the backup data.               ║');
  console.log('║                                                            ║');
  console.log('║  Target: ' + creds.url.padEnd(51) + '║');
  console.log('║  Tables: ' + String(tablesToRestore.length).padEnd(51) + '║');
  console.log('║  Rows:   ' + String(manifest.total_rows || 0).padEnd(51) + '║');
  console.log('║                                                            ║');
  console.log('║  Type RESTORE to confirm, or anything else to cancel.      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const confirmation = await ask('> ');
  if (confirmation.trim() !== 'RESTORE') {
    console.log('Cancelled.');
    process.exit(0);
  }

  console.log('');

  // ── Phase 1: DELETE ─────────────────────────────────────────────────────

  const startTime = Date.now();
  console.log('Phase 1: Deleting existing data (child-first order)...');

  const deleteList = DELETE_ORDER.filter(function (t) { return tablesToRestore.includes(t); });
  const extraTables = tablesToRestore.filter(function (t) { return !DELETE_ORDER.includes(t); });
  const fullDeleteList = deleteList.concat(extraTables);

  let deleteErrors = 0;
  for (const t of fullDeleteList) {
    process.stdout.write('  Deleting ' + t + '... ');
    const res = await deleteTable(creds.url, creds.key, t, false);
    if (res.ok) {
      console.log('OK' + (res.warning ? ' (' + res.warning + ')' : ''));
    } else {
      console.log('FAILED');
      deleteErrors++;
    }
  }

  console.log('');
  console.log('Delete phase complete. ' + (deleteErrors > 0 ? deleteErrors + ' error(s).' : 'All OK.'));
  console.log('');

  // ── Phase 2: INSERT ─────────────────────────────────────────────────────

  console.log('Phase 2: Inserting backup data (parent-first order)...');

  const insertList = INSERT_ORDER.filter(function (t) { return tablesToRestore.includes(t); });
  const fullInsertList = extraTables.concat(insertList);

  let insertErrors = 0;
  const results = [];

  for (const t of fullInsertList) {
    const rows = tables[t] || [];
    process.stdout.write('  Inserting ' + t + ' (' + rows.length + ' rows)... ');
    const res = await insertTable(creds.url, creds.key, t, rows, false);
    if (res.ok) {
      console.log('OK (' + res.inserted + ' inserted)');
      results.push({ table: t, status: 'OK', inserted: res.inserted });
    } else {
      console.log('FAILED');
      console.log('    Error: ' + (res.error || 'unknown'));
      insertErrors++;
      results.push({ table: t, status: 'FAILED', inserted: res.inserted || 0, error: res.error });
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('=== Restore Complete ===');
  console.log('  Duration:       ' + elapsed + 's');
  console.log('  Tables:         ' + results.length);
  console.log('  Succeeded:      ' + results.filter(function (r) { return r.status === 'OK'; }).length);
  console.log('  Failed:         ' + results.filter(function (r) { return r.status === 'FAILED'; }).length);
  console.log('  Total inserted: ' + results.reduce(function (sum, r) { return sum + r.inserted; }, 0));
  console.log('');

  if (insertErrors > 0 || deleteErrors > 0) {
    console.log('Some tables had errors. Review the output above for details.');
    console.log('');
    for (const r of results) {
      if (r.status === 'FAILED') {
        console.log('  FAILED: ' + r.table + ' — ' + r.error);
      }
    }
    process.exit(1);
  }

  console.log('All tables restored successfully.');
  process.exit(0);
}

main().catch(function (err) {
  console.error('Fatal error: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
