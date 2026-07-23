# Onboarding Identity-Document Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the onboarding identity document to the GP's storage + Google Drive "ID" folder, make it viewable to CEO/ATS users (never RSOs) on the GP profile, update the onboarding copy, and honour a retention/deletion policy.

**Architecture:** Extend `POST /api/ai/verify-identity` to persist the uploaded image (Supabase storage + a `user_documents` row keyed `identity`) and mirror it to the GP's Google Drive "ID" subfolder. Surface it on two CEO/ATS-only surfaces: the CEO documents panel (`/api/admin/gp-documents`, gated `isSuperAdminRole`) and the ATS candidate file (new `/api/ats/candidate-id`, `requireAtsSession`). A shared `purgeStoredIdentityDocument(userId)` powers deletion via a CEO/ATS button and a daily retention cron (on request / 6 months post-placement / 12 months inactivity).

**Tech Stack:** Node `server.js` (monolith), vanilla JS pages, Supabase (prod), Google Drive (googleapis), Vitest + http-harness tests.

## Global Constraints

- **Viewing + deletion of the ID: CEO (`super_admin`) and ATS (`consultant`) ONLY. RSOs (`admin`/`staff`) NEVER.** Enforce server-side with `isSuperAdminRole(ctx.role)` (CEO surfaces) / `requireAtsSession` (ATS surface) — not just UI hiding.
- **Store the ID as a `user_documents` row (`document_key='identity'`) + Supabase storage object.** NEVER write it to `user_profiles.id_copy_data_url` (the account page zeroes that field on every save — `pages/account.html`).
- **`country_code` lowercased** when writing `user_documents`; retrieve the identity row **country-agnostically** (by `user_id` + `document_key='identity'`).
- **The 6-month-post-placement purge is SILENT** — never shown in any GP-facing copy.
- **Front-facing copy uses plain punctuation (periods), not em dashes** (the app-wide em-dash sweep was reverted; front-facing only).
- **Bump the `js/onboarding.js?v=` cache-buster** at `pages/onboarding.html:1511` on any `onboarding.js` change (JS is cached ~1h).
- Ship to `main`; all touched test suites must pass before each commit.

## File Structure

- `server.js` — new helpers `saveIdentityDocumentForUser`, `purgeStoredIdentityDocument`, `identityRetentionDue`, `canViewIdentity`; edits to the verify-identity handler, the gp-documents handler, `atsGetDocFlagsProd`; new endpoints `/api/ats/candidate-id`, `/api/admin/gp-identity-delete`, `/api/cron/purge-identity-docs`.
- `pages/onboarding.html` — Step-4 copy + cache-buster bump.
- `js/onboarding.js` — post-verify persistence call + "verified" status copy.
- `js/ceo-ats-candidates.js` — "View ID" button on the ATS candidate documents card.
- `pages/ceo-dashboard.html` (+ `pages/admin.html`) — render the identity card from the new `identityDocument` response field.
- `vercel.json` — new cron entry.
- Tests: `tests/identity-document-storage.test.js` (new), plus additions to an onboarding-page static test.

---

### Task 1: Persist the identity document on upload (storage + user_documents + Drive)

**Files:**
- Modify: `server.js` — add `saveIdentityDocumentForUser(userId, payload)`; extend `POST /api/ai/verify-identity` (~47394–47585).
- Test: `tests/identity-document-storage.test.js`

**Interfaces:**
- Produces: `async function saveIdentityDocumentForUser(userId, payload) -> row|null`, where `payload = { fileDataUrl, mimeType, fileName, fileSize, country }`. Writes a `user_documents` row `{ document_key:'identity', country_code:<lower>, status:'uploaded', storage_bucket, storage_path, mime_type, file_size, file_name, file_url }` and synchronously mirrors to Drive "ID" subfolder. Never creates a doc-review task.
- Produces: storage-path builder `buildIdentityDocumentStoragePath(userId)` → `users/<uid>/identity/current`.

- [ ] **Step 1: Write failing test for the storage-path builder + payload shape**

