// Owner 2026-09-07: no gap above the header; the Australia home-hero video
// behind the Career box; a clear split between the doctor's own cards and
// the job board.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('shell header sits flush at the top', () => {
  const shell = read('pages/app-shell.html');
  it('no top padding, corners only below, and a dark shell body in dark mode', () => {
    expect(shell).toContain('padding: 0 24px 0;');
    expect(shell).not.toContain('padding: 4px 24px 0;');
    expect(shell).toContain('border-radius: 0 0 var(--radius-lg) var(--radius-lg);');
    expect(shell).toContain('border-top: 0;');
    expect(shell).toContain('@media (prefers-color-scheme: dark) {\n      body { background: #0f172a; }');
  });
});

describe('Career box plays the home hero video', () => {
  const career = read('pages/career.html');
  it('uses the same desktop clip as the home dashboard, muted + looping, with a veil and a fallback', () => {
    expect(career).toContain('<video class="at-mast-video" id="atMastVideo" autoplay muted loop playsinline preload="metadata" aria-hidden="true">');
    expect(career).toContain('<source src="/media/videos/gp-link-hero-desktop.mp4" type="video/mp4">');
    expect(fs.existsSync(path.join(process.cwd(), 'media', 'videos', 'gp-link-hero-desktop.mp4'))).toBe(true);
    expect(career).toContain('<div class="at-mast-veil" aria-hidden="true"></div>');
    expect(career).toContain(".at-mast.at-mast--novideo .at-mast-video, .at-mast.at-mast--novideo .at-mast-veil { display: none; }");
    expect(career).toContain("v.addEventListener('error',off,true)");
    expect(career).toContain("@media (prefers-reduced-motion: reduce) { .at-mast-video { display: none; } }");
    // the copy stays above the video and the veil
    expect(career).toContain('.at-mast-inner { position: relative; z-index: 2;');
  });
});

describe('matches & applications are visibly separate from the job board', () => {
  const career = read('pages/career.html');
  it('the doctor\'s cards sit in their own panel and the board has a titled header with its count', () => {
    expect(career).toContain('.cmap-mine{margin:-6px 0 26px;background:var(--gp-surface);border:1px solid var(--gp-border);border-left:4px solid #16a34a;');
    const head = career.indexOf('<div class="at-board-h" id="jobBoardHead">');
    expect(head).toBeGreaterThan(0);
    expect(head).toBeLessThan(career.indexOf('<div class="at-list" id="recommendedRoles"></div>'));
    expect(head).toBeGreaterThan(career.indexOf('id="cmapMineList"'));
    expect(career).toContain("var bEl=document.getElementById('boardCount');if(bEl)bEl.textContent=shown;");
  });
});
