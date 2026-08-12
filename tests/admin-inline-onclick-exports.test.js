/**
 * pages/admin.html runs its entire script inside an IIFE:
 *
 *   <script>
 *   (function(){ "use strict"; ... })();
 *
 * so a `function foo(){}` declared in there is NOT on `window`, and an inline
 * `onclick="foo()"` — which is evaluated in global scope — throws
 * `ReferenceError: foo is not defined` the moment it is clicked. The file
 * carries an explicit "Expose functions used by inline onclick handlers (IIFE
 * escape)" block near the bottom for exactly this reason.
 *
 * This is silent at build time and invisible in review: the markup and the
 * function both look correct, and nothing fails until a human clicks the
 * button in production. It has now happened twice —
 *   • `cropReviewDocImage`  (935eef4, "✂️ Crop out the background") — the CEO
 *     clicked it and got "Something went wrong — we've been notified";
 *   • `vaDeleteIdentityDoc` ("Delete ID"), found while fixing the first.
 *
 * So: every function named by an inline onclick in admin.html must appear in
 * the export block. Scoped to admin.html deliberately —
 * pages/ceo-dashboard.html declares its handlers at top level (all 56 of its
 * onclick targets are unexported and work fine), so the same rule there would
 * be wrong.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ADMIN = path.resolve(__dirname, '..', 'pages', 'admin.html');

/* Matches both the static markup (onclick="foo(") and the handlers built inside
 * JS template strings (onclick=\"foo(  /  onclick="'+ ... which still render as
 * onclick="foo(" in the source text). */
const ONCLICK = /onclick=\\?["']\s*([A-Za-z_$][\w$]*)\s*\(/g;
const EXPORTED = /window\.([A-Za-z_$][\w$]*)\s*=/g;

function collect(re, src) {
  const out = new Set();
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

describe('admin.html inline onclick handlers escape the IIFE', () => {
  const src = fs.readFileSync(ADMIN, 'utf8');

  it('is still a single IIFE (the reason this rule exists)', () => {
    expect(src).toMatch(/<script>\s*\(function\(\)\s*\{\s*"use strict";/);
  });

  it('exports every function named by an inline onclick', () => {
    const handlers = collect(ONCLICK, src);
    const exported = collect(EXPORTED, src);

    // Guard the guard: if the markup is ever restructured so no handlers are
    // found, this test must fail loudly rather than pass vacuously.
    expect(handlers.size).toBeGreaterThan(20);

    const missing = [...handlers].filter((n) => !exported.has(n)).sort();
    expect(
      missing,
      'These are called from an inline onclick but never assigned to window, so ' +
        'clicking them throws ReferenceError in production. Add `window.<name> = ' +
        '<name>;` to the "IIFE escape" block near the bottom of pages/admin.html.'
    ).toEqual([]);
  });

  it('exports the review-modal handlers, including the document crop', () => {
    const exported = collect(EXPORTED, src);
    for (const fn of [
      'openReviewDocModal',
      'closeReviewDocModal',
      'submitReviewDoc',
      'runReviewDocAiScan',
      'cropReviewDocImage',
    ]) {
      expect(exported.has(fn), `window.${fn} is not exported`).toBe(true);
    }
  });
});

describe('closing the review modal does not re-request the page as an image', () => {
  const src = fs.readFileSync(ADMIN, 'utf8');

  /* img.src = '' resolves against the document, so the browser fetches
   * /pages/admin AS AN IMAGE, fails, and error-reporter.js files a
   * "Resource failed to load: IMG /pages/admin" every time the modal closes. */
  it('clears the preview with removeAttribute, not an empty src', () => {
    expect(src).not.toMatch(/getElementById\(['"]reviewDocImg['"]\)\.src\s*=\s*['"]['"]/);
    expect(src).toMatch(/removeAttribute\(['"]src['"]\)/);
  });
});
