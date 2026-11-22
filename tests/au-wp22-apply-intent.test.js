// Australian GP build, WP-22: "Apply now" on a public job ends with THAT job
// open in Careers, through sign-up, sign-in and onboarding.
//
//   the rules (lib/au-apply-intent.js): the signed cookie, expiry, the decision
//   every hop against the real server and the in-memory database stub:
//     /jobs/apply -> cookie -> sign-up attaches it to the account -> the claim
//     waits for onboarding -> opens the role ONCE
//   every edge: role closed, not eligible (with the reason), a held doctor,
//     an existing signed-in doctor, an overseas doctor, another device,
//     a staff "View as" session, an altered or expired cookie
//   switch off: nothing is matched, read, stored or sent
//   the app shell's hook and the match popup's consent sheet (page JS)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const intent = require('../lib/au-apply-intent.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const fx = require('./helpers/au-wp22-fixtures.js');

const ROOT = path.resolve(__dirname, '..');
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits',
  'gp_nudge_log', 'password_setup_tokens', 'user_roles', 'practices', 'site_enquiries', 'career_suburb_geo_cache'];
const STRONG_PASSWORD = 'GpLink-Test-2026!';
const DAY = 24 * 60 * 60 * 1000;

const NON_DPA_VR = fx.publicId(1);   // Parramatta: not a DPA, VR required
const DPA_OPEN = fx.publicId(2);     // Dubbo: DPA, open to GPs without VR
const DPA_UNKNOWN = fx.publicId(5);  // Geelong: DPA status unknown
const CLOSED = 'internal_ats:wp22-role-8';

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const kv = (userId) => rows('runtime_kv').filter((r) => r.key === intent.kvKey(userId))[0] || null;
const timeline = (caseId) => rows('task_timeline').filter((r) => r.case_id === caseId && r.title === intent.TIMELINE_MARKER);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'w' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}

// The cookies a response set, as a request Cookie header (cleared ones dropped).
function cookiesFrom(res, base) {
  const jar = {};
  String(base || '').split(/;\s*/).filter(Boolean).forEach((pair) => { const i = pair.indexOf('='); jar[pair.slice(0, i)] = pair.slice(i + 1); });
  [].concat(res.headers['set-cookie'] || []).forEach((line) => {
    const first = line.split(';')[0];
    const i = first.indexOf('=');
    const name = first.slice(0, i);
    const value = first.slice(i + 1);
    if (/Max-Age=0/i.test(line) || value === '') delete jar[name]; else jar[name] = value;
  });
  return Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ');
}
const setCookieNames = (res) => [].concat(res.headers['set-cookie'] || []).map((l) => l.split('=')[0]);
const applyNow = (jobId, ro) => h.get('/jobs/apply?id=' + encodeURIComponent(jobId), ro);
const claim = (cookie) => h.post('/api/career/apply-intent/claim', {}, { cookie });
const resetBoard = () => t.__setPublicJobsRowsCacheForTest(null);
const stored = (userId, job, at, extra) => {
  rows('runtime_kv').push({ key: intent.kvKey(userId), value: Object.assign(intent.newRecord({ job, at: at || Date.now() }, 'test'), extra || {}), expires_at: null });
};

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  tables.career_roles = fx.allRows();
  h = await bootAuTestServer({ name: 'wp22', tables, emulator: { auth: true, rpc: { rate_limit_hit: function () { return { allowed: true }; } } } });
  t = h.testUtils;
}, 60000);

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  resetBoard();
  h.emu.requests.length = 0;
});

// ── the rules ───────────────────────────────────────────────────────────────

