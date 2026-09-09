// Owner decisions 2026-09-04: (1) practice NAME + WEBSITE are shown to signed-in
// doctors who have passed the CV gate, before applying — never on the public
// board, never the address/contact; (2) introduced applications that go quiet
// are surfaced on the CEO board and emailed once per quiet stretch.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); expect(i, a).toBeGreaterThan(-1); return src.slice(i, j === -1 ? undefined : j); };
const server = read('server.js');

describe('server: named reveal tier', () => {
  it('the CV gate check uses exactly the document set the apply gate and matching board accept', () => {
    const fn = between(server, 'async function gpHasVerifiedCareerCv(userId)', 'function resolveNamedPracticeWebsite');
    expect(fn).toContain('document_key=in.(career_cv,cv_signed_dated)');
    expect(fn).toContain('status=in.(uploaded,approved)');
  });
  it('the roles LIST enriches after the DPA gate on both the Supabase and local branches, skipping blurred stubs', () => {
    const handler = between(server, "pathname === '/api/career/roles' && req.method === 'GET'", "pathname === '/api/career/role' && req.method === 'GET'");
    expect(handler.match(/attachNamedPracticeToClientRoles\(/g).length).toBe(2);
    const attach = between(server, 'async function attachNamedPracticeToClientRoles', 'async function findPracticeFacingCvRow');
    expect(attach).toContain('if (!r || r.blurred || r.qualifies === false) return r;');
    expect(attach).toContain('nameRevealed: true');
    expect(attach).not.toContain('practiceAddress'); // name + website only
  });
  it('the job page sets nameRevealed only for a doctor with a CV and never flips `revealed`', () => {
    const block = between(server, 'const revealed = roleRevealCtx.revealed;', 'if (revealed) {');
    expect(block).toContain('!revealed && roleDetailUserId && await gpHasVerifiedCareerCv(roleDetailUserId)');
    expect(block).toContain('roleClientPayload.nameRevealed = true;');
    expect(block).not.toContain('roleClientPayload.revealed = true');
    expect(block).not.toContain('practiceAddress');
  });
  it('application rows name the practice on the named tier without claiming the identity reveal', () => {
    const block = between(server, '} else if (appsNamedTier && roleRow) {', 'let placement = null;');
    expect(block).toContain('roleClient.nameRevealed = true;');
    expect(block).not.toContain('roleClient.revealed = true');
  });
  it('the PUBLIC jobs payload never touches the named tier', () => {
    const pubStart = server.indexOf("pathname === '/api/public/jobs' && req.method === 'GET'");
    expect(pubStart).toBeGreaterThan(-1);
    const pubEnd = server.indexOf("if (pathname === '/api/", pubStart + 60); // the next route = end of this handler
    const pub = server.slice(pubStart, pubEnd === -1 ? pubStart + 20000 : pubEnd);
    expect(pub).not.toContain('attachNamedPracticeToClientRoles');
    expect(pub).not.toContain('nameRevealed');
    expect(pub).not.toContain('gpHasVerifiedCareerCv');
    const base = between(server, 'function mapCareerRoleRowToClient(row) {', 'function mapCareerRoleDetailToClient(row) {');
    expect(base).not.toContain('nameRevealed');
    expect(base).not.toContain('realPracticeName');
  });
  it('the clinic website wins over the corporate owner site', () => {
    const fn = between(server, 'function resolveNamedPracticeWebsite(roleRow, practiceRow)', 'async function attachNamedPracticeToClientRoles');
    expect(fn.indexOf('resolveCareerRoleWebsiteUrl(roleRow)')).toBeLessThan(fn.indexOf('practiceRow.website'));
  });
});

describe('doctor pages: named tier rendering', () => {
  it('job.html names the practice + website on the named tier but keys the address/map/pill on the identity reveal', () => {
    const html = read('pages/job.html');
    const mast = between(html, 'function renderMast(role) {', 'function renderHeroImage(role) {');
    expect(mast).toContain('const revealed = !!(role && role.revealed && role.realPracticeName);'); // pinned by job-page-redesign.test.js
    expect(mast).toContain('const named = revealed || !!(role && role.nameRevealed && role.realPracticeName);');
    expect(mast).toContain('const headline = named ? role.realPracticeName');
    expect(mast).toContain('const website = named ? matchSafeUrl(role.website) : "";');
    expect(mast).toMatch(/const locText = revealed\n?\s*\?/);
    expect(mast).toContain('(revealed ? "Identity unlocked" : "Eligible for you")');
    const hero = between(html, 'function renderHeroImage(role) {', 'dphotoEl.innerHTML');
    expect(hero).toContain('exact address shared once the practice accepts you');
    // The collapsible identity box must not contradict the named masthead:
    // three states — unlocked (identity), named (address still to come), masked.
    const box = between(html, 'function buildPracticeIdentityHtml(role) {', '/* ── Detail body ── */');
    expect(box).toContain('const named = !!(role && role.nameRevealed && role.realPracticeName);');
    expect(box).toContain('ADDRESS &amp; CONTACT &middot; SHARED ON ACCEPTANCE');
    expect(box).toContain('REVEALED ON ACCEPTANCE'); // masked state stays for doctors without a CV
    expect(box.indexOf('if (revealed) {')).toBeLessThan(box.indexOf('if (named) {'));
  });
  it('career.html cards show the name + website, keep the masked headline for suburb/search, and the link does not open the role', () => {
    const html = read('pages/career.html');
    const card = between(html, 'function buildRoleCardHtml(role) {', 'function isSaved(roleId) {');
    expect(card).toContain('const named = !!(role.nameRevealed && role.realPracticeName);');
    expect(card).toContain('class="at-rweb"');
    expect(card).not.toContain('PRACTICE NAMED'); // names are never hidden (owner 2026-09-07) — no chip beside a shown name
    expect(card).toContain('NAME ON ACCEPTANCE'); // masked fallback still renders
    expect(html).toContain('event.target.closest("a.at-rweb")) return;');
    expect(html).toContain('role.practiceName, role.realPracticeName, role.displayLabel');
    // suburb label still derives from the MASKED headline, untouched
    expect(html).toContain('const masked = String((role && role.practiceName) || "");');
    const safe = between(html, 'function cardSafeUrl(value) {', 'function buildBlurredRoleCardHtml');
    expect(safe).toMatch(/https\?:/);
  });
});

describe('server: gone-quiet applications', () => {
  it('lib is wired, threshold is env-tunable with a floor', () => {
    expect(server).toContain("const stalledApplications = require('./lib/stalled-applications.js');");
    expect(server).toMatch(/const STALLED_APPLICATION_DAYS = Math\.max\(7, Number\(process\.env\.STALLED_APPLICATION_DAYS\) \|\| stalledApplications\.DEFAULT_THRESHOLD_DAYS\);/);
  });
  it('attention tile count + tracker endpoint + daily cron (secret-gated) exist', () => {
    const attn = between(server, "pathname === '/api/ats/attention' && req.method === 'GET'", "pathname === '/api/ats/stalled-applications'");
    expect(attn).toContain('stalled_applications: atStalled');
    expect(attn).toContain('stalled_threshold_days: STALLED_APPLICATION_DAYS');
    expect(server).toContain("pathname === '/api/ats/stalled-applications' && req.method === 'GET'");
    const cron = between(server, "pathname === '/api/cron/stalled-applications'", "pathname === '/api/cron/sla-sweep'");
    expect(cron).toContain('isValidCronSecret(getBearerToken(req))');
    expect(cron).toContain('runStalledApplicationSweep()');
    expect(server).toContain("'stalled-applications': { schedule: '20 21 * * *', cadenceMinutes: 1440 }");
    const vercel = JSON.parse(read('vercel.json'));
    expect(vercel.crons.some((c) => c.path === '/api/cron/stalled-applications' && c.schedule === '20 21 * * *')).toBe(true);
  });
  it('the sweep emails the owner once per quiet stretch, notes the case timeline, and stores the sentinel in runtime_kv', () => {
    const sweep = between(server, 'async function runStalledApplicationSweep() {', 'async function _applyGpRoleVisibilityGate');
    expect(sweep).toContain('stalledApplications.selectFreshStalls(items, sentinel)');
    expect(sweep).toContain('to: GP_OWNER_EMAIL');
    expect(sweep).toContain("'stalled_application_alert'");
    expect(sweep).toContain("key: 'stalled_application_alerts'");
    expect(sweep).toContain("stalledApplications.nextSentinel(emailed ? items : items.filter(function (it) { return !fresh.some(function (f) { return f.id === it.id; }); }), sentinel, nowIso)");
    const email = between(server, 'function buildStalledApplicationsEmailHtml(items, thresholdDays)', 'async function runStalledApplicationSweep');
    expect(email).toContain('This is a prompt to look, not a finding.');
  });
});

describe('CEO board: gone-quiet tile and tracker', () => {
  const js = read('js/ceo-ats-candidates.js');
  it('adds the tile, the state flag, the dispatcher branch and the tracker fetch', () => {
    expect(js).toContain("{ key: 'stalled', label: 'Gone quiet'");
    expect(js).toContain('stalled: false };');
    expect(js).toContain("} else if (bucket === 'stalled') {");
    expect(js).toContain('if (state.stalled) fetchAndRenderStalled();');
    expect(js).toContain("ATS.swr('/api/ats/stalled-applications'");
    expect(js).toContain("Showing: <b>Gone quiet</b>");
  });
  it('every reset of the waiting tracker also resets the gone-quiet tracker', () => {
    const resets = js.match(/state\.waiting = false;/g).length;
    expect(js.match(/state\.waiting = false; state\.stalled = (false|true);/g).length).toBe(resets);
  });
  it('the dashboard ships the bumped buster', () => {
    expect(read('pages/ceo-dashboard.html')).toContain('/js/ceo-ats-candidates.js?v=20260910a');
  });
});

describe('careers tabs + apply cache (owner 2026-09-04)', () => {
  const career = read('pages/career.html');
  const job = read('pages/job.html');
  it('tab bar order is Roles, Applications, Offers, Saved', () => {
    const tabs = between(career, '<nav class="at-tabs" id="careerTabs"', '</nav>');
    const order = [...tabs.matchAll(/data-career-tab="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['browse', 'applications', 'offers', 'saved']);
    expect(tabs).toContain('>Applications<span class="at-badge" id="appsTabBadge"');
    expect(tabs).toContain('>Offers<span class="at-badge" id="offersTabBadge"');
  });
  it('offers is a real view: panel, allowed view lists, hash deep link, default landing', () => {
    expect(career).toContain('data-view-panel="offers"');
    expect(career.match(/\["browse", "applications", "offers", "saved", "secured"\]\.includes\(view\)/g).length).toBe(2);
    expect(career).toContain('["browse", "applications", "offers", "saved"].includes(hashView)');
    expect(career).toContain('careerState.activeView = defaultApplicationsView();');
    expect(career).not.toContain('careerState.activeView = careerState.applications.length ? "applications" : "browse";');
  });
  it('the list is split by the same rule the Offers badge counts', () => {
    const fn = between(career, 'function renderApplications() {', 'function defaultApplicationsView()');
    expect(fn).toContain('const offers = listed.filter(isCareerOpportunity);'); // pending matches filtered out first (2026-09-07)
    expect(fn).toContain('offersGridEl.innerHTML = offers.map(');
    expect(fn).toContain('applicationsGridEl.innerHTML = others.map(');
    expect(fn).not.toContain('at-grouplbl');
  });
  it('a successful apply clears every cache that could replay the pre-apply state on reload', () => {
    const fn = between(job, 'function invalidateApplicationCaches(roleId) {', 'function markAppliedLocally');
    expect(fn).toContain('localStorage.removeItem(ROLE_DETAIL_CACHE_PREFIX + roleId)');
    expect(fn).toContain('w.gpCache.invalidate("/api/career/applications")');
    expect(fn).toContain('sessionStorage.setItem("gp_career_apps_dirty", "1")');
    const mark = between(job, 'function markAppliedLocally(wasMatchAccept) {', 'function handleApplyOutcome');
    expect(mark).toContain('invalidateApplicationCaches(currentRole.id);');
    const cache = between(job, 'function readCachedRoleDetail(roleId) {', 'function writeCachedRoleDetail');
    expect(cache).toContain('isApplied(roleId)) return null;');
  });
});

describe('match notification + matched-role presentation (owner 2026-09-04)', () => {
  const srv = read('server.js');
  const board = read('js/ceo-ats-matching.js');
  const job = read('pages/job.html');
  it('shortlist results carry the notification outcome, and a resend endpoint exists for live matches', () => {
    expect(srv).toContain('function matchNotifySummary(ann)');
    expect(srv.match(/notified: matchNotifySummary\(/g).length).toBe(2); // insert + reopen branches
    const resend = between(srv, "pathname === '/api/ats/matching/resend' && req.method === 'POST'", "pathname === '/api/ats/matching/shortlist'");
    expect(resend).toContain("mrRow.ats_stage !== 'shortlisted'");
    expect(resend).toContain('announceShortlistToGp(mrRow)');
    expect(resend).toContain('notified: mrSummary');
  });
  it('the CEO is told when the match email did not go out, and can re-send from the row', () => {
    expect(board).toContain('email_not_configured');
    expect(board).toContain('match email NOT sent');
    expect(board).toContain("A.api('/api/ats/matching/resend'");
    expect(board).toContain('data-mb-resend="');
    expect(board).toContain("closest('[data-mb-resend]')");
  });
  it('a pending match is never painted as an application; the bar and banner say it was matched by the team', () => {
    expect(job).toContain('function isPendingMatchRow(app)');
    const applied = between(job, 'function isApplied(roleId) {', 'function getPendingLocalMatch');
    expect(applied).toContain('!isPendingMatchRow(app)');
    expect(job).toContain('? "match_pending" : "idle"');
    expect(job).toContain('match_pending: { cls: "at-bapply", html: "✦ Matched to you by the GP Link team');
    expect(job).toContain('getPendingLocalMatch(role.id)) ? buildMatchPendingHtml() : ""');
    const cache = between(job, 'function readCachedRoleDetail(roleId) {', 'function writeCachedRoleDetail');
    expect(cache).toContain('getPendingLocalMatch(roleId)) return null;');
    const banner = between(job, 'function buildMatchBannerHtml(role) {', 'function buildMatchPendingHtml()');
    expect(banner).toContain('Matched to you by the GP Link team.');
    expect(banner).toContain('strong chance of securing this position');
  });
  it('the popup and the careers card carry the same message', () => {
    expect(read('js/match-popup.js')).toContain('The GP Link team picked <b>');
    expect(read('pages/career.html')).toContain('The GP Link team matched you to this practice directly');
  });
});

describe('identity-step-optional tester flag (owner 2026-09-06)', () => {
  const cfg = read('js/bypass-config.js');
  const onb = read('js/onboarding.js');
  it('is a digest with an expiry, separate from the blanket bypass list (which stays empty)', () => {
    expect(cfg).toContain('"f4c9faeba3c465a82adb51cebe3d80b8e94e86470b0aaa50d752b8c2a8ba8c6e": "2026-09-30T23:59:59Z"');
    expect(cfg).toContain('var TEMPORARY_BYPASS_LOCK_DIGESTS = {};');
    expect(cfg).not.toContain('smithmiller1234');
    const srv = read('server.js');
    const tempBlock = srv.slice(srv.indexOf('const TEMPORARY_BYPASS_LOCK_EMAILS'), srv.indexOf('function isBypassLockEmail'));
    expect(tempBlock).not.toContain('@gmail.com\':'); // server blanket bypass map stays empty
    expect(cfg).toContain('window.gpIdentityStepOptional = identityStepOptional');
  });
  it('only the identity step consults it; every other step keeps its checks', () => {
    const step4 = between(onb, 'case 4: // identity check', 'default: return true;');
    expect(step4).toContain('identityStepOptionalForTester()');
    const step2 = between(onb, 'case 2: // country + register number', 'case 3: return true;');
    expect(step2).not.toContain('identityStepOptionalForTester');
    const bypass = between(onb, 'function canBypassOnboardingValidation() {', 'function validateStep');
    expect(bypass).not.toContain('gpIdentityStepOptional');
  });
  it('on a loopback dev host the identity STEP is optional for any account (client-only; the server bypass stays narrow/smith-only)', () => {
    const forTester = between(onb, 'function identityStepOptionalForTester() {', 'function canBypassOnboardingValidation()');
    expect(forTester).toContain('localhost');
    expect(forTester).toContain('127.0.0.1');
    // The server-side ID scan bypass must NOT be widened to a dev host —
    // tests/register-auto-verify.test.js pins that a real doctor still hits
    // the pipeline. It stays keyed on the email allow-list only.
    const srv = read('server.js');
    const verify = between(srv, "pathname === '/api/ai/verify-identity' && req.method === 'POST'", "if (!ANTHROPIC_API_KEY)");
    expect(verify).not.toContain('isLoopbackHostname');
  });
});

describe('job page CTA says "apply for interview" (owner 2026-09-07)', () => {
  const job = read('pages/job.html');
  it('idle bar, confirm sheet, sent state and received banner all speak of an interview request, not a job application', () => {
    expect(job).toContain('html: "Apply for interview<small>Not a job application');
    expect(job).toContain('<h2 id="applyConfirmTitle">Apply for an interview?</h2>');
    expect(job).toContain('id="applyConfirmBtn" type="button">Apply for interview</button>');
    expect(job).toContain('applied: "✓ Interview request sent<small>');
    expect(job).toContain('<b>Interview request received</b>');
    expect(job).not.toContain('Apply for this role<small>');
    expect(job).not.toContain('<b>Application received</b>');
  });
});

describe('matches are matches — not applications, not offers (owner 2026-09-07)', () => {
  const career = read('pages/career.html');
  const srv = read('server.js');
  it('the careers page keeps pending matches out of both tabs and both badges', () => {
    expect(career).toContain('function isPendingMatchApplication(application)');
    const opp = between(career, 'function isCareerOpportunity(application) {', 'function nextStepForApplication');
    expect(opp).toContain('if (isPendingMatchApplication(application)) return false;');
    const render = between(career, 'function renderApplications() {', 'function defaultApplicationsView()');
    expect(render).toContain('const listed = applications.filter((application) => !isPendingMatchApplication(application));');
    expect(career).toContain('&& !isPendingMatchApplication(application) && !isCareerOpportunity(application) && isActiveApplication(application)');
    expect(career).toContain('if (key === "matched" || key === "shortlisted") return "Accept or decline your match";');
  });
  it('the application detail endpoint names the practice on the named tier, and every location is suburb-first', () => {
    const detail = between(srv, "pathname === '/api/career/application' && req.method === 'GET'", '// Build placement payload if status warrants it');
    expect(detail).toContain('gpHasVerifiedCareerCv(userId)');
    expect(detail).toContain('roleClient.nameRevealed = true;');
    expect(srv).toContain('buildLocationLabel([row.suburb || row.location_city, row.location_state])');
    expect(srv).toContain("const suburbText = String(suburb || (row && row.suburb) || '').trim();");
    expect(srv).toContain("location_city: intake.suburb || intake.nearest_city || ''");
  });
  it('the applied status reads as an interview request everywhere the server labels it', () => {
    expect(srv).toContain("statusLabel: 'Interview request received — we’re putting you forward'");
    expect(srv).not.toContain("statusLabel: 'Application received — we’re putting you forward'");
  });
});

// Owner 2026-09-07: "we are not hiding practice names anymore so we can use
// the actual practice name" — the application page, the careers rows and the
// local rows written on apply all head themselves with the REAL name whenever
// one is known, never the masked, suburb-derived "DPA - Terrigal - …" headline.
// And a fresh direct application sits at Under Review on the tracker: the
// Registration Support Officer reviews before we submit to the practice.
describe('named headline everywhere + Under Review after applying', () => {
  const detail = read('pages/application-detail.html');
  const career = read('pages/career.html');
  const job = read('pages/job.html');
  const server = read('server.js');

  // Pull the helper trio out of the page and run it for real.
  function loadHelpers() {
    const start = detail.indexOf('var MASKED_HEADLINE_RE');
    const end = detail.indexOf('function labelForStatus');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return new Function(detail.slice(start, end) + '; return { isMaskedHeadline, resolvePracticeHeadline, resolveRoleTitle };')();
  }

  it('application page heads itself with the real name over a stale masked preview', () => {
    const h = loadHelpers();
    expect(h.resolvePracticeHeadline({ practiceName: 'DPA - Terrigal - Mixed Billing' }, { practiceName: 'GP Link Sandbox Practice', nameRevealed: true })).toBe('GP Link Sandbox Practice');
    expect(h.resolvePracticeHeadline({ practiceName: 'Non-DPA - Erina (Central Coast) - Bulk Billing' }, { realPracticeName: 'Erina Family Practice' })).toBe('Erina Family Practice');
    expect(h.resolvePracticeHeadline({ practiceName: 'Sandbox Coastal Medical Centre', revealed: true }, { practiceName: 'DPA - Merewether - Bulk Billing' })).toBe('Sandbox Coastal Medical Centre');
    // fully masked (no CV on file) renders exactly as before
    expect(h.resolvePracticeHeadline({ practiceName: 'DPA - Terrigal - Mixed Billing' }, { practiceName: 'DPA - Terrigal - Mixed Billing' })).toBe('DPA - Terrigal - Mixed Billing');
    expect(h.resolvePracticeHeadline({}, {})).toBe('Medical Centre');
    expect(h.resolvePracticeHeadline({ practiceName: 'Confidential practice' }, {})).toBe('Confidential practice');
    expect(h.isMaskedHeadline('DPA – Terrigal – Mixed Billing')).toBe(true);
    expect(h.isMaskedHeadline('Terrigal Medical Centre')).toBe(false);
  });

  it('role preview never repeats the masked headline as the role title', () => {
    const h = loadHelpers();
    expect(h.resolveRoleTitle({}, { roleType: 'DPA - Terrigal - Mixed Billing' })).toBe('General Practitioner');
    expect(h.resolveRoleTitle({ roleTitle: 'General Practitioner (VR)' }, { roleType: 'DPA - X - Y' })).toBe('General Practitioner (VR)');
    expect(h.resolveRoleTitle({}, {})).toBe('General Practitioner');
  });

  it('wires the helpers into the header, back bar and role preview', () => {
    expect(detail).toContain('var practiceName = resolvePracticeHeadline(app, role);');
    expect(detail).toContain('document.getElementById("backBarTitle").textContent = practiceName;');
    expect(detail).toContain('document.getElementById("roleTitle").textContent = resolveRoleTitle(app, role);');
    expect(detail).not.toContain('app.practiceName || role.practiceName || "Medical Centre"');
  });

  it('timeline: a fresh direct application sits at Under Review with Applied ticked', () => {
    expect(detail).toMatch(/applied: 1, review: 1, fast_tracked: 1,/);
    expect(detail).not.toMatch(/applied: 0/);
    // The renderer ticks every step below the active index — Applied gets its check.
    expect(detail).toContain('i < statusIdx ? "step-completed" : i === statusIdx ? "step-active" : "step-pending"');
  });

  it('careers page carries nameRevealed through the normaliser and the roles-list merge', () => {
    expect(career).toContain('nameRevealed: source.nameRevealed === true,');
    expect(career).toContain('nameRevealed: !!(app.role && app.role.nameRevealed === true),');
    expect(career).toContain('const liveNamedName = (liveRole.nameRevealed && liveRole.realPracticeName) ? String(liveRole.realPracticeName) : "";');
    expect(career).toContain('nameRevealed: job.nameRevealed === true || !!liveNamedName,');
    expect(career).toContain('const revealedName = ((app.revealed === true || app.nameRevealed === true)');
    expect(career).toContain(': namedRoleName;');
    // Names are never hidden on an application card (owner 2026-09-07): no
    // "named" / "identity unlocked" chip beside a shown name; the locked chip
    // survives only for a legacy row with no name.
    expect(career).not.toContain('IDENTITY UNLOCKED</span>');
    expect(career).not.toContain('PRACTICE NAMED</span>');
    expect(career).toContain('const identityChip = revealedName\n        ? ""');
    expect(career).toContain('NAME ON ACCEPTANCE');
  });

  it('local rows created on apply/save are titled with the real name when known', () => {
    const line = 'practiceName: (role.nameRevealed && role.realPracticeName) ? role.realPracticeName : role.practiceName,';
    // the application rows (createDefaultApplication / createApplicationSnapshot)
    expect(career.split(line).length - 1).toBe(1);
    expect(job.split(line).length - 1).toBe(1);
    // the Saved snapshots keep the masked headline and carry the real name beside it
    expect(career).toContain('realPracticeName: role.realPracticeName || "",');
    expect(job).toContain('realPracticeName: role.realPracticeName || "",');
    expect(job).toContain('nameRevealed: !!(role.nameRevealed && role.realPracticeName),');
  });

  it('server: named application rows and the detail carry realPracticeName too', () => {
    expect(server).toContain('roleClient.realPracticeName = namedAppName;');
    expect(server).toContain('roleClient.realPracticeName = detailNamedName;');
  });
});
