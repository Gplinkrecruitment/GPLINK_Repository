// Australian GP build, WP-05: what a doctor on the Australian onboarding branch
// can be shown, and how the branch is wired into the pages.
//
//  1. None of the words in AGENT-RULES section 4 appears anywhere a doctor on
//     the Australian branch can see: the Australian sections of
//     pages/onboarding.html and js/onboarding.js, all of js/onboarding-au.js,
//     the answer labels and messages the server returns, and the invite email.
//  2. The "Not yet eligible" off-ramp cannot be reached from the branch.
//  3. The existing wizard is where it was: same five slides in the same order,
//     and the default (switch-off) copy on onboarding and sign-in is unchanged.
//  4. Nothing about the pathway became writable from a browser.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const onboardingHtml = read('pages/onboarding.html');
const onboardingJs = read('js/onboarding.js');
const onboardingAuJs = read('js/onboarding-au.js');
const signinHtml = read('pages/signin.html');
const serverJs = read('server.js');
const auOnboarding = requireCjs('../lib/au-onboarding.js');

// AGENT-RULES section 4. Whole-word where the word is short enough to sit
// inside another one.
const BANNED = [
  ['MyIntealth', /my\s?int(e)?alth/i],
  ['AMC', /\bAMC\b/i],
  ['EPIC', /\bEPIC\b/i],
  ['visa', /visa/i],
  ['relocate / relocation', /relocat/i],
  ['your move', /your\s+move/i],
  ['overseas', /overseas/i],
  ['internationally trained', /internationally[\s-]+trained/i],
  ['GMC', /\bGMC\b/i],
  ['SPPA', /SPPA/i],
  ['Section G', /section\s+G\b/i],
  ['supervisor CV', /supervisor\s+CV/i],
  ['Not yet eligible', /not\s+yet\s+eligible/i]
];

