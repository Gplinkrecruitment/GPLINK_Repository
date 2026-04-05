# GP Link - Virtual Assistant Standard Operating Procedure

**Version:** 1.0
**Effective Date:** April 2026
**Owner:** GP Link Operations

---

## Table of Contents

1. [Your Role](#1-your-role)
2. [Getting Started](#2-getting-started)
3. [The VA Command Centre](#3-the-va-command-centre)
4. [The Registration Pipeline](#4-the-registration-pipeline)
5. [Stage 1 - MyIntealth](#5-stage-1---myintealth)
6. [Stage 2 - AMC Portfolio](#6-stage-2---amc-portfolio)
7. [Stage 3 - Career & Documents](#7-stage-3---career--documents)
8. [Stage 4 - AHPRA Registration](#8-stage-4---ahpra-registration)
9. [Stage 5 - Visa Application](#9-stage-5---visa-application)
10. [Stage 6 - PBS & Medicare](#10-stage-6---pbs--medicare)
11. [Stage 7 - Commencement](#11-stage-7---commencement)
12. [Daily Workflow](#12-daily-workflow)
13. [Case Management](#13-case-management)
14. [Task Management](#14-task-management)
15. [Practice Document Operations](#15-practice-document-operations)
16. [Visa Questionnaire Management](#16-visa-questionnaire-management)
17. [Blockers & Escalations](#17-blockers--escalations)
18. [SLA Guidelines](#18-sla-guidelines)
19. [Quick Reference](#19-quick-reference)

---

## 1. Your Role

You are a GP Link Virtual Assistant. Your job is to guide international General Practitioners through the full Australian registration pipeline - from their first account creation through to their first day at a practice.

**What you do:**
- Monitor GP progress across 7 registration stages
- Verify documents and milestones at each stage
- Chase missing documents from GPs, practices, and external parties
- Manage visa intake questionnaires
- Coordinate practice document packs (SPPA-00, Section G, etc.)
- Keep cases moving - flag blockers early, follow up consistently
- Maintain a clear audit trail of every action you take

**What the system does for you:**
- Automatically creates tasks when GPs complete milestones
- Tracks SLA breaches (flags cases with no GP activity for 5+ days)
- Logs every action to an immutable timeline (audit-ready)
- Sends GP notifications when you update visa/questionnaire status

---

## 2. Getting Started

### Logging In

1. Go to the admin login page
2. Enter your authorised admin email
3. Enter the OTP sent to your email
4. You'll land on the **VA Command Centre**

### Your Dashboard at a Glance

When you log in, you'll see four key numbers across the top:

| Metric | What it means |
|--------|---------------|
| **Total GPs** | All GPs in the system |
| **Urgent** | Tasks marked urgent - act on these first |
| **Overdue** | Tasks past their due date - these need immediate attention |
| **Open** | All tasks waiting to be done |

---

## 3. The VA Command Centre

The Command Centre has two views. Toggle between them at the top.

### Cases View (Default)

**Left panel** - Your case list:
- Search by GP name or email
- Filter tabs: All | Urgent | Overdue | Blocked | Active | Complete
- Each card shows the GP's name, current stage, last activity, and task counts
- **Journey dots** - 7 coloured dots showing how far through the pipeline each GP is

**Right panel** - When you click a case:
- GP details (name, email, stage, assigned VA)
- **Next Action** box - the single most important thing to do right now
- Active tasks list with Complete/Start buttons
- Registration journey stepper with expandable playbook guidance
- Case management fields (status, blocker, follow-up date, practice info, notes)
- Support tickets from the GP
- Full case timeline

### Work Queue View

Your daily to-do list. Shows all open tasks across all GPs, grouped by priority:
- **Urgent** (red) - Do these now
- **High** (amber) - Do these today
- **Normal** (blue) - Do these this week

Click any task to jump straight to that GP's case.

---

## 4. The Registration Pipeline

Every GP moves through 7 stages in order. Your job is to verify milestones, chase what's needed, and keep the case moving forward.

```
1. MyIntealth ──> 2. AMC ──> 3. Career ──> 4. AHPRA ──> 5. Visa ──> 6. PBS ──> 7. Commencement
```

The system automatically detects when a GP completes a milestone and creates a verification task for you. You verify, then the GP moves on.

---

## 5. Stage 1 - MyIntealth

**What the GP does:** Creates their account, completes onboarding, uploads qualification certificates.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| GP creates account | Confirm account is set up correctly | Verify |
| GP completes onboarding | Verify establishment documents are valid | Verify |
| GP uploads qualifications | **Review uploads carefully** - check names match, docs are legible, correct country requirements met | Verify (High Priority) |
| Qualifications verified | Confirm EPIC verification issued | Verify |

**Country-Specific Document Requirements:**
- **UK (GB):** MRCGP + either CCT or PMETB certificate
- **Ireland (IE):** MICGP + CSCST
- **New Zealand (NZ):** FRNZCGP

**Key checks:**
- Does the name on the qualification match the GP's profile name? (Middle names may differ - that's OK, but flag mismatches)
- Are documents legible and not expired?
- Has the AI verification flagged anything? Check the verification result before approving.

**When this stage is complete:** All qualifications verified and EPIC confirmation issued. The system auto-creates an AMC kickoff task.

---

## 6. Stage 2 - AMC Portfolio

**What the GP does:** Creates an AMC (Australian Medical Council) account, uploads credentials, waits for AMC verification.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| GP creates AMC account | Confirm portfolio creation | Verify |
| GP uploads credentials | Review credential documents for completeness | Verify (High Priority) |
| Waiting for AMC | Monitor verification progress, chase if delayed | Verify |
| AMC verifies | Confirm qualifications verified | Verify |

**Key checks:**
- Has the GP actually created their AMC portfolio (not just said they will)?
- Are all required credentials uploaded?
- If AMC verification is taking too long (>14 days), follow up with the GP to check status.

**When this stage is complete:** AMC verification confirmed. System auto-creates a Career kickoff task.

---

## 7. Stage 3 - Career & Documents

**What the GP does:** Browses available positions, applies to practices, completes the document preparation checklist.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| GP browsing jobs | Help match GP with suitable roles based on their profile and preferences | Manual |
| GP applies | Ensure all application documents are ready | Verify |
| **Placement secured** | Verify the placement and practice details | Verify |
| Post-placement | Request the Practice Pack (5 documents - see below) | Practice Pack |

### The Practice Pack

When a GP secures a placement, the system automatically creates a parent task with 5 child tasks - one for each document the practice needs to provide:

| # | Document | Key | What it is |
|---|----------|-----|------------|
| 1 | **SPPA-00** | sppa_00 | Sponsorship form |
| 2 | **Section G** | section_g | Section G form |
| 3 | **Position Description** | position_description | Role description from the practice |
| 4 | **Offer/Contract** | offer_contract | Employment offer letter or contract |
| 5 | **Supervisor CV** | supervisor_cv | Supervising GP's curriculum vitae |

For each document, you'll manage it through the Practice Document Operations workflow (see [Section 15](#15-practice-document-operations)).

**When this stage is complete:** Placement confirmed, practice pack collection underway. System auto-creates an AHPRA kickoff task.

---

## 8. Stage 4 - AHPRA Registration

**What the GP does:** Completes the AHPRA registration form, submits supporting documents, responds to any AHPRA queries.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| GP starts AHPRA form | Guide them through the form requirements | Verify |
| GP submits documents | Review for completeness before submission | Verify (High Priority) |
| AHPRA processing | Monitor assessment progress | Verify |
| AHPRA queries | Help GP respond to additional information requests | Followup |
| AHPRA approved | Confirm registration | Verify |

**Key checks:**
- Is the AHPRA form fully completed (no missing sections)?
- Do submitted documents match what AHPRA requires?
- If AHPRA raises queries, respond promptly - delays here can push out visa timelines.

**Escalation:** If AHPRA assessment stalls for more than 3 weeks with no communication, escalate internally.

**When this stage is complete:** AHPRA registration confirmed.

---

## 9. Stage 5 - Visa Application

**What the GP does:** Uploads visa documents, completes the visa intake questionnaire, responds to document requests.

**What you do:**

This is the most complex stage. You manage three parallel workstreams:

### A. Visa Case Management

1. **Create the visa case** in the Visa Admin panel
2. Set the visa subclass, type, and sponsor details
3. Link it to the GP's registration case
4. Track the visa through its stages (each stage change creates a task for you)

### B. Visa Questionnaire (see [Section 16](#16-visa-questionnaire-management))

The questionnaire collects detailed personal information from the GP (and dependants) needed for the visa application.

| Questionnaire Status | Your Action |
|---------------------|-------------|
| **draft** | GP is still filling it out - no action needed |
| **submitted** | Review the questionnaire for completeness and accuracy |
| **returned_for_changes** | You've sent it back - chase the GP if they don't update within 7 days |
| **va_reviewed** | Generate the PDF and choose the recipient route |
| **ready_to_send** | Send it to the migration agent or practice |
| **sent** | Done - record when it was sent |

### C. Document Collection

Request and track visa-specific documents from the GP. Each document upload triggers a review task for you.

**Sponsor & Migration Agent:**
- Record sponsor name and contact details on the case
- Record migration agent name and contact details
- The system tracks these and creates tasks when updates are needed

**When this stage is complete:** Visa granted. System auto-advances to PBS.

---

## 10. Stage 6 - PBS & Medicare

**What the GP does:** Uploads Medicare/PBS documents, provides practice details for provider number applications.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| Create PBS case | Set up the PBS application in the PBS Admin panel | Manual |
| Collect documents | Request Medicare/PBS required documents from GP | Verify |
| Apply for Provider Number | Submit Medicare Provider Number application | Manual |
| Apply for PBS Prescriber Number | Submit PBS Prescriber Number application | Manual |
| Track applications | Monitor both applications through to approval | Followup |

**Key checks:**
- Are practice details correct for the provider number application?
- Has the GP provided all required information (practice address, ABN, etc.)?

**When this stage is complete:** Both Medicare Provider Number and PBS Prescriber Number issued.

---

## 11. Stage 7 - Commencement

**What the GP does:** Completes the pre-arrival checklist, confirms their arrival date.

**What you do:**

| Step | Your Action | Task Type |
|------|-------------|-----------|
| Pre-arrival | Prepare welcome pack for the GP | Manual |
| Coordinate | Confirm start date with the practice | Manual |
| Verify registrations | Check all registrations (AHPRA, Medicare, PBS) are active | Verify |
| GP arrives | Confirm arrival and first day at practice | Verify |

**When this stage is complete:** GP has commenced at the practice. Mark the case as **complete**.

---

## 12. Daily Workflow

Follow this routine every working day:

### Morning (Start of Day)

1. **Open the Work Queue** - Review all urgent and overdue tasks
2. **Action urgent tasks first** - These are time-sensitive
3. **Check overdue tasks** - Determine why they're overdue and take action (chase GP, chase practice, escalate)
4. **Review the Cases view** filtered by "Blocked" - Are any blockers resolvable today?

### Throughout the Day

5. **Process new tasks as they appear** - The system creates tasks automatically when GPs complete milestones. Pick these up promptly.
6. **Follow up on "waiting" tasks** - If you set a task to "waiting" yesterday, check if the response has come in.
7. **Add notes** - Whenever you take an action (phone call, email sent, document reviewed), add a note to the case timeline. This keeps the audit trail complete.

### End of Day

8. **Review your open tasks** - Set follow-up dates for anything you're waiting on
9. **Check for cases with no activity in 5+ days** - The system flags these as SLA breaches, but a quick manual scan catches things early
10. **Sync** - Hit the Sync button if you think GP state changes may not have flowed through yet

### Weekly

11. **Review all "on_hold" cases** - Should any be reactivated?
12. **Review practice document progress** - Chase any docs that have been "awaiting_practice" for more than 5 days

---

## 13. Case Management

### Case Statuses

| Status | When to use |
|--------|-------------|
| **active** | Default. The case is progressing. |
| **on_hold** | GP has asked to pause, or there's a planned delay (e.g., waiting for exam results in 2 months). Add the reason in handover notes. |
| **blocked** | Something is preventing progress and needs resolution. Always set the blocker type. |
| **complete** | GP has commenced at their practice. All stages done. |
| **withdrawn** | GP has left the program. Add the reason in handover notes. |

### Blocker Types

When you set a case to "blocked", always specify the blocker:

| Blocker | Meaning |
|---------|---------|
| **waiting_on_gp** | You need the GP to do something (upload a doc, answer a question, complete a form) |
| **waiting_on_practice** | The practice needs to provide something (practice pack doc, confirmation, etc.) |
| **waiting_on_external** | An external body needs to act (AHPRA, immigration, AMC, etc.) |
| **internal_review** | The GP Link team needs to review/decide something internally |

### Updating a Case

In the case detail panel:
1. Change the relevant field (status, blocker, follow-up date, practice info, etc.)
2. Click **Save Changes**
3. The system logs every change to the timeline automatically

### Adding Notes

Use the "Add Note" box at the bottom of the case detail to record:
- Phone calls made or received
- Emails sent
- Decisions made and why
- Anything a colleague might need to know if they pick up the case

**Golden rule:** If it's not in the timeline, it didn't happen.

---

## 14. Task Management

### Task Priorities

| Priority | Meaning | Response Time |
|----------|---------|---------------|
| **Urgent** | Immediate action required - blocking a GP's progress or time-sensitive deadline | Same day |
| **High** | Important - affects pipeline progression | Within 1 business day |
| **Normal** | Standard task - routine verification or follow-up | Within 3 business days |
| **Low** | Non-critical - can be batched with other work | Within 5 business days |

### Task Statuses

| Status | When to use |
|--------|-------------|
| **open** | Task is ready to be worked on |
| **in_progress** | You're actively working on it right now |
| **waiting** | You've done your part - waiting for a response |
| **waiting_on_gp** | Specifically waiting for the GP to act |
| **waiting_on_practice** | Specifically waiting for the practice |
| **waiting_on_external** | Waiting for an external body (AHPRA, immigration, etc.) |
| **blocked** | Can't proceed - needs escalation or another task to complete first |
| **completed** | Done |
| **cancelled** | No longer needed |

### Working a Task

1. Click **Start** to move the task to "in_progress"
2. Do the work (review document, make call, send email, etc.)
3. Add a note describing what you did
4. Either **Complete** the task or set it to the appropriate waiting status
5. If waiting, set a follow-up date so you remember to chase

### Creating Manual Tasks

Sometimes you need to create a task that the system didn't auto-generate:
1. Click the **Create Task** button
2. Fill in: Title (required), Description, Priority, Due Date, Related Stage
3. The task appears in both the case's task list and the global work queue

---

## 15. Practice Document Operations

When a GP secures a placement, you need to collect 5 documents from the practice. Each document follows this workflow:

```
not_requested ──> requested ──> awaiting_practice ──> received ──> under_review ──> completed
                                                                         |
                                                                         v
                                                                  needs_correction ──> (back to awaiting_practice)
```

### Step-by-Step

| Step | What to do |
|------|-----------|
| **1. Request** | Contact the practice. Record who you requested from and the practice contact. Set a due date (typically 5 business days). Move status to `requested`. |
| **2. Awaiting** | Move to `awaiting_practice`. If no response by due date, chase - update `last_chased_date`. |
| **3. Received** | Document arrives. Move to `received`, then `under_review`. |
| **4. Review** | Check the document is correct, complete, and properly signed. |
| **5a. Approved** | Move to `completed`. |
| **5b. Needs Correction** | Move to `needs_correction`. Write a clear `correction_note` explaining what's wrong. Contact the practice. Move back to `awaiting_practice`. Increment `file_version`. |

### Chasing Documents

If a practice hasn't responded:
- **Day 5:** First chase (email/call). Update `last_chased_date`.
- **Day 10:** Second chase. Flag internally if still no response.
- **Day 14+:** Escalate. Consider contacting the practice manager directly.

---

## 16. Visa Questionnaire Management

The visa intake questionnaire collects personal details from the GP and any dependants for the visa application.

### Lifecycle

```
GP creates (draft) ──> GP submits ──> You review ──> Approved? ──> Generate PDF ──> Send
                                           |
                                           No
                                           |
                                           v
                                   Return for changes ──> GP updates ──> GP resubmits
```

### Your Actions at Each Status

**When submitted (task auto-created, high priority):**
1. Open the questionnaire
2. Check all fields are complete
3. Verify passport details match uploaded documents
4. Check dependant information is consistent
5. If everything looks good: **Approve** (add a review note)
6. If something's wrong: **Return for Changes** (write a clear return note explaining what needs fixing)

**When approved (va_reviewed):**
1. Generate the PDF (system creates a task for this)
2. Choose the recipient route:
   - **gplink_migration_agent** - Send through GP Link's migration agent
   - **practice_agent** - Send via the practice's migration agent
   - **practice_direct** - Send directly to the practice
3. Mark as **Ready to Send**

**When ready to send:**
1. Send the PDF to the chosen recipient
2. Mark as **Sent** and record the date

**If returned for changes:**
- Chase the GP if they don't resubmit within 7 days
- When they resubmit, the version number increments automatically

---

## 17. Blockers & Escalations

### When to Set a Blocker

Set a blocker on the case when:
- A GP hasn't responded in 5+ days and you can't proceed without them
- A practice is not providing required documents
- An external body (AHPRA, immigration) is delayed beyond expected timelines
- An internal decision is needed before you can proceed

### Escalation Triggers

Escalate to your supervisor when:
- A GP has been unresponsive for 14+ days despite multiple chase attempts
- A practice refuses to provide required documents
- AHPRA assessment has stalled for 3+ weeks
- Visa application hits an unexpected complication
- You're unsure about a document's validity
- The same blocker has been set for 10+ business days without resolution

### How to Escalate

1. Set the case blocker to the appropriate type
2. Add a detailed note to the case timeline explaining:
   - What the blocker is
   - What you've already tried
   - Why you're escalating
3. Create an urgent task: "Escalation: [brief description]"
4. Notify your supervisor directly

---

## 18. SLA Guidelines

| SLA | Threshold | What happens |
|-----|-----------|--------------|
| **GP inactivity** | 5 days with no GP activity | System auto-creates a high-priority SLA task. Contact the GP. |
| **Practice response** | 5 business days | Chase the practice. Update `last_chased_date`. |
| **Sponsor response** | 5 business days | Chase the sponsor. |
| **Task overdue** | 7 days past due date | Review task - either complete, update due date, or escalate. |
| **Questionnaire completion** | 7 days after return/request | Chase the GP to complete the questionnaire. |

### Inactivity Outreach

When the system flags a GP as inactive (5+ days):

1. **Day 5:** Send a friendly check-in message. "Hi [Name], just checking in - is there anything I can help with for your [current stage] application?"
2. **Day 10:** More direct follow-up. "Hi [Name], I noticed your [stage] hasn't progressed. Is there a blocker I can help with?"
3. **Day 14:** Set case to `blocked` / `waiting_on_gp`. Escalate if no response.

---

## 19. Quick Reference

### Stage Progression Cheat Sheet

| Stage | GP's Key Milestone | Your Key Action | Auto-creates |
|-------|-------------------|-----------------|--------------|
| MyIntealth | Qualifications uploaded | Verify docs match credentials | AMC kickoff task |
| AMC | Credentials verified | Confirm AMC acceptance | Career kickoff task |
| Career | Placement secured | Verify placement + request practice pack | AHPRA kickoff task + 5 practice pack tasks |
| AHPRA | Registration approved | Confirm AHPRA registration | Visa tasks |
| Visa | Visa granted | Manage questionnaire + docs + sponsor | PBS tasks |
| PBS | Provider numbers issued | Apply for Medicare + PBS numbers | Commencement tasks |
| Commencement | GP arrives at practice | Confirm arrival, close case | Case complete |

### Keyboard Shortcuts for the Command Centre

- **Search:** Click the search box or start typing to filter cases
- **Filters:** Click filter tabs to switch between All / Urgent / Overdue / Blocked / Active / Complete
- **View toggle:** Switch between Cases and Work Queue at the top

### Common Task Types

| Type | Created by | Meaning |
|------|-----------|---------|
| **kickoff** | System | New stage started - introduce yourself to the GP's needs at this stage |
| **verify** | System | GP completed something - verify it's correct |
| **review** | System | Document uploaded - review it |
| **followup** | System | Something needs chasing |
| **blocker** | System | A support ticket or issue is blocking progress |
| **sla_overdue** | System | SLA breach detected - act immediately |
| **practice_pack** | System | Parent task for the 5 practice documents |
| **practice_pack_child** | System | Individual practice document task |
| **visa_stage** | System | Visa case stage changed - verify milestone |
| **visa_doc** | System | Visa document uploaded - review it |
| **questionnaire** | System | Questionnaire action needed |
| **manual** | You | Task you created manually |

### The Golden Rules

1. **If it's not in the timeline, it didn't happen.** Always add notes.
2. **Urgent means today.** Don't let urgent tasks sit overnight.
3. **Chase early, chase often.** A 5-day SLA means you contact them on day 5, not day 15.
4. **Verify before advancing.** Never assume a milestone is complete - check the evidence.
5. **One case, one story.** Anyone should be able to read a case timeline and understand exactly where things stand.

---

*This SOP is a living document. If you encounter a scenario not covered here, document it and suggest an update.*
