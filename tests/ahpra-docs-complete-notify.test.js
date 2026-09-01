import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';

// The moment every document across the GP file's three groups — Direct to AHPRA,
// Prepared by Candidate, Prepared by GP LINK — is complete/accepted, the GP must be
// told by email + WhatsApp that the AHPRA step is unlocked, with a CTA into the AHPRA
// page (owner request 2026-09-02). _maybeNotifyAhpraDocsReady owns the check; these
// pins keep its rules and every trigger site wired.
const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');

describe('AHPRA docs-complete notification', () => {
  const fnIdx = server.indexOf('async function _maybeNotifyAhpraDocsReady');
  const fn = server.slice(fnIdx, fnIdx + 9000);

  it('the notifier exists and checks all three groups plus alternate-supervisor CVs', () => {
    expect(fnIdx).toBeGreaterThan(0);
    expect(fn).toContain("m.source === 'institution_docs'");
    expect(fn).toContain("m.source === 'prepared_by_you'");
    expect(fn).toContain('PRACTICE_DOC_KEYS.filter');
    expect(fn).toContain('alt_supervisor_cv_');
  });

  it('a rejected document never counts as done', () => {
    expect(fn).toContain("status !== 'pending' && status !== 'rejected'");
  });

  it('is idempotent via its own sentinels, independent of the stage-transition message', () => {
    expect(server).toContain("const AHPRA_DOCS_COMPLETE_EMAIL_MARKER = 'AHPRA docs complete — email sent'");
    expect(fn).toContain("_hasDoubleTickBeenSent(caseId, 'AHPRA docs complete')");
    // The stage message fires when the journey stage flips — often BEFORE documents
    // finish (Mercy was in the AHPRA stage with her SPPA still under review). This
    // notification must neither be suppressed by it nor stamp its sentinel.
    expect(fn).not.toContain("_hasDoubleTickBeenSent(caseId, 'AHPRA stage')");
    expect(fn).not.toContain("'AHPRA stage started — WhatsApp template sent'");
  });

  it('sends the email with a CTA into the AHPRA page', () => {
    const e = server.indexOf('async function sendAhpraDocsCompleteEmail');
    expect(e).toBeGreaterThan(0);
    const eBlock = server.slice(e, e + 1200);
    expect(eBlock).toContain('Begin AHPRA Registration');
    expect(eBlock).toContain("/pages/ahpra.html");
  });

  it('WhatsApp uses the CTA template with a link placeholder, falling back to the approved stage template', () => {
    expect(server).toContain("ahpra_docs_complete: { templateName: 'gp_link_ahpra_docs_complete', language: 'en' }");
    expect(fn).toContain("sendDoubleTickTemplate(adrPhone, 'ahpra_docs_complete', adrFirstName, [APP_BASE_URL + '/pages/ahpra.html'])");
    expect(fn).toContain("sendDoubleTickTemplate(adrPhone, 'ahpra', adrFirstName)");
    // the shared sender must forward extra placeholders into the template body
    expect(server).toContain(".concat(Array.isArray(extraPlaceholders) ? extraPlaceholders : [])");
  });

  it('fires from every trigger site: pack completion, SPPA submit, RSO file view, hourly cron', () => {
    const calls = server.match(/_maybeNotifyAhpraDocsReady\(/g) || [];
    // definition + 4 trigger sites
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(server).toContain("_maybeNotifyAhpraDocsReady(caseId).catch(function (e) { console.error('[AhpraDocsReady] finalise trigger error:");
    expect(server).toContain("[AhpraDocsReady] sppa-submit trigger error:");
    expect(server).toContain("[AhpraDocsReady] view trigger error:");
    expect(server).toContain("[AhpraDocsReady] cron sweep error:");
  });
});
