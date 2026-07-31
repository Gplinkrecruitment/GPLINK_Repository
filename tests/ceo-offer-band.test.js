// The staff OFFER band on the candidate card (owner request, 2026-07-31).
//
// Staff already manage the interview stage from the candidate card. The offer
// stage did not live there at all: the contract sat on a separate "Contracts"
// tab and the card's offer row still drove the LEGACY `ats_offers` "Send
// offer" form that the post-interview pipeline never uses. js/ceo-ats-offer.js
// puts the whole post-interview picture in that row instead — what the
// practice did and how long ago, the uploaded contract with its AI verdict, a
// release-to-the-doctor action, how long the doctor has had it, a nudge, and
// every superseded version.
//
// Source-level assertions (this repo's existing style for UI wiring): there is
// no jsdom here, so the checks pin the markup builders, the endpoint+payload
// each button maps to, and the cache keys that actually deliver the change.
// The behavioural half — /api/ats/application/offer-state and
// /api/ats/contract/nudge against a live server — lives in
// tests/contract-nudge-and-offer-state.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const offerJs = read('js/ceo-ats-offer.js');
const candidatesJs = read('js/ceo-ats-candidates.js');
const css = read('css/ceo-ats.css');
const dashHtml = read('pages/ceo-dashboard.html');

// The slice of ceo-ats-candidates.js that decides which offer UI a card gets.
const offerBoxFn = candidatesJs.slice(
  candidatesJs.indexOf('var POST_INTERVIEW_STAGES'),
  candidatesJs.indexOf('function hydrateOfferBands')
);

describe('offer band — where it mounts', () => {
  it('exposes the lazily-hydrated entry point, mirroring the interview slot picker', () => {
    expect(offerJs).toContain('window.atsRenderOfferBand = function (applicationId, containerEl, caseId)');
    // The precedent it copies must still be there — if the slot picker's shape
    // ever changes, this band should change with it.
    expect(candidatesJs).toContain('window.atsRenderSlotPicker = function (applicationId, containerEl, caseId)');
  });

  it('mounts ONLY for applications that reached the post-interview pipeline', () => {
    expect(offerBoxFn).toContain("var POST_INTERVIEW_STAGES = ['interview', 'offer', 'hired'];");
    expect(offerBoxFn).toContain("POST_INTERVIEW_STAGES.indexOf(a.ats_stage) !== -1 || a.status === 'interview_completed'");
  });

  it('keeps the legacy ats_offers "Send offer" form for everything earlier', () => {
    // The regression guard: an application still in applied/submitted/reviewing
    // must keep the pre-interview line, or staff lose the only way to send one.
    expect(offerBoxFn).toContain('if (!isPostInterviewApp(a)) return offerLineHtml(a);');
    expect(candidatesJs).toContain('function offerLineHtml(a)');
    expect(candidatesJs).toContain('ats-offer-send');
    // …and the two paths are documented as two paths, not an accident.
    expect(candidatesJs).toContain('BEFORE the interview the legacy `ats_offers` "Send offer" form');
  });

  it('the offer row renders the placeholder and wireDetailEvents hydrates it', () => {
    expect(candidatesJs).toContain("'<div class=\"ats-offer-box\" data-offer-app-id=\"' + ATS.escAttr(String(a.id)) + '\" style=\"flex:1;min-width:0\">' + offerBoxInnerHtml(a) + '</div>'");
    expect(candidatesJs).toContain("'<div class=\"ats-app-offer-band\" data-offer-band-id=\"'");
    expect(candidatesJs).toContain(".ats-app-offer-band[data-offer-band-id]");
    expect(candidatesJs).toContain('hydrateOfferBands(host, c.case_id);');
  });

  it('an un-hydrated placeholder still says something (never an empty box)', () => {
    expect(offerBoxFn).toContain('<span class="ats-ob-loading">Loading the offer…</span>');
    expect(offerJs).toContain("containerEl.innerHTML = '<span class=\"ats-ob-loading\">Loading the offer…</span>'");
  });

  it('refreshes the card through the shared refreshAfterAppAction convention', () => {
    expect(candidatesJs).toContain('window.atsRefreshAfterAppAction = refreshAfterAppAction;');
    expect(offerJs).toContain("typeof window.atsRefreshAfterAppAction === 'function'");
    expect(offerJs).toContain('window.atsRefreshAfterAppAction(ctx.caseId ? { case_id: ctx.caseId } : null)');
  });
});

