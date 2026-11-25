// Australian GP build, WP-30: the screens. The practice intake page (the
// practice is shown what was found, not asked), and the staff area panel
// (js/au-practice-area.js) on the practice and job screens.
// There is no browser here: the page code is run against small stand-ins.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const site = require('../lib/site-au-pages.js');
const area = require('../lib/au-practice-area.js');
const locator = require('../lib/au-workforce-locator.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// FR-9 (M9-06, deliberate): the consequence now says the whole truth: a role that is "not confirmed"
// is closed to EVERY doctor who may only work in a priority area, which includes doctors moving to
// Australia from overseas. Who is hidden did not change; only the words did.
const CONSEQUENCE = 'Not confirmed: hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas) until it is confirmed';

// ───────────────────────── the practice intake page ─────────────────────────

const INTAKE_ON = site.renderSource(read('pages/practice-intake.html'), { on: true }).html;
const INTAKE_OFF = site.renderSource(read('pages/practice-intake.html'), { on: false }).html;

function inlineScripts(html) {
  const out = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

describe('practice intake page: files', () => {
  it('every inline script still parses, switch on and off, and holds no stray control characters', () => {
    for (const html of [INTAKE_ON, INTAKE_OFF]) {
      const scripts = inlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const src of scripts) expect(() => new vm.Script(src)).not.toThrow();
      expect(html).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    }
  });
  it('WP-30\'s code exists only with the switch on', () => {
    expect(INTAKE_ON).toContain('/api/practice-intake/area');
    expect(INTAKE_ON).toContain('This looks wrong');
    expect(INTAKE_OFF).not.toContain('/api/practice-intake/area');
    expect(INTAKE_OFF).not.toContain('This looks wrong');
    expect(INTAKE_OFF).not.toContain('auLoc');
  });
  it('the block wraps the page\'s own functions rather than editing them', () => {
    const start = INTAKE_ON.indexOf('// WP-30 (Australian GP build)');
    const end = INTAKE_ON.indexOf('// ===================== end WP-30');
    expect(start).toBeGreaterThan(INTAKE_ON.indexOf('// ===================== end WP-23'));
    expect(end).toBeGreaterThan(start);
    for (const name of ['checkDpa', 'paintDpaSuggestion', 'dpaUnavailable', 'resetLocation', 'restoreDraft', 'editPrac', 'addAnother', 'renderList']) {
      expect(INTAKE_ON.slice(start, end)).toMatch(new RegExp('\\n  ' + name + ' = function'));
    }
  });
});

/** Runs the WP-30 block of the page against stand-ins for the page around it. */
function intakeHarness(opts) {
  const o = opts || {};
  const start = INTAKE_ON.indexOf('  var auLocTimer = null, auLocSeq = 0;');
  const end = INTAKE_ON.indexOf('  // ===================== end WP-30');
  const block = INTAKE_ON.slice(start, end);
  const els = {};
  const classList = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c), list: s }; };
  const el = (id) => {
    if (!els[id]) {
      const e = { id, _className: '', textContent: '', innerHTML: '', style: {}, value: '', disabled: false, placeholder: '', classList: classList(), focus() {}, querySelector: (sel) => el(id + ' ' + sel) };
      Object.defineProperty(e, 'className', { get() { return e._className; }, set(v) { e._className = v; } });
      Object.defineProperty(e, 'parentNode', { get() { return el(id + '^'); } });
      els[id] = e;
    }
    return els[id];
  };
  const calls = { base: [], fetch: [], timers: [], gate1: 0, gate2: 0, persist: 0, listeners: {} };
  const state = {
    cur: Object.assign({ address: '', suburb: '', state: '', postcode: '', latitude: null, longitude: null, google_place_id: '', dpa: null, dpaSuggested: null, mmm: null, practice_name: 'WP30 Page Practice (FAKE)' }, o.cur || {}),
    saved: o.saved || [],
    currentPractice: { au_gp: o.locator === false ? { dpa_lookup: 'unknown' } : { dpa_lookup: 'unknown', locator: { on: true } } }
  };
  const fetchStub = (url, init) => {
    const call = { url, body: JSON.parse(init.body) };
    calls.fetch.push(call);
    return new Promise((resolve, reject) => { call.resolve = (json) => resolve({ json: () => Promise.resolve(json) }); call.reject = reject; });
  };
  const base = (name, ret) => function () { calls.base.push([name].concat([].slice.call(arguments))); return ret; };
  const listRows = (o.listRows || []).map((html) => ({ innerHTML: html }));
  const names = ['cur', 'saved', 'token', 'currentPractice', '$', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'escapeHtml',
    'checkDpa', 'paintDpaSuggestion', 'dpaUnavailable', 'resetLocation', 'restoreDraft', 'editPrac', 'addAnother', 'renderList',
    'gate1', 'gate2', 'persistSoon', 'auOf', 'auApplyDpa', 'auPaint'];
  const auOf = (p) => { if (!p.au) p.au = { types: { overseas: false }, dpaAnswer: '', overseasTouched: false }; return p.au; };
  const values = [state.cur, state.saved, 'tok-' + 'x'.repeat(20), state.currentPractice, el,
    { addEventListener: (type, fn) => { calls.listeners[type] = fn; }, querySelectorAll: () => listRows },
    fetchStub, (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; }, () => {},
    (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    base('checkDpa'), base('paintDpaSuggestion'), base('dpaUnavailable'), base('resetLocation'), base('restoreDraft', o.restored !== false), base('editPrac'), base('addAnother'), base('renderList'),
    () => { calls.gate1 += 1; }, () => { calls.gate2 += 1; }, () => { calls.persist += 1; }, auOf,
    (a) => { if (a.dpaAnswer !== 'yes') a.types.overseas = false; else if (!a.overseasTouched) a.types.overseas = true; }, () => {}];
  const api = new Function(...names, block + '\n return { checkDpa: function () { return checkDpa(); }, paintDpaSuggestion: function () { return paintDpaSuggestion(); }, dpaUnavailable: function (r) { return dpaUnavailable(r); },' +
    ' resetLocation: function () { return resetLocation(); }, restoreDraft: function () { return restoreDraft(); }, editPrac: function (i) { return editPrac(i); }, renderList: function () { return renderList(); }, cur: cur };')(...values);
  return { api, calls, el, state, listRows, flush: () => new Promise((r) => setImmediate(r)) };
}

