// CEO dashboard: contract + optional LETTER OF OFFER (owner request 2026-09-14).
//
// Some practices send the doctor a signed letter of offer as well as the
// employment contract. The candidate drawer's "Upload contract" button now
// opens an inline mini-form (contract required, letter optional) and drives
//   sign-upload(contract) → PUT → [sign-upload(document:'offer_letter') → PUT]
//   → finalize({ …, offerLetter })
// and the Contracts tab renders TWO inline readers for such a row, each
// discrepancy highlighting only the document it was made against.
//
// Also covered: the drawer's interview row used to send a COMPLETED interview
// to the slot picker ("No mutually available times…") — it now says
// "Interview held". The browser-only behaviour (two panes, marks landing in
// the right pane, the wire-once toggle) is verified in headless Chrome; this
// file pins the source so a refactor cannot quietly undo it.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CANDS = read('js/ceo-ats-candidates.js');
const CONTRACTS = read('js/ceo-ats-contracts.js');
const DASH = read('pages/ceo-dashboard.html');

describe('candidate drawer — upload mini-form (contract + optional letter of offer)', () => {
  it('keeps the "Upload contract" button as the entry point, but it now OPENS a form', () => {
    expect(CANDS).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-contract-upload"');
    expect(CANDS).toContain('>Upload contract</button>');
    expect(CANDS).toContain("e.target.closest('.ats-contract-upload')");
    expect(CANDS).toMatch(/if \(cuBtn\) \{ openContractUploadForm\(cuBtn\.getAttribute\('data-app-id'\)\); return; \}/);
    // The old one-file picker is gone — it could only ever take the contract.
    expect(CANDS).not.toContain('function pickContractFile');
    expect(CANDS).not.toContain('function uploadContractFile');
  });

  it('the form has a required contract input and an optional letter-of-offer input, both PDF/DOCX', () => {
    expect(CANDS).toContain('function contractUploadFormHtml(appId)');
    expect(CANDS).toContain('Employment contract (required)<input type="file" class="cu-contract" accept="\' + CONTRACT_ACCEPT + \'">');
    expect(CANDS).toContain('Letter of offer (optional — only if the practice sent one)<input type="file" class="cu-offer-letter" accept="\' + CONTRACT_ACCEPT + \'">');
    expect(CANDS).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-contract-upload-cancel"');
    expect(CANDS).toContain('class="ats-btn ats-btn-primary ats-btn-sm ats-contract-upload-submit"');
    expect(CANDS).toContain('Upload &amp; run AI review');
    // Same inline-form pattern as the send-offer form: rendered into the
    // per-application .ats-offer-box, Cancel restores the offer line.
    expect(CANDS).toMatch(/function openContractUploadForm\(appId\) \{\s*var box = offerBoxFor\(appId\);\s*if \(box\) box\.innerHTML = contractUploadFormHtml\(appId\);/);
    expect(CANDS).toMatch(/if \(cuCancel\) \{ closeOfferForm\(cuCancel\.getAttribute\('data-app-id'\)\); return; \}/);
    expect(CANDS).toMatch(/if \(cuSubmit\) \{ submitContractUpload\(cuSubmit\.getAttribute\('data-app-id'\), c\); return; \}/);
  });

  it('drives sign-upload(contract) → PUT → sign-upload(offer_letter) → PUT → finalize({ offerLetter })', () => {
    const start = CANDS.indexOf('function submitContractUpload(appId, c)');
    expect(start).toBeGreaterThan(-1);
    const fn = CANDS.slice(start, CANDS.indexOf('function contractFiledMessage', start));
    // Contract first (no document param — the server default), then the letter by name.
    expect(fn).toContain("ATS.api('/api/ceo/contract/sign-upload', { method: 'POST', body: { applicationId: String(appId), filename: filename, mimeType: mime } })");
    expect(fn).toContain("ATS.api('/api/ceo/contract/sign-upload', { method: 'POST', body: { applicationId: String(appId), filename: letterName, mimeType: letterMime, document: 'offer_letter' } })");
    expect(fn.indexOf("document: 'offer_letter'")).toBeGreaterThan(fn.indexOf('mimeType: mime } })'));
    // The letter's sign-upload returns the SAME open revision — trust it.
    expect(fn).toContain('if (lsign.contractId) contractId = lsign.contractId;');
    // finalize names the letter only when one was chosen.
    expect(fn).toContain("ATS.api('/api/ceo/contract/finalize'");
    expect(fn).toContain('offerLetter: letter ? { filename: letterName, mimeType: letterMime } : undefined');
    // Raw PUT straight to Storage, unchanged headers (pinned by the manual-upload test too).
    expect(CANDS).toMatch(/method: 'PUT', credentials: 'omit', headers: \{ 'Content-Type': mime, 'x-upsert': 'true' \}/);
    // Narration on the submit button, in order.
    const a = fn.indexOf("narrate('Uploading contract…')");
    const b = fn.indexOf("narrate('Uploading letter of offer…')");
    const c = fn.indexOf("narrate('Running AI review…')");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // Gating + reload exactly as before.
    expect(fn).toContain('if (ATS.refreshContractsAlert) ATS.refreshContractsAlert();');
    expect(fn).toContain('window.atsOpenCandidate(c.case_id);');
    expect(fn).toContain('CONTRACT_MAX_BYTES');
    expect(CANDS).toMatch(/function canFileContract\(a\) \{\s*if \(ATS\.isConsultant && ATS\.isConsultant\(\)\) return false;/);
  });

  it('validates the letter like the contract (type + size) and refuses a letter without a contract', () => {
    expect(CANDS).toContain("if (!file) { ATS.toast('Choose the employment contract first — the letter of offer is optional, the contract is not.'); return; }");
    expect(CANDS).toContain("if (letter && !letterMime) { ATS.toast('Please choose the letter of offer as a PDF or Word (.docx) file.'); return; }");
    expect(CANDS).toContain('if (letter && letter.size > CONTRACT_MAX_BYTES)');
  });

  it('the success toast names both documents when a letter was included', () => {
    expect(CANDS).toContain('function contractFiledMessage(fin, withLetter)');
    expect(CANDS).toContain("var what = (withLetter || fin.hasOfferLetter) ? 'Contract and letter of offer' : 'Contract';");
    expect(CANDS).toContain('ATS.toast(contractFiledMessage(fin, !!letter));');
  });

  it('the contract line shows the letter pill and the partially-signed state', () => {
    const start = CANDS.indexOf('function contractLineHtml(a)');
    const fn = CANDS.slice(start, start + 3500);
    expect(fn).toContain('if (c.has_offer_letter) parts.push(\'<span class="ats-pill muted">Letter of offer + contract</span>\');');
    expect(fn).toContain("c.status === 'sent_to_gp' && !!c.contract_signed !== !!c.offer_letter_signed");
    expect(fn).toContain('Letter signed · contract pending');
    expect(fn).toContain('Contract signed · letter pending');
  });
});

describe('candidate drawer — a COMPLETED interview no longer falls into the slot picker', () => {
  it('has a completed branch BEFORE the slot-picker fallback', () => {
    const start = CANDS.indexOf('// Interview line');
    expect(start).toBeGreaterThan(-1);
    const block = CANDS.slice(start, start + 3600);
    const booked = block.indexOf("a.interview.status === 'booked'");
    const completed = block.indexOf("a.interview.status === 'completed'");
    const fallback = block.indexOf('ats-app-slot-pick');
    expect(booked).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(booked);
    expect(fallback).toBeGreaterThan(completed);
    expect(block).toContain('Interview held');
    expect(block).toContain('<span class="ats-pill green" style="margin-left:8px">Summary saved</span>');
    expect(block).toContain('<span class="ats-pill muted" style="margin-left:8px">No summary</span>');
    // The saved summary excerpt keeps its existing class.
    const completedBlock = block.slice(completed, fallback);
    expect(completedBlock).toContain('<div class="ats-app-interview-summary">');
    // Viewer-local time, like the booked line (the owner travels).
    expect(completedBlock).toContain('toLocaleString()');
    expect(completedBlock).not.toContain('timeZone');
  });
});

describe('Contracts tab — two readers, per-document highlighting and jumps', () => {
  it('keys readers and slots by "<contractId>:<key>" and fetches the letter by name', () => {
    expect(CONTRACTS).toContain("function docKey(contractId, key) { return String(contractId) + ':' + (key || 'contract'); }");
    expect(CONTRACTS).toContain('function ensureDoc(c, key)');
    expect(CONTRACTS).toContain('function paintDoc(c, key)');
    expect(CONTRACTS).toContain('function docHtml(c, key)');
    expect(CONTRACTS).toContain('function quotesFor(c, key)');
    // The contract keeps the endpoint default; the letter asks for itself.
    expect(CONTRACTS).toContain("'/api/ceo/contract/preview?contractId=' + encodeURIComponent(c.id) + (key === 'contract' ? '' : '&document=' + encodeURIComponent(key))");
    expect(CONTRACTS).toContain('data-doc-slot="\' + ATS.escAttr(docKey(c.id, d.key)) + \'"');
    expect(CONTRACTS).toContain('data-doc-slot="\' + ATS.escAttr(docKey(c.id, \'contract\')) + \'"');
  });

  it('lists the documents letter-first and labels them', () => {
    expect(CONTRACTS).toContain('function documentsFor(c)');
    expect(CONTRACTS).toContain("if (letter || (c && c.offerLetterUrl)) out.push({ key: 'offer_letter', label: (letter && letter.label) || 'Letter of offer'");
    expect(CONTRACTS).toContain("out.push({ key: 'contract', label: (contract && contract.label) || 'Employment contract'");
    expect(CONTRACTS).toContain('function hasOfferLetter(c) { return documentsFor(c).length > 1; }');
  });

  it('a discrepancy highlights ONLY the document it names (missing = contract), at its own index', () => {
    expect(CONTRACTS).toContain("function docOf(d) { return d ? (d.document || 'contract') : 'contract'; }");
    const start = CONTRACTS.indexOf('function quotesFor(c, key)');
    const fn = CONTRACTS.slice(start, start + 600);
    expect(fn).toContain("return ds.map(function (d) { return (d && docOf(d) === want) ? (d.contract_says || '') : ''; });");
    // Index alignment: NO filter — a filtered array would shift data-disc numbers.
    expect(fn).not.toContain('.filter(Boolean)');
    expect(CONTRACTS).toContain('applyDomHighlights(rich, quotesFor(c, key))');
    expect(CONTRACTS).toContain("highlightContract(doc.text || '', quotesFor(c, key))");
  });

  it('render() ensures and paints EVERY document of the expanded card', () => {
    const start = CONTRACTS.indexOf('function render(el)');
    const fn = CONTRACTS.slice(start, start + 1400);
    expect(fn).toContain('documentsFor(openCard).forEach(function (d) {');
    expect(fn).toContain('ensureDoc(openCard, d.key);');
    expect(fn).toContain('paintDoc(openCard, d.key);');
  });

  it('rows carry data-jump-doc + a Letter/Contract chip, and both listeners pass the key through', () => {
    expect(CONTRACTS).toContain('function discrepancyRow(d, i, contractId, withLetter)');
    expect(CONTRACTS).toContain('data-jump-doc="\' + ATS.escAttr(dk) + \'"');
    expect(CONTRACTS).toContain("(dk === 'offer_letter' ? 'Letter' : 'Contract')");
    expect(CONTRACTS).toContain('role="button" tabindex="0"');
    const calls = CONTRACTS.match(/jumpToDiscrepancy\(jump\.getAttribute\('data-jump-contract'\), jump\.getAttribute\('data-jump-disc'\), jump\.getAttribute\('data-jump-doc'\)\)/g) || [];
    expect(calls.length).toBe(2); // click + keydown
    expect(CONTRACTS).toContain('function jumpToDiscrepancy(contractId, index, key)');
    expect(CONTRACTS).toContain('var slot = document.querySelector(\'[data-doc-slot="\' + cssEscape(docKey(contractId, key)) + \'"]\');');
  });

  it('two-document rows render two readers with their own links; the header says so', () => {
    expect(CONTRACTS).toContain('function docLinksHtml(url, signedUrl, label)');
    expect(CONTRACTS).toContain('docLinksHtml(isLetter ? c.offerLetterUrl : c.contractUrl, isLetter ? c.offerLetterSignedUrl : c.signedUrl, d.label)');
    expect(CONTRACTS).toContain("(withLetter ? ' · letter of offer + contract' : '')");
    expect(CONTRACTS).toContain("if (withLetter && c.status === 'sent_to_gp' && !!c.contractSignedAt !== !!c.offerLetterSignedAt)");
    expect(CONTRACTS).toContain("smLabel += c.offerLetterSignedAt ? ' · letter signed' : ' · contract signed';");
    // Single-document rows keep the original heading, links block and copy.
    expect(CONTRACTS).toContain('<div class="df-lbl" style="margin:16px 0 6px">Contract</div>');
    expect(CONTRACTS).toContain("(withLetter ? '' : '<div style=\"margin-top:14px\">' + linkHtml + signedLinkHtml + '</div>')");
    expect(CONTRACTS).toContain('click one to jump to it in the contract above');
    expect(CONTRACTS).toMatch(/ATS\.escAttr\(c\.contractUrl\)/);
    expect(CONTRACTS).toMatch(/ATS\.escAttr\(c\.signedUrl\)/);
  });

  it('re-running the AI review forgets BOTH cached readers, and the exports + wire-once guard survive', () => {
    expect(CONTRACTS).toContain('function forgetDocs(contractId)');
    expect(CONTRACTS).toContain('forgetDocs(contractId);');
    expect(CONTRACTS).not.toContain('delete state.docs[contractId]');
    expect(CONTRACTS).toContain('window.__ceoContractHighlight = highlightContract;');
    expect(CONTRACTS).toContain('window.__ceoContractDomHighlight = applyDomHighlights;');
    expect(CONTRACTS).toContain('window.__ceoContractJump = jumpToDiscrepancy;');
    const w = CONTRACTS.indexOf('function wireEvents');
    const body = CONTRACTS.slice(w, w + 1400);
    expect(body.indexOf('__gpContractsWired')).toBeLessThan(body.indexOf('addEventListener'));
  });
});

describe('highlighter keeps discrepancy indexes when a quote belongs to the other document', () => {
  let highlight;
  beforeAll(async () => {
    const vm = await import('node:vm');
    const sandbox = {
      window: {},
      document: { readyState: 'complete', getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
      console, setTimeout, clearTimeout,
      location: { hash: '' }, history: { replaceState: () => {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(read('js/ceo-ats-shared.js'), sandbox, { filename: 'shared' });
    vm.runInContext(CONTRACTS, sandbox, { filename: 'contracts' });
    highlight = sandbox.window.__ceoContractHighlight;
  });

  it('an empty slot (a finding against the letter) leaves the contract finding at index 1', () => {
    // quotesFor() emits '' for the other document's findings, so the mark for
    // discrepancy #1 must still say data-disc="1" — not shift down to 0.
    const out = highlight('Rate is $170.00 per hour. Bonus is $20,000 over two years.', ['', 'Bonus is $20,000 over two years']);
    expect(out.html).toMatch(/<mark data-disc="1">Bonus is \$20,000 over two years<\/mark>/);
    expect(out.html).not.toContain('data-disc="0"');
    expect(out.unmatched).toHaveLength(0);   // an empty slot is not "unmatched"
  });

  it('all-empty quotes render the plain document (no marks, nothing unmatched)', () => {
    const out = highlight('Nothing flagged here & fine.', ['', '']);
    expect(out.html).toBe('Nothing flagged here &amp; fine.');
    expect(out.unmatched).toHaveLength(0);
  });
});

describe('cache-busters', () => {
  it('bumps candidates JS, contracts JS and the ATS CSS to 20260914b (CSS ≥ candidates JS)', () => {
    expect(DASH).toContain('/js/ceo-ats-candidates.js?v=20260914b');
    expect(DASH).toContain('/js/ceo-ats-contracts.js?v=20260914b');
    expect(DASH).toContain('/css/ceo-ats.css?v=20260914b');
    expect(DASH).not.toContain('/js/ceo-ats-candidates.js?v=20260914a');
    expect(DASH).not.toContain('/js/ceo-ats-contracts.js?v=20260914a');
    expect(DASH).not.toContain('/css/ceo-ats.css?v=20260914a');
  });
});
