// Australian GP build, FR-9 (review round 12), the location items:
//   S9-05  the suburb search has its own limit, sized for typing, and says so honestly
//   S9-06  a suggestion is chosen on a tap, never at the end of a scroll
//   S9-15  the ways people really type a place all find it
//   S9-16  a distance is only claimed when it is known, and says when it is to a suburb centre
//   and user_profiles.preferred_city is kept in step with the choice.
// Each test here fails on the code as it was before FR-9.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const loc = require('../lib/au-localities.js');
const match = require('../lib/au-location-match.js');
const picker = require('../js/au-location-picker.js');
const { bannedIn, stripJsComments } = require('./helpers/au-banned-words.js');
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

const labels = (q, opts) => loc.searchLocalities(q, opts).map((p) => p.label);
const choice = (base, travel, places) => {
  const n = match.normaliseLocationChoice({ base, travel, places: places || [] });
  if (!n.ok) throw new Error(JSON.stringify(n.errors));
  return n.choice;
};

describe('S9-15: the ways people really type a place', () => {
  it('the reviewer\'s misses: "mt isa", "saint kilda", "nth sydney", "central coast", "sydney cbd"', () => {
    expect(labels('mt isa')[0]).toBe('Mount Isa QLD 4825');
    expect(labels('mt. isa')[0]).toBe('Mount Isa QLD 4825');
    expect(labels('saint kilda')).toContain('St Kilda VIC 3182');
    expect(labels('nth sydney')[0]).toBe('North Sydney NSW 2055');
    expect(labels('central coast')[0]).toBe('Central Coast, NSW (region)');
    expect(labels('sydney cbd').slice(0, 2)).toEqual(['Sydney (whole city)', 'Sydney NSW 2000']);
  });
  it('short and long forms both ways, and compass letters, without breaking what is still being typed', () => {
    expect(labels('mount isa')[0]).toBe('Mount Isa QLD 4825');
    expect(labels('st kilda')).toContain('St Kilda VIC 3182');
    expect(labels('mt baw baw')[0]).toBe('Mt Baw Baw VIC 3833');           // stored short, typed short
    expect(labels('mount baw baw')[0]).toBe('Mt Baw Baw VIC 3833');        // stored short, typed long
    expect(labels('saint helena')).toContain('Saint Helena VIC 3088');
    expect(labels('st helena')).toContain('Saint Helena VIC 3088');
    expect(labels('sth melbourne')[0]).toBe('South Melbourne VIC 3205');
    expect(labels('n sydney')[0]).toBe('North Sydney NSW 2055');
    expect(labels('e melbourne')[0]).toBe('East Melbourne VIC 3002');
    expect(labels('w perth')).toContain('West Perth WA 6005');
    // a single last letter is the start of the next word, not a compass point
    expect(labels('north s')).toContain('North Sydney NSW 2055');
    expect(labels('st kilda e')[0]).toBe('St Kilda East VIC 3183');
    // "st" on its own still finds names that merely start with those letters
    const st = loc.searchLocalitiesDetailed('st');
    expect(st.total).toBeGreaterThan(100);
    expect(labels('stan').some((l) => /^Stan/.test(l))).toBe(true);
    // apostrophes, hyphens, full stops, word order
    expect(labels("o'connor")).toContain("O'Connor ACT 2602");
    expect(labels('oconnor')).toContain("O'Connor ACT 2602");
    expect(labels('kilda st')).toContain('St Kilda VIC 3182');
  });
  it('"cbd" and "city" lead with the whole-city entry, for every capital', () => {
    for (const c of ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra', 'Hobart', 'Darwin']) {
      expect(labels(c.toLowerCase() + ' cbd')[0], c).toBe(c + ' (whole city)');
      expect(labels(c.toLowerCase() + ' city')[0], c).toBe(c + ' (whole city)');
    }
    // a suburb really called that still shows
    expect(labels('brisbane city')).toContain('Brisbane City QLD 4000');
    // not a city: an ordinary search
    expect(labels('garden city')).toContain('Garden City VIC 3207');
  });
  it('named regions: found by name or another way of typing it, marked as regions, real places with a centre', () => {
    for (const q of ['northern beaches', 'sunshine coast', 'gold coast', 'mornington peninsula', 'blue mountains', 'hunter', 'hunter valley', 'illawarra', 'far north queensland', 'fnq', 'barossa', 'top end']) {
      const first = loc.searchLocalities(q)[0];
      expect(first, q).toBeTruthy();
      expect(['area', 'city'], q).toContain(first.kind);
    }
    expect(labels('hunter')[0]).toBe('Hunter Valley, NSW (region)');
    expect(labels('gold coast')[0]).toBe('Gold Coast (whole city)');        // already a whole-city entry: not repeated
    const place = loc.getPlaceById('area:central-coast-nsw');
    expect(place).toEqual({ id: 'area:central-coast-nsw', kind: 'area', name: 'Central Coast', state: 'NSW', postcode: null, lat: expect.any(Number), lng: expect.any(Number), label: 'Central Coast, NSW (region)' });
    expect(loc.areaRadiusKm('area:central-coast-nsw')).toBeGreaterThan(0);
    expect(loc.areaRadiusKm('area:nope')).toBe(null);
    expect(loc.getPlaceById('area:nope')).toBe(null);
    // every entry: inside Australia, a sensible radius, a unique id, no banned word
    const ids = new Set();
    loc.AREA_ENTRIES.forEach((a) => {
      expect(loc.inAustralia(a.lat, a.lng), a.name).toBe(true);
      expect(a.radiusKm, a.name).toBeGreaterThan(0);
      expect(loc.AU_STATES, a.name).toContain(a.state);
      const p = loc.searchLocalities(a.name + ' ' + a.state.toLowerCase()).filter((x) => x.kind === 'area' && x.name === a.name)[0];
      expect(p, a.name).toBeTruthy();
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(loc.getPlaceById(p.id)).toEqual(p);
      expect(bannedIn(p.label)).toEqual([]);
    });
  });
  it('a postcode typed in full returns ALL its suburbs; a partial one says how many there are', () => {
    const all = loc.searchLocalitiesDetailed('2480');
    expect(all.places.length).toBeGreaterThan(8);
    expect(all.places.length).toBe(all.total);
    expect(all.places.every((p) => p.postcode === '2480')).toBe(true);
    expect(all.places.map((p) => p.label)).toContain('Lismore NSW 2480');   // not in the first eight by name
    const part = loc.searchLocalitiesDetailed('248');
    expect(part.places.length).toBe(8);
    expect(part.total).toBeGreaterThan(8);
    // the biggest postcode fits
    const counts = {};
    require('../data/au-localities.json').rows.forEach((r) => { counts[r[2]] = (counts[r[2]] || 0) + 1; });
    const biggest = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    expect(counts[biggest]).toBeLessThanOrEqual(loc.MAX_POSTCODE_RESULTS);
    expect(loc.searchLocalities(biggest).length).toBe(counts[biggest]);
    // a caller that asks for a limit still gets it
    expect(loc.searchLocalities('2480', { limit: 8 }).length).toBe(8);
    // a name search says when there is more
    const many = loc.searchLocalitiesDetailed('mount');
    expect(many.places.length).toBe(8);
    expect(many.total).toBeGreaterThan(100);
  });
  it('ranking: the exact name, then starts with, then a later word, then contains; capital cities first inside a group', () => {
    const r = labels('richmond');
    expect(r.slice(0, 3).every((l) => /^Richmond [A-Z]/.test(l))).toBe(true);          // exact names lead
    expect(['Richmond VIC 3121', 'Richmond NSW 2753', 'Richmond SA 5033', 'Richmond QLD 4740', 'Richmond TAS 7025']).toContain(r[0]);
    expect(r[0]).not.toBe('Richmond QLD 4822');                                          // a capital-city one before an outback one
    const p = labels('parra');
    expect(p[0]).toBe('Parramatta NSW 2150');
    expect(p.indexOf('North Parramatta NSW 2151')).toBeGreaterThan(p.indexOf('Parramatta Park QLD 4870'));   // later word after starts-with
    expect(labels('sydney').slice(0, 2)).toEqual(['Sydney (whole city)', 'Sydney NSW 2000']);
  });
});

