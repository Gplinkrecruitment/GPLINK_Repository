// Australian GP build, WP-20: every prompt an OVERSEAS doctor's case sends to a
// model is byte-identical to what it was before this package.
//
// tests/fixtures/au-wp20/overseas-prompts.json was written from commit 65a82792
// (the last commit before WP-20 touched a prompt), by running this file with
// WP20_WRITE_SNAPSHOT=1. It is never rewritten by a normal run. Each entry is
// compared: the switch on with nothing recorded for the doctor, the switch on
// with an explicit overseas pathway, and the switch off (both doctors).
//
// No AI provider is contacted: tests/helpers/au-wp20-rig.js answers every call.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { bootWp20Rig } = require('./helpers/au-wp20-rig.js');
const suggestReplyPrompt = require('../lib/suggest-reply-prompt.js');
const playbook = require('../lib/registration-playbook.js');
const nudge = require('../lib/practice-nudge-draft.js');
const followup = require('../lib/practice-reply-followup.js');
const aiMatching = require('../lib/ai-matching.js');
const triage = require('../lib/email-triage.js');
const jobMatch = require('../lib/ai-candidate-job-match.js');

const SNAPSHOT_FILE = path.join(__dirname, 'fixtures', 'au-wp20', 'overseas-prompts.json');
const WRITE = process.env.WP20_WRITE_SNAPSHOT === '1';
const T = '2026-10-01T02:00:00.000Z';

const OVERSEAS_STAGES = ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement'];

/** The pure prompt builders, called exactly as the server calls them for an overseas doctor. */
function libPrompts() {
  const out = {};
  OVERSEAS_STAGES.concat(['placement', 'prestart', 'commenced', 'guarantee', 'complete', '', 'nonsense']).forEach((stage) => {
    out['playbook:' + stage] = playbook.playbookForStage(stage);
  });
  OVERSEAS_STAGES.forEach((stage) => {
    [true, false].forEach((senderIsGp) => {
      const m = suggestReplyPrompt.buildSuggestReplyMessages({
        playbookText: playbook.playbookForStage(stage),
        handoverSummary: 'Dr Test is waiting on the practice.\nNo blockers.',
        facts: { stage, gp: { name: 'Test Overseas', country: 'GB' }, open_tasks: ['Upload passport (high, ' + stage + ')'] },
        threadText: JSON.stringify([{ from: 'pm@practice.test', subject: 'Re: documents', snippet: 'Will send Friday' }]),
        currentEmail: 'From: pm@practice.test\nSubject: Re: documents\n\nWill send Friday.',
        senderIsGp, rsoName: 'Test Rso'
      });
      out['suggest-reply:' + stage + ':' + (senderIsGp ? 'gp' : 'third-party')] = JSON.stringify(m);
    });
  });
  out['suggest-reply:no-playbook'] = JSON.stringify(suggestReplyPrompt.buildSuggestReplyMessages({ currentEmail: 'Hello' }));
  const nudgeArgs = {
    docTitle: 'Supervisor CV', signRequirement: 'It must be signed and dated by the supervisor.', gpName: 'Test Overseas',
    contactName: 'Pat', rsoName: 'Test Rso', threadText: '[1] us -> them: please send the CV', daysSinceLastContact: 4,
    practiceEverReplied: true, knownContacts: [{ email: 'naomi@practice.test', name: 'Naomi' }]
  };
  out['practice-nudge'] = JSON.stringify(nudge.buildPracticeNudgeMessages(nudgeArgs));
  out['practice-nudge:fallback'] = JSON.stringify(nudge.buildFallbackNudge(nudgeArgs));
  const followArgs = {
    docTitle: 'Supervisor CV', signRequirement: 'It must be signed and dated by the supervisor.', gpName: 'Test Overseas',
    contactName: 'Pat', rsoName: 'Test Rso', replyText: 'Naomi will send it.', replySender: 'pm@practice.test',
    requestText: 'Please send the Supervisor CV.', knownContacts: [{ email: 'naomi@practice.test', name: 'Naomi' }], formOnFile: false
  };
  out['practice-reply'] = JSON.stringify(followup.buildPracticeReplyMessages(followArgs));
  out['practice-reply:fallback'] = JSON.stringify(followup.buildFallbackFollowup(followArgs));
  out['practice-reply:fallback-on-file'] = JSON.stringify(followup.buildFallbackFollowup(Object.assign({}, followArgs, { formOnFile: true })));
  out['email-doc-match:system'] = aiMatching.AI_MATCH_SYSTEM_PROMPT;
  out['email-doc-match:user'] = aiMatching.buildAIMatchUserPrompt(
    { sender: 'pm@practice.test', senderName: 'Pat', to: 'hazel@gplink-test.local', subject: 'Contract', date: T, body: 'Attached.', attachments: [{ index: 0, filename: 'contract.pdf', mimeType: 'application/pdf', size: 10 }] },
    [{ task_id: 't1', document_type: 'offer_contract', gp_name: 'Test Overseas' }]);
  out['triage:system'] = triage.TRIAGE_SYSTEM_PROMPT;
  out['triage:ahpra-system'] = triage.AHPRA_TRIAGE_SYSTEM_PROMPT;
  out['triage:user'] = triage.buildTriagePrompt(
    { sender: 'pm@practice.test', subject: 'Provider number', date: T, bodyText: 'Where is it?' },
    [{ user_id: 'u1', gp_name: 'Dr Test Overseas', practice_name: 'Test Practice (FAKE)', contact_emails: ['pm@practice.test'] }]);
  out['match:system'] = jobMatch.AI_MATCH_SYSTEM_PROMPT;
  return out;
}

