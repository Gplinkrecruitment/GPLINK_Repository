# Prepared-Doc Mismatch Flagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a candidate uploads a qualification document whose name does not match the account holder, is the wrong type, or fails verification, the server raises a normal-priority manual-review task that GP Link staff see in the Ops queue.

**Architecture:** Extend the existing server-side document pipeline (`processDocumentUpload` in `server.js`) rather than building a parallel system. Pure decision logic goes into `lib/document-pipeline.js` (unit-tested, no mocks, matching the existing pattern). Two client upload paths that currently write only `localStorage` are routed through the existing `PUT /api/prepared-documents` so the pipeline runs. Task creation reuses the `flagged_doc` task type and the dedup pattern from `createDocReviewTask`.

**Tech Stack:** Node.js (`server.js` monolith, CommonJS), vanilla JS frontend (`pages/*.html`, `js/*.js`), Supabase (PostgREST), Anthropic API for verification, Vitest for tests.

---

## Spec

See `docs/superpowers/specs/2026-06-12-prepared-doc-mismatch-flagging-design.md`.

## File Structure

- **Modify** `lib/document-pipeline.js` — add two pure functions: `classifyQualificationOutcome()` and `buildFlagReason()`. Export them.
- **Modify** `tests/document-pipeline.test.js` — add unit tests for the two new pure functions.
- **Modify** `server.js`:
  - Add `classifyQualificationOutcome`, `buildFlagReason` to the `require('./lib/document-pipeline.js')` destructure (~line 110).
  - Extract the Anthropic qualification-verify call (inside `/api/ai/verify-qualification`, ~25773–25900) into a reusable async helper `verifyQualificationDocument(...)`; have the endpoint call it.
  - Add `createFlaggedDocTask(userId, documentKey, label, reason)` near `createDocReviewTask` (~18683).
  - In `processDocumentUpload` (~18744), add a qualification-class branch that calls `verifyQualificationDocument`, routes via `classifyQualificationOutcome`, and creates a flagged task on `flag`.
  - Ensure `/api/admin/gp-documents` (~29741) returns the per-document `flag_reason`.
- **Modify** `js/qualification-scan.js` — after a successful scan, also `PUT /api/prepared-documents` with the file.
- **Modify** `pages/ahpra.html` — in `saveMissingUploadToDocuments` (~3202), also `PUT /api/prepared-documents`.
- **Modify** `pages/admin.html` — render a red "Name mismatch" badge when a prepared-by-candidate doc has `flag_reason === 'name_mismatch'`.

**Qualification-class document keys** (used in several tasks — keep identical everywhere):
`primary_medical_degree`, `mrcgp_certified`, `cct_certified`, `mrcgp`, `cct`, `micgp`, `cscst`, `frnzcgp`, `certificate_good_standing`, `confirmation_training`.

---

### Task 1: Pure decision function `classifyQualificationOutcome`

**Files:**
- Modify: `lib/document-pipeline.js`
- Test: `tests/document-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/document-pipeline.test.js`:

```js
import {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt,
  classifyQualificationOutcome,
  buildFlagReason
} from '../lib/document-pipeline.js';

describe('classifyQualificationOutcome', () => {
  it('approves when name matches (exact) and type is correct', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'exact', verified: true });
    expect(r).toEqual({ action: 'approve', status: 'approved', reasonKind: null });
  });
  it('approves on fuzzy name match', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'fuzzy', verified: true });
    expect(r.action).toBe('approve');
  });
  it('flags a name mismatch', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'mismatch', verified: true });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'name_mismatch' });
  });
  it('flags when verification failed (wrong type / illegible)', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'exact', verified: false });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'failed_verification' });
  });
  it('prioritises name mismatch over failed verification', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'mismatch', verified: false });
    expect(r.reasonKind).toBe('name_mismatch');
  });
  it('treats unknown nameMatch as failed_verification when not verified', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'unknown', verified: false });
    expect(r.reasonKind).toBe('failed_verification');
  });
  it('flags failed_verification when name is unknown but doc verified true', () => {
    // name could not be read; treat as needing review
    const r = classifyQualificationOutcome({ nameMatch: 'unknown', verified: true });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'failed_verification' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/document-pipeline.test.js -t classifyQualificationOutcome`
