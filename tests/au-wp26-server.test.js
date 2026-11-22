// WP-26 (Australian GP build): the server side of the dashboard package, on the
// real server with the in-memory database stub. Both states of the switch.
//
//   A. A consultant completes the Australian tasks they own from the CEO
//      dashboard (W3-D22), and nothing else: not an RSO task, not an overseas
//      doctor's task; an RSO and a doctor cannot call the route at all.
//   B. Reference checks cannot be closed with no referees on file unless a
//      reason is recorded, on both routes.
//   C. The task list a consultant reads: owner, what to do, what they may do,
//      and week 4 / 8 / 12 in date order.
//   D. Staff see an Australian doctor as Australian: AU, one document count.
//   E. A consultant lands on the CEO dashboard; the Contracts tab says why.
//   F. The Australian guide: pages, the one-click seed, who may do what.
//   G. Small things: the call label, the document expiry, the segment title.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const prestart = require('../lib/au-prestart.js');
const staffTools = require('../lib/au-staff-tools.js');
const guide = require('../lib/au-guide-content.js');

const EMPTY_TABLES = ['task_timeline', 'gp_applications', 'placements', 'user_documents', 'admin_audit_log', 'candidate_leads',
  'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'password_setup_tokens', 'user_roles',
  'career_roles', 'scheduled_calls', 'support_tickets', 'practice_doc_ops', 'ats_offers', 'career_contracts', 'visa_applications',
  'pbs_applications', 'case_events', 'task_messages', 'task_documents', 'site_enquiries', 'au_gp_doctor_details', 'guide_folders', 'guide_items'];

let h;
let au, auB, uk;
const rows = (t) => h.emu.table(t);
const task = (id) => rows('registration_tasks').filter((x) => x.id === id)[0];
const audit = (action) => rows('admin_audit_log').filter((x) => x.action === action);
const NOW = '2026-11-22T00:00:00.000Z';

