# Design — Google Drive Lifecycle Folders (Users → Candidates → Archived)

**Date:** 2026-06-22
**Status:** Design (awaiting approval)
**Author:** Claude + hello@mygplink.com.au

## 1. Goal

Organise the GP Link Google Drive so every GP's documents live in a single personal
folder that moves through their lifecycle, and so that **accepted** registration
documents (including ID) are archived to Drive automatically — with privacy
controls appropriate to the document type.

Lifecycle (a GP's personal folder moves between three parents):

```
GP Candidate Documents/            (existing root = GOOGLE_DRIVE_ROOT_FOLDER_ID)
├── Users/        ← personal folder created here at signup
├── Candidates/   ← moves here when the GP is placed in a practice
└── Archived/     ← moves here when the GP deletes (archives) their account
```

## 2. Folder structure

- Three **lifecycle folders** created once under the existing root: `Users`, `Candidates`, `Archived`.
- Each GP keeps **one personal folder** named `Dr <First> <Last>` (existing naming via
  `ensureGPDriveFolder`). It physically moves between the three lifecycle folders; it is never
  duplicated. `registration_cases.google_drive_folder_id` continues to hold its Drive ID.
- A new column **`registration_cases.drive_folder_stage`** (`'users' | 'candidates' | 'archived'`)
  records which lifecycle folder the personal folder currently sits in, so we can move it
  correctly without querying Drive on every request.

## 3. Lifecycle triggers

| Event | Hook (origin/main) | Action |
|---|---|---|
| **Signup / case created** | `_ensureRegCase` (already creates the folder per fix 9a3651c) | Create personal folder **inside `Users/`**; set `drive_folder_stage='users'`. |
| **Document accepted** | see §4 | Mirror the accepted file into the GP's personal folder. |
| **Placed in a practice** | placement-secured transition in `processRegistrationTaskAutomation` (the `!prevSecured && nextSecured` block that already creates the folder + practice pack) | Move personal folder `Users → Candidates`; set stage `'candidates'`. |
| **Account deleted (archived)** | `archiveUserAccount(userId, reason)` (sets `account_status='archived'`, `purge_after`) | Move personal folder → `Archived`; set stage `'archived'`. |
| **Account reinstated** | `reinstateUserAccount(userId)` | Move folder back to `Candidates` if placement secured, else `Users`; set stage accordingly. |
| **Account purged (90-day cron)** | existing purge path | **Keep** the folder in `Archived` (no Drive deletion). Decided. |

**Self-healing reconcile.** A single `reconcileGpDrive(caseId)` function makes the live state
match the case: ensures the lifecycle folders exist, ensures the personal folder exists and is
under the correct parent for the case's status, and mirrors any not-yet-synced accepted documents
(§4). It is called from each trigger above **and** from `/api/admin/gp-documents` (when an admin
opens a GP's Documents tab). This makes the feature self-correcting and is how existing GPs get
backfilled (§6) — no separate migration script required.

## 4. Document mirroring ("accepted only")

**Definition of "accepted":** a document that has either (a) passed the AI scan at upload, or
(b) been manually approved by an RSO/admin. Explicitly **excluded:** failed/rejected upload
attempts and documents still pending manual review.

- In `user_documents`, accepted ≈ `status = 'approved'`, plus AI-passed uploads (to be mapped
  precisely against the upload/verify flow during implementation — the certification verify path
  `/api/ai/verify-certification` and `ensureDocReviewOnUpload`). Rejected (`status='rejected'`) and
  in-review documents are never mirrored.
- Documents already pushed to Drive on approval (`deliverToMyDocuments`, `uploadDocumentToDrive`,
  doc-review approve) continue to work — they will now target the personal folder under
  `Users/Candidates` and use the new permission model (§5).
- **The gap this closes:** AI-accepted registration uploads that never went through manual approval
  are currently *not* in Drive. `reconcileGpDrive` mirrors every accepted `user_documents` row that
  lacks a `google_drive_file_id` into the personal folder.
- **ID document:** ID is captured at onboarding and is **not** a normal `user_documents` row (it
  lives on the profile / ID-verification, e.g. `user_profiles.id_copy_*`). The reconcile pulls the
  accepted ID from its actual source and uploads it as `ID.<ext>` with ID-only permissions (§5).
  Exact ID source confirmed during implementation.

## 5. Permissions (per-document)

Today every Drive file/folder is shared `{ role: 'reader', type: 'anyone' }` (server.js ~397/426) —
i.e. anyone with the link. The new model removes public sharing for these documents and shares per
document type:

- **ID document → only `hello@mygplink.com.au`** (`type: 'user', emailAddress: 'hello@mygplink.com.au', role: 'reader'`). No domain, no anyone.
- **All other documents → the `mygplink.com.au` domain** (`type: 'domain', domain: 'mygplink.com.au', role: 'reader'`) so any RSO with an `@mygplink.com.au` account can open them. **Fallback** if `mygplink.com.au` is not a Google Workspace domain (domain sharing unsupported): share each non-ID file with the known RSO `@mygplink.com.au` emails (from `rso_team` / `va_gmail_accounts`).
- **Folders** (`Users/Candidates/Archived` and each personal folder): owned by the service account,
  shared with `hello@mygplink.com.au` (so the owner can browse). **Not** domain-shared.

**Why file-level, not folder-level:** in Drive a file cannot be *more* private than its parent
folder. If a personal folder were domain-shared, the ID inside it would inherit domain access and
could not be hidden. Keeping folders private and sharing **non-ID files individually** with the
domain keeps the ID hidden (hello@ only) while RSOs still open the other documents via the links the
app already surfaces (`webViewLink` in the Documents panel). RSOs access documents through the
app/links, not by browsing Drive directly.

The service account always retains access (it owns the files), so the app continues to read/serve
documents to authorised admins regardless of these sharing settings.

## 6. Migration / backfill of existing GPs

No standalone migration script. `reconcileGpDrive` backfills on first trigger/view:

- **Smith Miller** (placement secured) → personal folder moved to `Candidates`, accepted docs mirrored.
- **Sana Ahsan** (signed up, not placed) → personal folder under `Users`, accepted docs mirrored.
- Any archived accounts → `Archived`.

Because reconcile runs when an admin opens a GP's Documents tab (and on the lifecycle hooks),
existing GPs are corrected the next time they're touched. A one-off "reconcile all" admin action
may be added to force it across all cases at once.

## 7. New / changed code (origin/main)

- **DB:** add `registration_cases.drive_folder_stage text` (migration via `exec_sql`).
- **New helpers:**
  - `ensureLifecycleFolders()` → ensures `Users/Candidates/Archived` exist under root, returns/caches their IDs.
  - `moveDriveFolder(folderId, toParentId, fromParentId?)` → `drive.files.update({ addParents, removeParents })`.
  - `shareDriveFile(fileId, mode)` where mode ∈ {`id_private` (hello@ only), `team_domain` (domain or RSO-email fallback)} — replaces the blanket `anyone` permission for lifecycle docs.
  - `reconcileGpDrive(caseId)` → orchestrates folder placement + accepted-doc mirroring.
- **Changed:**
  - `ensureGPDriveFolder` → create the personal folder under `Users/` (not root) for new folders; keep returning existing folder ids unchanged.
  - Placement transition, `archiveUserAccount`, `reinstateUserAccount` → call the move + stage update (via `reconcileGpDrive`).
  - `/api/admin/gp-documents` → call `reconcileGpDrive` (replaces the simpler "ensure folder" backfill from 9a3651c).
  - Document upload/approve paths → ensure accepted docs are mirrored with the §5 permissions (reuse reconcile).

## 8. Constraints, risks, verification

- **No Google credentials locally.** All Drive operations (create lifecycle folders, move folders,
  upload, set permissions) run **only on the deployed server**. Implementation is code → syntax-check
  with a downloaded node (`node --check server.js`) → push to `origin/main` → Vercel deploy. Verify by
  DB (`drive_folder_stage`, `google_drive_file_id`) and by you confirming in Drive. The full Drive
  behaviour cannot be exercised locally.
- **Privacy:** ID is mirrored to Drive (hello@-only). This is an intentional, explicit choice.
- **Domain-sharing assumption:** `team_domain` sharing assumes `mygplink.com.au` is a Google Workspace
  domain; fallback shares with explicit RSO emails.
- **Drive inheritance:** folders kept private so ID privacy holds (see §5).
- **Backfill cost:** reconcile uploads each accepted doc once (skips docs that already have a
  `google_drive_file_id`); idempotent.

## 9. Out of scope (YAGNI)

- No change to in-app document viewing (service account keeps serving docs to admins).
- No re-mirroring of historically rejected/failed uploads.
- No change to the 90-day purge of the **account** itself; only specifying that the Drive folder is kept.
- No UI for browsing the lifecycle folders inside the admin app (RSOs use existing Documents panel + links).