Expected: FAIL — `classifyQualificationOutcome is not a function` (import is undefined).

- [ ] **Step 3: Write minimal implementation**

In `lib/document-pipeline.js`, add before `module.exports`:

```js
/**
 * Decide what to do with a qualification document after AI verification.
 * Pure: no I/O. nameMatch is one of 'exact' | 'fuzzy' | 'mismatch' | 'unknown'.
 * Returns { action: 'approve'|'flag', status, reasonKind }.
 */
function classifyQualificationOutcome({ nameMatch, verified }) {
  if (nameMatch === 'mismatch') {
    return { action: 'flag', status: 'under_review', reasonKind: 'name_mismatch' };
  }
  const nameConfirmed = nameMatch === 'exact' || nameMatch === 'fuzzy';
  if (verified && nameConfirmed) {
    return { action: 'approve', status: 'approved', reasonKind: null };
  }
  return { action: 'flag', status: 'under_review', reasonKind: 'failed_verification' };
}
```

Add `classifyQualificationOutcome` to the `module.exports = { ... }` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/document-pipeline.test.js -t classifyQualificationOutcome`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/document-pipeline.js tests/document-pipeline.test.js
git commit -m "feat: add classifyQualificationOutcome decision helper"
```

---

### Task 2: Pure reason-message builder `buildFlagReason`

**Files:**
- Modify: `lib/document-pipeline.js`
- Test: `tests/document-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/document-pipeline.test.js`:

```js
describe('buildFlagReason', () => {
  it('builds a name mismatch reason naming both parties', () => {
    const r = buildFlagReason('name_mismatch', {
      nameFound: 'Mohammed Avais Hussain',
      profileName: 'Smith Miller',
      expectedLabel: 'Primary Medical Degree'
    });
    expect(r).toBe('Name on document ("Mohammed Avais Hussain") does not match account ("Smith Miller").');
  });
  it('handles a missing document name gracefully', () => {
    const r = buildFlagReason('name_mismatch', { nameFound: '', profileName: 'Smith Miller', expectedLabel: 'Primary Medical Degree' });
    expect(r).toBe('The name on the document does not match the account holder ("Smith Miller").');
  });
  it('builds a failed verification reason with the expected label', () => {
    const r = buildFlagReason('failed_verification', { expectedLabel: 'MRCGP Certificate', issues: ['This appears to be a passport.'] });
    expect(r).toBe('MRCGP Certificate could not be verified: This appears to be a passport.');
  });
  it('falls back when no issues are provided', () => {
    const r = buildFlagReason('failed_verification', { expectedLabel: 'MRCGP Certificate', issues: [] });
    expect(r).toBe('MRCGP Certificate could not be verified and needs manual review.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/document-pipeline.test.js -t buildFlagReason`
Expected: FAIL — `buildFlagReason is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/document-pipeline.js`, add before `module.exports`:

```js
/**
 * Build a human-readable reason for a flagged qualification document.
 * Pure. kind is 'name_mismatch' | 'failed_verification'.
 */
function buildFlagReason(kind, opts) {
  const o = opts || {};
  const label = o.expectedLabel || 'This document';
  if (kind === 'name_mismatch') {
    const profile = o.profileName || 'the account holder';
    if (o.nameFound) {
      return 'Name on document ("' + o.nameFound + '") does not match account ("' + profile + '").';
    }
    return 'The name on the document does not match the account holder ("' + profile + '").';
  }
  const issues = Array.isArray(o.issues) ? o.issues.filter(Boolean) : [];
  if (issues.length > 0) {
    return label + ' could not be verified: ' + issues.join(' ');
  }
  return label + ' could not be verified and needs manual review.';
}
```

Add `buildFlagReason` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/document-pipeline.test.js -t buildFlagReason`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/document-pipeline.js tests/document-pipeline.test.js
git commit -m "feat: add buildFlagReason message builder"
```

