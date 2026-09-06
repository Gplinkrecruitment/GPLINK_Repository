// Thorough scan of everything built on localhost (owner 2026-09-07: "do a
// thorough scan and fix any bugs, discrepancies, etc"). Four reviewers + a
// headless-Chrome render of the shell as the test doctor; every fix below is
// pinned so it cannot quietly regress.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('job page — bars tell the truth about closed, offer-preparing and pending states', () => {
  const job = read('pages/job.html');
  it('a closed application never paints "Interview request sent"', () => {
    expect(job).toContain('const CLOSED_APPLICATION_KEYS = ["withdrawn", "not_proceeding", "offer_declined", "declined"];');
    expect(job).toContain('if (CLOSED_APPLICATION_KEYS.includes(st)) return false;');
    expect(job).toContain('? "previously_withdrawn"');
    expect(job).toContain('? "closed_not_proceeding"');
    expect(job).toContain('? "closed_offer_declined"');
    expect(job).toContain('closed_not_proceeding: {');
    expect(job).toContain('closed_offer_declined: {');
    expect(job).toContain('"previously_withdrawn", "closed_not_proceeding", "closed_offer_declined", "matched_accepted"]');
  });
  it('an offer the practice is still preparing is not "waiting for you"', () => {
    expect(job).toContain('if (st === "offer" && role.applicationStatus.offerPending === false) return "offer_preparing";');
    expect(job).toContain('offer_preparing: "✓ Offer on its way');
    expect(job).toContain('html: (JOB_BAR_STAGES[jobBarStageFor(currentRole)]');
  });
  it('the "Loading your match…" hold ends once the detail has answered', () => {
    expect(job).toContain('let roleDetailLoaded = false;');
    expect(job).toContain('let enrichedRole = await detailPromise;\n    roleDetailLoaded = true;');
    expect(job).toContain('((!roleDetailLoaded && !getActiveMatch(role) && !role.match && !hasServerApplication(role) && getPendingLocalMatch(role.id)) ? "match_pending" : "idle")');
  });
  it('one noun everywhere: interview request', () => {
    expect(job).toContain('"Apply for an interview?"');
    expect(job).toContain('applyConfirmBtnEl.textContent = activeMatch ? "Fast-track me" : "Apply for interview";');
    expect(job).toContain('"Interview request sent ✓ Your Registration Support Officer will be in touch shortly"');
    expect(job).not.toContain('"Application sent ✓');
    expect(job).not.toContain('"Apply for this role?"');
  });
  it('the Saved snapshot keeps the masked headline and carries the real name beside it', () => {
    expect(job).toContain('practiceName: role.practiceName,\n      realPracticeName: role.realPracticeName || "",\n      website: role.website || "",');
  });
});

describe('careers page — an accepted match is an application; pending matches wear no chip', () => {
  const career = read('pages/career.html');
  it('fast_tracked never lands in Offers, whatever `revealed` says', () => {
    expect(career).toContain('if (key === "fast_tracked") return false;\n      return application.offerPending === true');
  });
  it('a pending match is not "applied" on its Roles card', () => {
    expect(career).toContain('isActiveApplication(job) && !isPendingMatchApplication(job));');
  });
  it('the Offers tab survives a reload', () => {
    expect(career).toContain('["browse", "applications", "offers", "saved"].includes(source.activeView)');
  });
  it("'shortlisted' is a pending match everywhere, never an interview stage", () => {
    expect(career).toContain('if (key === "matched" || key === "shortlisted") {\n        return { label: "Matched to you", tone: "review", isPlacementSecured: false };');
    expect(career).toContain('if (key === "matched" || key === "shortlisted") {\n        return S({');
    expect(career).not.toContain('["interview", "interview_scheduled", "shortlisted"]');
  });
  it('next step + card copy for fast_tracked and the two offer states', () => {
    expect(career).toContain('if (key === "fast_tracked") return "Being put forward to the practice";');
    expect(career).toContain('return offerPending === false ? "Waiting for the practice\'s offer" : "Review your offer";');
    expect(career).toContain('nextStepForApplication(app.status, app.interview, app.offerPending === true)');
    expect(career).toContain('blurb: "The practice has made you an offer — open it to read the terms and respond.",');
    expect(career).toContain('label: "Offer coming", ribbon: "OFFER ON ITS WAY"');
  });
  it('the Roles card never repeats the masked headline as the role type', () => {
    expect(career).toContain('function isMaskedHeadlineText(value) {');
    expect(career).toContain('(isMaskedHeadlineText(rawRoleType) || rawRoleType === String(role.practiceName || "")) ? "General Practitioner" : rawRoleType;');
  });
});

