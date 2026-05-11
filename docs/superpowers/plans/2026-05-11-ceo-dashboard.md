# CEO Command Centre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully functional CEO dashboard with real-time pipeline metrics, VA accountability, escalation workflow, and inline drill-down with admin-level actions.

**Architecture:** Standalone dark-themed page at `/pages/ceo-dashboard.html` backed by dedicated `/api/ceo/*` aggregation endpoints in `server.js`. Escalation feature adds columns to `registration_tasks` + an "Escalate to CEO" button in `admin.html`. All CEO actions reuse existing `/api/admin/*` endpoints for side-effect consistency.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework), Node.js server.js, Supabase PostgREST, existing admin auth system.

**Spec:** `docs/superpowers/specs/2026-05-11-ceo-dashboard-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260511000000_ceo_dashboard.sql` | CREATE | Schema: escalation columns, completed_at, first_reply_at, indexes, wider status constraint |
| `server.js` | EDIT | Enhance `_logCaseEvent` metadata, set `completed_at` on completion, set `first_reply_at` on ticket reply, handle escalation in task update, add all `/api/ceo/*` endpoints |
| `pages/admin.html` | EDIT | Add "Escalate to CEO" button+modal, escalated status badge, lock escalated tasks |
| `pages/ceo-dashboard.html` | CREATE | Full CEO dashboard: dark theme, 9 metric sections, escalation panel, drill-down, action modals, auto-refresh |

---

### Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/20260511000000_ceo_dashboard.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- CEO Dashboard: escalation columns, completed_at, first_reply_at, wider status constraint

-- 1. Widen task status constraint to include 'escalated'
ALTER TABLE registration_tasks DROP CONSTRAINT IF EXISTS registration_tasks_status_check;
ALTER TABLE registration_tasks ADD CONSTRAINT registration_tasks_status_check
  CHECK (status IN (
    'open','in_progress','waiting','completed','cancelled',
    'waiting_on_gp','waiting_on_practice','waiting_on_external','blocked',
    'escalated'
  ));

-- 2. Add escalation columns to registration_tasks
ALTER TABLE registration_tasks
  ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS escalated_reason TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

-- 3. Add completed_at to registration_cases
ALTER TABLE registration_cases
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 4. Add first_reply_at to support_tickets
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS first_reply_at TIMESTAMPTZ;

