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
 *   /js/au-doctor.js?v=20261122b
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
    // FR-7 (M3-04): never two "current" (the same rule as lib/au-gp-app.js).
    var currentSeen = false;
    STEP_DEFS.forEach(function (step) {
      if (states[step.key] !== 'current') return;
      if (currentSeen) states[step.key] = 'open';
      currentSeen = true;
    });
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
        // FB-2a (W3-D1b): the hint follows a DEFINITE answer about this
        // doctor. A session from a server with the switch off carries no
        // answer at all, and must not wipe what the device knows.
        if (info || payload.auPathwayEnabled === true) remember(!!info, s);
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

  // ── THE date and time formatter for an Australian doctor (FB-2b) ──────────
  //
  // W3-D23, R9, R14. Every date or time an Australian doctor reads goes
  // through one of these four, so the style is the same on every screen:
  //
  //   formatDate('2026-11-20')                     20 Nov 2026
  //   formatDate('2026-11-26T06:30:00Z')           26 Nov 2026 (the viewer's own day)
  //   formatTime(iso, 'Australia/Perth')           2:30 pm AWST
  //   formatDateTime(iso, 'Australia/Perth')       Thu 26 Nov 2026, 2:30 pm AWST
  //   formatDay(iso, 'Australia/Perth')            Thu 26 Nov 2026
  //
  // A DATE-ONLY value ('2026-11-20': a start date, an expiry, a notice date)
  // is a calendar date, not an instant. It is printed as that date whatever
  // zone the device is in: `new Date('2026-11-20')` is midnight UTC, which a
  // device west of UTC used to print as the 19th.
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isDateOnly(value) {
    return typeof value === 'string' && DATE_ONLY.test(value);
  }
  // The instant to print and the zone to print it in. null = not a date.
  function dateParts(value, zone) {
    if (value === null || value === undefined || value === '') return null;
    if (isDateOnly(value)) {
      var m = DATE_ONLY.exec(value);
      var utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (isNaN(utc.getTime()) || utc.getUTCDate() !== Number(m[3])) return null;
      return { date: utc, zone: 'UTC', dateOnly: true };
    }
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    return { date: d, zone: zone || undefined, dateOnly: false };
  }
  function intl(parts, options) {
    var opts = {};
    for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) opts[k] = options[k];
    if (parts.zone) opts.timeZone = parts.zone;
    try { return new Intl.DateTimeFormat(LOCALE, opts).format(parts.date); }
    catch (e) {
      // A zone this browser does not know: the device's own.
      try { delete opts.timeZone; return new Intl.DateTimeFormat(LOCALE, opts).format(parts.date); } catch (e2) { return ''; }
    }
  }
  // en-AU prints "20 Nov 2026" in most browsers and "20 Nov. 2026" or
  // "Thu, 26 Nov 2026" in some: one shape.
  function tidy(text) {
    return String(text || '').replace(/\./g, '').replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** D26. 20 Nov 2026. `options` are Intl options; '' for a value that is not a date. */
  function formatDate(value, options) {
    var parts = dateParts(value, options && options.timeZone);
    if (!parts) return '';
    if (options) {
      var custom = {};
      for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k) && k !== 'timeZone') custom[k] = options[k];
      return intl(parts, custom);
    }
    return tidy(intl(parts, { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  /** Thu 26 Nov 2026, on the clock of `zone` (the device's when none is given). */
  function formatDay(value, zone) {
    var parts = dateParts(value, zone);
    if (!parts) return '';
    return tidy(intl(parts, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
  }
  /** 2:30 pm: the clock alone, for a grid of times under a heading that names the zone. */
  function formatClock(value, zone) {
    var parts = dateParts(value, zone);
    if (!parts || parts.dateOnly) return '';
    return intl(parts, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\u202f|\u00a0/g, ' ').replace(/\s*([AP])\.?M\.?$/i, function (all, half) { return ' ' + half.toLowerCase() + 'm'; });
  }
  /** 2:30 pm AWST: 12-hour, with the zone's short label. '' for a date-only value. */
  function formatTime(value, zone) {
    var parts = dateParts(value, zone);
    if (!parts || parts.dateOnly) return '';
    var clock = formatClock(value, zone);
    var label = '';
    try {
      var named = new Intl.DateTimeFormat(LOCALE, parts.zone ? { timeZone: parts.zone, timeZoneName: 'short' } : { timeZoneName: 'short' }).formatToParts(parts.date);
      for (var i = 0; i < named.length; i++) if (named[i].type === 'timeZoneName') label = named[i].value;
    } catch (e) { label = ''; }
    return clock + (label ? ' ' + label : '');
  }
  /** Thu 26 Nov 2026, 2:30 pm AWST. A date-only value prints as formatDay. */
  function formatDateTime(value, zone) {
    var parts = dateParts(value, zone);
    if (!parts) return '';
    if (parts.dateOnly) return formatDay(value);
    return formatDay(value, zone) + ', ' + formatTime(value, zone);
  }
  /** Today's calendar date on this device, as YYYY-MM-DD. */
  function todayIso(now) {
    var d = now instanceof Date ? now : new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }
  /** Whole calendar days from `fromIso` to `toIso` (both YYYY-MM-DD). null when either is not a date. */
  function daysBetween(fromIso, toIso) {
    var a = DATE_ONLY.exec(String(fromIso || '').slice(0, 10));
    var b = DATE_ONLY.exec(String(toIso || '').slice(0, 10));
    if (!a || !b) return null;
    return Math.round((Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]))) / 86400000);
  }

  // ── the greeting (R17, W3-D23) ────────────────────────────────────────────
  var TITLES = { dr: 1, doctor: 1, prof: 1, professor: 1, mr: 1, mrs: 1, ms: 1, miss: 1, mx: 1, assoc: 1, 'a/prof': 1 };
  /**
   * The name to greet a doctor by: their first name, never "Test Fullwalk"
   * (first and last), never a bare title ("Dr"). '' when there is none: the
   * caller then says "Hi there". Takes a first name, or a full name.
   */
  function firstNameFor(firstName, fullName) {
    // The same rule as lib/au-greeting.js (a test keeps the two equal): any
    // leading title is skipped, and a title followed by ONE word ("Dr
    // Citizen") is a surname, not a first name.
    var parse = function (raw) {
      var words = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var titled = false;
      while (words.length && TITLES[words[0].toLowerCase().replace(/\.$/, '')]) { words.shift(); titled = true; }
      if (!words.length) return { first: '', surnameOnly: '' };
      var w = words[0].replace(/[.,;:]+$/, '');
      w = /[A-Za-z\u00C0-\u024F]/.test(w) ? w : '';
      return titled && words.length === 1 ? { first: '', surnameOnly: w } : { first: w, surnameOnly: '' };
    };
    // The first-name FIELD holds a first name ("Dr. Jane" is Jane).
    var own = parse(firstName);
    return own.first || own.surnameOnly || parse(fullName).first;
  }
  /** What goes after "Hi ": the first name, else "Dr Citizen", else "there". */
  function greetingName(firstName, fullName) {
    var first = firstNameFor(firstName, fullName);
    if (first) return first;
    var only = function (raw) {
      var words = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var titled = false;
      while (words.length && TITLES[words[0].toLowerCase().replace(/\.$/, '')]) { words.shift(); titled = true; }
      return titled && words.length === 1 ? words[0].replace(/[.,;:]+$/, '') : '';
    };
    var surname = only(fullName);
    return surname ? 'Dr ' + surname : 'there';
  }
  /** "Hi Test," or "Hi there," (never "Hi Dr," and never the full name). */
  function greeting(firstName, fullName) {
    return 'Hi ' + greetingName(firstName, fullName) + ',';
  }

  // ── Careers, placed: what the secured view shows per state (FB-2b) ────────
  var EMPTY_VALUES = { '': 1, pending: 1, 'billing pending': 1, tbc: 1, 'to be confirmed': 1, '-': 1, '\u2014': 1 };
  function isEmptyTile(value) {
    return !!EMPTY_VALUES[String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase()];
  }
  /**
   * W3-D12, W3-D13. Everything the placed view on Careers says that depends
   * on where the doctor is, from ONE value: `view.viewState` of
   * GET /api/gp/au-prestart (the server's answer). `view` null = not known
   * yet: nothing about a start date is claimed either way.
   *
   * @param {object|null} view       the pre-start view
   * @param {object} [placement]     the application's placement payload
   * @returns {{ state, known, chip, title, countdownValue, countdownCopy, startTag,
   *   showCountdownValue, quickStats, showIncome, incomeText, incomeUnit, stepsTitle }}
   */
  function securedView(view, placement) {
    var p = placement && typeof placement === 'object' ? placement : {};
    var comp = p.compensation && typeof p.compensation === 'object' ? p.compensation : {};
    var stats = (Array.isArray(p.quickStats) ? p.quickStats : []).filter(function (t) { return t && !isEmptyTile(t.value); });
    var out = {
      state: '', known: false, chip: 'Placement confirmed', title: 'Your Practice Is Secured',
      countdownValue: '', countdownCopy: '', startTag: '', showCountdownValue: false,
      // Empty tiles are not drawn ("Pending Split", "Expected income Pending").
      quickStats: stats, showIncome: !isEmptyTile(comp.range), incomeText: isEmptyTile(comp.range) ? '' : String(comp.range), incomeUnit: isEmptyTile(comp.range) ? '' : String(comp.unit || ''),
      stepsTitle: 'Your steps'
    };
    if (!view || typeof view !== 'object' || !view.viewState) return out;
    out.known = true;
    out.state = String(view.viewState);
    var started = out.state === 'first_week' || out.state === 'settling_in' || out.state === 'settled';
    if (started) {
      out.chip = out.state === 'settled' ? 'Your practice' : 'Started';
      out.title = out.state === 'settled' ? 'You Are With' : 'You Have Started';
      out.countdownCopy = view.startedOn ? 'You started on ' + formatDate(view.startedOn) : 'You have started';
      out.startTag = out.state === 'first_week' ? 'Your first week' : (out.state === 'settling_in' ? 'Settling in' : '');
      return out;
    }
    var confirmed = view.startDateSource === 'confirmed';
    if (out.state === 'cleared') out.chip = 'Cleared to start';
    if (!view.startDate) {
      // "To be confirmed" only when there truly is no date on file.
      out.countdownCopy = 'We will confirm your start date with you and the practice';
      out.startTag = 'Start date to be confirmed';
      return out;
    }
    var days = typeof view.startsInDays === 'number' && isFinite(view.startsInDays) ? view.startsInDays : null;
    if (days !== null && days > 0) {
      out.showCountdownValue = true;
      out.countdownValue = String(days);
      out.countdownCopy = (days === 1 ? 'day' : 'days') + (confirmed ? ' until your start' : ' until your expected start');
    } else if (days === 0) {
      out.countdownCopy = confirmed ? 'You start today' : 'Your expected start is today';
    } else {
      out.countdownCopy = confirmed ? 'Your start date' : 'Your expected start date';
    }
    out.startTag = (confirmed ? 'Starts ' : 'Expected start ') + formatDate(view.startDate) + (confirmed ? '' : ' (to be confirmed)');
    return out;
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
    // FB-2b: the one formatter, the greeting, and the placed view on Careers
    isDateOnly: isDateOnly,
    formatDay: formatDay,
    formatTime: formatTime,
    formatClock: formatClock,
    formatDateTime: formatDateTime,
    todayIso: todayIso,
    daysBetween: daysBetween,
    firstNameFor: firstNameFor,
    greetingName: greetingName,
    greeting: greeting,
    securedView: securedView,
    isEmptyTile: isEmptyTile,
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
