#!/usr/bin/env node
'use strict';
/*
 * Read-only look at the LOCAL test database and Outbox (never production).
 *   node scripts/au-local/lib/inspect.js doctor <email>     profile, state keys, case and tasks for one doctor
 *   node scripts/au-local/lib/inspect.js outbox [n]         the newest n outbox entries (default 15)
 *   node scripts/au-local/lib/inspect.js sql "<select ...>"  run one read-only query
 *   node scripts/au-local/lib/inspect.js counts              how many rows each table holds
 */
const cfg = require('./config.js');
const { pgClient, assertLocalDatabase } = require('./stack.js');
const { createOutbox } = require('./outbox.js');

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'outbox') {
    const n = Number(process.argv[3]) || 15;
    const all = createOutbox().readAll();
    const messages = all.filter((e) => e.kind !== 'system');
    console.log(all.length + ' entries in the outbox (' + messages.length + ' messages, ' + (all.length - messages.length) + ' background service calls).');
    for (const e of messages.slice(-n)) {
      console.log('  ' + e.ts + '  ' + String(e.channel).padEnd(9) + ' to ' + String((e.to || []).join(', ')).padEnd(38) + ' ' + (e.subject || ''));
    }
    const hosts = {};
    for (const e of all) { const h = e.host || '(local)'; hosts[h] = (hosts[h] || 0) + 1; }
    console.log('Outside addresses the app tried to reach (all captured, none contacted):');
    for (const h of Object.keys(hosts).sort()) console.log('  ' + String(hosts[h]).padStart(5) + '  ' + h);
    return;
  }
  const db = pgClient();
  await db.connect();
  try {
    await assertLocalDatabase(db);
    await db.query('set default_transaction_read_only = on');
    if (cmd === 'doctor') {
      const email = String(process.argv[3] || '').toLowerCase();
      const u = await db.query('select id, email, email_confirmed_at is not null as confirmed, raw_user_meta_data, raw_app_meta_data, created_at from auth.users where lower(email) = $1', [email]);
      if (!u.rows[0]) { console.log('No account with that email in the local database.'); return; }
      const id = u.rows[0].id;
      console.log('auth.users        ', JSON.stringify(u.rows[0]));
      const p = await db.query('select * from public.user_profiles where user_id = $1', [id]);
      const prof = p.rows[0] || {};
      for (const k of ['profile_photo_data_url', 'id_copy_data_url']) if (prof[k]) prof[k] = '(' + String(prof[k]).length + ' chars)';
      console.log('user_profiles     ', JSON.stringify(prof));
      const s = await db.query('select state, updated_at from public.user_state where user_id = $1', [id]);
      console.log('user_state keys   ', s.rows[0] ? Object.keys(s.rows[0].state || {}).join(', ') || '(empty)' : '(no row)');
      const r = await db.query('select role from public.user_roles where user_id = $1', [id]);
      console.log('user_roles        ', JSON.stringify(r.rows));
      const c = await db.query('select * from public.registration_cases where user_id = $1', [id]);
      console.log('registration_cases', JSON.stringify(c.rows.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== null)))));
      if (c.rows[0]) {
        const t = await db.query('select task_type, title, status, priority, related_stage, source_trigger, assignee, created_at from public.registration_tasks where case_id = $1 order by created_at', [c.rows[0].id]);
        console.log('registration_tasks (' + t.rowCount + ')');
        for (const row of t.rows) console.log('   ', JSON.stringify(row));
      }
      return;
    }
    if (cmd === 'sql') {
      const r = await db.query(process.argv[3]);
      console.log(JSON.stringify(r.rows, null, 2));
      return;
    }
    if (cmd === 'counts') {
      const t = await db.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1");
      for (const row of t.rows) {
        const n = await db.query('select count(*)::int as n from public."' + row.relname + '"');
        if (n.rows[0].n) console.log('  ' + String(n.rows[0].n).padStart(6) + '  ' + row.relname);
      }
      const a = await db.query('select count(*)::int as n from auth.users');
      console.log('  ' + String(a.rows[0].n).padStart(6) + '  auth.users');
      return;
    }
    console.log('Usage: inspect.js doctor <email> | outbox [n] | sql "<select>" | counts');
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('inspect failed: ' + e.message); process.exit(1); });
void cfg;
