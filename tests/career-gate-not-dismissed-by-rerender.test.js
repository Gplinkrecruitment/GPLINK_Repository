// The careers CV gate is a NON-dismissible modal: a job-hunting GP without an
// AI-verified CV must upload one before browsing (owner rule). Helen W. hit a
// bypass on 2026-07-21: the gate opened, then vanished on its own, letting her
// browse with no CV.
//
// Root cause (reproduced in headless Chrome): renderSecuredPlacement() clears
// the gate + its scroll lock as a "placed GPs must never be trapped" measure,
// but getSecuredPlacementUiState() answers "ready" for EVERY GP who is not on
// the secured view, so every renderPage() call also cleared the gate for the
// browse-view GPs the gate exists for. Any late re-render after the gate
// opened dismissed it for the whole session (careerGateState.checked blocks
// re-opening). In production the trigger is the `storage` event: the app-shell
// parent frame / another tab writes gp_career_state, career.html re-renders,
// gate gone. Scrolling during boot merely re-orders that race, which is why it
// looked scroll-triggered on Helen's phone.
//
// The invariant pinned here: inside renderSecuredPlacement, the gate close and
// scroll-lock clear run ONLY under a shouldLockCareerToSecuredView() guard,
// i.e. only for genuinely placed GPs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'career.html'), 'utf8');

// Extract a named function's full source by brace counting (none of the
// functions under test contain braces in strings/comments that would skew it).
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  expect(start, 'function ' + name + ' present in career.html').toBeGreaterThan(-1);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for ' + name);
}

describe('careers CV gate cannot be dismissed by a re-render', () => {
  const renderSecured = extractFunction(html, 'renderSecuredPlacement');

  it('renderSecuredPlacement still un-traps genuinely placed GPs', () => {
    // The original intent must survive the fix: a placed GP behind a stale
    // gate must have it cleared (gate close + scroll-lock restore).
    expect(renderSecured).toContain('closeCareerGateModal');
    expect(renderSecured).toContain('ensureSecuredScrollable');
  });

  it('the gate close + scroll-lock clear only run for GPs locked to the placement view', () => {
    // Both calls must sit inside a shouldLockCareerToSecuredView() guard so a
    // browse-view GP's open CV gate survives renderPage() (storage events,
    // filter changes, match refreshes...).
    expect(renderSecured).toMatch(
      /if\s*\(shouldLockCareerToSecuredView\(\)\)\s*\{[\s\S]{0,600}?closeCareerGateModal[\s\S]{0,600}?ensureSecuredScrollable\(\)/
    );
    // And no unguarded copy of either call may remain in the function: strip
    // the guarded block, then neither name may appear in executable code.
    const guardStart = renderSecured.search(/if\s*\(shouldLockCareerToSecuredView\(\)\)\s*\{/);
    const afterGuard = renderSecured.slice(guardStart === -1 ? 0 : guardStart);
    const guardBlockEnd = guardStart === -1 ? 0 : guardStart + afterGuard.indexOf('}') + 1;
    const outsideGuard = (renderSecured.slice(0, guardStart === -1 ? renderSecured.length : guardStart)
      + renderSecured.slice(guardBlockEnd))
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(outsideGuard).not.toContain('closeCareerGateModal');
    expect(outsideGuard).not.toContain('ensureSecuredScrollable()');
  });

  it('the gate has exactly the known close paths: its definition, the verified-CV CTA, and the guarded placed-GP clear', () => {
    // A non-dismissible modal stays non-dismissible only while nobody adds a
    // new closeCareerGateModal() call without thinking. Pin the call sites:
    //   1. the function definition,
    //   2. the CTA click handler (which requires !disabled, CV verified),
    //   3. the shouldLockCareerToSecuredView()-guarded clear above.
    // 4 name matches = 3 sites: the guarded clear spends two on one line
    // (`typeof closeCareerGateModal === "function"` + the call itself).
    const calls = [...html.matchAll(/closeCareerGateModal/g)];
    expect(calls.length).toBe(4);
    const ctaHandler = html.slice(html.indexOf("ev.target.id === 'careerGateCta'"));
    expect(ctaHandler.slice(0, 120)).toContain('!ev.target.disabled');
  });
});
