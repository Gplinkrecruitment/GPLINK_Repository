// Australian GP build, fix bundle FB-2a, R11: the tasks a recorded placement
// sets off (start date, indemnity, provider number, credentialing pack, the
// contract task) exist ONCE per placement, whoever else is doing the same
// thing at the same moment.
//
// Before: _auEnsurePlacementTask read, claimed `au_task:<type>:<placement>` in
// the nudge ledger, and when the claim was held by someone else and no task
// had appeared after 250 ms, took the claim over and inserted. Two overlapping
// placement passes whose first insert was merely slow (more than 250 ms to
// reach the database) each inserted the task.
//
// Now: the database refuses the second one (partial unique index
// uniq_au_placement_task on case, placement key and kind; migration
// 20261122100000_au_gp_fb2_placement_tasks_and_offer_sessions.sql), and the
// code treats the refused insert as "already there".
//
// Every case runs in a loop with the database's answers arriving after random
// delays, and with task inserts held in flight for longer than the old 250 ms.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');

const ROUNDS = 12;
const PRESTART = ['indemnity_certificate', 'provider_number_new_location', 'start_date_tracking'];
let rig; let t; let seq = 0;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function doctor() {
  seq += 1;
  const d = buildAuDoctor('au_vr', { idSuffix: String(7300 + seq), profile: { phone: '+614007' + String(10000 + seq) } });
  rig.addDoctor(d);
  return d;
}
const tasksOf = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const kindsOf = (d) => tasksOf(d).filter((x) => metaOf(x).placement_task_kind).map((x) => metaOf(x).placement_task_kind).sort();
const placedOnRecord = (d) => {
  const app = rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d));
  const offer = rig.table('ats_offers').find((x) => x.application_id === rig.appIdFor(d));
  app.status = 'placement_secured'; app.ats_stage = 'hired'; offer.status = 'accepted';
  rig.table('placements').push({
    id: 'pl-' + d.userId, user_id: d.userId, application_id: rig.appIdFor(d), practice_id: null, practice_name: 'Test Metro Practice (FAKE)',
    job_title: 'General Practitioner (FAKE role)', start_date: '2027-02-01', status: 'active', placed_at: new Date().toISOString(), created_at: new Date().toISOString()
  });
};
// Random delays on every answer; EVERY task insert held in flight for longer
// than the 250 ms after which the old design took a claim over.
function storm() {
  rig.emu.jitterMs = 5;
  rig.emu.hold = (r) => (r.method === 'POST' && r.table === 'registration_tasks' ? 300 + Math.random() * 60 : (Math.random() < 0.2 ? Math.random() * 10 : 0));
}
function calm() { rig.emu.jitterMs = 0; rig.emu.hold = null; }
async function quiet() {
  let last = -1;
  for (let i = 0; i < 200; i++) { const seen = rig.emu.requests.length; if (seen === last) return; last = seen; await sleep(80); }
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fb2a-r11',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) { calm(); await rig.close(); } });
beforeEach(() => { rig.setSwitch(true); calm(); rig.resetRecorders(); });

describe('the database stub enforces the new index as the real database does', () => {
  it('a second task of the same kind for the same case and placement is refused 409 / 23505; another placement, or another kind, is not', async () => {
    const d = doctor();
    const base = rig.emu.url + '/rest/v1/registration_tasks';
    const post = (meta, type) => fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([{ case_id: d.caseId, task_type: type || 'start_date_tracking', title: 'x', metadata: meta }])
    });
    expect((await post({ au: true, placement_key: 'p1', placement_task_kind: 'start_date_tracking' })).status).toBe(201);
    const dup = await post({ au: true, placement_key: 'p1', placement_task_kind: 'start_date_tracking' });
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('23505');
    expect((await post({ au: true, placement_key: 'p2', placement_task_kind: 'start_date_tracking' })).status).toBe(201);
    expect((await post({ au: true, placement_key: 'p1', placement_task_kind: 'indemnity_certificate' }, 'indemnity_certificate')).status).toBe(201);
    // A task with no kind (every task written before this migration) is never refused.
    expect((await post({ au: true, placement_key: 'p1' })).status).toBe(201);
    expect((await post({ au: true, placement_key: 'p1' })).status).toBe(201);
  });

  it('the migration creates exactly that index, additively', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261122100000_au_gp_fb2_placement_tasks_and_offer_sessions.sql'), 'utf8');
    expect(sql).toMatch(/create unique index if not exists uniq_au_placement_task\s+on public\.registration_tasks \(\s*case_id,\s*\(metadata ->> 'placement_key'\),\s*\(metadata ->> 'placement_task_kind'\)\s*\)\s*where \(metadata ->> 'placement_task_kind'\) is not null/);
    const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    expect(code).not.toMatch(/\bdrop\b|\bdelete\b|\bupdate\b|\btruncate\b|\brename\b/i);
  });
});

