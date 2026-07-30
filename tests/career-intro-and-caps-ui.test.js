import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const career = read('pages/career.html');
const job = read('pages/job.html');
const account = read('pages/account.html');
const walkthrough = read('js/gp-walkthrough.js');
const notice = read('js/gp-notice.js');

/* Owner ask 2026-07-31:
   "when the GP clicks the careers page for the first time there is a page that
    opens explaining the process and the rules (make sure the walkthrough of the
    page does not start until they have closed that page, uploaded their CV and
    continued on, only then should the walkthrough show)" */
describe('first-visit careers explainer', () => {
  it('is a full-screen page, not another modal on the pile', () => {
    expect(career).toMatch(/<div class="career-intro" id="careerIntro"[^>]*role="dialog"/);
    expect(career).toMatch(/\.career-intro \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/);
    // Above the CV gate's .modal (80) because it comes first, below the boot
    // overlay (200) so it can never flash over an undecided page.
    const rule = career.slice(career.indexOf('.career-intro {'), career.indexOf('.career-intro.is-open'));
    const z = Number((rule.match(/z-index:\s*(\d+)/) || [])[1]);
    expect(z).toBeGreaterThan(80);
    expect(z).toBeLessThan(200);
  });

  it('explains the process and states all three rules', () => {
    expect(career).toContain('Browse and apply');
    expect(career).toContain('We introduce you');
    expect(career).toContain('Meet the practice');
    expect(career).toContain('Offer and contract');
    expect(career).toContain('2 live applications at a time');
    expect(career).toContain('3 positions a month');
    expect(career).toContain('Withdrawing is final for that position');
  });

  // The ordering is the requirement, not a nicety.
  it('opens BEFORE the CV gate — the gate waits on it', () => {
    expect(career).toContain('ensureCareerIntro().then(ensureCareerGate)');
    const introIdx = career.indexOf('function ensureCareerIntro()');
    const gateIdx = career.indexOf('async function ensureCareerGate()');
    expect(introIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    // ensureCareerIntro resolves only when the doctor presses Continue.
    const fn = career.slice(introIdx, career.indexOf('document.addEventListener("click", (ev) => {', introIdx));
    expect(fn).toContain('careerIntroPending = resolve;');
    expect(fn).toContain('openCareerIntro();');
  });

  it('blocks the walkthrough while it is open, and defers UNMARKED', () => {
    const blocked = walkthrough.slice(walkthrough.indexOf('function pageBlocked()'), walkthrough.indexOf('var deferRetry'));
    expect(blocked).toContain("classList.contains('career-intro-open')");
    expect(blocked).toContain("querySelector('.career-intro.is-open')");
    // The CV gate stays a blocker too — the walkthrough must wait for BOTH.
    expect(blocked).toContain("classList.contains('career-gate-open')");
    // pageBlocked() is consulted before markSeen(area), so deferring never
    // burns the doctor's one chance to see the tip.
    // runArea is defined ABOVE maybeRun, so slice forward from maybeRun only.
    const maybeRun = walkthrough.slice(walkthrough.indexOf('function maybeRun()'));
    expect(maybeRun.indexOf('armRetry(); return;')).toBeGreaterThan(-1);
    expect(maybeRun.indexOf('armRetry(); return;')).toBeLessThan(maybeRun.indexOf('markSeen(area)'));
  });

  it('wakes the walkthrough when it closes, so the tip is not lost forever', () => {
    expect(career).toContain("window.dispatchEvent(new CustomEvent(\"gp-career-intro-closed\"))");
    expect(walkthrough).toContain("window.addEventListener('gp-career-intro-closed', fire)");
    expect(walkthrough).toContain("window.removeEventListener('gp-career-intro-closed', fire)");
  });

  it('remembers it was read, on the server not just this browser', () => {
    expect(career).toContain('const CAREER_INTRO_SEEN_KEY = "gp_career_intro_seen"');
    expect(career).toContain('localStorage.setItem(CAREER_INTRO_SEEN_KEY');
    expect(career).toContain('window.gpLinkStateSync.push()');
    // Reading the flag before state-sync hydrates would show the explainer to
    // someone who has already read it on another device.
    expect(career).toContain('function careerIntroWaitForState()');
    expect(career).toContain("window.addEventListener(\"gp-state-hydrated\", go, { once: true })");
    // ...but a state round-trip that never arrives must not hang the page.
    expect(career).toContain('window.setTimeout(go, 2500)');
  });

  it('a placed doctor never sees it', () => {
    const fn = career.slice(career.indexOf('function ensureCareerIntro()'));
    expect(fn.slice(0, 400)).toContain('if (shouldLockCareerToSecuredView()) return Promise.resolve();');
  });

  it('can be re-opened on demand, and the account page offers exactly that', () => {
    expect(career).toContain('.get("intro") === "1"');
    expect(account).toContain('href="career?intro=1"');
    expect(account).toContain('How careers works');
    // The page promises this in its own footnote — keep them together.
    expect(career).toContain('You can read this again any time from your account.');
  });
});

/* Owner rule 2026-07-31: 2 live applications, 3 positions a month, and the
   refusal must arrive as a notification the doctor can act on. */
describe('application-rule notifications', () => {
  it('one shared dialog, so both pages explain the rule identically', () => {
    expect(career).toContain('<script src="/js/gp-notice.js?v=20260731a"></script>');
    expect(job).toContain('<script src="/js/gp-notice.js?v=20260731a"></script>');
    expect(notice).toContain('root.gpNotice = { show: show, hide: hide, isOpen: isOpen };');
  });

  it('the job page turns both 409s into the dialog, not a vanishing toast', () => {
    expect(job).toContain('data.error === "active_cap"');
    expect(job).toContain('data.error === "monthly_cap"');
    expect(job).toContain('showApplicationCapNotice("active", data)');
    expect(job).toContain('showApplicationCapNotice("monthly", data)');
    // Neither is terminal: withdrawing (or next month) makes applying possible
    // again, so the Apply button must stay usable.
    const handler = job.slice(job.indexOf('if (data && data.error === "active_cap")'), job.indexOf('if (status === 429)'));
    expect(handler).toContain('applyState = "idle"');
    expect(handler).not.toContain('TERMINAL_APPLY_STATES');
  });

  it('names the applications standing in the way instead of just refusing', () => {
    for (const page of [job, career]) {
      expect(page).toContain('/api/career/application-usage');
      expect(page).toContain('usage.active.applications');
    }
    // Only the job page offers "Manage my applications" — on the careers page
    // the doctor is already there, so a button back to it would be noise.
    expect(job).toContain("secondaryLabel: \"Manage my applications\"");
    const careerFn = career.slice(career.indexOf('function showApplicationCapNotice'), career.indexOf('function buildRoleThumbHtml'));
    expect(careerFn).not.toContain('secondaryLabel');
    // The list arrives after the dialog is already up, so a slow or failed
    // lookup leaves plain wording rather than a spinner.
    const fn = job.slice(job.indexOf('function showApplicationCapNotice'), job.indexOf('function openBookConfirm'));
    expect(fn.indexOf('window.gpNotice.show(base);')).toBeLessThan(fn.indexOf('/api/career/application-usage'));
    expect(fn).toContain('.catch(function () {');
  });

  it('accepting a match is refused the same way, in match wording', () => {
    const accept = career.slice(career.indexOf('async function submitMatchAccept'), career.indexOf('async function submitMatchDecline'));
    expect(accept).toContain('data.error === "active_cap" || data.error === "monthly_cap"');
    expect(accept).toContain('{ context: "match" }');
    expect(career).toContain('opts.context === "match" ? "accept this match" : "apply for this position"');
  });

  it('falls back to a toast if the dialog module did not load — never silence', () => {
    expect(job).toContain('showToast(serverMessage || "You\'ve reached your application limit.")');
    expect(career).toContain('showToast(serverMessage || "You\'ve reached your application limit.")');
  });

  it('a rule the doctor must acknowledge cannot be dismissed by a stray tap', () => {
    expect(notice).toContain("current.dismissible !== false");
    expect(notice).toContain("if (current && current.dismissible === false) return;");
  });
});

describe('the design reference page', () => {
  const ref = read('pages/career-card-states.html');
  const server = read('server.js');

  it('is not reachable in production', () => {
    expect(server).toContain("const DEV_ONLY_PAGES = new Set(['pages/career-card-states.html']);");
    expect(server).toContain("if (DEV_ONLY_PAGES.has(segments.join('/')) && process.env.NODE_ENV === 'production') return false;");
  });

  it('renders the REAL card rather than a copy that can drift', () => {
    expect(ref).toContain("fetch('/pages/career.html?gp_shell_static=1'");
    expect(ref).toContain('buildCareerApplicationCardHtml');
    expect(ref).toContain('buildMatchCardHtml');
    // It must fail loudly rather than quietly show something that is not the card.
    expect(ref).toContain('so this page is NOT showing the real card');
  });
});
