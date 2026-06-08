# AHPRA — RSO Standard Operating Procedure

**Version:** 1.0
**Effective Date:** June 2026
**Owner:** GP Link Operations
**Applies to:** All RSOs (Registration Support Officers) managing GPs through the AHPRA stage

---

## 1. Overview

### What is AHPRA?

AHPRA is the third and most complex stage of the GP registration journey. It stands for **Australian Health Practitioner Regulation Agency** — the body that grants registration to practise medicine in Australia.

During this stage, the GP:
- Creates an AHPRA Online Services account
- Submits an application for specialist registration
- Waits for AHPRA to assess and grant registration

In parallel, the RSO prepares and coordinates the **practice pack** — a set of 5 documents that AHPRA requires as part of the application. This is where the bulk of RSO work happens.

All GP-facing application work happens on the **external AHPRA portal**: `https://www.ahpra.gov.au/Registration/Online-services.aspx`

### Prerequisites

AHPRA unlocks only when **both** conditions are met:
- **AMC is complete** — the GP's qualifications have been verified by AMC
- **Placement is secured** — the GP has been matched with an Australian medical practice

If either condition is missing, the GP sees a locked screen explaining what needs to happen first.

### The 3 Substeps

| Step | Name | What the GP Does | Typical Duration |
|------|------|-------------------|------------------|
| 1 | **Create Account** | Creates an AHPRA Online Services account and confirms login | 10–20 minutes |
| 2 | **Application** | Begins their application for specialist registration | 10–20 minutes |
| 3 | **Awaiting Outcome** | Application submitted — waits for AHPRA to process | Varies (weeks to months) |

### The 5 Practice Pack Documents

These are the documents the RSO coordinates alongside the GP's application. They are required by AHPRA as supporting evidence.

| Document | Who Provides It | RSO Role |
|----------|----------------|----------|
| **SPPA-00** (Supervised Practice Plan Agreement) | GP signs Section A + I, practice signs Sections B–H + J–K | Full lifecycle management — send, collect, review, submit |
| **Section G** | GP Link (template) | Auto-delivered to GP — no RSO action needed |
| **Position Description** | Practice (or AI-generated) | Request from practice, review, approve |
| **Offer / Contract** | Practice | Request counter-signature, review, approve |
| **Supervisor CV** | Practice | Request from practice, review, approve |

### Quick Reference

| Substep | Admin Dashboard Shows | RSO Action |
|---------|----------------------|------------|
| Create Account | Substage: `create_account` | Monitor activity, nudge if inactive 3+ days |
| Application | Substage: `account_establishment` | Monitor activity, assist with qualification guidance |
| Awaiting Outcome | Substage: `awaiting_outcome` | Liaise with AHPRA officer, handle correspondence, respond to document requests |

> **[Scribe: Insert screenshot]** Admin dashboard showing a GP in the AHPRA stage — profile bar, journey rail with AHPRA highlighted, and practice pack task group visible.

---

## 2. Substep Walkthroughs

### 2a. Create Account

**What the GP is doing:**
The GP creates their AHPRA Online Services account at the external portal and confirms they can log in.

**What the RSO sees:**
- Stage badge shows **AHPRA**
- Substage is **create_account**

**How to monitor:**
- Check `last_gp_activity_at`. If no activity for 3+ days, nudge.
- A GP who just unlocked AHPRA may not realise it's available — they should have received an automated WhatsApp message.

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP hasn't started | Doesn't realise AHPRA is unlocked | Send a nudge. Check the journey rail to confirm both AMC and placement are complete. |
| Account creation errors | AHPRA portal issues | Advise GP to contact AHPRA directly. The RSO cannot resolve issues on AHPRA's portal. |

**Troubleshooting steps:**
1. Confirm both prerequisites are met (AMC done + placement secured).
2. Send a nudge.
3. If the GP responds, direct them to the AHPRA Online Services URL and the tutorial video if available.

> **[Scribe: Insert screenshot]** Admin view of a GP at the `create_account` substep.

---

### 2b. Application

**What the GP is doing:**
The GP begins their application for specialist registration through the AHPRA portal. This step includes providing personal details, confirming qualification information, and beginning the formal application.

**What the RSO sees:**
- Substage is **account_establishment**
- The GP's AHPRA page shows a **qualification guidance card** with 5 rows of information about what documents are needed

**What the RSO monitors:**
- GP progress through this step
- Whether the GP has questions about which qualifications to reference (country-specific)
- Whether the GP needs help understanding the SPPA or submission package

**Common issues:**