describe('practice intake page: the practice is shown what was found, not asked', () => {
  const dubbo = { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', latitude: null, longitude: null, google_place_id: '' };

  it('with no provider the page asks exactly as before: every wrapped function hands straight back', () => {
    const t = intakeHarness({ locator: false, cur: dubbo });
    t.api.checkDpa(); t.api.paintDpaSuggestion(); t.api.dpaUnavailable('reason'); t.api.resetLocation(); t.api.restoreDraft(); t.api.editPrac(0); t.api.renderList();
    expect(t.calls.base.map((c) => c[0])).toEqual(['checkDpa', 'paintDpaSuggestion', 'dpaUnavailable', 'resetLocation', 'restoreDraft', 'editPrac', 'renderList']);
    expect(t.calls.base[2][1]).toBe('reason');
    expect(t.calls.fetch).toEqual([]);
    expect(t.calls.timers).toEqual([]);
    expect(t.state.cur.dpa).toBe(null);
    expect(t.el('aiDpa .seg').classList.contains('hidden')).toBe(false);
  });

  it('after the address step it asks the server (once the typing stops), never the old browser check, and never blocks the form', async () => {
    const t = intakeHarness({ cur: dubbo });
    t.api.checkDpa();
    expect(t.calls.base).toEqual([]);                       // the old check is not run
    expect(t.calls.fetch).toEqual([]);                      // debounced
    expect(t.calls.timers.length).toBe(1);
    expect(t.calls.timers[0].ms).toBeGreaterThanOrEqual(500);
    // meanwhile: "not confirmed", so Next is never held up by the look-up
    expect(t.state.cur).toMatchObject({ dpa: false, dpaSuggested: null });
    expect(t.state.cur.au.dpaAnswer).toBe('unsure');
    expect(t.el('aiT').textContent).toMatch(/Checking your address/);
    expect(t.el('aiDpa .seg').classList.contains('hidden')).toBe(true);   // the yes / no / not sure buttons are gone
    expect(t.el('dpaHint^ .must').style.display).toBe('none');            // and it is no longer "REQUIRED"
    expect(t.el('dpaHint').textContent).toMatch(/You do not need to answer/);

    t.calls.timers[0].fn();
    expect(t.calls.fetch.length).toBe(1);
    expect(t.calls.fetch[0].url).toBe('/api/practice-intake/area');
    expect(t.calls.fetch[0].body).toMatchObject({ address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
    expect(t.calls.fetch[0].body.token.length).toBeGreaterThan(16);
    expect(Object.keys(t.calls.fetch[0].body)).not.toContain('dpa');

    t.calls.fetch[0].resolve({ ok: true, finding: { state: 'yes', line: 'Your practice is in a Distribution Priority Area for GPs · Modified Monash 3' } });
    await t.flush(); await t.flush();
    expect(t.state.cur).toMatchObject({ dpa: true, dpaSuggested: true });
    expect(t.state.cur.au.dpaAnswer).toBe('yes');
    expect(t.state.cur.au.types.overseas).toBe(true);
    expect(t.el('aiT').textContent).toBe('What we found for your address');
    expect(t.el('aiP').innerHTML).toContain('Your practice is in a Distribution Priority Area for GPs · Modified Monash 3');
    expect(t.el('aiP').innerHTML).toContain('This looks wrong');
    expect(t.el('aiP').innerHTML).not.toMatch(/<button[^>]*data-action="set-dpa"/);
    expect(t.calls.gate1).toBeGreaterThan(0);
    expect(t.calls.persist).toBeGreaterThan(0);
  });

  it('not in a DPA, and "we will confirm" when not confident or when the request fails', async () => {
    const no = intakeHarness({ cur: dubbo });
    no.api.checkDpa(); no.calls.timers[0].fn();
    no.calls.fetch[0].resolve({ ok: true, finding: { state: 'no', line: 'Your practice is not in a Distribution Priority Area for GPs · Modified Monash 1' } });
    await no.flush(); await no.flush();
    expect(no.state.cur).toMatchObject({ dpa: false, dpaSuggested: false });
    expect(no.state.cur.au.dpaAnswer).toBe('no');
    expect(no.el('aiP').innerHTML).toContain('not in a Distribution Priority Area');

    for (const reply of [{ ok: true, finding: { state: 'unknown', line: 'We\'ll confirm your area with you' } }, { ok: false }, null, { ok: true, finding: { state: 'YES!', line: 'x' } }]) {
      const t = intakeHarness({ cur: dubbo });
      t.api.checkDpa(); t.calls.timers[0].fn();
      t.calls.fetch[0].resolve(reply);
      await t.flush(); await t.flush();
      expect(t.state.cur).toMatchObject({ dpa: false, dpaSuggested: null });
      expect(t.state.cur.au.dpaAnswer).toBe('unsure');
      expect(t.state.cur.auArea.state).toBe('unknown');
    }
    const failed = intakeHarness({ cur: dubbo });
    failed.api.checkDpa(); failed.calls.timers[0].fn();
    failed.calls.fetch[0].reject(new Error('offline'));
    await failed.flush(); await failed.flush();
    expect(failed.state.cur.auArea).toEqual({ state: 'unknown', line: 'We\'ll confirm your area with you' });
    expect(failed.el('aiP').innerHTML).toContain('We&#39;ll confirm your area with you');
    // FR-9 (M9-06, deliberate): the practice is no longer told "This does not hold anything up" (it was not true).
    expect(failed.el('aiP').innerHTML).not.toMatch(/does not hold anything up/);
    expect(failed.el('aiP').innerHTML).toMatch(/Until they have, your role is not shown to doctors who may only work in a priority area \(that includes doctors moving to Australia from overseas\)\. Other doctors can still see it\./);
  });

  it('an answer for an address the practice has since changed is ignored', async () => {
    const t = intakeHarness({ cur: dubbo });
    t.api.checkDpa(); t.calls.timers[0].fn();
    t.api.checkDpa();                                        // they kept typing
    t.calls.fetch[0].resolve({ ok: true, finding: { state: 'yes', line: 'stale' } });
    await t.flush(); await t.flush();
    expect(t.state.cur.dpa).toBe(false);
    expect(t.state.cur.auArea.pending).toBe(true);
  });

  it('"This looks wrong" sends a note and changes nothing shown', async () => {
    const t = intakeHarness({ cur: Object.assign({}, dubbo, { auArea: { state: 'no', line: 'Your practice is not in a Distribution Priority Area for GPs · Modified Monash 1' }, dpa: false }) });
    t.api.paintDpaSuggestion();
    const click = t.calls.listeners.click;
    const target = (action) => ({ closest: () => ({ getAttribute: () => action, disabled: false }) });
    click({ target: target('area-wrong'), preventDefault() {} });
    t.el('auAreaWrongNote').value = 'We are in the next catchment';
    click({ target: target('area-wrong-send'), preventDefault() {} });
    expect(t.calls.fetch.length).toBe(1);
    expect(t.calls.fetch[0].url).toBe('/api/practice-intake/area-note');
    expect(t.calls.fetch[0].body).toMatchObject({ note: 'We are in the next catchment', clinic: 'WP30 Page Practice (FAKE)' });
    t.calls.fetch[0].resolve({ ok: true });
    await t.flush(); await t.flush();
    expect(t.state.cur.dpa).toBe(false);
    expect(t.state.cur.auArea).toMatchObject({ state: 'no', noted: true });
    expect(t.el('aiP').innerHTML).toMatch(/does not change until they have/);
    // an empty note is not sent
    const empty = intakeHarness({ cur: Object.assign({}, dubbo, { auArea: { state: 'no', line: 'x' } }) });
    empty.calls.listeners.click({ target: target('area-wrong-send'), preventDefault() {} });
    expect(empty.calls.fetch).toEqual([]);
  });

  it('reopening the link shows what was found, and looks it up again if that never finished', () => {
    const done = intakeHarness({ cur: Object.assign({}, dubbo, { auArea: { state: 'yes', line: 'Your practice is in a Distribution Priority Area for GPs · Modified Monash 3' } }) });
    expect(done.api.restoreDraft()).toBe(true);
    expect(done.calls.timers).toEqual([]);
    expect(done.el('aiP').innerHTML).toContain('Modified Monash 3');
    const pending = intakeHarness({ cur: Object.assign({}, dubbo, { auArea: { pending: true, state: 'unknown', line: 'x' } }) });
    pending.api.restoreDraft();
    expect(pending.calls.timers.length).toBe(1);
    const fresh = intakeHarness({ cur: dubbo });
    fresh.api.editPrac(0);
    expect(fresh.calls.timers.length).toBe(1);
  });

  it('the list of clinics does not call an unconfirmed area "not DPA"', () => {
    const rowHtml = 'bulk billing · GP keeps 70% · not DPA · 1 × Full-time · As soon as possible';
    const t = intakeHarness({ saved: [{ auArea: { state: 'unknown' } }, { auArea: { state: 'no' } }, {}], listRows: [rowHtml, rowHtml, rowHtml] });
    t.api.renderList();
    expect(t.listRows[0].innerHTML).toContain(' · area to be confirmed · ');
    expect(t.listRows[1].innerHTML).toContain(' · not DPA · ');
    expect(t.listRows[2].innerHTML).toContain(' · area to be confirmed · ');
    const off = intakeHarness({ locator: false, saved: [{ auArea: { state: 'unknown' } }], listRows: [rowHtml] });
    off.api.renderList();
    expect(off.listRows[0].innerHTML).toBe(rowHtml);
  });

  it('clearing the address clears what was found', () => {
    const t = intakeHarness({ cur: Object.assign({}, dubbo, { auArea: { state: 'yes', line: 'x' } }) });
    t.state.cur.address = '';
    t.api.resetLocation();
    expect(t.calls.base[0][0]).toBe('resetLocation');
    expect(t.state.cur.auArea).toBe(null);
    expect(t.el('aiDpa').className).toBe('ai');
  });
});

// ───────────────────────────── the staff screens ────────────────────────────

function loadStaffScript() {
  const listeners = {};
  const elements = {};
  const sandbox = {
    window: { confirm: () => true, prompt: () => 'A good enough reason', setTimeout: (fn) => { fn(); return 1; } },
    document: { addEventListener: (t, fn) => { listeners[t] = fn; }, getElementById: (id) => elements[id] || null }
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read('js/au-practice-area.js'), sandbox, { filename: 'au-practice-area.js' });
  return { G: sandbox.window.GPAuArea, listeners, elements, window: sandbox.window };
}

const T1 = '2026-11-26T00:00:00.000Z';
const T2 = '2026-11-27T00:00:00.000Z';
const KEY = locator.addressKey({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
const exactYes = { ok: true, provider: 'health_gov', dpaGp: 'yes', mmm: 3, confidence: 'exact', method: 'geocoded_address', classificationYear: { dpa: '2026', mmm: 2023 }, checkedAt: T1, pointUsed: { lat: -32.2569, lng: 148.6011, source: 'geocoded_address' }, catchment: 'Dubbo', warnings: [] };
const approx = Object.assign({}, exactYes, { dpaGp: 'unknown', mmmApproximate: true, confidence: 'approximate', method: 'suburb_centroid', indicative: { dpaGp: 'yes', catchment: 'Dubbo' }, warnings: ['address_not_precise'] });
const pinned = (record, over) => Object.assign({ id: 'prac-1', name: 'WP30 Screen Practice (FAKE)', address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', location_state: 'NSW', postcode: '2830', metadata: record ? { au_area: record } : {} }, over || {});
const lookup = (record, result, now) => area.applyLookup(record, result, { addressKey: KEY, trigger: 't', by: 'system', now: now || T1 }).record;
const practicePayload = (row, jobs) => {
  const roles = {};
  (jobs || []).forEach((j) => { roles[j.id] = area.staffRoleView(j, row); });
  return { id: row.id, name: row.name, au_area: area.staffView(row), au_area_roles: roles };
};

describe('staff area panel (js/au-practice-area.js)', () => {
  const { G } = loadStaffScript();

  it('parses, and draws nothing when the server sent nothing', () => {
    expect(() => new vm.Script(read('js/au-practice-area.js'))).not.toThrow();
    expect(read('js/au-practice-area.js')).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(G.practiceCardHtml({ id: 'p' }, [])).toBe('');
    expect(G.chipHtml(null)).toBe('');
    expect(G.jobSectionHtml(null, 'j')).toBe('');
    expect(G.approvalHtml(null)).toBe('');
    expect(G.approvalConfirmText(null)).toBe('');
  });

  it('the practice card: DPA, Modified Monash, confidence, source, years, date, the address checked, and Re-check', () => {
    const row = pinned(lookup(null, exactYes));
    const html = G.practiceCardHtml(practicePayload(row), []);
    for (const s of ['In a DPA', 'Large rural town (MM 3)', 'Automatic check', 'Exact (street address)', 'Health Workforce Locator (Department of Health)',
      'DPA: 2026', 'Modified Monash: 2023 edition', 'GP catchment: Dubbo', '2 Test Road, Dubbo NSW 2830', 'the street address, found to the building', '26 Nov 2026']) {
      expect(html, s).toContain(s);
    }
    expect(html).toContain('data-au-area="recheck"');
    expect(html).toContain('data-au-area="toggle-manual"');
    expect(html).toContain('data-au-area="toggle-address"');
    expect(html).not.toContain('data-au-area="clear-manual"');
    expect(html).not.toContain(CONSEQUENCE);
    expect(html).toContain('data-practice-id="prac-1"');
  });

  it('an unknown practice says what that means, and why', () => {
    const html = G.practiceCardHtml(practicePayload(pinned(lookup(null, approx))), []);
    expect(html).toContain('DPA not confirmed');
    expect(html).toContain(CONSEQUENCE);
    expect(html).toContain('approximately Large rural town (MM 3)');
    expect(html).toContain('Approximate (not the exact building)');
    expect(html).toMatch(/centre of the suburb is in a DPA\. That is a hint only: it is not used\./);
    expect(html).toMatch(/Only the suburb or street could be found, not the building/);
    // never checked is a different thing: nothing has been asked, and the roles keep their labels
    const never = G.practiceCardHtml(practicePayload(pinned(null, { dpa: true })), []);
    expect(never).not.toContain(CONSEQUENCE);
    expect(never).toContain('Area not checked yet');
    expect(never).toContain('Recorded earlier on this practice: In a DPA.');
    expect(never).toContain('Its roles keep the labels they have until this address is checked.');
    expect(never).toContain('Not run yet. Press Re-check.');
  });

  it('a value set by hand: who, when, why; and the disagreement banner with both values and both dates', () => {
    const set = area.applyManual(null, { dpa: 'no', mmm: 2, reason: 'Confirmed with <b>the practice</b>', by: 'ceo.test@gplink-test.local', now: T1, addressKey: KEY }).record;
    const row = pinned(lookup(set, Object.assign({}, exactYes, { checkedAt: T2 }), T2));
    const html = G.practiceCardHtml(practicePayload(row), []);
    expect(html).toContain('Not in a DPA');
    expect(html).toContain('Set by hand by ceo.test@gplink-test.local');
    expect(html).toContain('Reason: Confirmed with &lt;b&gt;the practice&lt;/b&gt;');
    expect(html).not.toContain('<b>the practice</b>');
    expect(html).toContain('The automatic check and the value set by hand disagree.');
    expect(html).toContain('The automatic check says in a DPA; the value set by hand says not in a DPA.');
    expect(html).toMatch(/Automatic check: In a DPA, MM 3 \(27 Nov 2026\)\. Set by hand: Not in a DPA, MM 2 by ceo\.test@gplink-test\.local \(26 Nov 2026\)\./);
    expect(html).toContain('data-au-area="clear-manual"');
  });

  it('what the practice said looked wrong is shown to staff', () => {
    const rec = area.addDispute(lookup(null, exactYes), 'We are <i>across</i> the river', T2);
    const html = G.practiceCardHtml(practicePayload(pinned(rec)), []);
    expect(html).toContain('The practice told us this looks wrong');
    expect(html).toContain('We are &lt;i&gt;across&lt;/i&gt; the river');
  });

  it('each role: its label, where it came from, and a decision when two answers differ', () => {
    const row = pinned(lookup(null, exactYes));
    const jobs = [
      { id: 'j1', title: 'Following role (FAKE)', dpa: true, dpa_status: 'yes', mmm: 'MM3', suburb: 'Dubbo', source_payload: { au_area: { follows: true, site: 'practice' } } },
      { id: 'j2', title: 'Recorded-before role (FAKE)', dpa: false, mmm: 'MM3', suburb: 'Dubbo', source_payload: {} },
      { id: 'j3', title: 'Unknown role (FAKE)', dpa: false, dpa_status: 'unknown', mmm: '', suburb: 'Dubbo', source_payload: {} }
    ];
    const decided = area.roleDecision(jobs[1], area.effective(row.metadata.au_area), { source: 'practice', now: T2 });
    jobs[1].source_payload = { au_area: decided.area };
    const html = G.practiceCardHtml(practicePayload(row, jobs), jobs);
    expect(html).toContain('Roles at this practice');
    expect(html).toContain('Following role (FAKE)');
    expect(html).toContain('Follows the practice');
    expect(html).toContain('Two different answers.');
    expect(html).toContain('The automatic check says in a DPA; the value already recorded on this role says not in a DPA.');
    expect(html).toContain('data-au-area="role-use" data-job="j2"');
    expect(html).toContain('data-au-area="role-keep" data-job="j2"');
    expect(html.split(CONSEQUENCE).length).toBe(2);   // only the unknown role
  });

  it('list chips and the Check all button', () => {
    expect(G.chipHtml({ checked: true, status: 'yes', label: 'In a DPA', mmmLabel: 'Large rural town (MM 3)', consequence: '', disagreement: false, disputes: 0 })).toBe('<span class="ats-pill green" title="">In a DPA</span><span class="ats-pill muted">Large rural town (MM 3)</span>');
    expect(G.chipHtml({ checked: false, status: 'unknown', label: 'Area not checked yet', consequence: '' })).toBe('<span class="ats-pill muted">Area not checked yet</span>');
    const unknown = G.chipHtml({ checked: true, status: 'unknown', label: 'DPA not confirmed', mmmLabel: '', consequence: CONSEQUENCE, disagreement: true, disputes: 1 });
    expect(unknown).toContain('ats-pill amber');
    expect(unknown).toContain('title="' + CONSEQUENCE + '"');
    expect(unknown).toContain('Area: two answers');
    expect(unknown).toContain('Practice queried its area');
    expect(G.checkAllButtonHtml()).toContain('data-au-area="check-all"');
    expect(G.checkAllButtonHtml()).toMatch(/never replaces a value set by hand/);
  });

  it('the job screen: labels, where they came from, Re-check, and how to set by hand', () => {
    const row = pinned(lookup(null, exactYes));
    const job = { id: 'j1', dpa: true, dpa_status: 'yes', mmm: 'MM3', suburb: 'Dubbo', source_payload: { au_area: { follows: true, site: 'practice' } } };
    const html = G.jobSectionHtml({ role: area.staffRoleView(job, row) }, 'j1');
    for (const s of ['Area labels on this role', 'In a DPA', 'Large rural town (MM 3)', 'Follows the practice', 'Health Workforce Locator (Department of Health)', 'data-au-area="job-recheck"', 'id="atsJsAreaReason"', 'data-job-id="j1"']) {
      expect(html, s).toContain(s);
    }
    const unknown = G.jobSectionHtml({ role: area.staffRoleView({ id: 'j2', dpa: false, dpa_status: 'unknown', suburb: 'Dubbo', source_payload: { au_area: { follows: true } } }, row) }, 'j2');
    expect(unknown).toContain(CONSEQUENCE);
  });

  it('job approval shows the labels and warns when the status is unknown or unsettled', () => {
    const row = pinned(lookup(null, exactYes));
    const known = { role: area.staffRoleView({ dpa: true, dpa_status: 'yes', mmm: 'MM3', source_payload: { au_area: { follows: true } } }, row) };
    expect(G.approvalHtml(known)).toContain('In a DPA');
    expect(G.approvalHtml(known)).toContain('Large rural town (MM 3)');
    expect(G.approvalConfirmText(known)).toBe('');
    const unknown = { role: area.staffRoleView({ dpa: false, dpa_status: 'unknown', source_payload: { au_area: { follows: true } } }, row) };
    expect(G.approvalHtml(unknown)).toMatch(/priority-area status is not confirmed.*hidden from every doctor who may only work in a priority area \(that includes doctors moving to Australia from overseas\)/);
    expect(G.approvalConfirmText(unknown)).toMatch(/not confirmed.*Approve anyway\?/);
    const split = { role: Object.assign({}, known.role, { disagreement: { message: 'Two answers.' } }) };
    expect(G.approvalConfirmText(split)).toMatch(/two different priority-area answers/);
  });

  it('the buttons post the right action, and the reason travels with a hand-set job value', async () => {
    const t = loadStaffScript();
    const posts = [];
    let refreshed = 0;
    t.G.bind({ api: (url, opts) => { posts.push({ url, body: opts.body }); return Promise.resolve({ ok: true, outcome: 'unchanged' }); }, toast: () => {}, refreshPractice: () => { refreshed += 1; } });
    t.elements.auAreaCard = { getAttribute: () => 'prac-9' };
    t.elements.auAreaManualDpa = { value: 'no' }; t.elements.auAreaManualMmm = { value: '2' }; t.elements.auAreaManualReason = { value: 'Checked by phone' };
    t.elements.auAreaAddrStreet = { value: '2 Test Road' }; t.elements.auAreaAddrSuburb = { value: 'Dubbo' }; t.elements.auAreaAddrState = { value: 'NSW' }; t.elements.auAreaAddrPostcode = { value: '2830' };
    const click = (action, job) => t.listeners.click({ target: { closest: () => ({ getAttribute: (n) => (n === 'data-au-area' ? action : job), disabled: false }) } });
    click('recheck'); click('save-manual'); click('clear-manual'); click('save-address'); click('role-use', 'job-1'); click('role-keep', 'job-2');
    await new Promise((r) => setImmediate(r));
    expect(posts).toEqual([
      { url: '/api/ats/practice/area', body: { id: 'prac-9', action: 'recheck' } },
      { url: '/api/ats/practice/area', body: { id: 'prac-9', action: 'manual', dpa: 'no', mmm: '2', reason: 'Checked by phone' } },
      { url: '/api/ats/practice/area', body: { id: 'prac-9', action: 'clear_manual' } },
      { url: '/api/ats/practice/area', body: { id: 'prac-9', action: 'set_address', address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' } },
      { url: '/api/ats/job/area', body: { action: 'use_lookup', id: 'job-1' } },
      { url: '/api/ats/job/area', body: { action: 'keep', reason: 'A good enough reason', id: 'job-2' } }
    ]);
    expect(refreshed).toBe(6);

    t.elements.atsJsAreaReason = { value: '  Branch surgery  ' };
    const changed = { dpa_status: 'no' }; t.G.collectJobReason(changed);
    expect(changed).toEqual({ dpa_status: 'no', au_area_reason: 'Branch surgery' });
    const untouched = { summary: 'x' }; t.G.collectJobReason(untouched);
    expect(untouched).toEqual({ summary: 'x' });
  });
});

describe('Check all practices, from the button', () => {
  it('walks until done, adds up the outcomes, and the summary is still there after the list is redrawn', async () => {
    const t = loadStaffScript();
    const status = { innerHTML: '' };
    t.elements.auAreaCheckAllStatus = status;
    const replies = [
      { ok: true, done: false, next_cursor: 'p:2', phase: 'practices', total_practices: 4, position: 3, items: [
        { kind: 'practice', id: '1', name: 'A (FAKE)', outcome: 'changed', roles: { applied: 2, disagreements: 0, manual_kept: 0 } },
        { kind: 'practice', id: '2', name: 'B <b>(FAKE)</b>', outcome: 'not_confident', roles: { applied: 0, disagreements: 0, manual_kept: 0 } },
        { kind: 'practice', id: '3', name: 'C (FAKE)', outcome: 'disagreed', roles: { applied: 0, disagreements: 0, manual_kept: 1 } }] },
      { ok: true, done: false, next_cursor: 'r:', phase: 'practices', total_practices: 4, position: 4, items: [
        { kind: 'practice', id: '4', name: 'D (FAKE)', outcome: 'unchanged', roles: { applied: 0, disagreements: 1, manual_kept: 0 } }] },
      { ok: true, done: true, next_cursor: '', phase: 'roles', items: [{ kind: 'role', id: 'r1', name: 'Loose role', outcome: 'applied' }] }
    ];
    const cursors = []; let redrawn = 0;
    t.G.bind({ api: (url, opts) => { cursors.push(opts.body.cursor); return Promise.resolve(replies.shift()); }, toast: () => {}, refreshList: () => { redrawn += 1; status.innerHTML = ''; } });
    t.listeners.click({ target: { closest: () => ({ getAttribute: () => 'check-all' }) } });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(cursors).toEqual(['', 'p:2', 'r:']);
    expect(redrawn).toBe(1);
    const summary = t.G.checkAllButtonHtml();
    expect(summary).toContain('<b>Finished.</b> 4 practices checked: 1 changed, 1 unchanged, 1 not confident, 1 disagreed with a value set by hand, 0 could not be checked.');
    expect(summary).toContain('Roles: 2 updated, 1 need a decision, 1 set by hand and left alone, 1 roles with no practice record checked.');
    expect(summary).toContain('Needs a look: B &lt;b&gt;(FAKE)&lt;/b&gt; (not confident); C (FAKE) (disagrees with a value set by hand); D (FAKE) (a role needs a decision)');
  });
});

describe('the staff screens are wired, and the changed scripts were re-versioned', () => {
  const ceo = read('pages/ceo-dashboard.html');
  const practicesJs = read('js/ceo-ats-practices.js');
  const jobsJs = read('js/ceo-ats-jobs.js');
  it('the dashboard loads the panel before the two scripts that use it', () => {
    const at = (s) => ceo.indexOf(s);
    expect(at('<script src="/js/au-practice-area.js?v=20261126a"></script>')).toBeGreaterThan(0);
    expect(at('/js/au-practice-area.js?v=20261126a')).toBeLessThan(at('/js/ceo-ats-jobs.js?v=20261126a'));
    expect(at('/js/ceo-ats-jobs.js?v=20261126a')).toBeLessThan(at('/js/ceo-ats-practices.js?v=20261126a'));
    expect(ceo).not.toContain('ceo-ats-jobs.js?v=20261123a');
    expect(ceo).not.toContain('ceo-ats-practices.js?v=20261123a');
    expect(read('sw.js')).toContain('var VERSION = "20261126a"');
  });
  it('practices: the card, the chip, and Check all (CEO only)', () => {
    expect(practicesJs).toContain("auAreaCardHtml(p, jobs) + contractCardHtml(p) + auGpCardHtml(p) + '</div>'");
    expect(practicesJs).toContain('window.GPAuArea.chipHtml(p.au_area)');
    // an unchecked practice keeps the pill it always had (the WP-23 one), with a quiet note beside it
    // FR-9 (M9-01, deliberate): an address change with no answer for the new address also reads from the area chip.
    expect(practicesJs).toContain("var auAreaChecked = !!(p.au_area && (p.au_area.checked || p.au_area.movedUnanswered) && window.GPAuArea);");
    expect(practicesJs).toContain('auAreaCheckAllHtml(practices) +');
    const fn = practicesJs.slice(practicesJs.indexOf('  function auAreaCheckAllHtml(practices) {'), practicesJs.indexOf('  function practiceCardHtml(p) {'));
    const run = (isConsultant, practices, hasPanel) => new Function('ATS', 'window', fn + '\n return auAreaCheckAllHtml;')(
      { isConsultant: () => isConsultant }, hasPanel === false ? {} : { GPAuArea: { checkAllButtonHtml: () => 'BUTTON' } })(practices);
    expect(run(false, [{ au_area: {} }])).toBe('BUTTON');
    expect(run(true, [{ au_area: {} }])).toBe('');            // a consultant is not offered it
    expect(run(false, [{}, {}])).toBe('');                    // the server is not sending area labels: nothing is drawn
    expect(run(false, [{ au_area: {} }], false)).toBe('');
  });
  it('jobs: the panel in the editor, the reason on save, the labels and the warning at approval', () => {
    expect(jobsJs).toContain('window.GPAuArea.jobSectionHtml(auAreaEditor, currentBoardJobId)');
    expect(jobsJs).toContain('window.GPAuArea.collectJobReason(body)');
    expect(jobsJs).toContain('window.GPAuArea.approvalHtml(approvalArea)');
    expect(jobsJs).toContain('window.GPAuArea.approvalConfirmText(approvalArea)');
    expect(jobsJs).toContain("auAreaEditor = e.au_area || null;");
  });
});
