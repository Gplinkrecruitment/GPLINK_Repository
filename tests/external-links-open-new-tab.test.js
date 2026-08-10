// Every off-site link in the app must open a new tab (2026-08-11, sweep).
//
// Follow-up to tests/amc-open-external.test.js, which fixed "Open AMC". The same
// defect existed on three more surfaces, so this file pins the whole CLASS rather
// than the individual buttons.
//
// Why the class exists: all 18 GP-facing pages render inside the app shell's
// #appShellFramePrimary iframe. Sending an off-site URL through window.location —
// or clicking an <a> with no target — asks the browser to load that site INTO the
// frame, and it is refused, silently, with no navigation and nothing on screen:
//   * our own CSP pins frame-src to 'self' blob: *.google.com scribehow calendly
//     (server.js SECURITY_HEADERS), so ahpra.gov.au / wa.me / gmc are all blocked
//   * plus the destination's own X-Frame-Options where it sets one
//
// Fixed here: "Open AHPRA" (both AHPRA steps), the two GMC sign-in links in the
// Certificate-of-Good-Standing help, and the MyIntealth + WhatsApp fallbacks that
// pointed their popup-blocked rescue at the frame instead of the top window.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Exactly the routes js/app-shell.js embeds in the frame.
const SHELL_PAGES = [
  'index', 'myinthealth', 'amc', 'ahpra', 'my-documents', 'career', 'visa', 'pbs',
  'commencement', 'messages', 'account', 'registration-intro', 'application-detail',
  'job', 'offer-review', 'secure-interview', 'confirm-call', 'area-guide'
].map((n) => `pages/${n}.html`);

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

function buildOpener(html, fnName, { popup = null, visibility = 'visible', globals = {} } = {}) {
  const calls = { open: [], anchors: [], topAssign: [], selfAssign: [], timers: [] };
  const doc = {
    visibilityState: visibility,
    body: { appendChild() {} },
    createElement() {
      const el = { style: {}, clicked: 0, removed: 0, click() { this.clicked++; }, remove() { this.removed++; } };
      calls.anchors.push(el);
      return el;
    }
  };
  const win = {
    top: { location: { assign: (u) => calls.topAssign.push(u) } },
    location: { assign: (u) => calls.selfAssign.push(u) },
    open: (url, target, features) => { calls.open.push({ url, target, features }); return popup; },
    setTimeout: (fn) => { calls.timers.push(fn); return calls.timers.length; }
  };
  // Some helpers close over a page-level URL constant; inject those by name.
  const names = Object.keys(globals);
  const fn = new Function(
    'window', 'document', ...names,
    extractFunction(html, fnName) + '; return ' + fnName + ';'
  )(win, doc, ...names.map((n) => globals[n]));
  return { fn, calls, doc };
}

describe('openAhpraExternal opens AHPRA in a new tab', () => {
  const html = read('pages/ahpra.html');
  const URL = 'https://www.ahpra.gov.au/Registration/Online-services.aspx';

  it('is what both AHPRA steps call, not window.location', () => {
    expect(html).toMatch(/ctaType === "open"\)\s*openAhpraExternal\(AHPRA_URL\)/);
    expect(html).not.toMatch(/window\.location\.assign\(AHPRA_URL\)/);
    // Both stages still advertise the button, so both are covered by the one handler.
    expect(html.match(/cta: "Open AHPRA"/g) || []).toHaveLength(2);
  });

  it('opens a _blank tab with noopener and stops there', () => {
    const popup = { opener: {} };
    const { fn, calls } = buildOpener(html, 'openAhpraExternal', { popup });
    fn(URL);
    expect(calls.open).toHaveLength(1);
    expect(calls.open[0].target).toBe('_blank');
    expect(calls.open[0].features).toContain('noopener');
    expect(calls.anchors).toHaveLength(0);
    expect(popup.opener).toBeNull();
  });

  it('falls back to a real anchor click when the popup is blocked', () => {
    const { fn, calls } = buildOpener(html, 'openAhpraExternal', { popup: null });
    fn(URL);
    expect(calls.anchors).toHaveLength(1);
    expect(calls.anchors[0].target).toBe('_blank');
    expect(calls.anchors[0].clicked).toBe(1);
  });

  it('last resort sends the TOP window, never this frame', () => {
    const { fn, calls } = buildOpener(html, 'openAhpraExternal', { popup: null });
    fn(URL);
    calls.timers[0]();
    expect(calls.topAssign).toEqual([URL]);
    expect(calls.selfAssign).toEqual([]);
  });

  it('leaves the app alone once the page has gone hidden', () => {
    const { fn, calls, doc } = buildOpener(html, 'openAhpraExternal', { popup: null });
    fn(URL);
    doc.visibilityState = 'hidden';
    calls.timers[0]();
    expect(calls.topAssign).toEqual([]);
    expect(calls.selfAssign).toEqual([]);
  });
});

