// WP-14 (Australian GP build): the supervised-practice jobs and regulator mail,
// on the real server.
//
// WP-04 left every doctor on an Australian pathway out of the SPPA-00 practice
// chase, the SPPA backfill scan, the Section G sweep and the "documents
// complete" notifier. WP-11 then started creating those tasks for a SUPERVISED
// segment B doctor, so nothing drove them forward. WP-14 replaces the blanket
// exclusion with a per-doctor question to the placement-hook matrix:
//
//                                     chase  backfill  Section G  docs-complete
//   overseas (nothing recorded)        yes     yes       yes       today's message
//   A  au_vr                           no      no        no        nothing
//   C  au_non_vr                       no      no        no        nothing
//   B  supervised (limited)            YES     YES       YES       a note for STAFF
//   B  not supervised (general)        no      no        no        nothing
//   B  registration not on file        HELD    HELD      HELD      nothing
//
// The second half is regulator mail: a segment B doctor's AHPRA email matches
// their case and becomes ONE staff card; an A or C doctor's lands as a plain
// email card; the grant flow never opens a visa case for an Australian pathway.
//
// Every identity is fake. Gmail and the AI are never reached.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const careerIntro = require('../lib/career-intro.js');

const DAY = 86400000;
const CRON = { headers: { Authorization: 'Bearer test-cron-secret' } };
const PRACTICE_EMAIL = 'practice.test@gplink-test.local';
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

let h, t, realHarnessFetch;
const outbound = [];
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));

// The six doctors of the table above. `expect` is what each job must do.
const KINDS = [
  { key: 'overseas', kind: 'overseas_null', cred: null, sweep: 'overseas' },
  { key: 'a', kind: 'au_vr', cred: {}, sweep: 'exclude' },
  { key: 'c', kind: 'au_non_vr', cred: {}, sweep: 'exclude' },
  { key: 'b_supervised', kind: 'au_restricted', cred: { ahpra_registration_type: 'limited', supervision_level: 'level_2', specialist_gp: false }, sweep: 'include' },
  { key: 'b_general', kind: 'au_restricted', cred: {}, sweep: 'exclude' },
  { key: 'b_unknown', kind: 'au_restricted', cred: { ahpra_registration_type: null, supervision_level: null }, sweep: 'hold' }
];

function build(suffix) {
  return KINDS.map((k, i) => {
    const isAu = k.kind !== 'overseas_null';
    const d = buildAuDoctor(k.kind, {
      idSuffix: suffix + i,
      caseRow: { stage: isAu ? 'prestart' : 'ahpra', created_at: ago(60), updated_at: ago(40) },
      profile: { last_name: 'Sweep' + k.key.replace(/_/g, '') },
      credentials: k.cred || undefined
    });
    d.key = k.key;
    d.sweep = k.sweep;
    return d;
  });
}