-- 5. Indexes for CEO dashboard queries
CREATE INDEX IF NOT EXISTS idx_reg_tasks_escalated
  ON registration_tasks (escalated_to, escalated_at DESC)
  WHERE escalated_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_completed
  ON registration_cases (completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reg_cases_stage
  ON registration_cases (stage);
```

- [ ] **Step 2: Verify migration is syntactically valid**

Run: `cd supabase && grep -c 'ALTER TABLE' migrations/20260511000000_ceo_dashboard.sql`
Expected: `6` (6 ALTER TABLE statements)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260511000000_ceo_dashboard.sql
git commit -m "feat: add CEO dashboard migration — escalation columns, completed_at, first_reply_at"
git push
```

---

### Task 2: Server — Enhance Existing Code

Small targeted edits to existing functions in `server.js`. Each change is a few lines.

**Files:**
- Modify: `server.js`

#### 2A: Enhance `_logCaseEvent` to accept metadata

The current function at lines 4985-4990:
```javascript
async function _logCaseEvent(caseId, taskId, eventType, title, detail, actor) {
  if (!isSupabaseDbConfigured()) return;
  await supabaseDbRequest('task_timeline', '', {
    method: 'POST', body: [{ case_id: caseId, task_id: taskId || null, event_type: eventType, title: title, detail: detail || null, actor: actor || 'system' }]
  });
}
```

- [ ] **Step 1: Add optional 7th parameter `metadata` to `_logCaseEvent`**

Replace the function (lines 4985-4990) with:

```javascript
async function _logCaseEvent(caseId, taskId, eventType, title, detail, actor, metadata) {
  if (!isSupabaseDbConfigured()) return;
  const entry = { case_id: caseId, task_id: taskId || null, event_type: eventType, title: title, detail: detail || null, actor: actor || 'system' };
  if (metadata) entry.metadata = metadata;
  await supabaseDbRequest('task_timeline', '', {
    method: 'POST', body: [entry]
  });
}
```

- [ ] **Step 2: Pass from_stage/to_stage metadata on stage changes**

Find the stage change block in `processRegistrationTaskAutomation` (~lines 5675-5682). The current code:
```javascript
    if (newStage !== regCase.stage) {
      await _logCaseEvent(caseId, null, 'stage_change', 'Stage advanced to ' + newStage, null, 'system');
    }
```

Replace that `_logCaseEvent` call with:
```javascript
    if (newStage !== regCase.stage) {
      await _logCaseEvent(caseId, null, 'stage_change', 'Stage advanced to ' + newStage, null, 'system', { from_stage: regCase.stage, to_stage: newStage });
    }
```

#### 2B: Set `completed_at` when case reaches 'complete'

- [ ] **Step 3: Add completed_at to the case PATCH when stage becomes 'complete'**

In the same stage change block (~line 5678), find:
```javascript
    if (newStage !== regCase.stage) { caseUpdate.stage = newStage; }
```

Replace with:
```javascript
    if (newStage !== regCase.stage) {
      caseUpdate.stage = newStage;
      if (newStage === 'complete') { caseUpdate.completed_at = new Date().toISOString(); }
    }
```

#### 2C: Set `first_reply_at` on first ticket reply

- [ ] **Step 4: Add first_reply_at logic to the admin ticket resolve handler**

Find the admin ticket status update handler (~line 23283). The current PATCH code:
```javascript
    const patch = { status: nextStatus, updated_at: new Date().toISOString() };
    if (nextStatus === 'closed') { patch.resolved_at = new Date().toISOString(); patch.resolved_by = adminCtx.email; }
```

After that PATCH is applied (~line 23287), add a second PATCH to set first_reply_at if not already set:
```javascript
    // Set first_reply_at if this is the first admin interaction and it hasn't been set
    if (updated && !updated.first_reply_at) {
      await supabaseDbRequest('support_tickets', 'id=eq.' + encodeURIComponent(ticketId) + '&first_reply_at=is.null', {
        method: 'PATCH', body: { first_reply_at: new Date().toISOString() }
      });
    }
```

Also find the legacy admin ticket reply handler (~line 20527, the `POST /api/admin/tickets/:id/reply` endpoint). After the `persistSupportCaseUpdate` call succeeds, add:
```javascript
    // Set first_reply_at on the Supabase support_tickets record if not set
    if (isSupabaseDbConfigured()) {
      await supabaseDbRequest('support_tickets', 'source_ticket_id=eq.' + encodeURIComponent(ticketId) + '&first_reply_at=is.null', {
        method: 'PATCH', body: { first_reply_at: new Date().toISOString() }
      }).catch(() => {});
    }
```

#### 2D: Handle escalation fields in PUT /api/admin/task

- [ ] **Step 5: Extend the allowed fields and escalation logic in the task update endpoint**

Find `PUT /api/admin/task` (~line 22582). The current allowed fields:
```javascript
    const allowed = ['status', 'priority', 'assignee', 'due_date', 'blocker_reason', 'description'];
```

Replace with:
```javascript
    const allowed = ['status', 'priority', 'assignee', 'due_date', 'blocker_reason', 'description', 'escalated_to', 'escalated_reason', 'escalated_at'];
```

Then, after the `patch` object is built and before the PATCH request, add escalation auto-fields:
```javascript
    // Auto-set escalation fields when status is 'escalated'
    if (patch.status === 'escalated' && patch.escalated_to) {
      if (!patch.escalated_at) patch.escalated_at = new Date().toISOString();
    }
    // Clear escalation fields when status changes away from 'escalated'
    if (patch.status && patch.status !== 'escalated' && !patch.escalated_to) {
      patch.escalated_to = null;
      patch.escalated_at = null;
    }
```

Also update the timeline event type selection. The current code:
```javascript
    const evType = patch.status === 'completed' ? 'completed' : patch.status === 'cancelled' ? 'cancelled' : patch.priority ? 'priority_change' : 'status_change';
```

Replace with:
```javascript
    const evType = patch.status === 'completed' ? 'completed' : patch.status === 'cancelled' ? 'cancelled' : patch.status === 'escalated' ? 'escalation' : patch.priority ? 'priority_change' : 'status_change';
```

- [ ] **Step 6: Verify the server starts without errors**

Run: `cd "/Users/khaleed/GP LINK APP (Visual Studio)" && node -c server.js`
Expected: No output (syntax OK)

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: enhance _logCaseEvent metadata, completed_at, first_reply_at, escalation handling"
git push
```

---

### Task 3: Server — CEO API Endpoints

The main backend work. All new endpoints in `server.js`, gated by CEO email check.

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add CEO email constant and auth helper near the top of the admin section**

Find the SUPER_ADMIN_EMAILS declaration (~line 224). After it, add:

```javascript
const CEO_EMAIL = 'khaleedmahmoud1211@gmail.com';
```

Then add the CEO session helper near `requireAdminSession` (~after line 3823):

```javascript
function requireCeoSession(req, res) {
  const adminCtx = requireAdminSession(req, res);
  if (!adminCtx) return null;
  if (adminCtx.email.toLowerCase() !== CEO_EMAIL) {
    sendJson(res, 403, { ok: false, message: 'CEO access required.' });
    return null;
  }
  return adminCtx;
}
```

- [ ] **Step 2: Add the GET /api/ceo/dashboard endpoint**

Add this endpoint block in the admin/API section of server.js (after the existing `/api/admin/va/` endpoints, before the static file serving section). The endpoint aggregates all 9 dashboard sections + escalations in one response:

```javascript
  // ═══════════════════════════════════════════════════════════════════
  // CEO DASHBOARD ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════

  if (pathname === '/api/ceo/dashboard' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const ceoCtx = requireCeoSession(req, res);
    if (!ceoCtx) return;

    // Parallel queries
    const [casesRes, tasksRes, ticketsRes, appsRes, interviewsRes, rolesRes, profilesRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=*&order=updated_at.desc'),
      supabaseDbRequest('registration_tasks', 'select=*&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated)&order=created_at.desc&limit=1000'),
      supabaseDbRequest('support_tickets', 'select=*&order=created_at.desc&limit=500'),
      supabaseDbRequest('gp_applications', 'select=*'),
      supabaseDbRequest('career_interviews', 'select=*&status=neq.cancelled'),
      supabaseDbRequest('career_roles', 'select=id,practice_name,is_active'),
      supabaseDbRequest('user_profiles', 'select=user_id,email,first_name,last_name,phone')
    ]);

    const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
    const tasks = (tasksRes.ok && Array.isArray(tasksRes.data)) ? tasksRes.data : [];
    const tickets = (ticketsRes.ok && Array.isArray(ticketsRes.data)) ? ticketsRes.data : [];
    const apps = (appsRes.ok && Array.isArray(appsRes.data)) ? appsRes.data : [];
    const interviews = (interviewsRes.ok && Array.isArray(interviewsRes.data)) ? interviewsRes.data : [];
    const roles = (rolesRes.ok && Array.isArray(rolesRes.data)) ? rolesRes.data : [];
    const profiles = (profilesRes.ok && Array.isArray(profilesRes.data)) ? profilesRes.data : [];

    // Build profile lookup
    const profileByUserId = {};
    for (const p of profiles) { if (p.user_id) profileByUserId[p.user_id] = p; }
    function gpName(userId) {
      const p = profileByUserId[userId];
      if (!p) return 'Unknown GP';
      return ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'Unknown GP';
    }
    function gpEmail(userId) { const p = profileByUserId[userId]; return p ? (p.email || '') : ''; }

    // Build task lookup by case_id
    const tasksByCaseId = {};
    for (const t of tasks) {
      if (!tasksByCaseId[t.case_id]) tasksByCaseId[t.case_id] = [];
      tasksByCaseId[t.case_id].push(t);
    }

    const now = Date.now();
    const DAY_MS = 86400000;
    const weekAgo = new Date(now - 7 * DAY_MS).toISOString();

    // ── KPI ──
    const SECURED_STATUSES = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
    const securedApps = apps.filter(a => SECURED_STATUSES.has((a.status || '').toLowerCase()));
    const openTickets = tickets.filter(t => t.status !== 'closed');
    const overdueTasks = tasks.filter(t => t.due_date && new Date(t.due_date).getTime() < now && !['completed', 'cancelled'].includes(t.status));
    const blockedCases = cases.filter(c => c.status === 'blocked' || c.blocker_status);
    const completedCases = cases.filter(c => c.stage === 'complete');

    const kpi = {
      total_gps: cases.length,
      placed: securedApps.length,
      open_tasks: tasks.length,
      overdue_tasks: overdueTasks.length,
      blocked_cases: blockedCases.length,
      completed_gps: completedCases.length
    };

    // ── Escalations ──
    const escalations = tasks.filter(t => t.status === 'escalated' && t.escalated_to).map(t => {
      const c = cases.find(rc => rc.id === t.case_id);
      return {
        task_id: t.id, case_id: t.case_id, user_id: c ? c.user_id : null,
        gp_name: c ? gpName(c.user_id) : 'Unknown', gp_email: c ? gpEmail(c.user_id) : '',
        title: t.title, reason: t.escalated_reason || '', escalated_by: t.escalated_at ? 'VA' : '',
        escalated_at: t.escalated_at, stage: t.related_stage || (c ? c.stage : ''), priority: t.priority
      };
    });

    // ── Pipeline ──
    const STAGES = ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement', 'complete'];
    const pipeline = {};
    for (const s of STAGES) pipeline[s] = { count: 0, blocked: 0 };
    for (const c of cases) {
      const s = c.stage || 'myintealth';
      if (pipeline[s]) {
        pipeline[s].count++;
        if (c.status === 'blocked' || c.blocker_status) pipeline[s].blocked++;
      }
    }

    // ── Blockers ──
    const blockers = blockedCases.map(c => ({
      case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
      stage: c.stage, days_in_stage: c.last_gp_activity_at ? Math.floor((now - new Date(c.last_gp_activity_at).getTime()) / DAY_MS) : Math.floor((now - new Date(c.updated_at || c.created_at).getTime()) / DAY_MS),
      blocker_status: c.blocker_status || c.status, blocker_reason: c.blocker_reason || '',
      assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va
    })).sort((a, b) => b.days_in_stage - a.days_in_stage);

    // ── Task Health ──
    const completedTasksAll = [];
    // Fetch completed tasks separately for stats
    const completedRes = await supabaseDbRequest('registration_tasks', 'select=id,created_at,completed_at&status=eq.completed&order=completed_at.desc&limit=500');
    const completedTasks = (completedRes.ok && Array.isArray(completedRes.data)) ? completedRes.data : [];
    const completedThisWeek = completedTasks.filter(t => t.completed_at && t.completed_at >= weekAgo).length;
    let avgResolveDays = 0;
    const resolveDurations = completedTasks.filter(t => t.completed_at && t.created_at).map(t => (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / DAY_MS);
    if (resolveDurations.length > 0) avgResolveDays = Math.round((resolveDurations.reduce((a, b) => a + b, 0) / resolveDurations.length) * 10) / 10;

    const taskHealth = {
      open: tasks.filter(t => t.status === 'open').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed_this_week: completedThisWeek,
      completed_total: completedTasks.length,
      overdue: overdueTasks.length,
      avg_resolve_days: avgResolveDays
    };

    // ── VA Workload ──
    const vaMap = {};
    for (const c of cases) {
      const vaId = c.assigned_va || '__unassigned__';
      if (!vaMap[vaId]) vaMap[vaId] = { va_id: vaId, va_email: '', va_name: vaId === '__unassigned__' ? 'Unassigned' : gpName(vaId), case_count: 0, open_tasks: 0, overdue_tasks: 0, completed_this_week: 0 };
      vaMap[vaId].case_count++;
      if (vaId !== '__unassigned__') vaMap[vaId].va_email = gpEmail(vaId);
    }
    for (const t of tasks) {
      const c = cases.find(rc => rc.id === t.case_id);
      const vaId = (c && c.assigned_va) || '__unassigned__';
      if (vaMap[vaId]) {
        vaMap[vaId].open_tasks++;
        if (t.due_date && new Date(t.due_date).getTime() < now) vaMap[vaId].overdue_tasks++;
      }
    }
    for (const t of completedTasks.filter(ct => ct.completed_at && ct.completed_at >= weekAgo)) {
      // Best effort — completed tasks don't have case lookup here, skip VA attribution for completed
    }
    const vaWorkload = Object.values(vaMap).sort((a, b) => b.case_count - a.case_count);

    // ── Velocity ──
    // Fetch stage_change events from task_timeline
    const timelineRes = await supabaseDbRequest('task_timeline', 'select=case_id,created_at,metadata&event_type=eq.stage_change&order=case_id.asc,created_at.asc&limit=2000');
    const stageEvents = (timelineRes.ok && Array.isArray(timelineRes.data)) ? timelineRes.data : [];
    const velocityTransitions = {};
    const STAGE_PAIRS = [
      ['myintealth', 'amc', 'myintealth_to_amc'],
      ['amc', 'career', 'amc_to_career'],
      ['career', 'ahpra', 'career_to_ahpra'],
      ['ahpra', 'pbs', 'ahpra_to_pbs'],
      ['pbs', 'commencement', 'pbs_to_commencement']
    ];
    for (const [, , key] of STAGE_PAIRS) velocityTransitions[key] = [];
    // Group events by case_id
    const eventsByCase = {};
    for (const ev of stageEvents) {
      if (!eventsByCase[ev.case_id]) eventsByCase[ev.case_id] = [];
      eventsByCase[ev.case_id].push(ev);
    }
    // Compute durations between consecutive stage changes
    for (const caseId in eventsByCase) {
      const evs = eventsByCase[caseId];
      for (let i = 1; i < evs.length; i++) {
        const prev = evs[i - 1];
        const curr = evs[i];
        const days = (new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime()) / DAY_MS;
        // Try to match to a known transition using metadata if available
        const meta = typeof curr.metadata === 'object' && curr.metadata ? curr.metadata : (typeof curr.metadata === 'string' ? (() => { try { return JSON.parse(curr.metadata); } catch { return null; } })() : null);
        if (meta && meta.from_stage && meta.to_stage) {
          for (const [from, to, key] of STAGE_PAIRS) {
            if (meta.from_stage === from && meta.to_stage === to) { velocityTransitions[key].push(days); break; }
          }
        } else {
          // Fallback: use sequential order (less accurate but works for existing data)
          const prevTitle = prev.title || '';
          const currTitle = curr.title || '';
          for (const [from, to, key] of STAGE_PAIRS) {
            if (prevTitle.includes(from) && currTitle.includes(to)) { velocityTransitions[key].push(days); break; }
          }
        }
      }
    }
    const velocity = {};
    for (const [, , key] of STAGE_PAIRS) {
      const arr = velocityTransitions[key];
      velocity[key] = { avg_days: arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null, sample_size: arr.length };
    }

    // ── Placements ──
    const securedSet = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
    const appInterviewIds = new Set(interviews.map(i => i.application_id));
    const placements = {
      applied: apps.filter(a => !['withdrawn', 'rejected'].includes((a.status || '').toLowerCase())).length,
      submitted_to_practice: apps.filter(a => a.practice_submission_status && a.practice_submission_status !== 'pending_va_submission').length,
      interviewing: apps.filter(a => appInterviewIds.has(a.id) && !securedSet.has((a.status || '').toLowerCase())).length,
      offers_made: apps.filter(a => ['offer', 'offer_pending', 'offered'].includes((a.status || '').toLowerCase())).length,
      secured: securedApps.length,
      active_roles: roles.filter(r => r.is_active).length
    };

    // ── GP Activity ──
    const activeCases = cases.filter(c => c.stage !== 'complete' && c.status !== 'withdrawn');
    const active7d = []; const inactive7_14d = []; const cold14d = [];
    for (const c of activeCases) {
      const lastAct = c.last_gp_activity_at ? new Date(c.last_gp_activity_at).getTime() : new Date(c.created_at).getTime();
      const daysSince = Math.floor((now - lastAct) / DAY_MS);
      if (daysSince <= 7) active7d.push(c);
      else if (daysSince <= 14) inactive7_14d.push(c);
      else cold14d.push(c);
    }
    const gpActivity = {
      active_7d: active7d.length,
      inactive_7_14d: inactive7_14d.length,
      cold_14d_plus: cold14d.length,
      cold_gps: cold14d.slice(0, 10).map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        last_activity: c.last_gp_activity_at || c.created_at, stage: c.stage,
        days_inactive: Math.floor((now - new Date(c.last_gp_activity_at || c.created_at).getTime()) / DAY_MS),
        assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned'
      })).sort((a, b) => b.days_inactive - a.days_inactive)
    };

    // ── Tickets ──
    const closedTickets = tickets.filter(t => t.status === 'closed');
    const resolvedThisWeek = closedTickets.filter(t => t.resolved_at && t.resolved_at >= weekAgo).length;
    const resolutionDurations = closedTickets.filter(t => t.resolved_at && t.created_at).map(t => (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
    const avgResolutionHours = resolutionDurations.length > 0 ? Math.round((resolutionDurations.reduce((a, b) => a + b, 0) / resolutionDurations.length) * 10) / 10 : null;
    const replyDurations = closedTickets.filter(t => t.first_reply_at && t.created_at).map(t => (new Date(t.first_reply_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
    const avgFirstReplyHours = replyDurations.length > 0 ? Math.round((replyDurations.reduce((a, b) => a + b, 0) / replyDurations.length) * 10) / 10 : null;

    const ticketStats = {
      open: openTickets.length,
      resolved_this_week: resolvedThisWeek,
      resolved_total: closedTickets.length,
      avg_resolution_hours: avgResolutionHours,
      avg_first_reply_hours: avgFirstReplyHours
    };

    // ── Completions ──
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const thisMonthCompleted = completedCases.filter(c => c.completed_at && c.completed_at >= monthStart).length;
    // Recent milestones from stage_change timeline
    const recentMilestones = stageEvents.slice(-20).reverse().slice(0, 5).map(ev => {
      const c = cases.find(rc => rc.id === ev.case_id);
      return {
        gp_name: c ? gpName(c.user_id) : 'Unknown',
        milestone: ev.title || 'Stage change',
        date: ev.created_at,
        days_ago: Math.floor((now - new Date(ev.created_at).getTime()) / DAY_MS)
      };
    });

    const completions = {
      this_month: thisMonthCompleted,
      total: completedCases.length,
      recent_milestones: recentMilestones
    };

    sendJson(res, 200, {
      ok: true, refreshed_at: new Date().toISOString(),
      kpi, escalations, pipeline, blockers, task_health: taskHealth,
      va_workload: vaWorkload, velocity, placements, gp_activity: gpActivity,
      tickets: ticketStats, completions
    });
    return;
  }
```

- [ ] **Step 3: Add GET /api/ceo/drilldown/:section endpoint**

```javascript
  // ── CEO Drilldown ──
  const ceoDrilldownMatch = pathname.match(/^\/api\/ceo\/drilldown\/([a-z_]+)$/);
  if (ceoDrilldownMatch && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const ceoCtx = requireCeoSession(req, res);
    if (!ceoCtx) return;
    const section = ceoDrilldownMatch[1];

    const profilesRes = await supabaseDbRequest('user_profiles', 'select=user_id,email,first_name,last_name,phone');
    const profiles = (profilesRes.ok && Array.isArray(profilesRes.data)) ? profilesRes.data : [];
    const profileByUserId = {};
    for (const p of profiles) { if (p.user_id) profileByUserId[p.user_id] = p; }
    function gpName(uid) { const p = profileByUserId[uid]; return p ? ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || p.email || 'Unknown' : 'Unknown'; }
    function gpEmail(uid) { const p = profileByUserId[uid]; return p ? (p.email || '') : ''; }

    const now = Date.now();
    const DAY_MS = 86400000;

    if (section === 'pipeline') {
      const stage = url.searchParams.get('stage') || 'myintealth';
      const casesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=eq.' + encodeURIComponent(stage) + '&order=updated_at.desc');
      const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
      const caseIds = cases.map(c => c.id);
      let tasks = [];
      if (caseIds.length > 0) {
        const tasksRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,status,priority,due_date,title&case_id=in.(' + caseIds.join(',') + ')&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated)');
        tasks = (tasksRes.ok && Array.isArray(tasksRes.data)) ? tasksRes.data : [];
      }
      const taskCountByCase = {};
      for (const t of tasks) { taskCountByCase[t.case_id] = (taskCountByCase[t.case_id] || 0) + 1; }
      const items = cases.map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        substage: c.substage || '', assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va,
        days_in_stage: c.last_gp_activity_at ? Math.floor((now - new Date(c.last_gp_activity_at).getTime()) / DAY_MS) : Math.floor((now - new Date(c.updated_at || c.created_at).getTime()) / DAY_MS),
        status: c.status, blocker_status: c.blocker_status, blocker_reason: c.blocker_reason,
        open_task_count: taskCountByCase[c.id] || 0, last_gp_activity_at: c.last_gp_activity_at, last_va_action_at: c.last_va_action_at, practice_name: c.practice_name
      }));
      sendJson(res, 200, { ok: true, section: 'pipeline', stage, items });
      return;
    }

    if (section === 'blockers') {
      const casesRes = await supabaseDbRequest('registration_cases', 'select=*&or=(status.eq.blocked,blocker_status.not.is.null)&order=updated_at.desc');
      const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
      const items = cases.map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        stage: c.stage, blocker_status: c.blocker_status || c.status, blocker_reason: c.blocker_reason || '',
        days_stuck: c.last_gp_activity_at ? Math.floor((now - new Date(c.last_gp_activity_at).getTime()) / DAY_MS) : 0,
        assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va,
        last_va_action_at: c.last_va_action_at, practice_name: c.practice_name
      }));
      sendJson(res, 200, { ok: true, section: 'blockers', items });
      return;
    }

    if (section === 'tasks') {
      const statusFilter = url.searchParams.get('status') || 'open';
      let query = 'select=*&order=priority.asc,created_at.desc&limit=200';
      if (statusFilter === 'overdue') {
        query += '&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked)&due_date=lt.' + new Date().toISOString().slice(0, 10);
      } else {
        query += '&status=eq.' + encodeURIComponent(statusFilter);
      }
      const tasksRes = await supabaseDbRequest('registration_tasks', query);
      const taskList = (tasksRes.ok && Array.isArray(tasksRes.data)) ? tasksRes.data : [];
      // Enrich with GP name via case lookup
      const caseIds = [...new Set(taskList.map(t => t.case_id))];
      let caseLookup = {};
      if (caseIds.length > 0) {
        const cRes = await supabaseDbRequest('registration_cases', 'select=id,user_id,stage,assigned_va&id=in.(' + caseIds.join(',') + ')');
        if (cRes.ok && Array.isArray(cRes.data)) { for (const c of cRes.data) caseLookup[c.id] = c; }
      }
      const items = taskList.map(t => {
        const c = caseLookup[t.case_id] || {};
        return {
          task_id: t.id, case_id: t.case_id, user_id: c.user_id, gp_name: c.user_id ? gpName(c.user_id) : 'Unknown', gp_email: c.user_id ? gpEmail(c.user_id) : '',
          title: t.title, priority: t.priority, status: t.status, due_date: t.due_date,
          stage: t.related_stage || c.stage, assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va,
          created_at: t.created_at, description: t.description
        };
      });
      sendJson(res, 200, { ok: true, section: 'tasks', status: statusFilter, items });
      return;
    }

    if (section === 'va') {
      const vaEmail = url.searchParams.get('va_email') || '';
      // Find VA user_id from email
      const vaProfileRes = await supabaseDbRequest('user_profiles', 'select=user_id&email=eq.' + encodeURIComponent(vaEmail) + '&limit=1');
      const vaUserId = (vaProfileRes.ok && Array.isArray(vaProfileRes.data) && vaProfileRes.data[0]) ? vaProfileRes.data[0].user_id : null;
      if (!vaUserId) { sendJson(res, 200, { ok: true, section: 'va', items: [] }); return; }
      const casesRes = await supabaseDbRequest('registration_cases', 'select=*&assigned_va=eq.' + encodeURIComponent(vaUserId));
      const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
      const caseIds = cases.map(c => c.id);
      let tasks = [];
      if (caseIds.length > 0) {
        const tRes = await supabaseDbRequest('registration_tasks', 'select=*&case_id=in.(' + caseIds.join(',') + ')&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,blocked,escalated)');
        tasks = (tRes.ok && Array.isArray(tRes.data)) ? tRes.data : [];
      }
      const items = cases.map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        stage: c.stage, status: c.status, blocker_status: c.blocker_status,
        open_tasks: tasks.filter(t => t.case_id === c.id).length,
        overdue_tasks: tasks.filter(t => t.case_id === c.id && t.due_date && new Date(t.due_date).getTime() < now).length
      }));
      sendJson(res, 200, { ok: true, section: 'va', va_email: vaEmail, va_name: gpName(vaUserId), items });
      return;
    }

    if (section === 'placements') {
      const statusFilter = url.searchParams.get('status') || 'all';
      const SECURED = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
      const appsRes = await supabaseDbRequest('gp_applications', 'select=*&order=updated_at.desc&limit=300');
      const allApps = (appsRes.ok && Array.isArray(appsRes.data)) ? appsRes.data : [];
      const interviewsRes = await supabaseDbRequest('career_interviews', 'select=*&status=neq.cancelled');
      const allInterviews = (interviewsRes.ok && Array.isArray(interviewsRes.data)) ? interviewsRes.data : [];
      const interviewByAppId = {};
      for (const i of allInterviews) { interviewByAppId[i.application_id] = i; }
      const rolesRes = await supabaseDbRequest('career_roles', 'select=id,title,practice_name,location_label');
      const allRoles = (rolesRes.ok && Array.isArray(rolesRes.data)) ? rolesRes.data : [];
      const roleById = {};
      for (const r of allRoles) roleById[r.id] = r;
      let filtered = allApps;
      if (statusFilter === 'secured') filtered = allApps.filter(a => SECURED.has((a.status || '').toLowerCase()));
      else if (statusFilter === 'interviewing') filtered = allApps.filter(a => interviewByAppId[a.id]);
      else if (statusFilter === 'applied') filtered = allApps.filter(a => !['withdrawn', 'rejected'].includes((a.status || '').toLowerCase()));
      const items = filtered.map(a => {
        const role = roleById[a.career_role_id] || {};
        const interview = interviewByAppId[a.id];
        return {
          application_id: a.id, user_id: a.user_id, gp_name: gpName(a.user_id), gp_email: gpEmail(a.user_id),
          role_title: role.title || 'GP Role', practice_name: role.practice_name || a.practice_contact_name || '',
          location: role.location_label || '', status: a.status, practice_submission_status: a.practice_submission_status,
          applied_at: a.applied_at, submitted_to_practice_at: a.submitted_to_practice_at,
          interview_date: interview ? interview.scheduled_at : null, interview_status: interview ? interview.status : null
        };
      });
      sendJson(res, 200, { ok: true, section: 'placements', status: statusFilter, items });
      return;
    }

    if (section === 'activity') {
      const bucket = url.searchParams.get('bucket') || 'cold';
      const casesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=neq.complete&status=neq.withdrawn&order=last_gp_activity_at.asc.nullsfirst');
      const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
      const items = cases.filter(c => {
        const lastAct = c.last_gp_activity_at ? new Date(c.last_gp_activity_at).getTime() : new Date(c.created_at).getTime();
        const days = Math.floor((now - lastAct) / DAY_MS);
        if (bucket === 'active') return days <= 7;
        if (bucket === 'inactive') return days > 7 && days <= 14;
        return days > 14; // cold
      }).map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        stage: c.stage, last_activity: c.last_gp_activity_at || c.created_at,
        days_inactive: Math.floor((now - new Date(c.last_gp_activity_at || c.created_at).getTime()) / DAY_MS),
        assigned_va: c.assigned_va ? gpName(c.assigned_va) : 'Unassigned', assigned_va_id: c.assigned_va
      }));
      sendJson(res, 200, { ok: true, section: 'activity', bucket, items });
      return;
    }

    if (section === 'tickets') {
      const ticketsRes = await supabaseDbRequest('support_tickets', 'select=*&status=neq.closed&order=created_at.desc&limit=100');
      const ticketList = (ticketsRes.ok && Array.isArray(ticketsRes.data)) ? ticketsRes.data : [];
      const items = ticketList.map(t => ({
        ticket_id: t.id, user_id: t.user_id, case_id: t.case_id, gp_name: gpName(t.user_id), gp_email: gpEmail(t.user_id),
        title: t.title, category: t.category, priority: t.priority, status: t.status,
        created_at: t.created_at, days_open: Math.floor((now - new Date(t.created_at).getTime()) / DAY_MS)
      }));
      sendJson(res, 200, { ok: true, section: 'tickets', items });
      return;
    }

    if (section === 'completions') {
      const casesRes = await supabaseDbRequest('registration_cases', 'select=*&stage=eq.complete&order=completed_at.desc.nullslast,updated_at.desc');
      const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
      const items = cases.map(c => ({
        case_id: c.id, user_id: c.user_id, gp_name: gpName(c.user_id), gp_email: gpEmail(c.user_id),
        completed_at: c.completed_at || c.updated_at, practice_name: c.practice_name || '',
        total_days: c.completed_at ? Math.floor((new Date(c.completed_at).getTime() - new Date(c.created_at).getTime()) / DAY_MS) : null
      }));
      sendJson(res, 200, { ok: true, section: 'completions', items });
      return;
    }

    sendJson(res, 400, { ok: false, message: 'Unknown section: ' + section });
    return;
  }