describe('the cookie: signed, tied to one job, and it expires', () => {
  const secret = 'unit-secret';
  const now = Date.parse('2026-11-22T00:00:00Z');

  it('round-trips, and anything altered is refused', () => {
    const value = intent.encodeCookie(secret, { job: NON_DPA_VR, at: now });
    expect(intent.decodeCookie(secret, value, now + 1000)).toEqual({ job: NON_DPA_VR, at: now });
    expect(intent.decodeCookie('another-secret', value, now)).toBeNull();
    expect(intent.decodeCookie(secret, value.slice(0, -1) + (value.slice(-1) === 'a' ? 'b' : 'a'), now)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ job: DPA_OPEN, at: now })).toString('base64url') + '.' + value.split('.')[1];
    expect(intent.decodeCookie(secret, forged, now)).toBeNull();
    ['', 'x', 'a.b', null, undefined].forEach((bad) => expect(intent.decodeCookie(secret, bad, now)).toBeNull());
  });

  it('is dead after 14 days, and one dated in the future is refused', () => {
    const value = intent.encodeCookie(secret, { job: NON_DPA_VR, at: now });
    expect(intent.decodeCookie(secret, value, now + 14 * DAY - 1000)).not.toBeNull();
    expect(intent.decodeCookie(secret, value, now + 14 * DAY + 1000)).toBeNull();
    expect(intent.decodeCookie(secret, intent.encodeCookie(secret, { job: NON_DPA_VR, at: now + DAY }), now)).toBeNull();
  });

  it('only a public role id is ever accepted', () => {
    ['internal_ats:wp22-role-1', 'zoho_recruit:zr-wp22-7'].forEach((id) => expect(intent.isValidJobId(id)).toBe(true));
    ['', 'role', '../etc/passwd', 'a:b c', 'internal_ats:<script>', 'x:' + 'y'.repeat(300), 'https://evil.example/x:1'].forEach((id) => expect(intent.isValidJobId(id), id).toBe(false));
    expect(intent.encodeCookie(secret, { job: '<script>', at: now })).toBe('');
  });
});

describe('the decision', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const record = intent.newRecord({ job: NON_DPA_VR, at: now - DAY }, 'test');
  const ok = { canApply: true, hold: false, reasons: [] };
  const table = [
    ['no record', { record: null }, 'none', false],
    ['already consumed', { record: intent.consumed(record, 'opened', now) }, 'none', false],
    ['expired', { record: Object.assign({}, record, { expiresAt: now - 1 }) }, 'none', false],
    ['onboarding not finished', { record, onboardingComplete: false, roleOpen: true, verdict: ok }, 'wait', false],
    ['role closed', { record, onboardingComplete: true, roleOpen: false }, 'closed', true],
    ['eligible', { record, onboardingComplete: true, roleOpen: true, verdict: ok, isAu: true }, 'open', true],
    ['held (segment B / C)', { record, onboardingComplete: true, roleOpen: true, verdict: { canApply: false, hold: true, reasons: ['pathway_on_hold'] }, isAu: true }, 'held', false],
    ['Australian, limited to DPA', { record, onboardingComplete: true, roleOpen: true, verdict: { canApply: false, hold: false, reasons: ['dpa_restricted'] }, isAu: true }, 'not_eligible', true],
    ['overseas, not a DPA', { record, onboardingComplete: true, roleOpen: true, verdict: { canApply: false, hold: false, reasons: ['dpa_restricted'] }, isAu: false }, 'not_eligible', true],
    ['no verdict', { record, onboardingComplete: true, roleOpen: true, verdict: null, isAu: true }, 'not_eligible', true]
  ];
  table.forEach(([name, facts, action, consume]) => {
    it(`${name} -> ${action}${consume ? ' (used up)' : ''}`, () => {
      const d = intent.decide(Object.assign({ now }, facts));
      expect(d.action).toBe(action);
      expect(d.consume).toBe(consume);
      if (action === 'open') expect(d.go).toBe('/pages/job?id=' + encodeURIComponent(NON_DPA_VR));
      else expect(d.go).toBeUndefined();
    });
  });

  it('every reason has its own honest sentence, none names the role, and none is "you do not qualify"', () => {
    const reasons = { dpa_restricted: 'au_dpa_restricted', role_dpa_unknown: 'au_role_dpa_unknown', vr_required: 'vr_required',
      registrars_not_accepted: 'registrars_not_accepted', supervised_not_accepted: 'supervised_not_accepted', pathway_unreadable: 'unreadable' };
    Object.keys(reasons).forEach((code) => {
      const d = intent.decide({ now, record, onboardingComplete: true, roleOpen: true, verdict: { canApply: false, hold: false, reasons: [code] }, isAu: true });
      expect(d.outcome).toBe('not_eligible:' + reasons[code]);
      expect(d.notice).toBe(intent.MESSAGES[reasons[code]]);
    });
    Object.keys(intent.MESSAGES).forEach((key) => {
      const m = intent.MESSAGES[key];
      const text = m.title + ' ' + m.body;
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toMatch(/don.t (currently )?qualify|not qualified/i);
      expect(text).not.toMatch(/Parramatta|Dubbo|\(FAKE\)|wp22/);
      expect(auDoctorText.violations(text), key).toEqual([]);
    });
    expect(intent.MESSAGES.closed.title).toBe('That role has just closed');
  });

  it('a newer click replaces an older one; the same click never un-consumes a used intent', () => {
    const used = intent.consumed(record, 'opened', now);
    expect(intent.shouldReplace(used, { job: record.job, at: record.at }, now)).toBe(false);
    expect(intent.shouldReplace(used, { job: DPA_OPEN, at: now }, now)).toBe(true);
    expect(intent.shouldReplace(null, { job: DPA_OPEN, at: now }, now)).toBe(true);
    expect(intent.shouldReplace(record, { job: '<bad>', at: now + 5 }, now)).toBe(false);
  });
});

