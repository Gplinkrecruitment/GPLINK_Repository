# SPPA-00 Admin Flow — Step 1 Design Spec

## Overview

Step 1 replaces the Zoho Sign SPPA-00 flow with an email-based workflow. The system AI-scans the offer/contract and supervisor CV to detect if the supervisor is the practice owner/director (conflict of interest), programmatically fills Q7 on the SPPA-00 PDF, then guides the VA through sending it to the candidate and handling AHPRA officer correspondence.

**Zoho Sign is scrapped for SPPA-00.** The document is a real PDF form filled programmatically and emailed via the existing Gmail integration (`hazel@mygplink.com.au`).

---

## 1. Task Locking & Unlock Trigger

### 1.1 Locked State

The SPPA-00 practice pack child task exists from practice pack creation but is **locked** until both prerequisite documents are submitted:

- `supervisor_cv` task → status `complete`
- `offer_contract` task → status `complete`

**Admin UI while locked:**
- Task card visible but greyed out / disabled
- Message: *"Waiting for Supervisor CV and Offer/Contract to be submitted"*
- Checklist showing which prerequisites are done vs pending (e.g. ✓ Supervisor CV, ✗ Offer/Contract)
- No action buttons available

### 1.2 Unlock Trigger

When admin completes a `supervisor_cv` or `offer_contract` task, the task completion handler checks:

```
Did I just complete a supervisor_cv or offer_contract?
  → Is the other one also complete for this case?
    → YES: fire the AI conflict scan automatically
    → NO: remain locked
```

No manual trigger — the scan fires as a side effect of the second document being completed.

---

## 2. AI Conflict Scan

### 2.1 Inputs

A single Claude API call (Opus) with four inputs:

1. **Supervisor CV** — document buffer from `task_documents.attachment_url`
2. **Offer/Contract** — document buffer from `task_documents.attachment_url`
3. **MRCGP certificate** — document buffer from qualification verification (already stored in `user_documents`). Authoritative name source for the candidate since it's an official verified document.
4. **GP candidate name from profile** — fallback/additional signal from `registration_cases` or user record

### 2.2 AI Prompt Strategy

The prompt instructs the AI to:

1. Extract the supervisor's full name from the CV
2. Extract the employer/director/signatory/owner name(s) from the contract — looking for roles like "director", "owner", "principal", "employer", "signatory"
3. Extract the candidate/GP name from the MRCGP certificate + contract
4. Exclude the candidate name when identifying the practice owner (fuzzy match across all three name sources to reliably identify the candidate)
5. Compare the supervisor name against the practice owner/director name
6. Return a structured JSON result

### 2.3 Output

```json
{
  "supervisor_name": "Dr Wabbas Mahmud",
  "practice_owner_name": "Dr Wabbas Mahmud",
  "candidate_name": "Dr Obvious Chikore",
  "is_conflict": true,
  "confidence": "high",
  "reasoning": "The supervisor CV identifies Dr Wabbas Mahmud as the primary supervisor. The contract lists Dr Wabbas Mahmud as the director of 786AMW Pty Ltd atf Mahmud Medical Trust. Same person — supervisor is the practice owner/director."
}
```

- **Confidence levels**: `high`, `medium`, `low`
- Result stored in the SPPA-00 task's metadata JSON field
- Timeline event logged: *"AI conflict scan complete — Q7 marked YES/NO"*

---

## 3. PDF Form Filling

### 3.1 Template

A blank SPPA-00 PDF template stored in the repo at `documents/sppa-00-template.pdf`. This template already has many sections pre-filled for the practice side.

### 3.2 Filling Q7

Using `pdf-lib` (Node.js library) to programmatically fill the PDF form fields:

- **If `is_conflict: true`**:
  - Check the Q7 YES checkbox
  - Fill the Q7 details text field with: *"The supervisor is the practice owner. An email to the AHPRA officer will be sent directly explaining how any future potential conflicts of interest will be handled."*
- **If `is_conflict: false`**:
  - Check the Q7 NO checkbox
  - Leave details field blank

**Scope: Q7 only.** No other fields are filled in this step. Other sections are either pre-filled in the template already or filled by the candidate/practice during the signing flow.

### 3.3 Storage

The filled PDF is saved as a `task_document` attachment on the SPPA-00 task. This is an internal/admin document — it is **not** uploaded to the candidate's MyDocuments.

---

## 4. SPPA-00 Task Lifecycle

### State 1: LOCKED
- Task visible but greyed out
- Message: *"Waiting for Supervisor CV and Offer/Contract to be submitted"*
- Shows prerequisite checklist (which are done, which pending)
- No actions

### State 2: AI SCAN + READY TO SEND
- Unlocked after both docs submitted → AI scan fires automatically
- Q7-filled PDF attached to task
- Conflict alert banner shown next to the document:
  - **Conflict detected** (amber/warning): *"AI detected conflict of interest: supervisor [name] is the practice owner/director. Q7 has been marked YES on the SPPA-00. Please review before sending."* — AI reasoning expandable
  - **No conflict** (green): *"No conflict of interest detected. Q7 marked NO."*
  - **Low confidence** (red): *"AI could not determine with confidence. Manual review required."*
- Actions:
  - **"Send to Candidate"** — sends filled PDF via Gmail to candidate, asking them to complete Section A (Q1) + sign Section I and return
  - **"Override Q7"** — lets VA flip YES↔NO, regenerates the PDF

### State 3: SENT TO CANDIDATE
- Waiting for candidate to fill their sections and return
- Status chip: *"Sent to GP — awaiting return"*

