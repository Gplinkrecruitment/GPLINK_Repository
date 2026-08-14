// Every inline <script> in every page must actually PARSE (2026-08-14).
//
// Why this file exists: on 2026-08-10 commit 3836a87 applied the same patch to
// pages/career.html twice, leaving `let currentChecklistItems = [];` declared on
// two consecutive lines. A duplicate lexical declaration is a *parse-time*
// SyntaxError, so the browser threw away the ENTIRE script block before running
// a line of it. My Practice rendered a permanent spinner and the crash toast
// ("Something went wrong — we've been notified") for every doctor who opened it,
// on iOS Safari and Android Chrome alike, for four days.
//
// Nothing caught it. The page tests in this repo read the HTML as TEXT and grep
// it — a string search can never see a broken declaration, so the suite stayed
// green while the page was dead on arrival. There is no jsdom here either
// (see tests/practice-intake*), so no other test ever compiles page JS.
//
// This test closes that class: it compiles every inline script in every page
// with the real V8 parser. It asserts nothing about behaviour — only that the
// code the browser is handed is syntactically valid and will actually run.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// <script> blocks that carry real JS. Anything with src= is a separate file
// (covered below); non-JS types (application/ld+json, text/template) are data.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPE_RE = /^(text\/javascript|application\/javascript|module)$/i;

function inlineScripts(html) {
  const blocks = [];
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (type && !JS_TYPE_RE.test(type)) continue;
    if (!m[2].trim()) continue;
    blocks.push({
      code: m[2],
      isModule: /^module$/i.test(type),
      line: html.slice(0, m.index).split('\n').length
    });
  }
  return blocks;
}

function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(ext))
    .map((name) => path.join(dir, name));
}

// vm.Script compiles a classic script. A type="module" block is parsed under
// module rules — top-level await is legal there — so compile those as an async
// function body instead. (Real module parsing needs vm.SourceTextModule behind
// --experimental-vm-modules; the wrapper is equivalent for every module block
// this app ships, none of which use static import/export. Static `import x from`
// in a page module would surface here as a syntax error and want this revisited.)
function syntaxErrorFor(code, filename, isModule) {
  const source = isModule ? '(async () => {\n' + code + '\n})' : code;
  try {
    new vm.Script(source, { filename });
    return '';
  } catch (err) {
    if (err instanceof SyntaxError) return err.message;
    throw err;
  }
}

describe('inline page JavaScript parses', () => {
  const pages = listFiles(path.join(ROOT, 'pages'), '.html');

  it('finds the pages to check', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it('every inline <script> in every page compiles', () => {
    const broken = [];
    for (const file of pages) {
      const html = fs.readFileSync(file, 'utf8');
      for (const block of inlineScripts(html)) {
        const label = `${path.relative(ROOT, file)}:${block.line}`;
        const message = syntaxErrorFor(block.code, label, block.isModule);
        if (message) broken.push(`${label} — ${message}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every browser script file compiles', () => {
    const broken = [];
    for (const file of listFiles(path.join(ROOT, 'js'), '.js')) {
      const rel = path.relative(ROOT, file);
      const message = syntaxErrorFor(fs.readFileSync(file, 'utf8'), rel);
      if (message) broken.push(`${rel} — ${message}`);
    }
    const sw = path.join(ROOT, 'sw.js');
    if (fs.existsSync(sw)) {
      const message = syntaxErrorFor(fs.readFileSync(sw, 'utf8'), 'sw.js');
      if (message) broken.push(`sw.js — ${message}`);
    }
    expect(broken).toEqual([]);
  });

  it('career.html declares currentChecklistItems exactly once', () => {
    // The specific regression. Kept alongside the class check because this one
    // names the symbol, so a re-introduction reads as itself in the failure.
    const html = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
    const declarations = html.match(/\blet\s+currentChecklistItems\b/g) || [];
    expect(declarations.length).toBe(1);
  });
});
