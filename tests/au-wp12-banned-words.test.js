// WP-12 acceptance: a doctor on an Australian pathway never reads MyIntealth,
// AMC, EPIC, visa, relocate / relocation, "your move", overseas,
// internationally trained, GMC, SPPA, Section G, supervisor CV or "Not yet
// eligible" anywhere in the app (AGENT-RULES section 4).
//
// Three kinds of screen, three kinds of proof:
//
//   A. Files only an Australian doctor is ever sent (Home, the pre-start
//      page, the provider-number step, their documents page, and the scripts
//      behind them). Scanned WHOLE, markup and code included.
//   B. What the Australian builders produce (slides, checklist, role facts,
//      support articles, Account block, server wording). Rendered, then
//      scanned.
//   C. Screens shared with every other doctor (Careers, a job, an
//      application, the offer and signing screens, the interview and area
//      pages, Account, Support, the shell and its tours). Every piece of
//      text a person could read in each file is put through the guard that
//      runs on those pages for an Australian doctor (js/au-localise.js) and
//      must come out clean; and each page must load that guard.
//
// The same scan was run on the running app at 390px (docs/au-gp/screenshots/wp12).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const requireCjs = createRequire(import.meta.url);
const ROOT = decodeURIComponent(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const words = requireCjs('./helpers/au-banned-words.js');
const parity = requireCjs('./helpers/au-wp12-parity.js');
const doctorText = requireCjs('../lib/au-doctor-text.js');
const gpApp = requireCjs('../lib/au-gp-app.js');
const details = requireCjs('../lib/au-doctor-details.js');
const journeyLadders = requireCjs('../lib/journey-ladders.js');
const documentRequirements = requireCjs('../lib/document-requirements.js');
const auDoctor = requireCjs('../js/au-doctor.js');
const auPrestartPage = requireCjs('../js/au-prestart.js');
const accountAu = requireCjs('../js/account-au.js');
const supportAu = requireCjs('../js/support-au.js');
const jobFacts = requireCjs('../js/au-job-facts.js');
const strip = requireCjs('../js/career-step-strip.js');
const localise = requireCjs('../js/au-localise.js');
const myDocs = requireCjs('../js/my-documents-au.js');

const clean = (text, label) => expect(words.bannedLines(text), label).toEqual([]);

describe('the scanner itself', () => {
  it('finds each word', () => {
    expect(words.bannedIn('Open MyIntealth, then the AMC and EPIC steps')).toEqual(['MyIntealth', 'AMC', 'EPIC']);
    expect(words.bannedIn('your visa, your relocation and your move overseas')).toEqual(['visa', 'relocate / relocation', 'your move', 'overseas']);
    expect(words.bannedIn('internationally trained, GMC, SPPA-00, Section G and the supervisor CV')).toEqual(['internationally trained', 'GMC', 'SPPA', 'Section G', 'supervisor CV']);
    expect(words.bannedIn('Not yet eligible')).toEqual(['Not yet eligible']);
    expect(words.bannedIn('My Intealth, visas, relocating, relocate, internationally-trained')).toEqual(['MyIntealth', 'visa', 'relocate / relocation', 'internationally trained']);
  });

  it('is precise about word boundaries', () => {
    ['It is advisable to ask.', 'An advisory note.', 'They moved last year.', 'Remove the old file.', 'Your movement is tracked.', 'The epicentre of town.',
      'A supervisory role.', 'In section General.', 'Your Ahpra registration number, FRACGP, right to work.', 'Visage clinic.', 'gp_amc_progress', 'An allocation of sessions.']
      .forEach((s) => expect(words.bannedIn(s), s).toEqual([]));
  });

  it('the browser guard uses the same list as the server', () => {
    expect(localise.BANNED.map((p) => [p[0], p[1].source, p[1].flags])).toEqual(doctorText.BANNED_WORDS.map((p) => [p[0], p[1].source, p[1].flags]));
  });
});

describe('A. files only an Australian doctor is ever sent: scanned whole', () => {
  ['pages/index-au.html', 'pages/prestart.html', 'pages/pbs-au.html', 'pages/my-documents-au.html',
    'js/au-prestart.js', 'js/account-au.js', 'js/support-au.js', 'js/au-job-facts.js', 'css/au-app.css'].forEach((file) => {
    it(file + ' (comments and identifiers included)', () => clean(read(file), file));
  });

  it('js/au-doctor.js and the server builders: everything except comments', () => {
    clean(words.stripJsComments(read('js/au-doctor.js')), 'js/au-doctor.js');
    clean(words.stripJsComments(read('lib/au-gp-app.js')), 'lib/au-gp-app.js');
    clean(words.stripJsComments(read('lib/au-doctor-details.js')), 'lib/au-doctor-details.js');
  });

  it('those pages load only Australian or shared scripts, and are never kept by the service worker', () => {
    const server = read('server.js');
    expect(server).toContain("const AU_ONLY_PAGE_FILES = new Set([AU_HOME_PAGE, AU_PBS_PAGE, AU_PRESTART_PAGE]);");
    expect(server).toContain("if (AU_ONLY_PAGE_FILES.has(pathname)) return 'private, no-store';");
    ['pages/index-au.html', 'pages/prestart.html', 'pages/pbs-au.html'].forEach((p) => {
      const html = read(p);
      expect(html, p).toContain('<script src="/js/au-prestart.js?v=20261121b"></script>');
      expect(html, p).toContain('<link rel="stylesheet" href="/css/au-app.css?v=20261121a" />');
      expect(html, p).not.toMatch(/gp-walkthrough|qualification-scan|journey-stages/);
      expect(read('sw.js'), p).not.toContain(p.replace('pages/', '/pages/').replace('.html', ''));
    });
    expect(read('pages/prestart.html')).toContain('<script src="/js/my-documents-au.js?v=20261121a"></script>');
  });
});

describe('B. what the Australian builders produce', () => {
  const allSteps = journeyLadders.AU_STAGES.map((st) => gpApp.doctorSteps(st)).concat([gpApp.doctorSteps('prestart', { prestartDone: true, providerNumberRecorded: true, startDateConfirmed: true })]);
  const docItems = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'].map((pathway) =>
    documentRequirements.auDocumentRequirements({ pathway, isAu: true, launched: pathway === 'au_vr', segment: pathway === 'au_vr' ? 'A' : (pathway === 'au_restricted' ? 'B' : 'C') }, { phase: 'prestart' }).items
      .filter((i) => i.provider === 'you').map((i) => ({ key: i.key, label: i.label, short: i.short, required: i.required, phase: 'prestart', provider: 'you', status: 'pending' })));
  const statuses = ['pending', 'uploaded', 'under_review', 'approved', 'rejected'];
  const views = [];
  docItems.forEach((docs) => {
    statuses.forEach((status, n) => {
      const checklist = gpApp.buildPrestartChecklist({
        placement: { key: 'k', practiceName: n % 2 ? 'Test Metro Practice (FAKE)' : '', startDate: n % 2 ? '2027-02-01' : '' },
        tasks: n > 2 ? [{ task_type: 'start_date_tracking', status: 'completed', metadata: { confirmed_start_date: '2027-02-08' } }, { task_type: 'credentialing_pack', status: 'completed', metadata: {} }, { task_type: 'reference_check', status: 'completed', metadata: {} }] : [],
        documents: docs.map((d) => Object.assign({}, d, { status, note: status === 'rejected' ? 'The date is cut off.' : '' })),
        allDocuments: [], registerChecked: n > 1, registerCheckOpen: n < 2,
        details: n > 1 ? details.doctorView({ notice_given: true, notice_given_date: '2026-11-19', referees: [{ name: 'A' }, { name: 'B' }] }) : details.doctorView(null),
        providerNumber: { recorded: n > 2, number: '123456AB' }
      });
      ['provider_number_new_location', 'provider_number_plus_19ab_check', 'provider_number_plus_program_approval', 'overseas', ''].forEach((variant) => {
        views.push({
          ok: true, placed: true, launched: true, stage: 'prestart', steps: gpApp.doctorSteps('prestart', checklist.facts), items: checklist.items, complete: checklist.complete, counts: checklist.counts,
          practiceName: n % 2 ? 'Test Metro Practice (FAKE)' : '', startDate: checklist.startDate, startDateConfirmed: checklist.startDateConfirmed, teamLabel: gpApp.teamLabel(true),
          providerNumber: { recorded: n > 2, number: '123456AB' }, providerStep: gpApp.providerNumberStep(variant, { practiceName: n % 2 ? 'Test Metro Practice (FAKE)' : '' }), details: details.doctorView(null)
        });
      });
    });
  });
  const unplaced = [true, false].map((launched) => ({ ok: true, placed: false, launched, stage: 'placement', steps: gpApp.doctorSteps('placement'), items: [], teamLabel: gpApp.teamLabel(false), providerStep: gpApp.providerNumberStep('', {}), details: details.doctorView(null) }));

  it('the four steps, in every state', () => {
    clean(words.allStrings(allSteps), 'doctorSteps');
    clean(words.allStrings(journeyLadders.AU_STAGES.map((st) => auDoctor.stageStates(auDoctor.fromSession({ ok: true, auPathwayEnabled: true, auPathway: { pathway: 'au_vr', isAu: true, launched: true }, auJourney: { stage: st } })))), 'stageStates');
    clean(words.allStrings(journeyLadders.AU_LADDER.map((s) => s.gpLabel)), 'ladder labels');
  });

  it('Home, the pre-start checklist and the provider-number step, for every segment, document state and variant', () => {
    expect(views.length).toBe(100);
    views.concat(unplaced).forEach((view, i) => {
      clean(words.allStrings(view), 'view ' + i);
      clean(auPrestartPage._homeHtml(view), 'home ' + i);
      clean(auPrestartPage._prestartHtml(view, { open: 'referees' }), 'prestart ' + i);
      clean(auPrestartPage._providerHtml(view, { extraRows: 1 }), 'provider ' + i);
    });
    [null, {}, { ok: false }].forEach((bad) => { clean(auPrestartPage._homeHtml(bad), 'home error'); clean(auPrestartPage._prestartHtml(bad), 'prestart error'); clean(auPrestartPage._providerHtml(bad), 'provider error'); });
  });

  it('the document card drawn on the pre-start page (WP-07\'s card), for every item and state', () => {
    docItems.forEach((docs) => docs.forEach((d) => statuses.forEach((status) => {
      clean(myDocs._cardHtml(Object.assign({ help: [], expiryTracked: false, canUpload: true, fileName: 'file.pdf', updatedAt: '2026-11-21T00:00:00Z' }, d, { status }), Date.now()), d.key + ' ' + status);
    })));
  });

  it('every error a doctor can be shown by the cleaners', () => {
    const errors = [
      details.sanitiseReferees([{}, {}]).errors, details.sanitiseReferees(null).errors, details.sanitiseReferees([{ name: 'A A', role: 'r', relationship: 'r', phone: '0400000000', agreedToContact: true, atCurrentPractice: true }, { name: 'A A', role: 'r', relationship: 'r', phone: '0400000000', agreedToContact: true, atCurrentPractice: true }]).errors,
      details.sanitiseNotice({}).errors, details.sanitiseNotice({ given: true }).errors, details.sanitiseNotice({ given: true, date: '2099-01-01' }).errors, details.sanitiseNotice({ given: true, date: '2001-01-01' }).errors,
      details.sanitiseExistingNumbers({ existingProviderNumbers: [{ number: 'x' }], prescriberNumber: 'x' }).errors,
      details.sanitiseExistingNumbers({ existingProviderNumbers: Array.from({ length: 12 }, (_, i) => ({ number: '12345' + i + 'AB'.slice(0, 2) })) }).errors
    ];
    clean(words.allStrings(errors), 'cleaner errors');
  });

  it('the welcome slide, the placed slides, the careers strip, limits, hold and offer wording', () => {
    const limits = { active: 4, monthly: 6, interviewsMonthly: 6 };
    clean(words.allStrings([auDoctor.welcomeSlides({ name: 'Dr Auvr', limits }), auDoctor.welcomeSlides({}), auDoctor.placedSlides({ name: 'Dr Auvr', practiceName: 'Test Metro Practice (FAKE)' }), auDoctor.placedSlides({})]), 'slides');
    clean(words.allStrings([auDoctor.offerCopy, auDoctor.careersCopy, auDoctor.holdCopy, auDoctor.CONFIDENTIAL, auDoctor.STRIP_STEP_FOUR, auDoctor.teamLabel(true), auDoctor.teamLabel(false), auDoctor.WAITING_ON_PLACEMENT]), 'copy');
    const copy = auDoctor.limitsCopy(limits);
    clean(words.allStrings(Object.keys(copy).map((k) => (typeof copy[k] === 'function' ? copy[k]('apply') : copy[k]))), 'limits');
    const au = { stepFourLabel: auDoctor.STRIP_STEP_FOUR, securedHint: 'Your position is secured. Your pre-start checklist is ready.', securedHref: 'prestart', securedCta: auDoctor.offerCopy.securedCta };
    const apps = [[], [{ id: 'a', status: 'applied' }], [{ id: 'a', status: 'matched', roleId: 'r' }], [{ id: 'a', status: 'fast_tracked' }], [{ id: 'a', status: 'interview' }], [{ id: 'a', status: 'interview', interview: { scheduledAt: '2026-12-01T00:00:00Z' } }],
      [{ id: 'a', status: 'interview_completed' }], [{ id: 'a', status: 'offer', offerPending: true }], [{ id: 'a', status: 'offer', contractStage: 'sent_to_gp' }], [{ id: 'a', status: 'offer', contractStage: 'practice_review' }],
      [{ id: 'a', status: 'finalising_placement' }], [{ id: 'a', status: 'offer' }], [{ id: 'a', status: 'submitted' }], [{ id: 'a', status: 'placement_secured', isPlacementSecured: true }]];
    clean(words.allStrings(apps.map((a) => strip.deriveCareerStep(a, au))), 'careers strip');
  });

  it('role facts, support (categories, answers, articles) and the Account block', () => {
    const facts = [];
    ['bulk', 'mixed', 'private', ''].forEach((billingModel) => ['vr_required', 'vr_preferred', 'non_vr_accepted', ''].forEach((vrRequirement) => ['yes', 'no', 'unknown'].forEach((dpa) => {
      facts.push(jobFacts.rows({ billingModel, vrRequirement, dpa, sessionsMin: 4, sessionsMax: 9, mmm: 2, area: 'regional', engagementType: 'contract', specialInterests: ['Skin'], acceptsRegistrars: true }, { showDpa: true }));
    })));
    clean(words.allStrings(facts), 'job facts');
    clean(words.allStrings([supportAu.CATEGORIES, supportAu.FAQ_ITEMS, supportAu.HELP_ARTICLES, supportAu.ARTICLES_LABEL, supportAu.SUBJECT_PLACEHOLDER]), 'support');
    const options = { registrationTypes: ['general', 'specialist', 'general_and_specialist', 'provisional', 'limited', 'non_practising'], fellowshipTypes: ['fracgp', 'facrrm', 'both', 'other', 'none'], workRights: ['citizen', 'pr', 'temporary'], states: ['NSW'], locations: ['Sydney'] };
    [true, false].forEach((locked) => ['citizen', 'pr', 'temporary', ''].forEach((workRights) => {
      clean(accountAu._viewHtml({ ok: true, ahpraNumber: 'MED0001234567', ahpraNumberLocked: locked, registrationType: 'limited', fellowshipType: 'other', fellowshipDetail: '', workRights, noticePeriodWeeks: 4, availableFrom: '', currentState: 'NSW', currentSuburb: '', currentPostcode: '', preferredLocations: [], existingProviderNumbers: [], prescriberNumber: '', options }), 'account ' + locked + workRights);
    }));
    clean(accountAu._viewHtml(null), 'account error');
    // what the browser sends back for a time-limited right to work is the word "temporary"
    expect(JSON.stringify(accountAu.WORK_RIGHTS_LABELS)).not.toMatch(/visa/i);
  });

  it('the server\'s last line of defence leaves nothing in a role or placement payload', () => {
    const dirty = {
      title: 'GP wanted: visa sponsorship, relocation covered', summary: 'Open to overseas-trained GPs. Internationally trained doctors welcome. Great hours.',
      benefits: ['Visa and PR pathway support', 'Relocation support', 'DPA-aligned pathway', 'Mixed billing patient base'], tags: ['Visa pathway aligned', 'Relocation covered'],
      support: 'Relocation, visa and family-settlement support can be discussed with GP Link.',
      placement: { nextSteps: [{ key: 'ahpra', title: 'AHPRA registration', summary: 'Start your MyIntealth account, then the AMC portfolio.' }], quickStats: [{ label: 'Relocation package', value: 'Pending' }, { label: 'Relocation Package', value: '$10,000AUD' }],
        lifestyle: { heading: 'Relocation Explorer', intro: 'Explore live homes and nearby schools around the practice before you relocate.' }, notes: 'Section G and SPPA-00 with your supervisor CV. Not yet eligible. Your move, your way.' }
    };
    const out = doctorText.scrubRolePayload(dirty);
    clean(words.allStrings(out), 'scrubbed payload');
    expect(out.benefits).toEqual(['DPA-aligned pathway', 'Mixed billing patient base']);
    expect(out.summary).toBe('Great hours.');
  });
});