---

### Task 3: Extract `verifyQualificationDocument` shared helper

**Files:**
- Modify: `server.js` (endpoint `/api/ai/verify-qualification` at ~25701; new helper above it)

This refactor extracts the Anthropic verify call so the background pipeline can reuse it. Behaviour and the endpoint's JSON response shape must stay identical (covered by `tests/name-matching.test.js`, which uses `__testUtils`).

- [ ] **Step 1: Read the current endpoint body**

Read `server.js` lines `25773`–`25910` (from `const dateRules = {` through the JSON parse, the `applyQualificationNameMatchPolicy(...)` call, and the `sendJson(res, 200, { ok: true, verification })` response). This is the block to extract.

- [ ] **Step 2: Create the helper**

Add a new async function above the endpoint (near other AI helpers). It takes already-prepared inputs and returns the parsed verification object (or throws / returns an error shape). Move the prompt construction, the `fetch` to Anthropic, the response parse, and the `applyQualificationNameMatchPolicy` call into it:

```js
// Returns { ok: true, verification } | { ok: false, status, message }
async function verifyQualificationDocument({ contentBlock, documentType, expectedCountry, profileName, verifiedNames }) {
  const dateRules = { GB: 'August 2007 or later', IE: '2009 or later', NZ: '2010 or later' };
  const dateRule = dateRules[expectedCountry] || 'any date';
  const isPrimaryMedDegree = documentType === 'Primary Medical Degree';
  // ... move qualSystemPrompt, qualUserPrompt, the AbortController + fetch,
  //     the !anthropicRes.ok handling (return { ok:false, status, message }),
  //     recordAnthropicSpend, the textContent parse into `verification`,
  //     and applyQualificationNameMatchPolicy(verification, profileName, verifiedNames)
  //     verbatim from the endpoint.
  return { ok: true, verification };
}
```

- [ ] **Step 3: Rewire the endpoint to call the helper**

Replace the extracted block in `/api/ai/verify-qualification` with:

```js
const result = await verifyQualificationDocument({
  contentBlock, documentType, expectedCountry, profileName,
  verifiedNames: await getVerifiedQualificationNames(session) // keep existing source of verifiedNames if one is used today; otherwise pass []
});
if (!result.ok) { sendJson(res, result.status || 502, { ok: false, message: result.message }); return; }
sendJson(res, 200, { ok: true, verification: result.verification });
```

Keep the budget check, rate-limit check, `recordUserAiCall`, image normalization, and `contentBlock` construction in the endpoint (they are request-specific). If `verifiedNames` is currently built inline, pass that same value into the helper.

- [ ] **Step 4: Run the existing name-matching tests**

Run: `npx vitest run tests/name-matching.test.js`
Expected: PASS (unchanged — the policy function and response shape are preserved).

- [ ] **Step 5: Smoke-run the server**

