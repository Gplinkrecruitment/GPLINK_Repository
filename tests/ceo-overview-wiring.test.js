import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The Overview master tab was rebuilt on 2026-11-05 ("E": brief · status
// lights · funnel · needs you) as js/ceo-overview.js, and the old Overview DOM
// moved verbatim to Registration → Pipeline. js/* and css/* are served
// immutable for a year, so a rebuilt module behind an un-bumped ?v= would leave
// every browser on the old tab (the Social tab lesson). These assertions pin
// the wiring that has to agree across the page, the module, the stylesheet
// and the server. Mirrors tests/ceo-leads-tab-wiring.test.js.
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const mod = fs.readFileSync(path.join(ROOT, 'js/ceo-overview.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/ceo-overview.css'), 'utf8');
const atsCss = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
const leads = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-leads.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function version(tag) {
  const m = new RegExp(tag.replace(/[.?]/g, '\\$&') + '\\?v=([0-9a-z]+)').exec(html);
  return m ? m[1] : '';
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('CEO Overview (E) wiring', () => {
  it('the module and stylesheet are served under a version from 2026-11-05 or later, after the ATS bundle', () => {
    expect(version('/js/ceo-overview.js') >= '20261105a').toBe(true);
    expect(version('/css/ceo-overview.css') >= '20261105a').toBe(true);
    // ceo-ats-leads.js gained window.CeoLeads.open for the Overview's "Open" buttons.
    expect(version('/js/ceo-ats-leads.js') >= '20261105a').toBe(true);
    expect(html.indexOf('/js/ceo-ats-shared.js?v=')).toBeLessThan(html.indexOf('/js/ceo-overview.js?v='));
  });

  it('registers the loader the switcher calls by convention, honours quiet re-entry, and paints its own failures', () => {
    expect(mod).toContain('window.loadOverviewTab');
    expect(mod).toContain('opts.quiet');
    expect(mod).toContain('hit an error while drawing');
    expect(mod).toContain("'/api/ceo/overview'");
    // Never an eternal spinner: every failure path offers Retry.
    expect(mod).toContain("btn('Retry', 'retry'");
    expect(mod).toContain('function renderError');
  });

  it('the page hands the Overview master tab to the module and keeps the old Overview as Registration → Pipeline', () => {
    expect(html).toContain('window.loadRegistrationTab = function () {');
    expect(html).toContain('window.loadOverviewTab(opts)');
    expect(html).toMatch(/class="master-panel ats-scope" id="panel-registration"><div id="overviewRoot"><\/div>/);
    expect(html).toContain('data-regsub="pipeline"');
    expect(html).toContain('id="regSub-pipeline"');
    // The old DOM sits inside the Pipeline sub-panel, in its original order.
    const i = (s) => html.indexOf(s);
    expect(i('id="regSub-pipeline"')).toBeGreaterThan(i('id="regSub-rsos"'));
    expect(i('id="regSub-pipeline"')).toBeLessThan(i('id="timeFilterBar"'));
    expect(i('id="timeFilterBar"')).toBeLessThan(i('id="mainContent"'));
    expect(i('id="mainContent"')).toBeLessThan(i('id="regSub-guides"'));
    // Polling for the old payload is gated on that sub-tab being on screen.
    expect(html).toContain("function overviewActive() { return !!window.ATS && window.ATS.activeTab === 'rso' && regSubActive === 'pipeline'; }");
    expect(html).toContain("var regSubActive = 'rsos';");
    // Boot starts the new Overview and stamps the tab as loaded (quiet re-entry).
    expect(html).toContain('window.loadOverviewTab();');
    expect(html).toContain('.registration = Date.now()');
  });

  it('talks only to endpoints the server actually serves', () => {
    expect(mod).toContain("'/api/ceo/overview'");
    expect(server).toContain("pathname === '/api/ceo/overview'");
    expect(mod).toContain("'/api/ceo/owner-digest/send'");
    expect(server).toContain("pathname === '/api/ceo/owner-digest/send'");
    expect(mod).toContain("'/api/ceo/ads/draft/launch-now'");
    expect(server).toContain("pathname === '/api/ceo/ads/draft/launch-now'");
    expect(mod).toContain("'/api/ceo/ads/review'");
    expect(server).toContain("pathname === '/api/ceo/ads/review'");
    expect(mod).toContain("'/api/admin/va/nudge'");
    expect(server).toContain("pathname === '/api/admin/va/nudge'");
    expect(mod).toContain("'/api/admin/va/incoming-questions/' + encodeURIComponent(");
    expect(mod).toContain("+ '/resolve'");
    expect(server).toContain("pathname.startsWith('/api/admin/va/incoming-questions/') && pathname.endsWith('/resolve')");
    expect(mod).toContain("'/api/ceo/escalation/' + encodeURIComponent(");
    expect(mod).toContain("+ '/respond'");
    expect(server).toMatch(/\/api\\\/ceo\\\/escalation\\\/\(\[\^\/\]\+\)\\\/\(resolve\|respond\)\$/);
    expect(mod).toContain("'/api/ceo/leads/' + encodeURIComponent(");
    expect(mod).toContain("+ '/call'");
    expect(mod).toContain("+ '/hazel'");
    expect(mod).toContain("+ '/callback-done'");
    expect(server).toMatch(/\/api\\\/ceo\\\/leads\\\/\(\[\^\/\]\+\)\(\?:\\\/\(call\|hazel\|callback-done\)\)\?\$/);
  });

  it('the leads module exposes window.CeoLeads.open for the funnel/needs "Open" buttons', () => {
    expect(leads).toContain('window.CeoLeads = {');
    expect(leads).toMatch(/open:\s*function\s*\(id\)/);
    expect(mod).toContain('window.CeoLeads.open(id)');
  });

  it('uses no class name an ad blocker hides (EasyList hides every ad-/ads- prefix and -ad/-ads suffix)', () => {
    // class="…" attributes in the module are often built by concatenation
    // (class="ov-btn ' + cls + '"), which would leak JS identifiers in as
    // "classes": take only literal attributes, the 'ov-…' string literals,
    // and every selector in the stylesheet.
    const literalAttrs = [...mod.matchAll(/class="([a-z0-9 -]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    const stringLits = [...mod.matchAll(/'(ov-[a-z0-9-]+(?: ov-[a-z0-9-]+)*)'/g)].flatMap((m) => m[1].split(' '));
    const cssClasses = [...stripComments(css).matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    const classes = new Set(literalAttrs.concat(stringLits, cssClasses).filter(Boolean));
    expect(classes.size).toBeGreaterThan(20);
    classes.forEach((c) => {
      expect(/^ad-|-ad$|-ads$|^ads-/.test(c), 'class "' + c + '" would be hidden by an ad blocker').toBe(false);
    });
    // Belt and braces: no concatenated attribute may start or end a class with ad-/ads- either.
    expect(mod).not.toMatch(/class="[^"]*(^|\s|')(ad|ads)-/);
    expect(mod).not.toMatch(/-(ad|ads)(\s|'|")[^"]*"/);
    // Every class the module/stylesheet introduce is ov-* (ats-* are shared
    // primitives; the old Pipeline DOM's classes are only targeted, not emitted).
    const allowed = ['open', 'ceo-topnav', 'time-filter-bar', 'time-btn'];
    classes.forEach((c) => {
      if (/^(ats-|ov-)/.test(c)) return;
      expect(allowed.includes(c), 'unexpected class "' + c + '"').toBe(true);
    });
  });

  it('the stylesheet styles the pieces the module renders', () => {
    ['ov-toolbar', 'ov-brief', 'ov-status-strip', 'ov-status', 'ov-st-h', 'ov-st-v', 'ov-st-s', 'ov-funnel', 'ov-stage', 'ov-bar', 'ov-lower', 'ov-row', 'ov-rows', 'ov-avatar',
      'ov-num-box', 'ov-alertbox', 'ov-tile', 'ov-spark-wide', 'ov-legend', 'ov-pill', 'ov-light', 'ov-seg', 'ov-error', 'ov-error-bar', 'ov-skel', 'ov-drawer-h', 'ov-drawer-b'].forEach((c) => {
      expect(css, 'missing .' + c).toContain('.' + c + ' ');
    });
    expect(css).toContain('.ats-drawer.ov-drawer {');
    // The page's tokens are used, not redeclared.
    expect(css).not.toMatch(/:root\s*\{/);
    expect(css).toContain('var(--panel)');
  });

  it('the moved Pipeline DOM keeps its period-filter overflow rules (mirrored from ceo-ats.css, which pins its own ?v=)', () => {
    expect(atsCss).toContain('#panel-registration .time-filter-bar');
    expect(css).toContain('#regSub-pipeline .time-filter-bar');
    expect(css).toContain('#regSub-pipeline .time-btn');
    expect(css).toContain('#regSub-pipeline .ceo-topnav');
  });

  it('the caller is Hayley everywhere the owner reads', () => {
    const code = stripComments(mod);
    expect(code).toContain('Hayley');
    // Only the route segment '/hazel' and the hazel JSON key may keep the old name.
    const hazelMentions = [...code.matchAll(/hazel/gi)].map((m) => code.slice(Math.max(0, m.index - 12), m.index + 8));
    hazelMentions.forEach((ctx) => {
      expect(/\/hazel'|status\.hazel|S\.hazel|T\.hazel|hazel\b\)/.test(ctx) || /'\/hazel'/.test(ctx) || /\.hazel\b/.test(ctx), 'user-facing Hazel in: ' + ctx).toBe(true);
    });
  });
});
