// Phase 5 Task 1 — GP-journey gap closures (G1, G3, G4, G5, G7).
//
// These pages are static HTML/JS served verbatim (no server-side templating),
// so reading them straight from disk is an honest check of exactly what the
// browser receives. Assertions pin the gap-closure contract:
//   G1/G3 — offer-review.html reveals a post-accept "Schedule your interview"
//           CTA and re-fetches /api/career/my-offer after accepting.
//   G4    — career.html Offers rows render honest terminal ribbons instead of
//           "UNDER REVIEW" for closed applications.
//   G5    — finalising_placement gets a positive client status-meta entry.
//   G7    — /pages/secure-interview is registered in the app-shell route tables.
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

describe('offer-review.html — post-accept interview path (G1 + G3)', () => {
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

  it('renders the post-accept interview state from the server my-offer payload (no client accept re-fetch)', () => {
    // Owner rule (2026-07-23): booking an interview time IS the acceptance, so
    // offer-review no longer POSTs /api/career/offer/accept and no longer
    // re-fetches after a client accept. The celebration panel is populated from
    // the my-offer payload on load whenever the server reports the offer accepted.
    expect(offerHtml).toContain('function renderPostAcceptInterview');
    expect(offerHtml).toContain('renderPostAcceptInterview(data);');
    expect(offerHtml).toMatch(/my-offer[\s\S]*?renderOffer\(data\)/);
  });

  it('the invitation-state CTA links to secure-interview (booking IS acceptance) — no accept POST', () => {
    // The primary "Your Decision" CTA is a plain link to the scheduler; there is
    // no /api/career/offer/accept call anywhere on the page. Decline still posts.
    expect(offerHtml).not.toContain('/api/career/offer/accept');
    expect(offerHtml).toContain('id="chooseInterviewTimeBtn"');
    expect(offerHtml).toMatch(/chooseInterviewTimeBtn[\s\S]*?\/pages\/secure-interview\?applicationId=/);
    expect(offerHtml).toContain('/api/career/offer/decline');
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

describe('career.html — terminal ribbons + finalising meta (G4 + G5)', () => {
  // The ribbon words now live in careerApplicationState — the one state map the
  // Offers list, the under-map strip and the card builder all read (2026-07-31).
  it('renders honest terminal ribbons, not UNDER REVIEW', () => {
    expect(careerHtml).toContain('ribbon: "NOT PROCEEDING"');
    expect(careerHtml).toContain('ribbon: "WITHDRAWN"');
    expect(careerHtml).toContain('ribbon: "OFFER DECLINED"');
    // ...and they are calm, not alarming.
    expect(careerHtml).toMatch(/ribbon: "NOT PROCEEDING", tone: "muted"/);
    expect(careerHtml).toMatch(/ribbon: "WITHDRAWN", tone: "muted"/);
  });

  it('branches the state map on the terminal server statuses', () => {
    expect(careerHtml).toContain('if (key === "not_proceeding")');
    expect(careerHtml).toContain('if (key === "withdrawn")');
    expect(careerHtml).toContain('if (key === "offer_declined")');
  });

  it('gives terminal outcomes an honest, non-review metaLine', () => {
    expect(careerHtml).toContain("This one didn't work out");
    expect(careerHtml).toContain('You withdrew this application.');
    expect(careerHtml).toContain('You declined this offer.');
  });

  it('has a positive finalising_placement client status-meta entry (G5)', () => {
    expect(careerHtml).toContain('key === "finalising_placement"');
    expect(careerHtml).toContain('Offer accepted — finalising your placement');
    // The metaLine string uses a — escape for the em-dash, so match around it.
    expect(careerHtml).toContain("We're finalising the paperwork");
    expect(careerHtml).toContain('your placement page unlocks shortly.');
    expect(careerHtml).toContain('ribbon: "OFFER ACCEPTED"');
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(careerHtml).not.toMatch(/\bRSO\b/);
  });
});

describe('js/app-shell.js — secure-interview route registration (G7)', () => {
  it('registers /pages/secure-interview in the shell route tables', () => {
    // PAGE_PATHS whitelist
    expect(appShellJs).toContain('"/pages/secure-interview": true');
    // NAV_GROUPS mapping (career group)
    expect(appShellJs).toMatch(/"\/pages\/secure-interview":\s*\{\s*desktop:\s*"career"/);
    // IDLE_PREFETCH_ORDER list
    expect(appShellJs).toMatch(/"\/pages\/secure-interview",/);
  });
});