Run: `node -e "require('./server.js')"` (loads the module; the test harness also boots it).
Expected: no syntax/throw on load.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "refactor: extract verifyQualificationDocument helper for reuse"
```

---

### Task 4: `createFlaggedDocTask` server helper

**Files:**
- Modify: `server.js` (add near `createDocReviewTask` at ~18683)

- [ ] **Step 1: Add the helper (mirrors createDocReviewTask dedup)**

```js
// Create (or reopen) a normal-priority manual-review task for a flagged qualification doc.
async function createFlaggedDocTask(userId, documentKey, label, reason) {
  var caseRes = await supabaseDbRequest('registration_cases', 'select=id&user_id=eq.' + encodeURIComponent(userId) + '&limit=1');
  var gpCase = caseRes.ok && Array.isArray(caseRes.data) && caseRes.data[0] ? caseRes.data[0] : null;
  if (!gpCase) return null;

  var existingRes = await supabaseDbRequest('registration_tasks',
    'select=id,status&case_id=eq.' + encodeURIComponent(gpCase.id) +
    '&task_type=eq.flagged_doc&related_document_key=eq.' + encodeURIComponent(documentKey) +
    '&status=in.(open,in_progress,waiting)&limit=1');
  var existing = existingRes.ok && Array.isArray(existingRes.data) && existingRes.data[0] ? existingRes.data[0] : null;

  if (existing) {
    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(existing.id), {
      method: 'PATCH',
      body: { status: 'open', description: reason, updated_at: new Date().toISOString() }
    });
    await supabaseDbRequest('task_timeline', '', {
      method: 'POST',
      body: [{ task_id: existing.id, case_id: gpCase.id, event_type: 'system', title: 'Document re-uploaded, flag reopened', detail: reason, actor: 'system' }]
    });
    return existing;
  }

  return await _createRegTask(gpCase.id, {
    task_type: 'flagged_doc',
    title: 'Review flagged qualification: ' + (label || documentKey),
    description: reason,
    priority: 'normal',
    source_trigger: 'prepared_doc_scan',
    related_stage: 'myintealth',
    related_document_key: documentKey,
    _actor: 'system'
  });
}
```

Confirm `_createRegTask` accepts `related_document_key` and `priority` (read its definition at ~7509); if it whitelists fields, add `related_document_key` to the allowed set.

- [ ] **Step 2: Smoke-load**

Run: `node -e "require('./server.js')"`
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add createFlaggedDocTask (normal priority, deduped)"
```

---

### Task 5: Wire qualification checks into `processDocumentUpload`

**Files:**
- Modify: `server.js` (`processDocumentUpload` ~18744; require destructure ~110)

- [ ] **Step 1: Import the pure helpers**

Add `classifyQualificationOutcome` and `buildFlagReason` to the destructured `require('./lib/document-pipeline.js')` at ~line 110.

- [ ] **Step 2: Add a qualification-class constant**

Near `getDocumentLabelForKey`, add:

```js
const QUALIFICATION_DOC_KEYS = new Set([
  'primary_medical_degree', 'mrcgp_certified', 'cct_certified', 'mrcgp', 'cct',
  'micgp', 'cscst', 'frnzcgp', 'certificate_good_standing', 'confirmation_training'
]);
```

- [ ] **Step 3: Branch inside processDocumentUpload**

After `var fileBuffer = ...` (the downloaded buffer, ~18759) and before the existing `classifyDocumentWithAI` call, insert:

```js
if (QUALIFICATION_DOC_KEYS.has(documentKey)) {
  var profile = await getSupabaseUserProfile(null, userId).catch(function () { return null; });
  var profileName = profile ? [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() : '';
  var docTypeLabel = getDocumentLabelForKey(documentKey) || documentKey;
  var qualContentBlock = buildQualContentBlock(fileBuffer, mimeType || doc.mime_type); // see note
  var vres = await verifyQualificationDocument({
    contentBlock: qualContentBlock,
    documentType: docTypeLabel,
    expectedCountry: (countryCode || '').toUpperCase(),
    profileName: profileName,
    verifiedNames: []
  }).catch(function () { return { ok: false }; });

  if (vres && vres.ok && vres.verification) {
    var v = vres.verification;
    var outcome = classifyQualificationOutcome({ nameMatch: v.nameMatch, verified: v.verified });
    if (outcome.action === 'flag') {
      var reason = buildFlagReason(outcome.reasonKind, {
        nameFound: v.nameFound, profileName: profileName,
        expectedLabel: docTypeLabel, issues: v.issues
      });
      await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
        method: 'PATCH',
        body: { status: 'under_review', flag_reason: outcome.reasonKind, rejection_reason: reason, updated_at: new Date().toISOString() }
      });
      await createFlaggedDocTask(userId, documentKey, docTypeLabel, reason);
      await pushDocumentNotificationToUser(userId, {
        type: 'action', title: docTypeLabel + ' needs review', detail: reason
      });
      return; // skip the generic type-only pipeline for this doc
    }
    // approve path falls through to existing classifyDocumentWithAI auto-approve below,
    // OR set approved directly:
    await supabaseDbRequest('user_documents', 'id=eq.' + encodeURIComponent(doc.id), {
      method: 'PATCH', body: { flag_reason: '', updated_at: new Date().toISOString() }
    });
  }
}
```

