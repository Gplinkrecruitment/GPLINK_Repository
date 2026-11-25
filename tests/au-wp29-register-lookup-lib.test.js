// WP-29: the Ahpra public-register lookup (lib/ahpra-register-lookup.js).
// NOTHING here touches the network: the real provider is driven with a
// stand-in for fetch that serves pages saved from the public site (personal
// details replaced with fakes; tests/fixtures/ahpra-register/).
import { describe, it, expect, beforeEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const L = require('../lib/ahpra-register-lookup.js');
const fixtures = require('../lib/ahpra-register-fixtures.js');

const DIR = path.join(__dirname, 'fixtures', 'ahpra-register');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const DETAILS = read('details-standard-supervised-practice.html');
const SEARCH_ONE = read('search-one-result.html');
const SEARCH_NONE = read('search-no-results.html');
const NUMBER = 'MED0009990002';
const START_PAGE = '<html><form method="post" id="mainform"></form></html>';

function response(status, body, cookies) {
  return { status, headers: { getSetCookie: () => cookies || [] }, text: async () => body };
}
// A stand-in for fetch that behaves like the public site did on 25 Nov 2026.
function fakeSite(over) {
  const o = over || {};
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body || '', headers: init.headers, redirect: init.redirect });
    if (o.throwOn && o.throwOn(calls.length)) { const e = new Error('boom'); if (o.abort) e.name = 'AbortError'; throw e; }
    if (init.method === 'GET') return o.start || response(200, START_PAGE, ['AhpraWeb=abc; path=/; secure', 'TS01=xyz; Path=/']);
    const rowId = /practitioner-row-id=([^&]*)/.exec(init.body)[1];
    if (!rowId) return o.search || response(200, SEARCH_ONE);
    return o.detail || response(200, DETAILS);
  };
  return { impl, calls };
}

beforeEach(() => { L._resetForTests(); });

describe('WP-29 lookup: the provider is OFF by default and then nothing is requested', () => {
  it('no setting, an unknown setting and `none` all mean none', () => {
    expect(L.providerName({})).toBe('none');
    expect(L.providerName({ AHPRA_LOOKUP_PROVIDER: '' })).toBe('none');
    expect(L.providerName({ AHPRA_LOOKUP_PROVIDER: 'pie' })).toBe('none');
    expect(L.providerName({ AHPRA_LOOKUP_PROVIDER: 'NONE' })).toBe('none');
    expect(L.providerName({ AHPRA_LOOKUP_PROVIDER: ' Fixture ' })).toBe('fixture');
    expect(L.providerName({ AHPRA_LOOKUP_PROVIDER: 'ahpra_public' })).toBe('ahpra_public');
  });
  it('with `none` the lookup answers { ok: false, provider: "none" } and never calls fetch', async () => {
    const site = fakeSite();
    const real = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = async () => { touched++; throw new Error('the network must not be used'); };
    try {
      expect(await L.lookupRegistration(NUMBER, { provider: 'none', fetchImpl: site.impl })).toEqual({ ok: false, provider: 'none', reason: 'provider_off' });
      const saved = process.env.AHPRA_LOOKUP_PROVIDER;
      delete process.env.AHPRA_LOOKUP_PROVIDER;
      expect((await L.lookupRegistration(NUMBER)).provider).toBe('none');
      if (saved !== undefined) process.env.AHPRA_LOOKUP_PROVIDER = saved;
    } finally { globalThis.fetch = real; }
    expect(site.calls).toHaveLength(0);
    expect(touched).toBe(0);
  });
  it('the test run itself has no provider switched on', () => {
    expect(L.providerName()).toBe('none');
  });
});

