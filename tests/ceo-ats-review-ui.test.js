import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Task 4 (2026-07-18 AI job write-up + combined review design) — the
// pending-job click routes into ONE combined review screen (details, AI
// write-up, preview, approve) instead of the empty candidate pipeline board.
// Source-level regex asserts, same style as tests/ceo-jobs-ui.test.js.
const root = process.cwd();
const jobsSrc = fs.readFileSync(path.join(root, 'js/ceo-ats-jobs.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const jobHtmlSrc = fs.readFileSync(path.join(root, 'pages/job.html'), 'utf8');
const siteJobHtmlSrc = fs.readFileSync(path.join(root, 'pages/site-job.html'), 'utf8');
const ceoHtmlSrc = fs.readFileSync(path.join(root, 'pages/ceo-dashboard.html'), 'utf8');

// Scoped regions so assertions can't accidentally match unrelated code.
const clickHandlerStart = jobsSrc.indexOf("listEl.addEventListener('click'");
const clickHandlerEnd = jobsSrc.indexOf('function currentJobFilters');
const clickHandler = jobsSrc.slice(clickHandlerStart, clickHandlerEnd);

const reviewExtrasStart = jobsSrc.indexOf('REVIEW SCREEN EXTRAS');
const reviewExtrasEnd = jobsSrc.indexOf('function submitJobSettings');
const reviewExtras = jobsSrc.slice(reviewExtrasStart, reviewExtrasEnd);

const editorPayloadStart = serverSrc.indexOf('function atsJobEditorPayload');
const editorPayloadEnd = serverSrc.indexOf('\n}', editorPayloadStart) + 2;
const editorPayload = serverSrc.slice(editorPayloadStart, editorPayloadEnd);

describe('CEO Jobs review screen (Task 4 — combined review)', () => {
  it('a pending job card routes to the review, not the empty candidate board', () => {
    expect(clickHandler).toMatch(/data-approval-status'\)\s*===\s*'pending'/);
    expect(clickHandler).toMatch(/openJobReview\(jobId\)/);
    // The plain card-click branch must still fall through to the pipeline
    // board for anything that ISN'T pending.
    expect(clickHandler).toMatch(/atsOpenJobBoard\(jobId\)/);
  });

  it('"Review & approve" also opens the review, never the standalone photo modal directly', () => {
    expect(clickHandler).toMatch(/data-ats-approve-job/);
    expect(clickHandler).toMatch(/openJobReview\(approveBtn\.getAttribute\('data-ats-approve-job'\)\)/);
    // Must NOT call openApprovalModal directly from the list click handler —
    // it should only ever be reached from inside the review screen now.
    expect(clickHandler).not.toMatch(/openApprovalModal\(approveBtn/);
  });

  it('every job card carries its approval_status so the click handler can route on it', () => {
    expect(jobsSrc).toMatch(/data-approval-status="'\s*\+\s*A\.escAttr\(j\.approval_status \|\| ''\)/);
  });

  it('openJobReview sets currentBoardJobId then reuses openJobSettings as the review hub', () => {
    expect(jobsSrc).toMatch(/function openJobReview\(jobId\)\s*\{[\s\S]*?currentBoardJobId = jobId;[\s\S]*?openJobSettings\(\);/);
  });

  it('the pending-only sections are appended to the settings/editor modal, not a new modal', () => {
    expect(jobsSrc).toMatch(/\(pending \? reviewExtrasHtml\(e\) : ''\)/);
    expect(jobsSrc).toMatch(/id="atsJobSettingsModal"/); // same modal id — reused, not duplicated
  });

  it('AI write-up block: editable textarea seeded from editor.ai_about', () => {
    expect(reviewExtras).toMatch(/id="atsJsAiAbout"/);
    expect(reviewExtras).toMatch(/A\.esc\(e\.ai_about \|\| ''\)/);
    expect(reviewExtras).toMatch(/e\.ai_highlights/);
    expect(reviewExtras).toMatch(/AI-drafted/);
  });

  it('Regenerate control POSTs the write-up endpoint and re-renders the block in place', () => {
    expect(reviewExtras).toMatch(/data-ats-regenerate-writeup/);
    expect(jobsSrc).toMatch(/function regenerateWriteup\(jobId\)/);
    expect(jobsSrc).toMatch(/\/api\/ats\/job\/ai-writeup\?id=' \+ encodeURIComponent\(jobId\)/);
    expect(jobsSrc).toMatch(/method: 'POST'/);
    // Re-renders the about textarea + highlights list from the response,
    // never a full-modal reload that would drop unsaved edits.
    expect(jobsSrc).toMatch(/aboutEl\.value = w\.about \|\| ''/);
    expect(jobsSrc).toMatch(/hlEl\.innerHTML = aiHighlightsListHtml\(w\.highlights\)/);
  });

  it('the no-API-key path is graceful, never a hard failure', () => {
    expect(jobsSrc).toMatch(/reason === 'ai_unavailable'/);
    expect(jobsSrc).toMatch(/AI isn't configured in this environment/);
  });

  it('a "show what the practice wrote" toggle reveals the raw intro_text', () => {
    expect(reviewExtras).toMatch(/data-ats-show-original/);
    expect(reviewExtras).toMatch(/e\.intro_text \|\| e\.role_summary/);
    expect(jobsSrc).toMatch(/atsJsShowOriginal[\s\S]{0,300}atsJsAiOriginal/);
  });

  it('a source line credits the write-up inputs', () => {
    expect(reviewExtras).toMatch(/Written by AI from:.*practice form.*website.*area/);
  });

  it('two preview buttons open the app + website listing in a new tab with preview=1', () => {
    expect(reviewExtras).toMatch(/data-ats-preview-app/);
    expect(reviewExtras).toMatch(/data-ats-preview-site/);
    expect(reviewExtras).toMatch(/\/pages\/job\.html\?id=' \+ enc \+ '&preview=1'/);
    expect(reviewExtras).toMatch(/\/jobs\/view\?id=' \+ enc \+ '&preview=1'/);
    expect(reviewExtras).toMatch(/target="_blank" rel="noopener"/);
  });

  it('preview links are built from the job\'s public_id (captured off d.job, not the editor payload)', () => {
    expect(jobsSrc).toMatch(/settingsPublicId = \(d\.job && d\.job\.public_id\) \|\| ''/);
  });

  it('the suburb photo + approve/reject path hands off to the existing approval modal (reused, not duplicated)', () => {
    expect(reviewExtras).toMatch(/data-ats-open-approval/);
    expect(jobsSrc).toMatch(/on\('atsJsOpenApproval', 'click', function \(\) \{ openApprovalModal\(jobId\); \}\)/);
    // No second upload/reuse-picker implementation anywhere near the review
    // extras — the ONLY approval-photo logic in the file stays inside
    // openApprovalModal/bindApprovalModal (asserted by absence of a second
    // "atsApFileInput"-style id inside the review-extras region).
    expect(reviewExtras).not.toMatch(/atsApFileInput/);
  });

  it('saving a pending review refreshes the jobs list, not the empty candidate board', () => {
    const submitStart = jobsSrc.indexOf('function submitJobSettings');
    const submitEnd = jobsSrc.indexOf('/* ====', submitStart + 10) === -1
      ? jobsSrc.length
      : jobsSrc.indexOf('/* ====', submitStart + 10);
    const submit = jobsSrc.slice(submitStart, submitEnd);
    expect(submit).toMatch(/wasPendingReview = o\.approval_status === 'pending'/);
    expect(submit).toMatch(/if \(wasPendingReview\) \{ fetchAndRenderJobList\(\); \} else \{ atsOpenJobBoard\(currentBoardJobId\); \}/);
  });

  it('bumps the ceo-ats-jobs.js cache-buster', () => {
    expect(ceoHtmlSrc).toMatch(/ceo-ats-jobs\.js\?v=20260805b/);
  });
});

describe('atsJobEditorPayload (server.js) surfaces the AI write-up', () => {
  it('returns ai_about / ai_highlights read from source_payload.gpLink.aiWriteup', () => {
    expect(editorPayload).toMatch(/aiWriteupForEditor\.about \|\| ''/);
    expect(editorPayload).toMatch(/ai_about:\s*aiWriteupForEditor\.about \|\| ''/);
    expect(editorPayload).toMatch(/ai_highlights:\s*Array\.isArray\(aiWriteupForEditor\.highlights\)\s*\?\s*aiWriteupForEditor\.highlights\s*:\s*\[\]/);
    // Sourced from source_payload.gpLink.aiWriteup, not some other stash.
    expect(editorPayload).toMatch(/sp\.gpLink/);
    expect(editorPayload).toMatch(/gpLinkForEditor\.aiWriteup/);
  });

  it('does not add practice-identifying fields beyond what already existed', () => {
    // The only NEW keys this task adds are ai_about / ai_highlights.
    const newKeysBlock = editorPayload.slice(editorPayload.indexOf('practice_name: j.practice_name'));
    const addedKeys = [...newKeysBlock.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(addedKeys).toEqual(['practice_name', 'ai_about', 'ai_highlights']);
  });
});

describe('Admin preview forwarding (Task 5 follow-up)', () => {
  it('pages/job.html forwards ?preview=1 onto the /api/career/role fetch', () => {
    expect(jobHtmlSrc).toMatch(/function isPreviewModeFromUrl\(\)/);
    expect(jobHtmlSrc).toMatch(/params\.get\("preview"\) === "1"/);
    expect(jobHtmlSrc).toMatch(/\/api\/career\/role\?id=" \+ encodeURIComponent\(roleId\) \+ \(isPreview \? "&preview=1" : ""\)/);
    // Preview must bypass the 10-minute cache both ways (never read a stale
    // miss, never poison the cache with a preview-only payload).
    expect(jobHtmlSrc).toMatch(/const bypassCache = isPreview \|\| !!\(options && options\.bypassCache\)/);
    expect(jobHtmlSrc).toMatch(/if \(!isPreview\) writeCachedRoleDetail\(roleId, data\.role\)/);
  });

  it('pages/site-job.html forwards ?preview=1 onto the /api/public/jobs fetch (it client-fetches its content)', () => {
    expect(siteJobHtmlSrc).toMatch(/function isPreviewModeFromUrl\(\)/);
    expect(siteJobHtmlSrc).toMatch(/if \(isPreviewModeFromUrl\(\)\) params\.set\("preview", "1"\)/);
  });
});
