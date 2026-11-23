// Fix bundle FR-1, defect B-01: only the server may write a doctor's pathway.
//
// THE REAL GUARANTEE IS THE MIGRATION
//   supabase/migrations/20261123110000_au_gp_fr1_server_owned_columns_guard.sql
// It is a database trigger, so no JavaScript test can prove it by itself. This
// file therefore has two halves:
//
//   1. "the migration file": always runs. It pins what the file contains (the
//      protected column list, that nothing existing is dropped or narrowed,
//      that the functions run with the caller's role).
//   2. "against the local test stack": runs ONLY when the local stack
//      (docs/au-gp/LOCAL-STACK.md) is up on this machine. It signs a fake
//      doctor in through the local sign-in emulator, takes the token, and
//      attacks the real Postgres through the real PostgREST exactly as the
//      final reviewer did. When the stack is not running these tests are
//      skipped (and say so); they are not a substitute for applying the
//      migration to a database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'supabase/migrations/20261123110000_au_gp_fr1_server_owned_columns_guard.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const PATHWAY_COLUMNS = ['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at', 'pathway_confirmed_at', 'pathway_confirmed_by'];
const PREFERENCE_COLUMNS = ['current_suburb', 'current_state', 'current_postcode', 'current_latitude', 'current_longitude',
  'commute_radius_km', 'notice_period_weeks', 'available_from', 'sessions_wanted', 'billing_preference', 'special_interests',
  'open_to_locum', 'open_to_relocate', 'timezone', 'preferred_locations'];
const PROTECTED = PATHWAY_COLUMNS.concat(PREFERENCE_COLUMNS);

describe('B-01: the migration file', () => {
  it('protects every column this build added to user_profiles', () => {
    // Every "add column" on user_profiles in an au_gp migration must be in the guard.
    const dir = path.join(ROOT, 'supabase/migrations');
    const added = new Set();
    for (const f of fs.readdirSync(dir).filter((n) => /au_gp/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /alter table public\.user_profiles\s+([^;]+);/g;
      let m;
      while ((m = re.exec(text))) {
        for (const c of m[1].matchAll(/add column if not exists ([a-z_0-9]+)/g)) added.add(c[1]);
      }
    }
    expect([...added].sort()).toEqual(PROTECTED.slice().sort());
    for (const col of PROTECTED) {
      expect(code, col + ' kept on UPDATE').toContain('new.' + col + ' := old.' + col + ';');
      expect(code, col + ' forced NULL on INSERT').toContain('new.' + col + ' := null;');
    }
  });

  it('uses the lib/gp-credentials.js column lists (nothing drifted)', () => {
    const gp = require_('../lib/gp-credentials.js');
    for (const col of gp.PATHWAY_PROFILE_COLUMNS) expect(PROTECTED).toContain(col);
    for (const col of gp.PREFERENCE_COLUMNS) expect(PROTECTED).toContain(col);
  });

  it('is additive: no policy, grant on a table, or existing object is dropped, replaced or narrowed', () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\b(create|alter)\s+policy\b/i);
    expect(code).not.toMatch(/\brevoke\b[^;]*\bon\s+(table\s+)?public\.(user_profiles|user_state)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\b(update|delete\s+from|truncate)\s+public\./i);
    expect(code).not.toMatch(/\b(begin|commit)\s*;/i);
  });

  it('runs the guard with the CALLER\'s role (never SECURITY DEFINER) and an empty search path', () => {
    expect(code).not.toMatch(/security\s+definer/i);
    expect((code.match(/set search_path to ''/g) || []).length).toBe(3);
    // The server test: role in effect is not an API end-user role AND the JWT claim is absent or service_role.
    expect(code).toMatch(/v_user in \('anon', 'authenticated'\)/);
    expect(code).toMatch(/v_claim is null or v_claim = 'service_role'/);
    expect(code).toMatch(/exception when others then\s+return false;/);
  });

  it('installs both triggers as BEFORE INSERT OR UPDATE row triggers, guarded so the file can be re-run', () => {
    expect(code).toMatch(/create trigger trg_au_gp_guard_user_profiles\s+before insert or update on public\.user_profiles\s+for each row execute function public\.au_gp_guard_user_profiles\(\)/);
    expect(code).toMatch(/create trigger trg_au_gp_guard_user_state\s+before insert or update on public\.user_state\s+for each row execute function public\.au_gp_guard_user_state\(\)/);
    expect((code.match(/if not exists \(\s*select 1 from pg_catalog\.pg_trigger/g) || []).length).toBe(2);
    // FR-3 (S3-10), deliberate: this file now defines the same full key list as the FR-2 and FR-3 files,
    // so re-running it alone cannot shrink the list.
    expect(code).toContain("array['gp_au_placement_hold', 'gp_au_signup_audience', 'gp_au_branch_started_at']");
  });

  it('the server-owned state key in the migration is the one the server uses', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).toContain("const AU_PLACEMENT_HOLD_KEY = 'gp_au_placement_hold';");
  });
});

