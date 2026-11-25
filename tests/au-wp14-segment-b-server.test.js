// WP-14 (Australian GP build): segment B on the real server.
//
// Segment B (`au_restricted`) is BUILT, NOT LAUNCHED, and its regulatory rules
// are unconfirmed. So these tests prove three things over and over:
//
//   1. an `au_restricted` doctor with a sponsor-tied visa gets a transfer
//      DECISION task on placement, and a transfer CASE only when a staff
//      member confirms; supervision tasks only when registration is supervised;
//   2. an `au_vr` citizen gets none of it, through every placement entry
//      point: no visa case, no visa task, no supervision task, no AHPRA message;
//   3. nothing is ever sent to the doctor or the practice unless a person
//      sends it (N21), and unknown facts raise a decision and do nothing else.
//
// The database stub enforces the unique indexes the real database has
// (the once-ever ledger, uniq_au_lifecycle_task, uniq_visa_nomination_transfer).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, ENTRY_POINTS, PRACTICE_NAME, PRACTICE_EMAIL, ROLE_ID } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor, fakeUuid } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const careerIntro = require('../lib/career-intro.js');
const auDoctorText = require('../lib/au-doctor-text.js');

let rig;
let t;
let seq = 0;

const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const text = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
const tasksOf = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const kindOf = (task) => metaOf(task).lifecycle_kind || '';
const byKind = (d, kind) => tasksOf(d).filter((x) => kindOf(x) === kind);
const visaCasesOf = (d) => rig.table('visa_applications').filter((x) => x.user_id === d.userId);
const credOf = (d) => rig.table('gp_credentials').find((c) => c.user_id === d.userId) || null;
const toList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
const emailsTo = (address) => rig.emails.filter((e) => toList(e && e.to).some((x) => String(x).toLowerCase().indexOf(String(address).toLowerCase()) !== -1));
const seg = (action, d, body, who) => rig.post('/api/admin/au/segment-b/' + action, Object.assign({ case_id: d.caseId }, body || {}), who || rig.superAdmin());
const view = (d, who) => rig.get('/api/admin/au/segment-b?case_id=' + d.caseId, who || rig.superAdmin());
const CONFIRM = { decision: 'confirm', current_sponsor: 'Test Old Practice (FAKE)', visa_expiry: '2028-01-31', visa_subclass: '482', note: 'Confirmed by phone with the doctor.' };
const VISA_TASK_TYPES = ['visa_stage', 'visa_doc', 'sponsor', 'migration_agent'];
const SUPERVISION_KEYS = ['sppa_00', 'section_g', 'supervisor_cv'];

