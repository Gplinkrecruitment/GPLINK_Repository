// Australian GP build, fix bundle FB-2a, W3-D2.
//
// A placed Australian doctor's Careers never went quiet: about 100
// `PUT /api/state` and 200 other requests every 10 seconds. The cycle:
//
//   renderPage() of a placed doctor calls replaceCareerUrlState("secured")
//   -> history.replaceState (same address as before)
//   -> js/nav-shell-bridge.js reports every replaceState to the shell
//   -> js/app-shell.js answers a route report by warming the NEXT page in its
//      hidden frame (and, with one hidden frame, swaps it each time)
//   -> that page's state hydrate (js/state-sync.js) clears and rewrites every
//      tracked localStorage key
//   -> the `storage` event re-renders Careers -> back to the top.
//
// The root is the first step: a render that changes nothing announced a
// navigation. For a doctor on an Australian pathway an unchanged address is
// no longer written. An overseas doctor's call is made exactly as before
// (the same loop exists for a placed overseas doctor on main: reported to the
// owner, not changed here).
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const career = read('pages/career.html');

function extract(name) {
  const start = career.indexOf('    function ' + name + '(');
  expect(start, name).toBeGreaterThan(-1);
  const end = career.indexOf('\n    }\n', start);
  return career.slice(start, end + 6);
}

// The two functions as the page has them, run against a fake browser.
function rig({ auDoctor, locked, href }) {
  const calls = [];
  const loc = new URL(href);
  const history = { replaceState(state, title, url) { calls.push(url); const next = new URL(url, loc.origin); loc.pathname = next.pathname; loc.search = next.search; loc.hash = next.hash; } };
  const windowObj = { location: loc };
  const fn = new Function('window', 'history', 'URL', 'auDoctorInfo', 'shouldLockCareerToSecuredView',
    extract('replaceCareerUrlState') + '\n' + extract('careerAuUrlAlreadyCurrent') + '\nreturn replaceCareerUrlState;');
  const replaceCareerUrlState = fn(windowObj, history, URL, auDoctor ? { pathway: 'au_vr' } : null, () => locked);
  return { replaceCareerUrlState, calls, loc };
}
const SECURED = 'http://localhost:3000/pages/career?gp_shell=embedded&gp_shell_static=1#secured';

describe('W3-D2: a placed doctor\'s Careers settles', () => {
  it('AUSTRALIAN, placed, address already "#secured": rendering again writes nothing, however often', () => {
    const r = rig({ auDoctor: true, locked: true, href: SECURED });
    for (let i = 0; i < 50; i++) r.replaceCareerUrlState('secured', null);
    expect(r.calls).toEqual([]);
  });

  it('AUSTRALIAN: a real change of address is still written, once', () => {
    const r = rig({ auDoctor: true, locked: true, href: 'http://localhost:3000/pages/career?gp_shell=embedded&gp_shell_static=1' });
    r.replaceCareerUrlState('secured', null);
    r.replaceCareerUrlState('secured', null);
    r.replaceCareerUrlState('secured', null);
    expect(r.calls).toEqual(['/pages/career?gp_shell=embedded&gp_shell_static=1#secured']);
    // An unplaced doctor moving between tabs: each real change, nothing else.
    const u = rig({ auDoctor: true, locked: false, href: 'http://localhost:3000/pages/career#browse' });
    u.replaceCareerUrlState('browse', null);
    u.replaceCareerUrlState('applications', null);
    u.replaceCareerUrlState('applications', null);
    u.replaceCareerUrlState('browse', 'internal_ats:x');
    expect(u.calls).toEqual(['/pages/career#applications', '/pages/career?role=internal_ats%3Ax#browse']);
  });

  it('a placed doctor is never moved off the secured view by a stale role or view request', () => {
    const r = rig({ auDoctor: true, locked: true, href: 'http://localhost:3000/pages/career?role=abc#browse' });
    r.replaceCareerUrlState('browse', 'abc');
    expect(r.calls).toEqual(['/pages/career#secured']);
  });

  it('OVERSEAS PARITY: with no Australian doctor on the page every call is made exactly as before', () => {
    const r = rig({ auDoctor: false, locked: true, href: SECURED });
    for (let i = 0; i < 3; i++) r.replaceCareerUrlState('secured', null);
    expect(r.calls).toEqual(Array(3).fill('/pages/career?gp_shell=embedded&gp_shell_static=1#secured'));
  });

  it('the guard cannot throw before the page has learned who the doctor is', () => {
    const fn = new Function(extract('careerAuUrlAlreadyCurrent') + '\nreturn careerAuUrlAlreadyCurrent;')();
    // `auDoctorInfo` is declared with `let` further down the page: reading it
    // early throws, and the guard must then answer "no" (today's call).
    expect(fn('/pages/career#secured', { pathname: '/pages/career', search: '', hash: '#secured' })).toBe(false);
  });
});

describe('the cycle this breaks (each link still as described)', () => {
  it('a placed doctor\'s render asks for the secured address every time', () => {
    const body = extract('renderPage');
    expect(body).toMatch(/if \(isLockedToSecured\) \{\s*replaceCareerUrlState\("secured", null\);/);
    // The storage listener re-renders on a change to the saved careers state.
    expect(career).toMatch(/window\.addEventListener\("storage", \(event\) => \{\s*if \(event\.key === CAREER_STATE_KEY\)/);
  });
  it('the bridge reports every replaceState and the shell warms a page for every report', () => {
    const bridge = read('js/nav-shell-bridge.js');
    expect(bridge).toMatch(/history\.replaceState = function patchedReplaceState\(state, title, url\) \{[\s\S]{0,120}notifyParent\(\);/);
    const shell = read('js/app-shell.js');
    expect(shell).toMatch(/setLoading\(false\);\s*updateFrameOffsets\(\);\s*scheduleRouteWarmup\(route\);\s*\}\s*function handlePopState/);
    // And a hydrate clears then rewrites every tracked key (the storage events).
    expect(read('js/state-sync.js')).toMatch(/var shouldPushMergedState = trackedStateDiffers\(mergedState, serverState\);\s*clearTrackedLocalState\(\);/);
  });
  it('the only history.replaceState on Careers that names the view goes through the guard', () => {
    const body = extract('replaceCareerUrlState');
    expect(body).toMatch(/if \(careerAuUrlAlreadyCurrent\(nextHref, window\.location\)\) return;\s*history\.replaceState\(null, "", nextHref\);/);
  });
});
