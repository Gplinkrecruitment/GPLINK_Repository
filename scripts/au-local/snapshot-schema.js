#!/usr/bin/env node
'use strict';
/*
 * snapshot-schema.js
 *
 * Reads the STRUCTURE of production's `public` schema (no row data) and writes
 * it as SQL to scripts/au-local/schema/prod-schema.sql, so a private local
 * Postgres can be built with the same shape as the live database.
 *
 * READ-ONLY BY CONSTRUCTION
 *   - Every statement sent is a SELECT over pg_catalog, wrapped in a DO block
 *     that (1) switches the transaction to read-only, then (2) ends by raising
 *     an exception carrying the result. The exception rolls the transaction
 *     back, so nothing could persist even if a statement tried to write.
 *   - assertReadOnly() refuses to send any SQL containing a writing keyword.
 *   - No query touches a user table. Only catalog metadata is read.
 *
 * Usage:
 *   node scripts/au-local/snapshot-schema.js            # rewrite the snapshot
 *   node scripts/au-local/snapshot-schema.js --check    # report differences only
 *   node scripts/au-local/snapshot-schema.js --verify-local   # compare production's structure with the LOCAL database's
 *
 * Credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from the
 * main checkout's .env (override the path with AU_LOCAL_PROD_ENV_FILE). They are
 * never printed and never written anywhere.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'schema');
const OUT_FILE = path.join(OUT_DIR, 'prod-schema.sql');
const META_FILE = path.join(OUT_DIR, 'prod-schema.meta.json');
const DEFAULT_ENV_FILE = '/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.env';
const ENV_FILE = process.env.AU_LOCAL_PROD_ENV_FILE || DEFAULT_ENV_FILE;
const MARK = 'AULOCAL_RESULT:';

function say(msg) { process.stdout.write(msg + '\n'); }

function readEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new Error('Cannot read the production env file at ' + file + ' (set AU_LOCAL_PROD_ENV_FILE).');
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const WRITE_WORDS = /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|comment|copy|call|vacuum|reindex|refresh|nextval|setval|merge|lock|notify|listen|execute|prepare|import|security\s+label|reassign|cluster|checkpoint|discard|load)\b/i;
function assertReadOnly(sql) {
  const m = WRITE_WORDS.exec(sql);
  if (m) throw new Error('Refusing to send SQL containing the keyword "' + m[1] + '". This script is read-only.');
  if (!/^\s*select\b/i.test(sql)) throw new Error('Refusing to send SQL that does not start with SELECT.');
}

let PROD = null;
async function probe(selectSql) {
  assertReadOnly(selectSql);
  if (!PROD) {
    const env = readEnvFile(ENV_FILE);
    const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from ' + ENV_FILE);
    PROD = { url, key };
  }
  const wrapped =
    'do $aulocal$ declare _aulocal_out text; begin ' +
    "perform pg_catalog.set_config('transaction_read_only','on',true); " +
    'select (' + selectSql + ')::text into _aulocal_out; ' +
    "raise exception using message = '" + MARK + "' || coalesce(_aulocal_out, 'null'); " +
    'end $aulocal$;';
  const resp = await fetch(PROD.url + '/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: {
      apikey: PROD.key,
      Authorization: 'Bearer ' + PROD.key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: wrapped })
  });
  const body = await resp.json().catch(() => null);
  const message = body && typeof body.message === 'string' ? body.message : '';
  if (!message.startsWith(MARK)) {
    throw new Error('Schema read failed (HTTP ' + resp.status + '): ' + (message || JSON.stringify(body)).slice(0, 400));
  }
  return JSON.parse(message.slice(MARK.length));
}

// The same questions, asked of the LOCAL test database (for --verify-local).
let LOCAL_DB = null;
async function localProbe(selectSql) {
  assertReadOnly(selectSql);
  if (!LOCAL_DB) {
    const cfg = require('./lib/config.js');
    const { Client } = require(path.join(cfg.AU_HOME, 'node_modules', 'pg'));
    LOCAL_DB = new Client({ host: '127.0.0.1', port: cfg.PORTS.postgres, user: 'postgres', database: cfg.DB_NAME });
    await LOCAL_DB.connect();
    // Production is read through exec_sql, which runs with an empty search
    // path; match it so object names are printed with the same prefixes.
    await LOCAL_DB.query("select pg_catalog.set_config('search_path', '', false)");
  }
  const r = await LOCAL_DB.query('select (' + selectSql + ')::text as v');
  return JSON.parse(r.rows[0].v);
}

// ── Catalog queries (each returns one JSON value) ─────────────────────────────
const NS = "(select oid from pg_catalog.pg_namespace where nspname = 'public')";
const NOT_EXT = (cls, col) =>
  'not exists (select 1 from pg_catalog.pg_depend d where d.classid = ' + "'" + cls + "'::pg_catalog.regclass" +
  ' and d.objid = ' + col + " and d.deptype = 'e')";

const Q = {
  meta: `select pg_catalog.json_build_object(
      'version', pg_catalog.version(),
      'version_num', pg_catalog.current_setting('server_version_num'),
      'collation', (select pg_catalog.json_build_object('collate', d.datcollate, 'ctype', d.datctype, 'provider', d.datlocprovider, 'encoding', pg_catalog.pg_encoding_to_char(d.encoding))
                      from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()),
      'timezone', pg_catalog.current_setting('TimeZone'),
      'extensions', (select pg_catalog.json_agg(pg_catalog.json_build_object('name', e.extname, 'schema', n.nspname, 'version', e.extversion) order by e.extname)
                       from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace),
      'roles', (select pg_catalog.json_agg(pg_catalog.json_build_object('name', r.rolname, 'bypassrls', r.rolbypassrls, 'inherit', r.rolinherit, 'login', r.rolcanlogin, 'config', r.rolconfig) order by r.rolname)
                  from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')),
      'schemas', (select pg_catalog.json_agg(n.nspname order by n.nspname) from pg_catalog.pg_namespace n
                   where n.nspname !~ '^pg_' and n.nspname <> 'information_schema')
    )`,

  enums: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', t.typname,
      'labels', (select pg_catalog.json_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid = t.oid)
    ) order by t.typname), '[]'::json)
    from pg_catalog.pg_type t where t.typnamespace = ${NS} and t.typtype = 'e' and ${NOT_EXT('pg_catalog.pg_type', 't.oid')}`,

  domains: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', t.typname,
      'base', pg_catalog.format_type(t.typbasetype, t.typtypmod),
      'notnull', t.typnotnull,
      'default', t.typdefault,
      'checks', (select pg_catalog.json_agg(pg_catalog.pg_get_constraintdef(c.oid, true)) from pg_catalog.pg_constraint c where c.contypid = t.oid)
    ) order by t.typname), '[]'::json)
    from pg_catalog.pg_type t where t.typnamespace = ${NS} and t.typtype = 'd' and ${NOT_EXT('pg_catalog.pg_type', 't.oid')}`,

  composites: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', t.typname,
      'attrs', (select pg_catalog.json_agg(pg_catalog.json_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                  from pg_catalog.pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped)
    ) order by t.typname), '[]'::json)
    from pg_catalog.pg_type t join pg_catalog.pg_class c on c.oid = t.typrelid
    where t.typnamespace = ${NS} and t.typtype = 'c' and c.relkind = 'c' and ${NOT_EXT('pg_catalog.pg_type', 't.oid')}`,

  sequences: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', c.relname,
      'type', pg_catalog.format_type(s.seqtypid, null),
      'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text,
      'cache', s.seqcache::text, 'cycle', s.seqcycle,
      'owned_by', (select pg_catalog.json_build_object('table', tc.relname, 'column', ta.attname, 'deptype', d.deptype)
                     from pg_catalog.pg_depend d
                     join pg_catalog.pg_class tc on tc.oid = d.refobjid
                     join pg_catalog.pg_attribute ta on ta.attrelid = d.refobjid and ta.attnum = d.refobjsubid
                    where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and d.objid = c.oid and d.deptype in ('a','i') limit 1)
    ) order by c.relname), '[]'::json)
    from pg_catalog.pg_class c join pg_catalog.pg_sequence s on s.seqrelid = c.oid
    where c.relnamespace = ${NS} and c.relkind = 'S'`,

  tables: (schemaName, onlyTable) => `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', c.relname,
      'kind', c.relkind,
      'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity,
      'partition_key', case when c.relkind = 'p' then pg_catalog.pg_get_partkeydef(c.oid) else null end,
      'columns', (select pg_catalog.json_agg(pg_catalog.json_build_object(
            'name', a.attname,
            'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
            'notnull', a.attnotnull,
            'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid),
            'identity', a.attidentity,
            'generated', a.attgenerated,
            'collation', (select cn.nspname || '.' || co.collname from pg_catalog.pg_collation co join pg_catalog.pg_namespace cn on cn.oid = co.collnamespace
                           join pg_catalog.pg_type ty on ty.oid = a.atttypid
                          where co.oid = a.attcollation and a.attcollation <> ty.typcollation)
          ) order by a.attnum)
          from pg_catalog.pg_attribute a
          left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
    ) order by c.relname), '[]'::json)
    from pg_catalog.pg_class c
    where c.relnamespace = (select oid from pg_catalog.pg_namespace where nspname = '${schemaName}')
      and c.relkind in ('r','p') ${onlyTable ? "and c.relname = '" + onlyTable + "'" : ''}
      and not c.relispartition
      and ${NOT_EXT('pg_catalog.pg_class', 'c.oid')}`,

  constraints: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'table', c.relname,
      'name', k.conname,
      'type', k.contype,
      'def', pg_catalog.pg_get_constraintdef(k.oid, true),
      'ref_schema', (select rn.nspname from pg_catalog.pg_class rc join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace where rc.oid = k.confrelid),
      'ref_table', (select rc.relname from pg_catalog.pg_class rc where rc.oid = k.confrelid)
    ) order by c.relname, k.contype, k.conname), '[]'::json)
    from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
    where c.relnamespace = ${NS} and c.relkind in ('r','p') and k.contype in ('p','u','c','f','x') and k.conparentid = 0`,

  indexes: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'table', t.relname, 'name', ic.relname, 'def', pg_catalog.pg_get_indexdef(i.indexrelid)
    ) order by t.relname, ic.relname), '[]'::json)
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
    join pg_catalog.pg_class t on t.oid = i.indrelid
    where t.relnamespace = ${NS} and t.relkind in ('r','p','m')
      and not exists (select 1 from pg_catalog.pg_constraint k where k.conindid = i.indexrelid)`,

  functionList: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'oid', p.oid::text, 'name', p.proname, 'kind', p.prokind,
      'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'late', (
        exists (select 1 from pg_catalog.pg_type ty join pg_catalog.pg_class rc on rc.oid = ty.typrelid
                 where rc.relkind <> 'c' and (ty.oid = p.prorettype or ty.oid = any(p.proargtypes::oid[]) or ty.oid = any(coalesce(p.proallargtypes, '{}'::oid[]))
                    or ty.typarray = p.prorettype or ty.typarray = any(p.proargtypes::oid[]) or ty.typarray = any(coalesce(p.proallargtypes, '{}'::oid[]))))
        or (p.prolang = (select oid from pg_catalog.pg_language where lanname = 'sql') and p.prosqlbody is not null)
      ),
      'acl', (select pg_catalog.json_agg(pg_catalog.json_build_object('grantee', case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_catalog.pg_roles where oid = x.grantee) end, 'priv', x.privilege_type))
                from pg_catalog.aclexplode(p.proacl) x),
      'acl_null', p.proacl is null
    ) order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), '[]'::json)
    from pg_catalog.pg_proc p
    where p.pronamespace = ${NS} and p.prokind in ('f','p') and ${NOT_EXT('pg_catalog.pg_proc', 'p.oid')}`,

  functionDefs: (oids) => `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('oid', p.oid::text, 'def', pg_catalog.pg_get_functiondef(p.oid))), '[]'::json)
    from pg_catalog.pg_proc p where p.oid in (${oids.join(',')})`,

  aggregates: `select coalesce(pg_catalog.json_agg(p.proname order by p.proname), '[]'::json)
    from pg_catalog.pg_proc p where p.pronamespace = ${NS} and p.prokind in ('a','w') and ${NOT_EXT('pg_catalog.pg_proc', 'p.oid')}`,

  triggers: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'schema', n.nspname, 'table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled,
      'def', pg_catalog.pg_get_triggerdef(t.oid, true),
      'fn_schema', fn.nspname, 'fn_name', p.proname
    ) order by n.nspname, c.relname, t.tgname), '[]'::json)
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
    where not t.tgisinternal and t.tgparentid = 0 and (n.nspname = 'public' or fn.nspname = 'public')`,

  views: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', c.relname, 'kind', c.relkind, 'options', c.reloptions,
      'def', pg_catalog.pg_get_viewdef(c.oid, true)
    ) order by c.oid), '[]'::json)
    from pg_catalog.pg_class c where c.relnamespace = ${NS} and c.relkind in ('v','m') and ${NOT_EXT('pg_catalog.pg_class', 'c.oid')}`,

  policies: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'table', c.relname, 'name', pol.polname, 'permissive', pol.polpermissive, 'cmd', pol.polcmd,
      'roles', (select pg_catalog.json_agg(case when r = 0 then 'public' else (select rolname from pg_catalog.pg_roles where oid = r) end) from pg_catalog.unnest(pol.polroles) r),
      'using', pg_catalog.pg_get_expr(pol.polqual, pol.polrelid, true),
      'check', pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid, true)
    ) order by c.relname, pol.polname), '[]'::json)
    from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid
    where c.relnamespace = ${NS}`,

  relGrants: `select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
      'name', c.relname, 'kind', c.relkind,
      'acl', (select pg_catalog.json_agg(pg_catalog.json_build_object('grantee', case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_catalog.pg_roles where oid = x.grantee) end, 'priv', x.privilege_type))
                from pg_catalog.aclexplode(c.relacl) x)
    ) order by c.relname), '[]'::json)
    from pg_catalog.pg_class c where c.relnamespace = ${NS} and c.relkind in ('r','p','v','m','S') and c.relacl is not null`,

  schemaGrants: `select pg_catalog.json_build_object(
      'schema_acl', (select pg_catalog.json_agg(pg_catalog.json_build_object('grantee', case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_catalog.pg_roles where oid = x.grantee) end, 'priv', x.privilege_type))
                       from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) x where n.nspname = 'public'),
      'default_acl', (select pg_catalog.json_agg(pg_catalog.json_build_object(
                          'owner', (select rolname from pg_catalog.pg_roles where oid = d.defaclrole), 'objtype', d.defaclobjtype,
                          'grantee', case when x.grantee = 0 then 'PUBLIC' else (select rolname from pg_catalog.pg_roles where oid = x.grantee) end, 'priv', x.privilege_type))
                        from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) x where d.defaclnamespace = ${NS})
    )`
};

// ── SQL emitters ──────────────────────────────────────────────────────────────
function qi(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function ql(text) { return "'" + String(text).replace(/'/g, "''") + "'"; }
const LOCAL_ROLES = new Set(['anon', 'authenticated', 'service_role', 'authenticator', 'postgres', 'PUBLIC']);

function emitTable(schema, t) {
  const cols = (t.columns || []).map((c) => {
    let line = '  ' + qi(c.name) + ' ' + c.type;
    if (c.collation) line += ' collate ' + c.collation.split('.').map(qi).join('.');
    if (c.generated === 's') line += ' generated always as (' + c.default + ') stored';
    else if (c.identity === 'a') line += ' generated always as identity';
    else if (c.identity === 'd') line += ' generated by default as identity';
    else if (c.default != null) line += ' default ' + c.default;
    if (c.notnull) line += ' not null';
    return line;
  });
  let sql = 'create table ' + schema + '.' + qi(t.name) + ' (\n' + cols.join(',\n') + '\n)';
  if (t.kind === 'p' && t.partition_key) sql += ' partition by ' + t.partition_key;
  return sql + ';';
}

async function build(probe, label) {
  say('Reading ' + label + ' STRUCTURE (read-only, catalog metadata only)...');
  const meta = await probe(Q.meta);
  say('  database: ' + String(meta.version).split(' on ')[0]);
  const enums = await probe(Q.enums);
  const domains = await probe(Q.domains);
  const composites = await probe(Q.composites);
  const sequences = await probe(Q.sequences);
  const tables = await probe(Q.tables('public'));
  say('  tables: ' + tables.length + ', enums: ' + enums.length + ', sequences: ' + sequences.length);
  const constraints = await probe(Q.constraints);
  const indexes = await probe(Q.indexes);
  say('  constraints: ' + constraints.length + ', extra indexes: ' + indexes.length);
  const fnList = await probe(Q.functionList);
  const fnDefs = {};
  for (let i = 0; i < fnList.length; i += 25) {
    const part = await probe(Q.functionDefs(fnList.slice(i, i + 25).map((f) => f.oid)));
    for (const row of part) fnDefs[row.oid] = row.def;
  }
  const aggregates = await probe(Q.aggregates);
  const triggers = await probe(Q.triggers);
  const views = await probe(Q.views);
  const policies = await probe(Q.policies);
  const relGrants = await probe(Q.relGrants);
  const schemaGrants = await probe(Q.schemaGrants);
  const authUsers = await probe(Q.tables('auth', 'users'));
  say('  functions: ' + fnList.length + ', triggers: ' + triggers.length + ', views: ' + views.length + ', RLS policies: ' + policies.length);

  const out = [];
  const section = (name, note) => { out.push('', '-- @@section ' + name, '-- ' + note); };

  out.push(
    '-- GP Link: STRUCTURE-ONLY snapshot of the production `public` schema.',
    '-- Generated by scripts/au-local/snapshot-schema.js. Do not edit by hand; re-run the script.',
    '-- Contains no row data. Loaded into the LOCAL test database only (scripts/au-local/setup.sh).',
    '-- Source server: ' + String(meta.version).split(' on ')[0],
    '-- Objects: ' + tables.length + ' tables, ' + constraints.length + ' constraints, ' + indexes.length + ' indexes, ' +
      fnList.length + ' functions, ' + triggers.length + ' triggers, ' + views.length + ' views, ' + policies.length + ' RLS policies.'
  );

  section('settings', 'Session settings for the load.');
  out.push('set check_function_bodies = off;', "set client_min_messages = warning;", "select pg_catalog.set_config('search_path', 'public, extensions', false);");

  section('auth_users', 'Shape of auth.users in production (structure only). The local auth emulator stores its accounts here so foreign keys and cascades behave as they do live.');
  if (authUsers.length) out.push(emitTable('auth', authUsers[0]).replace('create table', 'create table if not exists'));
  out.push('do $$ begin alter table auth.users add primary key (id); exception when others then null; end $$;');

  section('types', 'Enums, domains and composite types.');
  for (const e of enums) out.push('create type public.' + qi(e.name) + ' as enum (' + (e.labels || []).map(ql).join(', ') + ');');
  for (const d of domains) {
    out.push('create domain public.' + qi(d.name) + ' as ' + d.base + (d.default != null ? ' default ' + d.default : '') +
      (d.notnull ? ' not null' : '') + (d.checks || []).map((c) => ' ' + c).join('') + ';');
  }
  for (const c of composites) out.push('create type public.' + qi(c.name) + ' as (' + (c.attrs || []).map((a) => qi(a.name) + ' ' + a.type).join(', ') + ');');

  section('sequences', 'Sequences (identity-column sequences are created by their table instead).');
  for (const s of sequences) {
    if (s.owned_by && s.owned_by.deptype === 'i') continue;
    out.push('create sequence public.' + qi(s.name) + ' as ' + s.type + ' start with ' + s.start + ' increment by ' + s.increment +
      ' minvalue ' + s.min + ' maxvalue ' + s.max + ' cache ' + s.cache + (s.cycle ? ' cycle' : ' no cycle') + ';');
  }

  const fnSql = (f) => {
    const def = String(fnDefs[f.oid] || '').trim();
    return def ? def.replace(/;?\s*$/, '') + ';' : '-- (definition unavailable for ' + f.name + ')';
  };
  section('functions_early', 'Functions that do not depend on a table row type (created before tables so column defaults can use them).');
  for (const f of fnList) if (!f.late) out.push(fnSql(f), '');

  section('tables', 'Tables: columns, types, defaults, NOT NULL.');
  for (const t of tables) out.push(emitTable('public', t), '');

  section('sequence_ownership', 'Tie serial sequences to their columns.');
  for (const s of sequences) {
    if (s.owned_by && s.owned_by.deptype === 'a') {
      out.push('alter sequence public.' + qi(s.name) + ' owned by public.' + qi(s.owned_by.table) + '.' + qi(s.owned_by.column) + ';');
    }
  }

  const byType = (ty) => constraints.filter((k) => k.type === ty);
  section('constraints_keys', 'Primary keys, unique constraints and exclusion constraints.');
  for (const k of [...byType('p'), ...byType('u'), ...byType('x')]) {
    out.push('alter table public.' + qi(k.table) + ' add constraint ' + qi(k.name) + ' ' + k.def + ';');
  }
  section('constraints_check', 'CHECK constraints, exactly as they are live (these have drifted from the migration files).');
  for (const k of byType('c')) out.push('alter table public.' + qi(k.table) + ' add constraint ' + qi(k.name) + ' ' + k.def + ';');

  section('indexes', 'Indexes that are not part of a constraint.');
  for (const ix of indexes) out.push(ix.def + ';');

  section('constraints_fk', 'Foreign keys (including those pointing at auth.users).');
  for (const k of byType('f')) out.push('alter table public.' + qi(k.table) + ' add constraint ' + qi(k.name) + ' ' + k.def + ';');

  section('functions_late', 'Functions that take or return a table row type.');
  for (const f of fnList) if (f.late) out.push(fnSql(f), '');

  section('views', 'Views and materialised views.');
  for (const v of views) {
    const opts = Array.isArray(v.options) && v.options.length ? ' with (' + v.options.join(', ') + ')' : '';
    const body = String(v.def || '').trim().replace(/;\s*$/, '');
    if (v.kind === 'm') out.push('create materialized view public.' + qi(v.name) + ' as\n' + body + '\nwith no data;', '');
    else out.push('create view public.' + qi(v.name) + opts + ' as\n' + body + ';', '');
  }

  section('triggers', 'Triggers on public tables, and triggers elsewhere that call a public function.');
  for (const t of triggers) {
    out.push(t.def + ';');
    if (t.enabled === 'D') out.push('alter table ' + qi(t.schema) + '.' + qi(t.table) + ' disable trigger ' + qi(t.name) + ';');
  }

  section('rls', 'Row-level security switches and policies.');
  for (const t of tables) {
    if (t.rls) out.push('alter table public.' + qi(t.name) + ' enable row level security;');
    if (t.force_rls) out.push('alter table public.' + qi(t.name) + ' force row level security;');
  }
  const CMD = { r: 'select', a: 'insert', w: 'update', d: 'delete', '*': 'all' };
  for (const p of policies) {
    const roles = (p.roles || ['public']).filter((r) => r === 'public' || LOCAL_ROLES.has(r));
    out.push('create policy ' + qi(p.name) + ' on public.' + qi(p.table) + ' as ' + (p.permissive ? 'permissive' : 'restrictive') +
      ' for ' + (CMD[p.cmd] || 'all') + ' to ' + (roles.length ? roles.join(', ') : 'public') +
      (p.using != null ? ' using (' + p.using + ')' : '') + (p.check != null ? ' with check (' + p.check + ')' : '') + ';');
  }

  section('grants', 'Privileges for the API roles (anon, authenticated, service_role), as they are live.');
  out.push('revoke all on all tables in schema public from anon, authenticated, service_role;');
  out.push('revoke all on all sequences in schema public from anon, authenticated, service_role;');
  for (const g of (schemaGrants.schema_acl || [])) {
    if (LOCAL_ROLES.has(g.grantee) && g.grantee !== 'postgres') out.push('grant ' + g.priv.toLowerCase() + ' on schema public to ' + (g.grantee === 'PUBLIC' ? 'public' : g.grantee) + ';');
  }
  for (const r of relGrants) {
    const per = {};
    for (const a of (r.acl || [])) {
      if (!LOCAL_ROLES.has(a.grantee) || a.grantee === 'postgres') continue;
      (per[a.grantee] = per[a.grantee] || []).push(a.priv.toLowerCase());
    }
    for (const grantee of Object.keys(per).sort()) {
      out.push('grant ' + per[grantee].sort().join(', ') + ' on ' + (r.kind === 'S' ? 'sequence ' : 'table ') + 'public.' + qi(r.name) +
        ' to ' + (grantee === 'PUBLIC' ? 'public' : grantee) + ';');
    }
  }
  for (const f of fnList) {
    const sig = 'public.' + qi(f.name) + '(' + f.args + ')';
    const kw = f.kind === 'p' ? 'procedure ' : 'function ';
    if (f.acl_null) continue; // default privileges: PUBLIC may execute
    out.push('revoke all on ' + kw + sig + ' from public;');
    const grantees = [...new Set((f.acl || []).filter((a) => a.priv === 'EXECUTE' && LOCAL_ROLES.has(a.grantee) && a.grantee !== 'postgres').map((a) => a.grantee))].sort();
    for (const g of grantees) out.push('grant execute on ' + kw + sig + ' to ' + (g === 'PUBLIC' ? 'public' : g) + ';');
  }
  const DEF_OBJ = { r: 'tables', S: 'sequences', f: 'functions' };
  const defPer = {};
  for (const d of (schemaGrants.default_acl || [])) {
    if (!DEF_OBJ[d.objtype] || !LOCAL_ROLES.has(d.grantee) || d.grantee === 'postgres') continue;
    const k = d.objtype + '|' + d.grantee;
    (defPer[k] = defPer[k] || new Set()).add(d.priv.toLowerCase());
  }
  for (const k of Object.keys(defPer).sort()) {
    const [objtype, grantee] = k.split('|');
    out.push('alter default privileges in schema public grant ' + [...defPer[k]].sort().join(', ') + ' on ' + DEF_OBJ[objtype] +
      ' to ' + (grantee === 'PUBLIC' ? 'public' : grantee) + ';');
  }

  section('done', 'End of snapshot.');
  out.push("select pg_catalog.set_config('search_path', 'public', false);");

  const sql = out.join('\n') + '\n';
  const metaOut = {
    generated_by: 'scripts/au-local/snapshot-schema.js',
    server_version: String(meta.version).split(' on ')[0],
    server_version_num: meta.version_num,
    collation: meta.collation,
    timezone: meta.timezone,
    extensions: meta.extensions,
    api_roles: meta.roles,
    schemas: meta.schemas,
    counts: {
      tables: tables.length, enums: enums.length, domains: domains.length, composites: composites.length,
      sequences: sequences.length, constraints: constraints.length, indexes: indexes.length,
      functions: fnList.length, aggregates_not_copied: aggregates, triggers: triggers.length, views: views.length,
      policies: policies.length, tables_with_rls: tables.filter((t) => t.rls).length
    },
    cross_schema_foreign_keys: constraints.filter((k) => k.type === 'f' && k.ref_schema !== 'public').map((k) => k.table + ' -> ' + k.ref_schema + '.' + k.ref_table),
    triggers_outside_public: triggers.filter((t) => t.schema !== 'public').map((t) => t.schema + '.' + t.table + ' : ' + t.name + ' -> ' + t.fn_schema + '.' + t.fn_name)
  };
  return { sql, meta: metaOut };
}

// Anything that looks like a secret, an email address or a phone number must
// not be committed. Structure should contain none; function bodies are the
// only place one could hide, so the whole file is scanned.
function scanForSensitive(sql) {
  const findings = [];
  const rules = [
    ['JWT-like token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
    ['API-key-like string', /\b(sk|pk|rk|re|sb|whsec|key|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g],
    ['long hex/base64 secret', /'[A-Za-z0-9+/=_-]{40,}'/g],
    ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
    ['phone number', /(?<![\w.-])\+?\d[\d\s()-]{9,}\d(?![\w.-])/g, /^create sequence /]
  ];
  sql.split('\n').forEach((line, idx) => {
    for (const [label, re, skipLine] of rules) {
      if (skipLine && skipLine.test(line)) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) findings.push({ line: idx + 1, label, sample: m[0].slice(0, 6) + '...' });
    }
  });
  return findings;
}

// Lines that legitimately differ between the two databases.
function comparable(sql) {
  return sql.split('\n').filter((l) => !/^-- (Source server|Objects):/.test(l)).join('\n');
}

(async () => {
  const check = process.argv.includes('--check');
  if (process.argv.includes('--verify-local')) {
    const prod = await build(probe, 'production');
    const local = await build(localProbe, 'the LOCAL database');
    if (LOCAL_DB) await LOCAL_DB.end();
    const a = comparable(prod.sql).split('\n');
    const b = comparable(local.sql).split('\n');
    const onlyProd = a.filter((l) => !b.includes(l));
    const onlyLocal = b.filter((l) => !a.includes(l));
    say('');
    if (!onlyProd.length && !onlyLocal.length) {
      say('MATCH: the local database has exactly the structure production has (' + a.length + ' lines compared).');
      process.exit(0);
    }
    say('DIFFERENCES between production and the local database:');
    say('  ' + onlyProd.length + ' line(s) only in production, ' + onlyLocal.length + ' line(s) only in local.');
    for (const l of onlyProd.slice(0, 60)) say('  production only: ' + l.slice(0, 220));
    for (const l of onlyLocal.slice(0, 60)) say('  local only:      ' + l.slice(0, 220));
    say('(Lines "local only" are expected for anything an au_gp migration added locally.)');
    process.exit(4);
  }
  const { sql, meta } = await build(probe, 'production');
  const findings = scanForSensitive(sql);
  if (findings.length) {
    say('');
    say('WARNING: ' + findings.length + ' place(s) in the snapshot look like a secret, email or phone number:');
    for (const f of findings.slice(0, 40)) say('  line ' + f.line + ': ' + f.label + ' (' + f.sample + ')');
    say('Review these before committing.');
  } else {
    say('  sensitive-content scan: nothing that looks like a key, email address or phone number.');
  }
  if (check) {
    const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    say(existing === sql ? 'Snapshot is up to date with production.' : 'Snapshot DIFFERS from production. Re-run without --check to refresh it.');
    process.exit(existing === sql ? 0 : 3);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, sql);
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  say('Wrote ' + path.relative(process.cwd(), OUT_FILE) + ' (' + sql.split('\n').length + ' lines) and ' + path.basename(META_FILE) + '.');
})().catch((err) => {
  process.stderr.write('snapshot-schema failed: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
