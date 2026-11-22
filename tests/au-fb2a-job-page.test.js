// Australian GP build, fix bundle FB-2a, W3-D10.
//
// Staff verify a doctor; the doctor follows a link straight to a job page
// (before visiting Careers) and is told "Role not found ... you don't currently
// qualify". Why: the job page paints from the saved role LIST while the role is
// fetched, and only Careers threw that list away when the doctor's eligibility
// version changed. The list's old entry for the role was a locked placeholder
// (`blurred`), and its flag then survived the merge with the real role.
//
// Now, for a doctor on an Australian pathway, the job page asks the server and
// applies the eligibility-version check itself before any saved copy is read,
// and a locked placeholder never outlives the real role.
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const job = read('pages/job.html');
const auDoctorSrc = read('js/au-doctor.js');

function extract(name, prefix) {
  const start = job.indexOf('  ' + (prefix || '') + 'function ' + name + '(');
  expect(start, name).toBeGreaterThan(-1);
  const end = job.indexOf('\n  }\n', start);
  return job.slice(start, end + 4);
}

function makeStore(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    get length() { return Object.keys(data).length; },
    key: (i) => Object.keys(data)[i] || null,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}
const ROLE = 'internal_ats:role_x';
const auSession = (version) => ({
  ok: true, authenticated: true, profile: { email: 'au.vr.test@gplink-test.local' }, auPathwayEnabled: true,
  auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true },
  auDoctor: { eligibilityVersion: version, limits: { active: 4, monthly: 6, interviewsMonthly: 6 }, onboardingComplete: true }
});
const savedList = (roles) => JSON.stringify({ fetchedAt: new Date().toISOString(), roles });

// The job page's own functions, with the real js/au-doctor.js, in a fake browser.
function page({ au, storedVersion, sessionVersion, list, sessionFails, liveRoles }) {
  const calls = [];
  const local = makeStore(Object.assign({}, list ? { gp_career_roles_cache: savedList(list) } : {}, storedVersion ? { gp_au_eligibility_version: storedVersion } : {}, au ? { gp_au_pathway_hint: '1' } : {}));
  const session = makeStore(au ? { 'gpc:/api/auth/session': JSON.stringify({ data: auSession(storedVersion || 'v0'), ts: Date.now() }) } : {});
  const fetchFn = (url) => {
    calls.push(String(url));
    if (String(url).indexOf('/api/auth/session') === 0) {
      if (sessionFails) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(auSession(sessionVersion)) });
    }
    if (String(url).indexOf('/api/career/roles') === 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, roles: liveRoles || [] }) });
    return Promise.reject(new Error('unexpected ' + url));
  };
  const sandbox = { localStorage: local, sessionStorage: session, fetch: fetchFn, console, Date, JSON, Promise, Error };
  sandbox.window = sandbox;
  if (au) vm.runInNewContext(auDoctorSrc, sandbox, { filename: 'au-doctor.js' });
  const src = [
    'const ROLE_LIST_CACHE_KEY = "gp_career_roles_cache"; const ROLE_CACHE_TTL_MS = 10 * 60 * 1000;',
    extract('readCachedRoles'), extract('writeCachedRoles'), extract('auDoctorOnPage'),
    'let auSavedListUntrusted = false;', extract('auJobEligibilityCheck', 'async '), extract('auDropStaleLock'), extract('loadRolePreview', 'async '),
    'this.__job = { auJobEligibilityCheck, auDropStaleLock, loadRolePreview, readCachedRoles, untrusted: () => auSavedListUntrusted };'
  ].join('\n');
  vm.runInNewContext(src, sandbox, { filename: 'job-page-extract.js' });
  return { fn: sandbox.__job, calls, local };
}
const LOCKED = { id: ROLE, blurred: true, practiceName: 'Confidential practice' };
const OPEN = { id: ROLE, practiceName: 'Test Metro Practice (FAKE)', title: 'General Practitioner' };

