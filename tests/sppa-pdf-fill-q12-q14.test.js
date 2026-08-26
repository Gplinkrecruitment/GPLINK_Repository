import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fillSppaQ7, extractSppaFormFields, autofillSppaStartDate } = require('../lib/sppa-pdf-fill.js');
const { PDFDocument } = require('pdf-lib');

// Owner rules (2026-08-27, Dr Mercy Obanimoh's return as the example):
// - Q12 hours must be IN the designated box on the form GP Link sends (not below it).
// - Q14 must be crossed NO automatically before the form goes out.
// - A blank Q12 start date on a practice return is filled by GP Link (5 months from the
//   return date) — autofillSppaStartDate does the PDF write.
describe('SPPA-00 template fill: Q12 hours + Q14 NO', () => {
  it('fillSppaQ7 leaves Q14 crossed NO and the hours field populated', async () => {
    const buf = await fillSppaQ7({ isConflict: false });
    const fields = await extractSppaFormFields(buf);
    const byName = {};
    fields.forEach((f) => { byName[f.name] = f; });
    expect(byName['q14'] && byName['q14'].value).toBe('No');
    const hours = byName['Refer to Note C in Notes at the end of this form to help complete the plan'];
    expect(hours && hours.value).toBeTruthy();
  }, 30000);

  it('appearance streams are well-formed (no slash-prefixed dict keys)', async () => {
    // '/Type' as a JS key produces a PDF name literally called "/Type" (#2FType) — a
    // malformed XObject that macOS Preview / Quick Look and print pipelines refuse to
    // render, leaving the filled value invisible on the page.
    const buf = await fillSppaQ7({ isConflict: false });
    expect(buf.includes('#2FType')).toBe(false);
    const dated = await autofillSppaStartDate(buf, '01/02/2027');
    expect(dated.filled).toBe(true);
    expect(dated.buffer.includes('#2FType')).toBe(false);
  }, 30000);
});

describe('autofillSppaStartDate', () => {
  it('fills a blank start date and reports it', async () => {
    const buf = await fillSppaQ7({ isConflict: false });
    const out = await autofillSppaStartDate(buf, '27/01/2027');
    expect(out.filled).toBe(true);
    expect(out.reason).toBe('filled');
    const fields = await extractSppaFormFields(out.buffer);
    const sd = fields.find((f) => f.name === 'ProposedDateSP-start');
    expect(sd && sd.value).toBe('27/01/2027');
  }, 30000);

  it('never overwrites a date the practice entered', async () => {
    const buf = await fillSppaQ7({ isConflict: false });
    const first = await autofillSppaStartDate(buf, '27/01/2027');
    const second = await autofillSppaStartDate(first.buffer, '01/01/2030');
    expect(second.filled).toBe(false);
    expect(second.reason).toBe('already_filled');
  }, 30000);

  it('fails open on a scanned return with no form fields', async () => {
    const blank = await PDFDocument.create();
    blank.addPage([595, 842]);
    const blankBuf = Buffer.from(await blank.save());
    const out = await autofillSppaStartDate(blankBuf, '27/01/2027');
    expect(out.filled).toBe(false);
    expect(out.buffer).toBe(null);
  }, 30000);
});
