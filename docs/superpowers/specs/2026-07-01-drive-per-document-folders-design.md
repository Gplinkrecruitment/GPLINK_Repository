# Per-Document Google Drive Folders — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation

## Goal

Organise each candidate's Google **Drive** folder so every document type sits in
its **own subfolder named after the app's document label** (e.g. `SPPA-00`,
`Position description`, `Supervisor CV`). Anything that doesn't match a known
document type goes in an `Other Files` folder. This is about the **real Drive
structure** — visible when you open Drive directly — kept organised **by Drive
itself (delivery + a daily sweep), independent of whether anyone opens the app.**

Approved decisions (from brainstorming):
- **Scope:** every document type gets its own folder, **plus** an `Other Files`
  catch-all.
- **Existing files:** move existing files into folders too (not just new ones).
- **Trigger:** organise on Drive itself — at delivery (immediate) **and** via a
  daily background sweep (app-independent) — not tied to opening the app profile.

## Resulting Drive structure

```
<lifecycle: Users | Candidates | Archived>/
  Dr <First> <Last>/                         (existing candidate folder)
    SPPA-00/                                 → SPPA-00 *.pdf
    Section G/
    Position description/
    Offer / Contract/
    Supervisor CV/
    Alternate Supervisor CV/                 → CV Dr Ahmed Mahmoud.pdf, ...
    Primary medical degree/
    Signed CV/
    MRCGP certificate/  CCT certificate/  MICGP certificate/  CSCST certificate/
    ICGP confirmation letter/  FRNZCGP certificate/  RNZCGP confirmation letter/
    Certificate of good standing/  Criminal history check/  Confirmation of training/
    ID/                                      → ID — <identity doc> (owner-only)
    Other Files/                             → anything not matching a known doc
```

Subfolders are created **lazily** — only when a file needs to go in one — so a
candidate's folder only contains folders for documents they actually have.

## Components

### 1. `lib/drive-doc-folders.js` (new, pure, unit-tested)

Single source of truth mapping a `document_key` → Drive folder name, derived from
the labels the app already shows so the folder name always matches the card.

- `DOC_FOLDER_NAMES`: `{ sppa_00: 'SPPA-00', section_g: 'Section G',
  position_description: 'Position description', offer_contract: 'Offer / Contract',
  supervisor_cv: 'Supervisor CV', primary_medical_degree: 'Primary medical degree',
  cv_signed_dated: 'Signed CV', mrcgp_certified: 'MRCGP certificate', ... }` (full
  set incl. IE/NZ variants + institution docs).
- `OTHER_FILES_FOLDER = 'Other Files'`, `ID_FOLDER = 'ID'`,
  `ALT_CV_FOLDER = 'Alternate Supervisor CV'`.
- `driveFolderForDocKey(docKey)`:
  - `alt_supervisor_cv_*` → `Alternate Supervisor CV`
  - identity/ID doc keys → `ID`
  - known key → its `DOC_FOLDER_NAMES` entry
  - unknown / falsy → `null` (caller routes to `Other Files`)
- `sanitizeDriveFolderName(name)`: trims, collapses whitespace; the map already
  bakes Drive-safe names (e.g. `Offer / Contract`, not a bare `Offer/contract`).

No I/O here — just the mapping + helpers, so it can be tested without Drive creds.

### 2. The shared "file this Drive file into its document folder" primitive (server.js)

- `ensureDocTypeSubfolder(candidateFolderId, folderName, cache)` — find-or-create a
  subfolder under the candidate folder. Team-domain shared like the candidate folder
  (`createPrivateDriveFolder`); the `ID` folder is owner-only (mirrors today's
  `id_private` ID handling). In-request `cache` (Map of `folderName`→id) avoids
  duplicate lookups/creates within one sweep.
- `placeDriveFileInFolder(driveFileId, targetFolderId, currentParentIds)` — move the
  file into the target subfolder via `drive.files.update({ addParents, removeParents })`.
  **Idempotent:** if the file's current parent already is the target, do nothing.
  Moving does **not** change the file's own sharing/permissions.
- `fileDocOnDrive(caseId, docKey, driveFileId)` — the single entry point used
  everywhere: resolve the candidate folder (`ensureGPDriveFolder`), resolve the
  folder name (`driveFolderForDocKey(docKey)` || `Other Files`), ensure the subfolder,
  move the file. Best-effort + logged; never throws into the caller.

### 3. New documents — file at delivery (immediate)

