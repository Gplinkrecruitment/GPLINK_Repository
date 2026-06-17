import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Regression guard for the CEO dashboard "eternal Authenticating… spinner" bug.
 *
 * Root cause (2026-06-17): pages/ceo-dashboard.html contained a regex written with
 * RAW control bytes in its character class — /[<U+0000>-<U+001F><U+007F>]/ — instead
 * of escape sequences. On disk this is a valid in-order range, so `node --check` and
 * the V8 render harness passed. But the HTML parser replaces a literal U+0000 (NUL)
 * inside <script> data with U+FFFD before JS tokenization, turning the class into
 * /[<U+FFFD=65533>-<U+001F=31>]/ → "Range out of order in character class" →
 * Uncaught SyntaxError → the ENTIRE inline script fails to parse → init() never runs
 * → the page hangs forever on the loading spinner. This is browser-universal.
 *
 * The fix is to use escape sequences (\x00-\x1f\x7f). This test makes sure no served
 * HTML page ever ships raw control bytes again. Allowed control bytes: \t (0x09),
 * \n (0x0a), \r (0x0d).
 */

const root = process.cwd();
const pagesDir = path.join(root, 'pages');

function rawControlByteOffenders(buf) {
  const offenders = [];
  let line = 1;
  let col = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0a) { line++; col = 0; continue; }
    col++;
    const isAllowed = b === 0x09 || b === 0x0d; // tab, CR (newline handled above)
    const isControl = b < 0x20 || b === 0x7f;
    if (isControl && !isAllowed) {
      offenders.push({ line, col, byte: '0x' + b.toString(16).padStart(2, '0') });
    }
  }
  return offenders;
}

const htmlFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'));

describe('served HTML pages contain no raw control bytes', () => {
  it('has at least one page to scan', () => {
    expect(htmlFiles.length).toBeGreaterThan(0);
  });

  for (const file of htmlFiles) {
    it(`${file} has no raw control bytes (NUL/DEL/etc.) that break browser JS parsing`, () => {
      const buf = fs.readFileSync(path.join(pagesDir, file));
      const offenders = rawControlByteOffenders(buf);
      expect(
        offenders,
        `Raw control bytes in pages/${file} (use escape sequences like \\x00 instead): ` +
          JSON.stringify(offenders.slice(0, 10))
      ).toEqual([]);
    });
  }
});