```

- [ ] **Step 4: Add GET /api/ceo/trends endpoint**

```javascript
  // ── CEO Trends (weekly) ──
  if (pathname === '/api/ceo/trends' && req.method === 'GET') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const ceoCtx = requireCeoSession(req, res);
    if (!ceoCtx) return;

    const DAY_MS = 86400000;
    const WEEK_MS = 7 * DAY_MS;
    const now = Date.now();
    const twelveWeeksAgo = new Date(now - 12 * WEEK_MS).toISOString();

    const [casesRes, tasksRes, ticketsRes, appsRes, timelineRes] = await Promise.all([
      supabaseDbRequest('registration_cases', 'select=created_at&created_at=gte.' + twelveWeeksAgo),
      supabaseDbRequest('registration_tasks', 'select=created_at,completed_at,status&or=(created_at.gte.' + twelveWeeksAgo + ',completed_at.gte.' + twelveWeeksAgo + ')&limit=2000'),
      supabaseDbRequest('support_tickets', 'select=created_at,resolved_at&or=(created_at.gte.' + twelveWeeksAgo + ',resolved_at.gte.' + twelveWeeksAgo + ')&limit=1000'),
      supabaseDbRequest('gp_applications', 'select=applied_at,status,updated_at&applied_at=gte.' + twelveWeeksAgo),
      supabaseDbRequest('task_timeline', 'select=created_at&event_type=eq.stage_change&created_at=gte.' + twelveWeeksAgo)
    ]);

    const cases = (casesRes.ok && Array.isArray(casesRes.data)) ? casesRes.data : [];
    const tasks = (tasksRes.ok && Array.isArray(tasksRes.data)) ? tasksRes.data : [];
    const tickets = (ticketsRes.ok && Array.isArray(ticketsRes.data)) ? ticketsRes.data : [];
    const apps = (appsRes.ok && Array.isArray(appsRes.data)) ? appsRes.data : [];
    const timeline = (timelineRes.ok && Array.isArray(timelineRes.data)) ? timelineRes.data : [];

    // Build 12-week buckets (Monday-start)
    function getWeekStart(dateStr) {
      const d = new Date(dateStr);
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
      return monday.toISOString().slice(0, 10);
    }

    const SECURED = new Set(['hired', 'secured', 'placement_secured', 'offer_accepted', 'contract_signed']);
    const weeks = {};
    for (let i = 0; i < 12; i++) {
      const ws = getWeekStart(new Date(now - i * WEEK_MS).toISOString());
      weeks[ws] = { week_start: ws, new_gps: 0, tasks_completed: 0, tasks_created: 0, stage_transitions: 0, tickets_opened: 0, tickets_resolved: 0, applications_submitted: 0, placements_secured: 0 };
    }

    for (const c of cases) { const ws = getWeekStart(c.created_at); if (weeks[ws]) weeks[ws].new_gps++; }
    for (const t of tasks) {
      if (t.created_at) { const ws = getWeekStart(t.created_at); if (weeks[ws]) weeks[ws].tasks_created++; }
      if (t.completed_at) { const ws = getWeekStart(t.completed_at); if (weeks[ws]) weeks[ws].tasks_completed++; }
    }
    for (const t of tickets) {
      if (t.created_at) { const ws = getWeekStart(t.created_at); if (weeks[ws]) weeks[ws].tickets_opened++; }
      if (t.resolved_at) { const ws = getWeekStart(t.resolved_at); if (weeks[ws]) weeks[ws].tickets_resolved++; }
    }
    for (const a of apps) {
      if (a.applied_at) { const ws = getWeekStart(a.applied_at); if (weeks[ws]) weeks[ws].applications_submitted++; }
      if (SECURED.has((a.status || '').toLowerCase()) && a.updated_at) { const ws = getWeekStart(a.updated_at); if (weeks[ws]) weeks[ws].placements_secured++; }
    }
    for (const ev of timeline) { const ws = getWeekStart(ev.created_at); if (weeks[ws]) weeks[ws].stage_transitions++; }

    const weekList = Object.values(weeks).sort((a, b) => a.week_start.localeCompare(b.week_start));
    sendJson(res, 200, { ok: true, weeks: weekList });
    return;
  }
