// FB-2b (walk-findings A2): a server redirect for a doctor on an Australian
// pathway keeps the app shell's embed parameters, so a frame the shell loaded
// (visible, or the hidden warm one) never lands on a bare address, which the
// server would wrap in a second shell. Every Australian redirect is covered;
// an overseas doctor, and everyone with the switch off, is sent exactly where
// they were before.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const requireCjs = createRequire(import.meta.url);
const { bootPlacementRig } = requireCjs('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = requireCjs('./helpers/au-fixtures.js');

let rig;
let t;
const placed = buildAuDoctor('au_vr', { credentials: { staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'consultant.test@gplink-test.local' } });
const unplaced = buildAuDoctor('au_vr', { idSuffix: '2', selfDeclared: true });
const overseas = buildAuDoctor('overseas_null');
const as = (d) => ({ cookie: rig.gpCookie(d.email, d.userId) });
const EMBED = 'gp_shell=embedded';
const WARM = 'gp_shell=embedded&gp_shell_static=1';

beforeAll(async () => {
  rig = await bootPlacementRig({ name: 'fb2b-redirects', doctors: [placed, unplaced, overseas] });
  rig.setSwitch(true);
  t = requireCjs('../server.js').__testUtils;
  expect((await rig.place(placed, 'ats_placement')).status).toBe(200);
  await rig.settle(120);
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });

describe('auRedirectKeepingShell (pure)', () => {
  const url = (q) => new URL('http://x/pages/whatever' + (q ? '?' + q : ''));
  it('carries the two shell parameters, and only those, to a page the shell can hold', () => {
    expect(t.auRedirectKeepingShell('/pages/prestart', url(EMBED))).toBe('/pages/prestart?gp_shell=embedded');
    expect(t.auRedirectKeepingShell('/pages/career', url(WARM))).toBe('/pages/career?gp_shell=embedded&gp_shell_static=1');
    expect(t.auRedirectKeepingShell('/pages/career', url('gp_shell_static=1'))).toBe('/pages/career?gp_shell_static=1');
    expect(t.auRedirectKeepingShell('/pages/index', url(EMBED + '&token=secret&next=/pages/x'))).toBe('/pages/index?gp_shell=embedded');
    // an existing query and a fragment both survive
    expect(t.auRedirectKeepingShell('/pages/career?locked=pbs', url(EMBED))).toBe('/pages/career?locked=pbs&gp_shell=embedded');
    expect(t.auRedirectKeepingShell('/pages/prestart#start-date', url(EMBED))).toBe('/pages/prestart?gp_shell=embedded#start-date');
  });
  it('changes nothing for a top-level request, a page outside the shell, or a value that is not the shell\'s own', () => {
    expect(t.auRedirectKeepingShell('/pages/prestart', url(''))).toBe('/pages/prestart');
    expect(t.auRedirectKeepingShell('/pages/onboarding', url(WARM))).toBe('/pages/onboarding');
    expect(t.auRedirectKeepingShell('/pages/signin', url(WARM))).toBe('/pages/signin');
    expect(t.auRedirectKeepingShell('/pages/prestart', url('gp_shell=other&gp_shell_static=0'))).toBe('/pages/prestart');
    expect(t.auRedirectKeepingShell('/pages/prestart', null)).toBe('/pages/prestart');
    // never doubled
    expect(t.auRedirectKeepingShell('/pages/prestart?gp_shell=embedded', url(EMBED))).toBe('/pages/prestart?gp_shell=embedded');
  });
});

describe('A2: every Australian page redirect, framed', () => {
  const cases = [
    // [who, address, where it leads]
    ['unplaced', '/pages/prestart', '/pages/career'],
    ['unplaced', '/pages/pbs', '/pages/career'],
    ['unplaced', '/pages/registration-intro', '/pages/career'],
    ['unplaced', '/pages/commencement', '/pages/career'],
    ['placed', '/pages/registration-intro', '/pages/prestart'],
    ['placed', '/pages/commencement', '/pages/prestart'],
    ['placed', '/pages/index-au', '/pages/index'],
    ['placed', '/pages/pbs-au', '/pages/pbs'],
    ['placed', '/pages/myinthealth', '/pages/index'],
    ['placed', '/pages/amc', '/pages/index'],
    ['placed', '/pages/ahpra', '/pages/index'],
    ['placed', '/pages/visa', '/pages/index'],
    ['placed', '/pages/visa-transfer-au', '/pages/visa']
  ];
  it('a framed request is redirected to a framed address (visible frame and hidden warm frame)', async () => {
    const who = { placed, unplaced };
    for (const [w, from, to] of cases) {
      for (const q of [EMBED, WARM]) {
        const r = await rig.get(from + '?' + q, as(who[w]));
        expect([w, from, r.status, r.headers.location]).toEqual([w, from, 302, to + '?' + q]);
      }
      const plain = await rig.get(from, as(who[w]));
      expect([w, from, plain.status, plain.headers.location]).toEqual([w, from, 302, to]);
    }
  });

  it('following the redirect inside a frame never serves the app shell (no shell inside the shell)', async () => {
    const first = await rig.get('/pages/prestart?' + WARM, as(unplaced));
    const second = await rig.get(first.headers.location, as(unplaced));
    expect(second.status).toBe(200);
    expect(second.raw).not.toContain('app-shell-frame');
    // and the old behaviour, for the record: the bare address IS the shell
    expect((await rig.get('/pages/career', as(unplaced))).raw).toContain('app-shell-frame');
  });

  it('no Australian page redirect in server.js is written without the helper', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('// WP-12 (APP-09, APP-11, APP-13, APP-15): Home, the provider-number step,');
    // The block ends where the overseas stage gate begins (untouched, on purpose).
    const end = src.indexOf('// Server-side stage access gate', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const redirects = block.match(/Location:[^}\n]+/g) || [];
    expect(redirects.length).toBe(4);
    redirects.forEach((line) => expect(line, line).toContain('auRedirectKeepingShell('));
  });
});

