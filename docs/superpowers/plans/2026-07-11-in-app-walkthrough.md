# In-App Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided walkthrough that teaches GPs how to navigate the app — an upfront spotlight tour of the bottom nav (auto once for new sign-ups, replayable) plus 2–3 step first-visit mini-tours on the five main areas.

**Architecture:** One dependency-free overlay engine (`gp-coach.js`) is reused by two thin controllers: a **shell controller** (`gp-walkthrough-shell.js`, runs in `app-shell.html`) that owns the bottom-nav tour and the `tourDone` flag, and a **page controller** (`gp-walkthrough.js`, runs inside each of the four content pages) that owns per-page mini-tours. Both share a pure state module (`gp-walkthrough-state.js`) and one synced key `gp_walkthrough_state`. State is read/written through the existing `state-sync.js`, which must also be loaded in the shell (localStorage is shared same-origin; each frame syncs its own writes). No new bidirectional cross-frame channel is added; the only new message is a child→shell `gp-shell-run-tour` for replay.

**Tech Stack:** Vanilla ES5-style browser JS (UMD factory for testable modules), no build step, no new npm deps. Tests: vitest (Node, no jsdom) — pure logic via `createRequire`, wiring via static file-content assertions. Supabase (`user_state.state` JSON blob) for persistence.

## Global Constraints

