// Three defects reported from a live intake run (screenshot 2026-07-23):
//
//   1. Walking BACK through the step rail from the practices list, changing an
//      answer, then pressing "Save this practice" appended a SECOND copy of the
//      same practice instead of updating it.
//   2. "Continue to the agreement" always failed with "practice_name is
//      required" — the payload builder never sent the field.
//   3. A single practice had no way to add a second one without first finding
//      the "Corporate group" toggle.
//
// These are behaviour tests, not string greps: the real function bodies are
// extracted from the shipped page and executed against stubs, and the payload
// is validated by the REAL server-side validator. tests/practice-intake-form.js
// keeps the static-content checks for the redesign's markup.
const fs = require('fs');
const path = require('path');
const practicePipeline = require('../lib/practice-pipeline');

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'practice-intake.html'), 'utf8');

// Pull a top-level `function name(...) { ... }` out of the page by counting
// braces. The intake page's functions contain no braces inside string or regex
// literals, so a plain counter is exact here (asserted by the smoke test below).
function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found in practice-intake.html');
  let depth = 0;
  let seenBrace = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') { depth++; seenBrace = true; }
    else if (source[i] === '}') {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting ' + name);
}

describe('practice intake — extraction smoke test', () => {
  it('pulls whole function bodies out of the page', () => {
    const src = extractFn(html, 'savePrac');
    expect(src.startsWith('function savePrac(')).toBe(true);
    expect(src.endsWith('}')).toBe(true);
    // Balanced.
    const opens = (src.match(/\{/g) || []).length;
    const closes = (src.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — practice_name never reached the server
// ---------------------------------------------------------------------------
describe('practice intake — the payload the browser actually sends', () => {
  function buildPayloadFor(practice) {
    const factory = new Function(`
      ${extractFn(html, 'boolToSelect')}
      ${extractFn(html, 'buildClinicPayload')}
      return buildClinicPayload;
    `);
    return factory()(practice);
  }

  // A practice that filled in EVERY question on the form.
  const completed = {
    practice_name: 'Bayside Family Practice',
    billing_style: 'mixed', dpa: true, dpaSuggested: true, mmm: 'MM1',
    percentage_split: '90/10', suburb: 'Erina', nearest_city: 'Central Coast',
    state: 'NSW', address: '123 Erina St, Erina NSW 2250',
    general_location: 'Erina, NSW', postcode: '2250',
    latitude: -33.43, longitude: 151.39, google_place_id: 'place-abc',
    urgency: 'asap', employment_type: 'full_time', gps_needed: '2',
    visa_sponsorship: true, ownership: 'GP-owned', years_operating: '10',
    nursing_on_site: true, gp_count: '5', incentives: 'Relocation support',
    earnings_text: '$400k', website: 'https://example.com',
    supervision_available: true, role_summary: 'Busy mixed-billing clinic',
    intro_text: 'We are a family practice', intro_video_url: '',
    hasOwn: false, ownEntity: '', ownAbn: ''
  };

  it('includes the practice name', () => {
    expect(buildPayloadFor(completed).practice_name).toBe('Bayside Family Practice');
  });

  it('is ACCEPTED by the real server validator — a completed form can submit', () => {
    const result = practicePipeline.validatePracticeIntakePayload(buildPayloadFor(completed));
    // Before the fix this was { ok:false, error:'practice_name is required' },
    // which blocked EVERY practice at "Continue to the agreement".
    expect(result.ok).toBe(true);
  });

  it('still reports a genuinely missing name rather than silently inventing one', () => {
    const blank = Object.assign({}, completed, { practice_name: '' });
    const result = practicePipeline.validatePracticeIntakePayload(buildPayloadFor(blank));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/practice_name/);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — the step rail created duplicate practices
// ---------------------------------------------------------------------------
describe('practice intake — going back via the step rail never duplicates', () => {
  // Runs the REAL savePrac() and goRail() against stubs, so the assertions are
  // about shipped behaviour rather than the shape of the source.
  function harness(initial) {
    const factory = new Function('state', `
      var saved = state.saved;
      var cur = state.cur;
      var editIdx = state.editIdx;
      var step = state.step;
      var maxStep = state.maxStep;

      // Stubs for the DOM-bound collaborators.
      function captureCur() { state.captured = (state.captured || 0) + 1; }
      function gate3() {}
      function gate1() {}
      function gate2() {}
      function persistSoon() {}
      function $() { return null; }
      function go(n) { step = n; state.visited.push(n); }
      // Mirrors the real editPrac contract: bind the edit target, load it into
      // cur, then land on a step.
      function editPrac(i, targetStep) {
        editIdx = i;
        cur = saved[i];
        go(targetStep || 1);
      }

      ${extractFn(html, 'savePrac')}
      ${extractFn(html, 'goRail')}

      return {
        savePrac: savePrac,
        goRail: goRail,
        read: function () { return { saved: saved, cur: cur, editIdx: editIdx, step: step }; }
      };
    `);
    const state = Object.assign({ visited: [], maxStep: 5 }, initial);
    return factory(state);
  }

  function practice(name) {
    return { practice_name: name, website: 'https://example.com', suburb: 'Erina', state: 'NSW' };
  }

  it('reproduces the report: rail back to "The job", then Save, keeps ONE practice', () => {
    const p1 = practice('Erina Medical');
    // State the form is in after saving the first practice: sitting on the
    // list (step 4) with `cur` still pointing at the practice just saved.
    const h = harness({ saved: [p1], cur: p1, editIdx: null, step: 4 });

    h.goRail(2);          // practice clicks "2 · The job" on the rail
    h.savePrac();         // ...changes an answer, then "Save this practice"

    expect(h.read().saved).toHaveLength(1);
  });

  it('binds an edit target when the rail re-enters the per-practice steps', () => {
    const p1 = practice('Erina Medical');
    const h = harness({ saved: [p1], cur: p1, editIdx: null, step: 4 });
    h.goRail(2);
    expect(h.read().editIdx).toBe(0);
    expect(h.read().step).toBe(2); // honours the step the practice asked for
  });

  it('edits the RIGHT practice after a reload, where object identity is lost', () => {
    // restoreDraft() rebuilds `cur` with Object.assign(freshCur(), d.cur), so
    // cur is a different object to saved[n] even though it is the same clinic.
    const p1 = practice('Erina Medical');
    const p2 = practice('Gosford Family');
    const restoredCur = Object.assign({}, p2);
    const h = harness({ saved: [p1, p2], cur: restoredCur, editIdx: null, step: 4 });

    h.goRail(3);
    h.savePrac();

    const out = h.read();
    expect(out.saved).toHaveLength(2);                       // no duplicate
    expect(out.saved[1].practice_name).toBe('Gosford Family'); // updated in place
    expect(out.saved[0].practice_name).toBe('Erina Medical');  // untouched
  });

  it('still APPENDS a genuinely new practice added from the list', () => {
    const p1 = practice('Erina Medical');
    const fresh = practice('Brand New Clinic');
    // addAnother() sets cur to a fresh object and clears editIdx.
    const h = harness({ saved: [p1], cur: fresh, editIdx: null, step: 1 });

    h.savePrac();

    const out = h.read();
    expect(out.saved).toHaveLength(2);
    expect(out.saved[1].practice_name).toBe('Brand New Clinic');
  });

  it('an explicit Edit still updates in place', () => {
    const p1 = practice('Erina Medical');
    const p2 = practice('Gosford Family');
    const h = harness({ saved: [p1, p2], cur: p2, editIdx: 1, step: 2 });

    h.savePrac();

    expect(h.read().saved).toHaveLength(2);
    expect(h.read().editIdx).toBeNull();
  });

  it('moving forward through the rail does not hijack the edit target', () => {
    const p1 = practice('Erina Medical');
    const h = harness({ saved: [p1], cur: p1, editIdx: null, step: 4 });
    h.goRail(5); // on to Sign
    expect(h.read().editIdx).toBeNull();
    expect(h.read().step).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — a single practice could not add a second one
// ---------------------------------------------------------------------------
describe('practice intake — adding a second practice promotes to a group', () => {
  it('addAnother switches a solo practice to group mode', () => {
    const src = extractFn(html, 'addAnother');
    expect(src).toMatch(/setMode\(\s*['"]group['"]\s*\)/);
  });

  it('the add button is no longer gated behind picking "Corporate group"', () => {
    // Previously: $('addBtn').classList.toggle('hidden', m !== 'group')
    expect(extractFn(html, 'setMode')).not.toMatch(/addBtn[\s\S]{0,80}!==\s*['"]group['"]/);
    expect(extractFn(html, 'renderList')).not.toMatch(/addBtn[\s\S]{0,80}!==\s*['"]group['"]/);
  });

  it('does not fall back to a blunt yes/no confirm', () => {
    expect(extractFn(html, 'setMode')).not.toMatch(/confirm\(/);
  });
});

// ---------------------------------------------------------------------------
// Switching a group back to a single practice: the practice picks the survivor
// ---------------------------------------------------------------------------
describe('practice intake — choosing which practice to keep', () => {
  // Runs the REAL setMode/startSoloPick/keepOnly against DOM stubs.
  function harness(initial) {
    const factory = new Function('state', `
      var saved = state.saved;
      var mode = state.mode;
      var soloPick = false;

      function fakeEl() {
        return {
          innerHTML: '', disabled: false,
          classList: { add: function () {}, remove: function () {}, toggle: function () {} }
        };
      }
      var els = {};
      function $(id) { if (!els[id]) els[id] = fakeEl(); return els[id]; }
      var document = { querySelectorAll: function () { return []; } };
      function persistSoon() {}
      function renderList() { state.renders = (state.renders || 0) + 1; }

      ${extractFn(html, 'paintModeButtons')}
      ${extractFn(html, 'startSoloPick')}
      ${extractFn(html, 'cancelSoloPick')}
      ${extractFn(html, 'keepOnly')}
      ${extractFn(html, 'setMode')}

      return {
        setMode: setMode,
        keepOnly: keepOnly,
        cancelSoloPick: cancelSoloPick,
        pickMessage: function () { return els.pickMsg ? els.pickMsg.innerHTML : ''; },
        read: function () { return { saved: saved, mode: mode, soloPick: soloPick }; }
      };
    `);
    const state = Object.assign({}, initial);
    return factory(state);
  }

  function group3() {
    return harness({
      mode: 'group',
      saved: [
        { practice_name: 'Erina', suburb: 'Erina', hasOwn: true, ownEntity: 'Erina Pty', ownAbn: '123' },
        { practice_name: 'Gosford', suburb: 'Gosford', hasOwn: true, ownEntity: 'Gosford Pty', ownAbn: '456' },
        { practice_name: 'Terrigal', suburb: 'Terrigal', hasOwn: true, ownEntity: 'Terrigal Pty', ownAbn: '789' }
      ]
    });
  }

  it('does not delete anything until the practice has chosen', () => {
    const h = group3();
    h.setMode('solo');
    const out = h.read();
    expect(out.saved).toHaveLength(3);   // nothing lost yet
    expect(out.mode).toBe('group');      // still a group until they pick
    expect(out.soloPick).toBe(true);     // picker is open
  });

  it('says only one will remain and how many will be deleted', () => {
    const h = group3();
    h.setMode('solo');
    const msg = h.pickMessage();
    expect(msg).toMatch(/Only one practice can remain/i);
    expect(msg).toMatch(/2 will be deleted/i);
    expect(msg).toMatch(/click the practice you want to keep/i);
  });

  it('reads naturally when only one practice would be lost', () => {
    const h = harness({
      mode: 'group',
      saved: [{ practice_name: 'Erina' }, { practice_name: 'Gosford' }]
    });
    h.setMode('solo');
    expect(h.pickMessage()).toMatch(/The other one will be deleted/i);
    expect(h.pickMessage()).not.toMatch(/The other 1 will be deleted/i);
  });

  it('keeps the practice the user actually clicked, not just the first', () => {
    const h = group3();
    h.setMode('solo');
    h.keepOnly(1); // clicks "Gosford"

    const out = h.read();
    expect(out.saved).toHaveLength(1);
    expect(out.saved[0].practice_name).toBe('Gosford');
    expect(out.mode).toBe('solo');
    expect(out.soloPick).toBe(false);
  });

  it('keeps the LAST one when that is the one chosen', () => {
    const h = group3();
    h.setMode('solo');
    h.keepOnly(2);
    expect(h.read().saved[0].practice_name).toBe('Terrigal');
  });

  it('clears the kept practice\'s own-company fields, since it is no longer a group', () => {
    const h = group3();
    h.setMode('solo');
    h.keepOnly(1);
    const kept = h.read().saved[0];
    expect(kept.hasOwn).toBe(false);
    expect(kept.ownEntity).toBe('');
    expect(kept.ownAbn).toBe('');
  });

  it('cancelling leaves every practice untouched and stays a group', () => {
    const h = group3();
    h.setMode('solo');
    h.cancelSoloPick();
    const out = h.read();
    expect(out.saved).toHaveLength(3);
    expect(out.mode).toBe('group');
    expect(out.soloPick).toBe(false);
  });

  it('a group of one switches straight to single with no picker', () => {
    const h = harness({ mode: 'group', saved: [{ practice_name: 'Erina', hasOwn: true, ownEntity: 'E', ownAbn: '1' }] });
    h.setMode('solo');
    const out = h.read();
    expect(out.soloPick).toBe(false);
    expect(out.mode).toBe('solo');
    expect(out.saved).toHaveLength(1);
  });

  it('the card itself is the choice, and Edit/Remove are out of the way while picking', () => {
    const src = extractFn(html, 'renderList');
    expect(src).toMatch(/soloPick\s*\?/);
    expect(src).toMatch(/keep-only/);
    // Continue and Add are blocked mid-choice.
    expect(src).toMatch(/toSign[\s\S]{0,60}soloPick/);
    expect(src).toMatch(/addBtn[\s\S]{0,60}soloPick/);
  });
});