```

- [ ] **Step 5: Add POST /api/ceo/escalation/:taskId/resolve and /respond endpoints**

```javascript
  // ── CEO Escalation Resolve/Respond ──
  const ceoEscMatch = pathname.match(/^\/api\/ceo\/escalation\/([^/]+)\/(resolve|respond)$/);
  if (ceoEscMatch && req.method === 'POST') {
    if (!isSupabaseDbConfigured()) { sendJson(res, 503, { ok: false, message: 'Requires Supabase.' }); return; }
    const ceoCtx = requireCeoSession(req, res);
    if (!ceoCtx) return;
    const taskId = decodeURIComponent(ceoEscMatch[1]);
    const action = ceoEscMatch[2]; // 'resolve' or 'respond'
    let body; try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false }); return; }
    const note = (body && typeof body.note === 'string') ? body.note.trim().slice(0, 2000) : '';

    if (action === 'respond' && !note) {
      sendJson(res, 400, { ok: false, message: 'Note required when responding to escalation.' });
      return;
    }

    // Fetch task to get case_id
    const taskRes = await supabaseDbRequest('registration_tasks', 'select=id,case_id,escalated_to,status&id=eq.' + encodeURIComponent(taskId) + '&limit=1');
    const task = (taskRes.ok && Array.isArray(taskRes.data) && taskRes.data[0]) ? taskRes.data[0] : null;
    if (!task) { sendJson(res, 404, { ok: false, message: 'Task not found.' }); return; }
    if (task.status !== 'escalated') { sendJson(res, 400, { ok: false, message: 'Task is not escalated.' }); return; }

    // PATCH task — clear escalation, set back to open
    const patch = { status: 'open', escalated_to: null, escalated_at: null };
    if (action === 'resolve') { patch.escalated_reason = null; } // Clear reason on resolve, keep on respond for history

    await supabaseDbRequest('registration_tasks', 'id=eq.' + encodeURIComponent(taskId), { method: 'PATCH', body: patch });

    // Timeline entry
    const evTitle = action === 'resolve' ? 'CEO resolved escalation' : 'CEO response';
    await _logCaseEvent(task.case_id, taskId, action === 'resolve' ? 'escalation' : 'note', evTitle, note || null, ceoCtx.email);

    // Update case last_va_action_at
    await supabaseDbRequest('registration_cases', 'id=eq.' + encodeURIComponent(task.case_id), { method: 'PATCH', body: { last_va_action_at: new Date().toISOString() } });

    sendJson(res, 200, { ok: true, action, task_id: taskId });
    return;
  }
