// Australian GP build, fix bundle FB-2a, W3-D1b.
//
// A browser that stayed open while the switch was off showed the other
// journey's Home ("Expedited Specialist Pathway", "Create your MyIntealth
// account") to an Australian doctor once the switch was back on. Why:
//
//   1. While the switch was off every page that asks "is this an Australian
//      doctor's device?" CLEARED the device hint (the switch-off answer was
//      treated as "this doctor is not Australian").
//   2. The service worker hands back its saved copy of Home, which is the
//      other journey's file. That file only steps aside when the hint is set.
//   3. The shell's one restart ("the device has just learned") was allowed
//      once per tab for ever, and that tab had already used it.
//
// Now: the hint follows only a DEFINITE answer about the signed-in doctor, and
// the shell restarts whenever it has just learned (it cannot loop: after the
// restart the hint is there).
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const auDoctor = require('../js/au-doctor.js');

function makeStore(initial, opts) {
  const data = Object.assign({}, initial || {});
  const o = opts || {};
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { if (o.readOnly) throw new Error('storage blocked'); if (!o.dropWrites) data[k] = String(v); },
    removeItem: (k) => { if (o.readOnly) throw new Error('storage blocked'); delete data[k]; }
  };
}

// auOnSession exactly as the shell has it, run against a fake browser.
function shellRig({ local, session, localOpts }) {
  const src = read('js/app-shell.js');
  const start = src.indexOf('  function auOnSession(session) {');
  const end = src.indexOf('\n  }\n', start);
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, end + 4);
  const out = { reloads: 0, applied: 0, scripts: 0 };
  const localStorage = makeStore(local, localOpts);
  const sessionStorage = makeStore(session);
  const windowObj = { localStorage, sessionStorage, location: { reload() { out.reloads += 1; } } };
  const documentObj = { createElement: () => ({}), head: { appendChild() { out.scripts += 1; } } };
  const fn = new Function('window', 'document', 'auApplyToShell', 'auHelper', 'AU_DOCTOR_SCRIPT', 'Date', body + '\nreturn auOnSession;');
  const auOnSession = fn(windowObj, documentObj, () => { out.applied += 1; }, () => ({}), '/js/au-doctor.js', Date);
  return { auOnSession, out, localStorage, sessionStorage };
}

const AU = { ok: true, authenticated: true, profile: { email: 'au.vr.test@gplink-test.local' }, auPathwayEnabled: true, auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true } };
const SWITCH_OFF = { ok: true, authenticated: true, profile: { email: 'au.vr.test@gplink-test.local' } };
const OVERSEAS_ON = { ok: true, authenticated: true, profile: { email: 'uk.test@gplink-test.local' }, auPathwayEnabled: true, auPathway: { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true } };

