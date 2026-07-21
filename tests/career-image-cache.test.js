import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(__dirname, '..');
describe('career hero image caching', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  it('sw caches career-hero-images cross-origin', () => {
    expect(sw).toMatch(/career-hero-images/);
    expect(sw).toMatch(/IMAGE_CACHE/);
  });
  it('career page warms role thumbnails', () => {
    const career = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');
    expect(career).toMatch(/warmRoleImages/);
  });
});