| Issue | What's happening | What to do |
|-------|-----------------|------------|
| GP confused about which qualifications | Unsure what to enter in the AHPRA application | Check their country and advise: UK → MRCGP, Ireland → MICGP, NZ → FRNZCGP. |
| GP asks about the SPPA | Sees references to SPPA but doesn't have it yet | Explain that GP Link is preparing the SPPA separately — the GP will receive it via email when it's ready. |
| GP wants to download supporting docs | Needs their documents for the AHPRA application | Direct them to the "Download my documents" feature on their AHPRA page. |

> **[Scribe: Insert screenshot]** Admin view of a GP at the `account_establishment` substep.

---

### 2c. Awaiting Outcome

**What the GP is doing:**
The GP has submitted their application. They see a status page with a pulsing indicator showing "In Progress". There is nothing for the GP to actively do — they are waiting for AHPRA to process.

**What the RSO sees:**
- Substage is **awaiting_outcome**
- Status shows "In Progress" or "Registration Granted"

**What the RSO does during this period:**
- Handles any AHPRA correspondence that comes in (see Section 4)
- Responds to AHPRA officer requests for additional documents
- Keeps the GP informed about progress
- Manages any document amendments AHPRA requests

This is typically the longest phase. AHPRA processing times vary from weeks to months. The RSO's main role is to be responsive when AHPRA reaches out and to keep the GP reassured.

**When registration is granted:**
- The GP's status page updates to show "Registration Granted" with a green indicator
- The GP can proceed to PBS & Medicare

> **[Scribe: Insert screenshot]** Admin view of a GP at `awaiting_outcome`, showing the status indicator.

---

## 3. Practice Pack Documents

The practice pack is a set of 5 documents required for the AHPRA application. Tasks for these documents are **automatically created** when a GP secures their placement (the `career_secured` trigger). They appear as `practice_pack_child` tasks grouped under the Career & Documents stage in the task pane.

Each document task has a **guided action prompt** — a line on the task card telling you exactly what to do next. Follow the prompt.

---

### 3a. Offer / Contract

**What it is:** The GP's employment contract or letter of offer from the practice, with both candidate and employer signatures.

**How it's created:** Auto-created when the GP secures placement. Starts as `open`.

**Workflow:**

| Step | What Happens | RSO Action | Guided Prompt |
|------|-------------|------------|---------------|
| 1. Request | No document exists yet | Click **Email Practice** — a pre-filled email opens requesting the contract with counter-signature | "Email the practice requesting the Contract" |
| 2. Wait | Email sent, waiting for practice response | Monitor. If 7+ days with no response, follow up | "Waiting on practice to send the document" |
| 3. Receive | Practice replies with the document attached — system auto-matches it to the task | Review the document | "Review the uploaded document and approve" |
| 4. Review | Document preview opens | Check the document has both signatures (candidate + employer). If correct, click **Submit to Drive & Complete**. If issues, click **Request Revision**. | — |
| 5. Complete | Document uploaded to Google Drive and delivered to GP's MyDocuments | Task auto-closes | — |

**If the GP has already signed the contract** (e.g. during onboarding), the email to the practice will automatically attach the candidate-signed version and request the employer's counter-signature.

**If revisions are needed:** Click **Request Revision**, explain what needs fixing, and the task returns to the waiting state.

> **[Scribe: Insert screenshot]** Offer/Contract task card showing the guided action prompt and Email Practice button.

---

### 3b. Supervisor CV

**What it is:** The CV of the GP's primary supervisor at the practice.

**How it's created:** Auto-created when the GP secures placement. Starts as `open`.

**Workflow:** Identical to Offer / Contract.

| Step | RSO Action | Guided Prompt |
|------|-----------|---------------|
| 1. Request | Click **Email Practice** to request the Supervisor CV | "Email the practice requesting the Supervisor CV" |
| 2. Wait | Monitor for response, follow up after 7+ days | "Waiting on practice to send the document" |
| 3. Receive | Document arrives via email, auto-matched to task | "Review the uploaded document and approve" |
| 4. Review | Check the CV is for the correct supervisor and is complete | — |
| 5. Complete | Submit to Drive & Complete | — |

**Important:** When both the Supervisor CV **and** Offer/Contract are completed, the system automatically triggers a **conflict of interest scan** for the SPPA-00. See Section 3e.

> **[Scribe: Insert screenshot]** Supervisor CV task card.

---

### 3c. Position Description

**What it is:** A description of the GP's role at the practice.

**How it's created:** Auto-created when the GP secures placement. Starts as `open`.

**Workflow:**