describe('S9-16: a distance is only claimed when it is known', () => {
  const parra = choice('loc:NSW:2150:parramatta', 'commute');
  const line = (c, row) => match.locationLine(match.matchRoleLocation(c, row), c);
  it('a practice point outside Australia (or swapped, or with the sign dropped) is "distance unknown", never a distance', () => {
    for (const row of [
      { latitude: 51.5074, longitude: -0.1278 },            // London
      { latitude: -36.85, longitude: 174.76 },               // Auckland
      { latitude: 151.0034, longitude: -33.8136 },           // swapped
      { latitude: 33.8136, longitude: 151.0034 },            // sign dropped
      { latitude: 0, longitude: 151 }, { latitude: 0, longitude: 0 }, { latitude: '0', longitude: '0' }
    ]) {
      const m = match.matchRoleLocation(parra, row);
      expect(m.distanceKm, JSON.stringify(row)).toBe(null);
      expect(m.basis).toBe('unknown');
      expect(m.band).toBe('unknown');
      expect(match.locationLine(m, parra)).toBe('');
    }
    // with a suburb to fall back on, the suburb is used and the bad point ignored
    const m = match.matchRoleLocation(parra, { latitude: 51.5074, longitude: -0.1278, suburb: 'Dubbo', location_state: 'NSW', postcode: '2830' });
    expect(m.basis).toBe('suburb');
    expect(m.distanceKm).toBeGreaterThan(250);
    expect(m.distanceKm).toBeLessThan(320);
  });
  it('a role located only by its suburb never reads "Less than 1 km": it says "In <suburb>" or "(to the suburb centre)"', () => {
    expect(line(parra, { suburb: 'Parramatta', location_state: 'NSW' })).toBe('In Parramatta');
    expect(line(parra, { latitude: 0, longitude: 0, suburb: 'Parramatta', location_state: 'NSW' })).toBe('In Parramatta');
    expect(line(parra, { suburb: 'Westmead', location_state: 'NSW' })).toMatch(/^About \d+ km from Parramatta \(to the suburb centre\)$/);
    expect(line(parra, { suburb: 'Dubbo', location_state: 'NSW', postcode: '2830' })).toMatch(/^Outside the area you chose · about \d+ km from Parramatta \(to the suburb centre\)$/);
    expect(line(parra, { postcode: '2150' })).toMatch(/\(approximate\)$/);
    for (const row of [{ suburb: 'Parramatta', location_state: 'NSW' }, { postcode: '2150' }, { suburb: 'Harris Park', location_state: 'NSW' }]) {
      expect(line(parra, row)).not.toMatch(/less than 1 km/i);
    }
    // a practice with its own map point still gets the plain distance
    expect(line(parra, { latitude: -33.8170, longitude: 151.0035, suburb: 'Parramatta', location_state: 'NSW' })).toBe('Less than 1 km from Parramatta');
    // no line carries digits from a mistyped suburb field (a street number, a postcode)
    expect(line(parra, { suburb: 'Parramatta 2150', postcode: '2150' })).not.toMatch(/\d{3,}/);
  });
  it('a named region: a role inside it says so; it can be where the doctor is based; it never hides a role', () => {
    const c = choice('loc:NSW:2150:parramatta', 'places', ['area:central-coast-nsw', 'area:hunter-valley-nsw']);
    const gosford = match.matchRoleLocation(c, { suburb: 'Gosford', location_state: 'NSW' });
    expect(gosford.withinPreference).toBe(true);
    expect(match.locationLine(gosford, c)).toBe('In the Central Coast region');
    const dubbo = match.matchRoleLocation(c, { latitude: -32.2569, longitude: 148.6011 });
    expect(dubbo.withinPreference).toBe(false);
    expect(match.locationLine(dubbo, c)).toMatch(/^Outside the area you chose · about \d+ km from /);
    // based in a region
    const based = choice('area:central-coast-nsw', 'commute');
    expect(based.base).toMatchObject({ kind: 'area', state: 'NSW' });
    expect(match.matchRoleLocation(based, { suburb: 'Gosford', location_state: 'NSW' }).withinPreference).toBe(true);
    expect(match.legacyLocationsFor(based)).toEqual(['Regional NSW']);
    expect(match.describeChoiceForStaff(based)).toBe('Based in Central Coast, NSW (region); within a commute (about 45 km)');
    // survives being stored and read back
    expect(match.readLocationChoice(JSON.stringify(c)).places.map((p) => p.kind)).toEqual(['area', 'area']);
    // "Regional <state>" still cannot be a base
    expect(match.normaliseLocationChoice({ base: 'region:NSW', travel: 'commute' }).ok).toBe(false);
    // ordering keeps every role
    const items = [{ id: 'a', latitude: -32.2569, longitude: 148.6011 }, { id: 'b', suburb: 'Gosford', location_state: 'NSW' }, { id: 'c' }];
    expect(match.orderRolesByLocation(items, c).map((x) => x.item.id)).toEqual(['b', 'a', 'c']);
  });
});