function bannedIn(text) {
  return BANNED.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// Every section between a START and an END marker.
function sections(source, startRe, endRe) {
  const out = [];
  let rest = source;
  for (;;) {
    const s = startRe.exec(rest);
    if (!s) break;
    const after = rest.slice(s.index + s[0].length);
    const e = endRe.exec(after);
    expect(e, 'a START marker has no END marker').toBeTruthy();
    out.push(after.slice(0, e.index));
    rest = after.slice(e.index + e[0].length);
  }
  return out;
}

const htmlSections = sections(onboardingHtml, /AU-BRANCH(?:-CSS)?:START/, /AU-BRANCH(?:-CSS)?:END/);
const jsSections = sections(onboardingJs, /AU BRANCH: START/, /AU BRANCH: END/);

describe('the scan itself works', () => {
  it('finds each banned word', () => {
    expect(bannedIn('Add my GMC number')).toEqual(['GMC']);
    expect(bannedIn('your visa and your move overseas')).toEqual(['visa', 'your move', 'overseas']);
    expect(bannedIn('Not yet eligible')).toEqual(['Not yet eligible']);
    expect(bannedIn('Open MyIntealth, then the AMC and EPIC steps, SPPA-00, Section G and the supervisor CV')).toEqual(
      ['MyIntealth', 'AMC', 'EPIC', 'SPPA', 'Section G', 'supervisor CV']);
    expect(bannedIn('relocation support for internationally trained doctors')).toEqual(['relocate / relocation', 'internationally trained']);
    expect(bannedIn('Your Ahpra registration number, FRACGP, right to work')).toEqual([]);
  });

  it('finds the Australian sections it is meant to scan', () => {
    expect(htmlSections.length).toBe(3);       // the styles, the two overlays, the five slides
    expect(jsSections.length).toBe(2);         // the "start here" row, and the branch itself
    expect(htmlSections.join('')).toContain('Are you already registered with Ahpra and working in Australia?');
    expect(htmlSections.join('')).toContain('data-au-step="review"');
    expect(jsSections.join('')).toContain('function auSubmit');
    expect(jsSections.join('').length).toBeGreaterThan(8000);
  });
});

describe('no banned word on any Australian-branch screen', () => {
  it('pages/onboarding.html: the Australian sections', () => {
    htmlSections.forEach((s, i) => expect(bannedIn(s), 'html section ' + i).toEqual([]));
  });

  it('js/onboarding.js: the Australian sections (code, strings and comments)', () => {
    jsSections.forEach((s, i) => expect(bannedIn(s), 'js section ' + i).toEqual([]));
  });

  it('js/onboarding-au.js: the whole file', () => {
    expect(bannedIn(onboardingAuJs)).toEqual([]);
  });

  it('the identity step the branch reuses, and both Australian success screens', () => {
    const identity = onboardingHtml.slice(onboardingHtml.indexOf('<!-- STEP 4: Identity Check'), onboardingHtml.indexOf('<!-- AU-BRANCH:START\n           The Australian screens'));
    expect(identity).toContain('Confirm your identity');
    expect(bannedIn(identity)).toEqual([]);
  });

  it('answer labels, error messages and the reply from the server', () => {
    const labels = [].concat(
      auOnboarding.REGISTRATION_TYPE_ANSWERS, auOnboarding.FELLOWSHIP_ANSWERS,
      auOnboarding.MORATORIUM_ANSWERS, auOnboarding.WORK_RIGHTS_ANSWERS
    ).map((o) => o.label).concat(auOnboarding.AU_LOCATIONS).join(' | ');
    expect(bannedIn(labels)).toEqual([]);
    const everyError = auOnboarding.validateAuOnboarding({ auBranch: 'yes', au: { workRights: 'temporary', permitExpiry: 'x', postcode: '1', sessions: 99, locations: ['x'] } });
    expect(Object.keys(everyError.errors).length).toBeGreaterThan(10);
    expect(bannedIn(Object.values(everyError.errors).join(' | '))).toEqual([]);
    // Everything completeAuOnboarding can send back as a message.
    const fn = serverJs.slice(serverJs.indexOf('async function completeAuOnboarding('), serverJs.indexOf('async function sendAuWaitlistInviteEmail('));
    const messages = (fn.match(/message: '[^']*'/g) || []).join(' | ');
    expect(messages).toContain('We could not save your details just now');
    expect(bannedIn(messages)).toEqual([]);
  });

  it('the waitlist invite email', () => {
    const mail = auOnboarding.buildAuWaitlistInviteEmail({ appBaseUrl: 'https://app.example.test/' });
    const text = [mail.subject, mail.title, mail.body, mail.ctaText, mail.footer].join(' | ');
    expect(bannedIn(text)).toEqual([]);
    expect(text).toContain('Ahpra');
    expect(text).not.toContain('AHPRA');
    expect(text).toContain('We never contact your current practice');
    expect(mail.ctaUrl).toBe('https://app.example.test/pages/onboarding?au=1');
    expect(mail.title).toContain('{{name}}');
  });

  it('writes the regulator as "Ahpra" in the new copy', () => {
    // (AHPRA_NUMBER_PATTERN is a constant's name in code, not copy.)
    htmlSections.concat(jsSections, [onboardingAuJs.replace(/AHPRA_NUMBER_PATTERN/g, '')]).forEach((s) => expect(s).not.toContain('AHPRA'));
  });
});

describe('the off-ramp cannot be reached from the Australian branch', () => {
  const branch = jsSections.join('\n');

  it('the branch never opens or shows the eligibility screen', () => {
    expect(branch).not.toContain('openEligibilityOfframp');
    expect(branch).not.toContain('showEligibilityScreen');
    expect(branch).not.toContain('selectUnsupportedCountry');
    expect(branch).not.toContain('/api/eligibility-waitlist');
    // It only ever HIDES it (going back to the first question).
    expect(branch).toContain('hideEligibilityScreen()');
  });

  it('with the switch on, Australia is no longer offered as a country we do not support', () => {
    expect(onboardingJs).toContain('ALL_COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) && !(auSwitchOn && c.code === "AU"))');
    expect(onboardingJs).toContain('var auSwitchOn = false;');
    // The only place it is turned on is inside the branch, after the server said so.
    expect(onboardingJs.split('auSwitchOn = true').length).toBe(2);
    expect(branch).toContain('auSwitchOn = true');
    expect(branch).toContain('and GPs who are already registered with Ahpra and working in Australia');
  });

  it('the switch is learned from the server, and any failure means today\'s flow', () => {
    expect(branch).toContain('window.GPAuPathway.init()');
    expect(branch).toContain('return Promise.resolve(false)');
    expect(onboardingJs).toContain('if (auPathwayOn === true && auTakeOver(params)) { initRendered = true; return; }');
    expect(onboardingJs).not.toMatch(/auSwitchOn\s*=\s*true\s*;[^\n]*\n[^\n]*DOCS_ONLY_MODE = /);
  });
});

describe('the existing wizard is where it was', () => {
  it('the five existing slides come first, in the same order; the Australian ones follow, hidden', () => {
    const order = [];
    const re = /<div class="slide( active)?( au-slide)?"( hidden)? data-(slide|au-step)="([^"]+)"/g;
    let m;
    while ((m = re.exec(onboardingHtml))) order.push((m[2] ? 'au:' : '') + m[5] + (m[3] ? ':hidden' : ''));
    expect(order).toEqual(['0', '1', '2', '3', '4',
      'au:where:hidden', 'au:when:hidden', 'au:registration:hidden', 'au:details:hidden', 'au:review:hidden']);
    expect(onboardingJs).toContain('const TOTAL_STEPS = 5;');
    expect((onboardingHtml.match(/<div class="progress-dot( active)?"/g) || []).length).toBe(5);
  });

  it('the default copy (what is shown with the switch off) is byte-for-byte what it was', () => {
    [
      '<h1>Your fastest pathway to practising in Australia</h1>',
      '<h1>Plan your move</h1>',
      '<label class="field-label" for="targetDate">Target arrival date</label>',
      '<div class="field-hint">Allow at least 5 months for registration and placement.</div>',
      '<h1>Not yet eligible</h1>',
      "GP Link currently supports GPs who trained in the United Kingdom, Ireland or New Zealand. We're working on more countries &mdash; confirm your details below and we'll let you know the moment yours is supported.</p>",
      '<button class="btn-next" id="successContinueBtn">Go to Dashboard</button>'
    ].forEach((s) => expect(onboardingHtml).toContain(s));
    [
      '<p class="auth-sub">Your pathway to practising in Australia begins here.</p>',
      '<h2 class="overlay-title">Your fastest pathway to Australia</h2>',
      '<p class="overlay-copy">Personalised to your qualifications, timeline, and family — set up in under 3 minutes.</p>',
      'Trusted by GPs relocating from the UK, Ireland, and New Zealand.<br />'
    ].forEach((s) => expect(signinHtml).toContain(s));
  });

  it('the five-month minimum and the digits-only register field still apply to the existing flow', () => {
    expect(onboardingJs).toContain('minDate.setMonth(minDate.getMonth() + 5);');
    expect(onboardingJs).toContain('Your target date must be at least 5 months from today.');
    expect(onboardingJs).toContain('.replace(/[\\s-]+/g, "").replace(/[^0-9]/g, "")');
    expect(onboardingJs).toContain('inputmode="numeric"');
  });

  it('sign-in: neutral copy is swapped in only after the server says the switch is on (APP-05, WEB-18)', () => {
    const tail = signinHtml.slice(signinHtml.lastIndexOf('<script src="/js/au-pathway.js'));
    expect(tail).toContain('if (!au || !au.enabled()) return;');
    expect(tail).toContain('Create your GP Link account to get started.');
    expect(tail).toContain('For GPs practising in Australia, and GPs planning to.');
    const neutral = (tail.match(/"[^"\n]{12,}"/g) || []).join(' | ');
    expect(bannedIn(neutral)).toEqual([]);
  });

  it('the Australian screens: text keyboard for the Ahpra number, no minimum on the start date, no uploads', () => {
    const slides = htmlSections[2];
    expect(slides).toMatch(/<input type="text" id="auAhpraNumber" inputmode="text" autocapitalize="characters"/);
    expect(slides).toMatch(/<input type="date" id="auAvailableFrom" \/>/);
    expect(slides).not.toMatch(/id="auAvailableFrom"[^>]*\bmin=/);
    expect(jsSections.join('')).not.toMatch(/auAvailableFrom[^\n]*\.min\s*=/);
    expect(slides).not.toContain('type="file"');
    expect(slides).toContain('We never contact your current practice');
    expect(slides).toContain('Not sure yet');
  });
});

describe('scripts, cache-busters and the service worker', () => {
  it('onboarding loads the switch helper and the branch helper before the wizard', () => {
    const a = onboardingHtml.indexOf('<script src="/js/au-pathway.js?v=20261120b"></script>');
    const b = onboardingHtml.indexOf('<script src="/js/onboarding-au.js?v=20261121a"></script>');
    const c = onboardingHtml.indexOf('<script src="../js/onboarding.js?v=20261121b"></script>');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(onboardingAuJs).toContain('/js/onboarding-au.js?v=20261121a');
  });

  it('the service worker precaches the same versions and its own version moved', () => {
    const sw = read('sw.js');
    expect(sw).toContain('"/js/onboarding.js?v=20261121b"');
    expect(sw).toContain('"/js/onboarding-au.js?v=20261121a"');
    expect(sw).not.toContain('onboarding.js?v=20260918a');
    const version = (/var VERSION = "([^"]+)"/.exec(sw) || [])[1] || '';
    expect(version >= '20261120a').toBe(true);
  });

  it('every inline script on the two pages still parses', () => {
    [onboardingHtml, signinHtml].forEach((html) => {
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
      let m; let count = 0;
      while ((m = re.exec(html))) { count++; expect(() => new Function(m[1])).not.toThrow(); }
      expect(count).toBeGreaterThan(1);
    });
    expect(() => new Function(onboardingJs)).not.toThrow();
    expect(() => new Function(onboardingAuJs)).not.toThrow();
  });
});

