// WP-12 (GP app after placement): the pure pieces. Stage list per pathway,
// entry route, the pre-start checklist, what a doctor may record, the
// provider-number step, the neutral role label, the shared job-facts
// renderer, support filtering and the Account block.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const requireCjs = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(decodeURIComponent(ROOT), p), 'utf8');

const gpApp = requireCjs('../lib/au-gp-app.js');
const details = requireCjs('../lib/au-doctor-details.js');
const doctorText = requireCjs('../lib/au-doctor-text.js');
const journeyLadders = requireCjs('../lib/journey-ladders.js');
const auDoctor = requireCjs('../js/au-doctor.js');
const auPrestartPage = requireCjs('../js/au-prestart.js');
const accountAu = requireCjs('../js/account-au.js');
const supportAu = requireCjs('../js/support-au.js');
const jobFacts = requireCjs('../js/au-job-facts.js');
const strip = requireCjs('../js/career-step-strip.js');
const slides = requireCjs('../js/gp-intro-slides.js');
const localise = requireCjs('../js/au-localise.js');

const session = (stage, over) => Object.assign({
  ok: true, authenticated: true, auPathwayEnabled: true,
  auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true },
  auJourney: { ladder: 'au', pathway: 'au_vr', stage, steps: gpApp.doctorSteps(stage), entryRoute: gpApp.entryRouteForStage(stage) },
  auDoctor: { eligibilityVersion: 'aaaaaaaaaaaaaaaa', limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, onboardingComplete: true }
}, over || {});