// ── every hop, for a brand-new doctor ───────────────────────────────────────

describe('a brand-new visitor: Apply now -> sign-up -> onboarding -> that job open', () => {
  let email, userId, jar;

  it('hop 1: "Apply now" keeps the job in a signed, HttpOnly cookie and goes to sign-up', async () => {
    const res = await applyNow(NON_DPA_VR);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/signin?signup=1&next=/pages/career');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const set = [].concat(res.headers['set-cookie']);
    const main = set.filter((l) => l.indexOf(intent.COOKIE_NAME + '=') === 0)[0];
    const flag = set.filter((l) => l.indexOf(intent.FLAG_COOKIE_NAME + '=') === 0)[0];
    expect(main).toMatch(/HttpOnly/);
    expect(main).toMatch(/SameSite=Lax/);
    expect(main).toMatch(/Max-Age=1209600/);
    expect(flag).toBe(intent.FLAG_COOKIE_NAME + '=1; Path=/; SameSite=Lax; Max-Age=1209600');
    // The cookie names the public role id only: nothing about the practice.
    const payload = JSON.parse(Buffer.from(decodeURIComponent(main.split(';')[0].split('=')[1]).split('.')[0], 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['at', 'job']);
    expect(payload.job).toBe(NON_DPA_VR);
    jar = cookiesFrom(res);
    // Nothing is stored for anyone yet.
    expect(rows('runtime_kv').length).toBe(0);
  });

  it('hop 2: signing up moves it onto the account and tells staff in one timeline line', async () => {
    email = 'new.applicant.' + Date.now() + '@gplink-test.local';
    const res = await h.post('/api/auth/signup', { firstName: 'Test', lastName: 'Applicant', email, countryDial: '+61', phoneNumber: '400000001', password: STRONG_PASSWORD }, { cookie: jar });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    userId = h.emu.authUsers.find((u) => u.email === email).id;
    const names = setCookieNames(res);
    expect(names).toContain('gp_session');
    // The browser's copy is cleared; the flag stays so the app knows to ask.
    const cleared = [].concat(res.headers['set-cookie']).filter((l) => l.indexOf(intent.COOKIE_NAME + '=;') === 0)[0];
    expect(cleared).toMatch(/Max-Age=0/);
    jar = cookiesFrom(res, jar);
    expect(jar).toContain(intent.FLAG_COOKIE_NAME + '=1');
    expect(jar).not.toContain(intent.COOKIE_NAME + '=ey');

    const rec = kv(userId);
    expect(rec.value.job).toBe(NON_DPA_VR);
    expect(rec.value.status).toBe('pending');
    expect(rec.value.source).toBe('public_job_page_signup');
    expect(Date.parse(rec.expires_at) - Date.now()).toBeGreaterThan(13 * DAY);

    await wait(250);
    const theCase = rows('registration_cases').filter((c) => c.user_id === userId)[0];
    expect(theCase).toBeTruthy();
    const lines = timeline(theCase.id);
    expect(lines.length).toBe(1);
    expect(lines[0].detail).toBe('Pressed "Apply now" on: Non-DPA - Parramatta - Mixed Billing (Test Practice 1 (FAKE)). Nothing has been applied for yet.');
    expect(lines[0].event_type).toBe('note');
    expect(kv(userId).value.loggedAt).toBeGreaterThan(0);
  });

  it('hop 3: before onboarding is finished nothing happens and nothing is used up', async () => {
    const res = await claim(jar);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, action: 'wait' });
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(kv(userId).value.status).toBe('pending');
    expect(setCookieNames(res)).not.toContain(intent.FLAG_COOKIE_NAME);
    expect(rows('gp_applications').length).toBe(0);
  });

  it('hop 4: once onboarding is finished the claim opens THAT job, and nothing is applied for', async () => {
    // The Australian branch finished (segment A, staff have not confirmed the
    // 19AB answer yet, so the doctor is limited to DPA roles): the role they
    // chose is not in a DPA. See the next block for the eligible case.
    const profile = rows('user_profiles').filter((p) => p.user_id === userId)[0] || null;
    const now = new Date().toISOString();
    const patch = { onboarding_completed_at: now };
    if (profile) Object.assign(profile, patch); else rows('user_profiles').push(Object.assign({ user_id: userId, email }, patch));
    const res = await claim(jar);
    // A brand-new doctor with nothing recorded is an overseas doctor: the
    // role is not in a DPA, so they are told why instead.
    expect(res.json.action).toBe('not_eligible');
    expect(res.json.notice).toEqual(intent.MESSAGES.legacy_dpa_restricted);
    expect(kv(userId).value.status).toBe('consumed');
  });
});

