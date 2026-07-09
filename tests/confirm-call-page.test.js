import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const p = path.join(ROOT, 'pages', 'confirm-call.html');

describe('pages/confirm-call.html', () => {
  const html = fs.readFileSync(p, 'utf8');
  it('is auth-gated + shell-aware (mirrors secure-interview head)', () => {
    expect(html).toContain('/js/auth-guard.js');
    expect(html).toContain('/js/nav-shell-bridge.js');
    expect(html).toContain('/css/gp-tokens.css');
  });
  it('reads the stage param and calls the assistance-call endpoint', () => {
    expect(html).toMatch(/params\.get\(['"]stage['"]\)/);
    expect(html).toContain('/api/gp/assistance-call');
  });
  it('opens Calendly in a new tab (CSP blocks embedding) and never fabricates a Zoom link', () => {
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toMatch(/indexOf\(['"]https:['"]\)|startsWith\(['"]https:/);
  });
  it('shows the confirm title', () => {
    expect(html).toContain('Confirm your Zoom call');
  });
});