describe('popup-blocked rescues target the top window', () => {
  it('MyIntealth no longer aims its last resort at the frame', () => {
    const html = read('pages/myinthealth.html');
    const { fn, calls } = buildOpener(html, 'openMyIntealthExternal', {
      popup: null,
      globals: { MYINTEALTH_URL: 'https://applicant.myintealth.app/s/' }
    });
    fn();
    calls.timers[0]();
    expect(calls.topAssign).toHaveLength(1);
    expect(calls.topAssign[0]).toContain('myintealth');
    expect(calls.selfAssign).toEqual([]);
  });

  it('the WhatsApp fallback escapes the frame instead of dying in it', () => {
    const html = read('pages/messages.html');
    expect(html).toMatch(/\(window\.top \|\| window\)\.location\.assign\(url\)/);
    expect(html).not.toMatch(/setAttribute\("href", url\); window\.location\.href = url;/);
    // NOT window.open here on purpose: a tab opened from this handler is the
    // blank-page-on-mobile regression that support-whatsapp-handoff.test.js pins.
    const handler = (html.match(/fabWhatsAppEl\.addEventListener\("click"[\s\S]*?\n      \}\);/) || [''])[0];
    expect(handler).toBeTruthy();
    expect(handler.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')).not.toContain('window.open(');
  });
});

describe('class guard: no shell page may navigate the frame off-site', () => {
  // An <a> with an external href and no target navigates the frame it lives in,
  // which is the same silent refusal. Catch it on every embedded page at once.
  it('every external anchor carries target="_blank"', () => {
    const offenders = [];
    for (const page of SHELL_PAGES) {
      const html = read(page);
      const tags = html.match(/<a\s[^>]*href=\\?"https?:\/\/[^>]*>/g) || [];
      for (const tag of tags) {
        if (!tag.includes('_blank')) offenders.push(page + ' :: ' + tag.slice(0, 90));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no page sends a literal off-site url through window.location', () => {
    const offenders = [];
    for (const page of SHELL_PAGES) {
      const html = read(page);
      const hits = html.match(/window\.location\.(?:assign|replace)\(\s*["'`]https?:\/\/[^"'`]*["'`]\s*\)|window\.location\.href\s*=\s*["'`]https?:\/\//g) || [];
      for (const hit of hits) offenders.push(page + ' :: ' + hit.slice(0, 90));
    }
    expect(offenders).toEqual([]);
  });

  it('no CTA hands an off-site constant straight to window.location', () => {
    // The three step pages each define a URL constant for their regulator. A bare
    // window.location.assign(CONST) is the bug; the helper's own guarded fallback
    // inside catch {} is reached only after window.top itself threw, so it is scoped
    // to the helper body and excluded here by construction.
    const pairs = [
      ['pages/amc.html', 'openAmcExternal', ['AMC_URL', 'AMC_SIGNUP_URL']],
      ['pages/ahpra.html', 'openAhpraExternal', ['AHPRA_URL']],
      ['pages/myinthealth.html', 'openMyIntealthExternal', ['MYINTEALTH_URL']]
    ];
    for (const [page, helper, names] of pairs) {
      const html = read(page);
      const outside = html.replace(extractFunction(html, helper), '');
      for (const name of names) {
        expect(outside, page + ' / ' + name)
          .not.toMatch(new RegExp('window\\.location\\.assign\\(' + name + '\\)'));
      }
      // And the helper really does escape the frame on its last resort.
      expect(extractFunction(html, helper), page).toContain('(window.top || window).location.assign(');
    }
  });
});

describe('the fixed pages are re-fetched, not served from the old cache', () => {
  const sw = read('sw.js');

  it('still precaches every page this sweep touched', () => {
    for (const p of ['amc', 'ahpra', 'myinthealth', 'messages']) {
      expect(sw, p).toContain('"/pages/' + p + '?gp_shell=embedded&gp_shell_static=1"');
    }
  });

  it('bumps VERSION past the AMC-only fix', () => {
    const version = /var VERSION = "([^"]+)"/.exec(sw);
    expect(version).toBeTruthy();
    expect(version[1] > '20260811a').toBe(true);
  });
});
