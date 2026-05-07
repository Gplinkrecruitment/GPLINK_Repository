# GP Link VA Command Centre -- CEO Technical Overview

**Document version:** 2026-05-07  
**Audience:** Executive leadership  
**Purpose:** Definitive reference for every process and system in the VA Command Centre

---

## Table of Contents

1. [What the VA Command Centre Is](#1-what-the-va-command-centre-is)
2. [System Architecture](#2-system-architecture)
3. [Database Design](#3-database-design)
4. [The Redesign (Phase 1) -- Interface and Workflow](#4-the-redesign-phase-1----interface-and-workflow)
5. [AI Features (Phase 2) -- Intelligent Automation](#5-ai-features-phase-2----intelligent-automation)
6. [The Registration Flow](#6-the-registration-flow)
7. [Task Lifecycle](#7-task-lifecycle)
8. [The Guided Action System](#8-the-guided-action-system)
9. [The Needs Action Algorithm](#9-the-needs-action-algorithm)
10. [The Reconciliation Flow (Step by Step)](#10-the-reconciliation-flow-step-by-step)
11. [External Integrations](#11-external-integrations)
12. [Cost Projections](#12-cost-projections)
13. [Security Architecture](#13-security-architecture)
14. [Environment Variables Reference](#14-environment-variables-reference)
15. [Monitoring and Troubleshooting](#15-monitoring-and-troubleshooting)

---

## 1. What the VA Command Centre Is

The VA Command Centre is the internal dashboard used by GP Link's Virtual Assistants (VAs) to manage the registration journey of every GP moving to Australia. It is the operational heart of the business -- every GP's case, every task, every document, every communication channel converges here.

Think of it as air traffic control for GP registrations. Each GP is a "flight" progressing through a defined route (Placement, MyIntealth, AMC, AHPRA, PBS, Commencement). The VA sees every flight's status at a glance, knows which ones need immediate attention, and has one-click actions to move each one forward.

---

## 2. System Architecture

### High-Level Overview

```
                  Internet
                     |
              +------v------+
              |   Vercel     |  (Hosting + Edge Network)
              |   CDN/Edge   |
              +------+------+
                     |
              +------v------+
              |  server.js   |  Single Node.js process
              |  (monolith)  |  Handles ALL routes:
              |              |  - API endpoints
              |              |  - Static file serving
              |              |  - Authentication
              |              |  - Admin dashboard
              +------+------+
                     |
       +-------------+-------------+
       |             |             |
+------v------+ +---v----+ +-----v------+
|  Supabase   | | Claude | |  External  |
|  PostgreSQL | |  API   | |  Services  |
| (database)  | |  (AI)  | |            |
+-------------+ +--------+ +-----+------+
                                  |
                    +-------------+-------------+
                    |             |             |
              +-----v----+ +----v-----+ +-----v------+
              |  Gmail   | | Double   | | Zoho Sign  |
              |  API     | | Tick API | | + Recruit  |
              +---------+  +---------+  +-----------+
```

### How It Works

**Single entry point.** Every HTTP request -- whether it is a browser loading the admin page, an API call saving a task, or a cron job running the daily reconciliation -- enters through `server.js`. This is a monolithic Node.js application, meaning all the code lives in one file. This is intentional: it keeps deployment simple and eliminates the complexity of microservices.

**Vercel deployment.** The app is hosted on Vercel, a cloud platform. Vercel's `vercel.json` configuration routes every incoming request (`/(.*)`) to `server.js` via the `@vercel/node` runtime. Vercel also runs scheduled cron jobs (more on those in Section 5).

**Serverless execution.** Each request spins up a fresh instance of `server.js` (or reuses a warm one). This means there is no persistent server running 24/7 -- Vercel scales automatically. The tradeoff is that in-memory data (like the daily AI spend counter) resets when a new instance starts. This is acceptable because the budget tracker is a safety net, not a billing system.

**Database.** Production uses Supabase, which is a managed PostgreSQL database. All persistent data lives here: GP profiles, registration cases, tasks, timeline events, WhatsApp messages. In development, a local JSON file (`data/app-db.json`) stands in for the database.

---

## 3. Database Design

The VA Command Centre relies on six core tables. Each one serves a distinct purpose in the system.

### `registration_cases` -- One per GP

This is the master record for each GP's registration journey.

| Column | Purpose |
|---|---|
| `id` | Unique case identifier (UUID) |
| `user_id` | Links to the GP's user account |
| `assigned_va` | Which VA owns this case |
| `stage` | Current registration stage (e.g., `myintealth`, `ahpra`, `pbs`) |
| `substage` | Granular sub-step within the stage |
| `status` | Case health: `active`, `on_hold`, `blocked`, `complete`, `withdrawn` |
| `blocker_status` | If blocked: who are we waiting on? (`waiting_on_gp`, `waiting_on_practice`, `waiting_on_external`, `internal_review`) |
| `blocker_reason` | Free-text explanation of what is blocking progress |
| `next_followup_date` | When the VA should next check in |
| `last_gp_activity_at` | Last time the GP did something in the app |
| `last_va_action_at` | Last time a VA touched this case |
| `practice_name` | The medical centre the GP is assigned to |
| `practice_contact` | Contact details (JSON) for the practice |
| `handover_notes` | Notes for when a case transfers between VAs |
| `gp_verified_stage` | The stage confirmed by app-side verification logic |

**Key constraint:** One case per GP (`UNIQUE(user_id)`). A GP cannot have two simultaneous registrations.

### `registration_tasks` -- All Work Items

Every action a VA needs to take is a task. Tasks are linked to cases and organized by registration stage.

| Column | Purpose |
|---|---|
| `id` | Unique task identifier |
| `case_id` | Which GP case this belongs to |
| `parent_task_id` | For sub-tasks (e.g., a practice pack has child document tasks) |
| `task_type` | Classification: `kickoff`, `verify`, `review`, `followup`, `blocker`, `escalation`, `practice_pack_child`, `manual`, `system`, `whatsapp_help`, `chase`, `doc_review`, and others |
| `title` | Human-readable task description |
| `priority` | `urgent`, `high`, `normal`, `low` |
| `status` | `open`, `in_progress`, `waiting`, `waiting_on_gp`, `waiting_on_practice`, `waiting_on_external`, `blocked`, `completed`, `cancelled` |
| `due_date` | When this task should be done by |
| `related_stage` | Which registration stage this task belongs to (used for grouping in the UI) |
| `related_document_key` | If this task is about a specific document (e.g., `sppa_00`, `offer_contract`) |
| `follow_up_source_timeline_id` | Links a follow-up task back to the note that created it (added in Phase 2) |
| `attachment_url` | Document attached to this task (e.g., auto-matched from email) |
| `gmail_message_id` | If the attachment was auto-parsed from email |
| `ai_confidence` | AI's confidence score in the email-to-task match |
| `zoho_sign_envelope_id` | Tracks Zoho Sign document signing status |

### `task_timeline` -- The Audit Trail

Every significant event is logged here. This creates a complete, tamper-evident history of what happened to every case and task.

| Column | Purpose |
|---|---|
| `task_id` | Which task this event relates to (nullable -- some events are case-level) |
| `case_id` | Which case this event belongs to |
| `event_type` | `created`, `status_change`, `assigned`, `note`, `blocker_set`, `blocker_cleared`, `priority_change`, `stage_change`, `completed`, `cancelled`, `system`, `reopened` |
| `title` | Summary of what happened |
| `detail` | Full detail text |
| `actor` | Who did it (VA email, `system`, `system:reconciliation`, `system:gmail-autoparse`) |
| `metadata` | Flexible JSON for extra context |
| `created_at` | Timestamp |

**Why this matters:** If anyone ever asks "who did what and when," the timeline has the answer. Every AI auto-completion, every VA action, every status change is recorded with the actor and timestamp.

### `doubletick_messages` -- WhatsApp Message Store (NEW in Phase 2)

Every inbound WhatsApp message received via the DoubleTick webhook is stored here. This serves two purposes: (1) the daily reconciliation AI can read recent messages to determine if a follow-up was addressed, and (2) it creates a searchable archive of all GP communications.

| Column | Purpose |
|---|---|
| `case_id` | Linked case (matched via phone number lookup) |
| `user_id` | Linked GP user |
| `from_phone` | Sender's phone number |
| `contact_name` | Name from DoubleTick |
| `message_body` | Message text (truncated to 2,000 characters) |
| `message_type` | `TEXT`, `IMAGE`, etc. |
| `direction` | `inbound` or `outbound` |
| `doubletick_message_id` | External message ID for deduplication |
| `conversation_url` | Direct link to the DoubleTick conversation |

### `user_profiles` -- GP Identity

Stores the GP's personal details: name, email, phone, country. Used for display in the Command Centre and for cross-referencing communications.

### `user_state` -- GP Journey Progress

Tracks each GP's progress through the registration stages from the app side. The VA Command Centre reads this to build the journey rail and auto-create tasks when a GP advances.

---

## 4. The Redesign (Phase 1) -- Interface and Workflow

Phase 1 completely rebuilt the VA's workspace from a basic admin panel into a purpose-built command centre. Every element was designed to answer one question: **"What should I do next?"**

### Top Navigation -- Four Workspaces

The top of the screen has four tabs that represent the four domains of VA work:

| Tab | Purpose | What it contains |
|---|---|---|
| **GPs** (default) | The primary workspace. Manage GP registration cases. | Priority-sorted GP list, case detail panels, tasks, notes |
| **Medical Centres** | Practice relationship management. | List of medical centres, contact details, linked GPs, practice pack status |
| **Support** | Inbound support tickets from GPs. | FIFO queue of support requests, resolve/close/reopen actions |
| **Ops Queue** | Operational overview of all tasks across all GPs. | All open tasks sorted by priority, SLA tracking, overdue detection |

### Priority Lanes -- Instant Triage

When a VA opens the GPs tab, the GP list is automatically split into two lanes:

**Needs Action (red dot):** GPs who have at least one task that is urgent, overdue, or due today. These are the GPs that need attention right now.

**On Track (green dot):** GPs whose tasks are all progressing normally with no urgent items.

This split means the VA never has to manually scan through a list to find who needs help. The system surfaces urgency automatically. The count next to each lane label shows how many GPs are in each category.

### Profile Bar -- GP Identity at a Glance

When a VA clicks on a GP, the top of the detail view shows a compact profile bar:

- **Avatar** with the GP's initials
- **Name, email, phone, country** on a single line
- **Stage pill** showing the current registration stage (colour-coded)
- **Document counter** showing approved documents vs. required (e.g., "3/5 docs")
- **Quick action buttons:** WhatsApp (opens DoubleTick conversation), Nudge (sends a WhatsApp reminder)
- **Expand toggle** that reveals the full case management form (assigned VA, blocker status, practice details, handover notes)

### Journey Rail -- Visual Progress Tracker

Below the profile bar, a horizontal sequence of chevron-shaped pills shows the GP's journey:

```
[Placement] -> [MyIntealth] -> [AMC] -> [AHPRA] -> [PBS] -> [Commence]
```

Each step is colour-coded:
- **Green (done):** Completed stages show with a solid green background
- **Blue (current):** The active stage pulses with a blue glow
- **Grey (pending):** Future stages are greyed out

The chevron arrows between stages create a clear left-to-right visual flow. This lets the VA instantly understand where the GP is in their journey without reading any text.

### Stage-Grouped Tasks -- Work Organized by Context

Below the journey rail, the GP's open tasks are organized by registration stage (not by priority or creation date). This means all AHPRA-related tasks are grouped together, all MyIntealth tasks together, and so on.

Within each stage group:
- A header shows the stage name
- If the stage is locked (prerequisites not met), tasks are shown dimmed with a lock badge explaining what needs to happen first (e.g., "Unlocks after AMC")
- The first actionable task in the current stage is highlighted with an `active-next` visual treatment
- Each task card shows:
  - Task title with urgent/overdue badges
  - Attached document info (filename, auto-match confidence if from email)
  - A guided action prompt ("-> Next: [instruction]") telling the VA exactly what to do
  - A primary action button (the one-click action)
  - A "..." dropdown with secondary actions (mark complete, start, set waiting status, email GP, WhatsApp, send nudge, escalate)

### Sub-tabs -- Tasks and Notes

The detail view has two tabs:

**Tasks:** The stage-grouped task view described above, plus an "+ Add Task" button at the bottom for manual task creation.

**Notes:** A chronological feed of case notes with the ability to add new notes. When a VA writes a note, it is sent to AI for follow-up detection (see Phase 2).

Documents are not a separate tab. Instead, document information is embedded directly into task cards (as attachments, preview buttons, and guided actions). This keeps everything in context rather than forcing the VA to switch between tabs.

---

## 5. AI Features (Phase 2) -- Intelligent Automation

Phase 2 adds two AI-powered capabilities that reduce manual work and catch things humans might miss.

### Part A: Note Follow-up Detection

**The problem it solves:** A VA writes a note like "Called AHPRA, they said the application will be processed by Friday." That note contains an implicit follow-up: check back on Friday to see if AHPRA processed it. Without automation, the VA has to manually remember to create a follow-up task.

**How it works:**

1. VA writes a note in the Notes tab and clicks Save
2. The note text is sent to the API endpoint `/api/admin/va/note/parse-followup`
3. The endpoint sends the note to **Claude Haiku** (Anthropic's fastest, cheapest model) with this system prompt:

   > "You extract follow-up actions from case management notes. Today is [date]. Return JSON only, no markdown. If no follow-up is needed, return `{"followup":null}`. If a follow-up exists, return `{"followup":{"action":"<what to do>","deadline":"<YYYY-MM-DD>","condition":"<if any, else null>"}}`. Interpret relative dates (e.g. 'Monday' = next Monday, 'Friday' = this Friday if today is before Friday, else next Friday)."

4. The AI reads the note and returns structured JSON. For the example above, it would return:
   ```json
   {"followup": {"action": "Check if AHPRA processed the application", "deadline": "2026-05-09", "condition": null}}
   ```

5. The UI shows a one-click suggestion: "Create follow-up task: Check if AHPRA processed the application -- Due Friday May 9"

6. If the VA clicks "Create," the system creates a `followup` task linked back to the original timeline entry via `follow_up_source_timeline_id`

**What happens if the AI cannot extract a follow-up:** It returns `{"followup": null}` and no suggestion appears. The VA proceeds normally.

**What happens if the budget is exceeded:** The endpoint returns `{"followup": null, "reason": "budget_exceeded"}` -- the feature silently degrades with no disruption to the VA's workflow.

**Model used:** Claude Haiku (`claude-haiku-4-5-20251001`) -- chosen for speed (under 1 second) and cost (fraction of a cent per call).

### Part B: Daily Reconciliation

**The problem it solves:** Follow-up tasks accumulate. Some get resolved naturally -- the GP responds via WhatsApp, AHPRA sends a confirmation email, the practice uploads a document. Without automation, a VA has to manually check each follow-up against multiple communication channels to see if it has been addressed.

**How it works (the full step-by-step flow is in Section 10):**

A Vercel cron job runs at **6:00 AM AEST daily** (configured as `0 20 * * *` UTC in `vercel.json`). For each follow-up task that is due today or overdue, the system:

1. Gathers evidence from three channels (WhatsApp messages, Gmail, app events)
2. Sends everything to **Claude Opus** (Anthropic's most capable model) for judgment
3. If the AI determines the follow-up was fulfilled (90%+ confidence), the task is auto-completed with a full audit trail
4. If not fulfilled, the task is escalated to urgent priority

**Model used:** Claude Opus (`claude-opus-4-6`) -- chosen because this is a high-stakes judgment call. A wrong auto-completion could mean a GP's registration step gets skipped. Opus provides the highest accuracy.

**Confidence threshold:** 90%. Below this, the system does not auto-complete -- it escalates instead. This is conservative by design. It is better to escalate a resolved follow-up (minor VA inconvenience) than to auto-close an unresolved one (registration delay).

### Phase 2 Audit Fixes

Three data quality issues were fixed as part of Phase 2 to ensure the AI has clean data to work with:

1. **`related_stage` backfill:** Some tasks were missing their stage assignment. A migration script inferred stages from document keys (practice pack documents = `ahpra` stage) and from case stages (manual tasks inherit the case's current stage). All tasks now have a stage, which means the stage-grouped view in Phase 1 is complete.

2. **DoubleTick message storage:** Previously, WhatsApp messages were processed for AI responses but not stored. Now every inbound message is stored in `doubletick_messages` with case and user linkage (matched via phone number). This gives the reconciliation AI access to communication history.

3. **Follow-up linkage:** The `follow_up_source_timeline_id` column on `registration_tasks` links AI-suggested follow-up tasks back to the note that triggered them. This creates full traceability: note -> AI suggestion -> follow-up task -> reconciliation verdict -> auto-completion or escalation.

---

## 6. The Registration Flow

Every GP follows this journey:

```
Secure Placement (non-blocking) -> MyIntealth -> AMC -> AHPRA -> PBS & Medicare -> Commencement
```

### What each stage means

| Stage | What happens | Prerequisite |
|---|---|---|
| **Secure Placement** | GP is matched with an Australian medical centre. This stage runs in parallel -- it does not block other stages from starting. | None (entry point) |
| **MyIntealth** | GP completes their profile, uploads qualifications, personal documents. | None |
| **AMC** | Australian Medical Council credential verification. GP uploads credentials, VA tracks AMC processing. | None (but typically after MyIntealth) |
| **AHPRA** | Australian Health Practitioner Regulation Agency registration. Practice pack documents are prepared and submitted. | Requires both **Placement secured** AND **AMC completed** |
| **PBS & Medicare** | Provider number applications for prescribing and Medicare billing. | After AHPRA |
| **Commencement** | Final pre-arrival checklist, onboarding at the practice. | After PBS |

**Note:** The Visa application step exists in the codebase but is deferred for v1. The server logic, pages, and admin views remain in place but are hidden from the user-facing journey.

### Stage locking

AHPRA is the key locked stage. The system enforces that a GP cannot enter AHPRA until both their placement is secured AND their AMC verification is complete. In the task view, locked stage groups appear dimmed with a lock icon and the message "Unlocks after [prerequisite stage]."

---

## 7. Task Lifecycle

Every task follows this state machine:

```
                   +--------+
                   | Created|  (auto or manual)
                   +---+----+
                       |
                       v
                   +---+----+
              +--->|  Open  |<---+
              |    +---+----+    |
              |        |         |  (reopen)
              |        v         |
              |  +-----+------+ |
              |  | In Progress| |
              |  +-----+------+ |
              |        |         |
              |        v         |
              |  +-----+------+----+
              |  |   Waiting       |
              |  | on_practice     |
              |  | on_gp           |
              |  | on_external     |
              |  +-----+-----+----+
              |        |     |
              |        |     +------+
              |        v            v
              |  +-----+------+ +--+------+
              |  | Completed  | | Blocked |
              |  +------------+ +--+------+
              |                    |
              |                    v
              +              +-----+------+
                             | Escalation |
                             +------------+
```

### How tasks are created

Tasks enter the system through four channels:

1. **Auto-created by GP actions:** When a GP advances to a new stage (e.g., completes MyIntealth), the server automatically creates the verification and review tasks for that stage.

2. **Auto-created by email parsing:** The Gmail integration watches the VA inbox. When an email arrives with an attachment that matches a GP (by name or case context), a `doc_review` task is created with the document attached.

3. **Auto-created by WhatsApp:** When a GP sends a WhatsApp message that the AI classifies as a help request, a `whatsapp_help` task is created.

4. **Manually created by VAs:** The "+ Add Task" button lets VAs create tasks for anything not covered by automation.

### Statuses explained

| Status | Meaning | Who acts next |
|---|---|---|
| `open` | New task, not started | VA |
| `in_progress` | VA is actively working on it | VA |
| `waiting` | Generic waiting state | Depends on context |
| `waiting_on_gp` | Waiting for the GP to do something | GP |
| `waiting_on_practice` | Waiting for the medical centre | Practice |
| `waiting_on_external` | Waiting on a third party (AHPRA, AMC, etc.) | External body |
| `blocked` | Cannot proceed due to an issue | Requires escalation |
| `completed` | Done | No one |
| `cancelled` | No longer needed | No one |

---

## 8. The Guided Action System

The guided action system is the core UX innovation of the redesigned Command Centre. For every task, the system determines the single most logical next step and presents it as a one-click action.

### How it works

The function `getGuidedAction(task)` examines the task's type, document key, attachment status, and current state to determine what the VA should do. It returns three things:

1. **Prompt** -- A human-readable instruction (displayed as "-> Next: [instruction]")
2. **Label** -- The button text
3. **Action** -- The technical action to execute when clicked

### The complete action mapping

| Task condition | Prompt shown to VA | Button label | Action |
|---|---|---|---|
| **SPPA document** (no envelope yet) | "Send SPPA agreement via Zoho Sign" | Send SPPA | Opens Zoho Sign sending flow |
| **SPPA document** (envelope exists) | "Check Zoho Sign status for signatures" | Check Status | Queries Zoho Sign API |
| **Section G** (not completed) | "Will auto-deliver when GP enters AHPRA stage" | Waiting | No action (informational) |
| **Section G** (completed) | "Section G auto-delivered" | Done | No action |
| **Position Description** (not generated) | "Generate a position description using AI" | Generate | Triggers AI document generation |
| **Position Description** (generated) | "Review the generated position description and approve" | Edit & Review | Opens document editor |
| **Document task** (auto-matched from email) | "Review the auto-matched document and approve or request revision" | Review Doc | Opens document preview |
| **Document task** (manually uploaded) | "Review the uploaded document and approve" | Review Doc | Opens document preview |
| **Document task** (waiting on practice) | "Waiting on practice to send the document" | Waiting | No action |
| **Document task** (no attachment) | "Email the practice requesting the [Contract/Supervisor CV]" | Email Practice | Opens email compose |
| **Verify task** | "Review the evidence and verify" | Review | Completes task |
| **Kickoff / review task** | "Review and complete this task" | Complete | Completes task |
| **Blocker / escalation task** | "Resolve the blocking issue" | Resolve | Completes task |
| **WhatsApp help task** | "Respond to the GP's WhatsApp query" | Open Chat | Opens DoubleTick conversation |
| **Follow-up / chase / nudge task** | "Follow up with the GP" | Follow Up | Completes task |
| **Any other task** | "Complete this task" | Complete | Completes task |

### Why this matters

Without guided actions, a VA looks at a task and has to figure out what to do. With guided actions, the system tells them. This reduces training time, prevents mistakes, and dramatically speeds up task throughput. A VA working through 50 tasks sees 50 clear instructions instead of 50 puzzles to solve.

---

## 9. The Needs Action Algorithm

The priority lanes split is computed every time the GP list renders. Here is the exact logic:

### For each GP case, the system checks three conditions:

1. **Has urgent tasks?** -- Does the case have any tasks where `priority === 'urgent'`? (The `urgent_tasks` count is pre-computed by the dashboard API.)

2. **Has overdue tasks?** -- Does the case have any tasks where the `overdue_tasks` count is greater than zero? (Overdue means the task's `due_date` or `sla_due_date` has passed and the task is not completed.)

3. **Has tasks due today?** -- Does the case have any task where `due_date` is today and `status` is not `completed`? (This uses a same-day date comparison.)

### The classification:

- If **any** of the three conditions is true: the GP goes into **Needs Action** (red lane)
- If **none** of the three conditions is true: the GP goes into **On Track** (green lane)

### Visual treatment:

- The Needs Action lane appears first, with a red dot indicator and a count badge
- A divider line separates the two lanes
- The On Track lane appears below with a green dot indicator and its own count
- Within each lane, GP cards are rendered in their filtered order

### What this means in practice:

At a glance, a VA sees: "I have 4 GPs that need action and 12 on track." They work through the Needs Action lane first, knowing that everything in On Track can wait. When all urgent/overdue/due-today items are resolved, the Needs Action lane empties and all GPs move to On Track.

---

## 10. The Reconciliation Flow (Step by Step)

This is the most sophisticated automated process in the system. Here is exactly what happens:

### Step 1: Cron trigger (6:00 AM AEST daily)

Vercel fires a GET request to `/api/cron/reconcile-followups`. The endpoint verifies the request using a `CRON_SECRET` bearer token (prevents unauthorized triggering).

### Step 2: Find due follow-ups

The system queries the database:
```
SELECT * FROM registration_tasks
WHERE task_type = 'followup'
  AND status IN ('open', 'in_progress', 'waiting')
  AND due_date <= TODAY
```

This returns all follow-up tasks that are either due today or overdue. If none are found, the process ends immediately with "No follow-ups due."

### Step 3: For each follow-up task, gather evidence

For each task, the system:

**a. Loads the case and GP profile**
- Fetches the `registration_case` to get context (practice info, user ID)
- Fetches the `user_profile` to get the GP's email, phone, and name

**b. Collects WhatsApp messages (last 7 days)**
- Queries `doubletick_messages` for this case ID, created in the last 7 days
- Returns up to 10 most recent messages with direction (inbound/outbound) and message body

**c. Searches Gmail (last 7 days)**
- Uses the `searchGmailForGP` utility, which:
  - Authenticates to Gmail using the Google Service Account
  - Builds a search query: `{from:gp@email to:gp@email from:practice@email to:practice@email} after:2026/04/30`
  - Returns up to 10 messages with subject, sender, and snippet
- Searches across both the GP's email and the practice's email

**d. Fetches app events (last 7 days)**
- Queries `task_timeline` for this case: completions, status changes, and notes from the last 7 days
- Returns up to 10 most recent events

### Step 4: Build the activity summary

All evidence is compiled into a structured text document:

```
Recent activity for Dr. Jane Smith:

WhatsApp messages (last 7 days):
- [inbound] Hi, yes we received the AHPRA confirmation... (5/5/2026)
- [outbound] Good morning, just checking if you received... (5/3/2026)

Emails (last 7 days):
- From: ahpra@ahpra.gov.au | Subject: Registration Confirmation | Your application... (5/4/2026)

App events (last 7 days):
- completed: AHPRA application submitted (5/4/2026)
- note: VA called AHPRA, confirmed processing (5/2/2026)
```

### Step 5: AI verdict

The summary is sent to Claude Opus with this system prompt:

> "You are reviewing whether a follow-up task has been fulfilled based on recent activity. Return JSON only. Format: {"fulfilled": true/false, "confidence": 0.0-1.0, "evidence": "brief explanation"}. A task is fulfilled if the activity clearly shows the follow-up action was completed or the condition was met."

The user message includes the task title, due date, description, and the full activity summary.

**Temperature is set to 0** (deterministic output). **Max tokens is 200** (keeps responses concise). **Timeout is 30 seconds.**

### Step 6: Parse the AI response

The AI returns something like:
```json
{"fulfilled": true, "confidence": 0.95, "evidence": "AHPRA confirmation email received on 5/4 and GP confirmed receipt via WhatsApp on 5/5"}
```

### Step 7: Decision and action

**If fulfilled AND confidence >= 90%:**
- The task is marked as completed (actor: `system:reconciliation`)
- A timeline entry is logged: "Auto-resolved by reconciliation. Evidence: [AI's explanation with confidence %]"
- The result is recorded as `auto_completed`

**If NOT fulfilled OR confidence < 90%:**
- The task's priority is escalated to `urgent`
- A timeline entry is logged: "Escalated to urgent by reconciliation. Follow-up not fulfilled. [AI's explanation]"
- The result is recorded as `escalated_to_urgent`

### Step 8: Budget guard

Before each AI call, the system checks `checkAnthropicBudget()`. If the daily spend has exceeded the configured limit (`ANTHROPIC_DAILY_LIMIT_USD`, default $100), the task is skipped with reason `budget_exceeded`. This prevents runaway costs if something goes wrong.

### Step 9: Return results

The endpoint returns a JSON summary of all processed tasks:
```json
{
  "ok": true,
  "processed": 15,
  "results": [
    {"task_id": "...", "title": "Check AHPRA status", "status": "auto_completed", "confidence": 0.95, "evidence": "..."},
    {"task_id": "...", "title": "Follow up on PBS", "status": "escalated_to_urgent", "confidence": 0.4, "evidence": "..."},
    {"task_id": "...", "title": "Chase supervisor CV", "status": "skipped", "reason": "budget_exceeded"}
  ]
}
```

---

## 11. External Integrations

### Gmail API (Google Service Account)

**Purpose:** Reads the VA's inbox to find GP-related emails for the reconciliation engine and for auto-parsing attachments into tasks.

**How it connects:** Uses a Google Cloud service account with domain-wide delegation. The service account impersonates the VA's Gmail address (`VA_GMAIL_ADDRESS`) to read messages. No password or OAuth login is needed -- the service account has pre-authorized access.

**Gmail Push Notifications:** A Google Pub/Sub topic is configured to notify the app when new emails arrive. The app's webhook receives these notifications and processes attachments in near-real-time, creating `doc_review` tasks with auto-matched documents.

### DoubleTick API (WhatsApp)

**Purpose:** Two-way WhatsApp communication with GPs.

**Inbound:** DoubleTick sends a webhook to the app when a GP sends a WhatsApp message. The message is:
1. Stored in `doubletick_messages` for reconciliation
2. Analyzed by AI to determine if it is a help request (creates a `whatsapp_help` task if so)

**Outbound:** The app sends WhatsApp messages via the DoubleTick API for nudges, notifications, and automated reminders.

### Zoho Sign

**Purpose:** Electronic signing of the SPPA (Specialist Pathway Practice Agreement) document.

**How it works:** When a VA clicks "Send SPPA" on a practice pack task, the system uses a Zoho Sign template to generate a personalized agreement, sends it to the practice for signing, and tracks the signing status. The task's `zoho_sign_envelope_id` links to the Zoho Sign envelope.

### Zoho Recruit

**Purpose:** Job synchronization. Medical centre job listings are synced from Zoho Recruit to match GPs with available positions.

**Schedule:** A cron job runs at 6:00 AM UTC daily (`0 6 * * *`) to sync new and updated listings.

---

## 12. Cost Projections

### AI Costs

| Feature | Model | Pricing | Estimated daily usage | Estimated daily cost | Monthly cost (30 days) |
|---|---|---|---|---|---|
| Note follow-up detection | Claude Haiku | $0.80/MTok in, $4/MTok out | ~100 notes, ~200 tokens each | $0.30 - $0.50 | $9 - $15 |
| Daily reconciliation | Claude Opus | $15/MTok in, $75/MTok out | ~50 follow-ups, ~800 tokens each | $3 - $8 | $90 - $240 |
| WhatsApp AI triage | Claude Sonnet | $3/MTok in, $15/MTok out | ~100 messages | $0.50 - $1.00 | $15 - $30 |
| Qualification verification | Claude Sonnet | $3/MTok in, $15/MTok out | ~20 scans | $0.30 - $0.50 | $9 - $15 |
| **Total** | | | | **$4 - $10/day** | **$123 - $300/month** |

### At scale (1,000 active GPs)

| Feature | Estimated daily cost | Monthly cost |
|---|---|---|
| Note follow-up detection | $0.50 | $15 |
| Daily reconciliation (1,000 follow-ups) | $7.84 | $235 |
| WhatsApp AI triage | $2.00 | $60 |
| Qualification verification | $1.50 | $45 |
| **Total at 1,000 GPs** | **~$12/day** | **~$355/month** |

### Infrastructure costs

| Service | Monthly cost |
|---|---|
| Vercel (Pro plan) | $20/month base + usage |
| Supabase (Pro plan) | $25/month base + usage |
| Google Workspace (service account) | $0 (included in existing workspace) |
| DoubleTick | Per-message pricing (varies by volume) |
| Zoho Sign | Per-document pricing (varies by plan) |

### Budget safety

The `ANTHROPIC_DAILY_LIMIT_USD` environment variable (default: $100/day) acts as a hard cap. If AI spend reaches this limit on any given day, all AI features gracefully degrade -- they return empty/null results instead of errors. The VA's workflow continues without AI assistance until the next day when the counter resets.

---

## 13. Security Architecture

### Authentication

**GP users:** OTP (One-Time Password) login. GPs enter their email or phone number, receive a 6-digit code, and submit it to verify their identity. No passwords are stored. Sessions are maintained via the `gp_session` cookie, which is an HMAC-signed token using the `AUTH_SECRET`.

**Admin/VA users:** Separate OTP flow with the `gp_admin_session` cookie. Admin access requires the user's email to be listed in the server's admin email configuration. Three role levels exist:
- **Staff** -- Basic VA access
- **Admin** -- Full VA access plus configuration
- **Super Admin** -- Everything, including system settings and agent controls

**OTP security:**
- Codes are hashed before storage (never stored in plain text)
- Codes expire after a fixed time window
- Rate limiting prevents brute-force attempts (per IP + per email/phone)
- Per-user AI verification limits: max 10 AI calls per user per day (prevents abuse of the document verification feature)

### Cross-Site Request Forgery (CSRF) Protection

All mutation requests (POST, PUT, PATCH, DELETE) are checked by `enforceMutationOrigin()`:
- Verifies that the `Origin` or `Referer` header matches the request's `Host` header
- If they do not match, the request is rejected with HTTP 403
- In development mode, this check is relaxed (no origin/referer headers are accepted)

### Cross-Site Scripting (XSS) Prevention

Multiple layers of defense:

1. **Content Security Policy (CSP):** A strict CSP header is set on every response:
   - `default-src 'self'` -- Only load resources from the same origin
   - `script-src` limited to self, inline (required for the vanilla JS architecture), and specific CDNs
   - `frame-ancestors 'self'` -- Prevents clickjacking
   - `base-uri 'self'` and `form-action 'self'` -- Prevents base tag and form action hijacking

2. **Security headers:** Every response includes:
   - `X-Content-Type-Options: nosniff` -- Prevents MIME type sniffing
   - `X-Frame-Options: SAMEORIGIN` -- Legacy clickjacking prevention
   - `X-XSS-Protection: 1; mode=block` -- Legacy XSS filter
   - `Referrer-Policy: strict-origin-when-cross-origin` -- Limits referrer leakage
   - `Permissions-Policy: camera=(self), microphone=(), geolocation=()` -- Restricts browser APIs
   - `Strict-Transport-Security` (production only) -- Forces HTTPS with preloading

3. **Input sanitization:** The `sanitizeUserString()` function strips or escapes user input across all endpoints. Document payloads, file names, MIME types, storage paths, and search queries are all sanitized before use.

4. **HTML escaping:** The admin frontend uses an `esc()` function to escape all dynamic content before inserting it into the DOM, preventing injection through task titles, GP names, or note text.

### API Budget Controls

- **Global daily limit:** `ANTHROPIC_DAILY_LIMIT_USD` (default $100/day) with in-memory tracking
- **Per-user limit:** Max 10 AI verification calls per user per day
- **Graceful degradation:** When budgets are hit, AI features return null/empty results instead of errors
- **Spend tracking:** Every AI call records input tokens, output tokens, cache tokens, and estimated cost

### Data Access Control

- **Row Level Security (RLS):** Supabase tables have RLS policies ensuring that only the service role (server-side) can access data. GP users cannot directly query the database.
- **Admin route protection:** All `/api/admin/*` endpoints require a valid admin session cookie
- **Cron route protection:** Cron endpoints require a `CRON_SECRET` bearer token

---

## 14. Environment Variables Reference

These are the environment variables configured on Vercel that the system depends on:

### Core

| Variable | Purpose | Default |
|---|---|---|
| `AUTH_SECRET` | Signs session cookies (HMAC key). Must be a long random string. | Required |
| `NODE_ENV` | `production` on Vercel, determines security strictness | `development` |

### Database

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (e.g., `https://xxxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (full database access -- never expose to client) |

### AI (Anthropic)

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for all AI features | Required for AI |
| `ANTHROPIC_DAILY_LIMIT_USD` | Maximum daily AI spend in USD | `100` |
| `RECONCILE_AI_MODEL` | Model for reconciliation cron | `claude-opus-4-6` |

### Google (Gmail + Drive)

| Variable | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email for API auth |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Service account private key (PEM format) |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Root folder for GP document storage |
| `GOOGLE_PUBSUB_TOPIC` | Pub/Sub topic for Gmail push notifications |
| `GMAIL_WEBHOOK_SECRET` | Verifies Gmail push webhook authenticity |
| `VA_GMAIL_ADDRESS` | The VA inbox email address for Gmail search |

### Cron

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Bearer token for authenticating cron job requests |

### Zoho Sign

| Variable | Purpose |
|---|---|
| `ZOHO_SIGN_CLIENT_ID` | OAuth client ID |
| `ZOHO_SIGN_CLIENT_SECRET` | OAuth client secret |
| `ZOHO_SIGN_ACCOUNTS_SERVER` | Zoho accounts server URL |
| `ZOHO_SIGN_API_BASE` | Zoho Sign API base URL |
| `ZOHO_SIGN_REDIRECT_URI` | OAuth redirect URI |
| `ZOHO_SIGN_SPPA_TEMPLATE_ID` | Template ID for SPPA documents |

### Scheduled Tasks (Vercel Cron)

| Schedule (UTC) | AEST equivalent | Endpoint | Purpose |
|---|---|---|---|
| `0 0 * * *` | 10:00 AM AEST | `/api/cron/renew-gmail-watch` | Renews Gmail push notification subscription |
| `0 0 * * *` | 10:00 AM AEST | `/api/cron/refresh-zoho-sign-token` | Refreshes Zoho Sign OAuth token |
| `0 6 * * *` | 4:00 PM AEST | `/api/integrations/zoho-recruit/cron-sync` | Syncs job listings from Zoho Recruit |
| `0 20 * * *` | 6:00 AM AEST | `/api/cron/reconcile-followups` | Daily AI reconciliation of follow-up tasks |

---

## 15. Monitoring and Troubleshooting

### What to watch

**Reconciliation results.** The `/api/cron/reconcile-followups` endpoint returns a JSON summary every morning. Key things to look for:
- `processed: 0` consistently -- means no follow-ups are being created (check if Part A is working)
- Many `skipped` results with reason `budget_exceeded` -- the AI budget limit is being hit; consider increasing `ANTHROPIC_DAILY_LIMIT_USD`
- All tasks being `escalated_to_urgent` -- the AI may not be finding evidence; check if Gmail search and DoubleTick storage are working

**Vercel function logs.** All errors are logged to the Vercel console with tagged prefixes:
- `[Cron]` -- Cron job issues
- `[AI]` -- Anthropic API call failures
- `[Gmail]` -- Gmail API issues
- `[DT]` -- DoubleTick (WhatsApp) issues
- `[VA]` -- VA dashboard data loading issues

**Budget tracking.** The in-memory spend tracker logs to console. However, because Vercel functions are serverless, the counter resets on cold starts. This means the actual daily spend could slightly exceed the configured limit if many cold starts occur. For precise cost tracking, check the Anthropic dashboard at `console.anthropic.com`.

### Common issues and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Note follow-up suggestions stopped appearing | `ANTHROPIC_API_KEY` missing or budget exceeded | Check Vercel env vars; check Anthropic dashboard for key status |
| Reconciliation cron returns "Not configured" | Supabase or Anthropic API not configured | Verify `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY` are set |
| Gmail search returns empty for known emails | Service account delegation issue | Verify `VA_GMAIL_ADDRESS` matches a real inbox with domain-wide delegation enabled |
| WhatsApp messages not appearing in reconciliation | DoubleTick webhook not storing messages | Check Vercel logs for `[DT] Message storage failed` errors |
| Tasks missing from stage groups | `related_stage` is null | Run the Phase 2 backfill migration again; check that new task creation sets `related_stage` |
| Budget exceeded too early in the day | High-volume AI calls (many scans or WhatsApp messages) | Increase `ANTHROPIC_DAILY_LIMIT_USD` or review which features are making the most calls |
| VA cannot see any GPs | Admin session expired or role not configured | VA needs to re-login; check that their email is in the admin configuration |
| Guided action shows "Complete" for a document task | Task is missing its `related_document_key` or attachment | Check task creation logic; manually edit the task to add the document key |

### SLA defaults

The system has built-in SLA timers that create overdue alerts:

| SLA Type | Default Days |
|---|---|
| GP inactivity (no action from GP) | 5 days |
| Practice response (waiting on practice) | 5 days |
| Sponsor response | 5 days |
| Task overdue (general) | 7 days |
| Questionnaire completion | 7 days |

These can be adjusted by changing the `SLA_DEFAULT_DAYS` configuration in `server.js`.

---

## Summary

The VA Command Centre is a single-server application that manages the end-to-end GP registration journey. Phase 1 rebuilt the interface around priority lanes, journey rails, stage-grouped tasks, and guided one-click actions. Phase 2 added AI-powered note follow-up detection and daily cross-channel reconciliation.

The system is designed around three principles:

1. **Surface urgency, not data.** The Needs Action algorithm, guided actions, and priority badges mean VAs spend time acting, not searching.

2. **Automate judgment where safe.** The reconciliation engine auto-resolves follow-ups only when confidence exceeds 90%, and always logs full evidence trails. When in doubt, it escalates.

3. **Degrade gracefully.** Every AI feature has a budget check and a fallback path. If Claude is down, if the budget is hit, or if any integration fails, the VA's core workflow continues without interruption.

The total AI cost is projected at $123-$355/month depending on scale, with a configurable daily safety cap. All actions are audited in the `task_timeline` table, creating a permanent record of who did what and when -- whether human or machine.