describe('nothing about the pathway became writable from a browser', () => {
  it('USER_STATE_KEYS has neither the marker nor a pathway key', () => {
    const list = serverJs.slice(serverJs.indexOf('const USER_STATE_KEYS = ['), serverJs.indexOf('];', serverJs.indexOf('const USER_STATE_KEYS = [')));
    expect(list).not.toContain(auOnboarding.AU_BRANCH_MARKER_KEY);
    expect(list).not.toContain('candidate_pathway');
    expect(list).not.toContain('au_pathway');
    expect(list).not.toContain('candidate_');
    const stateSync = read('js/state-sync.js');
    expect(stateSync).not.toContain(auOnboarding.AU_BRANCH_MARKER_KEY);
  });

  it('sanitizeProfileInput does not accept a pathway, credential or preference column', () => {
    const start = serverJs.indexOf('function sanitizeProfileInput(body) {');
    const fn = serverJs.slice(start, serverJs.indexOf('\nfunction ', start + 10));
    ['candidate_pathway', 'candidate_basis', 'pathway_', 'moratorium', 'ahpra_', 'available_from', 'notice_period_weeks'].forEach((k) => {
      expect(fn, k).not.toContain(k);
    });
  });

  it('the wizard never sends a pathway', () => {
    expect(jsSections.join('')).not.toMatch(/candidate_pathway|au_vr|au_restricted|au_non_vr|au_registrar/);
    expect(onboardingAuJs).not.toMatch(/candidate_pathway|au_vr|au_restricted|au_non_vr|au_registrar/);
  });
});