describe('APP-08: the stage list per pathway', () => {
  it('a doctor is shown four steps, mapped from the case ladder', () => {
    expect(gpApp.DOCTOR_STEPS.map((s) => s.title)).toEqual(['Secure placement', 'Pre-start checks', 'Medicare provider number', 'Start date']);
    expect(gpApp.doctorSteps('placement').map((s) => s.state)).toEqual(['current', 'locked', 'locked', 'locked']);
    expect(gpApp.doctorSteps('prestart').map((s) => s.state)).toEqual(['done', 'current', 'open', 'open']);
    ['commenced', 'guarantee', 'complete'].forEach((st) => expect(gpApp.doctorSteps(st).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']));
    // every rung of the ladder is covered, and nothing else is treated as "placed"
    expect(journeyLadders.AU_STAGES).toEqual(['placement', 'prestart', 'commenced', 'guarantee', 'complete']);
    ['myintealth', 'amc', 'ahpra', 'visa', 'pbs', '', null, undefined, 'nonsense'].forEach((st) => {
      expect(gpApp.doctorSteps(st).map((s) => s.state)).toEqual(['current', 'locked', 'locked', 'locked']);
      expect(gpApp.entryRouteForStage(st)).toBe('/pages/career');
    });
  });

  it('the pre-start facts refine the steps: one current step, the first that is not done', () => {
    expect(gpApp.doctorSteps('prestart', { prestartDone: true }).map((s) => s.state)).toEqual(['done', 'done', 'current', 'open']);
    expect(gpApp.doctorSteps('prestart', { providerNumberRecorded: true }).map((s) => s.state)).toEqual(['done', 'current', 'done', 'open']);
    expect(gpApp.doctorSteps('prestart', { prestartDone: true, providerNumberRecorded: true, startDateConfirmed: true }).map((s) => s.state)).toEqual(['done', 'done', 'done', 'current']);
    expect(gpApp.doctorSteps('placement', { prestartDone: true, providerNumberRecorded: true }).map((s) => s.locked)).toEqual([false, true, true, true]);
  });

  it('the browser maps a stage exactly as the server does', () => {
    journeyLadders.AU_STAGES.concat(['myintealth', '', 'x']).forEach((st) => {
      expect(auDoctor.stepsFor(st)).toEqual(gpApp.doctorSteps(st));
      [{ prestartDone: true }, { providerNumberRecorded: true }, { prestartDone: true, providerNumberRecorded: true, startDateConfirmed: true }].forEach((f) => {
        expect(auDoctor.stepsFor(st, f)).toEqual(gpApp.doctorSteps(st, f));
      });
    });
    expect(auDoctor.STEP_DEFS).toEqual(gpApp.DOCTOR_STEPS.map((s) => ({ key: s.key, title: s.title, href: s.href, description: s.description })));
    expect(auDoctor.WAITING_ON_PLACEMENT).toBe(gpApp.WAITING_ON_PLACEMENT);
  });

  it('the session gives the browser the doctor\'s journey; a muddled one reads as the first rung, never as placed', () => {
    const placed = auDoctor.fromSession(session('prestart'));
    expect(placed.journey).toMatchObject({ stage: 'prestart', placed: true, started: false, entryRoute: '/pages/prestart' });
    expect(placed.journey.steps.map((s) => s.state)).toEqual(['done', 'current', 'open', 'open']);
    expect(auDoctor.fromSession(session('placement')).journey).toMatchObject({ stage: 'placement', placed: false, entryRoute: '/pages/career' });
    [undefined, null, {}, { stage: 'myintealth' }, { stage: 'prestart', steps: [{ key: 'x' }] }].forEach((j) => {
      const d = auDoctor.fromSession(session('placement', { auJourney: j }));
      expect(d.journey.steps).toHaveLength(4);
      expect(d.journey.steps.map((s) => s.key)).toEqual(['placement', 'prestart', 'provider_number', 'start']);
    });
    expect(auDoctor.fromSession(session('placement', { auJourney: { stage: 'myintealth' } })).journey.placed).toBe(false);
    // not an Australian doctor: no details at all, so nothing Australian is ever drawn
    expect(auDoctor.fromSession({ ok: true, auPathwayEnabled: true, auPathway: { pathway: 'overseas_esp', isAu: false } })).toBeNull();
    expect(auDoctor.fromSession({ ok: true, authenticated: true })).toBeNull();
  });

  it('js/journey-stages.js: every consumer of the stage list gets the Australian list for an Australian doctor', () => {
    const info = auDoctor.fromSession(session('prestart'));
    const win = { GPAuDoctor: Object.assign({}, auDoctor, { cached: () => info }) };
    vm.runInNewContext(read('js/journey-stages.js'), { window: win });
    const J = win.GPJourneyStages;
    const rows = JSON.parse(JSON.stringify(J.getStageStates({ epicDone: true, amcDone: true }, false)));
    expect(rows.map((r) => r.title)).toEqual(['Secure placement', 'Pre-start checks', 'Medicare provider number', 'Start date']);
    expect(rows.map((r) => r.page)).toEqual(['career', 'prestart', 'pbs', 'prestart']);
    expect(rows.map((r) => r.done)).toEqual([true, false, false, false]);
    expect(rows.every((r) => !r.locked)).toBe(true);
    expect(J.isAuDoctor()).toBe(true);
    expect(J.entryRoute()).toBe('/pages/prestart');
    expect(JSON.parse(JSON.stringify(J.stagesForDoctor())).map((r) => r.key)).toEqual(['placement', 'prestart', 'provider_number', 'start']);
    // before a placement: the three later steps are locked and lead to Careers
    const early = auDoctor.fromSession(session('placement'));
    const win2 = { GPAuDoctor: Object.assign({}, auDoctor, { cached: () => early }) };
    vm.runInNewContext(read('js/journey-stages.js'), { window: win2 });
    const rows2 = JSON.parse(JSON.stringify(win2.GPJourneyStages.getStageStates({}, false)));
    expect(rows2.map((r) => r.locked)).toEqual([false, true, true, true]);
    expect(rows2[1]).toMatchObject({ positionLocked: true, lockReason: 'Opens once your placement is secured' });
    expect(win2.GPJourneyStages.entryRoute()).toBe('/pages/career');
  });

  it('the shell draws its registration menu, phase and nav from the same answer', () => {
    const shell = read('js/app-shell.js');
    expect(shell).toMatch(/function getRegistrationRows\(\) \{\s*\/\/[^\n]*\n\s*var auRows = auRegistrationRows\(\);\s*if \(auRows\) return auRows;/);
    expect(shell).toContain('if (au && au.journey && au.journey.placed) return "registration";');
    expect(shell).toContain('auVis.scan = false;');
    expect(shell).toContain('"/pages/prestart": true');
    expect(shell).toContain('"/pages/prestart": { desktop: "home", mobile: "/pages/index" }');
    // the helper is only ever read through cached(): no session, no Australian shell
    expect(shell).toMatch(/function auInfo\(\) \{\s*var helper = auHelper\(\);\s*try \{ return helper && typeof helper\.cached === "function" \? helper\.cached\(\) : null; \}/);
  });
});

describe('APP-09: the entry route comes from the pathway, in one place', () => {
  it('other-journey addresses are recognised whatever their spelling', () => {
    ['/pages/myinthealth', '/pages/amc', '/pages/ahpra', '/pages/visa', '/pages/registration-intro', '/pages/commencement',
      '/pages/visa.html?x=1', '/pages/myinthealth?gp_registration_continue=1', '/pages/ahpra#top'].forEach((p) => expect(auDoctor.isOtherJourneyRoute(p), p).toBe(true));
    ['/pages/index', '/pages/career', '/pages/pbs', '/pages/prestart', '/pages/account', '/pages/my-documents', '', null].forEach((p) => expect(auDoctor.isOtherJourneyRoute(p), String(p)).toBe(false));
  });

  it('the shell rewrites a navigation once, before anything else looks at it', () => {
    const shell = read('js/app-shell.js');
    const fn = shell.slice(shell.indexOf('function resolveRouteUrlForNavigation(input) {'), shell.indexOf('function getDesktopItems() {'));
    expect(fn.indexOf('routeUrl = auRemapRouteUrl(routeUrl);')).toBeGreaterThan(0);
    expect(fn.indexOf('routeUrl = auRemapRouteUrl(routeUrl);')).toBeLessThan(fn.indexOf('shouldRouteThroughRegistrationIntro(routeUrl)'));
    expect(shell).toContain('return auRemapRoute(direct);');
    expect(shell).toContain('return auRemapRoute(resolved);');
    const remap = shell.slice(shell.indexOf('function auRemapRouteUrl(routeUrl) {'), shell.indexOf('function auRemapRoute(route) {'));
    expect(remap).toContain('if (!helper || !info || !routeUrl) return routeUrl;');
    expect(remap).toContain('helper.isOtherJourneyRoute(path)');
    expect(remap).toContain('(path === "/pages/prestart" || path === "/pages/pbs") && !info.journey.placed && !hasCareerSecured()');
  });

  it('after signing: the placed slides end on the pre-start page, and the signed-offer button leads there', () => {
    const walk = read('js/gp-walkthrough-shell.js');
    expect(walk).toContain("if (window.gpShellNavigate) window.gpShellNavigate(ctx.auEntryRoute || '/pages/prestart', { replace: true });");
    expect(walk.indexOf("ctx.auEntryRoute || '/pages/prestart'")).toBeLessThan(walk.indexOf("window.gpShellNavigate('/pages/registration-intro', { replace: true })"));
    const offer = read('pages/offer-review.html');
    expect(offer).toContain("try { if (window.GPAuDoctor && window.GPAuDoctor.isCandidate()) target = '/pages/prestart'; } catch (auErr) {}");
    const placedDeck = auDoctor.placedSlides({ name: 'Dr Auvr', practiceName: 'Test Metro Practice (FAKE)' });
    expect(placedDeck[placedDeck.length - 1].cta).toBe('Open my pre-start checklist');
    expect(placedDeck[0].bullets.map((b) => b.title)).toEqual(['Pre-start checks', 'Medicare provider number', 'Start date']);
    expect(placedDeck[0].body).toContain('Your position at Test Metro Practice (FAKE) is secured.');
  });
});

describe('APP-16, D1, D17, D20: slides, tours and the careers strip', () => {
  it('ONE welcome slide for an Australian doctor, with their own limits; the standard decks are used when none is passed', () => {
    const one = auDoctor.welcomeSlides({ name: 'Dr Auvr', limits: { active: 4, monthly: 6, interviewsMonthly: 6 } });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ title: 'Welcome, Dr Auvr', cta: 'See roles', note: 'You can have 4 applications in play at once, and 6 in a calendar month. Withdrawing from a position is final.' });
    expect(one[0].body).toContain('We never contact your current practice without asking you first.');
    expect(slides.buildWelcomeSlides({ auWelcomeSlides: one })).toBe(one);
    expect(slides.buildRegistrationSlides({ auPlacedSlides: one })).toBe(one);
    expect(slides.buildWelcomeSlides({ auWelcomeSlides: [] })).toHaveLength(6);
    expect(slides.buildWelcomeSlides({ firstName: 'Sam' })).toHaveLength(6);
    expect(slides.buildRegistrationSlides({})).toHaveLength(4);
  });

  it('the shell shows no deck to a held doctor, and none while it does not yet know who the doctor is', () => {
    const walk = read('js/gp-walkthrough-shell.js');
    expect(walk).toContain('if (ctx.auPending || ctx.auHeld) { broadcastCoachActive(false); return; }');
    expect(walk).toContain('ctx.auHeld = au.info.launched !== true;');
    expect(walk).toContain("setTimeout(function () { finish({ pending: true }); }, 4000);");
    expect(walk).toContain('if (auCandidate()) return; // WP-12: no tab tour for a doctor on an Australian pathway');
    expect(walk).toContain('if (auCandidate()) { broadcastCoachActive(false); if (auDoctorNow()) markNextStepDone(); return; }');
  });

  it('no careers tutorial, Home tour or "start here" pointer for an Australian doctor', () => {
    const tips = read('js/gp-walkthrough.js');
    expect(tips).toContain("if (auDoctorOnPage() && (area === 'home' || area === 'practice')) return [];");
    expect(tips).toMatch(/function careerStepsPending\(\) \{\s*if \(auDoctorOnPage\(\)\) return false;/);
    expect(tips).toMatch(/function maybeRunCareerSteps\(\) \{\s*if \(auDoctorOnPage\(\)\) return false;/);
    expect(tips).toMatch(/function runNextStepPointer\(\) \{\s*if \(!S \|\| !C\) return;\s*if \(auDoctorOnPage\(\)\) \{ markNextStepDone\(\); return; \}/);
  });

  it('the careers strip: step 4 is "Pre-start" and a secured position leads to the checklist', () => {
    const au = { stepFourLabel: auDoctor.STRIP_STEP_FOUR, securedHint: 'Your position is secured. Your pre-start checklist is ready.', securedHref: 'prestart', securedCta: auDoctor.offerCopy.securedCta };
    expect(strip.deriveCareerStep([], au).steps.map((s) => s.label)).toEqual(['Job Search', 'Interview', 'Offer & contract', 'Pre-start']);
    expect(strip.deriveCareerStep([{ id: 'a', status: 'placement_secured', isPlacementSecured: true }], au))
      .toMatchObject({ step: 4, label: 'Pre-start', hint: 'Your position is secured. Your pre-start checklist is ready.', href: 'prestart', ctaLabel: 'Open my pre-start checklist' });
    // steps 1 to 3 are untouched by the option
    const apps = [{ id: 'a', roleId: 'r', status: 'offer', offerPending: true }];
    const plain = strip.deriveCareerStep(apps);
    const withAu = strip.deriveCareerStep(apps, au);
    expect(withAu.hint).toBe(plain.hint);
    expect(withAu.href).toBe(plain.href);
    expect(strip.STEPS[3].label).toBe('Registration');
  });

  it('D17 and D18 on Careers: the hold is decided before anything paints; the honest line is drawn from the server\'s flag', () => {
    const career = read('pages/career.html');
    expect(career).toContain('<script>try{var auHeldEarly=window.GPAuDoctor&&window.GPAuDoctor.cached();if(auHeldEarly&&auHeldEarly.launched===false)document.documentElement.setAttribute("data-au-hold","true");}catch(e){}</script>');
    ['.at-dock', '.at-headline', '.at-sub', '.at-consult', '#careerStepStrip', '#careerMapWrap', '#teamMatchesSection', '#jobBoardHead', '#recommendedRoles']
      .forEach((sel) => expect(career).toContain('html[data-au-hold="true"] ' + sel));
    expect(career).toContain('if (browsePanel) browsePanel.insertBefore(card, browsePanel.firstChild);');
    expect(career).toContain('#au-hold-state .au-hold-text { font-size: 16px; line-height: 1.55; margin: 0 0 10px; color: #0f172a; }');
    expect(career).toContain('if (auDoctorHeld()) return Promise.resolve();');
    expect(career).toContain('if (auDoctorInfo || auDoctorHeld()) return;');
    expect(career).toContain('auShowPendingNote(payload.auRegistrationPending === true); // WP-12 (D18)');
    expect(auDoctor.careersCopy.unverifiedNote).toBe('More roles may open once we have confirmed your registration.');
    const onboarding = read('pages/onboarding.html');
    expect(onboarding).toContain('<button class="btn-next" id="auSuccessReviewContinueBtn" type="button">See where things are up to</button>');
    expect(read('js/onboarding.js')).toContain('if (goHeld) goHeld.addEventListener("click", function () { window.location.href = "/pages/career"; });');
    // FB1-E
    expect(read('js/onboarding.js')).toContain('backBtn.textContent = index === 0 ? "Change my answer" : "Previous";');
  });
});

describe('D19: the neutral name for the people at GP Link', () => {
  it('a consultant before placement, the team after it; one helper', () => {
    expect(gpApp.teamLabel(false)).toBe('your GP Link consultant');
    expect(gpApp.teamLabel(true)).toBe('your GP Link team');
    expect(auDoctor.teamLabel(false)).toBe(gpApp.teamLabel(false));
    expect(auDoctor.teamLabel(true)).toBe(gpApp.teamLabel(true));
    expect(auDoctor.TeamLabel(true)).toBe('Your GP Link team');
  });

  it('the shared screens use it wherever the overseas job title appears', () => {
    expect(localise.localiseText('with your Registration Support Officer negotiating for you.', false)).toBe('with your GP Link consultant negotiating for you.');
    expect(localise.localiseText('Your Registration Support Officer joins you, so you\'re never in the room alone.', false)).toBe('Your GP Link consultant joins you, so you\'re never in the room alone.');
    expect(localise.localiseText('Your Registration Guidance Officer', true)).toBe('Your GP Link team');
    expect(localise.localiseText('Message your Registration Support Officer if that wasn\'t what you meant to do.', true)).toBe('Message your GP Link team if that wasn\'t what you meant to do.');
  });
});

describe('APP-13: the pre-start checklist', () => {
  const base = {
    placement: { key: 'app-1', practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-02-01' },
    tasks: [
      { task_type: 'start_date_tracking', status: 'open', metadata: { what_to_do: 'STAFF ONLY do this', placement_key: 'app-1' } },
      { task_type: 'indemnity_certificate', status: 'open', metadata: { what_to_do: 'STAFF ONLY', done_when: 'STAFF ONLY' } },
      { task_type: 'provider_number_new_location', status: 'open', metadata: {} },
      { task_type: 'reference_check', status: 'open', metadata: {} }
    ],
    documents: [
      { key: 'au_ahpra_certificate', label: 'Ahpra registration certificate', short: 'Your current certificate.', status: 'pending', required: true, phase: 'prestart', provider: 'you', staffLabel: 'STAFF LABEL' },
      { key: 'au_indemnity_certificate', label: 'Indemnity certificate of currency', short: 'From your insurer.', status: 'pending', required: true, phase: 'prestart', provider: 'you' },
      { key: 'au_immunisation_record', label: 'Immunisation record', short: 'Optional.', status: 'pending', required: false, phase: 'prestart', provider: 'you' }
    ],
    allDocuments: [],
    registerChecked: false, registerCheckOpen: true,
    details: details.doctorView(null),
    providerNumber: { recorded: false }
  };

  it('lists each item with its status, a plain line and who is doing it; arrivals items are not there', () => {
    const out = gpApp.buildPrestartChecklist(base);
    expect(out.items.map((i) => i.key)).toEqual(['register_check', 'notice', 'start_date', 'indemnity', 'provider_number', 'referees', 'credentialing', 'doc_au_ahpra_certificate']);
    const by = Object.fromEntries(out.items.map((i) => [i.key, i]));
    expect(by.register_check).toMatchObject({ status: 'waiting', whoLabel: 'GP Link' });
    expect(by.notice).toMatchObject({ status: 'todo', whoLabel: 'You', action: { kind: 'notice', label: 'I have given notice' } });
    expect(by.start_date).toMatchObject({ status: 'waiting', whoLabel: 'GP Link and the practice', startDate: '2027-02-01' });
    expect(by.indemnity).toMatchObject({ status: 'todo', whoLabel: 'You', documentKey: 'au_indemnity_certificate', action: { kind: 'upload' } });
    expect(by.provider_number).toMatchObject({ status: 'todo', whoLabel: 'You', title: 'Medicare provider number for Test Metro Practice (FAKE)', action: { kind: 'link', href: '/pages/pbs' } });
    expect(by.referees).toMatchObject({ status: 'todo', whoLabel: 'You', action: { kind: 'referees' } });
    expect(by.credentialing).toMatchObject({ status: 'waiting', whoLabel: 'GP Link and the practice' });
    expect(out.complete).toBe(false);
    expect(out.counts).toEqual({ done: 0, total: 8 });
    out.items.forEach((i) => { expect(i.whatToDo.length).toBeGreaterThan(10); expect(['done', 'todo', 'waiting', 'attention']).toContain(i.status); });
    const all = JSON.stringify(out);
    ['Book travel', 'Bank account', 'TFN', 'travel'].forEach((w) => expect(all).not.toContain(w));
    // an optional document is not on the checklist
    expect(all).not.toContain('Immunisation');
  });

  it('never carries a staff field out: no what_to_do, done_when, staff label or task title', () => {
    const all = JSON.stringify(gpApp.buildPrestartChecklist(base));
    expect(all).not.toContain('STAFF');
    expect(all).not.toMatch(/what_to_do|done_when|staffLabel|metadata/);
  });

  it('follows the real state: done, in progress, needs another look', () => {
    const out = gpApp.buildPrestartChecklist(Object.assign({}, base, {
      registerChecked: true, registerCheckOpen: false,
      tasks: [
        { task_type: 'start_date_tracking', status: 'completed', metadata: { confirmed_start_date: '2027-02-08' } },
        { task_type: 'credentialing_pack', status: 'completed', metadata: {} },
        { task_type: 'reference_check', status: 'completed', metadata: {} }
      ],
      documents: [
        { key: 'au_ahpra_certificate', label: 'Ahpra registration certificate', short: 'x', status: 'rejected', note: 'The expiry date is cut off.', required: true },
        { key: 'au_indemnity_certificate', label: 'Indemnity certificate of currency', short: 'x', status: 'approved', required: true }
      ],
      details: details.doctorView({ notice_given: true, notice_given_date: '2026-11-19', notice_placement_key: 'app-1' }, { placementKey: 'app-1' }),
      providerNumber: { recorded: true, number: '123456AB' }
    }));
    const by = Object.fromEntries(out.items.map((i) => [i.key, i]));
    expect(by.register_check.status).toBe('done');
    expect(by.notice).toMatchObject({ status: 'done', noticeGivenDate: '2026-11-19' });
    expect(by.start_date).toMatchObject({ status: 'done', startDate: '2027-02-08' });
    expect(by.indemnity.status).toBe('done');
    expect(by.provider_number.status).toBe('done');
    expect(by.referees.status).toBe('done');
    expect(by.credentialing.status).toBe('done');
    expect(by.doc_au_ahpra_certificate).toMatchObject({ status: 'attention', note: 'The expiry date is cut off.', action: { kind: 'upload', label: 'Upload again' } });
    expect(out.startDateConfirmed).toBe(true);
    expect(out.facts).toEqual({ prestartDone: false, providerNumberRecorded: true, startDateConfirmed: true });
    expect(out.complete).toBe(false);
    // referees given but not yet taken: with us, not "to do"
    const given = gpApp.buildPrestartChecklist(Object.assign({}, base, { details: { referees: [{ name: 'a' }, { name: 'b' }] } }));
    expect(given.items.find((i) => i.key === 'referees')).toMatchObject({ status: 'waiting', whoLabel: 'GP Link' });
    // notice recorded for an EARLIER placement does not count for this one
    expect(details.doctorView({ notice_given: true, notice_given_date: '2026-01-01', notice_placement_key: 'old' }, { placementKey: 'app-1' }).noticeGiven).toBe(false);
  });

  it('the page draws it at phone width with the forms the doctor fills in', () => {
    const checklist = gpApp.buildPrestartChecklist(base);
    const view = { ok: true, placed: true, launched: true, steps: gpApp.doctorSteps('prestart', checklist.facts), items: checklist.items, complete: false, counts: checklist.counts,
      practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-02-01', startDateConfirmed: false, teamLabel: 'your GP Link team',
      providerNumber: { recorded: false }, providerStep: gpApp.providerNumberStep('provider_number_new_location', { practiceName: 'Test Metro Practice (FAKE)' }), details: details.doctorView(null) };
    const html = auPrestartPage._prestartHtml(view, { open: '' });
    expect(html).toContain('0 of 8 done');
    expect(html).toContain('data-au-item="notice"');
    expect(html).toContain('data-au-notice-given');
    expect(html).toContain('data-au-ref="2" data-au-ref-field="agreed"');
    expect(html).toContain('This person has agreed to be contacted by GP Link about me.');
    expect(html).toContain('Is this person at your current practice?');
    expect(html).toContain('id="start-date"');
    expect(html).toContain('Your expected start date is 1 February 2027.');
    expect(html).toContain('data-au-docs');
    const home = auPrestartPage._homeHtml(view);
    expect(home).toContain('Your next step');
    expect(home).toContain('Notice to your current practice');
    expect(home).toContain('data-au-step="provider_number"');
    expect(home).toContain('Expected start date: <strong>1 February 2027</strong>');
    // a held doctor's Home says so, and offers no role
    const held = auPrestartPage._homeHtml({ ok: true, placed: false, launched: false, steps: gpApp.doctorSteps('placement'), items: [], teamLabel: 'your GP Link consultant' });
    expect(held).toContain('Thanks, we have your details');
    expect(held).not.toContain('See roles');
    // not placed, launched: Careers is the next step
    expect(auPrestartPage._homeHtml({ ok: true, placed: false, launched: true, steps: gpApp.doctorSteps('placement'), items: [] })).toContain('data-au-route="/pages/career"');
    // an unusable answer never draws half a page
    expect(auPrestartPage._prestartHtml(null)).toContain('We could not load your checklist');
    expect(read('css/au-app.css')).toContain('@media (max-width: 420px)');
  });
});

describe('what a doctor may record (lib/au-doctor-details.js)', () => {
  const good = (over) => Object.assign({ name: 'Dr Test Referee (FAKE)', role: 'Practice principal', relationship: 'My supervisor', phone: '0491 570 157', email: '', agreedToContact: true, atCurrentPractice: false }, over || {});

  it('two referees, each with a name, role, relationship, a contact, an explicit agreement and an explicit yes or no', () => {
    const ok = details.sanitiseReferees([good(), good({ name: 'Dr Second (FAKE)', phone: '', email: 'Second@GPLink-Test.local', atCurrentPractice: true })]);
    expect(ok.ok).toBe(true);
    expect(ok.referees).toEqual([
      { name: 'Dr Test Referee (FAKE)', role: 'Practice principal', relationship: 'My supervisor', phone: '0491570157', email: '', agreed_to_contact: true, at_current_practice: false },
      { name: 'Dr Second (FAKE)', role: 'Practice principal', relationship: 'My supervisor', phone: '', email: 'second@gplink-test.local', agreed_to_contact: true, at_current_practice: true }
    ]);
    expect(details.sanitiseReferees([good()]).errors.referees).toBe('Please give two referees.');
    expect(details.sanitiseReferees([good(), good(), good()]).ok).toBe(false);
    expect(details.sanitiseReferees(null).ok).toBe(false);
    const bad = details.sanitiseReferees([good({ name: '', agreedToContact: false, atCurrentPractice: undefined }), good({ name: 'Dr Second (FAKE)', phone: '12', email: 'nope' })]);
    expect(bad.ok).toBe(false);
    expect(bad.referees).toEqual([]);
    expect(Object.keys(bad.errors).sort()).toEqual(['referee1_agreed', 'referee1_current', 'referee1_name', 'referee2_email', 'referee2_phone']);
    expect(details.sanitiseReferees([good({ phone: '' }), good({ name: 'Dr Second (FAKE)' })]).errors.referee1_contact).toBeTruthy();
    expect(details.sanitiseReferees([good(), good()]).errors.referees).toBe('Please give two different referees.');
    // a tick that is not a real tick is not agreement
    expect(details.sanitiseReferees([good({ agreedToContact: 'yes' }), good({ name: 'B B' })]).errors.referee1_agreed).toBeTruthy();
    // markup never survives
    expect(details.sanitiseReferees([good({ name: '<b>Dr X</b>' }), good({ name: 'Dr Second (FAKE)' })]).referees[0].name).toBe('bDr X/b');
  });

  it('notice given: a tick and a date that is not in the future', () => {
    const now = '2026-11-21T02:00:00.000Z';
    expect(details.sanitiseNotice({ given: true, date: '2026-11-19' }, { now })).toEqual({ ok: true, errors: {}, notice: { given: true, date: '2026-11-19' } });
    expect(details.sanitiseNotice({ given: true, date: '2026-11-22' }, { now }).ok).toBe(true); // the doctor's "today" can be the server's tomorrow
    expect(details.sanitiseNotice({ given: true, date: '2026-12-25' }, { now }).errors.date).toMatch(/future/);
    expect(details.sanitiseNotice({ given: true, date: '2023-01-01' }, { now }).errors.date).toMatch(/too long ago/);
    expect(details.sanitiseNotice({ given: false, date: '2026-11-19' }, { now }).errors.given).toBeTruthy();
    expect(details.sanitiseNotice({ given: true, date: 'soon' }, { now }).errors.date).toBeTruthy();
    expect(details.sanitiseNotice(null, { now }).ok).toBe(false);
  });

  it('existing provider numbers and a prescriber number; nothing else can be written through here', () => {
    const ok = details.sanitiseExistingNumbers({ existingProviderNumbers: [{ number: '234567 1a', location: 'Test Current Practice (FAKE)' }, { number: '2345671A' }, { number: '' }, '445566 7B'], prescriberNumber: '123 4567' });
    expect(ok).toEqual({ ok: true, errors: {}, existingProviderNumbers: [{ number: '2345671A', location: 'Test Current Practice (FAKE)' }, { number: '4455667B', location: '' }], prescriberNumber: '1234567' });
    expect(details.sanitiseExistingNumbers({ existingProviderNumbers: [{ number: 'hello' }] }).ok).toBe(false);
    expect(details.sanitiseExistingNumbers({ prescriberNumber: 'ABC' }).errors.prescriberNumber).toBeTruthy();
    expect(details.sanitiseExistingNumbers({})).toEqual({ ok: true, errors: {}, existingProviderNumbers: [], prescriberNumber: '' });
    // the table has no staff column at all
    const migration = read('supabase/migrations/20261121100000_au_gp_wp12_prestart_details.sql');
    const table = migration.slice(migration.indexOf('create table if not exists public.au_gp_doctor_details'), migration.indexOf('comment on table public.au_gp_doctor_details'));
    expect(table).not.toMatch(/staff|verified|pathway|confirmed_by/);
  });
});

describe('APP-12, ADM-21: the provider-number step and where the number is stored', () => {
  it('a provider-number-only case: no prescriber application is asked for, and nothing is asserted beyond the one sentence', () => {
    const step = gpApp.providerNumberStep('provider_number_new_location', { practiceName: 'Test Metro Practice (FAKE)' });
    expect(step.providerNumberOnly).toBe(true);
    expect(step.intro).toContain('Your new practice location needs its own provider number.');
    expect(step.steps).toHaveLength(3);
    expect(step.prescriberNote).toContain('This step does not ask you to apply for one.');
    expect(step.extraNote).toBe('');
    ['provider_number_plus_19ab_check', 'provider_number_plus_program_approval'].forEach((v) => expect(gpApp.providerNumberStep(v, {}).extraNote).toContain('Please wait to hear from us.'));
    const all = JSON.stringify(step);
    ['must', 'required by', 'section 19', 'within', 'days', 'legally', 'HPOS'].forEach((w) => expect(all).not.toContain(w));
    const html = auPrestartPage._providerHtml({ ok: true, placed: true, steps: [], items: [], practiceName: 'Test Metro Practice (FAKE)', providerStep: step, providerNumber: { recorded: false }, details: details.doctorView(null) }, {});
    expect(html).toContain('data-au-new-number');
    expect(html).toContain('Numbers you already hold');
    expect(html).toContain('data-au-prescriber');
    expect(html).not.toMatch(/prescriber number application|apply for (a |your )?prescriber/i);
    const done = auPrestartPage._providerHtml({ ok: true, placed: true, steps: [], items: [], practiceName: 'Test Metro Practice (FAKE)', providerStep: step, providerNumber: { recorded: true, number: '123456AB' }, details: details.doctorView(null) }, {});
    expect(done).toContain('<p class="aua-number">123456AB</p>');
    expect(done).not.toContain('data-au-new-number');
  });

  it('the migration is additive: nullable location columns on the existing row, the unique rule untouched', () => {
    const sql = read('supabase/migrations/20261121100000_au_gp_wp12_prestart_details.sql');
    const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').toLowerCase();
    ['au_location_practice_id uuid', 'au_location_name text', 'au_location_placement_key text', 'au_location_recorded_by text', 'au_location_recorded_at timestamptz']
      .forEach((c) => expect(code).toContain('add column if not exists ' + c));
    expect(code).toContain('create table if not exists public.au_gp_doctor_details');
    expect(code).toContain('enable row level security');
    expect(code).toContain('revoke all on public.au_gp_doctor_details from anon, authenticated');
    expect(code).not.toMatch(/\bdrop\b|\brename\b|alter column|\bupdate\b|\bdelete\b|pbs_applications_user_id_application_type_key/);
    // the columns added to the EXISTING table are nullable with no default
    const alter = code.slice(code.indexOf('alter table public.pbs_applications'), code.indexOf('comment on column'));
    expect(alter).not.toMatch(/not null|default/);
    expect(code).not.toMatch(/\bbegin\s*;|\bcommit\b/); // no transaction control (the plpgsql "begin ... end" block is fine)
    // the live rule this build must not touch is still what the snapshot says
    expect(read('scripts/au-local/schema/prod-schema.sql')).toContain('add constraint "pbs_applications_user_id_application_type_key" UNIQUE (user_id, application_type)');
  });
});

describe('APP-20, D4: role facts and wording on the careers screens', () => {
  it('the shared renderer states the facts on file and nothing else', () => {
    const rows = jobFacts.rows({ billingModel: 'mixed', vrRequirement: 'vr_preferred', sessionsMin: 8, sessionsMax: 10, mmm: 3, area: 'regional', engagementType: 'permanent', specialInterests: ['Skin'], dpa: 'yes' });
    expect(rows).toEqual([
      { key: 'billing', label: 'Billing', value: 'Mixed billing' },
      { key: 'vr', label: 'Registration', value: 'VR preferred' },
      { key: 'sessions', label: 'Sessions', value: '8 to 10 sessions a week' },
      { key: 'area', label: 'Location type', value: 'Regional (MM3)' },
      { key: 'engagement', label: 'Engagement', value: 'Permanent' },
      { key: 'interests', label: 'Special interests', value: 'Skin' }
    ]);
    expect(jobFacts.rows({ dpa: 'yes' }, { showDpa: true }).map((r) => r.key)).toEqual(['vr', 'dpa']);
    expect(jobFacts.rows({})).toEqual([{ key: 'vr', label: 'Registration', value: 'Vocational registration (VR) required' }]); // nothing recorded: the careful default
    expect(jobFacts.rows({ sessionsMin: 6 })[1].value).toBe('6 sessions a week');
    expect(jobFacts.rows({ area: 'metro', mmm: 1 })[1].value).toBe('Metropolitan (MM1)');
    expect(jobFacts.rows(null)).toEqual([]);
    expect(jobFacts.html({ billingModel: 'bulk' })).toBe('<dl class="au-job-facts"><div class="au-job-fact" data-fact="billing"><dt>Billing</dt><dd>Bulk billing</dd></div><div class="au-job-fact" data-fact="vr"><dt>Registration</dt><dd>Vocational registration (VR) required</dd></div></dl>');
    const text = JSON.stringify(jobFacts.rows({ billingModel: 'private', vrRequirement: 'non_vr_accepted', sessionsMin: 4, sessionsMax: 9, area: 'metro', mmm: 1, engagementType: 'contract', acceptsRegistrars: true, dpa: 'no' }, { showDpa: true }));
    expect(text).not.toMatch(/\$|%|sponsor/i);
  });

  it('the job page draws those rows for an Australian doctor instead of the DPA and sponsorship rows', () => {
    const job = read('pages/job.html');
    const fn = job.slice(job.indexOf('function buildPracticeFactsHtml(role) {'), job.indexOf('// Only surfaces a "Team" line'));
    expect(fn.indexOf('const auFacts = role && role.auFacts && window.GPAuJobFacts ? role.auFacts : null;')).toBeGreaterThan(0);
    expect(fn.indexOf('if (auFacts) {')).toBeLessThan(fn.indexOf('if (typeof role.dpa === "boolean") {'));
    expect(job).toContain("<script>try{if(window.GPAuDoctor)document.write('<script src=\"/js/au-job-facts.js?v=20261121a\"><\\/script>');}catch(e){}</script>");
  });

  it('the server takes the words out of an Australian doctor\'s copy of a role or placement', () => {
    const role = {
      id: 'internal_ats:visa-clinic', title: 'GP - visa sponsorship available', summary: 'Great team. Visa sponsorship available. Close to the beach.',
      benefits: ['Mixed billing patient base', 'Visa and PR pathway support', 'Relocation support'], tags: ['DPA / MMM 2', 'Relocation covered'],
      support: 'Relocation, visa and family-settlement support can be discussed with GP Link.',
      heroImage: 'https://example.invalid/relocation/visa.jpg', status: 'open',
      placement: { quickStats: [{ label: 'Split', value: '70%' }, { label: 'Relocation package', value: 'Pending' }], heading: 'Relocation Explorer', stats: [{ label: 'Relocation Package', value: '$5,000' }] },
      auFacts: { billingModel: 'mixed', dpa: 'yes' }
    };
    const out = doctorText.scrubRolePayload(role);
    expect(out.id).toBe('internal_ats:visa-clinic');
    expect(out.heroImage).toBe('https://example.invalid/relocation/visa.jpg');
    expect(out.title).toBe('GP - sponsorship available');
    expect(out.summary).toBe('Great team. Close to the beach.');
    expect(out.benefits).toEqual(['Mixed billing patient base']);
    expect(out.tags).toEqual(['DPA / MMM 2']);
    expect(out.support).toBe('');
    expect(out.placement.quickStats).toEqual([{ label: 'Split', value: '70%' }]);
    expect(out.placement.heading).toBe('Explore the area');
    expect(out.placement.stats).toEqual([{ label: 'Moving allowance', value: '$5,000' }]);
    expect(out.auFacts).toEqual({ billingModel: 'mixed', dpa: 'yes' });
    expect(doctorText.violations(JSON.stringify(Object.assign({}, out, { id: '', heroImage: '' })))).toEqual([]);
    // a clean payload is returned equal, and the input is never changed
    const clean = { title: 'General Practitioner', benefits: ['Mixed billing'], n: 3, ok: true, nested: [{ label: 'Split', value: '70%' }] };
    expect(doctorText.scrubRolePayload(clean)).toEqual(clean);
    expect(role.benefits).toHaveLength(3);
  });

  it('the secured view lists the doctor\'s own four steps under "What\'s Left To Do"', () => {
    const career = read('pages/career.html');
    const fn = career.slice(career.indexOf('function renderPlacementChecklist(checklistItems) {'), career.indexOf('function cacheRolePreview(roleId) {'));
    expect(fn).toContain('auItems = window.GPAuDoctor.stageStates(auDoctorInfo).map((step) => ({');
    expect(fn).toContain('const items = auItems || buildPlacementChecklistItems(checklistItems);');
  });
});

describe('APP-27, D6, D7: support filtered by pathway', () => {
  it('the Australian lists: categories the server already accepts, five short answers, five articles', () => {
    expect(supportAu.CATEGORIES.map((c) => c.value)).toEqual(['Documents', 'AHPRA', 'Provider', 'Contract', 'Other']);
    const serverAccepts = ['EPIC', 'AMC', 'Documents', 'AHPRA', 'Provider', 'Contract', 'Other'];
    supportAu.CATEGORIES.forEach((c) => expect(serverAccepts).toContain(c.value));
    expect(supportAu.CATEGORIES.map((c) => c.label)).toEqual(['Documents', 'My Ahpra registration details', 'Provider number or my new practice', 'Offer or contract', 'Something else']);
    expect(supportAu.FAQ_ITEMS).toHaveLength(5);
    expect(supportAu.HELP_ARTICLES.map((a) => a.tag)).toEqual(['Getting started', 'Confidentiality', 'Pre-start', 'Provider number', 'Changing practices']);
    supportAu.HELP_ARTICLES.forEach((a) => { ['id', 'title', 'tag', 'tagBg', 'tagColor', 'bg', 'icon', 'desc', 'content'].forEach((k) => expect(typeof a[k]).toBe('string')); });
    const icons = read('pages/messages.html').match(/const ARTICLE_ICONS = \{[\s\S]*?\n    \};/)[0];
    supportAu.HELP_ARTICLES.forEach((a) => expect(icons).toContain('\n      ' + a.icon + ': '));
    expect(supportAu.ARTICLES_LABEL).toBe('Working with GP Link');
  });

  it('general information only: no pay figures, no legal advice, the confidentiality promise in one wording', () => {
    const all = supportAu.FAQ_ITEMS.concat(supportAu.HELP_ARTICLES).map((a) => [a.title, a.desc || '', a.content].join('\n')).join('\n');
    expect(all).not.toMatch(/\$\s?\d|\d+\s?%|\bk\b a year|per annum|salary of/i);
    expect(all).not.toMatch(/you must|you are required|the law (says|requires)|legally (binding|required)|is unenforceable|is enforceable/i);
    expect(all).toContain('This is general information, not legal advice.');
    expect(all).toContain('We are not able to answer it.');
    const promise = all.match(/never contact your current practice[^.]*\./g) || [];
    expect(promise.length).toBeGreaterThanOrEqual(3);
    promise.forEach((p) => expect(p).toBe('never contact your current practice without asking you first.'));
  });

  it('the page draws from the Australian lists only for an Australian doctor, and its own lists are untouched', () => {
    const page = read('pages/messages.html');
    expect(page).toContain("<script>try{if(window.GPAuDoctor)document.write('<script src=\"/js/support-au.js?v=20261121a\"><\\/script>');}catch(e){}</script>");
    expect(page).toContain('function supportFaqItems() { const au = auSupport(); return au ? au.FAQ_ITEMS : FAQ_ITEMS; }');
    expect(page).toContain('function supportArticles() { const au = auSupport(); return au ? au.HELP_ARTICLES : HELP_ARTICLES; }');
    expect(page).toContain('try { auSupportOn = !!(window.GPAuDoctor && window.GPSupportAu && window.GPAuDoctor.isCandidate()); } catch (e) { auSupportOn = false; }');
    expect(page).toContain('select.innerHTML = DEFAULT_CATEGORY_OPTIONS_HTML;');
    expect(page).toContain('<div class="thread-container" id="detailThread" data-au-raw></div>');
    // run the filter functions as the page defines them
    const src = page.slice(page.indexOf('function auSupport() {'), page.indexOf('const DEFAULT_CATEGORY_OPTIONS_HTML'));
    const make = (on, lists) => new Function('FAQ_ITEMS', 'HELP_ARTICLES', 'window', 'auSupportOn', src + '; return { faq: supportFaqItems(), articles: supportArticles() };')(['overseas-faq'], ['overseas-article'], { GPSupportAu: lists }, on);
    expect(make(true, supportAu)).toEqual({ faq: supportAu.FAQ_ITEMS, articles: supportAu.HELP_ARTICLES });
    expect(make(false, supportAu)).toEqual({ faq: ['overseas-faq'], articles: ['overseas-article'] });
    expect(make(true, undefined)).toEqual({ faq: ['overseas-faq'], articles: ['overseas-article'] });
  });
});

describe('APP-26, D5, D15: Account for an Australian doctor', () => {
  const view = {
    ok: true, launched: true, ahpraNumber: 'MED0001234567', ahpraNumberLocked: false, registrationType: 'specialist', fellowshipType: 'fracgp', fellowshipDetail: '',
    workRights: 'citizen', noticePeriodWeeks: 4, availableFrom: '2026-12-31', currentState: 'NSW', currentSuburb: 'Parramatta', currentPostcode: '2150',
    preferredLocations: ['Sydney', 'Regional NSW'], existingProviderNumbers: [{ number: '2345671A', location: 'Test Current Practice (FAKE)' }], prescriberNumber: '1234567',
    options: { registrationTypes: ['general', 'specialist', 'general_and_specialist', 'provisional', 'limited', 'non_practising'], fellowshipTypes: ['fracgp', 'facrrm', 'both', 'other', 'none'], workRights: ['citizen', 'pr', 'temporary'], states: ['NSW', 'VIC'], locations: ['Sydney', 'Melbourne', 'Regional NSW'] }
  };

  it('shows what is on file, in place of "Relocation Details" and the generic registration field', () => {
    const html = accountAu._viewHtml(view);
    expect(html).toContain('Ahpra registration number');
    expect(html).toContain('value="MED0001234567"');
    expect(html).toContain('<option value="specialist" selected>Specialist (general practice)</option>');
    expect(html).toContain('<option value="fracgp" selected>FRACGP</option>');
    expect(html).toContain('<option value="citizen" selected>Australian citizen</option>');
    expect(html).toContain('<option value="NSW" selected>NSW</option>');
    expect(html).toContain('value="Parramatta"');
    expect(html).toContain('value="4"');
    expect(html).toContain('value="2026-12-31"');
    expect(html).toContain('On file: Sydney, Regional NSW.');
    expect(html).toContain('value="2345671A"');
    expect(html).toContain('value="1234567"');
    expect(html).toContain('Where you are now and when you can start');
    expect(html).not.toContain('AHPRA');
    const page = read('pages/account.html');
    expect(page).toContain('html.gp-au-doctor #relocationSection,');
    expect(page).toContain('html.gp-au-doctor #registrationNumberField { display: none !important; }');
    expect(page).toContain('<section class="section-card" id="relocationSection">');
    expect(page).toContain('tag.src = "/js/account-au.js?v=20261121a";');
    expect(page).toContain('if (!helper || typeof helper.whenKnown !== "function") return;');
  });

  it('the Ahpra number is read-only once our team has checked it', () => {
    const locked = accountAu._viewHtml(Object.assign({}, view, { ahpraNumberLocked: true }));
    expect(locked).toContain('<input id="auAhpraNumber" type="text" readonly value="MED0001234567">');
    expect(locked).toContain('Checked by our team on the public Ahpra register.');
    expect(locked).not.toContain('data-au-field="auAhpraNumber"');
    // and the form does not send it
    const fields = {};
    const el = { querySelector: (sel) => (sel in fields ? fields[sel] : null), querySelectorAll: () => [] };
    fields['#auAhpraNumber'] = { value: 'MED0009999999' };
    expect('ahpraNumber' in accountAu._readForm(el, { ahpraNumberLocked: true })).toBe(false);
    expect(accountAu._readForm(el, { ahpraNumberLocked: false }).ahpraNumber).toBe('MED0009999999');
    // the form has no pathway field of any kind
    expect(accountAu._viewHtml(view)).not.toMatch(/pathway|segment|19AB|moratorium/i);
  });
});
