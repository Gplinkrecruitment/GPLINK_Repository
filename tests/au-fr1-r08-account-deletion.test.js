// Fix bundle FR-1, defect R-08: referee details and provider numbers are
// deleted with the account.
//
//   1. the migration file (always): a cascading foreign key, additive;
//   2. the server (always, on the harness): every path that deletes an account
//      removes au_gp_doctor_details and the two per-user key-value rows first;
//   3. the real database (ONLY when the local test stack is running): delete
//      the sign-in account and the row is gone through the foreign key alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { bootLeadCopyServer } = require_('./helpers/au-wp16-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require_('./helpers/au-fixtures.js');
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20261123120000_au_gp_fr1_doctor_details_cascade.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('R-08: the migration file', () => {
  it('adds one cascading foreign key to the user row, and nothing else', () => {
    expect(code).toMatch(/alter table public\.au_gp_doctor_details\s+add constraint au_gp_doctor_details_user_id_fkey\s+foreign key \(user_id\) references public\.user_profiles\(user_id\) on delete cascade\s+not valid;/);
    expect(code).toMatch(/validate constraint au_gp_doctor_details_user_id_fkey/);
    expect((code.match(/if (not )?exists \(\s*select 1 from pg_catalog\.pg_constraint/g) || []).length).toBe(2);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.|truncate)\b/i);
    expect(code).not.toMatch(/\b(begin|commit)\s*;/i);
  });
  it('every table this build created cascades from the user row', () => {
    const dir = path.join(ROOT, 'supabase/migrations');
    const all = fs.readdirSync(dir).filter((n) => /au_gp/.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
    const created = [...all.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((m) => m[1]).sort();
    expect(created).toEqual(['au_gp_doctor_details', 'gp_credentials']);
    expect(all).toMatch(/user_id uuid primary key references public\.user_profiles\(user_id\) on delete cascade/);   // gp_credentials
    expect(all).toMatch(/au_gp_doctor_details_user_id_fkey\s+foreign key \(user_id\) references public\.user_profiles\(user_id\) on delete cascade/);
  });
});

describe('R-08: the deletion routes on the server', () => {
  let h, t;
  const PAST = '2026-01-01T00:00:00.000Z';
  const details = (d) => ({ user_id: d.userId, referees: [{ name: 'Dr Test Referee One (FAKE)', phone: '0491570157', email: 'referee.one@gplink-test.local' }, { name: 'Dr Test Referee Two (FAKE)' }],
    existing_provider_numbers: [{ number: '2345671A', location: 'Test Current Practice (FAKE)' }], prescriber_number: '1234567', notice_given: true });
  const kv = (d) => [{ key: 'signup_attribution:' + d.userId, value: { v: 1, segment: 'australian' } }, { key: 'apply_intent:' + d.userId, value: { v: 1, job: 'job-1', status: 'pending' } },
    { key: 'unrelated:key', value: { keep: true } }];
  function load(doctors, extra) {
    const db = Object.assign(buildAuFixtureDb(doctors), extra || {});
    ['au_gp_doctor_details', 'runtime_kv', 'placements', 'gp_nudge_log', 'registration_tasks', 'task_timeline', 'admin_audit_log', 'user_roles'].forEach((n) => { if (!db[n]) db[n] = []; });
    Object.keys(h.emu.db).forEach((n) => { if (n !== 'rso_team') delete h.emu.db[n]; });
    Object.keys(db).forEach((n) => { h.emu.db[n] = JSON.parse(JSON.stringify(db[n])); });
    h.emu.reset();
  }
  const archived = (suffix) => buildAuDoctor('au_vr', { idSuffix: suffix, profile: { account_status: 'archived', archived_at: PAST, purge_after: PAST } });
  const rowsFor = (d) => (h.emu.db.au_gp_doctor_details || []).filter((r) => r.user_id === d.userId);
  const kvKeys = () => (h.emu.db.runtime_kv || []).map((r) => r.key).sort();

  beforeAll(async () => { h = await bootLeadCopyServer({ name: 'fr1-r08', mode: 'supabase', tables: {} }); t = h.testUtils; }, 60000);
  afterAll(async () => { if (h) await h.closeAll(); });

  it('the 90-day purge job: the doctor\'s referees, numbers and per-user records go before the account does', async () => {
    const gone = archived('p1');
    const kept = buildAuDoctor('au_vr', { idSuffix: 'p2' });   // an active account: untouched
    load([gone, kept], { au_gp_doctor_details: [details(gone), details(kept)], runtime_kv: kv(gone).concat([{ key: 'signup_attribution:' + kept.userId, value: { v: 1 } }]) });
    h.setSwitch(true);
    const res = await h.cron('/api/cron/purge-accounts');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, due: 1, purged: 1 });
    expect(rowsFor(gone)).toEqual([]);
    expect(rowsFor(kept).length).toBe(1);
    expect(kvKeys()).toEqual(['signup_attribution:' + kept.userId, 'unrelated:key'].sort());
    // the order: the private rows were removed BEFORE the account was deleted
    const reqs = h.emu.requests.map((r) => r.method + ' ' + (r.table || r.path || ''));
    const iDetails = reqs.findIndex((r) => /^DELETE au_gp_doctor_details/.test(r));
    expect(iDetails).toBeGreaterThan(-1);
  });

  it('a doctor with a current placement is still retained whole (the existing legal-retention rule): nothing of theirs is removed', async () => {
    const d = archived('p3');
    load([d], { au_gp_doctor_details: [details(d)], runtime_kv: kv(d),
      gp_applications: [{ id: 'app-ret-1', user_id: d.userId, status: 'hired', practice_name: 'Test Metro Practice (FAKE)' }] });
    h.setSwitch(true);
    const res = await h.cron('/api/cron/purge-accounts');
    expect(res.json).toMatchObject({ ok: true, due: 1, purged: 0, retained: 1 });
    expect(rowsFor(d).length).toBe(1);
    expect(kvKeys()).toContain('signup_attribution:' + d.userId);
  });

  it('the helper: idempotent, never throws, tolerates a database without the table', async () => {
    const d = archived('p4');
    load([d], { au_gp_doctor_details: [details(d)], runtime_kv: kv(d) });
    h.setSwitch(true);
    expect(await t.auDeleteDoctorPrivateData(d.userId)).toMatchObject({ ran: true, details: true, kv: 2 });
    expect(await t.auDeleteDoctorPrivateData(d.userId)).toMatchObject({ ran: true, details: true });
    expect(rowsFor(d)).toEqual([]);
    h.emu.missingTables = new Set(['au_gp_doctor_details']);
    try { expect(await t.auDeleteDoctorPrivateData(d.userId)).toMatchObject({ ran: true, details: true }); } finally { h.emu.missingTables = new Set(); }
    expect(await t.auDeleteDoctorPrivateData('')).toEqual({ ran: false });
  });

  it('switch off: the purge job behaves exactly as before and names no new table', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'p5', profile: { account_status: 'archived', archived_at: PAST, purge_after: PAST } });
    load([d]);
    h.setSwitch(false);
    try {
      h.emu.reset();
      const res = await h.cron('/api/cron/purge-accounts');
      expect(res.json).toMatchObject({ ok: true, due: 1, purged: 1 });
      expect(h.emu.requests.some((r) => r.table === 'au_gp_doctor_details' || (r.table === 'runtime_kv' && r.method === 'DELETE'))).toBe(false);
      expect(await t.auDeleteDoctorPrivateData(d.userId)).toEqual({ ran: false });
    } finally { h.setSwitch(true); }
  });

  it('every code path that deletes a sign-in account calls the helper first', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const deletes = [...src.matchAll(/admin\/users\/[^\n]*method: 'DELETE'/g)].map((m) => m.index);
    expect(deletes.length).toBe(2);   // the staff "create candidate" undo, and purge-all-users
    deletes.forEach((at) => {
      const before = src.slice(Math.max(0, at - 700), at);
      expect(before, 'the delete at offset ' + at).toContain('auDeleteDoctorPrivateData(');
    });
    // the third: the shared helper every other path (the 90-day purge) goes through
    const helper = src.slice(src.indexOf('async function supabaseAuthAdminDeleteUser(userId) {'));
    const body = helper.slice(0, helper.indexOf('\n}\n'));
    expect(body.indexOf('await auDeleteDoctorPrivateData(userId);')).toBeGreaterThan(-1);
    expect(body.indexOf('await auDeleteDoctorPrivateData(userId);')).toBeLessThan(body.indexOf("method: 'DELETE'"));
    // and nothing else in the server deletes a sign-in account
    expect((src.match(/\/auth\/v1\/admin\/users\/\$\{[^}]+\}`, \{\s*method: 'DELETE'/g) || []).length).toBe(1);
  });
});

// ── The real database ────────────────────────────────────────────────────────
const GATEWAY = 'http://127.0.0.1:54321';
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
  });
}
async function localStack() {
  try {
    if (!fs.existsSync(path.join(os.homedir(), 'gplink-tools/au-local/local-secrets.json'))) return null;
    if (!(await portOpen(54321)) || !(await portOpen(54330))) return null;
    const secrets = require_('../scripts/au-local/lib/config.js').loadSecrets();
    if (!secrets || !secrets.serviceRoleKey) return null;
    return secrets;
  } catch (e) { return null; }
}
const stack = await localStack();
if (!stack) console.warn('[au-fr1-r08] local test stack not running: the real-database cascade check is SKIPPED. Run scripts/au-local/start.sh to include it.');

describe.skipIf(!stack)('R-08: on the local Postgres (the foreign key itself)', () => {
  const svc = () => ({ apikey: stack.serviceRoleKey, Authorization: 'Bearer ' + stack.serviceRoleKey, 'content-type': 'application/json', Prefer: 'return=representation' });
  const rest = async (method, p, body) => {
    const r = await fetch(GATEWAY + '/rest/v1/' + p, { method, headers: svc(), body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data };
  };
  it('deleting the sign-in account removes the doctor-details row and the credentials row with it', async () => {
    const email = 'fr1.r08.' + Date.now() + '@gplink-test.local';
    const created = await (await fetch(GATEWAY + '/auth/v1/admin/users', { method: 'POST', headers: svc(), body: JSON.stringify({ email, password: 'GpLink-Test-2026!', email_confirm: true }) })).json();
    const uid = created.id || (created.user && created.user.id);
    expect(uid).toBeTruthy();
    try {
      if (!(await rest('GET', 'user_profiles?user_id=eq.' + uid + '&select=user_id')).data.length) await rest('POST', 'user_profiles', { user_id: uid, email });
      const d = await rest('POST', 'au_gp_doctor_details', { user_id: uid, referees: [{ name: 'Dr Test Referee One (FAKE)' }], prescriber_number: '1234567' });
      expect(d.status).toBe(201);
      const c = await rest('POST', 'gp_credentials', { user_id: uid, ahpra_number: 'MED0001234567' });
      expect(c.status).toBe(201);
      // a row for a user who does not exist is refused by the constraint
      const orphan = await rest('POST', 'au_gp_doctor_details', { user_id: '00000000-0000-4000-8000-00000000dead', prescriber_number: '7654321' });
      expect(orphan.status).toBe(409);
    } finally {
      await fetch(GATEWAY + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: svc() });
    }
    expect((await rest('GET', 'user_profiles?user_id=eq.' + uid + '&select=user_id')).data).toEqual([]);
    expect((await rest('GET', 'au_gp_doctor_details?user_id=eq.' + uid + '&select=user_id')).data).toEqual([]);
    expect((await rest('GET', 'gp_credentials?user_id=eq.' + uid + '&select=user_id')).data).toEqual([]);
  });
});