```

- [ ] **Step 6: Verify syntax**

Run: `cd "/Users/khaleed/GP LINK APP (Visual Studio)" && node -c server.js`
Expected: No output (syntax OK)

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: add CEO dashboard API endpoints — /api/ceo/dashboard, drilldown, trends, escalation"
git push
```

---

### Task 4: admin.html — Escalate to CEO Button

Add a proper "Escalate to CEO" button (distinct from blocked) and an escalated status badge.

**Files:**
- Modify: `pages/admin.html`

- [ ] **Step 1: Replace the existing "Escalate" blocked button with a proper CEO escalation button**

Find the task action dropdown (~line 2055). The current escalate line:
```javascript
html+='<button class="st-dropdown-item" data-set-waiting="'+esc(t.id)+'" data-waiting="blocked">\uD83D\uDEA8 Escalate</button>';
```

Replace with:
```javascript
html+='<button class="st-dropdown-item" data-set-waiting="'+esc(t.id)+'" data-waiting="blocked">\u26D4 Set Blocked</button>';
html+='<button class="st-dropdown-item st-escalate-ceo" data-escalate-ceo="'+esc(t.id)+'">\uD83D\uDEA8 Escalate to CEO</button>';
```

- [ ] **Step 2: Add CSS for the escalated status badge**

