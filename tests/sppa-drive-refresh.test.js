import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';

// A scan corrected by direct DB write (the Q7 conflict repair, Dr Mercy Obanimoh 2026-09)
// leaves the GP's Google Drive folder holding the PRE-repair copy — and because filed docs
// get MOVED into the sppa_00 subfolder, a plain re-upload can strand a stale copy there too.
// The sppa-drive-refresh endpoint re-uploads the CURRENT stored document and trashes every
// other SPPA-00 file in the case folder + sppa_00 subfolder, leaving exactly one copy.
const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');

describe('SPPA-00 Drive refresh endpoint', () => {
  const idx = server.indexOf("pathname.endsWith('/sppa-drive-refresh')");

  it('exists as an admin-guarded POST route', () => {
    expect(idx).toBeGreaterThan(0);
    const block = server.slice(idx, idx + 3500);
    expect(block).toContain('requireAdminSession(req, res)');
  });

  it('uploads the CURRENT primary document (never alt-CV / other)', () => {
    const block = server.slice(idx, idx + 3500);
    expect(block).toContain('is_current=eq.true&category=not.in.(alt_supervisor_cv,other)');
    expect(block).toContain("_uploadSppaDocToDrive(task.case_id, refDoc.id, refBuffer, 'SPPA-00 (Completed).pdf')");
  });

  it('trashes other SPPA-00 copies in the case folder and the sppa_00 subfolder', () => {
    const block = server.slice(idx, idx + 3500);
    expect(block).toContain("name contains 'SPPA-00'");
    expect(block).toContain('{ trashed: true }');
    expect(block).toContain("folderNameForDoc('sppa_00')");
    // never trash the file that was just uploaded
    expect(block).toContain('=== uploaded.id) continue');
  });
});