describe('application page — legacy shortlisted rows bounce like matched ones', () => {
  const detail = read('pages/application-detail.html');
  it('bounces on matched or shortlisted and never labels them an interview', () => {
    expect(detail).toContain('if (bounceKey === "matched" || bounceKey === "shortlisted") {');
    expect(detail).toContain('interview: 2, interview_scheduled: 2, interview_completed: 2,');
    expect(detail).toContain('shortlisted: "Matched to you — accept or decline"');
  });
});

describe('shell + modules', () => {
  it('a frame that navigates itself onto a hidden route is sent to the landing page', () => {
    const shell = read('js/app-shell.js');
    expect(shell).toContain('if (PH && currentPhase && PH.isRouteHiddenInPhase(currentPhase, routeFromUrl(routeUrl))) {\n      navigateTo(PH.landingRoute(currentPhase), { historyMode: "replace", animate: false });\n      return;\n    }');
    expect(shell).toContain('if (reason !== "boot" && reason !== "hydrated" && previous && next !== "restricted"');
  });
  it('the two-tab grid applies in the onboarding phase too', () => {
    expect(read('pages/app-shell.html')).toContain('html.gp-phase-position .mobile-nav,\n    html.gp-phase-onboarding .mobile-nav {');
  });
  it('Enter on a focused Back/Close button activates that button, not Next', () => {
    expect(read('js/gp-intro-slides.js')).toContain("if (e.key === 'Enter' && ae && ae.tagName === 'BUTTON' && overlay.contains(ae) && ae.getAttribute('data-slide-next') !== '1') return;");
  });
  it('the step strip says the request is with US while applied', () => {
    const { deriveCareerStep } = require(path.join(process.cwd(), 'js', 'career-step-strip.js'));
    const app = (over) => Object.assign({ id: 'a1', roleId: 'r9', practiceName: 'Practice', rawStatus: 'applied', offerPending: false, contractStage: null, interview: null, isPlacementSecured: false }, over);
    expect(deriveCareerStep([app({ practiceName: 'Sandbox Coastal' })]).hint).toContain('We are reviewing your interview request and will put you forward to Sandbox Coastal');
    expect(deriveCareerStep([app({ rawStatus: 'submitted', practiceName: 'Sandbox Coastal' })]).hint).toContain('Your application is with Sandbox Coastal');
  });
  it('the match popup ignores an expired hold', () => {
    expect(read('js/match-popup.js')).toContain('return !(isFinite(exp) && exp < now);');
  });
  it('allowlist phones compare in E.164 after AU normalisation — never by suffix', () => {
    const { createNotifyAllowlist, phoneDigits, parseRecipients } = require(path.join(process.cwd(), 'lib', 'notify-allowlist.js'));
    expect(phoneDigits('0406 281 243')).toBe('61406281243');
    expect(phoneDigits('+61 406 281 243')).toBe('61406281243');
    const list = createNotifyAllowlist('0406281243');
    expect(list.permitsPhone('+61406281243')).toBe(true);
    expect(list.permitsPhone('+447406281243')).toBe(false); // foreign number sharing the last 9 digits
    expect(parseRecipients('a@b.com c@d.com').warnings.length).toBe(1);
  });
  it('stalled detector: `revealed` alone is not an introduction; a practice approval is', () => {
    const S = require(path.join(process.cwd(), 'lib', 'stalled-applications.js'));
    expect(S.isIntroduced({ revealed: true })).toBe(false);
    expect(S.isIntroduced({ practice_submission_status: 'client_approved' })).toBe(true);
  });
});