- **No new npm dependencies.** Vanilla JS only; UMD factory pattern per `js/career-home-card.js`.
- **Cache-buster on every script tag:** `?v=20260711a` (pattern `?v=YYYYMMDD[letter]`).
- **State key must be registered in BOTH allowlists** or sync is silently dropped: client `STATE_KEYS` (`js/state-sync.js:2`) AND server `USER_STATE_KEYS` (`server.js:6165`). Both `sanitizeUserStateInput` (PUT, `server.js:11300`) and `filterUserStateForClient` (GET, `server.js:23851`) iterate `USER_STATE_KEYS`.
- **Read synced state only after hydration:** `gpLinkStateSync` has no `get()`. Read `localStorage.getItem('gp_walkthrough_state')` after the `gp-state-hydrated` window event (or when `window.gpLinkStateSync.isHydrated()` is already true). Persist by writing `localStorage` then calling `window.gpLinkStateSync.push()`.
- **Suppress in limited modes:** skip auto-tour and mini-tours when `localStorage.getItem('gp_account_under_review') === 'true'`, `localStorage.getItem('gp_account_pep_waitlist') === 'true'`, or `document.body.classList.contains('gp-restricted')`.
- **New-users-only rollout:** a brand-new account has no `gp_walkthrough_state` (empty = run everything). A launch backfill sets existing users to all-seen so nothing auto-fires for them.
- **Plain, friendly copy.** All step copy is placeholder pending owner sign-off; keep it in the two controller files only.
- **Design tokens:** use `var(--gp-*)` from `css/gp-tokens.css` in injected styles.
- **The app is mobile-first.** The shell topbar (`#appShellDesktop`) is `display:none` below 860px, so the primary replay entry is an Account settings row, not a topbar button.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/gp-walkthrough-state.js` | **NEW.** Pure state logic (UMD): shape, parse/serialize, fire-conditions, route→area, backfill value. No DOM. |
| `js/gp-coach.js` | **NEW.** Overlay engine (UMD): pure `computePlacement` + DOM `run`/`isActive`/`waitForElement`. |
| `js/gp-walkthrough.js` | **NEW.** Page controller: per-page mini-tours, guards, replay-button delegation. Runs in the 4 content pages. |
| `js/gp-walkthrough-shell.js` | **NEW.** Shell controller: bottom-nav tour, auto-trigger, `tourDone` write, replay entry. Runs in `app-shell.html`. |
| `js/state-sync.js` | **MODIFY.** Add `gp_walkthrough_state` to `STATE_KEYS`. |
| `server.js` | **MODIFY.** Add `gp_walkthrough_state` to `USER_STATE_KEYS`. |
| `pages/app-shell.html` | **MODIFY.** Load state-sync + coach + state + shell controller. |
| `js/app-shell.js` | **MODIFY.** Dispatch `gp-shell-frame-loaded`; handle `gp-shell-run-tour` message. |
| `pages/index.html`, `career.html`, `messages.html`, `account.html` | **MODIFY.** Load coach + state + page controller. |
| `pages/account.html` | **MODIFY.** Add "Replay the app tour" row. |
| `js/qualification-scan.js` | **MODIFY.** First-open Scan mini-tour. |
| `scripts/backfill-walkthrough-state.js` | **NEW.** One-time launch backfill (existing users → all-seen). |
| `tests/*.test.js` | **NEW.** Pure-logic + wiring + backfill tests. |

---

## Task 1: Pure state module (`gp-walkthrough-state.js`)

**Files:**
- Create: `js/gp-walkthrough-state.js`
- Test: `tests/gp-walkthrough-state.test.js`

**Interfaces:**
- Produces (on `window.gpWalkthroughState` and `module.exports`):
  - `AREAS: string[]` = `['home','practice','support','account','scan']`
  - `defaultState() → {tourDone:false, tips:{home:false,...}}`
  - `parseState(raw:string|object|null) → state` (garbage → default)
  - `serializeState(state) → string`
  - `allSeenState() → {tourDone:true, tips:{all true}}`
  - `withTourDone(state) → newState`
  - `withTipSeen(state, area) → newState`
  - `shouldRunTour(state) → bool`
  - `shouldRunTip(state, area) → bool`
  - `routeToArea(pathname) → area|null`

- [ ] **Step 1: Write the failing test**

Create `tests/gp-walkthrough-state.test.js`:

```js
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const S = require(path.join(__dirname, '..', 'js', 'gp-walkthrough-state.js'));

describe('gp-walkthrough-state', () => {
  it('defaultState is all-false', () => {
    expect(S.defaultState()).toEqual({
      tourDone: false,
      tips: { home: false, practice: false, support: false, account: false, scan: false }
    });
  });

  it('parseState tolerates empty, garbage, JSON and objects', () => {
    expect(S.parseState(null)).toEqual(S.defaultState());
    expect(S.parseState('')).toEqual(S.defaultState());
    expect(S.parseState('not json')).toEqual(S.defaultState());
    expect(S.parseState('{"tourDone":true}').tourDone).toBe(true);
    expect(S.parseState({ tourDone: true, tips: { home: true } }).tips.home).toBe(true);
    // unknown tip keys are dropped, missing ones default false
    expect(S.parseState({ tips: { bogus: true } }).tips).toEqual(S.defaultState().tips);
  });

  it('serialize/parse round-trips', () => {
    const st = S.withTipSeen(S.withTourDone(S.defaultState()), 'account');
    expect(S.parseState(S.serializeState(st))).toEqual(st);
  });

  it('allSeenState is all-true', () => {
    const a = S.allSeenState();
    expect(a.tourDone).toBe(true);
    expect(Object.values(a.tips).every(Boolean)).toBe(true);
  });

  it('withTourDone / withTipSeen are immutable', () => {
    const base = S.defaultState();
    const t = S.withTourDone(base);
    expect(base.tourDone).toBe(false); // original untouched
    expect(t.tourDone).toBe(true);
    const seen = S.withTipSeen(base, 'home');
    expect(base.tips.home).toBe(false);
    expect(seen.tips.home).toBe(true);
    expect(S.withTipSeen(base, 'nope').tips).toEqual(base.tips); // unknown area no-op
  });

  it('shouldRunTour: only when not done', () => {
    expect(S.shouldRunTour(S.defaultState())).toBe(true);
    expect(S.shouldRunTour(S.withTourDone(S.defaultState()))).toBe(false);
  });

  it('shouldRunTip: only after tour done and area unseen', () => {
    const done = S.withTourDone(S.defaultState());
    expect(S.shouldRunTip(S.defaultState(), 'home')).toBe(false); // tour not done
    expect(S.shouldRunTip(done, 'home')).toBe(true);
    expect(S.shouldRunTip(S.withTipSeen(done, 'home'), 'home')).toBe(false);
    expect(S.shouldRunTip(done, 'unknown')).toBe(false);
  });

  it('routeToArea maps the five routes and .html variants', () => {
    expect(S.routeToArea('/pages/index')).toBe('home');
    expect(S.routeToArea('/pages/index.html')).toBe('home');
    expect(S.routeToArea('/pages/career?gp_shell=embedded')).toBe('practice');
    expect(S.routeToArea('/pages/messages')).toBe('support');
    expect(S.routeToArea('/pages/account.html')).toBe('account');
    expect(S.routeToArea('/pages/ahpra')).toBe(null);
    expect(S.routeToArea('')).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gp-walkthrough-state.test.js`
Expected: FAIL — cannot find module `js/gp-walkthrough-state.js`.

- [ ] **Step 3: Write minimal implementation**

Create `js/gp-walkthrough-state.js`:

```js
// Pure walkthrough state logic — no DOM, no browser globals. UMD so vitest can require it.
// State shape: { tourDone: bool, tips: { home, practice, support, account, scan : bool } }
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpWalkthroughState = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var AREAS = ['home', 'practice', 'support', 'account', 'scan'];

  function defaultState() {
    return { tourDone: false, tips: { home: false, practice: false, support: false, account: false, scan: false } };
  }
  function normalize(state) {
    var d = defaultState();
    if (!state || typeof state !== 'object') return d;
    d.tourDone = state.tourDone === true;
    var t = state.tips && typeof state.tips === 'object' ? state.tips : {};
    for (var i = 0; i < AREAS.length; i++) d.tips[AREAS[i]] = t[AREAS[i]] === true;
    return d;
  }
  function parseState(raw) {
    if (raw === null || typeof raw === 'undefined' || raw === '') return defaultState();
    if (typeof raw === 'object') return normalize(raw);
    try { return normalize(JSON.parse(raw)); } catch (e) { return defaultState(); }
  }
  function serializeState(state) { return JSON.stringify(normalize(state)); }
  function allSeenState() {
    return { tourDone: true, tips: { home: true, practice: true, support: true, account: true, scan: true } };
  }
  function withTourDone(state) { var n = normalize(state); n.tourDone = true; return n; }
  function withTipSeen(state, area) {
    var n = normalize(state);
    if (AREAS.indexOf(area) !== -1) n.tips[area] = true;
    return n;
  }
  function shouldRunTour(state) { return normalize(state).tourDone !== true; }
  function shouldRunTip(state, area) {
    var n = normalize(state);
    return n.tourDone === true && AREAS.indexOf(area) !== -1 && n.tips[area] === false;
  }
  var ROUTE_AREA = {
    '/pages/index': 'home',
    '/pages/career': 'practice',
    '/pages/messages': 'support',
    '/pages/account': 'account'
  };
  function routeToArea(pathname) {
    if (!pathname) return null;
    var p = String(pathname).replace(/[?#].*$/, '').replace(/\.html$/, '').replace(/\/+$/, '');
    return ROUTE_AREA[p] || null;
  }

  return {
    AREAS: AREAS, defaultState: defaultState, parseState: parseState, serializeState: serializeState,
    allSeenState: allSeenState, withTourDone: withTourDone, withTipSeen: withTipSeen,
    shouldRunTour: shouldRunTour, shouldRunTip: shouldRunTip, routeToArea: routeToArea
  };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gp-walkthrough-state.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add js/gp-walkthrough-state.js tests/gp-walkthrough-state.test.js
git commit -m "feat(walkthrough): pure state module (shape, fire-conditions, route map)"
```

---

## Task 2: Overlay engine (`gp-coach.js`)

**Files:**
- Create: `js/gp-coach.js`
- Test: `tests/gp-coach.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (on `window.gpCoach` and `module.exports`):
  - `computePlacement(target, tip, viewport, opts) → {spot:{left,top,width,height}, tip:{left,top}, placeBelow:bool, arrowLeft:number}` — **pure.** `target`/`viewport` in px; `tip` is `{width,height}`.
  - `run(steps, options) → Promise<'done'|'skip'|'empty'|'busy'>` — DOM sequence. `steps: [{target:selector|Element|fn, title, body}]`. `options: {onDone, onSkip, label(idx,total)→string}`.
  - `isActive() → bool`
  - `waitForElement(selector, timeoutMs) → Promise<Element|null>`

- [ ] **Step 1: Write the failing test** (pure geometry only — `run` is verified manually in Task 9)

Create `tests/gp-coach.test.js`:

```js
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require(path.join(__dirname, '..', 'js', 'gp-coach.js'));

const VP = { width: 390, height: 788 };
const TIP = { width: 280, height: 150 };

describe('gp-coach computePlacement', () => {
  it('places the tip BELOW a target in the top half', () => {
    const p = C.computePlacement({ left: 20, top: 100, width: 60, height: 40 }, TIP, VP, {});
    expect(p.placeBelow).toBe(true);
    expect(p.tip.top).toBeGreaterThan(100);
  });

  it('places the tip ABOVE a target in the bottom half (e.g. nav bar)', () => {
    const p = C.computePlacement({ left: 20, top: 720, width: 60, height: 44 }, TIP, VP, {});
    expect(p.placeBelow).toBe(false);
    expect(p.tip.top).toBeLessThan(720);
  });

  it('clamps the tip within the viewport horizontally', () => {
    const left = C.computePlacement({ left: 0, top: 100, width: 40, height: 40 }, TIP, VP, {});
    expect(left.tip.left).toBeGreaterThanOrEqual(12);
    const right = C.computePlacement({ left: 380, top: 100, width: 40, height: 40 }, TIP, VP, {});
    expect(right.tip.left + TIP.width).toBeLessThanOrEqual(VP.width - 12 + 0.001);
  });

  it('keeps the arrow inside the tip', () => {
    const p = C.computePlacement({ left: 0, top: 100, width: 20, height: 20 }, TIP, VP, {});
    expect(p.arrowLeft).toBeGreaterThanOrEqual(12);
    expect(p.arrowLeft).toBeLessThanOrEqual(TIP.width - 12);
  });

  it('spotlight box pads around the target', () => {
    const p = C.computePlacement({ left: 100, top: 100, width: 60, height: 40 }, TIP, VP, { pad: 8 });
    expect(p.spot).toEqual({ left: 92, top: 92, width: 76, height: 56 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gp-coach.test.js`
Expected: FAIL — cannot find module `js/gp-coach.js`.

- [ ] **Step 3: Write minimal implementation**

Create `js/gp-coach.js`:

```js
// Coach-mark overlay engine. Pure computePlacement is unit-tested; run()/DOM code is
// browser-only and never touches the DOM at load time (safe to require() under Node).
// UMD: window.gpCoach in the browser, module.exports for vitest.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpCoach = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---------- pure geometry ----------
  function computePlacement(target, tip, viewport, opts) {
    opts = opts || {};
    var pad = opts.pad != null ? opts.pad : 8;
    var gap = opts.gap != null ? opts.gap : 14;
    var margin = opts.margin != null ? opts.margin : 12;
    var spot = { left: target.left - pad, top: target.top - pad, width: target.width + pad * 2, height: target.height + pad * 2 };
    var placeBelow = (target.top + target.height / 2) < viewport.height / 2;
    var tipTop = placeBelow ? (spot.top + spot.height + gap) : (spot.top - gap - tip.height);
    if (placeBelow && tipTop + tip.height > viewport.height - margin) { tipTop = spot.top - gap - tip.height; placeBelow = false; }
    else if (!placeBelow && tipTop < margin) { tipTop = spot.top + spot.height + gap; placeBelow = true; }
    var tipLeft = target.left + target.width / 2 - tip.width / 2;
    tipLeft = Math.max(margin, Math.min(tipLeft, viewport.width - tip.width - margin));
    var arrowLeft = Math.max(12, Math.min(target.left + target.width / 2 - tipLeft, tip.width - 12));
    return { spot: spot, tip: { left: tipLeft, top: tipTop }, placeBelow: placeBelow, arrowLeft: arrowLeft };
  }

  // ---------- browser-only below (never called at module load) ----------
  var STYLE_ID = 'gp-coach-styles';
  var active = false;
  function doc() { return typeof document !== 'undefined' ? document : null; }

  function ensureStyles() {
    var d = doc(); if (!d || d.getElementById(STYLE_ID)) return;
    var css = ''
      + '.gp-coach-overlay{position:fixed;inset:0;z-index:2147483000;}'
      + '.gp-coach-spot{position:fixed;border-radius:14px;pointer-events:none;'
      + 'box-shadow:0 0 0 9999px rgba(9,14,28,.62),0 0 0 3px rgba(255,255,255,.92);'
      + 'transition:all .32s cubic-bezier(.22,.61,.21,1);}'
      + '.gp-coach-tip{position:fixed;width:min(280px,calc(100vw - 24px));background:#fff;border-radius:16px;'
      + 'padding:15px 15px 13px;box-shadow:0 24px 55px -24px rgba(2,6,23,.5);'
      + "font-family:var(--gp-font-body,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);color:#1f2b43;"
      + 'transition:all .3s cubic-bezier(.22,.61,.21,1);}'
      + '.gp-coach-step{font-size:11px;font-weight:700;letter-spacing:.05em;color:#2563eb;text-transform:uppercase;margin-bottom:6px;}'
      + '.gp-coach-title{margin:0 0 5px;font-size:15.5px;font-weight:700;color:#0f172a;}'
      + '.gp-coach-body{margin:0 0 13px;font-size:13.5px;line-height:1.5;}'
      + '.gp-coach-acts{display:flex;align-items:center;gap:8px;}'
      + '.gp-coach-skip{margin-right:auto;background:none;border:none;font:inherit;font-size:12.5px;font-weight:600;color:#94a3b8;cursor:pointer;}'
      + '.gp-coach-back{background:#eff4ff;border:none;border-radius:10px;padding:8px 13px;font:inherit;font-size:13px;font-weight:600;color:#1d4ed8;cursor:pointer;}'
      + '.gp-coach-next{background:linear-gradient(135deg,#2e6bf0,#1d4ed8);border:none;border-radius:10px;padding:8px 15px;font:inherit;font-size:13px;font-weight:600;color:#fff;cursor:pointer;}'
      + '.gp-coach-arrow{position:absolute;width:14px;height:14px;background:#fff;transform:rotate(45deg);}'
      + '.gp-coach-arrow.below{top:-7px;}.gp-coach-arrow.above{bottom:-7px;}'
      + '@media (prefers-reduced-motion: reduce){.gp-coach-spot,.gp-coach-tip{transition:none!important;}}';
    var el = d.createElement('style'); el.id = STYLE_ID; el.textContent = css; d.head.appendChild(el);
  }

  function waitForElement(selector, timeout) {
    var d = doc();
    return new Promise(function (resolve) {
      if (!d) return resolve(null);
      var found = d.querySelector(selector);
      if (found) return resolve(found);
      var to = null;
      var obs = new MutationObserver(function () {
        var el = d.querySelector(selector);
        if (el) { obs.disconnect(); if (to) clearTimeout(to); resolve(el); }
      });
      obs.observe(d.body, { childList: true, subtree: true });
      to = setTimeout(function () { obs.disconnect(); resolve(d.querySelector(selector)); }, timeout || 4000);
    });
  }

  function resolveTarget(t) {
    var d = doc(); if (!d) return Promise.resolve(null);
    if (typeof t === 'function') { try { return Promise.resolve(t()); } catch (e) { return Promise.resolve(null); } }
    if (t && t.nodeType === 1) return Promise.resolve(t);
    if (typeof t === 'string') return waitForElement(t, 4000);
    return Promise.resolve(null);
  }

  function run(steps, options) {
    var d = doc();
    if (!d || !Array.isArray(steps) || !steps.length) return Promise.resolve('empty');
    if (active) return Promise.resolve('busy');
    active = true;
    ensureStyles();
    var opts = options || {};
    var reduced = false;
    try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

    var overlay = d.createElement('div');
    overlay.className = 'gp-coach-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var spot = d.createElement('div'); spot.className = 'gp-coach-spot';
    var tip = d.createElement('div'); tip.className = 'gp-coach-tip';
    tip.innerHTML = '<div class="gp-coach-arrow"></div><div class="gp-coach-step" aria-live="polite"></div>'
      + '<h5 class="gp-coach-title"></h5><p class="gp-coach-body"></p><div class="gp-coach-acts"></div>';
    overlay.appendChild(spot); overlay.appendChild(tip);
    d.body.appendChild(overlay);

    var stepEl = tip.querySelector('.gp-coach-step');
    var titleEl = tip.querySelector('.gp-coach-title');
    var bodyEl = tip.querySelector('.gp-coach-body');
    var actsEl = tip.querySelector('.gp-coach-acts');
    var arrowEl = tip.querySelector('.gp-coach-arrow');
    var idx = 0, curTarget = null, lastFocus = d.activeElement, total = steps.length;

    return new Promise(function (resolve) {
      function cleanup(reason) {
        active = false;
        window.removeEventListener('resize', reposition, true);
        window.removeEventListener('scroll', reposition, true);
        d.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
        resolve(reason);
      }
      function done() { if (opts.onDone) { try { opts.onDone(); } catch (e) {} } cleanup('done'); }
      function skip() { if (opts.onSkip) { try { opts.onSkip(); } catch (e) {} } cleanup('skip'); }
      function next() { if (idx >= total - 1) done(); else { idx++; render(); } }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); skip(); }
        else if (e.key === 'Enter') { e.preventDefault(); next(); }
      }
      function reposition() {
        if (!curTarget) return;
        var r = curTarget.getBoundingClientRect();
        var pl = computePlacement(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          { width: tip.offsetWidth, height: tip.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }, {});
        spot.style.left = pl.spot.left + 'px'; spot.style.top = pl.spot.top + 'px';
        spot.style.width = pl.spot.width + 'px'; spot.style.height = pl.spot.height + 'px';
        tip.style.left = pl.tip.left + 'px'; tip.style.top = pl.tip.top + 'px';
        arrowEl.style.left = pl.arrowLeft + 'px';
        arrowEl.className = 'gp-coach-arrow ' + (pl.placeBelow ? 'below' : 'above');
      }
      function renderActions() {
        actsEl.innerHTML = '';
        var s = d.createElement('button'); s.type = 'button'; s.className = 'gp-coach-skip'; s.textContent = 'Skip';
        s.addEventListener('click', skip); actsEl.appendChild(s);
        if (idx > 0) {
          var b = d.createElement('button'); b.type = 'button'; b.className = 'gp-coach-back'; b.textContent = 'Back';
          b.addEventListener('click', function () { idx = Math.max(0, idx - 1); render(); }); actsEl.appendChild(b);
        }
        var n = d.createElement('button'); n.type = 'button'; n.className = 'gp-coach-next';
        n.textContent = idx === total - 1 ? 'Done' : 'Next';
        n.addEventListener('click', next); actsEl.appendChild(n);
      }
      function render() {
        resolveTarget(steps[idx].target).then(function (el) {
          if (!el) { if (idx >= total - 1) { done(); } else { idx++; render(); } return; }
          curTarget = el;
          try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) {}
          stepEl.textContent = typeof opts.label === 'function' ? opts.label(idx, total) : ('Step ' + (idx + 1) + ' of ' + total);
          titleEl.textContent = steps[idx].title || '';
          bodyEl.textContent = steps[idx].body || '';
          renderActions();
          (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () {
            reposition();
            var f = actsEl.querySelector('.gp-coach-next'); if (f) { try { f.focus(); } catch (e) {} }
          });
        });
      }
      window.addEventListener('resize', reposition, true);
      window.addEventListener('scroll', reposition, true);
      d.addEventListener('keydown', onKey, true);
      render();
    });
  }

  function isActive() { return active; }

  return { computePlacement: computePlacement, run: run, isActive: isActive, waitForElement: waitForElement };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gp-coach.test.js`
Expected: PASS (5 tests). (Importing the file under Node also proves it does no DOM work at load.)

- [ ] **Step 5: Commit**

```bash
git add js/gp-coach.js tests/gp-coach.test.js
git commit -m "feat(walkthrough): coach-mark overlay engine (pure placement + DOM run)"
```

---

## Task 3: Register the state key (client + server)

**Files:**
- Modify: `js/state-sync.js:2-27` (add to `STATE_KEYS`)
- Modify: `server.js:6165-6191` (add to `USER_STATE_KEYS`)
- Test: `tests/walkthrough-state-key.test.js`

**Interfaces:**
- Produces: the key `gp_walkthrough_state` round-trips through `/api/state`.

- [ ] **Step 1: Write the failing test**

Create `tests/walkthrough-state-key.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('gp_walkthrough_state is registered on both sides', () => {
  it('client STATE_KEYS in js/state-sync.js', () => {
    const src = read('js/state-sync.js');
    const block = src.slice(src.indexOf('STATE_KEYS'), src.indexOf('STATE_KEYS') + 900);
    expect(block).toContain("'gp_walkthrough_state'");
  });
  it('server USER_STATE_KEYS in server.js', () => {
    const src = read('server.js');
    const block = src.slice(src.indexOf('USER_STATE_KEYS'), src.indexOf('USER_STATE_KEYS') + 900);
    expect(block).toContain("'gp_walkthrough_state'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-state-key.test.js`
Expected: FAIL — key not present in either file.

- [ ] **Step 3: Implement — add the key in both files**

In `js/state-sync.js`, add a line after `'gp_stage_override_at'` (line 26), inside the `STATE_KEYS` array:
```js
  'gp_stage_override_at',
  'gp_walkthrough_state'
```

In `server.js`, add a line after `'gp_eligibility_waitlist'` (line 6190), inside the `USER_STATE_KEYS` array:
```js
  'gp_eligibility_waitlist',
  'gp_walkthrough_state'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/walkthrough-state-key.test.js`
Expected: PASS (2 tests).
Also sanity-check the server still parses: `node --check server.js` → no output (success).

- [ ] **Step 5: Commit**

```bash
git add js/state-sync.js server.js tests/walkthrough-state-key.test.js
git commit -m "feat(walkthrough): register gp_walkthrough_state in client + server state allowlists"
```

---

## Task 4: Page controller + wire the four content pages

**Files:**
- Create: `js/gp-walkthrough.js`
- Modify: `pages/index.html:6-18`, `pages/career.html:48-58`, `pages/messages.html:8-15`, `pages/account.html:7-15` (add three script tags each)
- Test: `tests/walkthrough-page-wiring.test.js`

**Interfaces:**
- Consumes: `window.gpWalkthroughState`, `window.gpCoach`, `window.gpLinkStateSync`.
- Produces: `window.gpWalkthrough = { maybeRun, runArea }`. Auto-runs the current page's mini-tour on first visit; delegates clicks on `[data-walkthrough-replay]` to a `gp-shell-run-tour` postMessage.

- [ ] **Step 1: Write the failing test** (static wiring; behaviour verified in Task 9)

Create `tests/walkthrough-page-wiring.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), 'pages', p), 'utf8');
const PAGES = ['index.html', 'career.html', 'messages.html', 'account.html'];

describe('content pages load the walkthrough scripts', () => {
  for (const p of PAGES) {
    it(`${p} includes gp-coach, gp-walkthrough-state and gp-walkthrough`, () => {
      const html = read(p);
      expect(html).toMatch(/\/js\/gp-coach\.js\?v=/);
      expect(html).toMatch(/\/js\/gp-walkthrough-state\.js\?v=/);
      expect(html).toMatch(/\/js\/gp-walkthrough\.js\?v=/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-page-wiring.test.js`
Expected: FAIL — scripts not present.

- [ ] **Step 3a: Create the page controller**

Create `js/gp-walkthrough.js`:

```js
// Page controller: runs INSIDE each content page's iframe. Owns per-page first-visit
// mini-tours. Reads/writes the shared gp_walkthrough_state via localStorage + state-sync.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var KEY = 'gp_walkthrough_state';
  var S = window.gpWalkthroughState, C = window.gpCoach;

  function guarded() {
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return true;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return true;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return true;
    if (C && C.isActive && C.isActive()) return true;
    return false;
  }
  function readState() { try { return S.parseState(localStorage.getItem(KEY)); } catch (e) { return S.defaultState(); } }
  function markSeen(area) {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withTipSeen(readState(), area)));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }

  var HOME = [
    { target: '.glass-progress', title: 'Your journey', body: 'Every registration stage sits here — green is done, blue is your current step.' },
    { target: '#hero-next-action', title: 'Your next move', body: 'Your single next action is always shown here. Tap it to jump straight in.' },
    { target: '#journeyList', title: 'The full path', body: 'Scroll to see every step ahead, from MyIntealth through to starting work.' }
  ];
  var ACCOUNT = [
    { target: '.account-hero', title: 'Your profile', body: 'Your details and how complete your profile is, at a glance.' },
    { target: '#panel-home .section-card', title: 'Settings & quick links', body: 'Update your details, notifications and privacy from here.' }
  ];
  // Practice & Support are empty for brand-new GPs, so adapt: walk live cards if present,
  // otherwise a single tip on the static container explaining what will appear.
  function stepsFor(area) {
    if (area === 'home') return HOME;
    if (area === 'account') return ACCOUNT;
    if (area === 'practice') {
      if (document.querySelector('.at-match-pin')) return [
        { target: '.at-match-pin', title: 'Roles matched to you', body: 'Each match is scored against your profile — higher means a better fit.' },
        { target: '.at-match-accept', title: 'Review & accept', body: 'Open a match to meet the practice, then accept the one you want.' }
      ];
      return [{ target: '#teamMatchesSection', title: 'Roles matched to you', body: 'When we match you to a practice it appears here — ready to review and accept.' }];
    }
    if (area === 'support') {
      if (document.querySelector('.chat-card')) return [
        { target: '#chatList', title: 'Your conversations', body: 'Every chat with your GP Link team lives here.' },
        { target: '.chat-card', title: 'Open a conversation', body: 'Tap a chat to read replies and message back — we reply within a day.' }
      ];
      return [{ target: '#chatList', title: 'Message us any time', body: 'Your conversations with the GP Link team appear here — tap to start one.' }];
    }
    return [];
  }

  function firstVisitLabel(i, n) { return n > 1 ? ('First-visit · ' + (i + 1) + '/' + n) : 'First-visit tip'; }

  function runArea(area) {
    if (!area || !C || !S) return;
    var steps = stepsFor(area);
    if (!steps.length) return;
    C.run(steps, { label: firstVisitLabel });
  }
  function maybeRun() {
    if (!S || !C) return;
    var area = S.routeToArea(location.pathname);
    if (!area) return;
    if (guarded()) return;
    if (!S.shouldRunTip(readState(), area)) return;
    markSeen(area);          // mark BEFORE running so it can never double-fire
    runArea(area);
  }

  // Replay entry (Account row): ask the shell to run the nav tour.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-walkthrough-replay]') : null;
    if (!el) return;
    e.preventDefault();
    try { window.parent.postMessage({ type: 'gp-shell-run-tour' }, location.origin); } catch (err) {}
  });

  function boot() {
    if (window.gpLinkStateSync && window.gpLinkStateSync.isHydrated && window.gpLinkStateSync.isHydrated()) { maybeRun(); return; }
    window.addEventListener('gp-state-hydrated', maybeRun, { once: true });
    window.addEventListener('gp-data-ready', function () { setTimeout(maybeRun, 60); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.gpWalkthrough = { maybeRun: maybeRun, runArea: runArea };
})();
```

- [ ] **Step 3b: Add the three script tags to each of the four pages**

For **each** page, add these three lines into the existing `<head>` script block (they must come after `state-sync.js`, which is already present). Use the exact insertion points below.

`pages/index.html` — after the `state-sync.js` tag (line 12):
```html
  <script src="/js/gp-coach.js?v=20260711a" defer></script>
  <script src="/js/gp-walkthrough-state.js?v=20260711a" defer></script>
  <script src="/js/gp-walkthrough.js?v=20260711a" defer></script>
```
`pages/career.html` — after the `state-sync.js` tag (line 53): same three lines.
`pages/messages.html` — after the `state-sync.js` tag (line 10): same three lines.
`pages/account.html` — after the `state-sync.js` tag (line 9): same three lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/walkthrough-page-wiring.test.js`
Expected: PASS (4 tests).
Sanity: `node --check js/gp-walkthrough.js` → no output.

- [ ] **Step 5: Commit**

```bash
git add js/gp-walkthrough.js pages/index.html pages/career.html pages/messages.html pages/account.html tests/walkthrough-page-wiring.test.js
git commit -m "feat(walkthrough): page controller + first-visit mini-tours on the four content pages"
```

---

## Task 5: Shell controller + shell wiring

**Files:**
- Create: `js/gp-walkthrough-shell.js`
- Modify: `pages/app-shell.html` (head script block, lines 13-23) — add four script tags
- Modify: `js/app-shell.js` — (a) in `handleFrameLoad` after `frameState.loadedRoute = nextRoute;` (line 1541) dispatch an event; (b) in the `message` handler that processes `gp-shell-route` add a `gp-shell-run-tour` case
- Test: `tests/walkthrough-shell-wiring.test.js`

**Interfaces:**
- Consumes: `window.gpWalkthroughState`, `window.gpCoach`, `window.gpLinkStateSync`; the `gp-shell-frame-loaded` window event (new); the visible nav DOM.
- Produces: `window.gpWalkthroughShell = { runTour }`. Auto-runs the nav tour once for new users; writes `tourDone`.

- [ ] **Step 1: Write the failing test** (static wiring)

Create `tests/walkthrough-shell-wiring.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('shell wiring', () => {
  it('app-shell.html loads state-sync, coach, state and the shell controller', () => {
    const html = read('pages/app-shell.html');
    expect(html).toMatch(/\/js\/state-sync\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-coach\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-state\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-shell\.js\?v=/);
  });
  it('app-shell.js dispatches gp-shell-frame-loaded and handles gp-shell-run-tour', () => {
    const js = read('js/app-shell.js');
    expect(js).toContain('gp-shell-frame-loaded');
    expect(js).toContain('gp-shell-run-tour');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-shell-wiring.test.js`
Expected: FAIL.

- [ ] **Step 3a: Create the shell controller**

Create `js/gp-walkthrough-shell.js`:

```js
// Shell controller: runs in app-shell.html (the parent). Owns the bottom-nav spotlight
// tour and the tourDone flag. Renders in the shell so it can highlight the nav bars.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var KEY = 'gp_walkthrough_state';
  var S = window.gpWalkthroughState, C = window.gpCoach;
  var homeLoaded = false, hydrated = false, ranAuto = false;

  var TABS = [
    { area: 'home', title: 'Home', body: 'Your dashboard — see how far along your registration is, anytime.' },
    { area: 'practice', title: 'My Practice', body: 'Browse GP roles matched to you and accept the one you want.' },
    { area: 'scan', title: 'Scan', body: 'Snap a photo of a document and we verify it for you.' },
    { area: 'support', title: 'Support', body: 'Message our team — replies land right here.' },
    { area: 'account', title: 'Account', body: 'Your profile, details and notification settings.' }
  ];
  var MOBILE = {
    home: '.mobile-nav [data-route="/pages/index"]',
    practice: '.mobile-nav [data-route="/pages/career"]',
    scan: '.mobile-nav [data-qual-scan-trigger]',
    support: '.mobile-nav [data-route="/pages/messages"]',
    account: '.mobile-nav [data-route="/pages/account"]'
  };
  var DESKTOP = {
    home: '.nav-menu [data-route="/pages/index"]',
    practice: '.nav-menu [data-route="/pages/career"]',
    support: '.nav-menu [data-route="/pages/messages"]',
    account: '.nav-menu [data-route="/pages/account"]'
  };
  function navEl(area) {
    var mobile = document.querySelector('.mobile-nav');
    var mobileVisible = mobile && getComputedStyle(mobile).display !== 'none';
    if (mobileVisible) return document.querySelector(MOBILE[area]);
    return DESKTOP[area] ? document.querySelector(DESKTOP[area]) : null; // no scan tab on desktop
  }
  function buildSteps() {
    var out = [];
    for (var i = 0; i < TABS.length; i++) {
      var el = navEl(TABS[i].area);
      if (el) out.push({ target: el, title: TABS[i].title, body: TABS[i].body });
    }
    return out;
  }

  function guarded() {
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return true;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return true;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return true;
    if (C && C.isActive && C.isActive()) return true;
    return false;
  }
  function readState() { try { return S.parseState(localStorage.getItem(KEY)); } catch (e) { return S.defaultState(); } }
  function markDone() {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withTourDone(readState())));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }
  function runTour() {
    if (!C || !S || C.isActive()) return;
    var steps = buildSteps();
    if (!steps.length) return;
    C.run(steps, { label: function (i, n) { return 'Step ' + (i + 1) + ' of ' + n; }, onDone: markDone, onSkip: markDone });
  }
  function tryAuto() {
    if (ranAuto || !homeLoaded || !hydrated) return;
    ranAuto = true; // decide exactly once
    if (guarded()) return;
    if (!S.shouldRunTour(readState())) return;
    setTimeout(runTour, 350); // let the nav settle
  }

  if (window.gpLinkStateSync && window.gpLinkStateSync.isHydrated && window.gpLinkStateSync.isHydrated()) { hydrated = true; }
  else {
    window.addEventListener('gp-state-hydrated', function () { hydrated = true; tryAuto(); }, { once: true });
    window.addEventListener('gp-data-ready', function () { hydrated = true; tryAuto(); }, { once: true });
  }
  window.addEventListener('gp-shell-frame-loaded', function (e) {
    if (e && e.detail && e.detail.route === '/pages/index') { homeLoaded = true; tryAuto(); }
  });

  window.gpWalkthroughShell = { runTour: runTour };
  tryAuto();
})();
```

- [ ] **Step 3b: Add the four script tags to `pages/app-shell.html`**

Inside the `<head>` script block (after the existing app-shell/match-popup scripts, around line 23), add — order matters:
```html
  <script src="/js/state-sync.js?v=20260711a" defer></script>
  <script src="/js/gp-coach.js?v=20260711a" defer></script>
  <script src="/js/gp-walkthrough-state.js?v=20260711a" defer></script>
  <script src="/js/gp-walkthrough-shell.js?v=20260711a" defer></script>
```

- [ ] **Step 3c: Dispatch `gp-shell-frame-loaded` from `js/app-shell.js`**

In `handleFrameLoad`, immediately after the line `frameState.loadedRoute = nextRoute;` (line 1541), add:
```js
      try { window.dispatchEvent(new CustomEvent('gp-shell-frame-loaded', { detail: { route: nextRoute } })); } catch (e) {}
```

- [ ] **Step 3d: Handle the `gp-shell-run-tour` replay message in `js/app-shell.js`**

Find the `message` event handler that checks `data.type === 'gp-shell-route'` (grep `gp-shell-route` in `js/app-shell.js`). At the top of that handler's body, after the existing origin check and before/near the `gp-shell-route` handling, add:
```js
      if (data && data.type === 'gp-shell-run-tour') {
        if (window.gpWalkthroughShell && window.gpWalkthroughShell.runTour) window.gpWalkthroughShell.runTour();
        return;
      }
```
(Keep it inside the same origin-validated handler so it only accepts same-origin messages.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/walkthrough-shell-wiring.test.js`
Expected: PASS (2 tests).
Sanity: `node --check js/gp-walkthrough-shell.js` and `node --check js/app-shell.js` → no output.

- [ ] **Step 5: Commit**

```bash
git add js/gp-walkthrough-shell.js pages/app-shell.html js/app-shell.js tests/walkthrough-shell-wiring.test.js
git commit -m "feat(walkthrough): shell controller + auto nav tour + replay message wiring"
```

---

## Task 6: Account replay entry row

**Files:**
- Modify: `pages/account.html` — add an `.ov-row` button inside the "Quick links" `.overview` (after the "My Practice" row, ~line 582)
- Test: `tests/walkthrough-replay-row.test.js`

**Interfaces:**
- Consumes: the `[data-walkthrough-replay]` click delegation from Task 4's `gp-walkthrough.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/walkthrough-replay-row.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('account has a replay-the-tour row', () => {
  it('renders a [data-walkthrough-replay] control', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'account.html'), 'utf8');
    expect(html).toContain('data-walkthrough-replay');
    expect(html).toMatch(/Replay the app tour|Show me around again/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-replay-row.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the row**

In `pages/account.html`, inside the "Quick links" card's `.overview` block, immediately after the "My Practice" `.ov-row` link closes (`</a>` near line 582), add:
```html
            <button class="ov-row" type="button" data-walkthrough-replay>
              <svg class="ov-ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/></svg>
              <span class="ov-label"><b>Replay the app tour</b><small>See the quick walkthrough again</small></span>
              <svg class="ov-chev" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
            </button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walkthrough-replay-row.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pages/account.html tests/walkthrough-replay-row.test.js
git commit -m "feat(walkthrough): 'Replay the app tour' row in Account quick links"
```

---

## Task 7: Scan mini-tour on first camera-modal open

**Files:**
- Modify: `js/qualification-scan.js` — in `openModal()` (line 539), after the modal is shown, trigger a first-visit Scan mini-tour
- Test: `tests/walkthrough-scan-hook.test.js`

**Interfaces:**
- Consumes: `window.gpCoach`, `window.gpWalkthroughState`, `window.gpLinkStateSync`; the modal's `.scan-actions` (line 483) and `.scan-submit` (`#gpScanSubmit`, line 501).

- [ ] **Step 1: Write the failing test**

Create `tests/walkthrough-scan-hook.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('scan modal triggers a first-visit Scan mini-tour', () => {
  it('qualification-scan.js references the scan-area walkthrough hook', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'js', 'qualification-scan.js'), 'utf8');
    expect(src).toContain('gpWalkthroughState');
    expect(src).toMatch(/maybeScanTour|'scan'|"scan"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-scan-hook.test.js`
Expected: FAIL.

- [ ] **Step 3: Add the hook**

In `js/qualification-scan.js`, add this helper near the top of the module (after the existing constants) and call it at the end of `openModal()` (line 539), after the modal gets its `.open` class:

```js
  // First-visit Scan mini-tour (part of the app walkthrough). Runs once, gated on state.
  function maybeScanTour() {
    var S = window.gpWalkthroughState, C = window.gpCoach;
    if (!S || !C || C.isActive()) return;
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return;
    var KEY = 'gp_walkthrough_state';
    var st; try { st = S.parseState(localStorage.getItem(KEY)); } catch (e) { st = S.defaultState(); }
    if (!S.shouldRunTip(st, 'scan')) return;
    try {
      localStorage.setItem(KEY, S.serializeState(S.withTipSeen(st, 'scan')));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
    C.run([
      { target: '.scan-actions', title: 'Scan a document', body: 'Take a photo with your camera, or upload a file you already have.' },
      { target: '#gpScanSubmit', title: 'We verify it for you', body: 'Tap “Scan with AI” and we read and check the document automatically.' }
    ], { label: function (i, n) { return 'First-visit · ' + (i + 1) + '/' + n; } });
  }
```
Then, at the end of `openModal()` (after the modal is displayed), add:
```js
    setTimeout(maybeScanTour, 350);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walkthrough-scan-hook.test.js`
Expected: PASS.
Sanity: `node --check js/qualification-scan.js` → no output.

- [ ] **Step 5: Commit**

```bash
git add js/qualification-scan.js tests/walkthrough-scan-hook.test.js
git commit -m "feat(walkthrough): first-visit Scan mini-tour on camera-modal open"
```

---

## Task 8: Launch backfill (existing users → all-seen)

**Files:**
- Create: `scripts/backfill-walkthrough-state.js`
- Test: `tests/walkthrough-backfill.test.js`

**Interfaces:**
- Consumes: `window`-free `gp-walkthrough-state.js` (`allSeenState`, `serializeState`); Supabase `user_state` table (`user_id`, `state`).
- Produces: sets `state.gp_walkthrough_state` = all-seen for every existing `user_state` row that doesn't already have it. Idempotent.

- [ ] **Step 1: Write the failing test** (pure transform — no network)

Create `tests/walkthrough-backfill.test.js`:

```js
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { backfillStateBlob } = require(path.join(__dirname, '..', 'scripts', 'backfill-walkthrough-state.js'));

describe('backfillStateBlob', () => {
  it('adds an all-seen gp_walkthrough_state to a blob that lacks it', () => {
    const out = backfillStateBlob({ gp_selected_country: 'GB' });
    const w = JSON.parse(out.gp_walkthrough_state);
    expect(w.tourDone).toBe(true);
    expect(Object.values(w.tips).every(Boolean)).toBe(true);
    expect(out.gp_selected_country).toBe('GB'); // other keys untouched
  });
  it('is idempotent — leaves an existing value unchanged', () => {
    const existing = { gp_walkthrough_state: JSON.stringify({ tourDone: false, tips: {} }) };
    expect(backfillStateBlob(existing)).toBe(null); // null => skip (already set)
  });
  it('handles a null/empty blob', () => {
    const out = backfillStateBlob(null);
    expect(JSON.parse(out.gp_walkthrough_state).tourDone).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/walkthrough-backfill.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the backfill script**

Create `scripts/backfill-walkthrough-state.js`:

```js
// One-time launch backfill: mark every EXISTING user's walkthrough as fully seen so the
// auto-tour and first-visit tips only ever fire for brand-new sign-ups.
// Pure transform `backfillStateBlob` is unit-tested; the runner is guarded behind `main`.
const path = require('path');
const S = require(path.join(__dirname, '..', 'js', 'gp-walkthrough-state.js'));

// Returns the NEW state blob (object) to write, or null if the row already has the key.
function backfillStateBlob(stateBlob) {
  const blob = stateBlob && typeof stateBlob === 'object' ? stateBlob : {};
  if (Object.prototype.hasOwnProperty.call(blob, 'gp_walkthrough_state')) return null;
  const next = Object.assign({}, blob);
  next.gp_walkthrough_state = S.serializeState(S.allSeenState());
  return next;
}

async function main() {
  // Lazy-require so unit tests never touch the network.
  const { createClient } = requireSupabase();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY'); process.exit(1); }
  const db = createClient(url, key);

  const PAGE = 500;
  let from = 0, updated = 0, skipped = 0;
  for (;;) {
    const { data, error } = await db.from('user_state').select('user_id,state').range(from, from + PAGE - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || !data.length) break;
    for (const row of data) {
      const next = backfillStateBlob(row.state);
      if (!next) { skipped++; continue; }
      const upd = await db.from('user_state').update({ state: next }).eq('user_id', row.user_id);
      if (upd.error) { console.error('update failed', row.user_id, upd.error); } else { updated++; }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log('Backfill complete. updated=' + updated + ' skipped=' + skipped);
}

function requireSupabase() {
  try { return require('@supabase/supabase-js'); }
  catch (e) { console.error('Install @supabase/supabase-js or adapt to supabaseDbRequest before running.'); process.exit(1); }
}

module.exports = { backfillStateBlob };
if (require.main === module) main();
```

> **Ops note for the runner (not a code step):** this repo talks to Supabase via `supabaseDbRequest` in `server.js`, not the `@supabase/supabase-js` client. Before running in production, either (a) `npm i -D @supabase/supabase-js` for this one-off, or (b) swap the `main()` body to use PATCH `user_state?user_id=eq.<id>` via `supabaseDbRequest` (same call shape as `server.js:1914`). The pure `backfillStateBlob` transform is what the tests lock down and what carries the launch guarantee; the runner is a thin loop around it. Run once at launch with the service key from `.env` (see memory: SERVICE_ROLE_KEY lives in `.env`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/walkthrough-backfill.test.js`
Expected: PASS (3 tests).
Sanity: `node --check scripts/backfill-walkthrough-state.js` → no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-walkthrough-state.js tests/walkthrough-backfill.test.js
git commit -m "feat(walkthrough): launch backfill (existing users -> all-seen) + pure transform test"
```

---

## Task 9: End-to-end manual verification

**Files:** none (verification only). No code — this task confirms the DOM behaviour that unit tests can't.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run tests/gp-walkthrough-state.test.js tests/gp-coach.test.js tests/walkthrough-state-key.test.js tests/walkthrough-page-wiring.test.js tests/walkthrough-shell-wiring.test.js tests/walkthrough-replay-row.test.js tests/walkthrough-scan-hook.test.js tests/walkthrough-backfill.test.js`
Expected: all PASS.

- [ ] **Step 2: Syntax-check every touched JS file**

Run: `node --check server.js && node --check js/app-shell.js && node --check js/state-sync.js && node --check js/gp-coach.js && node --check js/gp-walkthrough.js && node --check js/gp-walkthrough-shell.js && node --check js/gp-walkthrough-state.js && node --check js/qualification-scan.js && node --check scripts/backfill-walkthrough-state.js`
Expected: no output (all valid).

- [ ] **Step 3: Manual browser walkthrough** (`npm start`, open `http://localhost:3000`, sign in as a test GP with no walkthrough state; use a narrow viewport for mobile nav). Confirm and note the result of each:
  1. On first landing on Home, the **nav tour** auto-plays; `Next`/`Back`/`Skip` and the step counter work; the spotlight sits over each bottom-nav tab; finishing (and, separately, skipping) both stop it re-firing on reload.
  2. Tapping **My Practice**, **Support**, **Account** each shows that page's **mini-tour once**; revisiting doesn't re-fire.
  3. Returning to **Home** after visiting another tab shows the **Home mini-tour** (it was suppressed during the tour); it does not stack on the tour.
  4. Tapping **Scan** (mobile) opens the modal and shows the **2-step Scan mini-tour** once.
  5. **Account → "Replay the app tour"** re-runs the nav tour from anywhere.
  6. Cross-device: complete on one browser, sign in on another — nothing re-fires (state synced via `/api/state`).
  7. Keyboard: `Enter` advances, `Esc` skips. `prefers-reduced-motion` disables the slide animation.
  8. Set `localStorage.gp_account_under_review = 'true'` → no auto-tour / tips fire.

- [ ] **Step 4: Record results honestly**

Write a short PASS/FAIL note per item 1–8 in the PR description. If any DOM behaviour fails, fix it and re-verify before claiming completion. Do NOT run the backfill against production data as part of verification (it is a launch step).

---

## Self-Review (completed against the spec)

- **Spec coverage:** upfront tour (Task 5) ✓; first-visit mini-tours on the 5 areas — Home/Practice/Support/Account (Task 4) + Scan (Task 7) ✓; auto-once + replay (Task 5 + Task 6) ✓; per-user cross-device state (Task 3) ✓; new-users-only rollout via backfill (Task 8) ✓; limited-mode + no-stack guards (Tasks 4/5/7) ✓; content in one place per controller (Tasks 4/5) ✓; iframe-safe split (shell tour vs page tips) ✓.
- **Refinements vs spec (discovered while grounding in code):** (1) `state-sync.js` is now also loaded in the shell — the spec assumed the shell could read the flag; it couldn't, and this is the minimal fix. (2) Replay lives in an **Account row**, not a topbar "? Help", because the shell topbar is desktop-only. (3) Practice/Support mini-tours target **static containers with first-time copy** because a new GP has no live cards; they upgrade to card-walking tours when content exists. (4) Career copy is "review & accept," not "apply" — this page is match/accept based.
- **Placeholder scan:** all step copy is intentionally placeholder (owner sign-off pending) and confined to the two controllers; no `TBD`/`TODO` in logic.
- **Type consistency:** `gpWalkthroughState` (state module), `gpCoach` (engine), `gpWalkthrough`/`gpWalkthroughShell` (controllers), `gp_walkthrough_state` (key), `gp-shell-frame-loaded` / `gp-shell-run-tour` (events) are used identically across tasks.
