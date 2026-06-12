# Design: Flag mismatched / wrong / failed qualification documents for manual review

**Date:** 2026-06-12
**Status:** Approved (design), pending spec review
**Author:** Claude (with hello@mygplink.com.au)

## Problem

A candidate (Smith Miller, `user_id a505f0b8-fb62-490d-9d63-2c09f800366f`) uploaded a "Primary medical degree" that belongs to a different person ("Mohammed Avais Hussain"). The browser-side AI scan **correctly detected** the name mismatch (`nameMatch: "mismatch"`), but:

1. The document showed only a generic **"Under review"** badge — visually identical to a normal pending document.
2. **No task was created** for GP Link staff to manually check it. Confirmed: his case (`10a3c2d8-...`) has zero `flagged_doc` tasks.
3. The mismatch verdict existed only in client `localStorage` (`gp_documents_prep`), synced to `user_state` as an opaque blob the server never inspects. His degree is **not** in `user_documents` at all — the file never reached the server.

### Root cause (two defects)

- **Defect A — uploads bypass the server.** Two prepared-document upload paths write only to `localStorage`:
  - `js/qualification-scan.js` (scan modal) — writes `gp_documents_prep`, calls `gpLinkStateSync.push()`, never `PUT`s the file.
  - `pages/ahpra.html` `saveMissingUploadToDocuments` (~line 3202) — `localStorage` only.

  Because the file never hits `PUT /api/prepared-documents`, the server's existing `processDocumentUpload()` pipeline never runs. (The `ahpra.html` intro-doc handler at ~line 2709 *does* `PUT`, so it is unaffected by Defect A.)

- **Defect B — the server pipeline checks type, not identity.** `processDocumentUpload()` (`server.js:18744`) runs `classifyDocumentWithAI()` to check the document **type** and routes to `auto_approve` / `va_review` / `rejected`. It never compares the **name on the document** against the account holder. So even a document that reaches the server is not checked for a name mismatch. Additionally, the `rejected` (wrong-type / failed) branch notifies the user but creates **no** staff task.

- **Status clobbering (contributing).** Even when `qualification-scan.js` writes `status: "name_mismatch"`, the non-scanning handlers (`ahpra.html:2704` → `"uploaded"`, `ahpra.html:3207` → `"under_review"`) merge-and-overwrite the status without re-checking the name, downgrading the flag to a benign state.

### Blast radius

Scanned all 4 `user_state` rows. **Smith Miller is the only affected user.** Remediation is one document, not a backfill.

## Goals

1. Every qualification-class document upload is verified server-side for **name match**, **document type**, and **pass/fail**.
2. A name mismatch, wrong type, or failed verification raises a **normal-priority** manual-review task that GP Link staff see in the Ops queue.
3. Tasks are deduped — re-uploading the same document reopens the existing task, never creates duplicates.
4. The admin view visually distinguishes a **name mismatch** from a benign "under review".
5. Smith Miller's existing mismatched document gets a task immediately.

## Non-goals

- No backfill sweep (only one affected user; handled as a one-off).
- No new VA push-notification channel. "Notify the VA" = the task surfacing in the existing Ops queue (no separate VA push channel exists today).
- No changes to the onboarding qualification flow (`/api/onboarding/complete`), which already creates `flagged_doc` tasks correctly.

## Design

Extend existing infrastructure; do not build a parallel system.

### Part 1 — Route all qualification uploads through the server

Make the two `localStorage`-only paths also persist server-side via `PUT /api/prepared-documents` (same call the working handlers already use):

- `js/qualification-scan.js`: after a successful scan, `PUT` the file (`country`, `key`, `fileName`, `mimeType`, `fileSize`, `fileDataUrl`) so it lands in `user_documents` and triggers the pipeline. Continue writing `localStorage` for immediate UI.
- `pages/ahpra.html` `saveMissingUploadToDocuments`: add the same `PUT`.

The document `key` must be the canonical qualification key (e.g. `primary_medical_degree`), not a derived slug, so the server recognises it as qualification-class.

### Part 2 — Add an identity/type/validity check to the pipeline

In `processDocumentUpload()` (`server.js:18744`), for **qualification-class** document keys (`primary_medical_degree`, `mrcgp_certified`, `cct_certified`, `certificate_good_standing`, `confirmation_training`, and the other keys already listed in `getDocumentLabelForKey`), run a name/identity verification step that reuses the AI logic behind `/api/ai/verify-qualification` (`server.js:25701`), which already returns `{ verified, nameMatch, nameFound, documentType, issues }`.