Find the CSS section with status/priority pill styles (search for `.tp.urgent`). Add:

```css
.tp.escalated{background:#dc2626;color:#fff;font-weight:700;}
.st-escalate-ceo{color:#dc2626 !important;font-weight:600;}
```

- [ ] **Step 3: Add the escalation modal HTML**

Find the modal overlay element (`#modalOverlay` or end of `<body>`). Add this escalation modal:

```html
<div id="escalateCeoModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:none;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:12px;padding:24px;width:400px;max-width:90vw;">
    <h3 style="margin:0 0 12px;">Escalate to CEO</h3>
    <p style="font-size:0.85rem;color:#666;margin:0 0 12px;">This task will appear on the CEO dashboard for a decision. Provide a reason:</p>
    <textarea id="escalateReasonInput" rows="4" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px;font-size:0.9rem;resize:vertical;" placeholder="Why does this need CEO attention?"></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn" onclick="document.getElementById('escalateCeoModal').style.display='none';">Cancel</button>
      <button class="btn red" id="escalateConfirmBtn">Escalate</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Add the escalation event handler**

Find the event delegation section where `data-set-waiting` is handled (~line 3520). Add this handler BEFORE the `data-set-waiting` handler:

```javascript
      if(e.target.closest("[data-escalate-ceo]")){
        const btn=e.target.closest("[data-escalate-ceo]");
        const taskId=btn.getAttribute("data-escalate-ceo");
        document.querySelectorAll(".st-dropdown.open").forEach(d=>d.classList.remove("open"));
        const modal=document.getElementById("escalateCeoModal");
        const reasonInput=document.getElementById("escalateReasonInput");
        const confirmBtn=document.getElementById("escalateConfirmBtn");
        reasonInput.value="";
        modal.style.display="flex";
        reasonInput.focus();
        confirmBtn.onclick=async function(){
          const reason=reasonInput.value.trim();
          if(!reason){reasonInput.style.borderColor="#dc2626";return;}
          modal.style.display="none";
          try{
            const r=await fetch("/api/admin/task?id="+encodeURIComponent(taskId),{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"escalated",escalated_to:"CEO",escalated_reason:reason,escalated_at:new Date().toISOString()})});
            const d=await r.json().catch(()=>({}));
            if(d.ok){toast("Escalated to CEO","#dc2626");loadAll();}else{toast("Failed to escalate","#dc2626");}
          }catch{toast("Failed to escalate","#dc2626");}
        };
        return;
      }
