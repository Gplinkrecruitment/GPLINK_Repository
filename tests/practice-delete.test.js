import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * "i should be able to delete a practice. and when i delete it it send the
 * practice a nice template email thanking them and should they need a GP in the
 * future we would be happy to work together again in the future" — owner,
 * 2026-08-10, from the Erina Medical Centre detail page.
 *
 * Before this there was NO delete-practice path in the app at all: the only
 * removal gesture on the Practices tab was stage=archived, which collapses the
 * card into "Archived & declined" but leaves the row, its job listings and its
 * public board entries exactly where they were.
 *
 * The delete cannot be a bare DELETE on `practices`. Verified FK behaviour
 * (information_schema, 2026-07-28):
 *   - career_roles.practice_id     SET NULL  -> the job SURVIVES, keeps its
 *       practice_name and is_active, so it stays on the public board AND
 *       rebuilds the practice as a name-only card (atsListPracticesDerived
 *       groups jobs by practice_name). Retiring the jobs is what makes the
 *       delete actually stick.
 *   - gp_applications.practice_id  NO ACTION -> BLOCKS the delete.
 *   - career_contracts/career_interviews .application_id  CASCADE -> which is
 *       why the block is cleared by UNLINKING the application, never deleting
 *       it. Deleting would silently destroy the doctor's interviews+contracts.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const practicesJs = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-practices.js'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const atsCss = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');

const pipeline = require(path.join(ROOT, 'lib/practice-pipeline.js'));

