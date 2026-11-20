// WP-04 of the Australian GP build: "Pathway filters on sweeps and scheduled
// jobs" (ADM-04, COM-02, COM-09, DAT-20 and the scheduled-jobs table in
// docs/au-gp/review-report.md).
//
// The real server, booted once against the in-memory database stub, with a
// fetch that records every email, WhatsApp and push the server tries to send.
//
//   THE MATRIX   every job in JOBS  x  a doctor on au_vr / au_restricted /
//                au_non_vr  x  every Australian stage (placement, prestart,
//                commenced, guarantee, complete), plus a doctor whose pathway
//                is set but whose case is still parked at 'myintealth', plus
//                one who is part-way through onboarding. Each doctor is given
//                the rows that make every job WANT to act (a stale case, an
//                SPPA-00 with the practice, an unanswered AHPRA officer
//                thread, a flagged qualification, a pending register check,
//                ...). Nothing may be sent and no task may be opened.
//   TEETH        the same rows for an overseas doctor DO produce tasks and
//                messages, so the matrix is not passing because nothing fires.
//   PARITY       for the overseas doctor (nothing recorded, and a recorded
//                overseas pathway) every job produces exactly the same tasks
//                and messages with the switch ON as with it OFF.
//
// Every identity is fake. Nothing real is contacted.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

const DAY = 86400000;
const CRON = { headers: { Authorization: 'Bearer test-cron-secret' } };
const PRACTICE_EMAIL = 'practice.test@gplink-test.local';
const OFFICER_EMAIL = 'officer.test@gplink-test.local';

// AGENT-RULES section 4, plus the acceptance list ("MyIntealth, AMC, AHPRA
// application, SPPA or visa"). AHPRA in capitals is the overseas spelling.
const BANNED = /myintealth|\bAMC\b|\bEPIC\b|visa|relocat|your move|overseas|internationally trained|\bGMC\b|SPPA|Section G|supervisor CV|not yet eligible|AHPRA/i;

const AU_KINDS = ['au_vr', 'au_restricted', 'au_non_vr'];
const AU_STAGES = ['placement', 'prestart', 'commenced', 'guarantee', 'complete'];

let h, t, realHarnessFetch;
const outbound = []; // every non-database request the server made

const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// ── Fixtures ────────────────────────────────────────────────────────────────
// One doctor plus the rows that make every job want to act on them.
function doctor(kind, variant, suffix) {
  const over = { idSuffix: suffix, caseRow: {}, profile: {}, state: {} };
  // Signed up a while ago, quiet for 40 days: "stalled" by every activity rule.
  Object.assign(over.caseRow, {
    created_at: ago(60), updated_at: ago(40), last_gp_activity_at: ago(40),
    ahpra_officer_email: OFFICER_EMAIL, ahpra_officer_name: 'Test Officer'
  });
  Object.assign(over.profile, {
    onboarding_completed_at: ago(10), created_at: ago(60), updated_at: ago(40),
    register_body: 'gmc', register_number: '7000001', register_status: 'pending_verification', register_auto_checked_at: null
  });
  if (AU_STAGES.indexOf(variant) !== -1) over.caseRow.stage = variant;
  if (variant === 'parked' || variant === 'onboarding') {
    // The pathway is on the profile; the case was created at sign-up and has
    // not been moved onto the Australian ladder (and carries no mirror).
    over.caseRow.stage = 'myintealth';
    over.caseRow.pathway = null;
  }
  if (variant === 'onboarding') {
    over.profile.onboarding_completed_at = null;
    over.state = { gp_onboarding_complete: false, gp_onboarding: { currentStep: 2 } };
  }
  const d = buildAuDoctor(kind, over);
  d.variant = variant;
  d.state.updated_at = ago(40);
  return d;
}

