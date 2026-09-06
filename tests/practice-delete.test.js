import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * "i should be able to delete a practice. and when i delete it it send the
 * practice a nice template email thanking them…" — owner, 2026-08-10.
 * Then, same day: "if i delete a practice then all of the jobs attached should
 * also get deleted. When a practice is deleted it gets archived for 12 months
 * which can be restored along with the job openings still linked. only after 12
 * months are they completely deleted."
 *
 * So "Delete" is a SOFT delete:
 *   delete  -> practice + its job openings vanish from the app together, a
 *              restore snapshot is written to practices.metadata.deleted, and
 *              the thank-you letter goes out.
 *   restore -> both come back, jobs returned to their exact prior state.
 *   purge   -> 12 months later, /api/cron/purge-practices destroys them.
 *
 * The FK map (information_schema, verified 2026-07-28) is what shapes the purge:
 *   career_roles.practice_id     SET NULL  -> a surviving job stays on the
 *     public board AND rebuilds the practice as a name-only card, because
 *     atsListPracticesDerived groups jobs by practice_name. Jobs must go too.
 *   gp_applications.practice_id  NO ACTION -> blocks a real delete.
 *   career_contracts/career_interviews .application_id  CASCADE -> so the block
 *     is cleared by UNLINKING the application, never deleting it.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const practicesJs = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const atsCss = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

const pipeline = require(path.join(ROOT, 'lib/practice-pipeline.js'));
const atsPractices = require(path.join(ROOT, 'lib/ats-practices.js'));

// ---------------------------------------------------------------------------
// The 12-month archive record (pure functions — tested for real).
// ---------------------------------------------------------------------------
describe('practice soft-delete helpers', () => {
  const NOW = '2026-08-10T01:00:00.000Z';
  const JOBS = [
    { id: 'j-live', is_active: true, job_status: 'open', approval_status: 'approved' },
    { id: 'j-pending', is_active: false, job_status: 'open', approval_status: 'pending' }
  ];
  const rec = atsPractices.buildPracticeDeletionRecord({
    practice: { stage: 'active' }, jobs: JOBS, actorEmail: 'ceo@x', nowIso: NOW
  });
  const archived = { metadata: { deleted: rec } };

  it('retains for 12 months', () => {
    expect(atsPractices.PRACTICE_DELETE_RETENTION_MONTHS).toBe(12);
    expect(rec.retention_months).toBe(12);
    expect(rec.purge_after).toBe('2027-08-10T01:00:00.000Z');
  });

  it('adds months without rolling into the next month', () => {
    // 31 Aug + 6mo must clamp to the end of Feb, not spill into March.
    expect(atsPractices.addMonthsIso('2026-08-31T01:00:00.000Z', 6)).toBe('2027-02-28T01:00:00.000Z');
    expect(atsPractices.addMonthsIso('2026-08-10T01:00:00.000Z', 12)).toBe('2027-08-10T01:00:00.000Z');
    expect(atsPractices.addMonthsIso('not-a-date', 12)).toBeNull();
  });

  it('snapshots every job so a restore is exact, not a guess', () => {
    expect(rec.restore.jobs).toEqual([
      { id: 'j-live', is_active: true, job_status: 'open', approval_status: 'approved' },
      { id: 'j-pending', is_active: false, job_status: 'open', approval_status: 'pending' }
    ]);
    // …and the practice's own lifecycle stage, so restoring cannot silently
    // promote a declined practice back to active.
    expect(rec.restore.stage).toBe('active');
  });

  it('round-trips through read/isDeleted', () => {
    expect(atsPractices.isPracticeDeleted(archived)).toBe(true);
    expect(atsPractices.isPracticeDeleted({ metadata: {} })).toBe(false);
    expect(atsPractices.isPracticeDeleted({})).toBe(false);
    expect(atsPractices.isPracticeDeleted({ metadata: { deleted: {} } })).toBe(false);
    const read = atsPractices.readPracticeDeletion(archived);
    expect(read.at).toBe(NOW);
    expect(read.purgeAfter).toBe('2027-08-10T01:00:00.000Z');
    expect(read.by).toBe('ceo@x');
    expect(read.jobs).toHaveLength(2);
  });

  it('is only purge-due once the full window has elapsed', () => {
    expect(atsPractices.practicePurgeDue(archived, '2026-08-11T00:00:00.000Z')).toBe(false);
    expect(atsPractices.practicePurgeDue(archived, '2027-08-09T00:00:00.000Z')).toBe(false);
    expect(atsPractices.practicePurgeDue(archived, '2027-08-10T01:00:00.000Z')).toBe(true);
    expect(atsPractices.practicePurgeDue(archived, '2027-09-01T00:00:00.000Z')).toBe(true);
  });

  it('never purges on a malformed record — data loss is worse than a stuck row', () => {
    expect(atsPractices.practicePurgeDue({ metadata: { deleted: { at: 'x', purge_after: 'nonsense' } } }, '2030-01-01T00:00:00Z')).toBe(false);
    expect(atsPractices.practicePurgeDue({}, '2030-01-01T00:00:00Z')).toBe(false);
  });

  it('counts the days left to restore, never going negative', () => {
    expect(atsPractices.practiceRestoreDaysLeft(archived, '2027-08-08T01:00:00.000Z')).toBe(2);
    expect(atsPractices.practiceRestoreDaysLeft(archived, '2028-01-01T00:00:00.000Z')).toBe(0);
    expect(atsPractices.practiceRestoreDaysLeft({}, NOW)).toBeNull();
  });

  it('retire/restore job patches are exact inverses', () => {
    // A live approved job.
    expect(atsPractices.retiredJobPatch(JOBS[0])).toEqual({ is_active: false, job_status: 'closed' });
    expect(atsPractices.restoredJobPatch(rec.restore.jobs[0])).toEqual({ is_active: true, job_status: 'open', approval_status: 'approved' });
    // A pending job also has to leave the pending queue, which the directory merges in.
    expect(atsPractices.retiredJobPatch(JOBS[1])).toEqual({ is_active: false, job_status: 'closed', approval_status: 'rejected' });
    expect(atsPractices.restoredJobPatch(rec.restore.jobs[1])).toEqual({ is_active: false, job_status: 'open', approval_status: 'pending' });
  });
});

