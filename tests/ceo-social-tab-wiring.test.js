import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The Social tab once rendered into a panel nobody could see, and showed no
// error anywhere. The cause was not the tab's own code: js/* is served
// `max-age=31536000, immutable`, so editing ceo-ats-shared.js without bumping
// its ?v= left every browser on a year-old copy whose MASTER_PANELS had no
// 'social'. The switcher hid every other panel, never un-hid this one, and the
// content was written into a hidden div.
//
// These assertions pin the wiring that has to agree across three files.

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const shared = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-shared.js'), 'utf8');
const social = fs.readFileSync(path.join(ROOT, 'js/ceo-social.js'), 'utf8');

function masterPanels() {
  const m = /MASTER_PANELS\s*=\s*\[([^\]]*)\]/.exec(shared);
  if (!m) throw new Error('MASTER_PANELS not found in ceo-ats-shared.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

describe('CEO Social tab wiring', () => {
  it("MASTER_PANELS includes 'social', or the panel is never un-hidden", () => {
    expect(masterPanels()).toContain('social');
  });

  it('every panel div in the page is known to the switcher', () => {
    // A panel the switcher does not know about can only ever render invisibly.
    const ids = [...html.matchAll(/id="panel-([a-z0-9-]+)"/g)].map((m) => m[1]);
    const panels = masterPanels();
    expect(ids.length).toBeGreaterThan(5);
    ids.forEach((id) => expect(panels, 'panel-' + id + ' missing from MASTER_PANELS').toContain(id));
  });

  it('the tab button, the panel and the assets are all present', () => {
    expect(html).toContain('data-mtab="social"');
    expect(html).toContain('id="panel-social"');
    expect(html).toContain('/js/ceo-social.js?v=');
    expect(html).toContain('/css/ceo-social.css?v=');
  });

  it('the panel carries ats-scope so its palette tokens resolve', () => {
    expect(html).toMatch(/class="master-panel ats-scope" id="panel-social"/);
  });

  it('ceo-social.js registers the loader the switcher calls by convention', () => {
    // setActiveTab() looks up window['load' + Social + 'Tab'] by name.
    expect(social).toContain('window.loadSocialTab');
  });

  it('render failures paint themselves instead of leaving a blank tab', () => {
    // The switcher swallows loader exceptions, so a throw used to be invisible.
    expect(social).toContain('hit an error while drawing');
    expect(social).toMatch(/\.catch\(/);
  });

  it('the shared bundle is busted past the version that lacked social', () => {
    // js/* is immutable-cached for a year; the old URL can never update.
    const m = /ceo-ats-shared\.js\?v=(\d{8}[a-z]?)/.exec(html);
    expect(m, 'ceo-ats-shared.js must carry a ?v= buster').toBeTruthy();
    expect(m[1] > '20260805a', 'buster must be newer than the pre-social build').toBe(true);
  });
});