// ── the server, with a stubbed model ────────────────────────────────────────
const CASE = { stage: 'ahpra', practice_name: 'Test Overseas Practice (FAKE)', created_at: T, updated_at: T, last_gp_activity_at: T };
const uk = buildAuDoctor('overseas_null', { caseRow: CASE });
// The same doctor, with the overseas pathway written down by staff instead of left empty.
const ukExplicit = buildAuDoctor('overseas_null', {
  idSuffix: '2',
  profile: { candidate_pathway: 'overseas_esp', candidate_basis: 'overseas', pathway_set_by: 'staff.test@gplink-test.local', pathway_set_at: T, pathway_confirmed_at: T, pathway_confirmed_by: 'staff.test@gplink-test.local' },
  caseRow: Object.assign({}, CASE, { pathway: 'overseas_esp' })
});
const DOCTORS = [uk, ukExplicit];

function tasksFor(d, n) {
  return [
    { id: 'task-email-' + n, case_id: d.caseId, task_type: 'email_triage', title: 'Email: when do I upload my degree?', description: 'When do I upload my degree?', status: 'open', priority: 'normal', related_stage: 'ahpra', email_sender: d.email, email_body_snippet: 'Hi, when do I upload my degree certificate?', created_at: T, updated_at: T, metadata: {} },
    { id: 'task-wa-' + n, case_id: d.caseId, task_type: 'whatsapp_help', title: 'WhatsApp help', description: 'I am stuck on the certified copies, can we talk?', status: 'open', priority: 'high', related_stage: 'ahpra', created_at: T, updated_at: T, metadata: {} },
    { id: 'task-doc-' + n, case_id: d.caseId, task_type: 'practice_pack_child', title: 'Supervisor CV', description: '', status: 'waiting', priority: 'normal', related_stage: 'career', related_document_key: 'supervisor_cv', created_at: T, updated_at: T, metadata: {} }
  ];
}

let rig;
beforeAll(async () => {
  const tables = Object.assign(buildAuFixtureDb(DOCTORS), {
    registration_tasks: tasksFor(uk, 1).concat(tasksFor(ukExplicit, 2)),
    task_timeline: [
      { id: 'tl-1', case_id: uk.caseId, event_type: 'note', title: 'Called the doctor', actor: 'rso', created_at: T },
      { id: 'tl-2', case_id: ukExplicit.caseId, event_type: 'note', title: 'Called the doctor', actor: 'rso', created_at: T }
    ],
    task_messages: [
      { id: 'tm-1', case_id: uk.caseId, task_id: 'task-doc-1', direction: 'outbound', channel: 'email', sender: 'hazel@gplink-test.local', subject: 'Supervisor CV for Dr Test', body_text: 'Could you send the Supervisor CV?', created_at: T },
      { id: 'tm-2', case_id: ukExplicit.caseId, task_id: 'task-doc-2', direction: 'outbound', channel: 'email', sender: 'hazel@gplink-test.local', subject: 'Supervisor CV for Dr Test', body_text: 'Could you send the Supervisor CV?', created_at: T }
    ],
    doubletick_messages: [], support_tickets: [],
    practice_doc_ops: [
      { id: 'pdo-1', case_id: uk.caseId, document_key: 'supervisor_cv', ops_status: 'awaiting_practice', created_at: T },
      { id: 'pdo-2', case_id: ukExplicit.caseId, document_key: 'supervisor_cv', ops_status: 'awaiting_practice', created_at: T }
    ],
    user_documents: [], scheduled_calls: [], gp_applications: [], placements: [], practices: [], career_roles: [],
    runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [], admin_audit_log: [], task_contacts: [], case_contacts: []
  });
  rig = await bootWp20Rig({ name: 'wp20-parity', tables });
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });

async function capture(fn) {
  rig.ai.reset();
  await fn();
  return rig.ai.calls.map((c) => c.raw);
}

