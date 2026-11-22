// Australian GP build, WP-20, against the real server with a STUBBED model:
// what each AI feature sends for a doctor on an Australian pathway, and what
// happens to the model's answer before it can reach that doctor or a practice.
//
// No AI provider is contacted: tests/helpers/au-wp20-rig.js answers every
// request to api.anthropic.com / api.openai.com with what the test sets.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { bootWp20Rig } = require('./helpers/au-wp20-rig.js');
const ctxLib = require('../lib/au-ai-context.js');
const careerIntro = require('../lib/career-intro.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const nudgeLib = require('../lib/practice-nudge-draft.js');
const triage = require('../lib/email-triage.js');
const aiMatching = require('../lib/ai-matching.js');

const T = '2026-10-01T02:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
const PRACTICE = 'Test Metro Practice (FAKE)';
const PM_EMAIL = 'pm@practice-test.local';
// Planted on the Australian doctors. None may be in a prompt whose answer goes to a practice.
const SECRET = { condition: 'CONDITION-TEXT-SENTINEL supervised practice only', ahpra: 'MED0001999999', provider: '246810AB', employer: 'CURRENT-EMPLOYER-SENTINEL Medical', suburb: 'SECRET-SUBURB' };
const OVERSEAS_SENTENCE = /overseas GPs register/;

const CASE_PRESTART = { stage: 'prestart', practice_name: PRACTICE, practice_contact_email: PM_EMAIL, created_at: T, updated_at: T, last_gp_activity_at: T };
const vr = buildAuDoctor('au_vr', {
  credentials: { staff_verified_at: T, staff_verified_by: STAFF, ahpra_number: SECRET.ahpra, has_conditions: true, conditions_text: SECRET.condition, flags_reviewed_at: T, flags_reviewed_by: STAFF, visa_sponsor_name: SECRET.employer },
  profile: { register_status: 'verified', register_body: 'ahpra', register_number: SECRET.ahpra, current_state: 'NSW', current_suburb: SECRET.suburb },
  caseRow: CASE_PRESTART
});
const restricted = buildAuDoctor('au_restricted', {
  credentials: { work_rights: 'visa', visa_sponsor_tied: true, visa_sponsor_name: SECRET.employer, ahpra_registration_type: 'general' },
  caseRow: CASE_PRESTART
});
const uk = buildAuDoctor('overseas_null', { caseRow: { stage: 'ahpra', practice_name: 'Test Overseas Practice (FAKE)', created_at: T, updated_at: T, last_gp_activity_at: T } });
const DOCTORS = { vr, restricted, uk };

function tasksFor(d, n, au) {
  const base = { case_id: d.caseId, status: 'open', priority: 'normal', created_at: T, updated_at: T, metadata: {} };
  const rows = [
    Object.assign({}, base, { id: 'task-email-gp-' + n, task_type: 'email_triage', title: 'Email: what do you still need from me?', related_stage: d.caseRow.stage, email_sender: d.email, email_body_snippet: 'Hi, what do you still need from me before I start?' }),
    Object.assign({}, base, { id: 'task-email-pm-' + n, task_type: 'email_triage', title: 'Email: what do you need from us?', related_stage: 'practice_contact', email_sender: PM_EMAIL, email_body_snippet: 'Hi, what do you still need from the practice? Their Ahpra number is ' + SECRET.ahpra + '.' }),
    Object.assign({}, base, { id: 'task-wa-' + n, task_type: 'whatsapp_help', title: 'WhatsApp help', description: 'Can we talk through the provider number form?', priority: 'high', related_stage: d.caseRow.stage }),
    Object.assign({}, base, { id: 'task-chase-' + n, task_type: 'manual', title: 'Employment contract', status: 'waiting', related_stage: d.caseRow.stage })
  ];
  if (au) {
    // The pre-start tasks of this doctor's placement, as the server raises them (tied to the placement by its key).
    const key = 'pl-' + n;
    const pre = (meta) => Object.assign({ au: true, placement_key: key }, meta);
    rows.push(Object.assign({}, base, { id: 'task-start-' + n, task_type: 'start_date_tracking', title: 'Confirm notice period and start date', status: 'completed', related_stage: 'prestart', source_trigger: 'au_placement', metadata: pre({ confirmed_start_date: '2027-02-01' }) }));
    rows.push(Object.assign({}, base, { id: 'task-ind-' + n, task_type: 'indemnity_certificate', title: 'Collect indemnity certificate', related_stage: 'prestart', source_trigger: 'au_placement', metadata: pre({ document_key: 'au_indemnity_certificate' }) }));
    rows.push(Object.assign({}, base, { id: 'task-prov-' + n, task_type: 'provider_number_new_location', title: 'Medicare provider number for the new location', status: 'completed', related_stage: 'prestart', source_trigger: 'au_placement', metadata: pre({ location_name: PRACTICE, provider_number: SECRET.provider }) }));
  }
  return rows;
}

let rig;
const su = () => rig.superAdmin();
const rows = (t) => rig.emu.table(t);
const caseOf = (d) => rows('registration_cases').filter((r) => r.id === d.caseId)[0];

beforeAll(async () => {
  const list = Object.keys(DOCTORS).map((k) => DOCTORS[k]);
  const tables = Object.assign(buildAuFixtureDb(list), {
    registration_tasks: tasksFor(vr, 'vr', true).concat(tasksFor(restricted, 'b', true)).concat(tasksFor(uk, 'uk', false)),
    task_timeline: [],
    task_messages: ['vr', 'b', 'uk'].map((n, i) => ({
      id: 'tm-' + n, case_id: list[i].caseId, task_id: 'task-chase-' + n, direction: 'outbound', channel: 'email', sender: 'hazel@gplink-test.local',
      subject: 'Employment contract for Dr Test', body_text: 'Could you send the signed contract? (ref ' + SECRET.ahpra + ')', created_at: T
    })),
    placements: [
      { id: 'pl-vr', user_id: vr.userId, status: 'active', practice_name: PRACTICE, start_date: '2027-02-01', placed_at: T, created_at: T, application_id: null, practice_id: null, job_title: 'General Practitioner' },
      { id: 'pl-b', user_id: restricted.userId, status: 'active', practice_name: PRACTICE, start_date: '2027-03-01', placed_at: T, created_at: T, application_id: null, practice_id: null, job_title: 'General Practitioner' }
    ],
    doubletick_messages: [], support_tickets: [], practice_doc_ops: [], user_documents: [], scheduled_calls: [], gp_applications: [],
    practices: [], career_roles: [], runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [], admin_audit_log: [], task_contacts: [], case_contacts: [],
    pbs_applications: [], au_gp_doctor_details: [], cron_runs: []
  });
  rig = await bootWp20Rig({ name: 'wp20-server', tables });
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => {
  rig.setSwitch(true);
  rig.ai.reset();
  rig.emu.failTables = {};
  rows('registration_cases').forEach((r) => { r.ai_handover_summary = null; r.updated_at = T; });
});

const SUMMARY_REPLY = JSON.stringify({ overview: 'An overview.', action_items: ['Chase the certificate'], concerns: [], key_history: 'History.' });
const sentText = () => rig.ai.textOf(rig.ai.last());

describe('the Australian context the server builds (auAiContextFor)', () => {
  it('is null for an overseas doctor and with the switch off, and asks nothing with the switch off', async () => {
    expect(await rig.testUtils.auAiContextFor(uk.userId, { withState: true })).toBe(null);
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    expect(await rig.testUtils.auAiContextFor(vr.userId, { withState: true })).toBe(null);
    expect(rig.emu.requests.length).toBe(before);
  });
  it('segment A and segment B, as the model sees them', async () => {
    const a = await rig.testUtils.auAiContextFor(vr.userId, { caseRow: caseOf(vr), withState: true });
    expect(a.ctx.paragraph).toBe('This doctor is already in Australia, registered with Ahpra and working as a GP. They are changing practice within Australia. '
      + 'GP Link staff have confirmed they are a vocationally registered GP (FRACGP). They have no visa step and no registration step with GP Link. '
      + 'A registration condition, undertaking or notation is flagged on file and a person has reviewed it. Its wording is deliberately not given to you.');
    expect(a.ctx.stateFacts).toEqual([
      'Stage: Pre-start (Australian ladder: Placement, Pre-start, Commenced, Guarantee period, Complete).',
      'Ahpra register check: done by staff on 2026-10-01, registration confirmed on the public register.',
      'Placement: recorded at ' + PRACTICE + '.',
      'Planned start date: 2027-02-01 (not yet confirmed as started).',
      // the ONE definition of pre-start complete (FB-2a): the four tasks and the doctor's required documents
      'Pre-start items still open: Collect indemnity certificate; Practice credentialing pack; Document not yet approved: Ahpra registration certificate / register extract; Document not yet approved: Fellowship certificate (FRACGP / FACRRM); Document not yet approved: Right-to-work evidence; Document not yet approved: Working with Children Check.',
      'Pre-start items complete: Notice period and confirmed start date; Medicare provider number (new location).'
    ]);
    // the practice is told only what the introduction already says, and only its own pre-start items
    expect(a.practiceIntro).toMatch(/vocationally registered GP/);
    // (their own credentialing is open; the doctor's indemnity certificate and documents are not told to them)
    expect(a.practiceStateFacts).toEqual(['Planned start date at the practice: 2027-02-01.', 'Still open before the start, where the practice has a part: Practice credentialing pack.']);
    for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer, SECRET.suburb]) {
      expect(a.secrets, s).toContain(s);
      expect(a.practiceIntro, s).not.toContain(s);
      expect(JSON.stringify(a.ctx), s).not.toContain(s);
    }

    const b = await rig.testUtils.auAiContextFor(restricted.userId, { caseRow: caseOf(restricted), withState: true });
    expect(b.ctx.segment).toBe('B');
    expect(b.ctx.paragraph).toMatch(/^This doctor is already in Australia, registered with Ahpra and working as a GP\. They are changing practice within Australia\. They are recorded as an Australian-registered GP with restrictions/);
    expect(b.ctx.paragraph).toMatch(/Section 19AB: staff have confirmed it applies/);
    expect(b.ctx.paragraph).toMatch(/Right to work on file: a visa tied to a sponsoring employer\./);
    expect(b.ctx.paragraph).toMatch(/staff handle this doctor by hand/);
  });
  it('a pathway that cannot be read is "unreadable", never "overseas"', async () => {
    rig.emu.failTables = { user_profiles: 500 };
    expect(await rig.testUtils.auAiContextFor(vr.userId, { withState: true })).toEqual({ unreadable: true });
  });
});