// The rows that make each job WANT to act on every one of them: an SPPA-00
// sent to the practice ten days ago, a Section G task with no file behind it,
// the pack's other tasks done.
function rowsFor(d) {
  const meta = { au: d.key !== 'overseas', placement_key: 'pk-' + d.userId };
  return {
    registration_tasks: [
      { id: 'sppa-' + d.userId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'sppa_00', related_stage: 'prestart', status: 'waiting_on_practice', title: 'SPPA-00', gmail_thread_id: null, created_at: ago(20), updated_at: ago(10),
        metadata: Object.assign({ sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE_EMAIL, sent_to_practice_at: ago(10) }, meta) },
      { id: 'sg-' + d.userId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', related_stage: 'prestart', status: 'deferred', title: 'Section G', created_at: ago(20), updated_at: ago(20), metadata: meta },
      { id: 'cv-' + d.userId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', related_stage: 'prestart', status: 'completed', title: 'Supervisor CV', created_at: ago(20), updated_at: ago(20), metadata: meta },
      { id: 'oc-' + d.userId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'offer_contract', related_stage: 'prestart', status: 'completed', title: 'Offer / Contract', created_at: ago(20), updated_at: ago(20), metadata: meta }
    ]
  };
}

const EMPTY_TABLES = ['registration_tasks', 'task_messages', 'task_timeline', 'task_documents', 'user_documents', 'gp_applications', 'placements',
  'gp_nudge_log', 'user_nudges', 'practice_doc_ops', 'user_roles', 'runtime_kv', 'visa_applications', 'visa_documents', 'visa_dependants',
  'visa_timeline_events', 'pbs_applications', 'support_tickets', 'case_events', 'processed_gmail_messages', 'email_suppression', 'cron_runs',
  'doubletick_messages', 'scheduled_calls', 'career_interviews', 'admin_audit_log'];

function loadDb(doctors, extraRows) {
  const db = buildAuFixtureDb(doctors);
  EMPTY_TABLES.forEach((name) => { if (!db[name]) db[name] = []; });
  doctors.forEach((d) => {
    const extra = extraRows === false ? {} : rowsFor(d);
    Object.keys(extra).forEach((name) => { db[name] = (db[name] || []).concat(extra[name]); });
  });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') h.emu.db[name].length = 0; });
  Object.keys(db).forEach((name) => {
    const target = h.emu.table(name);
    db[name].forEach((row) => target.push(JSON.parse(JSON.stringify(row))));
  });
  h.emu.reset();
  outbound.length = 0;
}
const cron = (path) => h.get(path, CRON);
const taskOf = (d, prefix) => h.emu.table('registration_tasks').find((x) => x.id === prefix + '-' + d.userId);
const tasksOf = (d) => h.emu.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const timelineOf = (d) => h.emu.table('task_timeline').filter((x) => x.case_id === d.caseId).map((x) => String(x.title));
const emails = () => outbound.filter((c) => /resend/.test(c.url)).map((c) => c.body || {});
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 200));

