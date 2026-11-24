// AHPRA intro — the "your part is done, we are still preparing ours" state.
//
// Owner report 2026-08-14, on Dr Sana Ahsan's case: a doctor who has finished every
// document that is actually hers was still shown "There are a few documents we need
// prepared before commencing" above a "Complete Now" button, and then a list naming only
// things she had already done. Nothing on the screen ever said the remaining work was
// OURS (the practice pack we prepare with the practice).
//
// Two defects behind it:
//  1. The "GP Link Prepares" group was dead code. getIncompleteDocsForIntro referenced
//     SUPERVISED_PRACTICE_DOCS, which is defined ONLY in pages/my-documents.html, so
//     `typeof SUPERVISED_PRACTICE_DOCS !== "undefined"` was always false and the group
//     rendered nothing at all.
//  2. renderIntroCta had only two branches (all done / something outstanding), so work
//     the doctor cannot do was presented to her as work she must do.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AHPRA_PATH = path.join(__dirname, '..', 'pages', 'ahpra.html');
const MY_DOCS_PATH = path.join(__dirname, '..', 'pages', 'my-documents.html');

let ahpraHtml;
let myDocsHtml;

beforeAll(() => {
  ahpraHtml = fs.readFileSync(AHPRA_PATH, 'utf8');
  myDocsHtml = fs.readFileSync(MY_DOCS_PATH, 'utf8');
});

const PACK_KEYS = ['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv'];

describe('the GP Link prepared-document list actually exists on the AHPRA page', () => {
  it('defines the five pack documents locally, not only in my-documents.html', () => {
    expect(ahpraHtml).toContain('AHPRA_GPLINK_PREPARED_DOCS');
    for (const key of PACK_KEYS) {
      expect(ahpraHtml, key + ' must be in the AHPRA page list').toContain('"' + key + '"');
    }
  });

  it('falls back to that list rather than to an empty array', () => {
    // The old code ended `: [];` which silently disabled the whole group.
    expect(ahpraHtml).toMatch(/SUPERVISED_PRACTICE_DOCS\s*:\s*AHPRA_GPLINK_PREPARED_DOCS/);
    expect(ahpraHtml).not.toMatch(/typeof SUPERVISED_PRACTICE_DOCS !== "undefined" \? SUPERVISED_PRACTICE_DOCS : \[\]/);
  });

  it('keeps the same keys and order as my-documents.html so the two surfaces agree', () => {
    function keysFrom(src, marker) {
      const start = src.indexOf(marker);
      expect(start, marker + ' not found').toBeGreaterThan(-1);
      const block = src.slice(start, src.indexOf('];', start));
      return (block.match(/key:\s*"([a-z_0-9]+)"/g) || []).map(m => m.replace(/.*"([a-z_0-9]+)"/, '$1'));
    }
    const ahpraKeys = keysFrom(ahpraHtml, 'AHPRA_GPLINK_PREPARED_DOCS');
    const myDocsKeys = keysFrom(myDocsHtml, 'SUPERVISED_PRACTICE_DOCS');
    expect(ahpraKeys).toEqual(PACK_KEYS);
    expect(ahpraKeys).toEqual(myDocsKeys);
  });
});

describe('a doctor is never asked to complete work that is ours', () => {
  it('splits the outstanding documents by who has to act', () => {
    expect(ahpraHtml).toContain('function splitIntroDocsByOwner');
    expect(ahpraHtml).toMatch(/d\.group === "gplink"\) ours\.push\(d\); else mine\.push\(d\)/);
  });

  it('shows the reassurance branch when only GP Link items remain', () => {
    expect(ahpraHtml).toMatch(/else if \(split\.doctor\.length === 0\)/);
    expect(ahpraHtml).toContain("You\\'ve done everything we need from you");
  });

  it('offers "See what we\'re preparing" instead of "Complete Now" in that state', () => {
    expect(ahpraHtml).toContain('introWaitingBtn');
    expect(ahpraHtml).toContain("See what we\\'re preparing");
    // The waiting branch must not render the Complete Now button.
    const start = ahpraHtml.indexOf('else if (split.doctor.length === 0)');
    const end = ahpraHtml.indexOf('} else {', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(ahpraHtml.slice(start, end)).not.toContain('introCompleteBtn');
  });

  it('still shows Complete Now when the doctor genuinely has something to do', () => {
    expect(ahpraHtml).toContain('introCompleteBtn');
    expect(ahpraHtml).toContain('There are a few documents we need prepared before commencing');
  });

  it('leads the document list with the "your part is complete" banner', () => {
    expect(ahpraHtml).toContain('intro-waiting-banner');
    expect(ahpraHtml).toContain('Your part is complete');
    expect(ahpraHtml).toMatch(/splitForList\.doctor\.length === 0/);
  });

  it('tells the doctor the pack items need nothing from her', () => {
    expect(ahpraHtml).toContain('GP Link is preparing this with your practice. Nothing needed from you.');
  });
});