describe('the whole way for a role the doctor can have', () => {
  it('Australian VR doctor (staff-confirmed): signs in, the role opens once, and never again', async () => {
    const d = add('au_vr');
    const first = await applyNow(NON_DPA_VR);
    const browser = cookiesFrom(first);
    // Signed in (by whatever route) with the cookie still in the browser:
    // the claim itself moves it onto the account first.
    const res = await claim(cookiesFrom(first, d.cookie));
    expect(res.json).toEqual({ ok: true, action: 'open', go: '/pages/job?id=' + encodeURIComponent(NON_DPA_VR) });
    expect(browser).toContain(intent.COOKIE_NAME);
    const rec = kv(d.userId).value;
    expect(rec.status).toBe('consumed');
    expect(rec.outcome).toBe('opened');
    // The browser is told to stop asking, and its own copy is cleared.
    const cleared = [].concat(res.headers['set-cookie']).map((l) => l.split(';')[0]);
    expect(cleared).toContain(intent.COOKIE_NAME + '=');
    expect(cleared).toContain(intent.FLAG_COOKIE_NAME + '=');
    // Consumed once.
    const again = await claim(d.cookie + '; ' + intent.FLAG_COOKIE_NAME + '=1');
    expect(again.json).toEqual({ ok: true, action: 'none' });
    // Even when the browser replays the very same cookie.
    const replay = await claim(cookiesFrom(first, d.cookie));
    expect(replay.json).toEqual({ ok: true, action: 'none' });
    expect(kv(d.userId).value.status).toBe('consumed');
    // It never applies for anyone.
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId).length).toBe(0);
    expect(timeline(d.caseId).length).toBe(1);
  });

  it('an existing signed-in doctor: straight onto the account, then the job', async () => {
    const d = add('au_vr');
    const res = await applyNow(DPA_OPEN, { cookie: d.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/pages/career');
    expect(setCookieNames(res)).toEqual([intent.FLAG_COOKIE_NAME]);
    expect(kv(d.userId).value.source).toBe('public_job_page_signed_in');
    const out = await claim(cookiesFrom(res, d.cookie));
    expect(out.json).toEqual({ ok: true, action: 'open', go: '/pages/job?id=' + encodeURIComponent(DPA_OPEN) });
    await wait(100);
    expect(timeline(d.caseId).length).toBe(1);
    expect(timeline(d.caseId)[0].detail).toContain('DPA - Dubbo - Bulk Billing (Test Practice 2 (FAKE))');
  });

  it('an overseas doctor (nothing recorded), switch on: a DPA role opens', async () => {
    const d = add('overseas_null');
    const res = await applyNow(DPA_OPEN, { cookie: d.cookie });
    const out = await claim(cookiesFrom(res, d.cookie));
    expect(out.json).toEqual({ ok: true, action: 'open', go: '/pages/job?id=' + encodeURIComponent(DPA_OPEN) });
  });

  it('pressing "Apply now" on a second role replaces the first', async () => {
    const d = add('au_vr');
    await applyNow(NON_DPA_VR, { cookie: d.cookie });
    await wait(5);
    await applyNow(DPA_OPEN, { cookie: d.cookie });
    expect(kv(d.userId).value.job).toBe(DPA_OPEN);
    const out = await claim(d.cookie + '; ' + intent.FLAG_COOKIE_NAME + '=1');
    expect(out.json.go).toBe('/pages/job?id=' + encodeURIComponent(DPA_OPEN));
  });
});

