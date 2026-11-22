// WP-12 (GP app after placement): the server, against the in-memory database.
//   GET /api/gp/au-prestart and the doctor's three POSTs
//   the provider number's home (ADM-21) and the WP-11 task it closes
//   the Medicare step opening on placement (APP-11), overseas unchanged
//   which page an address serves (Home, provider number, pre-start)
//   Account details (APP-26) and "View as GP" writing nothing (ADM-27)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const requireCjs = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_NAME, START_DATE } = requireCjs('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = requireCjs('./helpers/au-fixtures.js');
const words = requireCjs('./helpers/au-banned-words.js');

let rig;
// `placed`: our team has checked this doctor on the register (staff_verified_at), as they will have been before a placement.
const placed = buildAuDoctor('au_vr', { credentials: { staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'consultant.test@gplink-test.local' } });
const unplaced = buildAuDoctor('au_vr', { idSuffix: '2', selfDeclared: true });
const held = buildAuDoctor('au_restricted');
const overseas = buildAuDoctor('overseas_null');
const as = (d) => ({ cookie: rig.gpCookie(d.email, d.userId) });
// A staff "View as GP" session: the doctor's session, stamped with who is previewing.
function previewAs(d) {
  const payload = Buffer.from(JSON.stringify({ userProfile: { email: d.email, supabaseUserId: d.userId, _impersonatedBy: rig.SUPER_EMAIL }, expiresAt: Date.now() + 3600000 }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return { cookie: 'gp_session=' + encodeURIComponent(payload + '.' + sig) };
}
const rowsOf = (table, d) => rig.table(table).filter((r) => r.user_id === d.userId);
const tasksOf = (d, type) => rig.table('registration_tasks').filter((t) => t.case_id === d.caseId && (!type || t.task_type === type));
const meta = (t) => (typeof t.metadata === 'string' ? JSON.parse(t.metadata) : (t.metadata || {}));
const timelineOf = (d) => rig.table('task_timeline').filter((e) => e.case_id === d.caseId).map((e) => e.title);
const goodReferees = [
  { name: 'Dr Test Referee One (FAKE)', role: 'Practice principal', relationship: 'My supervisor', phone: '0491 570 157', agreedToContact: true, atCurrentPractice: true },
  { name: 'Dr Test Referee Two (FAKE)', role: 'GP colleague', relationship: 'Worked alongside me', email: 'referee.two@gplink-test.local', agreedToContact: true, atCurrentPractice: false }
];
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  rig = await bootPlacementRig({ name: 'wp12', doctors: [placed, unplaced, held, overseas] });
  rig.setSwitch(true);
  const res = await rig.place(placed, 'ats_placement');
  expect(res.status).toBe(200);
  await rig.settle(120);
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });

describe('GET /api/gp/au-prestart', () => {
  it('does not exist for an overseas doctor, or for anyone with the switch off', async () => {
    const a = await rig.get('/api/gp/au-prestart', as(overseas));
    expect(a.status).toBe(404);
    rig.setSwitch(false);
    try {
      for (const d of [placed, overseas]) {
        expect((await rig.get('/api/gp/au-prestart', as(d))).status).toBe(404);
        expect((await rig.get('/api/account/au-details', as(d))).status).toBe(404);
        for (const u of ['/api/gp/au-prestart/notice', '/api/gp/au-prestart/referees', '/api/gp/au-prestart/provider-details', '/api/account/au-details']) {
          expect((await rig.post(u, { given: true, date: today() }, as(d))).status, u).toBe(404);
        }
      }
    } finally { rig.setSwitch(true); }
    expect((await rig.get('/api/gp/au-prestart', {})).status).toBe(401);
  });

  it('before a placement: the first step is current, nothing to do yet', async () => {
    const res = await rig.get('/api/gp/au-prestart', as(unplaced));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, placed: false, stage: 'placement', launched: true, teamLabel: 'your GP Link consultant', entryRoute: '/pages/career', items: [], complete: false });
    expect(res.json.steps.map((s) => s.state)).toEqual(['current', 'locked', 'locked', 'locked']);
    const h = await rig.get('/api/gp/au-prestart', as(held));
    expect(h.json).toMatchObject({ placed: false, launched: false });
  });

  it('after a placement: the checklist is composed from the real tasks, documents and credentials', async () => {
    const res = await rig.get('/api/gp/au-prestart', as(placed));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, placed: true, stage: 'prestart', stageLabel: 'Pre-start checks', teamLabel: 'your GP Link team', entryRoute: '/pages/prestart', practiceName: PRACTICE_NAME, startDate: START_DATE });
    expect(res.json.steps.map((s) => [s.key, s.state])).toEqual([['placement', 'done'], ['prestart', 'current'], ['provider_number', 'open'], ['start', 'open']]);
    const keys = res.json.items.map((i) => i.key);
    expect(keys.slice(0, 7)).toEqual(['register_check', 'notice', 'start_date', 'indemnity', 'provider_number', 'referees', 'credentialing']);
    expect(keys).toEqual(expect.arrayContaining(['doc_au_ahpra_certificate', 'doc_au_fellowship_certificate', 'doc_au_right_to_work', 'doc_au_wwcc']));
    const by = Object.fromEntries(res.json.items.map((i) => [i.key, i]));
    expect(by.register_check.status).toBe('done');            // the fixture doctor is staff-verified with no check task open
    expect(by.notice.status).toBe('todo');
    expect(by.indemnity).toMatchObject({ status: 'todo', documentKey: 'au_indemnity_certificate' });
    expect(by.provider_number).toMatchObject({ status: 'todo', title: 'Medicare provider number for ' + PRACTICE_NAME });
    expect(res.json.providerNumber).toEqual({ recorded: false, number: '', locationName: PRACTICE_NAME });
    expect(res.json.providerStep).toMatchObject({ variant: 'provider_number_new_location', providerNumberOnly: true });
    // CHANGED by FB-2a (W3-D21): the count is the required set (the four
    // pre-start tasks and the four other required documents), not every card,
    // and it is the same count staff are shown for this case.
    expect(res.json.counts.total).toBe(res.json.items.filter((i) => i.required).length);
    expect(res.json.counts.total).toBe(8);
    const staffSide = await rig.get('/api/admin/au/prestart?case_id=' + encodeURIComponent(placed.caseId), rig.superAdmin());
    expect(staffSide.json.prestart_counts).toEqual(res.json.counts);
    expect(staffSide.json.prestart_complete).toBe(res.json.complete);
    // the pre-start tasks really exist behind it
    ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location'].forEach((t) => expect(tasksOf(placed, t)).toHaveLength(1));
  });

  it('never sends a staff field, a private key or a banned word; and it is a read (nothing is written)', async () => {
    const before = rig.emu.requests.length;
    const res = await rig.get('/api/gp/au-prestart', as(placed));
    const writes = rig.emu.requests.slice(before).filter((r) => r.method !== 'GET');
    expect(writes).toEqual([]);
    expect(res.raw).not.toMatch(/what_to_do|done_when|staffLabel|"_caseId"|"_placementKey"|owner_then|placing_consultant|staff_verified/);
    const staffLines = tasksOf(placed).map((t) => meta(t).what_to_do).filter(Boolean);
    expect(staffLines.length).toBeGreaterThan(2);
    staffLines.forEach((line) => expect(res.raw).not.toContain(line.slice(0, 40)));
    tasksOf(placed).forEach((t) => expect(res.raw).not.toContain(t.title));
    expect(words.bannedLines(words.allStrings(res.json))).toEqual([]);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('the doctor\'s own actions on the pre-start page', () => {
  it('are refused until a placement is recorded', async () => {
    for (const [u, body] of [['/api/gp/au-prestart/notice', { given: true, date: today() }], ['/api/gp/au-prestart/referees', { referees: goodReferees }], ['/api/gp/au-prestart/provider-details', { prescriberNumber: '1234567' }]]) {
      const res = await rig.post(u, body, as(unplaced));
      expect(res.status, u).toBe(409);
      expect(res.json.code).toBe('no_placement');
    }
    expect(rowsOf('au_gp_doctor_details', unplaced)).toEqual([]);
    expect((await rig.post('/api/gp/au-prestart/notice', { given: true, date: today() }, as(overseas))).status).toBe(404);
  });

  it('notice given: validated, stored against this placement, and staff can see it', async () => {
    expect((await rig.post('/api/gp/au-prestart/notice', { given: false, date: today() }, as(placed))).status).toBe(400);
    expect((await rig.post('/api/gp/au-prestart/notice', { given: true, date: '2099-01-01' }, as(placed))).json.errors.date).toMatch(/future/);
    expect(rowsOf('au_gp_doctor_details', placed)).toEqual([]);
    // a body that also tries to set things that are not the doctor's to set
    const res = await rig.post('/api/gp/au-prestart/notice', { given: true, date: today(), staff_verified_at: '2026-01-01', candidate_pathway: 'overseas_esp', notice_placement_key: 'someone-else', provider_number: '999999ZZ' }, as(placed));
    expect(res.status).toBe(200);
    expect(res.json.saved).toBe(true);
    expect(res.json.items.find((i) => i.key === 'notice')).toMatchObject({ status: 'done', noticeGivenDate: today() });
    const row = rowsOf('au_gp_doctor_details', placed)[0];
    expect(row).toMatchObject({ notice_given: true, notice_given_date: today(), notice_placement_key: rig.appIdFor(placed) });
    expect(Object.keys(row).filter((k) => k !== 'id' && k !== 'created_at').sort()).toEqual(['notice_given', 'notice_given_date', 'notice_placement_key', 'notice_recorded_at', 'updated_at', 'user_id']);
    expect(rig.table('user_profiles').find((p) => p.user_id === placed.userId).candidate_pathway).toBe('au_vr');
    expect(timelineOf(placed)).toContain('Doctor recorded: notice given to current practice');
  });

  it('referees: two, each agreed and each marked as at the current practice or not', async () => {
    const bad = await rig.post('/api/gp/au-prestart/referees', { referees: [goodReferees[0], Object.assign({}, goodReferees[1], { agreedToContact: false })] }, as(placed));
    expect(bad.status).toBe(400);
    expect(bad.json.errors.referee2_agreed).toBeTruthy();
    expect((await rig.post('/api/gp/au-prestart/referees', { referees: [goodReferees[0]] }, as(placed))).status).toBe(400);
    expect(rowsOf('au_gp_doctor_details', placed)[0].referees).toBeUndefined();
    const res = await rig.post('/api/gp/au-prestart/referees', { referees: goodReferees }, as(placed));
    expect(res.status).toBe(200);
    expect(res.json.items.find((i) => i.key === 'referees')).toMatchObject({ status: 'waiting', whoLabel: 'GP Link' });
    expect(rowsOf('au_gp_doctor_details', placed)[0].referees).toEqual([
      { name: 'Dr Test Referee One (FAKE)', role: 'Practice principal', relationship: 'My supervisor', phone: '0491570157', email: '', agreed_to_contact: true, at_current_practice: true },
      { name: 'Dr Test Referee Two (FAKE)', role: 'GP colleague', relationship: 'Worked alongside me', phone: '', email: 'referee.two@gplink-test.local', agreed_to_contact: true, at_current_practice: false }
    ]);
    expect(timelineOf(placed)).toContain('Doctor gave two referees');
    const staff = await rig.get('/api/admin/au/prestart?case_id=' + placed.caseId, rig.superAdmin());
    expect(staff.json.doctor_details).toMatchObject({ noticeGiven: true, noticeGivenDate: today() });
    expect(staff.json.doctor_details.referees.map((r) => [r.name, r.atCurrentPractice])).toEqual([['Dr Test Referee One (FAKE)', true], ['Dr Test Referee Two (FAKE)', false]]);
  });

  it('the numbers the doctor already holds are kept; a wrong one is refused and nothing is saved', async () => {
    const bad = await rig.post('/api/gp/au-prestart/provider-details', { existingProviderNumbers: [{ number: 'hello' }], prescriberNumber: '1234567' }, as(placed));
    expect(bad.status).toBe(400);
    expect(rowsOf('au_gp_doctor_details', placed)[0].prescriber_number).toBeUndefined();
    expect((await rig.post('/api/gp/au-prestart/provider-details', {}, as(placed))).status).toBe(400);
    const res = await rig.post('/api/gp/au-prestart/provider-details', { existingProviderNumbers: [{ number: '234567 1a', location: 'Test Current Practice (FAKE)' }], prescriberNumber: '1234567' }, as(placed));
    expect(res.status).toBe(200);
    expect(res.json.details).toMatchObject({ existingProviderNumbers: [{ number: '2345671A', location: 'Test Current Practice (FAKE)' }], prescriberNumber: '1234567' });
    // the new location's number has not been touched, and the staff task is still open
    expect(res.json.providerNumber.recorded).toBe(false);
    expect(tasksOf(placed, 'provider_number_new_location')[0].status).toBe('open');
    expect(rowsOf('pbs_applications', placed)).toEqual([]);
  });
});

describe('ADM-21: the provider number for the new location', () => {
  it('entered by the doctor: stored on their pbs_applications row with the location, and the WP-11 task closes', async () => {
    const bad = await rig.post('/api/gp/au-prestart/provider-details', { newLocationProviderNumber: 'hello' }, as(placed));
    expect(bad.status).toBe(400);
    expect(bad.json.errors.newLocationProviderNumber).toBeTruthy();
    const res = await rig.post('/api/gp/au-prestart/provider-details', { newLocationProviderNumber: '345678 2b' }, as(placed));
    expect(res.status).toBe(200);
    expect(res.json.providerNumber).toEqual({ recorded: true, number: '3456782B', locationName: PRACTICE_NAME });
    expect(res.json.items.find((i) => i.key === 'provider_number').status).toBe('done');
    expect(res.json.steps.find((s) => s.key === 'provider_number').state).toBe('done');
    const rows = rowsOf('pbs_applications', placed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ application_type: 'medicare_provider', provider_number: '3456782B', status: 'complete', au_location_name: PRACTICE_NAME, au_location_placement_key: rig.appIdFor(placed), au_location_recorded_by: 'doctor' });
    const task = tasksOf(placed, 'provider_number_new_location')[0];
    expect(task.status).toBe('completed');
    expect(meta(task)).toMatchObject({ provider_number: '3456782B', stored_in: 'pbs_applications', recorded_by: 'doctor', location_name: PRACTICE_NAME });
    expect(timelineOf(placed)).toContain('Medicare provider number for the new location entered by the doctor');
    // staff read it from the same place
    const staff = await rig.get('/api/admin/au/prestart?case_id=' + placed.caseId, rig.superAdmin());
    expect(staff.json.provider_number).toMatchObject({ number: '3456782B', location_name: PRACTICE_NAME, recorded_by: 'doctor', stored_in: 'pbs_applications' });
    expect(staff.json.open).not.toContain('provider_number_new_location');
  });

  it('staff "Record number" writes the same place (one row per doctor: the location is on that row)', async () => {
    const res = await rig.post('/api/admin/au/prestart/provider-number', { case_id: placed.caseId, provider_number: '456789 3C' }, rig.superAdmin());
    expect(res.status).toBe(200);
    const rows = rowsOf('pbs_applications', placed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider_number: '4567893C', au_location_recorded_by: rig.SUPER_EMAIL });
    expect((await rig.get('/api/gp/au-prestart', as(placed))).json.providerNumber.number).toBe('4567893C');
  });

  it('a database without the WP-12 columns: the number is still recorded, on the task, exactly as WP-11 left it', async () => {
    const t = rig.testUtils;
    const cols = ['au_location_practice_id', 'au_location_name', 'au_location_placement_key', 'au_location_recorded_by', 'au_location_recorded_at'];
    rig.emu.missingColumns.pbs_applications = cols; // the migration is not applied: PostgREST answers 400 to a write that names them
    try {
      const res = await t.auRecordProviderNumber(placed.caseId, { providerNumber: '567890 4D' }, rig.SUPER_EMAIL);
      expect(res).toMatchObject({ ok: true, provider_number: '5678904D', stored_in: 'task_metadata' });
      const task = tasksOf(placed, 'provider_number_new_location')[0];
      expect(meta(task)).toMatchObject({ provider_number: '5678904D', stored_in: 'task_metadata', pbs_application_id: null });
      expect(rowsOf('pbs_applications', placed)[0].provider_number).toBe('4567893C'); // the row was not half-written
    } finally { delete rig.emu.missingColumns.pbs_applications; }
    // put the home copy back in step for the tests that follow
    await t.auRecordProviderNumber(placed.caseId, { providerNumber: '456789 3C' }, rig.SUPER_EMAIL);
    expect(rowsOf('pbs_applications', placed)[0].provider_number).toBe('4567893C');
  });

  it('a write that fails for another reason fails honestly: nothing is marked recorded', async () => {
    const t = rig.testUtils;
    rig.emu.forbid((r) => (r.table === 'pbs_applications' && r.method !== 'GET' ? 'test: provider table write refused' : ''));
    try {
      const res = await t.auRecordProviderNumber(placed.caseId, { providerNumber: '678901 5E' }, rig.SUPER_EMAIL);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(502);
      expect(meta(tasksOf(placed, 'provider_number_new_location')[0]).provider_number).toBe('4567893C');
    } finally { rig.emu.forbid(null); }
  });
});

