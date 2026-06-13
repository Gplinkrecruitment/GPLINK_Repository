# Auto-submit qualification document for manual review after 3 failed AI scans

**Date:** 2026-06-14
**Status:** Approved — ready for implementation plan

## Problem

When a doctor uploads a certified qualification document on the **My Documents** page, the AI scans it (document classification + certification check + name match against the account). On any failure the current code:

1. Increments a per-document fail counter (`certFailCounts[key]`, client-side localStorage).
2. **Deletes the document and the file** (`delete state.docs[key]`, `deletePreparedDocumentFile`).
3. Shows a "Scan Failed" popup. At ≥3 fails it shows a **"Contact support"** button.

The file is **never uploaded to the server on a failure** — only a successful scan calls `savePreparedDocumentFile` → `PUT /api/prepared-documents`. So a doctor whose document the AI keeps mis-judging (e.g. a legitimate name mismatch because their married/maiden name differs) hits a dead-end: their file is thrown away and the only path forward is "contact support."

## Goal

After **3 failed AI scan attempts** on a document, stop discarding the file. Keep the latest upload, send it to the server flagged for **manual review**, show the doctor **"Under review"**, and route the document into the **existing RSO approve/reject workflow** — without the AI re-judging (and potentially auto-rejecting) it again.

If the upload fails due to a bad connection, the file stays cached locally and is **automatically retried** when the connection returns or the next time the page loads — never a dead-end, never a re-upload.

## Existing systems reused (no new admin UI / review endpoint)

- **RSO review queue** = `registration_tasks` rows with `task_type = 'doc_review'` + the matching `user_documents` row at `status = 'under_review'`. This is the same queue medium-confidence AI uploads already land in. Staff approve/reject from it today.
- **Upload endpoint** = `PUT /api/prepared-documents` (server.js ~28120). Saves the file to Supabase storage + `user_documents`, then runs the background AI pipeline `processDocumentUpload`.
- **Task creator** = `createDocReviewTask(userId, documentKey, expectedLabel, confidence, aiResult)` (server.js ~18683). Idempotent — reuses/reopens an existing open `doc_review` task for the same doc key.
- **Client file cache** = the document's `fileDataUrl` (base64) is already held in `state.docs[key]` / the prepared-docs localStorage. No new storage needed for the retry cache.

## Design

### 1. Client — `pages/my-documents.html`

**a. Thread `storedFile` into the failure path.** Today the cert-scan failure branches set `state.docs[key] = { uploaded:false, fileName:file.name }` and discard the `storedFile` object before calling `handleCertFailure`. Change the failure callers (in `runCertificationCheck` and the mobile scan flow) to pass the `storedFile` through so the 3rd-fail branch has the file data.

**b. `handleCertFailure` branches at the threshold.** When `incCertFailCount(key)` reaches `CERT_SUPPORT_THRESHOLD` (3), call a new `submitDocForManualReview(...)` instead of deleting the doc. Below the threshold, behavior is unchanged (delete + "attempts remaining" message).

**c. New `submitDocForManualReview(key, state, country, storedFile, docTitle, reason)`:**
- Set `state.docs[key]` → `{ uploaded:true, fileName, status:"under_review", manualReview:true, manualReviewReason:reason, pendingServerUpload:true, submittedAt:<iso> }`, persist (force), render. Doctor immediately sees **"Under review."**
- Call `savePreparedDocumentFile(country, key, storedFile)` with a new `forceReview:true` flag and `reviewReason:reason`.
  - **Success:** clear `pendingServerUpload`, persist. Popup: *"We've submitted your document for manual review. Our team will check it within 24 hours."*
  - **Failure (network/storage):** leave `pendingServerUpload:true` and the cached file in place. Same reassuring popup (still "Under review") — the retry layer handles delivery. No "Contact support" dead-end.

**d. Retry layer (new, small):**
- `flushPendingDocUploads()` scans `state.docs` for entries with `pendingServerUpload:true` that still hold a cached `fileDataUrl`, and re-attempts `savePreparedDocumentFile(..., forceReview:true)` for each; clears the flag on success.
- Triggered on: (i) `window.addEventListener("online", ...)`, and (ii) page/docs init (after state loads). Best-effort and idempotent (server `createDocReviewTask` dedupes).
- If a pending doc has no cached `fileDataUrl` (e.g. evicted), leave it `under_review` + `pendingServerUpload` and let a later successful re-scan/upload resolve it; never crash.

**e. `savePreparedDocumentFile`** gains optional flags in its request body: `forceReview` and `reviewReason`, passed straight through to the server.

### 2. Server — `server.js`, `PUT /api/prepared-documents`

Read `body.forceReview === true` (and `body.reviewReason`, trimmed/capped) directly from the raw body (not via `sanitizePreparedDocumentPayload`, which strips unknown fields). After `savePreparedDocumentForUser` succeeds:

- **If `forceReview`:**
  - PATCH `user_documents` → `status:'under_review'` (instead of `'processing'`), `rejection_reason:''`.
  - `await createDocReviewTask(userId, key, docLabel, null, { reason: reviewReason || 'Submitted for manual review after 3 failed AI scans', identifiedAs:'', reasoning: reviewReason })`.
  - Push the existing "under review" notification (`pushDocumentNotificationToUser`).
  - **Do NOT call `processDocumentUpload`** (skip AI re-classification).
  - Respond `{ ok:true, document: { ...saved, status:'under_review' } }`.
- **Else:** unchanged (status `'processing'` + background `processDocumentUpload`).

The `doc_review` task created here is structurally identical to the one the AI `va_review` path creates, so it appears in the RSO queue with no admin-side changes.

## Edge cases

- **3rd fail definition:** auto-submit fires on the 3rd failed scan (`fails >= 3`), per product decision.
- **Idempotent re-submits:** `createDocReviewTask` reopens an existing open task rather than duplicating; safe to retry.
- **Reason surfaced to RSO:** the last AI failure message (e.g. "Name mismatch") is passed as `reviewReason` so staff know why it was escalated.
- **forceReview only valid with a file:** if no `fileDataUrl` reaches the endpoint, treat as a normal bad payload (no task created).
- **Offline at submit + page closed:** file persists in localStorage; `flushPendingDocUploads` on next load delivers it.
- **Account status:** unlike the support-ticket path, manual-review submission does **not** force `account_status='under_review'` for the whole account — only the single document goes to review.

## Testing

- Repo uses **vitest** (`npm test`). Add focused tests for the server `forceReview` branch where unit-testable (status set to `under_review`, `createDocReviewTask` called, `processDocumentUpload` skipped). The HTTP handler is in the monolithic `server.js`; if it can't be exercised in isolation, extract/assert the branch logic the same way existing tests do, or document manual verification steps.
- Manual verification (stated explicitly as manual): upload a name-mismatching cert 3×, confirm the doc shows "Under review", a `doc_review` task appears in the RSO queue, and the AI pipeline did not auto-reject. Simulate offline on the 3rd submit, confirm retry on reconnect.
