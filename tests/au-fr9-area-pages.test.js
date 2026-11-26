// Australian GP build, FR-9 (review round 12): what the staff screens DRAW for
// the practice area check (js/au-practice-area.js, run in a sandbox: no browser,
// no network). Every identity is fake.
//
//   M9-06 / M9-08  the "Area: needs a person" list, the card, "Mark as looked at"
//   M9-07          the job editor says a reason is needed and what "Not recorded" does
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const area = require('../lib/au-practice-area.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const STAFF = 'staff.test@gplink-test.local';
const T1 = '2026-11-26T00:00:00.000Z';

function loadStaffScript() {
  const listeners = {}; const elements = {}; const posts = []; const toasts = [];
  const sandbox = {
    window: { confirm: () => true, prompt: () => 'A good enough reason', setTimeout: (fn) => { fn(); return 1; } },
    document: { addEventListener: (t, fn) => { listeners[t] = fn; }, getElementById: (id) => elements[id] || null }
  };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(read('js/au-practice-area.js'), sandbox, { filename: 'au-practice-area.js' });
  const G = sandbox.window.GPAuArea;
  G.bind({ api: (url, opts) => { posts.push({ url, body: opts.body }); return { then: (fn) => fn({ ok: true, outcome: opts.body.action }) }; }, toast: (m) => toasts.push(m), refreshPractice: () => {} });
  return { G, listeners, elements, posts, toasts };
}
const approx = () => area.applyLookup(null, { ok: true, dpaGp: 'unknown', mmm: 3, mmmApproximate: true, confidence: 'approximate', provider: 'fixture', method: 'suburb_centroid', checkedAt: T1, warnings: ['address_not_precise'] },
  { addressKey: 'k', now: T1 }).record;
const practiceRow = (id, name, record) => ({ id, name, address: '77 Other Street', suburb: 'Dubbo', location_state: 'NSW', postcode: '2830', metadata: { au_area: record } });
const cardOf = (row, roleCount) => { const v = area.staffView(row, { roleCount }); return { id: row.id, name: row.name, au_area: { checked: v.checked, status: v.status, label: v.label, consequence: v.consequence, mmmLabel: v.mmmLabel, setBy: v.setBy, disagreement: !!v.disagreement, disputes: v.disputes.length, needsPerson: v.needsPerson } }; };

describe('FR-9: the "Area: needs a person" list on the Practices tab', () => {
  const { G } = loadStaffScript();
  const queried = practiceRow('p1', 'FR9 Query Practice (FAKE)', area.addDispute(area.applyLookup(null, { ok: true, dpaGp: 'yes', mmm: 3, confidence: 'exact', checkedAt: T1 }, { addressKey: 'k', now: T1 }).record, 'We are <b>not</b> in Dubbo', T1));
  const unsure = practiceRow('p2', 'FR9 Unsure Practice (FAKE)', approx());
  const fine = practiceRow('p3', 'FR9 Fine Practice (FAKE)', area.applyLookup(null, { ok: true, dpaGp: 'yes', mmm: 3, confidence: 'exact', checkedAt: T1 }, { addressKey: 'k', now: T1 }).record);

  it('lists each practice with something waiting, in words, and each line opens the practice', () => {
    const html = G.attentionListHtml([cardOf(queried, 1), cardOf(unsure, 2), cardOf(fine, 4), { id: 'p4', name: 'No area sent' }]);
    expect(html).toContain('Area: needs a person (2)');
    expect(html).toContain('These stay here until someone settles them.');
    expect(html).toContain('data-ats="open-practice" data-id="p1"');
    expect(html).toContain('data-ats="open-practice" data-id="p2"');
    expect(html).not.toContain('data-id="p3"');
    expect(html).toContain('FR9 Query Practice (FAKE)');
    // the practice's own words, escaped
    expect(html).toContain('The practice told us its area looks wrong: &quot;We are &lt;b&gt;not&lt;/b&gt; in Dubbo&quot;');
    expect(html).not.toContain('<b>not</b>');
    expect(html).toContain('its 2 roles are hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas)');
  });
  it('draws nothing when nothing is waiting, or when the server sent no area at all', () => {
    expect(G.attentionListHtml([cardOf(fine, 4)])).toBe('');
    expect(G.attentionListHtml([])).toBe('');
    expect(G.attentionListHtml(null)).toBe('');
    expect(G.attentionListHtml([{ id: 'x', name: 'y' }])).toBe('');
  });
  it('the Practices tab draws it for everyone who works practices (not only the CEO)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-practices.js'), 'latin1');
    expect(js).toContain('      auAreaCheckAllHtml(practices) +\n      auAreaTodoHtml(practices) +');
    const fn = js.slice(js.indexOf('function auAreaTodoHtml(practices) {'), js.indexOf('}', js.indexOf('function auAreaTodoHtml(practices) {')) + 1);
    expect(fn).not.toMatch(/isConsultant/);
    // the list's lines use the tab's own "open this practice" hook
    expect(js).toContain('data-ats="open-practice" data-id="');
  });
  it('the card chip: a red "needs a person" chip for a practice whose roles are hidden; red chips show even when the area has no answer yet', () => {
    expect(G.chipHtml(cardOf(unsure, 2).au_area)).toContain('Area: needs a person');
    expect(G.chipHtml(cardOf(unsure, 0).au_area)).not.toContain('Area: needs a person');
    const neverAnswered = { checked: false, label: 'Area not checked yet', disputes: 1, needsPerson: [{ code: 'practice_query', message: 'm' }] };
    expect(G.chipHtml(neverAnswered)).toContain('Practice queried its area');
    expect(G.chipHtml(neverAnswered)).toContain('Area not checked yet');
  });
});

