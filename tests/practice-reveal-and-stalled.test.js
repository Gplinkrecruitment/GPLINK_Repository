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
    expect(card).toContain('PRACTICE NAMED');
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
    expect(sweep).toContain('stalledApplications.nextSentinel(items, sentinel, nowIso)');
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
    expect(read('pages/ceo-dashboard.html')).toContain('/js/ceo-ats-candidates.js?v=20260904a');
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
    expect(fn).toContain('const offers = applications.filter(isCareerOpportunity);');
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