function early(type, d, id) {
  return Object.assign({ id, case_id: d.caseId, created_at: NOW, updated_at: NOW },
    prestart.buildEarlyTask(type, { name: d.name, applicationId: 'app-' + id, now: NOW }));
}
function pre(type, d, id, metaPatch) {
  const t = Object.assign({ id, case_id: d.caseId, created_at: NOW, updated_at: NOW },
    prestart.buildPrestartTask(type, { name: d.name, practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', now: NOW }));
  t.metadata = Object.assign({}, t.metadata, metaPatch || {});
  return t;
}
function checkin(d, id, mark, due) {
  return {
    id, case_id: d.caseId, task_type: 'guarantee_checkin', title: 'Week ' + mark.slice(1) + ' check-in: ' + d.name, status: 'open', priority: 'normal',
    due_date: due, related_stage: 'guarantee', created_at: NOW, updated_at: NOW,
    metadata: { au: true, owner: 'consultant', what_to_do: 'Speak to the doctor and the practice.', lifecycle_kind: 'guarantee_checkin', mark, placement_key: 'app-1' }
  };
}
const complete = (who, body) => h.post('/api/ats/candidate/task/complete', body, who);

beforeAll(async () => {
  au = buildAuDoctor('au_vr', { idSuffix: 'w1', caseRow: { stage: 'prestart' } });
  auB = buildAuDoctor('au_restricted', { idSuffix: 'w2' });
  uk = buildAuDoctor('overseas_null', { idSuffix: 'w3' });
  const tables = buildAuFixtureDb([au, auB, uk]);
  EMPTY_TABLES.forEach((t) => { if (!tables[t]) tables[t] = []; });
  tables.registration_tasks = [
    early('reference_check', au, 't-ref'),
    early('restraint_check', au, 't-restraint'),
    early('dpa_19ab_check', auB, 't-19ab'),
    pre('start_date_tracking', au, 't-start'),
    pre('provider_number_new_location', au, 't-provider'),
    pre('credentialing_pack', au, 't-cred'),
    checkin(au, 't-w12', 'w12', '2027-02-14'),
    checkin(au, 't-w4', 'w4', '2026-12-20'),
    checkin(au, 't-w8', 'w8', '2027-01-17'),
    { id: 't-invoice', case_id: au.caseId, task_type: 'invoice_due', title: 'Raise placement-fee invoice', status: 'open', priority: 'high', due_date: '2026-11-22', related_stage: 'commenced', created_at: NOW, metadata: { au: true, owner: 'ceo', what_to_do: 'Raise the invoice.', lifecycle_kind: 'invoice_due', placement_key: 'app-1' } },
    { id: 't-uk', case_id: uk.caseId, task_type: 'manual', title: 'Call the doctor', status: 'open', priority: 'normal', due_date: '2026-12-01', related_stage: 'myintealth', metadata: {}, created_at: NOW },
    // a task dressed up to look consultant-owned on an OVERSEAS doctor's case
    { id: 't-uk-fake', case_id: uk.caseId, task_type: 'reference_check', title: 'Reference checks', status: 'open', priority: 'normal', due_date: '2026-12-01', related_stage: 'myintealth', metadata: { au: true, owner: 'consultant', what_to_do: 'x' }, created_at: NOW }
  ];
  tables.scheduled_calls = [{ id: 'call-au', user_id: au.userId, case_id: au.caseId, stage: 'prestart', status: 'invited', meeting_kind: 'consultation', created_at: NOW, duration_minutes: 30 }];
  h = await bootAuTestServer({ name: 'wp26-server', tables });
  [au, auB, uk].forEach((d) => { d.cookie = h.gpCookie(d.email, d.userId); });
}, 60000);

afterAll(async () => { if (h) await h.close(); });

describe('A. a consultant completes the Australian tasks they own, and only those', () => {
  it('a guarantee check-in needs a note, then closes, is stamped and audited', async () => {
    const refused = await complete(h.consultant(), { task_id: 't-w4' });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('note_required');
    expect(task('t-w4').status).toBe('open');
    const ok = await complete(h.consultant(), { task_id: 't-w4', note: 'Doctor and practice both happy.' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, status: 'completed', already_completed: false });
    expect(task('t-w4')).toMatchObject({ status: 'completed', completed_by: h.CONSULTANT_EMAIL });
    expect(task('t-w4').metadata).toMatchObject({ completion_note: 'Doctor and practice both happy.', completed_via: 'ceo_dashboard', au: true, owner: 'consultant' });
    const logged = audit('admin_au_consultant_task_complete').filter((a) => String(a.target_id) === 't-w4');
    expect(logged.some((a) => a.success === true || a.success === undefined)).toBe(true);
    // pressing it again changes nothing
    const again = await complete(h.consultant(), { task_id: 't-w4', note: 'Second press.' });
    expect(again.json).toMatchObject({ ok: true, already_completed: true });
    expect(task('t-w4').metadata.completion_note).toBe('Doctor and practice both happy.');
  });

  it('the restraint check needs an outcome, and a note when a restraint applies', async () => {
    expect((await complete(h.consultant(), { task_id: 't-restraint', note: 'looked' })).json.code).toBe('outcome_required');
    expect((await complete(h.consultant(), { task_id: 't-restraint', outcome: 'made_up' })).json.code).toBe('outcome_required');
    expect((await complete(h.consultant(), { task_id: 't-restraint', outcome: 'restraint_applies' })).json.code).toBe('note_required');
    const ok = await complete(h.consultant(), { task_id: 't-restraint', outcome: 'no_restraint' });
    expect(ok.status).toBe(200);
    expect(task('t-restraint').metadata.restraint_outcome).toBe('no_restraint');
  });

  it('the 19AB check on a segment B doctor closes with a note (the CEO may do the same)', async () => {
    expect((await complete(h.superAdmin(), { task_id: 't-19ab' })).json.code).toBe('note_required');
    const ok = await complete(h.superAdmin(), { task_id: 't-19ab', note: 'Dubbo is in a DPA.' });
    expect(ok.status).toBe(200);
    expect(task('t-19ab').status).toBe('completed');
  });

  it('a task finished by its own action is refused with what to do instead', async () => {
    const start = await complete(h.consultant(), { task_id: 't-start', note: 'done it' });
    expect(start.status).toBe(409);
    expect(start.json).toMatchObject({ code: 'au_task_needs_its_action', action: 'start_date' });
    expect((await complete(h.consultant(), { task_id: 't-provider', note: 'done it' })).json.action).toBe('provider_number');
    expect((await complete(h.consultant(), { task_id: 't-invoice', note: 'done it' })).json.action).toBe('invoice');
    ['t-start', 't-provider', 't-invoice'].forEach((id) => expect(task(id).status, id).toBe('open'));
  });

  it('an RSO-owned Australian task is not a consultant\'s to close', async () => {
    const res = await complete(h.consultant(), { task_id: 't-cred', note: 'pack sent' });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('not_consultant_task');
    expect(task('t-cred').status).toBe('open');
  });

  it('an overseas doctor\'s task cannot be touched, whatever the task says about itself', async () => {
    for (const id of ['t-uk', 't-uk-fake']) {
      const res = await complete(h.consultant(), { task_id: id, note: 'trying', reason: 'trying to close it anyway' });
      expect(res.status, id).toBe(403);
      expect(res.json.code, id).toBe('not_au_pathway');
      expect(task(id).status, id).toBe('open');
    }
    expect(audit('admin_au_consultant_task_complete').some((a) => String(a.target_id) === 't-uk' && a.success === false)).toBe(true);
  });

  it('an RSO, a doctor and a signed-out visitor cannot call it; switch off it does not exist', async () => {
    expect((await complete(h.rso(), { task_id: 't-w8', note: 'as the RSO' })).status).toBe(403);
    expect([401, 403, 404]).toContain((await complete({ cookie: au.cookie }, { task_id: 't-w8', note: 'as the doctor' })).status);
    expect([401, 403, 404]).toContain((await complete({}, { task_id: 't-w8', note: 'nobody' })).status);
    expect(task('t-w8').status).toBe('open');
    h.setSwitch(false);
    const off = await complete(h.consultant(), { task_id: 't-w8', note: 'switch off' });
    h.setSwitch(true);
    expect(off.status).toBe(404);
    expect(task('t-w8').status).toBe('open');
    expect((await complete(h.consultant(), {})).status).toBe(400);
    expect((await complete(h.consultant(), { task_id: 'no-such-task' })).status).toBe(404);
  });
});

describe('B. reference checks need referees on file, or a recorded reason (W3-D22)', () => {
  it('the consultant route: refused with none, closed with a reason that is kept', async () => {
    const refused = await complete(h.consultant(), { task_id: 't-ref' });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'au_references_missing', referees_on_file: 0 });
    expect((await complete(h.consultant(), { task_id: 't-ref', reason: 'short' })).status).toBe(409);
    expect(task('t-ref').status).toBe('open');
    const ok = await complete(h.consultant(), { task_id: 't-ref', reason: 'Both referees were phoned on 20 Nov.' });
    expect(ok.status).toBe(200);
    expect(task('t-ref').metadata).toMatchObject({ no_referees_reason: 'Both referees were phoned on 20 Nov.', no_referees_reason_by: h.CONSULTANT_EMAIL });
  });

  it('the admin route has the same rule, and with two referees on file it simply closes', async () => {
    rows('registration_tasks').push(early('reference_check', auB, 't-ref-b'));
    const refused = await h.put('/api/admin/task?id=t-ref-b', { status: 'completed' }, h.superAdmin());
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('au_references_missing');
    expect(task('t-ref-b').status).toBe('open');
    rows('au_gp_doctor_details').push({ user_id: auB.userId, referees: [{ name: 'Dr Referee One (FAKE)' }, { name: 'Dr Referee Two (FAKE)' }], referees_submitted_at: NOW });
    const ok = await h.put('/api/admin/task?id=t-ref-b', { status: 'completed' }, h.superAdmin());
    expect(ok.status).toBe(200);
    expect(task('t-ref-b').status).toBe('completed');
    // an overseas doctor's ordinary task is completed exactly as before
    const overseas = await h.put('/api/admin/task?id=t-uk', { status: 'completed' }, h.superAdmin());
    expect(overseas.status).toBe(200);
    task('t-uk').status = 'open';
  });
});

describe('C. the task list a consultant reads', () => {
  it('says who owns each task, what to do and what this viewer may do; open first, in date order', async () => {
    const res = await h.get('/api/ats/candidate/tasks?case_id=' + au.caseId, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json.viewer_role).toBe('consultant');
    expect(res.json.read_only).toBe(false);
    const open = res.json.tasks.filter((t) => t.open);
    const dates = open.map((t) => t.due_date);
    expect(dates).toEqual(dates.slice().sort());
    const ids = open.map((t) => t.id);
    expect(ids.indexOf('t-w8')).toBeLessThan(ids.indexOf('t-w12'));
    const by = (id) => res.json.tasks.filter((t) => t.id === id)[0];
    expect(by('t-w8')).toMatchObject({ owner: 'consultant', can_complete: true, action: 'complete', completion: { needs: 'note' } });
    expect(by('t-start')).toMatchObject({ owner: 'consultant', owner_then: 'rso', can_complete: false, action: 'start_date' });
    expect(by('t-provider')).toMatchObject({ owner: 'rso', can_complete: false, action: 'provider_number' });
    expect(by('t-cred')).toMatchObject({ owner: 'rso', can_complete: false, action: 'complete' });
    expect(by('t-invoice')).toMatchObject({ owner: 'ceo', can_complete: false, action: 'invoice' });
    expect(by('t-w8').what_to_do).toBeTruthy();
    expect(res.json.restraint_outcomes.map((o) => o.value)).toEqual(['no_restraint', 'restraint_does_not_apply', 'restraint_applies']);
    expect(res.raw).not.toMatch(/description|attachment_url|document_html|email_body/);
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + au.caseId, h.superAdmin())).json.viewer_role).toBe('ceo');
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + uk.caseId, h.consultant())).status).toBe(403);
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + au.caseId, h.rso())).status).toBe(403);
  });
});

