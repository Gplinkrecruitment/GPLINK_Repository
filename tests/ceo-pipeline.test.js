// CEO Overview "Pipeline & money" board (mockup A, 2026-11-26):
//   unit  — lib/ceo-pipeline.js buildPipelineBoard() over a fixed clock + fixtures
//   route — GET /api/ceo/pipeline and the POST routes against the REAL server
//           + the in-memory PostgREST emulator from tests/ceo-overview.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import pipeline from '../lib/ceo-pipeline.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-ceo-pipeline-${RUN_ID}.json`;
const SUPER_HOST = 'ats-test.local';
const TZ = 'Australia/Sydney';
const NOW = '2026-11-26T03:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const H = 3600000, D = 86400000;
const ago = (ms) => new Date(NOW_MS - ms).toISOString();
const ahead = (ms) => new Date(NOW_MS + ms).toISOString();

const U = {
  ibrahim: '11111111-1111-4111-8111-000000000001',
  innocent: '11111111-1111-4111-8111-000000000002',
  mercy: '11111111-1111-4111-8111-000000000003',
  sana: '11111111-1111-4111-8111-000000000004',
  wakwanje: '11111111-1111-4111-8111-000000000005',
  dormant: '11111111-1111-4111-8111-000000000006',
  tester: '11111111-1111-4111-8111-000000000007',
  archived: '11111111-1111-4111-8111-000000000008',
  chikore: '11111111-1111-4111-8111-000000000009',
  hatice: '11111111-1111-4111-8111-000000000010',
  musharraf: '11111111-1111-4111-8111-000000000011'
};
const R = {
  haticeWa: '22222222-2222-4222-8222-000000000001',
  tanManual: '22222222-2222-4222-8222-000000000002',
  tanWa: '22222222-2222-4222-8222-000000000003',
  phoneWa: '22222222-2222-4222-8222-000000000004',
  phoneManual: '22222222-2222-4222-8222-000000000014',
  parastou: '22222222-2222-4222-8222-000000000005',
  gilmore: '22222222-2222-4222-8222-000000000006',
  later: '22222222-2222-4222-8222-000000000007',
  closed: '22222222-2222-4222-8222-000000000008',
  sanaApp: '22222222-2222-4222-8222-000000000009',
  hamza: '22222222-2222-4222-8222-000000000011',
  yanFind: '22222222-2222-4222-8222-000000000012',
  archived: '22222222-2222-4222-8222-000000000013',
  fresh: '22222222-2222-4222-8222-000000000015'
};

