# Document Upload Pipeline — AI Verification, Google Drive Sync & VA Review

**Date:** 2026-04-24
**Status:** Approved

## Overview

Every document a GP uploads — across all pages and endpoints — goes through a unified background processing pipeline that:
1. Sanitises and validates the file
2. Runs AI classification to verify it matches the expected document type
3. Based on confidence: auto-approves, sends to VA, or auto-rejects
4. Approved documents are uploaded to the GP's Google Drive folder and appear as verified on My Documents with a download button

## File Sanitisation & Security

Every upload passes through a sanitisation layer before any processing:

### Input Validation
- **File size cap:** 10MB maximum
- **MIME type allowlist:**
  - `application/pdf`
  - `image/jpeg`, `image/png`, `image/webp`, `image/heic`
  - `application/msword` (DOC), `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX)
- **Magic byte verification:** Read first bytes of the file buffer to confirm the actual file type matches the claimed MIME type. Prevents renaming executables to accepted extensions.
- **Filename sanitisation:** Strip path traversal (`../`), null bytes, control characters. Allow only alphanumeric, hyphens, underscores, periods. Limit to 255 characters. The user-provided filename is used for display only — storage paths are server-generated.
- **Base64 payload validation:** Reject if the decoded buffer doesn't match expected magic bytes for the claimed type.

### Content Security
- **Images:** Strip all EXIF/XMP metadata before storage (prevents embedded script injection, removes GPS/device data).
- **PDFs:** Validate header starts with `%PDF-`. Reject files containing embedded JavaScript, `/Launch`, `/OpenAction`, or `/AA` action tags.
- **DOC/DOCX:** Validate ZIP structure (DOCX) or OLE structure (DOC). No executable macro scanning needed — files are only used for text extraction, never executed.
- **No raw SQL anywhere:** All database access goes through Supabase PostgREST (parameterised). User-provided strings are never interpolated into queries.

### Storage Security
- Files stored at server-generated paths: `users/{userId}/prepared-documents/{country}/{documentKey}/current`
- Supabase Storage bucket (`gp-link-documents`) has RLS: authenticated users access only their own path prefix
- Signed download URLs expire after 5 minutes

## Background Processing Pipeline

### Entry Point

A single function `processDocumentUpload()` is called by all existing upload endpoints after the file is saved to Supabase Storage. The function runs in the background — the upload endpoint returns 200 immediately with `status: "processing"`.

### Affected Endpoints

All GP-side upload endpoints call the pipeline:
- `PUT /api/prepared-documents` — registration documents (qualifications, certificates)
- `PUT /api/onboarding-documents` — onboarding wizard documents
- `POST /api/career/upload-cv` — CV upload for career
- `PUT /api/account/career-documents` — CV and cover letter from Account page
- Any future upload endpoint

### AI Classification

**Images and PDFs (visual classification):**
- Sent to Claude Sonnet 4.6 via the existing `/api/ai/classify-document` logic
- Image normalisation: files >400KB are compressed via the `normalize-scan-image` Supabase Edge Function (quality 72, max 1200px) to reduce token cost
- Prompt asks: does this document match the expected type? What does it actually appear to be? Return confidence score 0-100.

**DOCX files (text classification):**
- Text extracted server-side using the `mammoth` library (lightweight, ~200KB)
- Extracted text sent to Claude as a text prompt (not vision)
- Same classification logic: does the content match expected document type?

**DOC files (legacy Word, no text extraction):**
- Classified by filename + document key heuristics only
- If heuristic confidence is below 70%, falls through to VA review

### Confidence Thresholds

| Confidence | Action | Status | Google Drive | Notification |
|---|---|---|---|---|
| >= 70% | Auto-approve | `approved` | Upload to GP folder | None (silent) |
| 40-69% | Send to VA | `under_review` | Not yet | "We're reviewing your [doc]" |
| < 40% | Auto-reject | `rejected` | Not uploaded | "This appears to be [X] but we expected [Y]" |

### Failure Handling

If the AI call fails for any reason (API down, rate limited, timeout, malformed response):
- Document falls through to VA review (`status: "under_review"`, VA task created)
- The GP never sees an error — worst case their document goes to VA instead of auto-approving
- Error logged server-side for monitoring

## VA Review Workflow

### Task Creation (40-70% confidence or AI failure)

A `registration_task` row is created:
- `task_type`: `"doc_review"`
- `title`: "Review uploaded [document name] for Dr [GP name]"
- `priority`: `"normal"` (bumped to `"high"` if the document blocks a registration step)
- `source_trigger`: `"doc_upload"`
- `related_document_key`: the document key (e.g., `primary_medical_degree`)
- `ai_match_confidence`: the confidence score (0-100)
- `ai_match_reasoning`: what the AI identified the document as

### VA Actions

**Approve:**
- `user_documents.status` -> `"approved"`
- Upload file to Google Drive (GP's folder)
- Store `google_drive_file_id` on the `user_documents` row
- In-app notification to GP: "[doc name] has been reviewed and verified. You can download it from My Documents."
- Task status -> `"completed"`

**Reject:**
- VA writes a short rejection reason (free text)
- `user_documents.status` -> `"rejected"` with `rejection_reason` stored
- In-app notification to GP: "[doc name] needs attention — [reason]"
- Task status -> `"waiting"` (waiting on GP to re-upload)

### Re-Upload Flow

When a GP re-uploads a document that was previously rejected:
1. The new file replaces the old one in Supabase Storage (same path)
2. `user_documents.status` set to `"processing"`
3. Background pipeline runs on the new file
4. Outcomes:
   - AI confidence >= 70%: auto-approve, task auto-closes (`"completed"`)
   - AI confidence 40-70%: task status resets to `"open"`, VA reviews again
   - AI confidence < 40%: task stays at `"waiting"`, GP sees new rejection reason

## Google Drive Integration

### Upload on Approval

When a document is approved (by AI or VA):
1. `ensureGPDriveFolder()` — creates `Dr [FirstName] [LastName]` folder in root if it doesn't exist, stores folder ID on `registration_cases`
2. `uploadToGoogleDrive()` — uploads the file to the GP's folder
3. Store the returned `google_drive_file_id` on `user_documents`

### File Replacement on Re-Upload

Each `document_key` gets exactly one file per GP in their Drive folder. When a replacement is approved:
1. Look up existing `google_drive_file_id` from `user_documents`
2. If it exists, call `drive.files.delete(fileId)` to remove the old version
3. Upload the new file
4. Update `google_drive_file_id` with the new file ID

Rejected documents are never uploaded to Google Drive. Only approved documents exist in Drive — always the latest approved version.

## My Documents Page

### Document Card Display

Each document card on My Documents shows status based on `user_documents.status`:

| Status | Badge | Actions Available |
|---|---|---|
| `processing` | Blue "Processing" | None (spinner/pulse animation) |
| `under_review` | Blue "Under Review" | None |
| `approved` | Green "Verified" | Download button |
| `rejected` | Amber "Needs Attention" | Shows rejection reason + re-upload button |
| `pending` | Grey "Not uploaded" | Upload button |

The download button calls `/api/prepared-documents/download?country=X&key=Y` which generates a 5-minute signed Supabase URL.

## In-App Notifications

Using the existing updates panel (`js/updates-sync.js` + bell icon):

| Trigger | Title | Body |
|---|---|---|
| Sent to VA review | "[Doc name] under review" | "We're reviewing your document. This usually takes less than 24 hours." |
| Auto-rejected | "[Doc name] needs attention" | "This appears to be a [identified as] but we expected a [expected]. Please re-upload the correct document." |
| VA approved | "[Doc name] verified" | "Your document has been reviewed and verified. You can download it from My Documents." |
| VA rejected | "[Doc name] needs attention" | "[VA's rejection reason]. Please re-upload from My Documents." |

**No notification for auto-approved documents.** The GP simply sees the document appear as verified on My Documents.

## Future Notification Catalogue

For future email + WhatsApp integration (not built in this phase):

**Account & Auth:**
1. Welcome / account created
2. Password reset requested
3. Account status changed

**Documents:**
4. Document auto-approved by AI
5. Document sent to VA for review
6. Document approved by VA
7. Document rejected by VA

**Registration Journey:**
8. MyIntealth step completed
9. AMC step completed
10. AHPRA step unlocked
11. AHPRA step completed
12. PBS & Medicare step unlocked
13. Commencement checklist available

**Practice / Placement:**
14. Placement confirmed
15. Practice pack document ready for signature
16. Practice pack fully completed
17. Start date reminder (7 days, 1 day)

**Support:**
18. New message from GP Link team
19. Support ticket update / resolved

**Admin-initiated:**
20. VA nudge — action needed
21. Registration stalled reminder

## Database Changes

### New column on `user_documents`:
- `google_drive_file_id` TEXT DEFAULT '' — tracks the Drive file for replacement/deletion
- `rejection_reason` TEXT DEFAULT '' — VA's rejection reason
- `ai_classification_confidence` INTEGER DEFAULT NULL — AI confidence score (0-100)
- `ai_classification_result` TEXT DEFAULT '' — what the AI identified the document as

### New task type:
- `doc_review` added to `registration_tasks.task_type` allowed values

## Dependencies

### New npm package:
- `mammoth` — DOCX text extraction (~200KB, well-maintained, no native dependencies)

### Existing infrastructure used:
- Claude Sonnet 4.6 via Anthropic API (AI classification)
- Google Drive API via service account (file upload/delete)
- Supabase Storage (file storage)
- Supabase PostgREST (database)
- `normalize-scan-image` Edge Function (image compression)