describe('the case summary (ADM-15)', () => {
  const get = (d) => rig.get('/api/admin/candidate-summary?case_id=' + d.caseId + '&force=1', su());

  it('an Australian case: the Australian prompt, STATE facts first, no overseas journey, no commercial fact', async () => {
    rig.ai.reply = SUMMARY_REPLY;
    const res = await get(vr);
    expect(res.status).toBe(200);
    expect(rig.ai.calls.length).toBe(1);
    const body = rig.ai.last().body;
    const system = body.system[0].text;
    const user = body.messages[0].content;
    expect(system).toBe(rig.testUtils.auCaseSummarySystemPrompt());
    expect(system + user).not.toMatch(OVERSEAS_SENTENCE);
    expect(system).toMatch(/STATE FACTS.*OUTRANK task statuses, email claims/);
    // the STATE facts are the first thing in the data, above tasks, emails and the previous summary
    expect(user.indexOf('ABOUT THIS DOCTOR')).toBe(0);
    expect(user.indexOf('STATE FACTS')).toBeGreaterThan(0);
    expect(user.indexOf('STATE FACTS')).toBeLessThan(user.indexOf('CANDIDATE: Dr'));
    expect(user.indexOf('STATE FACTS')).toBeLessThan(user.indexOf('--- TASKS'));
    expect(user.indexOf('STATE FACTS')).toBeLessThan(user.indexOf('--- PREVIOUS HANDOVER SUMMARY ---'));
    expect(user).toMatch(/Pre-start items still open: Collect indemnity certificate; Practice credentialing pack; Document not yet approved: /);
    expect(user).toMatch(/Planned start date: 2027-02-01/);
    expect(user).toMatch(/CANDIDATE: Dr .* \| Australia \(already registered and working here\)/);
    // the overseas qualification list is not reported as "missing" for them
    expect(user).not.toMatch(/--- QUALIFICATIONS ---|MRCGP|CCT Certificate/);
    // no fee, invoice or credit; no condition wording
    expect(system + user).not.toContain(SECRET.condition);
    expect(user).not.toMatch(/invoice|\$\d|credit_pct|fee_amount/i);
    // the token budget and model are the ones the truncation fix set
    expect(body.max_tokens).toBe(16000);
    expect(body.temperature).toBeUndefined();
    // saved, awaited
    expect(caseOf(vr).ai_handover_summary.overview).toBe('An overview.');
  });

  it('a segment B case says what staff recorded (19AB, the sponsor tie) and nothing more', async () => {
    rig.ai.reply = SUMMARY_REPLY;
    expect((await get(restricted)).status).toBe(200);
    const user = rig.ai.last().body.messages[0].content;
    expect(user).toMatch(/Section 19AB: staff have confirmed it applies/);
    expect(user).toMatch(/a visa tied to a sponsoring employer/);
    expect(user).toMatch(/A visa may be mentioned only as the recorded fact above/);
    expect(rig.ai.last().body.system[0].text).not.toMatch(OVERSEAS_SENTENCE);
  });

  it('an overseas case keeps the overseas sentence (and the snapshot test pins every byte)', async () => {
    rig.ai.reply = SUMMARY_REPLY;
    expect((await get(uk)).status).toBe(200);
    const body = rig.ai.last().body;
    expect(body.system[0].text).toMatch(/helps overseas GPs register to work in Australia/);
    expect(body.messages[0].content).toMatch(/^CANDIDATE: Dr /);
    expect(body.messages[0].content).toMatch(/--- QUALIFICATIONS ---/);
  });

  it('switch off: an Australian doctor\'s case is an overseas case again (no Australian prompt, no new read)', async () => {
    rig.setSwitch(false);
    rig.ai.reply = SUMMARY_REPLY;
    expect((await get(vr)).status).toBe(200);
    expect(rig.ai.last().body.system[0].text).toMatch(/helps overseas GPs register to work in Australia/);
    expect(rig.ai.last().body.messages[0].content).not.toMatch(/ABOUT THIS DOCTOR/);
  });

  it('pathway unreadable: no summary is written and the model is not called with the overseas prompt', async () => {
    rig.ai.reply = SUMMARY_REPLY;
    rig.emu.forbid((r) => (r.table === 'gp_credentials' ? 'credentials unreadable' : null));
    const res = await get(vr);
    rig.emu.forbid(null);
    expect(res.status).toBe(503);
    expect(rig.ai.calls.length).toBe(0);
    expect(caseOf(vr).ai_handover_summary).toBe(null);
  });
});

