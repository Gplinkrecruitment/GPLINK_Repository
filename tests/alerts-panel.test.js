// Task 9 (AI Matching, 2026-07-06 plan) — Team Alerts panel redesign
// (mockup docs/mockups/matching/matching-alerts-redesign-v9.html, spec §11).
//
// This is a rendering-only upgrade to js/updates-sync.js: storage, data flow,
// and public API stay identical. These are source-level (regex/string)
// assertions — the file is browser JS with no DOM available under vitest —
// mirroring the existing pattern used by tests/ai-matching-*.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, 'js/updates-sync.js'), 'utf8');

describe('Team Alerts redesign (Task 9) — js/updates-sync.js', () => {
  it('renders a serif "Team Alerts" title', () => {
    expect(src).toContain('<h4>Team Alerts</h4>');
    expect(src).toMatch(/font-family:\s*"Source Serif 4",\s*Georgia,\s*serif/);
  });

  it('has the four filter chips: All / Actions / Updates / Replies', () => {
    expect(src).toMatch(/data-filter="all">All<\/button>/);
    expect(src).toMatch(/data-filter="action">Actions<\/button>/);
    expect(src).toMatch(/data-filter="update">Updates<\/button>/);
    expect(src).toMatch(/data-filter="support">Replies<\/button>/);
  });

  it('groups items into NEW / EARLIER sections, hiding an empty group', () => {
    expect(src).toMatch(/renderGroup\(\s*["']New["']/);
    expect(src).toMatch(/renderGroup\(\s*["']Earlier["']/);
    expect(src).toMatch(/if \(!groupItems\.length\) return;/);
  });

  it('keeps the existing "No Updates Yet" empty state', () => {
    expect(src).toContain('No Updates Yet');
  });

  it('defines a timeAgo helper covering the required relative-time bands', () => {
    expect(src).toMatch(/function timeAgo\(ts\)/);
    expect(src).toContain('"Just now"');
    expect(src).toMatch(/\$\{minutes\}\s*min ago/);
    expect(src).toMatch(/\$\{hours\}\s*hrs ago/);
    expect(src).toMatch(/\$\{days\}\s*days ago/);
  });

  it('has a "Mark all read" action wired through a loop helper using the existing markRead mechanics', () => {
    expect(src).toMatch(/class="mark-all"\s*data-mark-all/);
    expect(src).toMatch(/function markAllAlertsRead\(items\)/);
    expect(src).toMatch(/markAllAlertsRead\(items \|\| \[\]\)\.forEach|\(items \|\| \[\]\)\.forEach\(\(item\) => \{\s*markRead\(item\.id\)/);
    expect(src).toContain('markAllAlertsRead(buildAlertItems())');
  });

  it('escapes interpolated title and detail text with escHtml', () => {
    expect(src).toMatch(/escHtml\(item\.title\)/);
    expect(src).toMatch(/escHtml\(detail\)/);
    expect(src).toMatch(/escHtml\(kindLabel\(item\.kind\)\)/);
  });

  it('renders a per-kind icon square (amber action / blue update / green support)', () => {
    expect(src).toMatch(/k-action[\s\S]{0,400}#d97706/);
    expect(src).toMatch(/k-update[\s\S]{0,400}#2563eb/);
    expect(src).toMatch(/k-support[\s\S]{0,400}#16a34a/);
  });

  it('shows an inline "View" action link only when the item has a target', () => {
    expect(src).toMatch(/showGo\s*=\s*typeof item\.target === "string" && item\.target\.indexOf\("\/pages\/"\) === 0/);
    expect(src).toMatch(/showGo \? `<span class="go">View<\/span>` : ""/);
  });

  it('gives unread items a blue wash and read items reduced opacity', () => {
    expect(src).toMatch(/\.aitem\.unread\s*\{\s*background:\s*#f8fbff;\s*border-color:\s*#e0ebfd;/);
    expect(src).toMatch(/\.aitem\.read\s*\{\s*opacity:\s*\.78;/);
  });

  it('keeps the panel id, show class, and close/outside-click/escape mechanics', () => {
    expect(src).toContain('const PANEL_ID = "gp-alert-center";');
    expect(src).toContain('.show');
    expect(src).toContain('data-alert-close');
    expect(src).toMatch(/event\.key === "Escape"/);
  });

  it('preserves the See-all footer navigation to /pages/messages', () => {
    expect(src).toContain('See all updates');
    expect(src).toMatch(/href="\/pages\/messages" class="see-all"/);
    expect(src).toMatch(/gpShellNavigate\("\/pages\/messages"\)/);
  });

  it('leaves the localStorage keys unchanged', () => {
    expect(src).toContain('const UPDATES_KEY = "gp_link_updates";');
    expect(src).toContain('const READ_KEY = "gp_link_updates_read";');
  });

  it('leaves buildAlertItems(), saveGpLinkUpdates/getGpLinkUpdates, and mark-read semantics untouched', () => {
    expect(src).toMatch(/return out\.slice\(0, 3\);/);
    expect(src).toMatch(/function markRead\(alertId\) \{/);
    expect(src).toMatch(/function saveGpLinkUpdates\(updates\) \{/);
    expect(src).toMatch(/function getGpLinkUpdates\(\) \{/);
  });

  it('leaves every window.* export assigned', () => {
    [
      'window.getGpLinkUpdates = getGpLinkUpdates;',
      'window.saveGpLinkUpdates = saveGpLinkUpdates;',
      'window.hasGpLinkActionRequired = hasGpLinkActionRequired;',
      'window.refreshInboxBadges = refreshInboxBadges;',
      'window.openGpAlertPanel = openPanel;',
      'window.closeGpAlertPanel = closePanel;',
      'window.gpLinkPullServerNudges = pullServerNudges;',
    ].forEach((line) => expect(src).toContain(line));
  });

  it('keeps the fixed top-center outer panel positioning + mobile media query untouched', () => {
    expect(src).toMatch(/#\$\{PANEL_ID\}\s*\{\s*position:\s*fixed;\s*left:\s*50%;\s*top:\s*14px;/);
    expect(src).toMatch(/@media \(max-width: 767px\) \{\s*#\$\{PANEL_ID\}\s*\{\s*top:\s*8px;/);
  });
});

describe('Team Alerts redesign (Task 9) — cache buster bumped everywhere', () => {
  const pages = [
    'pages/index.html',
    'pages/app-shell.html',
    'pages/area-guide.html',
    'pages/job.html',
    'pages/career.html',
    'pages/pbs.html',
    'pages/commencement.html',
    'pages/registration-intro.html',
    'pages/account.html',
    'pages/myinthealth.html',
    'pages/interview-prep.html',
    'pages/application-detail.html',
    'pages/messages.html',
    'pages/amc.html',
    'pages/my-documents.html',
    'pages/ahpra.html',
    'pages/offer-review.html',
    'pages/visa.html',
  ];

  it.each(pages)('%s references updates-sync.js?v=20260707b', (rel) => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(html).toContain('updates-sync.js?v=20260707b');
    expect(html).not.toContain('updates-sync.js?v=20260707a');
  });

  it('js/native-bridge.js and js/perf-cache.js warm-cache lists are bumped in step', () => {
    const nativeBridge = fs.readFileSync(path.join(ROOT, 'js/native-bridge.js'), 'utf8');
    const perfCache = fs.readFileSync(path.join(ROOT, 'js/perf-cache.js'), 'utf8');
    expect(nativeBridge).toContain('/js/updates-sync.js?v=20260516b');
    expect(perfCache).toContain('/js/updates-sync.js?v=20260516b');
    expect(nativeBridge).not.toContain('/js/updates-sync.js?v=20260516a');
    expect(perfCache).not.toContain('/js/updates-sync.js?v=20260516a');
  });
});
