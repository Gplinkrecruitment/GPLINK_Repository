// Owner decision 2026-07-30 — the doctor-facing half of "the practice opening
// the decision page moves the card into Practice Reviewing".
//
// The server half is covered end-to-end in tests/practice-decision.test.js
// (forward-only, idempotent, terminal-safe, silent). This file covers what the
// DOCTOR sees, because until now nothing ever reached the 'reviewing' stage, so
// every screen that renders it was written and never once exercised.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
const detailHtml = fs.readFileSync(path.join(ROOT, 'pages/application-detail.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

describe('the practice-opened stage move', () => {
  it('is wired to the first-open signal and is forward-only', () => {
    const idx = serverSrc.indexOf("pathname === '/api/practice/application/decision-context'");
    expect(idx).toBeGreaterThan(-1);
    const routeSrc = serverSrc.slice(idx, idx + 3200);
    expect(routeSrc).toContain('practice_opened_at');
    expect(routeSrc).toContain("planAtsStageReconciliation(appRow.ats_stage || '', 'reviewing')");
    expect(routeSrc).toContain("atsUpdateApplicationStageRow(appRow.id, practiceOpenStage, undefined, 'practice_opened')");
  });

  it('is awaited, so it cannot land after an accept made from the same page', () => {
    const idx = serverSrc.indexOf('const practiceOpenStage =');
    const block = serverSrc.slice(idx, idx + 400);
    expect(block).toContain('await atsUpdateApplicationStageRow');
  });

  it('does not notify the doctor — a practice opening a page is not a decision', async () => {
    const { ATS_GP_NOTIFY_STAGES } = (await import('../server.js')).__testUtils;
    expect(ATS_GP_NOTIFY_STAGES).toEqual(['interview', 'offer', 'hired', 'not_proceeding']);
    expect(ATS_GP_NOTIFY_STAGES).not.toContain('reviewing');
  });
});

describe('what the doctor sees once a card reaches Practice Reviewing', () => {
  it('the server tells them the practice has it', () => {
    const idx = serverSrc.indexOf("if (stage === 'reviewing') {");
    expect(idx).toBeGreaterThan(-1);
    expect(serverSrc.slice(idx, idx + 220)).toContain('The practice is reviewing your profile');
  });

  it('the careers card ribbon reads FORWARD of SUBMITTED, not back to UNDER REVIEW', () => {
    // Without its own branch, 'reviewing' fell through to the generic
    // "UNDER REVIEW" ribbon — so the doctor watched SUBMITTED become UNDER
    // REVIEW and read it as going backwards.
    // Scoped to careerApplicationState — the one state map every card reads
    // (2026-07-31). "UNDER REVIEW" appears elsewhere on the page, so a
    // whole-file indexOf compares the wrong two positions.
    const chainStart = careerHtml.indexOf('function careerApplicationState(application) {');
    expect(chainStart).toBeGreaterThan(-1);
    const chain = careerHtml.slice(chainStart, careerHtml.indexOf('function careerMineStatusLabel', chainStart));
    expect(chain).toContain('if (key === "reviewing")');
    expect(chain).toContain('ribbon: "WITH PRACTICE"');
    // Must be reached before the catch-all fallback, or it never fires. The
    // fallback is the map's LAST statement — a bare `return S({ blurb: ... })`
    // with no key test, which inherits ribbon "UNDER REVIEW" from the defaults.
    const fallbackIdx = chain.indexOf('return S({ blurb: "Your Registration Support Officer is reviewing your application');
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(chain.indexOf('if (key === "reviewing")')).toBeLessThan(fallbackIdx);
  });

  it('the card no longer claims GP Link is screening a profile the practice already has', () => {
    const idx = careerHtml.indexOf('function nextStepForApplication');
    const fnSrc = careerHtml.slice(idx, idx + 1400);
    expect(fnSrc).toContain('if (key === "submitted") return "Practice review";');
    expect(fnSrc).toContain('if (key === "reviewing") return "The practice\'s decision";');
    // The catch-all is still there for the stages it IS true for.
    expect(fnSrc).toContain('return "GP Link screening";');
  });

  it('the local fallback label agrees with the server instead of rendering a bare "Reviewing"', () => {
    const idx = careerHtml.indexOf('function getApplicationStatusMeta');
    const fnSrc = careerHtml.slice(idx, idx + 2200);
    expect(fnSrc).toContain('if (key === "reviewing")');
    expect(fnSrc).toContain('The practice is reviewing your profile');
  });

  it('the tracker timeline already places it at Under Review', () => {
    // Pre-existing and correct — pinned so the newly-reachable stage cannot
    // silently drift to a different step.
    expect(detailHtml).toContain('under_review: 1, submitted: 1, reviewing: 1,');
  });

  it('the meta line says the practice has it, not that we are still checking', () => {
    // The copy now sits on the 'reviewing' branch of careerApplicationState, so
    // the strip under the map and the Offers list cannot disagree about it.
    // Scoped: getApplicationStatusMeta earlier in the file tests the same key,
    // and an unscoped indexOf finds that one instead.
    const mapStart = careerHtml.indexOf('function careerApplicationState(application) {');
    expect(mapStart).toBeGreaterThan(-1);
    const idx = careerHtml.indexOf('if (key === "reviewing")', mapStart);
    expect(idx).toBeGreaterThan(-1);
    expect(careerHtml.slice(idx, idx + 320)).toContain('The practice is reviewing your profile now');
  });
});
