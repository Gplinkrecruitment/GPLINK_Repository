'use strict';
/**
 * Australian GP build, fix bundle FR-6 (final review R6-01, R6-02, S6-01).
 *
 * THE NARROW RULE for the placement text the server builds and saves.
 *
 * What it is for. When a placement is recorded the server builds a placement
 * payload and saves it in the doctor's career state. Three of the entries it
 * builds were written for a doctor moving country:
 *     lifestyle.heading   "Relocation Explorer"
 *     lifestyle.intro     "Explore live homes and nearby schools around <practice> before you relocate."
 *     a tile's label      "Relocation package" / "Relocation Package"
 * and the careers page saves one more of its own:
 *     an application's "Next step" value   "Relocation handover"
 * For a doctor whose RECORDED pathway is Australian the server writes the
 * Australian wording instead, at the place the payload is built, and maps
 * rows written earlier when they are read.
 *
 * What it is NOT. FR-5 ran a general cleaner over the whole saved state, and
 * so cut sentences out of a doctor's own support messages, dropped keys,
 * emptied tokens and broke URLs. Nothing here looks at anything except the
 * four entries above, by their exact key AND their exact text. A value that
 * is not exactly what the server's own builder writes is left as it is: a
 * doctor's own words are never rewritten, whatever words they use.
 *
 * ONE SOURCE OF THE STRINGS. The Australian words below are the ones the
 * doctor's pages already show (js/au-localise.js maps the same overseas
 * phrases to the same words in the browser). The test "ONE source of the
 * strings" in tests/au-fr1-r09-s03-s04-commencement.test.js checks the two
 * against each other, so they cannot drift.
 *
 * Pure, no I/O.
 */

const HEADING = Object.freeze({ overseas: 'Relocation Explorer', au: 'Explore the area' });
const INTRO_OVERSEAS = /^Explore live homes and nearby schools around ([\s\S]+) before you relocate\.$/;
function introAu(practice) { return 'Explore live homes and nearby schools around ' + practice + ' before you start.'; }
function introOverseas(practice) { return 'Explore live homes and nearby schools around ' + practice + ' before you relocate.'; }
const PACKAGE_LABELS_OVERSEAS = Object.freeze(['Relocation package', 'Relocation Package']);
const PACKAGE_LABEL_AU = 'Moving allowance';
const NEXT_STEP = Object.freeze({ overseas: 'Relocation handover', au: 'Pre-start' });

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// A { label, value } tile whose label is exactly the builder's.
function isPackageTile(x) { return isObj(x) && typeof x.label === 'string' && PACKAGE_LABELS_OVERSEAS.indexOf(x.label) !== -1; }

/**
 * One placement payload (what resolveInAppPlacementForApplication returns).
 * mode 'au':   the three entries are given their Australian wording.
 * mode 'omit': the pathway could not be read: the three entries are left out
 *              (neither wording is written; the page shows its own defaults).
 * Returns the SAME object when nothing in it matches.
 */
function placementFor(placement, mode) {
  if (!isObj(placement)) return placement;
  const omit = mode === 'omit';
  let out = placement;
  const set = function (key, value) { if (out === placement) out = Object.assign({}, placement); out[key] = value; };

  // lifestyle.heading and lifestyle.intro
  if (isObj(placement.lifestyle)) {
    const l = placement.lifestyle;
    let nl = l;
    const lset = function (key, value) { if (nl === l) nl = Object.assign({}, l); if (value === undefined) delete nl[key]; else nl[key] = value; };
    if (l.heading === HEADING.overseas) lset('heading', omit ? undefined : HEADING.au);
    if (typeof l.intro === 'string') {
      const m = INTRO_OVERSEAS.exec(l.intro);
      if (m) lset('intro', omit ? undefined : introAu(m[1]));
    }
    if (nl !== l) set('lifestyle', nl);
  }
  // the "Relocation package" tile: in any list of { label, value } tiles the
  // builder puts directly on the payload or one level inside it
  const fixList = function (list) {
    if (!Array.isArray(list) || !list.some(isPackageTile)) return list;
    return omit ? list.filter(function (x) { return !isPackageTile(x); })
      : list.map(function (x) { return isPackageTile(x) ? Object.assign({}, x, { label: PACKAGE_LABEL_AU }) : x; });
  };
  Object.keys(placement).forEach(function (key) {
    const v = placement[key];
    if (Array.isArray(v)) { const nv = fixList(v); if (nv !== v) set(key, nv); return; }
    if (isObj(v) && key !== 'lifestyle') {
      let nv = v;
      Object.keys(v).forEach(function (k2) {
        if (!Array.isArray(v[k2])) return;
        const fixed = fixList(v[k2]);
        if (fixed !== v[k2]) { if (nv === v) nv = Object.assign({}, v); nv[k2] = fixed; }
      });
      if (nv !== v) set(key, nv);
    }
  });
  return out;
}

/**
 * The saved career state (gp_career_state): each application's `placement`,
 * and each application's "Next step" value the careers page saved. Accepts
 * the object or its JSON string and returns the same kind. Returns the SAME
 * value (same object, same string) when nothing in it matches.
 */
function careerStateFor(careerState, mode) {
  if (typeof careerState === 'string') {
    const t = careerState.trim();
    if (t.charAt(0) !== '{') return careerState;
    let parsed = null;
    try { parsed = JSON.parse(t); } catch (e) { return careerState; }
    const next = careerStateFor(parsed, mode);
    return next === parsed ? careerState : JSON.stringify(next);
  }
  if (!isObj(careerState) || !Array.isArray(careerState.applications)) return careerState;
  let changed = false;
  const apps = careerState.applications.map(function (app) {
    if (!isObj(app)) return app;
    let out = app;
    const p = placementFor(app.placement, mode);
    if (p !== app.placement) { out = Object.assign({}, out, { placement: p }); }
    // the careers page's own "Next step" line, saved in the preview meta
    if (Array.isArray(app.meta) && app.meta.some(function (m) { return isObj(m) && m.value === NEXT_STEP.overseas; })) {
      out = Object.assign({}, out, { meta: app.meta.map(function (m) { return isObj(m) && m.value === NEXT_STEP.overseas ? Object.assign({}, m, { value: NEXT_STEP.au }) : m; }) });
    }
    if (out !== app) changed = true;
    return out;
  });
  return changed ? Object.assign({}, careerState, { applications: apps }) : careerState;
}

/**
 * A whole saved-state document: ONLY its gp_career_state is looked at.
 * Returns the SAME object when nothing matches.
 */
function savedStateFor(state, mode) {
  if (!isObj(state) || !Object.prototype.hasOwnProperty.call(state, 'gp_career_state')) return state;
  const next = careerStateFor(state.gp_career_state, mode);
  return next === state.gp_career_state ? state : Object.assign({}, state, { gp_career_state: next });
}

/** Does this saved state hold any of the builder's overseas entries? A cheap test on text, used to avoid a read. */
function mentionsOverseasPlacementText(state) {
  if (!isObj(state)) return false;
  const cs = state.gp_career_state;
  const flat = typeof cs === 'string' ? cs : (cs ? JSON.stringify(cs) : '');
  return flat.indexOf('Relocation') !== -1 || flat.indexOf('before you relocate') !== -1;
}

module.exports = {
  HEADING, PACKAGE_LABELS_OVERSEAS, PACKAGE_LABEL_AU, NEXT_STEP, introAu, introOverseas,
  placementFor, careerStateFor, savedStateFor, mentionsOverseasPlacementText
};
