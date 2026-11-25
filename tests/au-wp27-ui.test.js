// WP-27 (Australian GP build): what the CEO dashboard draws.
//   js/ceo-au-pipeline.js   the Australian pipeline card (Overview and
//                           Registration -> Pipeline), run here with the
//                           server's own view of the WP-27 fixtures
//   wiring                  script order, cache-busters, the page mounts, the
//                           review-queue deep links, the Gone quiet tile
// There is no DOM in this suite: the module is run in a bare context and its
// HTML is read as text.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fx = require('./helpers/au-wp27-fixtures.js');
const auPipeline = require('../lib/au-pipeline.js');
const reviewQueue = require('../lib/ceo-review-queue.js');
const lifecycle = require('../lib/au-lifecycle.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function loadModule() {
  const window = {};
  const ctx = { window, location: { hash: '' }, document: {}, fetch: () => Promise.reject(new Error('no network in this test')), WeakMap, Promise, setTimeout };
  vm.runInNewContext(read('js/ceo-au-pipeline.js'), ctx, { filename: 'ceo-au-pipeline.js' });
  return window.GPAuPipeline;
}

// The view the server would send for the WP-27 Australian fixtures.
function viewFor(role) {
  const t = fx.auTables();
  const doctors = t.user_profiles.map((p) => Object.assign({}, p, { pathway: p.candidate_pathway || '' }));
  const facts = { nowMs: fx.NOW_MS, doctors, cases: t.registration_cases, applications: t.gp_applications, placements: t.placements,
    interviews: t.scheduled_calls.filter((r) => r.meeting_kind === 'interview'), credentials: t.gp_credentials, leads: t.site_enquiries };
  const built = auPipeline.buildAuPipeline(facts);
  const pipeline = auPipeline.serialisable(built);
  let items = reviewQueue.buildReviewQueue({ nowMs: fx.NOW_MS, au: Object.assign({}, facts, { tasks: t.registration_tasks, roles: fx.ROLES, pipeline: built }) }).items;
  if (role !== 'ceo') items = items.filter((it) => !/invoice|credit/.test(it.kind));
  const view = { enabled: true, ok: true, today: fx.TODAY, window_days: 7, pipeline, brief: auPipeline.briefText(pipeline, items.length), review: { count: items.length, items: items.slice(0, 8) }, leads: { window: 2, total: 3, recent: [] } };
  if (role === 'ceo') {
    const s = lifecycle.commercialSummary(t.placements.filter((p) => p.commenced_at), fx.TODAY);
    const named = (list) => list.map((x) => Object.assign({}, x, { gp_name: 'Dr Testau Someone', case_id: 'case-x' }));
    view.commercial = { counts: s.counts, invoices_due: named(s.invoicesDue), in_guarantee: named(s.inGuarantee), guarantee_ending_soon: named(s.guaranteeEndingSoon), ending_within_days: 14 };
  }
  return view;
}
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('WP-27: the Australian pipeline card', () => {
  const mod = loadModule();

  it('nothing is drawn unless the server sent an Australian section', () => {
    expect(mod.html(null)).toBe('');
    expect(mod.html(undefined)).toBe('');
    expect(mod.html({})).toBe('');
    expect(mod.html({ enabled: false })).toBe('');
  });

  it('the CEO sees the six columns in order, the groups outside the pipeline, the numbers, the commercial tile and what needs them', () => {
    const html = mod.html(viewFor('ceo'), {});
    const text = textOf(html);
    expect(text).toContain('Australian GPs already registered in Australia');
    const order = ['Matched', 'Interview', 'Contract', 'Pre-start', 'Commenced', 'Guarantee'].map((l) => html.indexOf('<span class="aup-col-l">' + l + '</span>'));
    order.forEach((i) => expect(i).toBeGreaterThan(-1));
    expect(order.slice().sort((a, b) => a - b)).toEqual(order);
    expect((html.match(/class="aup-col[ "]/g) || []).length).toBe(6);
    expect(text).toMatch(/Matched 3 .*Interview 1 .*Contract 1 .*Pre-start 2 .*Commenced 1 .*Guarantee 2/);
    expect(text).toContain('Not in the pipeline Finishing their profile 1 Looking, not yet matched 4 Complete 1 Ended 1 Needs review (not launched) 2');
    expect(text).toContain('Invoices and the guarantee period you only');
    expect(text).toMatch(/3 invoices due 2 unpaid past terms/);
    expect(text).toMatch(/3 in the guarantee period/);
    expect(text).toMatch(/1 guarantee ending within 14 days/);
    expect(text).toMatch(/Needs you 13/);
    expect(text).toContain('Application to placement 2.3 weeks');
    expect(text).toContain('Latest placement: Dr Testau Prestart at Test Metro Practice (FAKE) · starts 8 December 2026');
    // every doctor link opens the candidate by case id, with the card to look at
    expect(html).toMatch(/data-aup-act="open" data-id="[0-9a-z-]{36}" data-focus="au_/);
  });

  it('no raw stage word, no overseas stage, no "ad-" class (ad blockers hide those)', () => {
    const html = mod.html(viewFor('ceo'), {});
    expect(textOf(html)).not.toMatch(/prestart|first_week|settling_in|myintealth|MyIntealth|AMC|_/);
    expect(html).not.toMatch(/class="[^"]*\bad-/);
    const css = read('css/ceo-au-pipeline.css');
    expect(css).not.toMatch(/\.ad-|-ad\b|\.ads-/);
    // its own stylesheet: only aup-* classes (plus the one grid hook)
    const classes = Array.from(new Set((css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.[a-z][a-z0-9-]*/g) || []).map((c) => c.slice(1))));
    classes.forEach((c) => expect(/^aup-/.test(c) || c === 'section-grid', c).toBe(true));
    // every class the card emits has a rule
    const emitted = Array.from(new Set((read('js/ceo-au-pipeline.js').match(/aup-[a-z-]+/g) || [])));
    emitted.filter((c) => !/^aup-(root|act|panel)$/.test(c)).forEach((c) => expect(css.indexOf('.' + c) !== -1, c).toBe(true));
  });

  it('a view with no commercial section draws no money: not a count, not an amount, not the word', () => {
    const html = mod.html(viewFor('consultant'), {});
    const text = textOf(html);
    expect(text).not.toMatch(/invoice|Invoices|credit|ex GST|\$\d|guarantee period you only/i);
    expect(html).not.toContain('data-aup-act="money"');
    expect(text).toMatch(/Needs you 9/);
    expect(text).toMatch(/Matched 3/);
  });

  it('a section the server could not read says so, and shows no number', () => {
    const html = mod.html({ enabled: true, ok: false, message: 'The Australian doctors could not be read just now. Nothing below is counted until they can be.' }, {});
    expect(textOf(html)).toContain('could not be read just now');
    expect(html).not.toContain('aup-col-n');
  });

  it('dates are calendar dates and durations are days or weeks, never months', () => {
    expect(mod.day('2026-11-15')).toBe('15 Nov 2026');
    expect(mod.daysWords(9)).toBe('9 days');
    expect(mod.daysWords(16)).toBe('2.3 weeks');
    expect(mod.daysWords(null)).toBe('');
    expect(mod.money(15000)).toBe('$15,000 ex GST');
    expect(mod.money(null)).toBe('amount not on file');
  });
});

