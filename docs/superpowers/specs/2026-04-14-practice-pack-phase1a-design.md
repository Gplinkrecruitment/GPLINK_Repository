# Practice Pack Phase 1a — Design Spec

## Overview

Redesign of the 5 practice pack document tasks so each has its own distinct flow. Phase 1a covers Section G, Position Description, Offer/Contract, Supervisor CV, and Google Drive folder integration. Phase 2 covers SPPA-00 via Zoho Sign API (deferred until API tokens are generated).

## Document Flows

### 1. SPPA-00 (Phase 2 — deferred)

Sent via Zoho Sign API. Contact signs first, then Candidate. VA reviews completed signed document against checklist (fields complete, name matches, signatures present). VA approves → PDF to GP MyDocuments + Google Drive.

**Not implemented in Phase 1a.** Task is created but action buttons are disabled with a "Pending Zoho Sign setup" label.

### 2. Section G — Auto-Delivery

**Trigger:** GP enters AHPRA stage (career secured + AMC verified, detected in `processRegistrationTaskAutomation`).

**Flow:**
1. Static PDF (`section_g.pdf`) is stored in the repo under a documents directory
2. On AHPRA stage entry, server:
   - Delivers Section G PDF reference to GP's MyDocuments
   - Uploads Section G PDF to Google Drive folder (`GP Candidate Documents/Dr [Name]/Section G.pdf`)
   - Auto-completes the Section G task with `completed_by: 'system'`
   - Logs timeline event: "Section G auto-delivered to MyDocuments"

**No VA action required.**

### 3. Position Description — AI-Generated

**Trigger:** VA clicks "Generate" button on the Position Description task in the admin dashboard.

**Data sources (already in user state / Zoho Recruit):**
- `practiceName` — from placement object in `gp_career_state`
- `roleTitle` — from placement object
- `location` — from placement object
- Job opening details — from Zoho Recruit if needed for additional context

**Flow:**
1. VA clicks **"Generate"** on the Position Description task card
2. Server calls Anthropic API with practice name, role title, location to generate a professional position description for a GP joining that practice
3. Generated content returned as rich text / HTML
4. VA sees an editable preview panel in the admin dashboard
5. VA can edit the text as needed
6. VA clicks **"Approve & Send to GP"**
7. Server converts HTML to PDF
8. PDF saved to GP's MyDocuments
9. PDF uploaded to Google Drive folder
10. Task marked complete
11. Timeline event logged

**AI prompt context:** Generate a professional position description for a General Practitioner joining [Practice Name] in [Location] for the role of [Role Title]. Include practice overview, key responsibilities, supervision arrangements, working hours expectations, and professional development opportunities.

### 4. Offer/Contract — Zoho Recruit Attachments + Manual Upload

**Trigger:** Practice pack tasks created (career secured).

**Automatic check on task creation:**
Server calls `listZohoRecruitApplicationAttachments` for the GP's job application and uses `scoreZohoContractAttachment` to find the best-matching contract/offer document.

**Path A — Attachment found on Zoho Recruit:**
1. Task displays: "Contract found on Zoho Recruit: [filename]"
2. VA clicks **"Review Document"** to preview/download the attachment
3. VA reviews the document
4. VA clicks **"Submit"** → document saved to GP MyDocuments + Google Drive
5. Task marked complete

**Path B — No attachment found:**
1. Task displays: "No contract found on Zoho Recruit"
2. VA sees a **mailto: link** pre-filled:
   - **To:** practice contact email (from placement `practiceContact.email`)
   - **Subject:** `Offer/Contract Required — Dr [GP Name] at [Practice Name]`
   - **Body:** `Hi [Contact Name],\n\nWe require the completed employment agreement between [Practice Name] and Dr [GP Name] for the [Role Title] position.\n\nPlease reply with the signed document attached.\n\nKind regards,\nGP Link Team`
3. Task status updates to "Waiting on practice"
4. VA receives reply manually (Phase 1b will auto-parse Gmail)
5. VA **uploads the document** to the task via file upload button
6. VA reviews → clicks **"Submit"** → saved to GP MyDocuments + Google Drive
7. Task marked complete

**Both paths require VA review and explicit submit.**

### 5. Supervisor CV — mailto + Manual Upload

**Flow:**
1. Task shows a **mailto: link** pre-filled:
   - **To:** practice contact email
   - **Subject:** `Supervisor CV Required — Dr [GP Name] at [Practice Name]`
   - **Body:** `Hi [Contact Name],\n\nWe require the supervising doctor's CV for Dr [GP Name]'s Specialist Registration application at [Practice Name].\n\nPlease reply with the supervisor's CV attached.\n\nKind regards,\nGP Link Team`
2. After VA clicks mailto, task status updates to "Waiting on practice"
3. VA receives reply manually (Phase 1b will auto-parse Gmail)
4. VA **uploads the document** via file upload button on the task
5. VA reviews → clicks **"Submit"** → saved to GP MyDocuments + Google Drive
6. Task marked complete

## Google Drive Integration