```

- [ ] **Step 5: Add escalated status pill rendering**

Find where task status pills are rendered (search for `t.status` in the task card rendering function). Add a case for `escalated`:

In the status pill rendering logic, ensure `escalated` maps to the right label. Find the status label mapping and add:
```javascript
if(t.status==='escalated') statusLabel='\uD83D\uDEA8 Escalated to CEO';
```

- [ ] **Step 6: Lock status changes for escalated tasks**

In the task dropdown rendering (~line 2037), wrap the action buttons in a check:
```javascript
if(t.status==='escalated'){
  html+='<div style="padding:8px 12px;color:#dc2626;font-size:0.8rem;">Escalated to CEO — awaiting decision</div>';
} else {
  // existing dropdown buttons
}
```

- [ ] **Step 7: Commit**

```bash
git add pages/admin.html
git commit -m "feat: add Escalate to CEO button + modal + escalated badge in admin.html"
git push
```

---

### Task 5: CEO Dashboard Page — Shell, CSS, Auth, Data Loading

Create the full `pages/ceo-dashboard.html` file. This is a large vanilla HTML/CSS/JS page. Use the `frontend-design` skill for the visual implementation.

**Files:**
- Create: `pages/ceo-dashboard.html`

**Design reference:** The brainstorming mockups are at `.superpowers/brainstorm/44302-1778465947/content/layout-overview.html` and `drilldown-escalation.html`. The spec is at `docs/superpowers/specs/2026-05-11-ceo-dashboard-design.md`.

- [ ] **Step 1: Create the page shell with dark-theme CSS, auth check, and data loading skeleton**

Create `pages/ceo-dashboard.html` with:

**HTML structure:**
- `<!DOCTYPE html>` with meta viewport, title "GP Link Command Centre"
- Inline `<style>` block with dark theme CSS variables (`--bg: #0f1117`, `--panel: #1a1d27`, etc.), card styles, KPI strip grid, section grid, status pills, action button styles, modal styles, toast styles
- Header bar: "GP Link Command Centre" left, escalation badge + "Last refresh: Xs ago" + auto-refresh toggle right
- KPI strip: 6 cards in a `display: grid; grid-template-columns: repeat(6, 1fr)` row
- Escalation banner: conditionally visible red-tinted bar
- Section grid: `display: grid; grid-template-columns: 1fr 1fr; gap: 16px` with 9 section cards
- Each section card: `background: var(--panel); border: 1px solid var(--panel-border); border-radius: 12px; padding: 16px`
- Drill-down panel container below each card (hidden by default)
- Action modal overlay (hidden by default)
- Toast container (position: fixed; bottom: 20px; right: 20px)

