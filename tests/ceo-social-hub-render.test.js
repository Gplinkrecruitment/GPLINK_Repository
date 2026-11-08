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
    // Sub-tabs (2026-11-08): the writer's rules and the drafts board sit on
    // New ads, the consultation themes on Research, in that order in the paint.
    expect(html.indexOf('Rules the ad writer follows')).toBeLessThan(html.indexOf('soc-drafts-slot'));
    expect(html.indexOf('soc-drafts-slot')).toBeLessThan(html.indexOf('What GPs ask about'));
    expect(html).toContain('data-subpanel="research" style="display:none"');
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

// 2026-11-08: four sub-tabs and ONE "Do today" list. The review used to be
// drawn five times (headline actions, verdicts, account changes, improvements,
// briefs); now each point appears once, in the group where it is acted on,
// and the tick-and-Submit list for account changes keeps every state it had.
describe('Ads hub sub-tabs and the single Do today list', () => {
  const off = fx.offPhase();
  const night = meta.assembleSnapshot({ config: meta.adsConfig({}), now: OFF_NOW, adsets: off.adsets, ads: off.ads, rules: fx.rules, insights: fx.insights, daily: fx.daily, leadRows: fx.leadRows });
  const liveAdId = String((night.ads.find((a) => a.rotation === 'live' || a.rotation === 'scheduled_off') || night.ads[0]).id);
  const REVIEW = {
    headline: 'A weak week for bookings: fresh creative and a sharper Hazel call, not more budget.',
    summary: 'Spend was flat and leads fell from 12 to 10.',
    actions_today: [
      { action: 'Rewrite Hazel\'s opening and close. Open with the headline the lead clicked. Ask one question about when they might move. Then offer two specific call times in the next 48 hours.', why: 'This week Hazel spoke to 6 leads and booked 1.', where: 'automation' },
      { action: 'Add a required question to the instant form: are you a fully qualified GP or a GP trainee?', why: 'Two non-GPs took consultation slots.', where: 'ads_manager' },
      { action: 'Schedule two organic posts this week that reuse the No QOF line.', why: '0 posts went out last week.', where: 'none' }
    ],
    ad_verdicts: [{ ad_id: liveAdId, verdict: 'pause', reason: 'Below the 4% click-to-lead rule.' }],
    improvements: [
      { id: 'imp-17', title: 'Make Hazel\'s call end in a booking', change: 'Open with the ad\'s headline. Ask one question about when they might move. Offer two named slots in the next 48 hours.', evidence: 'Hazel spoke to 6 leads and booked 1.', applies_to: 'automation', priority: 1 },
      { id: 'imp-11', title: 'Make Hazel and the chase reach more leads', change: 'Leave a short voicemail plus an instant text with the booking link. Add a third attempt the next day.', evidence: '574 of 1,000 calls went unanswered.', applies_to: 'automation', priority: 1 },
      { id: 'imp-16', title: 'Pair the after-led line with an Australian photo', change: 'Any headline about life after the move gets an Australian setting.', evidence: 'No QOF on a sunny practice photo booked 13 of 34 leads.', applies_to: 'image', priority: 2 },
      { id: 'imp-2', title: 'Lead with a UK GP moment', change: 'Open on a UK scene, never on Australia is hiring.', evidence: 'Generic headlines booked 1 of 7.', applies_to: 'headline', priority: 3 }
    ],
    account_changes: [
      { id: 'chg-1', title: 'Pause the Dark in, dark out ad', action: 'pause_ad', label: 'Pause ad', effect: 'Pauses the ad on Meta.', why: 'Only 1.9% of link clicks became leads.', priority: 1, target_id: liveAdId, applied: null },
      { id: 'chg-2', title: 'Launch No QOF on a suburban photo', action: 'create_ad', label: 'New ad', effect: 'Writes, photographs and launches it.', why: 'The best booker in the account.', priority: 1, target_id: '06-no-qof', applied: { ok: true, at: '2026-11-08T05:00:00Z', message: 'Written as draft 1' } }
    ],
    what_works: [{ pattern: 'After-led jargon over a sunny practice photo', evidence: 'Booked 13 of 34 leads.', ad_ids: [liveAdId] }],
    what_doesnt: [{ pattern: 'Generic hiring headlines', evidence: '1 of 7 booked.', ad_ids: [] }],
    new_ad_briefs: [],
    todos: { 'act-2': { done_at: '2026-11-08T06:00:00Z' } }
  };
  function withReview() {
    return Object.assign(payloadWith(night), { review: { id: 'rev-1', kind: 'daily', created_at: '2026-11-08T05:31:00Z', model: 'claude-opus-5-5', review: REVIEW }, drafts: [{ id: 'd1', status: 'draft' }, { id: 'd2', status: 'archived' }] });
  }
  function count(html, needle) { return (html.split(needle).length - 1); }

  it('draws four sub-tabs with Today showing and the others hidden, and counts what is open', async () => {
    const html = await renderHub(withReview());
    expect(html).not.toContain('hit an error while drawing');
    expect(count(html, 'data-act="subtab"')).toBe(4);
    expect(html).toContain('data-subtab="today" role="tab" aria-selected="true"');
    expect(html).toContain('<div class="mk-subpanel" data-subpanel="today">');
    ['creatives', 'newads', 'research'].forEach((k) => expect(html).toContain('data-subpanel="' + k + '" style="display:none"'));
    // 1 open account change + 3 undone to-dos; 7 running creatives; 1 non-archived draft.
    expect(html).toContain('Today <span class="ats-count-chip">4</span>');
    expect(html).toContain('Creatives <span class="ats-count-chip">7</span>');
    expect(html).toContain('New ads <span class="ats-count-chip">1</span>');
  });

  it('keeps the tick-and-Submit list for account changes exactly as it was, inside the On Meta group', async () => {
    const html = await renderHub(withReview());
    expect(html).toContain('<div class="mk-do-group mk-changes">');
    expect(count(html, 'class="mk-chg-check"')).toBe(2);
    expect(html).toContain('<input type="checkbox" class="mk-chg-check" value="chg-1" checked>');
    expect(html).toContain('<input type="checkbox" class="mk-chg-check" value="chg-2" disabled>');
    expect(html).toContain('<span class="mk-chg-state ok">✓ Applied · ');
    expect(html).toContain('Written as draft 1');
    expect(count(html, 'data-act="apply-changes"')).toBe(1);
    expect(html).toContain('Submit ticked changes</button><span class="mk-apply-count">1 waiting</span>');
    expect(html).toContain('<summary>How it applies them</summary>');
    expect(html).toContain('a pause that would empty the ad set is refused');
  });

  it('automation changes get their own tick-and-Submit list inside In the app, with the settings in force behind a disclosure', async () => {
    const review = Object.assign({}, REVIEW, { automation_changes: [
      { id: 'aut-1', lever: 'hazel.max_attempts', value: 3, label: 'Hazel', title: 'Give Hazel a third attempt', effect: 'Hazel tries each lead up to 3 times (was 2).', why: '574 of 1,000 calls went unanswered.', priority: 1, applied: null },
      { id: 'aut-2', lever: 'noshow.grace_min', value: 120, label: 'No-show sweep', title: 'Judge no-shows sooner', effect: 'A booking is judged 2 hours after its slot (was 3 hours).', why: 'Bookings sat unmarked.', priority: 2, applied: { ok: true, at: '2026-11-08T07:00:00Z', message: 'A booking is judged 2 hours after its slot (was 3 hours).' } }
    ] });
    const payload = Object.assign(withReview(), { automation: { settings: { 'hazel.max_attempts': 2 }, levers: [
      { key: 'hazel.max_attempts', group: 'Hazel', label: 'Hazel: call attempts per lead', display: '2' },
      { key: 'chase.step1_min', group: 'Chase sequence', label: 'Chase: first WhatsApp after the form', display: '5 min' }
    ] } });
    payload.review = Object.assign({}, payload.review, { review });
    const html = await renderHub(payload);
    expect(html).not.toContain('hit an error while drawing');
    expect(html).toContain('<div class="mk-do-group mk-automation">');
    expect(html).toContain('Tick the changes and press Submit: the app changes its own settings at once.');
    expect(html).toContain('<input type="checkbox" class="mk-auto-check" value="aut-1" checked>');
    expect(html).toContain('<input type="checkbox" class="mk-auto-check" value="aut-2" disabled>');
    expect(html).toContain('Hazel tries each lead up to 3 times (was 2).');
    expect(html).toContain('<span class="mk-chg-state ok">✓ Changed · ');
    expect(count(html, 'data-act="apply-automation"')).toBe(1);
    expect(html).toContain('Submit ticked changes</button><span class="mk-apply-count">1 waiting</span>');
    expect(html).toContain('<summary>What the automation is set to now</summary>');
    expect(html).toContain('<li><span>Chase: first WhatsApp after the form</span><strong>5 min</strong></li>');
    // The to-dos no lever reaches still sit in the same group, and the open count grows by one.
    expect(html).toContain('data-key="act-0"');
    expect(html).toContain('Today <span class="ats-count-chip">5</span>');
    // The Meta list is untouched.
    expect(count(html, 'class="mk-chg-check"')).toBe(2);
  });

  it('shows every review point once: an automation improvement an action already carries out is folded into it', async () => {
    const html = await renderHub(withReview());
    // Three actions + the one automation improvement no action covers (imp-11); imp-17 is folded into action 0.
    expect(count(html, 'class="mk-todo-check"')).toBe(4);
    expect(count(html, 'Make Hazel&#39;s call end in a booking')).toBe(1);
    expect(count(html, 'Rewrite Hazel&#39;s opening and close.')).toBe(1);
    expect(html).toContain('data-key="act-0"');
    expect(html).toContain('data-key="imp-11"');
    expect(html).not.toContain('data-key="imp-17"');
    // Grouped by where it happens: the form question sits with Meta, Hazel in the app, organic elsewhere.
    expect(html.indexOf('<strong>On Meta</strong>')).toBeLessThan(html.indexOf('are you a fully qualified GP'));
    expect(html.indexOf('are you a fully qualified GP')).toBeLessThan(html.indexOf('<strong>In the app</strong>'));
    expect(html.indexOf('<strong>In the app</strong>')).toBeLessThan(html.indexOf('Rewrite Hazel'));
    expect(html.indexOf('<strong>Elsewhere</strong>')).toBeLessThan(html.indexOf('Schedule two organic posts'));
    // The stored tick is drawn ticked and greyed.
    expect(html).toContain('data-key="act-2" checked>');
    expect(html).toContain('<li class="mk-imp mk-todo is-done">');
    expect(count(html, '✓ Done · ')).toBe(1);
    // No second copy of the review anywhere else on the page.
    expect(html).not.toContain('What to do today');
    expect(html).not.toContain('Suggested improvements');
  });

  it('turns the creative improvements into the writer\'s rules on New ads, still wired to Generate', async () => {
    const html = await renderHub(withReview());
    expect(html).toContain('Rules the ad writer follows <span class="ats-count-chip">2</span>');
    expect(count(html, 'class="mk-imp-check"')).toBe(2);
    expect(html).toContain('<input type="checkbox" class="mk-imp-check" value="imp-16" checked>');
    expect(html).toContain('<input type="checkbox" class="mk-imp-check" value="imp-2" checked>');
    expect(html).not.toContain('class="mk-imp-check" value="imp-17"');
    expect(html).toContain('id="mkGenCount"');
    expect(html).toContain('id="mkGenInstr"');
    expect(count(html, 'data-act="generate"')).toBe(1);
    expect(html.indexOf('data-subpanel="newads"')).toBeLessThan(html.indexOf('Rules the ad writer follows'));
  });

  it('puts the verdict on the card and the evidence under the creatives, naming the ads', async () => {
    const html = await renderHub(withReview());
    expect(html).toContain('<span class="mk-verdict ats-pill red">pause</span>');
    expect(html).toContain('<div class="mk-verdict-reason"><strong>pause:</strong> Below the 4% click-to-lead rule.</div>');
    expect(count(html, '<summary>Details</summary>')).toBe(7);
    expect(html).toContain('<h3>Evidence behind today\'s call</h3>');
    expect(count(html, 'What works, and why')).toBe(1);
    expect(html).toContain('<span class="mk-adrefs">');
    expect(html.indexOf('Creatives running')).toBeLessThan(html.indexOf('Evidence behind today'));
  });

  it('reads the review headline once, on Today, with the after-the-form line folded to a click', async () => {
    const html = await renderHub(withReview());
    expect(count(html, 'A weak week for bookings')).toBe(1);
    expect(html).toContain('<h3>Today\'s review</h3>');
    expect(html).toContain('Morning review · ');
    expect(html).toContain('<div id="soc-range-root"></div>');
    expect(html.indexOf('<h3>This week</h3>')).toBeLessThan(html.indexOf('<h3>Today\'s review</h3>'));
  });
});
