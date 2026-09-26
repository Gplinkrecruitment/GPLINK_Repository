import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// docx-preview's UMD build captures a GLOBAL JSZip when it loads and does not bundle it. Loading it
// alone made every Word preview in admin fail with "reading 'loadAsync'" (a supervisor's CV).
describe('admin Word preview loader', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');
  it('loads JSZip before docx-preview', () => {
    const zip = html.indexOf('/npm/jszip@');
    const docx = html.indexOf('/npm/docx-preview@');
    expect(zip).toBeGreaterThan(-1);
    expect(docx).toBeGreaterThan(zip);
  });
});