Refactor that AI logic into a shared helper (e.g. `verifyQualificationDocument(fileBuffer, mimeType, expectedDocumentType, profileName)`) so both the HTTP endpoint and the pipeline call the same code.

Outcome routing (qualification-class docs only):

| Condition | Document status | Task |
|-----------|----------------|------|
| `nameMatch` exact/fuzzy AND correct type | `approved` (existing auto-approve) | auto-close existing task |
| `nameMatch === "mismatch"` | `under_review` + reason `name_mismatch` | create `flagged_doc` task |
| wrong type / `verified === false` / failed | `under_review` + reason `failed_verification` | create `flagged_doc` task |

Non-qualification documents keep today's `classifyDocumentWithAI` type-only behaviour unchanged.

### Part 3 — Reuse task creation + dedup + notify

Create a helper `createFlaggedDocTask(userId, documentKey, label, reason)` that:

- Resolves the case via `_ensureRegCase(userId)`.
- Dedups exactly like `createDocReviewTask`: look for an existing `flagged_doc` task on the case with the same `related_document_key` and status in `(open, in_progress, waiting)`. If found, reopen it and append a `task_timeline` entry instead of inserting a duplicate.
- Otherwise inserts a `registration_tasks` row: `task_type: 'flagged_doc'`, **`priority: 'normal'`**, `title: 'Review flagged qualification: <label>'`, `description: <reason>` (e.g. `Name on document ("Mohammed Avais Hussain") does not match account ("Smith Miller")`), `source_trigger: 'prepared_doc_scan'`, `related_document_key: <key>`, `_actor: 'system'`.
- Notifies the GP user via the existing `pushDocumentNotificationToUser()`.

`flagged_doc` is reused (rather than `doc_review`) so these identity/validity flags appear under the existing admin label "Flagged qualification document" alongside onboarding flags. The assigned VA sees the task in the Ops queue (no separate VA push channel).

### Part 4 — Admin badge + Smith Miller backfill

- Persist a machine-readable reason on the `user_documents` row (`rejection_reason` = `name_mismatch` / `failed_verification`, or a dedicated field) so `pages/admin.html` (Prepared-by-Candidate section, fed by `/api/admin/gp-documents` at `server.js:29741`) can render a distinct red **"Name mismatch"** badge, visually separate from "Under review".
- One-off remediation: insert a `flagged_doc` task for Smith Miller's `primary_medical_degree` with reason `Name on document ("Mohammed Avais Hussain") does not match account ("Smith Miller")`. His file is not on the server, so this is a direct task insert (not a pipeline re-run).

## Data flow (after fix)

```
Upload (scan modal | missing-docs | intro handler | my-documents)
  → PUT /api/prepared-documents
    → savePreparedDocumentForUser → user_documents row (status: processing)
    → processDocumentUpload (background)
       → qualification-class? → verifyQualificationDocument(file, profileName)
          → match + right type → approved (+ auto-close task)
          → mismatch          → under_review + reason → createFlaggedDocTask (normal)
          → wrong type/failed  → under_review + reason → createFlaggedDocTask (normal)
       → non-qualification → existing classifyDocumentWithAI behaviour
  → admin.html reads status+reason → "Name mismatch" / "Under review" badge
  → Ops queue shows flagged_doc task → staff action it
```

## Testing

Vitest unit tests (align with existing `tests/` setup):

1. Qualification doc, name mismatch → one `flagged_doc` task created, normal priority, correct reason.
2. Qualification doc, name match + correct type → no task; approved.
3. Qualification doc, wrong type / failed verification → `flagged_doc` task created.
4. Re-upload of a flagged doc → existing task reopened, no duplicate.
5. Non-qualification doc → unchanged type-only behaviour, no identity check.

## Risks & mitigations

- **Extra AI call per qualification upload.** Uploads are infrequent; acceptable cost for closing an identity hole. Only qualification-class keys are re-verified.
- **Shared-helper refactor could change `/api/ai/verify-qualification` behaviour.** Mitigate by extracting logic verbatim and keeping the endpoint's response shape identical; cover with the existing/added tests.
- **`fileSize: 0` / empty mime from some client paths.** Ensure the `PUT` sends real `file.type` / `file.size`; pipeline already validates via `validateFileUpload`.

## Out-of-scope follow-ups (not in this work)

- A dedicated VA push-notification channel (currently queue-only).
- Hardening the client status-clobber writers beyond what Part 1 requires (server is now authoritative, so client status is cosmetic).
