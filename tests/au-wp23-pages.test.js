// Australian GP build, WP-23: the employers page, the practice FAQ, the
// practice lead form's script and the practice intake page.
//   switch OFF: every one of them is the file on origin/main, byte for byte
//   switch ON:  the local-GP track, the rewritten DPA answer, the three DPA
//               outcomes on the lead form, and the GP-types question
// There is no jsdom: page script is checked by parsing it and by running the
// extracted functions against small stand-ins.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const site = require('../lib/site-au-pages.js');
const gp = require('../lib/practice-gp-types.js');
const words = require('./helpers/au-banned-words.js');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const snapshot = JSON.parse(read('tests/fixtures/au-wp23-switch-off.snapshot.json'));
const render = (rel, on) => site.renderPageFile('/' + rel, { on, root: ROOT });
function mainBytes(rel) {
  try { return execFileSync('git', ['show', 'origin/main:' + rel], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return null; }
}
const noComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, ' ');
function visibleText(html) {
  const h = noComments(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  return words.htmlText(h).replace(/\s+/g, ' ');
}
function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc=/.test(m[1]) && !/application\/ld\+json/.test(m[1])).map((m) => m[2]);
}
const EMPLOYERS = 'pages/site-employers.html';
const FAQ = 'pages/site-faq.html';
const INTAKE = 'pages/practice-intake.html';

describe('switch off: byte for byte the files on origin/main', () => {
  it('the practice intake page (served through the marker resolver from now on)', () => {
    expect(site.isMarkedPagePath('/' + INTAKE)).toBe(true);
    expect(site.isSitePagePath('/' + INTAKE)).toBe(false);
    const off = render(INTAKE, false);
    expect(off.ok).toBe(true);
    const fromGit = mainBytes(INTAKE);
    if (fromGit) expect(off.body.equals(fromGit)).toBe(true);
    // and it is what the real server sent before WP-23 (recorded then)
    expect(sha(off.body)).toBe(snapshot.files.intakePage.sha256);
    expect(off.body.length).toBe(snapshot.files.intakePage.bytes);
  });

  it('the employers page and the FAQ', () => {
    for (const rel of [EMPLOYERS, FAQ]) {
      const off = render(rel, false);
      expect(off.ok).toBe(true);
      const fromGit = mainBytes(rel);
      if (fromGit) expect(off.body.equals(fromGit), rel).toBe(true);
      expect(off.html).toContain('site.css');
    }
    expect(render(EMPLOYERS, false).html).toContain('<script src="/js/site-practice-lead.js?v=20260722c"></script>');
    expect(render(EMPLOYERS, false).html).not.toContain('site-practice-lead-au.js');
  });

  it('the live lead-form script is untouched', () => {
    const live = fs.readFileSync(path.join(ROOT, 'js/site-practice-lead.js'));
    expect(sha(live)).toBe(snapshot.files.leadScript.sha256);
    const fromGit = mainBytes('js/site-practice-lead.js');
    if (fromGit) expect(live.equals(fromGit)).toBe(true);
  });

  it('markers are sound, none reaches a visitor, and every inline script parses raw, off and on', () => {
    for (const rel of [EMPLOYERS, FAQ, INTAKE]) {
      const raw = read(rel);
      expect(site.parseMarkers(raw).errors, rel).toEqual([]);
      for (const on of [false, true]) {
        const page = render(rel, on);
        expect(page.ok).toBe(true);
        expect(page.html).not.toMatch(/<!--\/?au:/);
        for (const code of inlineScripts(page.html)) expect(() => new vm.Script(code)).not.toThrow();
      }
      for (const code of inlineScripts(raw)) expect(() => new vm.Script(code)).not.toThrow();
      expect(raw).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    }
  });
});