function rowsFor(d) {
  const sppaId = 'task-sppa-' + d.userId;
  const ahpraId = 'task-ahpra-' + d.userId;
  return {
    registration_tasks: [
      { id: sppaId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'sppa_00', related_stage: 'career', status: 'waiting_on_practice', title: 'SPPA-00', gmail_thread_id: null, created_at: ago(20), updated_at: ago(10), metadata: { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE_EMAIL, sent_to_practice_at: ago(10) } },
      { id: 'task-sg-' + d.userId, case_id: d.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', related_stage: 'career', status: 'deferred', title: 'Section G', created_at: ago(20), updated_at: ago(20), metadata: {} },
      { id: ahpraId, case_id: d.caseId, task_type: 'ahpra_correspondence', related_stage: 'ahpra', status: 'open', title: 'AHPRA correspondence', gmail_thread_id: null, created_at: ago(20), updated_at: ago(10), metadata: {} }
    ],
    task_messages: [
      { id: 'msg-' + d.userId, task_id: ahpraId, direction: 'outbound', created_at: ago(10), subject: 'Query about the application', rfc822_message_id: null, rfc822_references: null, gmail_thread_id: null }
    ],
    user_documents: [
      { id: 'doc-' + d.userId, user_id: d.userId, document_key: 'mrcgp_cert', country_code: 'uk', status: 'under_review', flag_reason: 'name_mismatch', rejection_reason: null, ai_review_state: null, reviewed_by: null, mime_type: 'application/pdf', storage_path: 'docs/' + d.userId + '/mrcgp.pdf', file_url: null, expires_at: null, expiry_nudged_at: null, created_at: ago(3), updated_at: ago(3) }
    ],
    onboarding_reminders: d.variant === 'onboarding'
      ? [{ user_id: d.userId, email: d.email, name: d.name, anchor_at: ago(3), last_step: 2, steps_sent: [], stopped: false, unsubscribed: false }]
      : []
  };
}

const EMPTY_TABLES = ['registration_tasks', 'task_messages', 'task_timeline', 'task_documents', 'user_documents', 'onboarding_reminders',
  'gp_applications', 'placements', 'gp_nudge_log', 'user_nudges', 'practice_doc_ops', 'user_roles', 'runtime_kv', 'visa_applications',
  'pbs_applications', 'support_tickets', 'case_events', 'processed_gmail_messages', 'email_suppression', 'cron_runs', 'ats_intent',
  'doubletick_messages', 'scheduled_calls', 'career_interviews'];

function loadDb(doctors) {
  const db = buildAuFixtureDb(doctors);
  EMPTY_TABLES.forEach((name) => { if (!db[name]) db[name] = []; });
  doctors.forEach((d) => {
    const extra = rowsFor(d);
    Object.keys(extra).forEach((name) => { db[name] = (db[name] || []).concat(extra[name]); });
  });
  // Replace the stub's contents in place (rso_team stays).
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') h.emu.db[name].length = 0; });
  Object.keys(db).forEach((name) => {
    const target = h.emu.table(name);
    db[name].forEach((row) => target.push(JSON.parse(JSON.stringify(row))));
  });
  h.emu.reset();
  outbound.length = 0;
}

// ── The jobs ────────────────────────────────────────────────────────────────
const STATE_FLAGS = {
  // What a stray page visit or an admin override writes into the doctor's state.
  gp_epic_progress: { stage: 'verification_issued', completed: { account_establishment: true, upload_qualifications: true, verification_issued: true } },
  gp_amc_progress: { stage: 'qualifications_verified', completed: { upload_credentials: true, waiting_verification: true, qualifications_verified: true } },
  gp_ahpra_progress: { completed: { account_establishment: true, upload_qualifications: true, waiting_verification: true, verification_issued: true } }
};

const cron = (path) => h.get(path, CRON);
const JOBS = {
  'weekly-sweep (daily stalled-GP chase)': () => cron('/api/cron/weekly-sweep'),
  'sla-sweep (5 days without GP activity)': () => cron('/api/cron/sla-sweep'),
  'chase-nonresponders (SPPA practice, AHPRA officer, GP stall)': () => cron('/api/cron/chase-nonresponders'),
  'the manual weekly check-in': () => h.post('/api/admin/va/weekly-checkin/sweep', {}, h.superAdmin()),
  'reconcile-doc-tasks': () => cron('/api/cron/reconcile-doc-tasks'),
  'register-auto-verify': () => cron('/api/cron/register-auto-verify'),
  'sppa-backfill-scan': () => cron('/api/cron/sppa-backfill-scan'),
  'onboarding-nudge': () => cron('/api/cron/onboarding-nudge'),
  'onboarding-step-followup (on demand)': () => cron('/api/cron/onboarding-step-followup?send=1'),
  'dropoff-nudge': () => cron('/api/cron/dropoff-nudge'),
  'doc-ai-review': () => cron('/api/cron/doc-ai-review'),
  'recompute-intent': () => cron('/api/cron/recompute-intent'),
  'the stage messages in processRegistrationTaskAutomation (state flags)': async (doctors) => {
    for (const d of doctors) await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, STATE_FLAGS);
    return { status: 200 };
  },
  'the "AHPRA documents ready" notifier (_maybeNotifyAhpraDocsReady)': async (doctors) => {
    for (const d of doctors) await t._maybeNotifyAhpraDocsReady(d.caseId);
    return { status: 200 };
  },
  'the stalled-GP chase itself (chaseStalledCase)': async (doctors) => {
    for (const d of doctors) {
      const c = h.emu.table('registration_cases').find((r) => r.id === d.caseId);
      await t.chaseStalledCase(c, { days: 14, sourceTrigger: 'weekly_checkin', actor: 'system' });
    }
    return { status: 200 };
  }
};

