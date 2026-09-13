// Owner 2026-09-14: some practices send a LETTER OF OFFER as well as the
// employment contract, and the doctor must sign BOTH — letter first. These are
// source assertions on the doctor-facing signing page (pages/offer-review.html).
// The single-document flow must be untouched: no `document` field in any POST
// body, no `&document=` on the preview, no step strip.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGE = fs.readFileSync(path.join(ROOT, 'pages/offer-review.html'), 'utf8');

// Slice one function body: from its declaration to the next top-level
// `  function ` at the same indentation (the page's inline script is one IIFE).
function fnBody(name) {
  const start = PAGE.indexOf('function ' + name + '(');
  expect(start, name + ' exists').toBeGreaterThan(-1);
  const next = PAGE.indexOf('\n  function ', start + 10);
  return next > start ? PAGE.slice(start, next) : PAGE.slice(start);
}
// A whole POST call: from the fetch(<route>) to the closing of its body line.
function postBodies(route) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = PAGE.indexOf("fetch('" + route + "'", from);
    if (i < 0) break;
    const b = PAGE.indexOf('body: JSON.stringify(', i);
    const eol = PAGE.indexOf('\n', b);
    out.push(PAGE.slice(b, eol));
    from = eol;
  }
  return out;
}

describe('offer-review: two documents to sign (letter of offer + agreement)', () => {
  it('renders a two-step strip above the reader with real text, ids the tests can pin', () => {
    expect(PAGE).toContain('<ol class="doc-steps" id="contractDocSteps" aria-label="Documents to sign, in order" hidden>');
    expect(PAGE).toContain('id="docStepOfferLetter" data-document="offer_letter"');
    expect(PAGE).toContain('id="docStepContract" data-document="contract"');
    expect(PAGE).toContain('1 · Letter of offer');
    expect(PAGE).toContain('2 · Employment agreement');
    expect(PAGE).toContain('id="docStepOfferLetterState"');
    expect(PAGE).toContain('id="docStepContractState"');
    // The strip sits INSIDE the actions block, above the inline reader.
    const actions = PAGE.indexOf('id="contractActions"');
    const strip = PAGE.indexOf('id="contractDocSteps"');
    const reader = PAGE.indexOf('id="agreementDoc"');
    expect(actions).toBeLessThan(strip);
    expect(strip).toBeLessThan(reader);
  });

  it('marks state in words, not colour alone (✓ Signed / Sign now / Next) and aria-current on the active step', () => {
    const body = fnBody('renderDocSteps');
    expect(body).toContain("signed ? '✓ Signed' : (active ? 'Sign now' : 'Next')");
    expect(body).toContain("li.setAttribute('aria-current', 'step')");
    expect(body).toContain("li.classList.toggle('is-done', signed)");
    expect(body).toContain("li.classList.toggle('is-active', active)");
    // Hidden — not rendered — for the ordinary single-document row.
    expect(body).toContain('if (!contract.hasOfferLetter) { strip.hidden = true; return; }');
  });

  it('the ACTIVE document is the first unsigned one, letter first; single rows have no active key', () => {
    const body = fnBody('pickActiveDocumentKey');
    expect(body).toContain("if (!contract.hasOfferLetter) return ''");
    expect(body).toContain("if (!contractDocs[i].signed) return String(contractDocs[i].key || 'contract')");
    // documents[] is read from the server (letter first); flat flags are a fallback only.
    const docs = fnBody('documentsOf');
    expect(docs).toContain('Array.isArray(contract.documents)');
    expect(docs).toContain("key: 'offer_letter'");
    expect(docs).toContain('contract.offerLetterSigned === true');
  });

  it('heading, intro, button label and download link adapt to the active document; single-document copy is unchanged', () => {
    const body = fnBody('renderContractState');
    expect(body).toContain("if (activeDocumentKey === 'offer_letter') {");
    expect(body).toContain("setText('contractHeading', 'Sign your letter of offer')");
    expect(body).toContain("setText('contractIntro', 'Read your letter of offer below, then sign it — your employment agreement is next.')");
    expect(body).toContain("setText('contractHeading', 'Sign your employment agreement')");
    expect(body).toContain("setText('contractIntro', 'Read your agreement below, then sign it to secure your position.')");
    // The original single-document copy survives verbatim.
    expect(body).toContain("setText('contractHeading', 'Your agreement is ready')");
    expect(PAGE).toContain('<span id="signAgreementBtnLabel">Sign &amp; secure my position</span>');
    expect(body).toContain("setText('signAgreementBtnLabel', 'Sign my letter of offer')");
    // Download follows the active document, falling back to contractUrl.
    expect(body).toContain("String((activeDoc && activeDoc.url) || contract.contractUrl || '')");
    expect(body).toContain("dlLink.textContent = activeDocumentKey === 'offer_letter' ? 'Download letter of offer' : 'Download agreement'");
    expect(PAGE).toContain('id="downloadAgreementLink"');
  });

  it('the reader loads the ACTIVE document, keyed guard so it reloads when the letter gives way to the agreement', () => {
    const body = fnBody('loadAgreementPreview');
    expect(PAGE).not.toContain('var agreementLoaded = false;');
    expect(PAGE).toContain('var agreementLoadedKey = null;');
    expect(body).toContain('if (agreementLoadedKey === docKey || !contractAppId) return;');
    // &document=<key> only when there is a key — the single-document URL is unchanged.
    expect(body).toContain("'/api/career/contract/preview?applicationId=' + encodeURIComponent(contractAppId) + (docKey ? '&document=' + encodeURIComponent(docKey) : '')");
    // A stale response must not overwrite a newer document in the reader.
    expect(body).toContain('if (agreementLoadedKey !== docKey) return;');
    expect(fnBody('renderContractState')).toContain('loadAgreementPreview(activeDocumentKey);');
  });

  it('sends `document` in sign-inapp / sign-upload / finalize-signed bodies ONLY when a letter exists', () => {
    const helper = fnBody('withDocument');
    expect(helper).toContain('if (activeDocumentKey) body.document = activeDocumentKey;');
    expect(helper).toContain('return body;');
    // Every POST body on the signing paths goes through the helper.
    expect(postBodies('/api/career/contract/sign-inapp')).toEqual([
      "body: JSON.stringify(withDocument({ applicationId: contractAppId, signedName: name, signatureDataUrl: sigCanvas.toDataURL('image/png') }))"
    ]);
    expect(postBodies('/api/career/contract/sign-upload')).toEqual([
      'body: JSON.stringify(withDocument({ applicationId: contractAppId, filename: filename, mimeType: mime }))'
    ]);
    expect(postBodies('/api/career/contract/finalize-signed')).toEqual([
      'body: JSON.stringify(withDocument({ applicationId: contractAppId, filename: res.data.filename, mimeType: res.data.mimeType }))',
      'body: JSON.stringify(withDocument({ applicationId: contractAppId, path: storagePath, filename: filename, mimeType: mime }))'
    ]);
    // No bare `document:` literal anywhere in a request body.
    expect(PAGE).not.toMatch(/JSON\.stringify\(\{[^}]*\bdocument:/);
    // request-changes is untouched (no document concept there).
    expect(postBodies('/api/career/contract/request-changes')).toEqual([
      'body: JSON.stringify({ applicationId: contractAppId, message: message })'
    ]);
  });

  it('working copy names the letter while it is the active document', () => {
    const sign = fnBody('signAgreementInApp');
    expect(sign).toContain("setStatus(activeDocumentKey === 'offer_letter' ? 'Signing your letter of offer…' : 'Signing…', false);");
    const upload = fnBody('runSignedUpload');
    expect(upload).toContain("setStatus(activeDocumentKey === 'offer_letter' ? 'Uploading your signed letter of offer…' : 'Uploading your signed contract…', false);");
  });

  it('finalize-signed { allSigned:false } → green status, pad cleared, contract re-fetched and re-rendered; allSigned:true → today\'s handling', () => {
    const sign = fnBody('signAgreementInApp');
    const upload = fnBody('runSignedUpload');
    expect(sign).toContain('if (fin.data.allSigned === false) { onDocumentSigned(fin.data, statusEl); return; }');
    expect(upload).toContain('if (fin.data.allSigned === false) { onDocumentSigned(fin.data, statusEl); return null; }');
    // The allSigned:false branch runs BEFORE the placementSecured branch in both paths.
    for (const body of [sign, upload]) {
      expect(body.indexOf('fin.data.allSigned === false')).toBeLessThan(body.indexOf('if (fin.data.placementSecured) {'));
      // Buttons are re-enabled before the branch, as today.
      expect(body.indexOf('.disabled = false;\n')).toBeGreaterThan(-1);
    }
    const handler = fnBody('onDocumentSigned');
    expect(handler).toContain("(fin && fin.message) || ('Letter of offer signed ✓ — now sign your employment agreement')");
    expect(handler).toContain("statusEl.style.color = '#15803d'");
    expect(handler).toContain('sigClear();');
    expect(handler).toContain('refreshContractState(function (contract) { renderContractState(contract); })');
    const refresh = fnBody('refreshContractState');
    expect(refresh).toContain("fetch('/api/career/contract?applicationId=' + encodeURIComponent(contractAppId), { credentials: 'same-origin' })");
    // Today's secured / "still finalising" handling is untouched.
    expect(sign).toContain("showContractSecured('Position secured 🎉'");
    expect(upload).toContain("showContractSecured('Placement secured 🎉'");
    expect(sign).toContain("showContractSecured('Agreement signed', (fin.data.message || 'Signed — our team is finalising your placement.'))");
    expect(upload).toContain("showContractSecured('Agreement signed', (fin.data.message || 'Signed — our team is finalising your placement.'))");
    // The placement-secured hook count other tests pin (3) is unchanged.
    expect(PAGE.split('window.gpPlacementSecured.applyPlacementSecured(window, contractAppId').length - 1).toBe(3);
  });

  it('status "signed" lists BOTH signed downloads from documents[].url when a letter exists', () => {
    expect(PAGE).toContain('<div class="signed-docs" id="contractSignedDocs" hidden></div>');
    const body = fnBody('renderSignedDocuments');
    expect(body).toContain("if (!contract || !contract.hasOfferLetter) { host.hidden = true; return; }");
    expect(body).toContain('var docs = documentsOf(contract);');
    expect(body).toContain("if (url.indexOf('http') !== 0) continue;");
    expect(body).toContain("a.textContent = 'Download signed ' +");
    expect(body).toContain("a.setAttribute('data-document', String(docs[i].key || ''))");
    // Wired from the 'signed' branch and after the final finalize on two-document rows.
    const render = fnBody('renderContractState');
    expect(render.indexOf("status === 'signed'")).toBeLessThan(render.indexOf('renderSignedDocuments(contract);'));
    expect(fnBody('signAgreementInApp')).toContain('if (activeDocumentKey) refreshContractState(function (c) { renderSignedDocuments(c); });');
    expect(fnBody('runSignedUpload')).toContain('if (activeDocumentKey) refreshContractState(function (c) { renderSignedDocuments(c); });');
  });

  it('changes_requested / practice_review copy is unchanged', () => {
    const body = fnBody('renderContractState');
    expect(body).toContain("setText('contractHeading', 'Your requested changes are with us')");
    expect(body).toContain("setText('contractIntro', \"We've sent your requested changes to your GP Link team. We'll let you know as soon as we hear back from the practice.\")");
    expect(body).toContain("setText('contractHeading', 'The practice is reviewing your changes')");
    expect(body).toContain("setText('contractIntro', 'The practice is considering your requested change. Your GP Link team will be in touch with the outcome.')");
  });

  it('keeps every pinned control id and gates the test hook behind an opt-in flag', () => {
    for (const id of ['signAgreementBtn', 'uploadSignedBtn', 'showChangesBtn', 'submitChangesBtn', 'signedFileInput', 'downloadAgreementLink', 'gpSigPad', 'gpSigClear']) {
      expect(PAGE).toContain('id="' + id + '"');
    }
    expect(PAGE).toContain('if (window.__offerReviewTestEnable === true) {');
    expect(PAGE).toContain('window.__offerReviewTest = {');
    // The guard is the only place the flag is consulted (once, in code — the
    // other mention is its comment), and the page never sets it itself.
    const code = PAGE.replace(/^\s*\/\/.*$/gm, '');
    expect(code.split('window.__offerReviewTestEnable === true').length - 1).toBe(1);
    expect(code).not.toMatch(/__offerReviewTestEnable\s*=[^=]/);
  });
});
