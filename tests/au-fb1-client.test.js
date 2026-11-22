// Australian GP build, fix bundle FB-1: the browser side of the walk-through
// findings D9, D10, D11, D12, D14, D23 and D26, plus the two pure libraries.
// There is no DOM here: the helper file is loaded with require, and page
// behaviour is checked by lifting the function out of the page source.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const auDoctor = require('../js/au-doctor.js');
const auDoctorSession = require('../lib/au-doctor-session.js');
const introSlides = require('../js/gp-intro-slides.js');

const careerHtml = read('pages/career.html');
const jobHtml = read('pages/job.html');
const signinHtml = read('pages/signin.html');
const onboardingJs = read('js/onboarding.js');
const shellJs = read('js/gp-walkthrough-shell.js');
const AU_DOCTOR_TAG = '/js/au-doctor.js?v=20261122b'; // WP-12 bumped it
const AU_LOCALISE_TAG = '/js/au-localise.js?v=20261122a';

function memoryStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] === undefined ? null : Array.from(m.keys())[i],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => Array.from(m.keys())
  };
}
const auSession = (over) => Object.assign({
  ok: true, authenticated: true, profile: { email: 'fb1.test@gplink-test.local' },
  auPathwayEnabled: true,
  auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true },
  auDoctor: { eligibilityVersion: 'aaaaaaaaaaaaaaaa', limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, onboardingComplete: true }
}, over || {});
const overseasSessionOn = { ok: true, authenticated: true, profile: {}, auPathwayEnabled: true, auPathway: { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true } };
const sessionOff = { ok: true, authenticated: true, profile: {} };

describe('FB-1 lib/au-doctor-session.js: the block the server sends', () => {
  const vr = { pathway: 'au_vr', isAu: true, launched: true, dpaRestricted: false, confirmed: true, needsStaffReview: false, roleFit: { vr: true, registrar: false, supervised: false }, hasRegistrationFlags: false, flagsReviewed: false };
  const caps = { active: 4, monthly: 6, interviewsMonthly: 6, strikeLock: 3 };
  const make = (p, extra) => auDoctorSession.buildAuDoctorSessionBlock(Object.assign({ userKey: 'u1', pathwayResult: p, caps, onboardingComplete: true, secret: 's3cret' }, extra || {}));

  it('is null for anyone who is not clearly on an Australian pathway', () => {
    expect(make(null)).toBeNull();
    expect(make({ pathway: 'overseas_esp', isAu: false })).toBeNull();
    expect(make(Object.assign({}, vr, { readFailed: true }))).toBeNull();
    expect(make(Object.assign({}, vr, { schemaMissing: true }))).toBeNull();
  });

  it('carries only the version, the limits and the onboarding answer', () => {
    const block = make(vr);
    expect(Object.keys(block).sort()).toEqual(['eligibilityVersion', 'limits', 'onboardingComplete']);
    expect(block.limits).toEqual({ active: 4, monthly: 6, interviewsMonthly: 6 });
    expect(block.eligibilityVersion).toHaveLength(auDoctorSession.VERSION_LENGTH);
  });

  it('the version moves with everything that decides which roles a doctor may see, and with the caps', () => {
    const base = make(vr).eligibilityVersion;
    const differs = (change, extra) => expect(make(Object.assign({}, vr, change), extra).eligibilityVersion, JSON.stringify(change || extra)).not.toBe(base);
    differs({ dpaRestricted: true });
    differs({ dpaRestricted: undefined }); // unknown reads as restricted
    differs({ pathway: 'au_restricted', launched: false });
    differs({ confirmed: false });
    differs({ needsStaffReview: true });
    differs({ roleFit: { vr: false, registrar: false, supervised: false } });
    differs({ hasRegistrationFlags: true });
    differs({}, { caps: { active: 5, monthly: 6, interviewsMonthly: 6 } });
    differs({}, { userKey: 'u2' });
    expect(make(Object.assign({}, vr)).eligibilityVersion).toBe(base); // stable
    expect(make(Object.assign({}, vr, { dpaRestricted: true })).eligibilityVersion)
      .toBe(make(Object.assign({}, vr, { dpaRestricted: null })).eligibilityVersion);
  });

  it('is keyed: it cannot be recomputed without the server secret, and is empty with none', () => {
    expect(make(vr, { secret: 'another' }).eligibilityVersion).not.toBe(make(vr).eligibilityVersion);
    expect(make(vr, { secret: '' }).eligibilityVersion).toBe('');
  });
});