describe('the summary refresher (refresh-summaries) now includes Australian cases', () => {
  const run = () => rig.get('/api/cron/refresh-summaries', { headers: { authorization: 'Bearer test-cron-secret' } });

  it('refreshes Australian and overseas cases in the same run, each with its own prompt', async () => {
    rig.ai.reply = SUMMARY_REPLY;
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, scanned: 3, stale: 3, refreshed: 3, failed: 0, skipped: 0 });
    for (const d of [vr, restricted, uk]) expect(caseOf(d).ai_handover_summary && caseOf(d).ai_handover_summary.generated_at, d.kind).toBeTruthy();
    const systems = rig.ai.calls.map((c) => c.body.system[0].text);
    expect(systems.filter((s) => OVERSEAS_SENTENCE.test(s)).length).toBe(1);           // the overseas case only
    expect(systems.filter((s) => s === rig.testUtils.auCaseSummarySystemPrompt()).length).toBe(2);
    // a second run has nothing to do: saving a summary is not "activity" (the self-write tolerance)
    rig.ai.reset(); rig.ai.reply = SUMMARY_REPLY;
    rows('registration_cases').forEach((r) => { r.updated_at = r.ai_handover_summary.generated_at; });
    expect((await run()).json).toMatchObject({ stale: 0, refreshed: 0 });
    expect(rig.ai.calls.length).toBe(0);
  }, 30000);

  it('keeps its time-box, its cap and the awaited save (the three fixes of 2026-08/09 are still in the code)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const job = src.slice(src.indexOf("pathname === '/api/cron/refresh-summaries'"), src.indexOf("pathname === '/api/admin/case' && req.method === 'PUT'"));
    expect(job).toMatch(/Date\.now\(\) - rsStart > 50000/);
    expect(job).toMatch(/SUMMARY_REFRESH_CAP \|\| 25/);
    expect(job).toMatch(/selectStaleSummaryCases\(rsCases/);
    // the interim exclusion is gone: no pathway index is read by this job any more
    expect(job).not.toMatch(/auSweepPathwayIndex|auSweepExcludesCaseId/);
    const endpoint = src.slice(src.indexOf("pathname === '/api/admin/candidate-summary'"), src.indexOf("pathname === '/api/cron/refresh-summaries'"));
    expect(endpoint).toMatch(/max_tokens: 16000/);
    expect(endpoint).toMatch(/stop_reason === 'max_tokens'/);
    expect(endpoint).toMatch(/var handoverSave = await supabaseDbRequest\('registration_cases'/);
  });

  it('a truncated answer is still reported as cut off, for an Australian case too', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => (String(url).indexOf('api.anthropic.com') !== -1
      ? Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"overview": "half' }], stop_reason: 'max_tokens', usage: { output_tokens: 16000 } }), { status: 200 }))
      : realFetch(url, init));
    try {
      const res = await rig.get('/api/admin/candidate-summary?case_id=' + vr.caseId + '&force=1', su());
      expect(res.status).toBe(502);
      expect(res.json.error).toMatch(/cut off before it finished/);
      expect(caseOf(vr).ai_handover_summary).toBe(null);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('staff reply drafts (suggest-reply)', () => {
  const post = (taskId) => rig.post('/api/admin/email-triage/suggest-reply', { taskId }, su());
  const CLEAN = 'Hi Test,\n\nThanks for your note. The one thing still open is your indemnity certificate of currency, which you can upload in the app.\n\nKind regards,\nTest Rso';

  it('to an Australian doctor: the Australian prompt and playbook; a clean draft passes through unchanged', async () => {
    caseOf(vr).ai_handover_summary = { overview: 'STAFF-SUMMARY-SENTINEL', key_history: '', generated_at: T };
    rig.ai.reply = CLEAN;
    const res = await post('task-email-gp-vr');
    expect(res.status).toBe(200);
    expect(res.json.suggestedReply).toBe(CLEAN);
    expect(res.json.rsoNotes).toEqual([]);
    const body = rig.ai.last().body;
    expect(body.system[0].text).not.toMatch(/helping overseas GPs register/);
    expect(body.system[0].text).toMatch(/Pre-start \(a placement is recorded and the doctor has not started yet\)/);
    const user = body.messages[0].content;
    expect(user.indexOf('ABOUT THIS DOCTOR')).toBe(0);
    expect(user).toMatch(/STAFF-SUMMARY-SENTINEL/);            // about them, to them
    expect(user).toMatch(/"stage": "Pre-start"/);
    expect(user).not.toMatch(/qualifications|MRCGP|"country"/);
    expect(user).toMatch(/Write a reply addressed directly to the doctor\./);
  });

  it('the net: a draft carrying banned wording is not handed over; the person writes it', async () => {
    for (const bad of ['Hi Test, your visa will be sorted soon.', 'Hi Test, once you relocate we will be in touch.', 'Hi Test, your MyIntealth account is next.', 'Hi Test, your number ' + SECRET.ahpra + ' is on file.']) {
      rig.ai.reset(); rig.ai.reply = bad;
      const res = await post('task-email-gp-vr');
      expect(res.status, bad).toBe(200);
      expect(res.json.suggestedReply, bad).toBe('');
      expect(res.json.rsoNotes.join(' '), bad).toMatch(/The AI draft was not used/);
      expect(JSON.stringify(res.json), bad).not.toContain(bad);
    }
  });

  it('to a practice, about an Australian doctor: no staff summary, no condition wording, no numbers, no current employer in the prompt', async () => {
    caseOf(vr).ai_handover_summary = { overview: 'STAFF-SUMMARY-SENTINEL ' + SECRET.condition, key_history: '', generated_at: T };
    rig.ai.reply = 'Hi Pat,\n\nThanks for your email. We will send the credentialing pack this week.\n\nKind regards,\nTest Rso';
    const res = await post('task-email-pm-vr');
    expect(res.status).toBe(200);
    expect(res.json.suggestedReply).toMatch(/credentialing pack/);
    const sent = sentText();
    for (const s of ['STAFF-SUMMARY-SENTINEL', SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer, SECRET.suburb]) expect(sent, s).not.toContain(s);
    expect(sent).toMatch(/\[withheld\]/);                      // the number the practice typed was taken out
    expect(sent).toMatch(/WHAT GP LINK NEEDS FROM A PRACTICE/);
    // the placed practice is told the start date and its own open item; never the introduction paragraph
    expect(sent).toMatch(/Planned start date at the practice: 2027-02-01\./);
    expect(sent).toMatch(/Nothing else about them has been cleared for this practice\./);
    expect(sent).not.toMatch(/vocationally registered GP \(FRACGP\)|based in New South Wales/);
    expect(sent).not.toMatch(/Collect indemnity certificate|open_tasks|Document not yet approved/);
    expect(sent).not.toContain(vr.email);                       // the doctor's own address is not handed to a reply for someone else
    expect(sent).toMatch(/refer to the doctor in the third person/);
    // and the practice net: money, or "registration process", never leaves
    rig.ai.reset(); rig.ai.reply = 'Hi Pat, our fee is $21,000 and we are managing the registration process.';
    const bad = await post('task-email-pm-vr');
    expect(bad.json.suggestedReply).toBe('');
    expect(bad.json.rsoNotes.join(' ')).toMatch(/The AI draft was not used/);
  });

  it('to a third party who is not the placed practice: nothing from the doctor\'s records at all', async () => {
    const stranger = rows('registration_tasks').filter((t) => t.id === 'task-email-pm-vr')[0];
    const was = stranger.email_sender;
    stranger.email_sender = 'Someone Else <someone@gmail.com>';
    rig.ai.reply = 'Hi, thanks for your email. We will come back to you shortly.';
    try {
      expect((await post('task-email-pm-vr')).status).toBe(200);
      const sent = sentText();
      expect(sent).toMatch(/Nothing else about them has been cleared for this practice\./);
      expect(sent).not.toMatch(/Planned start date|Still open before the start|WHERE THINGS STAND|vocationally registered GP \(FRACGP\)/);
      for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer, SECRET.suburb]) expect(sent, s).not.toContain(s);
    } finally { stranger.email_sender = was; }
    // the rule itself: the same address, or the practice's own domain; never a shared webmail domain
    const is = rig.testUtils.auSenderIsPractice;
    expect(is('Pat <pm@practice-test.local>', ['pm@practice-test.local'])).toBe(true);
    expect(is('reception@practice-test.local', ['pm@practice-test.local'])).toBe(true);
    expect(is('someone@gmail.com', ['practice@gmail.com'])).toBe(false);
    expect(is('practice@gmail.com', ['practice@gmail.com'])).toBe(true);
    expect(is('pm@other.test', ['pm@practice-test.local', null, ''])).toBe(false);
    expect(is('', ['pm@practice-test.local'])).toBe(false);
  });

  it('an overseas doctor: today\'s prompt, and nothing is netted (a draft about their visa is theirs to receive)', async () => {
    const visaReply = 'Hi Test, your visa documents are next once AHPRA is granted.';
    rig.ai.reply = visaReply;
    const res = await post('task-email-gp-uk');
    expect(res.json.suggestedReply).toBe(visaReply);
    expect(rig.ai.last().body.system[0].text).toMatch(/helping overseas GPs register to work in Australia/);
    expect(rig.ai.last().body.messages[0].content).not.toMatch(/ABOUT THIS DOCTOR/);
  });

  it('pathway unreadable: no draft and no model call', async () => {
    rig.emu.forbid((r) => (r.table === 'gp_credentials' ? 'credentials unreadable' : null));
    const res = await post('task-email-gp-vr');
    rig.emu.forbid(null);
    expect(res.status).toBe(200);
    expect(res.json.suggestedReply).toBe('');
    expect(res.json.rsoNotes.join(' ')).toMatch(/could not check this doctor's pathway/);
    expect(rig.ai.calls.length).toBe(0);
  });
});

describe('the Zoom "reason for the meeting" (shown to the doctor)', () => {
  const post = (taskId) => rig.post('/api/admin/calls/suggest-reason', { task_id: taskId }, su());
  it('Australian: no "international GP", the stage in the doctor\'s own words, and the net with a fixed fallback', async () => {
    rig.ai.reply = 'A call to walk you through the provider number form for your new practice.';
    const ok = await post('task-wa-vr');
    expect(ok.json.suggestedReason).toBe('A call to walk you through the provider number form for your new practice.');
    const body = rig.ai.last().body;
    expect(body.system[0].text).not.toMatch(/international GP|registering to practise in Australia/);
    expect(body.system[0].text).toMatch(/already registered with Ahpra and working in Australia/);
    expect(body.messages[0].content).toMatch(/Where they are up to: Pre-start checks/);
    expect(body.messages[0].content).not.toMatch(/Stage: prestart|Stage: registration/);

    for (const bad of ['A call about your visa and your move to Australia.', 'A call to help with your AMC portfolio.']) {
      rig.ai.reset(); rig.ai.reply = bad;
      const res = await post('task-wa-vr');
      expect(res.json.suggestedReason, bad).toBe(rig.testUtils.AU_ZOOM_REASON_FALLBACK);
    }
    expect(auDoctorText.violations(rig.testUtils.AU_ZOOM_REASON_FALLBACK)).toEqual([]);
  });
  it('overseas: the sentence is present and the answer is not netted', async () => {
    rig.ai.reply = 'A call to help with your AMC portfolio.';
    const res = await post('task-wa-uk');
    expect(res.json.suggestedReason).toBe('A call to help with your AMC portfolio.');
    expect(rig.ai.last().body.system[0].text).toMatch(/an international GP \(registering to practise in Australia via GP Link\)/);
  });
});

describe('practice chase drafts', () => {
  const post = (taskId) => rig.post('/api/admin/practice-nudge/draft', { taskId }, su());
  const reply = (text) => JSON.stringify({ suggested_subject: 'x', suggested_reply: text, rso_notes: '' });

  it('Australian: the Australian prompt, nothing secret in it, and a clean draft is used', async () => {
    const clean = 'Hi there,\n\nJust following up on the signed contract for Dr Test. Could you send it through when you have a moment?\n\nKind regards,\nTest Rso';
    rig.ai.reply = reply(clean);
    const res = await post('task-chase-vr');
    expect(res.json.nudge.source).toBe('ai');
    expect(res.json.nudge.suggested_reply).toBe(clean);
    const sent = sentText();
    expect(sent).not.toMatch(/helps overseas GPs register/);
    expect(sent).toMatch(/WHAT GP LINK NEEDS FROM A PRACTICE/);
    for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer, SECRET.suburb]) expect(sent, s).not.toContain(s);
  });
  it('the net: a chase with registration or visa framing is replaced by the fixed Australian wording', async () => {
    for (const bad of ['Hi, we need this for the visa application.', 'Hi, we are managing the registration process and need the contract.', 'Hi, as Dr Test is internationally trained we need the contract.']) {
      rig.ai.reset(); rig.ai.reply = reply(bad);
      const res = await post('task-chase-vr');
      expect(res.json.nudge.source, bad).toBe('fallback');
      expect(res.json.nudge.suggested_reply, bad).toMatch(/ready to start with you/);
      expect(res.json.nudge.suggested_reply, bad).not.toMatch(/registration|visa/i);
      expect(ctxLib.auOutputNet(res.json.nudge.suggested_reply, { audience: 'practice' }).ok).toBe(true);
    }
  });
  it('overseas: today\'s prompt, today\'s fallback, nothing netted', async () => {
    const text = 'Hi, we need the Supervisor CV for the registration process.';
    rig.ai.reply = reply(text);
    const res = await post('task-chase-uk');
    expect(res.json.nudge.source).toBe('ai');
    expect(res.json.nudge.suggested_reply).toBe(text);
    expect(rig.ai.last().body.system[0].text).toMatch(/helps overseas GPs register to work in Australia/);
    // with the model down, the overseas fallback is the old wording
    rig.ai.reset(); rig.ai.status = 500;
    expect((await post('task-chase-uk')).json.nudge.suggested_reply).toMatch(/to proceed with their registration/);
  });
});

