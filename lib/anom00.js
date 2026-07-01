// lib/anom00.js
//
// ANOM-00 "Authorised representative nomination form" fill engine.
//
// The official AHPRA ANOM-00 is a flat, 3-page A4 PDF with NO fillable AcroForm
// fields, so we overlay typed values and signature images at fixed coordinates
// onto the committed template using pdf-lib.
//
// IMPORTANT — the committed template (assets/anom00-template.pdf) is GP LINK's
// ANOM-00 with the company's STANDING details already printed on it: the
// authorised-representative Organisation name, Address, City, State, Country,
// and the Q4 "Do you have an Ahpra account? = YES" tick. The engine therefore
// fills only the PER-CASE variable fields and does NOT redraw those constants
// (drawing over them would double-print). If a truly BLANK ANOM-00 is ever
// used instead, pass `data.blankTemplate = true` to also fill the constants.
// If GP LINK's registered details change, replace assets/anom00-template.pdf.
//
// Two build modes:
//   'rep_only' — Section B rep fields + rep consent signature (Page 3 top).
//                Sent to the doctor to review before they complete their half.
//   'full'     — everything above PLUS Section A applicant details, the Q6
//                authorisations, and the applicant signature.
//
// buildAnom00(data, sigs) is pure: plain data + PNG buffers -> PDF bytes
// (Uint8Array). No DB, no network, no filesystem writes.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'anom00-template.pdf');

// Coordinate map. pdf-lib origin is bottom-left; units are points; A4 = 595x842.
// `page` is 0-based. Text {page,x,y,size}; checkbox mark {page,x,y,size};
// signature image {page,x,y,w,h}. Calibrated against assets/anom00-template.pdf
// via a 50pt coordinate grid overlay (2026-07-02).
const ANOM00_FIELDS = {
  // ── Page 1 — Section A: personal details (applicant / doctor) ──
  familyName:        { page: 0, x: 280, y: 224, size: 10 },
  firstName:         { page: 0, x: 280, y: 193, size: 10 },
  middleName:        { page: 0, x: 280, y: 163, size: 10 },
  dob:               { page: 0, x: 350, y: 107, size: 11 },
  // ── Page 2 — Q2/Q3 (applicant) + Section B (rep) ──
  regNo_x:           { page: 1, x: 366, y: 784, size: 12 }, // Q2 "No" box
  applicantEmail:    { page: 1, x: 285, y: 594, size: 9 },  // Q3 email
  legalName:         { page: 1, x: 285, y: 342, size: 9 },
  repName:           { page: 1, x: 285, y: 312, size: 9 },
  postcode:          { page: 1, x: 448, y: 147, size: 9 },
  repEmail:          { page: 1, x: 285, y: 50,  size: 9 },
  // ── Page 3 — rep consent signature + Q6 (applicant authorisation) ──
  repDate:           { page: 2, x: 100, y: 746, size: 11 },
  repSig:            { page: 2, x: 350, y: 735, w: 150, h: 40 },
  authorises_x:      { page: 2, x: 266, y: 672, size: 12 }, // Q6 "Yes"
  authCommunicate_x: { page: 2, x: 256, y: 617, size: 10 },
  authAct_x:         { page: 2, x: 256, y: 580, size: 10 },
  authReceive_x:     { page: 2, x: 256, y: 541, size: 10 },
  gpDate:            { page: 2, x: 305, y: 495, size: 11 },
  gpSig:             { page: 2, x: 440, y: 484, w: 135, h: 38 },
  // ── Pre-printed on the GP LINK template — only drawn when blankTemplate ──
  hasAccount_x:      { page: 1, x: 300, y: 452, size: 12 }, // Q4 "Yes"
  orgName:           { page: 1, x: 285, y: 256, size: 8 },
  address:           { page: 1, x: 285, y: 232, size: 8 },
  city:              { page: 1, x: 285, y: 183, size: 8 },
  state:             { page: 1, x: 285, y: 147, size: 8 },
  country:           { page: 1, x: 285, y: 113, size: 8 },
};

const INK = { r: 0.05, g: 0.14, b: 0.35 };
const MARK = { r: 0.78, g: 0.15, b: 0.15 };

