// Owner request 2026-07-30: a doctor who applies DIRECTLY should get the same
// journey and the same screens as a doctor we shortlisted and who accepted —
// only the words differ, and they land in the 'applied' pipeline segment
// rather than passing through 'shortlisted'.
//
// The pipeline half was already true (POST /api/career/apply inserts
// status:'applied' and never touches 'shortlisted'). What was NOT true is that
// the two doctors were told the same things. Both are waiting on exactly one
// step — us putting them in front of the practice — but the matched doctor got
// a three-step "what happens next" everywhere and the direct applicant got
// "Application submitted" and silence.
//
// The load-bearing asymmetry that must SURVIVE: a matched doctor's practice is
// revealed at match time; a direct applicant applied to a masked listing and
// has not earned that. So every piece of new copy tells them what happens next
// WITHOUT naming the practice.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('careerRowIsOwnApplicationAwaitingPractice — who counts as a direct applicant', () => {
  let fn;
  it('loads', async () => {
    fn = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    expect(typeof fn).toBe('function');
  });

  it('a cold application waiting on us is true, at applied AND at submitted', async () => {
    const f = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    expect(f({ status: 'applied', ats_stage: 'applied', origin: 'gp_applied' })).toBe(true);
    // Mirrors getAcceptedMatchAwaitingPracticeForRole, which also runs through
    // 'submitted' — the doctor is still waiting to hear either way.
    expect(f({ status: 'applied', ats_stage: 'submitted', origin: 'gp_applied' })).toBe(true);
  });

  it('a legacy row with no ats_stage still counts — the column default is not the only source', async () => {
    // POST /api/career/apply does not set ats_stage; it relies on the Postgres
    // column default. In local-JSON mode there is no default, so the stage has
    // to be derived or a dev-mode applicant silently gets no banner at all.
    const f = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    expect(f({ status: 'applied', origin: 'gp_applied' })).toBe(true);
  });

  it('anything carrying a match_outcome is NOT a cold apply — the match blocks own those', async () => {
    const f = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    // Accepted match sitting at exactly the same stage: described by
    // matchAccepted, and double-reporting it would race two banners.
    expect(f({ status: 'applied', ats_stage: 'applied', match_outcome: 'accepted' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'not_proceeding', match_outcome: 'declined' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'not_proceeding', match_outcome: 'expired' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'not_proceeding', match_outcome: 'position_filled' })).toBe(false);
  });

  it('an unanswered match is not an application', async () => {
    const f = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    expect(f({ status: 'shortlisted', ats_stage: 'shortlisted', origin: 'ai_matched' })).toBe(false);
  });

  it('withdrawn, rejected and anything past the practice handover are false', async () => {
    const f = (await import('../server.js')).__testUtils.careerRowIsOwnApplicationAwaitingPractice;
    expect(f({ status: 'withdrawn', ats_stage: 'applied' })).toBe(false);
    expect(f({ status: 'rejected', ats_stage: 'applied' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'reviewing' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'interview' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'offer' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'hired' })).toBe(false);
    expect(f({ status: 'applied', ats_stage: 'not_proceeding' })).toBe(false);
    expect(f(null)).toBe(false);
    expect(f(undefined)).toBe(false);
  });
});

describe('the status the doctor reads', () => {
  it('a direct application says what happens next; a match still says fast-tracked; an unanswered match still says matched', async () => {
    const { buildInternalCareerStatusPresentation } = (await import('../server.js')).__testUtils;

    const cold = buildInternalCareerStatusPresentation({ status: 'applied', ats_stage: 'applied', origin: 'gp_applied' }, null);
    expect(cold.status).toBe('applied');           // key is load-bearing — ribbons + timeline index read it
    expect(cold.statusLabel).toContain('putting you forward');
    expect(cold.statusLabel).not.toBe('Application submitted');

    // The two branches above the default must be untouched by the reword.
    const fast = buildInternalCareerStatusPresentation({ status: 'applied', ats_stage: 'applied', match_outcome: 'accepted' }, null);
    expect(fast.status).toBe('fast_tracked');
    const pending = buildInternalCareerStatusPresentation({ status: 'shortlisted', ats_stage: 'shortlisted' }, null);
    expect(pending.status).toBe('matched');
  });
});