describe('FB-1 js/au-doctor.js: reading the session', () => {
  it('only a clear "switch on, Australian pathway" session gives details', () => {
    // WP-12 added `journey` (the doctor's stage and four steps). A session
    // with no auJourney reads as the first rung.
    const details = auDoctor.fromSession(auSession());
    expect(details).toMatchObject({
      pathway: 'au_vr', launched: true, eligibilityVersion: 'aaaaaaaaaaaaaaaa',
      limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, onboardingComplete: true
    });
    expect(Object.keys(details).sort()).toEqual(['eligibilityVersion', 'journey', 'launched', 'limits', 'onboardingComplete', 'pathway']);
    expect(details.journey).toMatchObject({ stage: 'placement', placed: false, entryRoute: '/pages/career' });
    [null, {}, sessionOff, overseasSessionOn,
      auSession({ auPathwayEnabled: false }),
      auSession({ auPathway: { pathway: 'made_up', isAu: true } }),
      auSession({ auPathway: { pathway: 'overseas_esp', isAu: true } })
    ].forEach((s) => expect(auDoctor.fromSession(s)).toBeNull());
  });

  it('missing limits read as unknown (null), never as a number; only a definite false means onboarding is unfinished', () => {
    const noBlock = auDoctor.fromSession(auSession({ auDoctor: undefined }));
    expect(noBlock.limits).toBeNull();
    expect(noBlock.onboardingComplete).toBe(true);
    expect(noBlock.eligibilityVersion).toBe('');
    expect(auDoctor.fromSession(auSession({ auDoctor: { limits: { active: 4, monthly: 'six', interviewsMonthly: 6 } } })).limits).toBeNull();
    expect(auDoctor.fromSession(auSession({ auDoctor: { onboardingComplete: false } })).onboardingComplete).toBe(false);
  });

  it('cached() reads the session js/gp-cache.js saved in this tab, with no request', () => {
    const session = memoryStore({ 'gpc:/api/auth/session': JSON.stringify({ data: auSession(), ts: 1 }) });
    expect(auDoctor.cached({ session, local: memoryStore() }).limits.active).toBe(4);
    expect(auDoctor.cached({ session: memoryStore({ 'gpc:/api/auth/session': JSON.stringify({ data: overseasSessionOn, ts: 1 }) }), local: memoryStore() })).toBeNull();
    expect(auDoctor.cached({ session: memoryStore({ 'gpc:/api/auth/session': 'not json' }), local: memoryStore() })).toBeNull();
    expect(auDoctor.cached({ session: memoryStore(), local: memoryStore() })).toBeNull();
  });

  it('refresh() asks the server past every cache, saves the answer for the tab and keeps the device hint', async () => {
    const calls = [];
    const stores = { session: memoryStore(), local: memoryStore() };
    const fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, json: () => Promise.resolve(auSession()) }); };
    const result = await auDoctor.refresh({ fetch, storages: stores });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/auth/session');
    expect(calls[0].init.cache).toBe('no-store');
    expect(result.ok).toBe(true);
    expect(result.info.limits.monthly).toBe(6);
    expect(JSON.parse(stores.session.getItem('gpc:/api/auth/session')).data.auDoctor.eligibilityVersion).toBe('aaaaaaaaaaaaaaaa');
    expect(stores.local.getItem('gp_au_pathway_hint')).toBe('1');

    const gone = await auDoctor.refresh({ fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(overseasSessionOn) }), storages: stores });
    expect(gone).toEqual({ ok: true, info: null });
    expect(stores.local.getItem('gp_au_pathway_hint')).toBeNull();

    expect(await auDoctor.refresh({ fetch: () => Promise.reject(new Error('offline')), storages: stores })).toEqual({ ok: false, info: null });
    expect(await auDoctor.refresh({ fetch: () => Promise.resolve({ ok: false }), storages: stores })).toEqual({ ok: false, info: null });
  });
});

