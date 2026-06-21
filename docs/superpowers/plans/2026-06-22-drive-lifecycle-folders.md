# Google Drive Lifecycle Folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organise the GP Link Google Drive so each GP's personal folder lives under `Users/`, moves to `Candidates/` on placement and `Archived/` on account deletion, and accepted registration documents (incl. ID) are mirrored there with per-document privacy.

**Architecture:** Pure lifecycle decisions live in a new testable module `lib/drive-lifecycle.js`. All Google Drive I/O stays in `server.js` as thin helpers. A single idempotent `reconcileGpDrive(caseId)` makes Drive match the case's lifecycle (folder placement + accepted-doc mirroring + permissions), called from lifecycle hooks and the admin documents view.

**Tech Stack:** Node (CommonJS) `server.js`, `googleapis` Drive v3, Supabase REST (`supabaseDbRequest`) + Storage, vitest.

## Global Constraints

- Work against **origin/main** in worktree `worktree-drive-lifecycle-folders` (local checkout is stale — ~3k lines behind). Read deployed code with the worktree's files.
- **No Google credentials locally.** Drive I/O cannot be run or unit-tested here. Server-side tasks verify with `node --check server.js` (use the downloaded node at `$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node`) + careful review; runtime behaviour is verified only after deploy to prod (DB columns + you confirming in Drive). Do NOT fabricate Drive test results.
- Lifecycle folder names exactly: `Users`, `Candidates`, `Archived` (under existing root `GOOGLE_DRIVE_ROOT_FOLDER_ID`).
- "Accepted" = `user_documents.status === 'approved'` (covers AI-accepted-on-upload and manual approval). Never mirror `rejected`/`uploaded`/in-review docs.
- ID source = `user_profiles.id_copy_data_url` (data URL) + `id_copy_name`. ID permission = hello@mygplink.com.au only. All other docs = `mygplink.com.au` domain (fallback: explicit RSO emails).
- Remove `{ type:'anyone' }` sharing for lifecycle documents/folders; never make ID `anyone`-readable.
- **No new DB columns** (the Supabase `exec_sql` RPC does not exist; DDL is applied manually in the dashboard, which is not available here). All state is derived from Drive + existing columns: folder location from the personal folder's current Drive parent; per-doc mirror idempotency from the existing `user_documents.google_drive_file_id`; ID idempotency from a folder listing (ID file named with the `ID — ` prefix).
- Owner email constant: `hello@mygplink.com.au`. Team domain: `mygplink.com.au`.
- Commit after each task. Push to `origin/main` only in the final task (after full syntax check).

---

### Task 1: Pure lifecycle module (`lib/drive-lifecycle.js`) + tests

**Files:**
- Create: `lib/drive-lifecycle.js`
- Test: `tests/drive-lifecycle.test.js`

**Interfaces:**
- Produces: `LIFECYCLE_FOLDER_NAMES` (`{users:'Users',candidates:'Candidates',archived:'Archived'}`), `stageForCase({accountStatus, placementSecured}) -> 'users'|'candidates'|'archived'`, `isAcceptedStatus(status) -> boolean`.

- [ ] **Step 1: Write the failing test**

```js
// tests/drive-lifecycle.test.js
import { describe, it, expect } from 'vitest';
import { stageForCase, isAcceptedStatus, LIFECYCLE_FOLDER_NAMES } from '../lib/drive-lifecycle.js';

describe('stageForCase', () => {
  it('archived account → archived regardless of placement', () => {
    expect(stageForCase({ accountStatus: 'archived', placementSecured: true })).toBe('archived');
    expect(stageForCase({ accountStatus: 'archived', placementSecured: false })).toBe('archived');
  });
  it('placement secured (not archived) → candidates', () => {
    expect(stageForCase({ accountStatus: 'active', placementSecured: true })).toBe('candidates');
  });
  it('signed up, not placed, not archived → users', () => {
    expect(stageForCase({ accountStatus: 'active', placementSecured: false })).toBe('users');
    expect(stageForCase({})).toBe('users');
  });
});

describe('isAcceptedStatus', () => {
  it('only approved counts as accepted', () => {
    expect(isAcceptedStatus('approved')).toBe(true);
    expect(isAcceptedStatus('Approved')).toBe(true);
    expect(isAcceptedStatus('uploaded')).toBe(false);
    expect(isAcceptedStatus('under_review')).toBe(false);
    expect(isAcceptedStatus('rejected')).toBe(false);
    expect(isAcceptedStatus('')).toBe(false);
    expect(isAcceptedStatus(null)).toBe(false);
  });
});

describe('LIFECYCLE_FOLDER_NAMES', () => {
  it('exact names', () => {
    expect(LIFECYCLE_FOLDER_NAMES).toEqual({ users: 'Users', candidates: 'Candidates', archived: 'Archived' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" node_modules/vitest/vitest.mjs run tests/drive-lifecycle.test.js`
