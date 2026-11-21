/* Australian GP build, fix bundle FB-1 (walk-findings D9, D10, D13, D26).
 *
 * What the careers screens need to know about a doctor on an Australian
 * pathway, in one place:
 *
 *   GPAuDoctor.cached()            their details from the session this tab
 *                                  already holds (no request), or null
 *   GPAuDoctor.refresh()           ask the server now; resolves the same shape
 *   GPAuDoctor.syncEligibility(i)  throw away saved role lists when the
 *                                  doctor's eligibility has changed (D9)
 *   GPAuDoctor.limitsCopy(limits)  every sentence that names an application
 *                                  limit, built from the doctor's own limits (D10)
 *   GPAuDoctor.formatDate(value)   a date the Australian way: 20 Nov 2026 (D26)
 *
 * THIS FILE IS ONLY EVER LOADED FOR A DOCTOR ON AN AUSTRALIAN PATHWAY. Pages
 * decide that with a few inline lines (the device hint that js/au-pathway.js
 * keeps, or the session already saved in this tab) and only then add this
 * script. An overseas doctor's browser never requests it and never runs it,
 * so their screens, requests and saved data are exactly what they were.
 *
 * Where the answers come from: GET /api/auth/session carries, for a doctor on
 * an Australian pathway only (switch on), `auPathway` and
 *   auDoctor: { eligibilityVersion, limits: { active, monthly, interviewsMonthly }, onboardingComplete }
 * (lib/au-doctor-session.js). Anything missing or muddled reads as "not an
 * Australian doctor": null.
 *
 * Load with a cache-buster and bump it whenever this file changes:
 *   /js/au-doctor.js?v=20261121b
 *
 * WP-12 added: the doctor's journey (`info.journey`: stage, the four steps,
 * the entry route), `whenKnown()`, `stageStates()`, `entryRoute()`,
 * `teamLabel()` and the wording an Australian doctor reads on the shared
 * screens (welcome slide, placed slides, careers strip, offer review, Home).
 * Every string in this file is scanned for the AGENT-RULES section 4 words.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GPAuDoctor = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  var SESSION_URL = '/api/auth/session';
  var SESSION_CACHE_KEY = 'gpc:' + SESSION_URL;          // written by js/gp-cache.js
  var HINT_KEY = 'gp_au_pathway_hint';                   // kept by js/au-pathway.js
  var VERSION_KEY = 'gp_au_eligibility_version';         // stored beside the saved role lists
  var ROLE_LIST_CACHE_KEY = 'gp_career_roles_cache';     // pages/career.html, pages/job.html
  var ROLE_DETAIL_CACHE_PREFIX = 'gp_career_role_detail:'; // pages/job.html
  var GP_CACHE_ROLE_PREFIX = 'gpc:/api/career/role';     // /api/career/roles and /api/career/role?...
  var AU_PATHWAYS = { au_vr: true, au_restricted: true, au_non_vr: true, au_registrar: true };
  var LOCALE = 'en-AU';

  function storages(given) {
    var g = given || {};
    var out = { local: g.local || null, session: g.session || null };
    try { if (!out.local && root && root.localStorage) out.local = root.localStorage; } catch (e) { /* private mode */ }
    try { if (!out.session && root && root.sessionStorage) out.session = root.sessionStorage; } catch (e) { /* private mode */ }
    return out;
  }

  function wholeNumber(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0 ? v : null; }

  /**
   * A session response -> the doctor's details, or null unless the response
   * clearly says "switch on, Australian pathway".
   */
  function fromSession(payload) {
    var p = payload && typeof payload === 'object' ? payload : null;
    if (!p || p.auPathwayEnabled !== true) return null;
    var mine = p.auPathway && typeof p.auPathway === 'object' ? p.auPathway : null;
    if (!mine || mine.isAu !== true || !Object.prototype.hasOwnProperty.call(AU_PATHWAYS, String(mine.pathway))) return null;
    var d = p.auDoctor && typeof p.auDoctor === 'object' ? p.auDoctor : {};
    var l = d.limits && typeof d.limits === 'object' ? d.limits : {};
    var limits = { active: wholeNumber(l.active), monthly: wholeNumber(l.monthly), interviewsMonthly: wholeNumber(l.interviewsMonthly) };
    return {
      pathway: String(mine.pathway),
      launched: mine.launched === true,
      journey: readJourney(p.auJourney),
      eligibilityVersion: typeof d.eligibilityVersion === 'string' ? d.eligibilityVersion : '',
      limits: (limits.active && limits.monthly && limits.interviewsMonthly) ? limits : null,
      // Only a definite `false` sends a doctor back to onboarding.
      onboardingComplete: d.onboardingComplete === false ? false : true
    };
  }

  // ── WP-12: the journey ──────────────────────────────────────────────────────
  // The server's ladder is placement -> prestart -> commenced -> guarantee ->
  // complete. A doctor is shown four steps. This is the browser's copy of
  // lib/au-gp-app.js doctorSteps (stage only); the server sends the same list
  // on auJourney.steps and tests/au-wp12-stage-list.test.js keeps them in step.
  var AU_LADDER = ['placement', 'prestart', 'commenced', 'guarantee', 'complete'];
  var ROUTES = { careers: '/pages/career', prestart: '/pages/prestart', providerNumber: '/pages/pbs', documents: '/pages/my-documents', home: '/pages/index' };
  var WAITING_ON_PLACEMENT = 'Opens once your placement is secured';
  var STEP_DEFS = [
    { key: 'placement', title: 'Secure placement', href: ROUTES.careers, description: 'Find the practice that suits you, interview and sign.' },
    { key: 'prestart', title: 'Pre-start checks', href: ROUTES.prestart, description: 'The short list to finish before your first day.' },
    { key: 'provider_number', title: 'Medicare provider number', href: ROUTES.providerNumber, description: 'Your new practice location needs its own provider number.' },
    { key: 'start', title: 'Start date', href: ROUTES.prestart + '#start-date', description: 'Your start date, agreed with you and the practice.' }
  ];
  // Addresses that belong to the journey of a doctor moving country. For an
  // Australian doctor each one leads to their own next step instead (the
  // server redirects them too). The fourth is spelt in two halves so that
  // this file can be scanned whole for the words such a doctor never reads.
  var OTHER_JOURNEY_ROUTES = {};
  ['myinthealth', 'a' + 'mc', 'ahpra', 'vi' + 'sa', 'registration-intro', 'commencement'].forEach(function (name) {
    OTHER_JOURNEY_ROUTES['/pages/' + name] = true;
  });

  function ladderStage(stage) {
    var s = String(stage || '');
    return AU_LADDER.indexOf(s) === -1 ? 'placement' : s;
  }
  function stepsFor(stage, facts) {
    var f = facts && typeof facts === 'object' ? facts : {};
    var s = ladderStage(stage);
    var placed = s !== 'placement';
    var started = s === 'commenced' || s === 'guarantee' || s === 'complete';
    var states = {
      placement: placed ? 'done' : 'current',
      prestart: !placed ? 'locked' : (started || f.prestartDone === true ? 'done' : 'current'),
      provider_number: !placed ? 'locked' : (started || f.providerNumberRecorded === true ? 'done' : 'open'),
      start: !placed ? 'locked' : (started ? 'done' : (f.startDateConfirmed === true ? 'current' : 'open'))
    };
    if (placed && !started && states.prestart === 'done' && states.provider_number !== 'done') states.provider_number = 'current';
    return STEP_DEFS.map(function (step, index) {
      var state = states[step.key];
      return {
        key: step.key, title: step.title, description: step.description, href: step.href, num: index + 1,
        state: state, done: state === 'done', locked: state === 'locked',
        lockReason: state === 'locked' ? WAITING_ON_PLACEMENT : null
      };
    });
  }
  function readJourney(raw) {
    var j = raw && typeof raw === 'object' ? raw : {};
    var stage = ladderStage(j.stage);
    var steps = null;
    if (Array.isArray(j.steps) && j.steps.length === STEP_DEFS.length) {
      steps = [];
      for (var i = 0; i < j.steps.length; i++) {
        var st = j.steps[i];
        if (!st || st.key !== STEP_DEFS[i].key || typeof st.title !== 'string') { steps = null; break; }
        var state = ['done', 'current', 'open', 'locked'].indexOf(st.state) === -1 ? 'locked' : st.state;
        steps.push({
          key: st.key, title: st.title, description: String(st.description || ''), href: STEP_DEFS[i].href, num: i + 1,
          state: state, done: state === 'done', locked: state === 'locked', lockReason: state === 'locked' ? WAITING_ON_PLACEMENT : null
        });
      }
    }
    return {
      stage: stage,
      placed: stage !== 'placement',
      started: stage === 'commenced' || stage === 'guarantee' || stage === 'complete',
      steps: steps || stepsFor(stage),
      entryRoute: stage === 'placement' ? ROUTES.careers : ROUTES.prestart
    };
  }

  /** The session this tab already holds (saved by js/gp-cache.js). No request. */
  function cached(given) {
    var s = storages(given);
    try {
      var raw = s.session ? s.session.getItem(SESSION_CACHE_KEY) : null;
      var entry = raw ? JSON.parse(raw) : null;
      return fromSession(entry && entry.data);
    } catch (e) {
      return null;
    }
  }

  /** Should a page bother loading this file at all? (Pages inline the same test.) */
  function isCandidate(given) {
    var s = storages(given);
    try { if (s.local && s.local.getItem(HINT_KEY) === '1') return true; } catch (e) { /* ignore */ }
    return !!cached(s);
  }

  function remember(isAu, given) {
    var s = storages(given);
    try {
      if (!s.local) return;
      if (isAu) s.local.setItem(HINT_KEY, '1');
      else s.local.removeItem(HINT_KEY);
    } catch (e) { /* ignore */ }
  }

  /**
   * Ask the server now (never the saved copy). Resolves
   *   { ok: true, info: <details or null> }   the server answered
   *   { ok: false, info: null }               it could not be asked
   * The fresh answer is also written where js/gp-cache.js keeps the session,
   * so every other page in the tab sees it.
   */
  function refresh(options) {
    var o = options || {};
    var fetcher = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!fetcher) return Promise.resolve({ ok: false, info: null });
    var s = storages(o.storages);
    return fetcher(SESSION_URL, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (payload) {
        if (!payload || payload.ok !== true) return { ok: false, info: null };
        try { if (s.session) s.session.setItem(SESSION_CACHE_KEY, JSON.stringify({ data: payload, ts: Date.now() })); } catch (e) { /* full or private */ }
        var info = fromSession(payload);
        remember(!!info, s);
        return { ok: true, info: info };
      })
      .catch(function () { return { ok: false, info: null }; });
  }

  /** Throw away every saved copy of a role list or a role's detail. */
  function purgeRoleCaches(given) {
    var s = storages(given);
    var removed = 0;
    var sweep = function (store, test) {
      if (!store) return;
      var keys = [];
      try { for (var i = 0; i < store.length; i++) { var k = store.key(i); if (k && test(k)) keys.push(k); } } catch (e) { return; }
      keys.forEach(function (k) { try { store.removeItem(k); removed++; } catch (e) { /* ignore */ } });
    };
    sweep(s.local, function (k) { return k === ROLE_LIST_CACHE_KEY || k.indexOf(ROLE_DETAIL_CACHE_PREFIX) === 0; });
    sweep(s.session, function (k) { return k.indexOf(GP_CACHE_ROLE_PREFIX) === 0; });
    return removed;
  }

  /**
   * D9. Compare the doctor's eligibility version with the one stored beside
   * the saved role lists. Different (or none stored, or the server sent none):
   * the saved lists are thrown away and the new version is stored.
   * `info` null (not an Australian doctor any more): the stored version is
   * dropped and nothing else is touched.
   * @returns {{ changed: boolean, purged: number }}
   */
  function syncEligibility(info, given) {
    var s = storages(given);
    if (!info) {
      try { if (s.local) s.local.removeItem(VERSION_KEY); } catch (e) { /* ignore */ }
      return { changed: false, purged: 0 };
    }
    var version = String(info.eligibilityVersion || '');
    var stored = '';
    try { stored = (s.local && s.local.getItem(VERSION_KEY)) || ''; } catch (e) { stored = ''; }
    if (version && stored === version) return { changed: false, purged: 0 };
    var purged = purgeRoleCaches(s);
    try {
      if (s.local) {
        if (version) s.local.setItem(VERSION_KEY, version);
        else s.local.removeItem(VERSION_KEY);
      }
    } catch (e) { /* ignore */ }
    return { changed: true, purged: purged };
  }

  /**
   * WP-12. The doctor's details as soon as they can be known: the session this
   * tab holds, else one request. Resolves the details, or null for anyone who
   * is not on an Australian pathway (and when the server cannot be asked).
   */
  var knownPromise = null;
  function whenKnown(options) {
    var o = options || {};
    if (!o.force) {
      var now = cached(o.storages);
      if (now) return Promise.resolve(now);
      if (knownPromise) return knownPromise;
    }
    knownPromise = refresh(o).then(function (r) { return r && r.info ? r.info : null; });
    return knownPromise;
  }

  /** Has a placement been recorded for this doctor (their case is past the first rung)? */
  function isPlaced(info) {
    var i = info || cached();
    return !!(i && i.journey && i.journey.placed);
  }

  /**
   * APP-09. Where "start / continue" leads: Careers until a placement is
   * recorded, the pre-start page after it. Never a step of the other journey.
   */
  function entryRoute(info) {
    var i = info || cached();
    return i && i.journey ? i.journey.entryRoute : ROUTES.careers;
  }

  /** Is this address one that belongs to the other journey? (path only, no query) */
  function isOtherJourneyRoute(path) {
    var p = String(path || '').split('?')[0].split('#')[0].replace(/\.html$/i, '');
    return Object.prototype.hasOwnProperty.call(OTHER_JOURNEY_ROUTES, p);
  }

  /**
   * APP-08. The four steps in the shape js/journey-stages.js getStageStates
   * returns, so every consumer of the stage list (the shell's progress menu,
   * Home, the slides) can draw them with no change of its own.
   */
  function stageStates(info, facts) {
    var i = info || cached();
    var stage = i && i.journey ? i.journey.stage : 'placement';
    var steps = facts ? stepsFor(stage, facts) : (i && i.journey ? i.journey.steps : stepsFor(stage));
    return steps.map(function (st) {
      return {
        key: st.key, title: st.title, page: st.href.replace(/^\/pages\//, '').split('#')[0], href: st.href,
        description: st.description, num: st.num, state: st.state,
        done: st.done, locked: st.locked, positionLocked: st.locked, lockReason: st.lockReason
      };
    });
  }

  /**
   * D19. The neutral name for the people at GP Link: a consultant looks after
   * an Australian GP until placement, a small team after it.
   */
  function teamLabel(placed) {
    return placed ? 'your GP Link team' : 'your GP Link consultant';
  }
  function TeamLabel(placed) {
    return placed ? 'Your GP Link team' : 'Your GP Link consultant';
  }

  var CONFIDENTIAL = 'We never contact your current practice without asking you first.';

  /**
   * D1, D20. ONE short welcome between finishing onboarding and seeing a role.
   * `name` is how the slide greets the doctor ("Dr Sam").
   */
  function welcomeSlides(ctx) {
    var c = ctx && typeof ctx === 'object' ? ctx : {};
    var copy = limitsCopy(c.limits);
    return [{
      icon: 'wave', kicker: 'Welcome to GP Link', title: 'Welcome, ' + (c.name || 'Doctor'),
      body: 'Browse roles that fit you, meet the practice, and sign your offer here in the app. After that there is a short pre-start checklist, and then your first day. ' + CONFIDENTIAL,
      note: copy ? copy.slideNote : '',
      cta: 'See roles'
    }];
  }

  /** The slides a doctor sees once, when their placement is recorded. */
  function placedSlides(ctx) {
    var c = ctx && typeof ctx === 'object' ? ctx : {};
    var practice = String(c.practiceName || '').trim();
    var rest = STEP_DEFS.slice(1).map(function (s) { return { title: s.title, sub: s.description }; });
    return [
      {
        icon: 'trophy', kicker: 'Position secured', title: 'Congratulations, ' + (c.name || 'Doctor'),
        body: (practice ? 'Your position at ' + practice + ' is secured.' : 'Your position is secured.')
          + ' What is left is a short pre-start checklist before your first day.',
        bullets: rest
      },
      {
        icon: 'tabs', kicker: 'New tabs', title: 'Your app just grew',
        body: 'Home shows your steps and what is next. My Documents holds your certificates. Support is where your GP Link team replies.',
        cta: 'Open my pre-start checklist'
      }
    ];
  }

  /** APP-16. The careers "where am I" strip: step 4 for an Australian doctor. */
  var STRIP_STEP_FOUR = 'Pre-start';

  /** APP-20. What the offer and signing screens say once the contract is signed. */
  var offerCopy = {
    securedSub: 'Congratulations. Your placement is confirmed. Your GP Link team will guide you through a short pre-start checklist before your first day.',
    securedSubSigned: 'Congratulations. Your signed agreement is in and your placement is confirmed. Your GP Link team will guide you through a short pre-start checklist before your first day.',
    securedCta: 'Open my pre-start checklist',
    teamHeading: 'Your GP Link consultant',
    stepContract: '<strong>Contract &amp; pre-start</strong>: your GP Link consultant sends the formal contract, then a short pre-start checklist opens',
    stepArea: '<strong>Getting to know the area</strong>: housing search and area guides for your new practice'
  };

  /** APP-20. Careers wording. */
  var careersCopy = {
    heroHelp: 'Questions about a role? Talk to your GP Link consultant any time.',
    unverifiedNote: 'More roles may open once we have confirmed your registration.',
    securedProgress: 'Pre-start progress',
    securedNext: 'Continue your pre-start checklist',
    areaHeading: 'Explore the area',
    movingAllowance: 'Moving allowance'
  };

  /** D17. What a doctor whose details are still with our team reads. */
  var holdCopy = {
    title: 'Thanks, we have your details',
    body: 'Thank you for telling us about your registration. Before we show you roles, one of our team needs to confirm a few details with you. You do not need to do anything now: we will be in touch by email, usually within two working days.',
    action: 'See where things are up to'
  };

  /** D26. 20 Nov 2026. `options` are Intl options; '' for a value that is not a date. */
  function formatDate(value, options) {
    if (value === null || value === undefined || value === '') return '';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(LOCALE, options || { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  /**
   * D10. Every sentence that names an application limit. null when the limits
   * are not known: the page then leaves its own wording alone rather than
   * print a sentence with a hole in it.
   */
  function limitsCopy(limits) {
    var l = limits && typeof limits === 'object' ? limits : null;
    var a = l ? wholeNumber(l.active) : null;
    var m = l ? wholeNumber(l.monthly) : null;
    var n = l ? wholeNumber(l.interviewsMonthly) : null;
    if (!a || !m || !n) return null;
    return {
      active: a, monthly: m, interviewsMonthly: n,
      activeHeading: a + ' live applications at a time',
      activeBody: 'You can have ' + a + ' applications in play at once. To apply for another, withdraw one of your current applications first. We will show you which ones they are.',
      monthlyHeading: m + ' positions a month',
      monthlyBody: 'Across a calendar month you can apply for ' + m + ' positions in total. Your allowance resets on the 1st. Withdrawing frees up a live slot, but it does not give the month\'s application back.',
      whyBody: 'When we introduce you, a real practice blocks out time to read your CV and meet you. Keeping each doctor to ' + a + ' live applications means every introduction we make is one you actually want. That is why practices take our candidates seriously, and why our doctors get interviews.',
      slideNote: 'You can have ' + a + ' applications in play at once, and ' + m + ' in a calendar month. Withdrawing from a position is final.',
      applyIntro: 'You can interview for up to ' + n + ' positions per month, so accept the roles you are genuinely serious about.',
      applyIntroMatch: 'This puts you in front of the practice for an interview. You can interview for up to ' + n + ' positions per month, so use it on the ones you are genuinely serious about.',
      activeCapTitle: 'You already have ' + a + ' live applications',
      activeCapBody: function (verb) {
        return 'You can have ' + a + ' applications in play at a time. To ' + (verb || 'apply for this position') + ', withdraw one of your current applications first.';
      },
      monthlyCapTitle: 'That\'s your ' + m + ' positions for this month',
      monthlyCapBody: 'You can apply for ' + m + ' positions each calendar month. Your allowance resets at the start of next month.',
      withdrawnBlurb: 'You withdrew this application. It no longer counts towards your ' + a + ' live applications.'
    };
  }

  return {
    SESSION_CACHE_KEY: SESSION_CACHE_KEY,
    HINT_KEY: HINT_KEY,
    VERSION_KEY: VERSION_KEY,
    ROLE_LIST_CACHE_KEY: ROLE_LIST_CACHE_KEY,
    ROLE_DETAIL_CACHE_PREFIX: ROLE_DETAIL_CACHE_PREFIX,
    LOCALE: LOCALE,
    fromSession: fromSession,
    cached: cached,
    isCandidate: isCandidate,
    refresh: refresh,
    purgeRoleCaches: purgeRoleCaches,
    syncEligibility: syncEligibility,
    formatDate: formatDate,
    limitsCopy: limitsCopy,
    // WP-12
    ROUTES: ROUTES,
    STEP_DEFS: STEP_DEFS,
    WAITING_ON_PLACEMENT: WAITING_ON_PLACEMENT,
    CONFIDENTIAL: CONFIDENTIAL,
    STRIP_STEP_FOUR: STRIP_STEP_FOUR,
    stepsFor: stepsFor,
    readJourney: readJourney,
    whenKnown: whenKnown,
    isPlaced: isPlaced,
    entryRoute: entryRoute,
    isOtherJourneyRoute: isOtherJourneyRoute,
    stageStates: stageStates,
    teamLabel: teamLabel,
    TeamLabel: TeamLabel,
    welcomeSlides: welcomeSlides,
    placedSlides: placedSlides,
    offerCopy: offerCopy,
    careersCopy: careersCopy,
    holdCopy: holdCopy
  };
});