// ── the picker, in a very small stand-in for a page ────────────────────────────
function fakePage() {
  const timers = [];
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.className = ''; this.id = ''; this.value = ''; this._text = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, extra) { const e = Object.assign({ type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, extra || {}); (this.listeners[type] || []).forEach((fn) => fn(e)); return e; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    querySelectorAll(sel) { const m = /\[role="(\w+)"\]/.exec(sel); const out = []; const walk = (n) => n.children.forEach((c) => { if (m && c.attrs.role === m[1]) out.push(c); walk(c); }); walk(this); return out; }
  }
  const doc = { activeElement: null, createElement: (tag) => new El(tag) };
  const win = {
    calls: [],
    setTimeout(fn, ms) { timers.push({ fn, ms, dead: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].dead = true; },
    AbortController: class { constructor() { const self = this; this.signal = { aborted: false }; this.abort = () => { self.signal.aborted = true; if (self.signal.onabort) self.signal.onabort(); }; } }
  };
  return { doc, win, timers };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function runTimers(page) { page.timers.filter((x) => !x.dead && !x.ran).forEach((x) => { x.ran = true; x.fn(); }); }
function combo(page, onPick) {
  const c = picker._buildCombobox(page.doc, page.win, { id: 'x', labelId: 'xl', onPick });
  page.doc.activeElement = c.input;
  return c;
}
const answerWith = (page, status, body) => {
  page.win.fetch = (url, init) => {
    page.win.calls.push({ url, init });
    return new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), 0);
    });
  };
};
async function type(page, c, text) { c.input.value = text; c.input.fire('input'); runTimers(page); await tick(); await tick(); await tick(); }
const FIVE = { ok: true, results: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: 'loc:NSW:2000:' + x, label: 'Place ' + x + ' NSW 2000', kind: 'locality' })), total: 5 };

