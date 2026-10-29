// CEO dashboard — "extremely slow loading times when I click through [tabs]
// and sometimes the entire page refreshing when I click action buttons and
// taking me out of the page I was on" (owner, 2026-10-29).
//
// Five causes, five pins:
//  1. setActiveTab re-ran a tab's loader on EVERY activation, including a
//     re-click of the tab already on screen (placeholder, refetch, scroll to
//     top, open drill-in gone). A re-click now does nothing; a revisit within
//     5 minutes passes { quiet: true } so the loader revalidates in place.
//  2. The "new version — Reload now" bar was FIXED full-width over the header
//     and master tabs at z-index 2147483000. A click aimed at a tab hit it
//     instead and reloaded the page. It is now a compact bottom-right notice
//     with Reload / Later, and only the Reload button reloads.
//  3. Every non-GET purged the WHOLE SWR cache, so one save made every tab a
//     cold AU→US round trip. Mutations now drop only the family they touched
//     (+ dashboard, review-queue) via __gpSwr.invalidate(path).
//  4. The Overview's 30s / 5min timers and visibilitychange refresh ran while
//     the Overview was hidden (6 requests a cycle for nothing on screen).
//     They are gated on window.ATS.activeTab === 'registration'.
//  5. "Export CSV" was a bare <a href="/api/admin/export…">: a JSON answer
//     (401/400/500) navigated the dashboard to it. Exports now go through
//     ATS.downloadCsv (fetch + content-type check + Blob download, toast on
//     failure).
//
// No jsdom in this project: the real function bodies are extracted and
// executed against small stubs, as tests/ceo-social-approve-toast-storm.test.js
// does. Anything that cannot be executed that way is pinned on source.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = read('pages/ceo-dashboard.html');
const shared = read('js/ceo-ats-shared.js');
const reviewQueue = read('js/ceo-review-queue.js');
const candidates = read('js/ceo-ats-candidates.js');
const matching = read('js/ceo-ats-matching.js');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
function compile(sources, exportName, stubs) {
  const names = Object.keys(stubs);
  const body = sources.join('\n\n') + '\nreturn ' + exportName + ';';
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => stubs[n]));
}
function spy() {
  const fn = function () { fn.calls.push(Array.from(arguments)); return fn.ret; };
  fn.calls = [];
  return fn;
}

