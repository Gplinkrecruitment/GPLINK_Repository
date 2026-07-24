// Phase 2 Task 2 — Atlas browse experience on pages/career.html.
//
// The career page is a static HTML file served verbatim (no server-side
// templating), so reading it straight from disk is an honest check of exactly
// what the browser receives. These assertions pin the Atlas rebuild contract:
// tabs + dropdown filters exist, the dead legacy role modal is gone, GP-visible
// copy never says "RSO", the applicant count comes from the deterministic
// applicantBand (never a real count), and the secured-placement machinery that
// must NOT be touched is still present.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAREER_PAGE_PATH = path.join(__dirname, '..', 'pages', 'career.html');

let html;

beforeAll(() => {
  html = fs.readFileSync(CAREER_PAGE_PATH, 'utf8');
});

describe('career.html — Atlas browse rebuild (Phase 2 Task 2)', () => {
  it('has the Roles / Saved / Offers tab bar', () => {
    expect(html).toContain('data-career-tab="browse"');
    expect(html).toContain('data-career-tab="saved"');
    expect(html).toContain('data-career-tab="applications"');
    expect(html).toMatch(/>Roles</);
    expect(html).toMatch(/>Saved</);
    expect(html).toMatch(/>Offers</);
  });

  it('has the billing + location filters, with the eligibility toggle removed', () => {
    expect(html).toContain('id="heroBillingSelect"');
    expect(html).toContain('id="heroLocationSelect"');
    // The eligibility dropdown was removed 2026-07-25: a GP is only ever shown
    // roles they're eligible for, so there is nothing to toggle. Its markup and
    // the "Jobs I'm eligible for" / "All roles" options must be gone.
    expect(html).not.toContain('id="heroEligibilitySelect"');
    expect(html).not.toContain("Jobs I'm eligible for");
  });

  it('billing filter never offers the "Billing to be confirmed" placeholder', () => {
    // getRoleBillingOptions() must drop the no-billing-model placeholder so it
    // can't appear as a selectable billing category in the dropdown.
    const start = html.indexOf('function getRoleBillingOptions');
    expect(start).toBeGreaterThan(-1);
    const fn = html.slice(start, start + 800);
    expect(fn).toContain('value !== "Billing to be confirmed"');
  });

  it('has the masked-identity locked ribbon treatment on cards', () => {
    expect(html).toContain('NAME ON ACCEPTANCE');
    expect(html).toContain('at-mblur');
  });

  it('no longer contains the dead legacy role modal', () => {
    expect(html).not.toContain('roleModal');
  });

  it('no longer contains the legacy how-to-apply modal (nothing opened it)', () => {
    expect(html).not.toContain('howToApplyModal');
  });

  it('never says "RSO" anywhere GP-visible', () => {
    expect(html).not.toMatch(/\bRSO\b/);
  });

  it('spells out Registration Support Officer', () => {
    expect(html).toContain('Registration Support Officer');
  });

  it('uses the deterministic applicantBand for the "N applied" urgency band', () => {
    // The JS reads the server field...
    expect(html).toContain('applicantBand');
    // ...renders it as "{band} applied"...
    expect(html).toContain('${band} applied');
    // ...and has the client-side fallback hash (same djb2 as the server) so a
    // stale cached role still gets a stable band — never Math.random().
    expect(html).toContain('function getApplicantBand');
    expect(html).toMatch(/15 \+ \(h % 9\)/);
    expect(html).not.toMatch(/Math\.random\(\)[^\n]*applied/i);
  });

  it('never renders a real application count for display', () => {
    // The only "applied" band on cards is the band variable; make sure no
    // template renders applications.length as an applied count.
    expect(html).not.toMatch(/applications\.length[^\n]*applied/i);
    // No inventory counts: no "N live roles"-style copy.
    expect(html).not.toMatch(/\d+\s+live roles/i);
    expect(html).not.toMatch(/roles\.length\s*\+\s*["'`][^"'`]*roles/i);
  });

  it('keeps the secured-placement machinery intact', () => {
    expect(html).toContain('renderSecuredPlacement');
    expect(html).toContain('data-career-placement-state');
    expect(html).toContain('securedPracticeName');
    expect(html).toContain('shouldLockCareerToSecuredView');
    expect(html).toContain('enforceLockedCareerView');
    expect(html).toContain('career-mode-secured');
  });

  it('keeps blurred non-qualifying stub rendering (Task 11 concept)', () => {
    expect(html).toContain('buildBlurredRoleCardHtml');
    expect(html).toContain("You don't currently qualify for this role");
    expect(html).toContain('role-card--blurred');
  });

  it('keeps the app-shell embed + card->detail navigation path', () => {
    expect(html).toContain('gp-shell-embedded');
    expect(html).toContain('gpShellNavigate');
    expect(html).toContain('/pages/job?id=');
  });

  it('search haystack is masked fields only (no raw-title fields)', () => {
    const start = html.indexOf('function getFilteredRoles');
    expect(start).toBeGreaterThan(-1);
    const fn = html.slice(start, html.indexOf('async function loadRemoteRoles', start));
    // Masked headline is searchable; free-form token arrays are not.
    expect(fn).toContain('role.practiceName');
    expect(fn).not.toContain('filterTokens');
    expect(fn).not.toContain('role.tags');
  });

  it('applying happens on the job detail page — no in-page apply endpoint call', () => {
    expect(html).not.toContain('/api/career/apply');
    expect(html).not.toContain('applyForRole');
  });
});

// The in-app Australia map (2026-07-25) must (a) label its count as the number
// of practices the GP is eligible for, not "across Australia", and (b) narrow
// its pins to whatever roles survive the current filters/search — never the
// full public catalogue. The list render publishes the visible role-id set and
// the map script intersects PINNABLE against it.
describe('career.html — filter-driven eligible-practice map', () => {
  it('captions the map with the eligible-practice count, not "across Australia"', () => {
    expect(html).toContain('practices you&rsquo;re eligible for');
    expect(html).not.toContain('practices across Australia');
  });

  it('the role list publishes its filtered ids to the map on every render', () => {
    // renderRoles -> syncCareerMap publishes the id set + pokes the map hook.
    expect(html).toContain('syncCareerMap(roles)');
    expect(html).toMatch(/function syncCareerMap\(roles\)/);
    expect(html).toContain('window.__careerVisibleRoleIds');
    expect(html).toContain('window.__careerMapApply');
  });

  it('the map rebuilds its pins from the visible id set (intersection, not all)', () => {
    expect(html).toMatch(/window\.__careerMapApply\s*=\s*function\(ids\)\{VISIBLE=toIdSet\(ids\);renderPins\(\);\}/);
    expect(html).toContain('function renderPins()');
    // A pin is skipped when its id is filtered out of the visible set.
    expect(html).toContain('if(VISIBLE && !VISIBLE[String(p.id)])return;');
    // Count reflects what's actually shown after filtering.
    expect(html).toContain("cEl.textContent=shown");
  });
});
