// WP-27 (Australian GP build), against the real server and the in-memory
// database:
//   review queue   the Australian kinds are raised, each once, with a deep
//                  link, and leave when the fact behind them is resolved; the
//                  overseas kinds and counters are untouched
//   gone-quiet     14 days for an Australian application, 60 for an overseas
//                  one; the go-live guard; the separate sentinel; the email;
//                  the tile; switch off
//   RSO workload   an unassigned Australian case is not "Unassigned" RSO work,
//                  and its document check is not routed to an RSO
//   request budget GET /api/ceo/overview with and without Australian doctors
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const fx = require('./helpers/au-wp27-fixtures.js');
const parity = require('./helpers/au-wp27-parity.js');

let h;
let t;
const AU = fx.auDoctors();
const OS = fx.overseasDoctors();
const table = (name) => h.emu.table(name);
const ceo = () => h.superAdmin();
const queue = async () => (await h.get('/api/ceo/review-queue', ceo())).json;
const kinds = (q, kind) => q.items.filter((it) => it.kind === kind);
const cred = (d) => table('gp_credentials').find((c) => c.user_id === d.userId);
const placement = (id) => table('placements').find((p) => p.id === id);
const taskRow = (id) => table('registration_tasks').find((x) => x.id === id);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: fx.NOW_MS });
  h = await bootLeadCopyServer({ name: 'wp27-server', mode: 'supabase', tables: fx.merged(fx.overseasTables(), fx.auTables()) });
  h.setSwitch(true);
  t = h.testUtils;
}, 60000);

afterAll(async () => {
  delete process.env.AU_STALLED_LIVE_FROM;
  delete process.env.AU_STALLED_APPLICATION_DAYS;
  if (h) await h.closeAll();
  vi.useRealTimers();
});