describe('FB-1 D9: saved role lists are thrown away when eligibility changes', () => {
  const seeded = () => ({
    local: memoryStore({
      gp_career_roles_cache: '{"roles":[1]}',
      'gp_career_role_detail:internal_ats:one': '{"role":{}}',
      gp_career_state: '{"savedJobs":[]}',
      gp_au_eligibility_version: 'aaaaaaaaaaaaaaaa'
    }),
    session: memoryStore({
      'gpc:/api/career/roles': '{"data":{}}',
      'gpc:/api/career/role?id=one': '{"data":{}}',
      'gpc:/api/career/applications': '{"data":{}}',
      'gpc:/api/auth/session': '{"data":{}}'
    })
  });
  const info = (version) => auDoctor.fromSession(auSession({ auDoctor: { eligibilityVersion: version, limits: { active: 4, monthly: 6, interviewsMonthly: 6 } } }));

  it('same version: nothing is touched', () => {
    const s = seeded();
    expect(auDoctor.syncEligibility(info('aaaaaaaaaaaaaaaa'), s)).toEqual({ changed: false, purged: 0 });
    expect(s.local.getItem('gp_career_roles_cache')).toBeTruthy();
    expect(s.session.getItem('gpc:/api/career/roles')).toBeTruthy();
  });

  it('a different version: every saved role list and role detail goes, nothing else, and the new version is stored', () => {
    const s = seeded();
    const out = auDoctor.syncEligibility(info('bbbbbbbbbbbbbbbb'), s);
    expect(out).toEqual({ changed: true, purged: 4 });
    expect(s.local.getItem('gp_career_roles_cache')).toBeNull();
    expect(s.local.getItem('gp_career_role_detail:internal_ats:one')).toBeNull();
    expect(s.session.getItem('gpc:/api/career/roles')).toBeNull();
    expect(s.session.getItem('gpc:/api/career/role?id=one')).toBeNull();
    expect(s.local.getItem('gp_career_state')).toBeTruthy();
    expect(s.session.getItem('gpc:/api/career/applications')).toBeTruthy();
    expect(s.session.getItem('gpc:/api/auth/session')).toBeTruthy();
    expect(s.local.getItem('gp_au_eligibility_version')).toBe('bbbbbbbbbbbbbbbb');
    // The next load with the same version is quiet again.
    expect(auDoctor.syncEligibility(info('bbbbbbbbbbbbbbbb'), s).changed).toBe(false);
  });

  it('no version stored yet, or none from the server: treated as changed (read the list from the network)', () => {
    const first = seeded();
    first.local.removeItem('gp_au_eligibility_version');
    expect(auDoctor.syncEligibility(info('aaaaaaaaaaaaaaaa'), first).changed).toBe(true);
    const unknown = seeded();
    expect(auDoctor.syncEligibility(info(''), unknown).changed).toBe(true);
    expect(unknown.local.getItem('gp_au_eligibility_version')).toBeNull();
  });

  it('not an Australian doctor: the stored version is dropped and no saved list is touched', () => {
    const s = seeded();
    expect(auDoctor.syncEligibility(null, s)).toEqual({ changed: false, purged: 0 });
    expect(s.local.getItem('gp_au_eligibility_version')).toBeNull();
    expect(s.local.getItem('gp_career_roles_cache')).toBeTruthy();
  });

  it('the careers page waits for the check before reading the role list, and reads the network when it changed', () => {
    const start = careerHtml.indexOf('async function loadRemoteRoles(options = {}) {');
    const body = careerHtml.slice(start, careerHtml.indexOf('// AU-HOLD:START', start));
    expect(body).toContain('const auBoot = await auDoctorBoot();');
    expect(body.indexOf('await auDoctorBoot()')).toBeLessThan(body.indexOf('gpCacheFetch("/api/career/roles"'));
    expect(body).toContain('gpCacheFetch("/api/career/roles", { forceNetwork: true })');
    // With no helper on the page (every doctor who is not Australian) the check asks nothing.
    const boot = careerHtml.slice(careerHtml.indexOf('function auDoctorBoot() {'), careerHtml.indexOf('function auDoctorLateStart('));
    expect(boot).toMatch(/function auDoctorBoot\(\) \{\s*if \(!window\.GPAuDoctor\) return Promise\.resolve\(null\);/);
    expect(boot).toContain('helper.refresh()');
    expect(boot).toContain('helper.syncEligibility(result.info)');
    // Could not ask: do not trust a saved list.
    expect(boot).toMatch(/result\.ok !== true\) \{[\s\S]{0,260}readFromNetwork: true/);
  });

  it('the job page never uses its 10-minute saved copy of a role for an Australian doctor', () => {
    const fn = jobHtml.slice(jobHtml.indexOf('function readCachedRoleDetail(roleId) {'), jobHtml.indexOf('function writeCachedRoleDetail('));
    expect(fn).toMatch(/try \{[\s\S]{0,420}if \(auDoctorOnPage\(\)\) return null;[\s\S]*localStorage\.getItem\(ROLE_DETAIL_CACHE_PREFIX \+ roleId\)/);
    // The deliberate rule for everyone else is still there.
    expect(fn).toContain('if (parsed.role.match || parsed.role.matchAccepted || parsed.role.applied) return null;');
    expect(fn).toContain('Date.now() - fetchedAt <= ROLE_CACHE_TTL_MS ? parsed.role : null');
  });
});

describe('FB-1 D10: every limit an Australian doctor reads comes from their own limits', () => {
  it('limitsCopy builds each sentence from the three numbers', () => {
    const c = auDoctor.limitsCopy({ active: 4, monthly: 6, interviewsMonthly: 5 });
    expect(c.activeHeading).toBe('4 live applications at a time');
    expect(c.monthlyHeading).toBe('6 positions a month');
    expect(c.activeBody).toContain('You can have 4 applications in play at once.');
    expect(c.monthlyBody).toContain('you can apply for 6 positions in total');
    expect(c.whyBody).toContain('Keeping each doctor to 4 live applications');
    expect(c.slideNote).toBe('You can have 4 applications in play at once, and 6 in a calendar month. Withdrawing from a position is final.');
    expect(c.applyIntro).toContain('up to 5 positions per month');
    expect(c.applyIntroMatch).toContain('up to 5 positions per month');
    expect(c.activeCapTitle).toBe('You already have 4 live applications');
    expect(c.activeCapBody('accept this match')).toBe('You can have 4 applications in play at a time. To accept this match, withdraw one of your current applications first.');
    expect(c.monthlyCapTitle).toBe("That's your 6 positions for this month");
    expect(c.monthlyCapBody).toContain('6 positions each calendar month');
    expect(c.withdrawnBlurb).toContain('towards your 4 live applications');
    // No sentence still carries a number written for the other caps.
    const all = Object.keys(c).map((k) => (typeof c[k] === 'function' ? c[k]('apply') : String(c[k]))).join(' ');
    expect(all).not.toMatch(/\b(two|three|couple)\b/i);
    expect(all).not.toMatch(/\b[23] (live|positions|applications|interviews)\b/);
  });

  it('unknown limits give no copy at all, so a page keeps its own wording rather than print a hole', () => {
    [null, undefined, {}, { active: 4, monthly: 6 }, { active: 0, monthly: 6, interviewsMonthly: 6 }, { active: '4', monthly: 6, interviewsMonthly: 6 }]
      .forEach((l) => expect(auDoctor.limitsCopy(l)).toBeNull());
  });

  it('welcome slide: the Australian sentence when the shell passes one, the original sentence otherwise', () => {
    const ORIGINAL = 'You can have two applications in play at once, and three in a calendar month. Withdrawing from a position is final.';
    const notes = (ctx) => introSlides.buildWelcomeSlides(ctx).map((s) => s.note).filter(Boolean);
    expect(notes({ lastName: 'Test' })).toEqual([ORIGINAL]);
    expect(notes({ lastName: 'Test', limitsNote: '' })).toEqual([ORIGINAL]);
    expect(notes(null)).toEqual([ORIGINAL]);
    const au = auDoctor.limitsCopy({ active: 4, monthly: 6, interviewsMonthly: 6 }).slideNote;
    expect(notes({ lastName: 'Test', limitsNote: au })).toEqual([au]);
    // Nothing else on the slides moves.
    const strip = (list) => list.map((s) => Object.assign({}, s, { note: undefined }));
    expect(strip(introSlides.buildWelcomeSlides({ lastName: 'Test', limitsNote: au }))).toEqual(strip(introSlides.buildWelcomeSlides({ lastName: 'Test' })));
  });

  it('the shell only works the sentence out for a device that knows the doctor is Australian', () => {
    // WP-12 replaced auLimitsNote() with auDeckContext(): the same guard, now
    // answering with everything the decks need for an Australian doctor.
    const fn = shellJs.slice(shellJs.indexOf('function auCandidate() {'), shellJs.indexOf('function slideContext() {'));
    expect(fn).toContain("localStorage.getItem('gp_au_pathway_hint') === '1'");
    expect(fn).toMatch(/if \(!auCandidate\(\)\) \{ finish\(null\); return; \}/);
    expect(fn.indexOf('if (!auCandidate()) { finish(null); return; }')).toBeLessThan(fn.indexOf("document.createElement('script')"));
    expect(shellJs).toContain("var AU_DOCTOR_SCRIPT = '" + AU_DOCTOR_TAG + "';");
  });

  it('careers and job pages: the Australian copy is used when there is any, and the original strings are byte-for-byte still there', () => {
    [
      '<span>2 live applications at a time</span>',
      "You can have two applications in play at once. To apply for a third, withdraw one of your current applications first — we'll show you which ones they are.",
      '<span>3 positions a month</span>',
      'Across a calendar month you can apply for three positions in total.',
      'Keeping each doctor to a couple of live applications',
      '"That\'s your 3 positions for this month"',
      '"You can apply for three positions each calendar month. Your allowance resets at the start of next month."',
      '"You already have 2 live applications"',
      '"You withdrew this application. It no longer counts towards your 2 live applications."',
      "You can interview for up to 3 positions per month — so accept the roles you're genuinely serious about."
    ].forEach((text) => expect(careerHtml, text).toContain(text));
    [
      "<p id=\"applyConfirmIntro\">You can interview for up to 3 positions per month — so accept the roles you're genuinely serious about.</p>",
      '"That\'s your 3 positions for this month"',
      '"You already have 2 live applications"',
      '"You can have two applications in play at a time. To apply for this position, withdraw one of your current applications first."',
      '"This puts you in front of the practice for an interview. You can interview for up to 3 positions per month, so use it on the ones you\'re genuinely serious about."'
    ].forEach((text) => expect(jobHtml, text).toContain(text));

    expect(careerHtml).toContain('title: auCapCopy ? auCapCopy.activeCapTitle : "You already have 2 live applications"');
    expect(careerHtml).toContain('auApplyLimitsCopy(); // AU-FB1 (D10): no effect for an overseas doctor');
    expect(careerHtml).toMatch(/function auApplyLimitsCopy\(\) \{\s*const copy = auDoctorCopy\(\);\s*if \(!copy\) return;/);
    expect(jobHtml).toMatch(/applyConfirmIntroEl\.textContent = auApplyCopy\s*\? \(activeMatch \? auApplyCopy\.applyIntroMatch : auApplyCopy\.applyIntro\)/);
  });
});

describe('FB-1: the helper file is only ever loaded for an Australian doctor', () => {
  // WP-12: the same guard now writes two files, the helper and js/au-localise.js
  // (the phrase guard for the shared screens). Still nothing for anyone else.
  const LOADER = "<script>(function(){try{var au=localStorage.getItem(\"gp_au_pathway_hint\")===\"1\";if(!au){var raw=sessionStorage.getItem(\"gpc:/api/auth/session\");au=!!raw&&raw.indexOf('\"isAu\":true')!==-1;}if(au)document.write('<script src=\"" + AU_DOCTOR_TAG + "\"><\\/script><script src=\"" + AU_LOCALISE_TAG + "\"><\\/script>');}catch(e){}})();</script>";

  it('careers and job pages add it behind the same guard, and never with a plain script tag', () => {
    [careerHtml, jobHtml].forEach((html) => {
      expect(html).toContain(LOADER);
      expect(html.split(LOADER)).toHaveLength(2);
      expect(html.split(LOADER).join('')).not.toMatch(/<script src="[^"]*au-doctor\.js/);
    });
    // WP-12: the shell, Account, Support and the application, offer,
    // interview and area pages now add it too, behind the very same guard
    // (the shell's also says "this is the shell" first). Never a plain tag.
    ['pages/account.html', 'pages/messages.html', 'pages/offer-review.html', 'pages/application-detail.html',
      'pages/secure-interview.html', 'pages/confirm-call.html', 'pages/area-guide.html'].forEach((p) => {
      const html = read(p);
      expect(html, p).toContain(LOADER);
      expect(html.split(LOADER), p).toHaveLength(2);
      expect(html.split(LOADER).join(''), p).not.toMatch(/<script src="[^"]*au-(doctor|localise)\.js/);
    });
    const shellLoader = LOADER.replace("if(au)document.write('", "if(au){window.__gpAuShell=true;document.write('").replace("');}catch(e){}})();", "');}}catch(e){}})();");
    expect(read('pages/app-shell.html')).toContain(shellLoader);
    expect(read('pages/app-shell.html').split(shellLoader).join('')).not.toMatch(/<script src="[^"]*au-(doctor|localise)\.js/);
    ['pages/index.html', 'pages/my-documents.html', 'pages/onboarding.html', 'pages/signin.html',
      'pages/index-au.html', 'pages/prestart.html', 'pages/pbs-au.html', 'pages/my-documents-au.html']
      .forEach((p) => expect(read(p), p).not.toContain('au-doctor.js'));
  });

  it('the guard says "no" for a doctor who is not Australian, with the switch on or off', () => {
    const guard = (local, session) => {
      let wrote = '';
      const fn = new Function('localStorage', 'sessionStorage', 'document', LOADER.replace(/^<script>/, '').replace(/<\/script>$/, ''));
      fn(local, session, { write: (s) => { wrote = s; } });
      return wrote;
    };
    const cache = (payload) => memoryStore({ 'gpc:/api/auth/session': JSON.stringify({ data: payload, ts: 1 }) });
    expect(guard(memoryStore(), cache(sessionOff))).toBe('');
    expect(guard(memoryStore(), cache(overseasSessionOn))).toBe('');
    expect(guard(memoryStore(), memoryStore())).toBe('');
    expect(guard(memoryStore(), cache(auSession()))).toContain(AU_DOCTOR_TAG);
    expect(guard(memoryStore({ gp_au_pathway_hint: '1' }), memoryStore())).toContain(AU_DOCTOR_TAG);
  });

  it('the service worker does not precache it (that would be a request from every browser), and the version in the file matches the pages', () => {
    expect(read('sw.js')).not.toContain('au-doctor.js');
    expect(read('js/au-doctor.js')).toContain(AU_DOCTOR_TAG);
    expect(careerHtml).toContain('tag.src = "' + AU_DOCTOR_TAG + '";');
  });
});

