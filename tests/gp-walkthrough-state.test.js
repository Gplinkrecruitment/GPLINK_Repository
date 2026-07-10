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