describe('D. staff see an Australian doctor as Australian', () => {
  it('the RSO page\'s list: AU, the Australian stage in words and ONE document count; an overseas row has no such key', async () => {
    rows('user_documents').push({ id: 'doc-1', user_id: au.userId, document_key: 'au_indemnity_certificate', country_code: 'au_reg', status: 'approved', storage_path: 'x/1', file_name: 'i.pdf' });
    rows('user_documents').push({ id: 'doc-2', user_id: au.userId, document_key: 'au_wwcc', country_code: 'au_reg', status: 'under_review', storage_path: 'x/2', file_name: 'w.pdf' });
    const res = await h.get('/api/admin/va/dashboard', h.superAdmin());
    const row = res.json.users.filter((u) => u.user_id === au.userId)[0];
    expect(row.country).toBe('AU');
    expect(row.au).toMatchObject({ pathway: 'au_vr', stage: 'prestart', stage_label: 'Pre-start', docs_have: 2, docs_approved: 1, docs_total: 8 });
    const ukRow = res.json.users.filter((u) => u.user_id === uk.userId)[0];
    expect(ukRow.country).toBe('GB');
    expect('au' in ukRow).toBe(false);
    // the Documents pane and the CEO drawer carry the same count
    const docs = await h.get('/api/admin/gp-documents?case_id=' + au.caseId + '&user_id=' + au.userId, h.superAdmin());
    expect(docs.json.docCount).toEqual({ have: 2, approved: 1, total: 8 });
    expect(docs.json.preparedByCandidate.filter((d) => d.key === 'au_wwcc')[0].expiry_tracked).toBe(true);
    const drawer = await h.get('/api/ceo/candidate?case_id=' + au.caseId, h.consultant());
    expect(drawer.json.candidate.au.drawer.doc_count).toEqual({ have: 2, approved: 1, total: 8 });
    expect((await h.get('/api/admin/gp-documents?case_id=' + uk.caseId + '&user_id=' + uk.userId, h.superAdmin())).json.docCount).toBeUndefined();
  });

  it('the CEO drawer: the Ahpra number, the stage, consent per application; nothing of the kind for an overseas doctor', async () => {
    rows('gp_applications').push({ id: 'app-w1', user_id: au.userId, career_role_id: 'role-1', status: 'applied', ats_stage: 'applied', applied_at: NOW,
      profile_share_consent_at: NOW, profile_share_consent_version: 'v1', profile_share_consent_source: 'staff_verbal', profile_share_consent_role_id: 'role-1', profile_share_consent_by: h.CONSULTANT_EMAIL });
    rows('gp_applications').push({ id: 'app-w1b', user_id: au.userId, career_role_id: 'role-2', status: 'applied', ats_stage: 'applied', applied_at: NOW });
    const res = await h.get('/api/ceo/candidate?case_id=' + au.caseId, h.consultant());
    const block = res.json.candidate.au;
    expect(block.stage).toBe('prestart');
    expect(block.drawer.reg_number).toBe(au.credentials.ahpra_number);
    expect(block.drawer.app_consent['app-w1']).toMatchObject({ on_file: true, source: 'staff_verbal' });
    expect(block.drawer.app_consent['app-w1b']).toMatchObject({ on_file: false });
    const overseas = await h.get('/api/ceo/candidate?case_id=' + uk.caseId, h.consultant());
    expect(overseas.json.candidate.au.drawer).toBeUndefined();
    expect(overseas.json.candidate.au.stage).toBeUndefined();
  });

  it('the candidate list: the Australian stage filter finds Australian doctors only', async () => {
    const all = await h.get('/api/ceo/candidates', h.consultant());
    const row = all.json.candidates.filter((r) => r.user_id === au.userId)[0];
    expect(row.au.country).toBe('AU');
    const pre2 = await h.get('/api/ceo/candidates?stage=au:prestart', h.consultant());
    expect(pre2.json.candidates.map((r) => r.user_id)).toEqual([au.userId]);
    const placement = await h.get('/api/ceo/candidates?stage=au:placement', h.consultant());
    expect(placement.json.candidates.map((r) => r.user_id)).toEqual([auB.userId]);
    // an overseas stage still filters exactly as it did
    const my = await h.get('/api/ceo/candidates?stage=myintealth', h.consultant());
    expect(my.json.candidates.map((r) => r.user_id)).toEqual([uk.userId]);
    h.setSwitch(false);
    const off = await h.get('/api/ceo/candidates?stage=au:prestart', h.consultant());
    h.setSwitch(true);
    expect(off.json.candidates).toEqual([]);
  });
});