describe('WP-27 (ADM-24): Australian review kinds in the one queue', () => {
  it('raises each kind once, with the doctor, a plain title and a deep link', async () => {
    const q = await queue();
    expect(q.counts.au).toBe(13);
    expect(q.counts.au_kinds).toEqual({
      au_ahpra_flags: 1, au_ahpra_recheck: 1, au_19ab_mismatch: 1, au_19ab_role: 1, au_prestart_overdue: 2,
      au_held: 2, au_start_unconfirmed: 1, au_invoice_overdue: 3, au_credit_decision: 1
    });
    const au = q.items.filter((it) => it.au === true);
    // deduplicated: one key each
    expect(new Set(au.map((it) => it.key)).size).toBe(au.length);
    au.forEach((it) => {
      expect(it.gp_name).toMatch(/^Dr Testau /);
      expect(it.title).not.toMatch(/_|undefined|null/);
      expect(it.detail).not.toMatch(/undefined|null|NaN/);
      expect(it.focus).toMatch(/^au_(pathway|ahpra|eligibility|tasks|commencement)$/);
      expect(it.seen_token).toContain(it.key);
      // the link the popup builds: #candidate=<case>&focus=<card>
      expect(it.case_id || it.user_id).toBeTruthy();
    });
    const who = (kind) => kinds(q, kind).map((it) => it.gp_name.replace('Dr Testau ', '')).sort();
    expect(who('au_ahpra_flags')).toEqual(['Flags']);
    expect(who('au_ahpra_recheck')).toEqual(['Expiring']);
    expect(who('au_19ab_mismatch')).toEqual(['Mismatch']);
    expect(who('au_19ab_role')).toEqual(['Nondpa']);
    expect(who('au_prestart_overdue')).toEqual(['Prestart', 'Startreached']);
    expect(who('au_held')).toEqual(['Heldb', 'Heldc']);
    expect(who('au_start_unconfirmed')).toEqual(['Startreached']);
    expect(who('au_invoice_overdue')).toEqual(['Ended', 'Firstweek', 'Guarantee']);
    expect(who('au_credit_decision')).toEqual(['Ended']);
  });

  it('the overseas kinds and their counters are exactly what they were', async () => {
    const before = parity.readSnapshot('overseas-on').endpoints.reviewQueue.body;
    const q = await queue();
    ['register', 'register_pending', 'register_mismatch', 'account'].forEach((k) => expect(q.counts[k], k).toBe(before.counts[k]));
    const overseas = q.items.filter((it) => /Testos/.test(it.gp_name));
    expect(overseas).toEqual(before.items);
    // no Australian kind leaks into a row chip
    const flags = require('../lib/ceo-review-queue.js').flagsByUser(q.items);
    Object.keys(flags).forEach((uid) => expect(Object.keys(flags[uid]).sort()).toEqual(['account', 'register', 'register_label']));
  });

  it('CLEARED when resolved: each item leaves when the fact behind it changes, and nothing else moves', async () => {
    const count = async (kind) => kinds(await queue(), kind).length;

    // Ahpra flags: a person reviews them.
    Object.assign(cred(AU.flags), { flags_reviewed_at: fx.ago(0), flags_reviewed_by: fx.CONSULTANT_EMAIL });
    expect(await count('au_ahpra_flags')).toBe(0);

    // Registration expiring: staff check the register again.
    cred(AU.expiring).ahpra_last_checked_at = fx.ago(0);
    expect(await count('au_ahpra_recheck')).toBe(0);

    // 19AB role: the practice confirms the location is a DPA.
    const role = table('career_roles').find((r) => r.id === 'role-metro');
    const was = role.dpa_status;
    role.dpa_status = 'yes';
    expect(await count('au_19ab_role')).toBe(0);
    role.dpa_status = was;
    expect(await count('au_19ab_role')).toBe(1);
    // ... or the application closes.
    table('gp_applications').find((a) => a.id === 'app-au-nondpa').status = 'withdrawn';
    expect(await count('au_19ab_role')).toBe(0);

    // Overdue pre-start item: it is done.
    expect(await count('au_prestart_overdue')).toBe(2);
    Object.assign(taskRow('task-au-pre-provider'), { status: 'completed', completed_at: fx.ago(0) });
    expect(await count('au_prestart_overdue')).toBe(1);

    // Held doctor: the decision is recorded (the segment review is completed).
    Object.assign(taskRow('task-au-heldb-review'), { status: 'completed', completed_at: fx.ago(0) });
    expect(kinds(await queue(), 'au_held').map((it) => it.gp_name)).toEqual(['Dr Testau Heldc']);

    // Start date reached: commencement is confirmed. The invoice is then due.
    Object.assign(placement('plc-au-start'), { commenced_at: fx.dayAt(-2), invoice_due_at: fx.dayAt(-2), guarantee_ends_at: fx.dayAt(82) });
    expect(await count('au_start_unconfirmed')).toBe(0);

    // Invoice overdue: sent (and for the others, paid).
    expect(await count('au_invoice_overdue')).toBe(4);
    placement('plc-au-start').invoice_sent_at = fx.dayAt(0);
    placement('plc-au-first').invoice_sent_at = fx.dayAt(0);
    placement('plc-au-guar').invoice_paid_at = fx.dayAt(0);
    placement('plc-au-ended').invoice_paid_at = fx.dayAt(0);
    expect(await count('au_invoice_overdue')).toBe(0);

    // Credit decision: the CEO records it.
    placement('plc-au-ended').credit_pct = 50;
    expect(await count('au_credit_decision')).toBe(0);
  });

  it('19AB mismatch: "Mark reviewed" clears it; a NEW staff confirmation raises it again', async () => {
    expect(kinds(await queue(), 'au_19ab_mismatch').length).toBe(1);
    expect((await h.post('/api/ceo/au/19ab-mismatch/reviewed', { case_id: AU.mismatch.caseId }, h.consultant())).status).toBe(403);
    expect((await h.post('/api/ceo/au/19ab-mismatch/reviewed', {}, ceo())).status).toBe(400);
    const done = await h.post('/api/ceo/au/19ab-mismatch/reviewed', { case_id: AU.mismatch.caseId }, ceo());
    expect(done.status).toBe(200);
    const line = table('task_timeline').filter((r) => r.case_id === AU.mismatch.caseId && r.title === '19AB mismatch reviewed');
    expect(line.length).toBe(1);
    expect(line[0].event_type).toBe('system');
    expect(kinds(await queue(), 'au_19ab_mismatch').length).toBe(0);
    // a doctor with no mismatch, and an overseas doctor, are refused
    expect((await h.post('/api/ceo/au/19ab-mismatch/reviewed', { case_id: AU.looking.caseId }, ceo())).status).toBe(409);
    expect((await h.post('/api/ceo/au/19ab-mismatch/reviewed', { case_id: OS.o1.caseId }, ceo())).status).toBe(409);
    // staff confirm again (a new confirmation): it is a new thing to look at
    cred(AU.mismatch).moratorium_19ab_confirmed_at = fx.ago(0, 1);
    expect(kinds(await queue(), 'au_19ab_mismatch').length).toBe(1);
    // the doctor changes their answer to agree: nothing to review
    cred(AU.mismatch).moratorium_19ab_status = 'no';
    expect(kinds(await queue(), 'au_19ab_mismatch').length).toBe(0);
  });

  it('an archived doctor, a withdrawn case and an owner test account raise nothing', async () => {
    const before = (await queue()).counts.au;
    const p = table('user_profiles').find((x) => x.user_id === AU.heldC.userId);
    p.account_status = 'archived';
    expect((await queue()).counts.au).toBe(before - 1);
    p.account_status = 'active';
    p.email = 'khaleedmahmoud.au@gplink-test.local';
    expect((await queue()).counts.au).toBe(before - 1);
    p.email = AU.heldC.email;
    const c = table('registration_cases').find((x) => x.id === AU.heldC.caseId);
    c.status = 'withdrawn';
    expect((await queue()).counts.au).toBe(before - 1);
    c.status = 'active';
    expect((await queue()).counts.au).toBe(before);
  });

  it('switch off: no Australian item, no Australian counter, no Australian read', async () => {
    h.setSwitch(false);
    try {
      h.emu.reset();
      const q = await queue();
      expect('au' in q.counts).toBe(false);
      expect(q.items.some((it) => it.au === true)).toBe(false);
      expect(h.emu.requests.some((r) => /candidate_pathway|gp_credentials|gp_au_branch/.test(r.table + ' ' + r.query))).toBe(false);
    } finally { h.setSwitch(true); }
  });
});