beforeAll(async () => {
  h = await bootAuTestServer({
    name: 'wp14-sweeps-mail',
    tables: buildAuFixtureDb([]),
    env: { RESEND_API_KEY: 'test-resend-key', DOUBLETICK_API_KEY: 'test-doubletick-key', NOTIFY_TEST_RECIPIENTS: '' },
    emulator: { defaults: { registration_tasks: { status: 'open' } } }
  });
  t = h.testUtils;
  realHarnessFetch = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('http://127.0.0.1') === 0) return realHarnessFetch(url, init);
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = String(init && init.body); }
    outbound.push({ url: u, body });
    const payload = /doubletick/.test(u) ? { messages: [{ messageId: 'wa-test', status: 'SENT' }] } : { id: 'msg-test' };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
}, 60000);
afterAll(async () => {
  if (realHarnessFetch) globalThis.fetch = realHarnessFetch;
  if (h) await h.close();
});
beforeEach(() => {
  h.setSwitch(true);
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
  h.emu.failTables = {};
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the per-doctor predicate', () => {
  it('auSupervisedSweepVerdict: one answer per kind of doctor, for every row, and it costs nothing with the switch off', async () => {
    const doctors = build('p');
    loadDb(doctors);
    for (const row of ['sppa00Task', 'sectionGDelivery']) {
      const index = await t.auSweepPathwayIndex('wp14-test');
      for (const d of doctors) {
        expect(await t.auSupervisedSweepVerdict(index, d.userId, row), d.key + ' ' + row).toBe(d.sweep);
        expect(await t.auSupervisedSweepVerdictForCase(index, d.caseId, row), d.key + ' ' + row + ' (by case)').toBe(d.sweep);
      }
      // the summary counts who was left alone: A, C, B general, B unknown (not the included doctor, not the overseas one)
      expect(index.summary().excluded_au_pathway).toBe(4);
    }
    // pathways unreadable: every doctor is held, including the overseas one
    h.emu.failTables = { user_profiles: 500 };
    const unreadable = await t.auSweepPathwayIndex('wp14-test');
    h.emu.failTables = {};
    for (const d of doctors) expect(await t.auSupervisedSweepVerdict(unreadable, d.userId, 'sppa00Task'), d.key).toBe('hold');
    // the credentials row cannot be read for one segment B doctor: held, never guessed
    const index = await t.auSweepPathwayIndex('wp14-test');
    h.emu.failTables = { gp_credentials: 500 };
    expect(await t.auSupervisedSweepVerdict(index, doctors[3].userId, 'sppa00Task')).toBe('hold');
    h.emu.failTables = {};
    // a doctor part-way through the Australian onboarding branch (no pathway yet) is still left alone
    const started = buildAuDoctor('overseas_null', { idSuffix: 'pst', state: { gp_au_branch_started_at: ago(1) } });
    loadDb(doctors.concat([started]));
    const withStarted = await t.auSweepPathwayIndex('wp14-test');
    expect(await t.auSupervisedSweepVerdict(withStarted, started.userId, 'sppa00Task')).toBe('exclude');

    h.setSwitch(false);
    const before = h.emu.requests.length;
    const off = await t.auSweepPathwayIndex('wp14-test');
    for (const d of doctors) expect(await t.auSupervisedSweepVerdict(off, d.userId, 'sppa00Task'), d.key).toBe('overseas');
    expect(h.emu.requests.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('each supervised-practice job includes a supervised segment B doctor and excludes A and C', () => {
  it('the SPPA-00 practice chase (chase-nonresponders, pass A)', async () => {
    const doctors = build('c');
    loadDb(doctors);
    const res = await cron('/api/cron/chase-nonresponders');
    expect(res.status).toBe(200);
    await settle();
    const sent = emails().filter((e) => [].concat(e.to || []).join(',').indexOf(PRACTICE_EMAIL) !== -1);
    for (const d of doctors) {
      const chased = Number(metaOf(taskOf(d, 'sppa')).practice_chase_count) || 0;
      const expected = d.sweep === 'include' || d.sweep === 'overseas' ? 1 : 0;
      expect(chased, d.key + ': chased').toBe(expected);
      expect(timelineOf(d).filter((x) => /Automatic reminder sent/.test(x)).length, d.key + ': timeline').toBe(expected);
    }
    expect(sent.length).toBe(2);
    const forB = sent.find((e) => /Sweepbsupervised/.test(String(e.subject)));
    const forOverseas = sent.find((e) => /Sweepoverseas/.test(String(e.subject)));
    // the overseas reminder is byte for byte what it was
    expect(forOverseas.subject).toBe('Reminder: Supervised Practice Plan (SPPA-00) for Dr Test Sweepoverseas');
    expect(forOverseas.html).toContain('we are still waiting on the completed and signed Supervised Practice Plan Agreement (SPPA-00) for Dr Test Sweepoverseas.');
    // the segment B reminder is worded for a doctor already here, changing practice
    expect(forB.subject).toBe('Reminder: supervised practice paperwork for Dr Test Sweepbsupervised');
    expect(forB.html).toContain('who is joining your practice and needs a new supervised practice arrangement with you');
    expect(careerIntro.auPracticeTextViolations(forB.subject + '\n' + forB.html.replace(/<[^>]+>/g, ' '))).toEqual([]);
    expect(forB.subject + forB.html).not.toMatch(/AHPRA|internationally|overseas|relocat/i);
    // a second run the same day chases nobody again
    outbound.length = 0;
    await cron('/api/cron/chase-nonresponders');
    await settle();
    expect(emails().filter((e) => [].concat(e.to || []).join(',').indexOf(PRACTICE_EMAIL) !== -1)).toEqual([]);
  });

  it('the SPPA backfill scan (sppa-backfill-scan)', async () => {
    const doctors = build('s');
    loadDb(doctors);
    const res = await cron('/api/cron/sppa-backfill-scan');
    expect(res.status).toBe(200);
    const byCase = {};
    res.json.results.forEach((r) => { byCase[r.case_id] = r.action; });
    for (const d of doctors) {
      if (d.sweep === 'exclude') expect(byCase[d.caseId], d.key).toBe('skip_au_pathway');
      else if (d.sweep === 'hold') expect(byCase[d.caseId], d.key).toBe('skip_pathway_unreadable');
      else expect(String(byCase[d.caseId]), d.key).not.toMatch(/^skip_(au_pathway|pathway_unreadable)$/);
    }
    // the included doctor really went through the scan (it asked for the documents the scan reads)
    const b = doctors[3];
    expect(h.emu.requests.some((r) => r.table === 'registration_tasks' && r.method === 'GET' && String(r.query).indexOf('supervisor_cv,offer_contract') !== -1 && String(r.query).indexOf(b.caseId) !== -1)).toBe(true);
    const a = doctors[1];
    expect(h.emu.requests.some((r) => r.table === 'registration_tasks' && r.method === 'GET' && String(r.query).indexOf('supervisor_cv,offer_contract') !== -1 && String(r.query).indexOf(a.caseId) !== -1)).toBe(false);
  });

  it('the Section G sweep (reconcile-doc-tasks): delivered to the supervised doctor silently, to nobody else on an Australian pathway', async () => {
    const doctors = build('g');
    loadDb(doctors);
    const index = await t.auSweepPathwayIndex('wp14-section-g');
    const out = await t.sweepUndeliveredSectionG(25, index);
    await settle();
    expect(out.scanned).toBe(2);   // the overseas doctor and the supervised segment B doctor
    const docs = h.emu.table('user_documents').filter((x) => x.document_key === 'section_g');
    const got = (d) => docs.filter((x) => x.user_id === d.userId).length;
    expect(out).toEqual({ scanned: 2, repaired: 2, failed: 0 });
    for (const d of doctors) expect(got(d), d.key + ': Section G file').toBe(d.sweep === 'include' || d.sweep === 'overseas' ? 1 : 0);
    for (const d of doctors) if (d.sweep === 'exclude' || d.sweep === 'hold') expect(got(d), d.key).toBe(0);
    // nothing is emailed to the segment B doctor about it (the word is banned for them)
    const b = doctors[3];
    expect(emails().filter((e) => [].concat(e.to || []).join(',').indexOf(b.email) !== -1)).toEqual([]);
    // the cron route runs the same function with the job's own index
    const res = await cron('/api/cron/reconcile-doc-tasks');
    expect(res.status).toBe(200);
    expect(res.json.sectionG.scanned).toBeLessThanOrEqual(2);
  });

  it('the "documents complete" notifier: staff are told once for a supervised segment B doctor; the doctor is told nothing', async () => {
    const doctors = build('n');
    loadDb(doctors);
    const b = doctors[3];
    // still waiting on the SPPA-00 and Section G
    expect(await t._maybeNotifyAhpraDocsReady(b.caseId)).toEqual({ notified: false, reason: 'segment_b_pending', pending: ['sppa_00', 'section_g'] });
    for (const d of doctors) if (d.sweep === 'exclude' || d.sweep === 'hold') expect(await t._maybeNotifyAhpraDocsReady(d.caseId), d.key).toEqual({ notified: false, reason: 'au_pathway' });
    expect(timelineOf(b).filter((x) => /Supervision paperwork complete/.test(x))).toEqual([]);
    // everything in the pack is done
    for (const d of doctors) { taskOf(d, 'sppa').status = 'completed'; taskOf(d, 'sg').status = 'completed'; }
    outbound.length = 0;
    expect(await t._maybeNotifyAhpraDocsReady(b.caseId)).toEqual({ notified: false, reason: 'segment_b_staff_notified' });
    expect(await t._maybeNotifyAhpraDocsReady(b.caseId)).toEqual({ notified: false, reason: 'segment_b_staff_notified' });
    expect(timelineOf(b).filter((x) => x === 'Supervision paperwork complete: ready to lodge with Ahpra').length).toBe(1);
    for (const d of doctors) {
      if (d.sweep === 'exclude' || d.sweep === 'hold') {
        expect(await t._maybeNotifyAhpraDocsReady(d.caseId), d.key).toEqual({ notified: false, reason: 'au_pathway' });
        expect(timelineOf(d).filter((x) => /Supervision paperwork complete/.test(x)), d.key).toEqual([]);
      }
    }
    await settle();
    // no email, no WhatsApp, to anyone on an Australian pathway
    expect(outbound.filter((c) => /resend|doubletick/.test(c.url))).toEqual([]);
    // the overseas doctor still goes through the real check
    const o = doctors[0];
    const res = await t._maybeNotifyAhpraDocsReady(o.caseId);
    expect(['au_pathway', 'pathway_unreadable', 'segment_b_pending', 'segment_b_staff_notified']).not.toContain(res.reason);
  });

  it('with the switch off every job treats all six exactly alike (nobody is Australian)', async () => {
    const doctors = build('f');
    loadDb(doctors);
    h.setSwitch(false);
    const res = await cron('/api/cron/chase-nonresponders');
    expect(res.status).toBe(200);
    await settle();
    for (const d of doctors) expect(Number(metaOf(taskOf(d, 'sppa')).practice_chase_count) || 0, d.key).toBe(1);
    const sent = emails().filter((e) => [].concat(e.to || []).join(',').indexOf(PRACTICE_EMAIL) !== -1);
    expect(sent.length).toBe(6);
    for (const e of sent) expect(e.subject).toMatch(/^Reminder: Supervised Practice Plan \(SPPA-00\) for /);
    const scan = await cron('/api/cron/sppa-backfill-scan');
    expect(scan.json.results.filter((r) => /^skip_(au_pathway|pathway_unreadable)$/.test(r.action))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('regulator mail (ADM-14)', () => {
  const mail = (d, extra) => Object.assign({
    sender: 'Test Officer <officer@ahpra.gov.au>', to: d.email, cc: 'registration@gplink-test.local',
    subject: 'Ahpra - update on your registration', bodyText: 'Dear Doctor, please see the attached letter.', bodyHtml: null,
    date: '2026-11-21', threadId: 'thr-' + d.userId, rfc822MessageId: '<m-' + d.userId + '@ahpra.gov.au>', attachments: []
  }, extra || {});
  const caseOf = (d) => ({ id: d.caseId, user_id: d.userId, stage: h.emu.table('registration_cases').find((c) => c.id === d.caseId).stage, assigned_va: null });

  it('the route for a matched case: segment B a staff card, A and C a plain email card, overseas today\'s pipeline', async () => {
    const doctors = build('r');
    loadDb(doctors, false);
    const want = { overseas: 'overseas', a: 'plain_triage', c: 'plain_triage', b_supervised: 'segment_b', b_general: 'segment_b', b_unknown: 'segment_b' };
    for (const d of doctors) expect(await t.auAhpraMailRouteForCase(caseOf(d)), d.key).toBe(want[d.key]);
    // pathway unreadable on a case that looks Australian: a person, never the overseas pipeline
    h.emu.failTables = { user_profiles: 500 };
    expect(await t.auAhpraMailRouteForCase(caseOf(doctors[1]))).toBe('plain_triage');
    expect(await t.auAhpraMailRouteForCase(caseOf(doctors[0]))).toBe('overseas');
    h.emu.failTables = {};
  });

  it('the matcher\'s candidate list now includes segment B doctors on the Australian ladder, and only them', async () => {
    const doctors = build('m');
    loadDb(doctors, false);
    const cands = await t.auSegmentBAhpraMailCandidates();
    expect(cands.map((c) => c.user_id).sort()).toEqual(doctors.filter((d) => d.kind === 'au_restricted').map((d) => d.userId).sort());
    for (const c of cands) expect(c).toMatchObject({ stage: 'prestart', au_segment_b: true });
    // a segment B doctor whose case is not on the Australian ladder yet is not added (the overseas filter decides)
    h.emu.table('registration_cases').find((c) => c.id === doctors[3].caseId).stage = 'myintealth';
    expect((await t.auSegmentBAhpraMailCandidates()).map((c) => c.user_id)).not.toContain(doctors[3].userId);
  });

  it('a segment B doctor: ONE staff card on their case, an inbound message, nothing else; a decision letter is flagged as one', async () => {
    const doctors = build('b');
    loadDb(doctors, false);
    const b = doctors[3];
    const before = h.emu.requests.length;
    await t._processAhpraEmail(mail(b), 'gm-b-1', caseOf(b), { auOutcomeKind: 'granted', auMatchedVia: 'to_email' });
    const tasks = tasksOf(b);
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ task_type: 'ahpra_correspondence', status: 'open', priority: 'high', related_stage: 'prestart', source_trigger: 'au_segment_b_ahpra_mail', source_gmail_message_id: 'gm-b-1' });
    expect(tasks[0].title).toMatch(/^Ahpra letter \(segment B\): confirm the outcome/);
    expect(metaOf(tasks[0])).toMatchObject({ au_segment_b: true, registration_decision: true, outcome_kind: 'granted', matched_via: 'to_email' });
    expect(h.emu.table('task_messages').filter((m) => m.case_id === b.caseId && m.direction === 'inbound').length).toBe(1);
    // none of the overseas handling: no officer stored, no conflict letter, no request tray, no visa case, no stage move
    const c = h.emu.table('registration_cases').find((x) => x.id === b.caseId);
    expect(c.stage).toBe('prestart');
    expect(c.ahpra_officer_email == null).toBe(true);
    expect(c.ahpra_registration_granted_at == null).toBe(true);
    expect(h.emu.table('visa_applications')).toEqual([]);
    expect(h.emu.table('visa_documents')).toEqual([]);
    // no AI was asked, and nothing was sent
    expect(outbound.filter((x) => /anthropic|resend|doubletick/.test(x.url))).toEqual([]);
    // the same message again (the other mailbox's copy, or a retry) files nothing more
    await t._processAhpraEmail(mail(b), 'gm-b-1', caseOf(b), {});
    await t._processAhpraEmail(mail(b), 'gm-b-1-other-mailbox', caseOf(b), {});
    expect(tasksOf(b).length).toBe(1);
    // an ordinary email (not a decision) reads "read and action"
    await t._processAhpraEmail(mail(b, { rfc822MessageId: '<m2@ahpra.gov.au>', subject: 'Query about your application' }), 'gm-b-2', caseOf(b), {});
    const second = tasksOf(b).find((x) => x.source_gmail_message_id === 'gm-b-2');
    expect(second.title).toMatch(/^Ahpra email \(segment B\): read and action/);
    expect(metaOf(second).registration_decision).toBe(false);
    expect(h.emu.requests.slice(before).filter((r) => r.table === 'visa_applications' && r.method === 'POST')).toEqual([]);

    // the staff card lists both, and recording the outcome closes the decision letter's card (not the ordinary email's)
    const cardView = await h.get('/api/admin/au/segment-b?case_id=' + b.caseId, h.superAdmin());
    expect(cardView.json.supervision.ahpra_letters.map((l) => [l.open, l.decision]).sort()).toEqual([[true, false], [true, true]]);
    const res = await h.post('/api/admin/au/segment-b/ahpra-outcome', { case_id: b.caseId, outcome: 'approved', visa_action: 'no_visa_action' }, h.superAdmin());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.closed).toContain('ahpra_letter');
    expect(tasksOf(b).find((x) => x.source_gmail_message_id === 'gm-b-1').status).toBe('completed');
    expect(tasksOf(b).find((x) => x.source_gmail_message_id === 'gm-b-2').status).toBe('open');
    expect(h.emu.table('visa_applications')).toEqual([]);
    expect(outbound.filter((x) => /anthropic|resend|doubletick/.test(x.url))).toEqual([]);
  });

  it('a segment A or C doctor: a plain email card for a person, never auto-acted', async () => {
    const doctors = build('t');
    loadDb(doctors, false);
    for (const d of [doctors[1], doctors[2]]) {
      await t._processAhpraEmail(mail(d), 'gm-' + d.key, caseOf(d), { auOutcomeKind: 'granted' });
      const tasks = tasksOf(d);
      expect(tasks.length, d.key).toBe(1);
      expect(tasks[0], d.key).toMatchObject({ task_type: 'email_triage', source_trigger: 'gmail_triage', related_stage: 'prestart', gmail_message_id: 'gm-' + d.key });
      expect(tasks[0].title, d.key).toBe('✉️ Email: Ahpra - update on your registration');
      expect(tasks.filter((x) => x.task_type === 'ahpra_correspondence' || x.task_type === 'ahpra_action_item' || x.task_type === 'ahpra_conflict_letter'), d.key).toEqual([]);
      const c = h.emu.table('registration_cases').find((x) => x.id === d.caseId);
      expect(c.stage, d.key).toBe('prestart');
      expect(c.ahpra_officer_email == null, d.key).toBe(true);
    }
    expect(h.emu.table('visa_applications')).toEqual([]);
    expect(outbound.filter((x) => /anthropic|resend|doubletick/.test(x.url))).toEqual([]);
  });

  it('the grant handler never opens a visa case or a passport request for ANY Australian pathway, and says what to do for segment B', async () => {
    const doctors = build('h');
    loadDb(doctors, false);
    for (const d of doctors.slice(1)) {
      const out = await t.handleAhpraRegistrationGranted({
        caseId: d.caseId, userId: d.userId, source: { type: 'manual' }, actor: 'staff.test@gplink-test.local',
        registration: { registration_number: 'MED0001234567', registration_type: 'Specialist', effective_date: '2026-11-02', expiry_date: '2027-09-30' }
      });
      expect(out.ok, d.key).toBe(false);
      expect(out.skipped, d.key).toBe('au_pathway');
      expect(out.visaCaseId, d.key).toBe(null);
      expect(out.tasks, d.key).toEqual([]);
      expect(out.segment, d.key).toBe(d.kind === 'au_vr' ? 'A' : (d.kind === 'au_non_vr' ? 'C' : 'B'));
      if (d.kind === 'au_restricted') expect(out.errors[0], d.key).toMatch(/Record the Ahpra outcome from the "Segment B" card/);
      else expect(out.errors[0], d.key).toBe('This doctor is on the Australian pathway, so the overseas registration-granted steps (visa case, migration agent, passports) were not run.');
      const c = h.emu.table('registration_cases').find((x) => x.id === d.caseId);
      expect(c.stage, d.key).toBe('prestart');
      expect(c.ahpra_registration_number == null, d.key).toBe(true);
      expect(tasksOf(d), d.key).toEqual([]);
    }
    expect(h.emu.table('visa_applications')).toEqual([]);
    expect(h.emu.table('visa_documents')).toEqual([]);
    expect(h.emu.table('visa_dependants')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('college mail (ADM-23): what the server tells the router about the doctor', () => {
  it('an Australian-pathway doctor: { isAu, stage: the case\'s own stage }; an overseas doctor: null', async () => {
    const doctors = build('e');
    loadDb(doctors, false);
    const caseRow = (d) => h.emu.table('registration_cases').find((c) => c.id === d.caseId);
    expect(await t.auEmailRoutingPathwayFor(caseRow(doctors[0]))).toBe(null);
    for (const d of doctors.slice(1)) expect(await t.auEmailRoutingPathwayFor(caseRow(d)), d.key).toEqual({ isAu: true, stage: 'prestart' });
    // an Australian doctor whose case has not moved onto the Australian ladder yet: the first rung, never an overseas stage
    caseRow(doctors[1]).stage = 'myintealth';
    expect(await t.auEmailRoutingPathwayFor(caseRow(doctors[1]))).toEqual({ isAu: true, stage: 'placement' });
  });
});