### Folder Structure
```
GP Candidate Documents/
├── Dr [First] [Last]/
│   ├── Section G.pdf
│   ├── Position Description.pdf
│   ├── Offer-Contract.pdf
│   ├── Supervisor CV.pdf
│   ├── SPPA-00.pdf          (Phase 2)
│   ├── Certified Copies/
│   │   └── ...
│   ├── CCT.pdf
│   ├── CV.pdf
│   └── [other qualification docs]
```

### Trigger
- Folder created when GP enters AHPRA stage (same trigger as Section G auto-delivery)
- At creation time, any existing qualification documents already in the system are synced to the folder

### Ongoing Sync
- Every document approved/submitted via VA dashboard is uploaded to the GP's Drive folder
- Every document delivered to GP MyDocuments is uploaded to Drive

### Authentication
- Google service account with access to a shared Drive folder
- Same credentials will be reused for Gmail API in Phase 1b
- Env vars: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`

## Server Changes (server.js)

### New API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /api/admin/va/task/:taskId/generate-position-description` | POST | AI-generate position description |
| `POST /api/admin/va/task/:taskId/approve-document` | POST | Approve & send document to GP MyDocuments + Drive |
| `POST /api/admin/va/task/:taskId/upload-document` | POST | VA uploads a document to a task (multipart) |
| `GET /api/admin/va/task/:taskId/preview-document` | GET | Preview/download attached document |
| `POST /api/admin/va/task/:taskId/check-zoho-attachment` | POST | Re-check Zoho Recruit for contract attachment |

### New Helper Functions

- `createGoogleDriveGPFolder(gpName)` — creates the folder structure
- `uploadToGoogleDrive(folderId, fileName, buffer, mimeType)` — uploads a file
- `syncExistingDocsToGoogleDrive(userId, folderId)` — syncs existing qualification docs
- `generatePositionDescriptionHTML(practiceName, roleTitle, location)` — AI generation
- `convertHtmlToPdf(html)` — server-side HTML→PDF conversion (using puppeteer or similar)
- `deliverToMyDocuments(userId, docKey, fileName, buffer, mimeType)` — saves to GP's MyDocuments + uploads to Drive
- `buildMailtoLink(to, subject, body)` — generates mailto: URI with encoded params

### Automation Changes

In `processRegistrationTaskAutomation`, when AHPRA stage is entered:
1. Create Google Drive folder for the GP
2. Deliver Section G PDF to MyDocuments
3. Upload Section G PDF to Drive folder
4. Auto-complete Section G task
5. Sync any existing qualification docs to Drive

On practice pack task creation (career secured):
1. Check Zoho Recruit attachments for Offer/Contract
2. If found, store reference on the task record (new `attachment_meta` JSON column or field in task description)

## Admin Dashboard Changes (pages/admin.html)

### Task Card Actions by Document Type

Each `practice_pack_child` task renders different action buttons based on `related_document_key`:

| Document Key | Actions |
|---|---|
| `sppa_00` | Disabled "Send SPPA-00" button with "Pending Zoho Sign setup" label |
| `section_g` | No action needed (auto-completed). Shows "Auto-delivered" badge |
| `position_description` | "Generate" button → editable preview → "Approve & Send to GP" |
| `offer_contract` | "Review Document" (if attachment found) OR mailto link + file upload → "Submit" |
| `supervisor_cv` | mailto link + file upload → "Submit" |

### Position Description Editor
- Modal/panel with rich text editor (contenteditable div or lightweight editor)
- Pre-populated with AI-generated content
- "Approve & Send to GP" button at bottom

### File Upload Component
- Drag-and-drop or file picker on Offer/Contract and Supervisor CV tasks
- Accepts PDF, DOC, DOCX
- Shows uploaded file name with preview link
- "Submit" button enabled after upload

## Database Changes

### registration_tasks table
- Add `attachment_url` (text, nullable) — stores reference to uploaded/found document
- Add `attachment_filename` (text, nullable) — original filename
- Add `zoho_attachment_id` (text, nullable) — Zoho Recruit attachment ID if sourced from there
- Add `google_drive_file_id` (text, nullable) — Drive file ID once uploaded

### registration_cases table
- Add `google_drive_folder_id` (text, nullable) — the GP's Drive folder ID

## Dependencies

- **Google APIs**: `googleapis` npm package for Drive API
- **PDF generation**: `puppeteer` (or lighter alternative like `html-pdf-node`) for HTML→PDF
- **Static file**: `section_g.pdf` stored in repo under `documents/` directory

## Environment Variables (new)

| Variable | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google service account email |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Google service account private key |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID of the "GP Candidate Documents" root folder |

## Phase 1b (future)

- Gmail API watch/push notifications for inbound email parsing
- Auto-extract attachments from practice contact replies
- Auto-link to Offer/Contract and Supervisor CV tasks
- Same Google service account credentials

## Phase 2 (future)

- Zoho Sign API OAuth integration
- SPPA-00 send flow with signing status progression
- Zoho Sign webhook for status updates
- VA review checklist before approval