**Note on `buildQualContentBlock`:** the endpoint builds `contentBlock` from base64 (image normalization or PDF document block). Add a small server helper `buildQualContentBlock(fileBuffer, mimeType)` that returns `{ type:'document', source:{ type:'base64', media_type:'application/pdf', data } }` for PDFs and `{ type:'image', source:{ type:'base64', media_type, data } }` for images, reusing `normalizeImageForAi` where needed. Place it next to `verifyQualificationDocument`.

- [ ] **Step 4: Smoke-load + full test run**

Run: `npx vitest run tests/document-pipeline.test.js tests/name-matching.test.js`
Expected: PASS.

Run: `node -e "require('./server.js')"`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: verify qualification name/type in document pipeline, flag mismatches"
```

---

### Task 6: Surface `flag_reason` in `/api/admin/gp-documents`

**Files:**
- Modify: `server.js` (`/api/admin/gp-documents` ~29741)
- Migration: add `flag_reason` column to `user_documents` if not present.

- [ ] **Step 1: Add the DB column (idempotent)**

Via `rpc/exec_sql` (service key): `ALTER TABLE public.user_documents ADD COLUMN IF NOT EXISTS flag_reason text;`
(See memory: Supabase migrations via exec_sql.)

- [ ] **Step 2: Include `flag_reason` in the admin docs response**

In the handler that builds the "Prepared by Candidate" doc objects, read `flag_reason` from the `user_documents` row and include it on each doc object returned (e.g. `flagReason: row.flag_reason || ''`). Read ~29741–29850 to find the exact mapping and add the field alongside `status`.

- [ ] **Step 3: Smoke-load**

Run: `node -e "require('./server.js')"`
Expected: no error.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: expose flag_reason on admin gp-documents endpoint"
```

---

### Task 7: Admin "Name mismatch" badge

**Files:**
- Modify: `pages/admin.html` (Prepared-by-Candidate rendering ~2894)

- [ ] **Step 1: Render the badge**

Where each candidate doc card/row is built, when `d.flagReason === 'name_mismatch'` show a red badge labelled `Name mismatch`; when `d.flagReason === 'failed_verification'` show an amber `Needs review` badge; otherwise keep the existing status badge. Use the existing badge markup/classes in that section. Bump the script cache-buster (`?v=YYYYMMDD[letter]`) on `admin.html` per repo convention.

- [ ] **Step 2: Manual verification note**

This is admin-only rendering; verify by loading the admin docs view for Smith Miller after Task 9 backfill — the degree should show "Name mismatch".

- [ ] **Step 3: Commit**

```bash
git add pages/admin.html
git commit -m "feat: distinct Name mismatch badge in admin candidate docs"
```

---

### Task 8: Route the two localStorage-only upload paths through the server

**Files:**
- Modify: `js/qualification-scan.js` (~618–635 and ~695–712)
- Modify: `pages/ahpra.html` (`saveMissingUploadToDocuments` ~3202)

- [ ] **Step 1: qualification-scan.js — PUT after scan**

In both result handlers (image branch ~617 and PDF branch ~694), after writing `localStorage`, add a best-effort upload so the server pipeline runs. Use the canonical key (map `docType` → canonical qualification key; for the degree this is `primary_medical_degree`). The scan already has the file (`file`) and base64 (`base64`):

```js
try {
  fetch('/api/prepared-documents', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      country: (state.country || 'uk'),
      key: canonicalKeyFor(docType),   // e.g. 'primary_medical_degree'
      fileName: file.name,
      mimeType: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'),
      fileSize: file.size || 0,
      fileDataUrl: 'data:' + (file.type || 'application/octet-stream') + ';base64,' + base64
    })
  }).catch(function () {});
} catch (e) {}
```

Add a small `canonicalKeyFor(docType)` map at the top of the file (Primary Medical Degree → `primary_medical_degree`, MRCGP → `mrcgp_certified`, CCT → `cct_certified`, Certificate of Good Standing → `certificate_good_standing`, etc.). If a docType has no mapping, fall back to the existing slug.