describe('the "why we recommend" blurb sent to a practice', () => {
  const cv = { buffer: Buffer.from('%PDF-1.4 fake cv'), mimeType: 'application/pdf', fileName: 'cv.pdf', gpName: 'Test Auvr' };
  it('Australian: built only from what the practice may see, with the forbidden framings; the net stays the last line', async () => {
    const a = await rig.testUtils.auAiContextFor(vr.userId, { withState: true });
    const intro = careerIntro.buildAuCandidateIntro({ gpName: 'Test Auvr', facts: careerIntro.auIntroFactsFromRecords({ pathwayResult: a.pathway, credentials: a.credentials, profile: a.profile, now: new Date(T) }) });
    const good = 'Dr Test Auvr has more than ten years of general practice experience. Dr Test Auvr has strengths in chronic disease management and teaching. Dr Test Auvr would be an excellent addition to your team.';
    rig.ai.reply = good;
    const out = await rig.testUtils.generateCandidateRecommendation(Object.assign({ auIntro: intro }, cv));
    expect(out).toBe(good);
    expect(careerIntro.auSafeRecommendation(out)).toBe(good);
    const prompt = rig.ai.last().body.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(prompt).toContain(intro.paragraph);
    expect(prompt).toMatch(/already registered with Ahpra and working in Australia/);
    expect(prompt).toMatch(/Do not say where the doctor trained/);
    expect(prompt).toMatch(/Do not name the doctor's current or most recent employer/);
    for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer, SECRET.suburb]) expect(prompt, s).not.toContain(s);
    // a model that ignores the instruction: the blurb is dropped whole
    for (const bad of ['Dr Test Auvr is an internationally trained GP.', 'Dr Test Auvr is relocating from the UK.', 'Dr Test Auvr bills $400k a year.']) {
      rig.ai.reset(); rig.ai.reply = bad + ' More text so that it is long enough to be kept.';
      const raw = await rig.testUtils.generateCandidateRecommendation(Object.assign({ auIntro: intro }, cv));
      expect(raw, bad).toMatch(/Dr Test Auvr/);
      expect(careerIntro.auSafeRecommendation(raw), bad).toBe('');
    }
  });
  it('overseas (no auIntro): the prompt is today\'s', async () => {
    rig.ai.reply = 'Dr Test has ten years of experience and would be a great fit for your team.';
    await rig.testUtils.generateCandidateRecommendation(cv);
    const prompt = rig.ai.last().body.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(prompt).not.toMatch(/already registered with Ahpra|NEVER, in these three sentences/);
    expect(prompt).toMatch(/^You are writing on behalf of GP Link, a medical recruitment agency, to a practice manager\. This CV belongs/);
  });
});