describe('WP-29 lookup: reading the real "Registration Details" page (personal details replaced)', () => {
  const parsed = L.parseRegistrationDetailsHtml(DETAILS, NUMBER);
  const f = parsed.facts;
  it('reads every field of the owner\'s example with no warnings', () => {
    expect(parsed.ok).toBe(true);
    expect(f.parseWarnings).toEqual([]);
    expect(f.number).toBe(NUMBER);
    expect(f.name).toBe('Dr Fixture Example-Doctor');
    expect(f.profession).toBe('Medical Practitioner');
    expect(f.status).toBe('Registered');
    expect(f.registrationType).toBe('specialist');
    expect(f.specialty).toBe('General practice');
    expect(f.specialistGp).toBe(true);
    expect(f.expiry).toBe('2027-09-30');
    expect(f.firstRegistrationDate).toBe('2025-12-18');
    expect(f.undertakings).toEqual({ present: false, text: null });
    expect(f.reprimands).toEqual({ present: false, text: null });
    expect(f.endorsements).toEqual({ present: false, text: null });
    expect(f.notations).toEqual({ present: false, text: null });
  });
  it('reads the conditions in full, without the page\'s "Show less" link text', () => {
    expect(f.conditions.present).toBe(true);
    expect(f.conditions.text.startsWith('On 18 December 2025, the Medical Board of Australia (the Board) imposed conditions.')).toBe(true);
    expect(f.conditions.text).toContain('1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway');
    expect(f.conditions.text).toContain('must not practise other than at approved practice location(s)');
    expect(f.conditions.text).toContain('3.4 The practitioner is not required to comply with the requirement for a reflective practice report');
    expect(f.conditions.text).not.toMatch(/Show less|Read more/i);
    // the same words as the copy the fixture provider prints
    expect(f.conditions.text.replace(/\s+/g, ' ')).toBe(fixtures.STANDARD_SUPERVISED_PRACTICE_CONDITIONS.replace(/\s+/g, ' '));
  });
  it('reads the registration requirements', () => {
    expect(f.requirements.supervisionRequired).toBe(true);
    expect(f.requirements.supervisionLevel).toBe('Indirect 2');
    expect(f.requirements.pathway).toBe('Expedited Specialist Pathway');
    expect(f.requirements.position).toBe('General Practitioner');
    expect(f.requirements.workplaces).toBe('Fakeville Medical Practice NSW');
    expect(f.requirements.commencement).toBe('18 December 2025');
    expect(f.requirements.approvedLocationsOnly).toBe(true);
    expect(f.requirements.raw).toContain('The Practitioner will only practise with supervision by a Board approved supervisor or Delegate');
  });
  it('reads the qualifications and the principal place of practice', () => {
    expect(f.qualifications.map((q) => [q.title, q.institution, q.country, q.year])).toEqual([
      ['Membership of the Royal College of General Practitioners', 'Royal College of General Practitioners', 'United Kingdom', 2024],
      ['Doctor of Medicine in General Medicine', 'Example State Medical University', 'Russian Federation', 2015]
    ]);
    expect(f.principalPlace).toEqual({ suburb: 'FAKEVILLE', state: 'NSW', postcode: '2999', country: 'Australia' });
  });
  it('the committed fixtures hold no real person: every number is a made-up one', () => {
    for (const name of fs.readdirSync(DIR)) {
      const numbers = read(name).match(/MED\d{10}/g) || [];
      for (const n of numbers) expect(/^MED000999|^MED9999999999$/.test(n), name + ' ' + n).toBe(true);
    }
    for (const n of Object.keys(fixtures.FIXTURES)) expect(n).toMatch(/^MED000999\d{4}$/);
  });
});