describe('FB-1 D11: a sample role is never stored as a saved job', () => {
  const ids = Array.from(careerHtml.slice(careerHtml.indexOf('const FALLBACK_ROLE_DATA = ['), careerHtml.indexOf('let roleData =')).matchAll(/^\s{8}id: "([^"]+)",$/gm)).map((m) => m[1]);

  it('the sample list still starts with the role the walk found in Saved Jobs', () => {
    expect(ids[0]).toBe('harbourline-medical');
    expect(ids.length).toBeGreaterThan(1);
  });

  it('what is written to gp_career_state has no sample saved job; real saved jobs and the screen are untouched', () => {
    const src = careerHtml.slice(careerHtml.indexOf('function withoutSampleSavedJobs(state) {'), careerHtml.indexOf('function persistCareerState() {'));
    const withoutSampleSavedJobs = new Function('SAMPLE_ROLE_IDS', src + '\nreturn withoutSampleSavedJobs;')(new Set(ids));
    const inMemory = { activeView: 'browse', savedJobs: [{ id: 'harbourline-medical' }, { id: 'internal_ats:real-role' }, { id: ids[1] }], applications: [{ id: 'a1' }] };
    const stored = withoutSampleSavedJobs(inMemory);
    expect(stored.savedJobs).toEqual([{ id: 'internal_ats:real-role' }]);
    expect(stored.applications).toEqual([{ id: 'a1' }]);
    expect(inMemory.savedJobs).toHaveLength(3); // the page's own state is not changed
    const clean = { savedJobs: [{ id: 'internal_ats:real-role' }] };
    expect(withoutSampleSavedJobs(clean)).toBe(clean); // nothing to do: the very same object
    expect(withoutSampleSavedJobs({ savedJobs: [] }).savedJobs).toEqual([]);
    expect(withoutSampleSavedJobs(null)).toBeNull();

    const persist = careerHtml.slice(careerHtml.indexOf('function persistCareerState() {'), careerHtml.indexOf('// "Where am I" strip in the masthead'));
    expect(persist).toContain('localStorage.setItem(CAREER_STATE_KEY, JSON.stringify(withoutSampleSavedJobs(careerState)));');
    expect(careerHtml).toContain('const SAMPLE_ROLE_IDS = new Set(FALLBACK_ROLE_DATA.map((role) => role && role.id).filter(Boolean));');
    // Nothing else writes the careers state from this page.
    expect(careerHtml.match(/localStorage\.setItem\(CAREER_STATE_KEY/g)).toHaveLength(1);
  });

  it('a held Australian doctor (no roles sent) has the saved state re-read against the empty list, as every other load does', () => {
    const hold = careerHtml.slice(careerHtml.indexOf('if (payload.auHold && payload.auHold.held === true) {'), careerHtml.indexOf('hideAuHoldState();\n        // AU-HOLD:END'));
    const renormalise = 'careerState = normalizeCareerState(parseStorage(CAREER_STATE_KEY), { dataSource: careerDataSource, roles: roleData });';
    expect(hold).toContain(renormalise);
    expect(hold.indexOf('roleData = [];')).toBeLessThan(hold.indexOf(renormalise));
    expect(hold.indexOf('careerDataSource = "api";')).toBeLessThan(hold.indexOf(renormalise));
    expect(hold.indexOf(renormalise)).toBeLessThan(hold.indexOf('persistCareerState();'));
    expect(hold.indexOf('persistCareerState();')).toBeLessThan(hold.indexOf('showAuHoldState('));
  });
});

describe('FB-1 D12 + D14: the invited doctor', () => {
  it('onboarding: a pathway on record enters the Australian branch before anything else is considered', () => {
    const takeOver = onboardingJs.slice(onboardingJs.indexOf('function auTakeOver(params) {'), onboardingJs.indexOf('(function auWireStaticButtons() {'));
    const recorded = takeOver.indexOf('auServerRecorded = !!(recordedMine && recordedMine.isAu === true);');
    expect(recorded).toBeGreaterThan(-1);
    // Decided before the saved answers, the "no" remembered on the device, and the first question.
    expect(recorded).toBeLessThan(takeOver.indexOf('if (state.auBranch === "yes") {'));
    expect(recorded).toBeLessThan(takeOver.indexOf('auReadLocalAnswer() === "no"'));
    expect(recorded).toBeLessThan(takeOver.lastIndexOf('auShowFirstQuestion();'));
    const forced = takeOver.slice(takeOver.indexOf('if (auServerRecorded && !('), takeOver.indexOf('if (state.auBranch === "yes") {'));
    expect(forced).toContain('auWriteLocalAnswer("");');
    expect(forced).toContain('state.auBranch = "yes";');
    expect(forced).toContain('auHideFirstQuestion();');
    expect(forced).toContain('auPrefillFromRecord();');
    expect(forced).toContain('return true;');
    expect(forced).not.toContain('auShowFirstQuestion');
  });

  it('onboarding: no way back to the first question, and "No" does nothing, for that doctor', () => {
    expect(onboardingJs).toMatch(/function auBack\(\) \{\s*if \(auStepIndex === 0\) \{\s*if \(auServerRecorded\) return;/);
    expect(onboardingJs).toMatch(/function auAnswerNo\(\) \{\s*if \(auServerRecorded\) return;/);
    expect(onboardingJs).toContain('backBtn.classList.toggle("visible", !(auServerRecorded && index === 0));');
  });

  it('onboarding: what staff entered fills empty answers only', () => {
    const fn = onboardingJs.slice(onboardingJs.indexOf('function auPrefillFromRecord() {'), onboardingJs.indexOf('// Called once from the init chain, with the switch known to be on'));
    expect(fn).toContain('fetch("/api/onboarding/au-prefill"');
    expect(fn).toContain('if (!a.state && typeof given.state === "string" && given.state)');
    expect(fn).toContain('if (!a.ahpraNumber && typeof given.ahpraNumber === "string" && given.ahpraNumber)');
    // Asked only from the branch for a doctor with a pathway on record.
    expect(onboardingJs.match(/auPrefillFromRecord\(\)/g)).toHaveLength(2); // the definition and the one call
  });

  it('sign-in page: first-time wording for an invite only; the reset screen keeps its markup', () => {
    expect(signinHtml).toContain('<h1 class="auth-title">Set new password</h1>');
    expect(signinHtml).toContain('<button class="submit-btn" id="resetPasswordSubmitBtn" type="submit">UPDATE PASSWORD</button>');
    const show = signinHtml.slice(signinHtml.indexOf('function showResetPasswordPanel() {'), signinHtml.indexOf('// ── "Check your email" panel ──'));
    expect(show).toMatch(/if \(_recoveryIsInvite\) \{[\s\S]*"Create your password"[\s\S]*"CREATE PASSWORD"[\s\S]*\}\s*resetPasswordContainerEl\.classList\.add\("active"\);/);
    expect(signinHtml).toContain('_recoveryIsInvite = new URLSearchParams(search).get("invite") === "1";');
    // Read before the address bar is cleaned.
    expect(signinHtml.indexOf('_recoveryIsInvite = new URLSearchParams(search)')).toBeLessThan(signinHtml.indexOf('var cleanUrl = window.location.origin + window.location.pathname;'));
  });

  it('sign-in page: going straight in depends on what the SERVER answered, not on the link', () => {
    const submit = signinHtml.slice(signinHtml.indexOf('var response = await fetch("/api/auth/recovery-update-password"'), signinHtml.indexOf('// Pre-warm server-side state cache'));
    expect(submit).toContain('if (result.signedIn === true && result.redirectTo) {');
    expect(submit).not.toMatch(/_recoveryIsInvite/);
    expect(submit).toContain('setStatus(signInStatusEl, "Password updated. Please sign in with your new password.", "ok");');
  });
});

describe('FB-1 D23: the crop dialog is solid on the Australian documents page only', () => {
  it('the Australian page overrides the backdrop; the standard page and the crop script are untouched', () => {
    const au = read('pages/my-documents-au.html');
    expect(au).toContain('html body #gpDocCropOverlay { background: #030712; }');
    expect(read('pages/my-documents.html')).not.toContain('#gpDocCropOverlay');
    const crop = read('js/doc-crop.js');
    expect(crop).toContain('var OVERLAY_ID = "gpDocCropOverlay";');
    expect(crop).toContain('background:rgba(3,7,18,0.92)');
    expect(au).toContain('doc-crop.js?v=20260813a');
  });
});

describe('FB-1 D26: one promise, Australian dates', () => {
  it('formatDate writes a date the Australian way whatever the browser default', () => {
    expect(auDoctor.formatDate('2026-11-20T03:00:00.000Z')).toBe('20 Nov 2026');
    expect(auDoctor.formatDate(new Date('2026-01-05T03:00:00.000Z'))).toBe('5 Jan 2026');
    expect(auDoctor.formatDate('2026-12-01T03:00:00.000Z', { day: 'numeric', month: 'short' })).toBe('1 Dec');
    ['', null, undefined, 'not a date'].forEach((v) => expect(auDoctor.formatDate(v)).toBe(''));
    expect(auDoctor.LOCALE).toBe('en-AU');
  });

  it('careers and job pages use it for an Australian doctor and the browser default for everyone else', () => {
    const short = careerHtml.slice(careerHtml.indexOf('function careerShortDate(value) {'), careerHtml.indexOf('// D10: the limit wording on "How careers works"'));
    expect(short).toContain('if (auDoctorInfo && window.GPAuDoctor) return window.GPAuDoctor.formatDate(value) || "—";');
    expect(short).toContain('return new Date(value).toLocaleDateString();');
    expect(careerHtml).toContain('{ label: "Applied", value: app.appliedAt ? careerShortDate(app.appliedAt) : "—" },');
    expect(careerHtml).toContain('function careerDateLocale() { return auDoctorInfo && window.GPAuDoctor ? window.GPAuDoctor.LOCALE : undefined; }');
    expect(jobHtml).toContain('function jobDateLocale() { return auDoctorOnPage() ? window.GPAuDoctor.LOCALE : undefined; }');
  });

  it('wherever an Australian doctor reads the promise about their current practice, it is the same promise', () => {
    const PROMISE = /never contact (your current practice|them)/gi;
    const FULL = /never contact (your current practice|them) without asking you first/i;
    const sources = {
      'pages/onboarding.html': read('pages/onboarding.html'),
      'js/onboarding-au.js': read('js/onboarding-au.js'),
      'lib/au-onboarding.js': read('lib/au-onboarding.js'),
      'lib/au-staff-tools.js': read('lib/au-staff-tools.js'),
      'lib/profile-share-consent.js': read('lib/profile-share-consent.js'),
      'lib/document-requirements.js': read('lib/document-requirements.js'),
      'js/my-documents-au.js': read('js/my-documents-au.js'),
      'pages/my-documents-au.html': read('pages/my-documents-au.html')
    };
    let seen = 0;
    Object.keys(sources).forEach((name) => {
      const text = sources[name];
      let m;
      PROMISE.lastIndex = 0;
      while ((m = PROMISE.exec(text))) {
        seen += 1;
        expect(FULL.test(text.slice(m.index, m.index + 90)), name + ': ' + text.slice(m.index - 30, m.index + 90)).toBe(true);
      }
    });
    expect(seen).toBeGreaterThanOrEqual(7);

    const staffTools = require('../lib/au-staff-tools.js');
    const consent = require('../lib/profile-share-consent.js');
    const SENTENCE = 'We never contact your current practice without asking you first.';
    expect(staffTools.buildCandidateInviteEmail({ pathway: 'au_vr', setupUrl: 'https://example.invalid/x' }).body).toContain(SENTENCE);
    expect(staffTools.buildAhpraVerifiedMessage({ appBaseUrl: 'https://example.invalid' }).body).toContain(SENTENCE);
    expect(consent.doctorConsentSheet({ practiceName: 'Test Metro Practice (FAKE)' }).footnote).toContain(SENTENCE);
    expect(read('docs/au-gp/legal-draft/consent-wording.md')).toContain('Wording aligned, 21 Nov 2026 (fix bundle FB-1, walk finding D26)');
  });

  it('the CV dialog on the job page drops its repeated line for an Australian doctor only', () => {
    expect(jobHtml).toContain("<p class=\"cv-modal-hint\">We'll quickly check it's a genuine CV before sending applications.</p>");
    const open = jobHtml.slice(jobHtml.indexOf('function openCvModal() {'), jobHtml.indexOf('function openCvModal() {') + 700);
    expect(open).toMatch(/if \(cvModal && auDoctorOnPage\(\)\) \{[\s\S]*auCvHint\.hidden = true;/);
  });
});