### State 4: GP RETURNED — WAITING ON PRACTICE
- Candidate's partially completed SPPA-00 stored under the SPPA-00 task (internal only)
- Amber alert: *"Filled by GP, waiting on practice"*
- New action available: **"Send to Practice"** — sends the GP-completed PDF to practice contact via Gmail, asking them to fill Sections B–H, J, K + sign and return

### State 5: SENT TO PRACTICE
- Waiting for practice to complete their sections and return
- Status chip: *"Sent to Practice — awaiting return"*

### State 6: PRACTICE RETURNED — VA REVIEW
- Fully completed SPPA-00 received from practice
- VA reviews the final document
- Action: **"Submit"** — marks task complete

### State 7: COMPLETE
- Final fully completed SPPA-00 uploaded to:
  - Candidate's MyDocuments (this is the **only** version the candidate sees/downloads)
  - Google Drive (GP's folder)
- Task marked complete
- Timeline event logged

**Document slot progression (admin-internal only):**
Blank Q7-filled → GP partial → Fully completed

**Candidate-facing:** Only the final completed SPPA-00 appears in MyDocuments.

---

## 5. AHPRA Email Pipeline

### 5.1 General-Purpose Detection

Any email from an `@ahpra.gov.au` sender hitting `hazel@mygplink.com.au` enters the AHPRA pipeline. This is a **general-purpose** system — not limited to conflict-of-interest emails.

### 5.2 Classification

The existing Gmail triage pipeline is extended. When an `@ahpra.gov.au` email is detected:

- AI (Opus-class for accuracy) reads the full email content
- Matches it to a GP candidate based on **email content** (GP name, registration number, application reference) — not based on officer-GP assignment, since one AHPRA officer can preside over many GPs
- Classifies the request type

### 5.3 GP Matching

Matching is content-based, not officer-based:
- AHPRA officers preside over many GPs (many-to-many relationship)
- Each email is matched by the GP's name, registration number, or application reference mentioned in the email body
- The officer's email address is stored against the case for convenience (pre-filling reply addresses) but is **not** used as a matching key

### 5.4 Task Classification Categories

Non-exhaustive — the AI determines the category from content:

| Category | Description | Task created |
|---|---|---|
| **Conflict of interest follow-up** | Officer asks about conflict management (when Q7 = YES) | Email practice contact with officer's email, asking them to explain how conflicts will be managed |
| **Additional document request** | Officer requests specific documents | Task with details of what documents are needed |
| **Information request** | Officer asks questions about the application | Task for VA to respond or coordinate a response |
| **Application update** | Status update, approval, feedback on application | Task to action accordingly |

### 5.5 Conflict of Interest Follow-Up Task (Q7 = YES specific)

When the AI detects an AHPRA email related to a GP who has `is_conflict: true` on their SPPA-00 task, and the email content relates to conflict of interest:

- **Task created**: *"AHPRA officer enquiry — conflict of interest follow-up"*
- **Task details**: Shows the AHPRA officer's email address extracted from the inbound email
- **Task instruction**: *"Email the practice contact [name] asking them to email [AHPRA officer email] explaining how potential future conflicts of interest will be managed, as they are both supervisor and practice owner/director."*
- **Action**: **"Send to Practice Contact"** — pre-composed email via Gmail to the practice contact with the AHPRA officer's email address and a template message

### 5.6 Officer Tracking

- Store the AHPRA officer's name + email against the GP's case when first detected
- Used for convenience (pre-filling reply addresses, showing officer info on the case)
- **Not** used as a matching key — content-based matching only

---

## 6. Email Integration

All emails sent via the existing Gmail integration (`hazel@mygplink.com.au`):

- **To candidate** (State 2 → 3): SPPA-00 PDF attached, asking to complete Section A + sign Section I and return
- **To practice contact** (State 4 → 5): GP-completed SPPA-00 PDF attached, asking to complete Sections B–H, J, K + sign and return
- **To practice contact** (AHPRA follow-up): Template email with AHPRA officer's email address, asking them to explain conflict management

Inbound email detection uses the existing Gmail webhook pipeline — returned PDFs from candidates and practices are matched to the correct SPPA-00 task and stored.

---

## 7. Technical Components

### New/Modified Files

- **`server.js`** — New AI scan function, PDF filling logic, updated task completion handler (unlock trigger), SPPA-00 email send endpoints, AHPRA email classification extension
- **`lib/sppa-conflict-scan.js`** (new) — AI conflict scan logic: takes document buffers + candidate name, returns structured result
- **`lib/sppa-pdf-fill.js`** (new) — PDF form filling with `pdf-lib`: loads template, fills Q7, returns buffer
- **`documents/sppa-00-template.pdf`** (new) — Blank SPPA-00 template with pre-filled practice sections
- **`lib/email-triage.js`** (modified) — Extended to handle `@ahpra.gov.au` sender detection + classification
- **`pages/admin.html`** (modified) — Updated SPPA-00 task card UI: locked state, conflict alert banner, override button, lifecycle status chips, send actions

### Dependencies

- **`pdf-lib`** — PDF form filling (npm package, no native deps)
- **Anthropic API** — Claude Sonnet for conflict scan, Opus-class for AHPRA email classification

### Database

- SPPA-00 task metadata field stores AI scan result (`is_conflict`, `confidence`, `reasoning`, names)
- AHPRA officer name + email stored on the registration case record
- Task timeline events for each state transition

---

## 8. What's NOT in Step 1

- Pre-filling any SPPA-00 sections other than Q7
- Zoho Sign — fully scrapped for SPPA-00
- Candidate-facing UI changes — the candidate only sees the final document in MyDocuments once complete