describe('APP-11: the Medicare step opens on placement for an Australian doctor', () => {
  it('Australian: open once a placement is on record, closed before it', async () => {
    const a = await rig.get('/api/registration/can-proceed', as(placed));
    expect(a.json).toMatchObject({ ok: true, auPathway: true, steps: { career: { accessible: true, completed: true }, prestart: { accessible: true }, pbs: { accessible: true, completed: true, locked_reason: null } } });
    const b = await rig.get('/api/registration/can-proceed', as(unplaced));
    expect(b.json.steps.pbs).toEqual({ accessible: false, completed: false, locked_reason: 'Opens once your placement is secured.' });
    expect(Object.keys(b.json.steps)).toEqual(['career', 'prestart', 'pbs']);
    expect(words.bannedLines(a.raw + '\n' + b.raw)).toEqual([]);
  });

  it('overseas: exactly today\'s answer, switch on or off (still locked behind the visa)', async () => {
    const on = await rig.get('/api/registration/can-proceed', as(overseas));
    rig.setSwitch(false);
    let off;
    let auOff;
    try { off = await rig.get('/api/registration/can-proceed', as(overseas)); auOff = await rig.get('/api/registration/can-proceed', as(placed)); } finally { rig.setSwitch(true); }
    expect(on.status).toBe(200);
    expect(on.raw).toBe(off.raw);
    expect(Object.keys(on.json.steps)).toEqual(['career', 'ahpra', 'visa', 'pbs', 'commencement']);
    expect(on.json.steps.pbs).toEqual({ accessible: false, completed: false, locked_reason: 'Visa must be granted first.' });
    expect(on.json.auPathway).toBeUndefined();
    // with the switch off a stored Australian doctor is an overseas doctor
    expect(Object.keys(auOff.json.steps)).toEqual(['career', 'ahpra', 'visa', 'pbs', 'commencement']);
  });
});