**JavaScript:**
- On DOMContentLoaded: call `loadSession()` → verify admin session + CEO email → redirect if unauthorized
- `loadDashboard()`: fetch `GET /api/ceo/dashboard` → populate all sections
- `loadTrends()`: fetch `GET /api/ceo/trends` → populate velocity trend indicators
- Auto-refresh: `setInterval(loadDashboard, 30000)` + visibility change listener
- `refreshTimer`: update "Last refresh: Xs ago" every second
- Section click handlers: call `GET /api/ceo/drilldown/:section` → render inline detail panel
- GP row expand: show detail fields + action buttons
- Action button handlers: call existing `/api/admin/*` endpoints (create task, reassign, nudge, stage change, blocker, note)
- Escalation panel: expand on banner click, resolve/respond buttons call `POST /api/ceo/escalation/:taskId/*`
- Toast function: `function toast(msg, color) { ... }` — brief notification bottom-right

**Auth check pattern (matching admin.html):**
```javascript
async function loadSession() {
  try {
    const r = await fetch('/api/admin/auth/session', { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!d.authenticated) { window.location.href = '/pages/admin-signin.html'; return false; }
    const role = (d.profile || d.session || {}).adminRole || (d.profile || d.session || {}).role || '';
    if (role !== 'super_admin') { window.location.href = '/pages/admin-signin.html'; return false; }
    return true;
  } catch { window.location.href = '/pages/admin-signin.html'; return false; }
}
```

**Data loading pattern:**
```javascript
async function loadDashboard() {
  const r = await fetch('/api/ceo/dashboard', { credentials: 'same-origin' });
  if (r.status === 401 || r.status === 403) { window.location.href = '/pages/admin-signin.html'; return; }
  const data = await r.json().catch(() => ({}));
  if (!data.ok) return;
  renderKPI(data.kpi);
  renderEscalations(data.escalations);
  renderPipeline(data.pipeline);
  renderBlockers(data.blockers);
  renderTaskHealth(data.task_health);
  renderVAWorkload(data.va_workload);
  renderVelocity(data.velocity);
  renderPlacements(data.placements);
  renderGPActivity(data.gp_activity);
  renderTickets(data.tickets);
  renderCompletions(data.completions);
  lastRefreshTime = Date.now();
}
```

**Drill-down pattern:**
```javascript
async function expandSection(section, params) {
  const query = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch('/api/ceo/drilldown/' + section + query, { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) return;
  renderDrilldown(section, data.items);
}
```

**Action modal pattern (example: Create Task):**
```javascript
async function createTask(caseId, title, priority, dueDate, description) {
  const r = await fetch('/api/admin/tasks', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, title, priority, due_date: dueDate, description })
  });
  const d = await r.json().catch(() => ({}));
  if (d.ok) { toast('Task created'); loadDashboard(); }
  else toast('Failed to create task', '#ef4444');
}
```

**Note:** This is a large file (~2000-3000 lines). Use the `frontend-design` skill to build the full page with production-quality dark-theme UI. The rendering functions (renderKPI, renderPipeline, etc.) build HTML strings and set innerHTML on section containers — same pattern as admin.html.

- [ ] **Step 2: Verify the page loads and shows auth redirect when not logged in**

Run: `cd "/Users/khaleed/GP LINK APP (Visual Studio)" && npm start &`
Then open `http://localhost:3000/pages/ceo-dashboard.html` in browser.
Expected: Redirects to admin-signin.html (since not logged in)

- [ ] **Step 3: Test with CEO session — verify dashboard loads with real data**

Log in as `khaleedmahmoud1211@gmail.com` via admin sign-in, then navigate to `/pages/ceo-dashboard.html`.
Expected: Dashboard loads with all 9 sections populated from Supabase data.

- [ ] **Step 4: Test drill-down — click a pipeline stage, verify GP list appears**

Click "AMC" bar in pipeline funnel.
Expected: Inline panel expands showing GPs at AMC stage with status pills and action buttons.

- [ ] **Step 5: Test action — create a task from drill-down panel**

Expand a GP row, click "Create Task", fill form, submit.
Expected: Toast "Task created", task appears in admin.html task list.

- [ ] **Step 6: Test escalation flow end-to-end**

1. In admin.html: find a task, click "Escalate to CEO", enter reason, confirm
2. In ceo-dashboard.html: verify escalation banner appears within 30 seconds
3. Click escalation banner, click "Add Note & Return to VA" on an escalation, type a note, submit
4. In admin.html: verify the task is back to "open" status with the CEO's note in timeline

Expected: Full round-trip works.

- [ ] **Step 7: Commit**

```bash
git add pages/ceo-dashboard.html
git commit -m "feat: add CEO Command Centre dashboard page — dark theme, 9 sections, drill-down, actions, escalations"
git push
```

---

### Task 6: Integration Verification

Final verification that everything works together.

**Files:** None (verification only)

- [ ] **Step 1: Run syntax check on server.js**

Run: `node -c server.js`
Expected: No output

- [ ] **Step 2: Run existing test suite to check for regressions**

Run: `npm test`
Expected: All existing tests pass

- [ ] **Step 3: Verify migration file exists and is valid SQL**

Run: `ls supabase/migrations/20260511000000_ceo_dashboard.sql`
Expected: File exists

- [ ] **Step 4: Verify all new endpoints respond correctly**

Start the server and test each endpoint:
```bash
# These should all return 401 (no session) or 403 (not CEO) — confirming auth gates work
curl -s http://localhost:3000/api/ceo/dashboard | head -c 100
curl -s http://localhost:3000/api/ceo/trends | head -c 100
curl -s http://localhost:3000/api/ceo/drilldown/pipeline | head -c 100
```
Expected: `{"ok":false,"authenticated":false}` (401 for unauthenticated)

- [ ] **Step 5: Verify admin.html escalation button exists**

Run: `grep -c 'data-escalate-ceo' pages/admin.html`
Expected: At least 2 (button creation + event handler)

- [ ] **Step 6: Verify CEO dashboard page exists and has key elements**

Run: `grep -c 'api/ceo/dashboard' pages/ceo-dashboard.html`
Expected: At least 1

Run: `grep -c 'GP Link Command Centre' pages/ceo-dashboard.html`
Expected: At least 1

- [ ] **Step 7: Deploy and verify on production**

```bash
git push
```

Verify the Vercel deployment succeeds, then test `/pages/ceo-dashboard.html` on the production URL.

---

## Dependency Graph

```
Task 1 (migration) ──┐
                      ├── Task 3 (CEO endpoints) ──┐
Task 2 (server edits) ┘                             ├── Task 5 (CEO dashboard page)
                                                     │
Task 4 (admin.html escalation) ─────────────────────┘
                                                     │
                                                     └── Task 6 (integration verification)
```

Tasks 1 + 2 can run in parallel. Task 3 depends on both. Task 4 is independent. Task 5 depends on Task 3. Task 6 depends on all.
