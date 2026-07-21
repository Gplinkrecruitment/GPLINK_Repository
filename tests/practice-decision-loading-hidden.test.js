// Regression (owner screenshot 2026-07-09): the practice "Candidate decision"
// page showed a "Loading…" spinner that never went away, practices saw a
// permanent loading screen sitting on top of the working Approve button and
// assumed the link was broken.
//
// Cause: #pdLoading has an author rule `display:flex` (id specificity). The page
// hides sections by setting the `hidden` attribute, which relies on the UA rule
// [hidden]{display:none}, but an author `display` on the same element always
// beats that, so `el.loading.hidden = true` could not hide the spinner. (Same
// class of bug as the career-gate scanlines, tests/career-gate-modal-fit.js.)
//
// Fix: a global `[hidden]{display:none !important}` so the hidden attribute wins
// over any per-element display rule on this page.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'practice-decision.html'), 'utf8');

describe('practice-decision page: hidden sections actually hide', () => {
  it('has a global [hidden] rule strong enough to beat #pdLoading{display:flex}', () => {
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/i);
  });

  it('still gives the spinner its flex layout while visible', () => {
    // the fix must not remove the spinner styling, only override it when hidden
    expect(html).toMatch(/#pdLoading\s*\{[^}]*display:\s*flex/);
  });
});