// ── edges ───────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('the role closed in the meantime: "That role has just closed", used up', async () => {
    const d = add('au_vr');
    stored(d.userId, NON_DPA_VR);
    rows('career_roles').filter((r) => r.provider_role_id === 'wp22-role-1')[0].job_status = 'filled';
    resetBoard();
    try {
      const out = await claim(d.cookie);
      expect(out.json).toEqual({ ok: true, action: 'closed', notice: { title: 'That role has just closed', body: 'The role you chose from our job board is no longer open. Here are the roles open to you now.' } });
      expect(kv(d.userId).value.outcome).toBe('role_closed');
      expect((await claim(d.cookie)).json).toEqual({ ok: true, action: 'none' });
    } finally {
      rows('career_roles').filter((r) => r.provider_role_id === 'wp22-role-1')[0].job_status = 'open';
    }
  });

  it('"Apply now" on a role that is not on the board stores nothing and shows the job page\'s own "no longer available"', async () => {
    for (const id of [CLOSED, 'internal_ats:never-existed']) {
      const res = await applyNow(id);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/jobs/view?id=' + encodeURIComponent(id));
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const bad = await applyNow('<script>alert(1)</script>');
    expect(bad.headers.location).toBe('/jobs');
    expect(bad.headers['set-cookie']).toBeUndefined();
  });

  it('Australian doctor limited to DPA roles + a role that is not in one: told why, the role not described', async () => {
    const d = add('au_vr', { selfDeclared: true, credentials: { moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null } });
    stored(d.userId, NON_DPA_VR);
    const out = await claim(d.cookie);
    expect(out.json.action).toBe('not_eligible');
    expect(out.json.go).toBeUndefined();
    expect(out.json.notice).toEqual(intent.MESSAGES.au_dpa_restricted);
    expect(JSON.stringify(out.json)).not.toMatch(/Parramatta|\(FAKE\)|wp22-role/);
    expect(kv(d.userId).value.outcome).toBe('not_eligible:au_dpa_restricted');
  });

  it('the same doctor + a role whose DPA status is unknown: its own sentence', async () => {
    const d = add('au_vr', { selfDeclared: true, credentials: { moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null } });
    stored(d.userId, DPA_UNKNOWN);
    const out = await claim(d.cookie);
    expect(out.json.notice).toEqual(intent.MESSAGES.au_role_dpa_unknown);
  });

  it('an overseas doctor + a role that is not in a DPA: told why', async () => {
    const d = add('overseas_null');
    stored(d.userId, NON_DPA_VR);
    const out = await claim(d.cookie);
    expect(out.json.action).toBe('not_eligible');
    expect(out.json.notice).toEqual(intent.MESSAGES.legacy_dpa_restricted);
  });

  it('a held doctor (segment C): the holding message, the intent KEPT for staff, and staff are flagged', async () => {
    const d = add('au_non_vr');
    const res = await applyNow(DPA_OPEN, { cookie: d.cookie });
    const out = await claim(cookiesFrom(res, d.cookie));
    expect(out.json).toEqual({ ok: true, action: 'held', notice: intent.MESSAGES.held });
    const rec = kv(d.userId).value;
    expect(rec.status).toBe('pending');
    expect(rec.job).toBe(DPA_OPEN);
    await wait(150);
    expect(timeline(d.caseId).length).toBe(1);
    expect(rows('registration_tasks').filter((x) => x.case_id === d.caseId && x.task_type === 'segment_review').length).toBe(1);
    // The browser stops asking until the next sign-in.
    expect([].concat(out.headers['set-cookie']).some((l) => l.indexOf(intent.FLAG_COOKIE_NAME + '=;') === 0)).toBe(true);
    // Still one line on the timeline however often they come back.
    await claim(d.cookie);
    await wait(100);
    expect(timeline(d.caseId).length).toBe(1);
  });

  it('an intent older than 14 days is dead', async () => {
    const d = add('au_vr');
    stored(d.userId, NON_DPA_VR, Date.now() - 15 * DAY);
    const out = await claim(d.cookie);
    expect(out.json).toEqual({ ok: true, action: 'none' });
    expect(kv(d.userId).value.status).toBe('pending');
  });

  it('an altered cookie is ignored at sign-up: nothing is stored', async () => {
    const res = await applyNow(NON_DPA_VR);
    const jar = cookiesFrom(res).replace(/(gp_apply_intent=[^;]{12})./, '$1X');
    const email = 'tamper.' + Date.now() + '@gplink-test.local';
    const up = await h.post('/api/auth/signup', { firstName: 'Test', lastName: 'Tamper', email, countryDial: '+61', phoneNumber: '400000002', password: STRONG_PASSWORD }, { cookie: jar });
    expect(up.json.ok).toBe(true);
    const userId = h.emu.authUsers.find((u) => u.email === email).id;
    expect(kv(userId)).toBeNull();
  });

  it('signing in on another device: the account holds it, so that browser is told to ask', async () => {
    const d = add('au_vr');
    stored(d.userId, DPA_OPEN);
    // (The database stub cannot issue a sign-in token with a user in it, so
    // this calls the function the three sign-in routes call.)
    const signedIn = await t.auAttachApplyIntentForTest({ userId: d.userId, email: d.email }, { readAccount: true });
    expect(signedIn.result).toEqual({ attached: false, pending: true });
    expect(signedIn.cookies).toEqual([intent.FLAG_COOKIE_NAME + '=1; Path=/; SameSite=Lax; Max-Age=1209600']);
    const none = await t.auAttachApplyIntentForTest({ userId: add('au_vr').userId, email: 'x@gplink-test.local' }, { readAccount: true });
    expect(none.result).toEqual({ attached: false, pending: false });
    expect(none.cookies).toEqual([]);
  });

  it('a staff "View as" session never uses up a doctor\'s intent', async () => {
    const d = add('au_vr');
    stored(d.userId, NON_DPA_VR);
    const payload = Buffer.from(JSON.stringify({ userProfile: { email: d.email, supabaseUserId: d.userId, _impersonatedBy: h.SUPER_EMAIL }, expiresAt: Date.now() + 3600000 }), 'utf8').toString('base64url');
    const cookie = 'gp_session=' + encodeURIComponent(payload + '.' + require('crypto').createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex'));
    const out = await h.post('/api/career/apply-intent/claim', {}, { cookie });
    expect(out.json).toEqual({ ok: true, action: 'none' });
    expect(kv(d.userId).value.status).toBe('pending');
    const viaLink = await applyNow(DPA_OPEN, { cookie });
    expect(viaLink.headers.location).toBe('/pages/signin?signup=1&next=/pages/career');
    expect(kv(d.userId).value.job).toBe(NON_DPA_VR);
  });

  it('signed out: the claim is refused', async () => {
    const out = await h.post('/api/career/apply-intent/claim', {}, {});
    expect(out.status).toBe(401);
  });
});