describe('WP-27: wiring on the CEO dashboard', () => {
  const page = read('pages/ceo-dashboard.html');
  const overview = read('js/ceo-overview.js');
  const candidates = read('js/ceo-ats-candidates.js');

  it('the card\'s script loads before the Overview module, both with a cache-buster; the stylesheet and the service worker moved', () => {
    const a = page.indexOf('/js/ceo-au-pipeline.js?v=20261123a');
    const b = page.indexOf('/js/ceo-overview.js?v=20261123a');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(page).toContain('/css/ceo-au-pipeline.css?v=20261123a');
    expect(page).toContain('/js/ceo-ats-candidates.js?v=20261125a');
    expect(read('sw.js')).toContain('var VERSION = "20261125a"');
    // the known trap: the ATS stylesheet's buster is never behind the candidates script's
    const css = page.match(/ceo-ats\.css\?v=(\d{8}[a-z])/)[1];
    const js = page.match(/ceo-ats-candidates\.js\?v=(\d{8}[a-z])/)[1];
    expect(css >= js).toBe(true);
  });

  it('the Overview draws the section only when the payload has one, under the funnel and outside the status lights', () => {
    expect(overview).toContain("if (!d || !d.au || d.au.enabled !== true || !window.GPAuPipeline) return '';");
    expect(overview).toContain("briefHtml(d) + statusHtml(d) + funnelHtml(d) + auSectionHtml(d) + '<div class=\"ov-gap\"></div>' + lowerHtml(d)");
    // the funnel and the status strip are untouched by it
    expect(overview).toContain("return '<div class=\"ov-status-strip\">' + metaBox(S.meta || {}, d) + hayleyBox(S.hayley || {}, d) + consultsBox(S.consults || {}, d) + registrationBox(S.registration || {}, d) + '</div>';");
  });

  it('Registration -> Pipeline mounts it beside the overseas funnel, and asks for it only when the server says the switch is on', () => {
    expect(page).toContain('html += renderPipelineSection(data.pipeline, data.ats_funnel);\n      html += auPipelineMountHtml();');
    expect(page).toContain("function auPipelineOn() { return !!(dashboardData && dashboardData.au && dashboardData.au.enabled === true && window.GPAuPipeline); }");
    expect(page).toContain("if (!auPipelineOn()) return;\n      apiFetch('/api/ceo/au-pipeline?window=30d')");
    const server = read('server.js');
    expect(server).toContain('if (auPathwayFlag.isAuPathwayEnabled()) dashPayload.au = { enabled: true };');
  });

  it('every Australian review kind\'s deep link points at a card that exists in the candidate drawer', () => {
    const targets = candidates.match(/au_pathway: '([^']+)', au_ahpra: '([^']+)', au_tasks: '([^']+)',\s+au_eligibility: '([^']+)', au_commencement: '([^']+)'/);
    expect(targets).toBeTruthy();
    targets.slice(1).forEach((sel) => expect(candidates.indexOf('id="' + sel.slice(1) + '"'), sel).toBeGreaterThan(-1));
    // every focus the builder hands out has a target
    const built = reviewQueue.buildAuReviewItems; expect(typeof built).toBe('function');
    const src = read('lib/ceo-review-queue.js');
    const focuses = Array.from(new Set((src.match(/focus: 'au_[a-z]+'/g) || []).map((s) => s.slice(8, -1))));
    expect(focuses.sort()).toEqual(['au_ahpra', 'au_commencement', 'au_eligibility', 'au_pathway', 'au_tasks']);
    focuses.forEach((f) => expect(candidates).toContain(f + ": '#ats-au-"));
    expect(candidates).toContain("'/api/ceo/au/19ab-mismatch/reviewed'");
  });

  it('the Gone quiet tile and list say the Australian threshold only when the server sends one', () => {
    expect(candidates).toContain("(attentionSummary.stalled_threshold_days_au ? ' (' + attentionSummary.stalled_threshold_days_au + '+ Australian)' : '')");
    expect(candidates).toContain("var auNote = auDays ? ' (' + auDays + '+ days for a doctor already registered in Australia)' : '';");
    expect(candidates).toContain("if (a.au === true) meta.push('Australian GP · ' + (a.au_threshold_days || 60) + '-day rule');");
  });

  it('every inline script on the page still parses', () => {
    const scripts = page.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((block, i) => {
      const code = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
      if (/type="application\/(ld\+)?json"/.test(block.slice(0, 80))) return;
      expect(() => new vm.Script(code, { filename: 'ceo-dashboard-inline-' + i + '.js' }), 'inline script ' + i).not.toThrow();
    });
  });
});
