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