describe('WP-29 lookup: a page it does not recognise is never guessed at', () => {
  it('not a details page, an empty body, and a page for a different number', () => {
    expect(L.parseRegistrationDetailsHtml('<html><body>Something else</body></html>', NUMBER)).toEqual({ ok: false, reason: 'unrecognised_page' });
    expect(L.parseRegistrationDetailsHtml('', NUMBER)).toEqual({ ok: false, reason: 'unrecognised_page' });
    expect(L.parseRegistrationDetailsHtml(null, NUMBER)).toEqual({ ok: false, reason: 'unrecognised_page' });
    expect(L.parseRegistrationDetailsHtml(SEARCH_ONE, NUMBER)).toEqual({ ok: false, reason: 'unrecognised_page' });
    expect(L.parseRegistrationDetailsHtml(DETAILS, 'MED0009990001')).toEqual({ ok: false, reason: 'number_mismatch' });
  });
  it('a field that cannot be read is null with a warning, not invented', () => {
    const noExpiry = DETAILS.replace('30/09/2027', 'soon');
    const a = L.parseRegistrationDetailsHtml(noExpiry, NUMBER);
    expect(a.ok).toBe(true);
    expect(a.facts.expiry).toBe(null);
    expect(a.facts.parseWarnings).toContain('expiry');
    const noFirst = DETAILS.replace('18/12/2025</div>', '31/02/2025</div>');
    const b = L.parseRegistrationDetailsHtml(noFirst, NUMBER);
    expect(b.facts.firstRegistrationDate).toBe(null);
    expect(b.facts.parseWarnings).toContain('firstRegistrationDate');
  });
  it('dates: the register prints dd/mm/yyyy, and only real dates are accepted', () => {
    expect(L.isoFromRegisterDate('18/12/2025')).toBe('2025-12-18');
    expect(L.isoFromRegisterDate('29/02/2024')).toBe('2024-02-29');
    expect(L.isoFromRegisterDate('29/02/2025')).toBe(null);
    expect(L.isoFromRegisterDate('2025-12-18')).toBe(null);
    expect(L.isoFromRegisterDate('')).toBe(null);
  });
  it('the search page: found, not found, and not a search page', () => {
    expect(L.parseSearchResultsHtml(SEARCH_ONE, NUMBER)).toEqual({ recognised: true, found: true, rows: 1 });
    expect(L.parseSearchResultsHtml(SEARCH_ONE, 'MED0009990001')).toEqual({ recognised: true, found: false, rows: 1 });
    expect(L.parseSearchResultsHtml(SEARCH_NONE, 'MED9999999999')).toEqual({ recognised: true, found: false, rows: 0 });
    expect(L.parseSearchResultsHtml('<html></html>', NUMBER).recognised).toBe(false);
  });
});

describe('WP-29 lookup: the fixture provider (tests and the local stack)', () => {
  const get = (n, name) => L.lookupRegistration(n, { provider: 'fixture', accountName: name || 'Test Auvr' });
  it('a clean VR GP, printed with the account\'s own name', async () => {
    const r = await get('MED0009990001');
    expect(r.ok).toBe(true); expect(r.found).toBe(true); expect(r.provider).toBe('fixture');
    expect(r.facts.name).toBe('Dr Test Auvr');
    expect(r.facts.conditions).toEqual({ present: false, text: null });
    expect(r.facts.specialistGp).toBe(true);
    expect(r.facts.source).toBe('fixture');
    expect(r.facts.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.facts.parseWarnings).toEqual([]);
  });
  it('the conditions case, the not-found case, somebody else\'s number, and a failure', async () => {
    const cond = await get('MED0009990002');
    expect(cond.facts.requirements.supervisionLevel).toBe('Indirect 2');
    expect(cond.facts.firstRegistrationDate).toBe('2025-12-18');
    expect(await get('MED0009990003')).toMatchObject({ ok: true, found: false });
    expect((await get('MED0009990004')).facts.name).toBe('Dr Someone Else-Entirely');
    expect(await get('MED0009990012')).toMatchObject({ ok: false, reason: 'timeout' });
    expect(await get('MED0001234567')).toMatchObject({ ok: true, found: false });   // not a fixture number: not found
    expect(await get('not a number')).toMatchObject({ ok: false, reason: 'invalid_number' });
  });
  it('every fixture page parses with the real parser and no warnings', async () => {
    for (const n of Object.keys(fixtures.FIXTURES)) {
      const r = await get(n);
      if (r.ok && r.found) expect(r.facts.parseWarnings, n).toEqual([]);
    }
  });
});

