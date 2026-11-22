// WP-26 (Australian GP build): the staff endpoints WP-26 touched answer an
// OVERSEAS doctor exactly as they did before the package, with the switch on
// (nothing recorded, and an explicitly overseas pathway) and with it off.
//
// tests/fixtures/au-wp26-server-overseas-parity.snapshot.json was written by
// this file BEFORE server.js was changed (WP26_WRITE_SNAPSHOT=1). Never
// regenerate it to make the test pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const fs = require('fs');
const path = require('path');
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp26-server-overseas-parity.snapshot.json');
const EMPTY_TABLES = ['task_timeline', 'gp_applications', 'placements', 'user_documents', 'admin_audit_log', 'candidate_leads',
  'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'password_setup_tokens', 'user_roles',
  'career_roles', 'scheduled_calls', 'support_tickets', 'practice_doc_ops', 'ats_offers', 'career_contracts', 'visa_applications',
  'pbs_applications', 'case_events', 'task_messages', 'task_documents', 'site_enquiries'];

let h;
const doctors = {};

// Values that move with the clock or the run are replaced by their kind.
function normalise(value, key) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((k) => { out[k] = normalise(value[k], k); });
    return out;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return '<timestamp>';
  if (typeof value === 'number' && /^(days_in_stage|days|age_days|blocked_days|days_on_books|generated_ms|ms)$/.test(String(key))) return '<n>';
  return value;
}

function taskFor(d, id) {
  return {
    id, case_id: d.caseId, title: 'Call the doctor', description: 'A manual task', task_type: 'manual', status: 'open', priority: 'normal',
    due_date: '2026-12-01', related_stage: 'myintealth', metadata: {}, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z'
  };
}

async function capture(d, taskId) {
  const sa = h.superAdmin();
  const co = h.consultant();
  const out = {};
  const pick = (list, test) => (Array.isArray(list) ? list.filter(test) : []);
  const va = await h.get('/api/admin/va/dashboard', sa);
  out.vaDashboardUser = { status: va.status, users: pick(va.json && va.json.users, (u) => u.user_id === d.userId) };
  const list = await h.get('/api/ceo/candidates?q=&stage=&band=&account_status=&sort=intent&ats_bucket=', sa);
  out.ceoCandidates = {
    status: list.status,
    keys: Object.keys(list.json || {}).filter((k) => k !== 'candidates' && k !== 'total').sort(),
    rows: pick(list.json && list.json.candidates, (r) => r.user_id === d.userId).map((r) => { const c = Object.assign({}, r); delete c.au; return c; }),
    rowKeys: pick(list.json && list.json.candidates, (r) => r.user_id === d.userId).map((r) => Object.keys(r).sort())
  };
  const one = await h.get('/api/ceo/candidate?case_id=' + encodeURIComponent(d.caseId), co);
  const cand = one.json && one.json.candidate ? Object.assign({}, one.json.candidate) : null;
  out.ceoCandidate = { status: one.status, keys: cand ? Object.keys(cand).sort() : [], candidate: (() => { if (cand) delete cand.au; return cand; })() };
  const docs = await h.get('/api/admin/gp-documents?case_id=' + encodeURIComponent(d.caseId) + '&user_id=' + encodeURIComponent(d.userId), sa);
  out.gpDocuments = { status: docs.status, body: docs.json };
  const mtg = await h.get('/api/ceo/meetings?kind=all', sa);
  out.meetings = { status: mtg.status, body: mtg.json };
  const call = await h.get('/api/gp/assistance-call', { cookie: d.cookie });
  out.assistanceCall = { status: call.status, body: call.json };
  const tasks = await h.get('/api/ats/candidate/tasks?case_id=' + encodeURIComponent(d.caseId), co);
  out.atsTasks = { status: tasks.status, code: tasks.json && tasks.json.code };
  const ops = await h.get('/api/admin/ops/queue', sa);
  out.opsQueue = { status: ops.status, tasks: pick(ops.json && ops.json.tasks, (t) => t.id === taskId) };
  const tpl = await h.get('/api/admin/email-templates?case_id=' + encodeURIComponent(d.caseId), sa);
  out.emailTemplates = { status: tpl.status, audience: tpl.json && tpl.json.audience, keys: ((tpl.json && tpl.json.templates) || []).map((x) => x.key || x.id || x.name).sort() };
  const done = await h.put('/api/admin/task?id=' + encodeURIComponent(taskId), { status: 'completed' }, sa);
  out.completeTask = { status: done.status, ok: done.json && done.json.ok, taskStatus: done.json && done.json.task && done.json.task.status };
  return normalise(out);
}

beforeAll(async () => {
  doctors.nullOn = buildAuDoctor('overseas_null', { idSuffix: 'p1' });
  doctors.explicitOn = buildAuDoctor('overseas_explicit', { idSuffix: 'p2' });
  doctors.off = buildAuDoctor('overseas_null', { idSuffix: 'p3' });
  const all = [doctors.nullOn, doctors.explicitOn, doctors.off];
  const tables = buildAuFixtureDb(all);
  EMPTY_TABLES.forEach((t) => { if (!tables[t]) tables[t] = []; });
  tables.registration_tasks = [taskFor(doctors.nullOn, 'task-p1'), taskFor(doctors.explicitOn, 'task-p2'), taskFor(doctors.off, 'task-p3')];
  tables.scheduled_calls = all.map((d, i) => ({
    id: 'call-p' + (i + 1), user_id: d.userId, case_id: d.caseId, stage: 'amc', status: 'invited', meeting_kind: 'consultation',
    calendly_booking_url: 'https://calendly.example/x', created_at: '2026-11-01T00:00:00Z', duration_minutes: 30
  }));
  h = await bootAuTestServer({ name: 'wp26-parity', tables });
  all.forEach((d) => { d.cookie = h.gpCookie(d.email, d.userId); });
}, 60000);

afterAll(async () => { if (h) await h.close(); });

describe('WP-26: an overseas doctor on the staff endpoints, before and after', () => {
  it('answers exactly what it answered before the package (switch on: nothing recorded; switch on: overseas recorded; switch off)', async () => {
    const got = {};
    h.setSwitch(true);
    got.nullOn = await capture(doctors.nullOn, 'task-p1');
    got.explicitOn = await capture(doctors.explicitOn, 'task-p2');
    h.setSwitch(false);
    got.off = await capture(doctors.off, 'task-p3');
    h.setSwitch(true);
    // Ids differ per doctor by suffix only: fold them so the three compare.
    const fold = (o, n) => JSON.parse(JSON.stringify(o).split('p' + n).join('pX'));
    const folded = { nullOn: fold(got.nullOn, 1), explicitOn: fold(got.explicitOn, 2), off: fold(got.off, 3) };
    if (process.env.WP26_WRITE_SNAPSHOT === '1') {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(folded, null, 1) + '\n');
    }
    const want = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    expect(folded.off).toEqual(want.off);
    expect(folded.nullOn).toEqual(want.nullOn);
    expect(folded.explicitOn).toEqual(want.explicitOn);
    // every endpoint was really reached
    ['vaDashboardUser', 'ceoCandidates', 'ceoCandidate', 'gpDocuments', 'meetings', 'assistanceCall', 'opsQueue', 'completeTask'].forEach((k) => {
      expect(folded.off[k].status, k).toBe(200);
    });
    expect(folded.off.vaDashboardUser.users.length).toBe(1);
    expect(folded.off.ceoCandidates.rows.length).toBe(1);
  }, 60000);
});
