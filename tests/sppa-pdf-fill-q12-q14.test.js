import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fillSppaQ7, extractSppaFormFields, autofillSppaStartDate, stampSppaQ12OnScan } = require('../lib/sppa-pdf-fill.js');
const { PDFDocument } = require('pdf-lib');

async function makeScanLikePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.276, 841.89]);
  return Buffer.from(await doc.save());
}

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

  it('the stray "40hrs" FreeText note below the hours box is deleted, other notes kept', async () => {
    const { PDFName } = require('pdf-lib');
    const buf = await fillSppaQ7({ isConflict: false });
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const texts = [];
    for (const page of doc.getPages()) {
      let annots;
      try { annots = page.node.Annots(); } catch (e) { annots = null; }
      if (!annots) continue;
      for (let a = 0; a < annots.size(); a++) {
        const an = doc.context.lookup(annots.get(a));
        if (!an || String(an.get(PDFName.of('Subtype')) || '') !== '/FreeText') continue;
        const c = an.get(PDFName.of('Contents'));
        texts.push((c && c.decodeText ? c.decodeText() : String(c || '')).trim());
      }
    }
    expect(texts).not.toContain('40hrs');
    // The two legitimate page-6 notes survive.
    expect(texts).toContain('Fortnightly');
    expect(texts.some((t) => t.startsWith('Reporting (TSPR-00)'))).toBe(true);
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

// A print-and-scan return has no fields to fill — the date (and hours, when asked) are drawn
// onto the page at the template's box position so the RSO's "Review PDF" shows them on the form.
describe('stampSppaQ12OnScan', () => {
  it('stamps the start date (and hours) onto a 13-page field-less scan', async () => {
    const scan = await makeScanLikePdf(13);
    const out = await stampSppaQ12OnScan(scan, { startDate: '25/01/2027', hoursText: '40hrs Per Week' });
    expect(out.filled).toBe(true);
    expect(out.reason).toBe('stamped_on_scan');
    expect(out.stamped.sort()).toEqual(['hours', 'start_date']);
    expect(out.buffer.length).toBeGreaterThan(scan.length);
  }, 30000);

  it('legacy-scan repairs: white-out of the stray 40hrs and Q14 NO / Q17 YES / Q19 YES crosses', async () => {
    const scan = await makeScanLikePdf(13);
    const out = await stampSppaQ12OnScan(scan, { whiteOutStrayHours: true, crossQ14No: true, crossQ17Yes: true, crossQ19Yes: true });
    expect(out.filled).toBe(true);
    expect(out.stamped.sort()).toEqual(['q14_no', 'q17_yes', 'q19_yes', 'stray_hours_whiteout']);
  }, 30000);

  it('refuses a scan whose layout it cannot trust (wrong page count)', async () => {
    const scan = await makeScanLikePdf(3);
    const out = await stampSppaQ12OnScan(scan, { startDate: '25/01/2027' });
    expect(out.filled).toBe(false);
    expect(out.reason).toBe('scan_layout_unknown');
  }, 30000);

  it('refuses a fillable PDF — fields are filled, not painted over', async () => {
    const filled = await fillSppaQ7({ isConflict: false });
    const out = await stampSppaQ12OnScan(filled, { startDate: '25/01/2027' });
    expect(out.filled).toBe(false);
    expect(out.reason).toBe('has_form_fields');
  }, 30000);
});
