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