// ── switch off ──────────────────────────────────────────────────────────────

describe('switch OFF: "Apply now" is exactly today\'s', () => {
  it('/jobs/apply is not an address, the claim does not exist, and nothing is read', async () => {
    h.setSwitch(false);
    const d = add('overseas_null');
    stored(d.userId, DPA_OPEN);
    h.emu.requests.length = 0;
    const unknown = await h.get('/jobs/no-such-address');
    const res = await applyNow(DPA_OPEN, { cookie: d.cookie });
    expect(res.status).toBe(unknown.status);
    expect(res.headers['set-cookie']).toBeUndefined();
    const out = await claim(d.cookie + '; ' + intent.FLAG_COOKIE_NAME + '=1');
    expect(out.status).toBe(404);
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv').length).toBe(0);
    expect(kv(d.userId).value.status).toBe('pending');
  });

  it('a sign-up carrying a cookie from before stores nothing and sets no extra cookie', async () => {
    const res = await applyNow(NON_DPA_VR);
    const jar = cookiesFrom(res);
    h.setSwitch(false);
    h.emu.requests.length = 0;
    const email = 'off.' + Date.now() + '@gplink-test.local';
    const up = await h.post('/api/auth/signup', { firstName: 'Test', lastName: 'Off', email, countryDial: '+44', phoneNumber: '7000000001', password: STRONG_PASSWORD }, { cookie: jar });
    expect(up.json.ok).toBe(true);
    expect(up.json.redirectTo).toBe('/pages/onboarding');
    expect(setCookieNames(up)).toEqual(['gp_session']);
    const userId = h.emu.authUsers.find((u) => u.email === email).id;
    expect(kv(userId)).toBeNull();
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && String(r.query || r.url || '').indexOf('apply_intent') !== -1).length).toBe(0);
    await wait(150);
    expect(rows('task_timeline').filter((r) => r.title === intent.TIMELINE_MARKER && JSON.stringify(r).indexOf(userId) !== -1).length).toBe(0);
  });
});