describe('employers page, switch on: both audiences, with a clear local-GP track', () => {
  const on = render(EMPLOYERS, true).html;
  const off = render(EMPLOYERS, false).html;
  const text = visibleText(on);
  const added = (() => {
    // the sentences that exist only with the switch on
    const before = new Set(visibleText(off).split(/(?<=[.?!])\s+/));
    return text.split(/(?<=[.?!])\s+/).filter((s) => !before.has(s)).join(' ');
  })();

  it('head tags name both audiences', () => {
    expect(on).toContain('<title>Hire GPs for Your Practice: Australian-Registered and Overseas-Trained | GP Link</title>');
    expect(on).not.toContain('<title>Hire Overseas-Trained GPs for Your Practice | GP Link</title>');
    const desc = /<meta name="description" content="([^"]*)">/.exec(on)[1];
    expect(desc).toMatch(/already registered and working here/);
    expect(desc).toMatch(/outside a Distribution Priority Area/);
    expect(/<meta property="og:title" content="([^"]*)">/.exec(on)[1]).toBe('Hire GPs for Your Practice: Australian-Registered and Overseas-Trained | GP Link');
    expect(/<meta property="og:description" content="([^"]*)">/.exec(on)[1]).toBe(desc);
    expect(on).toContain('<link rel="canonical" href="https://www.mygplink.com.au/employers">');
  });

  it('the local track says what is true, in the careful form', () => {
    expect(on).toContain('id="local-gps"');
    expect(text).toContain('GPs already registered in Australia');
    expect(text).toContain('No visa and no registration wait. An Australian vocationally registered GP can start once they have worked out their notice with their current practice.');
    expect(text).toContain('For GPs without location or supervision restrictions, your practice does not need to be in a Distribution Priority Area and there is no supervision arrangement to set up.');
    expect(text).toContain('we cannot promise that a GP is available for a particular suburb at a particular time');
    expect(text).toContain('Hire your next GP, already here or moving to Australia');
  });

  it('the overseas track is still there', () => {
    expect(text).toContain('Overseas-trained GPs moving to Australia');
    expect(text).toContain('Three things that make hiring overseas GPs simple');
    expect(text).toContain('These doctors generally need a practice in a Distribution Priority Area to bill Medicare.');
  });

  it('nothing promised: no number of weeks, no "any location", no guarantee, no availability claim', () => {
    expect(added).not.toMatch(/\bweeks?\b/i);
    expect(added).not.toMatch(/\b(?:at|in|to|for) any location\b|\bguarantee|\bimmediately\b|\bstart tomorrow\b|\bavailable now\b|\bwithin \d+ days\b/i);
    expect(added).not.toMatch(/\$|%|per cent/);
    expect(added).not.toMatch(/internationally trained|Expedited Specialist/i);
  });

  it('no invented figure, testimonial or logo: every number on the page was already on the live page', () => {
    const nums = (s) => (s.match(/\d[\d,.]*\+?/g) || []).map((x) => x.replace(/[.,]$/, ''));
    const allowed = new Set(nums(visibleText(off)));
    for (const x of nums(added)) expect(allowed.has(x), 'new figure: ' + x).toBe(true);
    expect((on.match(/<blockquote/g) || []).length).toBe((off.match(/<blockquote/g) || []).length);
    expect((on.match(/<img\b/g) || []).length).toBe((off.match(/<img\b/g) || []).length);
    expect((on.match(/data-count=/g) || []).length).toBe((off.match(/data-count=/g) || []).length);
    // the existing figures are labelled as belonging to the overseas track
    expect(text).toContain('Track record: GPs moving to Australia');
    expect(text).toContain('These figures and this comment come from placements of GPs who moved to Australia.');
    // the "830+ locations" figure (which disagrees with "230+" elsewhere) is not repeated in anything new
    expect((on.match(/830/g) || []).length).toBe((off.match(/830/g) || []).length);
    expect(added).not.toMatch(/830|230/);
  });

  it('the proof slot for Australian placements exists, empty and hidden', () => {
    expect(on).toMatch(/<div class="au-proof" id="local-proof" data-au-proof-slot hidden><\/div>/);
    expect(off).not.toContain('local-proof');
  });

  it('the page FAQ answers "do we have to be in a DPA?" with no', () => {
    expect(text).toContain('Does our practice have to be in a Distribution Priority Area (DPA)?');
    expect(text).toContain('No. A practice outside a DPA can hire Australian-registered GPs through GP Link');
    expect(text).not.toContain('What about DPA and 19AB?');
  });

  it('the new regulator spelling is "Ahpra" in new copy; existing overseas copy keeps "AHPRA"', () => {
    expect(added).toMatch(/Ahpra/);
    expect(text).toContain('AHPRA, AMC, visa: our team runs the whole pathway');
  });

  it('loads the Australian lead-form script instead of the live one', () => {
    expect(on).toContain('<script src="/js/site-practice-lead-au.js?v=20261123a"></script>');
    expect(on).not.toContain('/js/site-practice-lead.js?v=');
    expect(fs.existsSync(path.join(ROOT, 'js/site-practice-lead-au.js'))).toBe(true);
  });
});

