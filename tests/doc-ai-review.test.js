import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { docAiReviewDecision, rejectionMessageFor, looksLikeWrongDocument } from '../lib/doc-ai-review.js';

// ── Automatic AI document review (owner rule, 2026-09-01) ──
// "The AI does this automatically unless it cannot come to a verdict, then it
// should be manual and I should receive a notification."

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('docAiReviewDecision — the verdict matrix', () => {
  const CLEAN = { verified: true, legible: true, nameMatch: 'match', requiresCertification: false, documentType: 'CCT Certificate', expectedLabel: 'CCT Certificate' };

  it('approves a positively verified, legible, name-matching document', () => {
    expect(docAiReviewDecision(CLEAN)).toEqual({ action: 'approve', reason: 'verified' });
  });
  it('approves when the certified-copy requirement is positively met', () => {
    expect(docAiReviewDecision({ ...CLEAN, requiresCertification: true, certified: true }).action).toBe('approve');
  });
  it('routes unclear certification to a person, never auto-rejects it', () => {
    expect(docAiReviewDecision({ ...CLEAN, requiresCertification: true, certified: false }))
      .toEqual({ action: 'manual', reason: 'certification_unclear' });
  });
  it('a name mismatch ALWAYS goes to a person (name changes are a real flow)', () => {
    expect(docAiReviewDecision({ ...CLEAN, nameMatch: 'mismatch' }).action).toBe('manual');
    expect(docAiReviewDecision({ ...CLEAN, verified: false, nameMatch: false }).action).toBe('manual');
  });
  it('rejects an unreadable file with a re-upload ask', () => {
    expect(docAiReviewDecision({ ...CLEAN, verified: false, legible: false }))
      .toEqual({ action: 'reject', reason: 'illegible' });
  });
  it('rejects a clearly different document', () => {
    const scan = { ...CLEAN, verified: false, documentType: 'Bank statement' };
    expect(looksLikeWrongDocument(scan)).toBe(true);
    expect(docAiReviewDecision(scan)).toEqual({ action: 'reject', reason: 'wrong_document' });
  });
  it('does NOT call a related-sounding document "wrong" (shared meaningful words)', () => {
    const scan = { ...CLEAN, verified: false, documentType: 'CCT completion letter' };
    expect(looksLikeWrongDocument(scan)).toBe(false);
    expect(docAiReviewDecision(scan).action).toBe('manual');
  });
  it('an unverified scan with nothing decisive goes to a person', () => {
    expect(docAiReviewDecision({ ...CLEAN, verified: false, documentType: '' }))
      .toEqual({ action: 'manual', reason: 'not_verified' });
  });
  it('technical failures never decide anything', () => {
    expect(docAiReviewDecision({ technicalError: true }).action).toBe('manual');
    expect(docAiReviewDecision(null).action).toBe('manual');
  });
  it('a contradictory scan (verified but unreadable) goes to a person', () => {
    expect(docAiReviewDecision({ ...CLEAN, legible: false }))
      .toEqual({ action: 'manual', reason: 'contradictory_scan' });
  });
});

describe('rejectionMessageFor — doctor-facing copy', () => {
  it('names the fix, plainly, with no em dashes and no technical wording', () => {
    const a = rejectionMessageFor('illegible', 'CCT Certificate', '');
    const b = rejectionMessageFor('wrong_document', 'Primary Medical Degree', 'Bank statement');
    for (const msg of [a, b]) {
      expect(msg).not.toMatch(/—/);
      expect(msg.toLowerCase()).not.toContain('error');
      expect(msg.toLowerCase()).toContain('upload');
    }
    expect(b).toContain('Bank statement');
    expect(b).toContain('Primary Medical Degree');
  });
});

describe('server wiring (source pins)', () => {
  const serverJs = read('server.js');

  it('processDocumentUpload unwraps the storage download (the bug that killed the pipeline)', () => {
    expect(serverJs).toMatch(/var dlObj = await supabaseStorageDownloadObject\(SUPABASE_DOCUMENT_BUCKET, storagePath\);\s*\n\s*if \(!dlObj \|\| !dlObj\.buffer\) return;/);
  });
  it('the doc-ai-review cron exists, is scheduled, and uses the shared decision lib', () => {
    expect(serverJs).toContain("pathname === '/api/cron/doc-ai-review'");
    expect(serverJs).toMatch(/'doc-ai-review': \{ schedule: '\*\/10 \* \* \* \*'/);
    expect(serverJs).toContain('docAiReview.docAiReviewDecision(');
    expect(read('vercel.json')).toContain('"/api/cron/doc-ai-review"');
  });
  it('no-verdict documents get a review task (the CEO alert counts those tasks)', () => {
    const cron = serverJs.slice(serverJs.indexOf("pathname === '/api/cron/doc-ai-review'"));
    const block = cron.slice(0, cron.indexOf('[DocAiReview/Cron]'));
    expect(block).toContain("darSetState('manual_required')");
    expect(block).toContain('ensureDocReviewOnUpload(darUid');
  });
  it('auto-reject routes onboarding documents back to the WIZARD, others to My Documents', () => {
    expect(serverJs).toMatch(/darStage === 'onboarding' \? '\/pages\/onboarding\.html' : '\/pages\/my-documents\.html'/);
  });
  it('the CEO dashboard carries the pending-review count and the UI shows it', () => {
    expect(serverJs).toContain('doc_reviews_pending: docReviewsPending');
    const ceoHtml = read('pages/ceo-dashboard.html');
    expect(ceoHtml).toContain('id="masterDocReviewAlert"');
    expect(ceoHtml).toContain('d.doc_reviews_pending');
    expect(read('js/ceo-ats-candidates.js')).toContain('doc_reviews_pending');
  });
  it('per-candidate counts ride /api/ceo/candidates', () => {
    expect(serverJs).toMatch(/r\.doc_reviews_pending = \(r\.case_id && drByCase\[r\.case_id\]\) \|\| 0;/);
  });
});
