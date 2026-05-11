# CEO Command Centre — Design Spec

**Date:** 2026-05-11
**Author:** Claude (brainstorming session with Khaleed)
**Status:** Approved for implementation

---

## 1. Purpose

A standalone CEO dashboard at `/pages/ceo-dashboard.html` providing real-time pipeline health, VA task accountability, and an escalation workflow — with full drill-down and admin-level action capability. Accessible only to `khaleedmahmoud1211@gmail.com`.

This is NOT a read-only reporting page. The CEO can create tasks, reassign VAs, change case stages, send nudges, resolve escalations, and manage blockers — all without leaving the dashboard.

---

## 2. Access Control

- **Page:** `/pages/ceo-dashboard.html`
- **Auth gate:** On load, calls `GET /api/admin/auth/session`. Must return `ok: true` with `role: 'super_admin'`.
- **Hardcoded CEO check:** All `/api/ceo/*` endpoints verify `admin.email === 'khaleedmahmoud1211@gmail.com'` after `requireAdminSession()`. Returns 403 otherwise.
- **Redirect:** If session invalid or not CEO, redirect to `/pages/admin-signin.html`.

---

## 3. Database Changes (New Migration)

### 3.1 Escalation columns on `registration_tasks`

```sql
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS escalated_reason TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
```

### 3.2 Add `escalated` to task status constraint

Update the CHECK constraint on `registration_tasks.status` (currently in `20260404000000_va_ops_unified.sql` lines 45-49) to include `'escalated'`:

```sql
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked',
    'escalated'
  ));
```

### 3.3 Add `completed_at` to `registration_cases`

```sql
ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
```

Set this when `stage` transitions to `'complete'` in `processRegistrationTaskAutomation()` (server.js ~line 5654).

### 3.4 Add `first_reply_at` to `support_tickets`

```sql
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS first_reply_at TIMESTAMPTZ;
```

Set this in the admin ticket reply handler when `first_reply_at IS NULL`.

### 3.5 Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_reg_tasks_escalated
  ON registration_tasks (escalated_to, escalated_at DESC)
  WHERE escalated_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_completed
  ON registration_cases (completed_at DESC)
  WHERE completed_at IS NOT NULL;
```

---

## 4. Server-Side Changes (server.js)

### 4.1 Enhance `_logCaseEvent()` for stage transitions

At line ~5656 where stage changes are logged, pass metadata with `from_stage` and `to_stage`:

```javascript
// Before (current):
_logCaseEvent(caseId, null, 'stage_change', 'Stage advanced to ' + newStageLabel, null, email);