// C. the shared screens ---------------------------------------------------------
const SHARED_PAGES = ['pages/career.html', 'pages/job.html', 'pages/offer-review.html', 'pages/application-detail.html', 'pages/secure-interview.html',
  'pages/confirm-call.html', 'pages/area-guide.html', 'pages/account.html', 'pages/messages.html', 'pages/app-shell.html'];
const SHARED_SCRIPTS = ['js/app-shell.js', 'js/gp-intro-slides.js', 'js/gp-walkthrough.js', 'js/gp-walkthrough-shell.js', 'js/career-step-strip.js',
  'js/journey-stages.js', 'js/updates-sync.js', 'js/career-home-card.js', 'js/match-popup.js', 'js/interview-popup.js', 'js/contract-popup.js', 'js/placement-secured.js', 'js/account-dropdown.js'];
const LOADER_TAIL = "document.write('<script src=\"/js/au-doctor.js?v=20261121b\"><\\/script><script src=\"/js/au-localise.js?v=20261121a\"><\\/script>');";

describe('C. screens shared with every other doctor', () => {
  it('the phrases the walk found are replaced by an Australian equivalent, not just removed', () => {
    const t = (s, placed) => localise.safeText(s, placed);
    expect(t('Talk to our team about your move — any time.', false)).toBe('Questions about a role? Talk to your GP Link consultant any time.');
    expect(t('Your GP Link officer will guide you through the remaining registration steps.', true)).toBe('Your GP Link team will guide you through a short pre-start checklist before your first day.');
    expect(t('Start my registration', true)).toBe('Open my pre-start checklist');
    expect(t('Your secured role and relocation progress', true)).toBe('Your secured role and pre-start progress');
    expect(t('Continue your specialist registration steps', true)).toBe('Continue your pre-start checklist');
    expect(t('Relocation package', true)).toBe('Moving allowance');
    expect(t('Relocation Package', true)).toBe('Moving allowance');
    expect(t('Relocation Explorer', true)).toBe('Explore the area');
    expect(t('Explore housing and schooling around the practice before you relocate.', true)).toBe('Explore housing and schooling around the practice before you start.');
    expect(t('Relocation Details', false)).toBe('Where you are now');
    expect(t('Relocation support', false)).toBe('Moving support');
    expect(t('Curated for your move · 3+ beds', true)).toBe('Curated for you · 3+ beds');
    expect(t('Contract & registration', false)).toBe('Contract & pre-start');
    expect(t('Chat to your officer via WhatsApp', false)).toBe('Chat to us on WhatsApp');
  });

  it('anything else that carries one of the words loses that sentence, and clean text is returned exactly as it was', () => {
    expect(localise.safeText('Great team. Visa sponsorship available. Close to the beach.', false)).toBe('Great team. Close to the beach.');
    expect(localise.safeText('EPIC / MyIntealth', false)).toBe('');
    expect(localise.safeText('Yes — open to overseas-trained GPs', false)).toBe('');
    expect(localise.safeText('  Pick a time that works for you.  ', false)).toBe('  Pick a time that works for you.  ');
    ['It is advisable to ask.', 'They moved last year.', 'Remove this file', '4. Pre-start', ''].forEach((s) => expect(localise.safeText(s, true)).toBe(s));
  });

  SHARED_PAGES.concat(SHARED_SCRIPTS).forEach((file) => {
    it(file + ': every readable string comes out of the guard clean', () => {
      const strings = parity.stringsOf(file, read(file));
      expect(strings.length).toBeGreaterThan(0);
      const left = [];
      strings.forEach((s) => [false, true].forEach((placed) => {
        const out = localise.safeText(s, placed);
        const v = doctorText.violations(out);
        if (v.length) left.push('[' + v.join(', ') + '] ' + out.slice(0, 160));
      }));
      expect(left).toEqual([]);
    });
  });

  it('each shared page loads the guard, behind the "is this an Australian doctor?" test, and never any other way', () => {
    SHARED_PAGES.forEach((p) => {
      const html = read(p);
      expect(html, p).toContain(LOADER_TAIL);
      expect(html.split(LOADER_TAIL), p).toHaveLength(2);
      expect(html.split(LOADER_TAIL).join(''), p).not.toMatch(/<script src="[^"]*au-localise\.js/);
      const guard = html.slice(html.lastIndexOf('<script>', html.indexOf(LOADER_TAIL)), html.indexOf(LOADER_TAIL));
      expect(guard, p).toContain('localStorage.getItem("gp_au_pathway_hint")==="1"');
      expect(guard, p).toContain('raw.indexOf(\'"isAu":true\')!==-1');
    });
    expect(read('sw.js')).not.toContain('au-localise.js');
    expect(read('sw.js')).not.toContain('au-doctor.js');
  });

  it('the guard starts by itself, holds the page back while it does not know, and leaves anything a person typed alone', () => {
    const src = read('js/au-localise.js');
    expect(src).toContain("try { start({ shell: root.__gpAuShell === true }); } catch (e) { /* the page still works */ }");
    expect(src).toContain("if (info) { begin(helper.isPlaced(info)); watchPlacement(helper); return; }");
    expect(src).toContain('if (!candidate) return;');
    expect(src).toContain('if (!o.shell) hold();');
    expect(src).toContain("if (known) { begin(helper.isPlaced(known)); watchPlacement(helper); }");
    expect(src).toContain("if (el.hasAttribute && el.hasAttribute('data-au-raw')) return true;");
    expect(src).toContain('if (el.isContentEditable === true) return true;');
    expect(src).toContain('var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TEMPLATE: 1 };');
    // run it against a small fake document: a "not Australian" session leaves the page untouched
    const made = [];
    const fakeDoc = { documentElement: { classList: { add: (c) => made.push('add ' + c), remove: (c) => made.push('remove ' + c) } }, getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } };
    const run = (helper) => { made.length = 0; const win = { document: fakeDoc, GPAuDoctor: helper, __gpAuLocaliseManual: true, setTimeout: () => 1, clearTimeout: () => {} }; return new Function('window', 'module', src + '; return window.GPAuLocalise;')(win, undefined); };
    const notAu = run({ cached: () => null, isCandidate: () => false, whenKnown: () => Promise.resolve(null), isPlaced: () => false });
    notAu.start({});
    expect(notAu.isActive()).toBe(false);
    expect(made).toEqual([]);
  });
});
