// The Social tab's "one click, nineteen Approved toasts" (2026-08-17)
//
// #panel-social is a PERSISTENT element in ceo-dashboard.html — renderInner() only
// replaces its innerHTML, never the node. wire() ran on every render and attached
// another delegated click listener to that same node every time, so the listeners
// stacked. Because each stacked handler fired its own POST, and each POST reloaded
// the month and re-rendered (adding yet another listener), the cost DOUBLED per
// click. Measured in headless Chrome against the real module before the fix:
//
//     click #1 -> POSTs=1  toasts=1
//     click #2 -> POSTs=2  toasts=2
//     click #3 -> POSTs=4  toasts=4
//     click #4 -> POSTs=8  toasts=8
//     click #5 -> POSTs=16 toasts=16
//
// which is the column of "Approved" toasts in the owner's screenshot, plus sixteen
// identical writes to the server. It is the same trap that once stopped a Contracts
// card opening at all (stacked toggles cancelling each other out); the Matching
// board already guards it with a `panelWired` flag.
//
// The second half of the same report — "when I scroll down on the copy textbox it
// automatically goes back up" — is the repaint itself: reloading the month rebuilds
// all ~60 textareas, so a caption the owner had scrolled to read snapped back to the
// top, and an unsaved edit in it was silently thrown away. Measured before the fix:
// scrollTop 60 -> 0, unsaved edit lost.
//
// There is no jsdom in this project, so these tests EXTRACT the real function bodies
// and EXECUTE them against small DOM stubs, rather than grepping for the fix.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const social = fs.readFileSync(path.join(ROOT, 'js/ceo-social.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

function compile(sources, exportName, stubs) {
  const names = Object.keys(stubs);
  const body = sources.join('\n\n') + '\nreturn ' + exportName + ';';
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => stubs[n]));
}

// ── tiny DOM stubs ─────────────────────────────────────────────────────────
function fakeEl(extra) {
  return Object.assign({
    listeners: [],
    disabled: false,
    addEventListener(type, fn) { this.listeners.push({ type: type, fn: fn }); },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  }, extra || {});
}

function fakeCaption(id, value, scrollTop) {
  const card = { getAttribute: (a) => (a === 'data-id' ? id : null) };
  return {
    value: value,
    scrollTop: scrollTop || 0,
    selectionStart: 0,
    selectionEnd: 0,
    closest: () => card,
    focus() { this.focused = true; },
    setSelectionRange(a, b) { this.selRange = [a, b]; }
  };
}

describe('the delegated card handler is bound exactly once, however many renders', () => {
  function buildWire() {
    const root = fakeEl();
    const monthSel = fakeEl();
    const approveBtn = fakeEl();
    const doc = {
      getElementById(id) {
        if (id === 'socMonthSel') return monthSel;
        if (id === 'socApproveBtn') return approveBtn;
        return null;
      }
    };
    const wire = compile([extractFn(social, 'wire')], 'wire', {
      // `panelWired` is a parameter here, so the flag lives in the compiled
      // closure and its mutation persists across calls — exactly as the module's
      // module-scope variable does.
      panelWired: false,
      el: () => root,
      document: doc,
      onCardClick: function onCardClick() {},
      approveCampaign: function approveCampaign() {},
      load: function load() {}
    });
    return { wire, root, monthSel, approveBtn };
  }

  it('ten renders attach ONE click listener to the persistent panel', () => {
    const h = buildWire();
    for (let i = 0; i < 10; i += 1) h.wire();
    const clicks = h.root.listeners.filter((l) => l.type === 'click');
    expect(clicks).toHaveLength(1);
  });

  it('the month picker and Approve button ARE re-bound every render (new nodes each time)', () => {
    // These two live inside the replaced innerHTML, so skipping them would leave
    // the header dead after the first repaint.
    const h = buildWire();
    h.wire(); h.wire(); h.wire();
    expect(h.monthSel.listeners.filter((l) => l.type === 'change')).toHaveLength(3);
    expect(h.approveBtn.listeners.filter((l) => l.type === 'click')).toHaveLength(3);
  });

  it('the guard sits AFTER the per-render bindings, so it cannot skip them', () => {
    const body = extractFn(social, 'wire');
    expect(body.indexOf('socApproveBtn')).toBeLessThan(body.indexOf('if (panelWired) return;'));
    expect(body).toMatch(/panelWired = true;[\s\S]*root\.addEventListener\('click', onCardClick\)/);
  });

  it('the handler is a named function, not an inline closure re-created per render', () => {
    // An inline function literal can never be de-duplicated by removeEventListener
    // either, so naming it is what makes the binding auditable at all.
    expect(social).toMatch(/root\.addEventListener\('click', onCardClick\)/);
    expect(social).toMatch(/function onCardClick\(e\)/);
  });
});