describe('overlapping placement passes with slow inserts: one of each task', () => {
  // About 8 seconds alone (12 rounds, each holding inserts for 300 ms).
  it('four passes at once (the runner twice, the state sync, the bulk sync), ' + ROUNDS + ' rounds', { timeout: 120000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const d = doctor();
      placedOnRecord(d);
      rig.resetRecorders(); // the practice's address is shared by every round
      storm();
      const cookie = { cookie: rig.gpCookie(d.email, d.userId) };
      await Promise.all([
        t.auRunPlacementHooks(d.userId, { source: 'test a' }),
        sleep(Math.random() * 20).then(() => t.auRunPlacementHooks(d.userId, { source: 'test b', force: true })),
        sleep(Math.random() * 20).then(() => rig.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, cookie)),
        sleep(Math.random() * 20).then(() => t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, rig.appIdFor(d)))
      ]);
      calm();
      await quiet();
      const kinds = kindsOf(d);
      for (const type of PRESTART) expect(kinds.filter((k) => k === type), 'round ' + round + ' ' + type + ' in ' + JSON.stringify(kinds)).toHaveLength(1);
      expect(kinds.filter((k) => k === 'practice_pack_child:offer_contract'), 'round ' + round).toHaveLength(1);
      // Nothing was claimed in the ledger for a task any more.
      expect(rig.table('gp_nudge_log').filter((n) => n.user_id === d.userId && n.channel === 'task')).toEqual([]);
      // N11 and N12 still went once each.
      const cap = rig.capture(d);
      expect(cap.emailsToDoctor.filter((e) => /placement is secured/i.test(e.subject))).toHaveLength(1);
      expect(cap.emailsToPractice.filter((e) => /Placement confirmed/i.test(e.subject))).toHaveLength(1);
    }
  });

  it('twelve direct callers racing for one task: one row, eleven told "exists"', { timeout: 60000 }, async () => {
    const d = doctor();
    storm();
    const out = await Promise.all(Array.from({ length: 12 }, () => t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, 'race-key')));
    calm();
    expect(out.filter((r) => r.created)).toHaveLength(1);
    expect(out.filter((r) => r.ok)).toHaveLength(12);
    expect(tasksOf(d).filter((x) => metaOf(x).placement_key === 'race-key')).toHaveLength(1);
  });

  it('a second placement (a new placement key) gets its own task; the first is untouched', async () => {
    const d = doctor();
    const a = await t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, 'cycle-one');
    const again = await t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, 'cycle-one');
    const b = await t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, 'cycle-two');
    expect(a.created).toBe(true);
    expect(again).toMatchObject({ ok: true, created: false, taskId: a.taskId });
    expect(b.created).toBe(true);
    expect(b.taskId).not.toBe(a.taskId);
  });

  it('the insert fails for another reason: nothing is created and the caller is told', async () => {
    const d = doctor();
    rig.emu.forbid((r) => (r.method === 'POST' && r.table === 'registration_tasks' ? 'forced' : ''));
    const out = await t.__fb2a.ensurePlacementTaskForTest(d.userId, d.caseId, 'fail-key');
    rig.emu.forbid(null);
    expect(out).toMatchObject({ ok: false, created: false, reason: 'write_failed' });
  });
});