const PROFILES = [
  { user_id: U.ibrahim, first_name: 'Ibrahim', last_name: 'Fashola', email: 'ibrahim@example.com', phone: '+447700900001', created_at: ago(120 * D), onboarding_completed_at: ago(110 * D), account_status: 'active' },
  { user_id: U.innocent, first_name: 'Innocent', last_name: 'Aghadinuno', email: 'innocent@example.com', created_at: ago(90 * D), onboarding_completed_at: ago(80 * D), account_status: 'active' },
  { user_id: U.mercy, first_name: 'Mercy', last_name: 'Obanimoh', email: 'mercy@example.com', created_at: ago(300 * D), onboarding_completed_at: ago(290 * D), account_status: 'active' },
  { user_id: U.sana, first_name: 'Sana', last_name: 'Ahsan', email: 'sana@example.com', created_at: ago(200 * D), onboarding_completed_at: ago(190 * D), account_status: 'active' },
  { user_id: U.wakwanje, first_name: 'Wakwanje', last_name: 'Tizhe-Gami', email: 'wak@example.com', phone: '+447700900005', created_at: ago(10 * D), onboarding_completed_at: null, account_status: 'active' },
  { user_id: U.dormant, first_name: 'Dorma', last_name: 'Nt', email: 'dormant@example.com', created_at: ago(200 * D), onboarding_completed_at: null, account_status: 'active' },
  { user_id: U.tester, first_name: 'Khaleed', last_name: 'Test', email: 'khaleedmahmoud1211@gmail.com', created_at: ago(5 * D), onboarding_completed_at: null, account_status: 'active' },
  { user_id: U.archived, first_name: 'Arch', last_name: 'Ived', email: 'arch@example.com', created_at: ago(5 * D), onboarding_completed_at: null, account_status: 'archived' },
  { user_id: U.chikore, first_name: 'Obvious', last_name: 'Chikore', email: 'chikore@example.com', created_at: ago(400 * D), onboarding_completed_at: ago(390 * D), account_status: 'active' },
  { user_id: U.hatice, first_name: 'Hatice', last_name: 'Akkas', email: 'hatice@example.com', created_at: ago(100 * D), onboarding_completed_at: ago(95 * D), account_status: 'active' },
  { user_id: U.musharraf, first_name: 'Musharraf', last_name: 'Ali', email: 'mush@example.com', created_at: ago(100 * D), onboarding_completed_at: ago(95 * D), account_status: 'active' }
];
const APPS = [
  { id: 'a-ibrahim', user_id: U.ibrahim, career_role_id: 1, status: 'interview_completed', ats_stage: 'interview', ats_stage_updated_at: ago(12 * D), updated_at: ago(12 * D), applied_at: ago(30 * D) },
  { id: 'a-innocent', user_id: U.innocent, career_role_id: 2, status: 'applied', ats_stage: 'applied', origin: 'ai_matched', matched_at: ago(7 * D), updated_at: ago(7 * D), applied_at: ago(7 * D) },
  { id: 'a-sana', user_id: U.sana, career_role_id: 3, status: 'placement_secured', ats_stage: 'hired', updated_at: ago(40 * D) },
  { id: 'a-wak-dead', user_id: U.wakwanje, career_role_id: 2, status: 'withdrawn', ats_stage: 'not_proceeding', withdrawn_at: ago(3 * D), updated_at: ago(3 * D) },
  { id: 'a-tester', user_id: U.tester, career_role_id: 1, status: 'applied', ats_stage: 'interview', updated_at: ago(1 * D) },
  { id: 'a-mush', user_id: U.musharraf, career_role_id: 4, status: 'placement_secured', ats_stage: 'hired', updated_at: ago(30 * D) }
];
const ROLES = [
  { id: 1, practice_name: 'GP West' }, { id: 2, practice_name: 'Thornton Medical Centre' },
  { id: 3, practice_name: 'Halekulani Medical Centre' }, { id: 4, practice_name: 'Mount Hutton Medical' }
];
const PLACEMENTS = [
  { id: 'pl-mercy', user_id: U.mercy, practice_name: 'The Doctors Werribee', start_date: '2027-01-11', status: 'active', placed_at: ago(100 * D), created_at: ago(100 * D) },
  { id: 'pl-chikore', user_id: U.chikore, practice_name: 'Newcastle practice', start_date: '2026-06-01', status: 'active', placed_at: ago(300 * D), created_at: ago(300 * D) }
];
const CASES = [
  { id: 'case-mercy', user_id: U.mercy, stage: 'visa', status: 'active', updated_at: ago(5 * D) },
  { id: 'case-sana', user_id: U.sana, stage: 'ahpra', status: 'active', updated_at: ago(2 * D) },
  { id: 'case-chikore', user_id: U.chikore, stage: 'complete', status: 'active', updated_at: ago(60 * D) },
  { id: 'case-hatice', user_id: U.hatice, stage: 'career', status: 'active', updated_at: ago(50 * D) },
  { id: 'case-mush', user_id: U.musharraf, stage: 'career', status: 'active', updated_at: ago(30 * D) }
];
const CONTRACTS = [{ id: 'k-hatice', user_id: U.hatice, application_id: 'a-x', status: 'signed', created_at: ago(50 * D) }];
const SCHED = [
  { id: 'iv-ibrahim', user_id: U.ibrahim, application_id: 'a-ibrahim', meeting_kind: 'interview', status: 'completed', scheduled_at: ago(10 * D), completed_at: ago(10 * D) }
];
const ROWS = [
  { id: R.haticeWa, name: 'Dr Hatice Akkas', source: 'whatsapp_personal', source_ref: '111@lid', stage: 'warm', last_message_at: ago(20 * H), last_message_from: 'them', last_message_snippet: 'Is AHPRA granted? Why do my docs show missing?', created_at: ago(30 * D), updated_at: ago(20 * H) },
  { id: R.tanManual, name: 'Dr Tan Ke Ying', phone: '+60 12 345 6789', source: 'manual', stage: 'warm', waiting_on_owner: true, wait_note: 'Waiting for a call time', next_step: 'Lock in a call', created_at: ago(9 * D), updated_at: ago(1 * D) },
  { id: R.tanWa, name: 'Dr Tan Ke Ying', source: 'whatsapp_personal', source_ref: '222@lid', stage: 'warm', last_message_at: ago(1 * D), last_message_from: 'me', last_message_snippet: 'Sure, call me later', created_at: ago(9 * D), updated_at: ago(1 * D) },
  { id: R.phoneWa, name: '+44 7538 373168', phone: '+447538373168', source: 'whatsapp_personal', source_ref: '333@lid', stage: 'warm', last_message_at: ago(3 * D), last_message_from: 'them', last_message_snippet: 'Thanks!', created_at: ago(20 * D), updated_at: ago(3 * D) },
  { id: R.phoneManual, name: 'Dr Phone Person', phone: '07538 373168', source: 'manual', stage: 'warm', created_at: ago(20 * D), updated_at: ago(20 * D) },
  { id: R.parastou, name: 'Dr Parastou', source: 'manual', stage: 'warm', last_message_at: ago(40 * D), last_message_from: 'me', created_at: ago(60 * D), updated_at: ago(40 * D) },
  { id: R.gilmore, name: 'Dr David Gilmore', source: 'manual', stage: 'warm', last_message_at: ago(10 * D), last_message_from: 'me', created_at: ago(20 * D), updated_at: ago(10 * D) },
  { id: R.later, name: 'Dr Sam Olatigbe', source: 'manual', stage: 'later', later_until: '2027-03-01', later_reason: 'Committed until Jun 2027', created_at: ago(20 * D) },
  { id: R.closed, name: 'Dr Withdrawn Doctor', source: 'manual', stage: 'closed', created_at: ago(200 * D) },
  { id: R.sanaApp, name: 'Dr Sana Ahsan', user_id: U.sana, source: 'app', stage: 'warm', next_step: 'Wait for AHPRA decision', created_at: ago(30 * D), updated_at: ago(2 * D) },
  { id: R.hamza, name: 'Dr Hamza Masood', source: 'manual', stage: 'warm', heat_override: 1, last_message_at: ago(2 * D), last_message_from: 'them', created_at: ago(40 * D), updated_at: ago(2 * D) },
  { id: R.yanFind, name: 'Dr Yan Naing Win', source: 'email_contract', source_ref: 'gm-yan', stage: 'signed', needs_confirm: true, practice_name: 'Deception Bay Medical Centre', created_at: ago(1 * D), updated_at: ago(1 * D) },
  { id: R.archived, name: 'Dr Gone', source: 'manual', stage: 'warm', archived_at: ago(1 * D), created_at: ago(9 * D) },
  { id: R.fresh, name: 'Dr Fresh', source: 'whatsapp_personal', source_ref: '444@lid', stage: 'warm', last_message_at: ago(2 * H), last_message_from: 'them', created_at: ago(2 * H), updated_at: ago(2 * H) },
  { id: '22222222-2222-4222-8222-000000000099', name: 'Dr Khaleed Test', user_id: U.tester, source: 'app', stage: 'matched', created_at: ago(1 * D) }
];
const EVENTS = [
  { id: 'e1', person_id: R.phoneWa, kind: 'done', text: 'Replied', created_at: ago(2 * D) }
];
const DT = [
  { id: 'dt1', user_id: U.wakwanje, from_phone: '+447700900005', message_body: 'Which city should I pick?', direction: 'inbound', created_at: ago(15 * H) },
  { id: 'dt2', user_id: U.ibrahim, from_phone: '+447700900001', message_body: 'Old hello', direction: 'inbound', created_at: ago(20 * D) }
];
const FINDS = [
  { gmail_message_id: 'gm-yan', thread_id: 'th-yan', subject: 'Signed contract — Dr Yan Naing Win', doctor_name: 'Dr Yan Naing Win', practice_name: 'Deception Bay Medical Centre', signed_date: '2026-09-07', ai_summary: 'Signed employment agreement.', status: 'proposed', pipeline_person_id: R.yanFind }
];
const INVOICES = [
  { invoice_id: 'x-8516', invoice_number: 'INV-8516', type: 'ACCREC', status: 'AUTHORISED', contact_name: 'Halekulani Medical Centre', reference: 'Dr Tarig', invoice_date: '2026-06-25', due_date: '2026-07-25', total: 13750, amount_due: 13750, amount_paid: 0, doctor_name: 'Dr Sana Ahsan' },
  { invoice_id: 'x-874', invoice_number: 'INV-874', type: 'ACCREC', status: 'AUTHORISED', contact_name: 'The Doctors Werribee', invoice_date: '2026-06-12', due_date: '2026-07-12', total: 13750, amount_due: 13750, amount_paid: 0, doctor_name: null, user_id: U.mercy },
  { invoice_id: 'x-856', invoice_number: 'INV-856', type: 'ACCREC', status: 'AUTHORISED', contact_name: 'Halekulani Medical Centre', invoice_date: '2025-10-14', due_date: '2025-11-14', total: 3250, amount_due: 1250, amount_paid: 2000, doctor_name: 'Dr Withdrawn Doctor' },
  { invoice_id: 'x-963', invoice_number: 'INV-963', type: 'ACCREC', status: 'AUTHORISED', contact_name: 'Unknown Clinic', invoice_date: '2026-10-01', due_date: '2026-11-01', total: 3750, amount_due: 3750, amount_paid: 0, doctor_name: null },
  { invoice_id: 'x-sub', invoice_number: 'INV-990', type: 'ACCREC', status: 'SUBMITTED', contact_name: 'GP West', invoice_date: '2026-11-20', due_date: '2026-12-30', total: 5000, amount_due: 5000, amount_paid: 0, doctor_name: 'Dr Ibrahim Fashola' },
  { invoice_id: 'x-plan', invoice_number: 'INV-1001', type: 'ACCREC', status: 'AUTHORISED', contact_name: 'Forest Lake Local Doctors', invoice_date: '2026-11-20', due_date: '2026-12-20', total: 4583.32, amount_due: 4583.32, amount_paid: 0, doctor_name: 'Dr Krishnaveni Sivakumar' },
  { invoice_id: 'x-700', invoice_number: 'INV-700', type: 'ACCREC', status: 'PAID', contact_name: 'Newcastle practice', invoice_date: '2026-05-01', due_date: '2026-06-01', total: 13750, amount_due: 0, amount_paid: 13750, doctor_name: 'Dr Obvious Chikore' },
  { invoice_id: 'x-draft', invoice_number: 'INV-1002', type: 'ACCREC', status: 'DRAFT', contact_name: 'Halekulani', due_date: '2026-12-01', total: 100, amount_due: 100, doctor_name: 'Dr Sana Ahsan' },
  { invoice_id: 'x-void', invoice_number: 'INV-1003', type: 'ACCREC', status: 'VOIDED', contact_name: 'Halekulani', due_date: '2026-12-01', total: 100, amount_due: 100, doctor_name: 'Dr Hatice Akkas' },
  { invoice_id: 'x-bill', invoice_number: 'BILL-1', type: 'ACCPAY', status: 'AUTHORISED', contact_name: 'Supplier', due_date: '2026-01-01', total: 999, amount_due: 999, doctor_name: null }
];
const SYNC = [
  { source: 'xero', last_ok_at: ago(12 * 60000), last_run_at: ago(12 * 60000), detail: {} },
  { source: 'whatsapp_export', last_ok_at: ago(9 * D), detail: { exportedAtIso: ago(9 * D) } },
  { source: 'email_scan', last_ok_at: ago(40 * 60000), detail: {} }
];