describe('/api/career/role wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('the direct-application check sits OUTSIDE the practice-identity reveal gate', () => {
    // The whole point: a direct applicant is NOT revealed, so a check nested in
    // the `if (revealed)` block could never fire for them. Indentation is the
    // structural proof — everything inside that block is indented deeper.
    expect(serverSrc).toContain('\n    if (!roleClientPayload.match && !roleClientPayload.matchAccepted');
    expect(serverSrc).toContain('careerRowIsOwnApplicationAwaitingPractice(roleRevealCtx.application)');
    expect(serverSrc).toContain('roleClientPayload.applied = true;');
    // ...while the accepted-match one stays inside it (deeper indentation).
    expect(serverSrc).toContain('\n        if (acceptedRow) roleClientPayload.matchAccepted = true;');
  });

  it('the reveal verdict and the row come from ONE read, not two', () => {
    // Refetching the identical row to answer a second question is the repeated-
    // identical-query pattern the 2026-07-29 DB-load handover measured.
    expect(serverSrc).toContain('async function resolveCareerRoleRevealContext');
    expect(serverSrc).toContain('await resolveCareerRoleRevealContext(roleDetailUserId, finalRoleRow.id)');
    expect(serverSrc).toContain('const revealed = roleRevealCtx.revealed;');
    // canRevealPracticeIdentity keeps its signature + verdict for its other
    // callers — the reveal POLICY still goes through the one shared rule.
    const wrapper = serverSrc.slice(
      serverSrc.indexOf('async function canRevealPracticeIdentity'),
      serverSrc.indexOf('async function canRevealPracticeIdentity') + 260
    );
    expect(wrapper).toContain('resolveCareerRoleRevealContext');
    expect(wrapper).toContain('return revealCtx.revealed;');
    expect(serverSrc).toContain('revealed: practicePipeline.canRevealPracticeIdentityCore({ application, offer })');
  });

  it('`applied` deliberately does NOT flip the HTTP payload to no-store', () => {
    // A considered split, not an oversight. Match state is actionable from the
    // page (a stale copy replays the accept buttons — the 2026-07-29 bug);
    // `applied` is not, and it only moves when staff submit to the practice.
    // Making it volatile would turn off the 60s private cache for every role a
    // doctor has an active application on — the exact handful they reopen most.
    expect(serverSrc).toContain('const roleCarriesMatchState = !!(roleClientPayload.match || roleClientPayload.matchAccepted);');
    expect(serverSrc).not.toContain('matchAccepted || roleClientPayload.applied)');
  });
});

describe('job.html — the direct applicant sees the same shape of answer', () => {
  const jobHtml = fs.readFileSync(path.join(ROOT, 'pages/job.html'), 'utf8');

  it('the applied banner and bar come from the SERVER, not just this browser', () => {
    // isApplied() reads localStorage, so the doctor who applied on a laptop was
    // shown the Apply button again on their phone.
    expect(jobHtml).toContain('(role.applied || role.applicationStatus || isApplied(role.id)) && !getActiveMatch(role) ? buildApplicationProgressHtml(role)');
    expect(jobHtml).toContain('((role.applied || isApplied(role.id)) && !getActiveMatch(role)) ? "applied" : "idle"');
  });

  it('the role cache refuses a payload carrying `applied` — it goes stale like match state', () => {
    expect(jobHtml).toContain('parsed.role.matchAccepted || parsed.role.applied');
  });

  it('the received banner explains what happens next, and never names the practice', () => {
    const idx = jobHtml.indexOf('function buildReceivedHtml()');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = jobHtml.slice(idx, idx + 900);
    expect(fnSrc).toContain('interview times to choose from');
    expect(fnSrc).toContain('before the practice sees it');
    expect(fnSrc).toContain('nothing you need to do right now');
    // Masked listing: the practice must not be named here. buildFastTrackedHtml
    // legitimately does (a match reveals at match time) — this one must not.
    expect(fnSrc).not.toContain('realPracticeName');
    // And it must not promise a submission that is still the RSO's call.
    expect(fnSrc).not.toContain('putting you forward now');
  });
});

