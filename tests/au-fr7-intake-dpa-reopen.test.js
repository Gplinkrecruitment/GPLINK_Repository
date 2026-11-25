// FR-7 (guide walk): reopening the practice intake link part-way through hid
// the DPA answer buttons until the postcode was typed again.
//
// The three buttons sit inside a box (#aiDpa) that is hidden until something
// paints it. A restored draft painted it only when an AUTOMATIC answer was on
// file, so an address typed by hand (or a lookup that did not answer) came
// back with the question's buttons hidden. The restore itself is `main`'s
// code and is not edited; the repaint is added in the block the server only
// sends with the Australian switch on.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pages/practice-intake.html'), 'utf8');

function lift() {
  const a = html.indexOf('function auShowDpaAfterRestore() {');
  const b = html.indexOf('var auBaseRestoreDraft = restoreDraft;', a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return html.slice(a, b);
}
function el() {
  const classes = new Set();
  return { classes, textContent: '', innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
}
function run(cur, opts) {
  const o = opts || {};
  const nodes = { aiDpa: el(), aiT: el(), aiP: el(), dpaHint: el(), dpaYes: el(), dpaNo: el() };
  if (o.alreadyOn) nodes.aiDpa.classes.add('on');
  if (o.selected) nodes[o.selected].classes.add('sel');
  // eslint-disable-next-line no-new-func
  const fn = new Function('cur', '$', 'auOf', lift() + '; return auShowDpaAfterRestore();');
  const before = JSON.stringify(cur);
  const shown = fn(cur, (id) => nodes[id] || null, (c) => (c.au || (c.au = { dpaAnswer: '' })));
  return { shown, nodes, unchanged: JSON.stringify(Object.assign({}, cur, { au: undefined })) === JSON.stringify(Object.assign({}, JSON.parse(before), { au: undefined })) };
}

describe('the DPA question comes back when a part-finished intake is reopened', () => {
  it('a hand-typed address with no answer yet: the box is shown and the practice is asked', () => {
    const r = run({ address: '10 Test St, Surry Hills, NSW, 2010', dpa: null, dpaSuggested: null });
    expect(r.shown).toBe(true);
    expect(r.nodes.aiDpa.classes.has('on')).toBe(true);
    expect(r.nodes.aiT.textContent).toBe('We could not check this automatically');
    expect(r.nodes.aiP.innerHTML).toContain('Please tell us yourself whether your practice is in a DPA.');
    expect(r.nodes.dpaHint.textContent).toBe('Automatic check unavailable. Please answer.');
    expect(r.unchanged).toBe(true);
  });

  it('an answer already given is still shown as given: the selection is not cleared and nothing saved changes', () => {
    const no = run({ address: 'x', dpa: false, dpaSuggested: null, au: { dpaAnswer: 'no' } }, { selected: 'dpaNo' });
    expect(no.shown).toBe(true);
    expect(no.nodes.aiDpa.classes.has('done')).toBe(true);
    expect(no.nodes.aiT.textContent).toBe('Confirmed by you');
    expect(no.nodes.aiP.innerHTML).toContain('You confirmed: <b>not in a DPA</b>');
    expect(no.nodes.dpaNo.classes.has('sel')).toBe(true);
    expect(no.unchanged).toBe(true);
    const yes = run({ address: 'x', dpa: true, dpaSuggested: null, au: { dpaAnswer: 'yes' } }, { selected: 'dpaYes' });
    expect(yes.nodes.aiP.innerHTML).toContain('You confirmed: <b>in a DPA</b>');
    const unsure = run({ address: 'x', dpa: false, dpaSuggested: null, au: { dpaAnswer: 'unsure' } });
    expect(unsure.nodes.aiP.innerHTML).toContain('You told us you are <b>not sure</b>');
  });

  it('no address yet, or the box already painted (an automatic answer was restored): nothing is touched', () => {
    expect(run({ address: '', dpa: null }).shown).toBe(false);
    const auto = run({ address: 'x', dpa: null, dpaSuggested: true }, { alreadyOn: true });
    expect(auto.shown).toBe(false);
    expect(auto.nodes.aiT.textContent).toBe('');
  });

  it('it runs after every restore, inside the block the server only sends with the switch on; main\'s restore is not edited', () => {
    expect(html).toContain('restoreDraft = function () { var restored = auBaseRestoreDraft(); if (restored) { auShowDpaAfterRestore(); auPaint(); gate2(); } return restored; };');
    const at = html.indexOf('function auShowDpaAfterRestore() {');
    const open = html.lastIndexOf('<!--au:on-->', at);
    const close = html.lastIndexOf('<!--/au:on-->', at);
    expect(open).toBeGreaterThan(close);                           // inside an au:on block
    expect(html.indexOf('<!--/au:on-->', at)).toBeGreaterThan(at);
    // the base function is untouched: its DPA lines are main's
    expect(html).toContain("if (cur.dpaSuggested === true || cur.dpaSuggested === false) paintDpaSuggestion();");
  });
});
