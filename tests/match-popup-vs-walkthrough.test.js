// Owner report 2026-08-29 (Dr Deepika), three separate defects on one screen:
//
//  1. The AI-match popup showed once and never came back. It is one-time by
//     design (shown only while match_seen_at is null, stamped on render) — but
//     a staff "View as" session had SPENT it: her match was created 06:21 and
//     marked seen 06:25 by an impersonated session, so she could never receive
//     it. Previewing a doctor's dashboard must not consume something that is
//     theirs to see once.
//  2. The walkthrough's "Start here" pointer painted over that popup.
//  3. The pointer kept coming back after she had completed the walkthrough:
//     nextStepDone was only ever marked by clicking the nav item, so "Got it"
//     re-armed it on every boot — while she already held a live match, making
//     "Secure a position first" wrong guidance anyway.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('staff "View as" must not consume a one-time GP match popup', () => {
  const server = read('server.js');

  it('isImpersonatedSession reads the marker /api/admin/impersonate stamps', () => {
    const fn = server.slice(server.indexOf('function isImpersonatedSession'),
      server.indexOf('const TEMPORARY_BYPASS_LOCK_EMAILS'));
    expect(fn).toContain('_impersonatedBy');
    // the writer and the reader must agree on the property name
    expect(server).toContain('gpProfile._impersonatedBy = admin.email;');
  });

  it('/api/career/match/seen no-ops for an impersonated session', () => {
    const handler = server.slice(
      server.indexOf("pathname === '/api/career/match/seen'"),
      server.indexOf("pathname === '/api/career/match/dismiss-filled'")
    );
    expect(handler).toContain('isImpersonatedSession(msnSession)');
    // The bail must come BEFORE the write, or it does nothing.
    expect(handler.indexOf('isImpersonatedSession(msnSession)'))
      .toBeLessThan(handler.indexOf('match_seen_at: msnNowIso'));
    expect(handler).toContain('impersonated: true');
  });

  it('a real GP session still stamps match_seen_at', () => {
    const handler = server.slice(
      server.indexOf("pathname === '/api/career/match/seen'"),
      server.indexOf("pathname === '/api/career/match/dismiss-filled'")
    );
    expect(handler).toMatch(/if \(!msnRow\.match_seen_at\) \{/);
    expect(handler).toContain('body: { match_seen_at: msnNowIso }');
  });
});

describe('match-popup publishes its check for the walkthrough', () => {
  const js = read('js/match-popup.js');

  it('marks the check pending synchronously at init, before the fetch', () => {
    const fn = js.slice(js.indexOf('function init()'), js.length);
    expect(fn).toContain('publishMatchCheck({ pending: true })');
    expect(fn.indexOf('publishMatchCheck({ pending: true })')).toBeLessThan(fn.indexOf('fetchMatches()'));
  });

  it('reports hasLiveMatch even when there is nothing UNSEEN to show', () => {
    // The whole point: a match that was already seen still means this doctor
    // has one, so the "Start here" pointer must retire.
    const fn = js.slice(js.indexOf('function init()'), js.length);
    expect(fn).toContain('hasLiveMatch: live.length > 0');
    expect(fn).toContain('popupShown: false');
  });

  it('resolves the check and fires the event on the showing path too', () => {
    const fn = js.slice(js.indexOf('function init()'), js.length);
    expect(fn).toContain('pending: false, hasLiveMatch: true, popupShown: true');
    const pub = js.slice(js.indexOf('function publishMatchCheck'), js.indexOf('function init()'));
    expect(pub).toContain("gp-match-check-done");
    expect(pub).toMatch(/patch\.pending === false/);
  });

  it('loads before the walkthrough shell so the pending flag is up first', () => {
    const shell = read('pages/app-shell.html');
    expect(shell.indexOf('/js/match-popup.js')).toBeLessThan(shell.indexOf('/js/gp-walkthrough-shell.js'));
  });
});