- [ ] **Step 2: ahpra.html saveMissingUploadToDocuments — PUT the file**

In `saveMissingUploadToDocuments` (~3202), after the `localStorage.setItem`, add the same `PUT /api/prepared-documents` using the item's canonical `key`, reading the file as a data URL (use a `FileReader` like the intro handler at ~2686, or reuse the existing dataURL if available). Keep it best-effort (`.catch`).

- [ ] **Step 3: Bump cache-busters**

Update the `?v=YYYYMMDD[letter]` query on the `qualification-scan.js` script tag (search across `pages/*.html`) and on any changed inline script in `ahpra.html`, per repo convention.

- [ ] **Step 4: Manual verification**

Load the scan modal locally (`npm start`), scan a test PDF; confirm a `PUT /api/prepared-documents` fires (network tab / server log) and a `user_documents` row appears.

- [ ] **Step 5: Commit**

```bash
git add js/qualification-scan.js pages/ahpra.html pages/*.html
git commit -m "feat: route scan + missing-doc uploads through server pipeline"
```

---

### Task 9: One-off backfill — Smith Miller's flagged task

**Files:** none (data operation, run at deploy time)

- [ ] **Step 1: Create the task via PostgREST (service key)**

Insert a `flagged_doc` task for his existing mismatched degree (dedup-checked first):

```
case_id = 10a3c2d8-aefc-43c7-af3c-7ae5c014ea97
task_type = flagged_doc
title = Review flagged qualification: Primary Medical Degree
description = Name on document ("Mohammed Avais Hussain") does not match account ("Smith Miller").
priority = normal
source_trigger = prepared_doc_scan
related_document_key = primary_medical_degree
status = open
```

First query `registration_tasks?case_id=eq.<id>&task_type=eq.flagged_doc&related_document_key=eq.primary_medical_degree` to confirm none exists, then POST. (Match the exact columns/required fields of `registration_tasks`; mirror what `_createRegTask` inserts.)

- [ ] **Step 2: Verify**

Re-query and confirm one open `flagged_doc` task exists for the case. Confirm it appears in the admin Ops queue.

---

### Task 10: Full verification + deploy

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all pass (no regressions).

- [ ] **Step 2: Boot the server locally**

Run: `npm start` and confirm clean startup; load the admin docs view.

- [ ] **Step 3: Merge to main and deploy**

Production deploy = push to `origin/main` (Vercel auto-builds). Merge the feature branch into `main` (fast-forward or PR), then push. (See memory: deploy verification + admin host.)

- [ ] **Step 4: Post-deploy check**

After Vercel build completes, confirm Smith Miller's degree shows "Name mismatch" in admin and the Ops queue shows his flagged task.

---

## Self-Review

- **Spec coverage:** Part 1 → Task 8; Part 2 → Tasks 1,3,5; Part 3 → Tasks 1,2,4,5; Part 4 → Tasks 6,7,9. Tests → Tasks 1,2 (pure) + 3,5 (regression). Deploy → Task 10. All spec sections mapped.
- **Type consistency:** `classifyQualificationOutcome` returns `{action,status,reasonKind}` (Task 1), consumed in Task 5. `buildFlagReason(kind, opts)` (Task 2) called with the same `reasonKind` values (`name_mismatch`/`failed_verification`). `createFlaggedDocTask(userId, documentKey, label, reason)` (Task 4) called with matching args in Task 5. `flag_reason` column (Task 6) ↔ `flagReason` API field (Task 6) ↔ `d.flagReason` in admin (Task 7) — note the snake_case DB column vs camelCase API field is intentional and bridged in Task 6 Step 2.
- **Placeholders:** decision/reason logic and tests are concrete. Server-wiring tasks reference exact functions/line numbers and require the implementer to read the current block before editing (unavoidable in a 30k-line monolith); the new code to add is shown in full.
- **Open detail for implementer:** `_createRegTask` field whitelist (Task 4 Step 1) and the exact `registration_tasks` required columns (Task 9) must be confirmed by reading those definitions — flagged in-task.
