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
// 2026-10-29: the Social tab became the Ads hub; the monthly organic review it
// used to be moved, unchanged, to ceo-social-organic.js behind a view switch.
const organic = fs.readFileSync(path.join(ROOT, 'js/ceo-social-organic.js'), 'utf8');
const drafts = fs.readFileSync(path.join(ROOT, 'js/ceo-ads-drafts.js'), 'utf8');

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
    expect(html).toContain('/js/ceo-social-organic.js?v=');
    expect(html).toContain('/js/ceo-ads-drafts.js?v=');
    expect(html).toContain('/css/ceo-social.css?v=');
    // The hub must be the LAST of the three: it is what the switcher calls, and
    // it hands off to the other two by name.
    const order = ['/js/ceo-social-organic.js', '/js/ceo-ads-drafts.js', '/js/ceo-social.js'].map((f) => html.indexOf('src="' + f + '?v='));
    expect(order[0]).toBeGreaterThan(0);
    expect(order[0]).toBeLessThan(order[2]);
    expect(order[1]).toBeLessThan(order[2]);
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

  it('image URLs are versioned, so a replaced creative is not hidden by cache', () => {
    // /api/public/social-image caches for a day and is keyed only on the post
    // id. Replacing the picture on an existing row therefore showed every
    // reviewer the old one, with nothing on screen to suggest why.
    expect(organic).toMatch(/updated_at \|\| post\.created_at/);
    expect(organic).toMatch(/'&v='/);
  });

  it('the hub scaffolds the two roots once and the sub-modules target them', () => {
    // #panel-social is persistent; the hub writes the scaffold ONCE and only
    // repaints #soc-hub-root, so the drafts editor keeps unsaved edits and the
    // organic module's once-only click binding stays valid.
    expect(social).toContain("id=\"soc-hub-root\"");
    expect(social).toContain("id=\"soc-organic-root\"");
    expect(organic).toContain("getElementById('soc-organic-root')");
    expect(organic).not.toContain("getElementById('panel-social')");
    expect(drafts).toContain("getElementById('soc-drafts-root')");
    expect(social).toContain('window.loadSocialOrganicView');
    expect(organic).toContain('window.loadSocialOrganicView = function');
    expect(social).toContain('window.AdsDrafts');
    expect(drafts).toContain('window.AdsDrafts = ');
  });

  it('the busters moved past the pre-hub build so no browser keeps the old tab', () => {
    const css = /ceo-social\.css\?v=(\d{8}[a-z]?)/.exec(html);
    const js = /ceo-social\.js\?v=(\d{8}[a-z]?)/.exec(html);
    expect(css && css[1] > '20260818b').toBe(true);
    expect(js && js[1] > '20260819a').toBe(true);
  });

  it('the shared bundle is busted past the version that lacked social', () => {
    // js/* is immutable-cached for a year; the old URL can never update.
    const m = /ceo-ats-shared\.js\?v=(\d{8}[a-z]?)/.exec(html);
    expect(m, 'ceo-ats-shared.js must carry a ?v= buster').toBeTruthy();
    expect(m[1] > '20260805a', 'buster must be newer than the pre-social build').toBe(true);
  });
});
