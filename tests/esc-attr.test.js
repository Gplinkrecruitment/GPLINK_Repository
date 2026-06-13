import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function extractEscAttr() {
  const html = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const m = html.match(/function escAttr\(s\)\{[^\n]*\}/);
  if (!m) throw new Error('escAttr not found');
  // eslint-disable-next-line no-new-func
  return new Function('esc', `${m[0]}; return escAttr;`)(esc);
}

describe('escAttr', () => {
  it('entity-encodes double quotes so values cannot break out of a double-quoted attribute', () => {
    const escAttr = extractEscAttr();
    expect(escAttr('a"b')).not.toContain('"');
  });
  it('entity-encodes single quotes', () => {
    const escAttr = extractEscAttr();
    expect(escAttr("a'b")).not.toContain("'");
  });
});