function input(over) {
  return Object.assign({
    pipeline_people: ROWS, pipeline_events: EVENTS, gp_applications: APPS, placements: PLACEMENTS,
    registration_cases: CASES, user_profiles: PROFILES, career_contracts: CONTRACTS, career_roles: ROLES,
    scheduled_calls: SCHED, doubletick_messages: DT, xero_invoices: INVOICES, email_contract_finds: FINDS,
    pipeline_sync_state: SYNC, nowMs: NOW_MS, tz: TZ
  }, over || {});
}
const byName = (out, n) => out.people.find((p) => p.name === n);

// ── Unit ─────────────────────────────────────────────────────────────────────
describe('lib/ceo-pipeline buildPipelineBoard (unit)', () => {
  const out = pipeline.buildPipelineBoard(input());

  it('top-level shape and the six stages in board order', () => {
    expect(out.ok).toBe(true);
    expect(out.stages.map((s) => s.k)).toEqual(['warm', 'consult', 'matched', 'signed', 'visa', 'started']);
    for (const k of ['people', 'later', 'invoices', 'money', 'freshness', 'counts']) expect(out).toHaveProperty(k);
    expect(Object.keys(out.freshness).sort()).toEqual(['doubletick', 'email_scan', 'whatsapp_export', 'xero']);
  });

  it('normalises names and phones for dedupe', () => {
    expect(pipeline.normName('Dr. Hatice  Akkas')).toBe('hatice akkas');
    expect(pipeline.normName('Dr Hina (with Dr Mohammed Musheb)')).toBe('hina');
    expect(pipeline.normName('Dr Wakwanje Tizhe-Gami')).toBe('wakwanje tizhegami');
    expect(pipeline.phoneKey('+44 7538 373168')).toBe(pipeline.phoneKey('07538 373168'));
    expect(pipeline.phoneKey('123')).toBe('');
    expect(pipeline.namesMatch('Dr Sana Ahsan', 'Sana Q Ahsan')).toBe(true);
    expect(pipeline.namesMatch('Dr Sana', 'Dr Sana Ahsan')).toBe(false);
  });

  it('derives the stage of every app doctor', () => {
    expect(byName(out, 'Dr Ibrahim Fashola').stage).toBe('matched');
    expect(byName(out, 'Dr Innocent Aghadinuno').stage).toBe('matched');
    expect(byName(out, 'Dr Sana Ahsan').stage).toBe('signed');       // placement_secured, case at AHPRA
    expect(byName(out, 'Dr Hatice Akkas').stage).toBe('signed');     // signed contract, case before visa
    expect(byName(out, 'Dr Mercy Obanimoh').stage).toBe('visa');     // case at visa
    expect(byName(out, 'Dr Obvious Chikore').stage).toBe('started'); // case complete
    expect(byName(out, 'Dr Wakwanje Tizhe-Gami').stage).toBe('consult'); // account, only a withdrawn application
    expect(byName(out, 'Dr Ibrahim Fashola').practice).toBe('GP West');
    expect(byName(out, 'Dr Mercy Obanimoh').practice).toBe('The Doctors Werribee');
  });

  it('leaves out dormant, archived and test accounts, archived and closed rows', () => {
    const names = out.people.map((p) => p.name);
    expect(names).not.toContain('Dr Dorma Nt');
    expect(names).not.toContain('Dr Khaleed Test');
    expect(names).not.toContain('Dr Arch Ived');
    expect(names).not.toContain('Dr Gone');
    expect(names).not.toContain('Dr Withdrawn Doctor');
    expect(out.people.some((p) => p.user_id === U.tester)).toBe(false);
  });

  it('merges rows into app people by user_id and by name, and rows with each other by phone and name', () => {
    const sana = byName(out, 'Dr Sana Ahsan');
    expect(sana.id).toBe(R.sanaApp);
    expect(sana.user_id).toBe(U.sana);
    expect(sana.next).toBe('Wait for AHPRA decision');
    expect(sana.stage).toBe('signed'); // the app is further along than the row's 'warm'
    const hatice = byName(out, 'Dr Hatice Akkas');
    expect(hatice.id).toBe(R.haticeWa);
    expect(hatice.user_id).toBe(U.hatice);
    expect(hatice.channel).toBe('app');
    expect(hatice.open).toEqual({ kind: 'app', case_id: 'case-hatice', user_id: U.hatice });
    expect(out.people.filter((p) => p.name === 'Dr Tan Ke Ying')).toHaveLength(1);
    expect(byName(out, 'Dr Tan Ke Ying').id).toBe(R.tanManual);
    const phone = byName(out, 'Dr Phone Person');
    expect(phone).toBeTruthy();
    expect(phone.id).toBe(R.phoneManual);
    expect(out.people.some((p) => p.name === '+44 7538 373168')).toBe(false);
    expect(phone.open).toEqual({ kind: 'whatsapp', url: 'https://wa.me/447538373168' });
  });

  it('a row stage that is further along than the app wins', () => {
    const rows = ROWS.concat([{ id: '22222222-2222-4222-8222-0000000000aa', name: 'Dr Wakwanje', user_id: U.wakwanje, source: 'app', stage: 'matched', created_at: ago(1 * D), updated_at: ago(1 * D) }]);
    const o = pipeline.buildPipelineBoard(input({ pipeline_people: rows }));
    const w = o.people.find((p) => p.user_id === U.wakwanje);
    expect(w.stage).toBe('matched');
    expect(w.app_stage).toBe('consult');
  });

  it('a row can keep a dormant app account on the board, and a later/closed row takes an app doctor off it', () => {
    const rows = ROWS.concat([
      { id: '22222222-2222-4222-8222-0000000000ab', name: 'Dr Dorma Nt', source: 'whatsapp_personal', source_ref: 'd@lid', stage: 'warm', last_message_at: ago(1 * D), last_message_from: 'me', created_at: ago(1 * D) },
      { id: '22222222-2222-4222-8222-0000000000ac', name: 'Dr Innocent Aghadinuno', user_id: U.innocent, source: 'app', stage: 'later', later_until: '2026-11-01', later_reason: 'Exams first', created_at: ago(1 * D) }
    ]);
    const o = pipeline.buildPipelineBoard(input({ pipeline_people: rows }));
    const d = o.people.find((p) => p.user_id === U.dormant);
    expect(d).toBeTruthy();
    expect(d.stage).toBe('warm');
    expect(o.people.some((p) => p.user_id === U.innocent)).toBe(false);
    expect(o.later.find((l) => l.name === 'Dr Innocent Aghadinuno')).toMatchObject({ when: 'now', later_reason: 'Exams first' });
  });

  it('red: waiting_on_owner, a message from them older than 12 h, an unanswered business WhatsApp', () => {
    const tan = byName(out, 'Dr Tan Ke Ying');
    expect(tan.flag).toBe('red');
    expect(tan.reasons).toContain('waiting');
    expect(tan.wait).toBe('Waiting for a call time');
    const hatice = byName(out, 'Dr Hatice Akkas');
    expect(hatice.flag).toBe('red');
    expect(hatice.reasons[0]).toBe('message');
    expect(hatice.wait).toMatch(/^They messaged you .*“Is AHPRA granted\? Why do my docs show missing\?”, no reply$/);
    const wak = byName(out, 'Dr Wakwanje Tizhe-Gami');
    expect(wak.flag).toBe('red');
    expect(wak.reasons).toContain('business_whatsapp');
    expect(wak.wait).toContain('Which city should I pick?');
  });

  it('not red: a message under 12 h old, one answered with Done, or a business message older than 14 days', () => {
    expect(byName(out, 'Dr Fresh').flag).toBe('');
    expect(byName(out, 'Dr Phone Person').flag).toBe(''); // Done 2 days ago, after their message 3 days ago
    expect(byName(out, 'Dr Ibrahim Fashola').reasons).not.toContain('business_whatsapp');
  });

  it('amber: interview done > 7 days with no decision', () => {
    const p = byName(out, 'Dr Ibrahim Fashola');
    expect(p.flag).toBe('amber');
    expect(p.reasons).toContain('interview');
    expect(p.wait).toBe('Interview done 16 Nov, no decision for 10 days');
    expect(p.next).toBe('Ask the practice for a decision');
  });

  it('amber: matched but not sent to the practice for > 3 days', () => {
    const p = byName(out, 'Dr Innocent Aghadinuno');
    expect(p.flag).toBe('amber');
    expect(p.reasons).toEqual(['not_sent']);
    expect(p.wait).toBe('Matched 19 Nov, not sent to the practice');
    expect(p.status).toBe('Matched, not sent yet');
    expect(p.practice).toBe('Thornton Medical Centre');
  });

  it('amber: nothing has moved for 21 days on a matched/signed doctor', () => {
    const p = byName(out, 'Dr Musharraf Ali');
    expect(p.stage).toBe('signed');
    expect(p.flag).toBe('amber');
    expect(p.reasons).toEqual(['stale']);
    expect(p.wait).toBe('Nothing has moved for 30 days');
    // Hatice is stale too, but red beats amber.
    expect(byName(out, 'Dr Hatice Akkas').reasons).toContain('stale');
  });

  it('amber: an email contract find waiting for the owner, with a Gmail link', () => {
    const p = byName(out, 'Dr Yan Naing Win');
    expect(p.stage).toBe('signed');
    expect(p.flag).toBe('amber');
    expect(p.wait).toBe('Found in email — confirm');
    expect(p.next).toBe('Confirm the contract');
    expect(p.find).toMatchObject({ gmail_message_id: 'gm-yan', thread_id: 'th-yan' });
    expect(p.find.url).toBe('https://mail.google.com/mail/u/?authuser=hello@mygplink.com.au#all/th-yan');
    expect(p.channel).toBe('email');
    expect(p.open).toEqual({ kind: 'gmail', url: p.find.url });
    expect(p.practice).toBe('Deception Bay Medical Centre');
  });

  it('an email find with no row of its own still shows (synthetic person)', () => {
    const o = pipeline.buildPipelineBoard(input({ email_contract_finds: FINDS.concat([{ gmail_message_id: 'gm-new', thread_id: 'th-new', doctor_name: 'Dr New Signing', practice_name: 'X Clinic', status: 'proposed' }]) }));
    const p = o.people.find((x) => x.name === 'Dr New Signing');
    expect(p.id).toBe('find-gm-new');
    expect(p.flag).toBe('amber');
    expect(p.stage).toBe('signed');
  });

  it('an existing row the scan flagged (metadata.gmail_message_id) gets the Confirm/Dismiss find, and an orphan confirm row still gets buttons', () => {
    const rows = ROWS.concat([
      { id: '22222222-2222-4222-8222-0000000000d1', name: 'Dr Naila Said', source: 'whatsapp_personal', source_ref: 'naila@lid', stage: 'signed', needs_confirm: true, metadata: { gmail_message_id: 'gm-naila' }, created_at: ago(10 * D) },
      { id: '22222222-2222-4222-8222-0000000000d2', name: 'Dr Orphan Find', source: 'email_contract', source_ref: 'gm-orphan', stage: 'signed', needs_confirm: true, created_at: ago(1 * D) }
    ]);
    const finds = FINDS.concat([{ gmail_message_id: 'gm-naila', thread_id: 'th-naila', doctor_name: 'Naila Said', status: 'proposed', pipeline_person_id: null }]);
    const o = pipeline.buildPipelineBoard(input({ pipeline_people: rows, email_contract_finds: finds }));
    const naila = o.people.find((p) => p.name === 'Dr Naila Said');
    expect(naila.find.gmail_message_id).toBe('gm-naila');
    expect(naila.find.thread_id).toBe('th-naila');
    expect(naila.flag).toBe('amber');
    expect(o.people.filter((p) => p.name === 'Dr Naila Said')).toHaveLength(1);
    const orphan = o.people.find((p) => p.name === 'Dr Orphan Find');
    expect(orphan.find.gmail_message_id).toBe('gm-orphan');
    expect(orphan.wait).toBe('Found in email — confirm');
  });

  it('heat: override, hot (them within 7 days or red), warm (contact within 21 days), cooling', () => {
    expect(byName(out, 'Dr Hamza Masood').heat).toBe(1);         // override beats a red flag
    expect(byName(out, 'Dr Hamza Masood').flag).toBe('red');
    expect(byName(out, 'Dr Tan Ke Ying').heat).toBe(3);          // red
    expect(byName(out, 'Dr Fresh').heat).toBe(3);                // them 2 h ago
    expect(byName(out, 'Dr David Gilmore').heat).toBe(2);        // you, 10 days ago
    expect(byName(out, 'Dr Parastou').heat).toBe(1);             // 40 days ago
    expect(byName(out, 'Dr Wakwanje Tizhe-Gami').heat).toBe(3);  // consult column, red
    expect(byName(out, 'Dr Sana Ahsan').heat).toBeNull();        // signed: no heat pill
  });

  it('later: parked rows with their date and reason', () => {
    expect(out.later).toEqual([{ id: R.later, name: 'Dr Sam Olatigbe', later_until: '2027-03-01', later_reason: 'Committed until Jun 2027', when: '1 Mar 2027' }]);
    expect(out.counts.later).toBe(1);
  });

  it('invoice states: overdue, decide (failed placement), check (no doctor / awaiting approval), coming', () => {
    const inv = (n) => out.invoices.find((i) => i.number === n);
    expect(inv('INV-8516')).toMatchObject({ state: 'overdue', amount: 13750, days: 124, practice: 'Halekulani Medical Centre', doctor: 'Dr Sana Ahsan', person_id: R.sanaApp, due: '25 Jul' });
    expect(inv('INV-8516').url).toBe('https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=x-8516');
    expect(inv('INV-874')).toMatchObject({ state: 'overdue', days: 137, doctor: 'Dr Mercy Obanimoh' });
    expect(inv('INV-856')).toMatchObject({ state: 'decide', amount: 1250, days: 377, last: 'Part paid $2,000' });
    expect(inv('INV-856').note).toMatch(/^Placement failed/);
    expect(inv('INV-963')).toMatchObject({ state: 'check', person_id: null });
    expect(inv('INV-990')).toMatchObject({ state: 'check' });
    expect(inv('INV-1001')).toMatchObject({ state: 'coming', days: null, due: '20 Dec' });
    expect(inv('INV-700')).toBeUndefined();  // paid
    expect(inv('INV-1002')).toBeUndefined(); // draft
    expect(inv('INV-1003')).toBeUndefined(); // voided
    expect(inv('BILL-1')).toBeUndefined();   // a bill, not a sales invoice
    expect(out.invoices.map((i) => i.state)).toEqual(['overdue', 'overdue', 'decide', 'check', 'check', 'not_invoiced', 'not_invoiced', 'not_invoiced', 'coming']);
  });

  it('a placement cancelled in the app also makes its invoice "decide"', () => {
    const o = pipeline.buildPipelineBoard(input({
      placements: PLACEMENTS.concat([{ id: 'pl-x', user_id: U.innocent, practice_name: 'Thornton', status: 'cancelled', created_at: ago(50 * D) }]),
      xero_invoices: INVOICES.concat([{ invoice_id: 'x-inn', invoice_number: 'INV-2000', type: 'ACCREC', status: 'AUTHORISED', due_date: '2026-10-01', total: 500, amount_due: 500, amount_paid: 0, user_id: U.innocent }])
    }));
    expect(o.invoices.find((i) => i.number === 'INV-2000').state).toBe('decide');
  });

  it('money lines on the cards and "signed, no invoice yet"', () => {
    expect(byName(out, 'Dr Sana Ahsan').money).toBe('INV-8516 $13,750 overdue');
    expect(byName(out, 'Dr Mercy Obanimoh').money).toBe('INV-874 $13,750 overdue');
    expect(byName(out, 'Dr Obvious Chikore').money).toBe('Paid in full');
    expect(byName(out, 'Dr Ibrahim Fashola').money).toBe('INV-990 $5,000 unpaid');
    expect(byName(out, 'Dr Hatice Akkas').money).toBe('No invoice found yet'); // only a voided one
    expect(byName(out, 'Dr Parastou').money).toBe('');
    const ni = out.invoices.filter((i) => i.state === 'not_invoiced').map((i) => i.doctor).sort();
    expect(ni).toEqual(['Dr Hatice Akkas', 'Dr Musharraf Ali', 'Dr Yan Naing Win']);
  });

  it('money totals', () => {
    expect(out.money).toEqual({
      connected: true,
      overdue: 28750, overdueN: 3, oldestDays: 377,
      check: 8750, checkN: 2,
      coming: 4583.32, comingN: 1,
      notInvoiced: 3, notInvoicedNames: expect.arrayContaining(['Dr Hatice Akkas', 'Dr Musharraf Ali', 'Dr Yan Naing Win'])
    });
  });

  it('without a successful Xero sync: no numbers, no invoices, no money lines (never fake zeros)', () => {
    const o = pipeline.buildPipelineBoard(input({ pipeline_sync_state: SYNC.filter((s) => s.source !== 'xero') }));
    expect(o.money.connected).toBe(false);
    expect(o.money.overdue).toBeNull();
    expect(o.money.notInvoiced).toBeNull();
    expect(o.invoices).toEqual([]);
    expect(o.people.every((p) => p.money === '')).toBe(true);
    expect(o.freshness.xero).toEqual({ state: 'never', at: null, label: 'Xero not connected' });
    const failing = pipeline.buildPipelineBoard(input({ pipeline_sync_state: [{ source: 'xero', last_ok_at: null, last_error: 'invalid_grant' }] }));
    expect(failing.money.connected).toBe(false);
    expect(failing.freshness.xero.label).toBe('Xero sync failing: invalid_grant');
  });

  it('freshness labels', () => {
    expect(out.freshness.xero).toMatchObject({ state: 'ok', label: 'Xero checked 12 min ago' });
    expect(out.freshness.whatsapp_export).toMatchObject({ state: 'stale', label: 'WhatsApp export 9 days old — upload a new one' });
    expect(out.freshness.email_scan).toMatchObject({ state: 'ok', label: 'Email scan 40 min ago' });
    expect(out.freshness.doubletick.label).toBe('Business WhatsApp: last message 15 h ago');
    const none = pipeline.buildPipelineBoard({ nowMs: NOW_MS });
    expect(none.freshness.whatsapp_export.label).toBe('No WhatsApp export yet — upload one');
    expect(none.freshness.email_scan.label).toBe('Email scan not run yet');
  });

  it('counts, and cards sorted red → amber → fine within a column', () => {
    expect(out.counts.people).toBe(out.people.length);
    expect(out.counts.red).toBe(out.people.filter((p) => p.flag === 'red').length);
    expect(out.counts.by_stage.signed).toBe(4);
    const warm = out.people.filter((p) => p.stage === 'warm').map((p) => p.flag);
    const rank = { red: 0, amber: 1, '': 2 };
    expect(warm.slice().sort((a, b) => rank[a] - rank[b])).toEqual(warm);
  });

  it('cards carry status / last lines', () => {
    expect(byName(out, 'Dr Wakwanje Tizhe-Gami').status).toBe('Signed up 16 Nov, onboarding not finished');
    expect(byName(out, 'Dr Mercy Obanimoh').status).toBe('Registration: Visa');
    expect(byName(out, 'Dr Obvious Chikore').status).toBe('Started 1 Jun');
    expect(byName(out, 'Dr Parastou').last).toBe('You messaged 17 Oct');
    expect(byName(out, 'Dr Parastou').status).toBe('Only in your WhatsApp');
  });

  it('survives empty input', () => {
    const e = pipeline.buildPipelineBoard({ nowMs: NOW_MS });
    expect(e.ok).toBe(true);
    expect(e.people).toEqual([]);
    expect(e.money.connected).toBe(false);
    expect(e.counts.by_stage).toEqual({ warm: 0, consult: 0, matched: 0, signed: 0, visa: 0, started: 0 });
  });
});

