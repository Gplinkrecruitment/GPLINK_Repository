// WP-15 (Australian GP build): the /start page and the reusable form module,
// checked as files (there is no jsdom; the real page was also walked in a
// browser, screenshots in docs/au-gp/screenshots/wp15/).
//
//   - with the switch off the page is the page it was: the markup carries no
//     Australian wording, the module is only loaded after the server says the
//     switch is on, and the browser zone is only sent then
//   - the module and the Australian wording around the form use none of the
//     words in docs/au-gp/AGENT-RULES.md section 4
//   - the consent line is the draft's Australian wording, and no AI-call tick
//     is offered
//   - the Leads tab script draws the segment chips and sends the filter
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = read('pages/site-start.html');
const moduleSrc = read('js/site-au-lead.js');
const form = require('../js/site-au-lead.js');
const auLead = require('../lib/au-lead.js');
const leadsJs = read('js/ceo-ats-leads.js');
const ceoHtml = read('pages/ceo-dashboard.html');

// AGENT-RULES section 4.
const BANNED = [/MyIntealth/i, /\bAMC\b/, /\bEPIC\b/, /visa/i, /relocat/i, /your move/i, /overseas/i,
  /internationally trained/i, /\bGMC\b/, /SPPA/i, /Section G/i, /supervisor CV/i, /Not yet eligible/i];
function bannedIn(text) { return BANNED.filter((re) => re.test(text)).map(String); }

const inline = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
const submit = inline.slice(inline.indexOf("getElementById('consultForm').addEventListener('submit'"));

