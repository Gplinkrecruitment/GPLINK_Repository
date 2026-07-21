// Phase 5 Task 1, GP-journey gap closures (G1, G3, G4, G5, G7).
//
// These pages are static HTML/JS served verbatim (no server-side templating),
// so reading them straight from disk is an honest check of exactly what the
// browser receives. Assertions pin the gap-closure contract:
//   G1/G3, offer-review.html reveals a post-accept "Schedule your interview"
//           CTA and re-fetches /api/career/my-offer after accepting.
//   G4   , career.html Offers rows render honest terminal ribbons instead of
//           "UNDER REVIEW" for closed applications.
//   G5   , finalising_placement gets a positive client status-meta entry.
//   G7   , /pages/secure-interview is registered in the app-shell route tables.
// GP-visible copy must never say the bare "RSO" abbreviation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFER_REVIEW_PATH = path.join(__dirname, '..', 'pages', 'offer-review.html');
const CAREER_PATH = path.join(__dirname, '..', 'pages', 'career.html');
const APP_SHELL_JS_PATH = path.join(__dirname, '..', 'js', 'app-shell.js');

let offerHtml;
let careerHtml;
let appShellJs;

beforeAll(() => {
  offerHtml = fs.readFileSync(OFFER_REVIEW_PATH, 'utf8');
  careerHtml = fs.readFileSync(CAREER_PATH, 'utf8');
  appShellJs = fs.readFileSync(APP_SHELL_JS_PATH, 'utf8');
});

describe('offer-review.html, post-accept interview path (G1 + G3)', () => {
  it('has a post-accept interview CTA inside the celebration panel', () => {
    expect(offerHtml).toContain('id="postAcceptInterview"');
    expect(offerHtml).toContain('id="postAcceptInterviewBtn"');
    expect(offerHtml).toContain('Schedule your interview');
    // Booked-summary counterpart for an already-scheduled interview.
    expect(offerHtml).toContain('id="postAcceptBookedNote"');
    expect(offerHtml).toContain('id="postAcceptBookedZoom"');
  });

  it('deep-links the CTA to the proven secure-interview booking page', () => {
    expect(offerHtml).toMatch(/postAcceptInterviewBtn[\s\S]*?\/pages\/secure-interview\?applicationId=/);
  });

  it('re-fetches /api/career/my-offer after a successful accept', () => {
    expect(offerHtml).toContain('function refreshPostAcceptInterview');
    expect(offerHtml).toContain('refreshPostAcceptInterview();');
    expect(offerHtml).toMatch(/refreshPostAcceptInterview[\s\S]*?\/api\/career\/my-offer/);
  });

  it('guards the booked Zoom link to https only', () => {
    expect(offerHtml).toMatch(/postAcceptBookedZoom[\s\S]*?indexOf\('https:\/\/'\)/);
  });

  it('leads the post-accept narrative with interview then contract (G3)', () => {
    expect(offerHtml).toContain('<strong>Schedule your interview</strong>');
    expect(offerHtml).toContain('<strong>Contract &amp; registration</strong>');
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(offerHtml).not.toMatch(/\bRSO\b/);
  });
});

describe('career.html, terminal ribbons + finalising meta (G4 + G5)', () => {
  it('renders honest terminal ribbons, not UNDER REVIEW', () => {
    expect(careerHtml).toContain('>NOT PROCEEDING<');
    expect(careerHtml).toContain('>WITHDRAWN<');
    expect(careerHtml).toContain('>OFFER DECLINED<');
  });

  it('branches the row builder on the terminal server statuses', () => {
    expect(careerHtml).toContain('actionStatusKey === "not_proceeding"');
    expect(careerHtml).toContain('actionStatusKey === "withdrawn"');
    expect(careerHtml).toContain('actionStatusKey === "offer_declined"');
  });

  it('gives terminal outcomes an honest, non-review metaLine', () => {
    expect(careerHtml).toContain("This one didn't work out");
    expect(careerHtml).toContain('You withdrew this application.');
    expect(careerHtml).toContain('You declined this offer.');
  });

  it('has a positive finalising_placement client status-meta entry (G5)', () => {
    expect(careerHtml).toContain('key === "finalising_placement"');
    expect(careerHtml).toContain('Offer accepted, finalising your placement');
    // The metaLine string uses a, escape for the em-dash, so match around it.
    expect(careerHtml).toContain("We're finalising the paperwork");
    expect(careerHtml).toContain('your placement page unlocks shortly.');
    expect(careerHtml).toContain('>OFFER ACCEPTED<');
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(careerHtml).not.toMatch(/\bRSO\b/);
  });
});

describe('js/app-shell.js, secure-interview route registration (G7)', () => {
  it('registers /pages/secure-interview in the shell route tables', () => {
    // PAGE_PATHS whitelist
    expect(appShellJs).toContain('"/pages/secure-interview": true');
    // NAV_GROUPS mapping (career group)
    expect(appShellJs).toMatch(/"\/pages\/secure-interview":\s*\{\s*desktop:\s*"career"/);
    // IDLE_PREFETCH_ORDER list
    expect(appShellJs).toMatch(/"\/pages\/secure-interview",/);
  });
});
