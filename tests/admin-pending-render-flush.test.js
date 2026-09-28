import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// A render deferred by the silent 15s refresh is flushed on focusout. It used to call renderAll(),
// which rebuilt the detail pane on MOUSEDOWN of a composer's Send button, so the click never landed
// and an "Accept & email AHPRA" was silently never sent (Dr Mercy's supervisor CV, 2026-09-24).
describe('admin deferred-render flush', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');
  const fn = html.slice(html.indexOf('function flushPendingRender'), html.indexOf('function flushPendingRender') + 700);
  it('is no more destructive than the silent refresh it deferred', () => {
    expect(fn).toMatch(/S\.pendingRender=false;renderTopBar\(\);renderFilters\(\);/);
    const code = fn.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code.slice(0, code.indexOf('document.addEventListener'))).not.toMatch(/renderAll\(\)|renderDetail\(\)/);
  });
  it('the silent refresh itself still never rebuilds panels', () => {
    expect(html).toMatch(/if\(silent\)\{renderTopBar\(\);renderFilters\(\);return;\}/);
  });
  it('the officer composer says it is not sent yet and shows send errors inline', () => {
    expect(html).toContain('Not sent yet. Check the email below');
    expect(html).toContain('data-oreply-err=');
  });
});