describe('offer band — data + actions map to the right endpoints', () => {
  it('reads the one aggregate endpoint', () => {
    expect(offerJs).toContain("ATS.api('/api/ats/application/offer-state?applicationId=' + encodeURIComponent(applicationId))");
  });

  it('release-to-GP and return-to-practice post to /api/ceo/contract/decision', () => {
    expect(offerJs).toMatch(/submit_to_gp:\s*\{\s*\n\s*path: '\/api\/ceo\/contract\/decision'/);
    expect(offerJs).toMatch(/return_to_practice:\s*\{\s*\n\s*path: '\/api\/ceo\/contract\/decision'/);
    expect(offerJs).toContain('body: { contractId: contractId, action: action, note: noteFor(ctx.containerEl, contractId) }');
  });

  it('the change-request triage posts to /api/ceo/contract/change-decision', () => {
    expect(offerJs).toMatch(/release_to_practice:\s*\{\s*\n\s*path: '\/api\/ceo\/contract\/change-decision'/);
    expect(offerJs).toMatch(/decline_change:\s*\{\s*\n\s*path: '\/api\/ceo\/contract\/change-decision'/);
  });

  it('release-to-GP is offered only on an uploaded contract (the server requires it)', () => {
    expect(offerJs).toContain("if (c.status === 'uploaded') {");
    expect(offerJs).toContain('data-ob-action="submit_to_gp"');
    // …and the change triage only on a changes_requested one.
    expect(offerJs).toContain("if (c.status === 'changes_requested') {");
  });

  it('the AI re-run posts to /api/ceo/contract/ai-check with the contract id', () => {
    expect(offerJs).toContain("ATS.api('/api/ceo/contract/ai-check', { method: 'POST', body: { contractId: contractId } })");
  });

  it('the nudge posts to /api/ats/contract/nudge with the application id', () => {
    expect(offerJs).toContain("ATS.api('/api/ats/contract/nudge', { method: 'POST', body: { applicationId: String(applicationId) } })");
  });

  it('handles the nudge endpoint\'s two designed refusals in plain English', () => {
    expect(offerJs).toContain("res.code === 'too_soon'");
    expect(offerJs).toContain('res.retryAfterMinutes');
    expect(offerJs).toContain("res.code === 'nothing_to_nudge'");
    expect(offerJs).toContain('There is nobody to chase on this application right now.');
  });

  it('never offers a chase the server would answer with nothing_to_nudge', () => {
    // Mirrors the endpoint's own "who has the ball" branch.
    const fn = offerJs.slice(offerJs.indexOf('function nudgeTarget'), offerJs.indexOf('function line('));
    expect(fn).toContain("if (c.status === 'awaiting_upload') return 'practice';");
    expect(fn).toContain("if (c.status === 'sent_to_gp' || c.status === 'changes_requested') return 'gp';");
    expect(fn).toContain("if (c.status === 'practice_review') return 'practice';");
    expect(fn).toContain("return '';");
  });

  it('hides the CEO-only contract actions from consultants, and explains a refusal', () => {
    expect(offerJs).toContain('function isConsultant() { return !!(ATS.isConsultant && ATS.isConsultant()); }');
    expect(offerJs).toContain('if (!consultant) {');
    expect(offerJs).toContain('var rerun = isConsultant()');
    expect(offerJs).toContain('Your role can’t do this');
    expect(offerJs).toContain('function isPermissionError(res)');
    expect(offerJs).toContain('res.status === 401 || res.status === 403');
    // …and a consultant is told why the buttons aren't there, rather than
    // being left with a contract that looks like a dead end.
    expect(offerJs).toContain('is a CEO action.');
    expect(offerJs).toContain('var roleNote = (consultant &&');
  });

  it('escapes every server-controlled string it prints', () => {
    // Reasons, notes, AI text and practice names all come from the DB.
    expect(offerJs).toContain('ATS.esc(reason)');
    expect(offerJs).toContain('ATS.esc(c.changeRequest)');
    expect(offerJs).toContain('ATS.esc(ai.summary || terms)');
    expect(offerJs).toContain('ATS.esc(x.contract_says');
    expect(offerJs).toContain("ATS.escAttr(String(c.fileUrl))");
    expect(offerJs).not.toMatch(/\+\s*(p|c|x|h)\.[A-Za-z_]+\s*\+/); // no raw interpolation of payload fields
  });
});

describe('offer band — what it says', () => {
  it('elapsed days come from ONE formatter', () => {
    expect(offerJs).toContain('function elapsedDays(days, iso)');
    expect(offerJs).toContain('function elapsedLabel(days, iso)');
    expect(offerJs).toContain("return n === 1 ? '1 day' : n + ' days';");
    expect(offerJs).toContain("if (n <= 0) return 'today';");
    // Exactly one millisecond-per-day division in the whole module — the
    // brief's "do NOT scatter Math.floor(ms/86400000) around".
    expect(offerJs.match(/86400000/g)).toHaveLength(1);
    // Every day-count render goes through it.
    expect(offerJs).toContain('function agoHtml(prefix, days, iso)');
    expect(offerJs).toContain('elapsedLabel(days, iso)');
  });

  it('shows the elapsed time prominently, not as body copy', () => {
    expect(offerJs).toContain('<b class="ats-ob-days">');
    expect(css).toContain('.ats-ob-days');
    expect(css).toMatch(/\.ats-ob-days\s*\{[^}]*font-weight:800/);
  });

  it('escalates past 7 days on the practice and 5 on the doctor', () => {
    expect(offerJs).toContain('var PRACTICE_CHASE_DAYS = 7;');
    expect(offerJs).toContain('var GP_CHASE_DAYS = 5;');
    // Same phrasing the waiting-on-practice tracker already uses.
    expect(offerJs).toContain("⚠ no reply after ' + days + ' days — chase personally");
    expect(candidatesJs).toContain('⚠ no reply after 7 days — chase personally');
    expect(offerJs).toContain('days >= PRACTICE_CHASE_DAYS');
    expect(offerJs).toContain('gpDays >= GP_CHASE_DAYS');
    // …and the band itself goes amber, not just the text.
    expect(offerJs).toContain("if (waitingPractice || waitingGp || (c && c.status === 'uploaded')) tone = 'amber';");
    expect(css).toContain('.ats-offer-band.tone-amber');
  });

  it('answers "how long since the GP received the contract"', () => {
    expect(offerJs).toContain("agoHtml('The doctor received it', c.daysSinceSentToGp, c.sentToGpAt)");
  });

  it('a declined practice reads as out of the pipeline, with no release action', () => {
    const fn = offerJs.slice(offerJs.indexOf('function practiceLineHtml'), offerJs.indexOf('function contractLineHtml'));
    expect(fn).toContain("if (p.decision === 'declined')");
    expect(fn).toContain('decided not to proceed after the interview');
    expect(fn).toContain('This doctor has left the offer pipeline for this application.');
    expect(fn).toContain('ats-pill red');
    // No action markup at all in the declined branch.
    expect(fn).not.toContain('data-ob-action');
    // …and the contract row bails out entirely when there is no contract.
    expect(offerJs).toContain("if (p.decision === 'declined') return '';");
    // A closed-but-not-declined application (withdrawn / already placed) says so too.
    expect(offerJs).toContain('Out of the offer pipeline');
    expect(offerJs).toContain('if (d.outOfPipeline');
  });

  it('an errored or never-run AI review says so and offers the re-run', () => {
    const fn = offerJs.slice(offerJs.indexOf('function aiLineHtml'), offerJs.indexOf('function historyHtml'));
    expect(fn).toContain("if (st === 'error')");
    expect(fn).toContain('AI check failed');
    expect(fn).toContain('Nothing was compared against the agreed terms');
    expect(fn).toContain("if (st === 'not_run')");
    expect(fn).toContain('AI check not run');
    // Both branches carry the retry button — this is the gap the band closes.
    const errIdx = fn.indexOf("if (st === 'error')");
    const notRunIdx = fn.indexOf("if (st === 'not_run')");
    expect(fn.slice(errIdx, notRunIdx)).toContain('rerun');
    expect(fn.slice(notRunIdx)).toContain('rerun');
    expect(fn).toContain("btn('ats-ob-act', 'ai_check'");
  });

  it('colours the AI verdict and lists each discrepancy as field · severity', () => {
    expect(offerJs).toMatch(/aligned:\s*\{ label: 'Aligned', mod: 'green' \}/);
    expect(offerJs).toMatch(/minor_gaps:\s*\{ label: 'Minor gaps', mod: 'amber' \}/);
    expect(offerJs).toMatch(/major_discrepancies:\s*\{ label: 'Major discrepancies', mod: 'red' \}/);
    expect(offerJs).toMatch(/unreadable:\s*\{ label: 'Unreadable', mod: 'muted' \}/);
    expect(offerJs).toContain("ATS.esc(x.field || 'Unspecified') + ' · ' + ATS.esc(x.severity || 'unrated')");
    expect(offerJs).toContain("contract says ' + ATS.esc(x.contract_says || '—')");
    expect(offerJs).toContain("' / expected ' + ATS.esc(x.expected || '—')");
  });

  it('lists every superseded version, and omits the line when there is only the live one', () => {
    const fn = offerJs.slice(offerJs.indexOf('function historyHtml'), offerJs.indexOf('function nudgeLineHtml'));
    expect(fn).toContain('var earlier = all.filter(function (h) { return !h.isLive; });');
    expect(fn).toContain("if (!earlier.length) return '';");
    expect(fn).toContain('<details class="ats-ob-versions">');
    expect(fn).toContain("'<summary>Earlier versions (' + earlier.length + ')</summary>'");
    expect(fn).toContain("v' + ATS.esc(String(h.version || 0))");
    expect(fn).toContain('h.statusLabel');
  });

  it('shows a quiet loading line and a real Retry on failure', () => {
    expect(offerJs).toContain('ats-ob-loading');
    expect(offerJs).toContain('<span class="ats-ob-err">');
    expect(offerJs).toContain("btn('ats-ob-retry', 'retry', '', 'Retry')");
    expect(offerJs).toContain("if (action === 'retry') { window.atsRenderOfferBand(applicationId, containerEl, caseId); return; }");
  });

  it('wires its delegated handler once, so a re-render cannot double-fire', () => {
    // Exactly the trap the slot picker hit (containerEl.__atsSlotClickWired).
    expect(offerJs).toContain('containerEl.__atsOfferWired');
  });

  it('speaks the .cr-strip band\'s visual language', () => {
    expect(offerJs).toContain('ats-btn ats-btn-ghost ats-btn-sm');
    expect(offerJs).toContain('ats-danger-ghost');
    expect(css).toContain('.ats-offer-band');
    expect(css).toContain('.ats-ob-line');
    expect(css).toContain('.ats-ob-btns');
    expect(css).toContain('.ats-ob-versions');
    expect(css).toContain('.ats-ob-disc');
    expect(css).toContain('.cr-strip'); // the reference band it sits beside
  });
});

describe('offer band — cache keys actually deliver it', () => {
  it('ceo-dashboard.html loads the new module next to the other ceo-ats scripts', () => {
    expect(dashHtml).toContain('<script src="/js/ceo-ats-offer.js?v=20260731d"></script>');
    const offerIdx = dashHtml.indexOf('/js/ceo-ats-offer.js');
    const sharedIdx = dashHtml.indexOf('/js/ceo-ats-shared.js');
    expect(sharedIdx).toBeGreaterThan(-1);
    expect(offerIdx).toBeGreaterThan(sharedIdx); // window.ATS must exist first
  });

  it('the changed candidates script and stylesheet are bumped', () => {
    expect(dashHtml).toContain('/js/ceo-ats-candidates.js?v=20260731d');
    expect(dashHtml).not.toContain('/js/ceo-ats-candidates.js?v=20260731b');
    expect(dashHtml).toContain('/css/ceo-ats.css?v=20260731d');
    expect(dashHtml).not.toContain('/css/ceo-ats.css?v=20260731c');
  });

  it('the CSS key stays >= the candidates JS key (sw.js treats versioned CSS as immutable)', () => {
    const cssV = dashHtml.match(/ceo-ats\.css\?v=(\d{8})/);
    const jsV = dashHtml.match(/ceo-ats-candidates\.js\?v=(\d{8})/);
    const offerV = dashHtml.match(/ceo-ats-offer\.js\?v=(\d{8})/);
    expect(cssV).toBeTruthy();
    expect(jsV).toBeTruthy();
    expect(offerV).toBeTruthy();
    expect(Number(cssV[1])).toBeGreaterThanOrEqual(Number(jsV[1]));
    expect(Number(cssV[1])).toBeGreaterThanOrEqual(Number(offerV[1]));
  });
});