Expected: FAIL — cannot resolve `../lib/drive-lifecycle.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/drive-lifecycle.js
'use strict';

const LIFECYCLE_FOLDER_NAMES = Object.freeze({
  users: 'Users',
  candidates: 'Candidates',
  archived: 'Archived',
});

// Which lifecycle folder a GP's personal folder belongs in.
function stageForCase({ accountStatus, placementSecured } = {}) {
  if (String(accountStatus || '').toLowerCase() === 'archived') return 'archived';
  if (placementSecured) return 'candidates';
  return 'users';
}

// AI-accepted-on-upload and manual approval both set user_documents.status='approved'.
function isAcceptedStatus(status) {
  return String(status || '').toLowerCase() === 'approved';
}

module.exports = { LIFECYCLE_FOLDER_NAMES, stageForCase, isAcceptedStatus };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" node_modules/vitest/vitest.mjs run tests/drive-lifecycle.test.js`
Expected: PASS (3 suites).

- [ ] **Step 5: Commit**

```bash
git add lib/drive-lifecycle.js tests/drive-lifecycle.test.js
git commit -m "Add pure drive-lifecycle helpers (stage + accepted-status) with tests"
```

---

### Task 2: REMOVED — column-free design

No DB migration. The `exec_sql` RPC does not exist and DDL cannot be applied from here. Folder location and idempotency are derived from Drive + the existing `user_documents.google_drive_file_id` column (see Global Constraints and Task 4). Skip this task entirely.

---

### Task 3: Private Drive I/O helpers in `server.js`

Add near the other Drive helpers (after `deleteGoogleDriveFile`, before `ensureGPDriveFolder`). Require the lifecycle module at the top of server.js with the other requires.

**Files:**
- Modify: `server.js` (top requires; new helper functions in the Drive helper region ~lines 360–460 on origin/main).

**Interfaces:**
- Consumes: `getGoogleDriveClient()`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `isGoogleDriveConfigured()`, `supabaseDbRequest`, `LIFECYCLE_FOLDER_NAMES`.
- Produces:
  - `ensureLifecycleFolders() -> {users, candidates, archived}` (Drive folder ids; cached)
  - `createPrivateDriveFolder(name, parentId) -> {id,...}` (no `anyone` perm; shares reader with hello@)
  - `moveDriveFolder(folderId, toParentId) -> boolean`
  - `applyDriveDocPermissions(fileId, mode) -> void` where `mode ∈ {'id_private','team_domain'}`
  - `uploadPrivateToGoogleDrive(folderId, fileName, buffer, mimeType, mode) -> {id, webViewLink}`

- [ ] **Step 1: Add the require + constants** (top of server.js with other requires)

```js
const { LIFECYCLE_FOLDER_NAMES, stageForCase, isAcceptedStatus } = require('./lib/drive-lifecycle.js');
const GP_OWNER_EMAIL = 'hello@mygplink.com.au';
const GP_TEAM_DOMAIN = 'mygplink.com.au';
let _lifecycleFolderCache = null;
```

- [ ] **Step 2: Add the helper functions**