describe('CEO board', () => {
  const m = read('js/ceo-ats-matching.js');
  it('toasts report the WhatsApp leg, stay on screen when something failed, and never offer a dead run/resend', () => {
    expect(m).toContain("if (r.notified && r.notified.whatsapp && r.notified.whatsapp.ok === false) waFailed.push(mbNotifyReason(r.notified.whatsapp.error));");
    expect(m).toContain("function mbToastType(msg) { return /NOT sent|failed|Could not/.test(String(msg || '')) ? 'error' : ''; }");
    expect((m.match(/mbToastType\(mbShortlistToast/g) || []).length).toBe(2);
    expect(m).toContain("!mbShouldShowExtend(entry.match, nowMs))");
    expect(m).toContain("if (window.__gpSwr) { try { window.__gpSwr.purge(); } catch (e) { /* ignore */ } }\n      fetchBoard();");
    expect(m).toContain("((gp && gp.blocked) ? '' : '<button type=\"button\" class=\"ats-mb-runbtn ats-mb-runbtn--inline\"");
    expect(read('js/ceo-ats-shared.js')).toContain("type === 'error' ? 8000 : 2600");
    expect(read('pages/ceo-dashboard.html')).toContain("type === 'error' ? 8000 : 3000");
    const c = read('js/ceo-ats-candidates.js');
    expect(c).not.toContain('ATS.stageLabel');
    expect(c).toContain("(a.case_id ? ' · tap to open' : '')");
  });
});

describe('server', () => {
  const s = read('server.js');
  it('the job-page accept path sends the same WhatsApp as the match/respond path', () => {
    expect((s.match(/sendMatchAcceptedWhatsAppToGp\((mrAccept|matchAccept)\.updatedRow\)\.catch\(/g) || []).length).toBe(2);
  });
  it('a stalled alert that did not go out is retried next sweep', () => {
    expect(s).toContain('for (var i = 0; emailed && i < fresh.length; i++) {');
    expect(s).toContain('nextSentinel(emailed ? items : items.filter(function (it) { return !fresh.some(function (f) { return f.id === it.id; }); }), sentinel, nowIso)');
  });
  it('identity tier names the clinic + clinic site, exactly like the named tier', () => {
    expect(s).toContain("const revealName = (roleRow ? resolveCareerRolePracticeName(roleRow, revealedPractice) : '')");
    expect(s).toContain("const detailRealName = (roleRow ? resolveCareerRolePracticeName(roleRow, detailRevealPractice) : '')");
    expect(s).toContain('const revealedWebsite = resolveNamedPracticeWebsite(finalRoleRow, practiceRow);');
    expect(s).not.toContain("const revealName = (roleRow && roleRow.practice_name)");
  });
  it('an allowlist block is a skip, not a recorded delivery failure', () => {
    expect(s).toContain("if (/blocked_by_test_allowlist/.test(String(lastFailure || ''))) {\n        return { ok: false, skipped: true, blocked: true, error: 'blocked_by_test_allowlist' };");
  });
  it('phones are normalised before the Zoom-invite text; notify summaries carry skip reasons', () => {
    expect(s).toContain("const toNormalised = normalizePhone(toPhone);\n  if (!toNormalised) return { ok: false, error: 'invalid_phone' };");
    expect(s).toContain("error: (r && !r.ok) ? String(r.error || r.skipped || '') : ''");
  });
  it('an unannounced shortlist is never presented as a match; a match on an imported role is still in-app', () => {
    expect(s).toContain("if (stage === 'shortlisted' && !row.match_outcome && row.matched_at) {");
    expect(s).toContain("if (origin === 'gp_applied' || origin === 'admin_applied' || origin === 'ai_matched') return true;\n  if (appRow && appRow.matched_at) return true;");
    expect(s).toContain('offerPending: roleStatusView.offerPending === true');
    expect(s).not.toContain('nudgeTemplateMap');
  });
});