| Step | RSO Action | Guided Prompt |
|------|-----------|---------------|
| **Option A: Request from practice** | Click **Email Practice** to request | "Email the practice requesting the Position Description" |
| **Option B: AI-generate** | Use the AI generation feature to create a draft from the GP's career/application data | — |
| Wait | Monitor for practice response (if requested) | "Waiting on practice to send the position description" |
| Review | If AI-generated: review and edit inline. If received from practice: preview and approve. | "Review the generated position description and approve" or "Review the uploaded position description" |
| Complete | Submit to Drive & Complete | — |

**AI generation:** If the practice doesn't have a position description ready, you can generate one using the AI tool. The generated document appears as editable HTML — review it, make any corrections, then approve.

> **[Scribe: Insert screenshot]** Position Description task card, showing both the Email Practice and AI-generate options.

---

### 3d. Section G

**What it is:** A standard template document (part of the supervised practice plan).

**How it's created:** Auto-created when the GP secures placement. Starts as `deferred`.

**No RSO action required.** Section G is automatically delivered to the GP's MyDocuments when their placement is secured. The task is auto-completed by the system.

**Guided prompt:** "Section G auto-delivered"

> **[Scribe: Insert screenshot]** Section G task card showing completed/auto-delivered status.

---

### 3e. SPPA-00 (Supervised Practice Plan Agreement)

**What it is:** The main AHPRA document — a multi-section agreement signed by both the GP (supervisee) and the practice (supervisor). This is the most complex document in the practice pack.

**How it's created:** Auto-created when the GP secures placement. Starts as `deferred` and remains locked until prerequisites are met.

#### Prerequisites

The SPPA-00 task becomes actionable only after **both**:
- **Supervisor CV** task is completed
- **Offer / Contract** task is completed

Until then, the task card shows: "Waiting for prerequisites" with checkboxes showing which documents are still outstanding.

#### Conflict of Interest Scan

When both prerequisites complete, the system **automatically runs a conflict of interest scan** using AI. This checks whether the supervisor named in the CV is also the practice owner/director — a conflict that AHPRA needs to know about.

The scan result appears on the SPPA-00 task card:
- **"No conflict detected"** — Q7 (conflict of interest question) is pre-filled as "No"
- **"Conflict of interest detected"** — Q7 is pre-filled as "Yes" with details
- **"Could not determine with confidence"** — RSO must review manually

**Q7 Override:** If you disagree with the scan result, click **Override Q7** to change the conflict determination before sending the SPPA. You can set it to conflict or no conflict and add custom details.

#### SPPA-00 Full Lifecycle

| State | What's Happening | RSO Action | Guided Prompt |
|-------|-----------------|------------|---------------|
| **ready_to_send** | Conflict scan complete, SPPA ready to go | Review Q7 conflict result. Click **Send to Candidate**. | "Send SPPA-00 to candidate via email" |
| **sent_to_candidate** | GP has received the SPPA via email | Wait for GP to complete Section A and sign Section I, then return via email | "Waiting on GP to complete and return SPPA" |
| **gp_returned** | GP has returned the signed SPPA | Review GP's entries. If correct, click **Send to Practice**. If issues, click **Request GP Corrections**. | "Review GP's SPPA and send to practice" |
| **gp_corrections_requested** | GP has been asked to fix something | Wait for GP to resubmit | "Waiting on GP to resubmit corrected SPPA" |
| **sent_to_practice** | Practice has received the SPPA | Wait for practice to complete Sections B–H and sign Sections J–K | "Waiting on practice to complete and return SPPA" |
| **practice_returned** | Practice has returned the completed SPPA | Review all sections. If correct, click **Submit to AHPRA**. If issues, click **Request Practice Corrections**. | "Review practice's SPPA and submit" |
| **corrections_requested** | Practice has been asked to fix something | Wait for practice to resubmit | "Waiting on practice to resubmit corrected SPPA" |
| **completed** | SPPA finalized and delivered | Task auto-closes. SPPA uploaded to Drive and delivered to GP's MyDocuments. | — |

#### What the GP Completes

