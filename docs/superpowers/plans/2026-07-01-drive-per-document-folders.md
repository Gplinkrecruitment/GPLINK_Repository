# Per-Document Google Drive Folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organise each candidate's Google Drive folder so every document type sits in its own subfolder named after the app's document label, plus an `Other Files` catch-all — kept organised on Drive itself (at delivery + a daily sweep), independent of the app.

**Architecture:** One pure mapping module (`lib/drive-doc-folders.js`) is the single source of truth for `document_key → folder name`. One server primitive `fileDocOnDrive(caseId, docKey, driveFileId)` moves a Drive file into its folder (idempotent). Delivery paths call it for immediacy; `organizeCaseDrive(caseId)` + a daily cron sweep existing files and stragglers; the admin documents endpoint resolves each file by id so it keeps working regardless of folder.

**Tech Stack:** Node.js (vanilla, `server.js` monolith), Google Drive API (`googleapis`), Supabase REST, Vitest.

## Global Constraints

- Deployed prod = `origin/main`; local working tree is stale — verify against `git show origin/main:`.
- Run `node --check server.js` before any push; full `vitest` suite must stay green.
- Drive moves are metadata-only — they never change a file's own sharing.
- Every Drive call is best-effort + logged; a failure on one file never blocks a delivery or the rest of a sweep.
- Folder names must be Drive-safe (no bare `/`): `Offer / Contract`, not `Offer/contract`.
- Test binary: `/tmp/node-v20.18.1-darwin-arm64/bin/node node_modules/vitest/vitest.mjs run`.

---

### Task 1: `lib/drive-doc-folders.js` — pure docKey → folder mapping

**Files:**
- Create: `lib/drive-doc-folders.js`
- Test: `tests/drive-doc-folders.test.js`

**Interfaces:**
- Produces:
  - `driveFolderForDocKey(docKey: string) → string | null` — folder name for a known key (`alt_supervisor_cv_*` → `'Alternate Supervisor CV'`, ID keys → `'ID'`), else `null`.
  - `OTHER_FILES_FOLDER = 'Other Files'`, `ID_FOLDER = 'ID'`, `ALT_CV_FOLDER = 'Alternate Supervisor CV'`.
  - `folderNameForDoc(docKey) → string` — `driveFolderForDocKey(docKey) || OTHER_FILES_FOLDER`.
  - `DOC_FOLDER_NAMES` (object) for reference.

