// Australian GP build, WP-07: GPAuPathway (js/au-pathway.js) remembers the
// last answer on the device, as a hint only. pages/my-documents.html uses the
// hint to paint nothing until the server has said who is signed in, so a
// doctor on an Australian pathway is never shown the checklist for doctors
// moving to Australia while an old saved copy of that page is replaced.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperSrc = fs.readFileSync(path.join(ROOT, 'js/au-pathway.js'), 'utf8');

function load(routes, store) {
  const storage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = {
    localStorage: storage,
    fetch: (url) => {
      const r = routes[url];
      if (r === undefined || r === 'throw') return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: r.status ? r.status < 400 : true, json: () => Promise.resolve(r.body || r) });
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(helperSrc, sandbox, { filename: 'au-pathway.js' });
  return sandbox.GPAuPathway;
}
const ON = { '/api/public/features': { auPathwayEnabled: true } };
const session = (pathway) => ({ auPathwayEnabled: true, auPathway: { pathway, launched: pathway === 'au_vr' } });

describe('GPAuPathway remembers the last answer on the device (a hint, never a decision)', () => {
  it('an Australian doctor: the hint is set', async () => {
    const store = {};
    const au = load(Object.assign({ '/api/auth/session': session('au_vr') }, ON), store);
    expect(au.hinted()).toBe(false);
    await au.init();
    expect(store.gp_au_pathway_hint).toBe('1');
    expect(au.hinted()).toBe(true);
  });

  it('every Australian pathway sets it, launched or not', async () => {
    for (const p of ['au_restricted', 'au_non_vr', 'au_registrar']) {
      const store = {};
      await load(Object.assign({ '/api/auth/session': session(p) }, ON), store).init();
      expect(store.gp_au_pathway_hint, p).toBe('1');
    }
  });

  it('an overseas doctor signing in on the same device clears it', async () => {
    const store = { gp_au_pathway_hint: '1' };
    const au = load(Object.assign({ '/api/auth/session': session('overseas_esp') }, ON), store);
    expect(au.hinted()).toBe(true);
    await au.init();
    expect(store.gp_au_pathway_hint).toBeUndefined();
    expect(au.mine().isAu).toBe(false);
  });

  it('the switch being off clears it', async () => {
    const store = { gp_au_pathway_hint: '1' };
    await load({ '/api/public/features': { auPathwayEnabled: false } }, store).init();
    expect(store.gp_au_pathway_hint).toBeUndefined();
  });

  it('no answer at all (offline) leaves it alone, and the doctor still reads as an overseas doctor', async () => {
    const store = { gp_au_pathway_hint: '1' };
    const au = load({ '/api/public/features': 'throw' }, store);
    await au.init();
    expect(store.gp_au_pathway_hint).toBe('1');
    expect(au.enabled()).toBe(false);
    expect(au.mine().isAu).toBe(false); // the hint never makes a doctor Australian
  });

  it('signed out (no session answer) leaves it alone', async () => {
    const store = { gp_au_pathway_hint: '1' };
    const au = load(Object.assign({ '/api/auth/session': { status: 401, body: { ok: false } } }, ON), store);
    await au.init();
    expect(store.gp_au_pathway_hint).toBe('1');
    expect(au.mine().isAu).toBe(false);
  });

  it('blocked storage changes nothing', async () => {
    const sandbox = {
      get localStorage() { throw new Error('blocked'); },
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ auPathwayEnabled: false }) })
    };
    sandbox.window = sandbox;
    vm.runInNewContext(helperSrc, sandbox, { filename: 'au-pathway.js' });
    expect(sandbox.GPAuPathway.hinted()).toBe(false);
    await sandbox.GPAuPathway.init();
    expect(sandbox.GPAuPathway.enabled()).toBe(false);
  });

  it('the helper file says which tag loads it (kept in step with the pages)', () => {
    expect(helperSrc).toContain('<script src="/js/au-pathway.js?v=20261120b"></script>');
  });
});
