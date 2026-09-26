// Owner report 2026-09-26 (Dr Fashola): "I'm trying to click on the tab to
// 'fast track to interview' but it's not responding."
//
// The server WAS responding — with 403 requiresSpecialistCert, because his
// MRCGP upload had been auto-rejected on 2026-09-01 (the AI read it as a GMC
// registration certificate). js/match-popup.js swallowed that: any refusal
// other than 200/410 reset the button to its idle label with no message, so
// the tap looked dead. career.html and job.html already collect the
// certificate inline and retry; the popup — the surface a matched doctor sees
// FIRST, and only once — did not.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('match popup: a refused accept is never silent', () => {
  const js = read('js/match-popup.js');
  const handler = js.slice(js.indexOf('function handleAcceptResult'), js.indexOf('function submitAccept'));
  const submit = js.slice(js.indexOf('function submitAccept'), js.indexOf('function openCertPanel'));
  const panel = js.slice(js.indexOf('function openCertPanel'), js.indexOf('if (acceptEl) {'));

  it('parses as a plain script (no syntax smuggled in by the patch)', () => {
    expect(() => new vm.Script(js)).not.toThrow();
  });

  it('answers the specialist-certificate gate inline instead of resetting the button', () => {
    expect(handler).toContain('result.status === 403 && result.body && result.body.requiresSpecialistCert');
    expect(handler).toContain('openCertPanel(result.body)');
  });

  it('prints the server message for every other refusal, and a network-error line on throw', () => {
    expect(handler).toContain('showNote((result && result.body && result.body.message) || ACCEPT_FAILED_FALLBACK)');
    expect(submit).toContain('showNote(ACCEPT_NETWORK_ERROR)');
    // The old silent branch is gone: nothing restores the idle label without a note.
    expect(js).not.toMatch(/acceptEl\.disabled = false;\s*acceptEl\.textContent = "Fast-track to Interview";/);
    expect(js).toContain('<p class="gpmp-note" data-gpmp-note role="alert" hidden></p>');
  });

  it('the success and expired branches are unchanged', () => {
    expect(handler).toContain('result.status === 200 && result.body && result.body.ok');
    expect(handler).toContain('acceptEl.textContent = "Accepted ✓"');
    expect(handler).toContain('result.status === 410');
    expect(js).toMatch(/respond\(match\.applicationId,\s*"accept"\)/);
  });

  it('uploads through the same endpoint and canonical key the gate reads back', () => {
    expect(js).toContain('fetch("/api/onboarding-documents"');
    expect(js).toContain('method: "PUT"');
    expect(js).toContain('key: "onboarding_specialist_qualification"');
    // The gate's own label/country drive the panel; a missing country never posts.
    expect(panel).toContain('(body && body.certLabel) || "specialist GP certificate"');
    expect(panel).toContain('(body && body.certCountry) || ""');
    expect(panel).toContain('if (!country) {');
  });

  it('retries the accept after a successful upload, and restores the button if the doctor backs out', () => {
    expect(panel).toMatch(/closePanel\(\);\s*return submitAccept\(\);/);
    expect(panel).toContain('data-gpmp-cert-cancel');
    expect(panel).toContain('acceptEl.hidden = true;');
    expect(panel).toContain('acceptEl.hidden = false;');
    // Same client-side file rules as career.html's modal.
    expect(panel).toContain('/\\.(pdf|jpe?g|png|webp)$/i.test(file.name || "")');
    expect(panel).toContain('10 * 1024 * 1024');
    // A failed upload reports the server's reason and re-enables the button.
    expect(panel).toContain('(up && up.body && up.body.message) || "Upload failed. Please try again."');
  });

  it('a hidden accept button actually hides (author display:block would otherwise beat [hidden])', () => {
    expect(js).toContain('.gpmp-accept[hidden]{display:none;}');
    expect(js).toContain('.gpmp-note[hidden]{display:none;}');
  });
});

describe('the fix is actually served', () => {
  it('app-shell.html and the service-worker precache pin the new build', () => {
    expect(read('pages/app-shell.html')).toContain('<script src="/js/match-popup.js?v=20260926a" defer></script>');
    expect(read('sw.js')).toContain('"/js/match-popup.js?v=20260926a"');
    expect(read('pages/app-shell.html')).not.toContain('/js/match-popup.js?v=20260904c');
  });
  it('sw.js VERSION moved, or the shell is served from the old precache', () => {
    expect(read('sw.js')).toContain('var VERSION = "20260926a"');
  });
});