describe('WP-27 (ADM-18): gone-quiet thresholds per pathway', () => {
  const sweep = () => h.cron('/api/cron/stalled-applications');
  const kv = (key) => { const row = table('runtime_kv').find((r) => r.key === key); return row ? row.value : null; };
  const reset = () => {
    delete process.env.AU_STALLED_LIVE_FROM;
    delete process.env.AU_STALLED_APPLICATION_DAYS;
    t.__resetAuStalledLiveFromForTest();
    const rows = table('runtime_kv');
    for (let i = rows.length - 1; i >= 0; i--) if (/^(stalled_application_alerts|stalled_application_alerts_au|au_stalled_live_from)$/.test(rows[i].key)) rows.splice(i, 1);
    const tl = table('task_timeline');
    for (let i = tl.length - 1; i >= 0; i--) if (tl[i].event_type === 'stalled_application_alert') tl.splice(i, 1);
    h.reset();
  };
  beforeEach(reset);

  it('one config value: default 14 days, env-overridable, never under 7', () => {
    expect(t.auStalledApplicationDays()).toBe(14);
    process.env.AU_STALLED_APPLICATION_DAYS = '10';
    expect(t.auStalledApplicationDays()).toBe(10);
    process.env.AU_STALLED_APPLICATION_DAYS = '3';
    expect(t.auStalledApplicationDays()).toBe(7);
    process.env.AU_STALLED_APPLICATION_DAYS = 'soon';
    expect(t.auStalledApplicationDays()).toBe(14);
  });

  it('THE GO-LIVE GUARD: the first run records "now" and reports no Australian application that last moved before it', async () => {
    const first = await sweep();
    await parity.settle(h);
    // The overseas item is alerted exactly as before; the Australian one (20 days quiet, last moved before go-live) is not.
    expect(first.json).toMatchObject({ checked: 1, stalled: 1, alerted: 1, emailed: true });
    expect(first.json.au).toEqual({ stalled: 0, alerted: 0, threshold_days: 14, live_from: fx.NOW });
    expect(kv('au_stalled_live_from')).toMatchObject({ at: fx.NOW });
    expect(h.emails.length).toBe(1);
    expect(h.emails[0].body.subject).toBe('Gone quiet: Testos Doc3 at Test Metro Practice (FAKE) (70 days)');
    expect(h.emails[0].body.html).not.toMatch(/Testau|Australian GPs/);
    expect(Object.keys(kv('stalled_application_alerts'))).toEqual(['app-o3-quiet']);
    expect(kv('stalled_application_alerts_au')).toBe(null);
    // the tile and the list agree
    expect((await h.get('/api/ats/attention', ceo())).json).toMatchObject({ stalled_applications: 1, stalled_threshold_days: 60, stalled_threshold_days_au: 14 });
    const list = (await h.get('/api/ats/stalled-applications', h.consultant())).json;
    expect(list.applications.map((a) => a.id)).toEqual(['app-o3-quiet']);
    expect(list).toMatchObject({ threshold_days: 60, threshold_days_au: 14, au_live_from: fx.NOW });
  });

  it('after go-live: an Australian application quiet for 14+ days is alerted under ITS threshold, with its own sentinel; the overseas item is unchanged', async () => {
    process.env.AU_STALLED_LIVE_FROM = fx.ago(30);
    const first = await sweep();
    await parity.settle(h);
    expect(first.json).toMatchObject({ checked: 1, stalled: 1, alerted: 1, emailed: true });
    expect(first.json.au).toEqual({ stalled: 1, alerted: 1, threshold_days: 14, live_from: fx.ago(30) });
    expect(h.emails.length).toBe(1);
    const mail = h.emails[0].body;
    expect(mail.subject).toBe('Gone quiet: 2 introduced applications with no movement');
    // each under the right threshold
    const [overseasPart, auPart] = mail.html.split('Australian GPs (already registered here)');
    expect(overseasPart).toContain('Testos Doc3');
    expect(overseasPart).toContain('<strong>60+ days</strong>');
    expect(overseasPart).not.toContain('Testau');
    expect(auPart).toContain('Testau Interview');
    expect(auPart).toContain('<strong>14+ days</strong>');
    expect(auPart).toContain('<strong>20 days</strong>');
    expect(mail.html).toContain('Thresholds: 60 days without movement after an introduction, 14 days for a doctor already registered in Australia.');
    expect(mail.html).not.toMatch(/MyIntealth/);
    // sentinels: separate keys
    expect(Object.keys(kv('stalled_application_alerts'))).toEqual(['app-o3-quiet']);
    expect(Object.keys(kv('stalled_application_alerts_au'))).toEqual(['app-au-interview']);
    expect(table('task_timeline').filter((r) => r.event_type === 'stalled_application_alert').map((r) => r.case_id).sort()).toEqual([OS.o3.caseId, AU.interview.caseId].sort());
    // once per quiet stretch
    h.reset();
    const second = await sweep();
    await parity.settle(h);
    expect(second.json).toMatchObject({ alerted: 0, emailed: false });
    expect(second.json.au).toMatchObject({ stalled: 1, alerted: 0 });
    expect(h.emails.length).toBe(0);
    // the tile and the list show both, each marked with its threshold
    expect((await h.get('/api/ats/attention', ceo())).json.stalled_applications).toBe(2);
    const list = (await h.get('/api/ats/stalled-applications', ceo())).json;
    const auRow = list.applications.find((a) => a.id === 'app-au-interview');
    const osRow = list.applications.find((a) => a.id === 'app-o3-quiet');
    expect(auRow).toMatchObject({ au: true, au_threshold_days: 14, days_quiet: 20 });
    expect(auRow.alerted_at).toBe(fx.NOW);
    expect('au' in osRow).toBe(false);
    expect('au_threshold_days' in osRow).toBe(false);
  });

  it('an Australian application under its threshold is not reported; an overseas one under 60 days never is', async () => {
    process.env.AU_STALLED_LIVE_FROM = fx.ago(30);
    process.env.AU_STALLED_APPLICATION_DAYS = '21';
    const r = await sweep();
    expect(r.json.au).toMatchObject({ stalled: 0, alerted: 0, threshold_days: 21 });
    // app-o5-recent is introduced and 20 days quiet: an overseas doctor's application, so 60 days applies
    expect((await h.get('/api/ats/stalled-applications', ceo())).json.applications.map((a) => a.id)).toEqual(['app-o3-quiet']);
  });

  it('an Australian application already alerted under the old single rule is not alerted again', async () => {
    process.env.AU_STALLED_LIVE_FROM = fx.ago(30);
    const app = table('gp_applications').find((a) => a.id === 'app-au-interview');
    table('runtime_kv').push({ key: 'stalled_application_alerts', value: { 'app-au-interview': { alerted_at: fx.ago(2), last_movement_at: new Date(app.ats_stage_updated_at).toISOString(), days_quiet_at_alert: 18 } } });
    const r = await sweep();
    await parity.settle(h);
    expect(r.json.au).toMatchObject({ stalled: 1, alerted: 0 });
    expect(h.emails.map((m) => m.body.subject)).toEqual(['Gone quiet: Testos Doc3 at Test Metro Practice (FAKE) (70 days)']);
    expect(kv('stalled_application_alerts_au')['app-au-interview'].alerted_at).toBe(fx.ago(2));
  });

  it('a go-live value that cannot be read keeps every application on the 60-day rule', async () => {
    process.env.AU_STALLED_LIVE_FROM = 'next tuesday';
    const r = await sweep();
    expect(r.json.au).toMatchObject({ stalled: 0, alerted: 0, live_from: null });
    expect(r.json).toMatchObject({ stalled: 1, alerted: 1 });
  });

  it('the Australian doctors cannot be read: the run sends nothing and writes nothing, and tries again next time', async () => {
    h.emu.failTables.user_state = 500;
    try {
      const r = await sweep();
      await parity.settle(h);
      expect(r.json).toMatchObject({ skipped: 'pathway_unreadable', alerted: 0, emailed: false });
      expect(h.emails.length).toBe(0);
      expect(kv('stalled_application_alerts')).toBe(null);
    } finally { delete h.emu.failTables.user_state; }
    expect((await sweep()).json).toMatchObject({ alerted: 1, emailed: true });
  });

  it('switch off: one threshold, today\'s email, no Australian key read or written', async () => {
    process.env.AU_STALLED_LIVE_FROM = fx.ago(30);
    h.setSwitch(false);
    try {
      h.emu.reset();
      const r = await sweep();
      await parity.settle(h);
      expect(r.json).toEqual({ ok: true, checked: 1, stalled: 1, alerted: 1, emailed: true });
      expect(h.emails[0].body.html).not.toMatch(/Australian|Testau/);
      expect(h.emu.requests.some((q) => /au_stalled_live_from|stalled_application_alerts_au|candidate_pathway/.test(String(q.query) + JSON.stringify(q.body || '')))).toBe(false);
      const att = (await h.get('/api/ats/attention', ceo())).json;
      expect('stalled_threshold_days_au' in att).toBe(false);
      expect(att.stalled_applications).toBe(1);
    } finally { h.setSwitch(true); }
  });
});

