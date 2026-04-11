# VA Dashboard — UI Consolidation Design

**Date:** 2026-04-11
**Scope:** Sub-project #1 of a larger "completely functional VA dashboard" programme. UI consolidation only.
**Status:** Approved, ready for implementation plan.

## Context

The VA Command Centre in `pages/admin.html` has accrued 8 tabs (Today, Users, Tickets, Work Queue, Ops Queue, Interviews, Applications, Agent) plus a drill-through GP list + profile that was added in the previous session. The result is disjointed: the "Today" drill-through GP list and the "Users" tab render the same underlying data with two different UIs; the Ops Queue is a table while everything else is cards; Work Queue duplicates tasks already visible on Today; and the Agent tab competes with Users for the same screen real estate.

This spec consolidates the surface into a single coherent 5-tab layout while preserving every existing capability and every existing backend endpoint. It is deliberately UI-only — no messaging ingest, no document approve/reject flow, no bulk actions, no analytics. Those ship as later sub-projects.

## Users

Two personas share the page:
- **VA (Hazel)** — operational, day-to-day. Needs a landing view of action-required work, a fast GP browser, and the ability to act on tasks/tickets/cases without tab-hopping.
- **Super Admin** — oversight. Same layout as the VA, plus the Agent sub-view under Tools.

## Goals

1. One landing view for "what must I act on right now?" — no duplication across tabs.
2. One place to browse GPs and see everything about any one GP without switching tabs.
3. Preserve every existing capability (nudge, WhatsApp, ticket close, task complete, case management form, notes, timeline, journey stepper, qualifications view, document download, interviews, applications, ops queue, weekly sweep, agent runs).
4. Monolithic vanilla-JS style per `CLAUDE.md` — no framework, one HTML file, inline `<script>`.
5. Ship in one diff against `pages/admin.html` plus one small endpoint addition to `server.js` for global search.

## Non-goals (deferred)

