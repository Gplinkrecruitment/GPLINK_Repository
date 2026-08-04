// The practice page must describe WHERE the application actually is.
//
// Owner report 2026-08-05: Khaleed Crypto had sat his interview, and this page
// still said "Application received … there's nothing you need to do right now"
// over a "✓ Submitted — your Registration Support Officer is reviewing it" bar.
// The page only knew a yes/no "have you applied", and its fallback source was
// this browser's localStorage, which records the apply once and never expires.
//
// job.html is one big IIFE and this repo has no jsdom, so the page's own code is
// extracted and executed here rather than re-implemented — a copy of the logic
// would pass while the page stayed broken.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const jobHtml = fs.readFileSync(path.join(ROOT, 'pages/job.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// job.html indents its top-level declarations by exactly two spaces and closes
// them with "\n  }" / "\n  };" — the same convention the other job.html tests
// read it with.
function extractFn(name) {
  const start = jobHtml.indexOf('\n  function ' + name + '(');
  if (start === -1) throw new Error('missing function ' + name);
  const end = jobHtml.indexOf('\n  }', start);
  return jobHtml.slice(start + 1, end + 4);
}
function extractConst(name) {
  const start = jobHtml.indexOf('\n  const ' + name + ' = ');
  if (start === -1) throw new Error('missing const ' + name);
  const end = jobHtml.indexOf('\n  };', start);
  // Single-line consts (arrays) close with "];" instead.
  const endArr = jobHtml.indexOf('];', start);
  if (end === -1 || (endArr !== -1 && endArr < end)) {
    return jobHtml.slice(start + 1, jobHtml.indexOf('\n', endArr));
  }
  return jobHtml.slice(start + 1, end + 4);
}

const page = new Function(
  'escapeHtml',
  [
    extractConst('JOB_STAGE_NOTES'),
    extractConst('JOB_SECURED_STAGES'),
    extractConst('JOB_BAR_STAGES'),
    extractFn('jobStageKey'),
    extractFn('jobStageNote'),
    extractFn('buildReceivedHtml'),
    extractFn('buildApplicationProgressHtml'),
    'return { buildApplicationProgressHtml, jobStageNote, jobStageKey, JOB_BAR_STAGES, JOB_STAGE_NOTES };'
  ].join('\n')
)((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));

const panelFor = (status, statusLabel) =>
  page.buildApplicationProgressHtml({ applicationStatus: { status, statusLabel } });

describe('the practice page tells the doctor where their application really is', () => {
  // The exact reported bug.
  it('a doctor who has SAT the interview is not told their application was just received', () => {
    const html = panelFor('interview_completed', 'Interview done — awaiting the practice’s decision');
    expect(html).toContain('Interview done');
    expect(html).toContain('You&#39;ve met the practice');
    // The two things Khaleed was wrongly shown.
    expect(html).not.toContain('Application received');
    expect(html).not.toContain('There&#39;s nothing you need to do right now.<');
    expect(html).toContain('data-app-stage="interview_completed"');
  });

  it('the heading is the SERVER\'s label verbatim, so this page cannot drift from My Practice', () => {
    // Deliberately not a label the page knows about — it must still be shown.
    const html = panelFor('interview', 'Interview stage');
    expect(html).toContain('<b>Interview stage</b>');
    const invented = panelFor('interview', 'Some future wording');
    expect(invented).toContain('<b>Some future wording</b>');
  });

  it('every live stage gets its own words — no two stages read the same', () => {
    const stages = ['applied', 'submitted', 'reviewing', 'interview', 'interview_completed', 'offer', 'finalising_placement'];
    const notes = stages.map((s) => page.jobStageNote(s));
    expect(new Set(notes).size).toBe(stages.length);
    // And each says something concrete about that stage.
    expect(page.jobStageNote('interview')).toMatch(/joining link|My Practice/);
    expect(page.jobStageNote('offer')).toMatch(/offer/i);
    expect(page.jobStageNote('not_proceeding')).toMatch(/not a reflection/);
  });

  it('a placement counts as secured under any of the keys the server may store', () => {
    for (const key of ['hired', 'secured', 'placed', 'placement_secured', 'contract_signed']) {
      expect(page.jobStageKey(key)).toBe('placement_secured');
      expect(page.jobStageNote(key)).toContain('This is your practice');
      expect(page.JOB_BAR_STAGES[page.jobStageKey(key)]).toContain('This is your practice');
    }
  });

  it('an unknown or missing stage degrades to the applied copy, never a blank panel', () => {
    expect(page.jobStageNote('some_stage_invented_next_year')).toBe(page.JOB_STAGE_NOTES.applied);
    // No server answer at all (a Zoho-era row) behaves exactly as before.
    const noView = page.buildApplicationProgressHtml({});
    expect(noView).toContain('Application received');
    expect(noView).toContain('id="appliedBanner"');
  });

  it('the sticky bar reports the real stage instead of "Submitted" forever', () => {
    expect(page.JOB_BAR_STAGES.interview_completed).toContain('Interview done');
    expect(page.JOB_BAR_STAGES.interview).toContain('Interview stage');
    expect(page.JOB_BAR_STAGES.applied).toContain('Submitted');
    // Withdrawn / not-proceeding are deliberately absent — the bar has its own
    // handling for those and must not be hijacked into a dead label.
    expect(page.JOB_BAR_STAGES.withdrawn).toBeUndefined();
    expect(page.JOB_BAR_STAGES.not_proceeding).toBeUndefined();
  });

  it('the label is escaped — it is server text rendered into innerHTML', () => {
    const html = panelFor('interview', '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the server hands the practice page a real stage', () => {
  it('reuses the shared status mapper rather than re-deriving the labels', () => {
    const idx = serverSrc.indexOf('roleClientPayload.applicationStatus = {');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx - 900, idx + 400);
    expect(block).toContain('buildInternalCareerStatusPresentation(roleRevealCtx.application, roleRevealCtx.offer || null)');
    // Zoho-era rows keep their own labels, same gate the detail endpoint uses.
    expect(block).toContain('isInternalCareerApplication(roleRevealCtx.application, finalRoleRow)');
    expect(block).toContain('statusLabel: roleStatusView.statusLabel');
  });

  it('costs no extra database round trip — both rows are already in hand', () => {
    const idx = serverSrc.indexOf('roleClientPayload.applicationStatus = {');
    const block = serverSrc.slice(idx - 900, idx + 400);
    // The reveal context supplies application AND offer; asking Supabase again
    // here would put a query on every job-page open.
    expect(block).not.toMatch(/supabaseDbRequest|getAtsOfferByApplication/);
  });

  it('still narrows role.applied to the pre-practice stages — the two are different questions', () => {
    // applied === "with us, not yet in front of the practice"; applicationStatus
    // === "where it is". Collapsing them is what produced the original bug.
    const idx = serverSrc.indexOf('function careerRowIsOwnApplicationAwaitingPractice');
    const fnSrc = serverSrc.slice(idx, idx + 700);
    expect(fnSrc).toContain("return owStage === 'applied' || owStage === 'submitted';");
  });
});
