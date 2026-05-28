# Offer/Contract Signature Chase — Design Spec

## Problem

Currently, the offer/contract is uploaded to Zoho Recruit right after the candidate signs, but the employer often hasn't counter-signed yet. The contract is auto-delivered to Drive and marked complete when the candidate reaches the AHPRA stage (`career_secured`). This means incomplete contracts (missing employer signature) sit in the system unnoticed, and the admin only chases the employer's signature late in the process.

## Goal

Move the offer/contract check to onboarding completion so incomplete contracts are caught early. Use AI to detect whether the contract has one or both signatures. If only the candidate has signed, deploy a task to admin immediately so they can chase the employer's counter-signature. When the practice sends back the fully-signed version, admin compares and replaces the old contract.

## Design

### Trigger: Onboarding Complete

At `/api/onboarding/complete` (server.js:22238), after existing background jobs fire, a new async job runs:

1. Look up the user's hired Zoho application (from `gp_applications` where `status='hired'` and `user_id` matches)
2. If no application exists, skip — the contract chase will trigger later when Zoho sync links them
3. Download the top-scoring contract attachment from Zoho using the existing `listZohoRecruitApplicationAttachments()` + `selectZohoContractAttachmentCandidates()` scoring logic
4. Pass the document buffer + mime type to the AI signature scanner

### AI Signature Scan

A new function `scanContractSignatures(buffer, mimeType, filename)` that:

1. Converts the document to a format Claude can analyze:
   - **PDF:** Send as base64 PDF directly (Claude supports native PDF input)
   - **Images (PNG, JPG, HEIC):** Send as base64 image
   - **DOCX/DOC:** Send as base64 file (Claude can read DOCX natively); for DOC, attempt conversion or send as-is and note format limitations in the prompt
2. Calls Claude Opus via the Anthropic API with a structured prompt requesting JSON output:
   ```json
   {
     "signature_count": 1,
     "has_candidate_signature": true,
     "has_employer_signature": false,
     "confidence": "high",
     "notes": "Employer signature block on page 4 is blank"
   }
   ```
3. Returns the parsed result. On failure/ambiguity, defaults to `{ has_employer_signature: false }` so the task deploys to admin (safe default).

### AI Contract Diff (Zoho Re-upload)

A new function `diffContracts(oldBuffer, oldMime, newBuffer, newMime)` that:

1. Sends both documents to Claude with a prompt: "Compare these two versions of the same employment contract. Identify any differences in terms, conditions, dates, salary, hours, location, or other substantive changes. Be specific."
2. Returns a short summary string (e.g., "Salary changed from $180,000 to $195,000. Start date moved from 1 Jan to 15 Feb. Supervision hours reduced from 8 to 6 per week.")
3. This summary is stored on the task and displayed to admin.

### Decision Logic After Scan

**Both signatures detected:**
- Run the existing completion flow: `deliverOfferContract()` (uploads to Drive, updates `user_documents`, `gp_prepared_docs`, marks task complete)
- No task deployed to admin

**Single/zero signatures or scan failure:**
1. `_ensureRegCase(userId)` to guarantee a registration case exists
2. Create a `practice_pack_child` task:
   - `task_type`: `practice_pack_child`
   - `related_document_key`: `offer_contract`
   - `title`: `Offer / Contract`
   - `source_trigger`: `onboarding_signature_check`
   - `status`: `open`
   - `zoho_attachment_id`: the Zoho attachment ID (for re-upload detection)
3. Store the candidate-signed contract as a `task_documents` record (so "View" works in admin)
4. Store the AI scan result in a `task_timeline` entry for admin context (e.g., "AI scan: candidate signature detected, employer signature missing")

### Admin Email Composer

The `renderOpsPracticePackChild` function already has a State A email composer for tasks with no outbound messages. For the offer_contract task specifically:

- **Pre-filled template:**
  - To: practice contact email
  - Subject: "Signed Offer/Contract needed for Dr [Name] - GP Link"
  - Body: "Hi [contact],\n\nWe are preparing the registration documents for Dr [name] and need the following: **Offer / Contract** with both the candidate and employer signatures.\n\nPlease find attached the contract already signed by the candidate. Could you please counter-sign and return the completed contract at your earliest convenience?\n\nKind regards,\nHazel — GP Link Registration Team"
- **Auto-attach the candidate-signed contract** to the outgoing email. The email send endpoint (`/api/admin/email/send`) already supports attachments. The frontend needs to include the attachment data from `task_documents` in the request payload automatically for offer_contract tasks.

### Practice Response & Admin Review

When the practice emails back (handled by existing Gmail response matching at server.js:1792-1825):
- New attachment stored in `task_documents` as current version (existing flow)
- Previous version marked `is_current: false` (existing flow)
- Task status flipped to `open` for admin review (existing flow)

**Admin review UI changes in `renderOpsPracticePackChild` (State B, offer_contract only):**

1. Current doc shown with "View" (existing)
2. New **"View previous version"** button — opens the `is_current: false` doc in the preview modal
3. If a contract diff summary exists on the task (from Zoho re-upload), show an **amber banner** with the AI-generated differences

### Submit to Drive & Complete

When admin clicks "Submit to Drive & Complete" for an offer_contract task:

1. Upload the new fully-signed contract to Drive (existing flow in `/api/admin/task/submit-drive`)
2. **Delete the old incomplete contract from Google Drive** if it had been previously uploaded (check for a prior `google_drive_file_id` on the old `task_documents` record or `user_documents`)
3. Update `user_documents` and `gp_prepared_docs` to point to the new file (existing flow)
4. Mark task complete (existing flow)

### Zoho Re-upload Detection

During Zoho Recruit sync (`syncZohoRecruitApplicationStatuses()`), after fetching the live record:

1. For each synced application with a linked user, check if an open/waiting offer_contract task exists
2. List the application's attachments and score for contracts
3. Compare the top attachment ID against the task's `zoho_attachment_id`
4. If different (new upload):
   a. Download the new contract
   b. Run AI signature scan
   c. Download the old contract from task_documents and run AI diff — store summary on the task
   d. Replace the contract in `task_documents` (mark old as not current, insert new)
   e. Update `zoho_attachment_id` on the task
   f. If new contract has both signatures → auto-complete via `deliverOfferContract()`
   g. If still single-signature → keep task open, log timeline event with diff summary
5. If no task exists but signature scan shows single-signature → create the task (same as onboarding flow)

### Edge Cases

- **No Zoho application at onboarding:** Skip. The Zoho sync will trigger the check when the application is linked later.
- **No contract attachment in Zoho:** Skip. Task created later when contract is uploaded to Zoho (detected by sync).
- **AI scan fails:** Default to single-signature (deploy task to admin). Safe default.
- **Contract is not PDF (DOCX, HEIC, etc.):** AI scan handles all formats. Claude can analyze PDFs, images, and DOCX natively.
- **Multiple contract attachments:** Use the existing scoring logic (`selectZohoContractAttachmentCandidates`) to pick the best candidate.
- **Task already exists from career_secured:** The onboarding check runs before `career_secured`. If both fire, use the existing `_hasOpenTask()` guard to prevent duplicates. The `career_secured` flow should skip creating an offer_contract task if one already exists.
- **Admin completes task before practice responds:** Normal completion flow. No special handling needed.
