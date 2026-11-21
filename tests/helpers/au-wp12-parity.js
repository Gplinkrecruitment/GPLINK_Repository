'use strict';
/**
 * WP-12 overseas parity: what a doctor who is NOT on an Australian pathway is
 * shown by the files WP-12 changed.
 *
 * Two things are captured from a version of the repo (a set of file texts):
 *
 *   behaviour   the outputs of the pure builders with no Australian helper
 *               present: the stage list for a matrix of progress snapshots,
 *               both slide decks, the careers "where am I" strip.
 *   strings     every piece of text a person could read in each changed
 *               shared file: HTML text nodes and attribute text, and string
 *               literals in scripts.
 *
 * tests/fixtures/au-wp12-overseas-parity.snapshot.json holds the capture taken
 * from the commit BEFORE WP-12 touched anything (origin/au-gp-testing at
 * 1003edb2). tests/au-wp12-overseas-parity.test.js captures the working tree
 * the same way and compares: the behaviour must be identical, and every
 * string in the old capture must still be in the file.
 *
 * Regenerate the "before" capture (only ever from that commit):
 *   node tests/helpers/au-wp12-parity.js --write-baseline
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE_COMMIT = '1003edb2';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'au-wp12-overseas-parity.snapshot.json');

// The shared files WP-12 changed (an overseas doctor's browser loads these).
const SHARED_FILES = [
  'js/journey-stages.js', 'js/app-shell.js', 'js/gp-intro-slides.js', 'js/gp-walkthrough.js', 'js/gp-walkthrough-shell.js',
  'js/career-step-strip.js', 'js/onboarding.js',
  'pages/app-shell.html', 'pages/index.html', 'pages/pbs.html', 'pages/career.html', 'pages/job.html',
  'pages/offer-review.html', 'pages/application-detail.html', 'pages/secure-interview.html', 'pages/confirm-call.html',
  'pages/area-guide.html', 'pages/account.html', 'pages/messages.html', 'pages/onboarding.html'
];

function readTree(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

// ── behaviour ────────────────────────────────────────────────────────────────
function loadBrowserScript(source, extraWindow) {
  const window = Object.assign({}, extraWindow || {});
  const sandbox = { window, self: window, globalThis: window, module: undefined, console };
  vm.runInNewContext(source, sandbox, { timeout: 5000 });
  return window;
}
function loadUmd(source) {
  const module = { exports: {} };
  const sandbox = { module, self: {}, globalThis: {}, console };
  vm.runInNewContext(source, sandbox, { timeout: 5000 });
  return module.exports;
}

const SNAPS = (function () {
  const out = [];
  const flags = ['careerSecured', 'epicDone', 'amcDone', 'ahpraDone', 'visaDone', 'pbsDone'];
  // every prefix of the journey, plus a few out-of-order combinations
  for (let i = 0; i <= flags.length; i++) { const s = {}; flags.slice(0, i).forEach(function (f) { s[f] = true; }); out.push(s); }
  out.push({ epicDone: true }, { careerSecured: true, ahpraDone: true }, { careerSecured: true, epicDone: true, ahpraDone: true }, { pbsDone: true });
  return out;
})();

const SLIDE_CONTEXTS = [
  {},
  { firstName: 'Sam', lastName: 'Example', practiceName: 'Test Practice (FAKE)' },
  { firstName: 'Sam', limitsNote: 'A note passed by the shell.' },
  { lastName: 'Example', stages: [{ key: 'career', title: 'Secure Placement', description: 'x' }, { key: 'myinthealth', title: 'MyIntealth Account', description: 'y' }, { key: 'pbs', title: 'PBS & Medicare', description: 'z' }] }
];

const STRIP_CASES = [
  [],
  [{ id: 'a1', roleId: 'r1', status: 'applied', practiceName: 'Test Practice (FAKE)' }],
  [{ id: 'a1', roleId: 'r1', status: 'matched', practiceName: 'Test Practice (FAKE)' }],
  [{ id: 'a1', roleId: 'r1', status: 'fast_tracked', practiceName: 'Test Practice (FAKE)' }],
  [{ id: 'a1', roleId: 'r1', status: 'interview', practiceName: 'Test Practice (FAKE)' }],
  [{ id: 'a1', roleId: 'r1', status: 'interview_completed', practiceName: 'Test Practice (FAKE)' }],
  [{ id: 'a1', roleId: 'r1', status: 'offer', offerPending: true }],
  [{ id: 'a1', roleId: 'r1', status: 'offer', contractStage: 'sent_to_gp' }],
  [{ id: 'a1', roleId: 'r1', status: 'finalising_placement' }],
  [{ id: 'a1', roleId: 'r1', status: 'placement_secured', isPlacementSecured: true }],
  [{ id: 'a1', roleId: 'r1', status: 'withdrawn' }, { id: 'a2', roleId: 'r2', status: 'submitted', practiceName: 'Confidential practice' }]
];

function captureBehaviour(read) {
  const stages = loadBrowserScript(read('js/journey-stages.js')).GPJourneyStages;
  const slides = loadUmd(read('js/gp-intro-slides.js'));
  const strip = loadUmd(read('js/career-step-strip.js'));
  const plain = function (v) { return JSON.parse(JSON.stringify(v)); };
  return {
    stageList: plain(stages.STAGES),
    allStages: plain(stages.ALL_STAGES),
    stageStates: SNAPS.map(function (s) { return { snap: s, normal: plain(stages.getStageStates(s, false)), bypass: plain(stages.getStageStates(s, true)) }; }),
    findStage: ['career', 'myinthealth', 'pbs', 'commencement', 'nope'].map(function (k) { return plain(stages.findStage(k)); }),
    welcomeSlides: SLIDE_CONTEXTS.map(function (c) { return plain(slides.buildWelcomeSlides(c)); }),
    registrationSlides: SLIDE_CONTEXTS.map(function (c) { return plain(slides.buildRegistrationSlides(c)); }),
    careerStrip: STRIP_CASES.map(function (apps) { return plain(strip.deriveCareerStep(apps)); }),
    stripSteps: plain(strip.STEPS)
  };
}

// ── strings ──────────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s.replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013').replace(/&amp;/g, '&').replace(/&rsquo;/g, '\u2019').replace(/&lsquo;/g, '\u2018')
    .replace(/&hellip;/g, '\u2026').replace(/&nbsp;/g, ' ').replace(/&times;/g, '\u00d7').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function tidy(s) { return decodeEntities(String(s)).replace(/\s+/g, ' ').trim(); }

// String literals in a script: '...', "..." and `...` (template text between ${}).
function scriptStrings(js) {
  const out = [];
  const src = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    raw.split(/\$\{[^}]*\}/).forEach(function (part) {
      const text = tidy(part.replace(/\\n/g, ' ').replace(/\\(['"`])/g, '$1').replace(/<[^>]+>/g, ' '));
      if (text.length >= 14 && /[a-z] [a-z]/i.test(text)) out.push(text);
    });
  }
  return out;
}

// Text a person can read in an HTML file: text nodes, a few attributes, and the strings in its scripts.
function htmlStrings(html) {
  const out = [];
  const scripts = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function (_, js) { scripts.push(js); return ' '; })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  body.replace(/\b(?:placeholder|title|aria-label|alt)="([^"]*)"/g, function (_, v) { const t = tidy(v); if (t.length >= 6) out.push(t); return _; });
  body.replace(/>([^<>]+)</g, function (_, v) { const t = tidy(v); if (t.length >= 6 && /[a-z]/i.test(t)) out.push(t); return _; });
  scripts.forEach(function (js) { scriptStrings(js).forEach(function (s) { out.push(s); }); });
  return out;
}

function stringsOf(file, text) {
  const list = /\.html$/.test(file) ? htmlStrings(text) : scriptStrings(text);
  return Array.from(new Set(list)).sort();
}

function capture(read) {
  const strings = {};
  SHARED_FILES.forEach(function (f) { strings[f] = stringsOf(f, read(f)); });
  return { behaviour: captureBehaviour(read), strings };
}

module.exports = { ROOT, FIXTURE, BASELINE_COMMIT, SHARED_FILES, capture, captureBehaviour, stringsOf, readTree, tidy };

if (require.main === module && process.argv.indexOf('--write-baseline') !== -1) {
  const { execFileSync } = require('child_process');
  const readBase = function (file) { return execFileSync('git', ['show', BASELINE_COMMIT + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); };
  const snap = capture(readBase);
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify({ commit: BASELINE_COMMIT, behaviour: snap.behaviour, strings: snap.strings }, null, 1) + '\n');
  console.log('wrote ' + path.relative(ROOT, FIXTURE) + ': ' + Object.keys(snap.strings).map(function (f) { return f + '=' + snap.strings[f].length; }).join(', '));
}