// ── Route: real server + PostgREST emulator (from tests/ceo-overview.test.js) ─
let server, port, sbServer, sbPort, realFetch;
const clone = (x) => JSON.parse(JSON.stringify(x));
const db = {
  pipeline_people: clone(ROWS), pipeline_events: clone(EVENTS), gp_applications: clone(APPS), placements: clone(PLACEMENTS),
  registration_cases: clone(CASES), user_profiles: clone(PROFILES), career_contracts: clone(CONTRACTS), career_roles: clone(ROLES),
  scheduled_calls: clone(SCHED), doubletick_messages: [], xero_invoices: clone(INVOICES), email_contract_finds: clone(FINDS),
  pipeline_sync_state: [{ source: 'xero', last_ok_at: new Date().toISOString(), detail: {} }], runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function cmp(cell, val) {
  const a = Number(cell), b = Number(val);
  if (cell !== null && cell !== undefined && cell !== '' && Number.isFinite(a) && Number.isFinite(b) && String(cell).trim() !== '') return a - b;
  return String(cell) < val ? -1 : (String(cell) > val ? 1 : 0);
}
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') return val.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    if (cell === null || cell === undefined) return false;
    if (op === 'gte') return cmp(cell, val) >= 0;
    if (op === 'gt') return cmp(cell, val) > 0;
    if (op === 'lte') return cmp(cell, val) <= 0;
    if (op === 'lt') return cmp(cell, val) < 0;
    return true;
  });
}
function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const [col, dir] = String(orderParam).split('.');
  const sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => sign * cmp(a[col], String(b[col])));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = applyOrder(rows.filter(matches), u.searchParams.get('order'));
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(payload);
  });
}
const call = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ceo-pipeline-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.META_ADS_ACCOUNT_TIMEZONE = TZ;
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});
afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/ceo/pipeline (route)', () => {
  it('is gated behind the super-admin session', async () => {
    for (const [m, p] of [['GET', '/api/ceo/pipeline'], ['POST', '/api/ceo/pipeline/person'], ['POST', '/api/ceo/pipeline/whatsapp-import'], ['POST', '/api/ceo/pipeline/person/app-x/done'], ['POST', '/api/ceo/pipeline/email-find/gm-yan/dismiss']]) {
      const res = await callNoAuth(m, p, m === 'POST' ? {} : undefined);
      expect([401, 403], m + ' ' + p).toContain(res.status);
    }
  });

  it('builds the board from the emulated tables', async () => {
    const res = await call('GET', '/api/ceo/pipeline?tz=Europe/London');
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.ok).toBe(true);
    expect(b.tz).toBe('Europe/London');
    expect(typeof b.generated_in_ms).toBe('number');
    expect(b.stages).toHaveLength(6);
    expect(b.people.find((p) => p.name === 'Dr Sana Ahsan').stage).toBe('signed');
    expect(b.money.connected).toBe(true);
    expect(b.invoices.find((i) => i.number === 'INV-8516').state).toBe('overdue');
    expect(b.raw).toBeUndefined();
    expect(res.raw).not.toContain('[redacted-circular]');
  });
});

