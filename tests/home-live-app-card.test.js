import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'pages', 'index.html'), 'utf8');
const updatesSync = fs.readFileSync(path.join(ROOT, 'js', 'updates-sync.js'), 'utf8');

describe('home live application card wiring', () => {
  it('loads the deriveCareerHomeCard helper', () => {
    expect(indexHtml).toContain('/js/career-home-card.js');
  });
  it('fetches the live applications list', () => {
    expect(indexHtml).toContain('/api/career/applications');
    expect(indexHtml).toContain('deriveCareerHomeCard');
  });
  it('suppresses career-category updates so the live card replaces them', () => {
    expect(indexHtml).toContain('liveAppsLoaded');
    expect(indexHtml).toMatch(/category[^\n]*===[^\n]*["']career["']/);
  });
  it('updates-sync preserves the category field through sanitizeUpdate', () => {
    expect(updatesSync).toMatch(/item\.category/);
  });
});