// Runs js/ceo-ats-shared.js in a sandbox. initSwitcher() bails at once
// (getElementById('masterTabs') -> null), so nothing fetches at load.
function loadShared(extra) {
  const sandbox = Object.assign({
    window: { scrollTo: spy() },
    document: { readyState: 'complete', getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
    console, setTimeout, clearTimeout,
    location: { hash: '' },
    history: { replaceState: spy() },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(shared, sandbox, { filename: 'ceo-ats-shared.js' });
  return sandbox;
}

describe('1. tab switching: no loader on a re-click, quiet re-entry within 5 minutes', () => {
  it('re-clicking the active tab does not call its loader (and showMaster neither rewrites the hash nor scrolls)', () => {
    const sb = loadShared();
    const loadJobs = spy();
    sb.window.loadJobsTab = loadJobs;
    sb.window.ATS.setActiveTab('jobs', false);
    expect(loadJobs.calls).toEqual([[]]);                 // first visit: full load, no args
    sb.window.ATS.setActiveTab('jobs', false);
    sb.window.ATS.showMaster('jobs');
    expect(loadJobs.calls.length).toBe(1);                // re-click: nothing
    expect(sb.history.replaceState.calls.length).toBe(0);
    expect(sb.window.scrollTo.calls.length).toBe(0);
  });

  it('coming back within 5 minutes passes { quiet: true }; a hash navigation (force) reloads in full', () => {
    const sb = loadShared();
    const loadJobs = spy(), loadCands = spy();
    sb.window.loadJobsTab = loadJobs;
    sb.window.loadCandidatesTab = loadCands;
    sb.window.ATS.setActiveTab('jobs', false);
    sb.window.ATS.setActiveTab('candidates', false);
    sb.window.ATS.setActiveTab('jobs', false);
    expect(loadJobs.calls).toEqual([[], [{ quiet: true }]]);
    expect(loadCands.calls).toEqual([[]]);
    // Older than the window -> full reload.
    sb.window.ATS.tabLoadedAt.candidates = Date.now() - 6 * 60 * 1000;
    sb.window.ATS.setActiveTab('candidates', false);
    expect(loadCands.calls).toEqual([[], []]);
    // Browser back from #candidate=<id> to #candidates fires applyHash -> force.
    sb.window.ATS.setActiveTab('candidates', false, true);
    expect(loadCands.calls.length).toBe(3);
    expect(loadCands.calls[2]).toEqual([]);
  });

  it('a drill-in opened via skipLoad counts as loaded, so the next visit stays quiet and keeps it', () => {
    const sb = loadShared();
    const loadCands = spy();
    sb.window.loadCandidatesTab = loadCands;
    sb.window.ATS.setActiveTab('candidates', true); // applyHash('#candidate=…') path
    expect(loadCands.calls.length).toBe(0);
    sb.window.ATS.setActiveTab('jobs', false);
    sb.window.ATS.setActiveTab('candidates', false);
    expect(loadCands.calls).toEqual([[{ quiet: true }]]);
  });

  it("the Social tab (the Ads hub) gets { quiet } on a revisit like every other tab", () => {
    // Its loader keeps the numbers and the drafts editor on screen for a quiet
    // re-entry (js/ceo-social.js loadSocialTab) — a revisit must not wipe it.
    const sb = loadShared();
    const loadSocial = spy();
    sb.window.loadSocialTab = loadSocial;
    sb.window.ATS.setActiveTab('social', false);
    sb.window.ATS.setActiveTab('jobs', false);
    sb.window.ATS.setActiveTab('social', false);
    expect(loadSocial.calls).toEqual([[], [{ quiet: true }]]);
    expect(shared).not.toContain("if (name === 'social') fn();");
    expect(read('js/ceo-social.js')).toMatch(/o\.quiet && state\.data/);
  });

  it('every tab loader honours { quiet } and leaves an open drill-in alone', () => {
    expect(candidates).toContain("if (!document.getElementById('ats-cand-table')) return; // a candidate profile is open");
    expect(read('js/ceo-ats-jobs.js')).toContain("if (!el('atsJobsListView')) return; // a board or review screen is open");
    expect(read('js/ceo-ats-practices.js')).toContain("if (quiet && !panel.querySelector('#atsPracSearch')) return;");
    expect(matching).toContain('if (opts && opts.quiet && state.boardData && panel.children.length) { fetchBoard(); return; }');
    expect(read('js/ceo-ats-meetings.js')).toContain("if (opts && opts.quiet && document.getElementById('mtg-list')) { fetchAndRender(true); return; }");
    expect(read('js/ceo-ats-leads.js')).toContain("if (opts && opts.quiet && document.getElementById('lead-list')) { fetchAndRender(false, true); return; }");
    expect(read('js/ceo-ats-contracts.js')).toContain("if (opts && opts.quiet && document.getElementById('contracts-list')) { fetchAndRender(true); return; }");
    expect(html).toContain("if (quiet && c.querySelector('.rso-detail-head, .ceo-gp-detail')) return;");
    expect(html).toContain('if (opts && opts.quiet && techCache && tc && tc.children.length) return;');
  });
});

describe('2. the "new version" notice no longer sits over the header', () => {
  // Minimal DOM: createElement returns a node; setting innerHTML registers
  // the ids inside it so getElementById can hand the buttons back.
  function fakeDom() {
    const byId = {};
    const removed = [];
    function node(tag) {
      const n = {
        tag, id: '', style: { cssText: '' }, listeners: {}, parentNode: null, _html: '',
        setAttribute() {},
        addEventListener(type, fn) { (n.listeners[type] = n.listeners[type] || []).push(fn); },
        click() { (n.listeners.click || []).forEach((fn) => fn()); }
      };
      Object.defineProperty(n, 'innerHTML', {
        get() { return n._html; },
        set(v) { n._html = v; [...v.matchAll(/id="([^"]+)"/g)].forEach((m) => { byId[m[1]] = node('button'); byId[m[1]].id = m[1]; }); }
      });
      return n;
    }
    const body = { appendChild(n) { n.parentNode = body; byId[n.id] = n; }, removeChild(n) { removed.push(n.id); n.parentNode = null; } };
    return { document: { getElementById: (id) => byId[id] || null, createElement: node, body }, removed };
  }

  it('is a compact bottom-right notice with Reload + Later; Later removes it, only Reload reloads', () => {
    const dom = fakeDom();
    const reload = spy();
    const state = { reloadBarShown: false };
    const showReloadBar = compile([extractFn(reviewQueue, 'showReloadBar')], 'showReloadBar', {
      state, document: dom.document, window: { location: { reload } }
    });
    showReloadBar();
    const bar = dom.document.getElementById('gp-dash-reload-bar');
    expect(bar).toBeTruthy();
    expect(bar.style.cssText).toMatch(/position:fixed/);
    expect(bar.style.cssText).toMatch(/bottom:16px/);
    expect(bar.style.cssText).toMatch(/right:16px/);
    expect(bar.style.cssText).toMatch(/max-width:/);
    expect(bar.style.cssText).not.toMatch(/top:0/);
    expect(bar.style.cssText).not.toMatch(/left:0/);
    expect(bar.style.cssText).not.toMatch(/2147483000/);
    expect(reload.calls.length).toBe(0);                 // never auto-reloads
    dom.document.getElementById('gp-dash-reload-later').click();
    expect(dom.removed).toEqual(['gp-dash-reload-bar']);
    expect(reload.calls.length).toBe(0);
    expect(state.reloadBarShown).toBe(true);             // "Later" = not again this session
    dom.document.getElementById('gp-dash-reload-btn').click();
    expect(reload.calls.length).toBe(1);
  });

  it('checkVersion still polls /api/health and only ever shows the notice (source)', () => {
    expect(reviewQueue).toContain("fetch('/api/health'");
    expect(reviewQueue).toContain('if (commit !== state.commit) showReloadBar();');
    expect((reviewQueue.match(/window\.location\.reload\(\)/g) || []).length).toBe(1);
  });
});

describe('3. SWR: targeted invalidation instead of a namespace purge', () => {
  function fakeStorage(keys) {
    const m = new Map(keys.map((k) => [k, '{}']));
    return {
      get length() { return m.size; },
      key: (i) => Array.from(m.keys())[i],
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
      keys: () => Array.from(m.keys())
    };
  }
  const NS = 'gpSwr1:ceo:';
  function invalidator(storage) {
    return compile([extractFn(html, 'gpSwrFamily'), extractFn(html, 'gpSwrInvalidate')], 'gpSwrInvalidate', {
      GP_SWR_NS: NS, sessionStorage: storage
    });
  }
  const seed = [
    NS + '/api/ceo/candidates?q=&stage=', NS + '/api/ceo/candidate?case_id=c1', NS + '/api/ats/jobs',
    NS + '/api/ats/job/pipeline?id=j1', NS + '/api/ats/practices', NS + '/api/ceo/contracts',
    NS + '/api/ceo/meetings?kind=all', NS + '/api/ats/matching/board?direction=gps',
    NS + '/api/ceo/dashboard?period=all', NS + '/api/ceo/review-queue', NS + '/api/ceo/trends',
    'gp_ceo_review_seen_v1'
  ];

  it('a candidate write drops candidate + candidates + dashboard + review-queue and nothing else', () => {
    const st = fakeStorage(seed);
    invalidator(st)('/api/ceo/candidate/notes?case_id=c1');
    expect(st.keys().sort()).toEqual([
      NS + '/api/ats/job/pipeline?id=j1', NS + '/api/ats/jobs', NS + '/api/ats/matching/board?direction=gps',
      NS + '/api/ats/practices', NS + '/api/ceo/contracts', NS + '/api/ceo/meetings?kind=all',
      NS + '/api/ceo/trends', 'gp_ceo_review_seen_v1'
    ].sort());
  });

  it('singular/plural siblings: a PATCH to /api/ats/job?id= drops the /api/ats/jobs list (and the pipeline)', () => {
    const st = fakeStorage(seed);
    invalidator(st)('/api/ats/job?id=j1');
    expect(st.getItem(NS + '/api/ats/jobs')).toBeNull();
    expect(st.getItem(NS + '/api/ats/job/pipeline?id=j1')).toBeNull();
    expect(st.getItem(NS + '/api/ats/practices')).not.toBeNull();
    expect(st.getItem(NS + '/api/ceo/candidates?q=&stage=')).not.toBeNull();
    expect(st.getItem(NS + '/api/ceo/meetings?kind=all')).not.toBeNull();
    const st2 = fakeStorage(seed);
    invalidator(st2)('/api/ats/matching/shortlist');
    expect(st2.getItem(NS + '/api/ats/matching/board?direction=gps')).toBeNull();
    expect(st2.getItem(NS + '/api/ats/jobs')).not.toBeNull();
    const st3 = fakeStorage(seed);
    invalidator(st3)('/api/ceo/contract/finalize');
    expect(st3.getItem(NS + '/api/ceo/contracts')).toBeNull();
    expect(st3.getItem(NS + '/api/ceo/candidates?q=&stage=')).not.toBeNull();
  });

  it('ATS.api calls __gpSwr.invalidate(path) on a mutation and never purge', async () => {
    const purge = spy(), invalidate = spy();
    const sb = loadShared({ window: { scrollTo: spy(), __gpSwr: { purge, invalidate, read: () => null, write() {}, drop() {} } } });
    await sb.window.ATS.api('/api/ats/job?id=j1', { method: 'PATCH', body: { x: 1 } });
    await sb.window.ATS.api('/api/ats/jobs');
    expect(purge.calls.length).toBe(0);
    expect(invalidate.calls).toEqual([['/api/ats/job?id=j1']]);
  });

  it('the inline apiFetch, postJson and the matching module invalidate instead of purging; purge stays for the quota path only', () => {
    const apiFetch = extractFn(html, 'apiFetch');
    expect(apiFetch).toContain("if (o.method && o.method !== 'GET') gpSwrInvalidate(path);");
    expect(apiFetch).not.toContain('gpSwrPurge');
    expect(extractFn(html, 'postJson')).toContain('gpSwrInvalidate(path);');
    expect(html).toContain('window.__gpSwr = { read: gpSwrRead, write: gpSwrWrite, drop: gpSwrDrop, invalidate: gpSwrInvalidate, purge: gpSwrPurge };');
    // The only remaining purge() CALL is the sessionStorage-quota fallback
    // (the declaration and a comment also spell the name, hence the `;`).
    expect((html.match(/gpSwrPurge\(\);/g) || []).length).toBe(1);
    expect(extractFn(html, 'gpSwrWrite')).toContain('gpSwrPurge();');
    expect(matching).not.toContain('__gpSwr.purge(');
    expect(shared).not.toContain('__gpSwr.purge(');
  });
});

describe('4. Overview polling is gated on the Overview tab being on screen', () => {
  it('overviewActive() reads window.ATS.activeTab', () => {
    const w = { ATS: { activeTab: 'registration' } };
    const overviewActive = compile([extractFn(html, 'overviewActive')], 'overviewActive', { window: w });
    expect(overviewActive()).toBe(true);
    w.ATS.activeTab = 'jobs';
    expect(overviewActive()).toBe(false);
    expect(compile([extractFn(html, 'overviewActive')], 'overviewActive', { window: {} })()).toBe(true); // before the ATS bundle loads
  });

  it('the 30s and 5min timers skip a hidden Overview and pass { periodic: true } when it is on screen', () => {
    const timers = [];
    const refreshDashboard = spy(), refreshTrends = spy();
    let active = false;
    const startRefreshLoop = compile([extractFn(html, 'startRefreshLoop')], 'startRefreshLoop', {
      refreshTimerId: null, trendTimerId: null, autoRefresh: true,
      clearInterval() {}, setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
      overviewActive: () => active, refreshDashboard, refreshTrends
    });
    startRefreshLoop();
    expect(timers.map((t) => t.ms)).toEqual([30000, 300000]);
    timers.forEach((t) => t.fn());
    expect(refreshDashboard.calls.length).toBe(0);
    expect(refreshTrends.calls.length).toBe(0);
    active = true;
    timers.forEach((t) => t.fn());
    expect(refreshDashboard.calls).toEqual([[{ periodic: true }]]);
    expect(refreshTrends.calls).toEqual([[{ periodic: true }]]);
  });

  it('visibilitychange is gated the same way, and coming back to Overview refreshes once if older than 30s', () => {
    const vis = html.slice(html.indexOf("document.addEventListener('visibilitychange'"), html.indexOf('/* ── Keyboard shortcut'));
    expect(vis).toContain("document.visibilityState === 'visible' && autoRefresh && overviewActive()");
    expect(vis).toContain('refreshDashboard({ periodic: true })');
    expect(html).toContain('window.loadRegistrationTab = function () {');
    expect(html).toContain('if (dashboardStale || (Date.now() - lastRefreshAt) > 30000) refreshDashboard({ force: true });');
  });

  it('refreshDashboard() on a hidden Overview only refreshes the review queue and marks the dashboard stale', () => {
    const rq = spy(), gpSwr = spy();
    gpSwr.ret = Promise.resolve({ ok: true });
    let active = false;
    const refreshDashboard = compile([extractFn(html, 'refreshDashboard')], 'refreshDashboard', {
      window: { CeoReviewQueue: { refresh: rq } }, overviewActive: () => active,
      dashboardData: { ok: true }, dashboardStale: false, dashboardSubLoadsPending: false, dashboardInflight: false,
      lastRefreshAt: 0, currentPeriod: 'all', gpSwr,
      renderDashboard() {}, renderLoadError() {}, showToast() {}, document: { getElementById: () => null }
    });
    refreshDashboard();                                  // post-action call from another tab
    expect(rq.calls.length).toBe(1);
    expect(gpSwr.calls.length).toBe(0);
    refreshDashboard({ force: true });                  // boot / retry / period change
    expect(gpSwr.calls.length).toBe(1);
    expect(gpSwr.calls[0][0]).toBe('/api/ceo/dashboard?period=all');
    active = true;
    refreshDashboard({ periodic: true });
    expect(gpSwr.calls.length).toBe(2);
    expect(rq.calls.length).toBe(3);
  });

  it('the five Overview sub-requests fire once per cycle and an open drilldown survives a periodic repaint', () => {
    const render = extractFn(html, 'renderDashboard');
    expect(render).toContain('if (activeDrilldown && opts && opts.periodic) {');
    expect(render).toContain('fireDashboardSubLoads();');
    expect(render).toContain('if (activeDrilldown) reapplyDrilldown();');
    expect(render).not.toMatch(/\n\s*loadPepWaitlist\(\);/);          // moved into fireDashboardSubLoads
    const fire = extractFn(html, 'fireDashboardSubLoads');
    expect(fire).toContain('if (!dashboardSubLoadsPending) return;');
    ['loadPepWaitlist', 'loadOnbWaitlist', 'loadConversionFunnel', 'loadSourceAttribution', 'loadPlacementsList'].forEach((n) => expect(fire).toContain(n + '();'));
    expect(extractFn(html, 'refreshDashboard')).toContain('dashboardSubLoadsPending = true;');
    // A rebuild without a refetch must not put "Loading…" back over lists it is not refetching.
    expect(html).toContain("(placementsListData ? renderPlacementsListBody(placementsListData) : '<div style=\"font-size:12px;color:var(--text-dim)\">Loading…</div>')");
    expect(html).toContain("(pepWaitlistData ? renderPepWaitlistBody(pepWaitlistData) : '<div class=\"pep-wl-empty\">Loading…</div>')");
  });
});

describe('5. Export CSV never navigates the page', () => {
  it('no bare href to /api/admin/export remains; the three controls go through ATS.downloadCsv', () => {
    expect(html).not.toMatch(/href="\/api\/admin\/export/);
    expect(candidates).not.toMatch(/href="\/api\/admin\/export/);
    expect(html).toContain('data-csv-export="/api/admin/export?entity=placements&format=csv"');
    expect(html).toContain('data-csv-export="/api/admin/export?entity=leads&format=csv"');
    expect(html).toContain("window.ATS.downloadCsv(exportUrl)");
    expect(candidates).toContain('id="ats-cand-export"');
    expect(candidates).toContain("ATS.downloadCsv('/api/admin/export?entity=gps&format=csv', 'gplink-gps.csv')");
    expect(shared).toContain('downloadCsv: downloadCsv');
  });

  function run(response) {
    const toast = spy();
    const created = [];
    const anchors = [];
    const downloadCsv = compile([extractFn(shared, 'downloadCsv')], 'downloadCsv', {
      toast,
      fetch: () => Promise.resolve(response),
      URL: { createObjectURL: (b) => { created.push(b); return 'blob:x'; }, revokeObjectURL() {} },
      document: { createElement: () => { const a = { style: {}, click: spy(), parentNode: null }; anchors.push(a); return a; }, body: { appendChild(a) { a.parentNode = this; }, removeChild() {} } },
      setTimeout: () => {}
    });
    return downloadCsv('/api/admin/export?entity=gps&format=csv', 'fallback.csv').then((ok) => ({ ok, toast, created, anchors }));
  }

  it('a JSON error answer becomes a toast with the server message — no download, no navigation', async () => {
    const r = await run({ ok: false, status: 401, headers: { get: (h) => (h === 'content-type' ? 'application/json' : '') }, json: () => Promise.resolve({ ok: false, message: 'Admin session expired' }) });
    expect(r.ok).toBe(false);
    expect(r.toast.calls).toEqual([['Export failed: Admin session expired', 'error']]);
    expect(r.created.length).toBe(0);
    expect(r.anchors.length).toBe(0);
  });

  it('a 200 that is not a CSV is still refused', async () => {
    const r = await run({ ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'text/html' : '') }, json: () => Promise.reject(new Error('not json')) });
    expect(r.ok).toBe(false);
    expect(r.toast.calls[0][0]).toBe('Export failed: export failed (HTTP 200)');
    expect(r.created.length).toBe(0);
  });

  it('a real CSV is downloaded via a Blob object URL, named from Content-Disposition', async () => {
    const blob = { size: 3 };
    const r = await run({ ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'text/csv; charset=utf-8' : 'attachment; filename="gplink-gps-2026-10-29.csv"') }, blob: () => Promise.resolve(blob) });
    expect(r.ok).toBe(true);
    expect(r.toast.calls.length).toBe(0);
    expect(r.created).toEqual([blob]);
    expect(r.anchors.length).toBe(1);
    expect(r.anchors[0].href).toBe('blob:x');
    expect(r.anchors[0].download).toBe('gplink-gps-2026-10-29.csv');
    expect(r.anchors[0].click.calls.length).toBe(1);
  });
});

describe('after-action refreshes repaint in place', () => {
  it('atsOpenCandidate({ quiet }) paints no placeholder, keeps the scroll position and bails if the profile is gone', () => {
    const fn = candidates.slice(candidates.indexOf('window.atsOpenCandidate = function (caseId, opts)'), candidates.indexOf('function detailHtml('));
    expect(fn).toContain("if (!quiet) el.innerHTML = ATS.loadingHtml('Loading candidate…');");
    expect(fn).toContain("if (quiet && !host.querySelector('#ats-cand-back')) return;");
    expect(fn).toContain('if (quiet) { if (window.scrollTo) window.scrollTo(0, keepY); return; }');
    // Every post-action caller is quiet; the list/row openers (cid / wcid / id) are not.
    expect(candidates).not.toMatch(/window\.atsOpenCandidate\((c\.case_id( \|\| c\.user_id)?|caseId)\);/);
    expect((candidates.match(/window\.atsOpenCandidate\((c\.case_id( \|\| c\.user_id)?|caseId), \{ quiet: true \}\)/g) || []).length).toBe(18);
    expect(candidates).toContain('if (id) window.atsOpenCandidate(id);');
  });

  it('jobs board, practice card and the RSO GP file do the same', () => {
    const jobs = read('js/ceo-ats-jobs.js');
    expect(jobs).toContain("if (!quiet) panel.innerHTML = A.loadingHtml('Loading pipeline…');");
    expect((jobs.match(/atsOpenJobBoard\(currentBoardJobId, \{ quiet: true \}\)/g) || []).length).toBe(5);
    expect(jobs).not.toMatch(/atsOpenJobBoard\(currentBoardJobId\)/);
    const prac = read('js/ceo-ats-practices.js');
    expect(prac).toContain("if (!quiet) panel.innerHTML = ATS.loadingHtml('Loading practice…');");
    expect(prac).toContain("if (!quiet && window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });");
    expect((prac.match(/openPractice\(p\.id, \{ quiet: true \}\)/g) || []).length).toBe(4);
    expect(html).toContain('function openGpDetail(caseId, rsoId, opts) {');
    expect(html).toContain('if (gpDetailCache && gpDetailCache.caseId === caseId) openGpDetail(caseId, rsoId, { quiet: true });');
    expect(html).toContain('loadRsoOps(rsoId, { fresh: true });');
    expect(html).toContain('loadRsoSupport(ceoSupportRsoId, { fresh: true });');
  });

  it('jobs: the search box is debounced and the map resize handlers are bound once', () => {
    const jobs = read('js/ceo-ats-jobs.js');
    expect(jobs).not.toContain("on('ats-job-search', 'input', fetchAndRenderJobList);");
    expect(jobs).toContain("jobSearchTimer = setTimeout(function () { fetchAndRenderJobList(); }, 250);");
    expect(jobs).toContain('if (jmapResizeObs) { try { jmapResizeObs.disconnect(); }');
    expect(jobs).toContain("if (jmapResizeFix) window.removeEventListener('resize', jmapResizeFix);");
    expect(jobs).not.toContain('new ResizeObserver(fix).observe(shell)');
  });

  it('boot count chips: cached counts paint at once, the three full-list fetches wait for idle', () => {
    const init = extractFn(shared, 'initSwitcher');
    expect(init).toContain("requestIdleCallback");
    expect(init).toContain('whenIdle(function () {');
    expect(init).not.toMatch(/\n\s*swr\('\/api\/ceo\/candidates'/);
    expect(init).toContain("whenIdle(function () { window.ATS.refreshContractsAlert(); });");
  });

  it('every modified bundle carries the 20261029b buster (js/* is immutable-cached for a year)', () => {
    ['ceo-ats-shared', 'ceo-ats-candidates', 'ceo-ats-jobs', 'ceo-ats-practices', 'ceo-ats-meetings', 'ceo-ats-matching', 'ceo-ats-leads', 'ceo-ats-contracts', 'ceo-review-queue']
      .forEach((f) => expect(html).toContain('<script src="/js/' + f + '.js?v=20261029b"></script>'));
  });
});