describe('OVERSEAS PARITY: nobody else\'s redirect moved', () => {
  const addresses = ['/pages/prestart', '/pages/index-au', '/pages/pbs-au', '/pages/visa-transfer-au', '/pages/pbs', '/pages/registration-intro'];
  const capture = async (d) => {
    const out = {};
    for (const a of addresses) for (const q of ['', '?' + EMBED, '?' + WARM]) {
      const r = await rig.get(a + q, as(d));
      out[a + q] = [r.status, r.headers.location || null];
    }
    return out;
  };
  it('an overseas doctor with the switch on, and everyone with it off, gets the same Location as before: no shell parameter added', async () => {
    const on = await capture(overseas);
    rig.setSwitch(false);
    let off; let offAu;
    try { off = await capture(overseas); offAu = await capture(placed); } finally { rig.setSwitch(true); }
    // The switch-off answers are what main gives. With the switch on an
    // overseas doctor gets the same, except the one address that is itself an
    // Australian file (/pages/visa-transfer-au), where the parameters are kept
    // for everyone while the switch is on.
    for (const key of Object.keys(off)) {
      if (off[key][1]) expect(off[key][1], key).not.toMatch(/gp_shell/);
      if (offAu[key][1]) expect(offAu[key][1], key).not.toMatch(/gp_shell/);
      if (key.indexOf('/pages/visa-transfer-au') !== 0) {
        if (on[key][1]) expect(on[key][1], key).not.toMatch(/gp_shell/);
        expect(on[key], key).toEqual(off[key]);
      }
    }
    expect(off['/pages/prestart?' + WARM]).toEqual([302, '/pages/index']);
    expect(on['/pages/prestart?' + WARM]).toEqual([302, '/pages/index']);
  });
});
