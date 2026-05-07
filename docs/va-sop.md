# GP Link VA Command Centre - Standard Operating Procedures

**Version:** 2.0
**Effective Date:** May 2026
**Owner:** GP Link Operations
**Applies to:** All Virtual Assistants working in the GP Link Command Centre

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Daily Workflow](#2-daily-workflow)
3. [Understanding Priority Lanes](#3-understanding-priority-lanes)
4. [Working a GP's Case](#4-working-a-gps-case)
5. [The Task System](#5-the-task-system)
6. [Common Task Workflows](#6-common-task-workflows)
7. [Writing Notes](#7-writing-notes)
8. [Case Management](#8-case-management)
9. [Ops Queue](#9-ops-queue)
10. [Handover Procedures](#10-handover-procedures)
11. [Quick Reference](#11-quick-reference)

---

## 1. Getting Started

### Logging In

1. Open the admin login page in your browser.
2. Enter your authorised admin email address.
3. A one-time passcode (OTP) will be sent to your email. Check your inbox.
4. Enter the OTP on screen.
5. You will land on the **VA Command Centre**, with the GPs tab open by default.

### Understanding the Layout

The Command Centre has **four tabs** along the top of the page. You will spend most of your time in the first one.

| Tab | What it is for |
|-----|----------------|
| **GPs** (default) | Your main workspace. Shows all GP cases with their tasks, notes, and registration progress. |
| **Medical Centres** | Information about medical centres and practice contacts. |
| **Support** | Support tickets and WhatsApp help requests from GPs. A notification dot appears when new tickets arrive. |
| **Ops Queue** | A cross-GP operational view. Shows all open tasks across every GP in a single filterable table. Useful for auditing, reporting, and finding tasks that may have been missed. |

### The GPs Tab Layout

When you click on the GPs tab (or when you first log in), this is what you see:

**Left sidebar - GP List:**
- A search bar at the very top for finding GPs by name or email.
- Filter chips below the search bar (All, Urgent, Overdue, Blocked, Active, Complete).
- The GP list itself, split into two **priority lanes** (explained in Section 3):
  - **Needs Action** (marked with a red dot) - GPs who need your attention right now.
  - **On Track** (marked with a green dot) - GPs whose cases are progressing normally.
- Each GP card in the list shows their name, current registration stage, and task count.

**Main area (right side) - appears when you click a GP:**
- **Profile bar** - A compact row at the top showing the GP's name, avatar, email, phone number, country, current stage badge, document count, and quick-action buttons (WhatsApp, Nudge). There is also an expand toggle (the small down-arrow on the right).
- **Journey rail** - A horizontal row of chevrons showing how far the GP has progressed through registration. Completed stages show a tick mark, the current stage is highlighted, and future stages are dimmed.
- **Sub-tabs** - Two tabs: **Tasks** (default) and **Notes**.
- **Task pane or Notes pane** - The content area below the sub-tabs, showing either stage-grouped tasks or the case notes timeline.

---

## 2. Daily Workflow

Follow this routine every working day. The goal is simple: keep every GP's case moving forward.

### Start of Shift

1. **Log in** and wait for the Command Centre to load. The GPs tab opens automatically.
2. **Look at the Needs Action lane first.** These are the GPs who have urgent, overdue, or due-today tasks. Start at the top and work your way down.
3. **Click the first GP in Needs Action.** Read their profile bar to remind yourself who they are. Glance at the journey rail to see where they are in registration. Look at their tasks.
4. **Work through their tasks** using the guided action system (explained in Section 5). Complete what you can, set waiting statuses where you cannot proceed, and add notes for anything you do.
5. **Move to the next GP in Needs Action.** Repeat until the lane is clear or every remaining item is in a waiting state.
6. **Check the On Track lane.** Scan for GPs who might have new tasks or whose waiting periods have ended. Click in and check if anything needs doing.

### Throughout the Day

7. **Process new tasks as they appear.** The system creates tasks automatically when GPs complete milestones (upload a document, pass a verification, etc.). These will cause GPs to appear in the Needs Action lane. Pick them up promptly.
8. **Follow up on waiting tasks.** If you set a task to "Waiting on Practice" yesterday, check whether the response has come in. The system will bump overdue follow-ups to urgent automatically via the daily reconciliation.
9. **Add notes after every action.** Every phone call, every email, every decision. If it is not in the notes, it did not happen.

### End of Shift

10. **Open the expand panel** (click the down-arrow on each GP you worked today) and update the **handover notes** field with anything the next VA needs to know.
11. **Set follow-up dates** on any tasks you are waiting on so they do not fall through the cracks.
12. **Check the Ops Queue tab** for a final scan. Filter by "overdue" to see if anything across all GPs was missed today.

### Weekly

13. **Review all on_hold cases.** Open the filter chips, click "Blocked", and review each blocked case. Can any blockers be resolved this week?
14. **Review practice document progress.** Any document that has been in "awaiting_practice" for more than 5 days needs a chase.

---

## 3. Understanding Priority Lanes

The GP list on the left sidebar is divided into two lanes. The system decides which lane each GP belongs to automatically, based on their tasks.

### Needs Action (Red Dot)

A GP appears in the Needs Action lane if **any** of the following are true:

- They have at least one **urgent** task.
- They have at least one **overdue** task (past its due date).
- They have at least one task **due today**.

This is the lane you should focus on first. These GPs need your attention right now.

### On Track (Green Dot)

A GP appears in the On Track lane if **none** of the above conditions apply. Their tasks are either:

- Not yet due.
- All in a waiting state.
- All completed.

On Track does not mean "ignore". It means there is no immediate deadline pressure. You should still check in on On Track GPs regularly, especially those who have been quiet for several days.

### How the Count Works

Next to each lane label, you will see a number. This is the count of GPs in that lane. For example, "Needs Action 7" means seven GPs need your attention right now.

### Filters Still Work

The filter chips (All, Urgent, Overdue, Blocked, Active, Complete) sit above the priority lanes. When you select a filter, it narrows which GPs are shown, and the lane split still applies within the filtered results. For example, selecting "Urgent" shows only GPs with urgent tasks, and they will all appear in the Needs Action lane.

---

## 4. Working a GP's Case

Here is what happens when you click on a GP in the list.

### Step 1: Read the Profile Bar

The profile bar is the compact row at the top of the main area. It tells you:

- **Avatar and name** - The GP's initials and full name.
- **Contact details** - Email, phone number, and country, shown on the second line.
- **Stage badge** - A coloured pill showing their current registration stage (e.g., "ahpra", "amc").
- **Document count** - How many documents have been approved out of how many are required (e.g., "2/5 docs").
- **WhatsApp button** - If the GP has a linked DoubleTick conversation, this button opens it in a new tab.
- **Nudge button** - Sends a WhatsApp nudge message to the GP about their current stage.

### Step 2: Check the Journey Rail

Below the profile bar, the journey rail shows the GP's progress through the full registration pipeline:

```
Secure Placement --> MyIntealth --> AMC --> AHPRA --> PBS & Medicare --> Commencement
```

- Stages with a tick mark are **completed**.
- The stage with a filled dot is the **current** stage.
- Dimmed stages are **pending** (not yet reached).

The Secure Placement step is non-blocking, meaning it can be worked on in parallel with other stages. The AHPRA stage requires both Secure Placement and AMC to be completed before it unlocks.

### Step 3: Look at the Tasks

Click the **Tasks** sub-tab (it is selected by default). Tasks are grouped by registration stage, not by priority. You will see:

- **Active stages** with a blue dot and full task cards.
- A **"Current stage"** badge on the stage the GP is currently in.
- **Locked stages** shown dimmed with a lock icon and a label like "Unlocks after AMC". You cannot interact with locked-stage tasks.
- An **"Other"** group at the bottom for tasks that do not belong to a specific stage.

### Step 4: Work the Tasks

Each task card has a guided action prompt telling you exactly what to do next. See Section 5 for full details.

### Step 5: Check Notes

Click the **Notes** sub-tab to see the case timeline. This is where all notes, status changes, and automated events are logged in chronological order. Read recent notes to understand what has happened since you last looked at this case.

### Step 6: Expand the Case Management Panel (When Needed)

Click the small down-arrow button on the far right of the profile bar. This opens the **expand panel** with:

- **Case status** (active, on_hold, blocked, complete, withdrawn).
- **Blocker type** (waiting_on_gp, waiting_on_practice, waiting_on_external, internal_review).
- **Follow-up date** - The date you plan to check back on this case.
- **Practice name** and contact details.
- **Handover notes** - Free-text field for shift handover information.
- **Assigned VA** - Who is currently responsible for this case.

You can edit these fields and save changes. Every change is automatically logged to the case timeline.

---

## 5. The Task System

### How Tasks Are Grouped

Tasks are grouped under their **registration stage**, not sorted by priority. Within the Tasks pane, you will see section headers like:

- **Career & Documents** (2 tasks)
- **AHPRA Registration** (3 tasks) - "Current stage"
- **PBS & Medicare** (1 task) - Locked, unlocks after AHPRA

The first open task in an active stage has a blue left border, marking it as the **suggested next task** to work on. You can work tasks in any order, but the blue-bordered one is the system's recommendation.

### Priority Badges

Even though tasks are grouped by stage, priority is still visible. Each task card can show:

- A **red "urgent" badge** if the task is marked urgent.
- An **amber "overdue" badge** if the task is past its due date.

These badges help you spot which tasks within a stage group need immediate attention.

### The Guided Action Prompt

Every task card shows a line that starts with an arrow, like:

> --> Next: Email the practice requesting the Supervisor CV

This is the **guided action prompt**. It tells you exactly what the next step is for this specific task, based on its current state. You do not need to memorise workflows. The system figures out where the task is in its lifecycle and tells you what to do.

### The Primary Action Button

To the right of each task, there is a coloured button matching the guided action. For example:

- **Email Practice** - Opens a pre-filled email to the practice contact.
- **Review Doc** - Opens the document for your review.
- **Send SPPA** - Triggers the SPPA agreement to be sent via Zoho Sign.
- **Complete** - Marks the task as complete.
- **Follow Up** - Marks the task as actioned for follow-up.

Click the primary button to perform the recommended next step. In many cases, this is all you need to do.

### The Three-Dot Menu

Next to the primary button, there is a **three-dot button** (the "more" menu). Click it to see a dropdown with additional actions, grouped into sections:

**Status actions:**
- Mark Complete - Closes the task.
- Start / In Progress - Marks you as actively working on it.
- Waiting on Practice - You have done your part; the practice needs to respond.
- Waiting on GP - You have done your part; the GP needs to respond.

**Communication actions:**
- Email GP - Opens a new email to the GP.
- WhatsApp - Opens the GP's DoubleTick conversation (if linked).
- Send Nudge - Sends a WhatsApp nudge message about the current stage.

**Management actions:**
- Escalate - Flags the task as blocked and escalates it for supervisor attention.

### Waiting States

When a task is in a waiting state, it shows a waiting indicator instead of the guided action prompt:

- "Waiting on practice" (with a timer icon)
- "Waiting on GP" (with a timer icon)
- "Waiting on external" (with a timer icon)

You do not need to actively work on waiting tasks. The system tracks them and will escalate them if the wait runs too long.

### Inline Document Information

For document-related tasks, the task card shows the document details inline:

- **Filename** - The name of the attached file.
- **Auto-matched** indicator - If the document was automatically matched from an incoming email, it says "Auto-matched" along with a confidence percentage.

This means you do not need to navigate to a separate documents tab. Everything is right there on the task card.

---

## 6. Common Task Workflows

### 6.1 Document Tasks (Supervisor CV, Offer/Contract)

These tasks follow the lifecycle: **Request --> Wait --> Review --> Approve or Revise**.

**When no document has been received yet:**

1. The guided action says: "Email the practice requesting the [document name]".
2. Click the **Email Practice** button. A pre-filled email opens with the practice contact, subject line, and body text already written.
3. Review the email, make any adjustments, and send it.
4. The task automatically moves to "Waiting on Practice".

**When a document arrives (manually uploaded or auto-matched from email):**

1. The guided action changes to: "Review the uploaded document and approve" (or "Review the auto-matched document and approve or request revision").
2. Click the **Review Doc** button to open the document.
3. Check that:
   - The document is the correct type (e.g., it really is a supervisor CV, not something else).
   - The GP's name matches.
   - The document is properly signed (if required).
   - The document is legible and complete.
4. If everything is correct, click **Mark Complete** from the three-dot menu.
5. If there is a problem, click **Escalate** or add a note describing the issue and set the task to "Waiting on Practice" with a correction note.

**If the practice does not respond:**

- **Day 5:** The task becomes overdue. Send a follow-up email or call the practice. Update the chased date.
- **Day 10:** Send a second chase. Flag internally.
- **Day 14+:** Escalate. Consider contacting the practice manager directly.

### 6.2 Verification Tasks

These tasks ask you to check that a GP has genuinely completed a milestone.

1. The guided action says: "Review the evidence and verify".
2. Click the **Review** button.
3. Check the evidence:
   - Has the GP actually done what the task says? (For example, if the task says "AMC account created", check that the AMC account genuinely exists, not just that the GP says it does.)
   - Do uploaded documents meet the requirements?
   - Has the AI verification flagged anything? If so, read the AI notes before approving.
4. If verified, click **Complete** to close the task and advance the GP.
5. If not verified, add a note explaining what is wrong and set the task to "Waiting on GP" with a description of what they need to fix.

**Country-specific qualification requirements (MyIntealth stage):**

| Country | Required Documents |
|---------|-------------------|
| UK (GB) | MRCGP + either CCT or PMETB certificate |
| Ireland (IE) | MICGP + CSCST |
| New Zealand (NZ) | FRNZCGP |

Always check that the name on the qualification matches the GP's profile name. Minor differences in middle names are acceptable, but significant mismatches should be flagged.

### 6.3 Practice Pack / SPPA Tasks

When a GP secures a placement, the system creates a parent task with five child tasks -- one for each document the practice must provide:

| Document | Key | Notes |
|----------|-----|-------|
| SPPA-00 (Sponsorship form) | sppa_00 | Sent via Zoho Sign for digital signatures |
| Section G | section_g | Auto-delivered when GP enters AHPRA stage |
| Position Description | position_description | Generated by AI, then reviewed and edited by you |
| Offer/Contract | offer_contract | Requested from the practice |
| Supervisor CV | supervisor_cv | Requested from the practice |

**SPPA-00 workflow:**

1. The guided action says: "Send SPPA agreement via Zoho Sign".
2. Click the **Send SPPA** button. The system prepares the SPPA-00 document and sends it through Zoho Sign to the practice for digital signatures.
3. The task moves to a waiting state. The guided action changes to: "Check Zoho Sign status for signatures".
4. Periodically click **Check Status** to see if signatures are complete.
5. Once signed by all parties, the signed document is automatically uploaded to Google Drive. Mark the task as complete.

**Section G workflow:**

This is automatic. The system delivers the Section G document when the GP enters the AHPRA stage. You do not need to do anything. The task will show "Will auto-deliver when GP enters AHPRA stage".

**Position Description workflow:**

1. The guided action says: "Generate a position description using AI".
2. Click **Generate**. The system uses AI to create a draft position description based on the GP's placement details.
3. The guided action changes to: "Review the generated position description and approve".
4. Click **Edit & Review** to open the document editor. Read through the generated text, make any corrections, and save.
5. Mark the task as complete once the position description is finalised.

**Offer/Contract and Supervisor CV:**

These follow the standard document task workflow described in Section 6.1 above.

### 6.4 WhatsApp Support Requests

When a GP sends a help message via WhatsApp, the system creates a support task.

1. The guided action says: "Respond to the GP's WhatsApp query".
2. Click the **Open Chat** button. This opens the GP's DoubleTick conversation in a new browser tab.
3. Read the GP's message and respond appropriately.
4. If the issue is resolved, return to the Command Centre and mark the task as complete.
5. If the issue requires further action (e.g., chasing a document, contacting a practice), create a follow-up task or update the existing task status as needed.
6. Always add a note to the case timeline summarising what the GP asked and what you did.

### 6.5 Follow-Up Tasks

Follow-up tasks are created in two ways:

- **Manually**, when you create a task from the three-dot menu or the "Add Task" button.
- **Automatically**, when the AI detects a follow-up action in a note you write (see Section 7).

Working a follow-up task:

1. Read the task title and description to understand what follow-up is needed.
2. Check whether the follow-up has already been resolved. Has the GP responded? Has the practice sent the document? The system may have already detected this and auto-completed the task via the daily reconciliation.
3. If not resolved, take the appropriate action (send an email, make a call, send a nudge).
4. Add a note describing what you did.
5. Either complete the task or update the due date if you need to wait longer.

---

## 7. Writing Notes

### The Notes Tab

Click the **Notes** sub-tab on any GP's case to see the full timeline of notes and events. Notes appear in reverse chronological order (newest first).

The timeline includes:

- Notes you or other VAs have written.
- Automated system events (task created, task completed, status changed, document uploaded).
- Priority changes and escalation records.

### Adding a Note

1. At the bottom of the Notes pane, there is a text input field.
2. Type your note. Be specific and factual. Good notes include:
   - What you did: "Emailed Sunrise Medical Centre requesting supervisor CV."
   - What you learned: "GP confirmed AMC verification received, forwarding email today."
   - What needs to happen next: "Practice said they will send the contract by Friday. Follow up Monday if not received."
3. Click the **Add Note** button.

### How AI Detects Follow-Ups

After you save a note, the system sends the text to an AI model that looks for follow-up actions. If it detects one, a blue suggestion box appears below the note input:

```
Follow-up detected
Chase practice for supervisor CV -- due 2026-05-12
Condition: If not received by Friday
[Create Follow-up Task]  [Dismiss]
```

The suggestion includes:

- **Action** - What needs to be done.
- **Deadline** - When it should be done by (the AI interprets relative dates like "Monday" or "next week").
- **Condition** - Any condition mentioned in your note (e.g., "if not received by Friday").

### Confirming or Dismissing a Suggestion

- Click **Create Follow-up Task** to accept. The system creates a follow-up task with the suggested title, due date, and links it back to the note that created it. The task will appear in the GP's task list under the appropriate stage.
- Click **Dismiss** to ignore the suggestion. The note is still saved; no task is created.

You do not have to accept every suggestion. The AI is a helper, not a requirement. Use your judgement.

### Daily Reconciliation

Every day, the system runs an automated check on all follow-up tasks that are due or overdue. It looks at:

- Recent WhatsApp messages (from the GP or practice).
- Recent emails (to or from the GP or practice).
- Recent activity in the app (tasks completed, documents uploaded).

Based on this evidence, the system makes a decision:

- **If the follow-up appears to have been fulfilled** (with 90% or higher confidence), the task is automatically marked as complete. A note is added to the timeline explaining the evidence.
- **If the follow-up has not been fulfilled**, the task is escalated to **urgent** priority, causing the GP to appear in the Needs Action lane.

This means you do not need to manually check every follow-up every day. The system does it for you. But you should still review urgent follow-ups that the reconciliation could not resolve.

---

## 8. Case Management

### Opening the Case Management Panel

Click the **expand toggle** (the small down-arrow on the far right of the profile bar). The panel slides open below the profile bar.

### Fields in the Panel

| Field | What it is for | When to update it |
|-------|---------------|-------------------|
| **Case Status** | The overall status of the GP's registration case. | When the GP's situation changes (e.g., they ask to pause, or a blocker is found). |
| **Blocker Type** | What is preventing progress, if anything. | When you set the case to "blocked". Always specify the blocker type. |
| **Follow-up Date** | The date you plan to revisit this case. | Whenever you set a task to waiting. Set the follow-up date to when you expect a response. |
| **Practice Name** | The name of the GP's assigned practice. | When a placement is confirmed. |
| **Assigned VA** | Which VA is responsible for this case. | During handover, or when cases are reassigned. |
| **Handover Notes** | Free-text notes for the next VA who picks up this case. | At the end of every shift, and whenever important context needs to be passed on. |

### Case Statuses

| Status | When to use it |
|--------|---------------|
| **active** | Default. The case is progressing normally. |
| **on_hold** | The GP has asked to pause, or there is a planned delay (e.g., waiting for exam results in 2 months). Write the reason in handover notes. |
| **blocked** | Something is preventing progress and needs resolution. Always set the blocker type. |
| **complete** | The GP has commenced at their practice. All stages are done. |
| **withdrawn** | The GP has left the program. Write the reason in handover notes. |

### Blocker Types

| Blocker | What it means |
|---------|--------------|
| **waiting_on_gp** | You need the GP to take an action (upload a document, answer a question, complete a form). |
| **waiting_on_practice** | The practice needs to provide something (a document, confirmation, etc.). |
| **waiting_on_external** | An external body needs to act (AHPRA, AMC, immigration, etc.). |
| **internal_review** | The GP Link team needs to review or decide something internally. |

### When to Escalate

Escalate to your supervisor when:

- A GP has been unresponsive for 14+ days despite multiple contact attempts.
- A practice refuses to provide required documents.
- An AHPRA assessment has stalled for 3+ weeks with no communication.
- You are unsure about a document's validity.
- The same blocker has been in place for 10+ business days without resolution.

To escalate: set the blocker type on the case, add a detailed note explaining what you have tried and why you are escalating, and use the three-dot menu on the relevant task to click "Escalate".

---

## 9. Ops Queue

The **Ops Queue** tab (the fourth tab along the top) gives you a cross-GP view of all tasks in the system.

### When to Use It

- **Auditing:** Check that no tasks have been missed across all GPs.
- **Reporting:** See how many tasks are open, overdue, or urgent system-wide.
- **Filtering:** Find specific types of tasks (e.g., all overdue document tasks, all SPPA tasks awaiting signatures).
- **End-of-day scan:** Before finishing your shift, filter by "overdue" to catch anything that slipped through.
- **Supervisor oversight:** Managers can use this view to monitor team workload.

### How It Works

The Ops Queue shows a table of tasks with columns for:

- Task title
- GP name
- Stage
- Priority
- Status
- Due date

You can filter and sort by any column. Click any task row to jump directly to that GP's case in the GPs tab.

### Difference from the GPs Tab

The GPs tab is organised around individual GPs. You select a GP and see their tasks. The Ops Queue is organised around tasks. You see all tasks across all GPs in one flat list. Use whichever view suits the job at hand.

---

## 10. Handover Procedures

When your shift ends and another VA will take over, follow these steps to ensure a smooth handover.

### Before You Leave

1. **Update handover notes on every case you worked today.** Click the expand toggle on each GP's profile bar and write a brief summary in the Handover Notes field:
   - What you did today on this case.
   - What is pending (e.g., "Waiting for Sunrise Medical to send supervisor CV, chased today, follow up Monday").
   - Any important context (e.g., "GP mentioned they are travelling next week and may be slow to respond").

2. **Set follow-up dates.** For every case with a pending action, set the follow-up date in the case management panel. This ensures the next VA knows when to check back.

3. **Check for tasks without notes.** If you completed any tasks today without adding a note, go back and add one now. The timeline should tell the complete story.

4. **Do a final Ops Queue scan.** Open the Ops Queue tab, filter by "urgent" and "overdue", and make sure nothing was missed.

### When You Start a Shift

1. **Check the Needs Action lane.** This is always your first stop.
2. **Read handover notes.** For each GP in Needs Action, click the expand toggle and read the handover notes from the previous VA.
3. **Check follow-up dates.** Look for cases where the follow-up date is today. These need attention even if no task is explicitly due.

### If a Case is Reassigned to You

1. Read all recent notes in the Notes tab to understand the case history.
2. Read the handover notes in the expand panel.
3. Check the journey rail to see where the GP is in registration.
4. Review open tasks and their guided action prompts.
5. Introduce yourself to the GP if appropriate (via WhatsApp or email) so they know who their new point of contact is.

---

## 11. Quick Reference

### The Registration Pipeline

```
Secure Placement --> MyIntealth --> AMC --> AHPRA --> PBS & Medicare --> Commencement
  (non-blocking)                            (requires placement + AMC)
```

Visa is deferred from the current release.

### Stage Cheat Sheet

| Stage | GP's Key Milestone | Your Key Action |
|-------|-------------------|-----------------|
| Secure Placement | Placement at a practice confirmed | Verify placement, begin practice pack collection |
| MyIntealth | Qualifications uploaded and verified | Verify documents match credentials, approve verification |
| AMC | AMC portfolio created, credentials verified | Confirm AMC account and verification |
| AHPRA | Registration form submitted, registration approved | Guide through form, monitor assessment, escalate if stalled |
| PBS & Medicare | Provider and prescriber numbers issued | Apply for Medicare + PBS numbers, track applications |
| Commencement | GP arrives at practice | Confirm arrival, verify all registrations active, close case |

### Task Priority Response Times

| Priority | Meaning | Target Response |
|----------|---------|-----------------|
| **Urgent** | Blocking progress or time-sensitive | Same day |
| **High** | Important for pipeline progression | Within 1 business day |
| **Normal** | Routine task | Within 3 business days |
| **Low** | Non-critical, can be batched | Within 5 business days |

### Common Guided Actions at a Glance

| You see this prompt | Click this button | What happens |
|--------------------|-------------------|--------------|
| Email the practice requesting the [doc] | Email Practice | Pre-filled email opens; task moves to Waiting on Practice |
| Review the uploaded document and approve | Review Doc | Document viewer opens for your inspection |
| Review the auto-matched document and approve or request revision | Review Doc | Document viewer opens with auto-match confidence shown |
| Send SPPA agreement via Zoho Sign | Send SPPA | SPPA sent to practice for digital signing |
| Check Zoho Sign status for signatures | Check Status | Checks whether all parties have signed |
| Generate a position description using AI | Generate | AI creates a draft position description |
| Review the generated position description and approve | Edit & Review | Document editor opens for your edits |
| Review the evidence and verify | Review | Opens evidence for your verification |
| Respond to the GP's WhatsApp query | Open Chat | Opens the DoubleTick conversation in a new tab |
| Follow up with the GP | Follow Up | Marks the task as actioned |

### The Three-Dot Menu Actions

| Action | What it does |
|--------|-------------|
| Mark Complete | Closes the task |
| Start / In Progress | Marks you as actively working on it |
| Waiting on Practice | Sets waiting status; practice needs to respond |
| Waiting on GP | Sets waiting status; GP needs to respond |
| Email GP | Opens a new email to the GP |
| WhatsApp | Opens the DoubleTick conversation |
| Send Nudge | Sends a WhatsApp nudge about the current stage |
| Escalate | Flags the task as blocked and escalates |

### SLA Thresholds

| SLA | Threshold | Your Action |
|-----|-----------|-------------|
| GP inactivity | 5 days with no activity | Contact the GP. Day 5 = friendly check-in. Day 10 = direct follow-up. Day 14 = set blocked, escalate. |
| Practice response | 5 business days | Chase the practice. |
| Task overdue | Past due date | Review, complete, update due date, or escalate. |

### The Golden Rules

1. **If it is not in the timeline, it did not happen.** Always add notes.
2. **Urgent means today.** Never let an urgent task sit overnight.
3. **Chase early, chase often.** Contact on day 5, not day 15.
4. **Verify before advancing.** Never assume a milestone is complete -- check the evidence.
5. **One case, one story.** Anyone should be able to read a case timeline and understand exactly where things stand.
6. **Needs Action first.** Always start your day with the Needs Action lane.
7. **Handover is not optional.** Update handover notes before you leave, every shift.

---

*This SOP is a living document. If you encounter a scenario not covered here, document it in a case note and suggest an update to your supervisor.*