describe('POST /api/ceo/pipeline/person (route)', () => {
  it('adds a candidate by hand, then the board shows them', async () => {
    const res = await call('POST', '/api/ceo/pipeline/person', { name: '  Dr New   Person ', phone: '+44 7700 900999', stage: 'warm', next_step: 'Phone her', waiting_on_owner: true, heat_override: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = db.pipeline_people.find((r) => r.name === 'Dr New Person');
    expect(row).toMatchObject({ source: 'manual', stage: 'warm', phone: '+44 7700 900999', next_step: 'Phone her', waiting_on_owner: true, heat_override: 2 });
    expect(db.pipeline_events.some((e) => e.person_id === row.id && e.kind === 'note')).toBe(true);
    const board = await call('GET', '/api/ceo/pipeline');
    const p = board.body.people.find((x) => x.name === 'Dr New Person');
    expect(p.flag).toBe('red');
    expect(p.heat).toBe(2);
  });

  it('rejects a bad stage, heat, date, email or a missing name', async () => {
    expect((await call('POST', '/api/ceo/pipeline/person', { name: 'X', stage: 'hired' })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person', { name: 'X', heat_override: 5 })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person', { name: 'X', later_until: 'next week' })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person', { name: 'X', email: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person', { phone: '123' })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person', { id: 'not-a-uuid', name: 'X' })).status).toBe(400);
  });

  it('updates only the fields sent, trims long text, and logs a stage move', async () => {
    const res = await call('POST', '/api/ceo/pipeline/person', { id: R.gilmore, stage: 'later', later_until: '2027-01-15', later_reason: 'x'.repeat(400) });
    expect(res.status).toBe(200);
    const row = db.pipeline_people.find((r) => r.id === R.gilmore);
    expect(row.stage).toBe('later');
    expect(row.later_until).toBe('2027-01-15');
    expect(row.later_reason).toHaveLength(300);
    expect(row.name).toBe('Dr David Gilmore'); // untouched
    expect(row.last_message_from).toBe('me');
    expect(db.pipeline_events.some((e) => e.person_id === R.gilmore && e.kind === 'stage' && e.text === 'warm → later')).toBe(true);
    const board = await call('GET', '/api/ceo/pipeline');
    expect(board.body.later.some((l) => l.name === 'Dr David Gilmore')).toBe(true);
  });

  it('404s an unknown id', async () => {
    expect((await call('POST', '/api/ceo/pipeline/person', { id: '33333333-3333-4333-8333-333333333333', name: 'X' })).status).toBe(404);
  });
});

describe('POST /api/ceo/pipeline/person/:id/done (route)', () => {
  it('Done on an app doctor with no row creates the row (source app), logs the event and sets the next step', async () => {
    expect(db.pipeline_people.some((r) => r.user_id === U.innocent)).toBe(false);
    const res = await call('POST', '/api/ceo/pipeline/person/app-' + U.innocent + '/done', { next_step: 'Chase Thornton for a yes', stage: 'matched' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = db.pipeline_people.find((r) => r.user_id === U.innocent);
    expect(row).toMatchObject({ source: 'app', name: 'Dr Innocent Aghadinuno', next_step: 'Chase Thornton for a yes', stage: 'matched', waiting_on_owner: false });
    const ev = db.pipeline_events.find((e) => e.person_id === row.id && e.kind === 'done');
    expect(ev.text).toContain('next: Chase Thornton for a yes');
    expect(ev.created_by).toBe('super@gplink-test.local');
    // A second Done reuses the same row.
    const again = await call('POST', '/api/ceo/pipeline/person/app-' + U.innocent + '/done', {});
    expect(again.body.id).toBe(row.id);
    expect(db.pipeline_people.filter((r) => r.user_id === U.innocent)).toHaveLength(1);
    expect(row.next_step).toBeNull();
    const board = await call('GET', '/api/ceo/pipeline');
    const p = board.body.people.find((x) => x.user_id === U.innocent);
    expect(p.id).toBe(row.id);
    expect(p.flag).toBe(''); // the Done cleared the "not sent" amber
  });

  it('Done on a row clears waiting_on_owner and turns the card from red', async () => {
    const res = await call('POST', '/api/ceo/pipeline/person/' + R.tanManual + '/done', { next_step: 'Call Thu 7pm', note: 'Booked a call' });
    expect(res.status).toBe(200);
    const row = db.pipeline_people.find((r) => r.id === R.tanManual);
    expect(row.waiting_on_owner).toBe(false);
    expect(row.next_step).toBe('Call Thu 7pm');
    const board = await call('GET', '/api/ceo/pipeline');
    const tan = board.body.people.find((x) => x.name === 'Dr Tan Ke Ying');
    expect(tan.flag).toBe('');
    expect(tan.next).toBe('Call Thu 7pm');
  });

  it('validates the id and stage', async () => {
    expect((await call('POST', '/api/ceo/pipeline/person/app-nope/done', {})).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person/find-gm-yan/done', {})).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person/' + R.tanManual + '/done', { stage: 'hired' })).status).toBe(400);
    expect((await call('POST', '/api/ceo/pipeline/person/33333333-3333-4333-8333-333333333333/done', {})).status).toBe(404);
    expect((await call('POST', '/api/ceo/pipeline/person/app-33333333-3333-4333-8333-333333333333/done', {})).status).toBe(404);
  });
});

describe('POST /api/ceo/pipeline/whatsapp-import (route)', () => {
  const recent = (daysAgo, hhmm) => { const d = new Date(Date.now() - daysAgo * D + 8 * H); return d.toISOString().slice(0, 10) + ' ' + (hhmm || '10:00'); };
  const exportJson = () => ({
    exportedAt: 'Mon Nov 23 2026 21:46:44 GMT+0800 (Central Indonesia Time)', source: 'WhatsApp Business Web', chatCount: 4, messageCount: 6,
    chats: [
      { chat: 'Dr Hatice Akkas', id: '111@lid', isGroup: false, messageCount: 2, messages: [{ time: recent(2, '09:00'), from: 'Dr Hatice Akkas', type: 'chat', text: 'Hello' }, { time: recent(1, '10:00'), from: 'Me', type: 'chat', text: 'All good, replying now' }] },
      { chat: 'Dr Brand New', id: '555@lid', isGroup: false, messageCount: 1, messages: [{ time: recent(3), from: 'Dr Brand New', type: 'chat', text: 'Interested in GP roles' }] },
      { chat: 'Mount Hutton + Dr M', id: '120363@g.us', isGroup: false, messageCount: 1, messages: [{ time: recent(1), from: 'Someone', type: 'chat', text: 'Hi' }] },
      { chat: 'Dr Cold', id: '666@lid', isGroup: false, messageCount: 1, messages: [{ time: recent(90), from: 'Dr Cold', type: 'chat', text: 'Maybe next year' }] }
    ]
  });

  it('rejects a body that is not an export', async () => {
    const res = await call('POST', '/api/ceo/pipeline/whatsapp-import', { hello: 1 });
    expect(res.status).toBe(400);
  });

  it('updates only the message fields of an existing row, creates warm doctors who replied recently, skips the rest', async () => {
    const before = db.pipeline_people.find((r) => r.id === R.haticeWa);
    before.next_step = 'Owner note: send AHPRA update';
    before.last_message_at = new Date(Date.now() - 5 * D).toISOString();
    const res = await call('POST', '/api/ceo/pipeline/whatsapp-import', exportJson());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: 1, updated: 1, skipped: 2, offset_minutes: 480, exported_at: '2026-11-23T13:46:44.000Z' });
    const after = db.pipeline_people.find((r) => r.id === R.haticeWa);
    expect(after.last_message_from).toBe('me');
    expect(after.last_message_snippet).toBe('All good, replying now');
    expect(after.next_step).toBe('Owner note: send AHPRA update');
    expect(after.stage).toBe('warm');
    expect(after.name).toBe('Dr Hatice Akkas');
    const created = db.pipeline_people.find((r) => r.source_ref === '555@lid');
    expect(created).toMatchObject({ name: 'Dr Brand New', stage: 'warm', source: 'whatsapp_personal', last_message_from: 'them' });
    expect(db.pipeline_people.some((r) => r.source_ref === '666@lid')).toBe(false);
    expect(db.pipeline_people.some((r) => r.source_ref === '120363@g.us')).toBe(false);
    const sync = db.pipeline_sync_state.find((s) => s.source === 'whatsapp_export');
    expect(sync.detail.exportedAtIso).toBe('2026-11-23T13:46:44.000Z');
    expect(typeof sync.last_ok_at).toBe('string');
    // Importing the same file again changes nothing and keeps one sync row.
    const again = await call('POST', '/api/ceo/pipeline/whatsapp-import', exportJson());
    expect(again.body).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 2 });
    expect(db.pipeline_sync_state.filter((s) => s.source === 'whatsapp_export')).toHaveLength(1);
    const board = await call('GET', '/api/ceo/pipeline');
    expect(board.body.freshness.whatsapp_export.label).toBe('WhatsApp export ' + Math.round((Date.now() - Date.parse('2026-11-23T13:46:44.000Z')) / D) + ' days old' + ((Date.now() - Date.parse('2026-11-23T13:46:44.000Z')) > 3 * D ? ' — upload a new one' : ''));
  });
});