describe('GP-facing copy on this screen uses no em dashes (owner instruction)', () => {
  it('has no em dash in any string the doctor reads here', () => {
    const phrases = [
      "You\\'ve done everything we need from you",
      'Your part is complete',
      'GP Link is preparing this with your practice. Nothing needed from you.',
      'will unlock. There\\\'s nothing further for you to do.',
      'We prepare these for you, so there\\\'s nothing for you to upload.'
    ];
    for (const p of phrases) expect(ahpraHtml).toContain(p);

    // Nothing emitted into the waiting banner / CTA may carry an em dash.
    const emitted = ahpraHtml.split('\n').filter(l => /html \+=/.test(l) && /intro-waiting|intro-doc-desc|intro-doc-notice|intro-ready-text/.test(l));
    expect(emitted.length).toBeGreaterThan(0);
    for (const line of emitted) {
      expect(line, 'em dash in GP-facing copy: ' + line.trim().slice(0, 90)).not.toContain('—');
    }
  });
});

describe('?intro=waiting preview', () => {
  it('filters to the GP Link items only, and writes nothing', () => {
    expect(ahpraHtml).toContain('introParam === "waiting"');
    expect(ahpraHtml).toMatch(/introIncompleteDocs\.filter\(function \(d\) \{ return d && d\.group === "gplink"; \}\)/);
  });

  it('survives the server reconcile so the preview cannot flicker back', () => {
    const syncStart = ahpraHtml.indexOf('syncIntroPreparedDocsFromServer(country).then');
    expect(syncStart).toBeGreaterThan(-1);
    const block = ahpraHtml.slice(syncStart, syncStart + 900);
    expect(block).toContain('introParam === "waiting"');
  });
});

// Dr Hatice Akkas, 24 Nov 2026: the gateway listed all five GP Link documents as
// "Preparing" although every one was ready on the server. The gateway paints on page
// load; on a fresh browser ("View as GP", a new phone) that is BEFORE state-sync has
// hydrated gp_prepared_docs. initPage() runs again on gp-state-hydrated, but
// showSecuredPage() returned early whenever the gateway was already visible, so the
// stale first paint was never corrected. Runs the page's REAL functions in a sandbox.
describe('the gateway re-draws once the doctor\'s state has hydrated', () => {
  function extractBlock(src, marker) {
    const start = src.indexOf(marker);
    expect(start, marker + ' not found').toBeGreaterThan(-1);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
  }

  it('shows the pack as ready after hydration instead of keeping the stale "Preparing" paint', async () => {
    const vm = await import('vm');
    const store = {};
    const drawn = [];
    const sandbox = {
      URLSearchParams,
      window: { location: { search: '' } },
      introEl: { style: { display: 'none' } },
      DOC_KEY: 'gp_documents_prep',
      PREPARED_DOCS_KEY: 'gp_prepared_docs',
      readJsonStorage: (k, fb) => { try { return k in store ? JSON.parse(store[k]) : fb; } catch (e) { return fb; } },
      getPageCountry: () => 'uk',
      hidePlacementGate: () => {},
      loadProgress: () => ({}),
      isAhpraGatewayBypassed: () => false,
      isIntroDismissed: () => false,
      renderIntroCta: () => {},
      renderIntroDocsList: (docs) => drawn.push(docs.map((d) => d.key + ':' + d.status)),
      removeIntroHideStyle: () => {},
      renderPage: () => {}
    };
    vm.createContext(sandbox);
    const packStart = ahpraHtml.indexOf('var AHPRA_GPLINK_PREPARED_DOCS');
    const src = [
      'var introIncompleteDocs = [];',
      extractBlock(ahpraHtml, 'const INTRO_COUNTRY_DOCS = ') + ';',
      ahpraHtml.slice(packStart, ahpraHtml.indexOf('];', packStart) + 2),
      extractBlock(ahpraHtml, 'function getIncompleteDocsForIntro('),
      extractBlock(ahpraHtml, 'function refreshIntroDocs('),
      // showIntroScreen's server reconcile + layout are out of scope here.
      'function showIntroScreen() { refreshIntroDocs(); introEl.style.display = ""; }',
      extractBlock(ahpraHtml, 'function showSecuredPage('),
      'this.showSecuredPage = showSecuredPage;'
    ].join('\n');
    vm.runInContext(src, sandbox);

    // 1) First paint: fresh browser, nothing hydrated yet → the pack reads "Preparing".
    sandbox.showSecuredPage();
    expect(drawn.at(-1)).toEqual(expect.arrayContaining(PACK_KEYS.map((k) => k + ':preparing')));

    // 2) state-sync hydrates the doctor's real state, then initPage() → showSecuredPage().
    store.gp_prepared_docs = JSON.stringify({ docs: Object.fromEntries(PACK_KEYS.map((k) => [k, { ready: true, url: 'https://drive.google.com/file/d/x' + k + '/view' }])) });
    sandbox.showSecuredPage();
    expect(drawn.length).toBe(2);
    expect(drawn.at(-1).filter((s) => s.endsWith(':preparing'))).toEqual([]);
  });
});