describe('a decision in flight cannot be double-posted', () => {
  it('onCardClick ignores a second click on the same card while one is in flight', () => {
    const sent = [];
    const card = {
      getAttribute: (a) => (a === 'data-id' ? 'post-1' : null),
      querySelector: () => ({ value: 'caption text' })
    };
    const btn = { closest: () => card, getAttribute: () => 'approve' };
    const evt = { target: { closest: () => btn } };
    const inFlight = {};
    const onCardClick = compile([extractFn(social, 'onCardClick')], 'onCardClick', {
      inFlight: inFlight,
      postUpdate: (id, body, msg) => { sent.push(msg); inFlight[id] = true; }
    });
    onCardClick(evt);
    onCardClick(evt);
    onCardClick(evt);
    expect(sent).toEqual(['Approved']);
  });

  it('postUpdate marks the card in flight before awaiting, and clears it after', async () => {
    const inFlight = {};
    let resolveApi;
    const postUpdate = compile([extractFn(social, 'postUpdate')], 'postUpdate', {
      inFlight: inFlight,
      el: () => null,
      A: { api: () => new Promise((r) => { resolveApi = r; }), toast: () => {} },
      load: () => Promise.resolve(),
      state: { month: '2026-09', summary: null, campaign: null }
    });
    const p = postUpdate('post-9', { decision: 'approve' }, 'Approved');
    expect(inFlight['post-9']).toBe(true);
    resolveApi({ ok: true });
    await p;
    expect(inFlight['post-9']).toBeUndefined();
  });

  it('a failed decision releases the card so it can be retried', async () => {
    const inFlight = {};
    const enabled = [];
    const btns = [{ disabled: false }, { disabled: false }];
    const cardEl = { querySelectorAll: () => btns };
    const root = { querySelector: () => cardEl };
    const postUpdate = compile([extractFn(social, 'postUpdate')], 'postUpdate', {
      inFlight: inFlight,
      el: () => root,
      A: { api: () => Promise.resolve({ ok: false, message: 'Could not save.' }), toast: (m) => enabled.push(m) },
      load: () => Promise.resolve(),
      state: { month: '2026-09', summary: null, campaign: null }
    });
    await postUpdate('post-9', { decision: 'approve' }, 'Approved');
    expect(inFlight['post-9']).toBeUndefined();
    expect(btns.every((b) => b.disabled === false)).toBe(true);
    expect(enabled).toEqual(['Could not save.']);
  });
});

describe('a repaint keeps what the owner was reading and typing', () => {
  function buildRestore(boxes) {
    const root = { querySelectorAll: () => boxes };
    return compile([extractFn(social, 'restoreCaptionState')], 'restoreCaptionState', {
      el: () => root
    });
  }

  it('a scrolled caption keeps its scroll position across the repaint', () => {
    // The reported symptom, reduced: the box is repainted holding the same server
    // text, and must come back at the same scroll offset.
    const box = fakeCaption('p1', 'server text', 0);
    buildRestore([box])({ p1: { scrollTop: 60, value: 'server text', focused: false, selStart: 0, selEnd: 0 } }, { p1: 'server text' });
    expect(box.scrollTop).toBe(60);
  });

  it('an UNSAVED edit survives a repaint caused by another card', () => {
    const box = fakeCaption('p1', 'server text', 0);
    buildRestore([box])({ p1: { scrollTop: 20, value: 'my unsaved edit', focused: false, selStart: 0, selEnd: 0 } }, { p1: 'server text' });
    expect(box.value).toBe('my unsaved edit');
    expect(box.scrollTop).toBe(20);
  });

  it('but the SERVER wins when the stored caption actually moved on', () => {
    // Otherwise a real change is masked by a stale box, and the next "Save copy"
    // would write the stale text straight back over it.
    const box = fakeCaption('p1', 'newer text from the server', 0);
    buildRestore([box])({ p1: { scrollTop: 5, value: 'my unsaved edit', focused: false, selStart: 0, selEnd: 0 } }, { p1: 'older text' });
    expect(box.value).toBe('newer text from the server');
  });

  it('an untouched caption takes the server value, never the stale one', () => {
    const box = fakeCaption('p1', 'newer text', 0);
    buildRestore([box])({ p1: { scrollTop: 0, value: 'older text', focused: false, selStart: 0, selEnd: 0 } }, { p1: 'older text' });
    expect(box.value).toBe('newer text');
  });

  it('focus and the caret come back, and focusing cannot yank the page', () => {
    const box = fakeCaption('p1', 'server text', 0);
    buildRestore([box])({ p1: { scrollTop: 40, value: 'server text', focused: true, selStart: 3, selEnd: 7 } }, { p1: 'server text' });
    expect(box.focused).toBe(true);
    expect(box.selRange).toEqual([3, 7]);
    expect(box.scrollTop).toBe(40);
    expect(extractFn(social, 'restoreCaptionState')).toMatch(/preventScroll: true/);
  });

  it('a caption that was not on screen before is left entirely alone', () => {
    const box = fakeCaption('brand-new', 'server text', 0);
    buildRestore([box])({}, {});
    expect(box.value).toBe('server text');
    expect(box.scrollTop).toBe(0);
  });

  it('renderInner captures BEFORE the innerHTML swap and restores AFTER it', () => {
    const body = extractFn(social, 'renderInner');
    const cap = body.indexOf('captureCaptionState()');
    const swap = body.indexOf('root.innerHTML = html;');
    const restore = body.indexOf('restoreCaptionState(');
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(swap);
    expect(restore).toBeGreaterThan(swap);
    // The baseline must be refreshed to the NEW server values, after being used.
    expect(body).toMatch(/lastPainted = \{\};[\s\S]*restoreCaptionState\(prevState, prevPainted\)/);
  });
});