The email to the GP asks them to:
1. Complete **Section A** (Question 1 — personal details)
2. Sign **Section I** (Supervisee's declaration)

The attachment checkboxes throughout the form are pre-checked — the GP does not need to attach supporting documents separately.

#### What the Practice Completes

The email to the practice asks them to:
1. Complete **Sections B through H** (supervisor details, practice information, supervision arrangements)
2. Sign **Sections J and K** (Supervisor's and Practice declarations)

#### Requesting Corrections

**From the GP:** Click **Request GP Corrections**. Enter what needs fixing in the corrections field. The system emails the GP with your instructions and sets the state to `gp_corrections_requested`. When the GP resubmits, the state returns to `gp_returned`.

**From the practice:** Click **Request Practice Corrections**. Same process — enter corrections, system emails the practice, state moves to `corrections_requested`. When the practice resubmits, the state returns to `practice_returned`.

#### Submitting the Final SPPA

When the practice-returned SPPA looks correct:
1. Click **Submit to AHPRA** (the "sppa-submit" action)
2. The system finalizes the document, uploads to Google Drive, and delivers to the GP's MyDocuments
3. If the GP had alternative supervisors listed, their CVs are also delivered (see below)
4. The task marks as `completed`

#### Alternative Supervisor CVs

If the practice returns the SPPA with alternative supervisors listed (beyond the primary supervisor), the system may create an **alt_supervisor_cv_review** task. This happens when the practice emails back CVs for the alternative supervisors.

**How to handle:**
1. The task shows which CVs were received and which supervisors they match to (with confidence scores)
2. Review that the CVs match the supervisors named in the SPPA
3. Click **Submit — Deliver to GP** to upload the CVs to the GP's Drive folder under an "Alternative Supervisor CVs" subfolder
4. The task completes

#### Amending SPPA Fields After Submission

If AHPRA requests changes to specific SPPA fields after it's been submitted:
- Use **Amend Field** to change a single form field directly in the PDF
- Use **Save Fields** to bulk-amend multiple fields
- Use **Upload Corrected** to manually upload a completely revised version
- All amendments create a new document version and auto-deliver to the GP's MyDocuments

> **[Scribe: Insert screenshot]** SPPA-00 task card at `ready_to_send` state, showing the conflict scan result and Send to Candidate button.

> **[Scribe: Insert screenshot]** SPPA-00 task card at `gp_returned` state, showing Review and Send to Practice options.

> **[Scribe: Insert screenshot]** SPPA-00 task card at `practice_returned` state, showing Submit to AHPRA button.

---

## 4. AHPRA Correspondence

### How AHPRA Emails Are Detected

The system automatically detects emails from AHPRA officers:
- Any email from an `@ahpra.gov.au` address is flagged as AHPRA correspondence
- The system matches the email to the correct GP case using: thread matching, application number, officer email, CC matching, or AI triage
- An `ahpra_correspondence` task is created automatically

### What Gets Extracted

When an AHPRA email arrives, the system extracts:
- **AHPRA officer name and email** — stored on the case for future reference
- **Application number** (format: APP-XXXXXXXXXX) — linked to the case
- **Action items with deadlines** — AI reads the email and creates individual `ahpra_action_item` tasks with due dates
- **Response type classification** — what kind of response is needed

### Response Types

Each AHPRA correspondence task is classified into a response type. This tells you how to handle it.

| Response Type | What It Means | What to Do |
|---------------|--------------|------------|
| **direct_reply** | AHPRA is asking for documents or information that GP Link has on file | Reply directly with the requested documents attached. The task shows which documents are available (`on_file_documents`) and may include an AI-drafted response. |
| **request_from_gp** | AHPRA needs something from the GP (e.g. additional personal information) | Forward the request to the GP via WhatsApp or email. Set task to "Waiting on GP". When the GP provides it, reply to AHPRA. |
| **request_from_practice** | AHPRA needs something from the practice (e.g. updated supervision details) | Contact the practice to obtain the information. Set task to "Waiting on Practice". When received, reply to AHPRA. |
| **amend_document** | AHPRA wants a change to a submitted document (typically the SPPA) | Check the `amend_target` field to see which document, section, and field needs changing, and who owns the amendment (RSO, GP, or practice). Use the SPPA amendment tools if it's the SPPA. |
| **status_update** | AHPRA is providing a progress update (no action required) | Click **Acknowledge** to mark the task as complete and notify the GP of the update. |
| **escalation** | Something needs senior attention | Escalate via the three-dot menu. Document the issue in case notes. |

### AI-Drafted Responses

For `direct_reply` tasks, the system may provide an **AI-drafted response** in the task metadata. This is a suggested reply based on the AHPRA officer's request and the documents on file. Review it before sending — do not send AI drafts without reading them first.

### Action Items with Deadlines

When AHPRA emails include specific deadlines or action requirements, the system creates separate `ahpra_action_item` tasks. Each has:
- A **title** describing the action
- An **owner** — who needs to do it: `gp` (the GP), `practice` (the practice), or `hazel` (RSO/GP Link)
- A **due date** — either extracted from the email or defaulted to 10 days out

Work these action items like any other task. The due date ensures they appear in the Needs Action lane when approaching deadline.

### Officer Tracking

Once an AHPRA officer is identified, their name and email are stored on the registration case:
- `ahpra_officer_name`
- `ahpra_officer_email`
- `ahpra_application_number`

This means future emails from the same officer are automatically matched to the correct case.

> **[Scribe: Insert screenshot]** An `ahpra_correspondence` task showing officer details, response type, and available actions.

> **[Scribe: Insert screenshot]** An `ahpra_action_item` task with deadline and owner assignment.

---

## 5. Communication Playbook

### 5a. Nudges

**When to nudge:**
- The GP has been inactive on a substep for 3+ days
- A task is approaching its due date with no GP activity

**How to send:**
1. Open the GP's case in the admin dashboard.
2. Click the **Nudge** button on the profile bar.
3. The system sends a stage-specific WhatsApp message + email + in-app notification.

**AHPRA nudge message:** "Great progress — you've unlocked the AHPRA step! This involves registering with the Australian Health Practitioner Regulation Agency. If you need any help, just reply to this message."

**After sending:** Monitor the nudge chat thread for replies.

> **[Scribe: Insert screenshot]** Sending a nudge for the AHPRA stage.

---

### 5b. WhatsApp (DoubleTick)

**How it works:**
- GP messages create a `whatsapp_help` task with a 24-hour due date
- Click the **WhatsApp button** on the profile bar to open the DoubleTick conversation

**Tips for AHPRA WhatsApp queries:**
- If the GP asks about their application status → check the substage and any recent AHPRA correspondence
- If the GP asks about practice pack documents → check which documents are still outstanding in the task list
- If the GP asks about the SPPA → check the SPPA task state and explain what's happening (e.g. "We've sent it to the practice and are waiting for their signature")
- If the GP asks about an AHPRA officer request → check recent `ahpra_correspondence` tasks for context

> **[Scribe: Insert screenshot]** WhatsApp conversation about an AHPRA query.

---

### 5c. Email

**When to use:** Detailed instructions, document-heavy communication, or when WhatsApp is unresponsive.

**How to send:** Three-dot menu on any task → **Email GP**.

**Tips for AHPRA emails:**
- Link to the AHPRA portal: `https://www.ahpra.gov.au/Registration/Online-services.aspx`
- When forwarding AHPRA officer requests, summarise what's needed clearly
- When the SPPA is ready, the system sends it automatically — don't duplicate

### 5d. Emailing Practices

For practice pack documents, the **Email Practice** button on each task opens a pre-filled email to the practice contact. The email includes:
- The GP's name
- Which document is needed
- Any attachments that should go with it (e.g. the candidate-signed contract)

If the practice hasn't responded after 7+ days, follow up using the same email thread.

> **[Scribe: Insert screenshot]** Email Practice action from a practice pack task card.

---

## 6. Support Tickets

For support ticket handling procedures, refer to the **Support Ticket Handling SOP**.

---

## Appendix: Practice Pack Document Status Reference

The `practice_doc_ops` table tracks each document's status. Here's what each status means:

| Status | Meaning |
|--------|---------|
| `not_requested` | No request has been sent yet |
| `requested` | Email sent to practice, waiting for response |
| `awaiting_practice` | Waiting for practice to provide the document |
| `awaiting_gp` | Waiting for GP to provide or correct something |
| `received` | Document received, pending RSO review |
| `under_review` | RSO is reviewing the document |
| `needs_correction` | Corrections requested, waiting for resubmission |
| `ready_for_gp` | Document approved, ready to deliver to GP |
| `completed` | Document delivered to GP and uploaded to Drive |

---

## Appendix: SPPA-00 State Reference

| State | Who's Acting | What's Expected |
|-------|-------------|-----------------|
| `ready_to_send` | RSO | Review conflict scan, send to candidate |
| `sent_to_candidate` | GP | GP completes Section A, signs Section I, returns via email |
| `gp_returned` | RSO | Review GP entries, send to practice or request corrections |
| `gp_corrections_requested` | GP | GP fixes issues and resubmits |
| `sent_to_practice` | Practice | Practice completes Sections B–H, signs J–K, returns via email |
| `practice_returned` | RSO | Review all sections, submit to AHPRA or request corrections |
| `corrections_requested` | Practice | Practice fixes issues and resubmits |
| `completed` | System | Uploaded to Drive, delivered to GP MyDocuments |

---

*Last updated: June 2026*