describe('application-detail.html — the same explainer, reworded', () => {
  const detailHtml = fs.readFileSync(path.join(ROOT, 'pages/application-detail.html'), 'utf8');

  it('the note renders for a direct application as well as a fast-track', () => {
    expect(detailHtml).toContain('var isAwaitingSubmission = noteStatusKey === "applied"');
    expect(detailHtml).toContain('ftNoteEl.hidden = !(isFastTracked || isAwaitingSubmission)');
    expect(detailHtml).toContain('id="fastTrackNoteTitle"');
  });

  it('the direct-application wording never names the practice, and the fast-track one still does', () => {
    const idx = detailHtml.indexOf('var noteStatusKey =');
    const block = detailHtml.slice(idx, idx + 1600);
    // fast-track branch keeps the practice name...
    expect(block).toContain('"Your Registration Support Officer is putting you forward to " + practiceName');
    // ...the cold branch is a single literal with no practiceName concatenation.
    const coldIdx = block.indexOf('isAwaitingSubmission) {');
    const coldBlock = block.slice(coldIdx);
    expect(coldBlock).toContain('interview times to choose from');
    expect(coldBlock).not.toContain('practiceName');
  });

  it('the timeline still relabels step 0 only for a fast-track', () => {
    // A direct applicant genuinely did apply, so step 0 stays "Applied".
    expect(detailHtml).toContain('(isFastTracked && i === 0) ? "Fast-tracked" : step.label');
  });
});

describe('the cold-apply email and push', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const idx = serverSrc.indexOf('function notifyGpApplicationSubmitted(');
  const fnSrc = serverSrc.slice(idx, idx + 6000);

  it('tells the doctor the same three steps as the matched copy', () => {
    expect(idx).toBeGreaterThan(-1);
    expect(fnSrc).toContain('Application received — here\\\'s what happens next');
    expect(fnSrc).toContain('checks every application before the practice sees it');
    expect(fnSrc).toContain('Track your application');
  });

  it('never names the practice — that string is reserved for the matched branch', () => {
    // `forPractice` is built from the REAL practice name. A cold applicant has
    // not passed the reveal gate, so leaking it by email would bypass the whole
    // masking model. Both cold branches must use locationLabel instead.
    const coldPush = fnSrc.slice(fnSrc.indexOf('var pushBody ='), fnSrc.indexOf('pushCareerNotificationToUser'));
    const coldPushOnly = coldPush.slice(coldPush.indexOf(': \'Your application for the'));
    expect(coldPushOnly).toContain('locationLabel');
    expect(coldPushOnly).not.toContain('forPractice');

    const coldEmail = fnSrc.slice(fnSrc.indexOf('Thanks for applying for the'), fnSrc.indexOf('ctaText:'));
    expect(coldEmail).toContain('locationLabel');
    expect(coldEmail).not.toContain('forPractice');
  });

  it('still only opts the two accept paths into the matched copy', () => {
    expect(serverSrc).toContain('matchAccept.caseId, applyGpDisplayName, { matched: true }');
    expect(serverSrc).toContain('mrAccept.caseId, mrGpDisplayName, { matched: true }');
    expect(serverSrc).toContain('notifyGpApplicationSubmitted(userId, email, roleRow, applyOpsCaseId, applyGpDisplayName);');
  });
});

describe('the pipeline half — a direct apply must never touch the shortlist stage', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('the insert lands in applied, with origin gp_applied', () => {
    const idx = serverSrc.indexOf('const appRow = {\n      user_id: userId,');
    expect(idx).toBeGreaterThan(-1);
    const insertSrc = serverSrc.slice(idx, idx + 700);
    expect(insertSrc).toContain("status: 'applied'");
    expect(insertSrc).toContain("origin: 'gp_applied'");
    expect(insertSrc).not.toContain("'shortlisted'");
  });

  it('applying to a role you were already matched to still counts as accepting that match', () => {
    // Otherwise a doctor could sidestep the match record by using Apply, and
    // the row would carry no match_outcome for a match we really did send.
    expect(serverSrc).toContain("if (existingAppRow.ats_stage === 'shortlisted') {");
    expect(serverSrc).toContain('await acceptShortlistedMatchRow(existingAppRow, userId, email, profile)');
  });
});