After each delivery stores a `google_drive_file_id`, call `fileDocOnDrive(caseId,
docKey, fileId)` so the file lands in its folder on Drive the moment it arrives.
Call sites (from the code map): `deliverToMyDocuments` (981), `/alt-cv-submit`
(38869), the practice-pack task submit (36170), `deliverOfferContract` (1546),
`/api/prepared-documents` (32935), `_uploadSppaDocToDrive` (1060). These already
know the `docKey` (or the task's `related_document_key`). `/alt-cv-submit` stops
hard-coding the `Alternative Supervisor CVs` subfolder and routes through
`fileDocOnDrive` (canonical `Alternate Supervisor CV`).

### 4. Existing files + safety net — `organizeCaseDrive(caseId)` + daily cron

`organizeCaseDrive(caseId)` (server.js), idempotent and column-free:
1. Resolve the candidate folder; list its folder tree once (direct children + each
   existing subfolder's children) → build `fileId → currentParentId`.
2. For every `user_documents` row (this case's user) with a `google_drive_file_id`,
   and every `task_documents`/practice-pack row with a `google_drive_file_id`
   (docKey via the task's `related_document_key`), `fileDocOnDrive(...)` — but only
   actually move when `currentParentId` is the candidate root (skip already-filed).
3. Any remaining **top-level file** (not a folder, not matched to a known doc) →
   move into `Other Files`.

`GET /api/cron/organize-drive` — iterates active/candidate cases (those with a
`google_drive_folder_id`) and runs `organizeCaseDrive` for each. Same cron auth as
the other crons (`CRON_SECRET || ZOHO_RECRUIT_SYNC_CRON_SECRET`). Added to
`vercel.json` `crons` (daily, e.g. `0 3 * * *`). This is the **app-independent**
guarantee. `reconcileGpDrive` also calls `organizeCaseDrive(caseId)` as a cheap
on-view safety net (no extra trigger needed, idempotent).

### 5. Keep the app's Documents view working (don't break it)

`/api/admin/gp-documents` currently matches cards to files by listing only the
top-level folder (+ a recent fetch-by-id fallback for alt-CVs). Generalise: resolve
each card's Drive file by its stored `google_drive_file_id` (fetch-by-id) regardless
of which subfolder it's in — the alt-CV pattern, applied to all doc types. List the
`Other Files` subfolder for the "Other files" section. (Folder-agnostic; the
candidate-facing My Documents page already builds its URL from
`google_drive_file_id`, so it's unaffected.)

## Permissions / sharing

- Subfolders: team-domain visible (`createPrivateDriveFolder`), matching the
  candidate folder, so RSOs/CEO see them.
- `ID` folder: owner-only, preserving today's ID privacy.
- File sharing is untouched by a move (Drive moves are metadata-only).

## Edge cases

- `Offer / Contract` folder name (avoid a bare `/`).
- Alt-CV consolidation: the canonical folder is `Alternate Supervisor CV`; existing
  files in the old `Alternative Supervisor CVs` folder are moved into it on the next
  sweep. The now-empty old folder is left in place (harmless; cleanup is out of scope).
- Files with no DB record (manually dropped) → `Other Files`.
- Never move folders, only files; never move a file already in its target folder.
- Drive API failure on any one file is logged and skipped — never blocks delivery or
  the rest of the sweep.

## Testing

- Unit tests (`tests/drive-doc-folders.test.js`) for `lib/drive-doc-folders.js`:
  every known key maps to the expected label; `alt_supervisor_cv_2` →
  `Alternate Supervisor CV`; unknown/empty → `null`; ID keys → `ID`; folder names are
  Drive-safe (no bare `/`).
- `node --check server.js`; full vitest suite stays green.
- Drive moves themselves need live Google creds (not available locally) — verified in
  prod after deploy by opening a candidate's Drive folder and by the cron run; this is
  stated explicitly, not asserted as auto-tested.

## Rollout

1. Ship code (lib + server primitive + delivery hooks + `organizeCaseDrive` + cron +
   render generalisation + `vercel.json` cron).
2. The daily cron organises every candidate within a day; opening any candidate's
   Documents tab organises that one immediately (reconcile). New deliveries file
   themselves at once.
3. Verify in prod: Smith Miller's Drive folder shows per-document subfolders with the
   files inside; the app Documents view still shows previews/Replace for every card.

## Out of scope

- Deleting the old empty `Alternative Supervisor CVs` folders.
- Reorganising the lifecycle (Users/Candidates/Archived) structure — unchanged.
- Candidate-facing My Documents page UI changes — unaffected (folder-agnostic).