describe('B-01: the server-side belt (a stamp without a staff name is not a confirmation)', () => {
  const cp = require_('../lib/candidate-pathway.js');
  const base = { candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: 'ceo@gplink-test.local', pathway_set_at: '2026-11-20T00:00:00Z' };
  const resolve = (extra) => cp.resolvePathwayFromRecords({ profile: Object.assign({}, base, extra), credentials: null, flagEnabled: true });
  it('the pair the server writes counts', () => {
    const r = resolve({ pathway_confirmed_at: '2026-11-20T00:00:00Z', pathway_confirmed_by: 'ceo@gplink-test.local' });
    expect(r.confirmed).toBe(true);
    expect(r.needsStaffReview).toBe(false);
  });
  it.each([[null], [''], ['  '], ['self'], ['SELF'], ['unknown'], [undefined]])('a stamp with confirmed_by = %j does not', (by) => {
    const r = resolve({ pathway_confirmed_at: '2026-11-20T00:00:00Z', pathway_confirmed_by: by });
    expect(r.confirmed).toBe(false);
    expect(r.needsStaffReview).toBe(true);
    expect(r.pathway).toBe('au_vr');
  });
  it('a name without a stamp does not', () => {
    expect(resolve({ pathway_confirmed_at: null, pathway_confirmed_by: 'ceo@gplink-test.local' }).confirmed).toBe(false);
  });
  it('an overseas / unrecorded doctor and the switch-off answer are unchanged', () => {
    const off = cp.resolvePathwayFromRecords({ profile: Object.assign({}, base, { pathway_confirmed_at: 'x', pathway_confirmed_by: 'a@b' }), flagEnabled: false });
    expect(off).toEqual(cp.overseasDefault({ flagEnabled: false }));
    const none = cp.resolvePathwayFromRecords({ profile: { candidate_pathway: null }, flagEnabled: true });
    expect(none.confirmed).toBe(false);
    expect(none.isAu).toBe(false);
    expect(none.needsStaffReview).toBe(false);
  });
});

// ── The live half ────────────────────────────────────────────────────────────
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
    if (!secrets || !secrets.anonKey || !secrets.serviceRoleKey) return null;
    // The guard must be installed in this local database (start.sh applies it).
    const probe = await fetch(GATEWAY + '/rest/v1/rpc/au_gp_caller_is_server', {
      method: 'POST', headers: { apikey: secrets.serviceRoleKey, Authorization: 'Bearer ' + secrets.serviceRoleKey, 'content-type': 'application/json' }, body: '{}'
    });
    if (!probe.ok) return null;
    return secrets;
  } catch (e) { return null; }
}
const stack = await localStack();
if (!stack) console.warn('[au-fr1-b01] local test stack not running (or the FR-1 migration is not applied to it): the live database checks are SKIPPED. Run scripts/au-local/start.sh to include them.');