describe('the walkthrough never paints over the match popup', () => {
  const js = read('js/gp-walkthrough-shell.js');
  const guarded = js.slice(js.indexOf('function guarded()'), js.indexOf('function hasLiveMatch'));

  it('guarded() blocks while the popup is open', () => {
    expect(guarded).toContain("classList.contains('gpmp-open')");
  });

  it('guarded() also blocks while the match check is still in flight', () => {
    // Without this the coach can win the race and be on screen before the
    // popup mounts — the overlap the owner screenshotted.
    expect(guarded).toContain('window.gpMatchCheck && window.gpMatchCheck.pending === true');
  });

  it('the popup class it watches is the one match-popup actually sets', () => {
    expect(read('js/match-popup.js')).toContain('classList.add("gpmp-open")');
  });
});

describe('the "Start here" pointer retires once the doctor has a match', () => {
  const js = read('js/gp-walkthrough-shell.js');

  it('hasLiveMatch fails closed — only a settled check retires the pointer', () => {
    const fn = js.slice(js.indexOf('function hasLiveMatch'), js.indexOf('function readState'));
    expect(fn).toContain('pending === false');
    expect(fn).toContain('hasLiveMatch === true');
  });

  it('marks nextStepDone and shows nothing when a match is already in hand', () => {
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf('function scheduleNextStepPointer'));
    expect(fn).toContain('if (hasLiveMatch()) {');
    expect(fn).toContain('markNextStepDone();');
    // must be decided BEFORE the placed/nav branches, since a match arrives
    // long before a placement is secured
    expect(fn.indexOf('hasLiveMatch()')).toBeLessThan(fn.indexOf('readCareerSecured()'));
    expect(fn.indexOf('hasLiveMatch()')).toBeLessThan(fn.indexOf("navEl('practice')"));
  });

  it('waits for the match check rather than racing it, with a timeout floor', () => {
    const fn = js.slice(js.indexOf('function scheduleNextStepPointer'), js.indexOf('function runTour'));
    expect(fn).toContain("window.addEventListener('gp-match-check-done', go)");
    expect(fn).toContain("window.removeEventListener('gp-match-check-done', go)");
    expect(fn).toContain('setTimeout(go, 4000)');
    // a hung request must not fire the pointer twice
    expect(fn).toContain('if (settled) return;');
  });
});

describe('the tour survives losing the boot race to the match check (owner report 2026-09-01)', () => {
  // A fresh sign-in hydrates /api/state from the auth pre-warm cache, so the
  // walkthrough's arming events routinely fire while /api/career/matches is
  // still in flight — and pending used to read as an ordinary guard that
  // silently dropped the tour for the visit. The FIRST login is exactly the
  // boot a new doctor is owed the tour on.
  const js = read('js/gp-walkthrough-shell.js');

  it('runTour waits out a pending match check instead of dropping the one shot', () => {
    const fn = js.slice(js.indexOf('function runTour'), js.indexOf('function tryAuto'));
    expect(fn).toContain('window.gpMatchCheck && window.gpMatchCheck.pending === true');
    expect(fn).toContain("window.addEventListener('gp-match-check-done', go)");
    expect(fn).toContain("window.removeEventListener('gp-match-check-done', go)");
    expect(fn).toContain('setTimeout(go, 4000)');
    // the wait must come BEFORE the guarded() bail, or pending still eats it
    expect(fn.indexOf('gpMatchCheck.pending')).toBeLessThan(fn.indexOf('if (guarded()) return;'));
    // a hung request must not loop the wait forever
    expect(fn).toContain('tourWaitedForMatch');
  });

  it('a settled check re-asks tryAuto — hydrate and home-load are once-only', () => {
    const tail = js.slice(js.indexOf('function tryAuto'), js.indexOf('window.gpWalkthroughShell'));
    expect(tail).toMatch(/addEventListener\('gp-match-check-done', function \(\) \{ tryAuto\(\); \}\)/);
  });
});

describe('cache busters for the two changed scripts', () => {
  const shell = read('pages/app-shell.html');
  it('app-shell.html pins the bumped match-popup + walkthrough-shell builds', () => {
    expect(shell).toContain('/js/match-popup.js?v=20260829a');
    expect(shell).toContain('/js/gp-walkthrough-shell.js?v=20260902a');
    expect(shell).not.toContain('/js/match-popup.js?v=20260729a');
    expect(shell).not.toContain('/js/gp-walkthrough-shell.js?v=20260829a');
  });
  it('sw.js VERSION moved, or the shell is served from the old precache', () => {
    expect(read('sw.js')).toContain('var VERSION = "20260902c"');
  });
});
