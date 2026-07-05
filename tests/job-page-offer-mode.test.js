// Phase 2 Task 4 — OFFER MODE + inline interview scheduling on pages/job.html
// (plus the folded minors: terminal apply-guard states survive re-renders,
// 70px shell-clearance fallback, career.html Offers-tab reveal chip).
//
// job.html / career.html are static HTML served verbatim, so reading them
// straight from disk is an honest check of exactly what the browser receives.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOB_PAGE_PATH = path.join(__dirname, '..', 'pages', 'job.html');
const CAREER_PAGE_PATH = path.join(__dirname, '..', 'pages', 'career.html');

let html;
let careerHtml;

beforeAll(() => {
  html = fs.readFileSync(JOB_PAGE_PATH, 'utf8');
  careerHtml = fs.readFileSync(CAREER_PAGE_PATH, 'utf8');
});

describe('job.html — offer mode wiring (Phase 2 Task 4)', () => {
  it('never says "RSO" anywhere GP-visible (job.html + career.html)', () => {
    expect(html).not.toMatch(/\bRSO\b/);
    expect(careerHtml).not.toMatch(/\bRSO\b/);
  });

  it('detects the offer via /api/career/my-offer and matches the client roleId', () => {
    expect(html).toContain('/api/career/my-offer');
    expect(html).toContain('function offerTargetsRole');
    // Only live offers flip the page: sent | accepted.
    expect(html).toMatch(/status !== "sent" && status !== "accepted"/);
    expect(html).toMatch(/String\(offerData\.roleId \|\| ""\) === String\(roleId\)/);
  });

  it('bypasses the 10-minute detail cache when an offer is detected', () => {
    expect(html).toContain('bypassCache');
    expect(html).toContain('loadRoleDetail._fromCache');
    expect(html).toMatch(/loadRoleDetail\(roleId, 25000, \{ bypassCache: true \}\)/);
  });

  it('wires accept + decline to the real endpoints with a decline confirm step', () => {
    expect(html).toContain('/api/career/offer/accept');
    expect(html).toContain('/api/career/offer/decline');
    // Decline goes through a confirm sheet with irreversible tone + the
    // Registration Support Officer as the person to talk to first.
    expect(html).toContain('declineOverlay');
    expect(html).toContain("This can't be undone");
    expect(html).toMatch(/renegotiate[\s\S]{0,120}talking to them first/);
  });

  it('offer banner uses the mockup copy and identity comes only from server reveal fields', () => {
    expect(html).toContain('The practice would like to interview you');
    expect(html).toContain('Please respond within 5 days');
    // Banner name interpolation is gated on role.revealed && realPracticeName.
    expect(html).toMatch(/role\.revealed && role\.realPracticeName\) \? String\(role\.realPracticeName\) : ""/);
    // No client-side reveal: the page never writes revealed=true itself.
    expect(html).not.toMatch(/\.revealed\s*=\s*true/);
  });

  it('shows offer terms (billing split, sessions, compensation, start date, notes)', () => {
    expect(html).toContain('billing_split');
    expect(html).toContain('sessions_per_week');
    expect(html).toContain('compensation_range');
    expect(html).toContain('start_date');
    expect(html).toContain('buildOfferTermsHtml');
  });

  it('mirrors the secure-interview slot pipeline: slots endpoint, grouping, book', () => {
    expect(html).toContain('/api/career/interview/slots?applicationId=');
    expect(html).toContain('/api/career/interview/book');
    expect(html).toContain('slot_start_utc');
    expect(html).toContain('function groupSlotsByDay');
    expect(html).toContain('slot.local.gp.tz');
  });

  it('handles every scheduling error branch honestly', () => {
    // 409 slot taken → toast + slot refresh.
    expect(html).toContain('slot_taken');
    expect(html).toContain('That time was just taken');
    // 403 not_available → link back to the offer (mirrors secure-interview).
    expect(html).toContain('not_available');
    expect(html).toMatch(/offer-review\?applicationId=/);
    // 401 → sign-in redirect preserving the return URL.
    expect(html).toContain('redirectToSignIn');
    expect(html).toMatch(/\/pages\/signin\?next=/);
  });

  it('booked card: Zoom join is https-only, calendar link is a Google template URL', () => {
    // Same https guard as secure-interview.html:455.
    expect(html).toMatch(/zoomUrl\.indexOf\("https:\/\/"\) === 0/);
    expect(html).toContain('zoom_join_url');
    expect(html).toContain('https://calendar.google.com/calendar/render');
    expect(html).toMatch(/45 \* 60 \* 1000/); // 45-minute event
    // Calendar title is masked-or-real strictly by the reveal gate.
    expect(html).toMatch(/revealed \? \("Interview — " \+ String\(currentRole\.realPracticeName\)\) : "GP Link practice interview"/);
  });

  it('reschedule goes via the Registration Support Officer — no fake reschedule endpoint', () => {
    expect(html).toContain('Need a different time? Message your Registration Support Officer');
    expect(html).not.toMatch(/interview\/(reschedule|cancel|unbook)/);
    expect(html).not.toContain('unbook(');
  });

  it('sticky bar has the offer-mode states from the mockup', () => {
    expect(html).toContain('Schedule your interview<small>');
    expect(html).toContain('✓ Interview booked<small>');
    expect(html).toContain('at-bapply--offer');
  });

  it('keeps a celebratory moment (ported confetti) on acceptance', () => {
    expect(html).toContain('function launchConfetti');
    expect(html).toMatch(/launchConfetti\(\);/);
  });

  it('folded minor: terminal apply-guard states are never reset back to idle', () => {
    expect(html).toContain('TERMINAL_APPLY_STATES');
    expect(html).toMatch(/applyState !== "applying" && !TERMINAL_APPLY_STATES\.includes\(applyState\)/);
    expect(html).toMatch(/\["already_placed", "closed", "not_qualified", "onboarding"\]/);
  });

  it('folded minor: shell clearance fallback is 70px (matches career.html)', () => {
    expect(html).not.toContain('--gp-shell-bottom-clearance, 0px');
    const seventies = html.match(/--gp-shell-bottom-clearance, 70px/g) || [];
    expect(seventies.length).toBeGreaterThanOrEqual(3);
  });

  it('offer mode shows no applicant counts', () => {
    // renderOfferBody never includes the urgency panel.
    const offerBody = html.match(/function renderOfferBody\(role\) \{[\s\S]*?\n  \}/);
    expect(offerBody).toBeTruthy();
    expect(offerBody[0]).not.toContain('buildUrgencyHtml');
    expect(offerBody[0]).not.toContain('applicantBand');
  });

  it('existing sibling flows stay intact (offer-review / secure-interview links unchanged)', () => {
    // The scheduling error branches point at offer-review, and the CV +
    // apply machinery from Task 3 is still present.
    expect(html).toContain('handleApplyOutcome');
    expect(html).toContain('/api/career/apply');
    expect(html).toContain('cvModal');
  });
});

describe('career.html — Offers tab reveal chip (folded Task-2 minor)', () => {
  it('buildApplicationRowHtml shows the real name + unlocked chip only when server-revealed', () => {
    const fn = careerHtml.match(/function buildApplicationRowHtml\(application\) \{[\s\S]*?\n    \}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toContain('application.revealed === true');
    expect(fn[0]).toContain('isConfidentialText');
    // The checkmark may be stored raw or as a ✓ JS escape — both render
    // identically in the browser.
    expect(fn[0]).toMatch(/(?:✓|\\u2713) IDENTITY UNLOCKED/);
    // Masked treatment kept otherwise.
    expect(fn[0]).toContain('NAME ON ACCEPTANCE');
    expect(fn[0]).toContain('at-mblur');
  });

  it('revealed flag is server-decided and passed through the application pipeline', () => {
    expect(careerHtml).toMatch(/revealed: !!\(app\.role && app\.role\.revealed === true\)/);
    expect(careerHtml).toMatch(/revealed: source\.revealed === true/);
  });

  it('has the unlocked chip style', () => {
    expect(careerHtml).toContain('.at-mini--unlocked');
  });
});
