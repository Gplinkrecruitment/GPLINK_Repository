// Australian GP build, WP-30: with the Australian switch OFF, or with no
// look-up provider configured, every route WP-30 touched answers and stores
// exactly what it did before WP-30.
//
// tests/fixtures/au-wp30-before.snapshot.json was recorded by
// tests/helpers/au-wp30-parity.js on the tree BEFORE WP-30 (au-gp-testing
// 34692cbe), once with the switch off and once with it on. Never regenerate
// it to make this pass. (Switch off against `main` itself for the practice
// front door is tests/au-wp23-switch-off-parity.test.js, which still runs.)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const wp23 = require('./helpers/au-wp23-parity.js');
const wp30 = require('./helpers/au-wp30-parity.js');
const siteAuPages = require('../lib/site-au-pages.js');

const ROOT = path.join(__dirname, '..');
const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'au-wp30-before.snapshot.json'), 'utf8'));
const WP23_MAIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'au-wp23-switch-off.snapshot.json'), 'utf8'));
const setProvider = (v) => { if (v == null) delete process.env.AU_WORKFORCE_LOCATOR_PROVIDER; else process.env.AU_WORKFORCE_LOCATOR_PROVIDER = v; };

let h;
beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp30-parity', mode: 'supabase', tables: wp23.parityTables(), emulator: wp23.PARITY_EMULATOR, env: wp23.PARITY_ENV });
});
afterAll(async () => { setProvider(null); if (h) await h.closeAll(); });
beforeEach(() => { wp30.clearTables(h); });

describe('WP-30 changes nothing unless the switch is on AND a provider is configured', () => {
  it('the snapshot really is a full walk', () => {
    for (const state of ['off', 'on']) {
      const s = BEFORE[state];
      expect(s.front.sign.status).toBe(200);
      expect(s.front.approve.status).toBe(200);
      expect(s.staffJob.patchDpa.status).toBe(200);
      expect(s.staffAddJob.status).toBe(200);
      expect(Object.values(s.newAddresses).map((p) => p.status)).toEqual([404, 404, 404, 404, 404]);
    }
  });

  for (const provider of ['fixture', 'health_gov', null]) {
    it('switch OFF, provider ' + JSON.stringify(provider) + ': word for word what it was', async () => {
      h.setSwitch(false); setProvider(provider);
      const got = await wp30.computeAreaParity(h);
      expect(got).toEqual(BEFORE.off);
      // nothing was pinned and nothing was logged
      expect(h.emu.table('practices').every((p) => !(p.metadata && p.metadata.au_area))).toBe(true);
      expect(h.emu.table('career_roles').every((r) => !(r.source_payload && r.source_payload.au_area))).toBe(true);
      expect(h.emu.table('admin_audit_log').filter((r) => /au_.*area/.test(r.action))).toEqual([]);
    }, 60000);
  }

  it('switch OFF with a provider set: the practice front door is still exactly main\'s (the WP-23 snapshot)', async () => {
    h.setSwitch(false); setProvider('fixture');
    const got = await wp23.computePracticeParity(h);
    expect(got).toEqual(WP23_MAIN);
  }, 60000);

  for (const provider of [null, 'none', 'rubbish']) {
    it('switch ON, provider ' + JSON.stringify(provider) + ' (off): what it was before WP-30, apart from the bytes of the intake page', async () => {
      h.setSwitch(true); setProvider(provider);
      const got = await wp30.computeAreaParity(h);
      const want = JSON.parse(JSON.stringify(BEFORE.on));
      // The intake page's Australian block gained WP-30's (inert) code, so its
      // bytes differ with the switch on. What it does is tested in
      // tests/au-wp30-pages.test.js.
      expect(got.intakePageFile.status).toBe(200);
      delete got.intakePageFile; delete want.intakePageFile;
      expect(got).toEqual(want);
      expect(h.emu.table('practices').every((p) => !(p.metadata && p.metadata.au_area))).toBe(true);
      expect(h.emu.table('career_roles').every((r) => !(r.source_payload && r.source_payload.au_area))).toBe(true);
    }, 60000);
  }
});

describe('the pages', () => {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  it('the intake page with the switch off is byte for byte the page recorded before WP-30', () => {
    const page = fs.readFileSync(path.join(ROOT, 'pages/practice-intake.html'), 'utf8');
    const rendered = siteAuPages.renderSource(page, { on: false });
    expect(rendered.ok).toBe(true);
    const off = rendered.html;
    expect({ sha256: sha(Buffer.from(off, 'utf8')), bytes: Buffer.byteLength(off, 'utf8') }).toEqual({ sha256: BEFORE.off.intakePageFile.sha256, bytes: BEFORE.off.intakePageFile.bytes });
    expect(off).not.toContain('WP-30');
    expect(off).not.toContain('auLocator');
    expect(off).not.toContain('/api/practice-intake/area');
  });
  it('the live lead-form script is untouched, and the Australian one is the file it was', () => {
    expect(BEFORE.off.front.files.leadScript.sha256).toBe(sha(fs.readFileSync(path.join(ROOT, 'js/site-practice-lead.js'))));
  });
});
