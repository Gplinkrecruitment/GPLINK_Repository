// Phase 2 Task 3, Atlas job detail rebuild on pages/job.html.
//
// job.html is a static HTML file served verbatim (no server-side templating),
// so reading it straight from disk is an honest check of exactly what the
// browser receives. These assertions pin the detail-page rebuild contract:
// GP-visible copy never says "RSO", the applicant count comes from the
// deterministic applicantBand (never a real count), the upgraded apply-guard
// branches exist (CV modal, not-qualified, already-placed, closed, onboarding,
// rate limit), the reveal gate + intro video are wired, and the identity vault
// is a placeholder graphic, never real text under a CSS blur.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOB_PAGE_PATH = path.join(__dirname, '..', 'pages', 'job.html');

let html;

beforeAll(() => {
  html = fs.readFileSync(JOB_PAGE_PATH, 'utf8');
});

describe('job.html, Atlas detail rebuild (Phase 2 Task 3)', () => {
  it('never says "RSO" anywhere GP-visible', () => {
    expect(html).not.toMatch(/\bRSO\b/);
  });

  it('spells out Registration Support Officer (mockup reassurance copy)', () => {
    expect(html).toContain('Registration Support Officer');
    // The "In your corner" strip copy from the mockup is ported.
    expect(html).toContain('reviews every application before the practice sees it');
  });

  it('uses the deterministic applicantBand with the same djb2 fallback as career.html', () => {
    // Reads the server field...
    expect(html).toContain('applicantBand');
    // ...with the identical client fallback formula (same as the server's
    // careerApplicantBand and career.html's getApplicantBand)...
    expect(html).toContain('function getApplicantBand');
    expect(html).toMatch(/15 \+ \(h % 9\)/);
    // ...and never a random or real count. The Task-4 confetti legitimately
    // uses Math.random for particle physics, so the ban is scoped to the
    // band helper + any applicant-count context.
    const bandFn = html.match(/function getApplicantBand\(role\) \{[\s\S]*?\n  \}/);
    expect(bandFn).toBeTruthy();
    expect(bandFn[0]).not.toMatch(/Math\.random/);
    expect(html).not.toMatch(/Math\.random\(\)[^\n]*(applied|applicant|band)/i);
  });

  it('band fallback is deterministic and within 15–23', () => {
    // Extract the function body and evaluate it standalone.
    const match = html.match(/function getApplicantBand\(role\) \{[\s\S]*?\n  \}/);
    expect(match).toBeTruthy();
    const escapeStub = 'const NumberIsInteger = Number.isInteger;';
    // eslint-disable-next-line no-new-func
    const fn = new Function(escapeStub + match[0] + '; return getApplicantBand;')();
    const ids = ['internal_ats:1', 'internal_ats:2', 'zoho_recruit:12345', '', 'x'];
    for (const id of ids) {
      const a = fn({ id });
      const b = fn({ id });
      expect(a).toBe(b); // deterministic
      expect(a).toBeGreaterThanOrEqual(15);
      expect(a).toBeLessThanOrEqual(23);
    }
    // Server-provided band wins when valid.
    expect(fn({ id: 'whatever', applicantBand: 21 })).toBe(21);
    // Out-of-range server value falls back to the hash.
    expect(fn({ id: 'x', applicantBand: 99 })).toBe(fn({ id: 'x' }));
  });

  it('never renders a real application count', () => {
    expect(html).not.toMatch(/applications\.length[^\n]*applied/i);
    expect(html).not.toMatch(/\d+\s*live roles/i);
  });

  it('branches explicitly on every apply guard', () => {
    expect(html).toContain('requiresCv');
    expect(html).toContain('not_qualified');
    expect(html).toContain('already_placed');
    expect(html).toContain('job_closed');
    // Rate limit + onboarding-incomplete handling.
    expect(html).toMatch(/status === 429/);
    expect(html).toMatch(/status === 403/);
    // Onboarding state links out to onboarding.
    expect(html).toContain('"onboarding"');
  });

  it('keeps the CV upload modal machinery', () => {
    expect(html).toContain('cvModal');
    // The modal uploads through the AI-scanned careers CV endpoint (stores
    // document_key career_cv), the legacy /api/career/upload-cv is gone.
    expect(html).toContain('fetch("/api/career/profile/cv"');
    expect(html).not.toContain('/api/career/upload-cv');
    expect(html).toContain('readAsDataURL');
    // The CV retry goes through the same guard-aware outcome handler.
    expect(html).toContain('handleApplyOutcome');
  });

  it('handles the intro video (embed for YouTube/Vimeo, video tag for files)', () => {
    expect(html).toContain('introVideoUrl');
    expect(html).toContain('youtube-nocookie.com/embed/');
    expect(html).toContain('player.vimeo.com/video/');
    expect(html).toMatch(/<video controls/);
    // Omitted entirely when absent: builder returns "" on empty.
    expect(html).toMatch(/if \(!raw\) return ""/);
  });

  it('uses revealedMapQuery at exact zoom post-reveal and mapQuery at suburb zoom pre-reveal', () => {
    expect(html).toContain('revealedMapQuery');
    expect(html).toContain('realPracticeName');
    expect(html).toContain('practiceAddress');
    expect(html).toMatch(/revealed \? 15 : 13/);
    expect(html).toContain('exact address shared on acceptance');
  });

  it('name-on-acceptance dropdown masks the practice identity, never real text under the mask (2026-07 redesign)', () => {
    // Redesign (2026-07) restyled the identity vault into the mockup's dark
    // <details> dropdown (buildPracticeIdentityHtml), same reveal gate,
    // new markup. The masked bar stays a static CSS placeholder: no role
    // field is ever interpolated into it pre-reveal.
    expect(html).toContain('at-noa-mask');
    expect(html).toContain('REVEALED ON ACCEPTANCE');
    expect(html).toMatch(/<div class="at-noa-line"><span class="at-noa-mask"><\/span><\/div>/);
    expect(html).toContain('stay private until you');
  });

  it('keeps the app-shell embedding contract', () => {
    expect(html).toContain('gp-shell-embedded');
    expect(html).toContain('nav-shell-bridge.js');
    expect(html).toContain('--gp-shell-bottom-clearance');
    expect(html).toContain('error-reporter.js');
  });

  it('keeps the role loading flow and saved-state sharing with career.html', () => {
    expect(html).toContain('getRoleIdFromUrl');
    expect(html).toContain('loadRolePreview');
    expect(html).toContain('loadRoleDetail');
    expect(html).toContain('/api/career/role?id=');
    expect(html).toContain('/api/career/hero-image');
    expect(html).toContain('gp_career_state');
    expect(html).toContain('createSavedSnapshot');
    expect(html).toContain('gpShare');
  });

  it('has a single render entry point ready for offer mode (Task 4 seam)', () => {
    expect(html).toMatch(/function renderRole\(role, ctx\)/);
    expect(html).toContain('mode: "standard"');
  });

  it('shares the Atlas visual system with career.html', () => {
    expect(html).toContain('at-scene');
    expect(html).toContain('Source Serif 4');
    expect(html).toContain('DM Sans');
    // Urgency panel + CV-priority line from the mockup.
    expect(html).toContain('High interest in this role');
    expect(html).toContain('shortlisted first');
  });
});