function toPngBuffer(png) {
  if (!png) return null;
  if (Buffer.isBuffer(png)) return png;
  if (png instanceof Uint8Array) return Buffer.from(png);
  if (typeof png === 'string') {
    const comma = png.indexOf(',');
    const b64 = png.startsWith('data:') && comma >= 0 ? png.slice(comma + 1) : png;
    return Buffer.from(b64, 'base64');
  }
  return null;
}

// buildAnom00(data, sigs)
//   data = { mode, applicant, rep, authorisations, dates, blankTemplate? }
//     applicant = { title, familyName, firstName, middleName, dob, email, registered? }
//     rep       = { fullName, orgName, address, city, state, postcode, country,
//                   email, hasAhpraAccount }
//     authorisations = { communicate, act, receive, authorises }  (full mode)
//     dates     = { rep, gp }  (DD/MM/YYYY strings)
//   sigs = { repSignaturePng, gpSignaturePng }  (Buffer | Uint8Array | base64/dataURL)
// returns Promise<Uint8Array>
async function buildAnom00(data, sigs) {
  const { mode, applicant, rep, authorisations, dates, blankTemplate } = data || {};
  if (!applicant || !rep) throw new Error('anom00: applicant and rep are required');
  const repPng = toPngBuffer(sigs && sigs.repSignaturePng);
  if (!repPng) throw new Error('anom00: rep signature (repSignaturePng) is required');
  const gpPng = toPngBuffer(sigs && sigs.gpSignaturePng);
  if (mode === 'full' && !gpPng) throw new Error('anom00: gp signature (gpSignaturePng) is required for full mode');

  const pdf = await PDFDocument.load(readFileSync(TEMPLATE_PATH));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const ink = rgb(INK.r, INK.g, INK.b);
  const markColor = rgb(MARK.r, MARK.g, MARK.b);

  const put = (key, text) => {
    const f = ANOM00_FIELDS[key];
    if (!f || text == null || text === '') return;
    pages[f.page].drawText(String(text), { x: f.x, y: f.y, size: f.size, font, color: ink });
  };
  const mark = (key) => {
    const f = ANOM00_FIELDS[key];
    if (!f) return;
    pages[f.page].drawText('X', { x: f.x, y: f.y, size: f.size, font, color: markColor });
  };
  const drawSig = async (key, png) => {
    const f = ANOM00_FIELDS[key];
    if (!f || !png) return;
    const img = await pdf.embedPng(png);
    const scale = Math.min(f.w / img.width, f.h / img.height);
    pages[f.page].drawImage(img, { x: f.x, y: f.y, width: img.width * scale, height: img.height * scale });
  };

  // Section A (applicant / doctor)
  put('familyName', applicant.familyName);
  put('firstName', applicant.firstName);
  put('middleName', applicant.middleName);
  put('dob', applicant.dob);
  mark(applicant.registered ? null : 'regNo_x');  // Q2: default No (mid-AHPRA doctor not yet registered)
  put('applicantEmail', applicant.email);

  // Section B (authorised rep / new RSO) — variable fields
  const legalName = [applicant.firstName, applicant.middleName, applicant.familyName].filter(Boolean).join(' ');
  put('legalName', legalName);
  put('repName', rep.fullName);
  put('postcode', rep.postcode);
  put('repEmail', (rep.email || '').toUpperCase());
  put('repDate', dates && dates.rep);
  await drawSig('repSig', repPng);

  // Constants that are PRE-PRINTED on the GP LINK template — only when blank.
  if (blankTemplate) {
    if (rep.hasAhpraAccount) mark('hasAccount_x');
    put('orgName', rep.orgName);
    put('address', rep.address);
    put('city', rep.city);
    put('state', rep.state);
    put('country', rep.country);
  }

  // Q6 authorisations + applicant signature (full mode only)
  if (mode === 'full') {
    const a = authorisations || {};
    if (a.authorises) mark('authorises_x');
    if (a.communicate) mark('authCommunicate_x');
    if (a.act) mark('authAct_x');
    if (a.receive) mark('authReceive_x');
    put('gpDate', dates && dates.gp);
    await drawSig('gpSig', gpPng);
  }

  return pdf.save();
}

module.exports = { buildAnom00, ANOM00_FIELDS, TEMPLATE_PATH };
