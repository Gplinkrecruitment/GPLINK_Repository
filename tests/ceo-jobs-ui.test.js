import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Phase 3 Task 4 — static source pins on the CEO Jobs tab client script
// (same style as tests/ceo-practices-ui.test.js: readFile + regex asserts).
const root = process.cwd();
const src = fs.readFileSync(path.join(root, 'js/ceo-ats-jobs.js'), 'utf8');
const ceo = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');

// The settings-submit region only (so legacy-key assertions are scoped to it).
const submitStart = src.indexOf('function submitJobSettings');
const submitEnd = src.indexOf('REVIEW & APPROVE MODAL');
const submit = src.slice(submitStart, submitEnd);

// The add-job (manual creation) region.
const addStart = src.indexOf('function submitAddJob');
const addEnd = src.indexOf('JOB SETTINGS MODAL');
const addJob = src.slice(addStart, addEnd);

describe('CEO Jobs tab UI (Phase 3 Task 4)', () => {
  it('settings submit sends billing_style, never the legacy free-text billing key', () => {
    expect(submit).toMatch(/'billing_style',\s*'atsJsBilling'/);
    // The legacy `billing:` PATCH key must not appear on the submit path.
    expect(submit).not.toMatch(/\bbilling:/);
    expect(submit).not.toMatch(/\['billing',/);
  });

  it('editor carries the intake-parity fields (address, intro video, percentage split)', () => {
    expect(src).toMatch(/id="atsJsAddress"/);
    expect(src).toMatch(/id="atsJsIntroVideo"/);
    expect(src).toMatch(/id="atsJsPctSplit"/);
    // And the submit diffs them with the intake vocabulary keys.
    expect(submit).toMatch(/'address',\s*'atsJsAddress'/);
    expect(submit).toMatch(/'intro_video_url',\s*'atsJsIntroVideo'/);
    expect(submit).toMatch(/'percentage_split',\s*'atsJsPctSplit'/);
  });

  it('DPA is an explicit yes/no toggle wired into the payload', () => {
    // The settings modal + submit both reference the DPA hidden field id.
    expect(src).toMatch(/dpaSegment\('atsJsDpa', 'atsJsDpaSeg'/);
    expect(src).toMatch(/val\('atsJsDpa'\)/);
    expect(src).toMatch(/data-dpa-val=/);
    expect(src).toMatch(/DPA eligible/);
    // Diff sends dpa but never strips it with a null.
    expect(submit).toMatch(/body\.dpa = dpaCur/);
    expect(submit).toMatch(/dpaCur !== null/);
  });

  it('shows a read-only masked-title preview that updates after save', () => {
    expect(src).toMatch(/id="atsJsMaskedPreview"/);
    expect(src).toMatch(/Doctor-facing title \(masked\)/);
    expect(submit).toMatch(/d\.editor && d\.editor\.masked_title/);
  });

  it('surfaces 400 validation messages inline, not just a toast', () => {
    expect(src).toMatch(/function jsError/);
    expect(submit).toMatch(/jsError\(\(d && d\.message\)/);
  });

  it('manual creation posts the full intake via the intake POST path', () => {
    expect(addJob).toMatch(/intake:\s*intake/);
    expect(addJob).toMatch(/practice_id:\s*practiceId/);
    // Required intake fields are present and required client-side.
    expect(addJob).toMatch(/billing_style:\s*billingStyle/);
    expect(addJob).toMatch(/dpa:\s*dpa/);
    expect(addJob).toMatch(/percentage_split:\s*pctSplit/);
    expect(addJob).toMatch(/suburb:\s*suburb/);
    expect(addJob).toMatch(/nearest_city:\s*nearestCity/);
    expect(addJob).toMatch(/address:\s*address/);
    // Pending explanation after success.
    expect(addJob).toMatch(/PENDING/);
  });

  it('add-job practice select hints corporations', () => {
    expect(src).toMatch(/org_type === 'corporation'/);
    expect(src).toMatch(/\(Corporation\)/);
  });

  it('job cards carry a cosmetic DPA / Non-DPA chip', () => {
    expect(src).toMatch(/function dpaChip/);
    expect(src).toMatch(/>DPA<\/span>/);
    expect(src).toMatch(/>Non-DPA<\/span>/);
  });

  it('settings enum selects guard against a phantom blank-baseline diff', () => {
    // A selected "— Not set —" (value "") option is prepended when the baseline
    // billing_style / type is empty or unmapped, so an untouched select does
    // not default to the first real option and silently PATCH it.
    expect(src).toMatch(/— Not set —/);
    expect(src).toMatch(/<option value="" selected>— Not set —<\/option>/);
    // Both the billing and type selects use the blank-guarding helpers.
    expect(src).toMatch(/id="atsJsBilling">'\s*\+\s*valueOptionsMaybeBlank\(BILLING_STYLE_OPTS, e\.billing_style\)/);
    expect(src).toMatch(/id="atsJsType">'\s*\+\s*plainOptionsMaybeBlank\(JOB_TYPES, e\.employment_type\)/);
  });

  it('create + save buttons are disabled during their round-trip (no double-submit)', () => {
    // Add-job create button is disabled while POSTing, re-enabled on error.
    expect(addJob).toMatch(/atsAddJobCreate/);
    expect(addJob).toMatch(/createBtn\.disabled = true/);
    expect(addJob).toMatch(/createBtn\.disabled = false/);
    // Settings save button is disabled while PATCHing, re-enabled on error.
    expect(submit).toMatch(/atsJsSave/);
    expect(submit).toMatch(/saveBtn\.disabled = true/);
    expect(submit).toMatch(/saveBtn\.disabled = false/);
  });

  it('drops the dead masked-preview write on save (toast carries the title)', () => {
    // The modal is destroyed on save, so it must not poke atsJsMaskedPreview.
    expect(submit).not.toMatch(/atsJsMaskedPreview/);
    // The now-unused BILLINGS constant is gone.
    expect(src).not.toMatch(/var BILLINGS\b/);
  });

  it('approval flow is untouched (Task 9 pins still present)', () => {
    expect(src).toMatch(/function openApprovalModal/);
    expect(src).toMatch(/\/api\/ats\/job\/header-image/);
    expect(src).toMatch(/onApprovalFileChange/);
    expect(src).toMatch(/submitApprovalAction/);
  });

  it('ceo-dashboard.html loads the bumped script', () => {
    expect(ceo).toContain('/js/ceo-ats-jobs.js?v=20260724a');
  });
});
