// "Open AMC" has to leave the app shell's iframe (2026-08-11).
//
// A doctor reported the button on the AMC Portfolio step did nothing. The handler
// called window.location.assign(AMC_SIGNUP_URL), but pages/amc.html is rendered
// inside #appShellFramePrimary, so that asks the browser to load AMC *into that
// frame*. It is refused twice over, both times silently:
//   * account.amc.org.au/sign_up responds with X-Frame-Options: SAMEORIGIN
//   * our own CSP in server.js pins frame-src to 'self' blob: *.google.com
//     scribehow.com calendly.com — amc.org.au is not on it
// So the click produced no navigation, no error the doctor could see, nothing.
//
// The fix routes both AMC CTAs through openAmcExternal(), which opens a new tab —
// what the button's ↗ icon has always promised — and mirrors openMyIntealthExternal()
// on the MyIntealth step. These tests pin the behaviour, not just the wording.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Pull `function <name>(...) { ... }` out of a page by counting braces.
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

const AMC_HTML = read('pages/amc.html');
const SIGNUP = 'https://account.amc.org.au/sign_up';

// Build openAmcExternal over stub window/document so the real branch order runs.
// No jsdom in this repo — the page's inline JS is executed against hand stubs.
function buildOpener({ popup = null, visibility = 'visible' } = {}) {
  const calls = { open: [], anchors: [], topAssign: [], selfAssign: [], timers: [] };

  const doc = {
    visibilityState: visibility,
    body: { appendChild() {} },
    createElement() {
      const el = {
        style: {},
        clicked: 0,
        removed: 0,
        click() { this.clicked++; },
        remove() { this.removed++; }
      };
      calls.anchors.push(el);
      return el;
    }
  };

  const top = { location: { assign: (u) => calls.topAssign.push(u) } };
  const win = {
    top,
    location: { assign: (u) => calls.selfAssign.push(u) },
    open: (url, target, features) => { calls.open.push({ url, target, features }); return popup; },
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; }
  };

  const fn = new Function(
    'window', 'document',
    extractFunction(AMC_HTML, 'openAmcExternal') + '; return openAmcExternal;'
  )(win, doc);

  return { fn, calls, doc };
}

describe('openAmcExternal opens AMC in a new tab', () => {
  it('calls window.open with _blank and noopener, and stops there when it works', () => {
    const popup = { opener: {} };
    const { fn, calls } = buildOpener({ popup });

    fn(SIGNUP);

    expect(calls.open).toHaveLength(1);
    expect(calls.open[0].url).toBe(SIGNUP);
    expect(calls.open[0].target).toBe('_blank');
    expect(calls.open[0].features).toContain('noopener');
    // A working popup must not also fall through to the anchor or the timer.
    expect(calls.anchors).toHaveLength(0);
    expect(calls.timers).toHaveLength(0);
    expect(popup.opener).toBeNull();
  });

  it('never navigates this frame — that is the refusal that broke the button', () => {
    const { fn, calls } = buildOpener({ popup: { opener: {} } });
    fn(SIGNUP);
    expect(calls.selfAssign).toEqual([]);
  });

  it('falls back to a real anchor click when the popup is blocked', () => {
    const { fn, calls } = buildOpener({ popup: null });

    fn(SIGNUP);

    expect(calls.anchors).toHaveLength(1);
    const link = calls.anchors[0];
    expect(link.href).toBe(SIGNUP);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.clicked).toBe(1);
    expect(link.removed).toBe(1);
  });

  it('last resort sends the TOP window to AMC, never the iframe', () => {
    const { fn, calls } = buildOpener({ popup: null, visibility: 'visible' });

    fn(SIGNUP);
    expect(calls.timers).toHaveLength(1);
    calls.timers[0].fn();

    expect(calls.topAssign).toEqual([SIGNUP]);
    expect(calls.selfAssign).toEqual([]);
  });

  it('leaves the app alone if the anchor did open a tab (page went hidden)', () => {
    const { fn, calls, doc } = buildOpener({ popup: null });

    fn(SIGNUP);
    doc.visibilityState = 'hidden';
    calls.timers[0].fn();

    expect(calls.topAssign).toEqual([]);
    expect(calls.selfAssign).toEqual([]);
  });

  it('does nothing without a url', () => {
    const { fn, calls } = buildOpener({ popup: null });
    fn('');
    expect(calls.open).toHaveLength(0);
    expect(calls.anchors).toHaveLength(0);
  });
});

describe('both AMC steps route through it', () => {
  it('wires open and open_signup to openAmcExternal, not window.location', () => {
    expect(AMC_HTML).toMatch(/ctaType === "open"\)\s*openAmcExternal\(AMC_URL\)/);
    expect(AMC_HTML).toMatch(/ctaType === "open_signup"\)\s*openAmcExternal\(AMC_SIGNUP_URL\)/);
  });

  it('has no window.location.assign left pointing at an AMC url', () => {
    expect(AMC_HTML).not.toMatch(/window\.location\.assign\(AMC_(URL|SIGNUP_URL)\)/);
  });
});

describe('the dead button is purged from the precache', () => {
  const sw = read('sw.js');

  it('still precaches the AMC step page', () => {
    expect(sw).toContain('"/pages/amc?gp_shell=embedded&gp_shell_static=1"');
  });

  it('bumps VERSION past the release that shipped the broken handler', () => {
    const version = /var VERSION = "([^"]+)"/.exec(sw);
    expect(version).toBeTruthy();
    expect(version[1] > '20260810a').toBe(true);
  });
});