```js
// tests/identity-document-storage.test.js (new)
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
  it('identity is stored to Drive ID subfolder, never as a doc-review task', () => {
    expect(SRC).toMatch(/driveDocFolders\.ID_FOLDER/);
    // guard: identity persistence must not enrol the ID into qualification review
    expect(SRC).not.toMatch(/createDocumentReview\([^)]*identity/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`saveIdentityDocumentForUser` not defined).
Run: `node ../../../node_modules/vitest/vitest.mjs run tests/identity-document-storage.test.js`

- [ ] **Step 3: Add the storage-path builder + helper** (place near `buildAccountCareerDocumentStoragePath`, server.js ~6739, and `saveAccountCareerDocumentForUser` ~7303).

```js
function buildIdentityDocumentStoragePath(userId) {
  return ['users', sanitizeStoragePathSegment(userId, 80), 'identity', 'current'].join('/');
}

// Persist an onboarding identity document: Supabase storage object + a
// user_documents row keyed 'identity' (full storage tuple so CEO/ATS can sign a
// view URL), then mirror privately into the GP's Drive "ID" subfolder. Country is
// stored lowercased but callers retrieve country-agnostically. Never creates a
// doc-review task — the ID is not a qualification.
async function saveIdentityDocumentForUser(userId, payload) {
  if (!payload || !userId || !isSupabaseDbConfigured()) return null;
  const country = String(payload.country || '').trim().toLowerCase() || 'zz';
  const storagePath = buildIdentityDocumentStoragePath(userId);
  const uploaded = await supabaseStorageUploadObject(SUPABASE_DOCUMENT_BUCKET, storagePath, payload.fileDataUrl, payload.mimeType);
  if (!uploaded) return null;
  const result = await supabaseDbRequest(
    'user_documents',
    'on_conflict=user_id,document_key,country_code',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{
        user_id: userId,
        country_code: country,
        document_key: 'identity',
        status: 'uploaded',
        file_name: payload.fileName || 'identity',
        file_url: storagePath,
        storage_bucket: SUPABASE_DOCUMENT_BUCKET,
        storage_path: storagePath,
        mime_type: payload.mimeType || 'application/octet-stream',
        file_size: payload.fileSize || 0,
        updated_at: new Date().toISOString()
      }]
    }
  );
  const row = (result.ok && Array.isArray(result.data) && result.data[0]) ? result.data[0] : null;
  // Mirror privately into the "ID" Drive subfolder (best-effort; no-op without creds).
  try { await mirrorIdentityToDrive(userId, payload); } catch (e) { console.error('[identity] drive mirror failed:', e.message); }
  return row;
}

