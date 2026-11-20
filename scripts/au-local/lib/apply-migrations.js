#!/usr/bin/env node
'use strict';
/*
 * Applies supabase/migrations/*au_gp* files to the LOCAL database, in filename
 * order, remembering what has been applied, and prints what each one added.
 *
 * Each file is run through the database's own public.exec_sql() function, the
 * same route used to apply migrations to production (it runs with an EMPTY
 * search path, so an object name missing its "public." prefix fails here
 * exactly as it would live).
 *
 *   --redo    apply every au_gp file again (proves they are safe to re-run)
 *   --quiet   say nothing when there is nothing new
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config.js');
const { pgClient, assertLocalDatabase } = require('./stack.js');

const REDO = process.argv.includes('--redo');
const QUIET = process.argv.includes('--quiet');
function say(msg) { process.stdout.write(msg + '\n'); }

const SHAPE_SQL = `
select 'column' as kind, c.table_name || '.' || c.column_name as name,
       c.data_type || case when c.is_nullable = 'NO' then ' NOT NULL' else '' end || coalesce(' default ' || c.column_default, '') as detail
  from information_schema.columns c where c.table_schema = 'public'
union all
select 'constraint', cl.relname || ' : ' || k.conname, pg_get_constraintdef(k.oid, true)
  from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public'
union all
select 'index', ic.relname, pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = ic.relnamespace where n.nspname = 'public'
union all
select 'table', c.relname, case when c.relrowsecurity then 'row-level security ON' else 'row-level security off' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f','p')
union all
select 'policy', c.relname || ' : ' || pol.polname, coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' / ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
  from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
union all
select 'trigger', c.relname || ' : ' || t.tgname, pg_get_triggerdef(t.oid, true)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal
`;

async function shape(db) {
  const r = await db.query(SHAPE_SQL);
  const map = new Map();
  for (const row of r.rows) map.set(row.kind + '|' + row.name, row.detail);
  return map;
}

function printDiff(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push([k, v]);
    else if (before.get(k) !== v) changed.push([k, before.get(k), v]);
  }
  for (const [k, v] of before) if (!after.has(k)) removed.push([k, v]);
  const label = (k) => { const i = k.indexOf('|'); return k.slice(0, i).padEnd(10) + ' ' + k.slice(i + 1); };
  if (!added.length && !changed.length && !removed.length) { say('      (no change to the structure)'); return; }
  for (const [k, v] of added) say('      + ' + label(k) + '   ' + String(v).slice(0, 400));
  for (const [k, a, b] of changed) {
    say('      ~ ' + label(k));
    if (k.startsWith('function|')) say('          (definition changed)');
    else { say('          was: ' + String(a).slice(0, 600)); say('          now: ' + String(b).slice(0, 600)); }
  }
  for (const [k, v] of removed) say('      - ' + label(k) + '   ' + String(v).slice(0, 200) + '   <-- REMOVED: migrations for this build must be additive only');
}

(async () => {
  let files = [];
  try {
    files = fs.readdirSync(cfg.PATHS.migrationsDir).filter((f) => /au_gp/i.test(f) && /\.sql$/i.test(f)).sort();
  } catch (e) { files = []; }

  const db = pgClient();
  try {
    await db.connect();
  } catch (e) {
    process.stderr.write('STOP: the local database is not running or not set up (' + e.message + '). Run scripts/au-local/setup.sh\n');
    process.exit(1);
  }
  try {
    await assertLocalDatabase(db);
    const appliedRows = await db.query('select filename, checksum from aulocal.applied_migrations');
    const applied = new Map(appliedRows.rows.map((r) => [r.filename, r.checksum]));

    if (!files.length) {
      if (!QUIET) say('  no files named *au_gp* in supabase/migrations yet. Nothing to apply.');
      return;
    }
    let ran = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(cfg.PATHS.migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const was = applied.get(file);
      if (was === checksum && !REDO) { if (!QUIET) say('  already applied: ' + file); continue; }
      say('  applying: ' + file + (was && was !== checksum ? '   (the file has CHANGED since it was last applied; applying it again)' : (was ? '   (again, --redo)' : '')));
      const before = await shape(db);
      try {
        await db.query('select public.exec_sql($1)', [sql]);
      } catch (err) {
        say('');
        say('    FAILED: ' + err.message);
        if (err.where) say('    where: ' + String(err.where).split('\n')[0]);
        say('    Nothing from this file was kept (it ran as one transaction). Files after it were not attempted.');
        say('    Hint: migrations run with an empty search path, as on production. Every table and function');
        say('    needs its "public." prefix, and BEGIN / COMMIT cannot be used inside the file.');
        process.exitCode = 1;
        return;
      }
      await db.query(
        'insert into aulocal.applied_migrations (filename, checksum) values ($1, $2) on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()',
        [file, checksum]);
      printDiff(before, await shape(db));
      ran++;
    }
    if (ran) {
      await db.query("notify pgrst, 'reload schema'");
      say('  ' + ran + ' migration file(s) applied to the LOCAL database. Production was not touched.');
    } else if (!QUIET) {
      say('  nothing new to apply (' + files.length + ' au_gp file(s) already applied).');
    }
  } finally {
    await db.end();
  }
})().catch((err) => {
  process.stderr.write('apply-migrations failed: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