describe('the job-board practice profile (public copy stored on the role)', () => {
  // (a name with no ordinary word in it: the server redacts the practice's name out of the copy)
  const row = { id: 'role-1', title: 'General Practitioner', practice_name: 'Quokkaville Zzyx (FAKE)', billing_model: 'Mixed Billing', employment_type: 'Contractor', practice_type: 'Family practice', metro: true, location_state: 'NSW', location_city: 'Sydney', source_payload: {} };
  const meta = { suburb: 'Erina', sourceBenefits: ['Visa and PR pathway support', 'Flexible sessions'], websiteUrl: 'https://quokkaville-zzyx.test', publicHeadline: 'old headline', publicIntro: 'old intro', publicBenefits: ['old'], publicSupport: 'old support', locationSummary: 'old' };
  const modelReply = (over) => JSON.stringify(Object.assign({
    headline: 'A friendly coastal family practice', intro: 'A well-supported family practice with a strong nursing team. Ideal for overseas doctors relocating to Australia.',
    benefits: ['Visa and PR pathway support', 'Flexible sessions', 'Mixed billing'], support: 'Full onboarding from day one. We help with your move.',
    location_summary: 'A relaxed coastal setting.', location_display: 'Erina, NSW', proximity_note: '', billing_model: 'Mixed Billing'
  }, over || {}));

  it('switch on: asked for audience-neutral copy; an overseas-only sentence is cut from what every audience reads; a visa benefit line survives for the doctors it is true for', async () => {
    rig.ai.reply = modelReply();
    const out = await rig.testUtils.createCareerRoleAiProfile(row, meta, 'We are a family practice.');
    const prompt = rig.ai.last().body.input;
    expect(prompt).not.toMatch(/for overseas General Practitioners relocating to Australia/);
    expect(prompt).toMatch(/GPs already registered and working in Australia who are changing practice, and GPs moving to Australia/);
    expect(prompt).toMatch(/ONLY as one benefit line of its own/);
    expect(out.publicIntro).toBe('A well-supported family practice with a strong nursing team.');
    expect(out.publicSupport).toBe('Full onboarding from day one.');
    expect(out.publicHeadline).toBe('A friendly coastal family practice');
    expect(out.publicBenefits).toEqual(['Visa and PR pathway support', 'Flexible sessions', 'Mixed billing']);
    // and an Australian doctor's own view of that stored copy has no such line (WP-12's filter)
    const seen = auDoctorText.scrubRolePayload({ intro: out.publicIntro, benefits: out.publicBenefits, support: out.publicSupport });
    expect(seen.benefits).toEqual(['Flexible sessions', 'Mixed billing']);
    expect(auDoctorText.violations(JSON.stringify(seen))).toEqual([]);
    // a clean reply is stored as written
    rig.ai.reset(); rig.ai.reply = modelReply({ intro: 'A well-supported family practice.', support: 'Full onboarding from day one.' });
    const clean = await rig.testUtils.createCareerRoleAiProfile(row, meta, 'x');
    expect(clean.publicIntro).toBe('A well-supported family practice.');
    expect(clean.publicSupport).toBe('Full onboarding from day one.');
  });
  it('switch off: the old premise, and the reply is stored exactly as the model wrote it', async () => {
    rig.setSwitch(false);
    rig.ai.reply = modelReply();
    const out = await rig.testUtils.createCareerRoleAiProfile(row, meta, 'We are a family practice.');
    expect(rig.ai.last().body.input).toMatch(/^You are writing a premium candidate-facing practice profile for overseas General Practitioners relocating to Australia\./);
    expect(out.publicIntro).toBe('A well-supported family practice with a strong nursing team. Ideal for overseas doctors relocating to Australia.');
    expect(out.publicSupport).toBe('Full onboarding from day one. We help with your move.');
  });
  it('nothing regenerates existing stored copy: the profile version is unchanged', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toMatch(/const CAREER_AI_PROFILE_VERSION = 2;/);
  });
});