describe.skipIf(!stack)('B-01: against the local test stack (real Postgres, real PostgREST, a real user token)', () => {
  const email = 'fr1.b01.' + Date.now() + '@gplink-test.local';
  const password = 'GpLink-Test-2026!';
  let uid = '';
  let token = '';
  const svc = () => ({ apikey: stack.serviceRoleKey, Authorization: 'Bearer ' + stack.serviceRoleKey, 'content-type': 'application/json', Prefer: 'return=representation' });
  const doc = () => ({ apikey: stack.anonKey, Authorization: 'Bearer ' + token, 'content-type': 'application/json', Prefer: 'return=representation' });
  const rest = async (headers, method, p, body) => {
    const r = await fetch(GATEWAY + '/rest/v1/' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data };
  };
  const profile = async () => (await rest(svc(), 'GET', 'user_profiles?user_id=eq.' + uid + '&select=*')).data[0];
  const state = async () => (await rest(svc(), 'GET', 'user_state?user_id=eq.' + uid + '&select=state')).data[0].state;

  beforeAll(async () => {
    const created = await fetch(GATEWAY + '/auth/v1/admin/users', {
      method: 'POST', headers: svc(),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { firstName: 'Test', lastName: 'Fr1guard' } })
    });
    const cj = await created.json();
    uid = cj.id || (cj.user && cj.user.id);
    expect(uid, 'fake doctor created').toBeTruthy();
    const have = await rest(svc(), 'GET', 'user_profiles?user_id=eq.' + uid + '&select=user_id');
    if (!have.data.length) await rest(svc(), 'POST', 'user_profiles', { user_id: uid, email });
    const haveState = await rest(svc(), 'GET', 'user_state?user_id=eq.' + uid + '&select=user_id');
    if (!haveState.data.length) await rest(svc(), 'POST', 'user_state', { user_id: uid, state: {} });
    const t = await (await fetch(GATEWAY + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: stack.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
    })).json();
    token = t.access_token;
    expect(token, 'doctor signed in with the public key').toBeTruthy();
  });

  afterAll(async () => {
    if (!uid) return;
    await fetch(GATEWAY + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: svc() }).catch(() => {});
    await rest(svc(), 'DELETE', 'user_state?user_id=eq.' + uid);
    await rest(svc(), 'DELETE', 'user_profiles?user_id=eq.' + uid);
  });

  it('the reviewer\'s attack: a doctor PATCHes their own pathway and confirmation: 200, and nothing protected changes', async () => {
    const r = await rest(doc(), 'PATCH', 'user_profiles?user_id=eq.' + uid, {
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: 'forged', pathway_set_at: '2026-01-01T00:00:00Z',
      pathway_confirmed_at: '2026-01-01T00:00:00Z', pathway_confirmed_by: 'ceo@gplink-test.local',
      timezone: 'Mars/Olympus', preferred_locations: ['Anywhere'], current_state: 'ZZ', commute_radius_km: 9999,
      preferred_city: 'Hobart'
    });
    expect(r.status).toBe(200);
    const row = await profile();
    for (const col of PROTECTED) expect(row[col], col).toBeNull();
    // ...and the ordinary profile field in the same statement IS written, as it is today.
    expect(row.preferred_city).toBe('Hobart');
    expect(r.data[0].preferred_city).toBe('Hobart');
    expect(r.data[0].candidate_pathway).toBeNull();
  });

  it('an existing (overseas) doctor\'s direct profile update behaves exactly as before: every pre-existing column is written', async () => {
    const patch = { first_name: 'Testa', last_name: 'Guarded', preferred_city: 'Perth', target_arrival_date: 'March', who_moving: 'family', qualification_country: 'GB' };
    const r = await rest(doc(), 'PATCH', 'user_profiles?user_id=eq.' + uid, patch);
    expect(r.status).toBe(200);
    const row = await profile();
    for (const k of Object.keys(patch)) expect(row[k], k).toBe(patch[k]);
  });

  it('the server (service role) can still write every protected column, and a later doctor write cannot change or clear them', async () => {
    const serverPatch = {
      candidate_pathway: 'au_restricted', candidate_basis: 'australia', pathway_set_by: 'ceo@gplink-test.local', pathway_set_at: '2026-11-20T00:00:00+00:00',
      pathway_confirmed_at: '2026-11-20T00:00:00+00:00', pathway_confirmed_by: 'ceo@gplink-test.local',
      current_suburb: 'Parramatta', current_state: 'NSW', current_postcode: '2150', current_latitude: -33.8, current_longitude: 151,
      commute_radius_km: 30, notice_period_weeks: 4, available_from: '2027-01-10', sessions_wanted: 6.5, billing_preference: 'mixed',
      special_interests: ['skin'], open_to_locum: false, open_to_relocate: true, timezone: 'Australia/Sydney', preferred_locations: ['Perth', 'Regional WA']
    };
    const w = await rest(svc(), 'PATCH', 'user_profiles?user_id=eq.' + uid, serverPatch);
    expect(w.status).toBe(200);
    const before = await profile();
    expect(before.candidate_pathway).toBe('au_restricted');
    expect(before.preferred_locations).toEqual(['Perth', 'Regional WA']);

    const attack = {};
    for (const col of PROTECTED) attack[col] = null;
    Object.assign(attack, { candidate_pathway: 'au_vr', pathway_confirmed_by: 'forged', timezone: 'Mars/Olympus' });
    const r = await rest(doc(), 'PATCH', 'user_profiles?user_id=eq.' + uid, attack);
    expect(r.status).toBe(200);
    const after = await profile();
    for (const col of PROTECTED) expect(after[col], col).toEqual(before[col]);
  });

  it('a doctor upsert (INSERT ... ON CONFLICT) cannot smuggle the columns in either', async () => {
    const before = await profile();
    const r = await fetch(GATEWAY + '/rest/v1/user_profiles?on_conflict=user_id', {
      method: 'POST', headers: Object.assign(doc(), { Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify({ user_id: uid, email, candidate_pathway: 'au_vr', pathway_confirmed_at: '2026-01-01T00:00:00Z', pathway_confirmed_by: 'forged' })
    });
    expect([200, 201]).toContain(r.status);
    const after = await profile();
    for (const col of PROTECTED) expect(after[col], col).toEqual(before[col]);
  });

  it('public.exec_sql (how migrations run) counts as the server', async () => {
    const r = await rest(svc(), 'POST', 'rpc/exec_sql', { query: "update public.user_profiles set candidate_pathway = 'au_non_vr', pathway_confirmed_at = null, pathway_confirmed_by = null where user_id = '" + uid + "'" });
    expect([200, 204]).toContain(r.status);
    expect((await profile()).candidate_pathway).toBe('au_non_vr');
    // a doctor cannot call exec_sql at all
    const d = await rest(doc(), 'POST', 'rpc/exec_sql', { query: 'select 1' });
    expect(d.status).toBeGreaterThanOrEqual(400);
  });

  it('the helper tells the two callers apart', async () => {
    expect((await rest(svc(), 'POST', 'rpc/au_gp_caller_is_server', {})).data).toBe(true);
    expect((await rest(doc(), 'POST', 'rpc/au_gp_caller_is_server', {})).data).toBe(false);
    const anon = { apikey: stack.anonKey, Authorization: 'Bearer ' + stack.anonKey, 'content-type': 'application/json' };
    expect((await rest(anon, 'POST', 'rpc/au_gp_caller_is_server', {})).data).toBe(false);
  });

  it('user_state: a doctor cannot add, change or remove the server-owned placement-hold key; other keys are written', async () => {
    const add = await rest(doc(), 'PATCH', 'user_state?user_id=eq.' + uid, { state: { gp_au_placement_hold: { at: '2026-01-01', application_id: 'someone-elses' }, gp_selected_country: 'GB' } });
    expect(add.status).toBe(200);
    let st = await state();
    expect(st.gp_au_placement_hold).toBeUndefined();
    expect(st.gp_selected_country).toBe('GB');

    const hold = { at: '2026-11-23T00:00:00.000Z', application_id: 'real-app' };
    await rest(svc(), 'PATCH', 'user_state?user_id=eq.' + uid, { state: { gp_selected_country: 'GB', gp_au_placement_hold: hold } });
    const change = await rest(doc(), 'PATCH', 'user_state?user_id=eq.' + uid, { state: { gp_selected_country: 'IE', gp_au_placement_hold: { at: 'x', application_id: 'forged' } } });
    expect(change.status).toBe(200);
    st = await state();
    expect(st.gp_au_placement_hold).toEqual(hold);
    expect(st.gp_selected_country).toBe('IE');

    await rest(doc(), 'PATCH', 'user_state?user_id=eq.' + uid, { state: { only: 'this' } });
    st = await state();
    expect(st.gp_au_placement_hold).toEqual(hold);
    expect(st.only).toBe('this');

    // the server can clear it
    await rest(svc(), 'PATCH', 'user_state?user_id=eq.' + uid, { state: { only: 'this' } });
    expect((await state()).gp_au_placement_hold).toBeUndefined();
  });

  it('read exposure: with a doctor token the server-only tables give nothing', async () => {
    for (const t of ['gp_credentials', 'au_gp_doctor_details']) {
      const r = await rest(doc(), 'GET', t + '?select=*&limit=1');
      expect(r.status, t).toBeGreaterThanOrEqual(400);
    }
    for (const t of ['registration_cases', 'placements', 'ats_offers', 'registration_tasks', 'task_timeline']) {
      const r = await rest(doc(), 'GET', t + '?select=*&limit=5');
      expect(Array.isArray(r.data) ? r.data.length : 0, t).toBe(0);
    }
    const other = await rest(doc(), 'GET', 'user_profiles?user_id=neq.' + uid + '&select=user_id&limit=5');
    expect(other.data.length).toBe(0);
  });
});