describe('WP-29 lookup: the real provider, driven by saved pages', () => {
  const run = (site, opts) => L.lookupRegistration(NUMBER, Object.assign({ provider: 'ahpra_public', fetchImpl: site.impl }, opts || {}));
  it('makes three ordinary requests in order, with cookies, a plain client name, and no personal detail', async () => {
    const site = fakeSite();
    const r = await run(site);
    expect(r.ok).toBe(true); expect(r.found).toBe(true); expect(r.provider).toBe('ahpra_public');
    expect(r.facts.source).toBe('ahpra_public');
    expect(site.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(site.calls[0].url).toBe('https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx');
    expect(site.calls[1].url).toBe('https://www.ahpra.gov.au/Registration/Registers-of-Practitioners');
    expect(site.calls[1].body).toContain('name-reg=' + NUMBER);
    expect(site.calls[1].body).toContain('practitioner-row-id=&');
    expect(site.calls[2].body).toContain('practitioner-row-id=' + NUMBER);
    expect(site.calls[1].headers.Cookie).toBe('AhpraWeb=abc; TS01=xyz');
    for (const c of site.calls) {
      expect(c.headers['User-Agent']).toBe('Mozilla/5.0 (compatible; register-check/1.0)');
      expect(c.redirect).toBe('manual');
      expect(JSON.stringify(c.headers) + c.body).not.toMatch(/gplink|gp link|@/i);
    }
  });
  it('a number with no row on the results page is "not found", and the details page is never asked for', async () => {
    const site = fakeSite({ search: response(200, SEARCH_NONE) });
    const r = await run(site);
    expect(r).toMatchObject({ ok: true, found: false });
    expect(site.calls).toHaveLength(2);
  });
  it('a refusal or a challenge STOPS the lookup: blocked, and nothing more is requested', async () => {
    for (const start of [response(403, ''), response(429, ''), response(200, '<html><title>Just a moment...</title><div class="cf-chl-widget"></div></html>'),
      response(200, '<html>Request Rejected. Your support ID is 123</html>'), response(200, '<html><div class="g-recaptcha"></div></html>')]) {
      L._resetForTests();
      const site = fakeSite({ start });
      const r = await run(site);
      expect(r).toMatchObject({ ok: false, reason: 'blocked' });
      expect(site.calls).toHaveLength(1);
    }
  });
  it('a redirect, or a page in another layout, is unrecognised and changes nothing', async () => {
    let site = fakeSite({ detail: response(302, '') });
    expect(await run(site)).toMatchObject({ ok: false, reason: 'unrecognised_page' });
    L._resetForTests();
    site = fakeSite({ detail: response(200, '<html><form id="mainform"></form><h1>New design</h1></html>') });
    expect(await run(site)).toMatchObject({ ok: false, reason: 'unrecognised_page' });
    L._resetForTests();
    site = fakeSite({ search: response(200, '<html><form id="mainform"></form></html>') });
    expect(await run(site)).toMatchObject({ ok: false, reason: 'unrecognised_page' });
  });
  it('one retry at most, and only for a plain network slip', async () => {
    let site = fakeSite({ throwOn: (n) => n === 1 });
    const r = await run(site);
    expect(r.ok).toBe(true);
    expect(site.calls).toHaveLength(4);     // the failed GET, then the three of the retry
    L._resetForTests();
    site = fakeSite({ throwOn: () => true });
    expect(await run(site)).toMatchObject({ ok: false, reason: 'network_error' });
    expect(site.calls).toHaveLength(2);     // two attempts, no third
    L._resetForTests();
    site = fakeSite({ throwOn: () => true, abort: true });
    expect(await run(site)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(site.calls).toHaveLength(1);     // a timeout is not retried
  });
  it('the same number is answered from memory for a day; staff pressing the button asks again', async () => {
    const site = fakeSite();
    const t0 = Date.parse('2026-11-26T00:00:00Z');
    await run(site, { now: t0 });
    const again = await run(site, { now: t0 + 60 * 60 * 1000 });
    expect(again.cached).toBe(true);
    expect(site.calls).toHaveLength(3);
    await run(site, { now: t0 + 2 * 60 * 60 * 1000, force: true });
    expect(site.calls).toHaveLength(6);
    await run(site, { now: t0 + 27 * 60 * 60 * 1000 });   // a day after the forced one
    expect(site.calls).toHaveLength(9);
  });
  it('at most about one lookup every few seconds across all doctors', async () => {
    const site = fakeSite();
    const t0 = Date.parse('2026-11-26T00:00:00Z');
    await L.lookupRegistration('MED0009990002', { provider: 'ahpra_public', fetchImpl: site.impl, now: t0 });
    const second = await L.lookupRegistration('MED0009990001', { provider: 'ahpra_public', fetchImpl: site.impl, now: t0 + 1000 });
    expect(second).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(site.calls).toHaveLength(3);
    expect(L.MIN_GAP_BETWEEN_LOOKUPS_MS).toBeGreaterThanOrEqual(3000);
    expect(L.TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(8000);
  });
  it('never throws, whatever it is handed', async () => {
    for (const bad of [null, undefined, '', {}, [], 12, 'MED', 'x'.repeat(5000)]) {
      const r = await L.lookupRegistration(bad, { provider: 'ahpra_public', fetchImpl: fakeSite().impl });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('invalid_number');
    }
  });
});
