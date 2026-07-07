// Careers CV-gate modal must fit every viewport (owner screenshot 2026-07-07).
//
// Two rendering bugs made the non-dismissible gate modal unusable on normal
// screens:
//  1. `.career-gate-card` set `overflow: hidden`, overriding `.modal-card`'s
//     `overflow: auto`. The gate content is ~1000px tall, so on any viewport
//     shorter than that the CTA (the ONLY way past the modal) was clipped off
//     the bottom with no scrollbar — the GP was hard-stuck.
//  2. The scan-status lines are toggled via the HTML `hidden` attribute, but
//     `.career-gate-scanline { display: flex }` beats the user-agent
//     `[hidden] { display: none }` rule (author styles always win over UA
//     styles), so all three lines — including an EMPTY red error box — were
//     permanently visible, adding ~125px of phantom height.
//
// Static pins in the style of tests/gp-flow-server-gaps.test.js "G2".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'career.html'), 'utf8');

function cssBlock(selector) {
  const start = html.indexOf(selector + ' {');
  expect(start, `CSS rule "${selector} {" present in career.html`).toBeGreaterThan(-1);
  const end = html.indexOf('}', start);
  return html.slice(start, end + 1);
}

describe('careers gate modal fits every viewport', () => {
  it('gate card scrolls vertically instead of clipping the CTA', () => {
    const card = cssBlock('.career-gate-card');
    // `overflow: hidden` silently discarded everything below the fold —
    // including the only button that closes the modal.
    expect(card).not.toMatch(/overflow:\s*hidden\s*;/);
    expect(card).toMatch(/overflow-y:\s*auto/);
  });

  it('keeps a 100vh max-height fallback for browsers without dvh support', () => {
    const card = cssBlock('.modal-card');
    const vh = card.indexOf('max-height: calc(100vh - 32px)');
    const dvh = card.indexOf('max-height: calc(100dvh - 32px)');
    expect(vh).toBeGreaterThan(-1);
    expect(dvh).toBeGreaterThan(vh); // dvh must come after so it wins when supported
  });

  it('scan-status lines actually hide when the hidden attribute is set', () => {
    // .career-gate-scanline's `display: flex` overrides the UA [hidden] rule,
    // so an explicit author-level [hidden] rule is required.
    expect(html).toMatch(/\.career-gate-scanline\[hidden\]\s*\{\s*display:\s*none/);
  });
});

// Round 2 — owner's iPhone screenshot 2026-07-07 11:47pm (embedded in the app
// shell): CTA hidden behind the bottom nav, blue header inset from the card
// edges, and the whole page pannable left-right.
describe('careers gate modal — mobile shell fixes', () => {
  it('CTA lives in a sticky footer so it is always visible', () => {
    // markup: the CTA + foot note are wrapped in the sticky footer
    expect(html).toMatch(/career-gate-footer">\s*<button class="career-gate-cta"/);
    const footer = cssBlock('.career-gate-footer');
    expect(footer).toMatch(/position:\s*sticky/);
    expect(footer).toMatch(/bottom:\s*0/);
    // solid background, otherwise scrolled content shows through behind it
    expect(footer).toMatch(/background:/);
  });

  it('gate card keeps padding 0 on mobile (blue header reaches the card edges)', () => {
    // The mobile media query re-pads .modal-card AFTER .career-gate-card's
    // padding: 0 (same specificity, later source order wins) — so the LAST
    // .career-gate-card declaration in the file must restore padding: 0.
    const blocks = [...html.matchAll(/\.career-gate-card\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[blocks.length - 1]).toMatch(/padding:\s*0/);
  });

  it('modal clears the app-shell bottom nav', () => {
    expect(cssBlock('.modal')).toContain('--gp-shell-bottom-clearance');
    expect(cssBlock('.modal-card')).toContain('--gp-shell-bottom-clearance');
  });

  it('masthead full-bleed no longer overhangs the viewport (no left-right pan)', () => {
    // margin: 0 -16px assumed a 16px-padded parent; the parent has none at
    // <=640px, so the mast poked 16px past both screen edges.
    expect(html).not.toMatch(/\.at-mast\s*\{[^}]*margin-left:\s*-/);
    expect(html).not.toMatch(/\.at-mast\s*\{[^}]*margin-right:\s*-/);
  });

  it('page locks horizontal overflow at the root', () => {
    expect(html).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
  });
});

// Round 3 — owner report 2026-07-08: with the popup open, scroll gestures
// sometimes scroll the career page underneath instead of the popup. Gestures
// starting on the backdrop fall through to the document, and the card's
// scroll chains to the page at its top/bottom edges.
describe('careers gate modal — background scroll lock', () => {
  it('page scrolling is locked while the gate modal is open', () => {
    // the lock MUST cover html as well: body overflow no longer propagates
    // to the viewport once html has overflow-x: hidden (verified live —
    // a body-only lock still scrolled).
    expect(html).toMatch(/html\.career-gate-open,\s*body\.career-gate-open\s*\{[^}]*overflow:\s*hidden/);
    // open/close must toggle the lock class on BOTH roots in step with is-open
    expect(html).toMatch(/function openCareerGateModal[^\n]*documentElement\.classList\.add\('career-gate-open'\)[^\n]*body\.classList\.add\('career-gate-open'\)/);
    expect(html).toMatch(/function closeCareerGateModal[^\n]*documentElement\.classList\.remove\('career-gate-open'\)[^\n]*body\.classList\.remove\('career-gate-open'\)/);
  });

  it('modal card scroll does not chain to the page at its edges', () => {
    expect(cssBlock('.modal-card')).toMatch(/overscroll-behavior:\s*contain/);
  });
});

// Round 4 — owner request 2026-07-08: make the blue "One quick step / Complete
// your profile" header sticky too, pinned to the top of the card while the
// content scrolls (mirrors the sticky footer).
describe('careers gate modal — sticky header', () => {
  it('blue header sticks to the top of the scrollable card', () => {
    const top = cssBlock('.career-gate-top');
    expect(top).toMatch(/position:\s*sticky/);
    expect(top).toMatch(/top:\s*0/);
    // a solid background so scrolled content does not show through behind it
    expect(top).toMatch(/background:/);
  });
});