describe('WP-27 (ADM-04 follow-through): RSO workload and routing', () => {
  it('an Australian case with nobody assigned is not counted as unassigned RSO work, anywhere it is shown', async () => {
    const before = parity.readSnapshot('overseas-on');
    const unassigned = (list) => list.find((w) => w.rso_id === '__unassigned__');
    const dash = (await h.get('/api/ceo/dashboard', ceo())).json;
    expect(unassigned(dash.rso_workload)).toEqual(unassigned(before.endpoints.dashboardCurrent.body.rso_workload));
    const drill = (await h.get('/api/ceo/drilldown/rso?rso_id=__unassigned__', ceo())).json;
    expect(drill.items).toEqual(before.endpoints.drillRsoUnassigned.body.items);
    const va = (await h.get('/api/admin/va/dashboard', ceo())).json;
    const vaUnassigned = unassigned(va.rso_workload);
    h.setSwitch(false);
    let off;
    try { off = (await h.get('/api/admin/va/dashboard', ceo())).json; } finally { h.setSwitch(true); }
    const auUnassigned = table('registration_cases').filter((c) => /^au_/.test(String(c.pathway || '')) && !c.assigned_rso && c.status !== 'withdrawn').length;
    expect(auUnassigned).toBeGreaterThan(5);
    expect(unassigned(off.rso_workload).case_count - vaUnassigned.case_count).toBe(auUnassigned);
  });

  it('a case assigned to an RSO at pre-start IS their work', async () => {
    const dash = (await h.get('/api/ceo/dashboard', ceo())).json;
    const a = dash.rso_workload.find((w) => w.rso_id === fx.RSO_A);
    const before = parity.readSnapshot('overseas-on').endpoints.dashboardCurrent.body.rso_workload.find((w) => w.rso_id === fx.RSO_A);
    expect(a.case_count).toBe(before.case_count + 2);
    const drill = (await h.get('/api/ceo/drilldown/rso?rso_id=' + fx.RSO_A, ceo())).json;
    expect(drill.items.filter((x) => /Testau/.test(x.gp_name)).map((x) => x.gp_name).sort()).toEqual(['Testau Prestart', 'Testau Startreached']);
  });

  it('an unassigned Australian doctor\'s document check is not routed to an RSO; an overseas doctor\'s still is', async () => {
    const auCase = table('registration_cases').find((c) => c.id === AU.matched.caseId);
    const osCase = table('registration_cases').find((c) => c.id === OS.o1.caseId);
    expect(await t.resolveCandidateCheckAssignee(auCase)).toBe(null);
    // even when the case row itself does not say Australian (the doctor's profile does)
    expect(await t.resolveCandidateCheckAssignee({ id: auCase.id, user_id: auCase.user_id, stage: 'myintealth', assigned_rso: null, assigned_va: null })).toBe(null);
    const routed = await t.resolveCandidateCheckAssignee(osCase);
    expect([fx.RSO_A, fx.RSO_B]).toContain(routed);
    h.setSwitch(false);
    try {
      h.emu.reset();
      expect([fx.RSO_A, fx.RSO_B]).toContain(await t.resolveCandidateCheckAssignee(osCase));
      expect(h.emu.requests.some((r) => /candidate_pathway/.test(String(r.query)))).toBe(false);
    } finally { h.setSwitch(true); }
  });
});

