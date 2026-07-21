// Phase 6 H1, 12-week trends chart on the CEO dashboard (static checks):
//  1. the trends section card exists and is wired into renderDashboard;
//  2. the series toggle uses the REAL /api/ceo/trends field names (the earlier
//     completions_done-vs-completions mismatch class of bug);
//  3. the chart is a hand-rolled inline SVG, NO external chart lib / CDN
//     (the CSP blocks CDNs, so a lib reference would silently dead the card);
//  4. the chart carries the dashboard's visual language: area fill, faint
//     gridlines, an emphasized latest point, native hover tooltips.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, '..', 'pages', 'ceo-dashboard.html');
const SERVER = path.join(__dirname, '..', 'server.js');

let html;
let serverSrc;
beforeAll(() => {
  html = fs.readFileSync(PAGE, 'utf8');
  serverSrc = fs.readFileSync(SERVER, 'utf8');
});

// Every key the chart offers must be a field computeWeeklyTrendSeries emits.
const REAL_FIELDS = [
  'applications_submitted',
  'stage_transitions',
  'tasks_completed',
  'placements_secured',
  'completions_done',
  'tickets_opened'
];

describe('CEO dashboard 12-week trends chart', () => {
  it('renders a trends section card wired into the dashboard grid', () => {
    expect(html).toContain('function renderTrendsSection');
    expect(html).toContain('renderTrendsSection()');
    expect(html).toMatch(/sectionCard\('trends'/);
  });

  it('series toggle exists and uses the real /api/ceo/trends field names', () => {
    expect(html).toContain('data-trend-series');
    for (const field of REAL_FIELDS) {
      expect(html, `chart series key ${field}`).toContain(`'${field}'`);
      // ...and each key really is emitted by the server's shared series builder.
      expect(serverSrc, `server emits ${field}`).toContain(`${field}:`);
    }
    // The old bug class: every key the chart's series config declares must be
    // one of the real trend fields (no invented 'completions'-style names).
    const cfgStart = html.indexOf('var TREND_SERIES');
    expect(cfgStart).toBeGreaterThan(-1);
    const cfgBlock = html.slice(cfgStart, html.indexOf('];', cfgStart));
    const declaredKeys = [...cfgBlock.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(declaredKeys.length).toBeGreaterThanOrEqual(5);
    for (const key of declaredKeys) {
      expect(REAL_FIELDS, `declared series key ${key} must be a real trends field`).toContain(key);
    }
  });

  it('hand-rolled inline SVG, no external chart library or CDN', () => {
    expect(html).toContain('function buildTrendChartSvg');
    expect(html).toContain('<svg');
    const forbidden = ['chart.js', 'chartjs', 'highcharts', 'd3.min', 'plotly', 'echarts', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
    for (const lib of forbidden) {
      expect(html.toLowerCase(), `must not reference ${lib}`).not.toContain(lib);
    }
    // No script tag loading anything from another origin.
    const externalScripts = (html.match(/<script[^>]+src=["']https?:\/\//g) || []);
    expect(externalScripts).toEqual([]);
  });

  it('carries the chart anatomy: area fill, gridlines, emphasized latest point, tooltips', () => {
    expect(html).toContain('fill-opacity');            // area fill under the line
    expect(html).toMatch(/rgba\(255,255,255,0\.0\d\)/); // faint gridlines
    expect(html).toContain('r="5.5"');                  // emphasized latest point
    expect(html).toContain('<title>');                  // native hover tooltips
    expect(html).toContain('vs last week');             // WoW movement summary
  });

  it('the "Send me the digest now" button is wired to the manual-send endpoint', () => {
    expect(html).toContain('sendDigestBtn');
    expect(html).toContain('/api/ceo/owner-digest/send');
  });
});