// ── What a job did ──────────────────────────────────────────────────────────
function taskInserts() {
  const out = [];
  h.emu.requests.filter((r) => r.table === 'registration_tasks' && r.method === 'POST').forEach((r) => {
    (Array.isArray(r.body) ? r.body : [r.body]).forEach((row) => { if (row) out.push(row); });
  });
  return out;
}
// Things written for the doctor to see in the app: bell items and nudge rows.
function inAppWrites() {
  const out = [];
  h.emu.requests.filter((r) => (r.method === 'POST' || r.method === 'PATCH') && (r.table === 'user_nudges' || r.table === 'user_state')).forEach((r) => {
    (Array.isArray(r.body) ? r.body : [r.body]).forEach((row) => {
      if (!row) return;
      if (r.table === 'user_nudges') out.push(JSON.stringify({ title: row.title, message: row.message }));
      else if (row.state && row.state.gp_link_updates) out.push(JSON.stringify(row.state.gp_link_updates));
    });
  });
  return out;
}
function messageOf(call) {
  const b = call.body || {};
  if (/resend/.test(call.url)) return { channel: 'email', to: [].concat(b.to || []).join(','), what: String(b.subject || ''), text: JSON.stringify(b) };
  if (/doubletick/.test(call.url)) {
    const m = (b.messages && b.messages[0]) || {};
    const c = m.content || {};
    return { channel: 'whatsapp', to: String(m.to || ''), what: String(c.templateName || c.text || ''), text: JSON.stringify(b) };
  }
  return { channel: 'other', to: '', what: call.url, text: call.url + ' ' + JSON.stringify(b) };
}
const messages = () => outbound.map(messageOf);

// A stable description of everything a run produced, for ON / OFF comparison.
function fingerprint() {
  return {
    tasks: taskInserts().map((r) => [r.task_type, r.title, r.related_stage || '', r.source_trigger || '', r.status || ''].join(' | ')).sort(),
    messages: messages().map((m) => [m.channel, m.to, m.what].join(' | ')).sort(),
    inApp: inAppWrites().map((s) => s.replace(/"ts":\d+/g, '"ts":0')).sort()
  };
}

async function settle() { await new Promise((r) => setTimeout(r, 250)); }