describe('switch ON, no intent: a sign-up is what it was', () => {
  it('no cookie -> no runtime_kv request, no extra cookie, the same reply', async () => {
    h.emu.requests.length = 0;
    const email = 'plain.' + Date.now() + '@gplink-test.local';
    const up = await h.post('/api/auth/signup', { firstName: 'Test', lastName: 'Plain', email, countryDial: '+44', phoneNumber: '7000000002', password: STRONG_PASSWORD }, {});
    expect(up.json.ok).toBe(true);
    expect(up.json.redirectTo).toBe('/pages/onboarding');
    expect(setCookieNames(up)).toEqual(['gp_session']);
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && JSON.stringify(r).indexOf('apply_intent') !== -1).length).toBe(0);
  });
});

// ── page JS ─────────────────────────────────────────────────────────────────

describe('the app shell: asks only when flagged, opens the job, shows the notice', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app-shell.js'), 'utf8');
  const start = src.indexOf('var APPLY_INTENT_FLAG =');
  const end = src.indexOf('  function init() {', start);
  const block = src.slice(start, end);

  function run(cookie, reply) {
    const calls = { fetch: [], nav: [], notices: [] };
    const made = [];
    const el = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {}, appendChild(c) { this.children.push(c); }, textContent: '' });
    const sandbox = {
      document: {
        cookie,
        body: { appendChild(box) { calls.notices.push(box); } },
        getElementById: () => null,
        createElement: () => { const e = el(); made.push(e); return e; }
      },
      window: {
        sessionStorage: { getItem: () => null },
        fetch(url, init) { calls.fetch.push({ url, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) }); }
      },
      currentRoute: '/pages/index',
      navigateTo(route, opts) { calls.nav.push({ route, opts }); },
      String, Promise
    };
    vm.runInNewContext(block + '\napplyIntentCheck(); applyIntentCheck();', sandbox);
    return new Promise((resolve) => setTimeout(() => resolve({ calls, made }), 20));
  }

  it('the block exists and init runs it after the session answer', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(src).toContain('if (applyIntentRestartMark() === restartMark) applyIntentCheck();');
  });

  it('no flag cookie -> no request at all', async () => {
    const { calls } = await run('gp_other=1; theme=dark', { ok: true, action: 'open', go: '/pages/job?id=x' });
    expect(calls.fetch.length).toBe(0);
    expect(calls.nav.length).toBe(0);
  });

  it('flagged -> one POST, and "open" navigates to that job', async () => {
    const go = '/pages/job?id=' + encodeURIComponent(NON_DPA_VR);
    const { calls } = await run('a=1; gp_apply_intent_flag=1', { ok: true, action: 'open', go });
    expect(calls.fetch.length).toBe(1);
    expect(calls.fetch[0].url).toBe('/api/career/apply-intent/claim');
    expect(calls.fetch[0].init.method).toBe('POST');
    expect(calls.nav).toEqual([{ route: go, opts: { historyMode: 'replace', animate: false } }]);
    expect(calls.notices.length).toBe(0);
  });

  it('the welcome deck does not send the doctor back to the role list once the job has been opened (found on the local-stack walk)', async () => {
    const go = '/pages/job?id=' + encodeURIComponent(NON_DPA_VR);
    expect(src).toContain('window.gpApplyIntentOpenedRoute = data.go;');
    const walk = fs.readFileSync(path.join(ROOT, 'js', 'gp-walkthrough-shell.js'), 'utf8');
    const at = walk.indexOf("tellFrames('gp-shell-intro-done', { deck: 'welcome' });");
    const tail = walk.slice(at, at + 700);
    expect(tail.indexOf('if (window.gpApplyIntentOpenedRoute) return;')).toBeGreaterThan(0);
    expect(tail.indexOf('if (window.gpApplyIntentOpenedRoute) return;')).toBeLessThan(tail.indexOf("window.gpShellNavigate('/pages/career', { replace: true })"));
    const { calls } = await run('gp_apply_intent_flag=1', { ok: true, action: 'open', go });
    expect(calls.nav.length).toBe(1);
  });

  it('never follows an address that is not a job page', async () => {
    const { calls } = await run('gp_apply_intent_flag=1', { ok: true, action: 'open', go: 'https://evil.example/' });
    expect(calls.nav.length).toBe(0);
  });

  it('"closed" shows the notice over Careers; "wait" and "none" do nothing', async () => {
    const closed = await run('gp_apply_intent_flag=1', { ok: true, action: 'closed', notice: intent.MESSAGES.closed });
    expect(closed.calls.nav).toEqual([{ route: '/pages/career', opts: { historyMode: 'replace', animate: false } }]);
    expect(closed.calls.notices.length).toBe(1);
    expect(closed.made.map((e) => e.textContent)).toContain('That role has just closed');
    for (const action of ['wait', 'none']) {
      const r = await run('gp_apply_intent_flag=1', { ok: true, action });
      expect(r.calls.nav.length).toBe(0);
      expect(r.calls.notices.length).toBe(0);
    }
  });
});