describe('W3-D10: the job page applies the eligibility-version check itself', () => {
  it('THE REPORTED CASE: verified since the list was saved -> the saved list is thrown away and the role is read fresh', async () => {
    const p = page({ au: true, storedVersion: 'v1', sessionVersion: 'v2', list: [LOCKED], liveRoles: [OPEN] });
    // Before the check the page would have painted the locked placeholder.
    expect(p.fn.readCachedRoles().map((r) => r.blurred)).toEqual([true]);
    expect(await p.fn.auJobEligibilityCheck()).toEqual({ checked: true, changed: true });
    expect(p.local.data.gp_au_eligibility_version).toBe('v2');
    expect(p.fn.readCachedRoles()).toEqual([]);
    const preview = await p.fn.loadRolePreview(ROLE);
    expect(preview).toMatchObject({ id: ROLE, practiceName: 'Test Metro Practice (FAKE)' });
    expect(preview.blurred).toBeUndefined();
    // The server was asked directly: the session, then the role list.
    expect(p.calls).toEqual(['/api/auth/session', '/api/career/roles']);
  });

  it('nothing changed: the saved list is kept and used (no second request)', async () => {
    const p = page({ au: true, storedVersion: 'v2', sessionVersion: 'v2', list: [OPEN] });
    expect(await p.fn.auJobEligibilityCheck()).toEqual({ checked: true, changed: false });
    expect(await p.fn.loadRolePreview(ROLE)).toMatchObject({ id: ROLE });
    expect(p.calls).toEqual(['/api/auth/session']);
  });

  it('the server cannot be asked: the saved list is not trusted, the role list is read from the network', async () => {
    const p = page({ au: true, storedVersion: 'v1', sessionFails: true, list: [LOCKED], liveRoles: [OPEN] });
    expect(await p.fn.auJobEligibilityCheck()).toEqual({ checked: false });
    expect(p.fn.untrusted()).toBe(true);
    expect((await p.fn.loadRolePreview(ROLE)).blurred).toBeUndefined();
  });

  it('a locked placeholder never outlives the real role', () => {
    const p = page({ au: true, storedVersion: 'v2', sessionVersion: 'v2' });
    expect(p.fn.auDropStaleLock(LOCKED, OPEN)).toBeNull();
    expect(p.fn.auDropStaleLock(OPEN, OPEN)).toBe(OPEN);
    expect(p.fn.auDropStaleLock(LOCKED, LOCKED)).toBe(LOCKED); // the server itself says locked
    expect(p.fn.auDropStaleLock(LOCKED, null)).toBe(LOCKED);
  });

  it('OVERSEAS PARITY: with no Australian doctor on the page nothing is asked and the saved list is used exactly as before', async () => {
    const p = page({ au: false, list: [LOCKED] });
    expect(await p.fn.auJobEligibilityCheck()).toEqual({ checked: false });
    expect(p.fn.untrusted()).toBe(false);
    expect(await p.fn.loadRolePreview(ROLE)).toMatchObject({ id: ROLE, blurred: true });
    expect(p.fn.auDropStaleLock(LOCKED, OPEN)).toBe(LOCKED);
    expect(p.calls).toEqual([]);
  });

  it('the page runs the check before it reads any saved copy, and only for an Australian doctor', () => {
    const init = extract('init', 'async ');
    const check = init.indexOf('if (auDoctorOnPage()) await auJobEligibilityCheck();');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(init.indexOf('let previewRole = readPreviewRole(roleId);'));
    expect(check).toBeLessThan(init.indexOf('loadRolePreview(roleId)'));
    expect(check).toBeLessThan(init.indexOf('loadRoleDetail(roleId, 25000)'));
    expect(init).toMatch(/if \(enrichedRole && previewRole && auDropStaleLock\(previewRole, enrichedRole\) === null\) \{\s*previewRole = null;/);
  });
});