beforeAll(async () => {
  h = await bootAuTestServer({
    name: 'wp04-sweeps',
    tables: buildAuFixtureDb([]),
    env: { RESEND_API_KEY: 'test-resend-key', DOUBLETICK_API_KEY: 'test-doubletick-key', NOTIFY_TEST_RECIPIENTS: '' }
  });
  t = h.testUtils;
  // Record everything the server sends anywhere but the database stub.
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
});

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
describe('THE MATRIX: no job opens a task for, or sends anything to, a doctor on an Australian pathway', () => {
  const variants = AU_STAGES.concat(['parked', 'onboarding']);
  function auDoctors() {
    const list = [];
    AU_KINDS.forEach((kind, k) => variants.forEach((variant, v) => list.push(doctor(kind, variant, 'm' + k + v))));
    return list;
  }

  it('the fixtures are what the brief asks for: 3 pathways x (5 Australian stages + parked at myintealth + mid-onboarding)', () => {
    const list = auDoctors();
    expect(list.length).toBe(21);
    AU_KINDS.forEach((kind) => {
      const mine = list.filter((d) => d.kind === kind);
      expect(mine.map((d) => d.caseRow.stage).sort()).toEqual(['commenced', 'complete', 'guarantee', 'myintealth', 'myintealth', 'placement', 'prestart']);
      expect(mine.every((d) => d.profile.candidate_pathway === kind)).toBe(true);
      const parked = mine.find((d) => d.variant === 'parked');
      expect(parked.caseRow.pathway).toBe(null);
      expect(mine.find((d) => d.variant === 'onboarding').profile.onboarding_completed_at).toBe(null);
    });
  });

  Object.keys(JOBS).forEach((label) => {
    it(label, async () => {
      const list = auDoctors();
      loadDb(list);
      const res = await JOBS[label](list);
      await settle();
      expect(res.status, label).toBe(200);

      const tasks = taskInserts();
      const sent = messages();
      const inApp = inAppWrites();
      // Nothing at all: no task, no email, no WhatsApp, no push, no bell item.
      expect(tasks.map((r) => r.title), label + ': tasks opened').toEqual([]);
      expect(sent.map((m) => m.channel + ' ' + m.to + ' ' + m.what), label + ': messages sent').toEqual([]);
      expect(inApp, label + ': in-app items written').toEqual([]);
      // And, said the way the acceptance says it: none of the banned words
      // reached a task or a message.
      tasks.forEach((r) => expect(BANNED.test(JSON.stringify(r)), 'task: ' + r.title).toBe(false));
      sent.forEach((m) => expect(BANNED.test(m.text), 'message: ' + m.what).toBe(false));
      inApp.forEach((s) => expect(BANNED.test(s), 'in-app: ' + s).toBe(false));
      // No doctor's stored state was changed by a job either (no stamp, no score).
      const docs = h.emu.table('user_documents');
      expect(docs.every((d) => d.status === 'under_review' && d.ai_review_state === null), label + ': documents untouched').toBe(true);
      expect(h.emu.table('user_profiles').every((p) => p.register_status === 'pending_verification'), label + ': register checks untouched').toBe(true);
      expect(h.emu.table('onboarding_reminders').every((r) => (r.steps_sent || []).length === 0)).toBe(true);
    });
  });

  it('career secured in the doctor\'s state: the "AHPRA step unlocked" WhatsApp and email are not sent (the task cascade is WP-11\'s)', async () => {
    const list = AU_STAGES.map((stage, i) => doctor('au_vr', stage, 'cs' + i));
    loadDb(list);
    for (const d of list) {
      await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, Object.assign({ gp_career_state: { career_secured: true } }, STATE_FLAGS));
    }
    await settle();
    const sent = messages();
    // WP-04's guarantee for this block: no stage message of any kind.
    expect(sent.filter((m) => m.channel === 'whatsapp').map((m) => m.what)).toEqual([]);
    expect(sent.filter((m) => /AHPRA|AMC|MyIntealth|Visa/i.test(m.what)).map((m) => m.what)).toEqual([]);
    // No AHPRA-stage task from the stray gp_ahpra_progress flags.
    expect(taskInserts().filter((r) => r.task_type === 'verify').map((r) => r.title)).toEqual([]);
    // NOT guaranteed here, and deliberately not asserted: the practice-pack
    // tasks (SPPA-00, Section G, supervisor CV) and the practice-pack email
    // still follow career_secured for an Australian doctor. That is the
    // placement cascade, which WP-11 branches (docs/au-gp/scheduled-jobs.md,
    // "Hooks left for later packages").
  });

  it('the two quiet jobs, checked by what they return: register-auto-verify attempts nobody, the AHPRA notifier answers au_pathway', async () => {
    const list = AU_KINDS.map((kind, i) => doctor(kind, i === 0 ? 'parked' : 'prestart', 'q' + i));
    const uk = doctor('overseas_null', 'parked', 'q9');
    loadDb(list.concat([uk]));
    for (const d of list) expect(await t._maybeNotifyAhpraDocsReady(d.caseId), d.kind).toEqual({ notified: false, reason: 'au_pathway' });
    // The overseas doctor goes through the real check (documents still pending here).
    const ukRes = await t._maybeNotifyAhpraDocsReady(uk.caseId);
    expect(ukRes.reason).not.toBe('au_pathway');
    expect(ukRes.reason).not.toBe('pathway_unreadable');

    const res = await cron('/api/cron/register-auto-verify');
    expect(res.status).toBe(200);
    expect(res.json.pending).toBe(4);
    expect(res.json.results.map((r) => r.user_id)).toEqual([uk.userId]);
    list.forEach((d) => {
      const p = h.emu.table('user_profiles').find((r) => r.user_id === d.userId);
      expect(p.register_auto_checked_at, d.kind + ': not stamped').toBe(null);
      expect(p.register_status).toBe('pending_verification');
    });

    const scan = await cron('/api/cron/sppa-backfill-scan');
    expect(scan.status).toBe(200);
    const byCase = {};
    scan.json.results.forEach((r) => { byCase[r.case_id] = r.action; });
    list.forEach((d) => expect(byCase[d.caseId], d.kind).toBe('skip_au_pathway'));
    expect(byCase[uk.caseId]).not.toBe('skip_au_pathway');
  });

  it('the visa bell item is never written for a doctor on an Australian pathway', async () => {
    const list = AU_KINDS.map((kind, i) => doctor(kind, 'prestart', 'vb' + i));
    loadDb(list);
    list.forEach((d) => h.emu.table('visa_applications').push({ id: 'visa-' + d.userId, user_id: d.userId }));
    for (const d of list) await t.pushVisaNotificationToOwner('visa-' + d.userId, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to lodged' });
    expect(inAppWrites()).toEqual([]);
    expect(h.emu.requests.filter((r) => r.table === 'user_state' && r.method !== 'GET')).toEqual([]);
  });

  it('the overseas "registration granted" flow does nothing for a doctor on an Australian pathway, and says why', async () => {
    const d = doctor('au_restricted', 'prestart', 'rg1');
    loadDb([d]);
    const summary = await t.handleAhpraRegistrationGranted({
      caseId: d.caseId, userId: d.userId, source: { type: 'manual' },
      registration: { registration_number: 'MED0001999999', effective_date: '2026-11-01', expiry_date: '2027-09-30' }, actor: 'staff.test@gplink-test.local'
    });
    expect(summary.ok).toBe(false);
    expect(summary.skipped).toBe('au_pathway');
    expect(summary.errors.join(' ')).toMatch(/Australian pathway/);
    expect(taskInserts()).toEqual([]);
    expect(messages()).toEqual([]);
    expect(h.emu.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    const c = h.emu.table('registration_cases').find((r) => r.id === d.caseId);
    expect(c.stage).toBe('prestart');
    expect(c.ahpra_registration_granted_at).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TEETH and PARITY: an overseas doctor gets exactly what they always did, switch on or off', () => {
  // The regression doctors: nothing recorded, and a pathway recorded as overseas.
  function overseasDoctors(variant) {
    return [doctor('overseas_null', variant, 'p1'), doctor('overseas_explicit', variant, 'p2')];
  }
  async function run(label, on, variant) {
    const list = overseasDoctors(variant);
    h.setSwitch(on);
    loadDb(list);
    // Admin ids are cached for two minutes; they are empty in every run here.
    const res = await JOBS[label](list);
    await settle();
    expect(res.status, label + (on ? ' ON' : ' OFF')).toBe(200);
    return fingerprint();
  }

  Object.keys(JOBS).forEach((label) => {
    it(label + ': switch ON equals switch OFF (stalled doctor at myintealth)', async () => {
      const off = await run(label, false, 'parked');
      const on = await run(label, true, 'parked');
      expect(on).toEqual(off);
    });
  });

  ['onboarding-nudge', 'onboarding-step-followup (on demand)', 'weekly-sweep (daily stalled-GP chase)', 'the stalled-GP chase itself (chaseStalledCase)'].forEach((label) => {
    it(label + ': switch ON equals switch OFF (doctor part-way through onboarding)', async () => {
      const off = await run(label, false, 'onboarding');
      const on = await run(label, true, 'onboarding');
      expect(on).toEqual(off);
    });
  });

  it('TEETH: the same rows that are silent for an Australian doctor produce tasks and messages for an overseas one', async () => {
    const acted = {};
    for (const label of Object.keys(JOBS)) {
      const fp = await run(label, true, 'parked');
      acted[label] = fp.tasks.length + fp.messages.length + fp.inApp.length;
    }
    const onb = await run('onboarding-nudge', true, 'onboarding');
    acted['onboarding-nudge'] = onb.tasks.length + onb.messages.length;
    const osf = await run('onboarding-step-followup (on demand)', true, 'onboarding');
    acted['onboarding-step-followup (on demand)'] = osf.tasks.length + osf.messages.length;
    // Jobs whose effect is a task or a message.
    ['weekly-sweep (daily stalled-GP chase)', 'sla-sweep (5 days without GP activity)',
      'chase-nonresponders (SPPA practice, AHPRA officer, GP stall)', 'the manual weekly check-in',
      'reconcile-doc-tasks', 'onboarding-nudge', 'onboarding-step-followup (on demand)', 'dropoff-nudge',
      'the stage messages in processRegistrationTaskAutomation (state flags)',
      'the stalled-GP chase itself (chaseStalledCase)'].forEach((label) => {
      expect(acted[label], label + ' did something for the overseas doctors').toBeGreaterThan(0);
    });
  });

  it('weekly sweep, spelled out: one chase task and one "Need a hand?" email per stalled overseas doctor, in both states', async () => {
    for (const on of [false, true]) {
      const fp = await run('weekly-sweep (daily stalled-GP chase)', on, 'parked');
      expect(fp.tasks).toEqual([
        'chase | Weekly check-in — GP stalled ≥14 days on myintealth | myintealth | weekly_checkin | ',
        'chase | Weekly check-in — GP stalled ≥14 days on myintealth | myintealth | weekly_checkin | '
      ]);
      expect(fp.messages.filter((m) => /Need a hand/.test(m)).length).toBe(2);
    }
  });

  it('SLA sweep, spelled out: one "no GP activity" task per stale overseas case, in both states', async () => {
    for (const on of [false, true]) {
      const fp = await run('sla-sweep (5 days without GP activity)', on, 'parked');
      expect(fp.tasks.length).toBe(2);
      fp.tasks.forEach((line) => expect(line).toMatch(/^sla_overdue \| Follow up: no GP activity for 5 days \| myintealth \| sla_check/));
    }
  });

  it('chase-nonresponders, spelled out: the practice and the AHPRA officer are chased for an overseas case, in both states', async () => {
    for (const on of [false, true]) {
      const fp = await run('chase-nonresponders (SPPA practice, AHPRA officer, GP stall)', on, 'parked');
      expect(fp.messages.filter((m) => m.indexOf('email | ' + PRACTICE_EMAIL + ' | Reminder: Supervised Practice Plan (SPPA-00)') === 0).length).toBe(2);
      expect(fp.messages.filter((m) => m.indexOf('email | ' + OFFICER_EMAIL + ' | ') === 0).length).toBe(2);
      expect(fp.tasks.filter((line) => /^chase \| AHPRA officer has not replied \| ahpra \| ahpra_officer_chase/.test(line)).length).toBe(2);
    }
  });

  it('the stage messages, spelled out: an overseas doctor still gets the MyIntealth, AMC and Career stage messages and the AHPRA task', async () => {
    for (const on of [false, true]) {
      const fp = await run('the stage messages in processRegistrationTaskAutomation (state flags)', on, 'parked');
      const wa = fp.messages.filter((m) => m.indexOf('whatsapp') === 0);
      expect(wa.length, 'stage WhatsApps ' + (on ? 'ON' : 'OFF')).toBeGreaterThanOrEqual(6); // myintealth + amc + career, twice
      expect(fp.messages.filter((m) => /MyIntealth Complete|AMC Complete/.test(m)).length).toBeGreaterThanOrEqual(2);
      // The AHPRA "verify" tasks are still opened (how many depends on the
      // dedupe lookup, which the stub answers loosely; at least one each).
      const verify = fp.tasks.filter((line) => /^verify \| /.test(line));
      expect(verify.length).toBeGreaterThanOrEqual(2);
      verify.forEach((line) => expect(line).toMatch(/AHPRA.* \| ahpra \| gp_state_change/));
    }
  });

  it('the visa bell item is still written for an overseas doctor, in both states', async () => {
    for (const on of [false, true]) {
      const list = overseasDoctors('parked');
      h.setSwitch(on);
      loadDb(list);
      list.forEach((d) => h.emu.table('visa_applications').push({ id: 'visa-' + d.userId, user_id: d.userId }));
      for (const d of list) await t.pushVisaNotificationToOwner('visa-' + d.userId, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to lodged' });
      const written = inAppWrites();
      expect(written.length, on ? 'ON' : 'OFF').toBe(2);
      written.forEach((s) => expect(s).toContain('Visa stage updated'));
    }
  });

  it('a mixed run: the Australian doctors are left out and the overseas doctor beside them is chased as usual', async () => {
    const uk = doctor('overseas_null', 'parked', 'x1');
    const au = [doctor('au_vr', 'parked', 'x2'), doctor('au_vr', 'prestart', 'x3'), doctor('au_non_vr', 'onboarding', 'x4')];
    loadDb([uk].concat(au));
    const res = await cron('/api/cron/weekly-sweep');
    await settle();
    expect(res.json).toMatchObject({ ok: true, created: 1 });
    const tasks = taskInserts();
    expect(tasks.length).toBe(1);
    expect(tasks[0].case_id).toBe(uk.caseId);
    const sent = messages();
    expect(sent.length).toBeGreaterThan(0);
    sent.forEach((m) => expect(m.to).toBe(uk.email));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the pathway index (auSweepPathwayIndex)', () => {
  it('switch OFF: inert, and it asks the database nothing', async () => {
    loadDb([doctor('au_vr', 'prestart', 'i1')]);
    h.setSwitch(false);
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(h.emu.requests).toEqual([]);
    expect(idx.enabled).toBe(false);
    expect(idx.size).toBe(0);
    expect(idx.excludesUser(h.emu.table('user_profiles')[0].user_id)).toBe(false);
    expect(idx.excludesCase({ id: 'c', user_id: 'u', stage: 'prestart', pathway: 'au_vr' })).toBe(false);
    expect(await t.auSweepExcludesCaseId(idx, 'c')).toBe(false);
    expect(idx.summary()).toBe(null);
    expect(h.emu.requests).toEqual([]);
  });

  // WP-05 changed this test deliberately: the index now makes TWO small reads
  // of its own instead of one. The second is the doctors part-way through the
  // Australian onboarding branch (a server-owned marker on user_state), who
  // have no pathway yet but must not get reminders written for another journey
  // (COM-07). Neither read adds a column to a job's existing queries.
  it('switch ON: two small reads of its own (the branch-started marker, then the pathway column)', async () => {
    const au = doctor('au_vr', 'prestart', 'i2');
    const reg = doctor('au_registrar', 'placement', 'i3');
    const uk = doctor('overseas_null', 'parked', 'i4');
    const ie = doctor('overseas_explicit', 'parked', 'i5');
    loadDb([au, reg, uk, ie]);
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(h.emu.requests.length).toBe(2);
    expect(h.emu.requests[0].table).toBe('user_state');
    expect(h.emu.requests[0].query).toContain('select=user_id,gp_au_branch_started_at:state->>gp_au_branch_started_at');
    expect(h.emu.requests[0].query).toContain('state->>gp_au_branch_started_at=not.is.null');
    expect(h.emu.requests[1].table).toBe('user_profiles');
    expect(h.emu.requests[1].select).toEqual(['user_id', 'candidate_pathway']);
    expect(h.emu.requests[1].query).toContain('candidate_pathway=in.(au_vr,au_restricted,au_non_vr,au_registrar)');
    expect(idx.size).toBe(2);
    expect(idx.excludesUser(au.userId)).toBe(true);
    expect(idx.excludesUser(reg.userId)).toBe(true);
    // NULL and a recorded overseas pathway are overseas doctors.
    expect(idx.excludesUser(uk.userId)).toBe(false);
    expect(idx.excludesUser(ie.userId)).toBe(false);
    expect(idx.reasonForUser(au.userId)).toBe('au_pathway');
    expect(idx.summary()).toMatchObject({ au_pathway_doctors: 2, excluded_au_pathway: 2, held_pathway_unreadable: 0, unreadable: false });
  });

  it('a bare case id: the Australian doctors\' cases are read once, and not at all when nobody is Australian', async () => {
    const au = doctor('au_vr', 'prestart', 'i6');
    const uk = doctor('overseas_null', 'parked', 'i7');
    loadDb([au, uk]);
    const idx = await t.auSweepPathwayIndex('test-job');
    h.emu.reset();
    expect(await t.auSweepExcludesCaseId(idx, au.caseId)).toBe(true);
    expect(await t.auSweepExcludesCaseId(idx, uk.caseId)).toBe(false);
    expect(await t.auSweepExcludesCaseId(idx, au.caseId)).toBe(true);
    expect(h.emu.requests.length).toBe(1);
    expect(h.emu.requests[0].table).toBe('registration_cases');
    expect(h.emu.requests[0].select).toEqual(['id', 'user_id']);

    loadDb([uk]);
    const none = await t.auSweepPathwayIndex('test-job');
    h.emu.reset();
    expect(await t.auSweepExcludesCaseId(none, uk.caseId)).toBe(false);
    expect(h.emu.requests).toEqual([]);
  });

  it('the migration is not applied (the column is missing): nobody is Australian, the job carries on, one log line', async () => {
    const uk = doctor('overseas_null', 'parked', 'i8');
    loadDb([uk]);
    h.emu.missingColumns = { user_profiles: ['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at', 'pathway_confirmed_at', 'pathway_confirmed_by'], registration_cases: ['pathway'] };
    h.emu.missingTables = new Set(['gp_credentials']);
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(idx.enabled).toBe(true);
    expect(idx.unreadable).toBe(false);
    expect(idx.schemaMissing).toBe(true);
    expect(idx.size).toBe(0);
    expect(idx.excludesUser(uk.userId)).toBe(false);
    // And a real job still chases the overseas doctor.
    h.emu.reset(); outbound.length = 0;
    const res = await cron('/api/cron/weekly-sweep');
    await settle();
    expect(res.json).toMatchObject({ ok: true, created: 1 });
    expect(taskInserts().length).toBe(1);
  });

  it('the read fails for another reason: every doctor is held this run (unknown fails closed), and the next run is normal', async () => {
    const uk = doctor('overseas_null', 'parked', 'i9');
    const au = doctor('au_vr', 'parked', 'i10');
    loadDb([uk, au]);
    h.emu.forbid((r) => (r.table === 'user_profiles' && /candidate_pathway=in\./.test(r.query)) ? 'simulated outage' : '');
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(idx.unreadable).toBe(true);
    expect(idx.excludesUser(uk.userId)).toBe(true);
    expect(idx.reasonForUser(uk.userId)).toBe('pathway_unreadable');
    expect(await t.auSweepExcludesCaseId(idx, uk.caseId)).toBe(true);

    h.emu.reset(); outbound.length = 0;
    const held = await cron('/api/cron/weekly-sweep');
    await settle();
    expect(held.status).toBe(200);
    expect(held.json.created).toBe(0);
    expect(taskInserts()).toEqual([]);
    expect(messages()).toEqual([]);

    // The outage clears: the overseas doctor is chased, the Australian one is not.
    h.emu.forbid(null);
    h.emu.reset(); outbound.length = 0;
    const next = await cron('/api/cron/weekly-sweep');
    await settle();
    expect(next.json.created).toBe(1);
    expect(taskInserts().map((r) => r.case_id)).toEqual([uk.caseId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ADM-04: stuck-case buckets, SLA tasks and the nightly score leave Australian cases out', () => {
  it('stuck cases: an Australian case is not shown as "stuck 30+ days"; it is counted in au_excluded', async () => {
    const uk = doctor('overseas_null', 'parked', 's1');
    const au = AU_STAGES.map((stage, i) => doctor('au_vr', stage, 's' + (i + 2)));
    const parked = doctor('au_restricted', 'parked', 's9');
    loadDb([uk].concat(au, [parked]));
    const on = await t.computeStuckCaseBuckets(Date.now());
    expect(on.total).toBe(1);
    expect(on.au_excluded).toBe(6);
    const items = on.buckets.reduce((all, b) => all.concat(b.items), []);
    expect(items.map((it) => it.case_id)).toEqual([uk.caseId]);

    h.setSwitch(false);
    h.emu.reset();
    const off = await t.computeStuckCaseBuckets(Date.now());
    expect(Object.keys(off).sort()).toEqual(['buckets', 'total']);
    expect(off.total).toBe(7);
    expect(h.emu.requests.filter((r) => /candidate_pathway/.test(r.query))).toEqual([]);

    // The staff endpoint still answers, for a super admin, in both states.
    h.setSwitch(true);
    const view = await h.get('/api/admin/stuck-cases', h.superAdmin());
    expect(view.status).toBe(200);
    expect(view.json.total).toBe(1);
  });

  it('the SLA check: no overdue task on an Australian case, so it adds nothing to an RSO\'s open-task count', async () => {
    const uk = doctor('overseas_null', 'parked', 's10');
    const au = doctor('au_vr', 'prestart', 's11');
    const parked = doctor('au_vr', 'parked', 's12');
    [uk, au, parked].forEach((d) => { d.caseRow.assigned_va = h.RSO_USER_ID; d.caseRow.assigned_rso = h.RSO_USER_ID; });
    loadDb([uk, au, parked]);
    const res = await t.runSlaCheck('system:test');
    expect(Object.keys(res).sort()).toEqual(['checked', 'created']);
    expect(res.created).toBe(1);
    const tasks = taskInserts();
    expect(tasks.map((r) => r.case_id)).toEqual([uk.caseId]);
    expect(tasks[0].task_type).toBe('sla_overdue');
  });

  it('the nightly intent score is not rewritten for an Australian case; an overseas case is scored as usual', async () => {
    const uk = doctor('overseas_null', 'parked', 's13');
    const au = doctor('au_vr', 'commenced', 's14');
    loadDb([uk, au]);
    const res = await cron('/api/cron/recompute-intent');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.processed).toBe(1);
    // Nothing was read or written about the Australian doctor beyond the index.
    const aboutAu = h.emu.requests.filter((r) => r.query.indexOf(au.userId) !== -1 || r.query.indexOf(au.caseId) !== -1);
    expect(aboutAu).toEqual([]);

    h.setSwitch(false);
    h.emu.reset();
    const off = await cron('/api/cron/recompute-intent');
    expect(off.json.processed).toBe(2);
  });

  it('refresh-summaries: Australian cases are taken out before the stale pick (predicate tested directly: the job needs an AI key)', async () => {
    const uk = doctor('overseas_null', 'parked', 's15');
    const au = doctor('au_vr', 'prestart', 's16');
    loadDb([uk, au]);
    const idx = await t.auSweepPathwayIndex('refresh-summaries');
    const cases = h.emu.table('registration_cases').map((c) => ({ id: c.id }));
    const kept = [];
    for (const c of cases) if (!(await t.auSweepExcludesCaseId(idx, c.id))) kept.push(c.id);
    expect(kept).toEqual([uk.caseId]);
    // Without an AI key the job itself answers "Not configured" and does nothing.
    const res = await cron('/api/cron/refresh-summaries');
    expect(res.json).toMatchObject({ ok: true, refreshed: 0 });
  });
});
