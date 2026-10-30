import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The Leads tab was rebuilt on 2026-10-30 around Hazel. js/* and css/* are
// served immutable for a year, so a rebuilt module behind an un-bumped ?v=
// would leave every browser on the old tab (the Social tab lesson). These
// assertions pin the wiring that has to agree across the page, the module,
// the stylesheet and the server.
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const shared = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-shared.js'), 'utf8');
const leads = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-leads.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function version(tag) {
  const m = new RegExp(tag.replace(/[.?]/g, '\\$&') + '\\?v=([0-9a-z]+)').exec(html);
  return m ? m[1] : '';
}

describe('CEO Leads tab wiring', () => {
  it("MASTER_PANELS includes 'leads' and the page has the panel + tab", () => {
    expect(/MASTER_PANELS\s*=\s*\[[^\]]*'leads'/.test(shared)).toBe(true);
    expect(html).toContain('data-mtab="leads"');
    expect(html).toMatch(/class="master-panel ats-scope" id="panel-leads"/);
  });

  it('the rebuilt module and stylesheet are served under a version from 2026-10-30 or later', () => {
    expect(version('/js/ceo-ats-leads.js') >= '20261030a').toBe(true);
    expect(version('/css/ceo-ats.css') >= '20261030a').toBe(true);
  });

  it('registers the loader the switcher calls by convention, and paints its own failures', () => {
    expect(leads).toContain('window.loadLeadsTab');
    expect(leads).toContain('hit an error while drawing');
    expect(leads).toContain('opts.quiet');
  });

  it('talks only to endpoints the server actually serves', () => {
    expect(leads).toContain("'/api/ceo/leads?filter='");
    expect(leads).toContain("'/api/ceo/leads/' + encodeURIComponent(");
    expect(leads).toContain("+ '/call'");
    expect(leads).toContain("+ '/hazel'");
    expect(server).toContain("pathname === '/api/ceo/leads' && req.method === 'GET'");
    expect(server).toMatch(/\/api\\\/ceo\\\/leads\\\/\(\[\^\/\]\+\)\(\?:\\\/\(call\|hazel\)\)\?\$/);
  });

  it('filter values the page sends are the ones the server answers', () => {
    const stageVals = [...leads.matchAll(/\{ v: '([a-z_]+)',\s+label: '[^']+'(?:,\s+hint: '[^']*')? \}/g)].map((m) => m[1]);
    const serverStage = /CEO_LEAD_STAGE_FILTERS = \{([\s\S]*?)\n\};/.exec(server)[1];
    const serverHazel = /CEO_LEAD_HAZEL_FILTERS = \{([\s\S]*?)\n\};/.exec(server)[1];
    expect(stageVals.length).toBeGreaterThan(10);
    stageVals.forEach((v) => {
      const known = new RegExp('(^|\\n)\\s*' + v + ':').test(serverStage) || new RegExp('(^|\\n)\\s*' + v + ':').test(serverHazel);
      expect(known, 'filter value "' + v + '" unknown to the server').toBe(true);
    });
  });

  it('uses no class name an ad blocker hides (EasyList hides .lead-ad / .lead-ads and every ad-* prefix)', () => {
    const classes = new Set([...leads.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).concat(
      [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(lead-[a-z0-9-]+)/g)].map((m) => m[1])));
    classes.forEach((c) => {
      expect(/^ad-|-ad$|-ads$|^ads-/.test(c), 'class "' + c + '" would be hidden by an ad blocker').toBe(false);
    });
    expect(classes.has('lead-row')).toBe(true);
  });

  it('the stylesheet styles the pieces the module renders', () => {
    ['lead-status', 'lead-tiles', 'lead-tile', 'lead-row', 'lead-hz', 'lead-hz-dot', 'lead-chase', 'lead-drawer', 'lead-call', 'lead-transcript', 'lead-sched'].forEach((c) => {
      expect(css, 'missing .' + c).toContain('.' + c + ' ');
    });
  });
});
