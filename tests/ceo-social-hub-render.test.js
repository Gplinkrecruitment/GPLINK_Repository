// Runs the Ads hub's client code (js/ceo-social.js) in a bare DOM stand-in
// with a night-phase snapshot, so a runtime slip in the page shows up here
// rather than as "The Ads view hit an error while drawing" on the owner's
// screen. `node --check` only proves the file parses.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const meta = require('../lib/meta-ads.js');
const fx = require('./fixtures/meta-ads-graph.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js/ceo-social.js'), 'utf8');

// Thu 5 Nov 2026 21:30Z: the nightly run, inside the "UK night off" window.
const OFF_NOW = Date.UTC(2026, 10, 5, 21, 30, 0);

function element(id) {
  return {
    id, innerHTML: '', style: {}, value: '', listeners: {},
    addEventListener(t, f) { this.listeners[t] = f; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} },
    parentNode: { replaceChild() {} }, appendChild() {}
  };
}

// Loads the hub into a fresh fake window, feeds it `payload` as /api/ceo/ads
// and returns what it drew into #soc-hub-root.
async function renderHub(payload) {
  const els = {};
  const document = {
    getElementById(id) { if (!els[id]) els[id] = element(id); return els[id]; },
    createElement(tag) { return element(tag + ':' + Object.keys(els).length); },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}
  };
  const window = {
    ATS: {
      esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
      api: async () => payload
    },
    document, confirm: () => false
  };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, Date, Intl, Math, Number, String, Array, Object, JSON, isFinite, setTimeout, clearTimeout, encodeURIComponent, Promise, Error });
  vm.runInContext(SRC, ctx, { filename: 'ceo-social.js' });
  window.loadSocialTab({});
  await new Promise((r) => setTimeout(r, 30));
  return els['soc-hub-root'].innerHTML;
}

function payloadWith(snapshot) {
  return {
    ok: true, configured: true, token_source: 'META_ADS_ACCESS_TOKEN', launch_disabled: false, anthropic_configured: true,
    higgsfield_configured: false, model: 'claude-opus-5-5',
    defaults: { adset_id: fx.ADSET_LIVE, lead_form_id: '2370693577080684', page_id: '769864969547691', campaign_id: fx.CAMPAIGN, account_id: '1668035273758338', time_zone: 'Australia/Melbourne' },
    cta_options: [], range_presets: [], account_time_zone: 'Australia/Sydney', problems: [],
    snapshot, snapshot_source: 'stored', snapshot_at: snapshot.fetched_at, review: null, last_run: null, drafts: [], lead_forms: []
  };
}

describe('Ads hub render with the time rule in play', () => {
  const off = fx.offPhase();
  const night = meta.assembleSnapshot({ config: meta.adsConfig({}), now: OFF_NOW, adsets: off.adsets, ads: off.ads, rules: fx.rules, insights: fx.insights, daily: fx.daily, leadRows: fx.leadRows });

  it('overnight: counts the seven ads as running, says the ad set is off by rule and when it is back', async () => {
    const html = await renderHub(payloadWith(night));
    expect(html).not.toContain('hit an error while drawing');
    expect(html).toContain('Creatives running <span class="ats-count-chip">7</span>');
    expect(html).toContain('0 delivering this minute');
    // The weekday is added when the firing is more than 20 h from the real clock.
    expect(html).toMatch(/Meta campaign · 7 ads in rotation · ad set off by rule until (\w{3} )?07:30 UK \(18:30 Sydney\)/);
    expect(html).toContain('<div class="mk-schedule"><span class="ats-pill blue">Off by rule</span>');
    expect(html).toMatch(/is switched off right now by the rule “UK night off” and comes back on at <strong>(\w{3} )?07:30 UK \(18:30 Sydney\)<\/strong> \(rule “UK morning on”\)/);
    expect(html).toContain('An ad you pause yourself stays paused when the rule turns the ad set back on');
    expect((html.match(/<span class="ats-pill blue">Off by rule<\/span>/g) || []).length).toBe(8); // the line + 7 cards
    expect(html).toContain('Show 2 paused / other ads');
    expect(html).toContain('/day · qualified-leads goal · off by rule');
    expect(html).not.toContain('Creatives running now');
  });

  it('the same stored snapshot the next morning reads as live, with the next switch-off', async () => {
    const morning = meta.rephaseSnapshot(night, Date.UTC(2026, 10, 6, 9, 0, 0));
    const html = await renderHub(payloadWith(morning));
    expect(html).not.toContain('hit an error while drawing');
    expect(html).toContain('Creatives running <span class="ats-count-chip">7</span></h3>');
    expect(html).not.toContain('delivering this minute');
    expect(html).toMatch(/7 ads in rotation · live now, off by rule at (\w{3} )?20:30 UK \(07:30 Sydney\)/);
    expect(html).toContain('<span class="ats-pill green">Live now</span>');
    expect(html).toMatch(/“UK night off” switches it off at <strong>(\w{3} )?20:30 UK \(07:30 Sydney\)<\/strong>/);
    // The cards follow rotation, not the ADSET_PAUSED Meta reported at 21:30 the night before.
    expect((html.match(/<span class="ats-pill green">Live<\/span>/g) || []).length).toBe(7);
    expect(html).not.toContain('Ad set paused</span>');
  });

  it('shows what GPs ask about in consultations when the snapshot carries it', async () => {
    const snap = Object.assign({}, night, { ecosystem: { gp_questions: {
      consults: 36, since: '2026-07-26', window_days: 365,
      themes: [{ key: 'visa', label: 'Visa and permanent residency', consults: 20, share_pct: 56, headings: [], examples: ['the doctor asked about the 482 visa & whether her husband could work.'] }, { key: 'income', label: 'Income, billings and the service fee', consults: 15, share_pct: 42, headings: [], examples: [] }],
      questions: [{ when: '2026-11-01', said: 'the doctor asked about the 482 visa.' }]
    } } });
    const html = await renderHub(payloadWith(snap));
    expect(html).not.toContain('hit an error while drawing');
    expect(html).toContain('What GPs ask about in consultations <span class="ats-count-chip">36</span>');
    expect(html).toContain('<strong>Visa and permanent residency</strong><span class="mk-asks-count">20 of 36 · 56%</span>');
    expect(html).toContain('<i style="width:56%"></i>');
    expect(html).toContain('the doctor asked about the 482 visa &amp; whether her husband could work.');
    expect(html).toContain('1 things doctors asked or were unsure about, newest first');
    expect(html.indexOf('Suggested improvements')).toBeLessThan(html.indexOf('What GPs ask about'));
    expect(html.indexOf('What GPs ask about')).toBeLessThan(html.indexOf('soc-drafts-slot'));
    const plain = await renderHub(payloadWith(night));
    expect(plain).not.toContain('What GPs ask about');
  });

  it('a snapshot without rules renders as before: live ads only, no schedule line', async () => {
    const plain = meta.assembleSnapshot({ config: meta.adsConfig({}), now: fx.NOW, adsets: fx.adsets, ads: fx.ads, insights: fx.insights, daily: fx.daily, leadRows: fx.leadRows });
    const html = await renderHub(payloadWith(plain));
    expect(html).not.toContain('hit an error while drawing');
    expect(html).toContain('Creatives running <span class="ats-count-chip">7</span></h3>');
    expect(html).toContain('Meta campaign · 7 ads in rotation · numbers as of');
    expect(html).not.toContain('mk-schedule');
    expect(html).toContain('Show 2 paused / other ads');
  });
});