describe('the match popup: an Australian doctor gets the consent sheet with the tick', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'match-popup.js'), 'utf8');

  it('the accept request is unchanged unless the doctor agreed', () => {
    const fn = src.slice(src.indexOf('function respond(applicationId, action, shareConsent) {'), src.indexOf('function readFileAsDataUrl'));
    const sent = [];
    const sandbox = { fetch(url, init) { sent.push({ url, body: init.body }); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }); }, JSON };
    vm.runInNewContext(fn + '\nrespond("app-1", "accept"); respond("app-1", "accept", null); respond("app-1", "accept", { agreed: true, version: "v1" });', sandbox);
    expect(sent[0].body).toBe('{"applicationId":"app-1","action":"accept"}');
    expect(sent[1].body).toBe('{"applicationId":"app-1","action":"accept"}');
    expect(JSON.parse(sent[2].body)).toEqual({ applicationId: 'app-1', action: 'accept', shareConsent: { agreed: true, version: 'v1' } });
  });

  it('the sheet opens only on the server\'s consent_required answer, and the button waits for the tick', () => {
    expect(src).toContain('result.status === 400 && result.body && result.body.code === "consent_required"');
    expect(src).toContain('openConsentPanel(result.body.shareConsent);');
    expect(src).toContain('data-gpmp-consent-go disabled>');
    expect(src).toContain('box.addEventListener("change", function () { goBtn.disabled = !box.checked; });');
    expect(src).toContain('submitAccept({ agreed: true, version: String(sheet.version) });');
    // The wording is the server's (lib/profile-share-consent.js), escaped.
    ['escapeHtml(sheet.tickLabel)', 'escapeHtml(sheet.body)', 'escapeHtml(sheet.footnote)'].forEach((s) => expect(src).toContain(s));
    // The first tap still sends no agreement: the server decides who needs one.
    expect(src).toContain('acceptEl.addEventListener("click", function () { submitAccept(); });');
  });

  it('the server sends the sheet with that answer, and accepts the agreement the sheet posts', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const at = server.indexOf("if (mrNeedsShareConsent && !profileShareConsent.parseDoctorConsent(mrBody).ok) {");
    expect(at).toBeGreaterThan(0);
    expect(server.slice(at, at + 1200)).toContain('shareConsent: mrJob ? profileShareConsent.doctorConsentSheet(');
    const consent = require('../lib/profile-share-consent.js');
    const sheet = consent.doctorConsentSheet({ practiceName: 'Test Metro Practice (FAKE)' });
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: true, version: String(sheet.version) } }).ok).toBe(true);
    expect(consent.parseDoctorConsent({ applicationId: 'x', action: 'accept' }).ok).toBe(false);
    expect(sheet.tickLabel).toBe('I agree to GP Link sending my details to Test Metro Practice (FAKE) for this role.');
  });
});
