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

describe('pages/visa.html — document checklist removed (owner request 2026-07-08)', () => {
  it('carries no visa document checklist card or leftover checklist markup/styles', () => {
    expect(visaHtml).not.toContain('Visa document checklist');
    expect(visaHtml).not.toContain('visa-checklist');
    expect(visaHtml).not.toContain('visa-check-item');
    expect(visaHtml).not.toContain('You provide');
    expect(visaHtml).not.toContain('We arrange');
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

  it('tucks the pathway into a collapsible <details> at the bottom of the page', () => {
    expect(visaHtml).toMatch(/<details class="pathway[^"]*" id="pathwayDetails">\s*<summary>Your pathway to permanent residency/);
    // The pathway comes AFTER the live cards, not before them.
    expect(visaHtml.indexOf('id="pathwayDetails"')).toBeGreaterThan(visaHtml.indexOf('id="visaDocsCard"'));
  });
});

// ── 2026-11-05: registration granted → the visa page is the GP's one page ──
// Matches the approved static preview (Step 5 of 6, collapsed journey, AHPRA
// granted strip, "Where things are" 4-step track, document requests, support
// banner with WhatsApp). Still static HTML served verbatim, so disk reads hold.
describe('pages/visa.html — registration-granted redesign (2026-11-05)', () => {
  it('heads the page as Step 5 of 6 · Visa Application on desktop and phone', () => {
    expect(visaHtml).toContain('Step 5 of 6 · Visa Application');
    expect(visaHtml).toContain('<h1 class="page-title">Your visa application</h1>');
    expect(visaHtml).toContain('<div class="step-eyebrow">Step 5 of 6</div>');
    expect(visaHtml).not.toContain('Step 5 of 7');
    // Phone hero and desktop heading both carry the live lead copy.
    expect(visaHtml).toContain('id="heroStepSub"');
    expect(visaHtml).toContain('id="pageSub"');
  });

  it('collapses the journey to "Steps 1 to 4" + the current Visa row, with a Review link to the full hub', () => {
    expect(visaHtml).toContain('id="visaJourney"');
    expect(visaHtml).toContain('Secure placement · MyIntealth · AMC portfolio · AHPRA registration');
    expect(visaHtml).toContain('href="/pages/index?all=1"');
    expect(visaHtml).toContain('data-route="/pages/index?all=1"');
    expect(visaHtml).toContain('id="visaJourneySub"');
    expect(visaHtml).toContain('<span class="journey-pill current">Current</span>');
    // Subtitle is derived from live state, e.g. "Practice engaging migration agent · 4 passports requested from you".
    expect(visaHtml).toContain('"Practice engaging migration agent"');
    expect(visaHtml).toContain('" requested from you"');
  });

  it('shows the AHPRA registration granted strip from `registration`, hidden when null', () => {
    expect(visaHtml).toContain('id="regGranted" hidden');
    expect(visaHtml).toContain('id="regGrantedText"');
    expect(visaHtml).toContain('renderRegistration(data && data.registration)');
    expect(visaHtml).toContain('with supervised-practice conditions');
    expect(visaHtml).toContain("Ahpra's Compliance Team will write to you about acknowledging the conditions within 30 days.");
    expect(visaHtml).toMatch(/link\.href = "\/pages\/my-documents"/);
    expect(visaHtml).toContain('reg.has_conditions');
    expect(visaHtml).toContain('reg.effective_date');
  });

  it('renders "Where things are" with the Agent engaged → Nomination → Lodged → Granted track', () => {
    expect(visaHtml).toContain('<h3 class="visa-card-title">Where things are</h3>');
    expect(visaHtml).toContain('data-stage="agent"');
    expect(visaHtml).toContain('Agent engaged');
    expect(visaHtml).toContain('id="visaTrackLastLabel"');
    expect(visaHtml).toContain('"Engaging migration agent"');
    expect(visaHtml).toContain('"To be confirmed by the practice"');
    expect(visaHtml).toContain('"What happens next"');
    expect(visaHtml).toContain('"Visa granted. We then move you to PBS & Medicare."');
    expect(visaHtml).toContain('addDetail("Planned start", fmtDate(ctx.planned_start, "long"))');
    expect(visaHtml).toContain('addDetail("Who\'s included", whoIsIncluded(data))');
  });

  it('renders the "Documents needed from you" card with the preview empty-state box', () => {
    expect(visaHtml).toContain('id="visaDocsCard" hidden');
    expect(visaHtml).toContain('id="visaDocList"');
    expect(visaHtml).toContain('id="visaDocsChip"');
    expect(visaHtml).toContain('<b>Nothing else is needed from you right now.</b> When the migration agent asks for something (for example birth or marriage certificates, police checks or a health examination), it will appear here as a new request and we will message you on WhatsApp and email.');
    expect(visaHtml).toContain('id="addFamilyBtn"');
    expect(visaHtml).toContain('+ Someone else is moving with you? Add a family member');
    expect(visaHtml).toContain('"● Uploaded, under review"');
    expect(visaHtml).toContain('"● Accepted"');
    expect(visaHtml).toContain('"● Not accepted"');
    expect(visaHtml).toContain('"Re-upload"');
  });

  it('frames support around the named Registration Support Officer with Message + WhatsApp', () => {
    expect(visaHtml).toContain('id="supportBannerTitle"');
    expect(visaHtml).toContain(', your Registration Support Officer, stays with you through the visa."');
    expect(visaHtml).toContain('"Message " + rso');
    expect(visaHtml).toContain('id="supportWhatsApp"');
    expect(visaHtml).toMatch(/id="supportWhatsApp" href="#" target="_blank" rel="noopener" hidden/);
  });

  it('stays mobile-safe and adds no external libraries', () => {
    expect(visaHtml).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.doc-row \{ grid-template-columns: 36px 1fr; \}/);
    const scriptSrcs = Array.from(visaHtml.matchAll(/<script[^>]+src="([^"]+)"/g)).map((m) => m[1]);
    expect(scriptSrcs.length).toBeGreaterThan(0);
    for (const src of scriptSrcs) expect(src, src).toMatch(/^\/js\//);
  });
});