/** Every model request the server makes for one overseas doctor, in a fixed order. */
async function serverPrompts(d, n) {
  const out = {};
  const su = rig.superAdmin();
  // Start each pass from the same stored state: a summary saved by an earlier
  // pass would otherwise be fed back in as "previous handover summary".
  rig.emu.table('registration_cases').forEach((r) => { r.ai_handover_summary = null; r.updated_at = T; });
  const summaryReply = JSON.stringify({ overview: 'x', action_items: [], concerns: [], key_history: 'y' });
  out['server:candidate-summary'] = await capture(() => { rig.ai.reply = summaryReply; return rig.get('/api/admin/candidate-summary?case_id=' + d.caseId + '&force=1', su); });
  out['server:suggest-reply'] = await capture(() => rig.post('/api/admin/email-triage/suggest-reply', { taskId: 'task-email-' + n }, su));
  out['server:zoom-reason'] = await capture(() => rig.post('/api/admin/calls/suggest-reason', { task_id: 'task-wa-' + n }, su));
  out['server:recommendation'] = await capture(() => rig.testUtils.generateCandidateRecommendation({
    buffer: Buffer.from('%PDF-1.4 fake cv'), mimeType: 'application/pdf', fileName: 'cv.pdf', gpName: 'Test Overseas'
  }));
  const profileReply = JSON.stringify({ headline: 'A friendly coastal practice', intro: 'A practice.', benefits: ['Flexible sessions'], support: 'Supported.', location_summary: 'Coastal.', location_display: 'Erina, NSW', proximity_note: '', billing_model: 'Mixed Billing' });
  out['server:job-board-profile'] = await capture(() => {
    rig.ai.reply = profileReply;
    return rig.testUtils.createCareerRoleAiProfile(
      { title: 'General Practitioner', practice_name: 'Test Metro Practice (FAKE)', billing_model: 'Mixed Billing', employment_type: 'Contractor', practice_type: 'Family practice', metro: true, earnings_text: '', support_summary: 'Nursing support', location_state: 'NSW', location_city: 'Sydney', source_payload: {} },
      { suburb: 'Erina', sourceBenefits: ['Visa and PR pathway support', 'Flexible sessions'], websiteUrl: 'https://practice.test', publicHeadline: 'h', publicIntro: 'i', publicBenefits: [], publicSupport: 's', locationSummary: 'l' },
      'We are a family practice.').catch(() => null);
  });
  // The nudge thread carries "days since our last email", which moves with the
  // clock, so only its (static) system prompt is compared here; the whole
  // request is compared at builder level above.
  const nudgeCalls = await capture(() => {
    rig.ai.reply = JSON.stringify({ suggested_subject: 's', suggested_reply: 'Hi there, just following up.', rso_notes: '' });
    return rig.post('/api/admin/practice-nudge/draft', { taskId: 'task-doc-' + n }, su);
  });
  out['server:practice-nudge:system'] = nudgeCalls.map((raw) => JSON.stringify(JSON.parse(raw).system));
  return out;
}

function normalise(map, d) {
  // The two fixture doctors differ only by id / email / name; fold those so one snapshot serves both.
  let s = JSON.stringify(map);
  [[d.caseId, '<CASE>'], [d.userId, '<USER>'], [d.email, '<EMAIL>'], [d.profile.first_name, '<FIRST>'], [d.profile.last_name, '<LAST>']]
    .forEach(([from, to]) => { if (from) s = s.split(from).join(to); });
  return JSON.parse(s.replace(/task-(email|wa|doc)-\d/g, 'task-$1-N'));
}

describe('WP-20: overseas prompts are byte-identical', () => {
  it('writes the snapshot (only with WP20_WRITE_SNAPSHOT=1)', async () => {
    if (!WRITE) return;
    rig.setSwitch(false);
    const snap = { lib: libPrompts(), server: normalise(await serverPrompts(uk, 1), uk) };
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2) + '\n');
    rig.setSwitch(true);
  }, 60000);

  it('the pure builders, called the way an overseas case calls them', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    [true, false].forEach((on) => {
      process.env.AU_PATHWAY_ENABLED = on ? 'true' : 'false';
      const now = libPrompts();
      expect(Object.keys(now).sort()).toEqual(Object.keys(snap.lib).sort());
      Object.keys(snap.lib).forEach((k) => { expect(now[k], k + ' (switch ' + (on ? 'on' : 'off') + ')').toBe(snap.lib[k]); });
    });
    process.env.AU_PATHWAY_ENABLED = 'true';
  });

  const CASES = [
    ['switch on, nothing recorded', true, () => [uk, 1]],
    ['switch on, explicit overseas pathway', true, () => [ukExplicit, 2]],
    ['switch off', false, () => [uk, 1]],
    ['switch off, explicit overseas pathway', false, () => [ukExplicit, 2]]
  ];
  CASES.forEach(([label, on, pick]) => {
    it('every model request the server makes: ' + label, async () => {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      rig.setSwitch(on);
      const [d, n] = pick();
      const now = normalise(await serverPrompts(d, n), d);
      Object.keys(snap.server).forEach((k) => {
        expect(snap.server[k].length, k + ' made a model call in the snapshot').toBeGreaterThan(0);
        expect(now[k], k).toEqual(snap.server[k]);
      });
      rig.setSwitch(true);
    }, 60000);
  });
});