// After:
_logCaseEvent(caseId, null, 'stage_change', 'Stage advanced to ' + newStageLabel, null, email, { from_stage: regCase.stage, to_stage: newStage });
```

This requires `_logCaseEvent()` (lines 4974-4979) to accept an optional 7th parameter `metadata` and write it to the `metadata` JSONB column on `task_timeline`.

### 4.2 Set `completed_at` on case completion

In `processRegistrationTaskAutomation()`, when `_deriveStageFromState()` returns `'complete'` and the case stage changes to `'complete'`, also set `completed_at: new Date().toISOString()` in the case PATCH.

### 4.3 Set `first_reply_at` on ticket reply

In the admin ticket reply/update handler (around line 23231), when writing `thread_json` or resolving a ticket, check if `first_reply_at` is null. If so, set it to `new Date().toISOString()`.

### 4.4 VA-side: "Escalate to CEO" in existing task update

Extend `PUT /api/admin/task` (line 22557) to handle escalation fields. When the request body includes `escalated_to`:

- Set `status: 'escalated'`, `escalated_to`, `escalated_reason`, `escalated_at` on the task
- Create timeline entry with `event_type: 'escalation'`, title: `'Escalated to CEO'`, detail: the reason text, actor: the VA's admin email (from `requireAdminSession().email`)

No new endpoint needed — the existing task update endpoint handles it. The `escalated_by` field in the CEO dashboard response is resolved by looking up the timeline event's `actor` field for the escalation event, or by resolving `escalated_to` (not the escalator — the escalator is the admin who called the endpoint, captured as `actor` in the timeline entry).

### 4.5 New CEO API Endpoints

All endpoints below require `requireAdminSession()` + CEO email check.

#### `GET /api/ceo/dashboard`

Single aggregation endpoint. Makes parallel Supabase queries and returns all sections:

**Queries (all via `supabaseDbRequest`):**
1. `registration_cases` — `select=*` (all cases)
2. `registration_tasks` — `select=*&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated)` (all non-closed tasks)
3. `support_tickets` — `select=*&status=neq.closed` (open tickets)
4. `gp_applications` — `select=*` (all applications)
5. `career_interviews` — `select=*&status=neq.cancelled` (active interviews)
6. `career_roles` — `select=id,practice_name,is_active` (for role counts)
7. `user_profiles` — `select=user_id,email,first_name,last_name,phone` (for name resolution)
8. `registration_tasks` where `escalated_to IS NOT NULL AND status=eq.escalated` (escalated tasks)

**Response shape:**

```json
{
  "ok": true,
  "refreshed_at": "ISO timestamp",
  "kpi": {
    "total_gps": 24,
    "placed": 6,
    "open_tasks": 12,
    "overdue_tasks": 4,
    "blocked_cases": 3,
    "completed_gps": 2
  },
  "escalations": [
    {
      "task_id": "uuid",
      "case_id": "uuid",
      "gp_name": "Dr. Anika Patel",
      "gp_email": "...",
      "title": "Task title",
      "reason": "GP unresponsive after 3 attempts",
      "escalated_by": "sarah@mygplink.com.au",
      "escalated_at": "ISO",
      "stage": "amc",
      "priority": "urgent"
    }
  ],
  "pipeline": {
    "myintealth": { "count": 18, "blocked": 1 },
    "amc": { "count": 14, "blocked": 2 },
    "career": { "count": 10, "blocked": 0 },
    "ahpra": { "count": 6, "blocked": 1 },
    "pbs": { "count": 3, "blocked": 0 },
    "commencement": { "count": 1, "blocked": 0 },
    "complete": { "count": 2 }
  },
  "blockers": [
    {
      "case_id": "uuid",
      "gp_name": "Dr. Patel",
      "stage": "amc",
      "days_in_stage": 23,
      "blocker_status": "waiting_on_gp",
      "blocker_reason": "Qualification docs not uploaded",
      "assigned_va": "Sarah M."
    }
  ],
  "task_health": {
    "open": 12,
    "in_progress": 5,
    "completed_this_week": 18,
    "completed_total": 38,
    "overdue": 4,
    "avg_resolve_days": 2.3
  },
  "va_workload": [
    {
      "va_email": "sarah@mygplink.com.au",
      "va_name": "Sarah M.",
      "case_count": 8,
      "open_tasks": 12,
      "overdue_tasks": 2,
      "completed_this_week": 7
    }
  ],
  "velocity": {
    "myintealth_to_amc": { "avg_days": 8 },
    "amc_to_career": { "avg_days": 14 },
    "career_to_ahpra": { "avg_days": 21 },
    "ahpra_to_pbs": { "avg_days": 10 },
    "pbs_to_commencement": { "avg_days": 5 }
  },
  "placements": {
    "applied": 15,
    "submitted_to_practice": 8,
    "interviewing": 4,
    "offers_made": 3,
    "secured": 6,
    "active_roles": 12
  },
  "gp_activity": {
    "active_7d": 18,
    "inactive_7_14d": 4,
    "cold_14d_plus": 2,
    "cold_gps": [
      { "gp_name": "Dr. X", "last_activity": "ISO", "stage": "amc", "days_inactive": 16 }
    ]
  },
  "tickets": {
    "open": 5,
    "resolved_this_week": 8,
    "resolved_total": 23,
    "avg_resolution_hours": 28.5,
    "avg_first_reply_hours": 4.2
  },
  "completions": {
    "this_month": 2,
    "total": 6,
    "recent_milestones": [
      { "gp_name": "Dr. Ahmed", "milestone": "PBS approved", "date": "ISO", "days_ago": 2 }
    ]
  }
}
```

**Computation details:**

- **Pipeline funnel:** Group `registration_cases` by `stage`, count per stage. Blocked = cases where `blocker_status` is not null.
- **Blockers:** Cases where `status = 'blocked'` OR `blocker_status IS NOT NULL`, enriched with GP name from `user_profiles`, days computed as `NOW() - last_gp_activity_at` (or case `updated_at` if no activity).
- **Task health:** Count tasks by status. Overdue = `due_date < NOW()` and status not completed/cancelled. Avg resolve = `AVG(completed_at - created_at)` for tasks completed this month.
- **VA workload:** Group `registration_cases` by `assigned_va`, count cases + open tasks per VA. Resolve VA user_id to name via `user_profiles`.
- **Velocity:** Query `task_timeline` for `event_type = 'stage_change'` events. For existing data without metadata, use window functions: `LAG(created_at) OVER (PARTITION BY case_id ORDER BY created_at)` on stage_change events to compute time between consecutive transitions. For new data with `from_stage`/`to_stage` metadata, filter directly.
- **Placements:** Count `gp_applications` by status. `applied` = all non-withdrawn/rejected. `interviewing` = has active `career_interviews`. `secured` = status IN `SECURED_CAREER_APPLICATION_STATUS_KEYS` (hired, secured, placement_secured, offer_accepted, contract_signed). `submitted_to_practice` = `practice_submission_status != 'pending_va_submission'`.
- **GP activity:** Bucket `registration_cases` by `last_gp_activity_at`: active (< 7 days), inactive (7-14), cold (> 14). Cases with null `last_gp_activity_at` use `created_at` as fallback.
- **Tickets:** Count `support_tickets` by status. Avg resolution = `AVG(resolved_at - created_at)` WHERE resolved. Avg first reply = `AVG(first_reply_at - created_at)` WHERE first_reply_at IS NOT NULL.
- **Completions:** Cases where `stage = 'complete'`. This month = `completed_at` in current calendar month. Recent milestones: last 5 `stage_change` timeline events for any stage, ordered by `created_at DESC`.

#### `GET /api/ceo/drilldown/:section`

Returns detailed GP/task lists for a specific dashboard section. Accepts query parameters for filtering.

**Sections and their params:**

| Section | Params | Returns |
|---------|--------|---------|
| `pipeline` | `?stage=amc` | GPs at that stage with: name, email, substage, assigned VA, days in stage, status, blocker info, open task count |
| `blockers` | (none) | All blocked/stalled cases with: GP name, stage, blocker_status, blocker_reason, days stuck, last VA action, assigned VA |
| `tasks` | `?status=overdue` or `?status=open` | Tasks matching filter with: GP name, title, priority, due date, stage, assigned VA, created_at |
| `va` | `?va_email=sarah@...` | Cases and tasks for a specific VA with: GP names, stages, task counts, overdue count |
| `placements` | `?status=interviewing` | Applications at that status with: GP name, role title, practice, submitted date, interview date if exists |
| `activity` | `?bucket=cold` | GPs in that activity bucket with: name, stage, last activity date, days inactive, assigned VA |
| `tickets` | (none) | Open tickets with: GP name, title, category, priority, created date, days open |
| `completions` | (none) | Completed GPs with: name, completed_at, total journey days, practice placed at |

Each response includes the same action-relevant fields needed for the drill-down panel (case_id, user_id, assigned_va) so the frontend can call existing admin endpoints for actions.

#### `GET /api/ceo/trends`

Weekly aggregated data for trend lines. Returns last 12 weeks of data.

```json
{
  "ok": true,
  "weeks": [
    {
      "week_start": "2026-03-02",
      "new_gps": 3,
      "tasks_completed": 12,
      "tasks_created": 15,
      "stage_transitions": 8,
      "tickets_opened": 2,
      "tickets_resolved": 3,
      "applications_submitted": 4,
      "placements_secured": 1,
      "avg_velocity_days": 12.5
    }
  ]
}
```

Computed by querying:
- `registration_cases.created_at` grouped by week for new GPs
- `registration_tasks.completed_at` grouped by week for task completion
- `registration_tasks.created_at` grouped by week for task creation
- `task_timeline` where `event_type = 'stage_change'` grouped by week
- `support_tickets.created_at` and `resolved_at` grouped by week
- `gp_applications.applied_at` grouped by week
- `gp_applications` with secured status + `updated_at` grouped by week

#### `POST /api/ceo/escalation/:taskId/resolve`

Resolves an escalation. Body: `{ note: "string (optional)" }`.

Actions:
1. PATCH `registration_tasks` SET `status = 'open'`, `escalated_to = null`, `escalated_reason = null`, `escalated_at = null`
2. Insert `task_timeline` entry: `event_type = 'escalation'`, title = `'CEO resolved escalation'`, detail = note, actor = CEO email
3. PATCH `registration_cases.last_va_action_at` for audit trail

#### `POST /api/ceo/escalation/:taskId/respond`

Returns task to VA with a note. Body: `{ note: "string (required)" }`.

Actions:
1. PATCH `registration_tasks` SET `status = 'open'`, `escalated_to = null`, `escalated_at = null` (keep `escalated_reason` for history)
2. Insert `task_timeline` entry: `event_type = 'note'`, title = `'CEO response'`, detail = note, actor = CEO email
3. PATCH `registration_cases.last_va_action_at`

---

## 5. VA-Side Changes (admin.html)

### 5.1 "Escalate to CEO" button

Add a new button to the task action dropdown (around line 2037-2057 in admin.html). Distinct from "Set Blocked":

```html
<button data-escalate-task="<taskId>" class="btn red">Escalate to CEO</button>
```

On click, show a small modal/prompt asking for a reason (free text, required). Then call:

```javascript
PUT /api/admin/task?id=<taskId>
Body: {
  status: 'escalated',
  escalated_to: '<CEO user_id>',
  escalated_reason: '<reason text>',
  escalated_at: new Date().toISOString()
}
```

### 5.2 Visual indicator for escalated tasks

Tasks with `status === 'escalated'` show a distinct red badge: "Escalated to CEO" instead of the normal status pill. The VA cannot change the status of an escalated task — only the CEO can resolve or return it.

---

## 6. Frontend — `pages/ceo-dashboard.html`

### 6.1 Visual Design

- **Dark theme** — dark background, light text, coloured accent cards. NOT the admin.html light theme.
- CSS variables:
  ```css
  --bg: #0f1117;
  --panel: #1a1d27;
  --panel-border: rgba(255,255,255,0.06);
  --text: #e2e8f0;
  --text-muted: rgba(255,255,255,0.5);
  --blue: #60a5fa;
  --red: #ef4444;
  --amber: #fbbf24;
  --green: #34d399;
  --purple: #a78bfa;
  ```
- Card-based layout with subtle borders and hover states
- Monospace numbers for metrics
- Status pills with coloured backgrounds matching priority/stage

### 6.2 Page Structure

Top to bottom:

1. **Header bar** — "GP Link Command Centre" left, escalation badge + last refresh + auto-refresh toggle right
2. **KPI strip** — 6 headline metric cards in a row: Total GPs, Placed, Open Tasks, Overdue (red highlight), Blocked, Completed
3. **Escalation banner** — only visible when escalated tasks exist. Red-tinted bar showing count + GP names. Click to expand escalation panel.
4. **Section grid** — 2-column grid of section cards:
   - Pipeline Funnel (horizontal bars per stage with counts)
   - Blockers & Red Flags (GP rows with days stuck, severity colour)
   - Task Health (open/completed/overdue/avg resolve 2x2 grid)
   - VA Workload (per-VA bars with case/task counts)
   - Pipeline Velocity (avg days per transition + week-over-week trend)
   - Placements & Career (applied/interviewing/offers/secured 2x2 grid)
   - GP Activity & Engagement (active/inactive/cold counts with cold GP list)
   - Support Tickets (open/resolved + avg response time)
   - Completions & Wins (full-width, this month count + recent milestones)

### 6.3 Drill-Down Interaction

Clicking any section card (or a specific item within it, like a pipeline stage bar) opens an **inline detail panel** below the card. The panel contains:

- **List of GPs/tasks** relevant to that section, each as a collapsible row
- Clicking a row expands it to show:
  - Detail fields (blocker reason, last activity, open tasks, practice, substage)
  - **Action buttons:** Create Task, Reassign VA, Change Stage, Send Nudge, Set Blocker, Add Note, View Full Case
- The detail panel has a close button to collapse back to the summary card

### 6.4 Escalation Panel

Clicking the escalation banner expands a panel showing all escalated tasks:

- Each escalation shows: GP name, task title, reason (VA's written context), escalated by (VA name), escalated at (relative time), stage, priority
- **Action buttons per escalation:**
  - **Resolve** — clears escalation, task goes back to `open`
  - **Add Note & Return to VA** — opens a text input, posts note, clears escalation
  - **Reassign** — dropdown of VAs, reassigns the case
  - **Put Case On Hold** — sets case status to `on_hold`
  - **Send Nudge to GP** — opens nudge modal (stage/message)

### 6.5 Action Modals

Small inline modals (not full-page overlays) for:

- **Create Task** — title (required), priority dropdown, due date, description. Calls `POST /api/admin/tasks` with the GP's `case_id`.
- **Reassign VA** — dropdown of admin users (fetched from admin endpoint). Calls `PUT /api/admin/case` with `assigned_va`.
- **Change Stage** — dropdown of stages. Calls `PUT /api/admin/case` with `stage`.
- **Send Nudge** — message textarea, auto-populated stage/substage. Calls `POST /api/admin/va/nudge`.
- **Set Blocker** — blocker_status dropdown (waiting_on_gp, waiting_on_practice, waiting_on_external, internal_review) + reason text. Calls `PUT /api/admin/case`.
- **Add Note** — text area. Calls `POST /api/admin/case/note` or `POST /api/admin/task/note`.
- **Resolve Escalation** — optional note text. Calls `POST /api/ceo/escalation/:taskId/resolve`.
- **Respond to Escalation** — required note text. Calls `POST /api/ceo/escalation/:taskId/respond`.

### 6.6 Data Loading & Refresh

- On page load: call `GET /api/ceo/dashboard` to populate all sections
- **Auto-refresh:** poll `GET /api/ceo/dashboard` every 30 seconds
- **Trend data:** call `GET /api/ceo/trends` once on load, refresh every 5 minutes (trends don't change fast)
- **Drill-down:** call `GET /api/ceo/drilldown/:section` on demand when a section is expanded
- Show "Last refresh: Xs ago" in header, update every second
- On visibility change (`document.visibilityState === 'visible'`), trigger immediate refresh

### 6.7 Toast Notifications

Use the same toast pattern as admin.html for action confirmations: "Task created", "Escalation resolved", "Nudge sent", etc. Rendered as a brief notification in the bottom-right corner.

---

## 7. Data Flow Diagram

```
GP updates state (localStorage → PUT /api/state)
  ↓