// Best-effort private Drive mirror of the identity image into the per-GP "ID" subfolder.
async function mirrorIdentityToDrive(userId, payload) {
  if (!isGoogleDriveConfigured()) return;
  const caseRes = await supabaseDbRequest('registration_cases', 'select=id,google_drive_folder_id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  const gpCase = (caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0]) ? caseRes.data[0] : null;
  if (!gpCase) return;
  const folderId = await ensureGPDriveFolder(gpCase.id, null, null);
  if (!folderId) return;
  const parsed = parseDataUrlPayload(payload.fileDataUrl);
  if (!parsed || !parsed.buffer) return;
  const idFolderId = await ensureDocTypeSubfolder(folderId, driveDocFolders.ID_FOLDER, null);
  const ext = ((parsed.mimeType || payload.mimeType || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  await uploadPrivateToGoogleDrive(idFolderId || folderId, 'ID — ' + (payload.fileName || ('identity.' + ext)), parsed.buffer, parsed.mimeType || payload.mimeType, 'id_private');
}
```

- [ ] **Step 4: Wire persistence into the verify-identity handler.** In `POST /api/ai/verify-identity`, just before `sendJson(res, 200, { ok: true, verification });`, persist the received image. Resolve the user id from the session using the same helper other authed endpoints use (grep for `getSessionUserId(` / `session.userId` / `session.user_id` and reuse it). Persist regardless of name-match (a mismatch is a name-change signal, not a rejection), as long as a readable image was received:

```js
      // Persist the ID (store + Drive) so CEO/ATS can verify the doctor is real.
      // Fire-and-persist BEFORE responding (Vercel freezes the function after the
      // response). Never blocks the verification result on a storage failure.
      try {
        const idUserId = getSessionUserId(session); // reuse existing session→userId resolver
        if (idUserId) {
          await saveIdentityDocumentForUser(idUserId, {
            fileDataUrl: 'data:' + mediaType + ';base64,' + aiImageBase64,
            mimeType: mediaType,
            fileName: 'identity.' + ((mediaType.split('/')[1] || 'jpg').replace('jpeg', 'jpg')),
            fileSize: 0,
            country: (profileName && '') || '' // country resolved below; see note
          });
        }
      } catch (idStoreErr) { console.error('[ID Verify] persist failed:', idStoreErr.message); }

      sendJson(res, 200, { ok: true, verification });
```

  Note on `country`: resolve the GP's onboarding country the same way other code does (e.g. from `user_profiles.registration_country`/`gp_selected_country` or the onboarding state); if the implementer cannot cheaply resolve it here, pass `''` — `saveIdentityDocumentForUser` falls back to `'zz'` and retrieval is country-agnostic, so this does not affect correctness. Confirm `getSessionUserId` is the real resolver name before use.

- [ ] **Step 5: Run source-contract test — expect PASS.**
Run: `node ../../../node_modules/vitest/vitest.mjs run tests/identity-document-storage.test.js`

- [ ] **Step 6: `node --check server.js`, then commit.**

```bash
git add server.js tests/identity-document-storage.test.js
git commit -m "feat(identity): persist onboarding ID to storage + Drive"
```

---

### Task 2: Onboarding copy + cache-buster (truthful storage wording)

**Files:**
- Modify: `pages/onboarding.html:1466-1467` (info copy), `pages/onboarding.html:1511` (`onboarding.js?v=` bump).
- Modify: `js/onboarding.js` `renderIdVerifyStatus` (~1511–1547) — the "verified" line currently says "your document has been deleted".
- Test: add static-source assertions (new `tests/onboarding-identity-copy.test.js` or extend an existing onboarding page test that GETs `/onboarding`).

**Interfaces:** none (copy only).

- [ ] **Step 1: Write failing static-source test.**

```js
// tests/onboarding-identity-copy.test.js (new) — boot server like tests/site-jobs-page.test.js
// (AUTH_DISABLED=false, no Supabase) and GET the onboarding page route.
it('onboarding ID step tells the user it is stored, not deleted', async () => {
  const res = await get('/pages/onboarding.html'); // confirm the served route in server.js
  expect(res.raw).toContain('We store your ID securely so GP Link can confirm you’re a real doctor');
  expect(res.raw).toContain('We’ll delete it whenever you ask, or after 12 months of inactivity.');
  expect(res.raw).not.toContain('nothing is stored');
  expect(res.raw).not.toContain('deleted immediately');
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Replace the info copy** at `pages/onboarding.html:1467`:

```html
              <span>We store your ID securely so GP Link can confirm you&rsquo;re a real doctor and vouch for you to practices. We&rsquo;ll delete it whenever you ask, or after 12 months of inactivity.</span>
```

- [ ] **Step 4: Update the "verified" status copy** in `js/onboarding.js` `renderIdVerifyStatus` — change the verified branch text from "your document has been deleted" to e.g. "Identity confirmed. Your ID is stored securely." (grep the exact string in `renderIdVerifyStatus` and replace).

- [ ] **Step 5: Bump the cache-buster** at `pages/onboarding.html:1511`: `onboarding.js?v=20260722b` → `onboarding.js?v=20260724a`.

- [ ] **Step 6: Run test — expect PASS. Commit.**

```bash
git add pages/onboarding.html js/onboarding.js tests/onboarding-identity-copy.test.js
git commit -m "feat(identity): onboarding copy — ID stored, not deleted"
```

---

### Task 3: Client persists the ID after a successful verify (belt-and-braces)

> Task 1 persists server-side inside verify-identity, so this task is only needed IF the implementer chose to keep verify-identity storeless and persist from the client instead. **Default: SKIP** — Task 1's server-side persistence is canonical and avoids a second upload. Retain this task only if server-side resolution of `getSessionUserId`/country proves unavailable; then have `handleIdVerification` (js/onboarding.js) POST the same base64 to a dedicated persist endpoint on the `verified` branch. If skipped, delete this task's checkbox and note why in the commit for Task 1.

---

### Task 4: CEO documents panel — role-gated identity card

**Files:**
- Modify: `server.js` — add `canViewIdentity(ctx)`; add an `identityDocument` field to the `/api/admin/gp-documents` response (~52107) built only when `isSuperAdminRole(gdAdminCtx.role)`.
- Modify: `pages/ceo-dashboard.html` (documents panel that consumes `/api/admin/gp-documents`, ~7072) and `pages/admin.html` (~3492) — render the identity card when `identityDocument` is present.
- Test: `tests/identity-document-storage.test.js` (source contract + role gate).

**Interfaces:**
- Produces: `function canViewIdentity(ctx) { return isSuperAdminRole(ctx && ctx.role); }`
- Produces: response field `identityDocument: { file_name, view_url, updated_at } | null` (present/non-null only for CEO).

- [ ] **Step 1: Failing test — source contract + gate.**

```js
it('gp-documents exposes identityDocument only under a CEO gate', () => {
  expect(SRC).toMatch(/function canViewIdentity\(/);
  expect(SRC).toMatch(/canViewIdentity\(gdAdminCtx\)/);
  // built from a signed URL over the identity user_documents row
  expect(SRC).toMatch(/document_key=eq\.identity/);
  expect(SRC).toMatch(/supabaseStorageCreateSignedUrl/);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add `canViewIdentity`** near `isSuperAdminRole` (server.js ~10917):

```js
// The identity document is viewable by CEO (super_admin) and ATS users
// (consultant) only — never RSOs. ATS surfaces gate via requireAtsSession; admin
// surfaces gate with this predicate.
function canViewIdentity(ctx) { return isSuperAdminRole(ctx && ctx.role); }
```

- [ ] **Step 4: Build the identity card in `/api/admin/gp-documents`.** Just before the final `sendJson` (server.js ~52107), resolve + sign it (CEO only):

```js
      var gdIdentity = null;
      if (canViewIdentity(gdAdminCtx)) {
        var idDocRes = await supabaseDbRequest('user_documents',
          'select=file_name,file_url,storage_path,storage_bucket,updated_at&user_id=eq.' + encodeURIComponent(gdUserId) + '&document_key=eq.identity&order=updated_at.desc&limit=1');
        var idRow = (idDocRes.ok && Array.isArray(idDocRes.data) && idDocRes.data[0]) ? idDocRes.data[0] : null;
        var idPath = idRow ? String(idRow.storage_path || idRow.file_url || '').trim() : '';
        if (idRow && idPath) {
          var idUrl = await supabaseStorageCreateSignedUrl(idRow.storage_bucket || SUPABASE_DOCUMENT_BUCKET, idPath, idRow.file_name || 'identity');
          if (idUrl) gdIdentity = { file_name: idRow.file_name || 'Identity document', view_url: idUrl, updated_at: idRow.updated_at || '' };
        }
      }
```

  Then add `identityDocument: gdIdentity` to the `sendJson` object. (`gdUserId` = the user id the handler already resolved for `gdUserDocsByKey`; confirm its variable name and reuse it.)

- [ ] **Step 5: Render the card (frontend).** In `pages/ceo-dashboard.html` (and `pages/admin.html`) where the gp-documents response arrays are rendered, add, when `data.identityDocument`, a card: label "Identity document", a "View" link to `identityDocument.view_url` (opens in a new tab), and (for Task 6) a "Delete ID" button. Guard everything on `data.identityDocument` being present (server already omits it for non-CEO).

- [ ] **Step 6: Run tests, `node --check server.js`, commit.**

```bash
git add server.js pages/ceo-dashboard.html pages/admin.html tests/identity-document-storage.test.js
git commit -m "feat(identity): CEO documents panel shows viewable ID (super_admin-gated)"
```

---

### Task 5: ATS candidate file — viewable ID for CEO + consultant

**Files:**
- Modify: `server.js` — new `GET /api/ats/candidate-id` (mirror `/api/ats/candidate-cv` ~64029–64053, guard `requireAtsSession`, audit `ats_id_viewed`); update `atsGetDocFlagsProd` (~32557) so `idDoc` also true when an `identity` `user_documents` row exists.
- Modify: `js/ceo-ats-candidates.js` `docsCardInner` (~1417) — turn the `idDoc` line into a "View ID" button (like the CV button) that opens the signed URL.
- Test: `tests/identity-document-storage.test.js`.

**Interfaces:**
- Produces: `GET /api/ats/candidate-id?user_id=&case_id=` → `{ ok, url }` (signed) or 404 / 403.
- Changes: `atsGetDocFlagsProd(...).idDoc` now also reflects a stored `identity` row.

- [ ] **Step 1: Failing test.**

```js
it('ATS exposes candidate-id under requireAtsSession and idDoc detects the identity row', () => {
  expect(SRC).toMatch(/\/api\/ats\/candidate-id/);
  expect(SRC).toMatch(/requireAtsSession/);
  // idDoc now also true from a user_documents identity row, not only id_copy_data_url
  expect(SRC).toMatch(/document_key === 'identity'/);
});
```
Also add an http-harness test: an unauthenticated `GET /api/ats/candidate-id` returns 403 (proves the gate).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Update `atsGetDocFlagsProd.idDoc`** (server.js:32570) to OR-in the identity row:

```js
    idDoc: present(function (r) { return r.document_key === 'identity'; }) || !!String(prof.id_copy_data_url || '').trim() || !!String(prof.id_copy_name || '').trim()
```

- [ ] **Step 4: Add `GET /api/ats/candidate-id`** modelled exactly on `/api/ats/candidate-cv` (server.js ~64029): `var ctx = requireAtsSession(req, res); if (!ctx) return;` → resolve `user_id`/`case_id` → query `user_documents` `document_key=eq.identity` newest → `supabaseStorageCreateSignedUrl(bucket, storage_path||file_url, file_name)` → `sendJson(res,200,{ok:true,url})` (404 when none) → `await logAdminAction(req, ctx, 'ats_id_viewed', { user_id })`.

- [ ] **Step 5: Frontend "View ID" button** in `js/ceo-ats-candidates.js` `docsCardInner`: for `d.k === 'idDoc'` when `has`, render a `View ID` button (mirror the `ats-cv-view` button at line 1433) wired to open `/api/ats/candidate-id`. Reuse the existing `openSignedDoc`/`/api/ats/candidate-cv` click pattern. Bump the `ceo-ats-candidates.js?v=` cache-buster wherever it's included.

- [ ] **Step 6: Run tests, `node --check server.js`, commit.**

```bash
git add server.js js/ceo-ats-candidates.js pages/*.html tests/identity-document-storage.test.js
git commit -m "feat(identity): ATS candidate file — viewable ID (CEO + consultant)"
```

---

### Task 6: Deletion — shared purge helper + on-request endpoint

**Files:**
- Modify: `server.js` — add `purgeStoredIdentityDocument(userId)`; add `POST /api/admin/gp-identity-delete` gated to CEO/ATS.
- Modify: `pages/ceo-dashboard.html` / `pages/admin.html` — "Delete ID" button on the identity card → calls the endpoint, then refreshes.
- Test: `tests/identity-document-storage.test.js`.

**Interfaces:**
- Produces: `async function purgeStoredIdentityDocument(userId) -> { removed:boolean }` — deletes the Supabase storage object, the `identity` `user_documents` row, the Drive "ID — …" file(s), and clears legacy `user_profiles.id_copy_data_url`/`id_copy_name`. Idempotent.
- Produces: `POST /api/admin/gp-identity-delete { user_id }` → `{ ok }`; 403 unless `canViewIdentity` (CEO) — reject `admin`/`staff`.

- [ ] **Step 1: Failing test.**

```js
it('defines an idempotent purge helper and a CEO-gated delete endpoint', () => {
  expect(SRC).toMatch(/function purgeStoredIdentityDocument\(/);
  expect(SRC).toMatch(/\/api\/admin\/gp-identity-delete/);
  expect(SRC).toMatch(/canViewIdentity\(/); // reused as the delete gate
});
```
Add http-harness test: `POST /api/admin/gp-identity-delete` with no session → 401/403.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the purge helper** (near `saveIdentityDocumentForUser`):

```js
// Remove every stored copy of a GP's identity document. Idempotent; Drive/legacy
// steps no-op when unconfigured/empty.
async function purgeStoredIdentityDocument(userId) {
  if (!userId || !isSupabaseDbConfigured()) return { removed: false };
  // 1) storage object
  try { await supabaseStorageDeleteObject(SUPABASE_DOCUMENT_BUCKET, buildIdentityDocumentStoragePath(userId)); } catch (e) { console.error('[identity purge] storage:', e.message); }
  // 2) Drive "ID — " file(s) in the personal folder + ID subfolder
  try { await deleteIdentityDriveFiles(userId); } catch (e) { console.error('[identity purge] drive:', e.message); }
  // 3) user_documents identity row(s)
  try { await supabaseDbRequest('user_documents', 'user_id=eq.' + encodeURIComponent(userId) + '&document_key=eq.identity', { method: 'DELETE' }); } catch (e) { console.error('[identity purge] row:', e.message); }
  // 4) legacy profile fields
  try { await supabaseDbRequest('user_profiles', 'user_id=eq.' + encodeURIComponent(userId), { method: 'PATCH', body: { id_copy_data_url: '', id_copy_name: '', updated_at: new Date().toISOString() } }); } catch (e) { console.error('[identity purge] profile:', e.message); }
  return { removed: true };
}
```
  Confirm `supabaseStorageDeleteObject` exists (grep; if not, add a small helper mirroring `supabaseStorageUploadObject` with `method:'DELETE'`). Implement `deleteIdentityDriveFiles(userId)` by resolving the case folder + ID subfolder and deleting files whose name matches `/^ID — /` via `deleteGoogleDriveFile` (used at server.js:26377).

- [ ] **Step 4: Add the delete endpoint** near other `/api/admin/*` routes:

```js
  if (req.method === 'POST' && pathname === '/api/admin/gp-identity-delete') {
    const idDelCtx = requireAdminSession(req, res);
    if (!idDelCtx) return;
    if (!canViewIdentity(idDelCtx)) { sendJson(res, 403, { ok: false, message: 'CEO/ATS access required.' }); return; }
    let idDelBody; try { idDelBody = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const targetUserId = String((idDelBody && idDelBody.user_id) || '').trim();
    if (!targetUserId) { sendJson(res, 400, { ok: false, message: 'Missing user_id.' }); return; }
    const out = await purgeStoredIdentityDocument(targetUserId);
    await logAdminAction(req, idDelCtx, 'identity_deleted', { user_id: targetUserId });
    sendJson(res, 200, { ok: true, removed: out.removed });
    return;
  }
```
  (Consultants reach ATS via `requireAtsSession`; if the CEO dashboard button is the only caller, `requireAdminSession` + `canViewIdentity` = super_admin is sufficient. If ATS also needs a delete control, add the same guard behind `requireAtsSession`.)

- [ ] **Step 5: "Delete ID" button** on the identity card (ceo-dashboard.html / admin.html) → `POST /api/admin/gp-identity-delete` with the GP's `user_id`, confirm dialog, refresh on success.

- [ ] **Step 6: Run tests, `node --check server.js`, commit.**

```bash
git add server.js pages/ceo-dashboard.html pages/admin.html tests/identity-document-storage.test.js
git commit -m "feat(identity): on-request purge (CEO/ATS) — helper + endpoint + button"
```

---

### Task 7: Retention cron — 6 months post-placement + 12 months inactivity

**Files:**
- Modify: `server.js` — add `identityRetentionDue({ placedAtMs, lastActiveMs, nowMs })` pure fn; add `GET /api/cron/purge-identity-docs`.
- Modify: `vercel.json` — add `{ "path": "/api/cron/purge-identity-docs", "schedule": "0 4 * * *" }`.
- Test: `tests/identity-document-storage.test.js` (pure function).

**Interfaces:**
- Produces: `function identityRetentionDue({ placedAtMs, lastActiveMs, nowMs }) -> { due:boolean, reason:'placement'|'inactivity'|null }`. Due when `placedAtMs && nowMs - placedAtMs >= 6*30d` OR `lastActiveMs && nowMs - lastActiveMs >= 365d`.

- [ ] **Step 1: Failing unit test (pure fn — fully testable, no Supabase).**

```js
import { identityRetentionDue } from '../server.js'; // export it (see step 3)
const DAY = 86400000;
it('purges 6 months after placement', () => {
  const now = 1000 * DAY;
  expect(identityRetentionDue({ placedAtMs: now - 181*DAY, lastActiveMs: now, nowMs: now })).toEqual({ due: true, reason: 'placement' });
  expect(identityRetentionDue({ placedAtMs: now - 100*DAY, lastActiveMs: now, nowMs: now }).due).toBe(false);
});
it('purges after 12 months inactivity', () => {
  const now = 1000 * DAY;
  expect(identityRetentionDue({ placedAtMs: 0, lastActiveMs: now - 366*DAY, nowMs: now })).toEqual({ due: true, reason: 'inactivity' });
  expect(identityRetentionDue({ placedAtMs: 0, lastActiveMs: now - 100*DAY, nowMs: now }).due).toBe(false);
});
```
  NOTE: if `server.js` cannot be ESM-imported in the test harness (it boots a server), instead assert the function's source contract like the other tests (`expect(SRC).toMatch(/function identityRetentionDue/)`) AND write a tiny standalone copy under `lib/identity-retention.js` that both `server.js` and the test import. Prefer the `lib/` extraction so the pure logic is unit-tested for real.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create `lib/identity-retention.js`** and require it in server.js:

```js
'use strict';
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;   // ~6 months
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
function identityRetentionDue({ placedAtMs, lastActiveMs, nowMs }) {
  if (placedAtMs && (nowMs - placedAtMs) >= SIX_MONTHS_MS) return { due: true, reason: 'placement' };
  if (lastActiveMs && (nowMs - lastActiveMs) >= TWELVE_MONTHS_MS) return { due: true, reason: 'inactivity' };
  return { due: false, reason: null };
}
module.exports = { identityRetentionDue, SIX_MONTHS_MS, TWELVE_MONTHS_MS };
```

- [ ] **Step 4: Add `GET /api/cron/purge-identity-docs`** (mirror `/api/cron/purge-accounts` auth at server.js:36781): validate `isValidCronSecret`; require Supabase; select all `user_documents` rows `document_key=eq.identity` (`select=user_id`); for each user, resolve:
  - `placedAtMs`: newest `placements.placed_at` for the user if the table exists, else the hired `gp_applications` row's `updated_at || applied_at` (mirror `userHasActivePlacement`'s query, selecting the timestamp).
  - `lastActiveMs`: `user_state.updated_at` (fallback `user_profiles.updated_at`) — the same derivation used at server.js:10584.
  Then `if (identityRetentionDue({placedAtMs,lastActiveMs,nowMs}).due) await purgeStoredIdentityDocument(userId)`. Honour a `IDENTITY_PURGE_DISABLED==='true'` dry-run switch; `console.log` a summary (`due/purged/reason counts`); `sendJson` the summary. No silent caps — log any batch limit.

- [ ] **Step 5: Add the vercel.json cron entry** (after `purge-accounts`).

- [ ] **Step 6: Run tests, `node --check server.js`, commit.**

```bash
git add server.js lib/identity-retention.js vercel.json tests/identity-document-storage.test.js
git commit -m "feat(identity): retention cron — 6mo post-placement + 12mo inactivity purge"
```

---

## Final verification (after all tasks)

- [ ] Run the full new suite + the onboarding copy test: `node ../../../node_modules/vitest/vitest.mjs run tests/identity-document-storage.test.js tests/onboarding-identity-copy.test.js`.
- [ ] `node --check server.js` and syntax-check edited inline page scripts.
- [ ] Rebase onto latest `origin/main`, push `HEAD:main`, confirm a **production** Vercel deploy (fresh SHA) reaches READY, and live-check the onboarding copy is served + `/api/admin/gp-identity-delete` returns 401/403 unauthenticated (role gate live).
- [ ] Verify no test suite elsewhere pinned the old "nothing is stored" onboarding copy (grep before shipping).

## Spec coverage check

R1 persist → T1 · R2 Drive → T1 · R3 CEO viewable → T4 · (ATS viewable) → T5 · R4 wording → T2 · R5 deletion (request/placement/inactivity) → T6 + T7 · R6 CEO/ATS-only-not-RSO → global constraint + T4 (`canViewIdentity`) + T5 (`requireAtsSession`) + T6 gate.