describe('which page an address serves', () => {
  it('the rule, as a table', () => {
    const rule = rig.testUtils.auPageRouteDecision;
    const au = (placedNow) => ({ isAu: true, placed: placedNow });
    expect(rule('/pages/index.html', au(false))).toEqual({ serve: '/pages/index-au.html', shellPath: '/pages/index.html' });
    expect(rule('/pages/pbs.html', au(true))).toEqual({ serve: '/pages/pbs-au.html', shellPath: '/pages/pbs.html' });
    expect(rule('/pages/pbs.html', au(false))).toEqual({ redirect: '/pages/career' });
    expect(rule('/pages/prestart.html', au(true))).toEqual({ serve: '/pages/prestart.html', shellPath: '/pages/prestart.html' });
    expect(rule('/pages/prestart.html', au(false))).toEqual({ redirect: '/pages/career' });
    expect(rule('/pages/registration-intro.html', au(true))).toEqual({ redirect: '/pages/prestart' });
    expect(rule('/pages/registration-intro.html', au(false))).toEqual({ redirect: '/pages/career' });
    expect(rule('/pages/commencement.html', au(true))).toEqual({ redirect: '/pages/prestart' });
    expect(rule('/pages/index-au.html', au(true))).toEqual({ redirect: '/pages/index' });
    expect(rule('/pages/pbs-au.html', au(true))).toEqual({ redirect: '/pages/pbs' });
    // anyone else: the Australian files do not exist, and every ordinary address is left to today's code
    [{ isAu: false }, {}, null, undefined].forEach((who) => {
      ['/pages/index-au.html', '/pages/pbs-au.html', '/pages/prestart.html'].forEach((p) => expect(rule(p, who)).toEqual({ redirect: '/pages/index' }));
      ['/pages/index.html', '/pages/pbs.html', '/pages/registration-intro.html', '/pages/commencement.html'].forEach((p) => expect(rule(p, who)).toBeNull());
    });
    ['/pages/career.html', '/pages/account.html', '/pages/messages.html', '/pages/my-documents.html', ''].forEach((p) => expect(rule(p, au(true))).toBeNull());
  });

  const embedded = '?gp_shell=embedded&gp_shell_static=1';
  it('an Australian doctor gets their own Home, provider-number step and pre-start page, never kept by a cache', async () => {
    const home = await rig.get('/pages/index' + embedded, as(placed));
    expect(home.status).toBe(200);
    expect(home.raw).toContain('id="auHomeRoot"');
    expect(home.headers['cache-control']).toBe('private, no-store');
    const pbs = await rig.get('/pages/pbs' + embedded, as(placed));
    expect(pbs.status).toBe(200);
    expect(pbs.raw).toContain('id="auProviderRoot"');
    expect(pbs.headers['cache-control']).toBe('private, no-store');
    const pre = await rig.get('/pages/prestart' + embedded, as(placed));
    expect(pre.raw).toContain('id="auPrestartRoot"');
    // a spelling that would serve the same file is routed the same way
    expect((await rig.get('/pages/PBS' + embedded, as(placed))).raw).toContain('id="auProviderRoot"');
    // the top-level address is the app shell, as for every page
    expect((await rig.get('/pages/prestart', as(placed))).raw).toContain('app-shell-frame');
    for (const p of ['/pages/registration-intro', '/pages/commencement']) {
      const r = await rig.get(p + embedded, as(placed));
      // CHANGED by FB-2b (A2): the shell's embed parameters are carried on
      // the redirect (they were dropped, so a framed request loaded a second
      // shell inside the first). A plain request is unchanged.
      expect([r.status, r.headers.location]).toEqual([302, '/pages/prestart' + embedded]);
      expect((await rig.get(p, as(placed))).headers.location).toBe('/pages/prestart');
    }
    for (const p of ['/pages/myinthealth', '/pages/amc', '/pages/ahpra', '/pages/visa']) expect((await rig.get(p + embedded, as(placed))).status).toBe(302);
  });

  it('before a placement the two later steps lead to Careers; a held doctor gets the Australian Home too', async () => {
    for (const p of ['/pages/pbs', '/pages/prestart', '/pages/registration-intro']) {
      const r = await rig.get(p + embedded, as(unplaced));
      // CHANGED by FB-2b (A2): see above.
      expect([p, r.status, r.headers.location]).toEqual([p, 302, '/pages/career' + embedded]);
    }
    expect((await rig.get('/pages/index' + embedded, as(unplaced))).raw).toContain('id="auHomeRoot"');
    expect((await rig.get('/pages/index' + embedded, as(held))).raw).toContain('id="auHomeRoot"');
  });

  it('an overseas doctor, and everyone with the switch off, is served exactly the pages they always were', async () => {
    const check = async (d, label) => {
      const home = await rig.get('/pages/index' + embedded, as(d));
      expect(home.raw, label).toContain('<title>Dashboard - GP Link</title>');
      expect(home.raw, label).not.toContain('auHomeRoot');
      expect(home.headers['cache-control'], label).toBe('private, no-cache');
      for (const p of ['/pages/prestart', '/pages/index-au', '/pages/pbs-au']) {
        const r = await rig.get(p + embedded, as(d));
        expect([label, p, r.status, r.headers.location]).toEqual([label, p, 302, '/pages/index']);
      }
    };
    await check(overseas, 'overseas, switch on');
    const pbsOn = await rig.get('/pages/pbs' + embedded, as(overseas));
    const introOn = await rig.get('/pages/registration-intro' + embedded, as(overseas));
    rig.setSwitch(false);
    try {
      await check(overseas, 'overseas, switch off');
      await check(placed, 'stored Australian doctor, switch off');
      const pbsOff = await rig.get('/pages/pbs' + embedded, as(overseas));
      const introOff = await rig.get('/pages/registration-intro' + embedded, as(overseas));
      expect([pbsOn.status, pbsOn.headers.location, pbsOn.raw]).toEqual([pbsOff.status, pbsOff.headers.location, pbsOff.raw]);
      expect([introOn.status, introOn.raw]).toEqual([introOff.status, introOff.raw]);
    } finally { rig.setSwitch(true); }
    expect([pbsOn.status, pbsOn.headers.location]).toEqual([302, '/pages/career?locked=pbs']);
  });
});