- [ ] **Step 1: Write the failing test** (`tests/drive-doc-folders.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { driveFolderForDocKey, folderNameForDoc, OTHER_FILES_FOLDER, ALT_CV_FOLDER, ID_FOLDER } from '../lib/drive-doc-folders.js';

describe('driveFolderForDocKey', () => {
  it('maps GP-Link prepared docs to their app labels', () => {
    expect(driveFolderForDocKey('sppa_00')).toBe('SPPA-00');
    expect(driveFolderForDocKey('section_g')).toBe('Section G');
    expect(driveFolderForDocKey('position_description')).toBe('Position description');
    expect(driveFolderForDocKey('supervisor_cv')).toBe('Supervisor CV');
  });
  it('uses a Drive-safe name for offer/contract (no bare slash)', () => {
    expect(driveFolderForDocKey('offer_contract')).toBe('Offer / Contract');
  });
  it('maps every alt-supervisor CV (any index) to one folder', () => {
    expect(driveFolderForDocKey('alt_supervisor_cv_1')).toBe(ALT_CV_FOLDER);
    expect(driveFolderForDocKey('alt_supervisor_cv_2')).toBe(ALT_CV_FOLDER);
    expect(ALT_CV_FOLDER).toBe('Alternate Supervisor CV');
  });
  it('maps candidate-prepared + institution docs to their labels', () => {
    expect(driveFolderForDocKey('primary_medical_degree')).toBe('Primary medical degree');
    expect(driveFolderForDocKey('cv_signed_dated')).toBe('Signed CV');
    expect(driveFolderForDocKey('mrcgp_certified')).toBe('MRCGP certificate');
    expect(driveFolderForDocKey('certificate_good_standing')).toBe('Certificate of good standing');
    expect(driveFolderForDocKey('criminal_history')).toBe('Criminal history check');
  });
  it('maps ID/identity keys to the ID folder', () => {
    expect(driveFolderForDocKey('id_document')).toBe(ID_FOLDER);
    expect(ID_FOLDER).toBe('ID');
  });
  it('returns null for unknown/empty keys', () => {
    expect(driveFolderForDocKey('something_else')).toBeNull();
    expect(driveFolderForDocKey('')).toBeNull();
    expect(driveFolderForDocKey(null)).toBeNull();
  });
  it('folderNameForDoc falls back to Other Files', () => {
    expect(folderNameForDoc('sppa_00')).toBe('SPPA-00');
    expect(folderNameForDoc('mystery')).toBe(OTHER_FILES_FOLDER);
    expect(OTHER_FILES_FOLDER).toBe('Other Files');
  });
  it('no folder name contains a bare slash', () => {
    Object.values(require('../lib/drive-doc-folders.js').DOC_FOLDER_NAMES).forEach((n) => {
      expect(/\S\/\S/.test(n)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `… vitest.mjs run tests/drive-doc-folders.test.js` → FAIL (module not found).

- [ ] **Step 3: Write `lib/drive-doc-folders.js`**

```js
'use strict';

// document_key → Drive folder name. Names match the labels the GP Link app shows
// on each document card, sanitised to be Drive-safe (no bare "/").
const DOC_FOLDER_NAMES = {
  // GP-Link-prepared (AHPRA pack)
  sppa_00: 'SPPA-00',
  section_g: 'Section G',
  position_description: 'Position description',
  offer_contract: 'Offer / Contract',
  supervisor_cv: 'Supervisor CV',
  // Candidate-prepared
  primary_medical_degree: 'Primary medical degree',
  cv_signed_dated: 'Signed CV',
  mrcgp_certified: 'MRCGP certificate',
  cct_certified: 'CCT certificate',
  micgp_certified: 'MICGP certificate',
  cscst_certified: 'CSCST certificate',
  icgp_confirmation_letter: 'ICGP confirmation letter',
  frnzcgp_certified: 'FRNZCGP certificate',
  rnzcgp_confirmation_letter: 'RNZCGP confirmation letter',
  // Institution / AHPRA direct
  certificate_good_standing: 'Certificate of good standing',
  criminal_history: 'Criminal history check',
  confirmation_training: 'Confirmation of training',
};

const OTHER_FILES_FOLDER = 'Other Files';
const ID_FOLDER = 'ID';
const ALT_CV_FOLDER = 'Alternate Supervisor CV';

function driveFolderForDocKey(docKey) {
  var key = String(docKey || '').trim().toLowerCase();
  if (!key) return null;
  if (/^alt_supervisor_cv(_\d+)?$/.test(key)) return ALT_CV_FOLDER;
  if (key === 'id_document' || key === 'identity' || key === 'id_copy' || key === 'id') return ID_FOLDER;
  return DOC_FOLDER_NAMES[key] || null;
}

function folderNameForDoc(docKey) {
  return driveFolderForDocKey(docKey) || OTHER_FILES_FOLDER;
}

module.exports = { DOC_FOLDER_NAMES, OTHER_FILES_FOLDER, ID_FOLDER, ALT_CV_FOLDER, driveFolderForDocKey, folderNameForDoc };
```

- [ ] **Step 4: Run test to verify it passes** — expect PASS (all).
- [ ] **Step 5: `node --check lib/drive-doc-folders.js`; commit** (`git add lib/drive-doc-folders.js tests/drive-doc-folders.test.js && git commit`).

> NOTE for implementer: verify the real identity-doc `document_key` against `git show origin/main:server.js` (search `id_copy`, `id_document`, `GP_DOCUMENT_META`) and include the actual key(s) in the ID branch; keep the unit test for whichever key(s) are real.

---

### Task 2: Drive primitive + per-case organiser in `server.js`

**Files:**
- Modify: `server.js` (add functions near `reconcileGpDrive`, ~line 594; add the `require` near the other lib requires, ~line 121).

**Interfaces:**
- Consumes: `driveFolderForDocKey`, `folderNameForDoc`, `OTHER_FILES_FOLDER`, `ID_FOLDER` from Task 1; existing `ensureGPDriveFolder`, `getGoogleDriveClient`, `createPrivateDriveFolder`, `isGoogleDriveConfigured`, `supabaseDbRequest`.
- Produces:
  - `async fileDocOnDrive(caseId, docKey, driveFileId) → bool` — move one file into its doc folder (idempotent, best-effort).
  - `async organizeCaseDrive(caseId) → {moved, skipped}` — sweep one case's files into folders + leftovers to `Other Files`.

- [ ] **Step 1: Add the require** near `const altCvRecover = require('./lib/alt-supervisor-cv-recover.js');`:
  `const driveDocFolders = require('./lib/drive-doc-folders.js');`

- [ ] **Step 2: Implement `ensureDocTypeSubfolder(candidateFolderId, folderName, cache, ownerOnly)`** — `drive.files.list` for a folder named `folderName` under `candidateFolderId`; if absent, `createPrivateDriveFolder(folderName, candidateFolderId)` (the `ID` folder uses the owner-only sharing path used for ID docs today). Cache by `folderName` in the passed Map. Return the folder id.

- [ ] **Step 3: Implement `placeDriveFileInFolder(drive, driveFileId, targetFolderId)`** — `drive.files.get({fileId, fields:'parents'})`; if `parents` already includes `targetFolderId`, return false (no-op); else `drive.files.update({fileId, addParents: targetFolderId, removeParents: (parents||[]).join(',')})`; return true. Wrap in try/catch → log + return false.

- [ ] **Step 4: Implement `fileDocOnDrive(caseId, docKey, driveFileId)`** — guard (`isGoogleDriveConfigured`, ids present); resolve candidate folder via `ensureGPDriveFolder(caseId)`; `folderNameForDoc(docKey)`; `ensureDocTypeSubfolder`; `placeDriveFileInFolder`. Best-effort.

- [ ] **Step 5: Implement `organizeCaseDrive(caseId)`** — resolve candidate folder; list its direct children once; build a `fileId→isFolder` set and the set of top-level file ids; for each `user_documents` row (case's user) with `google_drive_file_id` and each practice-pack `task`/`task_documents` row with `google_drive_file_id` + resolvable docKey (`related_document_key`), call `fileDocOnDrive` (only moves if currently at root); then any remaining top-level **file** id not matched → move into `Other Files`. Idempotent + column-free; log a one-line summary.

- [ ] **Step 6: `node --check server.js`; run full suite (must stay green — no new unit test for this task: it needs live Drive creds, covered by Task 1's pure tests + node --check + prod verification); commit.**

---

### Task 3: File new documents at delivery

**Files:**
- Modify: `server.js` delivery sites: `deliverToMyDocuments` (~981), `/alt-cv-submit` (~38869), practice-pack task submit (~36170), `deliverOfferContract` (~1546), `/api/prepared-documents` (~32935), `_uploadSppaDocToDrive` (~1060). Verify each anchor against `git show origin/main:server.js` first.

**Interfaces:**
- Consumes: `fileDocOnDrive` (Task 2).

- [ ] **Step 1:** After each site stores a `google_drive_file_id`, add `await fileDocOnDrive(caseId, docKey, fileId).catch(function(){});` (docKey = the doc's key, or the task's `related_document_key`). For `/alt-cv-submit`, REPLACE the hard-coded `Alternative Supervisor CVs` subfolder creation/upload with: upload to the candidate folder as before, then `fileDocOnDrive(caseId, altDocKey, cvDriveFile.id)` (routes to canonical `Alternate Supervisor CV`).
- [ ] **Step 2:** `node --check server.js`; full suite green; commit.

> Each site already has `caseId`/`userId`→case and the docKey in scope (or the task's `related_document_key`). Keep changes minimal and best-effort.

---

### Task 4: Daily cron + on-view safety net

**Files:**
- Modify: `server.js` (new `GET /api/cron/organize-drive` next to `/api/cron/process-gmail`; one call inside `reconcileGpDrive`).
- Modify: `vercel.json` (`crons` array).

**Interfaces:**
- Consumes: `organizeCaseDrive` (Task 2).

- [ ] **Step 1:** Add `GET /api/cron/organize-drive` — auth `String(process.env.CRON_SECRET || process.env.ZOHO_RECRUIT_SYNC_CRON_SECRET||'').trim()` Bearer check (mirror `/api/cron/process-gmail`); query `registration_cases` with `google_drive_folder_id=not.is.null` (limit 500); `for` each → `organizeCaseDrive(case.id)` in try/catch; return `{ok:true, organized, errors}`.
- [ ] **Step 2:** In `reconcileGpDrive(caseId)`, after the lifecycle/mirror steps, add `try { await organizeCaseDrive(caseId); } catch (e) { console.error('[reconcileGpDrive] organize failed:', e.message); }` (cheap on-view safety net).
- [ ] **Step 3:** `vercel.json` → add `{ "path": "/api/cron/organize-drive", "schedule": "0 3 * * *" }` to `crons`.
- [ ] **Step 4:** `node --check server.js`; full suite green; commit.

---

### Task 5: Keep the admin Documents view working (find files by id, list Other Files)

**Files:**
- Modify: `server.js` `/api/admin/gp-documents` (~35026): the GP-Link + candidate + institution card builders, and add an `Other Files` folder listing.

**Interfaces:**
- Consumes: existing `getGoogleDriveClient`; the alt-CV fetch-by-id fallback already added (~35224) as the pattern.

- [ ] **Step 1:** Generalise the fetch-by-id fallback to ALL cards: when a card has a known `google_drive_file_id` (from `user_documents`/`task_documents`) not present in the top-level `gdDriveFiles`, fetch it via `drive.files.get({fileId, fields:'id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink'})` and use it as the card's `drive_file`. (Refactor the alt-CV block's fetch into a small local helper and reuse.)
- [ ] **Step 2:** For the "Other files" section: also list the `Other Files` subfolder's children (if it exists) and include them in `gdOtherFiles`.
- [ ] **Step 3:** `node --check server.js`; full suite green; manually trace the data shape (cards still carry `drive_file` with `thumbnailLink/webViewLink`); commit.

---

## Self-Review

- **Spec coverage:** lib map (T1) ✓; primitive + organiser (T2) ✓; delivery filing (T3) ✓; daily cron + reconcile safety net (T4) ✓; render generalisation + Other Files (T5) ✓; permissions (T2 ensureDocTypeSubfolder ownerOnly for ID) ✓; existing-file migration (T2 organizeCaseDrive + T4 cron) ✓.
- **Placeholder scan:** none — code given for the pure module; integration tasks specify exact functions/anchors + best-effort pattern (anchors flagged "verify against origin/main" because the local tree is stale).
- **Type consistency:** `fileDocOnDrive(caseId, docKey, driveFileId)` and `organizeCaseDrive(caseId)` names/params consistent across T2–T4; `folderNameForDoc`/`driveFolderForDocKey` consistent T1↔T2.

## Verification (post-deploy, stated honestly — Drive moves need live creds not available locally)

- Trigger: open Smith Miller's Documents tab (runs reconcile→organize) or wait for the daily cron.
- Confirm in Google Drive: `Dr Smith Miller/` shows `SPPA-00/`, `Position description/`, `Supervisor CV/`, `Alternate Supervisor CV/`, etc., each containing its file; unrecognised files in `Other Files/`.
- Confirm the app: admin Documents view still shows previews + Replace for every card.
