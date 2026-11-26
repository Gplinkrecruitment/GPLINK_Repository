// Australian GP build, FR-9 (finishing pass), pure parts of the sorting / register-lookup items:
//   S9-04  a condition heading is recognised as WHOLE text, once, and only with all of its standard
//          wording under it (it used to be matched by its first words)
//   S9-02 / S9-08  the staff AI context never calls the automatic register lookup "staff"
//   S9-02 / S9-08  the staff screen never labels the automatic lookup as a person's confirmation,
//          and a hold the lookup wrote is not "a person has looked"
// Each test fails on the code before this pass.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const sorting = require('../lib/au-work-sorting.js');
const FX = require('../lib/ahpra-register-fixtures.js');
const aiContext = require('../lib/au-ai-context.js');

const STD = FX.STANDARD_SUPERVISED_PRACTICE_CONDITIONS;
const lines = STD.split('\n');
const h1 = lines.find((l) => /^1\. /.test(l));
const h2 = lines.find((l) => /^2\. /.test(l));

describe('S9-04: headings are whole text, once, with all of their wording', () => {
  it('the owner\'s standard set is still standard', () => {
    expect(sorting.classifyConditions(STD).standard).toBe(true);
  });
  it.each([
    ['words added after heading 1', STD.replace(h1, h1 + ' and must not consult female patients without a chaperone')],
    ['words added after heading 2', STD.replace(h2, h2 + '; must not prescribe Schedule 8')],
    ['a fourth condition reusing a standard heading\'s opening words', STD + '\n4. Complete supervised practice for suitability and eligibility – anything at all\n4.1 The practitioner must:'],
    ['a standard heading with only one generic sentence under it', h1 + '\n1.1 The practitioner must:'],
    ['a standard heading repeated', STD + '\n' + h1],
    ['a different pathway named in the heading', STD.replace(h1, h1.replace('Expedited Specialist pathway', 'Specialist pathway'))]
  ])('%s: not standard, a person looks', (name, text) => {
    const c = sorting.classifyConditions(text);
    expect(c.standard, JSON.stringify(c.unrecognised)).toBe(false);
    expect(c.unrecognised.length).toBeGreaterThan(0);
  });
});

describe('S9-02 / S9-08: the staff AI context says who checked', () => {
  const text = (chk) => aiContext.auStateFactLines({ ahpraChecked: chk }).join('\n');
  it('a check the automatic lookup completed is not "done by staff"', () => {
    const t = text({ at: '2026-11-26T07:25:09Z', verified: true, by: 'automatic register lookup (fixture)' });
    expect(t).not.toMatch(/by staff/i);
    expect(t).toMatch(/automatically by the register lookup/);
    expect(t).toMatch(/no staff member has checked it/);
  });
  it('a hold the lookup wrote is not "looked at by staff"', () => {
    const t = text({ at: '2026-11-26T07:25:09Z', verified: false, by: 'automatic register lookup (fixture) (lookup hold: name_mismatch)' });
    expect(t).not.toMatch(/by staff/i);
    expect(t).toMatch(/a person needs to check/);
  });
  it('a person\'s check reads as before', () => {
    expect(text({ at: '2026-11-26T07:25:09Z', verified: true, by: 'Test Consultant' })).toMatch(/done by staff on 2026-11-26/);
    expect(text({ at: '2026-11-26T07:25:09Z', verified: false, by: 'Test Consultant' })).toMatch(/looked at by staff on 2026-11-26/);
  });
});

describe('S9-02 / S9-08: the staff screen (js/ceo-ats-candidates.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
  it('a pathway the automatic lookup set has its own pill, never "Confirmed by staff"', () => {
    expect(src).toMatch(/Set by the automatic register lookup \(no person has checked\)/);
    expect(src).toMatch(/autoSet = \/\^automatic register lookup\/i/);
    expect(src).toMatch(/Pathway set by the automatic register lookup; no person has checked it/);
  });
  it('the 19AB line no longer promises a task it cannot see', () => {
    expect(src).not.toMatch(/a task is open for it/);
  });
  it('a hold the lookup wrote does not count as "a person has looked" for filling in the check form', () => {
    const m = /var staffSeen = ([^;]+);/.exec(src);
    expect(m && m[1]).toMatch(/byLookup\(cred\.ahpra_last_checked_by\)/);
    expect(src).toMatch(/var autoDone = [^;]*!lk\.hold\)/);
  });
});