describe('S9-06: a place is chosen on a tap, never at the end of a scroll', () => {
  it('a finger lifted after scrolling the list (touchend) chooses nothing; a tap (click) chooses that row', async () => {
    const page = fakePage();
    const picked = [];
    const c = combo(page, (p) => picked.push(p));
    answerWith(page, 200, FIVE);
    await type(page, c, 'place');
    const options = c.list.querySelectorAll('[role="option"]');
    expect(options.length).toBe(5);
    // scroll: touchstart, touchmove, touchend on a row, and no click (a browser sends none after a scroll)
    options[3].fire('touchstart'); options[3].fire('touchmove'); options[3].fire('touchend');
    expect(picked).toEqual([]);
    expect(c.list.hidden).toBe(false);
    // tap: the browser sends mousedown then click
    const down = options[1].fire('mousedown');
    expect(down.defaultPrevented).toBe(true);          // the search box keeps the focus, so the list stays open for the click
    expect(picked).toEqual([]);                        // pressing alone does not choose
    options[1].fire('click');
    expect(picked).toEqual([{ id: 'loc:NSW:2000:b', label: 'Place b NSW 2000' }]);
    expect(c.list.hidden).toBe(true);
  });
  it('nothing in the file chooses on touchend, and the list can be scrolled by touch', () => {
    const js = stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'js', 'au-location-picker.js'), 'utf8'));
    expect(js).not.toMatch(/addEventListener\(\s*["']touchend["']/);
    expect(js).toMatch(/\.aulp-list\{[^}]*max-height:288px;overflow-y:auto;[^}]*touch-action:pan-y/);
    expect(js).toMatch(/\.aulp-list\{[^}]*overscroll-behavior:contain/);
  });
  it('what the search replaces is really off the screen (a class with its own display beats the hidden attribute)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'js', 'au-location-picker.js'), 'utf8');
    expect(js).toContain('.aulp-chosen[hidden],.aulp-field[hidden],.aulp-tags[hidden]{display:none}');
    const acc = fs.readFileSync(path.join(__dirname, '..', 'js', 'account-au.js'), 'utf8');
    expect(acc).toContain("if (field) { field.hidden = true; field.style.display = 'none'; }");
    expect(acc).toContain("if (legacy) { legacy.hidden = true; legacy.style.display = 'none'; }");
  });
  it('more than fits: every result is in the list (it scrolls), and "keep typing" says how many there are', async () => {
    const page = fakePage();
    const c = combo(page, () => {});
    const many = { ok: true, total: 74, results: Array.from({ length: 74 }, (_, i) => ({ id: 'loc:NSW:2480:p' + i, label: 'Suburb ' + i + ' NSW 2480' })) };
    answerWith(page, 200, many);
    await type(page, c, '2480');
    expect(c.list.querySelectorAll('[role="option"]').length).toBe(74);
    expect(c.list.textContent).not.toContain('Keep typing');
    answerWith(page, 200, { ok: true, total: 196, results: many.results.slice(0, 8) });
    await type(page, c, '248');
    expect(c.list.querySelectorAll('[role="option"]').length).toBe(8);
    expect(c.list.textContent).toContain('Showing 8 of 196. Keep typing to narrow it down.');
  });
});