// ---------------------------------------------------------------------------
// The letter itself (a pure function — tested for real, not pinned).
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

  it('says plainly that the record is closed, so the silence is explained', () => {
    expect(copy.bodyHtml).toContain('closed your practice record with GP Link');
  });

  it('carries no call-to-action button — there is nothing left for them to do', () => {
    expect(copy.ctaUrl).toBeUndefined();
    expect(copy.ctaText).toBeUndefined();
  });

  it('signs off in the same house style as the intake letter', () => {
    const intake = pipeline.buildIntakeEmailCopy({ practiceName: 'X', contactName: 'Y', intakeUrl: 'https://e.g' });
    // Same signature block: CEO name, logo, company line.
    expect(copy.signatureHtml).toContain('CEO');
    expect(copy.signatureHtml).toContain('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
    expect(intake.signatureHtml).toContain('GP LINK RECRUITMENT AUSTRALIA PTY LTD');
  });

  it('ships a plain-text twin so text-only clients get a readable letter', () => {
    expect(copy.text).toContain('Dear Khaleed,');
    expect(copy.text).toContain('Warm regards');
    // Properly spaced paragraphs, not one run-on block.
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
    // Blank note -> no empty paragraph left behind.
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
// The endpoints.
// ---------------------------------------------------------------------------
describe('POST /api/ats/practice/delete', () => {
  const at = serverJs.indexOf("if (pathname === '/api/ats/practice/delete' && req.method === 'POST')");
  const block = serverJs.slice(at, serverJs.indexOf('// Manual signed-agreement upload (Phase 3)', at));

  it('exists at all (there was no delete path in the app before this)', () => {
    expect(at).toBeGreaterThan(-1);
    expect(serverJs).toContain("if (pathname === '/api/ats/practice/delete-preview' && req.method === 'GET')");
  });

  it('is CEO-only — a consultant cannot permanently delete a client', () => {
    expect(block).toContain('requireCeoSession(req, res)');
    expect(block).not.toContain('requireAtsSession(req, res)');
    const preview = serverJs.slice(serverJs.indexOf("'/api/ats/practice/delete-preview'"));
    expect(preview.slice(0, 400)).toContain('requireCeoSession(req, res)');
  });

  it('refuses unless the practice name is typed back exactly', () => {
    expect(block).toContain("code: 'confirm_name_mismatch'");
    expect(block).toContain('Type the practice name exactly as it appears');
    expect(block).toContain('pdTyped !== pdRealName');
    // The check has to happen BEFORE anything is written.
    expect(block.indexOf('confirm_name_mismatch')).toBeLessThan(block.indexOf('atsDeletePracticeRow'));
  });

  it('UNLINKS blocking applications rather than deleting them', () => {
    // career_contracts + career_interviews CASCADE off gp_applications, so a
    // delete here would silently destroy the doctor's history.
    expect(block).toContain('body: { practice_id: null }');
    expect(block).not.toMatch(/gp_applications[^\n]*method: 'DELETE'/);
  });

  it('puts the applications back if the row delete then fails', () => {
    expect(block).toContain('async function pdRestoreApplications()');
    expect(block).toContain('body: { practice_id: pdImpact.rowId }');
    // Two restore points cover all three failure exits after the unlink: the
    // unlink loop's own bail-out, and the row-delete branch (whose 409 and 502
    // exits share one restore because both sit under the same `if`).
    expect((block.match(/await pdRestoreApplications\(\);/g) || []).length).toBe(2);

    // Every failure exit that can be reached AFTER the first application is
    // unlinked must restore first — otherwise a delete that didn't happen
    // would leave candidates detached from a practice that still exists.
    const unlinkAt = block.indexOf('body: { practice_id: null }');
    const successAt = block.indexOf('sendJson(res, 200, {');
    const tail = block.slice(unlinkAt, successAt);
    const restorePoints = [...tail.matchAll(/await pdRestoreApplications\(\);/g)].map((m) => m.index);
    const failureExits = [...tail.matchAll(/sendJson\(res, (?:409|502|500), \{ ok: false/g)].map((m) => m.index);
    expect(failureExits.length).toBe(3);
    failureExits.forEach((exitAt) => {
      expect(restorePoints.some((r) => r < exitAt)).toBe(true);
    });
  });

  it('retires the job listings — otherwise the practice rebuilds itself', () => {
    // atsListPracticesDerived groups jobs by practice_name, so a surviving live
    // job re-creates the deleted practice as a name-only card.
    expect(block).toContain("var pdJobPatch = { is_active: false, job_status: 'closed' };");
    // Pending jobs are merged into the directory too, so they must move as well.
    expect(block).toContain("if (pdJob.approval_status === 'pending') pdJobPatch.approval_status = 'rejected';");
  });

  it('deletes the row before retiring the jobs, so a blocked delete changes no jobs', () => {
    expect(block.indexOf('atsDeletePracticeRow')).toBeLessThan(block.indexOf('var pdJobsRetired = 0;'));
  });

  it('explains a 409 instead of failing blankly', () => {
    expect(block).toContain("code: 'still_referenced'");
    expect(block).toContain('still linked to other records');
  });

  it('never lets a failed email fail the delete', () => {
    // The practice is already gone by then — the outcome is reported, not thrown.
    expect(block).toContain('pdEmailResult.sent = !!(pdSent && pdSent.ok);');
    expect(block).toContain('sendJson(res, 200, {');
    expect(block.indexOf('sendPracticeFarewellEmail')).toBeGreaterThan(block.indexOf('atsDeletePracticeRow'));
  });

  it('defaults to sending the thank-you letter', () => {
    expect(block).toContain('var pdSendEmail = bodyPD.send_email !== false;');
  });

  it('logs who deleted what', () => {
    expect(block).toContain("console.log('[practice-delete]'");
  });
});

describe('sendPracticeFarewellEmail', () => {
  const at = serverJs.indexOf('async function sendPracticeFarewellEmail(');
  const fn = serverJs.slice(at, serverJs.indexOf('\n}', serverJs.indexOf('} catch (e) {', at)) + 2);

  it('sends from hello@ and lets the practice reply straight back to a human', () => {
    expect(fn).toContain('from: { email: GP_OWNER_EMAIL, name: \'GP Link\' }');
    expect(fn).toContain('replyTo: GP_OWNER_EMAIL');
  });

  it('CCs the secondary contacts — the people copied on the introductions', () => {
    expect(fn).toContain('atsPracticeUtil.normalizeSecondaryContacts(practice.secondary_contacts, toEmail)');
    expect(fn).toContain('cc: ccList.length ? ccList : undefined');
  });

  it('is transactional, so it carries no unsubscribe/marketing category', () => {
    expect(fn).not.toContain("category: 'marketing'");
  });

  it('returns a reason instead of throwing when it cannot send', () => {
    expect(fn).toContain("return { ok: false, error: 'no_contact_email' };");
    expect(fn).toContain("return { ok: false, error: 'email_not_configured' };");
    expect(fn).toContain('} catch (e) {');
  });

  it('sends both the HTML letter and its plain-text twin', () => {
    expect(fn).toContain('html: buildCareerEmailHtml(copy)');
    expect(fn).toContain('text: copy.text');
  });
});

describe('atsDeletePracticeRow', () => {
  const at = serverJs.indexOf('async function atsDeletePracticeRow(id)');
  const fn = serverJs.slice(at, at + 1200);

  it('reports the status so the caller can tell a block from a failure', () => {
    expect(at).toBeGreaterThan(-1);
    expect(fn).toContain('return { ok: false, status: r.status');
    expect(fn).toContain('return { ok: true, status: r.status };');
  });

  it('works against the local JSON db too', () => {
    expect(fn).toContain('dbState.atsPractices = (dbState.atsPractices || []).filter(');
    expect(fn).toContain('saveDbState();');
  });
});

// ---------------------------------------------------------------------------
// The Practices tab UI.
// ---------------------------------------------------------------------------
describe('CEO Practices tab — delete control', () => {
  it('puts a Delete button next to Edit on the practice detail header', () => {
    expect(practicesJs).toContain('data-ats="delete-practice"');
    expect(practicesJs).toContain("else if (action === 'delete-practice') openDeleteModal();");
  });

  it('hides Delete from consultants (they keep Stage -> Archived)', () => {
    expect(practicesJs).toContain("ATS.isConsultant && ATS.isConsultant() ? '' : '<button class=\"ats-btn ats-btn-danger ats-btn-sm\" data-ats=\"delete-practice\">");
  });

  it('shows what will actually happen before confirming', () => {
    expect(practicesJs).toContain('/api/ats/practice/delete-preview?id=');
    expect(practicesJs).toContain('will be closed');
    expect(practicesJs).toContain('live on the public jobs board right now');
    expect(practicesJs).toContain('will be unlinked from this practice');
    expect(practicesJs).toContain('The doctors, their interviews and their contracts are all kept.');
  });

  it('points at Archive as the reversible alternative', () => {
    expect(practicesJs).toContain('This cannot be undone.');
    expect(practicesJs).toContain('Stage → Archived');
  });

  it('previews the letter, names the recipients, and allows a personal line', () => {
    expect(practicesJs).toContain('id="atsDelSendEmail"');
    expect(practicesJs).toContain('ats-email-preview');
    expect(practicesJs).toContain('em.preview_text');
    expect(practicesJs).toContain('id="atsDelNote"');
    expect(practicesJs).toContain('personal_note:');
  });

  it('says WHY there is no letter when there cannot be one', () => {
    expect(practicesJs).toContain('email sending is not configured on this environment');
    expect(practicesJs).toContain('there is no contact email on file for this practice');
  });

  it('keeps the delete button disabled until the name is typed back', () => {
    expect(practicesJs).toContain('id="atsDelBtn" disabled');
    expect(practicesJs).toContain('function syncDeleteConfirmState()');
    expect(practicesJs).toContain("btn.disabled = String(input.value || '').trim().toLowerCase() !== want;");
    // Needs keystroke-level events — change/blur would leave it disabled.
    expect(practicesJs).toContain("overlay.addEventListener('input', onOverlayInput);");
  });

  it('reports the email outcome honestly in the toast', () => {
    expect(practicesJs).toContain("msg += ' · thank-you email sent'");
    expect(practicesJs).toContain("msg += ' · thank-you email could NOT be sent'");
  });

  it('ships the danger button style and a bumped cache buster', () => {
    expect(atsCss).toContain('.ats-btn-danger');
    expect(ceoHtml).toContain('/js/ceo-ats-practices.js?v=20260810a');
    expect(ceoHtml).toContain('/css/ceo-ats.css?v=20260810a');
    expect(ceoHtml).not.toContain('/js/ceo-ats-practices.js?v=20260809b');
    expect(ceoHtml).not.toContain('/css/ceo-ats.css?v=20260805h');
  });
});