```js
// Create a folder WITHOUT public 'anyone' access; share read with the owner so they can browse.
async function createPrivateDriveFolder(folderName, parentFolderId) {
  const drive = await getGoogleDriveClient();
  if (!drive) return null;
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
    fields: 'id,name,webViewLink', supportsAllDrives: true,
  });
  try {
    await drive.permissions.create({
      fileId: folder.data.id, sendNotificationEmail: false, supportsAllDrives: true,
      requestBody: { type: 'user', role: 'reader', emailAddress: GP_OWNER_EMAIL },
    });
  } catch (e) { console.error('[Drive] owner share (folder) failed:', e.message); }
  return folder.data;
}

// Ensure Users/Candidates/Archived exist under the root; cache their ids.
async function ensureLifecycleFolders() {
  if (!isGoogleDriveConfigured()) return null;
  if (_lifecycleFolderCache) return _lifecycleFolderCache;
  const drive = await getGoogleDriveClient();
  if (!drive) return null;
  const out = {};
  for (const key of Object.keys(LIFECYCLE_FOLDER_NAMES)) {
    const name = LIFECYCLE_FOLDER_NAMES[key];
    const q = "name='" + name + "' and mimeType='application/vnd.google-apps.folder' and '"
      + GOOGLE_DRIVE_ROOT_FOLDER_ID + "' in parents and trashed=false";
    const res = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (res.data.files && res.data.files[0]) { out[key] = res.data.files[0].id; continue; }
    const created = await createPrivateDriveFolder(name, GOOGLE_DRIVE_ROOT_FOLDER_ID);
    out[key] = created ? created.id : null;
  }
  _lifecycleFolderCache = out;
  return out;
}

// Move a folder/file under a new parent (removing all current parents).
async function moveDriveFolder(folderId, toParentId) {
  if (!folderId || !toParentId) return false;
  const drive = await getGoogleDriveClient();
  if (!drive) return false;
  try {
    const cur = await drive.files.get({ fileId: folderId, fields: 'parents', supportsAllDrives: true });
    const prev = (cur.data.parents || []).join(',');
    await drive.files.update({ fileId: folderId, addParents: toParentId, removeParents: prev,
      fields: 'id,parents', supportsAllDrives: true });
    return true;
  } catch (e) { console.error('[Drive] move folder failed:', e.message); return false; }
}

// Apply per-document sharing. Removes any 'anyone' permission first.
async function applyDriveDocPermissions(fileId, mode) {
  const drive = await getGoogleDriveClient();
  if (!drive || !fileId) return;
  try {
    const perms = await drive.permissions.list({ fileId, fields: 'permissions(id,type)', supportsAllDrives: true });
    for (const p of (perms.data.permissions || [])) {
      if (p.type === 'anyone') { try { await drive.permissions.delete({ fileId, permissionId: p.id, supportsAllDrives: true }); } catch (e) {} }
    }
  } catch (e) { console.error('[Drive] perm list failed:', e.message); }
  try {
    if (mode === 'id_private') {
      await drive.permissions.create({ fileId, sendNotificationEmail: false, supportsAllDrives: true,
        requestBody: { type: 'user', role: 'reader', emailAddress: GP_OWNER_EMAIL } });
    } else {
      try {
        await drive.permissions.create({ fileId, sendNotificationEmail: false, supportsAllDrives: true,
          requestBody: { type: 'domain', role: 'reader', domain: GP_TEAM_DOMAIN } });
      } catch (domainErr) {
        // Fallback: share with each known RSO @mygplink.com.au account.
        const rso = await supabaseDbRequest('rso_team', 'select=email');
        const emails = (rso.ok && Array.isArray(rso.data) ? rso.data : [])
          .map(r => r && r.email).filter(e => e && /@mygplink\.com\.au$/i.test(e));
        for (const em of emails) {
          try { await drive.permissions.create({ fileId, sendNotificationEmail: false, supportsAllDrives: true,
            requestBody: { type: 'user', role: 'reader', emailAddress: em } }); } catch (e) {}
        }
      }
    }
  } catch (e) { console.error('[Drive] apply perms failed:', e.message); }
}

// Upload a file privately (no 'anyone'); then apply the document permission mode.
async function uploadPrivateToGoogleDrive(folderId, fileName, buffer, mimeType, mode) {
  const drive = await getGoogleDriveClient();
  if (!drive) return null;
  const { Readable } = require('stream');
  const media = { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) };
  const file = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] }, media,
    fields: 'id,name,webViewLink', supportsAllDrives: true,
  });
  await applyDriveDocPermissions(file.data.id, mode);
  return file.data;
}
```