describe('S9-05 (browser half): the picker waits, cancels and tells the truth', () => {
  it('waits a quarter of a second after the last keystroke; ten quick letters ask the server once', async () => {
    expect(picker.DEBOUNCE_MS).toBeGreaterThanOrEqual(250);
    const page = fakePage();
    const c = combo(page, () => {});
    answerWith(page, 200, FIVE);
    for (const text of ['pa', 'par', 'parr', 'parra', 'parram', 'parrama', 'parramat', 'parramatt', 'parramatta']) { c.input.value = text; c.input.fire('input'); }
    expect(page.timers.filter((x) => !x.dead).length).toBe(1);
    expect(page.timers.every((x) => x.ms === picker.DEBOUNCE_MS)).toBe(true);
    runTimers(page); await tick(); await tick();
    expect(page.win.calls.length).toBe(1);
    expect(page.win.calls[0].url).toBe('/api/au/localities?q=parramatta');
  });
  it('a request a newer one replaces is cancelled, and the same text is not asked twice', async () => {
    const page = fakePage();
    const c = combo(page, () => {});
    answerWith(page, 200, FIVE);
    c.input.value = 'par'; c.input.fire('input'); runTimers(page);
    const first = page.win.calls[0].init.signal;
    expect(first.aborted).toBe(false);
    c.input.value = 'parr'; c.input.fire('input'); runTimers(page);
    expect(first.aborted).toBe(true);                    // superseded: cancelled
    await tick(); await tick(); await tick();
    expect(page.win.calls.length).toBe(2);
    await type(page, c, 'par');                          // first one was cancelled, so it is asked again
    await type(page, c, 'parr');                         // already answered: no new request
    await type(page, c, 'par');
    expect(page.win.calls.length).toBe(3);
  });
  it('"too many searches" is said as that, not blamed on the connection; a real failure still says to check the connection', async () => {
    expect(picker.SEARCH_LIMITED).toBe('Too many searches: wait a moment and try again.');
    const page = fakePage();
    const c = combo(page, () => {});
    answerWith(page, 429, { ok: false, limited: true });
    await type(page, c, 'parra');
    expect(c.list.textContent).toBe('Too many searches: wait a moment and try again.');
    expect(c.list.textContent).not.toMatch(/connection/i);
    answerWith(page, 500, {});
    await type(page, c, 'parram');
    expect(c.list.textContent).toBe('We could not search just now. Check your connection and try again.');
    // a limited answer is not remembered: the same text is asked again once the minute has passed
    answerWith(page, 200, FIVE);
    await type(page, c, 'parra');
    expect(c.list.querySelectorAll('[role="option"]').length).toBe(5);
  });
});