// Supervised = limited registration with a supervision level.
const SUPERVISED = { ahpra_registration_type: 'limited', supervision_level: 'level_2', specialist_gp: false, vr_status: 'non_vr', staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'staff.test@gplink-test.local' };

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(4000 + seq) }, o, {
    profile: Object.assign({ phone: '+614004' + String(10000 + seq), phone_number: '4004' + String(10000 + seq), country_dial: '+61', last_name: 'Segb' + String.fromCharCode(97 + (seq % 26)) + String.fromCharCode(97 + Math.floor(seq / 26) % 26) }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
const bSponsoredSupervised = () => doctor('au_restricted', { credentials: SUPERVISED });
const bSponsoredGeneral = () => doctor('au_restricted', { credentials: { staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'staff.test@gplink-test.local' } });
const bCitizenSupervised = () => doctor('au_restricted', { credentials: Object.assign({}, SUPERVISED, { work_rights: 'citizen', visa_subclass: null, visa_expiry: null, visa_sponsor_tied: null, visa_sponsor_name: null }) });
const bUnknown = () => doctor('au_restricted', { credentials: { ahpra_registration_type: null, supervision_level: null, work_rights: null, visa_subclass: null, visa_expiry: null, visa_sponsor_tied: null, visa_sponsor_name: null } });

async function place(d, entry) {
  const res = await rig.place(d, entry || 'ats_placement', { settleMs: 120 });
  if (res) expect(res.status, (entry || 'ats_placement') + ': ' + JSON.stringify(res.json)).toBe(200);
  return res;
}

function assertNothingSegmentB(d, label) {
  const tasks = tasksOf(d);
  expect(tasks.filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1).map((x) => x.title), label + ': visa tasks').toEqual([]);
  expect(tasks.filter((x) => x.task_type === 'practice_pack').map((x) => x.title), label + ': supervision task').toEqual([]);
  expect(tasks.filter((x) => SUPERVISION_KEYS.concat(['position_description']).indexOf(x.related_document_key) !== -1).map((x) => x.related_document_key), label + ': supervision pack').toEqual([]);
  expect(tasks.filter((x) => /^visa_|^supervision_|segment_b/.test(kindOf(x))).map(kindOf), label + ': WP-14 kinds').toEqual([]);
  expect(tasks.filter((x) => x.task_type === 'ahpra_correspondence' || x.task_type === 'ahpra_action_item'), label + ': AHPRA tasks').toEqual([]);
  expect(visaCasesOf(d), label + ': visa case').toEqual([]);
  // (the practice's address is shared by every doctor in this rig: only the emails about THIS doctor)
  const about = emailsTo(PRACTICE_EMAIL).filter((e) => (String(e.subject) + ' ' + String(e.text || '') + ' ' + String(e.html || '')).indexOf(d.profile.last_name) !== -1);
  for (const e of emailsTo(d.email).concat(about)) {
    expect(String(e.subject) + ' ' + text(e.html), label + ': ' + e.subject).not.toMatch(/AHPRA|\b[Vv]isas?\b|[Nn]omination|[Ss]upervis/);
  }
  expect(rig.whatsapps, label + ': WhatsApp').toEqual([]);
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp14-segment-b',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    tables: { visa_applications: [], visa_timeline_events: [], visa_documents: [], visa_updates: [], visa_dependants: [] },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' }, visa_applications: { stage: 'nomination' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) { rig.emu.jitterMs = 0; rig.emu.hold = null; await rig.close(); } });
beforeEach(() => {
  rig.setSwitch(true);
  rig.emu.forbid(null);
  rig.emu.failTables = {};
  rig.emu.jitterMs = 0;
  rig.emu.hold = null;
  rig.resetRecorders();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('placement, through every entry point', () => {
  for (const entry of ENTRY_POINTS) {
    it(entry + ': a sponsor-tied, supervised au_restricted doctor gets ONE transfer decision and ONE supervision task; an au_vr citizen gets neither', async () => {
      const b = bSponsoredSupervised();
      const a = doctor('au_vr');
      await place(b, entry);
      rig.resetRecorders();
      await place(a, entry);

      // ── segment B ──
      const decision = byKind(b, 'visa_transfer_decision');
      expect(decision.length, entry + ': decision tasks').toBe(1);
      expect(decision[0].task_type).toBe('visa_stage');
      expect(decision[0].status).toBe('open');
      expect(decision[0].title).toMatch(/^Visa: confirm whether a nomination transfer is needed for the new employer/);
      expect(metaOf(decision[0])).toMatchObject({ au: true, segment: 'B', decision: null, needs_its_action: true, checklist_row: 10 });
      const supervision = byKind(b, 'supervision_relodgement');
      expect(supervision.length, entry + ': supervision tasks').toBe(1);
      expect(supervision[0].task_type).toBe('practice_pack');
      expect(metaOf(supervision[0]).checklist_row).toBe(11);
      // WP-11's pack for a supervised doctor is there (created by the runner, not by this package)
      const pack = tasksOf(b).filter((x) => x.task_type === 'practice_pack_child').map((x) => x.related_document_key).sort();
      expect(pack, entry).toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
      // NOTHING automatic beyond the decision: no case, none of the transfer's four tasks
      expect(visaCasesOf(b), entry + ': no case before a person confirms').toEqual([]);
      expect(byKind(b, 'visa_transfer_task'), entry).toEqual([]);
      // the Australian ladder, never the overseas one
      expect(rig.caseOf(b).stage, entry).toBe('prestart');

      // ── segment A ──
      assertNothingSegmentB(a, entry + ' (au_vr)');
      expect(rig.caseOf(a).stage, entry).toBe('prestart');

      // a replay creates nothing more
      const before = tasksOf(b).length;
      await rig.place(b, entry, { repeat: true, settleMs: 120 });
      await t.auRunPlacementHooks(b.userId, { force: true, silent: true });
      expect(tasksOf(b).length, entry + ': replay').toBe(before);
      expect(byKind(b, 'visa_transfer_decision').length).toBe(1);
      expect(byKind(b, 'supervision_relodgement').length).toBe(1);
    });
  }

  it('segment C and an overseas doctor get none of the segment B tasks either', async () => {
    const c = doctor('au_non_vr');
    const o = doctor('overseas_null');
    await place(c);
    await place(o);
    expect(tasksOf(c).filter((x) => /^visa_|^supervision_/.test(kindOf(x)))).toEqual([]);
    expect(tasksOf(c).filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1 || x.task_type === 'practice_pack')).toEqual([]);
    expect(visaCasesOf(c)).toEqual([]);
    expect(tasksOf(o).filter((x) => kindOf(x))).toEqual([]);
    expect(tasksOf(o).filter((x) => x.task_type === 'practice_pack')).toEqual([]);
  });

  it('a sponsor-tied doctor whose registration is NOT supervised: the decision, and no supervision task', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    expect(byKind(d, 'visa_transfer_decision').length).toBe(1);
    expect(byKind(d, 'supervision_relodgement')).toEqual([]);
    expect(tasksOf(d).filter((x) => SUPERVISION_KEYS.indexOf(x.related_document_key) !== -1)).toEqual([]);
  });

  it('a supervised segment B doctor who is a CITIZEN: supervision, and nothing about a visa at all', async () => {
    const d = bCitizenSupervised();
    await place(d);
    expect(byKind(d, 'supervision_relodgement').length).toBe(1);
    expect(tasksOf(d).filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1)).toEqual([]);
    expect(visaCasesOf(d)).toEqual([]);
    const v = (await view(d)).json;
    expect(v.visa).toMatchObject({ mode: 'none', reason: 'citizen_or_permanent_resident', decision: null, transfer_case: null });
    expect(v.can.decide_visa).toBe(false);
    // and a person cannot open one for them by hand
    const res = await seg('visa-transfer/decision', d, CONFIRM);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('au_no_visa_stage');
    expect(visaCasesOf(d)).toEqual([]);
    expect(credOf(d).work_rights).toBe('citizen');
  });

  it('UNKNOWN facts: a decision task worded "confirm this doctor\'s right to work", WP-11\'s review task, and nothing automatic', async () => {
    const d = bUnknown();
    await place(d);
    const decision = byKind(d, 'visa_transfer_decision');
    expect(decision.length).toBe(1);
    expect(decision[0].title).toMatch(/^Visa: confirm this doctor's right to work and whether a nomination transfer is needed/);
    expect(metaOf(decision[0]).visa_mode).toBe('unknown');
    // supervision is not known either: no supervision task, no pack; WP-11's review task asks a person
    expect(byKind(d, 'supervision_relodgement')).toEqual([]);
    expect(tasksOf(d).filter((x) => SUPERVISION_KEYS.indexOf(x.related_document_key) !== -1)).toEqual([]);
    expect(tasksOf(d).filter((x) => x.task_type === 'segment_review' && x.source_trigger === 'au_placement_review').length).toBe(1);
    expect(visaCasesOf(d)).toEqual([]);
    const v = (await view(d)).json;
    expect(v.visa.mode).toBe('unknown');
    expect(v.supervision.supervised).toBe(null);
    // confirming needs the facts: a bad form writes nothing
    const bad = await seg('visa-transfer/decision', d, { decision: 'confirm' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.errors).sort()).toEqual(['current_sponsor', 'visa_expiry']);
    expect(visaCasesOf(d)).toEqual([]);
    expect(credOf(d).work_rights).toBe(null);
    // with the facts, the person's confirmation is what records them
    const ok = await seg('visa-transfer/decision', d, CONFIRM);
    expect(ok.status).toBe(201);
    expect(credOf(d)).toMatchObject({ work_rights: 'visa', visa_sponsor_tied: true, visa_sponsor_name: 'Test Old Practice (FAKE)', visa_expiry: '2028-01-31' });
    expect(visaCasesOf(d).length).toBe(1);
  });

  it('facts recorded AFTER placement close what is no longer needed', async () => {
    const d = bUnknown();
    await place(d);
    expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('open');
    // staff record: a permanent resident on general registration
    Object.assign(credOf(d), { work_rights: 'pr', ahpra_registration_type: 'general' });
    await t.auRunPlacementHooks(d.userId, { force: true, silent: true });
    const decision = byKind(d, 'visa_transfer_decision')[0];
    expect(decision.status).toBe('completed');
    expect(metaOf(decision)).toMatchObject({ decision: 'not_needed', decided_by: 'system' });
    expect(visaCasesOf(d)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the staff decision', () => {
  it('confirm: one nomination-transfer case with the current sponsor, expiry and subclass, its four tasks, and nothing sent', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    rig.resetRecorders();
    const bellBefore = JSON.stringify((rig.stateOf(d) || {}).gp_link_updates || []);
    const res = await seg('visa-transfer/decision', d, CONFIRM, rig.consultant());
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ ok: true, decision: 'confirm', already: false });

    const cases = visaCasesOf(d);
    expect(cases.length).toBe(1);
    expect(cases[0]).toMatchObject({
      case_type: 'nomination_transfer', stage: 'nomination', current_sponsor_name: 'Test Old Practice (FAKE)',
      current_visa_expiry: '2028-01-31', current_visa_subclass: '482', sponsor_name: PRACTICE_NAME,
      transfer_placement_key: rig.appIdFor(d), visa_type: 'Transfer of nomination'
    });
    expect(cases[0].transfer_decided_by).toBeTruthy();
    expect(cases[0].visa_subclass == null).toBe(true);   // never a fresh application's subclass

    const four = byKind(d, 'visa_transfer_task');
    expect(four.map((x) => metaOf(x).mark).sort()).toEqual(['agent', 'grant_notice', 'sponsor', 'tracking']);
    expect(four.map((x) => x.task_type).sort()).toEqual(['migration_agent', 'sponsor', 'visa_doc', 'visa_stage']);
    for (const task of four) {
      expect(task.visa_case_id).toBe(cases[0].id);
      expect(task.related_stage).toBe('prestart');
      expect(metaOf(task).visa_case_type).toBe('nomination_transfer');
    }
    const agent = four.find((x) => metaOf(x).mark === 'agent');
    expect(agent.title).toMatch(/transfer of nomination/);
    expect(agent.description).toMatch(/TRANSFER of an existing nomination from Test Old Practice \(FAKE\), not a new visa application/);
    // none of the fresh-application machinery: no passport request, no dependants, no questionnaire
    expect(rig.table('visa_documents')).toEqual([]);
    expect(rig.table('visa_dependants')).toEqual([]);

    const decision = byKind(d, 'visa_transfer_decision')[0];
    expect(decision.status).toBe('completed');
    expect(metaOf(decision)).toMatchObject({ decision: 'confirm', visa_case_id: cases[0].id });
    expect(credOf(d)).toMatchObject({ work_rights: 'visa', visa_sponsor_tied: true, visa_sponsor_name: 'Test Old Practice (FAKE)' });

    // nothing reached the doctor or the practice
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
    expect(JSON.stringify((rig.stateOf(d) || {}).gp_link_updates || [])).toBe(bellBefore);
    expect(rig.table('visa_timeline_events').every((e) => e.visible_to_gp === false)).toBe(true);

    // the same press again changes nothing
    const again = await seg('visa-transfer/decision', d, CONFIRM);
    expect(again.status).toBe(200);
    expect(again.json.already).toBe(true);
    expect(visaCasesOf(d).length).toBe(1);
    expect(byKind(d, 'visa_transfer_task').length).toBe(4);

    // the audit row carries codes, not the sponsor or the note
    const audit = rig.table('admin_audit_log').filter((r) => r.action === 'admin_au_visa_transfer_decision' && r.target_id === d.caseId);
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit)).not.toMatch(/Test Old Practice|Confirmed by phone/);
  });

  it('not needed: needs a reason, closes the decision, opens nothing; it can still be confirmed later', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    const noNote = await seg('visa-transfer/decision', d, { decision: 'not_needed' });
    expect(noNote.status).toBe(400);
    expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('open');
    const res = await seg('visa-transfer/decision', d, { decision: 'not_needed', note: 'Migration agent confirmed in writing no transfer is required.' });
    expect(res.status).toBe(200);
    expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('completed');
    expect(metaOf(byKind(d, 'visa_transfer_decision')[0]).decision).toBe('not_needed');
    expect(visaCasesOf(d)).toEqual([]);
    expect(byKind(d, 'visa_transfer_task')).toEqual([]);
    expect((await seg('visa-transfer/decision', d, { decision: 'not_needed', note: 'Same decision again.' })).json.already).toBe(true);
    // a person changes their mind: the case is opened, once
    const later = await seg('visa-transfer/decision', d, CONFIRM);
    expect(later.status).toBe(201);
    expect(visaCasesOf(d).length).toBe(1);
    expect(metaOf(byKind(d, 'visa_transfer_decision')[0])).toMatchObject({ decision: 'confirm', previous_decision: 'not_needed' });
    // and it cannot be turned back into "not needed"
    const back = await seg('visa-transfer/decision', d, { decision: 'not_needed', note: 'Trying to undo a confirmed transfer.' });
    expect(back.status).toBe(409);
    expect(back.json.code).toBe('already_decided');
  });

  it('who may: the CEO and a consultant for any doctor; an RSO only for a case assigned to them; never for another segment', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    expect((await view(d, rig.rso('other.rso.test@gplink-test.local'))).status).toBe(403);
    expect((await seg('visa-transfer/decision', d, CONFIRM, rig.rso('other.rso.test@gplink-test.local'))).status).toBe(403);
    expect(visaCasesOf(d)).toEqual([]);
    const a = doctor('au_vr');
    await place(a);
    const refused = await seg('visa-transfer/decision', a, CONFIRM);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('not_segment_b');
    expect(visaCasesOf(a)).toEqual([]);
    const o = doctor('overseas_null');
    expect((await seg('visa-transfer/decision', o, CONFIRM)).json.code).toBe('not_au_pathway');
    expect((await view(o)).status).toBe(409);
  });

  it('before a placement there is nothing to decide', async () => {
    const d = bSponsoredGeneral();
    const res = await seg('visa-transfer/decision', d, CONFIRM);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('no_placement');
    expect(visaCasesOf(d)).toEqual([]);
    expect(tasksOf(d).filter((x) => kindOf(x))).toEqual([]);
  });

  it('a decision is a decision, not a tick: "Mark complete" on the task is refused', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    for (const kind of ['visa_transfer_decision', 'supervision_relodgement']) {
      const task = byKind(d, kind)[0];
      const res = await rig.put('/api/admin/task?id=' + task.id, { status: 'completed' }, rig.superAdmin());
      expect(res.status, kind).toBe(409);
      expect(res.json.code, kind).toBe('au_task_needs_its_action');
      expect(byKind(d, kind)[0].status, kind).toBe('open');
    }
  });

  it('the details can be corrected, and "nomination approved" closes the tracking task', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    await seg('visa-transfer/decision', d, CONFIRM);
    const upd = await seg('visa-transfer/update', d, { visa_expiry: '2028-06-30', new_sponsor_contact: 'Test Manager', reference_number: 'REF-TEST-1' });
    expect(upd.status).toBe(200);
    expect(visaCasesOf(d)[0]).toMatchObject({ current_visa_expiry: '2028-06-30', sponsor_contact: 'Test Manager', reference_number: 'REF-TEST-1' });
    expect(credOf(d).visa_expiry).toBe('2028-06-30');
    expect((await seg('visa-transfer/update', d, { visa_expiry: 'tomorrow' })).status).toBe(400);
    expect((await seg('visa-transfer/nomination-approved', d, {})).status).toBe(400);
    rig.resetRecorders();
    const res = await seg('visa-transfer/nomination-approved', d, { approved_on: '2026-11-15' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(visaCasesOf(d)[0].stage).toBe('granted');
    expect(String(visaCasesOf(d)[0].grant_date).slice(0, 10)).toBe('2026-11-15');
    expect(byKind(d, 'visa_transfer_task').find((x) => metaOf(x).mark === 'tracking').status).toBe('completed');
    expect((await seg('visa-transfer/nomination-approved', d, { approved_on: '2026-11-15' })).json.already).toBe(true);
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
  });

  it('the database changes are not applied: the decision says so and opens nothing', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    rig.emu.missingColumns = { visa_applications: ['case_type', 'current_sponsor_name', 'current_visa_expiry', 'current_visa_subclass', 'transfer_placement_key', 'transfer_decided_by', 'transfer_decided_at'] };
    try {
      const res = await seg('visa-transfer/decision', d, CONFIRM);
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('schema_missing');
      expect(visaCasesOf(d)).toEqual([]);
      expect(byKind(d, 'visa_transfer_task')).toEqual([]);
      expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('open');
    } finally { rig.emu.missingColumns = {}; }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('concurrency: two people, the same moment', () => {
  it('double (and triple) confirm of the transfer decision = one case, four tasks, one decision', async () => {
    for (let round = 0; round < 12; round += 1) {
      const d = bSponsoredGeneral();
      await place(d);
      rig.emu.jitterMs = 6;
      rig.emu.hold = (r) => (round % 3 === 0 && r.method === 'POST' && (r.table === 'visa_applications' || r.table === 'registration_tasks') && Math.random() < 0.4 ? 120 : (Math.random() < 0.25 ? Math.random() * 10 : 0));
      const who = [rig.superAdmin(), rig.consultant(), rig.superAdmin()];
      const out = await Promise.all(who.slice(0, round % 2 === 0 ? 2 : 3).map((w) => seg('visa-transfer/decision', d, CONFIRM, w)));
      rig.emu.jitterMs = 0; rig.emu.hold = null;
      for (const res of out) expect([200, 201], 'round ' + round + ': ' + JSON.stringify(res.json)).toContain(res.status);
      expect(visaCasesOf(d).length, 'round ' + round + ': cases').toBe(1);
      expect(byKind(d, 'visa_transfer_task').map((x) => metaOf(x).mark).sort(), 'round ' + round).toEqual(['agent', 'grant_notice', 'sponsor', 'tracking']);
      expect(byKind(d, 'visa_transfer_decision').length, 'round ' + round).toBe(1);
      expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('completed');
      expect(out.filter((r) => r.status === 201).length, 'round ' + round + ': exactly one request created the case').toBe(1);
    }
  }, 90000);

  it('overlapping placement passes = one decision task and one supervision task', async () => {
    for (let round = 0; round < 8; round += 1) {
      const d = bSponsoredSupervised();
      await place(d);
      // take them away, then let three passes race to put them back
      const keep = rig.table('registration_tasks');
      for (let i = keep.length - 1; i >= 0; i -= 1) if (keep[i].case_id === d.caseId && kindOf(keep[i])) keep.splice(i, 1);
      rig.emu.jitterMs = 6;
      rig.emu.hold = (r) => (r.method === 'POST' && r.table === 'registration_tasks' && Math.random() < 0.4 ? 80 : 0);
      const decided = await t.auPlacementHooksForUser(d.userId);
      const placement = { key: rig.appIdFor(d) };
      await Promise.all([1, 2, 3].map(() => t.auEnsureSegmentBPlacementTasks(d.userId, d.caseId, decided, placement, { gpName: 'Test', practiceName: PRACTICE_NAME }, 'prestart', 'system')));
      rig.emu.jitterMs = 0; rig.emu.hold = null;
      expect(byKind(d, 'visa_transfer_decision').length, 'round ' + round).toBe(1);
      expect(byKind(d, 'supervision_relodgement').length, 'round ' + round).toBe(1);
    }
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the visa stage is hidden for citizens and permanent residents (APP-29), enforced on the server', () => {
  const visaUpdate = (d) => rig.post('/api/visa/update', { userId: d.userId, stage: 'nomination', visaSubclass: '482', sponsorName: 'Test Sponsor (FAKE)' }, rig.rso());

  it('staff cannot open a fresh visa case for any doctor on an Australian pathway; an overseas doctor is exactly as before', async () => {
    const a = doctor('au_vr');
    const citizenB = bCitizenSupervised();
    const sponsoredB = bSponsoredGeneral();
    const c = doctor('au_non_vr');
    const o = doctor('overseas_null');

    const ra = await visaUpdate(a);
    expect(ra.status).toBe(409);
    expect(ra.json.code).toBe('au_no_visa_stage');
    expect(ra.json.message).toMatch(/citizen or permanent resident/);
    expect((await visaUpdate(citizenB)).json.code).toBe('au_no_visa_stage');
    expect((await visaUpdate(c)).json.code).toBe('au_no_visa_stage');
    const rb = await visaUpdate(sponsoredB);
    expect(rb.status).toBe(409);
    expect(rb.json.code).toBe('au_use_transfer_decision');
    for (const d of [a, citizenB, sponsoredB, c]) {
      expect(visaCasesOf(d), d.kind).toEqual([]);
      expect(tasksOf(d).filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1), d.kind).toEqual([]);
    }
    // the refusal is audit-logged, with no name in it
    expect(rig.table('admin_audit_log').filter((r) => r.action === 'admin_visa_case_refused_au_pathway').length).toBe(4);

    const ro = await visaUpdate(o);
    expect(ro.status).toBe(201);
    expect(visaCasesOf(o).length).toBe(1);
    expect(visaCasesOf(o)[0].case_type === undefined || visaCasesOf(o)[0].case_type === null).toBe(true);
    await rig.settle(80);
    expect(tasksOf(o).filter((x) => x.task_type === 'visa_stage').map((x) => x.title)).toEqual(['Review visa case setup']);
  });

  it('the doctor-facing visa API and page do not exist for them; a sponsor-tied segment B doctor gets the transfer page only once a person has confirmed', async () => {
    const a = doctor('au_vr');
    const citizenB = bCitizenSupervised();
    const b = bSponsoredGeneral();
    const o = doctor('overseas_null');
    const as = (d) => ({ cookie: rig.gpCookie(d.email, d.userId) });
    for (const d of [a, citizenB, b]) {
      for (const [method, path] of [['GET', '/api/visa/status'], ['GET', '/api/visa/timeline'], ['GET', '/api/visa/updates'], ['GET', '/api/visa/dependants'], ['GET', '/api/visa/questionnaire']]) {
        const res = await rig.request(method, path, as(d));
        expect(res.status, d.kind + ' ' + path).toBe(404);
        expect(res.json.code, d.kind + ' ' + path).toBe('au_pathway');
      }
      expect((await rig.post('/api/visa/dependants', { fullName: 'Test Child', relationship: 'child' }, as(d))).status, d.kind).toBe(404);
      expect((await rig.post('/api/visa/documents', { fileName: 'x.pdf' }, as(d))).status, d.kind).toBe(404);
      const page = await rig.get('/pages/visa', as(d));
      expect(page.status, d.kind + ' page').toBe(302);
      expect(page.headers.location, d.kind + ' page').toBe('/pages/index');
      expect((await rig.get('/api/gp/au-visa-transfer', as(d))).status, d.kind + ' transfer api').toBe(404);
    }
    expect((await rig.get('/api/visa/status', as(o))).status).toBe(200);
    expect((await rig.get('/api/gp/au-visa-transfer', as(o))).status).toBe(404);
    // the transfer file itself is never served at its own address, to anyone
    for (const d of [a, b, o]) {
      for (const address of ['/pages/visa-transfer-au', '/pages/VISA-transfer-au', '/pages/%76isa-transfer-au']) {
        const direct = await rig.get(address, as(d));
        expect(direct.status, address).toBe(302);
        expect(direct.headers.location, address).toBe('/pages/visa');
      }
    }
    expect(rig.table('visa_dependants')).toEqual([]);

    // a person confirms the transfer for the sponsor-tied doctor
    await place(b);
    await seg('visa-transfer/decision', b, CONFIRM);
    const api = await rig.get('/api/gp/au-visa-transfer', as(b));
    expect(api.status).toBe(200);
    expect(api.headers['cache-control']).toMatch(/no-store/);
    const tr = api.json.transfer;
    expect(tr).toMatchObject({ stage: 'nomination', stageLabel: 'Being prepared', currentSponsor: 'Test Old Practice (FAKE)', newEmployer: PRACTICE_NAME, visaExpiry: '31 January 2028', visaSubclass: '482' });
    expect(tr.intro).toMatch(/You do not need to apply for a new visa/);
    // no fresh-application flow: nothing about passports, dependants, a questionnaire or lodging
    const all = JSON.stringify(tr);
    expect(all).not.toMatch(/passport|dependant|questionnaire|upload|lodge anything/i);
    // the only banned word is the one the named exception allows on this page, for this doctor
    const who = { pathway: 'au_restricted', credentials: credOf(b), context: 'visa_transfer_page' };
    expect(auDoctorText.violationsFor(all, who)).toEqual([]);
    expect(auDoctorText.violations(all)).toEqual(['visa']);
    // nothing staff recorded leaves: no decided-by, no note, no internal id
    expect(Object.keys(tr).sort()).toEqual(['approvedOn', 'contactLine', 'currentSponsor', 'intro', 'newEmployer', 'stage', 'stageDetail', 'stageLabel', 'startNote', 'steps', 'title', 'visaExpiry', 'visaSubclass']);
    // the page: their own file, at the ordinary address, never kept by a cache
    const embedded = '?gp_shell=embedded&gp_shell_static=1';
    for (const address of ['/pages/visa', '/pages/VISA', '/pages/visa.html']) {
      const page = await rig.get(address + embedded, as(b));
      expect(page.status, address).toBe(200);
      expect(page.raw, address).toContain('id="auTransferRoot"');
      expect(page.raw, address).not.toContain('Subclass 482');
      expect(page.headers['cache-control'], address).toBe('private, no-store');
    }
    expect((await rig.get('/pages/visa', as(b))).raw).toContain('app-shell-frame');
    // every other page of the other journey is still not theirs
    for (const other of ['/pages/myinthealth', '/pages/amc', '/pages/ahpra']) expect((await rig.get(other + embedded, as(b))).status, other).toBe(302);
    // and an overseas doctor at the same address gets the page they always got
    const overseasPage = await rig.get('/pages/visa' + embedded, as(o));
    if (overseasPage.status === 200) expect(overseasPage.raw).not.toContain('id="auTransferRoot"');
    // the original doctor-facing visa API is still not theirs
    expect((await rig.get('/api/visa/status', as(b))).status).toBe(404);
    // a citizen never gets it, even with a stray transfer row on file
    rig.table('visa_applications').push({ id: fakeUuid('v', '9001'), user_id: citizenB.userId, case_type: 'nomination_transfer', stage: 'nomination', transfer_placement_key: 'x' });
    expect((await rig.get('/api/gp/au-visa-transfer', as(citizenB))).status).toBe(404);
    expect((await rig.get('/pages/visa', as(citizenB))).headers.location).toBe('/pages/index');
  });

  it('the bell: no visa item for any doctor on an Australian pathway (segment B is not launched); an overseas doctor is unchanged', async () => {
    const b = bSponsoredGeneral();
    const o = doctor('overseas_null');
    await place(b);
    await seg('visa-transfer/decision', b, CONFIRM);
    const before = JSON.stringify((rig.stateOf(b) || {}).gp_link_updates || []);
    await t.pushVisaNotificationToOwner(visaCasesOf(b)[0].id, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to Lodgement' });
    expect(JSON.stringify((rig.stateOf(b) || {}).gp_link_updates || [])).toBe(before);
    rig.table('visa_applications').push({ id: fakeUuid('v', '9002'), user_id: o.userId, stage: 'nomination' });
    await t.pushVisaNotificationToOwner(fakeUuid('v', '9002'), { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to Lodgement' });
    const bell = (rig.stateOf(o) || {}).gp_link_updates;
    expect(JSON.stringify(bell)).toMatch(/Visa stage updated/);
  });

  it('no visa TASK is ever created by the visa module for a citizen, even with an old case on file', async () => {
    const a = doctor('au_vr');
    rig.table('visa_applications').push({ id: fakeUuid('v', '9003'), user_id: a.userId, stage: 'nomination' });
    await t.processVisaTaskAutomation(fakeUuid('v', '9003'), a.userId, { stage: 'lodgement', sponsorName: 'x' }, 'staff.test@gplink-test.local');
    expect(tasksOf(a).filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1)).toEqual([]);
  });

  it('auVisaStageForUser: one answer per kind of doctor, and "hold" when the rows cannot be read', async () => {
    const cases = [
      [doctor('au_vr'), 'none', 'citizen_or_permanent_resident'],
      [bCitizenSupervised(), 'none', 'citizen_or_permanent_resident'],
      [bSponsoredGeneral(), 'transfer', 'visa_tied_to_an_employer'],
      [bUnknown(), 'unknown', 'right_to_work_not_recorded'],
      [doctor('au_restricted', { credentials: { visa_sponsor_tied: false } }), 'none', 'visa_not_tied_to_an_employer'],
      [doctor('au_restricted', { credentials: { visa_sponsor_tied: null } }), 'unknown', 'sponsor_tie_not_recorded'],
      [doctor('au_non_vr', { credentials: { work_rights: 'visa', visa_sponsor_tied: true } }), 'none', 'segment_has_no_visa_stage'],
      [doctor('overseas_null'), 'overseas', null]
    ];
    for (const [d, mode, reason] of cases) {
      expect((await t.auVisaStageForUser(d.userId)).verdict, d.kind + ' ' + mode).toEqual({ mode, reason });
    }
    const b = bSponsoredGeneral();
    rig.emu.failTables = { gp_credentials: 500 };
    expect((await t.auVisaStageForUser(b.userId)).verdict.mode).toBe('hold');
    expect((await visaUpdate(b)).status).toBe(503);
    rig.emu.failTables = {};
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    expect((await t.auVisaStageForUser(b.userId)).verdict.mode).toBe('overseas');
    expect(rig.emu.requests.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('supervision: done when the Ahpra approval is filed', () => {
  const fileFor = (d, slot) => rig.post('/api/ats/candidate/document', {
    case_id: d.caseId, slot: 'au:' + slot, fileName: 'approval.pdf', mimeType: 'application/pdf',
    fileBase64: Buffer.from('%PDF-1.4 fake approval').toString('base64')
  }, rig.superAdmin());

  it('staff file the approval in the "Supervision plan" slot: the supervision task closes; nothing is sent', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    rig.resetRecorders();
    const res = await fileFor(d, 'au_supervision_plan');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await rig.settle(80);
    const task = byKind(d, 'supervision_relodgement')[0];
    expect(task.status).toBe('completed');
    expect(metaOf(task)).toMatchObject({ approval_filed: true, approval_document_key: 'au_supervision_plan' });
    // the pack tasks are left as they are when only a document is filed
    expect(tasksOf(d).filter((x) => ['sppa_00', 'supervisor_cv'].indexOf(x.related_document_key) !== -1 && x.status === 'completed')).toEqual([]);
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
    expect((await view(d)).json.supervision.approval_document).toMatchObject({ has: true, staff_filed: true });
  });

  it('the visa grant notice filed by staff closes the transfer\'s "file the grant notice" task', async () => {
    const d = bSponsoredGeneral();
    await place(d);
    await seg('visa-transfer/decision', d, CONFIRM);
    const res = await fileFor(d, 'au_immigration_grant_notice');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await rig.settle(80);
    expect(byKind(d, 'visa_transfer_task').find((x) => metaOf(x).mark === 'grant_notice').status).toBe('completed');
    expect(byKind(d, 'visa_transfer_task').filter((x) => x.status === 'completed').length).toBe(1);
  });

  it('"Record Ahpra outcome" approved: saves the registration as staff-confirmed, closes the supervision task and the pack, opens NO visa case, sends nothing', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    rig.resetRecorders();
    const bad = await seg('ahpra-outcome', d, { outcome: 'approved' });
    expect(bad.status).toBe(400);
    expect(bad.json.errors.visa_action).toBeTruthy();
    const res = await seg('ahpra-outcome', d, { outcome: 'approved', registration_type: 'limited', supervision_level: 'level_1', registration_expiry: '2027-09-30', visa_action: 'transfer_of_nomination', note: 'Letter dated 20 November.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // (Section G was already delivered and its task closed by the placement itself.)
    expect(res.json.closed.sort()).toEqual(['practice_pack_child:sppa_00', 'practice_pack_child:supervisor_cv', 'supervision_relodgement']);
    expect(tasksOf(d).filter((x) => SUPERVISION_KEYS.indexOf(x.related_document_key) !== -1 && x.status !== 'completed')).toEqual([]);
    expect(credOf(d)).toMatchObject({ supervision_level: 'level_1', registration_expiry: '2027-09-30', ahpra_registration_type: 'limited' });
    expect(credOf(d).ahpra_last_checked_by).toBeTruthy();
    expect(byKind(d, 'supervision_relodgement')[0].status).toBe('completed');
    // the two visa variants: a transfer never opens a case by itself
    expect(visaCasesOf(d)).toEqual([]);
    expect(byKind(d, 'visa_transfer_decision').length).toBe(1);
    expect(byKind(d, 'visa_transfer_decision')[0].status).toBe('open');
    expect(res.json.practice_draft.variant).toBe('transfer_of_nomination');
    expect(res.json.practice_draft.body).toMatch(/This is a transfer of the existing nomination, not a new visa application/);
    expect(res.json.practice_draft.body).not.toMatch(/Subclass 482 nomination|passport|AHPRA\b/);
    // a draft, never sent
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
    expect(rig.table('visa_documents')).toEqual([]);
    // the overseas grant columns on the case are untouched
    expect(rig.caseOf(d).ahpra_registration_granted_at == null).toBe(true);
    expect(rig.caseOf(d).stage).toBe('prestart');
  });

  it('"no visa action" for a citizen: the draft says nothing about a visa; "not approved" leaves the task open', async () => {
    const d = bCitizenSupervised();
    await place(d);
    const no = await seg('ahpra-outcome', d, { outcome: 'not_approved', visa_action: 'no_visa_action', note: 'Ahpra asked for a different supervisor.' });
    expect(no.status).toBe(200);
    expect(byKind(d, 'supervision_relodgement')[0].status).toBe('open');
    expect(no.json.closed).toEqual([]);
    const yes = await seg('ahpra-outcome', d, { outcome: 'approved', visa_action: 'transfer_of_nomination' });
    expect(yes.status).toBe(200);
    // a citizen has no visa stage: asking for the transfer variant changes nothing and creates nothing
    expect(yes.json.practice_draft.variant).toBe('no_visa_action');
    expect(yes.json.practice_draft.subject + yes.json.practice_draft.body).not.toMatch(/\bvisas?\b|nomination|migration agent/i);
    expect(careerIntro.auPracticeTextViolations(yes.json.practice_draft.subject + '\n' + yes.json.practice_draft.body)).toEqual([]);
    expect(tasksOf(d).filter((x) => VISA_TASK_TYPES.indexOf(x.task_type) !== -1)).toEqual([]);
    expect(visaCasesOf(d)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the 19AB and DPA check: completion flow', () => {
  function withCheckTask(d) {
    rig.table('registration_tasks').push({
      id: fakeUuid('t', String(7000 + seq)), case_id: d.caseId, task_type: 'dpa_19ab_check', status: 'open',
      title: '19AB and DPA check: Dr Test', source_trigger: 'au_ats_stage', related_stage: 'placement',
      metadata: { au: true, owner: 'consultant', checklist_row: 2 }, created_at: '2026-11-20T02:00:00.000Z'
    });
  }
  const eligibility = async (d) => (await rig.get('/api/ats/candidate/role-eligibility?user_id=' + d.userId + '&career_role_id=' + ROLE_ID, rig.consultant())).json;

  it('recording "does not apply" writes the staff-confirmed answer, closes the task, and opens non-DPA roles in the eligibility staff see', async () => {
    const d = doctor('au_restricted', { credentials: Object.assign({}, SUPERVISED, { moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null }) });
    withCheckTask(d);
    // WP-29 (deliberate): this doctor is on limited registration. That used to
    // mean "needs a role that accepts supervised doctors", so the role was
    // marked `accepts_supervised`. Supervision no longer filters any role; a
    // doctor on limited registration is simply "not VR", so the role that fits
    // them is one that accepts non-VR doctors. `accepts_supervised` alone is
    // asserted to change nothing.
    const role = rig.table('career_roles').find((r) => r.id === ROLE_ID);
    const vrWas = role.vr_requirement;
    const sponsorWas = role.visa_pathway_aligned;
    role.accepts_supervised = true;
    try {
      const supervisedOnly = await eligibility(d);
      expect(supervisedOnly.roles[0].eligible).toBe(false);
      expect(supervisedOnly.roles[0].reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['dpa_restricted', 'vr_required']));
      expect(supervisedOnly.roles[0].reasons.map((r) => r.code)).not.toContain('supervised_not_accepted');
      role.vr_requirement = 'non_vr_accepted';
      // WP-29 (deliberate): this doctor's right to work is a visa tied to a
      // sponsor, so the role must also be one whose practice offers
      // sponsorship; until it says so, that is a reason of its own.
      const noSponsor = await eligibility(d);
      expect(noSponsor.roles[0].eligible).toBe(false);
      expect(noSponsor.roles[0].reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['dpa_restricted', 'sponsorship_not_offered']));
      role.visa_pathway_aligned = true;
      const before = await eligibility(d);
      expect(before.roles[0].eligible).toBe(false);
      expect(before.roles[0].reasons.map((r) => r.code)).toContain('dpa_restricted');
      expect(before.roles[0].reasons.map((r) => r.code)).not.toContain('vr_required');
      expect((await view(d)).json.moratorium).toMatchObject({ staff_confirmed: null, dpa_restricted: true });

      const bad = await seg('dpa-19ab', d, { applies: 'maybe' });
      expect(bad.status).toBe(400);
      expect(tasksOf(d).find((x) => x.task_type === 'dpa_19ab_check').status).toBe('open');

      const res = await seg('dpa-19ab', d, { applies: 'no', note: 'Exemption letter sighted and filed.' }, rig.consultant());
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json).toMatchObject({ applies: 'no', tasks_closed: 1, dpa_restricted: false });
      expect(credOf(d).moratorium_19ab_confirmed_status).toBe('no');
      expect(credOf(d).moratorium_19ab_confirmed_by).toBeTruthy();
      expect(credOf(d).moratorium_19ab_confirmed_at).toBeTruthy();
      const task = tasksOf(d).find((x) => x.task_type === 'dpa_19ab_check');
      expect(task.status).toBe('completed');
      expect(metaOf(task)).toMatchObject({ result_19ab: 'no', result_note: 'Exemption letter sighted and filed.' });
      const after = await eligibility(d);
      expect(after.roles[0].eligible).toBe(true);
      expect(res.json.view.moratorium).toMatchObject({ staff_confirmed: 'no', dpa_restricted: false });
      // still held: the doctor cannot self-serve, whatever the 19AB answer
      // (WP-29: held because they are not a vocationally registered GP).
      expect(after.hold).toBe(true);
      expect(after.hold_kind).toBe('review');
      expect(after.roles[0]).toMatchObject({ eligible: true, can_self_apply: false, hold: true });
      // ...and the same doctor still does not fit a VR-only role, with or without `accepts_supervised`.
      role.vr_requirement = 'vr_required';
      const vrOnly = await eligibility(d);
      expect(vrOnly.roles[0].eligible).toBe(false);
      expect(vrOnly.roles[0].reasons.map((r) => r.code)).toEqual(['vr_required', 'pathway_on_hold']);
    } finally {
      delete role.accepts_supervised;
      if (vrWas === undefined) delete role.vr_requirement; else role.vr_requirement = vrWas;
      if (sponsorWas === undefined) delete role.visa_pathway_aligned; else role.visa_pathway_aligned = sponsorWas;
    }
  });

  it('recording "applies" with an end date keeps the doctor to DPA roles; a failed save closes nothing (fail closed)', async () => {
    const d = doctor('au_restricted', { credentials: { moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null, moratorium_19ab_end_date: null } });
    withCheckTask(d);
    rig.emu.failTables = { gp_credentials: 500 };
    const failed = await seg('dpa-19ab', d, { applies: 'no', note: 'Checked the letter.' });
    rig.emu.failTables = {};
    expect([502, 503]).toContain(failed.status);
    expect(tasksOf(d).find((x) => x.task_type === 'dpa_19ab_check').status).toBe('open');
    expect(credOf(d).moratorium_19ab_confirmed_status).toBe(null);

    const res = await seg('dpa-19ab', d, { applies: 'yes', end_date: '2031-03-01', note: 'Services Australia confirmed by phone.' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ applies: 'yes', end_date: '2031-03-01', dpa_restricted: true, dpa_restricted_reason: 'staff_confirmed_19ab_applies' });
    expect(credOf(d)).toMatchObject({ moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_end_date: '2031-03-01' });
    expect((await eligibility(d)).roles[0].reasons.map((r) => r.code)).toContain('dpa_restricted');
  });

  it('segment C can have the check completed too; segment A shows no card content and an overseas doctor is refused', async () => {
    const c = doctor('au_non_vr');
    withCheckTask(c);
    expect((await seg('dpa-19ab', c, { applies: 'yes', note: 'Checked with the doctor.' })).status).toBe(200);
    expect(tasksOf(c).find((x) => x.task_type === 'dpa_19ab_check').status).toBe('completed');
    const a = doctor('au_vr');
    const va = (await view(a)).json;
    expect(va).toMatchObject({ ok: true, applies: false, segment: 'A' });
    expect(va.can.complete_19ab).toBe(false);
    expect(va.visa).toBeUndefined();
    expect(va.supervision).toBeUndefined();
    const o = doctor('overseas_null');
    expect((await seg('dpa-19ab', o, { applies: 'no', note: 'Should be refused.' })).status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('N21: only when a staff member confirms the outcomes and chooses to send', () => {
  it('nothing is sent on placement, on the decision or on the outcome; the preview says what is missing; a confirmed send goes once', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    const n21 = () => rig.emails.filter((e) => /what we have confirmed/.test(String(e.subject)));
    expect(n21()).toEqual([]);
    // the visa decision is not made yet
    let pv = (await seg('n21-preview', d)).json;
    expect(pv).toMatchObject({ ok: true, ready: false, missing: ['visa'] });
    expect(pv.gp).toBe(null);
    const early = await seg('n21-send', d, { to: ['gp', 'practice'], confirm: true });
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('outcomes_not_confirmed');
    expect(n21()).toEqual([]);

    await seg('visa-transfer/decision', d, CONFIRM);
    expect(n21()).toEqual([]);
    pv = (await seg('n21-preview', d)).json;
    expect(pv.ready).toBe(true);
    expect(pv.outcomes).toEqual({ moratorium: 'dpa_only', supervision: 'needed', visa: 'transfer_in_progress', visaWordsAllowed: true });
    expect(pv.gp.body).toMatch(/your nomination is being transferred to Test Metro Practice \(FAKE\)/);
    expect(n21(), 'a preview sends nothing').toEqual([]);

    // a person must tick the box and choose who
    expect((await seg('n21-send', d, { to: ['gp'] })).status).toBe(400);
    expect((await seg('n21-send', d, { to: [], confirm: true })).status).toBe(400);
    expect(n21()).toEqual([]);

    rig.resetRecorders();
    const sent = await seg('n21-send', d, { to: ['gp', 'practice'], confirm: true }, rig.consultant());
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.sent).toEqual({ gp: { sent: true }, practice: { sent: true, reason: null } });
    const toDoctor = emailsTo(d.email);
    const toPractice = emailsTo(PRACTICE_EMAIL);
    expect(toDoctor.length).toBe(1);
    expect(toPractice.length).toBe(1);
    expect(toDoctor[0].subject).toBe('Your new practice: what we have confirmed');
    // wording: the full banned list, minus only "visa" for this sponsor-tied doctor, in N21
    const who = { pathway: 'au_restricted', credentials: credOf(d), context: 'n21' };
    const doctorText = toDoctor[0].subject + '\n' + text(toDoctor[0].html);
    expect(auDoctorText.violationsFor(doctorText, who)).toEqual([]);
    expect(auDoctorText.violations(doctorText)).toEqual(['visa']);
    expect(doctorText).not.toMatch(/AHPRA|SPPA|Section G|supervisor CV/);
    const practiceText = toPractice[0].subject + '\n' + text(toPractice[0].html) + '\n' + toPractice[0].text;
    expect(careerIntro.auPracticeTextViolations(practiceText, who)).toEqual([]);
    expect(careerIntro.auPracticeTextViolations(practiceText)).toEqual(['Visa']);
    expect(practiceText).not.toMatch(/AHPRA|internationally trained|Expedited Specialist/);
    expect(rig.whatsapps).toEqual([]);
    // no bell item: N21 is an email
    expect(JSON.stringify((rig.stateOf(d) || {}).gp_link_updates || [])).not.toMatch(/what we have confirmed/);

    // the same outcomes are never sent twice
    const again = await seg('n21-send', d, { to: ['gp', 'practice'], confirm: true });
    expect(again.json.sent).toEqual({ gp: { sent: false, reason: 'already_sent' }, practice: { sent: false, reason: 'already_sent' } });
    expect(emailsTo(d.email).length).toBe(1);
    expect(emailsTo(PRACTICE_EMAIL).length).toBe(1);
  });

  it('a citizen segment B doctor: N21 never carries the word "visa", to the doctor or the practice', async () => {
    const d = bCitizenSupervised();
    await place(d);
    const pv = (await seg('n21-preview', d)).json;
    expect(pv.ready).toBe(true);
    expect(pv.outcomes).toMatchObject({ visa: 'not_applicable', visaWordsAllowed: false });
    rig.resetRecorders();
    const sent = await seg('n21-send', d, { to: ['gp', 'practice'], confirm: true });
    expect(sent.status).toBe(200);
    const doctorText = emailsTo(d.email)[0].subject + '\n' + text(emailsTo(d.email)[0].html);
    expect(auDoctorText.violations(doctorText)).toEqual([]);
    expect(doctorText).not.toMatch(/nomination/i);
    const practice = emailsTo(PRACTICE_EMAIL)[0];
    expect(careerIntro.auPracticeTextViolations(practice.subject + '\n' + practice.text)).toEqual([]);
  });

  it('unconfirmed facts cannot be sent: no staff 19AB answer, or a registration no person has checked', async () => {
    const d = doctor('au_restricted', { credentials: { ahpra_registration_type: 'limited', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null } });
    await place(d);
    const pv = (await seg('n21-preview', d)).json;
    expect(pv.ready).toBe(false);
    expect(pv.missing.sort()).toEqual(['moratorium', 'supervision', 'visa']);
    rig.resetRecorders();
    expect((await seg('n21-send', d, { to: ['gp'], confirm: true })).status).toBe(409);
    expect(rig.emails).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('switch off', () => {
  it('the routes do not exist, nothing is read, and the helpers do nothing', async () => {
    const d = bSponsoredSupervised();
    await place(d);
    await seg('visa-transfer/decision', d, CONFIRM);
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    expect((await view(d)).status).toBe(404);
    for (const action of ['visa-transfer/decision', 'visa-transfer/update', 'visa-transfer/nomination-approved', 'ahpra-outcome', 'dpa-19ab', 'n21-preview', 'n21-send']) {
      expect((await seg(action, d, CONFIRM)).status, action).toBe(404);
    }
    expect(await t.auDoctorTransferPageView(d.userId)).toBe(null);
    expect(await t.auOnSegmentBDocumentFiled(d.userId, 'au_supervision_plan')).toBe(null);
    expect(await t.auNoteSupervisionPaperworkComplete(d.caseId, d.userId)).toBe(null);
    expect(await t.auVisaCaseCreationBlock(d.userId)).toBe(null);
    expect(await t.auSegmentBAhpraMailCandidates()).toEqual([]);
    expect(await t.auAhpraMailRouteForCase({ id: d.caseId, user_id: d.userId, stage: 'prestart' })).toBe('overseas');
    expect(await t.auEmailRoutingPathwayFor({ id: d.caseId, user_id: d.userId, stage: 'prestart' })).toBe(null);
    expect(rig.emu.requests.length).toBe(before);
    // (a signed-in doctor's request reads their session's own rows first, as every doctor request does)
    expect((await rig.get('/api/gp/au-visa-transfer', { cookie: rig.gpCookie(d.email, d.userId) })).status).toBe(404);
  });
});