describe('the toast strip can never take the screen over again', () => {
  function buildToast() {
    const container = { children: [], appendChild(n) { this.children.push(n); n.parentNode = this; },
      removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; },
      querySelectorAll() { return this.children.filter((c) => !/removing/.test(c.className)); } };
    const doc = {
      getElementById: (id) => (id === 'toastContainer' ? container : null),
      createElement: () => ({
        className: '', textContent: '', attrs: {},
        classList: { add(c) { this.__el.className += ' ' + c; } },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
      })
    };
    // Read the cap out of the source so this test can never drift from the code.
    const capMatch = /var TOAST_MAX_VISIBLE = (\d+);/.exec(dashboard);
    expect(capMatch, 'TOAST_MAX_VISIBLE must be declared in ceo-dashboard.html').toBeTruthy();
    const showToast = compile([extractFn(dashboard, 'showToast')], 'showToast', {
      document: doc,
      TOAST_MAX_VISIBLE: Number(capMatch[1]),
      setTimeout: () => 0 // freeze the auto-dismiss so every toast stays "visible"
    });
    return { showToast, container, cap: Number(capMatch[1]) };
  }

  it('a repeated message collapses into one counted toast instead of a column', () => {
    const h = buildToast();
    for (let i = 0; i < 16; i += 1) h.showToast('Approved');
    expect(h.container.children).toHaveLength(1);
    expect(h.container.children[0].textContent).toBe('Approved ×16');
  });

  it('different messages still stack, but are hard-capped', () => {
    const h = buildToast();
    ['one', 'two', 'three', 'four', 'five', 'six'].forEach((m) => h.showToast(m));
    expect(h.container.children.length).toBeLessThanOrEqual(h.cap);
    // The newest survives; the oldest is dropped.
    expect(h.container.children[h.container.children.length - 1].textContent).toBe('six');
    expect(h.container.children.map((c) => c.textContent)).not.toContain('one');
  });

  it('a missing container is survivable, not a thrown error mid-action', () => {
    const showToast = compile([extractFn(dashboard, 'showToast')], 'showToast', {
      document: { getElementById: () => null, createElement: () => ({}) },
      setTimeout: () => 0
    });
    expect(() => showToast('Approved')).not.toThrow();
  });
});

describe('the module still loads and the buster moved', () => {
  it('ceo-social.js parses as real JavaScript', () => {
    // page-inline-js-parses.test.js covers pages/, not js/ — and a parse error here
    // would kill the whole tab silently (see the duplicate-`let` career.html crash).
    expect(() => new Function(social)).not.toThrow();
  });

  it('js/* is served immutable for a year, so the tag must carry a new ?v=', () => {
    // Asserted as "moved past the broken build", not frozen at one stamp — later
    // fixes must stay free to bump it. Stamps are sortable YYYYMMDD+letter strings.
    const m = /\/js\/ceo-social\.js\?v=([0-9a-z]+)/.exec(dashboard);
    expect(m, 'ceo-social.js must be loaded with a ?v= buster').toBeTruthy();
    // 20260817b shipped the toast storm; anything at or before it is a stale copy.
    expect(m[1] > '20260817b').toBe(true);
  });
});