describe('E. where a consultant lands, and the Contracts tab', () => {
  it('a consultant is sent to the CEO dashboard with the switch on, and to the admin page with it off; everyone else is unchanged', async () => {
    const session = (who) => h.get('/api/admin/auth/session', who);
    expect((await session(h.consultant())).json.redirectTo).toBe('/pages/ceo-dashboard');
    expect((await session(h.superAdmin())).json.redirectTo).toBe('/pages/admin');
    expect((await session(h.rso())).json.redirectTo).toBe('/pages/admin');
    h.setSwitch(false);
    const off = await session(h.consultant());
    const offCeo = await session(h.superAdmin());
    h.setSwitch(true);
    expect(off.json.redirectTo).toBe('/pages/admin');
    expect(offCeo.json.redirectTo).toBe('/pages/admin');
    expect(h.testUtils.adminLandingPathForRole ? h.testUtils.adminLandingPathForRole('consultant') : '/pages/ceo-dashboard').toBe('/pages/ceo-dashboard');
  });

  it('contracts stay the CEO\'s: a consultant gets 403 either way, with a plain sentence when the switch is on', async () => {
    const on = await h.get('/api/ceo/contracts', h.consultant());
    expect(on.status).toBe(403);
    expect(on.json.code).toBe('ceo_only');
    expect(on.json.message).toMatch(/reviewed and released by the CEO/);
    h.setSwitch(false);
    const off = await h.get('/api/ceo/contracts', h.consultant());
    h.setSwitch(true);
    expect(off.status).toBe(403);
    expect(off.json.code).toBeUndefined();
    expect((await h.get('/api/ceo/contracts', h.superAdmin())).status).toBe(200);
  });
});

