import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The "Pipeline & money" board (2026-11-26) sits under the Overview. js/* and
// css/* are served immutable, so the tags, the mount point, the loader hook
// and the endpoints have to agree across page, module, stylesheet and server.
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const mod = fs.readFileSync(path.join(ROOT, 'js/ceo-pipeline.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/ceo-pipeline.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('CEO pipeline board wiring', () => {
  it('loads the module and stylesheet with a cache buster, after the Overview module', () => {
    expect(html).toContain('/js/ceo-pipeline.js?v=20261126c');
    expect(html).toContain('/css/ceo-pipeline.css?v=20261126c');
    expect(html.indexOf('/js/ceo-overview.js?v=')).toBeLessThan(html.indexOf('/js/ceo-pipeline.js?v='));
  });

  it('mounts in #pipelineRoot right after #overviewRoot in the Overview panel', () => {
    expect(html).toContain('id="panel-registration"><div id="overviewRoot"></div><div id="pipelineRoot"></div></div>');
    expect(mod).toContain("var ROOT_ID = 'pipelineRoot';");
  });

  it('hooks the Overview loader and polls only while the tab is visible', () => {
    expect(mod).toContain('window.loadOverviewTab = function');
    expect(mod).toContain('window.loadPipelineBoard = function');
    expect(mod).toContain("document.visibilityState !== 'visible' || !isActive()");
  });

  it('talks only to endpoints the server serves', () => {
    expect(mod).toContain("'/api/ceo/pipeline'");
    expect(server).toContain("pathname === '/api/ceo/pipeline'");
    expect(mod).toContain("'/api/ceo/pipeline/person'");
    expect(server).toContain("pathname === '/api/ceo/pipeline/person'");
    expect(mod).toContain("'/done'");
    expect(server).toContain('/^\\/api\\/ceo\\/pipeline\\/person\\/([^/]+)\\/done$/');
    expect(mod).toContain("'/api/ceo/pipeline/whatsapp-import'");
    expect(server).toContain("pathname === '/api/ceo/pipeline/whatsapp-import'");
    expect(mod).toContain("'/api/ceo/pipeline/email-find/'");
    expect(server).toContain('/^\\/api\\/ceo\\/pipeline\\/email-find\\/([^/]+)\\/dismiss$/');
    expect(server).toContain('/^\\/api\\/ceo\\/pipeline\\/email-find\\/([^/]+)\\/confirm$/');
    expect(mod).toContain("'/api/ceo/xero/connect'");
    expect(server).toContain("pathname === '/api/ceo/xero/connect'");
    expect(mod).toContain("'/api/ceo/xero/sync'");
    expect(server).toContain("pathname === '/api/ceo/xero/sync'");
    expect(mod).toContain("'/api/ceo/xero/invoice/'");
    expect(mod).toContain("'/owner-status'");
    expect(server).toContain('/^\\/api\\/ceo\\/xero\\/invoice\\/([^/]+)\\/owner-status$/');
    expect(mod).toContain("'/expected-start'");
    expect(server).toContain('/^\\/api\\/ceo\\/pipeline\\/person\\/([^/]+)\\/expected-start$/');
    expect(mod).toContain("'/api/ceo/income-expectation'");
    expect(server).toContain("pathname === '/api/ceo/income-expectation'");
  });

  it('draws the income forecast under the money tiles as inline SVG (no chart library)', () => {
    expect(mod).toContain("tilesHtml(d) + forecastHtml(d) + boardHtml(d)");
    expect(mod).toContain('<svg class="pl-fc-svg"');
    expect(css).toContain('.pl-fc-scroll { overflow-x: auto;');
    expect(html).not.toMatch(/chart\.js|chartjs|d3\.v|apexcharts/i);
  });

  it('never uses browser dialogs', () => {
    expect(stripComments(mod)).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
  });

  it('says what Confirm really does before it does it', () => {
    expect(mod).toContain('This creates the placement in the app and emails the doctor and practice.');
  });

  it('uses only pl-* classes and none an ad blocker hides', () => {
    const literalAttrs = [...mod.matchAll(/class="([a-z0-9 -]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    const stringLits = [...mod.matchAll(/'(pl-[a-z0-9-]+(?: pl-[a-z0-9-]+)*)'/g)].flatMap((m) => m[1].split(' '));
    const cssClasses = [...stripComments(css).matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    const classes = new Set(literalAttrs.concat(stringLits, cssClasses).filter(Boolean));
    expect(classes.size).toBeGreaterThan(30);
    classes.forEach((c) => {
      expect(/^ad-|-ad$|-ads$|^ads-/.test(c), 'class "' + c + '"').toBe(false);
      expect(/^pl-/.test(c), 'unexpected class "' + c + '"').toBe(true);
    });
  });
});
