// Australian GP build, fix bundle FB-1: the server side of the walk-through
// findings D9, D10, D12, D13, D14 and D16, against the real server and the
// in-memory database stub. Every block proves three things: the Australian
// behaviour, the unchanged behaviour for a doctor with nothing recorded
// (switch on), and the switch off.
//
//   D9   an Australian doctor's role responses are never cacheable, and the
//        session carries a version that changes when their eligibility does
//   D10  the session carries the doctor's own application limits
//   D12  a doctor whose recorded pathway is Australian cannot complete the
//        other wizard; what staff entered is offered back for pre-filling
//   D13  Careers sends such a doctor to onboarding until it is finished
//   D14  the invite: first password = verified + signed in, once only
//   D16  one CV for an Australian doctor
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits',
  'gp_nudge_log', 'password_setup_tokens', 'user_roles', 'career_roles', 'practices'];
const STRONG_PASSWORD = 'GpLink-Test-2026!';

let h, t;
let seq = 0;
const resendCalls = [];
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'f' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const session = (d) => h.get('/api/auth/session', { cookie: d.cookie });

// What the other (non-Australian) wizard posts when it finishes.
function otherWizardBody() {
  return {
    _version: 2, currentStep: 4, country: 'GB', registerNumber: '1234567', qualDocs: {}, accountReviewFlag: false,
    targetDate: '2027-03-01', preferredCity: 'Sydney', whoMoving: 'me', childrenCount: 1, childrenAges: [],
    leadSource: 'google', leadSourceDetail: '', idVerification: null, completedAt: new Date().toISOString()
  };
}

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'fb1', tables, emulator: { auth: true, rpc: { rate_limit_hit: function () { return { allowed: true }; } } } });
  t = h.testUtils;
  const stubbed = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('api.resend.com') !== -1) {
      let body = null;
      try { body = JSON.parse(init && init.body ? init.body : 'null'); } catch (e) { body = null; }
      resendCalls.push({ url: u, body });
      return Promise.resolve(new Response(JSON.stringify({ id: 'stub-email' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return stubbed(url, init);
  };
}, 60000);

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.AU_APPLICATION_CAPS_JSON;
  resendCalls.length = 0;
  h.emu.authTokens = {};
});

describe('FB-1 D9 + D10: what the session tells an Australian doctor about themselves', () => {
  it('carries auDoctor (version, own limits, onboarding) for an Australian doctor only', async () => {
    const au = add('au_vr');
    const res = await session(au);
    expect(res.status).toBe(200);
    expect(res.json.auPathway).toMatchObject({ pathway: 'au_vr', isAu: true });
    expect(res.json.auDoctor.limits).toEqual({ active: 4, monthly: 6, interviewsMonthly: 6 });
    expect(res.json.auDoctor.onboardingComplete).toBe(true);
    expect(res.json.auDoctor.eligibilityVersion).toMatch(/^[0-9a-f]{16}$/);
    // Nothing staff recorded, and no DPA flag, reaches the browser.
    expect(JSON.stringify(res.json)).not.toMatch(/dpaRestricted|moratorium|staff_verified|confirmed/i);
  });

  it('the limits follow the caps config', async () => {
    process.env.AU_APPLICATION_CAPS_JSON = JSON.stringify({ au_vr: { active: 5, monthly: 8 } });
    const au = add('au_vr');
    expect((await session(au)).json.auDoctor.limits).toEqual({ active: 5, monthly: 8, interviewsMonthly: 6 });
  });

  it('the version changes when staff withdraw the 19AB confirmation, and changes back', async () => {
    const au = add('au_vr');
    const before = (await session(au)).json.auDoctor.eligibilityVersion;
    const cred = row('gp_credentials', au.userId);
    const saved = { s: cred.moratorium_19ab_confirmed_status, b: cred.moratorium_19ab_confirmed_by, a: cred.moratorium_19ab_confirmed_at };
    cred.moratorium_19ab_confirmed_status = null;
    cred.moratorium_19ab_confirmed_by = null;
    cred.moratorium_19ab_confirmed_at = null;
    const locked = (await session(au)).json.auDoctor.eligibilityVersion;
    expect(locked).not.toBe(before);
    cred.moratorium_19ab_confirmed_status = saved.s;
    cred.moratorium_19ab_confirmed_by = saved.b;
    cred.moratorium_19ab_confirmed_at = saved.a;
    expect((await session(au)).json.auDoctor.eligibilityVersion).toBe(before);
  });

  it('two Australian doctors in the same position do not share a version', async () => {
    const a = add('au_vr');
    const b = add('au_vr');
    expect((await session(a)).json.auDoctor.eligibilityVersion).not.toBe((await session(b)).json.auDoctor.eligibilityVersion);
  });

  it('a doctor with nothing recorded has no auDoctor key (switch on), and the response is unchanged with the switch off', async () => {
    const os = add('overseas_null');
    const on = await session(os);
    expect(Object.keys(on.json).sort()).toEqual(['auPathway', 'auPathwayEnabled', 'authenticated', 'ok', 'profile']);
    const au = add('au_vr');
    h.setSwitch(false);
    const before = h.emu.requests.length;
    const off = await session(au);
    expect(Object.keys(off.json).sort()).toEqual(['authenticated', 'ok', 'profile']);
    // Nothing Australian is read with the switch off.
    const made = h.emu.requests.slice(before).map((r) => JSON.stringify(r));
    expect(made.filter((r) => /gp_credentials|candidate_pathway|onboarding_completed_at/.test(r))).toEqual([]);
  });
});