- [ ] **Step 3: Syntax check**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" --check server.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Add private Drive helpers: lifecycle folders, move, per-doc permissions, private upload"
```

---

### Task 4: `ensureGPDriveFolder` under Users + `reconcileGpDrive`

**Files:**
- Modify: `server.js` — `ensureGPDriveFolder` (create new personal folders under `Users/`, private) and add `reconcileGpDrive`.

**Interfaces:**
- Consumes: Task 3 helpers, `stageForCase`, `isAcceptedStatus`, `supabaseDbRequest`, Supabase Storage download (`supabaseStorageDownloadObject`), `SUPABASE_DOCUMENT_BUCKET`.
- Produces: `reconcileGpDrive(caseId) -> void` (idempotent: ensures lifecycle folders, personal folder under correct parent, mirrors accepted docs + ID with correct permissions, updates `drive_folder_stage` + `drive_id_file_id`).

- [ ] **Step 1: Update `ensureGPDriveFolder` to place new folders under `Users/`**

Replace the folder-creation line so the parent is the Users lifecycle folder (falling back to root if lifecycle folders unavailable):

```js
// inside ensureGPDriveFolder, replacing: const folder = await createGoogleDriveFolder(folderName, GOOGLE_DRIVE_ROOT_FOLDER_ID);
const lifecycle = await ensureLifecycleFolders();
const parentId = (lifecycle && lifecycle.users) ? lifecycle.users : GOOGLE_DRIVE_ROOT_FOLDER_ID;
const folder = await createPrivateDriveFolder(folderName, parentId);
```
Keep the existing `google_drive_folder_id` PATCH unchanged (no new columns). Do NOT add `drive_folder_stage`.

- [ ] **Step 2: Add `reconcileGpDrive`**

```js
async function reconcileGpDrive(caseId) {
  try {
    if (!isGoogleDriveConfigured() || !caseId) return;
    const caseRes = await supabaseDbRequest('registration_cases',
      'select=id,user_id,google_drive_folder_id&id=eq.' + encodeURIComponent(caseId) + '&limit=1');
    const rc = caseRes.ok && caseRes.data && caseRes.data[0] ? caseRes.data[0] : null;
    if (!rc) return;
    const userId = rc.user_id;

    // account + placement status
    const stRes = await supabaseDbRequest('user_state', 'select=state&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const state = (stRes.ok && stRes.data && stRes.data[0] && typeof stRes.data[0].state === 'object') ? stRes.data[0].state : {};
    const accountStatus = String(state.account_status || '').toLowerCase();
    let career = state.gp_career_state; if (typeof career === 'string') { try { career = JSON.parse(career); } catch (e) { career = {}; } }
    career = career || {};
    const placementSecured = career.career_secured === true || career.secured === true ||
      (Array.isArray(career.applications) && career.applications.some(a => a && a.isPlacementSecured === true));
    const targetStage = stageForCase({ accountStatus, placementSecured });

    // profile (for folder name + ID)
    const profRes = await supabaseDbRequest('user_profiles',
      'select=first_name,last_name,id_copy_name,id_copy_data_url&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
    const prof = (profRes.ok && profRes.data && profRes.data[0]) ? profRes.data[0] : {};

    // ensure personal folder exists (creates under Users if new)
    let folderId = rc.google_drive_folder_id;
    if (!folderId) { folderId = await ensureGPDriveFolder(caseId, prof.first_name || '', prof.last_name || ''); }
    if (!folderId) return;

    const drive = await getGoogleDriveClient();
    if (!drive) return;

    // move to correct lifecycle parent if the folder is not already under it (location derived from Drive — no DB column)
    const lifecycle = await ensureLifecycleFolders();
    if (lifecycle && lifecycle[targetStage]) {
      try {
        const meta = await drive.files.get({ fileId: folderId, fields: 'parents', supportsAllDrives: true });
        const curParent = meta && meta.data && Array.isArray(meta.data.parents) ? meta.data.parents[0] : null;
        if (curParent !== lifecycle[targetStage]) await moveDriveFolder(folderId, lifecycle[targetStage]);
      } catch (e) { console.error('[reconcileGpDrive] parent check failed:', e.message); }
    }

    // mirror accepted user_documents lacking a Drive file (idempotent via existing google_drive_file_id)
    const docsRes = await supabaseDbRequest('user_documents',
      'select=id,document_key,file_name,status,storage_bucket,storage_path,file_url,mime_type,google_drive_file_id&user_id=eq.' + encodeURIComponent(userId));
    const docs = (docsRes.ok && Array.isArray(docsRes.data)) ? docsRes.data : [];
    for (const d of docs) {
      if (!isAcceptedStatus(d.status) || d.google_drive_file_id) continue;
      const path = d.storage_path || d.file_url; if (!path) continue;
      try {
        const dl = await supabaseStorageDownloadObject(d.storage_bucket || SUPABASE_DOCUMENT_BUCKET, path);
        if (!dl || !dl.buffer) continue;
        const up = await uploadPrivateToGoogleDrive(folderId, d.file_name || (d.document_key + '.pdf'), dl.buffer, d.mime_type || dl.mimeType || 'application/pdf', 'team_domain');
        if (up && up.id) await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(d.id), { method: 'PATCH', body: { google_drive_file_id: up.id } });
      } catch (e) { console.error('[reconcileGpDrive] doc mirror failed:', d.document_key, e.message); }
    }

    // mirror ID (hello@-only), once — idempotent via folder listing (file named "ID — …")
    if (prof.id_copy_data_url) {
      try {
        const list = await drive.files.list({ q: "'" + folderId + "' in parents and trashed=false", fields: 'files(id,name)', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true });
        const hasId = (list.data.files || []).some(f => /^ID — /.test(f.name || ''));
        if (!hasId) {
          const comma = prof.id_copy_data_url.indexOf(',');
          const head = prof.id_copy_data_url.substring(0, comma);
          const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
          const buf = Buffer.from(prof.id_copy_data_url.substring(comma + 1), 'base64');
          const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg');
          await uploadPrivateToGoogleDrive(folderId, 'ID — ' + (prof.id_copy_name || ('identity.' + ext)), buf, mime, 'id_private');
        }
      } catch (e) { console.error('[reconcileGpDrive] ID mirror failed:', e.message); }
    }
  } catch (err) { console.error('[reconcileGpDrive] error:', err.message); }
}
```

- [ ] **Step 3: Confirm `supabaseStorageDownloadObject` + `SUPABASE_DOCUMENT_BUCKET` names**

Run: `grep -nE "function supabaseStorageDownloadObject|SUPABASE_DOCUMENT_BUCKET\\s*=" server.js`
Expected: both exist. If the download fn has a different name/signature, adapt the call (it is used by the SPPA conflict scan at the `supabaseStorageDownloadObject(SUPABASE_DOCUMENT_BUCKET, storagePath)` call site — match that exactly).

- [ ] **Step 4: Syntax check**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" --check server.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "ensureGPDriveFolder creates under Users/; add idempotent reconcileGpDrive"
```

---

### Task 5: Wire lifecycle hooks + documents-view reconcile

**Files:**
- Modify: `server.js` — placement transition, `archiveUserAccount`, `reinstateUserAccount`, `/api/admin/gp-documents`.

**Interfaces:**
- Consumes: `reconcileGpDrive(caseId)`.

- [ ] **Step 1: Placement transition** — in `processRegistrationTaskAutomation`, inside the `!prevSecured && nextSecured` block, right after the existing `ensureGPDriveFolder(caseId, ...)` call, add:

```js
await reconcileGpDrive(caseId);
```

- [ ] **Step 2: Account archive** — at the end of `archiveUserAccount(userId, reason)` (after it sets `account_status='archived'`), look up the case and reconcile:

```js
try {
  const _arcCase = await supabaseDbRequest('registration_cases', 'select=id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  if (_arcCase.ok && _arcCase.data && _arcCase.data[0]) await reconcileGpDrive(_arcCase.data[0].id);
} catch (e) { console.error('[archive] drive reconcile failed:', e.message); }
```

- [ ] **Step 3: Account reinstate** — at the end of `reinstateUserAccount(userId)`, add the same case-lookup + `reconcileGpDrive` block (it moves the folder back to users/candidates based on placement).

- [ ] **Step 4: Documents view** — in `/api/admin/gp-documents`, replace the folder-ensure backfill added in 9a3651c (the `if (!gdCase.google_drive_folder_id && isGoogleDriveConfigured())` block) with a reconcile call placed before the Drive list:

```js
if (isGoogleDriveConfigured()) {
  try { await reconcileGpDrive(gdCaseId); } catch (e) { console.error('[gp-documents] reconcile failed:', e.message); }
  // refresh folder id after reconcile
  try {
    var _rcRefresh = await supabaseDbRequest('registration_cases', 'select=google_drive_folder_id&id=eq.' + encodeURIComponent(gdCaseId) + '&limit=1');
    if (_rcRefresh.ok && _rcRefresh.data && _rcRefresh.data[0]) gdCase.google_drive_folder_id = _rcRefresh.data[0].google_drive_folder_id;
  } catch (e) {}
}
```

- [ ] **Step 5: Syntax check**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" --check server.js`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "Wire reconcileGpDrive into placement/archive/reinstate hooks + documents view"
```

---

### Task 6: Final verification + deploy to main

**Files:** none (verification + push).

- [ ] **Step 1: Full test suite (pure module)**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" node_modules/vitest/vitest.mjs run tests/drive-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 2: Final syntax check of server.js**

Run: `"$CLAUDE_JOB_DIR/tmp/node-v20.18.1-darwin-arm64/bin/node" --check server.js`
Expected: exit 0.

- [ ] **Step 3: Confirm clean fast-forward and push**

```bash
git fetch -q origin main
[ "$(git rev-parse origin/main)" = "$(git merge-base origin/main HEAD)" ] && echo "FF-OK" || echo "REBASE NEEDED"
git push origin HEAD:main
```
Expected: `FF-OK`, then push succeeds. (If `REBASE NEEDED`, rebase onto origin/main, re-run syntax check, then push.)

- [ ] **Step 4: Post-deploy verification (prod)**

After Vercel builds (~1–2 min): open Smith Miller's and Sana Ahsan's Documents tabs in the admin (fires `reconcileGpDrive`). Then verify mirroring via DB (accepted docs now carry a Drive id):
```bash
curl -s "$SUPABASE_URL/rest/v1/user_documents?select=user_id,document_key,status,google_drive_file_id&status=eq.approved&user_id=in.(a505f0b8-fb62-490d-9d63-2c09f800366f,db02252c-36e8-4b56-86bf-c49ca97fc406)" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: approved docs have a non-null `google_drive_file_id`. Confirm in Drive (you) that `Users`/`Candidates`/`Archived` exist, Smith's folder is under `Candidates`, Sana's under `Users`, and ID is shared only with hello@. (Folder location + permissions cannot be verified locally — Drive runs on prod.)

---

## Self-Review

- **Spec coverage:** §2 structure → Task 3 (`ensureLifecycleFolders`) + Task 4 (folder under Users). §3 triggers → Task 5 (placement/archive/reinstate) + Task 4 (signup via ensureGPDriveFolder). §4 mirroring + accepted defn → Task 1 (`isAcceptedStatus`) + Task 4 (mirror loop + ID). §5 permissions → Task 3 (`applyDriveDocPermissions`, private folders). §6 backfill → Task 5 (gp-documents reconcile) + Task 6 verification. §7 DB field → removed (column-free; folder location derived from Drive parent, idempotency from existing `google_drive_file_id` + folder listing). Purge "keep folder" → no code needed (we simply never delete on purge; noted). Covered.
- **Placeholder scan:** none — all steps carry real code/commands.
- **Type consistency:** `reconcileGpDrive(caseId)`, `ensureLifecycleFolders()`, `uploadPrivateToGoogleDrive(folderId, fileName, buffer, mimeType, mode)`, `applyDriveDocPermissions(fileId, mode)`, `moveDriveFolder(folderId, toParentId)` used consistently across tasks.
- **Known adaptation points (verify in-task, not placeholders):** exact name/signature of `supabaseStorageDownloadObject` + `SUPABASE_DOCUMENT_BUCKET` (Task 4 Step 3); exact location of the `archiveUserAccount`/`reinstateUserAccount`/placement-transition insertion points (grep on origin/main during the task).