describe('APP-26: Account details for an Australian doctor', () => {
  it('shows what is on file', async () => {
    const res = await rig.get('/api/account/au-details', as(placed));
    expect(res.status).toBe(200);
    const cred = rig.table('gp_credentials').find((c) => c.user_id === placed.userId);
    expect(res.json).toMatchObject({ ok: true, ahpraNumber: cred.ahpra_number, ahpraNumberLocked: true, registrationType: cred.ahpra_registration_type, fellowshipType: cred.fellowship_type });
    expect(res.json.existingProviderNumbers).toEqual([{ number: '2345671A', location: 'Test Current Practice (FAKE)' }]);
    expect(res.json.options.workRights).toEqual(['citizen', 'pr', 'temporary']);
    expect(res.raw).not.toMatch(/dpaRestricted|moratorium|staff_verified|pathway_confirmed|"pathway"/);
    expect(words.bannedLines(words.allStrings(res.json))).toEqual([]);
    expect((await rig.get('/api/account/au-details', as(overseas))).status).toBe(404);
  });

  it('a bad value is a 400 and nothing at all is written', async () => {
    const before = rig.emu.requests.length;
    const res = await rig.post('/api/account/au-details', { currentSuburb: 'Newtown', currentPostcode: '20', noticePeriodWeeks: 500, registrationType: 'made_up', workRights: 'visa', preferredLocations: ['Atlantis'] }, as(unplaced));
    expect(res.status).toBe(400);
    expect(Object.keys(res.json.errors).sort()).toEqual(['currentPostcode', 'noticePeriodWeeks', 'preferredLocations', 'registrationType', 'workRights']);
    expect(rig.emu.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('saves the doctor\'s own details; the pathway cannot be written from the browser', async () => {
    const profileBefore = Object.assign({}, rig.table('user_profiles').find((p) => p.user_id === unplaced.userId));
    const credBefore = Object.assign({}, rig.table('gp_credentials').find((c) => c.user_id === unplaced.userId));
    const res = await rig.post('/api/account/au-details', {
      currentState: 'vic', currentSuburb: 'Carlton', currentPostcode: '3053', noticePeriodWeeks: 6, availableFrom: '2027-03-01', preferredLocations: ['Melbourne', 'Regional VIC'],
      existingProviderNumbers: [{ number: '111111 1A', location: 'Old Practice (FAKE)' }], prescriberNumber: '7654321',
      candidate_pathway: 'overseas_esp', pathway: 'au_registrar', candidate_basis: 'overseas', pathway_confirmed_at: '2026-01-01', staff_verified_at: '2026-01-01', moratorium_19ab_confirmed_status: 'no'
    }, as(unplaced));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ saved: true, registrationChanged: false, currentState: 'VIC', currentSuburb: 'Carlton', currentPostcode: '3053', noticePeriodWeeks: 6, availableFrom: '2027-03-01', preferredLocations: ['Melbourne', 'Regional VIC'], prescriberNumber: '7654321' });
    const profile = rig.table('user_profiles').find((p) => p.user_id === unplaced.userId);
    expect(profile).toMatchObject({ current_state: 'VIC', current_suburb: 'Carlton', notice_period_weeks: 6, available_from: '2027-03-01', preferred_locations: ['Melbourne', 'Regional VIC'] });
    ['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_confirmed_at', 'pathway_confirmed_by'].forEach((k) => expect(profile[k]).toEqual(profileBefore[k]));
    const cred = rig.table('gp_credentials').find((c) => c.user_id === unplaced.userId);
    // no staff column moved: not the verification stamp, not the staff 19AB answer
    ['staff_verified_at', 'staff_verified_by', 'moratorium_19ab_confirmed_status', 'moratorium_19ab_confirmed_by', 'moratorium_19ab_confirmed_at', 'ahpra_last_checked_at', 'flags_reviewed_at']
      .forEach((k) => expect(cred[k] === undefined ? null : cred[k], k).toEqual(credBefore[k] === undefined ? null : credBefore[k]));
    expect(cred.staff_verified_at || null).toBe(null);
    expect(rowsOf('au_gp_doctor_details', unplaced)[0]).toMatchObject({ existing_provider_numbers: [{ number: '1111111A', location: 'Old Practice (FAKE)' }], prescriber_number: '7654321' });
  });

  it('a changed registration fact is saved, the pathway is left alone, and staff are asked to check the register again', async () => {
    const before = tasksOf(unplaced, 'ahpra_register_check').filter((t) => t.status !== 'completed').length;
    const res = await rig.post('/api/account/au-details', { ahpraNumber: 'med 0007654321', registrationType: 'general', fellowshipType: 'none', workRights: 'temporary' }, as(unplaced));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ registrationChanged: true, ahpraNumber: 'MED0007654321', registrationType: 'general', fellowshipType: 'none', workRights: 'temporary' });
    const cred = rig.table('gp_credentials').find((c) => c.user_id === unplaced.userId);
    expect(cred).toMatchObject({ ahpra_number: 'MED0007654321', ahpra_registration_type: 'general', fellowship_type: 'none', work_rights: 'visa' });
    expect(rig.table('user_profiles').find((p) => p.user_id === unplaced.userId).candidate_pathway).toBe('au_vr');
    expect(timelineOf(unplaced)).toContain('Doctor changed registration details in Account');
    expect(tasksOf(unplaced, 'ahpra_register_check').filter((t) => t.status !== 'completed').length).toBeGreaterThanOrEqual(Math.max(1, before));
  });

  it('the Ahpra number cannot be changed once our team has checked it', async () => {
    const number = rig.table('gp_credentials').find((c) => c.user_id === placed.userId).ahpra_number;
    const res = await rig.post('/api/account/au-details', { ahpraNumber: 'MED0009999999' }, as(placed));
    expect(res.status).toBe(400);
    expect(res.json.errors.ahpraNumber).toMatch(/checked by our team/);
    expect(rig.table('gp_credentials').find((c) => c.user_id === placed.userId).ahpra_number).toBe(number);
    // sending the same number back is not a change
    expect((await rig.post('/api/account/au-details', { ahpraNumber: number, currentSuburb: 'Parramatta' }, as(placed))).status).toBe(200);
  });
});