describe('WP-27: request budget for GET /api/ceo/overview', () => {
  // Measured: 18 reads with the switch off; the two reads of the sweep index
  // with it on and no Australian doctor; nine batched reads more when there is
  // at least one (their profiles, cases, applications, placements, credentials,
  // interviews, tasks, roles and the practices' states), and one more only
  // while a 19AB mismatch is waiting. Never a read per doctor.
  const OVERVIEW_OFF = 18;
  const INDEX_READS = 2;
  const AU_FACT_READS = 9;
  const overview = async () => {
    await h.get('/api/ceo/overview?window=7d', ceo());   // the Zoom reconcile's throttle is warm after one call
    h.emu.reset();
    const r = await h.get('/api/ceo/overview?window=7d', ceo());
    expect(r.status).toBe(200);
    return { n: h.emu.requests.length, body: r.json, requests: h.emu.requests.slice() };
  };

  it('with Australian doctors: a fixed number of reads, and more doctors add none', async () => {
    h.setSwitch(false);
    let off;
    try { off = await overview(); } finally { h.setSwitch(true); }
    expect(off.n).toBe(OVERVIEW_OFF);
    const on = await overview();
    const mismatchWaiting = on.requests.some((r) => r.table === 'task_timeline');
    expect(on.n).toBe(OVERVIEW_OFF + INDEX_READS + AU_FACT_READS + (mismatchWaiting ? 1 : 0));
    // no read names a single doctor
    on.requests.forEach((r) => expect(/user_id=eq\.|case_id=eq\./.test(String(r.query)), r.table + ' ' + r.query).toBe(false));
    // twenty more Australian doctors, each with a case, an application and a placement
    const added = [];
    for (let i = 0; i < 20; i++) {
      const d = buildAuDoctor('au_vr', { idSuffix: 'bud' + i, profile: { last_name: 'Budget' + i }, caseRow: { stage: 'prestart' } });
      added.push(d);
      table('user_profiles').push(d.profile); table('gp_credentials').push(d.credentials); table('registration_cases').push(d.caseRow); table('user_state').push(d.state);
      table('gp_applications').push({ id: 'app-bud-' + i, user_id: d.userId, career_role_id: 'role-metro', status: 'placement_secured', ats_stage: 'hired', applied_at: fx.ago(20) });
      table('placements').push({ id: 'plc-bud-' + i, user_id: d.userId, application_id: 'app-bud-' + i, career_role_id: 'role-metro', practice_id: 'prac-metro', practice_name: 'Test Metro Practice (FAKE)', status: 'active', start_date: fx.dayAt(30), placed_at: fx.ago(5), created_at: fx.ago(5) });
    }
    try {
      const more = await overview();
      expect(more.n).toBe(on.n);
      expect(more.body.au.pipeline.total).toBe(on.body.au.pipeline.total + 20);
      // and the overseas numbers have still not moved
      expect(more.body.funnel).toEqual(on.body.funnel);
      expect(more.body.status.registration.cases).toEqual(on.body.status.registration.cases);
    } finally {
      const ids = new Set(added.map((d) => d.userId));
      ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state', 'gp_applications', 'placements'].forEach((name) => {
        const rows = table(name);
        for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].user_id)) rows.splice(i, 1);
      });
    }
  });

  it('without Australian doctors: the switch costs the index\'s two reads and nothing else', async () => {
    // take the Australian rows out of the database for this test
    const auIds = new Set(fx.auUserIds());
    const held = {};
    ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state', 'gp_applications', 'placements', 'support_tickets'].forEach((name) => {
      const rows = table(name);
      held[name] = rows.filter((r) => auIds.has(r.user_id));
      for (let i = rows.length - 1; i >= 0; i--) if (auIds.has(rows[i].user_id)) rows.splice(i, 1);
    });
    try {
      const on = await overview();
      expect(on.n).toBe(OVERVIEW_OFF + INDEX_READS);
      expect(on.body.au.pipeline.total).toBe(0);
      // The other metric endpoints: the index's two reads, nothing more.
      for (const [url, extra] of [['/api/ceo/dashboard', 2], ['/api/ceo/trends', 2], ['/api/ceo/conversion-funnel', 2], ['/api/ceo/source-attribution', 2], ['/api/ceo/rsos', 2], ['/api/ats/attention', 2]]) {
        h.setSwitch(false);
        h.emu.reset();
        await h.get(url, ceo());
        const offN = h.emu.requests.length;
        h.setSwitch(true);
        h.emu.reset();
        await h.get(url, ceo());
        expect(h.emu.requests.length - offN, url).toBe(extra);
      }
    } finally {
      Object.keys(held).forEach((name) => held[name].forEach((r) => table(name).push(r)));
    }
  });
});