describe('FR-9: the practice card and the job editor', () => {
  it('a note from the practice has a "Mark as looked at" button, which sends the action; a not-confirmed practice with roles says a person is needed', () => {
    const t = loadStaffScript();
    const row = practiceRow('p9', 'FR9 Card Practice (FAKE)', area.addDispute(approx(), 'Wrong town', T1));
    const html = t.G.practiceCardHtml({ id: row.id, name: row.name, au_area: area.staffView(row, { roleCount: 1 }), au_area_roles: {} }, []);
    expect(html).toContain('The practice told us this looks wrong');
    expect(html).toContain('data-au-area="dispute-done">Mark as looked at</button>');
    expect(html).toContain('<b>Needs a person.</b> Priority-area status not confirmed: its role is hidden from every doctor who may only work in a priority area');
    t.elements.auAreaCard = { getAttribute: () => 'p9' };
    t.listeners.click({ target: { closest: () => ({ getAttribute: () => 'dispute-done' }) } });
    expect(t.posts).toEqual([{ url: '/api/ats/practice/area', body: { id: 'p9', action: 'dispute_done' } }]);
    expect(t.toasts).toEqual(['Marked as looked at.']);
    // no open note: no button
    const quiet = practiceRow('p8', 'FR9 Quiet Practice (FAKE)', approx());
    expect(t.G.practiceCardHtml({ id: 'p8', name: 'x', au_area: area.staffView(quiet, { roleCount: 0 }), au_area_roles: {} }, [])).not.toContain('dispute-done');
  });
  it('a hand-set value that was put aside after an address change is said on the card', () => {
    const t = loadStaffScript();
    const exact = { ok: true, dpaGp: 'no', mmm: 1, confidence: 'exact', checkedAt: T1 };
    const hand = area.applyManual(area.applyLookup(null, exact, { addressKey: 'a|dubbo|nsw|2830', now: T1 }).record, { dpa: 'yes', mmm: 3, reason: 'Confirmed by phone', by: STAFF, now: T1, addressKey: 'a|dubbo|nsw|2830' }).record;
    const moved = area.applyLookup(hand, { ok: false, error: 'address_not_located' }, { addressKey: 'b|parramatta|nsw|2150', now: T1 }).record;
    const row = practiceRow('p7', 'FR9 Moved Practice (FAKE)', moved);
    const html = t.G.practiceCardHtml({ id: 'p7', name: 'x', au_area: area.staffView(row, { roleCount: 1 }), au_area_roles: {} }, []);
    expect(html).toContain('The address changed after ' + STAFF + ' set this by hand (In a DPA, MM 3). That value was for the old address, so it is no longer used. Set it by hand again if it still applies.');
  });
  it('the job editor says a reason is needed, and what "Not recorded" does; approval says the whole consequence', () => {
    const { G } = loadStaffScript();
    const rv = area.staffRoleView({ id: 'j1', dpa: false, dpa_status: 'unknown', source_payload: { au_area: { follows: true, site: 'practice' } } }, null);
    const html = G.jobSectionHtml({ role: rv }, 'j1');
    expect(html).toContain('placeholder="Reason (needed when you change the DPA status or Modified Monash by hand)"');
    expect(html).toContain('Choosing &quot;Not recorded&quot; hands this role back to the automatic check: no reason is needed.'.replace(/&quot;/g, '"'));
    expect(G.approvalConfirmText({ role: rv })).toBe('The priority-area status of this role is not confirmed, so no doctor who may only work in a priority area will see it (that includes doctors moving to Australia from overseas). Approve anyway?');
  });
  it('the script still parses and carries no control characters', () => {
    expect(() => new vm.Script(read('js/au-practice-area.js'))).not.toThrow();
    expect(read('js/au-practice-area.js')).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(() => new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-practices.js'), 'latin1'))).not.toThrow();
    expect(() => new vm.Script(read('js/ceo-ats-jobs.js'))).not.toThrow();
  });
});
