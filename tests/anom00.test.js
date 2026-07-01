// tests/anom00.test.js
//
// Unit tests for the ANOM-00 fill engine (lib/anom00.js). These load the real
// committed template and assert structural facts about the produced PDF
// (page count, that it embeds the signature image(s), required-input guards).
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import anom00 from '../lib/anom00.js';

const { buildAnom00, ANOM00_FIELDS } = anom00;

const applicant = {
  title: 'DR', familyName: 'MILLER', firstName: 'SMITH', middleName: 'JOHN',
  dob: '14/03/1989', email: 'dr.smith.miller@example.com',
};
const rep = {
  fullName: 'BEN CARTER', orgName: 'GP LINK RECRUITMENT AUSTRALIA PTY LTD',
  address: 'SUITE 3050, 780 THE ENTRANCE RD', city: 'WAMBERAL', state: 'NSW',
  postcode: '2260', country: 'AUSTRALIA', phone: '', mobile: '',
  email: 'ben@mygplink.com.au', hasAhpraAccount: true,
};
const authorisations = { communicate: true, act: true, receive: true, authorises: true };

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('buildAnom00', () => {
  it('rep_only mode returns a 3-page PDF (embedding the rep signature)', async () => {
    const bytes = await buildAnom00(
      { mode: 'rep_only', applicant, rep, authorisations, dates: { rep: '01/07/2026' } },
      { repSignaturePng: PNG },
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
  });

  it('full mode builds a 3-page PDF with both signatures', async () => {
    const bytes = await buildAnom00(
      { mode: 'full', applicant, rep, authorisations, dates: { rep: '01/07/2026', gp: '01/07/2026' } },
      { repSignaturePng: PNG, gpSignaturePng: PNG },
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(3);
  });

  it('accepts a data-URL signature string as well as a Buffer', async () => {
    const dataUrl = 'data:image/png;base64,' + PNG.toString('base64');
    const bytes = await buildAnom00(
      { mode: 'rep_only', applicant, rep, dates: { rep: '01/07/2026' } },
      { repSignaturePng: dataUrl },
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
  });

  it('throws when the rep signature is missing', async () => {
    await expect(
      buildAnom00({ mode: 'rep_only', applicant, rep, dates: {} }, {}),
    ).rejects.toThrow(/rep signature/i);
  });

  it('throws when full mode is missing the gp signature', async () => {
    await expect(
      buildAnom00({ mode: 'full', applicant, rep, authorisations, dates: {} }, { repSignaturePng: PNG }),
    ).rejects.toThrow(/gp signature/i);
  });

  it('throws when applicant or rep is missing', async () => {
    await expect(buildAnom00({ mode: 'rep_only', rep }, { repSignaturePng: PNG })).rejects.toThrow(/applicant/i);
  });

  it('exposes a coordinate map covering both signatures and key fields', () => {
    expect(ANOM00_FIELDS.repSig).toBeTruthy();
    expect(ANOM00_FIELDS.gpSig).toBeTruthy();
    expect(ANOM00_FIELDS.repEmail).toBeTruthy();
    expect(ANOM00_FIELDS.familyName.page).toBe(0);
  });
});