// ── the server ────────────────────────────────────────────────────────────────
const NOW = new Date().toISOString();
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents', 'admin_audit_log', 'candidate_leads',
  'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews', 'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events',
  'ats_offers', 'match_cache', 'career_contracts', 'onboarding_reminders', 'pep_waitlist', 'career_roles', 'practices'];
let h, t, seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const profile = (d) => row('user_profiles', d.userId);
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'f9l' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const VR = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, work_rights: 'citizen', moratorium_19ab_status: 'no' };
const doctor = () => add('au_vr', { selfDeclared: true, credentials: VR });
const search = (d, q) => h.get('/api/au/localities?q=' + encodeURIComponent(q), { cookie: d.cookie });

describe('S9-05 (server half): the suburb search has its own limit', () => {
  beforeAll(async () => {
    const tables = {};
    EMPTY_TABLES.concat(['user_profiles', 'gp_credentials', 'registration_cases', 'user_state']).forEach((name) => { tables[name] = []; });
    h = await bootAuTestServer({ name: 'fr9loc', tables });
    t = h.testUtils;
  }, 60000);
  afterAll(async () => { if (h) await h.close(); });
  beforeEach(() => { h.setSwitch(true); t._auLocalitySearchStore.clear(); });

  it('a doctor can search far more than 30 times a minute (120), and is then told the truth', async () => {
    const d = doctor();
    for (let i = 0; i < 120; i += 1) {
      const res = await search(d, 'parra' + (i % 7));
      expect(res.status, 'search ' + (i + 1)).toBe(200);
    }
    const over = await search(d, 'parra');
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ ok: false, limited: true, message: 'Too many searches: wait a moment and try again.' });
    // another doctor is not affected (the limit is per doctor)
    expect((await search(doctor(), 'parra')).status).toBe(200);
  });
  it('searching never spends the budget Account\'s save uses, and a spent general budget never stops a search', async () => {
    const d = doctor();
    for (let i = 0; i < 60; i += 1) expect((await search(d, 'cai' + i)).status).toBe(200);
    // after 60 searches the general per-user budget (30 a minute) is untouched: Account still reads and saves
    expect((await h.get('/api/account/au-details', { cookie: d.cookie })).status).toBe(200);
    const save = await h.post('/api/account/au-details', { locationChoice: { base: 'loc:QLD:4870:cairns', travel: 'state', places: [] } }, { cookie: d.cookie });
    expect(save.status).toBe(200);
    // the other way round: use up the general budget, the search still answers
    const e = doctor();
    let refused = 0;
    for (let i = 0; i < 35; i += 1) if ((await h.get('/api/account/au-details', { cookie: e.cookie })).status === 429) refused += 1;
    expect(refused).toBeGreaterThan(0);
    expect((await search(e, 'cairns')).status).toBe(200);
  });
  it('the limit itself: 120 per doctor and a higher ceiling per address, both in a one-minute window', () => {
    const at = 1000000;
    for (let i = 0; i < 120; i += 1) expect(t.auLocalitySearchAllowed('doc-1', '10.0.0.1', at + i)).toBe(true);
    expect(t.auLocalitySearchAllowed('doc-1', '10.0.0.1', at + 500)).toBe(false);
    expect(t.auLocalitySearchAllowed('doc-1', '10.0.0.1', at + 61000)).toBe(true);     // a minute later
    t._auLocalitySearchStore.clear();
    // many doctors behind one address: each has their own 120, the address stops at 600
    let allowed = 0;
    for (let u = 0; u < 7; u += 1) for (let i = 0; i < 100; i += 1) if (t.auLocalitySearchAllowed('doc-' + u, '10.0.0.9', at)) allowed += 1;
    expect(allowed).toBe(600);
  });
  it('the reply: every suburb of a postcode typed in full, a total, a named region; still ids and labels only', async () => {
    const d = doctor();
    const pc = await search(d, '2480');
    expect(pc.json.results.length).toBeGreaterThan(8);
    expect(pc.json.total).toBe(pc.json.results.length);
    expect(pc.json.results.map((r) => r.label)).toContain('Lismore NSW 2480');
    const name = await search(d, 'mount');
    expect(name.json.results.length).toBe(8);
    expect(name.json.total).toBeGreaterThan(8);
    const region = await search(d, 'central coast');
    expect(region.json.results[0]).toEqual({ id: 'area:central-coast-nsw', label: 'Central Coast, NSW (region)', kind: 'area' });
    expect((await search(d, 'mt isa')).json.results[0].label).toBe('Mount Isa QLD 4825');
    for (const res of [pc, name, region]) res.json.results.forEach((r) => expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'label']));
    expect(JSON.stringify(pc.json)).not.toMatch(/"lat"|"lng"/);
    // switch off: still 404, and nothing is counted
    h.setSwitch(false);
    t._auLocalitySearchStore.clear();
    expect((await search(d, 'parra')).status).toBe(404);
    expect(t._auLocalitySearchStore.size).toBe(0);
  });
  it('a named region can be saved as where the doctor is based and as a specific place', async () => {
    const d = doctor();
    const save = await h.post('/api/account/au-details', { locationChoice: { base: 'area:central-coast-nsw', travel: 'places', places: ['area:hunter-valley-nsw', 'city:newcastle'] } }, { cookie: d.cookie });
    expect(save.status).toBe(200);
    expect(save.json.locationChoice).toEqual({ base: { id: 'area:central-coast-nsw', label: 'Central Coast, NSW (region)' }, travel: 'places',
      places: [{ id: 'area:hunter-valley-nsw', label: 'Hunter Valley, NSW (region)' }, { id: 'city:newcastle', label: 'Newcastle (whole city)' }], fromEarlierAnswers: false });
    expect(profile(d)).toMatchObject({ current_suburb: 'Central Coast', current_state: 'NSW', current_postcode: null, preferred_city: 'Newcastle' });
  });

  describe('preferred_city is kept in step with the choice', () => {
    const fresh = () => {
      const d = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
      row('user_state', d.userId).state = {};
      return d;
    };
    const body = (over) => ({ auBranch: 'yes', au: Object.assign({ ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
      noticeWeeks: 4, availableFrom: '2026-12-18', base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [], sessions: 8, detailsConfirmed: true }, over || {}) });
    it('signing up again with a choice that has no city CLEARS the old city (it used to stay)', async () => {
      const d = fresh();
      expect((await h.post('/api/onboarding/complete', body(), { cookie: d.cookie })).status).toBe(200);
      expect(profile(d).preferred_city).toBe('Sydney');
      // again, now based in Dubbo within a commute: regional, no single city
      const again = await h.post('/api/onboarding/complete', body({ base: 'loc:NSW:2830:dubbo' }), { cookie: d.cookie });
      expect(again.status).toBe(200);
      expect(profile(d).preferred_locations).toEqual(['Regional NSW']);
      expect(profile(d).preferred_city).toBe(null);
      // and again with a city: it comes back
      await h.post('/api/onboarding/complete', body({ travel: 'places', places: ['city:melbourne'] }), { cookie: d.cookie });
      expect(profile(d).preferred_city).toBe('Melbourne');
    });
    it('Account keeps it in step both ways too', async () => {
      const d = doctor();
      await h.post('/api/account/au-details', { locationChoice: { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] } }, { cookie: d.cookie });
      expect(profile(d).preferred_city).toBe('Sydney');
      await h.post('/api/account/au-details', { locationChoice: { base: 'loc:NSW:2830:dubbo', travel: 'commute', places: [] } }, { cookie: d.cookie });
      expect(profile(d).preferred_city).toBe(null);
    });
    it('an overseas doctor\'s sign-up is untouched: the same replies and the same stored profile with the switch on and off', async () => {
      const overseas = (over) => ({ country: 'GB', preferredCity: 'Perth', targetDate: '2027-03-01', whoMoving: 'Just me', childrenCount: 0 });
      const out = [];
      for (const on of [true, false]) {
        h.setSwitch(on);
        const d = fresh();
        const res = await h.post('/api/onboarding/complete', overseas(), { cookie: d.cookie });
        const p = Object.assign({}, profile(d)); ['user_id', 'email', 'updated_at', 'onboarding_completed_at', 'created_at'].forEach((k) => delete p[k]);
        out.push({ status: res.status, keys: Object.keys(res.json || {}).sort(), p });
      }
      expect(out[0]).toEqual(out[1]);
    });
  });
});
