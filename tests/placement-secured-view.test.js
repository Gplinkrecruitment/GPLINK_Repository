// Owner 2026-09-10: "so the offer was accepted. Now we need to change the
// gps view to the registration pathway". The server secured the placement on
// signing, but the browser kept its cached copies (gp-cache payload, saved
// career state, the phase derived from it) — nav stayed My Practice + Account
// and the card said "finalising" until the caches expired.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const P = require(path.join(process.cwd(), 'js', 'placement-secured.js'));
import vm from 'node:vm';
// journey-stages.js only publishes window.GPJourneyStages — run it against a bare window.
const J = (() => { const w = {}; vm.runInNewContext(read('js/journey-stages.js'), { window: w, document: undefined, localStorage: undefined }); return w.GPJourneyStages; })();
const D = require(path.join(process.cwd(), 'js', 'gp-doctor-phase.js'));

function fakeStorage(init) {
  const m = Object.assign({}, init || {});
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m };
}

describe('placement secured — pure rule', () => {
  it('marks the application and the whole saved copy secured, so the phase module reads "registration"', () => {
    const saved = { applications: [{ id: 'a1', rawStatus: 'hired', status: 'Offer accepted', practiceName: 'Sandbox Coastal Medical Centre' }, { id: 'a2', rawStatus: 'applied' }], activeView: 'applications' };
    const { state, applicationFound } = P.markSecured(JSON.stringify(saved), 'a1', {}, '2026-09-10T00:00:00Z');
    expect(applicationFound).toBe(true);
    const a1 = state.applications.find((a) => a.id === 'a1');
    expect(a1.isPlacementSecured).toBe(true);
    expect(a1.rawStatus).toBe('placement_secured');
    expect(a1.statusLabel).toBe('Practice secured');
    expect(a1.contractStage).toBe('signed');
    expect(state.applications.find((a) => a.id === 'a2').rawStatus).toBe('applied');
    expect(state.career_secured).toBe(true);
    expect(state.activeView).toBe('secured');
    expect(state.updatedAt).toBe('2026-09-10T00:00:00Z');
    // the same helpers the shell uses now say: secured → registration phase
    expect(J.hasCareerSecured(state)).toBe(true);
    const store = fakeStorage({ gp_career_state: JSON.stringify(state), gp_onboarding_complete: 'true' });
    expect(D.derivePhaseFromStorage(store, J.hasCareerSecured)).toBe('registration');
  });

  it('survives an empty or broken saved copy (still marks career_secured)', () => {
    expect(P.markSecured(null, 'a1', {}).state.career_secured).toBe(true);
    expect(P.markSecured('{not json', 'a1', {}).state.career_secured).toBe(true);
    expect(P.markSecured('{}', 'a1', {}).applicationFound).toBe(false);
  });
});

describe('placement secured — side effects', () => {
  it('writes the saved copy, drops every cached payload in the frame and the shell, flags the list dirty, tells the shell and the other frames', () => {
    const calls = { prefix: [], invalidate: [], posted: [] };
    const store = fakeStorage({ gp_career_state: JSON.stringify({ applications: [{ id: 'a1', rawStatus: 'hired' }] }) });
    const session = fakeStorage();
    const otherFrame = { contentWindow: { postMessage: (m) => calls.posted.push('frame:' + m.type) } };
    const parent = {
      gpCache: { invalidatePrefix: (p) => calls.prefix.push('parent:' + p), invalidate: (u) => calls.invalidate.push(u) },
      postMessage: (m) => calls.posted.push('parent:' + m.type),
      document: { querySelectorAll: () => [otherFrame, { contentWindow: null }] }
    };
    const win = {
      localStorage: store, sessionStorage: session,
      gpCache: { invalidatePrefix: (p) => calls.prefix.push('self:' + p), invalidate: (u) => calls.invalidate.push(u) },
      location: { origin: 'http://localhost:3000' },
      dispatchEvent: () => true
    };
    win.parent = parent;
    const out = P.applyPlacementSecured(win, 'a1', { practiceName: 'Sandbox Coastal Medical Centre' });
    expect(out).toEqual({ applicationId: 'a1', savedCopy: true, applicationFound: true, cacheCleared: true, frames: 1 });
    expect(JSON.parse(store._m.gp_career_state).career_secured).toBe(true);
    expect(session._m.gp_career_apps_dirty).toBe('1');
    expect(calls.prefix).toEqual(['self:/api/career/', 'parent:/api/career/']);
    expect(calls.invalidate.flat()).toEqual(expect.arrayContaining(['/api/state', '/api/career/applications']));
    expect(calls.posted).toEqual(['parent:gp-placement-secured', 'frame:gp-placement-secured']);
  });

  it('a bare window is not an error', () => {
    expect(() => P.applyPlacementSecured({}, 'a1', null)).not.toThrow();
  });
});

describe('wiring', () => {
  it('the signing page applies it on every "secured" moment and offers "Start my registration"', () => {
    const page = read('pages/offer-review.html');
    expect(page).toContain('<script src="/js/placement-secured.js?v=20260910a" defer></script>');
    expect(page.split('window.gpPlacementSecured.applyPlacementSecured(window, contractAppId').length - 1).toBe(3);
    expect(page).toContain('id="contractSecuredCta" href="/pages/myinthealth"');
    expect(page).toContain('Start my registration →');
    expect(page).toContain("window.parent.gpShellNavigate(target, { replace: false })");
  });
  it('the shell refreshes the phase on the message, the career page re-reads the server', () => {
    expect(read('js/app-shell.js')).toContain('if (!d || d.type !== "gp-placement-secured") return;');
    expect(read('js/app-shell.js')).toContain('refreshPhase("placement");');
    const career = read('pages/career.html');
    expect(career).toContain('if (data && data.type === "gp-placement-secured") {');
  });
  it('the module is precached and the busters moved together', () => {
    const sw = read('sw.js');
    expect(sw).toContain('"/js/placement-secured.js?v=20260910a"');
    expect(sw).toContain('var VERSION = "20260918b"');
    expect(read('pages/app-shell.html')).toContain('/js/app-shell.js?v=20260910a');
    expect(sw).toContain('/js/app-shell.js?v=20260910a');
  });
});