describe('FAQ, switch on: a practice outside a DPA learns it can hire through GP Link', () => {
  const on = render(FAQ, true).html;
  const clean = (fragment) => words.htmlText(fragment).replace(/\s+/g, ' ').trim();
  const shown = [...noComments(on).matchAll(/<button class="faq-q">([\s\S]*?)<\/button>\s*<div class="faq-a"><div>([\s\S]*?)<\/div><\/div>/g)]
    .map((m) => ({ q: clean(m[1]), a: clean(m[2]) }));

  it('the DPA question is rewritten, in the careful form', () => {
    const dpa = shown.filter((x) => x.q === 'Does our practice have to be in a Distribution Priority Area (DPA)?')[0];
    expect(dpa).toBeTruthy();
    expect(dpa.a).toMatch(/^No\. A practice outside a DPA can hire Australian-registered GPs through GP Link\./);
    expect(dpa.a).toMatch(/can generally work, and bill Medicare, at any practice/);
    expect(dpa.a).toMatch(/Overseas-trained doctors are different/);
    expect(dpa.a).toMatch(/This is general information, not advice on your practice's circumstances\.$/);
    expect(shown.map((x) => x.q)).not.toContain('Can you help with DPA/19AB?');
    expect(visibleText(on)).toContain('Hiring a GP through GP Link');
    expect(dpa.a).not.toMatch(/\bweeks?\b|830|230|guarantee/i);
  });

  it('the FAQPage schema says exactly what the visible questions say', () => {
    const lds = [...on.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).filter((d) => d['@type'] === 'FAQPage');
    expect(lds.length).toBe(1);
    expect(lds[0].mainEntity.map((e) => ({ q: e.name, a: e.acceptedAnswer.text }))).toEqual(shown);
    expect(shown.length).toBe(10);
  });

  it('switch off: today\'s question and no schema', () => {
    const off = render(FAQ, false).html;
    expect(off).toContain('<button class="faq-q">Can you help with DPA/19AB?</button>');
    expect(off).not.toContain('application/ld+json');
  });
});

describe('the lead form script with the switch on: three outcomes, never a gate', () => {
  const live = read('js/site-practice-lead.js');
  const au = read('js/site-practice-lead-au.js');

  // Everything outside the marked WP-23 parts must be the live script.
  function strip(source, isAu) {
    let s = source.replace(/\r\n/g, '\n');
    s = s.replace(/^\/\*[\s\S]*?\*\/\n/, '');                                  // the header comment
    if (isAu) {
      s = s.replace(/[ \t]*\/\/ WP-23:start outcomes[\s\S]*?\/\/ WP-23:end outcomes\n/, '<<OUTCOMES>>\n');
      s = s.replace(/[ \t]*\/\/ WP-23:start dpa-yes\n[\s\S]*?[ \t]*\/\/ WP-23:end dpa-yes\n/, '<<DPA-YES>>\n');
      s = s.replace(/^.*\/\/ WP-23:line not-dpa\n/m, '<<NOT-DPA>>\n');
    } else {
      s = s.replace(/    \/\/ Everything else stays encouraging on purpose[\s\S]*?talk you through what applies to your practice\.<\/p><\/div>';\n/, '<<OUTCOMES>>\n');
      s = s.replace(/        '<p>That means your practice can recruit overseas-trained GPs' \+\n.*\n/, '<<DPA-YES>>\n');
      s = s.replace(/^          renderDpa\("neutral", json\);\n(?=        \} else \{)/m, '<<NOT-DPA>>\n');
    }
    return s;
  }
  it('is the live script apart from the marked blocks (a fix to one must be made to the other)', () => {
    const a = strip(live, false);
    const b = strip(au, true);
    for (const tag of ['<<OUTCOMES>>', '<<DPA-YES>>', '<<NOT-DPA>>']) {
      expect(a.split(tag).length, tag).toBe(2);
      expect(b.split(tag).length, tag).toBe(2);
    }
    expect(b).toBe(a);
    expect(() => new vm.Script(au)).not.toThrow();
    expect(au).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  function renderDpaOf(source) {
    const start = source.indexOf('  function renderDpa(status, payload) {');
    const end = source.indexOf('  function checkDpa() {');
    const fnSource = source.slice(start, end);
    return function (status, payload) {
      const classes = new Set();
      const dpaPanel = { hidden: true, innerHTML: '', classList: { add: (c) => classes.add(c), remove: (...c) => c.forEach((x) => classes.delete(x)) } };
      new Function('dpaPanel', fnSource + '\n renderDpa(arguments[1], arguments[2]);')(dpaPanel, status, payload);
      return { html: dpaPanel.innerHTML, text: words.htmlText(dpaPanel.innerHTML).replace(/\s+/g, ' ').trim(), classes: [...classes], hidden: dpaPanel.hidden };
    };
  }
  const renderAu = renderDpaOf(au);

  it('in a DPA: as today, plus Australian-registered GPs', () => {
    const r = renderAu('yes', { mmm: 'MM3' });
    expect(r.text).toBe("✓ Good news, you're in a Distribution Priority Area. That means your practice can recruit overseas-trained GPs (MM3) and Australian-registered GPs. We'll confirm the detail with you.");
    expect(r.classes).toEqual(['is-yes']);
  });
  it('not in a DPA: "You can hire Australian-registered GPs", one line on why, and the practice carries on', () => {
    const r = renderAu('no', {});
    expect(r.text).toBe("✓ You can hire Australian-registered GPs. Your area is not listed as a Distribution Priority Area. GPs who trained overseas generally need a DPA location, so we would introduce GPs who are already registered in Australia. Carry on and we'll confirm the detail with you.");
    expect(r.classes).toEqual(['is-yes']);
    expect(r.hidden).toBe(false);
    expect(r.text).not.toMatch(/not eligible|do(es)? not qualify|unfortunately|sorry/i);
  });
  it('unknown or failed look-up: "we will confirm with you", never "not a DPA"', () => {
    for (const payload of [undefined, { ok: true, dpa: null, reason: 'lookup_unavailable' }]) {
      const r = renderAu('neutral', payload);
      expect(r.text).toBe("→ We'll confirm your area with you. We couldn't check your area against the Distribution Priority Area map just now. Carry on, and one of our team will check it and confirm with you. Until they have, a role you list with us is not shown to doctors who may only work in a priority area (that includes doctors moving to Australia from overseas). Other doctors can still see it.");   // FR-9b (M9-06, deliberate): it used to say "That doesn't hold anything up", which was not true
      expect(r.classes).toEqual(['is-neutral']);
      expect(r.text).not.toMatch(/not listed|not in a/i);
    }
  });
  it('the look-up result is stored as three states by the script: false only for a real "no"', () => {
    const check = au.slice(au.indexOf('  function checkDpa() {'), au.indexOf('  // ------------------------------------------------------------- validation'));
    expect(check).toContain('renderDpa("no", json); // WP-23:line not-dpa');
    expect(check.match(/state\.dpa = null;/g).length).toBe(2);       // unknown answer, and a failed request
    expect(check.match(/state\.dpa = false;/g).length).toBe(1);
    expect(check).toMatch(/json && json\.ok && json\.dpa === false\) \{\s*state\.dpa = false;/);
    // nothing in the flow stops a practice whatever the answer: validation never reads state.dpa
    const validate = au.slice(au.indexOf('  function validateStep(n) {'), au.indexOf('  // ---------------------------------------------------------------- submit'));
    expect(validate).not.toContain('dpa');
  });
  it('the live script still says what it says today', () => {
    const r = renderDpaOf(live)('neutral', {});
    expect(r.text).toBe("→ Got it, we'll confirm your options. Placement rules vary by area, so one of our team will talk you through what applies to your practice.");
  });
});

describe('the intake page with the switch on: one clear question on which GPs', () => {
  const on = render(INTAKE, true).html;
  const off = render(INTAKE, false).html;

  it('the question is in the HTML the server sends, with the same options the server validates', () => {
    expect(on).toContain('<h2 class="sec">Which GPs will you consider?</h2>');
    const labels = [...on.matchAll(/<input type="checkbox" id="auType_([a-z_]+)" data-au-type="([a-z_]+)"( checked)?>\s*<span><b>([^<]*)<\/b>/g)]
      .map((m) => ({ key: m[1], attr: m[2], checked: !!m[3], label: m[4] }));
    expect(labels.map((l) => l.key)).toEqual(gp.GP_TYPE_KEYS.slice());
    for (const l of labels) {
      expect(l.attr).toBe(l.key);
      expect(l.label).toBe(gp.GP_TYPE_LABELS[l.key]);
    }
    // defaults: VR ticked, everything else not (owner decision 5)
    expect(labels.filter((l) => l.checked).map((l) => l.key)).toEqual(['vr']);
    const interests = [...on.matchAll(/data-au-interest="([^"]*)"/g)].map((m) => m[1]);
    expect(interests).toEqual(gp.SPECIAL_INTEREST_OPTIONS.slice());
    const engagement = [...on.slice(on.indexOf('id="auEngagement"'), on.indexOf('id="auSessMin"')).matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1]);
    expect(engagement).toEqual(gp.ENGAGEMENT_TYPES.slice());
    expect(on).not.toMatch(/locum/i);
    expect(on).toContain(gp.OVERSEAS_NOT_DPA_NOTE);
  });

  it('DPA is a question with three answers, not a gate, and explains itself', () => {
    expect(on).toContain('<button type="button" id="dpaUnsure" data-au-action="dpa-unsure">Not sure</button>');
    expect(on).toContain('A practice outside a DPA can still hire GPs who are already registered in Australia, so answer as it is.');
    expect(on).not.toContain('It decides which overseas-trained GPs are allowed to work at your practice, so it must be exactly right.');
    expect(off).not.toContain('dpaUnsure');
  });

  it('there is one supervision question: the old select is not on the page', () => {
    expect(off).toContain('<select id="supervision_available">');
    expect(on).not.toContain('id="supervision_available"');
    expect(on).not.toContain('The GPs we place need either');
    expect(on).toContain('Doctors who need supervision (limited or provisional registration)');
  });

  it('with the switch off none of it exists', () => {
    for (const s of ['auGpTypes', 'auType_', 'auEngagement', 'auSessMin', 'auInterests', 'au_gp', 'WP-23', 'Which GPs will you consider']) expect(off, s).not.toContain(s);
  });

  // Run the Australian block against stand-ins for the page's own functions.
  function rig(start) {
    const block = on.slice(on.indexOf('  // WP-23 (Australian GP build). Exists only'), on.indexOf('  // ===================== end WP-23'));
    expect(block.length).toBeGreaterThan(2000);
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', _c: new Set(),
      classList: { toggle(c, f) { const t = els[id]._c; (f === undefined ? !t.has(c) : f) ? t.add(c) : t.delete(c); }, add(c) { els[id]._c.add(c); }, remove(c) { els[id]._c.delete(c); } } });
    el('auType_vr').checked = true;
    ['gps_needed', 'employment_type', 'n2', 'aiP', 'dpaNo', 'dpaUnsure', 'auDpaNote', 'auOverseasNote', 'auTypeOverseasRow', 'auEngagement', 'auSessMin', 'auSessMax', 'auSessErr',
      'auType_non_vr', 'auType_registrar', 'auType_supervised', 'auType_overseas'].forEach(el);
    els.gps_needed.value = '1'; els.employment_type.value = 'either';
    const prelude = `
      var cur = start;
      var missing = [];
      function $(id) { return els[id] || null; }
      var document = { addEventListener: function () {}, querySelectorAll: function () { return []; } };
      function persistSoon() {}
      function missingMsg(after, items) { missing = items; }
      function setDpa(v) { cur.dpa = v; }
      function captureCur() {}
      function paintCur() {}
      function resetLocation() { cur.dpa = null; }
      function addAnother() {}
      function restoreDraft() { return false; }
      function gate2() { $('n2').disabled = !($('gps_needed').value && $('employment_type').value); }
      function buildClinicPayload(p) { return { dpa: p.dpa === true ? 'yes' : (p.dpa === false ? 'no' : ''), supervision_available: p.supervision_available === true ? 'yes' : '' }; }
    `;
    const api = new Function('els', 'start', prelude + block + `
      return { cur: function () { return cur; }, setDpa: function (v) { setDpa(v); }, unsure: function () { auUnsurePending = true; setDpa(false); },
        capture: function () { captureCur(); }, gate2: function () { gate2(); return { disabled: $('n2').disabled, missing: missing }; },
        payload: function () { captureCur(); return buildClinicPayload(cur); }, reset: function () { resetLocation(); } };`)(els, start);
    return { api, els };
  }
  const ctxOf = (payload) => ({ dpa: payload.dpa === 'yes', supervisionAvailable: payload.supervision_available === 'yes' ? true : null });

  it('a practice outside a DPA: VR only by default, overseas not applicable, and the payload is one the server accepts', () => {
    const { api, els } = rig({ address: '1 Fake Street', dpa: null });
    api.setDpa(false);
    const p = api.payload();
    expect(p.au_gp).toEqual({ gp_types: { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false }, dpa_answer: 'no', engagement_type: '', sessions_min: null, sessions_max: null, special_interests: [] });
    expect(p.dpa).toBe('no');
    expect(els.auType_overseas.disabled).toBe(true);
    expect(els.auOverseasNote._c.has('hidden')).toBe(false);          // explained, not hidden
    expect(els.auDpaNote.textContent).toMatch(/A practice outside a DPA can hire GPs who are already registered in Australia/);
    expect(gp.validateIntakeAuAnswers(p.au_gp, ctxOf(p)).ok).toBe(true);
    expect(api.gate2().disabled).toBe(false);                         // not a dead end
    // ticking overseas by force (a hand-edited page) is still sent as not applicable
    els.auType_overseas.checked = true;
    expect(api.payload().au_gp.gp_types.overseas).toBe(false);
  });

  it('in a DPA: overseas-trained GPs are on by default and the practice may untick them', () => {
    const { api, els } = rig({ address: '2 Fake Road', dpa: null });
    api.setDpa(true);
    expect(api.payload().au_gp).toMatchObject({ dpa_answer: 'yes', gp_types: { vr: true, overseas: true } });
    expect(els.auType_overseas.disabled).toBe(false);
    expect(els.auOverseasNote._c.has('hidden')).toBe(true);
    api.cur().au.overseasTouched = true; els.auType_overseas.checked = false;
    const p = api.payload();
    expect(p.au_gp.gp_types.overseas).toBe(false);
    expect(gp.validateIntakeAuAnswers(p.au_gp, ctxOf(p)).ok).toBe(true);
  });

  it('"Not sure" is sent as unsure with the closed yes / no, and is not a dead end', () => {
    const { api, els } = rig({ address: '3 Fake Lane', dpa: null });
    api.unsure();
    const p = api.payload();
    expect(p.dpa).toBe('no');
    expect(p.au_gp.dpa_answer).toBe('unsure');
    expect(els.aiP.innerHTML).toMatch(/not sure/);
    // FR-9b (M9-06, deliberate): it used to add "That does not hold anything up", which was not true
    expect(els.aiP.innerHTML).toMatch(/Our team will check it and confirm with you\. Until they have, your role is not shown to doctors who may only work in a priority area/);
    expect(els.auDpaNote.textContent).toMatch(/Either way you can carry on: a practice outside a DPA can still hire GPs who are already registered in Australia/);
    expect(gp.validateIntakeAuAnswers(p.au_gp, ctxOf(p)).ok).toBe(true);
    expect(api.gate2().disabled).toBe(false);
    // answering properly afterwards replaces it
    api.setDpa(false);
    expect(api.payload().au_gp.dpa_answer).toBe('no');
  });

  it('the supervision tick is the only supervision answer the payload carries', () => {
    const { api, els } = rig({ address: '4 Fake Way', dpa: null, supervision_available: true });
    api.setDpa(false);
    let p = api.payload();
    expect(p.supervision_available).toBe('');                          // a stale old answer cannot contradict the tick
    expect(p.au_gp.gp_types.supervised).toBe(false);
    els.auType_supervised.checked = true;
    p = api.payload();
    expect(p.supervision_available).toBe('yes');
    expect(p.au_gp.gp_types.supervised).toBe(true);
    expect(gp.validateIntakeAuAnswers(p.au_gp, ctxOf(p)).ok).toBe(true);
  });

  it('step 2 will not continue with no GP type ticked or a bad sessions range, and says why', () => {
    const { api, els } = rig({ address: '5 Fake Close', dpa: null });
    api.setDpa(false);
    els.auType_vr.checked = false; api.capture();
    let g = api.gate2();
    expect(g.disabled).toBe(true);
    expect(g.missing).toEqual(['at least one type of GP you will consider']);
    els.auType_vr.checked = true; els.auSessMin.value = '9'; els.auSessMax.value = '4'; api.capture();
    g = api.gate2();
    expect(g.disabled).toBe(true);
    expect(g.missing).toEqual(['a valid sessions range']);
    els.auSessMin.value = '4'; els.auSessMax.value = '9'; api.capture();
    expect(api.gate2().disabled).toBe(false);
    const p = api.payload();
    expect(p.au_gp).toMatchObject({ sessions_min: 4, sessions_max: 9 });
    expect(gp.validateIntakeAuAnswers(p.au_gp, ctxOf(p)).ok).toBe(true);
  });

  it('an answer with no official record to compare with is not called a difference from the record', () => {
    const { api, els } = rig({ address: '7 Fake Court', dpa: null, dpaSuggested: null });
    api.setDpa(false);
    expect(els.aiP.innerHTML).toBe('You confirmed: <b>not in a DPA</b>. We could not check it automatically, so we will use your answer.');
    // with a record on file the page's own wording stands (the stand-in setDpa writes nothing)
    const withRecord = rig({ address: '8 Fake Court', dpa: null, dpaSuggested: true });
    withRecord.api.setDpa(false);
    expect(withRecord.els.aiP.innerHTML).toBe('');
  });

  it('changing the address clears the DPA answer with it', () => {
    const { api } = rig({ address: '6 Fake Parade', dpa: null });
    api.setDpa(true);
    api.reset();
    expect(api.cur().au.dpaAnswer).toBe('');
    expect(api.cur().au.types.overseas).toBe(false);
  });
});