describe('the shell: the device hint across an off -> on flip', () => {
  it('switch OFF: the session carries no answer, so the hint stays where it was; nothing restarts', () => {
    const r = shellRig({ local: { gp_au_pathway_hint: '1', gp_au_pathway_hint_owner: 'au.vr.test@gplink-test.local' } });
    r.auOnSession(SWITCH_OFF);
    expect(r.localStorage.data.gp_au_pathway_hint).toBe('1');
    expect(r.out.reloads).toBe(0);
    expect(r.out.applied).toBe(1);
  });

  it('back ON with the hint kept: the doctor is known before anything paints; nothing restarts', () => {
    const r = shellRig({ local: { gp_au_pathway_hint: '1' }, session: { gp_au_shell_reloaded: '1' } });
    r.auOnSession(AU);
    expect(r.localStorage.data.gp_au_pathway_hint).toBe('1');
    expect(r.out.reloads).toBe(0);
  });

  it('THE REPORTED BUG: the hint is gone and this tab already used its one restart -> the shell still starts again', () => {
    // The old marker says "this tab has restarted once". It no longer blocks.
    const r = shellRig({ local: {}, session: { gp_au_shell_reloaded: '1' } });
    r.auOnSession(AU);
    expect(r.localStorage.data.gp_au_pathway_hint).toBe('1');
    expect(r.localStorage.data.gp_au_pathway_hint_owner).toBe('au.vr.test@gplink-test.local');
    expect(r.out.reloads).toBe(1);
    // After that restart the hint is there, so the next boot does not restart.
    const again = shellRig({ local: r.localStorage.data, session: r.sessionStorage.data });
    again.auOnSession(AU);
    expect(again.out.reloads).toBe(0);
  });

  it('it cannot loop: a restart less than ten seconds ago, or storage that will not keep the hint, means no restart', () => {
    const recent = shellRig({ local: {}, session: { gp_au_shell_reloaded_at: String(Date.now() - 2000) } });
    recent.auOnSession(AU);
    expect(recent.out.reloads).toBe(0);
    const dropped = shellRig({ local: {}, localOpts: { dropWrites: true } });
    dropped.auOnSession(AU);
    expect(dropped.out.reloads).toBe(0);
    const blocked = shellRig({ local: {}, localOpts: { readOnly: true } });
    blocked.auOnSession(AU);
    expect(blocked.out.reloads).toBe(0);
  });

  it('a definite "not Australian" (switch on) clears the hint, as before', () => {
    const r = shellRig({ local: { gp_au_pathway_hint: '1', gp_au_pathway_hint_owner: 'au.vr.test@gplink-test.local' } });
    r.auOnSession(OVERSEAS_ON);
    expect(r.localStorage.data.gp_au_pathway_hint).toBeUndefined();
    expect(r.localStorage.data.gp_au_pathway_hint_owner).toBeUndefined();
    expect(r.out.reloads).toBe(0);
  });

  it('switch OFF and a DIFFERENT account signs in on the device: the hint is not theirs, and goes', () => {
    const r = shellRig({ local: { gp_au_pathway_hint: '1', gp_au_pathway_hint_owner: 'au.vr.test@gplink-test.local' } });
    r.auOnSession({ ok: true, authenticated: true, profile: { email: 'uk.test@gplink-test.local' } });
    expect(r.localStorage.data.gp_au_pathway_hint).toBeUndefined();
  });

  it('signed out, or no answer: nothing is touched', () => {
    for (const s of [null, { ok: true, authenticated: false }]) {
      const r = shellRig({ local: { gp_au_pathway_hint: '1' } });
      r.auOnSession(s);
      expect(r.localStorage.data.gp_au_pathway_hint).toBe('1');
    }
  });

  it('OVERSEAS PARITY: an overseas doctor with no hint: nothing is written, nothing restarts (switch on and off)', () => {
    for (const s of [OVERSEAS_ON, { ok: true, authenticated: true, profile: { email: 'uk.test@gplink-test.local' } }]) {
      const r = shellRig({ local: {} });
      r.auOnSession(s);
      expect(r.localStorage.data).toEqual({});
      expect(r.sessionStorage.data).toEqual({});
      expect(r.out).toEqual({ reloads: 0, applied: 1, scripts: 0 });
    }
  });
});

describe('js/au-doctor.js refresh(): the same rule', () => {
  const answer = (payload) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
  it('a session from a server with the switch off does not wipe the hint', async () => {
    const stores = { local: makeStore({ gp_au_pathway_hint: '1' }), session: makeStore({}) };
    const res = await auDoctor.refresh({ fetch: answer(SWITCH_OFF), storages: stores });
    expect(res).toEqual({ ok: true, info: null });
    expect(stores.local.data.gp_au_pathway_hint).toBe('1');
  });
  it('a definite "not Australian" clears it; an Australian answer sets it', async () => {
    const stores = { local: makeStore({ gp_au_pathway_hint: '1' }), session: makeStore({}) };
    await auDoctor.refresh({ fetch: answer(OVERSEAS_ON), storages: stores });
    expect(stores.local.data.gp_au_pathway_hint).toBeUndefined();
    const full = Object.assign({}, AU, { auDoctor: { eligibilityVersion: 'abc', limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, onboardingComplete: true } });
    const res = await auDoctor.refresh({ fetch: answer(full), storages: stores });
    expect(res.info).toBeTruthy();
    expect(stores.local.data.gp_au_pathway_hint).toBe('1');
  });
});

describe('the pages that must step aside still do so on the hint', () => {
  it('Home and the provider-number page hide themselves and ask the server when the hint is set', () => {
    for (const p of ['pages/index.html', 'pages/pbs.html']) {
      const html = read(p);
      expect(html, p).toContain("localStorage.getItem('gp_au_pathway_hint')==='1'");
      expect(html, p).toContain('/js/au-page-handover.js');
    }
    // The handover shows the saved page untouched when the server says "not
    // Australian" or the switch is off, and asks again past the saved copy otherwise.
    const handover = read('js/au-page-handover.js');
    expect(handover).toContain('if (!isAu) { reveal(); return; }');
    expect(handover).toContain("window.location.pathname + '?au_page='");
  });
});