- Document approve/reject UI (sub-project #2).
- Bulk actions, assignment, "my queue" (sub-project #2).
- Gmail scan, WhatsApp webhook ingest, AI task extraction (sub-project #3+).
- Visa/PBS embedded into the dashboard (sub-project #4).
- SLA reporting, backlog trend, throughput analytics (sub-project #5).

## Architecture

### File changes

- `pages/admin.html` — rewritten top nav, new panel structure, new render functions, deletion of obsolete code. No new files.
- `server.js` — one new endpoint: `GET /api/admin/va/search`. Admin-gated, reuses existing `supabaseDbRequest` helper.
- `tests/admin-va-search.test.js` — new test file covering the search endpoint.

### 5-tab nav

The existing `.view-tabs` strip is replaced with:

```
Inbox | GPs | Interviews | Applications | Tools
```

The `Agent` top-level tab is removed. Agent controls move under `Tools` as a sub-view, visible only to super admins via `isSA()`.

### Layout modes

- **Inbox**, **Interviews**, **Applications**, **Tools** — full-width panel pattern. `mainLayout` grid hidden, one wide panel visible (existing `vaShowPanel` / `vaHidePanels` plumbing extends to cover the new panels).
- **GPs** — uses the existing `mainLayout` grid. Left list + right detail pane. Responsive:
  - Desktop (> 900px): detail pane is a two-column layout — narrow meta column (260px) on the left, wide tabbed content column on the right.
  - Mobile (≤ 900px): list panel full-viewport; clicking a row replaces it with a full-screen single-scroll profile page with a back button.

### Top bar

Adds `#globalSearch` input between `#topChips` and `.top-right`. Grows to fill available space on desktop, reflows to full-width below the title on mobile.

### State additions

Extends the existing `S` object:

```js
S.view // "inbox" | "gps" | "interviews" | "applications" | "tools"
S.toolsSubView // "ops" | "sweep" | "agent"
S.gpsProfileTab // "tasks" | "documents" | "journey" | "notes" — desktop only
S.search = {
  query: "",
  loading: false,
  clientResults: { gps: [], tasks: [], tickets: [] },
  serverResults: { documents: [], notes: [] },
  open: false,
  debounceTimer: null
}
S.va.gpDetailCache = {} // userId -> { quals, timeline }
S.va.lastSweepResult = null // { scanned, created, at }
```

`S.filter` continues to drive GPs tab filters. `S.selectedCaseId` continues to mean "selected GP on GPs tab".

## Inbox

**Purpose:** Landing view. Every live item in priority order.

**Data:** `/api/admin/va/dashboard` (unchanged). Returns `metrics`, `users`, `todays_tasks` (enriched with `is_urgent`, `is_overdue`, `age_hours`), `open_tickets`.

**Render:** `renderInboxPanel()` into `#inboxPanel`. Replaces `renderTodayPanel` + `#todayPanel`. No metric cards.

**Sections, in order, each hidden if empty:**

1. **Support Tickets** — sorted by `created_at` ascending (FIFO). Reuses existing `ticketCard()` rendering. Actions: WhatsApp, Send Nudge, Resolve & Close.
2. **Urgent** — `is_urgent === true && is_overdue === false`. Sorted oldest-created first. Reuses `taskCard()`.
3. **Overdue** — `is_overdue === true`. Sorted by `due_date` ascending. Reuses `taskCard()`.
4. **Blocked cases** — `users` filtered to `blocker_status != null`. New `blockerRow()` renderer: GP name, current stage, blocker reason, "Open profile" button (→ GPs tab with that case selected).
5. **Normal** — remaining tasks. Sorted by priority then created_at.

A single task appears in exactly one section. Precedence: Overdue > Urgent > Normal. A task that is both overdue and urgent appears only under Overdue.

Task card actions (unchanged): WhatsApp, Send Nudge, Complete, Open Case. "Open Case" routes to the GPs tab with the target case selected.

Empty state (all sections empty): `"All clear — no pending tickets or tasks. 🎉"`.

Header actions: `[Refresh]`. The weekly sweep button **is removed from the Inbox header** — it lives under Tools → Sweep.

Auto-refresh: existing 15-second `loadAll()` poll continues to refresh the inbox when the tab is visible.

## GPs tab

**Purpose:** The main GP browser. Replaces the old Users tab and the drill-through panels from the previous session.

**Data:** `/api/admin/va/dashboard` for the list, `/api/admin/case?id=X` for timeline, `/api/admin/va/user-qualifications?user_id=X` for documents. All existing.

### List panel (both layouts)

- Filter chips at top: `All · Urgent · Overdue · Blocked · Active · Complete` with counts from the existing `counts()` helper.
- Search input below filters — scoped to this tab only (name / email / phone substring match).
- List rows: avatar, name, stage pill, last activity, task badges (`N urgent` / `N open` / `N overdue`), blocker flag. Reuses the existing `case-card` renderer.
- Sort: urgent desc → open desc → stage order.
- Selected row highlighted.

### Detail pane — desktop (> 900px)

Two-column internal layout:

**Meta column (260px, always visible when a GP is selected):**
- Avatar + name + stage pill.
- Contact lines: email, phone, country.
- Progress bar (qualification percent).
- Actions: WhatsApp, Send Nudge, Open full case (escape hatch during transition; delete once sub-views are proven to cover everything).
- Case Management form: status, blocker, follow-up date, practice name, handover notes, VA-verified stage, Save button. Reuses existing `data-case-field` + `data-save-case` plumbing.

**Tabbed content column (remaining width):**

Four sub-tabs. `S.gpsProfileTab` defaults to `"tasks"` and is remembered per-session (not per-GP).

1. **Tasks**
   - "Next Action" card at top (highest-priority open task).
   - Open tasks grouped by priority (urgent / high / normal).
   - Each row: priority dot, title, description, due date, actions (Complete, Start).
   - `+ Add Task` button (reuses existing add-task flow).
2. **Documents**
   - Approved (`snapshot.approved`): label, file name, `[View]` → `/api/admin/va/user-document-download`.
   - Pending / awaiting AI (`snapshot.uploaded_unverified`): same row shape with status pill.
   - Missing (`snapshot.missing`): row with "Missing" badge, no action.
   - Reuses `loadGpProfileDocuments()` (renamed `loadGpDocuments()`).
3. **Journey**
   - Existing `buildJourney()` + `STEPS` + `PLAYBOOK` stepper, rendered as-is. Substeps clickable. Links to `admin-visa.html` / `admin-pbs.html` remain until sub-project #4.
4. **Notes**
   - Add-note textarea + submit (reuses `data-add-note`).
   - Per-GP support tickets list.
   - Case timeline (reuses `loadTimeline()`).

### Detail pane — mobile (≤ 900px)

Single-scroll page. No tabs. Sections in this fixed order:

```
Header (name, stage, contact, progress bar)
Actions (WhatsApp, Send Nudge, Open full case)
Case Management form
Next Action card
Tasks
Documents
Journey
Notes + Tickets + Timeline
```

Back button returns to the list.

### Breakpoint

`@media (min-width: 901px)` switches between single-scroll and two-column. One class applied to `body` based on `matchMedia`, one CSS rule set per layout.

### Navigation

- Inbox ticket / task card "Open Case" → `S.view = "gps"`, `S.selectedCaseId = X`, render list + detail.
- Deep-link via `?view=gps&case=X` supported so global search results can link into this tab.

### Empty states

- No GPs matching filter: `"No cases match filter."`
- GP selected, no tasks: `"No open tasks."`
- No approved docs: `"None approved yet."`
- No pending docs: `"Nothing awaiting verification."`
- All docs submitted: `"All required docs accounted for. 🎉"`
- No timeline: `"No activity yet."`

## Interviews & Applications

**No structural changes.** Existing `#interviewsPanel` and `#applicationsPanel` are kept verbatim. Only the tab-switching wiring changes to point `S.view = "interviews"` / `S.view = "applications"` at the existing panels.

The "schedule from application" hand-off (`data-app-schedule` → switches to Interviews tab, pre-fills `ivAppId`) is preserved.

## Tools tab

New `#toolsPanel` full-width panel. Sub-nav (pill buttons) at top:

```
[ Ops Queue ]  [ Weekly Sweep ]  [ Agent (SA) ]
```

`S.toolsSubView` defaults to `"ops"`. `renderToolsPanel()` switches sub-content based on this value.

### Ops Queue sub-view

- The existing `#opsPanel` content (stats, filters, ops table) is reparented into `<div id="toolsOps">` inside the Tools panel.
- `switchToOps()` / `switchFromOps()` helpers are removed — they were only needed when Ops was a top-level tab that hid/showed `mainLayout`. Replaced with simple show/hide of `#toolsOps` keyed off `S.toolsSubView`.
- `loadOpsQueue()`, all filter change handlers, the SLA check button, and the refresh button are preserved unchanged.

### Weekly Sweep sub-view

- One-line explanation: `"Creates check-in tasks for GPs stalled 14+ days in MyIntealth or AMC without an existing check-in task in the last 7 days."`
- `[Run Sweep Now]` button → existing `runWeeklyCheckinSweep()`.
- Result log showing the most recent sweep result: `"Scanned N — created M new tasks · Ran at HH:MM"`. Stored in `S.va.lastSweepResult`, client-side only, no persistence.

### Agent sub-view (SA only)

- Sub-tab button hidden via `isSA()` check. Non-SA users landing on `S.toolsSubView = "agent"` silently fall back to `"ops"`.
- Existing `renderAgentDetail()` + `renderAgentRunList()` are reparented into `<div id="toolsAgent">`. The agent uses a nested 2-pane split (run list left, run detail right) scoped inside the Tools panel.
- All existing agent control plumbing (`/api/admin/agent-control/*`, `loadAgentStatus`, `loadAgentRun`, cancel, start, etc.) is preserved unchanged.

## Global search

**Placement:** `#globalSearch` input in the top bar. Max width 500px on desktop.

**Data strategy:** Hybrid — client-side for cached data, server-side for the rest.

**Client-side (instant, no network):**
- **GPs** — `S.va.dashboard.users[]` + `S.cases[]`. Match name, email, phone, practice_name.
- **Tasks** — `S.tasks[]` + `S.va.dashboard.todays_tasks[]`. Match title, description.
- **Tickets** — `S.va.dashboard.open_tickets[]` + `S.va.tickets[]`. Match title, body, category.

**Server-side:**
- **Documents** — `onboarding_documents` joined to `user_profiles`. Match `file_name` with `ilike`. Document label is resolved client-side from the document key (labels are static).
- **Notes** — `task_timeline` (the existing case timeline table populated by `_logCaseEvent`) joined to `registration_cases` → `user_profiles` for GP name resolution. Matches `title` or `detail` with `ilike`.

**New endpoint:** `GET /api/admin/va/search`

- Auth: `requireAdminSession`.
- Query params:
  - `q` (required, min length 2)
  - `scope` (optional): `documents`, `notes`, or omitted for both.
- Behaviour:
  - Rejects 400 if `q` is shorter than 2 characters after trim.
  - Runs parallel `supabaseDbRequest` calls against the relevant tables with `ilike.*q*` filters.
  - Caps each scope at 20 results.
  - Joins `user_profiles` for `gp_name` resolution.
  - Returns:
    ```json
    {
      "ok": true,
      "query": "cct",
      "results": {
        "documents": [
          { "user_id": "...", "gp_name": "...", "country": "GB", "key": "cct", "label": "CCT Certificate", "file_name": "..." }
        ],
        "notes": [
          { "case_id": "...", "gp_name": "...", "event_type": "note", "title": "...", "detail": "...", "created_at": "..." }
        ]
      }
    }
    ```
- Follows the same error-handling and logging conventions as the other `/api/admin/va/*` endpoints.

**UX flow:**

1. VA focuses `#globalSearch`. Empty-state tooltip: `"Type to search across GPs, tasks, tickets, documents, and case notes."`
2. On keystroke (200 ms debounce, min 2 chars):
   - Client-side search runs synchronously, dropdown opens with instant results.
   - `/api/admin/va/search?q=X` fires in parallel; results merge in when returned.
3. Dropdown groups by type (GPs, Tasks, Tickets, Documents, Notes), max 5 per group. `"+ N more"` link at the bottom of a group expands that group to show up to 20 hits (the server cap). No pagination beyond 20.
4. Click a result → routes:
   - **GP** → GPs tab, that case selected.
   - **Task** → GPs tab, owning GP selected, Tasks sub-view active, item scrolled into view and briefly highlighted.
   - **Ticket** → GPs tab, owning GP selected, Notes sub-view active (tickets live there), item highlighted.
   - **Document** → GPs tab, owning GP selected, Documents sub-view active, row highlighted. Does not auto-open the file.
   - **Note** → GPs tab, owning case selected, Notes sub-view active, timeline row highlighted.

**Keyboard:**
- `/` (global) focuses the search box.
- `Esc` clears and closes results.
- `↑ / ↓` navigates, `Enter` activates (nice-to-have; ship click-only if time-constrained).

**Closing:** click outside, Esc, or clicking a result closes the dropdown.

**Error handling:** if the server-side call fails, client-side results still render and a small footer says `"Documents and notes unavailable (search server error)"`. Never blocks the VA from using the client-side hits.

## Data flow

Existing `loadAll()` continues to run on mount and every 15 seconds while the page is visible. It populates `S.dashboard`, `S.cases`, `S.tasks`, `S.visaCases`, `S.pbsCases`, `S.va.dashboard`.

**Per-tab load triggers:**

| Tab | On click | Refresh source |
|---|---|---|
| Inbox | `loadVaDashboard()` if stale → `renderInboxPanel()` | 15s poll + header Refresh |
| GPs | `renderCaseList()` + `renderDetail()` | 15s poll + header Refresh |
| Interviews | `loadInterviews()` | manual |
| Applications | `loadAdminApplications()` | manual |
| Tools / Ops | `loadOpsQueue()` | manual |
| Tools / Sweep | none | shows last run result |
| Tools / Agent | `loadAgentStatus()` | existing agent poll |

**On any mutation** (complete task, close ticket, save case, add note, send nudge, run sweep) — call the existing API, re-run `loadVaDashboard()`, re-render only the currently visible panel. Matches the existing pattern.

**GP detail cache:** `S.va.gpDetailCache[userId] = { quals, timeline }` is populated on first selection and invalidated on `loadVaDashboard()` refresh. Prevents redundant fetches when the VA clicks between GPs.

## Error handling

**API failures are non-blocking:**
- `loadVaDashboard()` failure → retain previous data, show a small inline warning banner at the top of the current panel: `"Could not refresh — showing last known state"`.
- Per-section fetches (timeline, qualifications, documents, search) failing → render `"Failed to load"` empty state in that section only.
- Mutation failures → existing `toast("...", "red")` pattern.
- Session expiry (401) → existing `loadSession()` redirect to `/pages/admin-login.html`.

## What gets deleted

- `#todayPanel` → becomes `#inboxPanel`.
- `#gpsListPanel`, `#gpProfilePanel`, `#metricTasksPanel` and their render functions (`renderGpsListPanel`, `renderGpProfilePanel`, `loadGpProfileDocuments`, `renderMetricTasksPanel`, `vaOpenGpsList`, `vaOpenGpProfile`, `vaOpenMetricTasks`, `vaBackToToday`).
- CSS: `.gp-grid`, `.gp-card*`, `.gp-profile-*`, `.doc-row*`, `.back-bar`, `.today-metric.clickable`, `.today-metric-hint`.
- Top-level `Agent` tab element and its click handler branch. Agent rendering itself is kept and reparented.
- Top-level `Tickets`, `Work Queue`, `Ops Queue` tab buttons. Ticket content reparents into Inbox; Ops reparents into Tools; Work Queue functionality collapses into Inbox priority grouping.
- `switchToOps()` / `switchFromOps()` helpers.
- `[data-va-sweep-weekly]` button on Inbox header.
- `/api/admin/va/dashboard` metric drill-through click handlers (`data-va-metric`, `data-va-back`, `data-va-back-to`, `data-gp-profile`, `data-view-case-from-profile`).

## What gets kept verbatim

- All `/api/admin/*` endpoints.
- `esc`, `ini`, `fmtR`, `fmtD`, `fmtDT`, `safeUrl`, `buildJourney`, `PLAYBOOK`, `STEPS`.
- Nudge modal, ticket close, task complete/start, case save, add note, timeline loader, qualifications loader, document download.
- `loadInterviews`, `submitInterview`, `updateInterviewStatus`, `loadAdminApplications`, `runWeeklyCheckinSweep`.
- Ops queue rendering, filters, SLA check, `loadOpsQueue`.
- Agent rendering, all agent-control plumbing, bridge negotiation, run list/detail.
- 15-second `loadAll()` poll, visibility-change listener, session handling.

## Testing strategy

**Automated tests (new):**
- `tests/admin-va-search.test.js` — covers the new `/api/admin/va/search` endpoint:
  - Requires admin session (401 without).
  - Rejects 400 when `q` is shorter than 2 chars.
  - `scope=documents` returns document hits with `user_id`, `gp_name`, `country`, `key`, `label`, `file_name`.
  - `scope=notes` returns note hits with `case_id`, `gp_name`, `event_type`, `title`, `detail`, `created_at`.
  - No `scope` returns both combined.
  - Caps at 20 results per scope.
  - Sanitizes `q` (no SQL injection, no ilike wildcards injected into the column names).
  - Handles Supabase errors gracefully (returns empty arrays, not 500).

**Manual test checklist** (included in the spec — run post-implementation):
- Fresh page load lands on Inbox.
- Each of the 5 tabs opens its panel.
- Tools sub-nav switches between Ops / Sweep / Agent.
- Agent sub-view is hidden for non-SA users.
- Inbox: ticket `Resolve & Close` → ticket disappears, dashboard refreshes.
- Inbox: task `Complete` → task disappears, correct section count decrements.
- Inbox: task `Open Case` → lands on GPs tab with that case selected.
- Inbox blocked-case `Open profile` → lands on GPs tab with that case selected.
- GPs list: filter chips change counts and visible rows.
- GPs list: tab-scoped search filters the list.
- GPs desktop: meta column + tabbed content render side by side at 1200px.
- GPs desktop: clicking a different GP keeps the current tab active.
- GPs desktop: `Tasks / Documents / Journey / Notes` tabs switch content.
- GPs desktop: Save on case management form posts to `/api/admin/case` and toasts success.
- GPs mobile (375px): single-scroll profile renders with all sections in order.
- GPs mobile: back button returns to the list.
- Documents sub-view: View button on an approved doc opens a signed URL in a new tab.
- Journey sub-view: substeps render, stage playbook cards render for the current stage.
- Notes sub-view: add note posts to `/api/admin/case/note` and appears in timeline.
- Global search: typing "kha" shows GP matches client-side within 200 ms.
- Global search: typing "cct" shows document matches after server-side call returns.
- Global search: clicking a Document result lands on GPs tab → Documents sub-view with the row highlighted.
- Global search: `/` focuses the search box; Esc clears and closes.
- 15-second poll refreshes the inbox without scrolling the page.
- 401 redirects to the admin login page.

## Out of scope (explicit)

- Document approve/reject workflow — sub-project #2.
- Bulk actions — sub-project #2.
- Assignment / "my queue" — sub-project #2.
- Inbound messaging ingest (WhatsApp webhook, Gmail scan) — sub-project #3.
- AI task extraction from messages — sub-project #4.
- Visa/PBS embedded into the dashboard — sub-project #5.
- SLA reporting, backlog trend, throughput analytics — sub-project #6.
