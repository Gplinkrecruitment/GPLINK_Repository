import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
const SRC = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('identity document persistence (source contract)', () => {
  it('defines saveIdentityDocumentForUser writing a user_documents identity row', () => {
    expect(SRC).toMatch(/function saveIdentityDocumentForUser\(/);
    expect(SRC).toMatch(/document_key:\s*'identity'/);
    // full storage tuple (so CEO/ATS can sign a URL later)
    expect(SRC).toMatch(/storage_bucket:\s*SUPABASE_DOCUMENT_BUCKET/);
    expect(SRC).toMatch(/buildIdentityDocumentStoragePath/);
  });
  it('verify-identity persists on a successful read (calls saveIdentityDocumentForUser)', () => {
    expect(SRC).toMatch(/saveIdentityDocumentForUser\(/);
  });
  it('identity persistence never creates a doc-review task', () => {
    const fn = SRC.match(/async function saveIdentityDocumentForUser\([\s\S]*?\n}\n/);
    expect(fn).toBeTruthy();
    expect(fn[0]).not.toMatch(/_createRegTask|createDocReviewTask/);
    // and it must file into the Drive ID subfolder
    expect(SRC).toMatch(/driveDocFolders\.ID_FOLDER/);
  });
});