describe('F. the Australian guide', () => {
  it('the pages are served to staff only, and not at all with the switch off', async () => {
    const page = await h.get(guide.pathFor('prestart'), h.rso());
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toMatch(/text\/html/);
    expect(page.raw).toContain('Pre-start tasks');
    expect(page.raw).not.toMatch(/<script/i);
    expect((await h.get(guide.pathFor('overview'), h.consultant())).status).toBe(200);
    expect([401, 403, 404]).toContain((await h.get(guide.pathFor('overview'), { cookie: au.cookie })).status);
    expect((await h.get(guide.PATH_PREFIX + 'no-such-page', h.superAdmin())).status).toBe(404);
    expect((await h.get(guide.PATH_PREFIX + '..%2Fsecret', h.superAdmin())).status).toBe(404);
    h.setSwitch(false);
    const off = await h.get(guide.pathFor('prestart'), h.superAdmin());
    h.setSwitch(true);
    expect(off.status).toBe(404);
  });

  it('the CEO adds it with one press, once; nobody else can', async () => {
    expect((await h.post('/api/admin/guide/seed-au', {}, h.rso())).status).toBe(403);
    expect((await h.post('/api/admin/guide/seed-au', {}, h.consultant())).status).toBe(403);
    expect(rows('guide_folders').length).toBe(0);
    const before = await h.get('/api/admin/guide/folders', h.superAdmin());
    expect(before.json.au_guide).toMatchObject({ available: true, seeded: false });
    const first = await h.post('/api/admin/guide/seed-au', {}, h.superAdmin());
    expect(first.json).toMatchObject({ ok: true, folder_created: true, items_added: guide.TOPICS.length });
    const second = await h.post('/api/admin/guide/seed-au', {}, h.superAdmin());
    expect(second.json).toMatchObject({ ok: true, folder_created: false, items_added: 0 });
    expect(rows('guide_folders').filter((f) => f.name === guide.FOLDER_NAME).length).toBe(1);
    expect(rows('guide_items').length).toBe(guide.TOPICS.length);
    rows('guide_items').forEach((i) => expect(guide.isGuidePath(i.scribe_url), i.scribe_url).toBe(true));
    const after = await h.get('/api/admin/guide/folders', h.rso());
    expect(after.json.au_guide.seeded).toBe(true);
    expect(after.json.folders[0].items.length).toBe(guide.TOPICS.length);
    expect(audit('admin_au_guide_seeded').length).toBe(2);
    h.setSwitch(false);
    const off = await h.get('/api/admin/guide/folders', h.superAdmin());
    const offSeed = await h.post('/api/admin/guide/seed-au', {}, h.superAdmin());
    h.setSwitch(true);
    expect(Object.keys(off.json).sort()).toEqual(['folders', 'ok']);
    expect(offSeed.status).toBe(404);
  });

  it('every page renders, escapes its text and names the fifteen steps', () => {
    guide.TOPICS.forEach((t) => {
      const html = guide.renderPage(t.key);
      expect(html, t.key).toContain('<h1>');
      expect(html, t.key).not.toMatch(/<script|onerror=|javascript:/i);
    });
    expect(guide.topic('overview').sections[1].list.length).toBe(15);
    expect(guide.renderPage('nope')).toBe(null);
    expect(guide.isGuidePath('/api/admin/guide/au/prestart')).toBe(true);
    expect(guide.isGuidePath('https://evil.example/api/admin/guide/au/prestart')).toBe(false);
    expect(guide.isGuidePath('/api/admin/guide/au/../x')).toBe(false);
  });
});