describe('ADM-27: "View as GP" shows the Australian app and writes nothing', () => {
  it('the preview is told the doctor is Australian, and is served their pages', async () => {
    const who = previewAs(placed);
    const session = await rig.get('/api/auth/session', who);
    expect(session.json.auPathway).toMatchObject({ pathway: 'au_vr', isAu: true });
    expect(session.json.auJourney).toMatchObject({ stage: 'prestart', entryRoute: '/pages/prestart' });
    expect(session.json.auJourney.steps.map((s) => s.state)).toEqual(['done', 'current', 'open', 'open']);
    expect((await rig.get('/pages/index?gp_shell=embedded&gp_shell_static=1', who)).raw).toContain('id="auHomeRoot"');
    expect((await rig.get('/pages/prestart?gp_shell=embedded&gp_shell_static=1', who)).raw).toContain('id="auPrestartRoot"');
    const view = await rig.get('/api/gp/au-prestart', who);
    expect(view.json).toMatchObject({ placed: true, practiceName: PRACTICE_NAME });
  });

  it('every write an Australian doctor\'s screens can make answers normally and stores nothing', async () => {
    const who = previewAs(placed);
    const snapshot = () => JSON.stringify(['au_gp_doctor_details', 'pbs_applications', 'gp_credentials', 'user_profiles', 'user_documents', 'registration_tasks', 'task_timeline', 'user_state']
      .map((t) => rig.table(t).filter((r) => r.user_id === placed.userId || r.case_id === placed.caseId)));
    const before = snapshot();
    const mark = rig.emu.requests.length;
    const calls = [
      ['POST', '/api/gp/au-prestart/notice', { given: true, date: '2026-10-01' }],
      ['POST', '/api/gp/au-prestart/referees', { referees: goodReferees.map((r) => Object.assign({}, r, { name: 'Changed By Preview' })) }],
      ['POST', '/api/gp/au-prestart/provider-details', { newLocationProviderNumber: '999999ZZ', prescriberNumber: '1111111', existingProviderNumbers: [] }],
      ['POST', '/api/account/au-details', { currentSuburb: 'Changed By Preview', noticePeriodWeeks: 52, registrationType: 'limited' }],
      ['PUT', '/api/gp/au-documents', { key: 'au_indemnity_certificate', fileName: 'x.pdf', mimeType: 'application/pdf', fileSize: 10, fileDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }],
      ['POST', '/api/gp/au-documents/expiry', { key: 'au_indemnity_certificate', expiresAt: '2027-06-30' }],
      ['PUT', '/api/state', { state: { gp_career_state: {}, gp_link_updates: [] }, updatedAt: new Date().toISOString() }]
    ];
    for (const [method, url, body] of calls) {
      const res = await rig.request(method, url, Object.assign({ body }, who));
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.json.impersonated, url).toBe(true);
      if ('saved' in res.json) expect(res.json.saved, url).toBe(false);
    }
    const writes = rig.emu.requests.slice(mark).filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.table);
    expect(writes).toEqual([]);
    expect(snapshot()).toBe(before);
    // the same calls from the doctor's own session DO write (the guard is the preview, not the route)
    const own = await rig.post('/api/gp/au-prestart/notice', { given: true, date: today() }, as(placed));
    expect(own.json.saved).toBe(true);
  });
});

describe('D18 and the role payload', () => {
  it('a doctor whose registration is not yet confirmed is told more roles may open; nobody else is', async () => {
    const pending = await rig.get('/api/career/roles', as(unplaced));
    expect(pending.status).toBe(200);
    expect(pending.json.auRegistrationPending).toBe(true);
    const confirmed = buildAuDoctor('au_vr', { idSuffix: '3' });
    rig.addDoctor(confirmed);
    expect('auRegistrationPending' in (await rig.get('/api/career/roles', as(confirmed))).json).toBe(false);
    expect('auRegistrationPending' in (await rig.get('/api/career/roles', as(overseas))).json).toBe(false);
    expect('auRegistrationPending' in (await rig.get('/api/career/roles', as(held))).json).toBe(false);
    // and no role an Australian doctor is sent carries one of the words
    for (const d of [unplaced, confirmed]) expect(words.bannedLines(words.allStrings((await rig.get('/api/career/roles', as(d))).json))).toEqual([]);
    expect(words.bannedLines(words.allStrings((await rig.get('/api/career/applications', as(placed))).json))).toEqual([]);
  });
});