describe('inbound mail: who the model is told is Australian, and which tasks wait on an emailed document', () => {
  it('marks Australian doctors in the triage list (switch on), and returns the same list otherwise', async () => {
    const list = [{ user_id: uk.userId, gp_name: 'Dr A' }, { user_id: vr.userId, gp_name: 'Dr B' }];
    const marked = await rig.testUtils.auMarkPlacedGpsForTriage(list);
    expect(marked[0]).toEqual(list[0]);
    expect(marked[1]).toEqual({ user_id: vr.userId, gp_name: 'Dr B', pathway: 'australian_gp' });
    expect(triage.triageSystemPromptFor(marked)).toBe(triage.TRIAGE_SYSTEM_PROMPT_AU);
    const overseasOnly = [{ user_id: uk.userId, gp_name: 'Dr A' }];
    expect(await rig.testUtils.auMarkPlacedGpsForTriage(overseasOnly)).toBe(overseasOnly);
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    expect(await rig.testUtils.auMarkPlacedGpsForTriage(list)).toBe(list);
    expect(rig.emu.requests.length).toBe(before);
    expect(triage.triageSystemPromptFor(list)).toBe(triage.TRIAGE_SYSTEM_PROMPT);
  });
  it('DAT-27: an Australian doctor\'s open indemnity / provider-number tasks join the matcher\'s list with WP-07\'s document keys (switch on only)', async () => {
    const on = await rig.testUtils.getOpenPracticePackTasks();
    const au = on.filter((t) => t.pathway === 'australian_gp');
    // vr: indemnity open (provider number already recorded); restricted: the same
    expect(au.map((t) => [t.task_id, t.document_type]).sort()).toEqual([['task-ind-b', 'au_indemnity_certificate'], ['task-ind-vr', 'au_indemnity_certificate']]);
    expect(au[0].gp_name).toMatch(/^Dr Test /);
    expect(aiMatching.matchSystemPromptFor(on)).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT_AU);
    // a provider-number task that is still open joins too
    rows('registration_tasks').filter((t) => t.id === 'task-prov-vr')[0].status = 'open';
    const again = (await rig.testUtils.getOpenPracticePackTasks()).filter((t) => t.task_id === 'task-prov-vr')[0];
    expect(again).toMatchObject({ document_type: 'au_provider_number_letter', practice_name: PRACTICE, pathway: 'australian_gp' });
    rows('registration_tasks').filter((t) => t.id === 'task-prov-vr')[0].status = 'completed';

    rig.setSwitch(false);
    const off = await rig.testUtils.getOpenPracticePackTasks();
    expect(off.filter((t) => t.pathway === 'australian_gp')).toEqual([]);
    expect(aiMatching.matchSystemPromptFor(off)).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT);
  });
});

