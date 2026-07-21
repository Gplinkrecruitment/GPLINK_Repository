// Mobile bottom-sheets for applying to / accepting a role were partly covered
// by the app-shell bottom nav bar, the Apply / Accept buttons sat behind the
// nav on mobile (owner screenshot 2026-07-09: job.html "Apply for this role?").
//
// Every such sheet's card must pad its bottom past the shell nav
// (--gp-shell-bottom-clearance), taking the LARGER of that and the iOS
// safe-area inset. The nav-shell-bridge measures the nav's height all the way
// to the viewport bottom, so it already INCLUDES the safe-area inset, summing
// both would double-count, hence max(), not +. Same family of fix as the
// career CV-gate sticky footer (tests/career-gate-modal-fit.test.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readPage(name) {
  return fs.readFileSync(path.join(process.cwd(), 'pages', name), 'utf8');
}
function cssBlock(html, selector, file) {
  const start = html.indexOf(selector + ' {');
  expect(start, `CSS rule "${selector} {" present in ${file}`).toBeGreaterThan(-1);
  const end = html.indexOf('}', start);
  return html.slice(start, end + 1);
}

// max( env(safe-area-inset-bottom …) , var(--gp-shell-bottom-clearance …) )
const CLEARS_NAV =
  /max\(\s*env\(safe-area-inset-bottom[^)]*\)\s*,\s*var\(--gp-shell-bottom-clearance[^)]*\)\s*\)/;

describe('apply/accept bottom sheets clear the app-shell nav on mobile', () => {
  it('job.html .at-sheet card (booking, decline + apply-confirm all use it)', () => {
    const sheet = cssBlock(readPage('job.html'), '.at-sheet', 'job.html');
    expect(sheet).toMatch(CLEARS_NAV);
  });

  it('career.html .at-match-confirm-card (accept-this-match sheet)', () => {
    const card = cssBlock(readPage('career.html'), '.at-match-confirm-card', 'career.html');
    expect(card).toMatch(CLEARS_NAV);
  });
});