processRegistrationTaskAutomation() fires
  ↓
Creates/completes tasks, updates case stage, logs timeline events
  ↓
CEO dashboard polls GET /api/ceo/dashboard (every 30s)
  ↓
Aggregates: cases + tasks + tickets + applications + interviews + profiles
  ↓
Returns all 9 sections + escalations in one response
  ↓
Frontend renders KPI strip, section cards, escalation banner
  ↓
CEO clicks section → GET /api/ceo/drilldown/:section → inline detail panel
  ↓
CEO takes action → calls existing /api/admin/* endpoints → side effects fire
  ↓
Next poll picks up changes

VA escalates task (PUT /api/admin/task with escalated_to)
  ↓
Task status = 'escalated', timeline event logged
  ↓
Next CEO dashboard poll shows escalation in banner
  ↓
CEO resolves/responds → POST /api/ceo/escalation/:taskId/resolve or /respond
  ↓
Task returns to 'open', VA sees it in their queue
```

---

## 8. Files Changed / Created

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/2026MMDD_ceo_dashboard.sql` | CREATE | New migration: escalation columns, completed_at, first_reply_at, indexes |
| `server.js` | EDIT | Add `/api/ceo/*` endpoints, enhance `_logCaseEvent()` metadata, set `completed_at` on case completion, set `first_reply_at` on ticket reply, handle escalation fields in task update |
| `pages/ceo-dashboard.html` | CREATE | Full CEO dashboard page with dark theme, all sections, drill-down, actions |
| `pages/admin.html` | EDIT | Add "Escalate to CEO" button + modal, escalated status badge, prevent status change on escalated tasks |
| `vercel.json` | VERIFY | Confirm all routes go through server.js (already the case — no change needed) |

---

## 9. What This Spec Does NOT Include

- **No new tables** — uses existing tables with added columns
- **No external dependencies** — no charting libraries, no new npm packages. All metrics rendered with HTML/CSS (bars, grids, numbers).
- **No cron jobs** — all data is computed on demand per request
- **No caching layer** — the dashboard endpoint runs fresh queries each poll. If performance becomes an issue later, add server-side caching with TTL (like the existing `getCachedAdminDashboardData()` pattern).
- **No mobile layout** — CEO dashboard is desktop-only for v1
- **No email/push notifications for escalations** — CEO sees them on next dashboard poll. Can add push later if needed.

---

## 10. Success Criteria

1. CEO can load `/pages/ceo-dashboard.html` and see all 9 metric sections populated with real data
2. Non-CEO admin accounts get a 403 and redirect
3. VAs can escalate tasks from admin.html with a reason
4. Escalated tasks appear in the CEO dashboard banner within 30 seconds
5. CEO can resolve/respond to escalations and the task returns to the VA queue
6. CEO can drill into any section and take actions (create task, reassign, nudge, etc.) that fire the same side effects as admin.html actions
7. Pipeline funnel, task health, and placement stats match the numbers shown in admin.html (same underlying data, different presentation)
8. Weekly trends show last 12 weeks of pipeline movement and task throughput
