// The `hidden` attribute must always hide an element.
//
// Browsers hide [hidden] with a low-priority default rule, so ANY class rule that
// sets display (flex, grid, inline-flex…) silently overrides it. On 2026-11-23 that
// showed every GP on the visa page a green "AHPRA registration granted" strip with
// no grant on record (.granted { display: flex } beat the hidden attribute).
//
// Every page therefore carries `[hidden] { display: none !important; }` in its own
// <style> (or a stylesheet it links). This test fails if a page is added or edited
// without it, so the bug cannot come back page by page.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'pages');
const GUARD = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/;

function pageCss(html) {
  const blocks = [];
  // Real <style> elements only: a block must close with </style>.
  html.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css) => { blocks.push(css); return ''; });
  const links = html.match(/<link[^>]+href="\/css\/[^"?]+/g) || [];
  for (const l of links) {
    const href = l.replace(/^.*href="\//, '');
    const p = path.join(ROOT, href);
    if (fs.existsSync(p)) blocks.push(fs.readFileSync(p, 'utf8'));
  }
  return blocks.join('\n');
}

const pages = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html'));

describe('hidden attribute guard', () => {
  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  for (const file of pages) {
    const html = fs.readFileSync(path.join(PAGES, file), 'utf8');
    const css = pageCss(html);
    // Redirect stubs with no styles of their own have nothing to override.
    if (!css.trim()) continue;

    it(`${file} keeps [hidden] elements hidden`, () => {
      expect(GUARD.test(css), `${file} needs "[hidden] { display: none !important; }" in its <style>`).toBe(true);
    });
  }

  it('the visa page cannot show the AHPRA-granted strip without data', () => {
    const html = fs.readFileSync(path.join(PAGES, 'visa.html'), 'utf8');
    expect(html).toMatch(/id="regGranted"[^>]*\shidden/);
    expect(GUARD.test(pageCss(html))).toBe(true);
  });
});