describe('POST /api/ceo/pipeline/email-find/:id/dismiss (route)', () => {
  it('dismisses the find and archives the row it proposed', async () => {
    const res = await call('POST', '/api/ceo/pipeline/email-find/gm-yan/dismiss', {});
    expect(res.status).toBe(200);
    expect(db.email_contract_finds.find((f) => f.gmail_message_id === 'gm-yan').status).toBe('dismissed');
    const row = db.pipeline_people.find((r) => r.id === R.yanFind);
    expect(typeof row.archived_at).toBe('string');
    expect(db.pipeline_events.some((e) => e.person_id === R.yanFind && e.kind === 'dismiss')).toBe(true);
    const board = await call('GET', '/api/ceo/pipeline');
    expect(board.body.people.some((p) => p.name === 'Dr Yan Naing Win')).toBe(false);
  });

  it('never archives a row the owner already confirmed', async () => {
    db.pipeline_people.push({ id: '22222222-2222-4222-8222-0000000000cc', name: 'Dr Confirmed', source: 'email_contract', stage: 'signed', needs_confirm: false, confirmed_at: new Date().toISOString() });
    db.email_contract_finds.push({ gmail_message_id: 'gm-conf', status: 'proposed', doctor_name: 'Dr Confirmed', pipeline_person_id: '22222222-2222-4222-8222-0000000000cc' });
    const res = await call('POST', '/api/ceo/pipeline/email-find/gm-conf/dismiss', {});
    expect(res.status).toBe(200);
    expect(db.pipeline_people.find((r) => r.id === '22222222-2222-4222-8222-0000000000cc').archived_at).toBeUndefined();
  });

  it('a doctor who was already on the board is never archived: only the confirm flag goes (and pre_find is restored)', async () => {
    const id = '22222222-2222-4222-8222-0000000000dd';
    db.pipeline_people.push({ id, name: 'Dr Was Warm', source: 'whatsapp_personal', source_ref: 'warm@lid', stage: 'signed', needs_confirm: true, next_step: 'Confirm contract', metadata: { gmail_message_id: 'gm-warm', pre_find: { stage: 'warm', next_step: 'Phone him' } } });
    db.email_contract_finds.push({ gmail_message_id: 'gm-warm', status: 'proposed', doctor_name: 'Dr Was Warm', pipeline_person_id: id });
    const res = await call('POST', '/api/ceo/pipeline/email-find/gm-warm/dismiss', {});
    expect(res.status).toBe(200);
    const row = db.pipeline_people.find((r) => r.id === id);
    expect(row.archived_at).toBeUndefined();
    expect(row).toMatchObject({ needs_confirm: false, stage: 'warm', next_step: 'Phone him' });
    expect(row.metadata.gmail_message_id).toBeUndefined();
    expect(row.metadata.dismissed_gmail_message_id).toBe('gm-warm');
    const board = await call('GET', '/api/ceo/pipeline');
    const p = board.body.people.find((x) => x.name === 'Dr Was Warm');
    expect(p.stage).toBe('warm');
    expect(p.find).toBeNull();
  });

  it('404s an unknown find and 400s a bad id', async () => {
    expect((await call('POST', '/api/ceo/pipeline/email-find/gm-nope/dismiss', {})).status).toBe(404);
    expect((await call('POST', '/api/ceo/pipeline/email-find/' + encodeURIComponent('a b') + '/dismiss', {})).status).toBe(400);
  });
});