describe('G. small things', () => {
  it('the doctor\'s "confirm your call" page names an Australian call by its doctor-facing name, never the raw key', async () => {
    const res = await h.get('/api/gp/assistance-call', { cookie: au.cookie });
    expect(res.json.call.stage).toBe('prestart');
    expect(res.json.call.stageLabel).toBe('Pre-start checks');
    expect(res.json.call.stageLabel).not.toMatch(/PRESTART|prestart/);
  });

  it('staff set a document\'s expiry: only a dated document of this doctor\'s set that is on file', async () => {
    const post = (who, body) => h.post('/api/admin/au/prestart/document-expiry', Object.assign({ case_id: au.caseId }, body), who);
    expect((await post(h.consultant(), { key: 'au_right_to_work', expires_at: '2028-01-01' })).json.code).toBe('not_expiry_tracked');
    expect((await post(h.consultant(), { key: 'au_wwcc', expires_at: 'soon' })).json.code).toBe('invalid_date');
    expect((await post(h.consultant(), { key: 'au_ahpra_certificate', expires_at: '2028-01-01' })).status).toBe(404);
    const ok = await post(h.consultant(), { key: 'au_wwcc', expires_at: '2029-06-30' });
    expect(ok.status).toBe(200);
    // stored the way the doctor's own expiry route stores it
    expect(String(rows('user_documents').filter((d) => d.id === 'doc-2')[0].expires_at).slice(0, 10)).toBe('2029-06-30');
    expect(audit('admin_au_document_expiry_set').length).toBeGreaterThan(0);
    expect((await h.post('/api/admin/au/prestart/document-expiry', { case_id: uk.caseId, key: 'au_wwcc', expires_at: '2029-06-30' }, h.consultant())).status).toBe(409);
    expect([401, 403]).toContain((await post({ cookie: au.cookie }, { key: 'au_wwcc', expires_at: '2029-06-30' })).status);
  });

  it('the segment task does not say "Ahpra check" when no check exists yet (D25)', () => {
    const after = staffTools.buildSegmentReviewTask({ name: 'Dr Test Aures', derivation: { segment: 'B', pathway: 'au_restricted' } });
    expect(after.title).toBe('Decide the segment for Dr Test Aures (Ahpra check: segment B)');
    const before = staffTools.buildSegmentReviewTask({ name: 'Dr Test Aures', derivation: { segment: 'B', pathway: 'au_restricted' }, beforeCheck: true });
    expect(before.title).not.toMatch(/Ahpra check:/);
    expect(before.title).toMatch(/not yet checked on the Ahpra register/);
    expect(before.description).toMatch(/own answers/);
  });

  it('the task-type list offers the Australian document keys, with staff labels', async () => {
    const res = await h.get('/api/admin/au/task-types', h.superAdmin());
    expect(res.json.document_keys.map((d) => d.key)).toContain('au_indemnity_certificate');
    res.json.document_keys.forEach((d) => expect(d.label, d.key).not.toMatch(/^au_/));
  });
});