// ---------------------------------------------------------------------------
// The letter.
// ---------------------------------------------------------------------------
describe('buildFarewellEmailCopy', () => {
  const copy = pipeline.buildFarewellEmailCopy({
    practiceName: 'Erina Medical Centre',
    contactName: 'Khaleed Mahmoud Ibanez'
  });

  it('thanks them by name and names the practice in the subject', () => {
    expect(copy.subject).toBe('Thank you from GP Link, Erina Medical Centre');
    expect(copy.bodyHtml).toContain('Dear Khaleed,');
    expect(copy.bodyHtml).toContain('Thank you for the opportunity to work with Erina Medical Centre');
  });

  it('leaves the door open for a future GP — the whole point of the letter', () => {
    expect(copy.bodyHtml).toContain('If you find yourself needing a GP again');
    expect(copy.bodyHtml).toMatch(/we would be delighted to work together/);
    expect(copy.text).toContain('If you find yourself needing a GP again');
  });

  it('carries no call-to-action button — there is nothing left for them to do', () => {
    expect(copy.ctaUrl).toBeUndefined();
    expect(copy.ctaText).toBeUndefined();
  });

  it('signs off in the same house style as the intake letter', () => {
    const intake = pipeline.buildIntakeEmailCopy({ practiceName: 'X', contactName: 'Y', intakeUrl: 'https://e.g' });
    expect(copy.signatureHtml).toContain('CEO');
    expect(copy.signatureHtml).toContain('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
    expect(intake.signatureHtml).toContain('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
  });

  it('ships a plain-text twin so text-only clients get a readable letter', () => {
    expect(copy.text).toContain('Dear Khaleed,');
    expect(copy.text).toContain('Warm regards');
    expect(copy.text.split('\n\n').length).toBeGreaterThan(4);
    expect(copy.text).not.toContain('<');
  });

  it('falls back to a usable greeting when no contact name is on file', () => {
    const anon = pipeline.buildFarewellEmailCopy({ practiceName: 'Bayside Family Practice' });
    expect(anon.bodyHtml).toContain('Dear Practice Manager,');
    expect(anon.text).toContain('Dear Practice Manager,');
  });

  it('still reads correctly when even the practice name is missing', () => {
    const bare = pipeline.buildFarewellEmailCopy({});
    expect(bare.subject).toBe('Thank you from GP Link');
    expect(bare.bodyHtml).toContain('work with your practice');
    expect(bare.bodyHtml).not.toContain('undefined');
    expect(bare.text).not.toContain('undefined');
  });

  it('adds the personal line as its own paragraph, and omits the block when blank', () => {
    const withNote = pipeline.buildFarewellEmailCopy({
      practiceName: 'Erina Medical Centre', contactName: 'Khaleed', personalNote: 'A pleasure working with Dr Chen.'
    });
    expect(withNote.bodyHtml).toContain('<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155">A pleasure working with Dr Chen.</p>');
    expect(withNote.text).toContain('\nA pleasure working with Dr Chen.\n');
    expect(copy.bodyHtml).not.toContain('color:#334155"></p>');
  });

  it('escapes anything typed into the personal note or the names', () => {
    const nasty = pipeline.buildFarewellEmailCopy({
      practiceName: '<script>alert(1)</script>',
      contactName: '<b>Bob</b>',
      personalNote: '<img src=x onerror=alert(1)>'
    });
    expect(nasty.bodyHtml).not.toContain('<script>');
    expect(nasty.bodyHtml).not.toContain('<img src=x');
    expect(nasty.bodyHtml).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// Delete = archive.
// ---------------------------------------------------------------------------
describe('POST /api/ats/practice/delete (archive)', () => {
  const at = serverJs.indexOf("if (pathname === '/api/ats/practice/delete' && req.method === 'POST')");
  const block = serverJs.slice(at, serverJs.indexOf("if (pathname === '/api/ats/practices/deleted'", at));

  it('exists, alongside the preview', () => {
    expect(at).toBeGreaterThan(-1);
    expect(serverJs).toContain("if (pathname === '/api/ats/practice/delete-preview' && req.method === 'GET')");
  });

  it('is CEO-only across delete, preview, list and restore', () => {
    for (const route of ["'/api/ats/practice/delete'", "'/api/ats/practice/delete-preview'",
      "'/api/ats/practices/deleted'", "'/api/ats/practice/restore'"]) {
      const idx = serverJs.indexOf(route);
      expect(idx, `route not found: ${route}`).toBeGreaterThan(-1);
      expect(serverJs.slice(idx, idx + 400)).toContain('requireCeoSession(req, res)');
    }
  });

  it('refuses unless the practice name is typed back exactly', () => {
    expect(block).toContain("code: 'confirm_name_mismatch'");
    expect(block.indexOf('confirm_name_mismatch')).toBeLessThan(block.indexOf('buildPracticeDeletionRecord'));
  });

  it('ARCHIVES rather than destroying — nothing is deleted on this path', () => {
    expect(block).toContain('atsPracticeUtil.buildPracticeDeletionRecord({');
    expect(block).toContain("stage: 'archived'");
    expect(block).toContain('is_active: false');
    // The destructive helpers must not be reachable from here.
    expect(block).not.toContain('atsDeletePracticeRow');
    expect(block).not.toContain('atsDeleteJobRow');
  });

  it('leaves candidate applications completely alone', () => {
    // Nothing is being destroyed, so the NO ACTION foreign key never bites and
    // the doctor keeps their link to the practice for the whole archive window.
    expect(block).not.toContain('practice_id: null');
  });

  it('merges into metadata instead of overwriting it', () => {
    // metadata also holds intake + agreement state; a blind write would wipe them.
    expect(block).toContain('var pdMergedMeta = Object.assign({},');
    expect(block).toContain('{ deleted: pdDeletionRecord }');
  });

  it('archives the practice BEFORE retiring the jobs', () => {
    // If the archive write fails the jobs are untouched, so the practice is
    // left exactly as it was rather than jobless-but-alive.
    expect(block.indexOf('var pdArchived = await atsUpdatePracticeRow')).toBeLessThan(block.indexOf('var pdJobsRetired = 0;'));
    expect(block).toContain('atsPracticeUtil.retiredJobPatch(pdJob)');
  });

  it('gives a name-only practice a real row so it can be restored', () => {
    // A derived practice has no row; retiring its jobs alone would make it
    // vanish with nothing left to restore from.
    expect(block).toContain('if (!pdRowId) {');
    expect(block).toContain('var pdCreated = await atsInsertPracticeRow({');
  });

  it('never lets a failed email fail the archive', () => {
    expect(block).toContain('pdEmailResult.sent = !!(pdSent && pdSent.ok);');
    expect(block.indexOf('sendPracticeFarewellEmail')).toBeGreaterThan(block.indexOf('var pdJobsRetired = 0;'));
  });

  it('tells the caller when the practice can be restored until', () => {
    expect(block).toContain('purge_after: pdDeletionRecord.purge_after');
    expect(block).toContain('retention_months: pdDeletionRecord.retention_months');
  });
});

describe('archived practices disappear from the app', () => {
  it('are dropped from the directory builder every surface is built on', () => {
    const at = serverJs.indexOf('async function atsListPracticesDerived()');
    const fn = serverJs.slice(at, serverJs.indexOf('\n}\n', at));
    expect(fn).toContain('if (atsPracticeUtil.isPracticeDeleted(p)) { delete byKey[k]; return; }');
  });

  it('do not resolve on their own detail page either', () => {
    const at = serverJs.indexOf('async function atsResolvePractice(id)');
    const fn = serverJs.slice(at, at + 1600);
    expect(fn).toContain('if (atsPracticeUtil.isPracticeDeleted(row)) return null;');
  });
});

describe('POST /api/ats/practice/restore', () => {
  const at = serverJs.indexOf("if (pathname === '/api/ats/practice/restore' && req.method === 'POST')");
  const block = serverJs.slice(at, serverJs.indexOf('// Manual signed-agreement upload (Phase 3)', at));

  it('exists', () => expect(at).toBeGreaterThan(-1));

  it('reads the row directly — the resolver deliberately hides archived practices', () => {
    expect(block).toContain('var prRow = await atsGetPracticeRow(prId);');
    // The resolver would return null for an archived practice, so restore must
    // never route through it. (Matched as a CALL — the block explains itself in
    // a comment that mentions the name.)
    expect(block).not.toMatch(/await\s+atsResolvePractice\(/);
  });

  it('refuses a practice that is not actually in the deleted list', () => {
    expect(block).toContain("code: 'not_deleted'");
  });

  it('puts each job back in its exact prior state', () => {
    expect(block).toContain('atsPracticeUtil.restoredJobPatch(prSaved)');
  });

  it('restores the jobs before clearing the record, so a retry can finish the job', () => {
    expect(block.indexOf('restoredJobPatch')).toBeLessThan(block.indexOf('delete prMeta.deleted;'));
  });

  it('restores the stage it had, not a blanket "active"', () => {
    expect(block).toContain('stage: prRec.restoreStage');
  });
});

describe('GET /api/cron/purge-practices', () => {
  const at = serverJs.indexOf("pathname === '/api/cron/purge-practices'");
  const block = serverJs.slice(at, serverJs.indexOf('Cron: purge stored onboarding identity documents', at));

  it('is registered as a daily cron in both places', () => {
    expect(vercelJson.crons.some((c) => c.path === '/api/cron/purge-practices')).toBe(true);
    expect(serverJs).toContain("'purge-practices': { schedule:");
  });

  it('is cron-secret gated like every other cron', () => {
    expect(block).toContain('isValidCronSecret(ppToken)');
  });

  it('has a dry-run off-switch, mirroring purge-accounts', () => {
    expect(block).toContain("process.env.PRACTICE_PURGE_DISABLED");
    expect(block).toContain('dryRun: !ppEnabled');
  });

  it('only touches practices whose 12 months are genuinely up', () => {
    expect(block).toContain('atsPracticeUtil.practicePurgeDue(p, ppNowIso)');
  });

  it('deletes the job openings for real — this is the "completely deleted" step', () => {
    expect(block).toContain('await atsDeleteJobRow(saved.id)');
  });

  it('UNLINKS applications rather than deleting them, even at purge time', () => {
    // career_contracts + career_interviews CASCADE off gp_applications.
    expect(block).toContain('body: { practice_id: null }');
    expect(block).not.toMatch(/gp_applications[^\n]*method: 'DELETE'/);
  });

  it('keeps a practice archived if anything under it refused to go', () => {
    // Better a retry next run than a practices row deleted out from under
    // jobs that are still there (they would orphan onto the public board).
    expect(block).toContain('if (ppRowBlocked) {');
    expect(block).toContain('will retry next run');
    expect(block.indexOf('if (ppRowBlocked) {')).toBeLessThan(block.indexOf('await atsDeletePracticeRow(prow.id)'));
  });

  it('logs what it did', () => {
    expect(block).toContain("console.log('[purge-practices]");
  });
});

describe('atsDeleteJobRow', () => {
  const at = serverJs.indexOf('async function atsDeleteJobRow(id)');
  const fn = serverJs.slice(at, at + 1100);

  it('exists and reports status so a blocked job does not fail the whole purge', () => {
    expect(at).toBeGreaterThan(-1);
    expect(fn).toContain('return { ok: false, status: r.status');
    expect(fn).toContain('return { ok: true, status: r.status };');
  });

  it('is only reachable from the purge cron', () => {
    expect((serverJs.match(/await atsDeleteJobRow\(/g) || []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UI.
// ---------------------------------------------------------------------------
describe('CEO Practices tab — delete + restore', () => {
  it('puts a Delete button next to Edit, hidden from consultants', () => {
    expect(practicesJs).toContain('data-ats="delete-practice"');
    expect(practicesJs).toContain("else if (action === 'delete-practice') openDeleteModal();");
    expect(practicesJs).toContain("ATS.isConsultant && ATS.isConsultant() ? '' : '<button class=\"ats-btn ats-btn-danger ats-btn-sm\" data-ats=\"delete-practice\">");
  });

  it('promises a 12-month restore window, not a permanent deletion', () => {
    expect(practicesJs).toContain('months, then permanently deleted.');
    expect(practicesJs).toContain('<b>Recently deleted</b>');
    // The old copy was written for a hard delete and is now simply untrue.
    expect(practicesJs).not.toContain('This cannot be undone.');
  });

  it('says the job openings go with it and come back with it', () => {
    expect(practicesJs).toContain('will be deleted with it');
    expect(practicesJs).toContain('They come back together if you restore.');
  });

  it('no longer claims applications get unlinked — they do not', () => {
    expect(practicesJs).toContain('stay');
    expect(practicesJs).toContain('Nothing about the doctors, their interviews or their contracts is touched.');
    expect(practicesJs).not.toContain('will be unlinked from this practice');
  });

  it('calls out a PLACED doctor separately from an active applicant', () => {
    expect(practicesJs).toContain('im.placed_application_count');
    expect(practicesJs).toContain('placed here.');
    expect(serverJs).toContain('placed_application_count:');
  });

  it('explains a name clash against a DELETED practice instead of "already exists"', () => {
    // The clashing row is invisible (it is in the archive), so the generic
    // duplicate-name 409 reads as nonsense.
    expect(serverJs).toContain("code: 'duplicate_name_deleted'");
    expect(serverJs).toContain('is in Recently deleted (at the bottom of the Practices list)');
  });

  it('renders a Recently deleted section with a restore button and countdown', () => {
    expect(practicesJs).toContain('/api/ats/practices/deleted');
    expect(practicesJs).toContain('🗑 Recently deleted (');
    expect(practicesJs).toContain('data-ats="restore-practice"');
    expect(practicesJs).toContain("else if (action === 'restore-practice') restorePractice(id, t);");
    expect(practicesJs).toContain('/api/ats/practice/restore');
    expect(practicesJs).toContain('function restoreWindowLabel(row)');
    expect(practicesJs).toContain('job' );
    expect(practicesJs).toContain('archived with it');
  });

  it('counts down in days only when it is nearly up', () => {
    expect(practicesJs).toContain("if (days <= 31) return days + (days === 1 ? ' day' : ' days') + ' left to restore';");
    expect(practicesJs).toContain("return Math.round(days / 30) + ' months left to restore';");
  });

  it('previews the letter, names the recipients, and allows a personal line', () => {
    expect(practicesJs).toContain('id="atsDelSendEmail"');
    expect(practicesJs).toContain('ats-email-preview');
    expect(practicesJs).toContain('id="atsDelNote"');
    expect(practicesJs).toContain('personal_note:');
  });

  it('keeps the delete button disabled until the name is typed back', () => {
    expect(practicesJs).toContain('id="atsDelBtn" disabled');
    expect(practicesJs).toContain("btn.disabled = String(input.value || '').trim().toLowerCase() !== want;");
    expect(practicesJs).toContain("overlay.addEventListener('input', onOverlayInput);");
  });

  it('reports the email outcome and the restore window in the toast', () => {
    expect(practicesJs).toContain("msg += ' · thank-you email could NOT be sent'");
    expect(practicesJs).toContain("msg += ' · restorable for '");
  });

  it('ships the danger button style and a bumped cache buster', () => {
    expect(atsCss).toContain('.ats-btn-danger');
    expect(ceoHtml).toContain('/js/ceo-ats-practices.js?v=20260810c');
    expect(ceoHtml).toContain('/css/ceo-ats.css?v=20260906a');
    expect(ceoHtml).not.toContain('/js/ceo-ats-practices.js?v=20260810b');
    expect(ceoHtml).not.toContain('/js/ceo-ats-practices.js?v=20260809b');
  });
});