describe('switch off: the page is the page it was', () => {
  it('the static markup has no first question and no Australian wording', () => {
    const body = html.slice(html.indexOf('<body'), html.lastIndexOf('<script>'));
    expect(body).not.toMatch(/Ahpra/);
    expect(body).not.toContain('au-lead');
    expect(body).not.toContain('19AB');
    expect(body).not.toContain('site-au-lead.js');
    // the form's own fields, in the order they have always been
    const formHtml = body.slice(body.indexOf('<form id="consultForm"'), body.indexOf('</form>'));
    expect((formHtml.match(/ id="(cf[A-Za-z]+)"/g) || []).map((s) => s.slice(5, -1)))
      .toEqual(['cfName', 'cfEmail', 'cfPhone', 'cfCountry', 'cfQuestion', 'cfWebsite', 'cfTz', 'cfSubmit', 'cfErr']);
    expect(formHtml).toContain('<label for="cfCountry">Where did you complete your GP training?</label>');
    expect(formHtml).toContain('<p class="book-consent">We\'ll only contact you about your enquiry. <a href="/pages/privacy" target="_blank" rel="noopener">Privacy policy</a>.</p>');
    // the framing above the form is untouched in the markup
    expect(body).toContain('<div class="eyebrow reveal">For UK, Irish &amp; NZ GPs</div>');
    expect(body).toContain('2 · We run your registration, visa and paperwork');
  });

  it('the module is loaded only after /api/public/features says the switch is on; any failure leaves the form alone', () => {
    expect(html).not.toMatch(/<script[^>]+site-au-lead/);
    const learn = inline.slice(inline.indexOf('(function learnAuSwitch()'), inline.indexOf('function show(id)'));
    expect(learn).toContain("fetch('/api/public/features'");
    expect(learn).toContain('j.auPathwayEnabled !== true');
    expect(learn.indexOf('j.auPathwayEnabled !== true')).toBeLessThan(learn.indexOf('sc.src = AU_LEAD_SRC'));
    expect(learn).toContain('.catch(auSettle)');
    expect(learn).toContain('sc.onerror = auSettle');
    expect(learn).toContain('setTimeout(auSettle, 2500)');
    expect(inline).toContain("var AU_LEAD_SRC = '/js/site-au-lead.js?v=" + form.VERSION + "'");
    expect(inline).toContain('var auForm = null;');
  });

  it('the browser zone and the new answers ride only when the first question is on the form', () => {
    expect(submit).toContain('if (auForm && cfTzField) {');
    expect(submit).not.toMatch(/\n\s*if \(cfTzField\) \{/);
    const base = submit.slice(submit.indexOf('var payload = {'), submit.indexOf('};', submit.indexOf('var payload = {')));
    expect(base.replace(/\s+/g, ' ')).toBe("var payload = { name: document.getElementById('cfName').value.trim(), email: document.getElementById('cfEmail').value.trim(), phone: document.getElementById('cfPhone').value.trim(), country: country, question: document.getElementById('cfQuestion').value.trim(), website: document.getElementById('cfWebsite').value, utm: utm ");
    expect(submit).toContain('if (auForm) {');
    expect(submit).toContain("if (!auBranch) payload.consentVersion = 'overseas_v0';");
    // the old validation sentence is still what an overseas doctor sees
    expect(submit).toContain("} else if (!payload.name || !payload.email || !payload.phone || !country) {");
    expect(submit).toContain("'Please fill in your name, email, phone and where you trained.'");
    expect(submit).toContain("post('/api/public/consult-lead', payload)");
  });

  it('an Ahpra-registered doctor is never routed to the turndown by the form', () => {
    const after = submit.slice(submit.indexOf('if (r.json.qualified) {'));
    const auIdx = after.indexOf('} else if (auBranch) {');
    const tdIdx = after.indexOf("show('bookTurndown');");
    expect(auIdx).toBeGreaterThan(-1);
    expect(auIdx).toBeLessThan(tdIdx);
  });

  it('every inline script on the page still parses, and so do the scripts', () => {
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m; let count = 0;
    while ((m = re.exec(html))) { count++; expect(() => new Function(m[1])).not.toThrow(); }
    expect(count).toBeGreaterThan(1);
    expect(() => new Function(moduleSrc)).not.toThrow();
    expect(() => new Function(leadsJs)).not.toThrow();
    // no raw control characters crept into the files written for this package
    for (const src of [moduleSrc, inline, read('lib/au-lead.js')]) expect(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(src)).toBe(false);
  });
});

describe('the Australian branch: wording', () => {
  it('nothing in js/site-au-lead.js (comments and names included) uses a banned word', () => {
    expect(bannedIn(moduleSrc)).toEqual([]);
    expect(moduleSrc).not.toMatch(/AHPRA/);
    expect(moduleSrc).toContain('Ahpra');
  });

  it('the wording swapped in around the form uses none either, and covers the lines written for a doctor moving country', () => {
    const block = inline.slice(inline.indexOf('// AU-FRAMING:START'), inline.indexOf('// AU-FRAMING:END'));
    const values = [];
    const re = /(?:text|html): (['"])((?:\\.|(?!\1).)*)\1/g;
    let m;
    while ((m = re.exec(block))) values.push(m[2]);
    expect(values.length).toBe(8);
    for (const v of values) expect(bannedIn(v), v).toEqual([]);
    expect(values.join(' ')).not.toMatch(/AHPRA/);
    for (const sel of ['.start-hero .eyebrow', '.start-hero h1', '.start-hero .sub', '.how-grid .how-card.dl2 h3', '#bookConfirmed .confirm-benefits', '#free-account', 'a[href="/visa"]', '.site-footer .foot-in > div:first-child p']) {
      expect(block, sel).toContain("sel: '" + sel + "'");
    }
    // each selector really is on the page
    expect(html).toContain('<div class="how-card reveal dl2"><h3>2 · We run your registration, visa and paperwork</h3></div>');
    expect(html).toContain('<section class="block acct-section" id="free-account">');
    expect(html).toContain('<ul class="confirm-benefits">');
    // a returning Australian-segment lead gets it too
    expect(inline).toContain('if (j.auSegment === true) whenAuSettled(function () { setAuFraming(true); });');
  });

  it('the questions: Ahpra first, then state, VR, 19AB and right to work; every "not sure" is offered', () => {
    expect(form.FIRST_QUESTION).toBe('Are you currently registered with Ahpra?');
    expect(form.FOLLOW_UPS.map((q) => q.key)).toEqual(['state', 'vrStatus', 'restriction19ab', 'rightToWork']);
    expect(form.STATES.map((s) => s.value)).toEqual(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT', 'outside']);
    // the values are exactly the server's fixed sets
    expect(form.VR.map((o) => o.value)).toEqual(auLead.LEAD_VR_STATUSES);
    expect(form.MORATORIUM.map((o) => o.value)).toEqual(auLead.LEAD_19AB_ANSWERS);
    expect(form.RIGHT_TO_WORK.map((o) => o.value)).toEqual(auLead.LEAD_VISA_STATUSES);
    expect(form.STATES[form.STATES.length - 1].value).toBe(auLead.LEAD_STATE_OUTSIDE);
    for (const list of [form.VR, form.MORATORIUM, form.RIGHT_TO_WORK]) expect(list.map((o) => o.value)).toContain('unsure');
    expect(Object.keys(auLead.LEAD_CONSENT_VERSIONS)).toContain(form.CONSENT_VERSION);
  });

  it('what the form sends', () => {
    expect(form.payloadExtras(form.emptyAnswers())).toBeNull();
    expect(form.payloadExtras({ first: 'no', state: 'WA', vrStatus: 'yes' })).toEqual({ ahpraRegistered: false });
    expect(form.payloadExtras({ first: 'yes', state: 'WA', vrStatus: 'yes', restriction19ab: 'unsure', rightToWork: 'temporary' }))
      .toEqual({ ahpraRegistered: true, consentVersion: 'au_a1_draft_2026_11', state: 'WA', vrStatus: 'yes', restriction19ab: 'unsure', rightToWork: 'temporary' });
    // a value that was never offered is not sent
    expect(form.payloadExtras({ first: 'yes', state: 'Texas', vrStatus: 'x' })).toEqual({ ahpraRegistered: true, consentVersion: 'au_a1_draft_2026_11' });
    // and the server reads exactly these keys
    const r = auLead.readLeadFormAnswers(form.payloadExtras({ first: 'yes', state: 'outside', vrStatus: 'registrar', restriction19ab: 'no', rightToWork: 'citizen_pr' }));
    expect(r.answers).toMatchObject({ ahpraRegistered: true, stateOutside: true, vrStatus: 'registrar', restriction19ab: 'no', visaStatus: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' });
  });

  it('validation asks for each follow-up and turns nobody away', () => {
    expect(form.validateAnswers(form.emptyAnswers())).toBe('Please tell us whether you are currently registered with Ahpra.');
    expect(form.validateAnswers({ first: 'no' })).toBe('');
    expect(form.validateAnswers({ first: 'yes' })).toBe('Please answer: Which state or territory are you in?');
    expect(form.validateAnswers({ first: 'yes', state: 'WA' })).toBe('Please answer: Are you a vocationally registered GP (FRACGP or FACRRM)?');
    for (const vrStatus of auLead.LEAD_VR_STATUSES) {
      for (const restriction19ab of auLead.LEAD_19AB_ANSWERS) {
        for (const rightToWork of auLead.LEAD_VISA_STATUSES) {
          expect(form.validateAnswers({ first: 'yes', state: 'outside', vrStatus, restriction19ab, rightToWork })).toBe('');
        }
      }
    }
  });

  it('consent: the draft\'s Australian wording, a hint about personal contact details, and no AI-call tick', () => {
    const draft = read('docs/au-gp/legal-draft/consent-wording.md').replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');
    const shown = form.CONSENT_HTML.replace(/<a [^>]+>Privacy Policy<\/a>/, '[Privacy Policy]');
    expect(draft).toContain(shown);
    expect(draft).toContain(form.CONTACT_HINT);
    expect(form.CONSENT_HTML).toContain('href="/pages/privacy"');
    expect(moduleSrc).not.toMatch(/type\s*=\s*['"]checkbox/);
    expect(moduleSrc).not.toMatch(/AI phone assistant|recorded and transcribed/);
  });

  it('the WP-21 hook is there: a preset on the address or on the section, and mount() takes it', () => {
    expect(inline).toContain("params.get('seg') === 'au'");
    expect(inline).toContain("bookSection.getAttribute('data-lead-segment') === 'au'");
    expect(moduleSrc).toContain("if (o.preset === 'au') setAnswer('yes');");
    expect(typeof form.mount).toBe('function');
    expect(typeof form.swapFraming).toBe('function');
  });
});

describe('ADM-29: the Leads tab script', () => {
  it('draws the segment chips only when the server sends counts, and sends the filter', () => {
    expect(leadsJs).toContain("seg: 'all', segCounts: null,");
    expect(leadsJs).toContain('state.segCounts = d.segment_counts || null;');
    expect(leadsJs).toContain("if (!state.segCounts) state.seg = 'all';");
    expect(leadsJs).toContain("(state.seg && state.seg !== 'all' ? '&seg=' + encodeURIComponent(state.seg) : '')");
    expect(leadsJs).toContain('id="lead-segments" style="display:none');
    const chips = /var SEGMENT_FILTERS = \[([\s\S]*?)\];/.exec(leadsJs)[1];
    expect((chips.match(/v: '([a-z]+)'/g) || []).map((s) => s.slice(4, -1))).toEqual(['all', 'au', 'overseas', 'uk', 'ie', 'nz', 'other']);
  });

  it('an Australian-segment lead shows their own place, never "Sydney" by default; the viewer-local formatter is not re-pinned', () => {
    expect(leadsJs).toContain("(place || COUNTRY_SHORT[String(country || '').toLowerCase()] || 'their time')");
    expect(leadsJs).toContain('theirTime(l.call_at, l.tz, l.country, l.tz_label)');
    expect(leadsJs).toContain('theirClockNow(lead.tz, lead.country, lead.tz_label)');
    expect(leadsJs).toContain("if (isAuLead(l)) meta.push(ATS.flag('au') + ' ' + ATS.esc(l.au_state || 'Australia'));");
    // localTime() (the owner's own clock) still has no timeZone option
    const local = leadsJs.slice(leadsJs.indexOf('function localTime(iso)'), leadsJs.indexOf('function theirTime'));
    expect(local).not.toContain('timeZone');
  });

  it('class names stay lead-* (an ad blocker hides "-ad" names) and the script version moved', () => {
    expect(leadsJs).not.toMatch(/class="[^"]*\b(?:ad-[a-z]|[a-z]+-ads?\b)/);
    expect(leadsJs).toContain('lead-seg');
    const v = (/\/js\/ceo-ats-leads\.js\?v=(\w+)/.exec(ceoHtml) || [])[1];
    expect(v >= '20261122a').toBe(true);   // WP-16 moved it (the drawer's "Messages sent and skipped")
  });
});
