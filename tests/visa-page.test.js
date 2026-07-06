// Phase 6 Batch F1 — G2: pages/visa.html is a real stage page, not a placeholder.
//
// visa.html is static HTML served verbatim, so disk reads are an honest check
// of what the browser receives. Contract pinned here:
//   - the "More information will appear here" placeholder is gone;
//   - the page shows the GP's visa STATUS (live fetch of /api/visa/status with
//     an honest couldn't-load → Retry state, plus a no-case "not started" and
//     past-visa "step complete" fallback derived from the journey state);
//   - a subclass-482 document checklist (passport, sponsorship/nomination,
//     health exam, police checks, …) with who-provides framing;
//   - reassuring "handled with your Registration Support Officer's support"
//     copy and a contact affordance reusing the existing support modal;
//   - dynamic values rendered via textContent (no HTML interpolation);
//   - the 482 → 186 pathway content is preserved.
// GP-visible copy must never say the bare "RSO" abbreviation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISA_PATH = path.join(__dirname, '..', 'pages', 'visa.html');

let visaHtml;

beforeAll(() => {
  visaHtml = fs.readFileSync(VISA_PATH, 'utf8');
});

describe('pages/visa.html — placeholder removed', () => {
  it('no longer contains the placeholder banner copy', () => {
    expect(visaHtml).not.toContain('More information will appear here');
    expect(visaHtml).not.toContain('GP Link agent');
  });
});

describe('pages/visa.html — live status section', () => {
  it('has the status card and fetches /api/visa/status', () => {
    expect(visaHtml).toContain('id="visaStatusCard"');
    expect(visaHtml).toContain('id="visaStatusBody"');
    expect(visaHtml).toContain('fetch("/api/visa/status"');
  });

  it('maps every server visa stage to a GP-readable label', () => {
    expect(visaHtml).toContain('Nomination in progress');
    expect(visaHtml).toContain('Application lodged');
    expect(visaHtml).toContain('With the Department of Home Affairs');
    expect(visaHtml).toContain('Visa granted');
    expect(visaHtml).toContain('Needs attention');
  });

  it('handles the no-case state honestly (not started / step complete)', () => {
    expect(visaHtml).toContain("Your visa case hasn't started yet");
    expect(visaHtml).toContain('Step complete');
    // Past-visa derivation mirrors the journey (stage override index > 5).
    expect(visaHtml).toContain('function isPastVisaStage()');
  });

  it('shows an honest couldn\'t-load state with a Retry affordance', () => {
    expect(visaHtml).toContain("We couldn't load your visa status right now.");
    expect(visaHtml).toMatch(/btn\.addEventListener\("click", loadVisaStatus\)/);
  });

  it('renders dynamic values via textContent, never HTML interpolation', () => {
    expect(visaHtml).toContain('node.textContent = String(text)');
    // No template-literal/string-concat innerHTML of application fields.
    expect(visaHtml).not.toMatch(/innerHTML\s*=[^;]*app\./);
  });
});

describe('pages/visa.html — document checklist', () => {
  it('has the checklist section with subclass-482 framing', () => {
    expect(visaHtml).toContain('Visa document checklist');
    expect(visaHtml).toContain('Subclass 482');
  });

  it('covers the core employer-sponsored document set', () => {
    expect(visaHtml).toContain('Current passport');
    expect(visaHtml).toContain('Sponsorship &amp; nomination documents');
    expect(visaHtml).toContain('Signed employment contract');
    expect(visaHtml).toContain('Health examination');
    expect(visaHtml).toContain('Police &amp; character checks');
    expect(visaHtml).toContain('English language evidence');
    expect(visaHtml).toContain('Dependant documents');
  });

  it('frames who provides each item', () => {
    expect(visaHtml).toContain('You provide');
    expect(visaHtml).toContain('We arrange');
  });
});

describe('pages/visa.html — Registration Support Officer support framing', () => {
  it('says the application is handled with the Registration Support Officer', () => {
    expect(visaHtml).toContain('Your Registration Support Officer manages this application with you.');
  });

  it('has a contact affordance wired to the existing support modal', () => {
    expect(visaHtml).toContain('id="contactOfficerBtn"');
    expect(visaHtml).toContain('Contact your Registration Support Officer');
    expect(visaHtml).toContain('id="supportModal"');
    expect(visaHtml).toMatch(/contactOfficerBtn[\s\S]*?openModal\(supportModalEl\)/);
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(visaHtml).not.toMatch(/\bRSO\b/);
  });
});

describe('pages/visa.html — pathway content preserved', () => {
  it('keeps the 482 → 186 → citizenship pathway', () => {
    expect(visaHtml).toContain('Subclass 482 Visa');
    expect(visaHtml).toContain('Subclass 186 Visa');
    expect(visaHtml).toContain('Australian Citizenship');
  });
});