describe('FB-1 D9: role responses are never cacheable for an Australian doctor', () => {
  it('roles list: no-store for an Australian doctor; today\'s private cache for everyone else', async () => {
    const au = add('au_vr');
    const os = add('overseas_null');
    const auRes = await h.get('/api/career/roles', { cookie: au.cookie });
    expect(auRes.status).toBe(200);
    expect(auRes.headers['cache-control']).toBe('no-store');
    const osRes = await h.get('/api/career/roles', { cookie: os.cookie });
    expect(osRes.headers['cache-control']).toBe('private, max-age=60, stale-while-revalidate=300');
    h.setSwitch(false);
    const offRes = await h.get('/api/career/roles', { cookie: au.cookie });
    expect(offRes.headers['cache-control']).toBe('private, max-age=60, stale-while-revalidate=300');
  });
});

describe('FB-1 D12: the recorded pathway decides which onboarding a doctor takes', () => {
  const invited = () => add('au_vr', {
    selfDeclared: true, noCase: true,
    profile: { onboarding_completed_at: null, pathway_set_by: 'consultant@gplink-test.local', current_state: 'VIC',
      register_body: 'ahpra', register_number: 'MED0001234888', register_status: 'pending_verification' },
    credentials: { ahpra_number: 'MED0001234888' }
  });

  it('refuses the other wizard for a doctor whose recorded pathway is Australian, and writes nothing', async () => {
    const d = invited();
    row('user_state', d.userId).state = {};
    const res = await h.post('/api/onboarding/complete', otherWizardBody(), { cookie: d.cookie });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_pathway', auBranchRequired: true });
    expect(row('user_profiles', d.userId).onboarding_completed_at).toBeNull();
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
    expect(row('user_state', d.userId).state.gp_onboarding_complete).toBeUndefined();
    expect(row('user_state', d.userId).state.gp_onboarding).toBeUndefined();
  });

  it('a doctor with nothing recorded completes the other wizard exactly as before (switch on and off)', async () => {
    for (const on of [true, false]) {
      h.setSwitch(on);
      const d = add('overseas_null', { noCase: true, profile: { onboarding_completed_at: null } });
      row('user_state', d.userId).state = {};
      const res = await h.post('/api/onboarding/complete', otherWizardBody(), { cookie: d.cookie });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(row('user_state', d.userId).state.gp_onboarding_complete).toBe(true);
    }
  });

  it('with the switch off the same request from the Australian doctor is not intercepted', async () => {
    const d = invited();
    row('user_state', d.userId).state = {};
    h.setSwitch(false);
    const res = await h.post('/api/onboarding/complete', otherWizardBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
  });

  it('offers back what staff entered, to that doctor only', async () => {
    const d = invited();
    const res = await h.get('/api/onboarding/au-prefill', { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json).toMatchObject({ ok: true, onboardingComplete: false, answers: { state: 'VIC', ahpraNumber: 'MED0001234888' } });
    expect(Object.keys(res.json.pathway).sort()).toEqual(['isAu', 'launched', 'pathway', 'segment']);
    const os = add('overseas_null');
    expect((await h.get('/api/onboarding/au-prefill', { cookie: os.cookie })).status).toBe(404);
    expect((await h.get('/api/onboarding/au-prefill')).status).toBe(401);
    h.setSwitch(false);
    expect((await h.get('/api/onboarding/au-prefill', { cookie: d.cookie })).status).toBe(404);
  });
});

describe('FB-1 D13: onboarding first on Careers for an Australian doctor', () => {
  it('sends an Australian doctor who has not finished onboarding to onboarding; serves everyone else', async () => {
    const notDone = add('au_vr', { profile: { onboarding_completed_at: null } });
    row('user_state', notDone.userId).state = {};
    const done = add('au_vr');
    const osNotDone = add('overseas_null', { profile: { onboarding_completed_at: null } });
    row('user_state', osNotDone.userId).state = {};

    for (const path of ['/pages/career', '/pages/CAREER', '/pages/%63areer']) {
      const res = await h.get(path, { cookie: notDone.cookie });
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toBe('/pages/onboarding');
    }
    const sessionBlock = (await session(notDone)).json.auDoctor;
    expect(sessionBlock.onboardingComplete).toBe(false);

    expect((await h.get('/pages/career', { cookie: done.cookie })).status).toBe(200);
    // A doctor with nothing recorded is served as they always were.
    expect((await h.get('/pages/career', { cookie: osNotDone.cookie })).status).toBe(200);
    h.setSwitch(false);
    expect((await h.get('/pages/career', { cookie: notDone.cookie })).status).toBe(200);
  });
});

describe('FB-1 D14: the staff invite', () => {
  async function invite(email) {
    const res = await h.post('/api/ats/candidate', {
      first_name: 'Test', last_name: 'Fbinvite', email, phone: '+61491570157', pathway: 'au_vr', ahpra_number: 'MED0001234999', state: 'VIC'
    }, h.consultant());
    expect(res.status).toBe(201);
    const user = h.emu.authUsers.find((x) => x.email === email);
    return { userId: res.json.user_id, user, token: rows('password_setup_tokens').filter((r) => r.user_id === res.json.user_id)[0].token };
  }
  const setPassword = (accessToken) => h.post('/api/auth/recovery-update-password', { accessToken, password: STRONG_PASSWORD });

  it('the phone staff typed without a space is split at the dial code', async () => {
    expect(t.auSplitStaffPhone('+61491570157')).toEqual({ countryDial: '+61', phoneNumber: '491570157' });
    expect(t.auSplitStaffPhone('+44 7700 900123')).toEqual({ countryDial: '+44', phoneNumber: '7700900123' });
    expect(t.auSplitStaffPhone('+353871234567')).toEqual({ countryDial: '+353', phoneNumber: '871234567' });
    expect(t.auSplitStaffPhone('0491 570 157')).toEqual({ countryDial: '', phoneNumber: '0491 570 157' });
    const inv = await invite('fb1.phone@gplink-test.local');
    expect(inv.user.user_metadata).toMatchObject({ countryDial: '+61', phoneNumber: '491570157' });
  });

  it('the invite link is marked, and only a marked link (switch on) lands with first-time wording', async () => {
    const inv = await invite('fb1.link@gplink-test.local');
    const mail = resendCalls.map((c) => c.body).filter((b) => [].concat(b && b.to).indexOf('fb1.link@gplink-test.local') !== -1)[0];
    expect(String(mail.html).replace(/&amp;/g, '&')).toContain('/api/auth/welcome-setup?token=' + inv.token + '&invite=1');

    const redirectFor = async (query) => {
      h.emu.authRequests.length = 0;
      const res = await h.get('/api/auth/welcome-setup?token=' + inv.token + query);
      expect(res.status).toBe(302);
      const gen = h.emu.authRequests.filter((r) => r.path === 'admin/generate_link')[0];
      return gen.body.options.redirect_to;
    };
    expect(await redirectFor('&invite=1')).toMatch(/\/pages\/signin\?reset=true&invite=1$/);
    expect(await redirectFor('')).toMatch(/\/pages\/signin\?reset=true$/);
    h.setSwitch(false);
    expect(await redirectFor('&invite=1')).toMatch(/\/pages\/signin\?reset=true$/);
  });

  it('the first password marks the address verified and signs the doctor in; a second use of the token does neither', async () => {
    const inv = await invite('fb1.first@gplink-test.local');
    expect(inv.user.app_metadata.created_by_staff).toBeTruthy();
    expect(inv.user.app_metadata.email_verified_at).toBeUndefined();
    h.emu.authTokens['aaa.bbb.ccc'] = inv.userId;
    resendCalls.length = 0;

    const first = await setPassword('aaa.bbb.ccc');
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, invite: true, signedIn: true, redirectTo: '/pages/onboarding' });
    expect(String(first.headers['set-cookie'] || '')).toContain('gp_session=');
    expect(inv.user.app_metadata.email_verified_at).toBeTruthy();
    expect(inv.user.app_metadata.created_by_staff).toBeTruthy(); // the stamp merged, nothing was lost
    expect(t.isAccountEmailVerified ? t.isAccountEmailVerified(inv.user) : true).toBe(true);
    // No "verify your account" email follows.
    expect(resendCalls.filter((c) => /verify/i.test(String(c.body && c.body.subject))).length).toBe(0);

    // The session it issued is a real one.
    const cookie = [].concat(first.headers['set-cookie']).map((c) => String(c).split(';')[0]).join('; ');
    const me = await h.get('/api/auth/session', { cookie });
    expect(me.status).toBe(200);
    expect(me.json.profile.email).toBe('fb1.first@gplink-test.local');

    const again = await setPassword('aaa.bbb.ccc');
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, message: 'Password updated successfully.' });
    expect(first.headers['set-cookie']).toBeTruthy();
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('an ordinary password reset is answered exactly as before', async () => {
    // A self sign-up on an Australian pathway: not created by staff.
    const self = add('au_vr');
    h.emu.authUsers.push({ id: self.userId, email: self.email, user_metadata: {}, app_metadata: { provider: 'email' } });
    h.emu.authTokens['self.reset.token'] = self.userId;
    const a = await setPassword('self.reset.token');
    expect(a.json).toEqual({ ok: true, message: 'Password updated successfully.' });
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(h.emu.authUsers.find((x) => x.id === self.userId).app_metadata.email_verified_at).toBeUndefined();

    // A doctor staff created whose pathway is NOT Australian.
    const os = add('overseas_null');
    h.emu.authUsers.push({ id: os.userId, email: os.email, user_metadata: {}, app_metadata: { created_by_staff: 'consultant@gplink-test.local' } });
    h.emu.authTokens['os.reset.token'] = os.userId;
    const b = await setPassword('os.reset.token');
    expect(b.json).toEqual({ ok: true, message: 'Password updated successfully.' });
    expect(b.headers['set-cookie']).toBeUndefined();

    // A bad token is still refused.
    expect((await setPassword('not.a.token')).status).toBe(401);
  });

  it('with the switch off an invited doctor gets the ordinary answer', async () => {
    const inv = await invite('fb1.off@gplink-test.local');
    h.emu.authTokens['off.bbb.ccc'] = inv.userId;
    h.setSwitch(false);
    const res = await setPassword('off.bbb.ccc');
    expect(res.json).toEqual({ ok: true, message: 'Password updated successfully.' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(inv.user.app_metadata.email_verified_at).toBeUndefined();
  });
});

describe('FB-1 D16: one CV for an Australian doctor', () => {
  const cvRow = (userId, key) => ({
    id: 'doc-' + key + '-' + userId, user_id: userId, country_code: 'AU', document_key: key, status: 'uploaded',
    file_name: 'FAKE-' + key + '.pdf', mime_type: 'application/pdf', file_size: 700,
    storage_bucket: 'gp-link-documents', storage_path: 'users/' + userId + '/' + key, file_url: 'users/' + userId + '/' + key,
    updated_at: '2026-11-20T00:00:00.000Z'
  });
  const pdf = { type: 'cv', fileName: 'FAKE-cv.pdf', mimeType: 'application/pdf', fileSize: 700,
    fileDataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64') };

  it('Account shows the careers CV to an Australian doctor, and says so with au: true', async () => {
    const au = add('au_vr');
    rows('user_documents').push(cvRow(au.userId, 'career_cv'));
    rows('user_documents').push(cvRow(au.userId, 'cv_signed_dated'));
    const res = await h.get('/api/account/career-documents', { cookie: au.cookie });
    expect(res.status).toBe(200);
    expect(res.json.au).toBe(true);
    expect(res.json.documents.cv).toMatchObject({ type: 'cv', key: 'career_cv', fileName: 'FAKE-career_cv.pdf', status: 'uploaded' });

    const none = add('au_vr');
    const empty = await h.get('/api/account/career-documents', { cookie: none.cookie });
    expect(empty.json.documents.cv).toMatchObject({ key: 'career_cv', fileName: '', status: 'pending' });
  });

  it('an Australian doctor\'s CV is never stored as the registration-file CV, and no review task is raised', async () => {
    const au = add('au_vr');
    const tasksBefore = rows('registration_tasks').length;
    const res = await h.put('/api/account/career-documents', pdf, { cookie: au.cookie });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_pathway', useCareerCv: true });
    expect(rows('user_documents').filter((r) => r.user_id === au.userId).length).toBe(0);
    expect(rows('registration_tasks').length).toBe(tasksBefore);
  });

  it('a doctor with nothing recorded sees and stores exactly what they did before', async () => {
    for (const on of [true, false]) {
      h.setSwitch(on);
      const os = add('overseas_null');
      rows('user_documents').push(cvRow(os.userId, 'career_cv'));
      const get = await h.get('/api/account/career-documents', { cookie: os.cookie });
      expect(Object.keys(get.json).sort()).toEqual(['documents', 'ok']);
      expect(get.json.documents.cv).toMatchObject({ key: 'cv_signed_dated', fileName: '', status: 'pending' });
      const put = await h.put('/api/account/career-documents', pdf, { cookie: os.cookie });
      expect(put.status).toBe(200);
      expect(rows('user_documents').some((r) => r.user_id === os.userId && r.document_key === 'cv_signed_dated')).toBe(true);
    }
  });
});