describe('with AI unavailable every Australian flow still completes with its fixed fallback', () => {
  it('a failing provider: the chase is the fixed Australian wording; the reply draft and the Zoom reason report the failure and send nothing', async () => {
    rig.ai.status = 500;
    const n = await rig.post('/api/admin/practice-nudge/draft', { taskId: 'task-chase-vr' }, su());
    expect(n.json.nudge).toEqual(Object.assign(nudgeLib.buildFallbackNudge({ docTitle: 'Employment contract', gpName: vr.profile.first_name + ' ' + vr.profile.last_name, contactName: '', rsoName: n.json.nudge.suggested_reply.match(/Kind regards,\n(.*) — GP Link/) ? n.json.nudge.suggested_reply.match(/Kind regards,\n(.*) — GP Link/)[1] : '', au: true }), { suggested_subject: n.json.nudge.suggested_subject }));
    expect(n.json.nudge.suggested_reply).not.toMatch(/registration/i);
    expect((await rig.post('/api/admin/email-triage/suggest-reply', { taskId: 'task-email-gp-vr' }, su())).status).toBe(502);
    expect((await rig.post('/api/admin/calls/suggest-reason', { task_id: 'task-wa-vr' }, su())).status).toBe(502);
    expect(await rig.testUtils.generateCandidateRecommendation({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'cv.pdf', gpName: 'Test', auIntro: { paragraph: 'Dr Test is a GP.' } })).toBe('');
    const s = await rig.get('/api/admin/candidate-summary?case_id=' + vr.caseId + '&force=1', su());
    expect(s.status).toBe(502);
    expect(caseOf(vr).ai_handover_summary).toBe(null);
  });
});
